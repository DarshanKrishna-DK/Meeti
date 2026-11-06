import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('../packages/server/router', () => ({ route: vi.fn() }));
vi.mock('../packages/server/discovery-jobs', () => ({ discoveryTick: vi.fn() }));
vi.mock('../packages/server/store', () => ({ closeStore: vi.fn(), db: vi.fn() }));
vi.mock('../packages/server/agent-tasks', () => ({ drainAgentTasks: vi.fn() }));
import { createHostedApi, hostedConfiguration } from '../scripts/hosted-api';

const origin = 'https://meeti.example';
const running: ReturnType<typeof createHostedApi>[] = [];
async function fixture(options: Partial<Parameters<typeof createHostedApi>[0]> = {}) {
  const route = vi.fn(async (request: Request, path: string[]) => Response.json({ url: request.url, origin: request.headers.get('origin'), host: request.headers.get('host'), forwarded: request.headers.get('x-forwarded-host'), path }));
  const closeStore = vi.fn(async () => {});
  const hosted = createHostedApi({ origin, route, discoveryTick: async () => ({ processed: 0, failed: 0 }), drainAgentTasks: async () => ({}), closeStore, ...options });
  running.push(hosted);
  await new Promise<void>(resolve => hosted.server.listen(0, '127.0.0.1', resolve));
  return { ...hosted, route, closeStore, base: `http://127.0.0.1:${(hosted.server.address() as AddressInfo).port}` };
}
afterEach(async () => { await Promise.all(running.splice(0).map(value => value.shutdown())); vi.restoreAllMocks(); });

describe('free hosted API boundary with local HTTP and explicit route fixtures', () => {
  it('requires Postgres, encryption, HTTPS origin and paused World before hosted startup', () => {
    const environment = { NODE_ENV: 'production' as const, APP_ORIGIN: origin, DATABASE_PROVIDER: 'postgres', SUPABASE_DATABASE_URL: 'postgresql://fixture:fixture@fixture.invalid/db', DATA_ENCRYPTION_KEY: 'a'.repeat(64), WORLD_CAPABILITY_ENABLED: 'false', AGENT_TASK_QUEUE_ENABLED: 'true', AI_GLOBAL_BUDGET_ID: 'fixture-budget' };
    expect(hostedConfiguration(environment)).toEqual({ origin, port: 10000 });
    for (const changes of [{ DATABASE_PROVIDER: 'sqlite' }, { SUPABASE_DATABASE_URL: '' }, { DATA_ENCRYPTION_KEY: '' }, { APP_ORIGIN: 'http://localhost' }, { APP_ORIGIN: origin + '/private' }, { PORT: 'wrong' }, { WORLD_CAPABILITY_ENABLED: 'true' }, { AGENT_TASK_QUEUE_ENABLED: 'false' }, { AI_GLOBAL_BUDGET_ID: '' }]) expect(() => hostedConfiguration({ ...environment, ...changes })).toThrow();
  });
  it('uses fixed application URL and strips forwarded host values while retaining caller Origin', async () => {
    const app = await fixture();
    const response = await fetch(app.base + '/api/auth/wallet/challenge?scope=fixture', { method: 'POST', headers: { origin, host: 'forged.invalid', 'x-forwarded-host': 'forged.invalid', 'x-forwarded-proto': 'http' }, body: '{}' });
    expect(await response.json()).toEqual({ url: origin + '/api/auth/wallet/challenge?scope=fixture', origin, host: 'meeti.example', forwarded: null, path: ['auth', 'wallet', 'challenge'] });
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    const denied = await fetch(app.base + '/api/profile', { method: 'POST', headers: { origin: 'https://forged.invalid', 'x-forwarded-origin': origin }, body: '{}' });
    expect(denied.status).toBe(403);
    expect(app.route).toHaveBeenCalledTimes(1);
  });
  it('rejects non-API paths, unsupported methods and encoded path separators before routing', async () => {
    const app = await fixture();
    for (const [path, method, status] of [['/dashboard', 'GET', 404], ['/api/profile', 'PUT', 405], ['/api/profile%2Fprivate', 'GET', 400], ['/api/%ZZ', 'GET', 400]] as const) expect((await fetch(app.base + path, { method })).status).toBe(status);
    expect(app.route).not.toHaveBeenCalled();
  });
  it('preserves separate HttpOnly cookies and exact JSON body for the real router', async () => {
    const route = vi.fn(async (request: Request) => {
      expect(await request.json()).toEqual({ fixture: 'owner input' });
      const headers = new Headers(); headers.append('Set-Cookie', 'meeti_session=fixture; HttpOnly; Secure'); headers.append('Set-Cookie', 'meeti_wallet_flow=fixture; HttpOnly; Secure');
      return Response.json({ data: { pending: true, confirmed: false } }, { headers });
    });
    const app = await fixture({ route });
    const response = await fetch(app.base + '/api/auth/wallet/verify', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: JSON.stringify({ fixture: 'owner input' }) });
    expect(response.headers.getSetCookie()).toHaveLength(2);
    expect(await response.json()).toEqual({ data: { pending: true, confirmed: false } });
  });
  it('bounds both declared and chunked request bodies without invoking the application', async () => {
    const app = await fixture();
    const declared = await fetch(app.base + '/api/context/files', { method: 'POST', headers: { origin }, body: 'x'.repeat(1410001) });
    expect(declared.status).toBe(413);
    const chunked = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(app.base + '/api/context/files', { method: 'POST', headers: { origin, 'content-type': 'application/json' } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode!)); });
      request.on('error', reject); request.write('x'.repeat(700000)); request.write('y'.repeat(710001)); request.end();
    });
    expect(chunked).toBe(413); expect(app.route).not.toHaveBeenCalled();
  });
  it('reports an unknown timeout honestly and keeps unresolved work counted until it settles', async () => {
    let resolve!: (value: Response) => void;
    const pending = new Promise<Response>(done => { resolve = done; });
    const route = vi.fn(async () => pending);
    const app = await fixture({ route, requestDeadlineMs: 30 });
    const responses = await Promise.all(Array.from({ length: 16 }, () => fetch(app.base + '/api/qualification')));
    for (const response of responses) {
      expect(response.status).toBe(504);
      expect((await response.json()).error).toMatchObject({ code: 'REQUEST_TIMEOUT' });
    }
    const busy = await fetch(app.base + '/api/qualification');
    expect(busy.status).toBe(503);
    expect((await busy.json()).error.code).toBe('API_BUSY');
    expect(route).toHaveBeenCalledTimes(16);
    resolve(Response.json({ data: { completed: false } }));
  });
  it('keeps arbitrary exception messages out of responses and diagnostic logs', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const app = await fixture({ route: async () => { throw new Error('private-fixture-token https://fixture.invalid/private'); } });
    const response = await fetch(app.base + '/api/state');
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain('private-fixture-token');
    expect(log).toHaveBeenCalledExactlyOnceWith('hosted_request_failed');
  });
  it('does not overlap discovery ticks and drains the active tick before closing storage', async () => {
    let finish!: () => void;
    const pending = new Promise<void>(resolve => { finish = resolve; });
    const discoveryTick = vi.fn(async () => { await pending; return { processed: 0, failed: 0 }; });
    const app = await fixture({ discoveryTick, discoveryPollMs: 10 });
    await vi.waitFor(() => expect(discoveryTick).toHaveBeenCalledTimes(1));
    await new Promise(resolve => setTimeout(resolve, 35));
    expect(discoveryTick).toHaveBeenCalledTimes(1);
    const stopped = app.shutdown();
    expect(app.shutdown()).toBe(stopped);
    expect(app.closeStore).not.toHaveBeenCalled();
    finish(); await stopped;
    expect(app.closeStore).toHaveBeenCalledTimes(1);
  });
  it('runs one task drain independently of slow discovery and waits for it during shutdown', async () => {
    let finishDiscovery!: () => void, finishTask!: () => void;
    const slowDiscovery = new Promise<void>(resolve => { finishDiscovery = resolve; });
    const slowTask = new Promise<void>(resolve => { finishTask = resolve; });
    const discoveryTick = vi.fn(async () => { await slowDiscovery; return { processed: 0, failed: 0 }; });
    const drainAgentTasks = vi.fn(async () => { await slowTask; return {}; });
    const app = await fixture({ discoveryTick, drainAgentTasks, discoveryPollMs: 10 });
    await vi.waitFor(() => { expect(discoveryTick).toHaveBeenCalledOnce(); expect(drainAgentTasks).toHaveBeenCalledOnce(); });
    await new Promise(resolve => setTimeout(resolve, 35));
    expect(discoveryTick).toHaveBeenCalledOnce(); expect(drainAgentTasks).toHaveBeenCalledOnce();
    const stopped = app.shutdown();
    finishDiscovery(); await Promise.resolve(); expect(app.closeStore).not.toHaveBeenCalled();
    finishTask(); await stopped; expect(app.closeStore).toHaveBeenCalledOnce();
  });
});

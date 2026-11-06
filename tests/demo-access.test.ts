import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase } from '../packages/server/db';
import { route } from '../packages/server/router';
import { inspectDemoOrigin } from '../packages/server/demo-access';
import { demoReadiness } from '../scripts/demo-doctor';
import type { Profile } from '../packages/shared/src';

const origin = 'http://127.0.0.1:3198';
const password = 'independent demo account test password';
let directory: string;

async function call(path: string, body?: unknown, cookie?: string, headers: Record<string, string> = {}) {
  return route(new Request(`${origin}/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), path.split('/'));
}
async function register() {
  const email = `demo-${randomUUID()}@example.test`;
  const response = await call('auth/register', { email, password });
  expect(response.status).toBe(200);
  const body = await response.json();
  return { email, id: body.data.id as string, cookie: response.headers.get('set-cookie')!.split(';')[0], response };
}
async function snapshot(cookie: string) {
  const response = await call('state', undefined, cookie);
  expect(response.status).toBe(200);
  return (await response.json()).data as { user: { id: string; email: string }; profile: Profile };
}

beforeEach(() => {
  closeDatabase();
  directory = mkdtempSync(join(tmpdir(), 'meeti-demo-test-'));
  vi.stubEnv('DATABASE_PATH', join(directory, 'demo.sqlite'));
  vi.stubEnv('DATA_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
  vi.stubEnv('APP_ORIGIN', origin);
  vi.stubEnv('ENS_SEPOLIA_RPC_URL', '');
  vi.stubEnv('ENS_SEPOLIA_AUTH_RPC_URL', '');
  vi.stubEnv('ARKIV_ACCESS_KEY', '');
  vi.stubEnv('AI_API_KEY', '');
  vi.stubEnv('WORLD_CAPABILITY_ENABLED', 'false');
});
afterEach(() => {
  closeDatabase();
  vi.unstubAllEnvs();
  const target = resolve(directory);
  if (!target.startsWith(resolve(tmpdir()) + sep + 'meeti-demo-test-')) throw new Error('Unexpected demo-test cleanup target.');
  rmSync(target, { recursive: true, force: true });
});

describe('safe mobile demo origin advice', () => {
  it.each(['http://127.0.0.1:3173', 'http://localhost:3173', 'http://[::1]:3173'])('supports exact loopback origin %s without claiming phone connectivity', value => {
    expect(inspectDemoOrigin(value)).toMatchObject({ usable: true, connection: 'loopback', origin: value });
  });
  it('requires trusted HTTPS for a LAN hostname and does not allow plain LAN HTTP', () => {
    expect(inspectDemoOrigin('http://192.168.1.22:3173')).toMatchObject({ usable: false, connection: 'unavailable' });
    expect(inspectDemoOrigin('https://meeti.example.test')).toMatchObject({ usable: true, connection: 'https' });
  });
  it.each([undefined, 'not a URL', 'file:///private', 'https://user:password@example.test', 'https://example.test/?token=private', 'https://example.test/#private', 'https://example.test/path'])('does not echo malformed origins, credentials or URL data', value => {
    const result = inspectDemoOrigin(value);
    expect(result.usable).toBe(false);
    expect(result).not.toHaveProperty('origin');
    expect(JSON.stringify(result)).not.toContain('password');
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it('refuses to call the current local SQLite and Ollama architecture Vercel-ready', async () => {
    const result = await demoReadiness({ APP_ORIGIN: 'not a configured origin', NODE_ENV: 'test' }, { target: 'vercel' });
    expect(result.readyForLocalReview).toBe(false);
    expect(result.completeMvpVerified).toBe(false);
    expect(result.checks.find(value => value.name === 'Deployment architecture')).toMatchObject({ state: 'blocked' });
    expect(result.checks.find(value => value.name === 'World verification')).toMatchObject({ state: 'paused' });
  });
});

describe('actual API session behavior for a two-participant demo', () => {
  it('keeps separate sessions for the same account and signs out only the selected session', async () => {
    const actor = await register();
    const login = await call('auth/login', { email: actor.email, password });
    const second = login.headers.get('set-cookie')!.split(';')[0];
    expect(second).not.toBe(actor.cookie);
    const before = await snapshot(actor.cookie);
    expect((await call('profile', { ...before.profile, headline: 'Updated from the second independent session' }, second)).status).toBe(200);
    expect((await snapshot(actor.cookie)).profile.headline).toBe('Updated from the second independent session');
    expect((await call('auth/logout', {}, actor.cookie)).status).toBe(200);
    expect((await call('state', undefined, actor.cookie)).status).toBe(401);
    expect((await snapshot(second)).user.id).toBe(actor.id);
  });
  it('returns private fresh state only for each authenticated participant and marks it no-store', async () => {
    const a = await register(), b = await register();
    const own = await snapshot(a.cookie);
    const privateText = `private-contact-${randomUUID()}`;
    expect((await call('profile', { ...own.profile, contact: privateText }, a.cookie)).status).toBe(200);
    const response = await call('state', undefined, b.cookie);
    expect(response.headers.get('cache-control')).toBe('no-store');
    const other = await response.text();
    expect(other).not.toContain(privateText);
    expect(other).not.toContain(a.email);
    expect(other).toContain(b.email);
    expect((await call('state')).status).toBe(401);
  });
  it('does not reinterpret a browser cookie as a different account because a window claims an actor ID', async () => {
    const a = await register(), b = await register();
    const response = await call('state', undefined, a.cookie, { 'x-user-id': b.id, 'x-account-id': b.id });
    expect((await response.json()).data.user.id).toBe(a.id);
  });
  it('rejects another origin even when forwarded host headers imitate the configured application', async () => {
    const actor = await register();
    const before = await snapshot(actor.cookie);
    const response = await call('profile', { ...before.profile, headline: 'Must not be saved' }, actor.cookie, {
      origin: 'http://192.168.1.22:3173', host: '127.0.0.1:3198',
      'x-forwarded-host': '127.0.0.1:3198', 'x-forwarded-proto': 'http',
    });
    expect(response.status).toBe(403);
    expect((await response.json()).error.code).toBe('ORIGIN_DENIED');
    expect((await snapshot(actor.cookie)).profile.headline).toBe(before.profile.headline);
  });
  it('retains Secure, HttpOnly and SameSite cookie attributes in production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const actor = await register();
    const cookie = actor.response.headers.get('set-cookie')!;
    expect(cookie).toContain('; Secure');
    expect(cookie).toContain('; HttpOnly');
    expect(cookie).toContain('; SameSite=Strict');
    expect(cookie).not.toContain('Domain=');
  });
  it('invalidates every session of a deleted actor without signing out another participant', async () => {
    const a = await register(), b = await register();
    const login = await call('auth/login', { email: a.email, password });
    const second = login.headers.get('set-cookie')!.split(';')[0];
    expect((await call('account/delete', { confirmation: 'DELETE' }, a.cookie)).status).toBe(200);
    expect((await call('state', undefined, a.cookie)).status).toBe(401);
    expect((await call('state', undefined, second)).status).toBe(401);
    expect((await snapshot(b.cookie)).user.id).toBe(b.id);
  });
  it('reports paused World capability without making configuration evidence a human-verification claim', async () => {
    const actor = await register();
    const response = await call('state', undefined, actor.cookie);
    const state = (await response.json()).data;
    expect(state.integrations.world.status).toBe('deferred');
    expect(state.integrations.world.message).toContain('paused');
    expect(state.proposals).toEqual([]);
    expect(state.rooms).toEqual([]);
  });
});

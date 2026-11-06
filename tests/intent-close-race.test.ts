import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Intent, Profile } from '../packages/shared/src';

// Only the permission provider is a fixture. Routes, sessions, SQLite transactions and intent versions are real.
const provider = vi.hoisted(() => ({ authority: vi.fn() }));
vi.mock('../packages/server/policy', async original => ({ ...await original<typeof import('../packages/server/policy')>(), authority: provider.authority }));
import { route } from '../packages/server/router';
import { agent, closeDatabase, db, intent, saveAgent, saveIntent } from '../packages/server/db';
import { encrypt, hash } from '../packages/server/crypto';
import { createSession } from '../packages/server/security';

const origin = 'http://127.0.0.1:3198';
let directory: string;
function fixture() {
  const id = randomUUID(), createdAt = new Date().toISOString(), wallet = `0x${randomBytes(20).toString('hex')}`;
  const profile: Profile = { displayName: 'Fictional closure fixture', headline: '', bio: '', seeking: '', offering: '', tags: [], contact: '', employer: '', publicFields: [], aiConsent: false };
  db().prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(id, `${id}@fixture.invalid`, '', wallet, encrypt(profile, `profile:${id}`), createdAt);
  const a: Agent = { id: randomUUID(), owner: wallet, delegate: `0x${'22'.repeat(20)}`, ensName: 'agent.closure-fixture.eth', persona: '', authority: null, config: {},
    policy: { version: 1, purpose: 'collaborator', allowedFields: [], allowedActions: ['publish', 'discover'], paused: false, expiresAt: new Date(Date.now() + 86400000).toISOString() } };
  saveAgent(id, a);
  const value: Intent = { id: randomUUID(), version: 1, policyVersion: 1, goal: 'collaborator', summary: 'Fictional public collaboration request.', tags: ['documentation'],
    status: 'published', demoOrigin: true, createdAt, expiresAt: a.policy.expiresAt, arkivKey: `0x${'aa'.repeat(32)}`, transactionHash: `0x${'bb'.repeat(32)}` };
  saveIntent(id, value); return { id, cookie: createSession(id).split(';')[0], a, value };
}
function request(owner: ReturnType<typeof fixture>, path: string, body: unknown) {
  return new Request(`${origin}/api/${path}`, { method: 'POST', headers: { origin, cookie: owner.cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
function delayedClose(owner: ReturnType<typeof fixture>) {
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), waiting = new Promise<void>(resolve => { release = resolve; });
  provider.authority.mockImplementationOnce(async () => { entered(); await waiting; return owner.a; });
  const input = request(owner, 'intent/close', { intentId: owner.value.id });
  return { input, pending: route(input, ['intent', 'close']), ready, release: () => release() };
}
async function code(response: Response) { return (await response.json()).error?.code; }
beforeEach(() => {
  closeDatabase(); directory = mkdtempSync(join(tmpdir(), 'meeti-intent-close-'));
  vi.stubEnv('DATABASE_PATH', join(directory, 'fixture.sqlite')); vi.stubEnv('DATA_ENCRYPTION_KEY', randomBytes(32).toString('hex')); vi.stubEnv('APP_ORIGIN', origin);
  provider.authority.mockReset().mockImplementation(async (userId: string) => agent(userId));
});
afterEach(() => { closeDatabase(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

describe('intent closure post-permission commit fencing', () => {
  it('does not overwrite a newer draft saved while its permission check is pending', async () => {
    const owner = fixture(), close = delayedClose(owner); await close.ready;
    const edit = await route(request(owner, 'intent', { id: owner.value.id, goal: 'collaborator', summary: 'Fictional newer owner-approved documentation request.', tags: ['documentation'],
      expiresAt: owner.value.expiresAt, publicApproved: true, demoOrigin: true }), ['intent']);
    expect(edit.status).toBe(200); const edited = (await edit.json()).data;
    close.release(); const result = await close.pending;
    expect(result.status).toBe(409); expect(await code(result)).toBe('INTENT_CHANGED'); expect(intent(owner.value.id)?.value).toEqual(edited);
  });
  it.each(['summary', 'arkivKey', 'publicStatus'] as const)('checks the complete snapshot when %s changes without a version change', async field => {
    const owner = fixture(), close = delayedClose(owner); await close.ready;
    const updated: Intent = { ...owner.value, ...(field === 'summary' ? { summary: 'Fictional changed same-version payload.' } : field === 'arkivKey' ? { arkivKey: `0x${'cc'.repeat(32)}` } : { publicStatus: 'closed' }) };
    saveIntent(owner.id, updated); close.release(); const result = await close.pending;
    expect(result.status).toBe(409); expect(await code(result)).toBe('INTENT_CHANGED'); expect(intent(owner.value.id)?.value).toEqual(updated);
  });
  it('rejects a session revoked during the permission await before mutating the intent', async () => {
    const owner = fixture(), close = delayedClose(owner); await close.ready;
    db().prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(owner.cookie.split('=')[1]));
    close.release(); const result = await close.pending;
    expect(result.status).toBe(401); expect(intent(owner.value.id)?.value).toEqual(owner.value);
  });
  it('rejects a changed authenticated account at commit without crossing either tenant', async () => {
    const owner = fixture(), other = fixture(), close = delayedClose(owner); await close.ready;
    // A controlled request-boundary change exercises the second authentication result, not wallet verification.
    close.input.headers.set('cookie', other.cookie); close.release(); const result = await close.pending;
    expect(result.status).toBe(403); expect(await code(result)).toBe('ACCOUNT_CHANGED');
    expect(intent(owner.value.id)?.value).toEqual(owner.value); expect(intent(other.value.id)?.value).toEqual(other.value);
  });
  it('preserves the pending-operation conflict introduced during the permission await', async () => {
    const owner = fixture(), close = delayedClose(owner); await close.ready; const operationId = randomUUID();
    db().prepare('INSERT INTO operations VALUES(?,?,?,?,?,?)').run(operationId, owner.id, 'fixture-only', 'prepared', encrypt({}, `operation:${operationId}`), new Date().toISOString());
    close.release(); const result = await close.pending;
    expect(result.status).toBe(409); expect(await code(result)).toBe('TRANSACTION_UNRESOLVED'); expect(intent(owner.value.id)?.value).toEqual(owner.value);
  });
  it('rejects changed permissions during the await without preparing a closure', async () => {
    const owner = fixture(), close = delayedClose(owner); await close.ready;
    saveAgent(owner.id, { ...owner.a, policy: { ...owner.a.policy, version: 2, paused: true } }); close.release(); const result = await close.pending;
    expect(result.status).toBe(409); expect(await code(result)).toBe('POLICY_CHANGED'); expect(intent(owner.value.id)?.value).toEqual(owner.value);
  });
  it('creates one local closure draft when the exact owner and intent remain unchanged', async () => {
    const owner = fixture(); const response = await route(request(owner, 'intent/close', { intentId: owner.value.id }), ['intent', 'close']);
    expect(response.status).toBe(200); const closed = (await response.json()).data;
    expect(closed).toMatchObject({ id: owner.value.id, version: 2, status: 'draft', publicStatus: 'closed' });
    expect(closed.arkivKey).toBeUndefined(); expect(closed.transactionHash).toBeUndefined();
    expect(intent(owner.value.id)?.value).toEqual(closed); expect(db().prepare('SELECT id FROM operations').all()).toEqual([]);
  });
});

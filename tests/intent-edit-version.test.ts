import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Intent, Profile } from '../packages/shared/src';
import { route } from '../packages/server/router';
import { closeDatabase, db, intent, saveAgent, saveIntent } from '../packages/server/db';
import { encrypt } from '../packages/server/crypto';
import { createSession } from '../packages/server/security';
import { queueDiscovery } from '../packages/server/discovery-jobs';

// These are local account fixtures. The real session, route, encryption and SQLite CAS boundary execute without providers.
const origin = 'http://127.0.0.1:3198';
let directory: string;
async function account() {
  const id = randomUUID(), wallet = `0x${randomBytes(20).toString('hex')}`, createdAt = new Date().toISOString();
  const profile: Profile = { displayName: 'Fictional revision fixture', headline: '', bio: '', seeking: '', offering: '', tags: [], contact: '', employer: '', publicFields: [], aiConsent: false };
  db().prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(id, `${id}@fixture.invalid`, '', wallet, encrypt(profile, `profile:${id}`), createdAt);
  const a: Agent = { id: randomUUID(), owner: wallet, delegate: `0x${'22'.repeat(20)}`, ensName: 'agent.revision-fixture.eth', persona: '', authority: null, config: {},
    policy: { version: 1, purpose: 'collaborator', allowedFields: [], allowedActions: ['publish', 'discover'], paused: false, expiresAt: new Date(Date.now() + 86400000).toISOString() } };
  saveAgent(id, a);
  return { id, cookie: (await createSession(id)).split(';')[0], a };
}
async function fixture(owner: Awaited<ReturnType<typeof account>>, status: Intent['status'] = 'published') {
  const value: Intent = { id: randomUUID(), version: 3, policyVersion: 1, goal: 'collaborator', summary: 'Fictional current documentation request.', tags: ['documentation'],
    status, demoOrigin: true, createdAt: new Date().toISOString(), expiresAt: owner.a.policy.expiresAt,
    ...(status === 'published' ? { arkivKey: `0x${'aa'.repeat(32)}`, transactionHash: `0x${'bb'.repeat(32)}` } : {}) };
  saveIntent(owner.id, value); await queueDiscovery(owner.id, value); return value;
}
function payload(value?: Intent) {
  return { ...(value ? { id: value.id, expectedVersion: value.version } : {}), goal: 'collaborator', summary: 'Fictional reviewed replacement request.', tags: ['documentation'],
    expiresAt: value?.expiresAt || new Date(Date.now() + 86400000).toISOString(), publicApproved: true, demoOrigin: true };
}
function post(owner: Awaited<ReturnType<typeof account>>, input: unknown) {
  return route(new Request(`${origin}/api/intent`, { method: 'POST', headers: { origin, cookie: owner.cookie, 'content-type': 'application/json' }, body: JSON.stringify(input) }), ['intent']);
}
function snapshot() {
  return { intents: db().prepare('SELECT * FROM intents ORDER BY id').all(), jobs: db().prepare('SELECT * FROM discovery_jobs ORDER BY intent_id').all(), audit: db().prepare('SELECT * FROM audit ORDER BY id').all() };
}
beforeEach(() => {
  closeDatabase(); directory = mkdtempSync(join(tmpdir(), 'meeti-intent-version-'));
  vi.stubEnv('DATABASE_PATH', join(directory, 'fixture.sqlite')); vi.stubEnv('DATA_ENCRYPTION_KEY', randomBytes(32).toString('hex')); vi.stubEnv('APP_ORIGIN', origin);
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Provider requests are forbidden in revision fixtures.'));
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); closeDatabase(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

describe('intent editing requires the exact reviewed server revision', () => {
  it('saves a reviewed private draft without granting public publication approval', async () => {
    const owner = await account();
    const response = await post(owner, { ...payload(), publicApproved: undefined, draftReviewed: true });
    expect(response.status).toBe(200);
    const saved = (await response.json()).data;
    expect(saved.status).toBe('draft'); expect(saved.arkivKey).toBeUndefined(); expect(saved.semantics).toBeUndefined();
    expect(saved.publicApproved).toBeUndefined(); expect(saved.draftReviewed).toBeUndefined();
  });
  it('requires explicit private draft review', async () => {
    const owner = await account();
    const response = await post(owner, { ...payload(), publicApproved: undefined });
    expect(response.status).toBe(400); expect(db().prepare('SELECT id FROM intents').all()).toHaveLength(0);
  });
  it('saves a new private draft during ENS setup without changing the prepared transaction', async () => {
    const owner = await account(), operationId = randomUUID();
    db().prepare('INSERT INTO operations VALUES(?,?,?,?,?,?)').run(operationId, owner.id, 'ens', 'prepared', 'fixture-unchanged', new Date().toISOString());
    const response = await post(owner, payload());
    expect(response.status).toBe(200);
    const saved = (await response.json()).data;
    expect(saved.status).toBe('draft'); expect(saved.arkivKey).toBeUndefined();
    expect(db().prepare('SELECT state,data FROM operations WHERE id=?').get(operationId)).toEqual({ state: 'prepared', data: 'fixture-unchanged' });
  });
  it.each(['ens', 'arkiv:fixture:1'])('keeps an existing intent immutable while %s is pending', async kind => {
    const owner = await account(), previous = await fixture(owner);
    db().prepare('INSERT INTO operations VALUES(?,?,?,?,?,?)').run(randomUUID(), owner.id, kind, 'prepared', 'fixture-unchanged', new Date().toISOString());
    const before = snapshot(), response = await post(owner, payload(previous));
    expect(response.status).toBe(409); expect((await response.json()).error.code).toBe('TRANSACTION_UNRESOLVED'); expect(snapshot()).toEqual(before);
  });
  it('retains the pending Arkiv publication guard even for new private drafts', async () => {
    const owner = await account();
    db().prepare('INSERT INTO operations VALUES(?,?,?,?,?,?)').run(randomUUID(), owner.id, 'arkiv:fixture:1', 'submitted', 'fixture-unchanged', new Date().toISOString());
    const response = await post(owner, payload()); expect(response.status).toBe(409);
    expect(db().prepare('SELECT id FROM intents').all()).toHaveLength(0);
  });
  it.each(['published', 'draft'] as const)('saves one reviewed %s revision as a private draft and invalidates discovery', async status => {
    const owner = await account(), previous = await fixture(owner, status);
    const response = await post(owner, payload(previous)); expect(response.status).toBe(200);
    const saved = (await response.json()).data;
    expect(saved).toMatchObject({ id: previous.id, version: 4, status: 'draft', summary: 'Fictional reviewed replacement request.' });
    expect(saved.arkivKey).toBeUndefined(); expect(saved.transactionHash).toBeUndefined(); expect(intent(previous.id)?.value).toEqual(saved);
    expect(db().prepare('SELECT enabled,result,lease_token FROM discovery_jobs WHERE intent_id=?').get(previous.id)).toMatchObject({ enabled: 0, result: null, lease_token: null });
    expect(db().prepare('SELECT action,outcome FROM audit').all()).toEqual([expect.objectContaining({ action: 'intent', outcome: 'draft_saved' })]);
  });
  it.each([undefined, 1, 2, 4])('rejects missing/stale/future expected version %s without side effects', async expectedVersion => {
    const owner = await account(), previous = await fixture(owner), before = snapshot();
    const response = await post(owner, { ...payload(previous), expectedVersion });
    expect(response.status).toBe(409); expect((await response.json()).error.code).toBe('INTENT_CHANGED'); expect(snapshot()).toEqual(before);
  });
  it.each([0, -1, 1.5, '3', null, Number.MAX_SAFE_INTEGER + 1])('rejects invalid expected version %s without side effects', async expectedVersion => {
    const owner = await account(), previous = await fixture(owner), before = snapshot();
    const response = await post(owner, { ...payload(previous), expectedVersion });
    expect(response.status).toBe(400); expect((await response.json()).error.code).toBe('INVALID_INPUT'); expect(snapshot()).toEqual(before);
  });
  it('allows exactly one of two concurrent edits based on the same revision', async () => {
    const owner = await account(), previous = await fixture(owner);
    const responses = await Promise.all([post(owner, { ...payload(previous), summary: 'Fictional first competing request.' }), post(owner, { ...payload(previous), summary: 'Fictional second competing request.' })]);
    expect(responses.map(response => response.status).sort()).toEqual([200, 409]);
    const winner = (await responses.find(response => response.status === 200)!.json()).data;
    expect(intent(previous.id)?.value).toEqual(winner); expect(winner.version).toBe(4);
    expect(db().prepare('SELECT id FROM audit').all()).toHaveLength(1); expect(db().prepare('SELECT intent_id FROM discovery_jobs').all()).toHaveLength(1);
  });
  it.each([undefined, 3])('returns tenancy-safe404 for a foreign edit with expected version %s', async expectedVersion => {
    const owner = await account(), other = await account(), previous = await fixture(owner), before = snapshot();
    const response = await post(other, { ...payload(previous), expectedVersion });
    expect(response.status).toBe(404); expect(snapshot()).toEqual(before);
  });
  it('returns404 for an unknown id before requiring an edit version', async () => {
    const owner = await account(), before = snapshot(); const response = await post(owner, { ...payload(), id: randomUUID() });
    expect(response.status).toBe(404); expect(snapshot()).toEqual(before);
  });
  it('creates a fresh version one intent without an expected revision', async () => {
    const owner = await account(); const response = await post(owner, payload()); expect(response.status).toBe(200);
    const created = (await response.json()).data; expect(created).toMatchObject({ version: 1, status: 'draft' }); expect(intent(created.id)?.userId).toBe(owner.id);
  });
  it('rejects an expected version for a new intent without creating records', async () => {
    const owner = await account(), before = snapshot(); const response = await post(owner, { ...payload(), expectedVersion: 1 });
    expect(response.status).toBe(400); expect((await response.json()).error.code).toBe('INVALID_INTENT_VERSION'); expect(snapshot()).toEqual(before);
  });
});

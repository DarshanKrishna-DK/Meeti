import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WorldBinding, WorldPollResult, WorldSession, WorldVerification } from '../packages/world';
import type { Agent, Intent, Profile } from '../packages/shared/src';

// This suite isolates World orchestration. Live Arkiv freshness has separate tests.
vi.mock('../packages/server/discovery', async () => {
  const { authority } = await import('../packages/server/policy');
  return { freshPublicIntent: async (userId: string, value: Intent, action: 'negotiate' | 'introduce' | 'message') => authority(userId, action, value.policyVersion), assessPair: vi.fn() };
});

// This suite substitutes provider boundaries only in tests. No result is live identity evidence.
const fixture = vi.hoisted(() => ({ start: vi.fn(), poll: vi.fn(), authority: vi.fn(), publicIdentity: vi.fn(), introduction: vi.fn(), revoked: new Set<string>() }));
vi.mock('../packages/server/identity', async importOriginal => ({
  ...await importOriginal<typeof import('../packages/server/identity')>(),
  resolveCurrentPublicAgentIdentityForUser: fixture.publicIdentity,
}));
vi.mock('../packages/world', async importOriginal => ({
  ...await importOriginal<typeof import('../packages/world')>(),
  createWorldProvider: () => ({ start: fixture.start, poll: fixture.poll }),
}));
vi.mock('../packages/server/policy', async importOriginal => ({
  ...await importOriginal<typeof import('../packages/server/policy')>(),
  authority: fixture.authority,
  ai: () => ({ createContextualIntroduction: fixture.introduction }),
}));

import { route } from '../packages/server/router';
import { agent, closeDatabase, db, profile, saveAgent, saveIntent, type ProposalData } from '../packages/server/db';
import { decrypt, encrypt, hash } from '../packages/server/crypto';
import { createSession, HttpError } from '../packages/server/security';
import { requireWorld } from '../packages/server/proposals';

const origin = 'http://127.0.0.1:3199';
let directory: string;
type Actor = { id: string; cookie: string };
type StoredChallenge = { binding: WorldBinding; session: WorldSession };

function actor(): Actor {
  const id = randomUUID();
  const p: Profile = { displayName: 'Test fixture', headline: 'A public fixture headline', bio: '', seeking: '', offering: '', tags: [],
    contact: `private-${id}`, employer: '', publicFields: ['headline'], aiConsent: true };
  db().prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(id, `${id}@example.test`, 'not-a-login-fixture', null, encrypt(p, `profile:${id}`), new Date().toISOString());
  return { id, cookie: createSession(id).split(';')[0] };
}
function pair(left = actor(), right = actor()) {
  function side(owner: Actor) {
    const a: Agent = { id: randomUUID(), ensName: 'test.fixture.eth', owner: `0x${'11'.repeat(20)}`, delegate: `0x${'22'.repeat(20)}`,
      persona: 'Test fixture', authority: null, config: {}, policy: { version: 1, purpose: 'collaborator', allowedFields: ['headline'],
        allowedActions: ['introduce', 'message', 'negotiate'], expiresAt: new Date(Date.now() + 3600000).toISOString(), paused: false } };
    saveAgent(owner.id, a);
    const intent: Intent = { id: randomUUID(), version: 1, policyVersion: 1, goal: 'collaborator', summary: 'Explicit local test intent', tags: ['typescript'],
      createdAt: new Date().toISOString(), expiresAt: a.policy.expiresAt, status: 'published', demoOrigin: true };
    saveIntent(owner.id, intent);
    return { a, intent };
  }
  const l = side(left), r = side(right), id = randomUUID(), digest = hash(id);
  const value: ProposalData = { leftIntent: l.intent, rightIntent: r.intent, leftPolicy: l.a.policy, rightPolicy: r.a.policy,
    leftAgent: l.a.id, rightAgent: r.a.id, leftProfileDigest: hash(JSON.stringify(profile(left.id))), rightProfileDigest: hash(JSON.stringify(profile(right.id))),
    summary: 'Test fixture proposal', compatibility: {}, exchanges: [], createdAt: new Date().toISOString() };
  db().prepare('INSERT INTO proposals VALUES(?,?,?,?,?,?,?)').run(id, left.id, right.id, id, 'waiting_consents', digest, encrypt(value, `proposal:${id}`));
  for (const owner of [left, right]) db().prepare('INSERT INTO consents VALUES(?,?,?,?,?,?,?)').run(randomUUID(), id, owner.id, 'approve', digest, 'test-only-signature', new Date().toISOString());
  return { id, digest, left, right };
}
async function call(owner: Actor, path: string, body?: unknown) {
  return route(new Request(`${origin}/api/${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { origin, 'content-type': 'application/json', cookie: owner.cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), path.split('/'));
}
async function challenge(owner: Actor, proposalId: string): Promise<string> {
  const response = await call(owner, 'world/challenge', { proposalId });
  expect(response.status).toBe(200);
  return (await response.json()).data.challengeId as string;
}
function saved(id: string): StoredChallenge {
  const row = db().prepare('SELECT data FROM challenges WHERE id=?').get(id) as { data: string };
  return decrypt<StoredChallenge>(row.data, `challenge:${id}`);
}
function verification(binding: WorldBinding, changes: Partial<WorldVerification> = {}): WorldVerification {
  return { issuer: 'https://sandbox.auth.world.org', subject: `fixture-human-${binding.userId}`, tokenId: randomUUID(), tokenDigest: hash(randomUUID()),
    authTime: new Date(binding.issuedAt).toISOString(), verifiedAt: new Date().toISOString(), expiresAt: new Date(binding.expiresAt).toISOString(),
    acr: 'https://world.org/oidc/acr/orb', amr: ['orb'], identityMode: 'sandbox-test-identity', ...changes };
}
async function verify(owner: Actor, proposalId: string) {
  const id = await challenge(owner, proposalId);
  const response = await call(owner, 'world/verify', { challengeId: id });
  expect(response.status).toBe(200);
  expect((await response.json()).data.status).toBe('verified');
  return id;
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}

beforeEach(() => {
  closeDatabase();
  directory = mkdtempSync(join(tmpdir(), 'meeti-world-orchestration-'));
  vi.stubEnv('DATABASE_PATH', join(directory, 'test.sqlite'));
  vi.stubEnv('DATA_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
  vi.stubEnv('APP_ORIGIN', origin);
  vi.stubEnv('WORLD_ISSUER', 'https://sandbox.auth.world.org');
  vi.stubEnv('WORLD_CAPABILITY_ENABLED', 'true');
  vi.stubEnv('WORLD_CLIENT_ID', 'test-only-client');
  vi.stubEnv('WORLD_CLIENT_SECRET', 'explicit-local-test-fixture');
  fixture.revoked.clear();
  fixture.start.mockReset().mockImplementation(async (binding: WorldBinding) => ({
    session: { binding, deviceCode: `server-only-device-${binding.challengeId}`, issuer: 'https://sandbox.auth.world.org', clientId: 'test-only-client',
      acceptedAcr: ['https://world.org/oidc/acr/orb'], intervalSeconds: 1, nextPollAt: 0, expiresAt: binding.expiresAt, status: 'pending' },
    challenge: { challengeId: binding.challengeId, userCode: 'TEST-ONLY', verificationUrl: 'https://sandbox.auth.world.org/verify',
      expiresAt: new Date(binding.expiresAt).toISOString(), pollIntervalSeconds: 1, identityMode: 'sandbox-test-identity' },
  }));
  fixture.poll.mockReset().mockImplementation(async (_session: WorldSession, binding: WorldBinding): Promise<WorldPollResult> => ({ status: 'verified', verification: verification(binding) }));
  fixture.authority.mockReset().mockImplementation(async (userId: string) => {
    if (fixture.revoked.has(userId)) throw new HttpError(403, 'ENS_AUTHORITY_DENIED', 'Explicit test fixture revocation.');
    return agent(userId);
  });
  // Public identity resolution is an explicit provider fixture, not a bypass of the proposal binding guard.
  fixture.publicIdentity.mockReset().mockImplementation(async (userId: string) => ({
    ensName: agent(userId)!.ensName, owner: agent(userId)!.owner,
    context: { state: 'absent' }, association: { state: 'absent' },
    observed: { chainId: 11155111, blockNumber: '1', checkedAt: new Date().toISOString() }, authorityVerified: false, humanVerified: false,
  }));
  fixture.introduction.mockReset().mockResolvedValue({ output: { opening: 'Explicit test-only introduction.', suggestedFirstQuestion: 'What would you build?' } });
});
afterEach(() => {
  closeDatabase(); vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('durable World challenge orchestration with explicit provider fixtures', () => {
  it('keeps configured World credentials inert while the owner capability is paused', async () => {
    const p = pair();
    const id = await challenge(p.left, p.id);
    fixture.start.mockClear(); fixture.poll.mockClear(); fixture.authority.mockClear();
    vi.stubEnv('WORLD_CAPABILITY_ENABLED', 'false');
    for (const [path, body] of [
      ['world/challenge', { proposalId: p.id }],
      ['world/verify', { challengeId: id }],
    ] as const) {
      const response = await call(p.left, path, body);
      expect(response.status).toBe(503);
      expect((await response.json()).error.code).toBe('WORLD_PAUSED');
    }
    expect(() => requireWorld(p.id)).toThrow('World verification is paused');
    expect(fixture.start).not.toHaveBeenCalled();
    expect(fixture.poll).not.toHaveBeenCalled();
    expect(fixture.authority).not.toHaveBeenCalled();
    expect(db().prepare('SELECT count(*) AS n FROM world_verifications').get()).toEqual({ n: 0 });
    expect(db().prepare('SELECT count(*) AS n FROM rooms').get()).toEqual({ n: 0 });
    expect(db().prepare('SELECT used FROM challenges WHERE id=?').get(id)).toEqual({ used: 0 });
  });

  it('keeps device codes server-side and binds the encrypted challenge to account, browser, proposal and candidate', async () => {
    const p = pair();
    const response = await call(p.left, 'world/challenge', { proposalId: p.id });
    expect(response.status).toBe(200);
    const text = await response.text();
    expect(text).not.toContain('deviceCode'); expect(text).not.toContain('server-only-device');
    const id = JSON.parse(text).data.challengeId as string;
    const stored = saved(id);
    expect(stored.binding).toMatchObject({ userId: p.left.id, sessionBinding: hash(p.left.cookie), proposalId: p.id,
      proposalDigest: p.digest, candidateId: p.right.id, action: 'introduce', challengeId: id });
    expect(stored.binding.nonce).toHaveLength(64);
    expect(stored.session.deviceCode).toBe(`server-only-device-${id}`);
    const raw = db().prepare('SELECT data FROM challenges WHERE id=?').get(id) as { data: string };
    expect(raw.data).not.toContain(stored.session.deviceCode);
    const ownerState = await call(p.left, 'state');
    expect(await ownerState.text()).not.toContain(stored.session.deviceCode);
    closeDatabase();
    expect(saved(id)).toEqual(stored);
  });

  it('rejects another account, a replacement browser session and extra client binding fields', async () => {
    const p = pair(), outsider = actor();
    const id = await challenge(p.left, p.id);
    expect((await call(outsider, 'world/verify', { challengeId: id })).status).toBe(404);
    const newSession = { id: p.left.id, cookie: createSession(p.left.id).split(';')[0] };
    const mismatch = await call(newSession, 'world/verify', { challengeId: id });
    expect(mismatch.status).toBe(403); expect((await mismatch.json()).error.code).toBe('WORLD_SESSION_MISMATCH');
    expect((await call(p.left, 'world/verify', { challengeId: id, proposalId: randomUUID(), candidateId: outsider.id, verified: true })).status).toBe(400);
    expect(fixture.poll).not.toHaveBeenCalled();
  });

  it('invalidates the old challenge when requesting a replacement for the same introduction', async () => {
    const p = pair(), first = await challenge(p.left, p.id), second = await challenge(p.left, p.id);
    expect((await call(p.left, 'world/verify', { challengeId: first })).status).toBe(403);
    expect((await call(p.left, 'world/verify', { challengeId: second })).status).toBe(200);
    expect(fixture.poll).toHaveBeenCalledTimes(1);
  });

  it('allows one provider poll at a time and prevents repeating a completed challenge', async () => {
    const p = pair(), id = await challenge(p.left, p.id), waiting = deferred<WorldPollResult>(), entered = deferred<void>();
    fixture.poll.mockImplementationOnce(() => { entered.resolve(); return waiting.promise; });
    const first = call(p.left, 'world/verify', { challengeId: id });
    await entered.promise;
    const concurrent = await call(p.left, 'world/verify', { challengeId: id });
    expect(concurrent.status).toBeGreaterThanOrEqual(400);
    expect(fixture.poll).toHaveBeenCalledTimes(1);
    waiting.resolve({ status: 'verified', verification: verification(saved(id).binding) });
    expect((await first).status).toBe(200);
    expect((await call(p.left, 'world/verify', { challengeId: id })).status).toBe(403);
    expect(db().prepare('SELECT count(*) AS n FROM world_verifications').get()).toEqual({ n: 1 });
  });

  it('persists a pending poll and enforces its next polling time', async () => {
    const p = pair(), id = await challenge(p.left, p.id), stored = saved(id);
    fixture.poll.mockResolvedValueOnce({ status: 'pending', session: { ...stored.session, nextPollAt: Date.now() + 30000 }, pollIntervalSeconds: 30 });
    const pending = await call(p.left, 'world/verify', { challengeId: id });
    expect(pending.status).toBe(200); expect((await pending.json()).data.status).toBe('pending');
    closeDatabase();
    const throttled = await call(p.left, 'world/verify', { challengeId: id });
    expect((await throttled.json()).data.status).toBe('pending');
    expect(fixture.poll).toHaveBeenCalledTimes(1);
    expect(db().prepare('SELECT used FROM challenges WHERE id=?').get(id)).toEqual({ used: 0 });
  });

  it('does not accept a provider success after cancellation during an active poll', async () => {
    const p = pair(), id = await challenge(p.left, p.id), waiting = deferred<WorldPollResult>(), entered = deferred<void>();
    fixture.poll.mockImplementationOnce(() => { entered.resolve(); return waiting.promise; });
    const pending = call(p.left, 'world/verify', { challengeId: id });
    await entered.promise;
    expect((await call(p.left, 'world/cancel', { challengeId: id })).status).toBe(200);
    waiting.resolve({ status: 'verified', verification: verification(saved(id).binding) });
    const response = await pending;
    expect(response.status).toBe(403); expect((await response.json()).error.code).toBe('WORLD_REVOKED');
    expect(db().prepare('SELECT count(*) AS n FROM world_verifications').get()).toEqual({ n: 0 });
  });

  it('does not store verification when the requesting session logs out during a provider poll', async () => {
    const p = pair(), id = await challenge(p.left, p.id), waiting = deferred<WorldPollResult>(), entered = deferred<void>();
    fixture.poll.mockImplementationOnce(() => { entered.resolve(); return waiting.promise; });
    const pending = call(p.left, 'world/verify', { challengeId: id });
    await entered.promise;
    expect((await call(p.left, 'auth/logout', {})).status).toBe(200);
    waiting.resolve({ status: 'verified', verification: verification(saved(id).binding) });
    const response = await pending;
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('SIGN_IN_REQUIRED');
    expect(db().prepare('SELECT count(*) AS n FROM world_verifications').get()).toEqual({ n: 0 });
    expect(db().prepare('SELECT count(*) AS n FROM world_identities').get()).toEqual({ n: 0 });
    expect(db().prepare('SELECT used FROM challenges WHERE id=?').get(id)).toEqual({ used: 1 });
  });

  it('rejects an expired challenge before calling the provider', async () => {
    const p = pair(), id = await challenge(p.left, p.id);
    db().prepare('UPDATE challenges SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), id);
    expect((await call(p.left, 'world/verify', { challengeId: id })).status).toBe(403);
    expect(fixture.poll).not.toHaveBeenCalled();
  });

  it('rejects a success that arrives after the bound challenge expires', async () => {
    const p = pair(), id = await challenge(p.left, p.id), stored = saved(id);
    stored.binding.expiresAt = Date.now() + 500;
    stored.session.binding = stored.binding;
    db().prepare('UPDATE challenges SET data=? WHERE id=?').run(encrypt(stored, `challenge:${id}`), id);
    fixture.poll.mockImplementationOnce(async () => {
      vi.spyOn(Date, 'now').mockReturnValue(stored.binding.expiresAt + 1);
      return { status: 'verified', verification: verification(stored.binding) };
    });
    try {
      expect((await call(p.left, 'world/verify', { challengeId: id })).status).toBe(403);
      expect(db().prepare('SELECT count(*) AS n FROM world_verifications').get()).toEqual({ n: 0 });
    } finally { vi.restoreAllMocks(); }
  });

  it.each(['tokenDigest', 'tokenId'] as const)('rejects durable replay by %s even when the other token field changes', async field => {
    const p = pair(), reused = verification({ userId: p.left.id, issuedAt: Date.now(), expiresAt: Date.now() + 300000 } as WorldBinding);
    fixture.poll.mockImplementationOnce(async () => ({ status: 'verified', verification: reused }));
    await verify(p.left, p.id);
    closeDatabase();
    const id = await challenge(p.left, p.id);
    fixture.poll.mockImplementationOnce(async (_session: WorldSession, binding: WorldBinding) => ({ status: 'verified',
      verification: verification(binding, field === 'tokenDigest' ? { tokenDigest: reused.tokenDigest } : { tokenId: reused.tokenId }) }));
    const replay = await call(p.left, 'world/verify', { challengeId: id });
    expect(replay.status).toBe(403); expect((await replay.json()).error.code).toBe('WORLD_REPLAY_DENIED');
    expect(db().prepare('SELECT count(*) AS n FROM world_verifications').get()).toEqual({ n: 1 });
  });

  it('does not allow one issuer subject to represent two application accounts', async () => {
    const p = pair();
    fixture.poll.mockImplementation(async (_session: WorldSession, binding: WorldBinding) => ({ status: 'verified', verification: verification(binding, { subject: 'the-same-test-human' }) }));
    await verify(p.left, p.id);
    const id = await challenge(p.right, p.id);
    const conflict = await call(p.right, 'world/verify', { challengeId: id });
    expect(conflict.status).toBe(403); expect((await conflict.json()).error.code).toBe('WORLD_IDENTITY_CONFLICT');
    expect(() => requireWorld(p.id)).toThrow();
  });

  it('does not allow one account to switch to a second World subject', async () => {
    const p = pair(); await verify(p.left, p.id);
    const id = await challenge(p.left, p.id);
    fixture.poll.mockImplementationOnce(async (_session: WorldSession, binding: WorldBinding) => ({ status: 'verified', verification: verification(binding, { subject: 'another-test-human' }) }));
    const response = await call(p.left, 'world/verify', { challengeId: id });
    expect(response.status).toBe(403); expect((await response.json()).error.code).toBe('WORLD_IDENTITY_CONFLICT');
  });

  it('requires both current verifications and creates one room under concurrent opens', async () => {
    const p = pair();
    expect(() => requireWorld(p.id)).toThrow();
    await verify(p.left, p.id);
    expect(() => requireWorld(p.id)).toThrow();
    await verify(p.right, p.id);
    expect(() => requireWorld(p.id)).not.toThrow();
    closeDatabase();
    expect(() => requireWorld(p.id)).not.toThrow();
    const responses = await Promise.all([call(p.left, `proposals/${p.id}/open`, {}), call(p.right, `proposals/${p.id}/open`, {})]);
    expect(responses.map(x => x.status)).toEqual([200, 200]);
    const ids = await Promise.all(responses.map(async x => (await x.json()).data.id));
    expect(new Set(ids).size).toBe(1);
    expect(db().prepare('SELECT count(*) AS n FROM rooms').get()).toEqual({ n: 1 });
    expect((await call(p.left, `rooms/${ids[0]}/messages`, { body: 'A test-only hello', requestId: randomUUID() })).status).toBe(200);
    fixture.revoked.add(p.right.id);
    expect((await call(p.left, `rooms/${ids[0]}`)).status).toBe(403);
    expect((await call(p.left, `rooms/${ids[0]}/messages`, { body: 'Forbidden after revocation' })).status).toBe(403);
    expect(db().prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 1 });
  });

  it('denies room release after proof expiry or proposal digest changes', async () => {
    const p = pair(); await verify(p.left, p.id); await verify(p.right, p.id);
    db().prepare('UPDATE world_verifications SET expires_at=? WHERE user_id=?').run(new Date(0).toISOString(), p.right.id);
    expect(() => requireWorld(p.id)).toThrow();
    db().prepare('UPDATE world_verifications SET expires_at=?').run(new Date(Date.now() + 60000).toISOString());
    db().prepare('UPDATE proposals SET digest=? WHERE id=?').run(hash('new-proposal'), p.id);
    expect(() => requireWorld(p.id)).toThrow();
    expect((await call(p.left, `proposals/${p.id}/open`, {})).status).toBe(403);
  });

  it('does not reuse sandbox verification after changing the configured issuer or client', async () => {
    const p = pair(); await verify(p.left, p.id); await verify(p.right, p.id);
    expect(() => requireWorld(p.id)).not.toThrow();
    vi.stubEnv('WORLD_ISSUER', 'https://auth.world.org');
    expect(() => requireWorld(p.id)).toThrow();
    vi.stubEnv('WORLD_ISSUER', 'https://sandbox.auth.world.org');
    vi.stubEnv('WORLD_CLIENT_ID', 'a-different-test-client');
    expect(() => requireWorld(p.id)).toThrow();
  });

  it('closes the challenge when the provider fails and never creates a verification', async () => {
    const p = pair(), id = await challenge(p.left, p.id);
    fixture.poll.mockRejectedValueOnce(new Error('Explicit test-only provider outage.'));
    expect((await call(p.left, 'world/verify', { challengeId: id })).status).toBe(503);
    expect((await call(p.left, 'world/verify', { challengeId: id })).status).toBe(403);
    expect(db().prepare('SELECT count(*) AS n FROM world_verifications').get()).toEqual({ n: 0 });
  });

  it('rechecks live authority after the introduction model finishes', async () => {
    const p = pair(); await verify(p.left, p.id); await verify(p.right, p.id);
    fixture.introduction.mockImplementationOnce(async () => {
      fixture.revoked.add(p.right.id);
      return { output: { opening: 'Blocked test-only introduction.', suggestedFirstQuestion: 'A fixture question?' } };
    });
    expect((await call(p.left, `proposals/${p.id}/open`, {})).status).toBe(403);
    expect(db().prepare('SELECT count(*) AS n FROM rooms').get()).toEqual({ n: 0 });
  });

  it('does not create a room when the requesting session logs out during model generation', async () => {
    const p = pair(); await verify(p.left, p.id); await verify(p.right, p.id);
    const waiting = deferred<{ output: { opening: string; suggestedFirstQuestion: string } }>(), entered = deferred<void>();
    fixture.introduction.mockImplementationOnce(() => { entered.resolve(); return waiting.promise; });
    const pending = call(p.left, `proposals/${p.id}/open`, {});
    await entered.promise;
    expect((await call(p.left, 'auth/logout', {})).status).toBe(200);
    waiting.resolve({ output: { opening: 'A test-only pending introduction.', suggestedFirstQuestion: 'A test-only question?' } });
    const response = await pending;
    expect(response.status).toBe(401);
    expect((await response.json()).error.code).toBe('SIGN_IN_REQUIRED');
    expect(db().prepare('SELECT count(*) AS n FROM rooms').get()).toEqual({ n: 0 });
    expect(db().prepare('SELECT status FROM proposals WHERE id=?').get(p.id)).toEqual({ status: 'waiting_consents' });
  });

  it('denies provider success when current authority is revoked during the poll', async () => {
    const p = pair(), id = await challenge(p.left, p.id);
    fixture.poll.mockImplementationOnce(async (_session: WorldSession, binding: WorldBinding) => {
      fixture.revoked.add(p.right.id);
      return { status: 'verified', verification: verification(binding) };
    });
    const response = await call(p.left, 'world/verify', { challengeId: id });
    expect(response.status).toBe(403);
    expect(db().prepare('SELECT count(*) AS n FROM world_verifications').get()).toEqual({ n: 0 });
  });

  it('invalidates a running verification when consent is revoked', async () => {
    const p = pair(), id = await challenge(p.left, p.id), waiting = deferred<WorldPollResult>(), entered = deferred<void>();
    fixture.poll.mockImplementationOnce(() => { entered.resolve(); return waiting.promise; });
    const response = call(p.left, 'world/verify', { challengeId: id });
    await entered.promise;
    expect((await call(p.right, `proposals/${p.id}/consent`, { decision: 'revoke' })).status).toBe(200);
    waiting.resolve({ status: 'verified', verification: verification(saved(id).binding) });
    expect((await response).status).toBeGreaterThanOrEqual(400);
    expect(db().prepare('SELECT count(*) AS n FROM world_verifications').get()).toEqual({ n: 0 });
    expect(() => requireWorld(p.id)).toThrow();
  });
});

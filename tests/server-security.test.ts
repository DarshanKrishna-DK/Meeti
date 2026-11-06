import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { route } from '../packages/server/router';
import { closeDatabase, db, profile, saveAgent, saveIntent, type ProposalData, type UserRow } from '../packages/server/db';
import { decrypt, encrypt, hash } from '../packages/server/crypto';
import { requireBothConsents, requireWorld } from '../packages/server/proposals';
import type { Agent, Intent, Profile, Room } from '../packages/shared/src';

// These local fixture records exercise denial boundaries. They are not provider receipts.
const origin = 'http://127.0.0.1:3198';
const password = 'a local test password 2026';
let directory: string;

async function call(path: string, body?: unknown, cookie?: string, headers: Record<string, string> = {}) {
  return route(new Request(`${origin}/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), path.split('/'));
}
async function register(email = `${randomUUID()}@example.test`) {
  const response = await call('auth/register', { email, password });
  expect(response.status).toBe(200);
  const { data } = await response.json() as { data: { id: string } };
  const cookie = response.headers.get('set-cookie')!.split(';')[0];
  return { id: data.id, email: email.trim().toLowerCase(), cookie, response };
}
function fixtureAgent(userId: string, changes: Partial<Agent['policy']> = {}): Agent {
  const value: Agent = {
    id: randomUUID(), ensName: 'agent.fixture.eth', owner: `0x${'11'.repeat(20)}`,
    delegate: `0x${'22'.repeat(20)}`, persona: 'A test-only fixture.', config: {},
    policy: { version: 1, purpose: 'collaborator', allowedFields: ['headline'],
      allowedActions: ['discover', 'publish', 'negotiate', 'introduce', 'message'],
      expiresAt: new Date(Date.now() + 86400000).toISOString(), paused: false, ...changes },
    authority: { allowed: true, reason: 'Untrusted historical fixture flag', checkedAt: new Date().toISOString() },
  };
  saveAgent(userId, value);
  return value;
}
function fixtureIntent(userId: string, changes: Partial<Intent> = {}): Intent {
  const value: Intent = { id: randomUUID(), version: 1, goal: 'collaborator', summary: 'Test fixture networking intent',
    tags: ['typescript'], expiresAt: new Date(Date.now() + 3600000).toISOString(), createdAt: new Date().toISOString(),
    policyVersion: 1, status: 'published', demoOrigin: true, ...changes };
  saveIntent(userId, value);
  return value;
}
function fixturePair(left: string, right: string) {
  const a = fixtureAgent(left), b = fixtureAgent(right);
  const leftIntent = fixtureIntent(left), rightIntent = fixtureIntent(right);
  const id = randomUUID(), digest = hash(id);
  const value: ProposalData = { leftIntent, rightIntent, leftPolicy: a.policy, rightPolicy: b.policy,
    leftProfileDigest: hash(JSON.stringify(profile(left))), rightProfileDigest: hash(JSON.stringify(profile(right))),
    leftAgent: a.id, rightAgent: b.id, summary: 'A test fixture proposal', compatibility: {}, exchanges: [], createdAt: new Date().toISOString() };
  db().prepare('INSERT INTO proposals(id,left_user,right_user,pair_key,status,digest,data) VALUES(?,?,?,?,?,?,?)')
    .run(id, left, right, id, 'proposed', digest, encrypt(value, `proposal:${id}`));
  const room: Room = { id: randomUUID(), proposalId: id, title: 'Test room', introduction: 'Private opening fixture', createdAt: new Date().toISOString() };
  db().prepare('INSERT INTO rooms VALUES(?,?,?)').run(room.id, id, encrypt(room, `room:${room.id}`));
  return { id, digest, value, room };
}
function fixtureConsent(proposalId: string, userId: string, digest: string, decision = 'approve') {
  db().prepare('INSERT INTO consents VALUES(?,?,?,?,?,?,?)').run(randomUUID(), proposalId, userId, decision, digest, 'test-only-signature', new Date().toISOString());
}

beforeEach(() => {
  closeDatabase();
  directory = mkdtempSync(join(tmpdir(), 'meeti-security-'));
  vi.stubEnv('DATABASE_PATH', join(directory, 'test.sqlite'));
  vi.stubEnv('DATA_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
  vi.stubEnv('APP_ORIGIN', origin);
  vi.stubEnv('ENS_SEPOLIA_RPC_URL', '');
  vi.stubEnv('ARKIV_ACCESS_KEY', '');
});
afterEach(() => {
  closeDatabase();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('durable account and private data security', () => {
  it('persists a normalized account across connection restart without storing password or session plaintext', async () => {
    const actor = await register('  OWNER@example.test  ');
    expect(actor.response.headers.get('set-cookie')).toContain('HttpOnly');
    expect(actor.response.headers.get('set-cookie')).toContain('SameSite=Strict');
    const row = db().prepare('SELECT * FROM users WHERE id=?').get(actor.id) as UserRow;
    expect(row.password_hash).not.toContain(password);
    const token = actor.cookie.split('=')[1];
    expect(db().prepare('SELECT token_hash FROM sessions').get()).toEqual({ token_hash: hash(token) });
    closeDatabase();
    const response = await call('state', undefined, actor.cookie);
    expect(response.status).toBe(200);
    expect((await response.json()).data.user.email).toBe('owner@example.test');
    const wrong = await call('auth/login', { email: actor.email, password: 'a wrong password 2026' });
    expect(wrong.status).toBe(401);
    const login = await call('auth/login', { email: actor.email, password });
    expect(login.status).toBe(200);
    expect(login.headers.get('set-cookie')!.split(';')[0]).not.toBe(actor.cookie);
  });

  it('isolates private profiles, exports and encrypted storage between accounts', async () => {
    const a = await register(), b = await register();
    const profile: Profile = { displayName: 'Private owner', headline: 'Only mine', bio: '', seeking: '', offering: '',
      tags: [], contact: 'private-phone-unique-4477', employer: 'private-employer-unique-9922', publicFields: [], aiConsent: false };
    expect((await call('profile', profile, a.cookie)).status).toBe(200);
    for (const path of ['state', 'export']) {
      const response = await call(path, undefined, b.cookie);
      const text = await response.text();
      expect(response.status).toBe(200);
      expect(text).not.toContain(profile.contact);
      expect(text).not.toContain(profile.employer);
      expect(text).not.toContain(a.email);
    }
    const row = db().prepare('SELECT profile FROM users WHERE id=?').get(a.id) as { profile: string };
    expect(row.profile).not.toContain(profile.contact);
    expect(decrypt<Profile>(row.profile, `profile:${a.id}`)).toEqual(profile);
    expect(() => decrypt(row.profile, `profile:${b.id}`)).toThrow();
    closeDatabase();
    expect(readFileSync(join(directory, 'test.sqlite')).includes(Buffer.from(profile.contact))).toBe(false);
  });

  it('rejects forged cookies, expired sessions and logged-out sessions', async () => {
    const actor = await register();
    expect((await call('state', undefined, `meeti_session=${'a'.repeat(64)}`)).status).toBe(401);
    expect((await call('auth/logout', {}, actor.cookie)).status).toBe(200);
    expect((await call('state', undefined, actor.cookie)).status).toBe(401);
    const login = await call('auth/login', { email: actor.email, password });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    db().prepare('UPDATE sessions SET expires_at=?').run(new Date(Date.now() - 1000).toISOString());
    expect((await call('state', undefined, cookie)).status).toBe(401);
  });

  it('does not allow profile mass assignment or private public-field approval', async () => {
    const actor = await register();
    const own = (await (await call('state', undefined, actor.cookie)).json()).data.profile;
    expect((await call('profile', { ...own, userId: randomUUID() }, actor.cookie)).status).toBe(400);
    expect((await call('profile', { ...own, publicFields: ['contact'] }, actor.cookie)).status).toBe(400);
  });

  it('removes dependent private records and invalidates sessions on account deletion', async () => {
    const a = await register(), b = await register();
    const pair = fixturePair(a.id, b.id);
    fixtureConsent(pair.id, a.id, pair.digest);
    const messageId = randomUUID();
    db().prepare('INSERT INTO messages VALUES(?,?,?,?,?)').run(messageId, pair.room.id, a.id, encrypt('private test message', `message:${messageId}`), new Date().toISOString());
    await call('wallet/challenge', { address: privateKeyToAccount(generatePrivateKey()).address }, a.cookie);
    db().prepare('INSERT INTO blocks VALUES(?,?)').run(b.id, a.id);
    db().prepare('INSERT INTO operations VALUES(?,?,?,?,?,?)').run(randomUUID(), a.id, 'test-only', 'prepared', encrypt({}, 'test-operation'), new Date().toISOString());
    const response = await call('account/delete', { confirmation: 'DELETE' }, a.cookie);
    expect(response.status).toBe(200);
    for (const table of ['agents', 'intents', 'proposals', 'consents', 'rooms', 'messages', 'challenges', 'blocks', 'operations']) {
      expect(db().prepare(`SELECT count(*) AS n FROM ${table}`).get()).toEqual({ n: table === 'agents' || table === 'intents' ? 1 : 0 });
    }
    expect(db().prepare('SELECT 1 FROM audit WHERE user_id=?').get(a.id)).toBeUndefined();
    expect((await call('state', undefined, a.cookie)).status).toBe(401);
    expect((await call('state', undefined, b.cookie)).status).toBe(200);
  });
});

describe('wallet nonce and ownership binding', () => {
  it('binds signed challenges to account and message and rejects signature replay', async () => {
    const a = await register(), b = await register();
    const wallet = privateKeyToAccount(generatePrivateKey());
    const response = await call('wallet/challenge', { address: wallet.address }, a.cookie);
    const { data } = await response.json() as { data: { id: string; message: string } };
    expect(data.message).toContain(`Origin: ${origin}`);
    expect(data.message).toContain(`Account: ${a.id}`);
    expect(data.message).toContain('Chain ID: 11155111');
    const signature = await wallet.signMessage({ message: data.message });
    expect((await call('wallet/verify', { id: data.id, signature }, b.cookie)).status).toBe(403);
    const altered = await wallet.signMessage({ message: data.message + ' altered' });
    expect((await call('wallet/verify', { id: data.id, signature: altered }, a.cookie)).status).toBe(403);
    const concurrent = await Promise.all([call('wallet/verify', { id: data.id, signature }, a.cookie), call('wallet/verify', { id: data.id, signature }, a.cookie)]);
    expect(concurrent.map(x => x.status).sort()).toEqual([200, 403]);
    expect((await call('wallet/verify', { id: data.id, signature }, a.cookie)).status).toBe(403);
    expect((await (await call('state', undefined, a.cookie)).json()).data.user.wallet).toBe(wallet.address.toLowerCase());
    const second = (await (await call('wallet/challenge', { address: wallet.address }, b.cookie)).json()).data;
    const secondSignature = await wallet.signMessage({ message: second.message });
    expect((await call('wallet/verify', { id: second.id, signature: secondSignature }, b.cookie)).status).toBe(409);
  });

  it('rejects expired wallet challenges without changing the account', async () => {
    const actor = await register(), wallet = privateKeyToAccount(generatePrivateKey());
    const { data } = await (await call('wallet/challenge', { address: wallet.address }, actor.cookie)).json();
    db().prepare('UPDATE challenges SET expires_at=? WHERE id=?').run(new Date(Date.now() - 1000).toISOString(), data.id);
    const signature = await wallet.signMessage({ message: data.message });
    expect((await call('wallet/verify', { id: data.id, signature }, actor.cookie)).status).toBe(403);
    expect(db().prepare('SELECT wallet FROM users WHERE id=?').get(actor.id)).toEqual({ wallet: null });
  });

  it('does not let an outstanding challenge rotate an already linked wallet', async () => {
    const actor = await register();
    const first = privateKeyToAccount(generatePrivateKey()), second = privateKeyToAccount(generatePrivateKey());
    const firstChallenge = (await (await call('wallet/challenge', { address: first.address }, actor.cookie)).json()).data;
    const secondChallenge = (await (await call('wallet/challenge', { address: second.address }, actor.cookie)).json()).data;
    const firstSignature = await first.signMessage({ message: firstChallenge.message });
    expect((await call('wallet/verify', { id: firstChallenge.id, signature: firstSignature }, actor.cookie)).status).toBe(200);
    const secondSignature = await second.signMessage({ message: secondChallenge.message });
    expect((await call('wallet/verify', { id: secondChallenge.id, signature: secondSignature }, actor.cookie)).status).toBe(409);
    expect(db().prepare('SELECT wallet FROM users WHERE id=?').get(actor.id)).toEqual({ wallet: first.address.toLowerCase() });
  });
});

describe('provider authority and consequential action denial', () => {
  it.each([
    [{ paused: true }, 403, 'AGENT_PAUSED'],
    [{ expiresAt: new Date(0).toISOString() }, 403, 'POLICY_EXPIRED'],
    [{ allowedActions: [] }, 403, 'ACTION_DENIED'],
    [{}, 503, 'ENS_UNCONFIGURED'],
  ] as const)('denies current authority when policy or provider cannot authorize (%j)', async (policy, status, code) => {
    const actor = await register();
    fixtureAgent(actor.id, policy as Partial<Agent['policy']>);
    const response = await call('agent/check', {}, actor.cookie);
    expect(response.status).toBe(status);
    expect((await response.json()).error.code).toBe(code);
  });

  it('refuses local intent discovery when live ENS authority is unavailable', async () => {
    const actor = await register(); fixtureAgent(actor.id);
    const intent = fixtureIntent(actor.id);
    const response = await call('discover', { intentId: intent.id }, actor.cookie);
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('ENS_UNCONFIGURED');
  });

  it('rejects forged World flags and never releases from local fixture claims', async () => {
    const actor = await register();
    for (const action of ['verify', 'challenge']) {
      const response = await call(`world/${action}`, { verified: true, success: true, proposalId: randomUUID() }, actor.cookie);
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(await response.text()).not.toContain('"verified":true');
    }
    expect(() => requireWorld(randomUUID())).toThrow();
    expect(db().prepare('SELECT count(*) AS n FROM rooms').get()).toEqual({ n: 0 });
  });

  it('denies unrelated proposal, disclosure, block and room access before provider calls', async () => {
    const a = await register(), b = await register(), outsider = await register();
    const pair = fixturePair(a.id, b.id);
    for (const [path, body] of [
      [`proposals/${pair.id}/consent`, { decision: 'decline' }],
      [`proposals/${pair.id}/disclosure`, { fieldId: 'contact' }],
      [`proposals/${pair.id}/open`, { verified: true }],
      ['blocks', { proposalId: pair.id }],
      [`rooms/${pair.room.id}/messages`, { body: 'intrusion' }],
      [`rooms/${pair.room.id}`, undefined],
    ] as const) expect((await call(path, body, outsider.cookie)).status).toBe(404);
    const state = await (await call('state', undefined, outsider.cookie)).json();
    expect(state.data.proposals).toEqual([]);
    expect(state.data.rooms).toEqual([]);
    expect(db().prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 0 });
  });

  it('binds both consent decisions to the exact proposal digest', async () => {
    const a = await register(), b = await register();
    const pair = fixturePair(a.id, b.id);
    const p = { row: { id: pair.id, left_user: a.id, right_user: b.id, pair_key: pair.id, status: 'proposed', digest: pair.digest, data: '' }, value: pair.value };
    fixtureConsent(pair.id, a.id, pair.digest);
    fixtureConsent(pair.id, b.id, hash('stale digest'));
    expect(() => requireBothConsents(p)).toThrow('Both people');
  });

  it('records immutable decline and revoke decisions and invalidates an existing room', async () => {
    const a = await register(), b = await register();
    const pair = fixturePair(a.id, b.id);
    expect((await call(`proposals/${pair.id}/consent`, { decision: 'decline' }, a.cookie)).status).toBe(200);
    expect((await call(`proposals/${pair.id}/consent`, { decision: 'decline' }, a.cookie)).status).toBe(200);
    expect((await call(`proposals/${pair.id}/consent`, { decision: 'revoke' }, a.cookie)).status).toBe(200);
    const rows = db().prepare('SELECT decision,digest,signature FROM consents WHERE proposal_id=? ORDER BY rowid').all(pair.id) as { decision: string; digest: string; signature: string }[];
    expect(rows.map(row => row.decision)).toEqual(['decline', 'revoke']);
    expect(rows.every(row => row.digest === pair.digest && row.signature.length === 64)).toBe(true);
    expect((await call(`rooms/${pair.room.id}`, undefined, b.cookie)).status).toBe(409);
    expect((await call(`rooms/${pair.room.id}/messages`, { body: 'revoked message' }, b.cookie)).status).toBe(409);
  });

  it('invalidates a proposal when a participant changes the consented profile snapshot', async () => {
    const a = await register(), b = await register();
    const pair = fixturePair(a.id, b.id);
    const current = profile(a.id);
    expect((await call('profile', { ...current, headline: 'Changed since this proposal was created' }, a.cookie)).status).toBe(200);
    const response = await call(`proposals/${pair.id}/open`, {}, b.cookie);
    expect(response.status).toBe(409);
    expect((await response.json()).error.code).toBe('PROFILE_CHANGED');
    expect((await call(`rooms/${pair.room.id}/messages`, { body: 'stale-context message' }, b.cookie)).status).toBe(409);
    expect(db().prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 0 });
  });

  it('rejects modification and publication of another account intent', async () => {
    const a = await register(), b = await register(); fixtureAgent(a.id); fixtureAgent(b.id);
    const intent = fixtureIntent(a.id, { status: 'draft' });
    expect((await call('intent', { id: intent.id, goal: intent.goal, summary: intent.summary, tags: intent.tags, expiresAt: intent.expiresAt, publicApproved: true }, b.cookie)).status).toBe(404);
    expect((await call('intent/publish', { intentId: intent.id }, b.cookie)).status).toBe(404);
  });
});

describe('request boundary', () => {
  it('allows an independent anonymous public authority check and denies unknown ENS authority', async () => {
    const response = await call('verifier', { ensName: 'agent.fixture.eth', owner: `0x${'11'.repeat(20)}`, delegate: `0x${'22'.repeat(20)}`, action: 'negotiate' });
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.allowed).toBe(false);
    expect(db().prepare('SELECT count(*) AS n FROM users').get()).toEqual({ n: 0 });
  });
  it.each(['https://attacker.example', 'null', ''])('rejects mutation origin %s', async attackOrigin => {
    const response = await call('auth/register', { email: 'attacker@example.test', password }, undefined, { origin: attackOrigin });
    expect(response.status).toBe(403);
    expect(db().prepare('SELECT count(*) AS n FROM users').get()).toEqual({ n: 0 });
  });
  it('rejects malformed JSON, oversized actual bodies and wrong media types', async () => {
    for (const [body, contentType, status] of [['{', 'application/json', 400], [JSON.stringify({ data: 'x'.repeat(64001) }), 'application/json', 413], ['{}', 'text/plain', 415]] as const) {
      const request = new Request(`${origin}/api/auth/register`, { method: 'POST', headers: { origin, 'content-type': contentType }, body });
      expect((await route(request, ['auth', 'register'])).status).toBe(status);
    }
  });
  it('rate limits repeated authentication attempts without accepting credentials', async () => {
    let response: Response | undefined;
    for (let index = 0; index < 11; index++) response = await call('auth/login', { email: 'missing@example.test', password });
    expect(response!.status).toBe(429);
  });
  it('requires authentication for private routes', async () => {
    expect((await call('state')).status).toBe(401);
    expect((await call('export')).status).toBe(401);
    expect((await call('account/delete', { confirmation: 'DELETE' })).status).toBe(401);
  });
});

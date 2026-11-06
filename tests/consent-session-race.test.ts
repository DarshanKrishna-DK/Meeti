import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Intent, Profile } from '../packages/shared/src';

const external = vi.hoisted(() => ({ fresh: vi.fn(), identity: vi.fn() }));
vi.mock('../packages/server/discovery', async original => ({ ...await original<typeof import('../packages/server/discovery')>(), freshPublicIntent: external.fresh }));
vi.mock('../packages/server/qualifications', async original => ({ ...await original<typeof import('../packages/server/qualifications')>(), assertCurrentPublicIdentityBindings: external.identity }));
import { route } from '../packages/server/router';
import { closeDatabase, db, saveAgent, saveIntent, type ProposalData } from '../packages/server/db';
import { encrypt, hash } from '../packages/server/crypto';
import { createSession } from '../packages/server/security';
import { privateSnapshotDigest } from '../packages/server/context-policy';

// External authority reads are controlled fixtures. Requests, sessions, encryption, consent and database transactions are real.
const origin = 'http://127.0.0.1:3198';
let directory: string;
function account() {
  const id = randomUUID(), wallet = `0x${randomBytes(20).toString('hex')}`, createdAt = new Date().toISOString();
  const profile: Profile = { displayName: 'Fictional consent race account', headline: '', bio: '', seeking: '', offering: '', tags: [], contact: '', employer: '', publicFields: [], aiConsent: false };
  db().prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(id, `${id}@fixture.invalid`, '', wallet, encrypt(profile, `profile:${id}`), createdAt);
  const agent: Agent = { id: randomUUID(), owner: wallet, delegate: `0x${'22'.repeat(20)}`, ensName: 'agent.consent-fixture.eth', persona: '', authority: null, config: {},
    policy: { version: 1, purpose: 'collaborator', allowedFields: [], allowedActions: ['introduce'], paused: false, expiresAt: new Date(Date.now() + 86400000).toISOString() } };
  saveAgent(id, agent);
  const intent: Intent = { id: randomUUID(), version: 1, policyVersion: 1, goal: 'collaborator', summary: 'Fictional consent collaboration fixture.', tags: ['documentation'],
    status: 'published', demoOrigin: true, createdAt, expiresAt: agent.policy.expiresAt, arkivKey: `0x${'aa'.repeat(32)}` };
  saveIntent(id, intent); return { id, cookie: createSession(id).split(';')[0], agent, intent };
}
function pair() {
  const left = account(), right = account(), id = randomUUID(), digest = hash(randomUUID());
  const value: ProposalData = { leftIntent: left.intent, rightIntent: right.intent, leftPolicy: left.agent.policy, rightPolicy: right.agent.policy,
    leftAgent: left.agent.id, rightAgent: right.agent.id, leftProfileDigest: privateSnapshotDigest(left.id), rightProfileDigest: privateSnapshotDigest(right.id),
    summary: 'Fictional consent proposal, not a model result.', compatibility: {}, exchanges: [], createdAt: new Date().toISOString() };
  db().prepare('INSERT INTO proposals VALUES(?,?,?,?,?,?,?)').run(id, left.id, right.id, randomUUID(), 'proposed', digest, encrypt(value, `proposal:${id}`));
  return { id, digest, left, right };
}
function request(owner: ReturnType<typeof account>, id: string, decision = 'approve') {
  return new Request(`${origin}/api/proposals/${id}/consent`, { method: 'POST', headers: { origin, cookie: owner.cookie, 'content-type': 'application/json' }, body: JSON.stringify({ decision }) });
}
function delayed(p: ReturnType<typeof pair>) {
  let release!: () => void, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; }), waiting = new Promise<void>(resolve => { release = resolve; });
  external.fresh.mockImplementationOnce(async () => { entered(); await waiting; });
  const input = request(p.left, p.id);
  return { input, ready, release: () => release(), pending: route(input, ['proposals', p.id, 'consent']) };
}
function snapshot() {
  return { consents: db().prepare('SELECT * FROM consents ORDER BY id').all(), proposals: db().prepare('SELECT * FROM proposals ORDER BY id').all(),
    challenges: db().prepare('SELECT * FROM challenges ORDER BY id').all(), audit: db().prepare('SELECT * FROM audit ORDER BY id').all() };
}
beforeEach(() => {
  closeDatabase(); directory = mkdtempSync(join(tmpdir(), 'meeti-consent-race-'));
  vi.stubEnv('DATABASE_PATH', join(directory, 'fixture.sqlite')); vi.stubEnv('DATA_ENCRYPTION_KEY', randomBytes(32).toString('hex')); vi.stubEnv('APP_ORIGIN', origin);
  external.fresh.mockReset().mockResolvedValue(undefined); external.identity.mockReset().mockResolvedValue(undefined);
  vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('External requests are forbidden in consent race fixtures.'));
});
afterEach(() => { expect(fetch).not.toHaveBeenCalled(); vi.restoreAllMocks(); closeDatabase(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

describe('consent commits recheck the authenticated owner after asynchronous authority', () => {
  it('does not approve after the original session is revoked during provider reads', async () => {
    const p = pair(), before = snapshot(), pending = delayed(p); await pending.ready;
    db().prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(p.left.cookie.split('=')[1])); pending.release();
    const response = await pending.pending; expect(response.status).toBe(401); expect((await response.json()).error.code).toBe('SIGN_IN_REQUIRED'); expect(snapshot()).toEqual(before);
  });
  it('does not approve after the original session expires during provider reads', async () => {
    const p = pair(), before = snapshot(), pending = delayed(p); await pending.ready;
    db().prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?').run('2000-01-01T00:00:00.000Z', hash(p.left.cookie.split('=')[1])); pending.release();
    const response = await pending.pending; expect(response.status).toBe(401); expect(snapshot()).toEqual(before);
  });
  it.each(['counterpart', 'unrelated'] as const)('rejects a changed authenticated account to the %s at the commit boundary', async target => {
    const p = pair(), other = target === 'counterpart' ? p.right : account(), before = snapshot(), pending = delayed(p); await pending.ready;
    // Controlled request-boundary substitution exercises account binding without fabricating wallet verification.
    pending.input.headers.set('cookie', other.cookie); pending.release();
    const response = await pending.pending; expect(response.status).toBe(403); expect((await response.json()).error.code).toBe('ACCOUNT_CHANGED'); expect(snapshot()).toEqual(before);
  });
  it('rejects a changed wallet binding for the same account before recording approval', async () => {
    const p = pair(), before = snapshot(), pending = delayed(p); await pending.ready;
    db().prepare('UPDATE users SET wallet=? WHERE id=?').run(`0x${'99'.repeat(20)}`, p.left.id); pending.release();
    const response = await pending.pending; expect(response.status).toBe(403); expect((await response.json()).error.code).toBe('ACCOUNT_CHANGED'); expect(snapshot()).toEqual(before);
  });
  it('records only the authenticated owner approval when authorization and session stay current', async () => {
    const p = pair(), pending = delayed(p); await pending.ready; pending.release();
    const response = await pending.pending; expect(response.status).toBe(200);
    expect(db().prepare('SELECT user_id,decision,digest FROM consents').all()).toEqual([expect.objectContaining({ user_id: p.left.id, decision: 'approve', digest: p.digest })]);
    expect(db().prepare('SELECT status FROM proposals WHERE id=?').get(p.id)).toMatchObject({ status: 'waiting_consents' });
    expect(db().prepare('SELECT action,outcome FROM audit').all()).toEqual([expect.objectContaining({ action: 'consent', outcome: 'approve' })]);
  });
  it('requires a current session even when repeating an already-recorded approval', async () => {
    const p = pair();
    expect((await route(request(p.left, p.id), ['proposals', p.id, 'consent'])).status).toBe(200);
    const before = snapshot(), pending = delayed(p); await pending.ready;
    db().prepare('DELETE FROM sessions WHERE token_hash=?').run(hash(p.left.cookie.split('=')[1])); pending.release();
    const response = await pending.pending; expect(response.status).toBe(401); expect((await response.json()).error.code).toBe('SIGN_IN_REQUIRED'); expect(snapshot()).toEqual(before);
  });
  it('keeps a changed proposal inactive despite a still-valid session', async () => {
    const p = pair(), pending = delayed(p); await pending.ready;
    db().prepare('UPDATE proposals SET status=? WHERE id=?').run('revoked', p.id); const before = snapshot(); pending.release();
    const response = await pending.pending; expect(response.status).toBe(409); expect(snapshot()).toEqual(before);
  });
  it('does not record approval after an authority read fails', async () => {
    const p = pair(), before = snapshot(); external.fresh.mockRejectedValueOnce(new Error('Fixture authority read failed.'));
    const response = await route(request(p.left, p.id), ['proposals', p.id, 'consent']); expect(response.status).toBe(503); expect((await response.json()).error.code).toBe('OPERATION_UNAVAILABLE'); expect(snapshot()).toEqual(before);
  });
});

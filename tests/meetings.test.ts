import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const gates = vi.hoisted(() => ({ validate: vi.fn(), world: vi.fn() }));
vi.mock('../packages/server/proposals', async original => ({ ...await original<typeof import('../packages/server/proposals')>(), validatePair: gates.validate, requireWorld: gates.world }));
import { closeDatabase, db, saveAgent, saveIntent, type ProposalData } from '../packages/server/db';
import { encrypt } from '../packages/server/crypto';
import { privateSnapshotDigest } from '../packages/server/context-policy';
import { meetingAction, meetingDto } from '../packages/server/meetings';
import { HttpError } from '../packages/server/security';
import type { Agent, Intent } from '../packages/shared/src';

let directory: string;
function owner(label: string) {
  const id = randomUUID(), now = new Date().toISOString();
  db().prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(id, `${id}@fixture.invalid`, '', null, encrypt({ displayName: label, headline: '', bio: '', seeking: '', offering: '', tags: [], contact: '', employer: '', publicFields: [], aiConsent: true }, `profile:${id}`), now);
  const agent: Agent = { id: randomUUID(), ensName: `agent.${label}.eth`, owner: `0x${'11'.repeat(20)}`, delegate: `0x${'22'.repeat(20)}`, persona: '', config: {}, authority: null,
    policy: { version: 1, purpose: 'collaborator', allowedFields: [], allowedActions: ['introduce'], paused: false, expiresAt: new Date(Date.now() + 7200000).toISOString() } };
  saveAgent(id, agent);
  const intent: Intent = { id: randomUUID(), version: 1, goal: 'collaborator', summary: 'Explicit local security fixture', tags: [], createdAt: now, expiresAt: agent.policy.expiresAt, policyVersion: 1, status: 'published', demoOrigin: true };
  saveIntent(id, intent); return { id, agent, intent };
}
function pair() {
  const left = owner('left'), right = owner('right'), id = randomUUID(), digest = randomUUID();
  const data: ProposalData = { leftIntent: left.intent, rightIntent: right.intent, leftPolicy: left.agent.policy, rightPolicy: right.agent.policy,
    leftAgent: left.agent.id, rightAgent: right.agent.id, leftProfileDigest: privateSnapshotDigest(left.id), rightProfileDigest: privateSnapshotDigest(right.id),
    summary: 'Synthetic fixture, not a live agent decision', compatibility: {}, exchanges: [], createdAt: new Date().toISOString() };
  db().prepare('INSERT INTO proposals VALUES(?,?,?,?,?,?,?)').run(id, left.id, right.id, randomUUID(), 'waiting_consents', digest, encrypt(data, `proposal:${id}`));
  for (const userId of [left.id, right.id]) db().prepare('INSERT INTO consents VALUES(?,?,?,?,?,?,?)').run(randomUUID(), id, userId, 'approve', digest, 'fixture', new Date().toISOString());
  return { id, left, right, digest };
}
const availability = { timezone: 'Asia/Kolkata', durationMinutes: 30, intervals: [{ start: '2026-11-07T10:00:00+05:30', end: '2026-11-07T11:00:00+05:30' }], shareForThisMeeting: true };
async function negotiate(p: ReturnType<typeof pair>) {
  await meetingAction(p.left.id, p.id, { action: 'availability', version: 1, availability }, () => {});
  await meetingAction(p.right.id, p.id, { action: 'availability', version: 2, availability }, () => {});
  return meetingDto(p.left.id, p.id);
}
beforeEach(() => {
  closeDatabase(); directory = mkdtempSync(join(tmpdir(), 'meeti-meetings-')); vi.stubEnv('DATABASE_PATH', join(directory, 'test.sqlite'));
  vi.stubEnv('DATA_ENCRYPTION_KEY', randomBytes(32).toString('hex')); vi.stubEnv('WORLD_CAPABILITY_ENABLED', 'false');
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-06T10:00:00Z'));
  gates.validate.mockReset().mockResolvedValue(undefined); gates.world.mockReset().mockImplementation(() => { throw new HttpError(503, 'WORLD_PAUSED', 'World remains paused.'); });
});
afterEach(() => { closeDatabase(); vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

// Current chain and World gates are controlled fixtures. Encryption, tenancy, consent and meeting persistence are real.
describe('meeting agreement authorization and version boundaries', () => {
  it('keeps intervals private, requires both current confirmations, and retains the World final gate', async () => {
    const p = pair(), dto = await negotiate(p);
    expect(dto).toMatchObject({ state: 'proposed', version: 3, confirmationCount: 0, externalInvitationCreated: false });
    expect(dto).not.toHaveProperty('availability'); expect(dto).not.toHaveProperty('otherAvailability');
    await expect(meetingAction(p.left.id, p.id, { action: 'confirm', version: 2 }, () => {})).rejects.toMatchObject({ code: 'MEETING_CHANGED' });
    await meetingAction(p.left.id, p.id, { action: 'confirm', version: 3 }, () => {});
    expect(meetingDto(p.right.id, p.id).confirmationCount).toBe(1);
    await meetingAction(p.right.id, p.id, { action: 'confirm', version: 3 }, () => {});
    await expect(meetingAction(p.right.id, p.id, { action: 'finalize', version: 3 }, () => {})).rejects.toMatchObject({ code: 'WORLD_PAUSED' });
    expect(meetingDto(p.left.id, p.id).state).toBe('confirmed_pending_verification');
    gates.world.mockImplementation(() => {});
    await meetingAction(p.right.id, p.id, { action: 'finalize', version: 3 }, () => {});
    expect(meetingDto(p.left.id, p.id)).toMatchObject({ state: 'agreed', externalInvitationCreated: false });
  });
  it('invalidates approvals when availability changes and denies a guessed slot', async () => {
    const p = pair(); await negotiate(p);
    await meetingAction(p.left.id, p.id, { action: 'confirm', version: 3 }, () => {});
    await meetingAction(p.right.id, p.id, { action: 'availability', version: 3, availability: { ...availability, durationMinutes: 45 } }, () => {});
    expect(meetingDto(p.left.id, p.id)).toMatchObject({ version: 4, state: 'duration_mismatch', confirmationCount: 0, selected: null });
    await expect(meetingAction(p.left.id, p.id, { action: 'select', version: 4, slot: { start: '2026-11-07T00:00:00Z', end: '2026-11-07T01:00:00Z' } }, () => {})).rejects.toMatchObject({ code: 'INVALID_SLOT' });
  });
  it('denies cross-user access and changed consent while cancellation remains possible during outages', async () => {
    const p = pair(); await negotiate(p);
    expect(() => meetingDto(owner('stranger').id, p.id)).toThrow();
    db().prepare('INSERT INTO consents VALUES(?,?,?,?,?,?,?)').run(randomUUID(), p.id, p.left.id, 'revoke', p.digest, 'fixture', new Date().toISOString());
    await expect(meetingAction(p.right.id, p.id, { action: 'confirm', version: 3 }, () => {})).rejects.toMatchObject({ code: 'MUTUAL_CONSENT_REQUIRED' });
    gates.validate.mockRejectedValue(new Error('RPC unavailable'));
    await expect(meetingAction(p.left.id, p.id, { action: 'cancel', version: 3 }, () => {})).resolves.toMatchObject({ state: 'cancelled', version: 4 });
  });
  it('does not commit after session revocation or proposal replacement during a delayed chain check', async () => {
    const p = pair(); await negotiate(p);
    await expect(meetingAction(p.left.id, p.id, { action: 'confirm', version: 3 }, () => { throw new HttpError(401, 'SIGN_IN_REQUIRED', 'Expired'); })).rejects.toMatchObject({ status: 401 });
    expect(meetingDto(p.left.id, p.id).confirmationCount).toBe(0);
    gates.validate.mockImplementation(async () => { db().prepare('UPDATE proposals SET digest=? WHERE id=?').run('changed', p.id); });
    await expect(meetingAction(p.left.id, p.id, { action: 'confirm', version: 3 }, () => {})).rejects.toMatchObject({ code: 'PROPOSAL_CHANGED' });
  });
});

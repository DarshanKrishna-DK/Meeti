import { randomUUID } from 'node:crypto';
import { agent, atomic, audit, db, intent, profile, proposal, type ProposalRow } from './db';
import { decrypt, encrypt, sign } from './crypto';
import { ai, assertIntent, participant, policyDigest } from './policy';
import { HttpError, requireValue } from './security';
import type { Room } from '../shared/src';
import { hasCurrentWorldVerification } from './world-store';
import { requireWorldCapability, worldEnabled } from './capabilities';
import { freshPublicIntent } from './discovery';
import type { RunningStage } from './agent-runs';
import { privateSnapshotDigest } from './context-policy';
import { startQualification } from './qualifications';

export function ownedProposal(userId: string, id: string) {
  const p = requireValue(proposal(id), 'Introduction request was not found.', 404);
  if (![p.row.left_user, p.row.right_user].includes(userId)) throw new HttpError(404, 'NOT_FOUND', 'Introduction request was not found.');
  return p;
}
export function assertPair(p: NonNullable<ReturnType<typeof proposal>>, expectedDigest = p.row.digest) {
  const fresh = requireValue(proposal(p.row.id), 'Introduction request is unavailable.', 404);
  if (fresh.row.digest !== expectedDigest || ['declined', 'revoked', 'expired', 'blocked'].includes(fresh.row.status)) throw new HttpError(409, 'PROPOSAL_INACTIVE', 'This introduction request is no longer active.');
  if (p.value.leftProfileDigest !== privateSnapshotDigest(p.row.left_user) || p.value.rightProfileDigest !== privateSnapshotDigest(p.row.right_user)) {
    throw new HttpError(409, 'PROFILE_CHANGED', 'A profile or its sharing preferences changed. Create a fresh introduction request.');
  }
  const left = requireValue(intent(p.value.leftIntent.id), 'The first intent is unavailable.');
  const right = requireValue(intent(p.value.rightIntent.id), 'The second intent is unavailable.');
  for (const [current, original, owner, policy] of [
    [left, p.value.leftIntent, p.row.left_user, p.value.leftPolicy],
    [right, p.value.rightIntent, p.row.right_user, p.value.rightPolicy],
  ] as const) {
    assertIntent(current.value);
    const a = agent(owner);
    if (current.userId !== owner || current.value.version !== original.version || !a || a.policy.paused
      || policyDigest(a.policy) !== policyDigest(policy) || Date.parse(a.policy.expiresAt) <= Date.now()) {
      throw new HttpError(409, 'STALE_PROPOSAL', 'An intent or permission policy has changed. Create a fresh introduction request.');
    }
  }
  const blocked = db().prepare('SELECT 1 FROM blocks WHERE (user_id=? AND blocked_id=?) OR (user_id=? AND blocked_id=?)').get(p.row.left_user, p.row.right_user, p.row.right_user, p.row.left_user);
  if (blocked) throw new HttpError(403, 'BLOCKED', 'This introduction is blocked.');
  return fresh;
}
export async function validatePair(p: NonNullable<ReturnType<typeof proposal>>, action: 'negotiate' | 'introduce' | 'message') {
  assertPair(p);
  await Promise.all([freshPublicIntent(p.row.left_user, p.value.leftIntent, action), freshPublicIntent(p.row.right_user, p.value.rightIntent, action)]);
  assertPair(p);
}
function latestConsents(p: NonNullable<ReturnType<typeof proposal>>) {
  return [p.row.left_user, p.row.right_user].map(userId => db().prepare('SELECT decision,digest FROM consents WHERE proposal_id=? AND user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(p.row.id, userId) as { decision: string; digest: string } | undefined);
}
export function requireBothConsents(p: NonNullable<ReturnType<typeof proposal>>) {
  if (latestConsents(p).some(c => c?.decision !== 'approve' || c.digest !== p.row.digest)) throw new HttpError(403, 'MUTUAL_CONSENT_REQUIRED', 'Both people must independently approve this introduction.');
}
export async function createProposal(userId: string, ownIntentId: string, candidateKey: string, checkSession: () => void, progress: (stage: RunningStage) => void = () => {}) {
  return startQualification(userId, ownIntentId, candidateKey, checkSession, progress);
}
export async function consent(userId: string, id: string, decision: 'approve' | 'decline' | 'revoke') {
  const p = ownedProposal(userId, id);
  if (decision === 'approve') await validatePair(p, 'introduce');
  return atomic(() => {
    if (decision === 'approve') assertPair(p);
    const prior = db().prepare('SELECT decision FROM consents WHERE proposal_id=? AND user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(id, userId) as { decision: string } | undefined;
    if (prior?.decision === decision) return { decision };
    const createdAt = new Date().toISOString();
    const consentId = randomUUID();
    db().prepare('INSERT INTO consents VALUES(?,?,?,?,?,?,?)').run(consentId, id, userId, decision, p.row.digest,
      sign(JSON.stringify({ consentId, id, userId, decision, digest: p.row.digest, createdAt })), createdAt);
    const status = decision === 'decline' ? 'declined' : decision === 'revoke' ? 'revoked' : 'waiting_consents';
    db().prepare('UPDATE proposals SET status=? WHERE id=?').run(status, id);
    db().prepare('UPDATE challenges SET used=1 WHERE kind LIKE ? AND binding=?').run('world%', id);
    audit(userId, 'consent', decision, `Introduction request ${id}`);
    return { decision };
  });
}

export function requireWorld(proposalId: string): void {
  requireWorldCapability();
  const p = requireValue(proposal(proposalId), 'Introduction request was not found.', 404);
  requireBothConsents(p);
  if (![p.row.left_user, p.row.right_user].every(userId => hasCurrentWorldVerification(proposalId, userId, p.row.digest))) {
    throw new HttpError(403, 'WORLD_VERIFICATION_REQUIRED', 'Both participants must complete fresh World Agent Pass verification for this introduction.');
  }
}
export async function openRoom(userId: string, id: string, checkSession: () => void): Promise<Room> {
  const p = ownedProposal(userId, id);
  await validatePair(p, 'introduce');
  checkSession();
  requireBothConsents(p); requireWorld(id);
  const existing = db().prepare('SELECT id,data FROM rooms WHERE proposal_id=?').get(id) as { id: string; data: string } | undefined;
  if (existing) return decrypt<Room>(existing.data, `room:${existing.id}`);
  const result = await ai().createContextualIntroduction({ left: participant(p.row.left_user, p.value.leftIntent), right: participant(p.row.right_user, p.value.rightIntent), purpose: p.value.leftIntent.goal });
  await validatePair(p, 'introduce');
  checkSession();
  return atomic(() => {
    assertPair(p); requireBothConsents(p); requireWorld(id);
    const prior = db().prepare('SELECT id,data FROM rooms WHERE proposal_id=?').get(id) as { id: string; data: string } | undefined;
    if (prior) return decrypt<Room>(prior.data, `room:${prior.id}`);
    const room: Room = { id: randomUUID(), proposalId: id, title: 'A new connection', introduction: result.output.opening + '\n\n' + result.output.suggestedFirstQuestion, createdAt: new Date().toISOString() };
    db().prepare('INSERT INTO rooms VALUES(?,?,?)').run(room.id, id, encrypt(room, `room:${room.id}`));
    db().prepare('UPDATE proposals SET status=? WHERE id=?').run('introduced', id);
    audit(p.row.left_user, 'introduction', 'opened', room.id); audit(p.row.right_user, 'introduction', 'opened', room.id);
    return room;
  });
}
export async function roomAccess(userId: string, roomId: string) {
  const row = requireValue(db().prepare('SELECT * FROM rooms WHERE id=?').get(roomId) as { id: string; proposal_id: string; data: string } | undefined, 'Room was not found.', 404);
  const p = ownedProposal(userId, row.proposal_id);
  await validatePair(p, 'message'); requireBothConsents(p); requireWorld(p.row.id);
  return { row, p, room: decrypt<Room>(row.data, `room:${row.id}`) };
}
export function proposalDtos(userId: string) {
  const rows = db().prepare('SELECT * FROM proposals WHERE left_user=? OR right_user=? ORDER BY rowid DESC LIMIT 100').all(userId, userId) as ProposalRow[];
  return rows.map(row => {
    const p = requireValue(proposal(row.id), 'Proposal unavailable.');
    const otherId = row.left_user === userId ? row.right_user : row.left_user;
    const other = profile(otherId), otherAgent = agent(otherId);
    const consents = db().prepare('SELECT user_id,decision,digest,created_at FROM consents WHERE proposal_id=? ORDER BY created_at,rowid').all(row.id) as { user_id: string; decision: 'approve' | 'decline' | 'revoke'; digest: string; created_at: string }[];
    const my = consents.filter(x => x.user_id === userId).at(-1);
    const room = db().prepare('SELECT id FROM rooms WHERE proposal_id=?').get(row.id) as { id: string } | undefined;
    let status = row.status;
    try { assertPair(p); } catch { if (!['declined', 'revoked', 'blocked'].includes(status)) status = 'expired'; }
    return { id: row.id, status, digest: row.digest, candidateName: other.publicFields.includes('displayName') ? other.displayName : otherAgent?.ensName || 'Private profile', candidateEns: otherAgent?.ensName || '',
      summary: p.value.summary, compatibility: p.value.compatibility, messages: p.value.exchanges,
      consents: consents.map(x => ({ userId: x.user_id, decision: x.decision, digest: x.digest, createdAt: x.created_at })), myConsent: my?.decision || null,
      world: (() => { try { requireWorld(row.id); return { verified: true, reason: 'Both participants completed fresh verification for this introduction.' }; } catch { return { verified: false, reason: worldEnabled() ? 'Both participants must complete fresh verification before release.' : 'World verification is paused. Protected introductions remain locked.' }; } })(), createdAt: p.value.createdAt, roomId: room?.id };
  });
}

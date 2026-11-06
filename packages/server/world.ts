import { randomBytes, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { createWorldProvider, WorldError, type WorldBinding, type WorldSession } from '../world';
import { atomic, audit, db, proposal } from './store';
import { decrypt, encrypt, hash, sign } from './crypto';
import { HttpError, requireValue, requireUser } from './security';
import { ownedProposal, validatePair, assertPair, requireBothConsents } from './proposals';
import { hasCurrentWorldVerification } from './world-store';
import { requireWorldCapability } from './capabilities';

function sessionBinding(request: Request) { return hash(request.headers.get('cookie')?.split(';').map(x => x.trim()).find(x => x.startsWith('meeti_session=')) || ''); }
function worldError(error: unknown): never {
  if (error instanceof WorldError) throw new HttpError(error.code === 'configuration' ? 503 : 403, 'WORLD_' + error.code.toUpperCase(), error.message);
  throw new HttpError(503, 'WORLD_UNAVAILABLE', 'World verification is unavailable. The protected introduction remains locked.');
}
export async function startWorld(request: Request, userId: string, body: unknown) {
  requireWorldCapability();
  const { proposalId } = z.object({ proposalId: z.string().uuid() }).strict().parse(body);
  const p = await ownedProposal(userId, proposalId);
  await validatePair(p, 'introduce'); await requireBothConsents(p);
  const now = Date.now(), id = randomUUID();
  const binding: WorldBinding = { challengeId: id, userId, sessionBinding: sessionBinding(request), proposalId,
    proposalDigest: p.row.digest, candidateId: p.row.left_user === userId ? p.row.right_user : p.row.left_user,
    action: 'introduce', nonce: randomBytes(32).toString('hex'), issuedAt: now, expiresAt: now + 300000 };
  try {
    const result = await createWorldProvider().start(binding);
    await validatePair(p, 'introduce');
    if ((await requireUser(request)).id !== userId) throw new HttpError(401, 'SESSION_CLOSED', 'Sign in again before requesting verification.');
    await assertPair(p); await requireBothConsents(p);
    await atomic(async () => {
      await db().prepare('UPDATE challenges SET used=1 WHERE user_id=? AND kind=? AND binding=?').run(userId, 'world', proposalId);
      await db().prepare('INSERT INTO challenges VALUES(?,?,?,?,?,?,0)').run(id, userId, 'world', proposalId, encrypt({ binding, session: result.session }, `challenge:${id}`), new Date(binding.expiresAt).toISOString());
      await audit(userId, 'world_challenge', 'created', `Introduction request ${proposalId}. Identity mode: ${result.challenge.identityMode}.`);
    });
    return result.challenge;
  } catch (error) { return worldError(error); }
}
export async function pollWorld(request: Request, userId: string, body: unknown) {
  requireWorldCapability();
  const { challengeId, proposalId } = z.object({ challengeId: z.string().uuid(), proposalId: z.string().uuid().optional() }).strict().parse(body);
  const row = requireValue(await db().prepare('SELECT * FROM challenges WHERE id=? AND user_id=? AND kind=?').get(challengeId, userId, 'world') as { id: string; binding: string; data: string; expires_at: string; used: number } | undefined, 'World challenge was not found.', 404);
  if (row.used !== 0 || Date.parse(row.expires_at) <= Date.now()) throw new HttpError(403, 'WORLD_CHALLENGE_EXPIRED', 'This challenge is expired, cancelled, or already used.');
  if (proposalId && proposalId !== row.binding) throw new HttpError(403, 'WORLD_BINDING_CHANGED', 'This challenge belongs to a different introduction.');
  const saved = decrypt<{ binding: WorldBinding; session: WorldSession }>(row.data, `challenge:${row.id}`);
  if (saved.binding.sessionBinding !== sessionBinding(request)) throw new HttpError(403, 'WORLD_SESSION_MISMATCH', 'Complete this challenge from the browser session that requested it.');
  const p = await ownedProposal(userId, row.binding);
  await validatePair(p, 'introduce'); await requireBothConsents(p);
  if (p.row.digest !== saved.binding.proposalDigest) throw new HttpError(409, 'WORLD_BINDING_CHANGED', 'The introduction changed after verification was requested.');
  if (saved.session.nextPollAt > Date.now()) return { status: 'pending', pollIntervalSeconds: Math.max(1, Math.ceil((saved.session.nextPollAt - Date.now()) / 1000)) };
  const reserved = await db().prepare('UPDATE challenges SET used=2 WHERE id=? AND used=0 AND expires_at>?').run(row.id, new Date().toISOString());
  if (reserved.changes !== 1) throw new HttpError(409, 'WORLD_POLL_BUSY', 'This challenge is already being checked.');
  try {
    const result = await createWorldProvider().poll(saved.session, saved.binding);
    await validatePair(p, 'introduce'); await requireBothConsents(p);
    if ((await requireUser(request)).id !== userId) throw new HttpError(401, 'SESSION_CLOSED', 'This browser session is no longer active.');
    return await atomic(async () => {
      await assertPair(p); await requireBothConsents(p);
      const current = await db().prepare('SELECT used FROM challenges WHERE id=?').get(row.id) as { used: number } | undefined;
      if (!current || current.used !== 2 || Date.now() >= saved.binding.expiresAt) throw new HttpError(403, 'WORLD_REVOKED', 'The challenge was cancelled or expired during verification.');
      if (result.status === 'pending') {
        await db().prepare('UPDATE challenges SET used=0,data=? WHERE id=?').run(encrypt({ binding: saved.binding, session: result.session }, `challenge:${row.id}`), row.id);
        return { status: 'pending', pollIntervalSeconds: result.pollIntervalSeconds };
      }
      const v = result.verification, subjectHash = sign(v.issuer + '|' + v.subject);
      const identity = await db().prepare('SELECT user_id FROM world_identities WHERE subject_hash=?').get(subjectHash) as { user_id: string } | undefined;
      const owner = await db().prepare('SELECT subject_hash FROM world_identities WHERE user_id=?').get(userId) as { subject_hash: string } | undefined;
      if ((identity && identity.user_id !== userId) || (owner && owner.subject_hash !== subjectHash)) throw new HttpError(403, 'WORLD_IDENTITY_CONFLICT', 'This World identity is already linked to a different account, or this account has a different identity.');
      const tokenIdHash = hash(v.issuer + '|' + v.tokenId);
      if (await db().prepare('SELECT id FROM world_verifications WHERE token_digest=? OR token_id_hash=?').get(v.tokenDigest, tokenIdHash)) throw new HttpError(403, 'WORLD_REPLAY_DENIED', 'This verification has already been used.');
      await db().prepare('INSERT OR IGNORE INTO world_identities VALUES(?,?)').run(subjectHash, userId);
      const expiresAt = new Date(Math.min(Date.parse(v.expiresAt), saved.binding.expiresAt)).toISOString();
      const verificationId = randomUUID();
      await db().prepare('INSERT INTO world_verifications VALUES(?,?,?,?,?,?,?,?)').run(verificationId, userId, p.row.id, p.row.digest, v.tokenDigest, tokenIdHash,
        encrypt({ issuer: v.issuer, clientId: saved.session.clientId, subjectHash, authTime: v.authTime, verifiedAt: v.verifiedAt, identityMode: v.identityMode, sessionBinding: saved.binding.sessionBinding }, `world:${verificationId}`), expiresAt);
      await db().prepare('UPDATE challenges SET used=1 WHERE id=?').run(row.id);
      await audit(userId, 'world_verification', 'verified', `Fresh protected-action verification. Identity mode: ${v.identityMode}.`);
      return { status: 'verified', expiresAt, identityMode: v.identityMode };
    });
  } catch (error) {
    await db().prepare('UPDATE challenges SET used=1 WHERE id=? AND used=2').run(row.id);
    await audit(userId, 'world_verification', 'denied', 'No protected action was released. Request a fresh challenge after resolving the issue.');
    if (error instanceof HttpError) throw error;
    return worldError(error);
  }
}
export async function cancelWorld(userId: string, body: unknown) {
  const { challengeId, proposalId } = z.object({ challengeId: z.string().uuid(), proposalId: z.string().uuid().optional() }).strict().parse(body);
  const row = await db().prepare('SELECT binding,used FROM challenges WHERE id=? AND user_id=? AND kind=?').get(challengeId, userId, 'world') as { binding: string; used: number } | undefined;
  if (!row) throw new HttpError(404, 'NOT_FOUND', 'World challenge was not found.');
  if (proposalId && proposalId !== row.binding) throw new HttpError(403, 'WORLD_BINDING_CHANGED', 'This challenge belongs to a different introduction.');
  const result = await db().prepare('UPDATE challenges SET used=1 WHERE id=? AND used IN (0,2)').run(challengeId);
  if (result.changes !== 1) throw new HttpError(409, 'WORLD_CHALLENGE_CLOSED', 'This checkpoint is already closed. Revoke introduction consent to withdraw an approval.');
  await audit(userId, 'world_challenge', 'cancelled', 'The owner cancelled human verification.');
  return { cancelled: true };
}
export async function worldStatus(proposalId: string, userId: string) {
  const p = await proposal(proposalId);
  if (!p || ![p.row.left_user, p.row.right_user].includes(userId)) return { verified: false, reason: 'Introduction request was not found.' };
  const verification = await Promise.all([p.row.left_user, p.row.right_user].map(id => hasCurrentWorldVerification(proposalId, id, p.row.digest)));
  const verified = verification.every(value => value === true);
  return { verified, reason: verified ? 'Both participants completed fresh World verification for this introduction.' : 'Both participants must complete fresh World verification before release.' };
}

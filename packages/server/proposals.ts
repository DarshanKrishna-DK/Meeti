import { randomUUID } from 'node:crypto';
import { agent, atomic, audit, db, intent, profile, proposal, type ProposalRow } from './store';
import { decrypt, encrypt, hash, sign } from './crypto';
import { ai, assertIntent, participant, policyDigest } from './policy';
import { HttpError, requireValue } from './security';
import type { Room } from '../shared/src';
import { hasCurrentWorldVerification } from './world-store';
import { requireWorldCapability, worldEnabled } from './capabilities';
import { freshPublicIntent } from './discovery';
import type { RunningStage } from './agent-runs';
import { privateSnapshotDigest } from './context-policy';
import { assertCurrentPublicIdentityBindings, startQualification } from './qualifications';
import { qualificationRecord } from './qualification-context';
export async function ownedProposal(userId: string, id: string) {
    const p = requireValue(await proposal(id), 'Introduction request was not found.', 404);
    if (![p.row.left_user, p.row.right_user].includes(userId))
        throw new HttpError(404, 'NOT_FOUND', 'Introduction request was not found.');
    return p;
}
export async function assertPair(p: NonNullable<Awaited<ReturnType<typeof proposal>>>, expectedDigest = p.row.digest) {
    const fresh = requireValue(await proposal(p.row.id), 'Introduction request is unavailable.', 404);
    if (fresh.row.digest !== expectedDigest || ['declined', 'revoked', 'expired', 'blocked'].includes(fresh.row.status))
        throw new HttpError(409, 'PROPOSAL_INACTIVE', 'This introduction request is no longer active.');
    if (p.value.leftProfileDigest !== await privateSnapshotDigest(p.row.left_user) || p.value.rightProfileDigest !== await privateSnapshotDigest(p.row.right_user)) {
        throw new HttpError(409, 'PROFILE_CHANGED', 'A profile or its sharing preferences changed. Create a fresh introduction request.');
    }
    const left = requireValue(await intent(p.value.leftIntent.id), 'The first intent is unavailable.');
    const right = requireValue(await intent(p.value.rightIntent.id), 'The second intent is unavailable.');
    for (const [current, original, owner, policy] of [
        [left, p.value.leftIntent, p.row.left_user, p.value.leftPolicy],
        [right, p.value.rightIntent, p.row.right_user, p.value.rightPolicy],
    ] as const) {
        assertIntent(current.value);
        const a = await agent(owner);
        if (current.userId !== owner || current.value.version !== original.version || !a || a.policy.paused
            || policyDigest(a.policy) !== policyDigest(policy) || Date.parse(a.policy.expiresAt) <= Date.now()) {
            throw new HttpError(409, 'STALE_PROPOSAL', 'An intent or permission policy has changed. Create a fresh introduction request.');
        }
    }
    const blocked = await db().prepare('SELECT 1 FROM blocks WHERE (user_id=? AND blocked_id=?) OR (user_id=? AND blocked_id=?)').get(p.row.left_user, p.row.right_user, p.row.right_user, p.row.left_user);
    if (blocked)
        throw new HttpError(403, 'BLOCKED', 'This introduction is blocked.');
    return fresh;
}
export async function validatePair(p: NonNullable<Awaited<ReturnType<typeof proposal>>>, action: 'negotiate' | 'introduce' | 'message') {
    await assertPair(p);
    const source = await db().prepare('SELECT id FROM qualifications WHERE pair_key=?').get(p.row.pair_key) as {
        id: string;
    } | undefined;
    const qualification = source ? requireValue(await qualificationRecord(source.id), 'The originating agent review is unavailable.', 409) : null;
    const newFormat = p.value.compatibility && typeof p.value.compatibility === 'object' && 'qualification' in p.value.compatibility;
    if (qualification) {
        if (qualification.row.left_user !== p.row.left_user || qualification.row.right_user !== p.row.right_user || qualification.row.state !== 'proposed'
            || qualification.value.proposalId !== p.row.id || qualification.value.result?.state !== 'qualified'
            || JSON.stringify(qualification.value.snapshot) !== JSON.stringify(p.value)
            || hash(JSON.stringify({ pairKey: qualification.row.pair_key, snapshot: qualification.value.snapshot })) !== p.row.digest) {
            throw new HttpError(409, 'QUALIFICATION_BINDING_CHANGED', 'This introduction no longer agrees with its completed agent review.');
        }
    }
    else if (newFormat)
        throw new HttpError(409, 'QUALIFICATION_REQUIRED', 'The completed agent review for this introduction is unavailable.');
    await Promise.all([freshPublicIntent(p.row.left_user, p.value.leftIntent, action), freshPublicIntent(p.row.right_user, p.value.rightIntent, action),
        assertCurrentPublicIdentityBindings(p.row.left_user, p.row.right_user, qualification?.value.publicIdentities)]);
    await assertPair(p);
}
async function latestConsents(p: NonNullable<Awaited<ReturnType<typeof proposal>>>) {
    return Promise.all([p.row.left_user, p.row.right_user].map(async (userId) => await db().prepare('SELECT decision,digest FROM consents WHERE proposal_id=? AND user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(p.row.id, userId) as {
        decision: string;
        digest: string;
    } | undefined));
}
export async function requireBothConsents(p: NonNullable<Awaited<ReturnType<typeof proposal>>>) {
    if ((await latestConsents(p)).some(c => c?.decision !== 'approve' || c.digest !== p.row.digest))
        throw new HttpError(403, 'MUTUAL_CONSENT_REQUIRED', 'Both people must independently approve this introduction.');
}
export async function createProposal(userId: string, ownIntentId: string, candidateKey: string, checkSession: () => void | Promise<void>, progress: (stage: RunningStage) => void | Promise<void> = () => { }) {
    return startQualification(userId, ownIntentId, candidateKey, checkSession, progress);
}
export async function consent(userId: string, id: string, decision: 'approve' | 'decline' | 'revoke', checkSession: () => void | Promise<void>) {
    const p = await ownedProposal(userId, id);
    if (decision === 'approve')
        await validatePair(p, 'introduce');
    return await atomic(async () => {
        await checkSession();
        if (decision === 'approve')
            await assertPair(p);
        const prior = await db().prepare('SELECT decision FROM consents WHERE proposal_id=? AND user_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1').get(id, userId) as {
            decision: string;
        } | undefined;
        if (prior?.decision === decision)
            return { decision };
        const createdAt = new Date().toISOString();
        const consentId = randomUUID();
        await db().prepare('INSERT INTO consents VALUES(?,?,?,?,?,?,?)').run(consentId, id, userId, decision, p.row.digest, sign(JSON.stringify({ consentId, id, userId, decision, digest: p.row.digest, createdAt })), createdAt);
        const status = decision === 'decline' ? 'declined' : decision === 'revoke' ? 'revoked' : 'waiting_consents';
        await db().prepare('UPDATE proposals SET status=? WHERE id=?').run(status, id);
        await db().prepare('UPDATE challenges SET used=1 WHERE kind LIKE ? AND binding=?').run('world%', id);
        await audit(userId, 'consent', decision, `Introduction request ${id}`);
        return { decision };
    });
}
export async function requireWorld(proposalId: string): Promise<void> {
    requireWorldCapability();
    const p = requireValue(await proposal(proposalId), 'Introduction request was not found.', 404);
    await requireBothConsents(p);
    const verified = await Promise.all([p.row.left_user, p.row.right_user].map(userId => hasCurrentWorldVerification(proposalId, userId, p.row.digest)));
    if (!verified.every(Boolean)) {
        throw new HttpError(403, 'WORLD_VERIFICATION_REQUIRED', 'Both participants must complete fresh World Agent Pass verification for this introduction.');
    }
}
export async function openRoom(userId: string, id: string, checkSession: () => void | Promise<void>): Promise<Room> {
    const p = await ownedProposal(userId, id);
    await validatePair(p, 'introduce');
    await checkSession();
    await requireBothConsents(p);
    await requireWorld(id);
    const existing = await db().prepare('SELECT id,data FROM rooms WHERE proposal_id=?').get(id) as {
        id: string;
        data: string;
    } | undefined;
    if (existing) {
        await checkSession();
        return decrypt<Room>(existing.data, `room:${existing.id}`);
    }
    const left = await participant(p.row.left_user, p.value.leftIntent), right = await participant(p.row.right_user, p.value.rightIntent);
    await checkSession();
    const result = await ai().createContextualIntroduction({ left, right, purpose: p.value.leftIntent.goal });
    await validatePair(p, 'introduce');
    await checkSession();
    return await atomic(async () => {
        await checkSession();
        await assertPair(p);
        await requireBothConsents(p);
        await requireWorld(id);
        const prior = await db().prepare('SELECT id,data FROM rooms WHERE proposal_id=?').get(id) as {
            id: string;
            data: string;
        } | undefined;
        if (prior)
            return decrypt<Room>(prior.data, `room:${prior.id}`);
        const room: Room = { id: randomUUID(), proposalId: id, title: 'A new connection', introduction: result.output.opening + '\n\n' + result.output.suggestedFirstQuestion, createdAt: new Date().toISOString() };
        await db().prepare('INSERT INTO rooms VALUES(?,?,?)').run(room.id, id, encrypt(room, `room:${room.id}`));
        await db().prepare('UPDATE proposals SET status=? WHERE id=?').run('introduced', id);
        await audit(p.row.left_user, 'introduction', 'opened', room.id);
        await audit(p.row.right_user, 'introduction', 'opened', room.id);
        return room;
    });
}
export async function roomAccess(userId: string, roomId: string) {
    const row = requireValue(await db().prepare('SELECT * FROM rooms WHERE id=?').get(roomId) as {
        id: string;
        proposal_id: string;
        data: string;
    } | undefined, 'Room was not found.', 404);
    const p = await ownedProposal(userId, row.proposal_id);
    await validatePair(p, 'message');
    await requireBothConsents(p);
    await requireWorld(p.row.id);
    return { row, p, room: decrypt<Room>(row.data, `room:${row.id}`) };
}
export async function proposalDtos(userId: string) {
    const rows = await db().prepare('SELECT * FROM proposals WHERE left_user=? OR right_user=? ORDER BY rowid DESC LIMIT 100').all(userId, userId) as ProposalRow[];
    return Promise.all(rows.map(async (row) => {
        const p = requireValue(await proposal(row.id), 'Proposal unavailable.');
        const otherId = row.left_user === userId ? row.right_user : row.left_user;
        const other = await profile(otherId), otherAgent = await agent(otherId);
        const consents = await db().prepare('SELECT user_id,decision,digest,created_at FROM consents WHERE proposal_id=? ORDER BY created_at,rowid').all(row.id) as {
            user_id: string;
            decision: 'approve' | 'decline' | 'revoke';
            digest: string;
            created_at: string;
        }[];
        const my = consents.filter(x => x.user_id === userId).at(-1);
        const room = await db().prepare('SELECT id FROM rooms WHERE proposal_id=?').get(row.id) as {
            id: string;
        } | undefined;
        let status = row.status;
        try {
            await assertPair(p);
        }
        catch {
            if (!['declined', 'revoked', 'blocked'].includes(status))
                status = 'expired';
        }
        return { id: row.id, status, digest: row.digest, candidateName: other.publicFields.includes('displayName') ? other.displayName : otherAgent?.ensName || 'Private profile', candidateEns: otherAgent?.ensName || '',
            summary: p.value.summary, compatibility: p.value.compatibility, messages: p.value.exchanges,
            consents: consents.map(x => ({ userId: x.user_id, decision: x.decision, digest: x.digest, createdAt: x.created_at })), myConsent: my?.decision || null,
            world: await (async () => {
                try {
                    await requireWorld(row.id);
                    return { verified: true, reason: 'Both participants completed fresh verification for this introduction.' };
                }
                catch {
                    return { verified: false, reason: worldEnabled() ? 'Both participants must complete fresh verification before release.' : 'World verification is paused. Protected introductions remain locked.' };
                }
            })(), createdAt: p.value.createdAt, roomId: room?.id };
    }));
}

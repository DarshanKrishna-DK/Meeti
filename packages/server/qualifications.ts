import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { agent, atomic, audit, db, intent, type ProposalData } from './store';
import { encrypt, hash } from './crypto';
import { ai, arkiv, assertIntent, authority, participant, policyDigest } from './policy';
import { assessPair, freshPublicIntent } from './discovery';
import { privateSnapshotDigest } from './context-policy';
import { resolveCurrentPublicAgentIdentityForUser } from './identity';
import { HttpError, requireValue } from './security';
import { answerFieldId, qualificationFields, qualificationRecord, type QualificationAnswer, type QualificationData, type QualificationPublicIdentityBinding, type QualificationRow } from './qualification-context';
import type { RunningStage } from './agent-runs';
import { AgentError, qualificationCheckpointSchema, qualificationOutputDiagnostic } from '../agents/src';
import { withEnsReadScope } from '../ens/rpc-transport';
type RecordValue = NonNullable<Awaited<ReturnType<typeof qualificationRecord>>>;
export type QualificationContinuation = { qualificationId: string; version: number; checkpointDigest: string };
export type QualificationWorkerOptions = { singleTurn?: true; deadlineMs?: number; onYield?: (continuation: QualificationContinuation) => Promise<void> };
/** Only a server worker callback can persist and consume this continuation. It is never a public retry request. */
export class QualificationYield extends Error {
    constructor(readonly continuation: QualificationContinuation) { super('QUALIFICATION_WORKER_YIELDED'); }
}
class AcceptedTurnComplete extends Error {}
const checkpointReady = 'WORKER_CHECKPOINT_READY';
function requireWorkerTime(worker: QualificationWorkerOptions) {
    if (worker.deadlineMs !== undefined && (!Number.isSafeInteger(worker.deadlineMs) || Date.now() + 120000 >= worker.deadlineMs))
        throw new HttpError(503, 'QUALIFICATION_WORKER_DEADLINE', 'This worker has insufficient time for another bounded model turn and its authorization checks. Review current activity before an explicit retry.');
}
function assertAcceptedCheckpoint(record: RecordValue, expectedDigest?: string) {
    const checkpoint = qualificationCheckpointSchema.safeParse(record.value.checkpoint), attempts = record.value.attempts;
    if (!checkpoint.success || !checkpoint.data.messages.length || !attempts?.length
        || hash(JSON.stringify(checkpoint.data.messages)) !== hash(JSON.stringify(record.value.messages))
        || checkpoint.data.messages.at(-1)?.inference.requestId !== attempts.at(-1)?.requestId
        || checkpoint.data.messages.some(message => !attempts.some(attempt => attempt.requestId === message.inference.requestId))
        || expectedDigest && hash(JSON.stringify(checkpoint.data)) !== expectedDigest)
        throw new HttpError(409, 'QUALIFICATION_CHECKPOINT_INVALID', 'The saved worker checkpoint cannot authorize continuation.');
    return checkpoint.data;
}
const versionInput = z.object({ version: z.number().int().positive() }).strict();
const answerInput = versionInput.extend({ questionId: z.string().uuid(), text: z.string().trim().min(1).max(1200), fieldClass: z.enum(['bio', 'seeking', 'offering']), providerDisclosureConsent: z.literal(true), shareWithCounterpart: z.literal(true) }).strict();
async function owned(userId: string, id: string): Promise<RecordValue> {
    const record = requireValue(await qualificationRecord(id), 'Conversation was not found.', 404);
    if (![record.row.left_user, record.row.right_user].includes(userId))
        throw new HttpError(404, 'NOT_FOUND', 'Conversation was not found.');
    return record;
}
async function current(record: RecordValue) {
    const { row, value: { snapshot } } = record;
    if (await db().prepare('SELECT 1 FROM blocks WHERE (user_id=? AND blocked_id=?) OR (user_id=? AND blocked_id=?)').get(row.left_user, row.right_user, row.right_user, row.left_user))
        throw new HttpError(403, 'BLOCKED', 'This conversation is blocked.');
    for (const side of ['left', 'right'] as const) {
        const userId = side === 'left' ? row.left_user : row.right_user, expected = snapshot[`${side}Intent`], a = await agent(userId), local = await intent(expected.id);
        if (!a || !local || local.userId !== userId || local.value.version !== expected.version || local.value.arkivKey !== expected.arkivKey || a.id !== snapshot[`${side}Agent`]
            || policyDigest(a.policy) !== policyDigest(snapshot[`${side}Policy`]) || await privateSnapshotDigest(userId) !== snapshot[`${side}ProfileDigest`])
            throw new HttpError(409, 'QUALIFICATION_CHANGED', 'An owner context, intent or policy changed. Start a fresh review.');
        assertIntent(local.value);
        if (a.policy.paused || Date.parse(a.policy.expiresAt) <= Date.now())
            throw new HttpError(403, 'POLICY_INACTIVE', 'The current policy is inactive.');
    }
}
async function publicIdentityBinding(userId: string): Promise<QualificationPublicIdentityBinding> {
    const result = await resolveCurrentPublicAgentIdentityForUser(userId).catch(error => {
        if (error instanceof HttpError)
            throw error;
        throw new HttpError(503, 'PUBLIC_IDENTITY_READ_UNAVAILABLE', 'The current public agent identity could not be read. Retry after the provider recovers.');
    }), a = requireValue(await agent(userId), 'Agent is unavailable.');
    if (result.ensName !== a.ensName || result.owner.toLowerCase() !== a.owner.toLowerCase() || result.observed.chainId !== 11155111
        || !['absent', 'valid'].includes(result.context.state) || !['absent', 'verified'].includes(result.association.state)
        || (result.context.state === 'valid' && !result.context.value) || (result.association.state === 'verified' && !result.association.identity)) {
        throw new HttpError(403, 'PUBLIC_IDENTITY_DENIED', 'The current public agent identity or declared registration could not be verified.');
    }
    // Remote prose remains untrusted public data. Only its binding digest and verification states persist here.
    return { context: result.context.state as 'absent' | 'valid', association: result.association.state as 'absent' | 'verified',
        digest: hash(JSON.stringify({ ensName: result.ensName, owner: result.owner.toLowerCase(), chainId: result.observed.chainId,
            context: { state: result.context.state, value: result.context.value ?? null }, association: { state: result.association.state, identity: result.association.identity ?? null } })) };
}
async function currentPublicIdentities(record: RecordValue) {
    await current(record);
    const identities = await assertCurrentPublicIdentityBindings(record.row.left_user, record.row.right_user, record.value.publicIdentities);
    await current(record);
    return identities;
}
/** A proposal without historical metadata bindings cannot claim a newly declared registration. */
export async function assertCurrentPublicIdentityBindings(leftUser: string, rightUser: string, expected?: QualificationData['publicIdentities']) {
    return withEnsReadScope(() => readCurrentPublicIdentityBindings(leftUser, rightUser, expected));
}
async function readCurrentPublicIdentityBindings(leftUser: string, rightUser: string, expected?: QualificationData['publicIdentities']) {
    const [left, right] = await Promise.all([publicIdentityBinding(leftUser), publicIdentityBinding(rightUser)]);
    if (expected && (expected.left.digest !== left.digest || expected.right.digest !== right.digest))
        throw new HttpError(409, 'PUBLIC_IDENTITY_CHANGED', 'A public agent context or registration changed. Start a fresh candidate review.');
    if (!expected && [left, right].some(identity => identity.context !== 'absent' || identity.association !== 'absent'))
        throw new HttpError(409, 'PUBLIC_IDENTITY_BINDING_REQUIRED', 'This older introduction has no matching public identity review. Create a fresh introduction request.');
    return { left, right };
}
async function live(record: RecordValue) {
    await current(record);
    // One gate shares only identical reads pinned to the same block. The scope ends
    // before inference, so subsequent actions always resolve current authority again.
    const [, , identities] = await withEnsReadScope(() => Promise.all([
        freshPublicIntent(record.row.left_user, record.value.snapshot.leftIntent, 'negotiate'),
        freshPublicIntent(record.row.right_user, record.value.snapshot.rightIntent, 'negotiate'),
        readCurrentPublicIdentityBindings(record.row.left_user, record.row.right_user, record.value.publicIdentities),
    ]));
    await current(record);
    return identities;
}
async function persist(record: RecordValue, state: string, token?: string) {
    const result = await db().prepare('UPDATE qualifications SET state=?,version=version+1,data=?,updated_at=? WHERE id=? AND version=?' + (token ? " AND lease_token=? AND lease_until>?" : ''))
        .run(state, encrypt(record.value, `qualification:${record.row.id}`), new Date().toISOString(), record.row.id, record.row.version, ...(token ? [token, new Date().toISOString()] : []));
    if (result.changes !== 1)
        throw new HttpError(409, 'QUALIFICATION_CHANGED', 'This conversation changed or its execution lease expired. Refresh before continuing.');
}
function summary(value: QualificationData) { return value.result?.messages.slice(-2).map(message => message.message).join('\n\n') || 'Agents are reviewing the approved intentions. No introduction decision has been assumed.'; }
const maxAttempts = 6;
function costLimit() { return Math.min(0.05, Number(process.env.AI_MAX_COST_USD || '0.05')); }
function remaining(value: QualificationData) {
    return Boolean(value.attempts && value.attempts.length < maxAttempts && value.attempts.reduce((sum, attempt) => sum + attempt.reservedCostUsd, 0) < costLimit());
}
function canRetry(value: QualificationData) {
    // Older raw provider read failures lacked a retry classification. A manual retry still
    // rechecks current state, live authority and the original durable request budget.
    return remaining(value) && (value.retryable === true || value.failureCode === 'PROVIDER_UNAVAILABLE');
}
async function recoverInterrupted(record: RecordValue) {
    if (record.row.state !== 'running' || (record.row.lease_until && Date.parse(record.row.lease_until) > Date.now()))
        return record;
    record.value.failureCode = 'QUALIFICATION_INTERRUPTED';
    record.value.retryable = Boolean(record.value.attempts && remaining(record.value));
    const changed = await db().prepare("UPDATE qualifications SET state='blocked',version=version+1,data=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND version=? AND state='running' AND (lease_until IS NULL OR lease_until<=?)")
        .run(encrypt(record.value, `qualification:${record.row.id}`), new Date().toISOString(), record.row.id, record.row.version, new Date().toISOString());
    return changed.changes === 1 ? await owned(record.row.left_user, record.row.id) : record;
}
function retryableFailure(error: unknown) {
    if (error instanceof AgentError)
        return error.code === 'timeout' || error.code === 'output'
            || (error.code === 'provider' && (!error.providerDetail || error.providerDetail.status === 429 || error.providerDetail.status >= 500 || error.providerDetail.code === 'json_validate_failed'));
    return error instanceof HttpError && error.status >= 500;
}
export async function listQualificationDtos(userId: string) {
    const rows = await db().prepare('SELECT id FROM qualifications WHERE left_user=? OR right_user=? ORDER BY updated_at DESC LIMIT 50').all(userId, userId) as {
        id: string;
    }[];
    return Promise.all(rows.map(async ({ id }) => {
        const record = await recoverInterrupted(await owned(userId, id)), { row, value } = record;
        const ownAgent = row.left_user === userId ? value.snapshot.leftAgent : value.snapshot.rightAgent;
        let state = row.state;
        let currentValid = true;
        if (state === 'running' && (!row.lease_until || Date.parse(row.lease_until) <= Date.now()))
            state = 'blocked';
        try {
            await current(record);
        }
        catch {
            state = 'blocked';
            currentValid = false;
        }
        const otherEns = (await agent(row.left_user === userId ? row.right_user : row.left_user))?.ensName || 'Unavailable agent';
        return { id, version: row.version, state, stopReason: value.result?.stopReason, otherEns, summary: summary(value), proposalId: value.proposalId || null,
            failureCode: value.failureCode === checkpointReady ? null : value.failureCode || (state === 'blocked' ? 'CURRENT_AUTHORITY_REQUIRED' : null),
            canRetry: currentValid && state === 'blocked' && canRetry(value), attemptsUsed: value.attempts?.length ?? value.messages.length, maxAttempts,
            publicIdentity: value.publicIdentities ? { own: { context: value.publicIdentities[row.left_user === userId ? 'left' : 'right'].context, association: value.publicIdentities[row.left_user === userId ? 'left' : 'right'].association },
                counterpart: { context: value.publicIdentities[row.left_user === userId ? 'right' : 'left'].context, association: value.publicIdentities[row.left_user === userId ? 'right' : 'left'].association }, observation: 'checked_before_protected_actions' } : null,
            messages: await Promise.all(value.messages.map(async (message) => ({ id: message.id, speaker: message.agentId === value.snapshot.leftAgent ? (await agent(row.left_user))?.ensName || 'First agent' : (await agent(row.right_user))?.ensName || 'Second agent', content: message.message, createdAt: message.createdAt, round: message.round, evidence: message.evidence }))),
            questions: value.questions.filter(question => question.ownerAgentId === ownAgent).map(question => ({ id: question.id, question: question.question, answered: value.answers.some(answer => answer.questionId === question.id) })) };
    }));
}
export async function startQualification(userId: string, ownIntentId: string, candidateKey: string, checkSession: () => void | Promise<void>, progress: (stage: RunningStage) => void | Promise<void>, worker: QualificationWorkerOptions = {}) {
    const own = requireValue(await intent(ownIntentId), 'Choose an active networking intent.');
    if (own.userId !== userId)
        throw new HttpError(404, 'NOT_FOUND', 'Networking intent was not found.');
    assertIntent(own.value);
    await authority(userId, 'negotiate', own.value.policyVersion);
    const candidate = await arkiv().readActive(candidateKey), other = requireValue(await intent(candidate.intent.intentId), 'This external agent has no connected Meeti inbox.', 409);
    const a = requireValue(await agent(userId), 'Set up your agent.'), b = requireValue(await agent(other.userId), 'Candidate agent is unavailable.');
    if (other.userId === userId || candidate.owner.toLowerCase() !== b.owner.toLowerCase() || candidate.intent.ensAgentRef !== b.ensName || candidate.intent.version !== other.value.version || other.value.arkivKey?.toLowerCase() !== candidateKey.toLowerCase() || own.value.goal !== other.value.goal)
        throw new HttpError(409, 'CANDIDATE_CHANGED', 'The candidate does not match its current owner inbox.');
    const snapshot: ProposalData = { leftIntent: own.value, rightIntent: other.value, leftPolicy: a.policy, rightPolicy: b.policy, leftAgent: a.id, rightAgent: b.id,
        leftProfileDigest: await privateSnapshotDigest(userId), rightProfileDigest: await privateSnapshotDigest(other.userId), summary: '', compatibility: null, exchanges: [], createdAt: new Date().toISOString() };
    const [leftIdentity, rightIdentity] = await withEnsReadScope(() => Promise.all([publicIdentityBinding(userId), publicIdentityBinding(other.userId)]));
    const publicIdentities = { left: leftIdentity, right: rightIdentity };
    const pairKey = hash(JSON.stringify([userId, other.userId].map((owner, index) => ({ owner, intent: index ? snapshot.rightIntent : snapshot.leftIntent, policy: index ? snapshot.rightPolicy : snapshot.leftPolicy, profile: index ? snapshot.rightProfileDigest : snapshot.leftProfileDigest,
        publicIdentity: index ? rightIdentity.digest : leftIdentity.digest })).sort((x, y) => x.owner.localeCompare(y.owner))));
    const id = await atomic(async () => {
        await checkSession();
        const prior = await db().prepare('SELECT id FROM qualifications WHERE pair_key=?').get(pairKey) as {
            id: string;
        } | undefined;
        if (prior)
            return prior.id;
        const id = randomUUID(), value: QualificationData = { snapshot, result: null, messages: [], questions: [], answers: [], attempts: [], publicIdentities };
        const provisional = { row: { left_user: userId, right_user: other.userId } as QualificationRow, value };
        await current(provisional);
        await db().prepare('INSERT INTO qualifications(id,left_user,right_user,pair_key,state,version,data,updated_at) VALUES(?,?,?,?,?,1,?,?)')
            .run(id, userId, other.userId, pairKey, 'queued', encrypt(value, `qualification:${id}`), new Date().toISOString());
        return id;
    });
    const record = await owned(userId, id);
    if (record.row.state !== 'queued')
        return { id: record.value.proposalId || null, qualificationId: id };
    return execute(userId, id, record.row.version, checkSession, progress, false, worker);
}
async function execute(userId: string, id: string, version: number, checkSession: () => void | Promise<void>, progress: (stage: RunningStage) => void | Promise<void> = () => { }, retry = false, worker: QualificationWorkerOptions = {}, continuationDigest?: string) {
    if (worker.singleTurn && !worker.onYield) throw new HttpError(409, 'QUALIFICATION_WORKER_REQUIRED', 'A durable worker continuation is required for bounded execution.');
    const token = randomUUID();
    await atomic(async () => {
        const record = await owned(userId, id);
        await current(record);
        await checkSession();
        if (record.row.version !== version || !(retry ? record.row.state === 'blocked' && canRetry(record.value) : ['queued', 'needs_owner'].includes(record.row.state)))
            throw new HttpError(409, 'QUALIFICATION_CHANGED', 'This conversation is not ready for this review.');
        if (continuationDigest) {
            if (record.row.state !== 'queued' || record.value.failureCode !== checkpointReady) throw new HttpError(409, 'QUALIFICATION_CHECKPOINT_INVALID', 'This conversation has no accepted worker continuation.');
            assertAcceptedCheckpoint(record, continuationDigest);
        } else if (record.value.failureCode === checkpointReady) throw new HttpError(409, 'QUALIFICATION_WORKER_REQUIRED', 'Continue this accepted checkpoint through its existing agent task.');
        if (!record.value.attempts && record.row.state === 'needs_owner') {
            const completed = record.value.result;
            if (!completed || completed.state !== 'needs_owner' || completed.messages.length !== completed.round * 2
                || completed.messages.length !== record.value.messages.length || completed.messages.length > maxAttempts
                || completed.messages.some((message, index) => message.id !== record.value.messages[index].id
                    || !Number.isFinite(message.inference.estimatedCostUsd) || message.inference.estimatedCostUsd < 0))
                throw new HttpError(409, 'QUALIFICATION_HISTORY', 'The historical request budget cannot be reconstructed safely.');
            // Before explicit retry existed, a completed owner-input state could contain only successful turns.
            record.value.attempts = completed.messages.map(message => ({ requestId: message.inference.requestId, model: message.inference.model, reservedCostUsd: message.inference.estimatedCostUsd }));
        }
        const changed = await db().prepare("UPDATE qualifications SET state='running',version=version+1,lease_token=?,lease_until=?,data=? WHERE id=? AND version=?").run(token, new Date(Date.now() + 15 * 60000).toISOString(), encrypt(record.value, `qualification:${id}`), id, version);
        if (changed.changes !== 1)
            throw new HttpError(409, 'QUALIFICATION_BUSY', 'Another review already started.');
    });
    try {
        requireWorkerTime(worker);
        let record = await owned(userId, id);
        await progress('evaluating_fit');
        const identities = await live(record);
        if (!record.value.publicIdentities) {
            record.value.publicIdentities = identities;
            await persist(record, 'running', token);
            record = await owned(userId, id);
        }
        const { snapshot } = record.value;
        const semanticAssessment = await assessPair(record.row.left_user, snapshot.leftIntent, record.row.right_user, snapshot.rightIntent);
        await current(record);
        await progress('exchanging_context');
        const left = await participant(record.row.left_user, snapshot.leftIntent), right = await participant(record.row.right_user, snapshot.rightIntent);
        left.fields.push(...await qualificationFields(id, record.row.left_user));
        right.fields.push(...await qualificationFields(id, record.row.right_user));
        let completedTurn: { pendingDisclosures: number } | undefined;
        const saved = (retry || continuationDigest) ? record.value.checkpoint ?? record.value.result : record.value.result;
        const result = await ai().qualifyIntroduction({ left, right, purpose: snapshot.leftIntent.goal, maxRounds: 3,
            ...((retry || continuationDigest) && record.value.checkpoint ? { checkpoint: record.value.checkpoint } : record.value.result ? { priorState: record.value.result } : {}),
            ownerAnswers: record.value.answers.filter(answer => !saved?.answers.some(prior => prior.questionId === answer.questionId)).map(({ questionId, ownerAgentId, fieldId, answeredAt, providerDisclosureConsent }) => ({ questionId, ownerAgentId, fieldId, answeredAt, providerDisclosureConsent })),
            beforeInference: async (reservation, checkpoint) => {
                if (worker.singleTurn && completedTurn) throw new HttpError(409, 'QUALIFICATION_WORKER_BOUND', 'This worker already accepted its bounded model turn.');
                requireWorkerTime(worker);
                await currentPublicIdentities(await owned(userId, id));
                requireWorkerTime(worker);
                await atomic(async () => {
                    await checkSession();
                    await progress('exchanging_context');
                    const active = await owned(userId, id);
                    await current(active);
                    if (active.row.state !== 'running' || active.row.lease_token !== token)
                        throw new HttpError(409, 'QUALIFICATION_STOPPED', 'This review was stopped.');
                    const attempts = active.value.attempts;
                    requireWorkerTime(worker);
                    if (!attempts || attempts.length >= maxAttempts || attempts.some(attempt => attempt.requestId === reservation.requestId)
                        || !Number.isFinite(reservation.reservedCostUsd) || reservation.reservedCostUsd < 0
                        || attempts.reduce((sum, attempt) => sum + attempt.reservedCostUsd, 0) + reservation.reservedCostUsd > costLimit())
                        throw new HttpError(409, 'QUALIFICATION_BUDGET', 'This conversation reached its request or cost limit. No new model request was sent.');
                    attempts.push(reservation);
                    active.value.checkpoint = checkpoint;
                    active.value.failureCode = undefined;
                    active.value.retryable = false;
                    await persist(active, 'running', token);
                });
            },
            onProgress: async (event) => {
                if (event.kind === 'turn_completed' || event.kind === 'state_completed')
                    await currentPublicIdentities(await owned(userId, id));
                await atomic(async () => {
                    await checkSession();
                    await progress('exchanging_context');
                    const active = await owned(userId, id);
                    await current(active);
                    if (active.row.state !== 'running' || active.row.lease_token !== token)
                        throw new HttpError(409, 'QUALIFICATION_STOPPED', 'This review was stopped.');
                    if (event.kind === 'turn_completed') {
                        active.value.messages.push(event.message);
                        for (const question of event.ownerQuestions)
                            if (!active.value.questions.some(previous => previous.id === question.id))
                                active.value.questions.push(question);
                    }
                    if (event.kind !== 'state_completed' && event.checkpoint)
                        active.value.checkpoint = event.checkpoint;
                    await persist(active, 'running', token);
                });
                if (worker.singleTurn) {
                    if (event.kind === 'turn_completed') completedTurn = { pendingDisclosures: event.message.requestedFieldIds.length };
                    else if (event.kind === 'disclosure_checked' && completedTurn) completedTurn.pendingDisclosures--;
                    if (completedTurn && completedTurn.pendingDisclosures === 0) throw new AcceptedTurnComplete();
                }
            } });
        await progress('rechecking_permissions');
        await live(await owned(userId, id));
        await checkSession();
        return await atomic(async () => {
            await checkSession();
            await progress('rechecking_permissions');
            record = await owned(userId, id);
            await current(record);
            if (record.row.state !== 'running' || record.row.lease_token !== token)
                throw new HttpError(409, 'QUALIFICATION_STOPPED', 'This review was stopped.');
            record.value.result = result;
            record.value.messages = result.messages;
            record.value.questions = result.ownerQuestions;
            record.value.checkpoint = undefined;
            record.value.failureCode = undefined;
            record.value.retryable = false;
            if (result.state === 'qualified') {
                const proposalId = randomUUID();
                snapshot.summary = summary(record.value);
                snapshot.compatibility = { semanticAssessment, qualification: result };
                snapshot.exchanges = await Promise.all(result.messages.map(async (message) => ({ speaker: message.agentId === left.agentId ? (await agent(record.row.left_user))!.ensName : (await agent(record.row.right_user))!.ensName, content: message.message, allowed: true })));
                record.value.snapshot = snapshot;
                const digest = hash(JSON.stringify({ pairKey: record.row.pair_key, snapshot }));
                await db().prepare('INSERT INTO proposals VALUES(?,?,?,?,?,?,?)').run(proposalId, record.row.left_user, record.row.right_user, record.row.pair_key, 'proposed', digest, encrypt(snapshot, `proposal:${proposalId}`));
                record.value.proposalId = proposalId;
                for (const owner of [record.row.left_user, record.row.right_user])
                    await audit(owner, 'proposal', 'qualified', `Introduction request ${proposalId}. Both human decisions are still required.`);
            }
            await persist(record, result.state === 'qualified' ? 'proposed' : result.state, token);
            await db().prepare('UPDATE qualifications SET lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?').run(id, token);
            return { id: record.value.proposalId || null, qualificationId: id };
        });
    }
    catch (error) {
        if (error instanceof AcceptedTurnComplete && worker.singleTurn && worker.onYield) {
            try {
              const continuation = await atomic(async () => {
                await checkSession();
                const active = await owned(userId, id);
                await current(active);
                if (active.row.state !== 'running' || active.row.lease_token !== token) throw new HttpError(409, 'QUALIFICATION_STOPPED', 'This review was stopped.');
                const checkpoint = assertAcceptedCheckpoint(active);
                active.value.failureCode = checkpointReady; active.value.retryable = false;
                await persist(active, 'queued', token);
                await db().prepare('UPDATE qualifications SET lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?').run(id, token);
                const continuation = { qualificationId: id, version: active.row.version + 1, checkpointDigest: hash(JSON.stringify(checkpoint)) };
                await worker.onYield!(continuation);
                return continuation;
              });
              throw new QualificationYield(continuation);
            } catch (yieldError) {
              if (yieldError instanceof QualificationYield) throw yieldError;
              error = yieldError;
            }
        }
        const record = await owned(userId, id);
        if (record.row.state === 'running' && record.row.lease_token === token) {
            const outputDiagnostic = qualificationOutputDiagnostic(error);
            record.value.failureCode = error instanceof HttpError ? error.code : error instanceof AgentError ? `AGENT_${error.code}${outputDiagnostic ? `_${outputDiagnostic}` : ''}` : 'PROVIDER_UNAVAILABLE';
            record.value.retryable = retryableFailure(error) && Boolean(record.value.attempts && remaining(record.value));
            await persist(record, 'blocked');
            await db().prepare('UPDATE qualifications SET lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?').run(id, token);
        }
        throw error;
    }
}
export async function continueQualificationCheckpoint(userId: string, continuation: QualificationContinuation, checkSession: () => void | Promise<void>, progress: (stage: RunningStage) => void | Promise<void>, worker: QualificationWorkerOptions) {
    const input = z.object({ qualificationId: z.string().uuid(), version: z.number().int().positive(), checkpointDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(continuation);
    return execute(userId, input.qualificationId, input.version, checkSession, progress, false, worker, input.checkpointDigest);
}
export async function answerQualification(userId: string, id: string, body: unknown, checkSession: () => void | Promise<void>) {
    const input = answerInput.parse(body), record = await owned(userId, id);
    await live(record);
    await checkSession();
    return await atomic(async () => {
        await checkSession();
        const fresh = await owned(userId, id);
        await current(fresh);
        if (fresh.row.version !== input.version || fresh.row.state !== 'needs_owner')
            throw new HttpError(409, 'QUALIFICATION_CHANGED', 'Refresh this conversation before answering.');
        const a = requireValue(await agent(userId), 'Agent unavailable.'), question = fresh.value.questions.find(question => question.id === input.questionId);
        if (!question || question.ownerAgentId !== a.id)
            throw new HttpError(404, 'NOT_FOUND', 'Owner question was not found.');
        if (!a.policy.allowedFields.includes(input.fieldClass))
            throw new HttpError(403, 'ANSWER_FIELD_DENIED', 'Your current ENS policy does not allow this field class.');
        if (fresh.value.answers.some(answer => answer.questionId === question.id))
            throw new HttpError(409, 'QUESTION_ANSWERED', 'This question already has an immutable answer.');
        const content = { questionId: question.id, userId, text: input.text, fieldClass: input.fieldClass };
        const answer: QualificationAnswer = { ...content, ownerAgentId: a.id, fieldId: answerFieldId(id, content), answeredAt: new Date().toISOString(), providerDisclosureConsent: true, shareWithCounterpart: true };
        fresh.value.answers.push(answer);
        await persist(fresh, 'needs_owner');
        return { id: null, qualificationId: id, version: fresh.row.version + 1 };
    });
}
export async function resumeQualification(userId: string, id: string, body: unknown, checkSession: () => void | Promise<void>, progress?: (stage: RunningStage) => void | Promise<void>, worker: QualificationWorkerOptions = {}) {
    const { version } = versionInput.parse(body), record = await owned(userId, id);
    if (!record.value.answers.some(answer => !record.value.result?.answers.some(prior => prior.questionId === answer.questionId)))
        throw new HttpError(409, 'OWNER_ANSWER_REQUIRED', 'A new owner answer is required before resuming.');
    return execute(userId, id, version, checkSession, progress, false, worker);
}
export async function retryQualification(userId: string, id: string, body: unknown, checkSession: () => void | Promise<void>, progress?: (stage: RunningStage) => void | Promise<void>, worker: QualificationWorkerOptions = {}) {
    const { version } = versionInput.parse(body);
    const record = await recoverInterrupted(await owned(userId, id));
    if (record.row.version !== version)
        throw new HttpError(409, 'QUALIFICATION_CHANGED', 'Refresh this conversation before retrying.');
    return execute(userId, id, version, checkSession, progress, true, worker);
}
export async function cancelQualification(userId: string, id: string, body: unknown, checkSession: () => void | Promise<void>) {
    const { version } = versionInput.parse(body);
    return await atomic(async () => {
        const record = await owned(userId, id);
        await checkSession();
        if (record.row.version !== version || record.value.proposalId)
            throw new HttpError(409, 'QUALIFICATION_CHANGED', 'Refresh this conversation or revoke the resulting introduction proposal.');
        await persist(record, 'cancelled');
        await db().prepare('UPDATE qualifications SET lease_token=NULL,lease_until=NULL WHERE id=?').run(id);
        return { cancelled: true as const };
    });
}

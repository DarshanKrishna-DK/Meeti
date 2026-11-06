import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { agent, atomic, audit, db, intent, type ProposalData } from './db';
import { encrypt, hash } from './crypto';
import { ai, arkiv, assertIntent, authority, participant, policyDigest } from './policy';
import { assessPair, freshPublicIntent } from './discovery';
import { privateSnapshotDigest } from './context-policy';
import { HttpError, requireValue } from './security';
import { answerFieldId, qualificationFields, qualificationRecord, type QualificationAnswer, type QualificationData, type QualificationRow } from './qualification-context';
import type { RunningStage } from './agent-runs';
import { AgentError } from '../agents/src';

type RecordValue = NonNullable<ReturnType<typeof qualificationRecord>>;
const versionInput = z.object({ version: z.number().int().positive() }).strict();
const answerInput = versionInput.extend({ questionId: z.string().uuid(), text: z.string().trim().min(1).max(1200), fieldClass: z.enum(['bio', 'seeking', 'offering']), providerDisclosureConsent: z.literal(true), shareWithCounterpart: z.literal(true) }).strict();
function owned(userId: string, id: string): RecordValue {
  const record = requireValue(qualificationRecord(id), 'Conversation was not found.', 404);
  if (![record.row.left_user, record.row.right_user].includes(userId)) throw new HttpError(404, 'NOT_FOUND', 'Conversation was not found.');
  return record;
}
function current(record: RecordValue) {
  const { row, value: { snapshot } } = record;
  if (db().prepare('SELECT 1 FROM blocks WHERE (user_id=? AND blocked_id=?) OR (user_id=? AND blocked_id=?)').get(row.left_user, row.right_user, row.right_user, row.left_user)) throw new HttpError(403, 'BLOCKED', 'This conversation is blocked.');
  for (const side of ['left', 'right'] as const) {
    const userId = side === 'left' ? row.left_user : row.right_user, expected = snapshot[`${side}Intent`], a = agent(userId), local = intent(expected.id);
    if (!a || !local || local.userId !== userId || local.value.version !== expected.version || local.value.arkivKey !== expected.arkivKey || a.id !== snapshot[`${side}Agent`]
      || policyDigest(a.policy) !== policyDigest(snapshot[`${side}Policy`]) || privateSnapshotDigest(userId) !== snapshot[`${side}ProfileDigest`]) throw new HttpError(409, 'QUALIFICATION_CHANGED', 'An owner context, intent or policy changed. Start a fresh review.');
    assertIntent(local.value);
    if (a.policy.paused || Date.parse(a.policy.expiresAt) <= Date.now()) throw new HttpError(403, 'POLICY_INACTIVE', 'The current policy is inactive.');
  }
}
async function live(record: RecordValue) {
  current(record);
  await Promise.all([freshPublicIntent(record.row.left_user, record.value.snapshot.leftIntent, 'negotiate'), freshPublicIntent(record.row.right_user, record.value.snapshot.rightIntent, 'negotiate')]);
  current(record);
}
function persist(record: RecordValue, state: string, token?: string) {
  const result = db().prepare('UPDATE qualifications SET state=?,version=version+1,data=?,updated_at=? WHERE id=? AND version=?' + (token ? " AND lease_token=? AND lease_until>?" : ''))
    .run(state, encrypt(record.value, `qualification:${record.row.id}`), new Date().toISOString(), record.row.id, record.row.version, ...(token ? [token, new Date().toISOString()] : []));
  if (result.changes !== 1) throw new HttpError(409, 'QUALIFICATION_CHANGED', 'This conversation changed or its execution lease expired. Refresh before continuing.');
}
function summary(value: QualificationData) { return value.result?.messages.slice(-2).map(message => message.message).join('\n\n') || 'Agents are reviewing the approved intentions. No introduction decision has been assumed.'; }
const maxAttempts = 6;
function costLimit() { return Math.min(0.05, Number(process.env.AI_MAX_COST_USD || '0.05')); }
function remaining(value: QualificationData) {
  return Boolean(value.attempts && value.attempts.length < maxAttempts && value.attempts.reduce((sum, attempt) => sum + attempt.reservedCostUsd, 0) < costLimit());
}
function recoverInterrupted(record: RecordValue) {
  if (record.row.state !== 'running' || (record.row.lease_until && Date.parse(record.row.lease_until) > Date.now())) return record;
  record.value.failureCode = 'QUALIFICATION_INTERRUPTED';
  record.value.retryable = Boolean(record.value.attempts && remaining(record.value));
  const changed = db().prepare("UPDATE qualifications SET state='blocked',version=version+1,data=?,lease_token=NULL,lease_until=NULL,updated_at=? WHERE id=? AND version=? AND state='running' AND (lease_until IS NULL OR lease_until<=?)")
    .run(encrypt(record.value, `qualification:${record.row.id}`), new Date().toISOString(), record.row.id, record.row.version, new Date().toISOString());
  return changed.changes === 1 ? owned(record.row.left_user, record.row.id) : record;
}
function retryableFailure(error: unknown) {
  if (error instanceof AgentError) return error.code === 'timeout' || error.code === 'output'
    || (error.code === 'provider' && (!error.providerDetail || error.providerDetail.status === 429 || error.providerDetail.status >= 500 || error.providerDetail.code === 'json_validate_failed'));
  return error instanceof HttpError && error.status >= 500;
}
export function listQualificationDtos(userId: string) {
  const rows = db().prepare('SELECT id FROM qualifications WHERE left_user=? OR right_user=? ORDER BY updated_at DESC LIMIT 50').all(userId, userId) as { id: string }[];
  return rows.map(({ id }) => {
    const record = recoverInterrupted(owned(userId, id)), { row, value } = record;
    const ownAgent = row.left_user === userId ? value.snapshot.leftAgent : value.snapshot.rightAgent;
    let state = row.state;
    let currentValid = true;
    if (state === 'running' && (!row.lease_until || Date.parse(row.lease_until) <= Date.now())) state = 'blocked';
    try { current(record); } catch { state = 'blocked'; currentValid = false; }
    const otherEns = agent(row.left_user === userId ? row.right_user : row.left_user)?.ensName || 'Unavailable agent';
    return { id, version: row.version, state, stopReason: value.result?.stopReason, otherEns, summary: summary(value), proposalId: value.proposalId || null,
      failureCode: value.failureCode || (state === 'blocked' ? 'CURRENT_AUTHORITY_REQUIRED' : null),
      canRetry: currentValid && state === 'blocked' && value.retryable === true && remaining(value), attemptsUsed: value.attempts?.length ?? value.messages.length, maxAttempts,
      messages: value.messages.map(message => ({ id: message.id, speaker: message.agentId === value.snapshot.leftAgent ? agent(row.left_user)?.ensName || 'First agent' : agent(row.right_user)?.ensName || 'Second agent', content: message.message, createdAt: message.createdAt, round: message.round, evidence: message.evidence })),
      questions: value.questions.filter(question => question.ownerAgentId === ownAgent).map(question => ({ id: question.id, question: question.question, answered: value.answers.some(answer => answer.questionId === question.id) })) };
  });
}
export async function startQualification(userId: string, ownIntentId: string, candidateKey: string, checkSession: () => void, progress: (stage: RunningStage) => void) {
  const own = requireValue(intent(ownIntentId), 'Choose an active networking intent.');
  if (own.userId !== userId) throw new HttpError(404, 'NOT_FOUND', 'Networking intent was not found.');
  assertIntent(own.value);
  await authority(userId, 'negotiate', own.value.policyVersion);
  const candidate = await arkiv().readActive(candidateKey), other = requireValue(intent(candidate.intent.intentId), 'This external agent has no connected Meeti inbox.', 409);
  const a = requireValue(agent(userId), 'Set up your agent.'), b = requireValue(agent(other.userId), 'Candidate agent is unavailable.');
  if (other.userId === userId || candidate.owner.toLowerCase() !== b.owner.toLowerCase() || candidate.intent.ensAgentRef !== b.ensName || candidate.intent.version !== other.value.version || other.value.arkivKey?.toLowerCase() !== candidateKey.toLowerCase() || own.value.goal !== other.value.goal) throw new HttpError(409, 'CANDIDATE_CHANGED', 'The candidate does not match its current owner inbox.');
  const snapshot: ProposalData = { leftIntent: own.value, rightIntent: other.value, leftPolicy: a.policy, rightPolicy: b.policy, leftAgent: a.id, rightAgent: b.id,
    leftProfileDigest: privateSnapshotDigest(userId), rightProfileDigest: privateSnapshotDigest(other.userId), summary: '', compatibility: null, exchanges: [], createdAt: new Date().toISOString() };
  const pairKey = hash(JSON.stringify([userId, other.userId].map((owner, index) => ({ owner, intent: index ? snapshot.rightIntent : snapshot.leftIntent, policy: index ? snapshot.rightPolicy : snapshot.leftPolicy, profile: index ? snapshot.rightProfileDigest : snapshot.leftProfileDigest })).sort((x, y) => x.owner.localeCompare(y.owner))));
  const id = atomic(() => {
    checkSession();
    const prior = db().prepare('SELECT id FROM qualifications WHERE pair_key=?').get(pairKey) as { id: string } | undefined;
    if (prior) return prior.id;
    const id = randomUUID(), value: QualificationData = { snapshot, result: null, messages: [], questions: [], answers: [], attempts: [] };
    const provisional = { row: { left_user: userId, right_user: other.userId } as QualificationRow, value };
    current(provisional);
    db().prepare('INSERT INTO qualifications(id,left_user,right_user,pair_key,state,version,data,updated_at) VALUES(?,?,?,?,?,1,?,?)')
      .run(id, userId, other.userId, pairKey, 'queued', encrypt(value, `qualification:${id}`), new Date().toISOString());
    return id;
  });
  const record = owned(userId, id);
  if (record.row.state !== 'queued') return { id: record.value.proposalId || null, qualificationId: id };
  return execute(userId, id, record.row.version, checkSession, progress);
}
async function execute(userId: string, id: string, version: number, checkSession: () => void, progress: (stage: RunningStage) => void = () => {}, retry = false) {
  const token = randomUUID();
  atomic(() => {
    const record = owned(userId, id); current(record); checkSession();
    if (record.row.version !== version || !(retry ? record.row.state === 'blocked' && record.value.retryable === true && remaining(record.value) : ['queued', 'needs_owner'].includes(record.row.state))) throw new HttpError(409, 'QUALIFICATION_CHANGED', 'This conversation is not ready for this review.');
    if (!record.value.attempts && record.row.state === 'needs_owner') {
      const completed = record.value.result;
      if (!completed || completed.state !== 'needs_owner' || completed.messages.length !== completed.round * 2
        || completed.messages.length !== record.value.messages.length || completed.messages.length > maxAttempts
        || completed.messages.some((message, index) => message.id !== record.value.messages[index].id
          || !Number.isFinite(message.inference.estimatedCostUsd) || message.inference.estimatedCostUsd < 0)) throw new HttpError(409, 'QUALIFICATION_HISTORY', 'The historical request budget cannot be reconstructed safely.');
      // Before explicit retry existed, a completed owner-input state could contain only successful turns.
      record.value.attempts = completed.messages.map(message => ({ requestId: message.inference.requestId, model: message.inference.model, reservedCostUsd: message.inference.estimatedCostUsd }));
    }
    const changed = db().prepare("UPDATE qualifications SET state='running',version=version+1,lease_token=?,lease_until=?,data=? WHERE id=? AND version=?").run(token, new Date(Date.now() + 15 * 60000).toISOString(), encrypt(record.value, `qualification:${id}`), id, version);
    if (changed.changes !== 1) throw new HttpError(409, 'QUALIFICATION_BUSY', 'Another review already started.');
  });
  try {
    let record = owned(userId, id); progress('evaluating_fit'); await live(record);
    const { snapshot } = record.value;
    const semanticAssessment = await assessPair(record.row.left_user, snapshot.leftIntent, record.row.right_user, snapshot.rightIntent);
    current(record); progress('exchanging_context');
    const left = participant(record.row.left_user, snapshot.leftIntent), right = participant(record.row.right_user, snapshot.rightIntent);
    left.fields.push(...qualificationFields(id, record.row.left_user)); right.fields.push(...qualificationFields(id, record.row.right_user));
    const result = await ai().qualifyIntroduction({ left, right, purpose: snapshot.leftIntent.goal, maxRounds: 3,
      ...(retry && record.value.checkpoint ? { checkpoint: record.value.checkpoint } : record.value.result ? { priorState: record.value.result } : {}),
      ownerAnswers: record.value.answers.filter(answer => !(retry ? record.value.checkpoint ?? record.value.result : record.value.result)?.answers.some(prior => prior.questionId === answer.questionId)).map(({ questionId, ownerAgentId, fieldId, answeredAt, providerDisclosureConsent }) => ({ questionId, ownerAgentId, fieldId, answeredAt, providerDisclosureConsent })),
      beforeInference: (reservation, checkpoint) => atomic(() => {
        checkSession(); progress('exchanging_context'); const active = owned(userId, id); current(active);
        if (active.row.state !== 'running' || active.row.lease_token !== token) throw new HttpError(409, 'QUALIFICATION_STOPPED', 'This review was stopped.');
        const attempts = active.value.attempts;
        if (!attempts || attempts.length >= maxAttempts || attempts.some(attempt => attempt.requestId === reservation.requestId)
          || !Number.isFinite(reservation.reservedCostUsd) || reservation.reservedCostUsd < 0
          || attempts.reduce((sum, attempt) => sum + attempt.reservedCostUsd, 0) + reservation.reservedCostUsd > costLimit()) throw new HttpError(409, 'QUALIFICATION_BUDGET', 'This conversation reached its request or cost limit. No new model request was sent.');
        attempts.push(reservation); active.value.checkpoint = checkpoint;
        active.value.failureCode = undefined; active.value.retryable = false; persist(active, 'running', token);
      }),
      onProgress: event => atomic(() => {
        checkSession(); progress('exchanging_context'); const active = owned(userId, id); current(active);
        if (active.row.state !== 'running' || active.row.lease_token !== token) throw new HttpError(409, 'QUALIFICATION_STOPPED', 'This review was stopped.');
        if (event.kind === 'turn_completed') { active.value.messages.push(event.message); for (const question of event.ownerQuestions) if (!active.value.questions.some(previous => previous.id === question.id)) active.value.questions.push(question); }
        if (event.kind !== 'state_completed' && event.checkpoint) active.value.checkpoint = event.checkpoint;
        persist(active, 'running', token);
      }) });
    progress('rechecking_permissions'); await live(owned(userId, id)); checkSession();
    return atomic(() => {
      progress('rechecking_permissions'); record = owned(userId, id); current(record);
      if (record.row.state !== 'running' || record.row.lease_token !== token) throw new HttpError(409, 'QUALIFICATION_STOPPED', 'This review was stopped.');
      record.value.result = result; record.value.messages = result.messages; record.value.questions = result.ownerQuestions;
      record.value.checkpoint = undefined; record.value.failureCode = undefined; record.value.retryable = false;
      if (result.state === 'qualified') {
        const proposalId = randomUUID(); snapshot.summary = summary(record.value); snapshot.compatibility = { semanticAssessment, qualification: result };
        snapshot.exchanges = result.messages.map(message => ({ speaker: message.agentId === left.agentId ? agent(record.row.left_user)!.ensName : agent(record.row.right_user)!.ensName, content: message.message, allowed: true }));
        record.value.snapshot = snapshot;
        const digest = hash(JSON.stringify({ pairKey: record.row.pair_key, snapshot }));
        db().prepare('INSERT INTO proposals VALUES(?,?,?,?,?,?,?)').run(proposalId, record.row.left_user, record.row.right_user, record.row.pair_key, 'proposed', digest, encrypt(snapshot, `proposal:${proposalId}`));
        record.value.proposalId = proposalId;
        for (const owner of [record.row.left_user, record.row.right_user]) audit(owner, 'proposal', 'qualified', `Introduction request ${proposalId}. Both human decisions are still required.`);
      }
      persist(record, result.state === 'qualified' ? 'proposed' : result.state, token);
      db().prepare('UPDATE qualifications SET lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?').run(id, token);
      return { id: record.value.proposalId || null, qualificationId: id };
    });
  } catch (error) {
    const record = owned(userId, id);
    if (record.row.state === 'running' && record.row.lease_token === token) {
      record.value.failureCode = error instanceof HttpError ? error.code : error instanceof AgentError ? `AGENT_${error.code}` : 'PROVIDER_UNAVAILABLE';
      record.value.retryable = retryableFailure(error) && Boolean(record.value.attempts && remaining(record.value));
      persist(record, 'blocked'); db().prepare('UPDATE qualifications SET lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?').run(id, token);
    }
    throw error;
  }
}
export async function answerQualification(userId: string, id: string, body: unknown, checkSession: () => void) {
  const input = answerInput.parse(body), record = owned(userId, id); await live(record); checkSession();
  return atomic(() => {
    const fresh = owned(userId, id); current(fresh);
    if (fresh.row.version !== input.version || fresh.row.state !== 'needs_owner') throw new HttpError(409, 'QUALIFICATION_CHANGED', 'Refresh this conversation before answering.');
    const a = requireValue(agent(userId), 'Agent unavailable.'), question = fresh.value.questions.find(question => question.id === input.questionId);
    if (!question || question.ownerAgentId !== a.id) throw new HttpError(404, 'NOT_FOUND', 'Owner question was not found.');
    if (!a.policy.allowedFields.includes(input.fieldClass)) throw new HttpError(403, 'ANSWER_FIELD_DENIED', 'Your current ENS policy does not allow this field class.');
    if (fresh.value.answers.some(answer => answer.questionId === question.id)) throw new HttpError(409, 'QUESTION_ANSWERED', 'This question already has an immutable answer.');
    const content = { questionId: question.id, userId, text: input.text, fieldClass: input.fieldClass };
    const answer: QualificationAnswer = { ...content, ownerAgentId: a.id, fieldId: answerFieldId(id, content), answeredAt: new Date().toISOString(), providerDisclosureConsent: true, shareWithCounterpart: true };
    fresh.value.answers.push(answer); persist(fresh, 'needs_owner');
    return { id: null, qualificationId: id, version: fresh.row.version + 1 };
  });
}
export async function resumeQualification(userId: string, id: string, body: unknown, checkSession: () => void, progress?: (stage: RunningStage) => void) {
  const { version } = versionInput.parse(body), record = owned(userId, id);
  if (!record.value.answers.some(answer => !record.value.result?.answers.some(prior => prior.questionId === answer.questionId))) throw new HttpError(409, 'OWNER_ANSWER_REQUIRED', 'A new owner answer is required before resuming.');
  return execute(userId, id, version, checkSession, progress);
}
export async function retryQualification(userId: string, id: string, body: unknown, checkSession: () => void, progress?: (stage: RunningStage) => void) {
  const { version } = versionInput.parse(body);
  const record = recoverInterrupted(owned(userId, id));
  if (record.row.version !== version) throw new HttpError(409, 'QUALIFICATION_CHANGED', 'Refresh this conversation before retrying.');
  return execute(userId, id, version, checkSession, progress, true);
}
export function cancelQualification(userId: string, id: string, body: unknown, checkSession: () => void) {
  const { version } = versionInput.parse(body);
  return atomic(() => {
    const record = owned(userId, id); checkSession();
    if (record.row.version !== version || record.value.proposalId) throw new HttpError(409, 'QUALIFICATION_CHANGED', 'Refresh this conversation or revoke the resulting introduction proposal.');
    persist(record, 'cancelled'); db().prepare('UPDATE qualifications SET lease_token=NULL,lease_until=NULL WHERE id=?').run(id);
    return { cancelled: true as const };
  });
}

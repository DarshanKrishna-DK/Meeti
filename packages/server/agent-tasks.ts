import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { atomic, audit, db } from './store';
import { decrypt, encrypt, sign } from './crypto';
import { HttpError } from './security';
import { withAgentRun, type RunningStage } from './agent-runs';
import { createProposal } from './proposals';
import { resumeQualification, retryQualification } from './qualifications';

const queuedLifetimeMs = 15 * 60000;
const runningLifetimeMs = 20 * 60000;
const maximumActiveTasks = 32;
const taskKind = z.enum(['propose', 'resume', 'retry']);
const proposeInput = z.object({ intentId: z.string().uuid().transform(value => value.toLowerCase()), candidateKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform(value => value.toLowerCase()) }).strict();
const continuationInput = z.object({ qualificationId: z.string().uuid().transform(value => value.toLowerCase()), version: z.number().int().positive() }).strict();
const taskResult = z.object({ id: z.string().uuid().nullable(), qualificationId: z.string().uuid() }).strict();
const taskError = z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), message: z.string().max(300) }).strict();
const payloadSchema = z.object({ version: z.literal(1), kind: taskKind, input: z.unknown(), sessionHash: z.string().regex(/^[a-f0-9]{64}$/), wallet: z.string().regex(/^0x[a-f0-9]{40}$/), result: taskResult.optional(), error: taskError.optional() }).strict();
export type AgentTaskKind = z.infer<typeof taskKind>;
export type AgentTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'interrupted' | 'expired';
type Payload = Omit<z.infer<typeof payloadSchema>, 'input'> & { input: z.infer<typeof proposeInput> | z.infer<typeof continuationInput> };
type TaskRow = { id: string; user_id: string; kind: AgentTaskKind; status: AgentTaskStatus; input_digest: string; data: string; lease_token: string | null; created_at: string; updated_at: string; expires_at: string };
export type AgentTaskDto = { taskId: string; kind: AgentTaskKind; status: AgentTaskStatus; createdAt: string; updatedAt: string; expiresAt: string; result?: z.infer<typeof taskResult>; error?: z.infer<typeof taskError> };
let draining = false;

function parseInput(kind: AgentTaskKind, input: unknown) { return kind === 'propose' ? proposeInput.parse(input) : continuationInput.parse(input); }
function inputDigest(userId: string, kind: AgentTaskKind, input: Payload['input']) { return sign(JSON.stringify({ userId, kind, input })); }
function decode(row: TaskRow): Payload {
  const value = payloadSchema.parse(decrypt(row.data, `agent-task:${row.user_id}:${row.id}`));
  const input = parseInput(value.kind, value.input);
  if (value.kind !== row.kind || inputDigest(row.user_id, value.kind, input) !== row.input_digest) throw new HttpError(409, 'AGENT_TASK_CHANGED', 'The queued task no longer matches its reviewed input.');
  return { ...value, input };
}
function fixedError(code: string): z.infer<typeof taskError> {
  if (code === 'AGENT_TASK_INTERRUPTED') return { code, message: 'The previous task stopped before its outcome could be confirmed. Review current agent activity before explicitly requesting another attempt.' };
  if (code === 'AGENT_TASK_EXPIRED') return { code, message: 'This task expired before it started. Review the current intent and explicitly request another attempt.' };
  if (code === 'AGENT_TASK_SESSION_CLOSED') return { code, message: 'The session that requested this task is no longer active. Sign in and review current activity.' };
  if (code === 'AGENT_TASK_WALLET_CHANGED') return { code, message: 'The requesting account wallet changed. Review the current owner identity before starting another task.' };
  if (code === 'AGENT_TASK_DATA_INVALID') return { code, message: 'The stored task could not be verified. No successful outcome was assumed.' };
  return { code: 'AGENT_TASK_FAILED', message: 'Qualification did not finish. Review current agent activity and its failure details before explicitly requesting another attempt.' };
}
async function checkSession(userId: string, sessionHash: string, expectedWallet?: string) {
  const row = await db().prepare('SELECT users.id,users.wallet FROM users JOIN sessions ON sessions.user_id=users.id WHERE users.id=? AND sessions.token_hash=? AND sessions.expires_at>?')
    .get(userId, sessionHash, new Date().toISOString()) as { id: string; wallet: string | null } | undefined;
  if (!row) throw new HttpError(401, 'AGENT_TASK_SESSION_CLOSED', fixedError('AGENT_TASK_SESSION_CLOSED').message);
  const wallet = row.wallet?.toLowerCase();
  if (!wallet || !/^0x[a-f0-9]{40}$/.test(wallet) || expectedWallet && expectedWallet !== wallet) throw new HttpError(409, 'AGENT_TASK_WALLET_CHANGED', fixedError('AGENT_TASK_WALLET_CHANGED').message);
  return wallet;
}
async function expireTasks(userId?: string) {
  const now = new Date().toISOString();
  const rows = await db().prepare("SELECT * FROM agent_tasks WHERE status IN ('queued','running') AND expires_at<=?" + (userId ? ' AND user_id=?' : ''))
    .all(now, ...(userId ? [userId] : [])) as TaskRow[];
  let interrupted = 0, expired = 0;
  for (const row of rows) {
    const status = row.status === 'running' ? 'interrupted' : 'expired';
    let data = row.data;
    try { data = encrypt({ ...decode(row), error: fixedError(status === 'interrupted' ? 'AGENT_TASK_INTERRUPTED' : 'AGENT_TASK_EXPIRED') }, `agent-task:${row.user_id}:${row.id}`); } catch { /* Invalid stored data cannot authorize another attempt. */ }
    const changed = await db().prepare('UPDATE agent_tasks SET status=?,data=?,lease_token=NULL,updated_at=? WHERE id=? AND status=? AND expires_at<=?').run(status, data, now, row.id, row.status, now);
    if (changed.changes) { if (status === 'interrupted') interrupted++; else expired++; }
  }
  return { interrupted, expired };
}

/** Reserve limits with a DB-only callback. Duplicate active requests do not reserve them again. */
export async function enqueueAgentTask(userId: string, sessionHash: string, kindInput: AgentTaskKind, input: unknown, reserveEvaluation?: () => Promise<void>) {
  const kind = taskKind.parse(kindInput), normalized = parseInput(kind, input);
  z.string().regex(/^[a-f0-9]{64}$/).parse(sessionHash);
  const digest = inputDigest(userId, kind, normalized);
  return atomic(async () => {
    const wallet = await checkSession(userId, sessionHash);
    await expireTasks();
    const active = await db().prepare("SELECT * FROM agent_tasks WHERE user_id=? AND status IN ('queued','running')").get(userId) as TaskRow | undefined;
    if (active) {
      if (active.input_digest !== digest) throw new HttpError(409, 'AGENT_TASK_BUSY', 'Your agent already has another queued or running request. Review its activity first.');
      const prior = decode(active);
      await checkSession(userId, prior.sessionHash, prior.wallet);
      return { taskId: active.id, status: active.status as 'queued' | 'running', deduplicated: true };
    }
    const total = await db().prepare("SELECT COUNT(*) AS count FROM agent_tasks WHERE status IN ('queued','running')").get() as { count: number | string };
    if (Number(total.count) >= maximumActiveTasks) throw new HttpError(503, 'AGENT_QUEUE_FULL', 'The agent queue is full. Retry after current tasks finish.');
    await reserveEvaluation?.();
    const id = randomUUID(), now = new Date().toISOString();
    const payload: Payload = { version: 1, kind, input: normalized, sessionHash, wallet };
    await db().prepare("INSERT INTO agent_tasks(id,user_id,kind,status,input_digest,data,created_at,updated_at,expires_at) VALUES(?,?,?,'queued',?,?,?,?,?)")
      .run(id, userId, kind, digest, encrypt(payload, `agent-task:${userId}:${id}`), now, now, new Date(Date.now() + queuedLifetimeMs).toISOString());
    await audit(userId, 'agent_task', 'queued', 'Owner requested a durable qualification task. No model call has started.');
    return { taskId: id, status: 'queued' as const, deduplicated: false };
  });
}
function taskDto(row: TaskRow): AgentTaskDto {
  const dto: AgentTaskDto = { taskId: row.id, kind: row.kind, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, expiresAt: row.expires_at };
  try {
    const value = decode(row);
    if (row.status === 'completed') {
      if (!value.result) throw new Error('task_result_missing');
      dto.result = value.result;
    } else if (['failed', 'interrupted', 'expired'].includes(row.status)) dto.error = value.error || fixedError('AGENT_TASK_DATA_INVALID');
  } catch { dto.status = row.status === 'interrupted' || row.status === 'expired' ? row.status : 'failed'; dto.error = fixedError('AGENT_TASK_DATA_INVALID'); }
  return dto;
}
export async function readAgentTask(userId: string, id: string): Promise<AgentTaskDto> {
  z.string().uuid().parse(id);
  return atomic(async () => {
    await expireTasks(userId);
    const row = await db().prepare('SELECT * FROM agent_tasks WHERE id=? AND user_id=?').get(id, userId) as TaskRow | undefined;
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'Agent task was not found.');
    return taskDto(row);
  });
}
/** Resume polling after refresh or another device without exposing task input or session bindings. */
export async function listAgentTasks(userId: string): Promise<AgentTaskDto[]> {
  return atomic(async () => {
    await expireTasks(userId);
    const rows = await db().prepare('SELECT * FROM agent_tasks WHERE user_id=? ORDER BY created_at DESC,id DESC LIMIT 20').all(userId) as TaskRow[];
    return rows.map(taskDto);
  });
}
async function activeSession(row: TaskRow, token: string, payload: Payload) {
  const current = await db().prepare('SELECT * FROM agent_tasks WHERE id=? AND user_id=?').get(row.id, row.user_id) as TaskRow | undefined;
  if (!current || current.status !== 'running' || current.lease_token !== token || current.input_digest !== row.input_digest || Date.parse(current.expires_at) <= Date.now()) throw new HttpError(409, 'AGENT_TASK_INTERRUPTED', fixedError('AGENT_TASK_INTERRUPTED').message);
  await checkSession(row.user_id, payload.sessionHash, payload.wallet);
}
async function failTask(row: TaskRow, token: string, error: unknown) {
  return atomic(async () => {
    await expireTasks(row.user_id);
    const current = await db().prepare('SELECT * FROM agent_tasks WHERE id=? AND user_id=?').get(row.id, row.user_id) as TaskRow | undefined;
    if (!current || current.status !== 'running' || current.lease_token !== token) return current?.status === 'interrupted' ? 'interrupted' : 'failed';
    let data = current.data;
    try {
      const allowed = error instanceof HttpError && ['AGENT_TASK_SESSION_CLOSED', 'AGENT_TASK_WALLET_CHANGED', 'AGENT_TASK_INTERRUPTED'].includes(error.code) ? error.code : 'AGENT_TASK_FAILED';
      data = encrypt({ ...decode(current), error: fixedError(allowed) }, `agent-task:${row.user_id}:${row.id}`);
    } catch { /* A corrupt task remains failed and never starts substitute work. */ }
    await db().prepare("UPDATE agent_tasks SET status='failed',data=?,lease_token=NULL,updated_at=? WHERE id=? AND status='running' AND lease_token=?").run(data, new Date().toISOString(), row.id, token);
    await audit(row.user_id, 'agent_task', 'failed', 'The task did not produce a confirmed result. Review current activity before another explicit attempt.');
    return 'failed';
  });
}

/** Only explicitly enqueued actions run. Expired running work is interrupted, never replayed. */
export async function drainAgentTasks() {
  const counts = { processed: 0, completed: 0, failed: 0, interrupted: 0, expired: 0, busy: false };
  if (draining) return { ...counts, busy: true };
  draining = true;
  try {
    const token = randomUUID();
    const row = await atomic(async () => {
      Object.assign(counts, await expireTasks());
      const next = await db().prepare("SELECT * FROM agent_tasks WHERE status='queued' ORDER BY created_at,id LIMIT 1").get() as TaskRow | undefined;
      if (!next) return null;
      const now = new Date().toISOString();
      const changed = await db().prepare("UPDATE agent_tasks SET status='running',lease_token=?,updated_at=?,expires_at=? WHERE id=? AND status='queued' AND expires_at>?")
        .run(token, now, new Date(Date.now() + runningLifetimeMs).toISOString(), next.id, now);
      return changed.changes === 1 ? next : null;
    });
    if (!row) return counts;
    counts.processed = 1;
    try {
      const payload = decode(row), check = () => activeSession(row, token, payload);
      await check();
      const result = await withAgentRun(row.user_id, async progress => {
        const guardedProgress = async (stage: RunningStage) => { await check(); await progress(stage); await check(); };
        await check();
        if (payload.kind === 'propose') {
          const input = proposeInput.parse(payload.input);
          return createProposal(row.user_id, input.intentId, input.candidateKey, check, guardedProgress);
        }
        const input = continuationInput.parse(payload.input);
        return payload.kind === 'resume'
          ? resumeQualification(row.user_id, input.qualificationId, { version: input.version }, check, guardedProgress)
          : retryQualification(row.user_id, input.qualificationId, { version: input.version }, check, guardedProgress);
      });
      const reviewedResult = taskResult.parse(result);
      await atomic(async () => {
        await check();
        const changed = await db().prepare("UPDATE agent_tasks SET status='completed',data=?,lease_token=NULL,updated_at=? WHERE id=? AND status='running' AND lease_token=? AND expires_at>?")
          .run(encrypt({ ...payload, result: reviewedResult }, `agent-task:${row.user_id}:${row.id}`), new Date().toISOString(), row.id, token, new Date().toISOString());
        if (changed.changes !== 1) throw new HttpError(409, 'AGENT_TASK_INTERRUPTED', fixedError('AGENT_TASK_INTERRUPTED').message);
        await audit(row.user_id, 'agent_task', 'completed', 'The requested qualification task finished. Introduction consent remains separate.');
      });
      counts.completed = 1;
    } catch (error) {
      if (await failTask(row, token, error) === 'interrupted') counts.interrupted++;
      else counts.failed++;
    }
    return counts;
  } finally { draining = false; }
}

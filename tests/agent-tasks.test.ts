import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const services = vi.hoisted(() => ({ propose: vi.fn(), resume: vi.fn(), retry: vi.fn() }));
// These fixtures exercise queue/session/fencing rules, not provider integration or matching decisions.
vi.mock('../packages/server/proposals', () => ({ createProposal: services.propose }));
vi.mock('../packages/server/qualifications', () => ({ resumeQualification: services.resume, retryQualification: services.retry }));
import { drainAgentTasks, enqueueAgentTask, listAgentTasks, readAgentTask } from '../packages/server/agent-tasks';
import { closeDatabase, db } from '../packages/server/db';
import { db as store, closeStore } from '../packages/server/store';
import { encrypt, hash } from '../packages/server/crypto';
import { createSession } from '../packages/server/security';

let directory: string;
const queuedLifetime = 15 * 60000, runningLifetime = 20 * 60000;
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; }
async function owner() {
  const id = randomUUID(), wallet = '0x' + randomBytes(20).toString('hex');
  db().prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(id, id + '@task.fixture.invalid', '', wallet, encrypt({}, `profile:${id}`), new Date().toISOString());
  const cookie = await createSession(id), token = cookie.split(';')[0].slice('meeti_session='.length);
  return { id, wallet, cookie, sessionHash: hash(token) };
}
function input() { return { intentId: randomUUID(), candidateKey: '0x' + randomBytes(32).toString('hex') }; }
beforeEach(() => {
  closeDatabase(); directory = mkdtempSync(join(tmpdir(), 'meeti-agent-tasks-'));
  vi.stubEnv('DATABASE_PROVIDER', 'sqlite'); vi.stubEnv('SUPABASE_DATABASE_URL', '');
  vi.stubEnv('DATABASE_PATH', join(directory, 'test.sqlite')); vi.stubEnv('DATA_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime(new Date('2026-11-07T22:00:00.000Z'));
  // Raw setup remains an explicit SQLite fixture until the root loader incorporates migration 008.
  db().exec(readFileSync('migrations/008_agent_tasks.sql', 'utf8'));
  for (const service of Object.values(services)) service.mockReset().mockImplementation(async (_user: string, _id: string, _input: unknown, check: () => Promise<void>, progress: (stage: string) => Promise<void>) => {
    expect(store().isTransaction).toBe(false);
    await check(); await progress('evaluating_fit'); await check();
    return { id: null, qualificationId: randomUUID() };
  });
});
afterEach(async () => { await closeStore(); closeDatabase(); vi.useRealTimers(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

describe('durable explicitly requested agent tasks with session and service fixtures', () => {
  it('enqueues encrypted private input without running models and returns only owner-bound task state', async () => {
    const actor = await owner(), reviewed = input(), reserve = vi.fn(async () => {});
    const task = await enqueueAgentTask(actor.id, actor.sessionHash, 'propose', reviewed, reserve);
    expect(task).toMatchObject({ status: 'queued', deduplicated: false });
    expect(reserve).toHaveBeenCalledOnce(); expect(services.propose).not.toHaveBeenCalled();
    const stored = JSON.stringify(db().prepare('SELECT * FROM agent_tasks').all());
    for (const value of [reviewed.intentId, reviewed.candidateKey, actor.wallet, actor.sessionHash, actor.cookie]) expect(stored).not.toContain(value);
    const dto = await readAgentTask(actor.id, task.taskId);
    expect(dto).toMatchObject({ taskId: task.taskId, kind: 'propose', status: 'queued' });
    expect(dto).not.toHaveProperty('input'); expect(dto).not.toHaveProperty('sessionHash');
    const outsider = await owner(); await expect(readAgentTask(outsider.id, task.taskId)).rejects.toMatchObject({ status: 404 });
    expect(await listAgentTasks(outsider.id)).toEqual([]);
    expect(await listAgentTasks(actor.id)).toEqual([dto]);
  });
  it('deduplicates canonical identical active requests, debits once and rejects a conflicting request', async () => {
    const actor = await owner(), reviewed = input(), reserve = vi.fn(async () => {});
    const requests = await Promise.all([enqueueAgentTask(actor.id, actor.sessionHash, 'propose', reviewed, reserve), enqueueAgentTask(actor.id, actor.sessionHash, 'propose', { ...reviewed, candidateKey: reviewed.candidateKey.toUpperCase().replace('0X', '0x') }, reserve)]);
    expect(new Set(requests.map(value => value.taskId)).size).toBe(1); expect(reserve).toHaveBeenCalledOnce();
    await expect(enqueueAgentTask(actor.id, actor.sessionHash, 'propose', input(), reserve)).rejects.toMatchObject({ code: 'AGENT_TASK_BUSY' });
    expect(db().prepare('SELECT id FROM agent_tasks').all()).toHaveLength(1); expect(reserve).toHaveBeenCalledOnce();
  });
  it('rolls back a failed enqueue budget reservation', async () => {
    const actor = await owner();
    await expect(enqueueAgentTask(actor.id, actor.sessionHash, 'propose', input(), async () => { throw new Error('fixture_budget_denied'); })).rejects.toThrow('fixture_budget_denied');
    expect(db().prepare('SELECT id FROM agent_tasks').all()).toHaveLength(0); expect(services.propose).not.toHaveBeenCalled();
  });
  it('runs the existing service outside transactions, persists its actual IDs privately and never repeats completion', async () => {
    const actor = await owner(), reviewed = input(), qualificationId = randomUUID(), proposalId = randomUUID();
    services.propose.mockImplementationOnce(async (_user, _id, _key, check, progress) => { expect(store().isTransaction).toBe(false); await check(); await progress('checking_permissions'); return { id: proposalId, qualificationId }; });
    const task = await enqueueAgentTask(actor.id, actor.sessionHash, 'propose', reviewed);
    expect(await drainAgentTasks()).toMatchObject({ processed: 1, completed: 1, failed: 0 });
    expect(services.propose).toHaveBeenCalledWith(actor.id, reviewed.intentId, reviewed.candidateKey, expect.any(Function), expect.any(Function));
    expect(await readAgentTask(actor.id, task.taskId)).toMatchObject({ status: 'completed', result: { id: proposalId, qualificationId } });
    expect(JSON.stringify(db().prepare('SELECT * FROM agent_tasks').all())).not.toContain(qualificationId);
    expect(await drainAgentTasks()).toMatchObject({ processed: 0 }); expect(services.propose).toHaveBeenCalledOnce();
  });
  it.each(['resume', 'retry'] as const)('routes explicit %s to the existing version-bound service', async kind => {
    const actor = await owner(), reviewed = { qualificationId: randomUUID(), version: 7 };
    await enqueueAgentTask(actor.id, actor.sessionHash, kind, reviewed); await drainAgentTasks();
    expect(services[kind]).toHaveBeenCalledWith(actor.id, reviewed.qualificationId, { version: 7 }, expect.any(Function), expect.any(Function));
    expect(services.propose).not.toHaveBeenCalled();
  });
  it.each(['logout', 'expiry', 'wallet'] as const)('denies %s changes before any protected service starts', async change => {
    const actor = await owner(), task = await enqueueAgentTask(actor.id, actor.sessionHash, 'propose', input());
    if (change === 'logout') db().prepare('DELETE FROM sessions WHERE token_hash=?').run(actor.sessionHash);
    if (change === 'expiry') db().prepare('UPDATE sessions SET expires_at=? WHERE token_hash=?').run(new Date(0).toISOString(), actor.sessionHash);
    if (change === 'wallet') db().prepare('UPDATE users SET wallet=? WHERE id=?').run('0x' + '77'.repeat(20), actor.id);
    expect(await drainAgentTasks()).toMatchObject({ processed: 1, failed: 1 });
    expect((await readAgentTask(actor.id, task.taskId)).error?.code).toBe(change === 'wallet' ? 'AGENT_TASK_WALLET_CHANGED' : 'AGENT_TASK_SESSION_CLOSED');
    expect(services.propose).not.toHaveBeenCalled();
  });
  it('rechecks revocation between protected callbacks and denies storing a late successful result', async () => {
    const actor = await owner();
    services.propose.mockImplementationOnce(async (_user, _id, _key, check, progress) => {
      await check(); await progress('evaluating_fit');
      db().prepare('DELETE FROM sessions WHERE token_hash=?').run(actor.sessionHash);
      return { id: null, qualificationId: randomUUID() };
    });
    const task = await enqueueAgentTask(actor.id, actor.sessionHash, 'propose', input());
    expect(await drainAgentTasks()).toMatchObject({ failed: 1 });
    expect(await readAgentTask(actor.id, task.taskId)).toMatchObject({ status: 'failed', error: { code: 'AGENT_TASK_SESSION_CLOSED' } });
    expect(await readAgentTask(actor.id, task.taskId)).not.toHaveProperty('result');
  });
  it('processes at most one task and rejects overlapping process-local drains', async () => {
    const first = await owner(), second = await owner(), hold = deferred<void>(), entered = deferred<void>();
    services.propose.mockImplementationOnce(async () => { entered.resolve(); await hold.promise; return { id: null, qualificationId: randomUUID() }; });
    await enqueueAgentTask(first.id, first.sessionHash, 'propose', input()); await enqueueAgentTask(second.id, second.sessionHash, 'propose', input());
    const pending = drainAgentTasks(); await entered.promise;
    try { expect(await drainAgentTasks()).toMatchObject({ processed: 0, busy: true }); expect(services.propose).toHaveBeenCalledOnce(); }
    finally { hold.resolve(); await pending; }
    expect(await drainAgentTasks()).toMatchObject({ processed: 1, completed: 1 }); expect(services.propose).toHaveBeenCalledTimes(2);
  });
  it('marks unknown expired running work interrupted and never automatically replays it after restart', async () => {
    const actor = await owner(), task = await enqueueAgentTask(actor.id, actor.sessionHash, 'propose', input());
    db().prepare("UPDATE agent_tasks SET status='running',lease_token=?,expires_at=? WHERE id=?").run(randomUUID(), new Date(Date.now() + runningLifetime).toISOString(), task.taskId);
    expect(await drainAgentTasks()).toMatchObject({ processed: 0 });
    closeDatabase(); vi.setSystemTime(new Date(Date.now() + runningLifetime + 1));
    expect(await drainAgentTasks()).toMatchObject({ processed: 0, interrupted: 1 });
    expect(await readAgentTask(actor.id, task.taskId)).toMatchObject({ status: 'interrupted', error: { code: 'AGENT_TASK_INTERRUPTED' } });
    await drainAgentTasks(); expect(services.propose).not.toHaveBeenCalled();
  });
  it('expires unstarted work and fences a result after its running lease expires', async () => {
    const actor = await owner(), first = await enqueueAgentTask(actor.id, actor.sessionHash, 'propose', input());
    vi.setSystemTime(new Date(Date.now() + queuedLifetime + 1));
    expect(await readAgentTask(actor.id, first.taskId)).toMatchObject({ status: 'expired' }); expect(services.propose).not.toHaveBeenCalled();
    const second = await enqueueAgentTask(actor.id, actor.sessionHash, 'propose', input());
    services.propose.mockImplementationOnce(async (_user, _id, _key, check) => { vi.setSystemTime(new Date(Date.now() + runningLifetime + 1)); await check(); return { id: null, qualificationId: randomUUID() }; });
    expect(await drainAgentTasks()).toMatchObject({ interrupted: 1, completed: 0 });
    expect(await readAgentTask(actor.id, second.taskId)).toMatchObject({ status: 'interrupted' });
  });
  it('sanitizes provider failures and refuses altered task bindings or additional result fields', async () => {
    const actor = await owner(), first = await enqueueAgentTask(actor.id, actor.sessionHash, 'propose', input());
    services.propose.mockRejectedValueOnce(new Error('private-provider-key-and-prompt'));
    await drainAgentTasks();
    expect(await readAgentTask(actor.id, first.taskId)).toMatchObject({ status: 'failed', error: { code: 'AGENT_TASK_FAILED' } });
    expect(JSON.stringify(db().prepare('SELECT * FROM agent_tasks').all())).not.toContain('private-provider-key-and-prompt');
    const second = await enqueueAgentTask(actor.id, actor.sessionHash, 'propose', input());
    db().prepare('UPDATE agent_tasks SET input_digest=? WHERE id=?').run('0'.repeat(64), second.taskId);
    await drainAgentTasks(); expect(services.propose).toHaveBeenCalledOnce();
    expect(await readAgentTask(actor.id, second.taskId)).toMatchObject({ status: 'failed', error: { code: 'AGENT_TASK_DATA_INVALID' } });
    const third = await enqueueAgentTask(actor.id, actor.sessionHash, 'propose', input());
    services.propose.mockResolvedValueOnce({ id: null, qualificationId: randomUUID(), privateContact: 'forbidden-fixture' });
    await drainAgentTasks(); expect(await readAgentTask(actor.id, third.taskId)).toMatchObject({ status: 'failed' });
    expect(JSON.stringify(db().prepare('SELECT * FROM agent_tasks').all())).not.toContain('forbidden-fixture');
  });
  it('bounds the global active queue and rejects unreviewed input shapes', async () => {
    for (let index = 0; index < 32; index++) { const actor = await owner(); await enqueueAgentTask(actor.id, actor.sessionHash, 'propose', input()); }
    const actor = await owner();
    await expect(enqueueAgentTask(actor.id, actor.sessionHash, 'propose', input())).rejects.toMatchObject({ code: 'AGENT_QUEUE_FULL' });
    await expect(enqueueAgentTask(actor.id, actor.sessionHash, 'propose', { ...input(), privateContact: 'not-accepted' })).rejects.toThrow();
    await expect(enqueueAgentTask(actor.id, actor.sessionHash, 'resume', { qualificationId: randomUUID(), version: 0 })).rejects.toThrow();
    expect(db().prepare('SELECT id FROM agent_tasks').all()).toHaveLength(32); expect(services.propose).not.toHaveBeenCalled();
  });
});

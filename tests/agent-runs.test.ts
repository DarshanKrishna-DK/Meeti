import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { route } from '../packages/server/router';
import { agentRuns, withAgentRun, type RunningStage } from '../packages/server/agent-runs';
import { closeDatabase, db } from '../packages/server/db';

// Deferred local work exercises request tracking only. It makes no matching or provider decisions.
const origin = 'http://127.0.0.1:3198';
const leaseMs = 15 * 60000;
let directory: string;
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function call(path: string, body?: unknown, cookie?: string) {
  return route(new Request(`${origin}/api/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { origin, 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }), path.split('/'));
}
async function register() {
  const response = await call('auth/register', { email: `${randomUUID()}@agent-run-fixture.invalid`, password: 'an explicit local fixture password' });
  expect(response.status).toBe(200);
  const { data } = await response.json() as { data: { id: string } };
  return { id: data.id, cookie: response.headers.getSetCookie()[0].split(';')[0] };
}
function holdRun(userId: string) {
  const work = deferred<{ id: string | null }>();
  let advance!: (value: RunningStage) => void;
  const result = withAgentRun(userId, async stage => { advance = stage; return work.promise; });
  return { work, result, advance };
}
function audits(userId: string) {
  return db().prepare('SELECT action,outcome,detail FROM audit WHERE user_id=? AND action=? ORDER BY rowid').all(userId, 'agent_run');
}

beforeEach(() => {
  closeDatabase();
  directory = mkdtempSync(join(tmpdir(), 'meeti-agent-runs-'));
  vi.stubEnv('DATABASE_PATH', join(directory, 'test.sqlite'));
  vi.stubEnv('DATA_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
  vi.stubEnv('APP_ORIGIN', origin);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-11-06T10:00:00.000Z'));
});
afterEach(() => {
  closeDatabase();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe('persisted bounded agent request progress', () => {
  it('records a running request and each actual callback stage, renewing its fifteen-minute lease', async () => {
    const owner = await register(), pending = holdRun(owner.id);
    const initial = agentRuns(owner.id)[0];
    expect(initial).toMatchObject({ kind: 'proposal', status: 'running', stage: 'checking_permissions' });
    expect(Date.parse(initial.expiresAt) - Date.parse(initial.startedAt)).toBe(leaseMs);
    for (const stage of ['evaluating_fit', 'exchanging_context', 'rechecking_permissions'] as RunningStage[]) {
      vi.setSystemTime(new Date(Date.now() + 60000));
      pending.advance(stage);
      const current = agentRuns(owner.id)[0];
      expect(current).toMatchObject({ id: initial.id, status: 'running', stage, startedAt: initial.startedAt });
      expect(Date.parse(current.expiresAt) - Date.now()).toBe(leaseMs);
      expect(current.updatedAt).toBe(new Date().toISOString());
    }
    const proposalId = randomUUID();
    pending.work.resolve({ id: proposalId });
    await expect(pending.result).resolves.toEqual({ id: proposalId });
    expect(agentRuns(owner.id)[0]).toMatchObject({ id: initial.id, status: 'completed', stage: 'completed', proposalId });
    expect(audits(owner.id).map(value => value.outcome)).toEqual(['started', 'completed']);
  });

  it('records completed work with no proposal without inventing a proposal identifier', async () => {
    const owner = await register();
    const work = vi.fn(async () => ({ id: null }));
    await expect(withAgentRun(owner.id, work)).resolves.toEqual({ id: null });
    expect(work).toHaveBeenCalledOnce();
    const [run] = agentRuns(owner.id);
    expect(run).toMatchObject({ status: 'completed', stage: 'completed' });
    expect(run).not.toHaveProperty('proposalId');
    expect(db().prepare('SELECT proposal_id FROM agent_runs WHERE id=?').get(run.id)).toEqual({ proposal_id: null });
  });

  it('marks rejected work failed without persisting or exposing private error text', async () => {
    const owner = await register(), pending = holdRun(owner.id);
    const secret = 'private provider credential and raw prompt fixture';
    const error = new Error(secret);
    const assertion = expect(pending.result).rejects.toBe(error);
    pending.work.reject(error);
    await assertion;
    expect(agentRuns(owner.id)[0]).toMatchObject({ status: 'failed', stage: 'failed' });
    expect(JSON.stringify(db().prepare('SELECT * FROM agent_runs WHERE user_id=?').all(owner.id))).not.toContain(secret);
    expect(JSON.stringify(audits(owner.id))).not.toContain(secret);
    expect(audits(owner.id).map(value => value.outcome)).toEqual(['started', 'failed']);
    const response = await call('state', undefined, owner.cookie);
    expect(response.status).toBe(200);
    expect(await response.text()).not.toContain(secret);
  });

  it('rejects a second concurrent request for the same owner before starting its callback', async () => {
    const owner = await register(), first = holdRun(owner.id);
    const secondWork = vi.fn(async () => ({ id: null }));
    await expect(withAgentRun(owner.id, secondWork)).rejects.toMatchObject({ status: 409, code: 'AGENT_BUSY' });
    expect(secondWork).not.toHaveBeenCalled();
    expect(agentRuns(owner.id)).toHaveLength(1);
    first.work.resolve({ id: null });
    await first.result;
    await expect(withAgentRun(owner.id, secondWork)).resolves.toEqual({ id: null });
    expect(secondWork).toHaveBeenCalledOnce();
  });

  it('tracks separate owners independently and exposes only the current owner progress through GET state', async () => {
    const left = await register(), right = await register();
    const leftWork = holdRun(left.id), rightWork = holdRun(right.id);
    leftWork.advance('evaluating_fit');
    rightWork.advance('exchanging_context');
    const leftRun = agentRuns(left.id)[0], rightRun = agentRuns(right.id)[0];
    expect(leftRun.id).not.toBe(rightRun.id);
    const leftResponse = await call('state', undefined, left.cookie), rightResponse = await call('state', undefined, right.cookie);
    const leftState = await leftResponse.text(), rightState = await rightResponse.text();
    expect(leftState).toContain(leftRun.id);
    expect(leftState).not.toContain(rightRun.id);
    expect(rightState).toContain(rightRun.id);
    expect(rightState).not.toContain(leftRun.id);
    expect((await call('state')).status).toBe(401);
    leftWork.work.resolve({ id: null });
    await leftWork.result;
    expect(agentRuns(right.id)[0].status).toBe('running');
    rightWork.work.resolve({ id: null });
    await rightWork.result;
  });

  it('interrupts an expired persisted run after reconnection and GET rather than claiming ongoing work', async () => {
    const owner = await register(), pending = holdRun(owner.id);
    const initial = agentRuns(owner.id)[0];
    closeDatabase();
    vi.setSystemTime(new Date(Date.now() + leaseMs));
    const response = await call('state', undefined, owner.cookie);
    expect(response.status).toBe(200);
    const { data } = await response.json();
    expect(data.agentRuns).toEqual([{ ...initial, status: 'interrupted', stage: 'interrupted', updatedAt: new Date().toISOString() }]);
    const assertion = expect(pending.result).rejects.toMatchObject({ status: 409, code: 'AGENT_RUN_INTERRUPTED' });
    pending.work.resolve({ id: randomUUID() });
    await assertion;
    expect(agentRuns(owner.id)[0]).toMatchObject({ status: 'interrupted', stage: 'interrupted' });
    expect(audits(owner.id).map(value => value.outcome)).not.toContain('completed');
  });

  it('rejects completion after lease expiry even when no GET request has expired the row first', async () => {
    const owner = await register(), pending = holdRun(owner.id);
    vi.setSystemTime(new Date(Date.now() + leaseMs + 1));
    const assertion = expect(pending.result).rejects.toMatchObject({ status: 409, code: 'AGENT_RUN_INTERRUPTED' });
    pending.work.resolve({ id: null });
    await assertion;
    expect(agentRuns(owner.id)[0]).toMatchObject({ status: 'interrupted', stage: 'interrupted' });
    expect(audits(owner.id).map(value => value.outcome)).not.toContain('completed');
  });

  it('allows fresh work after an expired lease without letting the old callback replace its progress', async () => {
    const owner = await register(), old = holdRun(owner.id);
    const oldId = agentRuns(owner.id)[0].id;
    vi.setSystemTime(new Date(Date.now() + leaseMs + 1));
    const current = holdRun(owner.id), currentId = agentRuns(owner.id)[0].id;
    expect(currentId).not.toBe(oldId);
    expect(() => old.advance('evaluating_fit')).toThrow(expect.objectContaining({ status: 409, code: 'AGENT_RUN_INTERRUPTED' }));
    const assertion = expect(old.result).rejects.toMatchObject({ status: 409, code: 'AGENT_RUN_INTERRUPTED' });
    old.work.resolve({ id: randomUUID() });
    await assertion;
    expect(agentRuns(owner.id).find(run => run.id === currentId)).toMatchObject({ status: 'running', stage: 'checking_permissions' });
    expect(agentRuns(owner.id).find(run => run.id === oldId)).toMatchObject({ status: 'interrupted', stage: 'interrupted' });
    current.work.resolve({ id: null });
    await current.result;
  });

  it('preserves interrupted status when expired work later rejects with a provider error', async () => {
    const owner = await register(), pending = holdRun(owner.id);
    vi.setSystemTime(new Date(Date.now() + leaseMs + 1));
    const error = new Error('private late provider failure fixture');
    const assertion = expect(pending.result).rejects.toBe(error);
    pending.work.reject(error);
    await assertion;
    expect(agentRuns(owner.id)[0]).toMatchObject({ status: 'interrupted', stage: 'interrupted' });
    expect(JSON.stringify(audits(owner.id))).not.toContain(error.message);
  });

  it('does not resurrect deleted owner records or write an invalid audit after a deferred success', async () => {
    const owner = await register(), pending = holdRun(owner.id);
    expect((await call('account/delete', { confirmation: 'DELETE' }, owner.cookie)).status).toBe(200);
    expect(db().prepare('SELECT id FROM agent_runs WHERE user_id=?').get(owner.id)).toBeUndefined();
    const assertion = expect(pending.result).rejects.toMatchObject({ status: 409, code: 'AGENT_RUN_INTERRUPTED' });
    pending.work.resolve({ id: null });
    await assertion;
    expect(db().prepare('SELECT id FROM users WHERE id=?').get(owner.id)).toBeUndefined();
    expect(audits(owner.id)).toEqual([]);
    expect((await call('state', undefined, owner.cookie)).status).toBe(401);
  });

  it('preserves the original callback error safely when its owner was deleted during work', async () => {
    const owner = await register(), pending = holdRun(owner.id);
    expect((await call('account/delete', { confirmation: 'DELETE' }, owner.cookie)).status).toBe(200);
    const error = new Error('explicit local work rejection');
    const assertion = expect(pending.result).rejects.toBe(error);
    pending.work.reject(error);
    await assertion;
    expect(agentRuns(owner.id)).toEqual([]);
    expect(audits(owner.id)).toEqual([]);
  });
});

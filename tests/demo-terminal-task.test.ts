import { randomBytes, randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { encrypt, sign } from '../packages/server/crypto';
import { reconcileTerminalTaskPointer } from '../scripts/demo-core-flow';

const target = 'https://meeti-fixture.vercel.app', source = 'http://127.0.0.1:3173';
type Saved = Parameters<typeof reconcileTerminalTaskPointer>[0];
function fixture(status = 'failed') {
  const taskId = randomUUID(), seeker = randomUUID(), recruiter = randomUUID(), qualificationId = randomUUID();
  const wallets = { 'demo-seeker': '0x' + '11'.repeat(20), 'demo-recruiter': '0x' + '22'.repeat(20) };
  const candidateKey = '0x' + 'ab'.repeat(32), input = { intentId: randomUUID(), candidateKey };
  const saved: Saved = { version: 1, origin: source, sessions: { 'demo-seeker': 'LOCAL_SESSION_PRESERVED' }, accounts: { 'demo-seeker': seeker, 'demo-recruiter': recruiter },
    prepared: {}, discovery: {}, qualifications: { collaboration: { qualificationId, id: null } },
    pending: { taskId, label: 'demo-seeker', case: 'job', origin: source, startedAt: new Date().toISOString(), step: `qualify:job:${candidateKey}` },
    hostedAuth: { [target]: { accounts: { 'demo-seeker': seeker, 'demo-recruiter': recruiter }, wallets, sessions: { 'demo-seeker': 'HOSTED_SESSION_ONE', 'demo-recruiter': 'HOSTED_SESSION_TWO' }, authenticatedAt: new Date().toISOString() } },
    taskHistory: [{ taskId: randomUUID(), step: 'old', origin: source, status: 'failed' }],
  };
  const row = { id: taskId, user_id: seeker, kind: 'propose', status, owner_wallet: wallets['demo-seeker'], seeker_id: seeker, seeker_wallet: wallets['demo-seeker'], recruiter_id: recruiter, recruiter_wallet: wallets['demo-recruiter'],
    input_digest: sign(JSON.stringify({ userId: seeker, kind: 'propose', input })), data: encrypt({ version: 1, kind: 'propose', input, wallet: wallets['demo-seeker'], sessionHash: 'a'.repeat(64) }, `agent-task:${seeker}:${taskId}`) };
  const lookup = vi.fn(async () => row as Record<string, unknown> | undefined);
  const options = { origin: target, explicitTarget: true, environment: { DATABASE_PROVIDER: 'postgres', SUPABASE_DATABASE_URL: 'configured-fixture-reference' }, lookup };
  return { saved, row, options, lookup, input };
}
beforeEach(() => { vi.stubEnv('DATA_ENCRYPTION_KEY', randomBytes(32).toString('hex')); vi.stubGlobal('fetch', vi.fn(() => { throw new Error('HTTP is forbidden in terminal reconciliation'); })); });
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

describe('explicit terminal demo-task reconciliation with read-only lookup fixtures', () => {
  it.each(['failed', 'interrupted', 'expired'])('archives only a confirmed %s task and preserves every other progress value', async status => {
    const { saved, options, lookup } = fixture(status), original = structuredClone(saved);
    const result = await reconcileTerminalTaskPointer(saved, options);
    expect(saved).toEqual(original); expect(result.progress).not.toHaveProperty('pending');
    expect(result.progress.sessions).toEqual(original.sessions); expect(result.progress.hostedAuth).toEqual(original.hostedAuth);
    expect(result.progress.qualifications).toEqual(original.qualifications); expect(result.progress.prepared).toEqual(original.prepared); expect(result.progress.discovery).toEqual(original.discovery);
    expect(result.progress.taskHistory).toHaveLength(2);
    expect(result.progress.taskHistory?.at(-1)).toMatchObject({ ...original.pending, origin: source, status, targetOrigin: target });
    expect(result.receipt).toMatchObject({ status, sourceOrigin: source, targetOrigin: target, databaseReadOnly: true, newActionEnqueued: false });
    expect(lookup).toHaveBeenCalledOnce(); expect(fetch).not.toHaveBeenCalled();
  });
  it.each(['queued', 'running', 'completed', 'unknown', ''])('never clears %s tasks based on expiry or assumptions', async status => {
    const { saved, options } = fixture(status), original = structuredClone(saved);
    await expect(reconcileTerminalTaskPointer(saved, options)).rejects.toMatchObject({ code: 'TERMINAL_TASK_STATUS_NOT_RECONCILABLE' }); expect(saved).toEqual(original); expect(fetch).not.toHaveBeenCalled();
  });
  it('requires explicit Postgres selection and an existing target-origin account mapping before any lookup', async () => {
    const { saved, options, lookup } = fixture();
    await expect(reconcileTerminalTaskPointer(saved, { ...options, explicitTarget: false })).rejects.toMatchObject({ code: 'TERMINAL_TASK_REQUIRES_EXPLICIT_POSTGRES_TARGET' });
    await expect(reconcileTerminalTaskPointer(saved, { ...options, environment: { DATABASE_PROVIDER: 'sqlite', SUPABASE_DATABASE_URL: '' } })).rejects.toMatchObject({ code: 'TERMINAL_TASK_REQUIRES_EXPLICIT_POSTGRES_TARGET' });
    const missing = structuredClone(saved); delete missing.hostedAuth;
    await expect(reconcileTerminalTaskPointer(missing, options)).rejects.toMatchObject({ code: 'EXISTING_TARGET_ACCOUNT_BINDING_REQUIRED' }); expect(lookup).not.toHaveBeenCalled();
  });
  it('rejects an unbound source origin or an incomplete pending pointer', async () => {
    const { saved, options, lookup } = fixture(); saved.pending!.origin = 'https://unbound-fixture.vercel.app';
    await expect(reconcileTerminalTaskPointer(saved, options)).rejects.toMatchObject({ code: 'EXISTING_SOURCE_ACCOUNT_BINDING_REQUIRED' });
    delete saved.pending!.origin;
    await expect(reconcileTerminalTaskPointer(saved, options)).rejects.toMatchObject({ code: 'EXISTING_ORIGIN_BOUND_TASK_POINTER_REQUIRED' }); expect(lookup).not.toHaveBeenCalled();
  });
  it.each(['user_id', 'owner_wallet', 'seeker_id', 'seeker_wallet', 'recruiter_id', 'recruiter_wallet'])('rejects changed same-database ownership: %s', async field => {
    const { saved, options, row } = fixture(); (row as Record<string, unknown>)[field] = 'different';
    await expect(reconcileTerminalTaskPointer(saved, options)).rejects.toMatchObject({ code: 'TERMINAL_TASK_ACCOUNT_OWNERSHIP_MISMATCH' }); expect(saved.pending).toBeDefined();
  });
  it('rejects missing tasks, altered ciphertext, input digests and step bindings', async () => {
    const first = fixture(); first.lookup.mockResolvedValueOnce(undefined);
    await expect(reconcileTerminalTaskPointer(first.saved, first.options)).rejects.toMatchObject({ code: 'TERMINAL_TASK_ACCOUNT_OWNERSHIP_MISMATCH' });
    for (const field of ['data', 'input_digest'] as const) {
      const { saved, options, row } = fixture(); row[field] = 'tampered';
      await expect(reconcileTerminalTaskPointer(saved, options)).rejects.toMatchObject({ code: 'TERMINAL_TASK_AUTHENTICATED_PAYLOAD_MISMATCH' });
    }
    const last = fixture(); last.saved.pending!.step = 'qualify:collaboration:0x' + 'ff'.repeat(32);
    await expect(reconcileTerminalTaskPointer(last.saved, last.options)).rejects.toMatchObject({ code: 'TERMINAL_TASK_AUTHENTICATED_PAYLOAD_MISMATCH' });
  });
  it('preserves older archived history and reports database failure with a fixed code', async () => {
    const { saved, options, lookup } = fixture(); saved.taskHistory = Array.from({ length: 21 }, () => ({ taskId: randomUUID(), step: 'old', origin: source, status: 'failed' }));
    expect((await reconcileTerminalTaskPointer(saved, options)).progress.taskHistory).toHaveLength(22);
    lookup.mockRejectedValueOnce(new Error('PRIVATE_CONNECTION_URI_AND_PAYLOAD'));
    await expect(reconcileTerminalTaskPointer(saved, options)).rejects.toMatchObject({ code: 'TERMINAL_TASK_DATABASE_READ_FAILED' }); expect(saved.pending).toBeDefined(); expect(fetch).not.toHaveBeenCalled();
  });
});

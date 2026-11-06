import { randomUUID } from 'node:crypto';
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { atomic, closeStore, db } from '../packages/server/store';
import { route } from '../packages/server/router';

// Private fictional accounts exercise the actual Postgres adapter and authentication routes.
// No chain transactions, provider inference or public intent publication occur.
async function main() {
  if (process.env.DATABASE_PROVIDER !== 'postgres') throw new Error('explicit_postgres_required');
  const origin = new URL(process.env.APP_ORIGIN || '').origin;
  const accounts: { id: string; cookie: string; challengeId: string }[] = [];
  const challengeIds: string[] = [];
  const marker = `postgres-check-${randomUUID()}`;
  const originalFetch = globalThis.fetch;
  const originalQueue = process.env.AGENT_TASK_QUEUE_ENABLED;
  process.env.AGENT_TASK_QUEUE_ENABLED = 'true';
  globalThis.fetch = async () => { throw new Error('external_http_forbidden_in_database_verification'); };
  const call = async (path: string, body?: unknown, cookie = '') => {
    const response = await route(new Request(`${origin}/api/${path}`, { method: body === undefined ? 'GET' : 'POST',
      headers: { origin, 'content-type': 'application/json', cookie }, body: body === undefined ? undefined : JSON.stringify(body) }), path.split('/'));
    return { response, payload: await response.json() };
  };
  try {
    const role = await db().prepare('SELECT current_user AS role').get();
    if (role?.role !== 'meeti_runtime') throw new Error('restricted_database_role_required');
    for (let index = 0; index < 2; index++) {
      const wallet = privateKeyToAccount(generatePrivateKey());
      const challenge = await call('auth/wallet/challenge', { address: wallet.address, chainId: 11155111 });
      if (challenge.response.status !== 200) throw new Error(`challenge_failed_${challenge.payload.error?.code || 'unknown'}`);
      const challengeId = challenge.payload.data.id; challengeIds.push(challengeId);
      const flow = challenge.response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
      const signature = await wallet.signMessage({ message: challenge.payload.data.message });
      const verified = await call('auth/wallet/verify', { id: challengeId, signature }, flow);
      if (verified.response.status !== 200) throw new Error(`wallet_verify_failed_${verified.payload.error?.code || 'unknown'}`);
      const cookie = verified.response.headers.getSetCookie().map(value => value.split(';')[0]).join('; ');
      accounts.push({ id: verified.payload.data.id, cookie, challengeId });
      const state = await call('state', undefined, cookie);
      if (state.response.status !== 200) throw new Error('private_account_read_failed');
      const changed = await call('profile', { ...state.payload.data.profile, displayName: `Fictional database check ${index}`, contact: `${marker}-${index}` }, cookie);
      if (changed.response.status !== 200) throw new Error('private_profile_write_failed');
      const replay = await call('auth/wallet/verify', { id: challengeId, signature }, flow);
      if (replay.response.status !== 403) throw new Error('signature_replay_not_denied');
    }
    if (accounts[0].id === accounts[1].id) throw new Error('account_isolation_failed');
    const reviewedTask = { intentId: randomUUID(), candidateKey: `0x${'ab'.repeat(32)}` };
    const queued = await call('proposals', reviewedTask, accounts[0].cookie);
    if (queued.response.status !== 202 || queued.payload.data.status !== 'queued') throw new Error('durable_enqueue_failed');
    const duplicate = await call('proposals', reviewedTask, accounts[0].cookie);
    if (duplicate.response.status !== 202 || duplicate.payload.data.taskId !== queued.payload.data.taskId || !duplicate.payload.data.deduplicated) throw new Error('task_deduplication_failed');
    const foreign = await call(`agent-tasks/${queued.payload.data.taskId}`, undefined, accounts[1].cookie);
    if (foreign.response.status !== 404) throw new Error('task_tenant_isolation_failed');
    await closeStore();
    for (let index = 0; index < accounts.length; index++) {
      const state = await call('state', undefined, accounts[index].cookie);
      if (state.response.status !== 200 || state.payload.data.profile.contact !== `${marker}-${index}`
        || JSON.stringify(state.payload).includes(`${marker}-${1 - index}`)) throw new Error('reconnect_or_tenant_isolation_failed');
    }
    const persistedTask = await call(`agent-tasks/${queued.payload.data.taskId}`, undefined, accounts[0].cookie);
    if (persistedTask.response.status !== 200 || persistedTask.payload.data.status !== 'queued') throw new Error('queued_task_reconnect_failed');
    try {
      await atomic(async () => { await db().prepare('INSERT INTO rate_limits VALUES(?,?,?)').run(marker, 1, Date.now()); throw new Error('intentional_rollback'); });
    } catch (error) { if (!(error instanceof Error) || error.message !== 'intentional_rollback') throw error; }
    if (await db().prepare('SELECT bucket FROM rate_limits WHERE bucket=?').get(marker)) throw new Error('rollback_failed');
    const anonymous = await call('state'); if (anonymous.response.status !== 401) throw new Error('anonymous_access_not_denied');
    console.log(JSON.stringify({ checkedAt: new Date().toISOString(), provider: 'postgres', role: 'meeti_runtime',
      accounts: 2, genuineWalletSignatures: 2, replayDenied: 2, privateProfileReadWrite: true, poolReconnectPersistence: true,
      tenantIsolation: true, anonymousDenied: true, transactionRollback: true, taskEnqueueAndDedupe: true,
      taskPrivateReadAndReconnect: true, modelCalls: 0, chainWrites: 0 }));
  } finally {
    try {
      await atomic(async () => {
        for (const account of accounts) await db().prepare('DELETE FROM users WHERE id=?').run(account.id);
        for (const id of challengeIds) await db().prepare('DELETE FROM wallet_auth_challenges WHERE id=?').run(id);
        await db().prepare('DELETE FROM rate_limits WHERE bucket=?').run(marker);
      });
    } finally { globalThis.fetch = originalFetch; if (originalQueue === undefined) delete process.env.AGENT_TASK_QUEUE_ENABLED; else process.env.AGENT_TASK_QUEUE_ENABLED = originalQueue; await closeStore(); }
  }
}
main().catch(error => { console.error(error instanceof Error && /^[a-z_0-9]+$/i.test(error.message) ? error.message : 'postgres_verification_failed'); process.exitCode = 1; });

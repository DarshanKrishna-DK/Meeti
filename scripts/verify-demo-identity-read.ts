import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { qualificationRecord } from '../packages/server/qualification-context';
import { assertCurrentPublicIdentityBindings } from '../packages/server/qualifications';
import { closeDatabase } from '../packages/server/db';

const qualificationId = '7c58a16c-325e-4de4-8402-fd68fe63d958';
const databasePath = resolve('.local-data/demo-core-flow.sqlite');
const outputPath = 'artifacts/demo-identity-read-verification.json';
const allowedMethods = new Set(['eth_chainId', 'eth_blockNumber', 'eth_getBlockByNumber', 'eth_getBlockByHash', 'eth_call', 'eth_getCode', 'eth_getStorageAt', 'eth_getBalance', 'eth_getTransactionCount', 'eth_estimateGas', 'eth_gasPrice', 'eth_maxPriorityFeePerGas', 'eth_feeHistory', 'eth_getTransactionReceipt', 'eth_getTransactionByHash', 'eth_getLogs', 'net_version']);
function requireValue(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }

async function main() {
  requireValue(resolve(process.env.DATABASE_PATH || '') === databasePath, 'exact_demo_database_path_required');
  const endpoints = new Set([process.env.ENS_SEPOLIA_AUTH_RPC_URL, process.env.ENS_SEPOLIA_RPC_URL].filter((value): value is string => Boolean(value)).map(value => new URL(value).href));
  requireValue(endpoints.size > 0 && [...endpoints].every(value => new URL(value).protocol === 'https:'), 'configured_https_read_rpc_required');
  const originalFetch = globalThis.fetch;
  const counts: Record<string, number> = {}, statuses: Record<string, number> = {};
  let requests = 0, blockedRequests = 0;
  // Counts contain fixed method names only. URLs, request parameters, headers, bodies and error strings are never recorded.
  globalThis.fetch = async (input, init) => {
    const inspection = input instanceof Request ? input.clone() : new Request(input, init);
    if (!endpoints.has(inspection.url) || inspection.method !== 'POST') { blockedRequests++; throw new Error('identity_read_check_forbids_non_rpc_request'); }
    let body: unknown;
    try { body = JSON.parse(await inspection.text()); } catch { blockedRequests++; throw new Error('identity_read_check_invalid_rpc_envelope'); }
    const batch = Array.isArray(body) ? body : [body];
    if (batch.length < 1 || batch.length > 4 || batch.some(value => !value || typeof value !== 'object' || !allowedMethods.has(String((value as { method?: unknown }).method)))) { blockedRequests++; throw new Error('identity_read_check_forbids_non_read_rpc'); }
    requests++;
    for (const value of batch) { const method = (value as { method: string }).method; counts[method] = (counts[method] || 0) + 1; }
    const response = await originalFetch(input, init);
    statuses[String(response.status)] = (statuses[String(response.status)] || 0) + 1;
    return response;
  };
  const started = performance.now();
  let stage: 'load_record' | 'current_public_identity_verification' | 'record_unchanged_check' = 'load_record';
  try {
    const stored = qualificationRecord(qualificationId);
    requireValue(stored?.row.id === qualificationId && stored.value.publicIdentities && stored.row.left_user !== stored.row.right_user, 'existing_two_owner_qualification_bindings_required');
    requireValue([stored.value.publicIdentities.left, stored.value.publicIdentities.right].every(value => value.context === 'valid' && value.association === 'verified'), 'expected_demo_associations_not_recorded');
    stage = 'current_public_identity_verification';
    const result = await assertCurrentPublicIdentityBindings(stored.row.left_user, stored.row.right_user, stored.value.publicIdentities);
    requireValue([result.left, result.right].every(value => value.context === 'valid' && value.association === 'verified' && /^[a-f0-9]{64}$/.test(value.digest)), 'both_current_associations_not_verified');
    stage = 'record_unchanged_check';
    const after = qualificationRecord(qualificationId);
    requireValue(after && after.row.version === stored.row.version && after.row.state === stored.row.state && after.row.data === stored.row.data, 'qualification_record_changed_during_read_check');
    const report = { checkedAt: new Date().toISOString(), qualificationId, outcome: 'current_public_identity_bindings_verified',
      bindings: { left: { context: result.left.context, association: result.left.association, digest: result.left.digest }, right: { context: result.right.context, association: result.right.association, digest: result.right.digest } },
      elapsedMs: Math.round(performance.now() - started), rpcRequests: requests, rpcMethodCounts: counts, httpStatusCounts: statuses, blockedRequests,
      qualificationRecordUnchanged: true, modelCalls: 0, signatures: 0, transactionWrites: 0, humanVerified: false, authorityVerified: false };
    mkdirSync('artifacts', { recursive: true }); writeFileSync(outputPath, JSON.stringify(report, null, 2)); console.log(JSON.stringify({ path: outputPath, ...report }));
  } catch {
    const report = { checkedAt: new Date().toISOString(), qualificationId, outcome: 'current_identity_verification_failed', stage, elapsedMs: Math.round(performance.now() - started), rpcRequests: requests, rpcMethodCounts: counts, httpStatusCounts: statuses, blockedRequests, modelCalls: 0, signatures: 0, transactionWrites: 0 };
    mkdirSync('artifacts', { recursive: true }); writeFileSync(outputPath, JSON.stringify(report, null, 2)); console.error(JSON.stringify({ path: outputPath, ...report })); process.exitCode = 1;
  } finally { globalThis.fetch = originalFetch; closeDatabase(); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main().catch(() => { console.error('identity_read_verification_startup_failed_no_private_details'); process.exitCode = 1; });

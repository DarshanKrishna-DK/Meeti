import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createPublicClient, encodeFunctionData, keccak256, type Address, type Hex } from 'viem';
import { sepolia } from 'viem/chains';
import { createEnsAuthorityProvider, dnsEncode, POLICY_KEY } from '../packages/ens';
import { resolverAbi } from '../packages/ens/abi';
import { boundedFundingEnvelope } from '../packages/ens/funding-envelope';
import type { buildNamespaceRepair } from '../packages/ens/namespace-repair';
import { createEnsReadTransport } from '../packages/ens/rpc-transport';
import { isForbiddenTextRoleRevert } from '../packages/ens/revert-verification';

type Repair = Awaited<ReturnType<typeof buildNamespaceRepair>>;
function requireValue(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error(reason); }
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
async function main() {
  requireValue(!existsSync('.local-data/demo-permission-cycle-approval.json'), 'approved_permission_cycle_is_immutable');
  const repairRaw = readFileSync('artifacts/namespace-repair-review.json', 'utf8'), repairReviewSha256 = createHash('sha256').update(repairRaw).digest('hex');
  const reviewed = JSON.parse(repairRaw) as Repair & { issuer: Address; chainId: number; originalReviewSha256: string; operations: { id: string }[]; funding: { id: string }[] };
  const execution = JSON.parse(readFileSync('artifacts/namespace-repair-execution.json', 'utf8')) as { reviewSha256: string; chainId: number; transactions: { id: string; status: string; hash: Hex }[] };
  const expectedSequence = [...reviewed.funding, ...reviewed.operations].map(op => op.id);
  requireValue(reviewed.chainId === 11155111 && execution.chainId === 11155111 && execution.reviewSha256 === repairReviewSha256 && reviewed.recipients.length === 2 && execution.transactions.length === expectedSequence.length && execution.transactions.every((tx, i) => tx.status === 'confirmed_readback' && tx.id === expectedSequence[i]), 'complete_repair_confirmations_required');
  const publicDelegates = JSON.parse(readFileSync('artifacts/demo-delegates.json', 'utf8')) as { version: number; fictional: boolean; humanVerified: boolean; delegates: { label: string; owner: Address; address: Address }[] };
  requireValue(publicDelegates.version === 1 && publicDelegates.fictional === true && publicDelegates.humanVerified === false, 'unexpected_public_delegate_manifest');
  const issuer = reviewed.issuer;
  requireValue(same(issuer, '0x9253705482a44e6A7378163e57cc791AE6213ed5'), 'unexpected_cycle_issuer');
  const rpcUrl = process.env.ENS_SEPOLIA_AUTH_RPC_URL || process.env.ENS_SEPOLIA_RPC_URL;
  requireValue(rpcUrl, 'ens_rpc_not_configured');
  const client = createPublicClient({ chain: sepolia, transport: createEnsReadTransport(rpcUrl) });
  const ens = createEnsAuthorityProvider({ rpcUrl });
  try {
    const [chainId, head] = await Promise.all([client.getChainId(), client.getBlock()]);
    requireValue(chainId === 11155111 && Math.abs(Date.now() / 1000 - Number(head.timestamp)) < 90, 'wrong_chain_or_stale_head');
    const operations = [], authorityEvidence = [], forbiddenSimulations = [], balances = [];
    const caps: Record<string, string> = {};
    for (const r of reviewed.recipients) {
      requireValue(r.label === 'demo-seeker' || r.label === 'demo-recruiter', 'unexpected_fictional_label');
      requireValue(r.policyVersion === 2 && !same(r.delegate, issuer) && !same(r.delegate, r.owner) && publicDelegates.delegates.some(entry => entry.label === r.label && same(entry.owner, r.owner) && same(entry.address, r.delegate)), 'repaired_independent_delegate_binding_required');
      const authority = await ens.checkAuthority({ ensName: r.agentName, owner: r.owner, delegate: r.delegate, action: 'negotiate', policyVersion: '2', policyDigest: r.policyDigest });
      requireValue(authority.allowed && authority.evidence && same(authority.evidence.resolver, r.resolver), 'current_agent_delegation_not_verified');
      authorityEvidence.push({ ensName: r.agentName, owner: r.owner, delegate: r.delegate, policyVersion: 2, reason: authority.reason, blockNumber: authority.blockNumber, policyDigest: authority.policyDigest, expiresAt: authority.expiresAt, resolver: authority.evidence.resolver });
      const publicPolicyData = encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [dnsEncode(r.agentName), POLICY_KEY, JSON.stringify(r.proposedPublicPolicy)] });
      let deniedByRevert = false;
      try { await client.call({ account: r.delegate, to: r.resolver, data: publicPolicyData, value: 0n }); }
      catch (error) { if (!isForbiddenTextRoleRevert(error, r.delegate, POLICY_KEY)) throw new Error('forbidden_policy_call_not_exact_eac_role_revert'); deniedByRevert = true; }
      requireValue(deniedByRevert, 'delegate_can_unexpectedly_write_public_policy');
      forbiddenSimulations.push({ ensName: r.agentName, from: r.delegate, to: r.resolver, data: publicPolicyData, value: '0x0', method: 'eth_call', actualEvmRevert: true, exactEacResourceAccountAndTextRole: true, transactionIncluded: false, checkedAt: new Date().toISOString() });
      const status = await ens.prepareTransaction({ operation: 'update-status', ensName: r.agentName, owner: r.owner, delegate: r.delegate, value: 'Meeti fictional test: status update before permission revocation.' });
      const revoke = await ens.prepareTransaction({ operation: 'revoke', ensName: r.agentName, owner: r.owner, delegate: r.delegate });
      const restore = await ens.prepareTransaction({ operation: 'grant', ensName: r.agentName, owner: r.owner, delegate: r.delegate });
      for (const [suffix, prepared, budget] of [['status', status, 500000000000000n], ['revoke', revoke, 750000000000000n], ['restore', restore, 750000000000000n]] as const) {
        const id = `${r.label}-${suffix}`, dependencies = suffix === 'status' ? [] : [`${r.label}-${suffix === 'revoke' ? 'status' : 'revoke'}`];
        requireValue(same(prepared.to, r.resolver) && same(prepared.from, suffix === 'status' ? r.delegate : r.owner), 'cycle_sender_or_resolver_mismatch');
        const estimatedGas = await client.estimateGas({ account: prepared.from, to: prepared.to, data: prepared.data, value: 0n, maxFeePerGas: 500000000n, maxPriorityFeePerGas: 10000000n });
        const current = await client.getBlock();
        const envelope = boundedFundingEnvelope({ estimatedGas, maxGasCostWei: budget, reviewedMaxFeePerGas: 500000000n, reviewedMaxPriorityFeePerGas: 10000000n, baseFeePerGas: current.baseFeePerGas ?? 0n });
        operations.push({ id, dependsOn: dependencies, ensName: r.agentName, owner: r.owner, delegate: r.delegate, policyVersion: 2, policyDigest: r.policyDigest, operation: prepared.operation, chainId: 11155111,
          from: prepared.from, to: prepared.to, data: prepared.data, value: '0x0', maxGasCostWei: budget.toString(), maxFeePerGas: '500000000', maxPriorityFeePerGas: '10000000',
          currentStateEstimate: { estimatedGas: estimatedGas.toString(), ...Object.fromEntries(Object.entries(envelope).map(([key, value]) => [key, value.toString()])) },
          simulation: suffix === 'restore' ? 'currently_idempotent_only_requires_reestimate_after_revocation' : 'simulated_current_state_requires_fresh_preflight_after_dependencies',
          checkpointAfter: suffix === 'revoke' ? ['Fresh current ENS authority must deny negotiate, publish and message.', 'Delegate status update must revert in eth_call.', 'Do not run model actions or release private data while authority is revoked.'] : [] });
      }
      caps[r.delegate] = '500000000000000';
      caps[r.owner] = '1500000000000000';
    }
    for (const address of Object.keys(caps)) balances.push({ address, balanceWei: (await client.getBalance({ address: address as Address })).toString(), requiredMaxGasWei: caps[address] });
    const report = { reviewOnly: true, approvalState: 'not_authorized_for_signature_or_broadcast', chainId: 11155111, checkedAt: new Date().toISOString(), reviewExpiresAt: new Date(Date.now() + 20 * 60_000).toISOString(), initialBlock: head.number.toString(), initialBlockHash: head.hash,
      fictional: true, humanVerified: false, originalReviewSha256: reviewed.originalReviewSha256, repairReviewSha256, repairConfirmedTransactionHashes: execution.transactions.map(tx => tx.hash), authorityEvidence, forbiddenSimulations, operations, caps, balances,
      requirements: ['Explicit bounded approval before any status write, revoke or restore signature.', 'Preserve exact sender, resolver, calldata and zero value. Fresh gas estimates may change gas/fee envelopes only within each original maximum gas-cost budget and aggregate wallet cap.', 'Encrypted signed journal before broadcast, canonical receipt and live state read-back before each dependency.', 'After each revoke, record actual current protected-action denial before restoring. After restore, record actual live authority recovery.', 'Restore simulation before revocation is idempotent and cannot establish its later gas requirement. Reprepare and estimate after the confirmed revoke.', 'Forbidden policy calls are read-only negative tests. No forbidden policy transaction is part of this review.'],
      signaturesRequested: 0, transactionsSubmitted: 0 };
    mkdirSync('artifacts', { recursive: true }); const path = 'artifacts/demo-permission-cycle-review.json'; writeFileSync(path, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ path, checkedAt: report.checkedAt, operations: operations.length, forbiddenEvmReverts: forbiddenSimulations.length, caps, allCurrentlyFunded: balances.every(row => BigInt(row.balanceWei) >= BigInt(row.requiredMaxGasWei)), reviewDigest: keccak256(new TextEncoder().encode(JSON.stringify(report))), signatures: 0, broadcasts: 0 }));
  } finally { await ens.disconnect(); const transport = client.transport as { getRpcClient?: () => Promise<{ close(): void }> }; try { if (transport.getRpcClient) (await transport.getRpcClient()).close(); } catch { /* No endpoint details in cleanup output. */ } }
}
await main().catch(error => { console.error(error instanceof Error && /^[a-z][a-z0-9_]+$/.test(error.message) ? error.message : 'permission_cycle_review_read_failed_no_secret_details_logged'); process.exitCode = 1; });

import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { createPublicClient, decodeFunctionResult, encodeFunctionData, keccak256, namehash, type Address, type Hex } from 'viem';
import { sepolia } from 'viem/chains';
import { decrypt, sign } from '../packages/server/crypto';
import { ALL_ROLES, createEnsAuthorityProvider, dnsEncode, ENS_DEPLOYMENT, POLICY_KEY, type EnsOperation } from '../packages/ens';
import { factoryAbi, registryAbi, resolverAbi, textProfileAbi } from '../packages/ens/abi';
import type { buildNamespaceDemoPlan } from '../packages/ens/namespace-plan';
import { createEnsReadTransport } from '../packages/ens/rpc-transport';
import { boundedFundingEnvelope } from '../packages/ens/funding-envelope';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function requireValue(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error(reason); }
type Plan = Awaited<ReturnType<typeof buildNamespaceDemoPlan>>;
type Entry = { id: string; hash: Hex; raw: Hex; from: Address; to: Address; data: Hex; valueWei: string; maxGasCostWei: string; confirmed?: { blockNumber: string; blockHash: Hex } };
async function main() {
  const reviewRaw = readFileSync('artifacts/namespace-demo-review.json', 'utf8'), reviewSha256 = digest(reviewRaw);
  requireValue(process.argv.includes(`--review-sha256=${reviewSha256}`), 'exact_review_hash_required');
  const review = JSON.parse(reviewRaw) as { chainId: number; parent: { issuer: Address; subregistry: Address; expiresAt: string }; plan: Plan; funding: { id: string; from: Address; to: Address; valueWei: string; data: Hex; maxGasCostWei: string }[] };
  const approvalRaw = readFileSync('.local-data/namespace-demo-approval.json', 'utf8');
  const approval = JSON.parse(approvalRaw) as { authorized: boolean; reviewSha256: string; chainId: number; issuerMaxGasAndTransferValueWei: string; recipientMaxGasCostWei: string };
  requireValue(approval.authorized === true && approval.reviewSha256 === reviewSha256 && approval.chainId === 11155111 && review.chainId === 11155111, 'unchanged_original_approval_required');
  requireValue(approval.issuerMaxGasAndTransferValueWei === '9871000000000000' && approval.recipientMaxGasCostWei === '2450000000000000', 'original_caps_mismatch');
  const journalPath = '.local-data/namespace-demo-journal.enc', journalRaw = readFileSync(journalPath, 'utf8');
  const journal = decrypt<{ reviewSha256: string; chainId: number; entries: Entry[] }>(journalRaw, `meeti-namespace-demo-journal-v1:${reviewSha256}`);
  requireValue(journal.reviewSha256 === reviewSha256 && journal.chainId === 11155111, 'journal_scope_mismatch');
  requireValue(journal.entries.every(entry => entry.confirmed), 'unreconciled_signed_transactions_recover_receipts_first');
  const issuer = review.parent.issuer, sequence = [...review.funding, ...review.plan.operations];
  requireValue(journal.entries.every((entry, index) => entry.id === sequence[index]?.id) && journal.entries.length <= sequence.length, 'journal_is_not_original_operation_prefix');
  const rpcUrl = process.env.ENS_SEPOLIA_AUTH_RPC_URL || process.env.ENS_SEPOLIA_RPC_URL;
  requireValue(rpcUrl, 'ens_rpc_not_configured');
  const client = createPublicClient({ chain: sepolia, transport: createEnsReadTransport(rpcUrl) });
  const ens = createEnsAuthorityProvider({ rpcUrl });
  try {
    const [chainId, head] = await Promise.all([client.getChainId(), client.getBlock()]);
    requireValue(chainId === 11155111 && Math.abs(Date.now() / 1000 - Number(head.timestamp)) < 90, 'wrong_chain_or_stale_head');
    const canonical = new Map<string, Hex>(), reserved: Record<string, bigint> = {};
    for (const entry of journal.entries) {
      const approved = sequence.find(op => op.id === entry.id)!;
      const expectedValue = 'valueWei' in approved ? BigInt(approved.valueWei) : 0n;
      requireValue(entry.hash === keccak256(entry.raw) && same(entry.from, approved.from) && same(entry.to, approved.to) && same(entry.data, approved.data) && BigInt(entry.valueWei) === expectedValue, 'journal_exact_transaction_mismatch');
      const [receipt, transaction] = await Promise.all([client.getTransactionReceipt({ hash: entry.hash }), client.getTransaction({ hash: entry.hash })]);
      requireValue(receipt.status === 'success' && head.number >= receipt.blockNumber + 1n && receipt.blockHash === entry.confirmed!.blockHash && receipt.blockNumber.toString() === entry.confirmed!.blockNumber, 'receipt_not_successful_canonical_depth');
      const blockKey = receipt.blockNumber.toString();
      if (!canonical.has(blockKey)) canonical.set(blockKey, (await client.getBlock({ blockNumber: receipt.blockNumber })).hash);
      requireValue(canonical.get(blockKey) === receipt.blockHash && same(transaction.from, approved.from) && transaction.to && same(transaction.to, approved.to) && same(transaction.input, approved.data) && transaction.value === expectedValue, 'receipt_or_calldata_changed');
      requireValue(transaction.maxFeePerGas !== undefined && transaction.gas * transaction.maxFeePerGas === BigInt(entry.maxGasCostWei) && BigInt(entry.maxGasCostWei) <= BigInt(approved.maxGasCostWei), 'signed_fee_budget_mismatch');
      reserved[entry.from] = (reserved[entry.from] ?? 0n) + BigInt(entry.maxGasCostWei) + expectedValue;
    }
    for (const [owner, amount] of Object.entries(reserved)) requireValue(amount <= BigInt(same(owner, issuer) ? approval.issuerMaxGasAndTransferValueWei : approval.recipientMaxGasCostWei), 'aggregate_cap_exceeded');
    const done = (id: string) => journal.entries.some(entry => entry.id === id);
    const parent = await ens.inspectProjectParent({ parentName: review.plan.parent, issuer });
    requireValue(parent.nextStep === 'ready' && same(parent.subregistry, review.parent.subregistry), 'project_parent_control_changed');
    const verifyProxy = async (address: Address, implementation: Address, owner: Address) => {
      const actual = await client.readContract({ address: ENS_DEPLOYMENT.factory, abi: factoryAbi, functionName: 'verifyContract', args: [address] });
      requireValue(same(actual, implementation), 'completed_proxy_implementation_changed');
      const abi = same(implementation, ENS_DEPLOYMENT.registryImplementation) ? registryAbi : resolverAbi;
      const [roles, count] = await Promise.all([client.readContract({ address, abi, functionName: 'roles', args: [0n, owner] }), client.readContract({ address, abi, functionName: 'roleCount', args: [0n] })]);
      requireValue(roles === ALL_ROLES && count === ALL_ROLES, 'completed_proxy_owner_changed');
    };
    if (done('branch-register')) {
      const branch = await ens.inspectProjectParent({ parentName: review.plan.branch, issuer });
      if (done('branch-attach')) requireValue(branch.nextStep === 'ready' && same(branch.subregistry, review.plan.usersRegistry), 'completed_branch_attachment_changed');
    }
    if (done('branch-registry')) await verifyProxy(review.plan.usersRegistry, ENS_DEPLOYMENT.registryImplementation, issuer);
    for (const r of review.plan.recipients) {
      if (done(`${r.label}-registry`)) await verifyProxy(r.recipientRegistry, ENS_DEPLOYMENT.registryImplementation, r.owner);
      if (done(`${r.label}-issue`)) {
        const user = await ens.inspectProjectParent({ parentName: r.userName, issuer: r.owner });
        requireValue(user.nextStep === 'ready' && same(user.subregistry, r.recipientRegistry), 'completed_recipient_attachment_changed');
      }
      if (done(`${r.label}-agent`)) {
        const state = await client.readContract({ address: r.recipientRegistry, abi: registryAbi, functionName: 'getState', args: [BigInt(keccak256(new TextEncoder().encode('networking')))] });
        requireValue(same(state.latestOwner, r.owner) && state.expiry === BigInt(Math.floor(Date.parse(review.parent.expiresAt) / 1000)), 'completed_agent_owner_or_expiry_changed');
      }
      if (done(`${r.label}-resolver`)) await verifyProxy(r.resolver, ENS_DEPLOYMENT.resolverImplementation, r.owner);
      if (done(`${r.label}-attach`)) requireValue(same(await client.readContract({ address: r.recipientRegistry, abi: registryAbi, functionName: 'getResolver', args: ['networking'] }), r.resolver), 'completed_resolver_attachment_changed');
      if (done(`${r.label}-policy`)) {
        const profile = encodeFunctionData({ abi: textProfileAbi, functionName: 'text', args: [namehash(r.agentName), POLICY_KEY] });
        const result = await client.readContract({ address: r.resolver, abi: resolverAbi, functionName: 'resolve', args: [dnsEncode(r.agentName), profile] });
        requireValue(decodeFunctionResult({ abi: textProfileAbi, functionName: 'text', data: result }) === JSON.stringify(r.proposedPublicPolicy), 'completed_public_policy_changed');
      }
      if (done(`${r.label}-grant`)) requireValue((await ens.checkAuthority({ ensName: r.agentName, owner: r.owner, delegate: r.delegate, action: 'negotiate', policyVersion: '1', policyDigest: r.policyDigest })).allowed, 'completed_delegation_no_longer_authorized');
    }
    const next = review.plan.operations.find(op => !done(op.id));
    let nextEnvelope: ReturnType<typeof boundedFundingEnvelope> | undefined;
    requireValue(!review.funding.some(op => !done(op.id)), 'funding_not_confirmed');
    if (next) {
      requireValue(next.dependsOn.every(done), 'next_operation_dependencies_not_confirmed');
      let prepared: { from: Address; to: Address; data: Hex };
      const expiry = Math.floor(Date.parse(review.parent.expiresAt) / 1000), r = review.plan.recipients.find(value => next.id.startsWith(`${value.label}-`));
      if (next.id === 'branch-register') prepared = await ens.prepareProjectSubname({ parentName: review.plan.parent, label: 'users', issuer, recipient: issuer, expiresAt: expiry });
      else if (next.id === 'branch-registry' || next.id === 'branch-attach') prepared = await ens.prepareTransaction({ ensName: `candidate.${review.plan.branch}`, owner: issuer, delegate: ENS_DEPLOYMENT.factory, operation: next.id === 'branch-registry' ? 'deploy-registry' : 'set-subregistry' });
      else {
        requireValue(r, 'next_recipient_missing');
        if (next.id.endsWith('-registry')) {
          const result = await ens.prepareProjectRecipientRegistry({ parentName: review.plan.branch, label: r.label, issuer, recipient: r.owner });
          requireValue(result.needed, 'next_registry_already_exists_reconcile_first'); prepared = result;
        } else if (next.id.endsWith('-issue')) prepared = await ens.prepareProjectSubname({ parentName: review.plan.branch, label: r.label, issuer, recipient: r.owner, recipientSubregistry: r.recipientRegistry, expiresAt: expiry });
        else {
          const suffix = next.id.slice(r.label.length + 1), mapping: Record<string, EnsOperation> = { agent: 'create-subname', resolver: 'deploy-resolver', attach: 'set-resolver', policy: 'set-policy', grant: 'grant' };
          requireValue(mapping[suffix], 'unknown_next_operation');
          prepared = await ens.prepareTransaction({ ensName: r.agentName, owner: r.owner, delegate: r.delegate, operation: mapping[suffix], expiresAt: expiry, ...(suffix === 'policy' ? { value: JSON.stringify(r.proposedPublicPolicy) } : {}) });
        }
      }
      requireValue(same(prepared.from, next.from) && same(prepared.to, next.to) && same(prepared.data, next.data), 'next_operation_changed_from_original_approval');
      const gas = await client.estimateGas({ account: next.from, to: next.to, data: next.data, value: 0n, maxFeePerGas: BigInt(next.maxFeePerGas), maxPriorityFeePerGas: BigInt(next.maxPriorityFeePerGas) });
      const feeHead = await client.getBlock();
      nextEnvelope = boundedFundingEnvelope({ estimatedGas: gas, maxGasCostWei: BigInt(next.maxGasCostWei), reviewedMaxFeePerGas: BigInt(next.maxFeePerGas), reviewedMaxPriorityFeePerGas: BigInt(next.maxPriorityFeePerGas), baseFeePerGas: feeHead.baseFeePerGas ?? 0n });
      requireValue(await client.getBalance({ address: next.from }) >= BigInt(next.maxGasCostWei), 'next_operation_wallet_underfunded');
    }
    const finalHead = await client.getBlock();
    requireValue(Math.abs(Date.now() / 1000 - Number(finalHead.timestamp)) < 90, 'renewal_head_stale');
    if (nextEnvelope) requireValue((finalHead.baseFeePerGas ?? 0n) + nextEnvelope.maxPriorityFeePerGas <= nextEnvelope.maxFeePerGas, 'next_operation_fee_cap_cannot_fit_current_head');
    requireValue(readFileSync(journalPath, 'utf8') === journalRaw && readFileSync('artifacts/namespace-demo-review.json', 'utf8') === reviewRaw && readFileSync('.local-data/namespace-demo-approval.json', 'utf8') === approvalRaw, 'review_approval_or_journal_changed_during_renewal');
    const payload = { version: 1, kind: 'meeti-namespace-freshness-renewal', reviewSha256, approvalSha256: digest(approvalRaw), journalSha256: digest(journalRaw), chainId: 11155111, checkedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 20 * 60_000).toISOString(), blockNumber: finalHead.number.toString(), blockHash: finalHead.hash,
      confirmed: journal.entries.map(entry => ({ id: entry.id, hash: entry.hash, blockHash: entry.confirmed!.blockHash })), nextOperationId: next?.id ?? null,
      nextEnvelope: nextEnvelope ? Object.fromEntries(Object.entries(nextEnvelope).map(([key, value]) => [key, value.toString()])) : null,
      issuerMaxGasAndTransferValueWei: approval.issuerMaxGasAndTransferValueWei, recipientMaxGasCostWei: approval.recipientMaxGasCostWei,
      reservedWei: Object.fromEntries(Object.entries(reserved).map(([owner, amount]) => [owner, amount.toString()])), scopeChanged: false, signaturesRequested: 0, transactionsSubmitted: 0 };
    const manifest = { payload, mac: sign(JSON.stringify(payload)) };
    mkdirSync('.local-data', { recursive: true }); const path = '.local-data/namespace-demo-renewal.json';
    writeFileSync(`${path}.tmp`, JSON.stringify(manifest, null, 2), { mode: 0o600 }); renameSync(`${path}.tmp`, path);
    console.log(JSON.stringify({ path, reviewSha256, checkedAt: payload.checkedAt, validUntil: payload.validUntil, confirmed: payload.confirmed.length, nextOperationId: payload.nextOperationId, scopeChanged: false, signatures: 0, broadcasts: 0 }));
  } finally { await ens.disconnect(); const transport = client.transport as { getRpcClient?: () => Promise<{ close(): void }> }; try { if (transport.getRpcClient) (await transport.getRpcClient()).close(); } catch { /* Endpoint details remain private. */ } }
}
await main().catch(error => { console.error(error instanceof Error && /^[a-z][a-z0-9_]+$/.test(error.message) ? error.message : 'namespace_renewal_read_failed_no_secret_details_logged'); process.exitCode = 1; });

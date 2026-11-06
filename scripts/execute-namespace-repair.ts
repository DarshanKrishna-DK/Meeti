import { createHash, timingSafeEqual } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, decodeFunctionResult, encodeFunctionData, http, keccak256, namehash, parseTransaction, recoverTransactionAddress, webSocket, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { decrypt, encrypt, sign } from '../packages/server/crypto';
import { ALL_ROLES, createEnsAuthorityProvider, dnsEncode, ENS_DEPLOYMENT, POLICY_KEY, STATUS_KEY, textResource, TEXT_ROLE } from '../packages/ens';
import { factoryAbi, registryAbi, resolverAbi, textProfileAbi } from '../packages/ens/abi';
import { boundedFundingEnvelope } from '../packages/ens/funding-envelope';
import type { buildNamespaceDemoPlan } from '../packages/ens/namespace-plan';
import { createEnsReadTransport } from '../packages/ens/rpc-transport';
import { isForbiddenTextRoleRevert } from '../packages/ens/revert-verification';

type Original = { parent: { issuer: Address; expiresAt: string }; plan: Awaited<ReturnType<typeof buildNamespaceDemoPlan>>; funding: Tx[] };
type Tx = { id: string; from: Address; to: Address; data: Hex; valueWei: string; chainId: number; gasLimit?: string; maxFeePerGas: string; maxPriorityFeePerGas: string; maxGasCostWei: string; dependsOn?: string[] };
type Recipient = Original['plan']['recipients'][number] & { policyVersion: 2 };
type Canonical = { hash: Hex; blockNumber: string; blockHash: Hex };
type Review = { reviewOnly: true; chainId: number; issuer: Address; reviewExpiresAt: string; originalReviewSha256: string;
  originalConfirmedDependencies: (Canonical & { id: string })[]; oldGrantReceipt: Canonical & { canonical: true; applicationAuthorityAllowed: false };
  recipients: Recipient[]; operations: (Tx & { adapterOperation?: 'revoke' | 'set-policy' | 'grant' })[]; funding: Tx[]; totalCaps: Record<string, string> };
type Approval = { authorized: boolean; reviewSha256: string; chainId: number; approvedAt: string; totalCaps: Record<string, string>; allowReadOnlyFreshnessRenewal?: boolean };
type Entry = { id: string; hash: Hex; raw: Hex; from: Address; to: Address; data: Hex; valueWei: string; maxGasCostWei: string;
  mined?: Canonical; confirmed?: Canonical & { readback: string } };
type Journal = { reviewSha256: string; chainId: number; entries: Entry[] };
const sha = (raw: string) => createHash('sha256').update(raw).digest('hex');
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function requireValue(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error(reason); }
function capMap(value: Record<string, string>) {
  requireValue(value && typeof value === 'object' && Object.entries(value).every(([key, amount]) => /^0x[0-9a-fA-F]{40}$/.test(key) && /^(0|[1-9][0-9]*)$/.test(amount)), 'invalid_repair_cap_map');
  return Object.entries(value).map(([address, amount]) => [address.toLowerCase(), amount]).sort(([a], [b]) => a.localeCompare(b));
}

/** Import-safe verification of a separate read-only proof. It never signs a transaction or renews scope. */
export function repairReviewFreshness(input: { reviewRaw: string; approvalRaw: string; journalRaw?: string; renewalRaw?: string; now?: number }) {
  const review = JSON.parse(input.reviewRaw) as Review, approval = JSON.parse(input.approvalRaw) as Approval, now = input.now ?? Date.now();
  requireValue(approval.authorized === true && approval.reviewSha256 === sha(input.reviewRaw) && review.chainId === 11155111 && approval.chainId === 11155111, 'repair_freshness_scope_mismatch');
  requireValue(JSON.stringify(capMap(review.totalCaps)) === JSON.stringify(capMap(approval.totalCaps)), 'repair_freshness_caps_mismatch');
  const deadline = Date.parse(review.reviewExpiresAt);
  requireValue(Number.isFinite(deadline) && Number.isFinite(now), 'repair_freshness_time_invalid');
  if (!input.renewalRaw) return { deadline, source: 'original-review' as const };
  requireValue(approval.allowReadOnlyFreshnessRenewal === true && typeof input.journalRaw === 'string', 'repair_freshness_renewal_not_enabled');
  const renewal = JSON.parse(input.renewalRaw) as { payload: { version: number; kind: string; reviewSha256: string; approvalSha256: string; journalSha256: string; chainId: number;
    checkedAt: string; validUntil: string; blockNumber: string; blockHash: Hex; totalCaps: Record<string, string>; scopeChanged: boolean; signaturesRequested: number; transactionsSubmitted: number }; mac: string };
  requireValue(renewal?.payload && /^[0-9a-f]{64}$/.test(renewal.mac), 'repair_freshness_mac_required');
  const expected = sign(JSON.stringify(renewal.payload));
  requireValue(timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(renewal.mac, 'hex')), 'repair_freshness_mac_invalid');
  const p = renewal.payload, checked = Date.parse(p.checkedAt), valid = Date.parse(p.validUntil);
  requireValue(p.version === 1 && p.kind === 'meeti-namespace-repair-freshness-v1' && p.chainId === 11155111 && p.scopeChanged === false && p.signaturesRequested === 0 && p.transactionsSubmitted === 0, 'repair_freshness_renewal_scope_invalid');
  requireValue(p.reviewSha256 === sha(input.reviewRaw) && p.approvalSha256 === sha(input.approvalRaw) && p.journalSha256 === sha(input.journalRaw!), 'repair_freshness_hash_mismatch');
  requireValue(JSON.stringify(capMap(p.totalCaps)) === JSON.stringify(capMap(approval.totalCaps)), 'repair_freshness_renewal_caps_mismatch');
  requireValue(Number.isFinite(checked) && checked >= Date.parse(approval.approvedAt) && checked <= now && valid > now && valid > checked && valid - checked <= 20 * 60_000, 'repair_freshness_renewal_time_invalid');
  requireValue(/^(0|[1-9][0-9]*)$/.test(p.blockNumber) && /^0x[0-9a-fA-F]{64}$/.test(p.blockHash), 'repair_freshness_block_invalid');
  return { deadline: valid, source: 'verified-renewal' as const, blockNumber: p.blockNumber, blockHash: p.blockHash };
}

async function main() {
  const arg = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  requireValue(process.argv.includes('--execute-reviewed'), 'explicit_repair_execution_flag_required');
  const reviewRaw = readFileSync('artifacts/namespace-repair-review.json', 'utf8'), reviewSha256 = sha(reviewRaw);
  requireValue(arg('review-sha256') === reviewSha256, 'exact_repair_review_hash_required');
  const approvalRaw = readFileSync('.local-data/namespace-repair-approval.json', 'utf8');
  const review = JSON.parse(reviewRaw) as Review, approval = JSON.parse(approvalRaw) as Approval;
  requireValue(review.reviewOnly === true && approval.authorized === true && approval.reviewSha256 === reviewSha256 && approval.chainId === 11155111 && review.chainId === 11155111, 'exact_repair_approval_required');
  requireValue(Number.isFinite(Date.parse(approval.approvedAt)) && Date.parse(approval.approvedAt) <= Date.now(), 'invalid_repair_approval_time');
  requireValue(JSON.stringify(capMap(review.totalCaps)) === JSON.stringify(capMap(approval.totalCaps)), 'repair_approved_caps_mismatch');
  requireValue(review.recipients.length === 2 && new Set(review.recipients.map(r => r.label)).size === 2 && review.recipients.every(r => ['demo-seeker', 'demo-recruiter'].includes(r.label)), 'unexpected_repair_recipients');
  const ids = ['demo-seeker-revoke-issuer', 'demo-seeker-policy-v2', 'demo-seeker-grant-delegate', 'demo-recruiter-registry', 'demo-recruiter-issue', 'demo-recruiter-agent', 'demo-recruiter-resolver', 'demo-recruiter-attach', 'demo-recruiter-policy-v2', 'demo-recruiter-grant-delegate'];
  requireValue(review.operations.length === ids.length && new Set(review.operations.map(tx => tx.id)).size === ids.length && review.operations.every(tx => ids.includes(tx.id)), 'unexpected_repair_operations');
  requireValue(review.operations[0].id === 'demo-seeker-revoke-issuer', 'issuer_revocation_must_be_first_repair_operation');
  requireValue(review.funding.length === 2 && new Set(review.funding.map(tx => tx.id)).size === 2, 'unexpected_repair_funding');
  const originalRaw = readFileSync('artifacts/namespace-demo-review.json', 'utf8'), original = JSON.parse(originalRaw) as Original;
  requireValue(sha(originalRaw) === review.originalReviewSha256 && same(review.issuer, original.parent.issuer) && same(review.issuer, '0x9253705482a44e6A7378163e57cc791AE6213ed5'), 'repair_original_scope_mismatch');
  const originalApproval = JSON.parse(readFileSync('.local-data/namespace-demo-approval.json', 'utf8')) as Approval;
  requireValue(originalApproval.authorized === true && originalApproval.reviewSha256 === review.originalReviewSha256 && originalApproval.chainId === 11155111, 'original_namespace_approval_required');
  const sequence = [...review.funding, ...review.operations];
  for (const tx of sequence) requireValue(tx.chainId === 11155111 && BigInt(tx.maxGasCostWei) > 0n && BigInt(tx.maxFeePerGas) === 500_000_000n && BigInt(tx.maxPriorityFeePerGas) === 10_000_000n, 'repair_fee_or_chain_scope_mismatch');
  const totals: Record<string, string> = {};
  for (const tx of sequence) totals[tx.from.toLowerCase()] = (BigInt(totals[tx.from.toLowerCase()] ?? '0') + BigInt(tx.maxGasCostWei) + BigInt(tx.valueWei)).toString();
  requireValue(JSON.stringify(capMap(totals)) === JSON.stringify(capMap(review.totalCaps)), 'repair_aggregate_review_arithmetic_mismatch');
  for (const r of review.recipients) {
    const old = original.plan.recipients.find(item => item.label === r.label);
    requireValue(old && same(old.owner, r.owner) && old.agentName === r.agentName && same(old.resolver, r.resolver) && same(old.recipientRegistry, r.recipientRegistry) && r.policyVersion === 2 && r.proposedPublicPolicy.version === '2' && !same(r.owner, r.delegate) && !same(review.issuer, r.delegate), 'repair_recipient_identity_mismatch');
    requireValue(same(r.proposedPublicPolicy.owner, r.owner) && same(r.proposedPublicPolicy.delegate, r.delegate) && r.proposedPublicPolicy.ensName === r.agentName && r.proposedPublicPolicy.digest === r.policyDigest, 'repair_policy_identity_mismatch');
    const funding = review.funding.find(tx => tx.id === `fund-${r.label}-delegate`);
    requireValue(funding && same(funding.from, review.issuer) && same(funding.to, r.delegate) && funding.data === '0x' && funding.valueWei === '1000000000000000' && funding.gasLimit === '21000' && funding.maxGasCostWei === '10500000000000', 'repair_funding_scope_mismatch');
  }
  for (const tx of review.operations.filter(op => !op.id.endsWith('-issuer') && !op.id.endsWith('-v2') && !op.id.endsWith('-delegate'))) {
    const old = original.plan.operations.find(op => op.id === tx.id);
    requireValue(old && same(old.from, tx.from) && same(old.to, tx.to) && same(old.data, tx.data) && tx.valueWei === '0' && old.maxGasCostWei === tx.maxGasCostWei, 'repair_original_structural_scope_changed');
  }
  requireValue(new Set(review.recipients.flatMap(r => [r.owner.toLowerCase(), r.delegate.toLowerCase()])).size === 4, 'repair_owners_and_delegates_must_be_distinct');
  const journalPath = '.local-data/namespace-repair-journal.enc', journalContext = `meeti-namespace-repair-journal-v1:${reviewSha256}`, lockPath = '.local-data/namespace-repair-execution.lock';
  mkdirSync('.local-data', { recursive: true }); const lock = openSync(lockPath, 'wx', 0o600);
  writeFileSync(lock, JSON.stringify({ pid: process.pid, reviewSha256 }));
  let client: ReturnType<typeof createPublicClient> | undefined, sender: ReturnType<typeof createPublicClient> | undefined, ens: ReturnType<typeof createEnsAuthorityProvider> | undefined;
  let activeOperationId = 'startup';
  try {
    const journalRaw = existsSync(journalPath) ? readFileSync(journalPath, 'utf8') : undefined;
    const journal = journalRaw ? decrypt<Journal>(journalRaw, journalContext) : { reviewSha256, chainId: 11155111, entries: [] };
    requireValue(journal.reviewSha256 === reviewSha256 && journal.chainId === 11155111 && journal.entries.length <= sequence.length && journal.entries.every((entry, index) => entry.id === sequence[index].id), 'repair_journal_scope_mismatch');
    const freshness = repairReviewFreshness({ reviewRaw, approvalRaw, journalRaw, ...(existsSync('.local-data/namespace-repair-renewal.json') ? { renewalRaw: readFileSync('.local-data/namespace-repair-renewal.json', 'utf8') } : {}) });
    const unexpired = () => requireValue(freshness.deadline > Date.now(), 'repair_review_expired_no_new_signature_or_broadcast');
    unexpired();
    const keyName = arg('issuer-key-env'); requireValue(keyName && /^[A-Z][A-Z0-9_]+$/.test(keyName), 'explicit_issuer_key_variable_required');
    const key = process.env[keyName]; requireValue(key && /^0x[0-9a-fA-F]{64}$/.test(key), 'issuer_key_not_configured');
    const issuerAccount = privateKeyToAccount(key as Hex); requireValue(same(issuerAccount.address, review.issuer), 'issuer_key_address_mismatch');
    const accounts = new Map<string, ReturnType<typeof privateKeyToAccount>>([[issuerAccount.address.toLowerCase(), issuerAccount]]);
    const owners = decrypt<{ version: number; wallets: { label: string; privateKey: Hex }[] }>(readFileSync('.local-data/demo-wallets.enc', 'utf8'), 'meeti-demo-wallets-v1');
    const delegates = decrypt<{ version: number; wallets: { label: string; owner: Address; privateKey: Hex }[] }>(readFileSync('.local-data/demo-delegates.enc', 'utf8'), 'meeti-demo-delegates-v1');
    requireValue(owners.version === 1 && delegates.version === 1 && owners.wallets.length === 2 && delegates.wallets.length === 2, 'invalid_demo_key_vaults');
    for (const r of review.recipients) {
      const owner = owners.wallets.find(wallet => wallet.label === r.label), delegate = delegates.wallets.find(wallet => wallet.label === r.label);
      requireValue(owner && delegate && same(delegate.owner, r.owner), 'repair_recipient_key_binding_missing');
      const ownerAccount = privateKeyToAccount(owner.privateKey), delegateAccount = privateKeyToAccount(delegate.privateKey);
      requireValue(same(ownerAccount.address, r.owner) && same(delegateAccount.address, r.delegate), 'repair_recipient_key_address_mismatch');
      accounts.set(ownerAccount.address.toLowerCase(), ownerAccount); accounts.set(delegateAccount.address.toLowerCase(), delegateAccount);
    }
    const rpcUrl = process.env.ENS_SEPOLIA_AUTH_RPC_URL || process.env.ENS_SEPOLIA_RPC_URL; requireValue(rpcUrl, 'ens_rpc_not_configured');
    client = createPublicClient({ chain: sepolia, transport: createEnsReadTransport(rpcUrl) });
    sender = createPublicClient({ chain: sepolia, transport: rpcUrl.startsWith('wss:') ? webSocket(rpcUrl, { retryCount: 0, reconnect: false, keepAlive: false }) : http(rpcUrl, { retryCount: 0 }) });
    ens = createEnsAuthorityProvider({ rpcUrl });
    const freshChain = async () => { const [chain, head] = await Promise.all([client!.getChainId(), client!.getBlock()]); requireValue(chain === 11155111 && Math.abs(Date.now() / 1000 - Number(head.timestamp)) < 90, 'wrong_chain_or_stale_head'); return head; };
    await freshChain();
    if (freshness.source === 'verified-renewal') requireValue((await client.getBlock({ blockNumber: BigInt(freshness.blockNumber) })).hash === freshness.blockHash, 'repair_renewal_block_not_canonical');
    function save() {
      writeFileSync(`${journalPath}.tmp`, encrypt(journal, journalContext), { mode: 0o600 }); renameSync(`${journalPath}.tmp`, journalPath);
      mkdirSync('artifacts', { recursive: true }); writeFileSync('artifacts/namespace-repair-execution.json', JSON.stringify({ reviewSha256, chainId: 11155111, checkedAt: new Date().toISOString(), transactions: journal.entries.map(({ id, hash, from, to, mined, confirmed }) => ({ id, hash, from, to, status: confirmed ? 'confirmed_readback' : mined ? 'mined_state_not_verified' : 'signed_pending_or_unknown', mined, confirmed })) }, null, 2));
    }
    async function canonical(hash: Hex, tx: Tx, expected?: Canonical) {
      const receipt = await client!.getTransactionReceipt({ hash }), actual = await client!.getTransaction({ hash }), head = await freshChain();
      requireValue(receipt.status === 'success' && same(actual.from, tx.from) && actual.to && same(actual.to, tx.to) && same(actual.input, tx.data) && actual.value === BigInt(tx.valueWei), 'repair_confirmed_transaction_mismatch');
      requireValue(head.number >= receipt.blockNumber + 1n && (await client!.getBlock({ blockNumber: receipt.blockNumber })).hash === receipt.blockHash, 'repair_canonical_two_confirmations_required');
      if (expected) requireValue(receipt.blockNumber.toString() === expected.blockNumber && receipt.blockHash === expected.blockHash, 'repair_dependency_reorganized');
      return { hash, blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash };
    }
    async function originalDependency(id: string, proof: Canonical) {
      const tx = [...original.funding, ...original.plan.operations.map(op => ({ ...op, valueWei: '0' }))].find(op => op.id === id);
      requireValue(tx, 'unknown_original_dependency'); await canonical(proof.hash, tx, proof);
    }
    for (const proof of review.originalConfirmedDependencies) await originalDependency(proof.id, proof);
    requireValue(review.oldGrantReceipt.canonical === true && review.oldGrantReceipt.applicationAuthorityAllowed === false, 'repair_old_grant_receipt_scope_invalid');
    await originalDependency('demo-seeker-grant', review.oldGrantReceipt);
    async function preflight(tx: Tx) {
      const r = review.recipients.find(recipient => tx.id.startsWith(`${recipient.label}-`)); requireValue(r, 'unknown_repair_recipient');
      let prepared: { from: Address; to: Address; data: Hex };
      if (tx.id.endsWith('-revoke-issuer')) prepared = await ens!.prepareTransaction({ ensName: r.agentName, owner: r.owner, delegate: review.issuer, operation: 'revoke' });
      else if (tx.id.endsWith('-policy-v2')) prepared = await ens!.prepareTransaction({ ensName: r.agentName, owner: r.owner, delegate: r.delegate, operation: 'set-policy', value: JSON.stringify(r.proposedPublicPolicy) });
      else if (tx.id.endsWith('-grant-delegate')) prepared = await ens!.prepareTransaction({ ensName: r.agentName, owner: r.owner, delegate: r.delegate, operation: 'grant' });
      else if (tx.id.endsWith('-registry')) {
        const result = await ens!.prepareProjectRecipientRegistry({ parentName: original.plan.branch, label: r.label, issuer: review.issuer, recipient: r.owner }); requireValue(result.needed, 'existing_repair_registry_needs_reconciliation'); prepared = result;
      } else if (tx.id.endsWith('-issue')) prepared = await ens!.prepareProjectSubname({ parentName: original.plan.branch, label: r.label, issuer: review.issuer, recipient: r.owner, recipientSubregistry: r.recipientRegistry, expiresAt: Math.floor(Date.parse(original.parent.expiresAt) / 1000) });
      else {
        const suffix = tx.id.slice(r.label.length + 1), operation = suffix === 'agent' ? 'create-subname' : suffix === 'resolver' ? 'deploy-resolver' : 'set-resolver';
        requireValue(['agent', 'resolver', 'attach'].includes(suffix), 'unknown_repair_adapter_operation');
        prepared = await ens!.prepareTransaction({ ensName: r.agentName, owner: r.owner, delegate: r.delegate, operation, expiresAt: Math.floor(Date.parse(original.parent.expiresAt) / 1000) });
      }
      requireValue(same(prepared.from, tx.from) && same(prepared.to, tx.to) && same(prepared.data, tx.data), 'repair_fresh_calldata_differs_from_review');
    }
    async function verifyProxy(address: Address, implementation: Address, owner: Address) {
      const actual = await client!.readContract({ address: ENS_DEPLOYMENT.factory, abi: factoryAbi, functionName: 'verifyContract', args: [address] });
      const abi = same(implementation, ENS_DEPLOYMENT.registryImplementation) ? registryAbi : resolverAbi;
      const [roles, count] = await Promise.all([client!.readContract({ address, abi, functionName: 'roles', args: [0n, owner] }), client!.readContract({ address, abi, functionName: 'roleCount', args: [0n] })]);
      requireValue(same(actual, implementation) && roles === ALL_ROLES && count === ALL_ROLES, 'repair_proxy_or_exclusive_owner_mismatch');
    }
    async function readback(tx: Tx) {
      if (review.funding.some(f => f.id === tx.id)) return 'exact_successful_test_eth_transfer';
      const r = review.recipients.find(recipient => tx.id.startsWith(`${recipient.label}-`))!;
      if (tx.id.endsWith('-revoke-issuer')) {
        const roles = await client!.readContract({ address: r.resolver, abi: resolverAbi, functionName: 'roles', args: [textResource(STATUS_KEY), review.issuer] });
        requireValue(roles === 0n, 'old_issuer_status_permission_not_revoked');
        const old = original.plan.recipients.find(recipient => recipient.label === r.label)!;
        for (const action of ['negotiate', 'publish', 'message'] as const) requireValue(!(await ens!.checkAuthority({ ensName: r.agentName, owner: r.owner, delegate: review.issuer, action, policyVersion: '1', policyDigest: old.policyDigest })).allowed, 'old_issuer_application_action_not_denied');
        const data = encodeFunctionData({ abi: resolverAbi, functionName: 'setText', args: [dnsEncode(r.agentName), STATUS_KEY, 'Meeti read-only revoked status permission check.'] });
        let denied = false;
        try { await client!.call({ account: review.issuer, to: r.resolver, data, value: 0n }); }
        catch (error) { denied = isForbiddenTextRoleRevert(error, review.issuer, STATUS_KEY); }
        requireValue(denied, 'old_issuer_status_call_not_proven_forbidden');
        return 'old_issuer_status_role_zero_current_application_denial_and_exact_eac_revert_verified';
      }
      if (tx.id.endsWith('-grant-delegate')) {
        const authority = await ens!.checkAuthority({ ensName: r.agentName, owner: r.owner, delegate: r.delegate, action: 'negotiate', policyVersion: '2', policyDigest: r.policyDigest });
        requireValue(authority.allowed && authority.evidence && same(authority.evidence.resolver, r.resolver), 'new_delegate_current_authority_denied');
        const roles = await client!.readContract({ address: r.resolver, abi: resolverAbi, functionName: 'roles', args: [textResource(STATUS_KEY), r.delegate] }); requireValue(roles === TEXT_ROLE, 'new_delegate_scope_not_status_only');
        return 'current_v2_authority_and_status_only_delegation_verified';
      }
      if (tx.id.endsWith('-registry')) await verifyProxy(r.recipientRegistry, ENS_DEPLOYMENT.registryImplementation, r.owner);
      else if (tx.id.endsWith('-issue')) { const state = await ens!.inspectProjectParent({ parentName: r.userName, issuer: r.owner }); requireValue(state.nextStep === 'ready' && same(state.subregistry, r.recipientRegistry), 'repair_user_registry_attachment_failed'); }
      else if (tx.id.endsWith('-agent')) { const state = await ens!.inspectProjectParent({ parentName: r.agentName, issuer: r.owner }); requireValue(state.issuer.toLowerCase() === r.owner.toLowerCase(), 'repair_agent_owner_mismatch'); }
      else if (tx.id.endsWith('-resolver')) await verifyProxy(r.resolver, ENS_DEPLOYMENT.resolverImplementation, r.owner);
      else {
        const attached = await client!.readContract({ address: r.recipientRegistry, abi: registryAbi, functionName: 'getResolver', args: ['networking'] }); requireValue(same(attached, r.resolver), 'repair_resolver_attachment_failed');
        await verifyProxy(r.resolver, ENS_DEPLOYMENT.resolverImplementation, r.owner);
        if (tx.id.endsWith('-policy-v2')) {
          const query = encodeFunctionData({ abi: textProfileAbi, functionName: 'text', args: [namehash(r.agentName), POLICY_KEY] });
          const result = await client!.readContract({ address: r.resolver, abi: resolverAbi, functionName: 'resolve', args: [dnsEncode(r.agentName), query] });
          requireValue(decodeFunctionResult({ abi: textProfileAbi, functionName: 'text', data: result }) === JSON.stringify(r.proposedPublicPolicy), 'repair_v2_policy_readback_mismatch');
        }
      }
      return 'current_namespace_state_verified';
    }
    for (const tx of sequence) {
      activeOperationId = tx.id; await freshChain();
      const funding = review.funding.some(op => op.id === tx.id), value = BigInt(tx.valueWei);
      requireValue(funding || value === 0n, 'repair_namespace_value_must_be_zero');
      let entry = journal.entries.find(item => item.id === tx.id);
      if (entry) {
        requireValue(entry.raw.startsWith('0x02') && entry.hash === keccak256(entry.raw), 'repair_journal_raw_hash_mismatch');
        const parsed = parseTransaction(entry.raw);
        requireValue(parsed.chainId === 11155111 && parsed.to && same(parsed.to, tx.to) && same(parsed.data ?? '0x', tx.data) && (parsed.value ?? 0n) === value && same(await recoverTransactionAddress({ serializedTransaction: entry.raw as `0x02${string}` }), tx.from), 'repair_journal_signed_scope_mismatch');
        requireValue(parsed.gas && parsed.maxFeePerGas && parsed.maxPriorityFeePerGas !== undefined && parsed.maxFeePerGas <= BigInt(tx.maxFeePerGas) && parsed.maxPriorityFeePerGas <= BigInt(tx.maxPriorityFeePerGas) && parsed.gas * parsed.maxFeePerGas <= BigInt(tx.maxGasCostWei) && entry.maxGasCostWei === (parsed.gas * parsed.maxFeePerGas).toString(), 'repair_journal_fee_cap_mismatch');
        requireValue(same(entry.from, tx.from) && same(entry.to, tx.to) && same(entry.data, tx.data) && entry.valueWei === tx.valueWei, 'repair_journal_metadata_mismatch');
      }
      if (!entry) {
        unexpired();
        for (const id of tx.dependsOn ?? []) {
          const prior = journal.entries.find(item => item.id === id), originalProof = review.originalConfirmedDependencies.find(item => item.id === id);
          if (prior?.confirmed) await canonical(prior.hash, sequence.find(item => item.id === id)!, prior.confirmed);
          else { requireValue(originalProof, 'repair_unconfirmed_dependency'); await originalDependency(id, originalProof); }
        }
        if (!funding) await preflight(tx);
        const cap = capMap(approval.totalCaps).find(([address]) => same(address, tx.from))?.[1];
        const reserved = journal.entries.filter(item => same(item.from, tx.from)).reduce((sum, item) => sum + BigInt(item.maxGasCostWei) + BigInt(item.valueWei), 0n);
        requireValue(cap && reserved + BigInt(tx.maxGasCostWei) + value <= BigInt(cap), 'repair_aggregate_wallet_cap_exceeded');
        const head = await freshChain();
        const gas = await client.estimateGas({ account: tx.from, to: tx.to, data: tx.data, value, maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) });
        const envelope = boundedFundingEnvelope({ estimatedGas: gas, maxGasCostWei: BigInt(tx.maxGasCostWei), reviewedMaxFeePerGas: BigInt(tx.maxFeePerGas), reviewedMaxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas), baseFeePerGas: head.baseFeePerGas ?? 0n });
        requireValue(await client.getBalance({ address: tx.from }) >= BigInt(tx.maxGasCostWei) + value, 'repair_insufficient_test_eth');
        const account = accounts.get(tx.from.toLowerCase()); requireValue(account, 'repair_unapproved_sender');
        const nonce = await client.getTransactionCount({ address: tx.from, blockTag: 'pending' }); unexpired();
        const raw = await account.signTransaction({ type: 'eip1559', chainId: 11155111, nonce, to: tx.to, data: tx.data, value, gas: envelope.gas, maxFeePerGas: envelope.maxFeePerGas, maxPriorityFeePerGas: envelope.maxPriorityFeePerGas });
        entry = { id: tx.id, raw, hash: keccak256(raw), from: tx.from, to: tx.to, data: tx.data, valueWei: tx.valueWei, maxGasCostWei: envelope.maxGasCostWei.toString() };
        journal.entries.push(entry); save();
      }
      const receipt = await client.getTransactionReceipt({ hash: entry.hash }).catch(() => undefined);
      if (!receipt) {
        const known = await client.getTransaction({ hash: entry.hash }).catch(() => undefined);
        if (!known) { unexpired(); if (!funding) await preflight(tx); requireValue(await sender.sendRawTransaction({ serializedTransaction: entry.raw }) === entry.hash, 'repair_broadcast_hash_mismatch'); }
        await client.waitForTransactionReceipt({ hash: entry.hash, confirmations: 2, timeout: 90_000, pollingInterval: 3000 });
      }
      const mined = await canonical(entry.hash, tx, entry.confirmed);
      if (JSON.stringify(entry.mined) !== JSON.stringify(mined)) { entry.mined = mined; save(); }
      const state = await readback(tx), confirmed = { ...mined, readback: state };
      if (JSON.stringify(entry.confirmed) !== JSON.stringify(confirmed)) { entry.confirmed = confirmed; save(); }
      console.log(JSON.stringify({ id: tx.id, transactionHash: entry.hash, mined: true, currentStateVerified: true, blockNumber: mined.blockNumber }));
    }
    console.log(JSON.stringify({ reviewSha256, confirmed: journal.entries.length, worldVerified: false }));
  } catch (error) {
    console.error(JSON.stringify({ operation: activeOperationId, outcome: 'stopped_no_automatic_replacement' }));
    throw error;
  } finally {
    if (ens) await ens.disconnect();
    for (const rpc of [client, sender]) { const transport = rpc?.transport as { getRpcClient?: () => Promise<{ close(): void }> } | undefined;
      try { if (transport?.getRpcClient) (await transport.getRpcClient()).close(); } catch { /* Cleanup never logs authenticated endpoints. */ }
    }
    closeSync(lock); unlinkSync(lockPath);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main().catch(error => {
  console.error(error instanceof Error && /^[a-z][a-z0-9_]+$/.test(error.message) ? error.message : 'namespace_repair_stopped_no_secret_details_logged');
  process.exitCode = 1;
});

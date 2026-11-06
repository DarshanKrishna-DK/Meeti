import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createPublicClient, decodeFunctionResult, encodeFunctionData, getAddress, http, keccak256, namehash, parseTransaction, recoverTransactionAddress, webSocket, type Address, type Hex } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { decrypt, encrypt, sign } from '../packages/server/crypto';
import { namespaceReviewFreshness } from './namespace-review-freshness';
import { ALL_ROLES, createEnsAuthorityProvider, dnsEncode, ENS_DEPLOYMENT, POLICY_KEY, type EnsOperation } from '../packages/ens';
import { factoryAbi, registryAbi, resolverAbi, textProfileAbi } from '../packages/ens/abi';
import type { buildNamespaceDemoPlan, NamespacePlanOperation } from '../packages/ens/namespace-plan';
import { createEnsReadTransport } from '../packages/ens/rpc-transport';
import { boundedFundingEnvelope } from '../packages/ens/funding-envelope';

type Plan = Awaited<ReturnType<typeof buildNamespaceDemoPlan>>;
type Funding = { id: string; from: Address; to: Address; valueWei: string; chainId: number; data: Hex; gasLimit: string; maxFeePerGas: string; maxPriorityFeePerGas: string; maxGasCostWei: string };
type Review = { reviewOnly: true; reviewExpiresAt: string; chainId: number; parent: { issuer: Address; subregistry: Address; expiresAt: string }; plan: Plan; funding: Funding[]; issuerMaxGasAndTransferValueWei: string };
type JournalEntry = { id: string; hash: Hex; raw: Hex; from: Address; to: Address; data: Hex; valueWei: string; maxGasCostWei: string; signedEnvelope: { gas: string; maxFeePerGas: string; maxPriorityFeePerGas: string }; confirmed?: { blockNumber: string; blockHash: Hex; readback: string } };
type Journal = { reviewSha256: string; chainId: 11155111; entries: JournalEntry[] };
const arg = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
function fail(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error(reason); }
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

async function main() {
// All authorization and immutable-file checks precede key access, signing and writable RPC construction.
fail(process.argv.includes('--execute-reviewed'), 'explicit_execution_flag_required');
const rawReview = readFileSync('artifacts/namespace-demo-review.json', 'utf8');
const reviewSha256 = createHash('sha256').update(rawReview).digest('hex');
fail(arg('review-sha256') === reviewSha256, 'exact_review_hash_required');
const review = JSON.parse(rawReview) as Review;
const approval = JSON.parse(readFileSync('.local-data/namespace-demo-approval.json', 'utf8')) as { authorized: boolean; reviewSha256: string; chainId: number; approvedAt: string; issuerMaxGasAndTransferValueWei: string; recipientMaxGasCostWei: string };
fail(approval.authorized === true && approval.reviewSha256 === reviewSha256 && approval.chainId === 11155111 && review.chainId === 11155111, 'exact_local_approval_required');
fail(Number.isFinite(Date.parse(approval.approvedAt)) && Date.parse(approval.approvedAt) <= Date.now(), 'invalid_approval_timestamp');
fail(approval.issuerMaxGasAndTransferValueWei === '9871000000000000' && approval.recipientMaxGasCostWei === '2450000000000000', 'approval_cap_mismatch');
fail(review.reviewOnly === true && review.plan.operations.length === 17 && review.funding.length === 2, 'unexpected_review_scope');
fail(review.issuerMaxGasAndTransferValueWei === approval.issuerMaxGasAndTransferValueWei && same(review.parent.issuer, '0x9253705482a44e6A7378163e57cc791AE6213ed5'), 'issuer_scope_mismatch');
mkdirSync('.local-data', { recursive: true });
const lockPath = '.local-data/namespace-demo-execution.lock';
const lock = openSync(lockPath, 'wx', 0o600);
writeFileSync(lock, JSON.stringify({ pid: process.pid, reviewSha256 }));
process.on('exit', () => { closeSync(lock); if (existsSync(lockPath)) unlinkSync(lockPath); });
const issuer = getAddress(review.parent.issuer);
const keyName = arg('issuer-key-env');
fail(keyName && /^[A-Z][A-Z0-9_]+$/.test(keyName), 'explicit_issuer_key_variable_required');
const issuerKey = process.env[keyName];
fail(issuerKey && /^0x[0-9a-fA-F]{64}$/.test(issuerKey), 'issuer_key_not_configured');
const accounts = new Map<string, ReturnType<typeof privateKeyToAccount>>();
const issuerAccount = privateKeyToAccount(issuerKey as Hex);
fail(same(issuerAccount.address, issuer), 'issuer_key_address_mismatch'); accounts.set(issuer.toLowerCase(), issuerAccount);
const vault = decrypt<{ version: number; wallets: { label: string; privateKey: Hex }[] }>(readFileSync('.local-data/demo-wallets.enc', 'utf8'), 'meeti-demo-wallets-v1');
fail(vault.version === 1 && vault.wallets.length === 2, 'invalid_test_wallet_vault');
for (const recipient of review.plan.recipients) {
  const secret = vault.wallets.find(wallet => wallet.label === recipient.label);
  fail(secret, 'recipient_key_missing'); const account = privateKeyToAccount(secret.privateKey);
  fail(same(account.address, recipient.owner), 'recipient_key_address_mismatch'); accounts.set(account.address.toLowerCase(), account);
}
const rpcUrl = process.env.ENS_SEPOLIA_AUTH_RPC_URL || process.env.ENS_SEPOLIA_RPC_URL;
fail(rpcUrl, 'ens_rpc_not_configured');
const client = createPublicClient({ chain: sepolia, transport: createEnsReadTransport(rpcUrl) });
const sender = createPublicClient({ chain: sepolia, transport: rpcUrl.startsWith('wss:') ? webSocket(rpcUrl, { retryCount: 0, reconnect: false, keepAlive: false }) : http(rpcUrl, { retryCount: 0 }) });
const ens = createEnsAuthorityProvider({ rpcUrl });
const journalPath = '.local-data/namespace-demo-journal.enc', journalContext = `meeti-namespace-demo-journal-v1:${reviewSha256}`;
const journal: Journal = existsSync(journalPath) ? decrypt<Journal>(readFileSync(journalPath, 'utf8'), journalContext) : { reviewSha256, chainId: 11155111, entries: [] };
fail(journal.reviewSha256 === reviewSha256 && journal.chainId === 11155111, 'journal_review_mismatch');
const freshness = namespaceReviewFreshness({ reviewRaw: rawReview, approvalRaw: readFileSync('.local-data/namespace-demo-approval.json', 'utf8'), approvedReviewSha256: reviewSha256,
  journal, ...(existsSync(journalPath) ? { journalRaw: readFileSync(journalPath, 'utf8') } : {}),
  ...(existsSync('.local-data/namespace-demo-renewal.json') ? { renewalRaw: readFileSync('.local-data/namespace-demo-renewal.json', 'utf8') } : {}), signPayload: sign });
function save() {
  mkdirSync('.local-data', { recursive: true });
  writeFileSync(`${journalPath}.tmp`, encrypt(journal, journalContext), { mode: 0o600 }); renameSync(`${journalPath}.tmp`, journalPath);
  mkdirSync('artifacts', { recursive: true }); writeFileSync('artifacts/namespace-demo-execution.json', JSON.stringify({ reviewSha256, chainId: 11155111, checkedAt: new Date().toISOString(),
    transactions: journal.entries.map(({ id, hash, from, to, confirmed }) => ({ id, hash, from, to, status: confirmed ? 'confirmed_readback' : 'signed_pending_or_unknown', confirmed })) }, null, 2));
}
function unexpired() { fail(freshness.deadline > Date.now(), 'review_expired_no_new_signature_or_broadcast'); }
async function freshChain() {
  const [chainId, block] = await Promise.all([client.getChainId(), client.getBlock()]);
  fail(chainId === 11155111 && Math.abs(Date.now() / 1000 - Number(block.timestamp)) < 90, 'wrong_chain_or_stale_head');
  return block;
}
async function preflight(op: NamespacePlanOperation) {
  const recipient = review.plan.recipients.find(r => op.id.startsWith(`${r.label}-`));
  const expiresAt = Math.floor(Date.parse(review.parent.expiresAt) / 1000);
  let prepared: { from: Address; to: Address; data: Hex };
  if (op.id === 'branch-register') prepared = await ens.prepareProjectSubname({ parentName: review.plan.parent, label: 'users', issuer, recipient: issuer, expiresAt });
  else if (op.id === 'branch-registry' || op.id === 'branch-attach') prepared = await ens.prepareTransaction({ ensName: `candidate.${review.plan.branch}`, owner: issuer, delegate: ENS_DEPLOYMENT.factory, operation: op.id === 'branch-registry' ? 'deploy-registry' : 'set-subregistry' });
  else {
    fail(recipient, 'unexpected_namespace_operation');
    if (op.id.endsWith('-registry')) {
      const result = await ens.prepareProjectRecipientRegistry({ parentName: review.plan.branch, label: recipient.label, issuer, recipient: recipient.owner });
      fail(result.needed, 'existing_recipient_registry_requires_reconciliation'); prepared = result;
    } else if (op.id.endsWith('-issue')) prepared = await ens.prepareProjectSubname({ parentName: review.plan.branch, label: recipient.label, issuer, recipient: recipient.owner, recipientSubregistry: recipient.recipientRegistry, expiresAt });
    else {
      const suffix = op.id.slice(recipient.label.length + 1);
      const operation: EnsOperation = suffix === 'agent' ? 'create-subname' : suffix === 'resolver' ? 'deploy-resolver' : suffix === 'attach' ? 'set-resolver' : suffix === 'policy' ? 'set-policy' : 'grant';
      fail(['agent', 'resolver', 'attach', 'policy', 'grant'].includes(suffix), 'unexpected_owner_operation');
      prepared = await ens.prepareTransaction({ ensName: recipient.agentName, owner: recipient.owner, delegate: recipient.delegate, operation, expiresAt,
        ...(suffix === 'policy' ? { value: JSON.stringify(recipient.proposedPublicPolicy) } : {}) });
    }
  }
  fail(same(prepared.from, op.from) && same(prepared.to, op.to) && same(prepared.data, op.data), 'fresh_calldata_differs_from_approved_review');
}
async function verifyProxy(address: Address, implementation: Address, owner: Address) {
  const actual = await client.readContract({ address: ENS_DEPLOYMENT.factory, abi: factoryAbi, functionName: 'verifyContract', args: [address] });
  fail(same(actual, implementation), 'deployed_proxy_implementation_mismatch');
  const abi = same(implementation, ENS_DEPLOYMENT.registryImplementation) ? registryAbi : resolverAbi;
  const [roles, count] = await Promise.all([client.readContract({ address, abi, functionName: 'roles', args: [0n, owner] }), client.readContract({ address, abi, functionName: 'roleCount', args: [0n] })]);
  fail(roles === ALL_ROLES && count === ALL_ROLES, 'deployed_root_control_not_exclusive');
}
async function readback(op: NamespacePlanOperation) {
  const recipient = review.plan.recipients.find(r => op.id.startsWith(`${r.label}-`));
  if (op.id === 'branch-register' || op.id === 'branch-attach') {
    const state = await ens.inspectProjectParent({ parentName: review.plan.branch, issuer });
    fail(op.id !== 'branch-attach' || (state.nextStep === 'ready' && same(state.subregistry, review.plan.usersRegistry)), 'branch_attachment_readback_failed');
  } else if (op.id === 'branch-registry') await verifyProxy(review.plan.usersRegistry, ENS_DEPLOYMENT.registryImplementation, issuer);
  else {
    fail(recipient, 'unknown_readback_recipient');
    if (op.id.endsWith('-registry')) await verifyProxy(recipient.recipientRegistry, ENS_DEPLOYMENT.registryImplementation, recipient.owner);
    else if (op.id.endsWith('-issue')) {
      const state = await ens.inspectProjectParent({ parentName: recipient.userName, issuer: recipient.owner });
      fail(state.nextStep === 'ready' && same(state.subregistry, recipient.recipientRegistry), 'recipient_registry_attachment_failed');
    } else if (op.id.endsWith('-agent')) {
      const state = await client.readContract({ address: recipient.recipientRegistry, abi: registryAbi, functionName: 'getState', args: [BigInt(keccak256(new TextEncoder().encode('networking')))] });
      fail(same(state.latestOwner, recipient.owner) && state.expiry === BigInt(Math.floor(Date.parse(review.parent.expiresAt) / 1000)), 'agent_ownership_readback_failed');
    } else if (op.id.endsWith('-resolver')) await verifyProxy(recipient.resolver, ENS_DEPLOYMENT.resolverImplementation, recipient.owner);
    else if (op.id.endsWith('-grant')) {
      const authority = await ens.checkAuthority({ ensName: recipient.agentName, owner: recipient.owner, delegate: recipient.delegate, action: 'negotiate', policyVersion: '1', policyDigest: recipient.policyDigest });
      fail(authority.allowed, 'current_agent_authority_readback_failed');
    } else {
      const attached = await client.readContract({ address: recipient.recipientRegistry, abi: registryAbi, functionName: 'getResolver', args: ['networking'] });
      fail(same(attached, recipient.resolver), 'resolver_attachment_readback_failed');
      await verifyProxy(recipient.resolver, ENS_DEPLOYMENT.resolverImplementation, recipient.owner);
      if (op.id.endsWith('-policy')) {
        const data = encodeFunctionData({ abi: textProfileAbi, functionName: 'text', args: [namehash(recipient.agentName), POLICY_KEY] });
        const encoded = await client.readContract({ address: recipient.resolver, abi: resolverAbi, functionName: 'resolve', args: [dnsEncode(recipient.agentName), data] });
        fail(decodeFunctionResult({ abi: textProfileAbi, functionName: 'text', data: encoded }) === JSON.stringify(recipient.proposedPublicPolicy), 'policy_record_readback_failed');
      }
    }
  }
}
let activeOperationId = 'startup';
async function execute(tx: Funding | NamespacePlanOperation, isFunding: boolean) {
  activeOperationId = tx.id;
  await freshChain();
  const value = isFunding ? BigInt((tx as Funding).valueWei) : 0n;
  fail(tx.chainId === 11155111 && BigInt(tx.maxFeePerGas) === 500_000_000n && BigInt(tx.maxPriorityFeePerGas) === 10_000_000n, 'transaction_fee_or_chain_scope_mismatch');
  fail(BigInt(tx.maxGasCostWei) === BigInt(tx.gasLimit) * BigInt(tx.maxFeePerGas), 'invalid_review_gas_arithmetic');
  if (isFunding) fail(same(tx.from, issuer) && review.plan.recipients.some(r => same(r.owner, tx.to)) && value <= 3_000_000_000_000_000n && tx.data === '0x' && tx.gasLimit === '21000', 'funding_scope_mismatch');
  let entry = journal.entries.find(item => item.id === tx.id);
  if (entry) {
    fail(entry.raw.startsWith('0x02'), 'journal_requires_eip1559_transaction');
    const decoded = parseTransaction(entry.raw);
    fail(entry.hash === keccak256(entry.raw) && same(entry.from, tx.from) && same(entry.to, tx.to) && same(entry.data, tx.data) && entry.valueWei === value.toString(), 'journal_transaction_mismatch');
    fail(decoded.chainId === 11155111 && (decoded.value ?? 0n) === value && decoded.gas !== undefined && decoded.maxFeePerGas !== undefined && decoded.maxPriorityFeePerGas !== undefined, 'journal_signed_fields_mismatch');
    fail(decoded.gas > 0n && decoded.maxFeePerGas <= BigInt(tx.maxFeePerGas) && decoded.maxPriorityFeePerGas <= BigInt(tx.maxPriorityFeePerGas) && decoded.gas * decoded.maxFeePerGas <= BigInt(tx.maxGasCostWei), 'journal_exceeds_approved_fee_budget');

    fail(entry.signedEnvelope.gas === decoded.gas.toString() && entry.signedEnvelope.maxFeePerGas === decoded.maxFeePerGas.toString() && entry.signedEnvelope.maxPriorityFeePerGas === decoded.maxPriorityFeePerGas.toString() && entry.maxGasCostWei === (decoded.gas * decoded.maxFeePerGas).toString(), 'journal_envelope_arithmetic_mismatch');
    fail(decoded.to && same(decoded.to, tx.to) && same(decoded.data ?? '0x', tx.data) && same(await recoverTransactionAddress({ serializedTransaction: entry.raw as `0x02${string}` }), tx.from), 'journal_signed_sender_or_destination_mismatch');
  }
  if (!entry) {
    unexpired();
    if (!isFunding) {
      const op = tx as NamespacePlanOperation;
      fail(op.dependsOn.every(id => journal.entries.some(item => item.id === id && item.confirmed)), 'unconfirmed_dependency');
      await preflight(op);
    }
    const total = journal.entries.filter(item => same(item.from, tx.from)).reduce((sum, item) => sum + BigInt(item.maxGasCostWei) + BigInt(item.valueWei), 0n) + BigInt(tx.maxGasCostWei) + value;
    fail(total <= BigInt(same(tx.from, issuer) ? approval.issuerMaxGasAndTransferValueWei : approval.recipientMaxGasCostWei), 'aggregate_wallet_cap_exceeded');
    const head = await freshChain();
    const gas = await client.estimateGas({ account: tx.from, to: tx.to, data: tx.data, value, maxFeePerGas: BigInt(tx.maxFeePerGas), maxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas) });
    const envelope = boundedFundingEnvelope({ estimatedGas: gas, maxGasCostWei: BigInt(tx.maxGasCostWei), reviewedMaxFeePerGas: BigInt(tx.maxFeePerGas), reviewedMaxPriorityFeePerGas: BigInt(tx.maxPriorityFeePerGas), baseFeePerGas: head.baseFeePerGas ?? 0n });
    fail((head.baseFeePerGas ?? 0n) + envelope.maxPriorityFeePerGas <= envelope.maxFeePerGas, 'fee_cap_below_current_base_fee');
    fail(gas <= envelope.gas, 'estimated_gas_exceeds_review_limit');
    fail(await client.getBalance({ address: tx.from }) >= BigInt(tx.maxGasCostWei) + value, 'insufficient_test_eth');
    const account = accounts.get(tx.from.toLowerCase()); fail(account, 'unapproved_sender');
    const nonce = await client.getTransactionCount({ address: tx.from, blockTag: 'pending' });
    unexpired();
    const raw = await account.signTransaction({ type: 'eip1559', chainId: 11155111, nonce, to: tx.to, data: tx.data, value, gas: envelope.gas, maxFeePerGas: envelope.maxFeePerGas, maxPriorityFeePerGas: envelope.maxPriorityFeePerGas });
    entry = { id: tx.id, raw, hash: keccak256(raw), from: tx.from, to: tx.to, data: tx.data, valueWei: value.toString(), maxGasCostWei: envelope.maxGasCostWei.toString(), signedEnvelope: { gas: envelope.gas.toString(), maxFeePerGas: envelope.maxFeePerGas.toString(), maxPriorityFeePerGas: envelope.maxPriorityFeePerGas.toString() } };
    journal.entries.push(entry); save();
  }
  let receipt = await client.getTransactionReceipt({ hash: entry.hash }).catch(() => undefined);
  if (!receipt) {
    const known = await client.getTransaction({ hash: entry.hash }).catch(() => undefined);
    if (!known) { unexpired(); const result = await sender.sendRawTransaction({ serializedTransaction: entry.raw }); fail(result === entry.hash, 'broadcast_hash_mismatch'); }
    receipt = await client.waitForTransactionReceipt({ hash: entry.hash, confirmations: 2, timeout: 90_000, pollingInterval: 3000 });
  }
  const actual = await client.getTransaction({ hash: entry.hash });
  fail(receipt.status === 'success' && same(actual.from, tx.from) && actual.to && same(actual.to, tx.to) && same(actual.input, tx.data) && actual.value === value, 'confirmed_transaction_mismatch');
  const head = await client.getBlock();
  fail(head.number >= receipt.blockNumber + 1n && (await client.getBlock({ blockNumber: receipt.blockNumber })).hash === receipt.blockHash, 'canonical_confirmations_required');
  if (!isFunding) await readback(tx as NamespacePlanOperation);
  if (!entry.confirmed) {
    entry.confirmed = { blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, readback: isFunding ? 'exact_successful_test_eth_transfer' : 'current_namespace_state_verified' }; save();
  }
  console.log(JSON.stringify({ id: tx.id, transactionHash: entry.hash, confirmed: true, blockNumber: receipt.blockNumber.toString() }));
}
try {
  for (const transfer of review.funding) await execute(transfer, true);
  for (const operation of review.plan.operations) await execute(operation, false);
  console.log(JSON.stringify({ reviewSha256, confirmed: journal.entries.length, worldVerified: false, externalDeployment: false }));
} catch (error) {
  const kinds: { name: string; status?: number; code?: number }[] = [];
  let cause: unknown = error;
  for (let depth = 0; depth < 4 && cause && typeof cause === 'object'; depth++) {
    const item = cause as { name?: unknown; status?: unknown; code?: unknown; cause?: unknown };
    kinds.push({ name: typeof item.name === 'string' && /^[A-Za-z]+$/.test(item.name) ? item.name : 'Error',
      ...(typeof item.status === 'number' ? { status: item.status } : {}), ...(typeof item.code === 'number' ? { code: item.code } : {}) });
    cause = item.cause;
  }
  console.error(JSON.stringify({ operation: activeOperationId, errors: kinds }));
  console.error(error instanceof Error && /^[a-z][a-z0-9_]+$/.test(error.message) ? error.message : 'namespace_execution_stopped_check_private_journal_and_public_receipts_no_automatic_replacement'); process.exitCode = 1;
} finally {
  await ens.disconnect();
  for (const rpcClient of [client, sender]) {
    const transport = rpcClient.transport as { getRpcClient?: () => Promise<{ close(): void }> };
    try { if (transport.getRpcClient) (await transport.getRpcClient()).close(); } catch { /* Closing must not expose endpoint details or replace the primary result. */ }
  }
}
}
await main().catch(error => {
  console.error(error instanceof Error && /^[a-z][a-z0-9_]+$/.test(error.message) ? error.message : 'namespace_execution_startup_failed_no_secret_details_logged');
  process.exitCode = 1;
});

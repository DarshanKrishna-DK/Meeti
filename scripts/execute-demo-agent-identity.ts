import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createPublicClient, http, keccak256, parseAbi, parseTransaction, recoverTransactionAddress, webSocket, type Address, type Hex, type TransactionSerialized } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { createEnsAuthorityProvider, inlinePolicyDigest } from '../packages/ens';
import { createAgentIdentityProvider, ERC8004_SEPOLIA, identityRegistryAbi } from '../packages/ens/agent-identity';
import { AGENT_CONTEXT_KEY, registrationDataUri, type AgentRegistryIdentity } from '../packages/ens/agent-records';
import { createEnsReadTransport } from '../packages/ens/rpc-transport';
import { decrypt, encrypt } from '../packages/server/crypto';
import type { AppState } from '../packages/shared/src';
import { api, loadDemo, JOURNAL_PATH as arkivJournalPath, REVIEW_PATH as arkivReviewPath, type Label } from './prepare-demo-arkiv';
import { prepareConditionalDemoAgentIdentityStep, type DemoIdentityOwnerReview, type DemoIdentityStep } from './prepare-demo-agent-identity';

type IdentityOperation = { id: string; label: Label; operation: 'register-identity' | DemoIdentityStep; chainId: number; from: Address; to: Address; valueWei: string; maxGasCostWei: string; maxFeePerGas: string; maxPriorityFeePerGas: string; dependsOn: string[]; data: Hex | null };
type Review = { version: number; reviewOnly: boolean; fictional: boolean; humanVerified: boolean; chainId: number; reviewExpiresAt: string; owners: DemoIdentityOwnerReview[]; operations: IdentityOperation[]; funding: unknown[]; totalCaps: Record<string, string>; checks: { owner: string; currentAuthority: { policyVersion: number; policyDigest: string } }[] };
export type IdentityQuote = { operationId: string; expiresAt: string; maxFeeWei: string; transaction: { chainId: number; from: Address; to: Address; data: Hex; value: string; ensName: string; gas: Hex; gasPrice: Hex } };
export type IdentityJournalEntry = { id: string; label: Label; state: 'preparing' | 'prepared' | 'signed' | 'broadcast_admitted' | 'submitted' | 'mined' | 'confirmed'; quote?: IdentityQuote; raw?: Hex; hash?: Hex; nonce?: number; reservedFeeWei?: string; broadcastAttemptedAt?: string; apiSubmitted?: boolean; receipt?: { blockNumber: string; blockHash: Hex; actualFeeWei: string }; identity?: AgentRegistryIdentity };
type Journal = { version: 1; chainId: 11155111; reviewSha256: string; entries: IdentityJournalEntry[] };
const sha = (raw: string) => createHash('sha256').update(raw).digest('hex');
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
function requireValue(condition: unknown, reason: string): asserts condition { if (!condition) throw new Error(reason); }
const reviewPath = 'artifacts/demo-agent-identity-review.json', approvalPath = '.local-data/demo-agent-identity-approval.json', journalPath = '.local-data/demo-agent-identity-journal.enc';

export function assertIdentityAdmission(input: { reviewExpiresAt: string; quoteExpiresAt?: string }, now = Date.now()) {
  requireValue(Number.isFinite(Date.parse(input.reviewExpiresAt)) && Date.parse(input.reviewExpiresAt) > now, 'identity_review_expired_no_new_signature_or_broadcast');
  if (input.quoteExpiresAt !== undefined) requireValue(Number.isFinite(Date.parse(input.quoteExpiresAt)) && Date.parse(input.quoteExpiresAt) > now, 'identity_api_quote_expired_no_new_signature_or_broadcast');
}
export function assertIdentityApiQuote(input: { quote: IdentityQuote; owner: DemoIdentityOwnerReview; operation: IdentityOperation; expected: { from: string; to: string; data: Hex; value: string }; reviewExpiresAt: string; now?: number }) {
  const { quote, owner, operation, expected } = input;
  requireValue(typeof quote.expiresAt === 'string' && Number.isFinite(Date.parse(quote.expiresAt)), 'identity_api_quote_expiry_required');
  assertIdentityAdmission({ reviewExpiresAt: input.reviewExpiresAt, quoteExpiresAt: quote.expiresAt }, input.now);
  requireValue(/^[0-9a-f-]{36}$/.test(quote.operationId) && quote.maxFeeWei === '500000000000000', 'identity_api_operation_or_cap_mismatch');
  const tx = quote.transaction;
  requireValue(tx.chainId === 11155111 && same(tx.from, owner.owner) && same(tx.from, operation.from) && same(tx.to, operation.to) && same(tx.from, expected.from) && same(tx.to, expected.to) && tx.data === expected.data && tx.value === '0x0' && expected.value === '0x0' && tx.ensName === owner.ensName, 'identity_api_quote_differs_from_reviewed_materialization');
  requireValue(/^0x[0-9a-f]+$/i.test(tx.gas) && /^0x[0-9a-f]+$/i.test(tx.gasPrice), 'identity_api_fee_encoding_invalid');
  const gas = BigInt(tx.gas), price = BigInt(tx.gasPrice);
  requireValue(gas > 0n && price > 0n && price <= BigInt(operation.maxFeePerGas) && gas * price <= BigInt(operation.maxGasCostWei), 'identity_api_quote_fee_cap_exceeded');
  return { gas, gasPrice: price, maximumFeeWei: gas * price };
}
export async function assertIdentityRaw(entry: IdentityJournalEntry, operation: IdentityOperation, owner: DemoIdentityOwnerReview) {
  requireValue(entry.raw && entry.hash && entry.quote && entry.hash === keccak256(entry.raw), 'identity_signed_journal_hash_mismatch');
  const tx = parseTransaction(entry.raw);
  requireValue(tx.type === 'legacy' && tx.chainId === 11155111 && tx.to && same(tx.to, operation.to) && same(tx.data ?? '0x', entry.quote.transaction.data) && (tx.value ?? 0n) === 0n && tx.nonce === entry.nonce && same(await recoverTransactionAddress({ serializedTransaction: entry.raw as TransactionSerialized }), owner.owner), 'identity_signed_scope_mismatch');
  requireValue(tx.gas === BigInt(entry.quote.transaction.gas) && tx.gasPrice === BigInt(entry.quote.transaction.gasPrice) && tx.gasPrice <= BigInt(operation.maxFeePerGas) && tx.gas * tx.gasPrice <= BigInt(operation.maxGasCostWei) && entry.reservedFeeWei === (tx.gas * tx.gasPrice).toString(), 'identity_signed_fee_cap_mismatch');
}
export async function admitIdentityBroadcast(entry: IdentityJournalEntry, reviewExpiresAt: string, save: () => void, send: (raw: Hex) => Promise<Hex>, now = Date.now) {
  requireValue(entry.state === 'signed' && entry.raw && entry.hash && entry.quote && !entry.broadcastAttemptedAt, 'identity_known_or_uncertain_submission_cannot_broadcast_again');
  requireValue(entry.hash === keccak256(entry.raw), 'identity_signed_hash_changed_before_broadcast');
  assertIdentityAdmission({ reviewExpiresAt, quoteExpiresAt: entry.quote.expiresAt }, now());
  entry.state = 'broadcast_admitted'; entry.broadcastAttemptedAt = new Date(now()).toISOString(); save();
  assertIdentityAdmission({ reviewExpiresAt, quoteExpiresAt: entry.quote.expiresAt }, now());
  requireValue(await send(entry.raw) === entry.hash, 'identity_broadcast_hash_mismatch_preserve_journal');
}
export async function ensureIdentityReceiptDepth<T extends { transactionHash: Hex; blockNumber: bigint }>(input: { receipt: T; headNumber: bigint; wait: () => Promise<T> }): Promise<T> {
  if (input.headNumber >= input.receipt.blockNumber + 1n) return input.receipt;
  const confirmed = await input.wait();
  requireValue(confirmed.transactionHash === input.receipt.transactionHash, 'identity_confirmation_wait_hash_changed');
  return confirmed;
}
function assertArkivComplete() {
  const raw = readFileSync(arkivReviewPath, 'utf8'), hash = sha(raw);
  const journal = decrypt<{ chainId: number; reviewSha256: string; entries: { id: string; state: string; entityKey?: string }[] }>(readFileSync(arkivJournalPath, 'utf8'), `meeti-demo-arkiv-journal-v1:${hash}`);
  const expected = ['job:demo-seeker', 'job:demo-recruiter', 'collaboration:demo-seeker', 'collaboration:demo-recruiter'];
  requireValue(journal.chainId === 7794095 && journal.reviewSha256 === hash && journal.entries.every(entry => entry.state === 'confirmed') && expected.every(id => journal.entries.some(entry => entry.id === id && /^0x[0-9a-f]{64}$/i.test(entry.entityKey ?? ''))), 'four_confirmed_arkiv_publications_required_before_identity_mutations');
}

async function main() {
  const mode = process.argv[2], arg = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  requireValue(['execute', 'reconcile', 'inspect'].includes(mode ?? ''), 'choose_identity_execute_reconcile_or_inspect');
  const reviewRaw = readFileSync(reviewPath, 'utf8'), reviewSha256 = sha(reviewRaw), review = JSON.parse(reviewRaw) as Review;
  requireValue(arg('review-sha256') === reviewSha256 && review.version === 1 && review.reviewOnly && review.fictional && review.humanVerified === false && review.chainId === 11155111 && review.owners.length === 2 && review.operations.length === 8 && review.funding.length === 0, 'exact_fictional_identity_review_required');
  const ids = review.owners.flatMap(owner => ['register-identity', 'publish-context', 'set-identity-uri', 'attest-association'].map(step => `${owner.label}-${step}`));
  requireValue(review.operations.every((op, i) => op.id === ids[i] && op.chainId === 11155111 && op.valueWei === '0' && op.maxGasCostWei === '500000000000000' && op.maxFeePerGas === '500000000' && op.maxPriorityFeePerGas === '10000000'), 'identity_review_operation_scope_mismatch');
  const context = `meeti-demo-agent-identity-journal-v1:${reviewSha256}`;
  const journal: Journal = existsSync(journalPath) ? decrypt<Journal>(readFileSync(journalPath, 'utf8'), context) : { version: 1, chainId: 11155111, reviewSha256, entries: [] };
  requireValue(journal.version === 1 && journal.chainId === 11155111 && journal.reviewSha256 === reviewSha256 && journal.entries.every((entry, i) => entry.id === ids[i]), 'identity_journal_is_not_approved_prefix');
  if (mode === 'inspect') { console.log(JSON.stringify({ reviewSha256, entries: journal.entries.map(({ id, state, hash, identity, receipt }) => ({ id, state, hash, identity, receipt })), signatures: 0, broadcasts: 0 })); return; }
  requireValue(process.argv.includes('--execute-reviewed'), 'explicit_identity_execution_flag_required');
  const approval = JSON.parse(readFileSync(approvalPath, 'utf8')) as { authorized: boolean; reviewSha256: string; chainId: number; approvedAt: string; totalCaps: Record<string, string> };
  requireValue(approval.authorized === true && approval.reviewSha256 === reviewSha256 && approval.chainId === 11155111 && Date.parse(approval.approvedAt) <= Date.now(), 'exact_identity_approval_required');
  requireValue(new Set(review.owners.map(owner => owner.owner.toLowerCase())).size === 2 && Object.keys(review.totalCaps).length === 2 && review.owners.every(owner => review.totalCaps[owner.owner] === '2000000000000000' && approval.totalCaps[owner.owner] === review.totalCaps[owner.owner]) && Object.keys(approval.totalCaps).length === 2, 'identity_owner_aggregate_cap_mismatch');
  if (mode === 'execute') assertIdentityAdmission(review);
  assertArkivComplete();
  const origin = new URL(process.env.APP_ORIGIN || 'http://127.0.0.1:3173').origin;
  requireValue(['127.0.0.1', 'localhost'].includes(new URL(origin).hostname) && new URL(origin).protocol === 'http:', 'identity_demo_local_http_origin_required');
  const saved = loadDemo(origin);
  mkdirSync('.local-data', { recursive: true }); const lockPath = '.local-data/demo-agent-identity-execution.lock', lock = openSync(lockPath, 'wx', 0o600);
  writeFileSync(lock, JSON.stringify({ pid: process.pid, reviewSha256 }));
  const rpcUrl = process.env.ENS_SEPOLIA_AUTH_RPC_URL || process.env.ENS_SEPOLIA_RPC_URL;
  let activeId = 'startup';
  try {
    requireValue(rpcUrl, 'identity_rpc_not_configured');
    const client = createPublicClient({ chain: sepolia, transport: createEnsReadTransport(rpcUrl) });
    const sender = mode === 'execute' ? createPublicClient({ chain: sepolia, transport: rpcUrl.startsWith('wss:') ? webSocket(rpcUrl, { reconnect: false, keepAlive: false, retryCount: 0 }) : http(rpcUrl, { retryCount: 0 }) }) : undefined;
    const ens = createEnsAuthorityProvider({ rpcUrl }), registry = createAgentIdentityProvider({ ens, rpcUrl });
    const accounts = new Map<string, ReturnType<typeof privateKeyToAccount>>();
    if (mode === 'execute') {
      const vault = decrypt<{ version: number; wallets: { label: Label; privateKey: Hex }[] }>(readFileSync('.local-data/demo-wallets.enc', 'utf8'), 'meeti-demo-wallets-v1');
      requireValue(vault.version === 1 && vault.wallets.length === 2, 'identity_owner_vault_invalid');
      for (const owner of review.owners) { const key = vault.wallets.find(wallet => wallet.label === owner.label); requireValue(key, 'identity_owner_key_missing'); const account = privateKeyToAccount(key.privateKey); requireValue(same(account.address, owner.owner), 'identity_owner_key_address_mismatch'); accounts.set(owner.label, account); }
    }
    function save() {
      const encrypted = encrypt(journal, context), temporary = `${journalPath}.tmp`; writeFileSync(temporary, encrypted, { mode: 0o600 });
      const fd = openSync(temporary, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); } renameSync(temporary, journalPath);
      requireValue(readFileSync(journalPath, 'utf8') === encrypted, 'identity_signed_journal_durable_readback_failed');
      mkdirSync('artifacts', { recursive: true }); writeFileSync('artifacts/demo-agent-identity-execution.json', JSON.stringify({ reviewSha256, chainId: 11155111, checkedAt: new Date().toISOString(), transactions: journal.entries.map(({ id, state, hash, identity, receipt }) => ({ id, state, hash, identity, receipt })), humanVerified: false }, null, 2));
    }
    async function freshChain() { const [chain, head] = await Promise.all([client.getChainId(), client.getBlock()]); requireValue(chain === 11155111 && Math.abs(Date.now() / 1000 - Number(head.timestamp)) < 90, 'identity_wrong_chain_or_stale_head'); return head; }
    async function scope(owner: DemoIdentityOwnerReview) {
      const state = await api<AppState>(saved, owner.label, 'state'), policy = review.checks.find(check => same(check.owner, owner.owner))?.currentAuthority;
      requireValue(state.user.id === saved.accounts[owner.label] && state.user.wallet && same(state.user.wallet, owner.owner) && state.agent && state.agent.ensName === owner.ensName && same(state.agent.owner, owner.owner) && same(state.agent.delegate, owner.delegate) && same(String(state.agent.config.resolverAddress), owner.resolver) && policy?.policyVersion === 2 && inlinePolicyDigest(state.agent.policy) === policy.policyDigest && JSON.stringify(state.agent.policy.allowedActions) === JSON.stringify(owner.publicContext.capabilities), 'identity_http_account_agent_or_policy_changed');
      const allowed = await ens.checkAuthority({ ensName: owner.ensName, owner: owner.owner, delegate: owner.delegate, action: 'discover', policyVersion: '2', policyDigest: policy.policyDigest }); requireValue(allowed.allowed, 'identity_current_ens_authority_denied');
    }
    async function expected(owner: DemoIdentityOwnerReview, operation: IdentityOperation) {
      if (operation.operation === 'register-identity') {
        const currentIdentity = await api<{ identity?: AgentRegistryIdentity }>(saved, owner.label, 'identity');
        const balance = await client.readContract({ address: ERC8004_SEPOLIA.registry, abi: parseAbi(['function balanceOf(address owner) view returns (uint256)']), functionName: 'balanceOf', args: [owner.owner] });
        requireValue(!currentIdentity.identity && balance === 0n, 'existing_identity_requires_recovery_not_duplicate_registration');
        const current = await registry.prepareTransaction({ operation: 'register-identity', ensName: owner.ensName, owner: owner.owner });
        requireValue(current.data === owner.registrationPrepared.data && same(current.from, owner.owner) && same(current.to, ERC8004_SEPOLIA.registry), 'identity_current_register_data_changed'); return { transaction: current, identity: undefined, context: undefined, document: undefined };
      }
      const registration = journal.entries.find(entry => entry.id === `${owner.label}-register-identity`); requireValue(registration?.state === 'confirmed' && registration.hash, 'identity_registration_not_confirmed');
      return prepareConditionalDemoAgentIdentityStep({ review: owner, registrationHash: registration.hash, operation: operation.operation, ens, identity: registry });
    }
    async function assertPendingQuote(owner: DemoIdentityOwnerReview, quote: IdentityQuote) {
      const pending = await api<{ id: string; state: string; data: Omit<IdentityQuote, 'operationId'> }[]>(saved, owner.label, 'operations');
      requireValue(pending.some(row => row.id === quote.operationId && row.state === 'prepared' && row.data.expiresAt === quote.expiresAt && row.data.maxFeeWei === quote.maxFeeWei && JSON.stringify(row.data.transaction) === JSON.stringify(quote.transaction)), 'identity_api_operation_changed_or_cancelled');
    }
    async function reconcile(entry: IdentityJournalEntry, operation: IdentityOperation, owner: DemoIdentityOwnerReview) {
      requireValue(entry.hash && entry.quote && entry.raw, 'identity_reconcile_signed_hash_required'); await assertIdentityRaw(entry, operation, owner);
      let receipt = await client.getTransactionReceipt({ hash: entry.hash }).catch(() => undefined);
      if (!receipt) { const known = await client.getTransaction({ hash: entry.hash }).catch(() => undefined); requireValue(known, 'identity_hash_unknown_no_rebroadcast_or_nonce_replacement'); receipt = await client.waitForTransactionReceipt({ hash: entry.hash, confirmations: 2, timeout: 90_000, pollingInterval: 3000 }); }
      receipt = await ensureIdentityReceiptDepth({ receipt, headNumber: (await freshChain()).number, wait: () => client.waitForTransactionReceipt({ hash: entry.hash!, confirmations: 2, timeout: 90_000, pollingInterval: 3000 }) });
      const [head, actual, block] = await Promise.all([freshChain(), client.getTransaction({ hash: entry.hash }), client.getBlock({ blockNumber: receipt.blockNumber })]);
      requireValue(receipt.status === 'success' && head.number >= receipt.blockNumber + 1n && block.hash === receipt.blockHash && same(actual.from, owner.owner) && actual.to && same(actual.to, operation.to) && actual.input === entry.quote.transaction.data && actual.value === 0n, 'identity_canonical_receipt_scope_mismatch');
      const fee = receipt.gasUsed * receipt.effectiveGasPrice; requireValue(fee <= BigInt(operation.maxGasCostWei), 'identity_confirmed_fee_cap_exceeded');
      const freshReceipt = { blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, actualFeeWei: fee.toString() };
      if (entry.receipt) requireValue(entry.receipt.blockHash === freshReceipt.blockHash && entry.receipt.blockNumber === freshReceipt.blockNumber, 'identity_prior_receipt_reorganized');
      if (!entry.receipt) { entry.receipt = freshReceipt; entry.state = 'mined'; save(); }
      if (!entry.apiSubmitted && Date.parse(entry.quote.expiresAt) > Date.now()) { await api(saved, entry.label, 'identity/submitted', { operationId: entry.quote.operationId, hash: entry.hash }); entry.apiSubmitted = true; save(); }
      const result = await api<{ confirmed: boolean; identity?: AgentRegistryIdentity }>(saved, entry.label, 'identity/confirm', { operationId: entry.quote.operationId, hash: entry.hash }); requireValue(result.confirmed, 'identity_application_confirmation_not_successful');
      if (operation.operation === 'register-identity') {
        const registered = await registry.confirmTransaction({ hash: entry.hash, prepared: owner.registrationPrepared }); requireValue(registered.identity && JSON.stringify(result.identity) === JSON.stringify(registered.identity), 'identity_application_tuple_does_not_match_canonical_event'); entry.identity = registered.identity;
      } else {
        const registration = journal.entries.find(item => item.id === `${owner.label}-register-identity`)!;
        const materialized = await prepareConditionalDemoAgentIdentityStep({ review: owner, registrationHash: registration.hash!, operation: operation.operation, ens, identity: registry });
        requireValue(materialized.transaction.data === entry.quote.transaction.data, 'identity_confirmed_data_not_current_reviewed_materialization');
        if (operation.operation === 'set-identity-uri') requireValue(await client.readContract({ address: ERC8004_SEPOLIA.registry, abi: identityRegistryAbi, functionName: 'tokenURI', args: [BigInt(materialized.identity.agentId)] }) === registrationDataUri(materialized.document), 'identity_current_uri_not_reviewed_document');
        if (operation.operation === 'attest-association') requireValue((await registry.verifyAssociation({ identity: materialized.identity, ensName: owner.ensName, owner: owner.owner })).verified, 'identity_final_registry_to_ens_association_unverified');
        entry.identity = materialized.identity;
      }
      const current = await api<{ identity?: AgentRegistryIdentity; context?: unknown; association?: { verified: boolean } }>(saved, entry.label, 'identity');
      requireValue(entry.identity && JSON.stringify(current.identity) === JSON.stringify(entry.identity), 'identity_http_tuple_not_persisted');
      if (operation.operation === 'publish-context') { const registration = journal.entries.find(item => item.id === `${owner.label}-register-identity`)!; const materialized = await prepareConditionalDemoAgentIdentityStep({ review: owner, registrationHash: registration.hash!, operation: 'publish-context', ens, identity: registry }); const records = await ens.readPublicAgentRecords({ ensName: owner.ensName, owner: owner.owner, keys: [AGENT_CONTEXT_KEY] }); requireValue(records.records[AGENT_CONTEXT_KEY] === JSON.stringify(materialized.context) && JSON.stringify(current.context) === JSON.stringify(materialized.context), 'identity_context_chain_or_http_readback_mismatch'); }
      if (operation.operation === 'attest-association') requireValue(current.association?.verified === true, 'identity_http_association_not_verified');
      if (entry.state !== 'confirmed') { entry.state = 'confirmed'; save(); }
      console.log(JSON.stringify({ id: entry.id, state: entry.state, hash: entry.hash, identity: entry.identity, receipt: entry.receipt }));
    }
    try {
      await freshChain(); requireValue((await registry.inspectDeployment()).verified, 'identity_pinned_deployment_not_verified');
      for (const operation of review.operations) {
        activeId = operation.id; const owner = review.owners.find(value => value.label === operation.label); requireValue(owner, 'unknown_identity_owner');
        let entry = journal.entries.find(value => value.id === operation.id);
        if (entry?.raw) {
          if (entry.state === 'confirmed' || entry.broadcastAttemptedAt || mode === 'reconcile') { await reconcile(entry, operation, owner); continue; }
        }
        if (mode === 'reconcile') continue;
        requireValue(operation.dependsOn.every(id => journal.entries.some(value => value.id === id && value.state === 'confirmed')), 'identity_prior_step_not_confirmed');
        await scope(owner); assertIdentityAdmission(review);
        const materialized = await expected(owner, operation);
        if (!entry) { const pending = await api<unknown[]>(saved, owner.label, 'operations'); requireValue(pending.length === 0, 'identity_other_application_operation_pending'); entry = { id: operation.id, label: operation.label, state: 'preparing' }; journal.entries.push(entry); save();
          entry.quote = await api<IdentityQuote>(saved, owner.label, 'identity/prepare', { operation: operation.operation, maxFeeWei: operation.maxGasCostWei, ...(operation.operation === 'publish-context' ? { name: owner.publicContext.name, description: owner.publicContext.description, publicApproved: true } : {}) }); entry.state = 'prepared'; save();
        } else if (!entry.quote) {
          const pending = await api<{ id: string; kind: string; state: string; data: Omit<IdentityQuote, 'operationId'> }[]>(saved, owner.label, 'operations');
          const matches = pending.filter(row => row.kind === 'identity' && row.state === 'prepared' && row.data.transaction?.data === materialized.transaction.data && same(row.data.transaction.from, owner.owner));
          requireValue(matches.length === 1, 'uncertain_identity_preparation_requires_exact_operation_recovery'); entry.quote = { ...matches[0].data, operationId: matches[0].id }; entry.state = 'prepared'; save();
        }
        const quote = entry.quote; requireValue(quote, 'identity_api_quote_missing');
        const fee = assertIdentityApiQuote({ quote, owner, operation, expected: materialized.transaction, reviewExpiresAt: review.reviewExpiresAt });
        const pending = await api<{ id: string; data: Omit<IdentityQuote, 'operationId'> }[]>(saved, owner.label, 'operations'); requireValue(pending.some(row => row.id === quote.operationId && JSON.stringify(row.data.transaction) === JSON.stringify(quote.transaction)), 'identity_api_operation_changed');
        const reserved = journal.entries.filter(value => value.label === owner.label && value.id !== entry!.id).reduce((sum, value) => sum + BigInt(value.reservedFeeWei ?? '0'), 0n); requireValue(reserved + fee.maximumFeeWei <= BigInt(review.totalCaps[owner.owner]), 'identity_aggregate_owner_fee_cap_exceeded');
        await scope(owner); assertIdentityAdmission({ reviewExpiresAt: review.reviewExpiresAt, quoteExpiresAt: quote.expiresAt });
        const [head, nonce, pendingNonce, estimate, price, balance] = await Promise.all([freshChain(), client.getTransactionCount({ address: owner.owner, blockTag: 'latest' }), client.getTransactionCount({ address: owner.owner, blockTag: 'pending' }), client.estimateGas({ account: owner.owner, to: quote.transaction.to, data: quote.transaction.data, value: 0n, gasPrice: fee.gasPrice }), client.getGasPrice(), client.getBalance({ address: owner.owner })]);
        requireValue(nonce === pendingNonce && estimate <= fee.gas && fee.gas <= head.gasLimit && price <= fee.gasPrice && balance >= fee.maximumFeeWei, 'identity_quote_nonce_gas_price_or_balance_changed');
        await assertPendingQuote(owner, quote);
        if (!entry.raw) { const account = accounts.get(owner.label); requireValue(account, 'identity_owner_signer_unavailable'); assertIdentityAdmission({ reviewExpiresAt: review.reviewExpiresAt, quoteExpiresAt: quote.expiresAt }); const raw = await account.signTransaction({ type: 'legacy', chainId: 11155111, nonce, to: quote.transaction.to, data: quote.transaction.data, value: 0n, gas: fee.gas, gasPrice: fee.gasPrice }); entry.raw = raw; entry.hash = keccak256(raw); entry.nonce = nonce; entry.reservedFeeWei = fee.maximumFeeWei.toString(); entry.state = 'signed'; save(); }
        requireValue(entry.nonce === nonce, 'identity_signed_nonce_changed_no_replacement'); await assertIdentityRaw(entry, operation, owner);
        await scope(owner); await freshChain(); await assertPendingQuote(owner, quote); assertIdentityAdmission({ reviewExpiresAt: review.reviewExpiresAt, quoteExpiresAt: quote.expiresAt });
        requireValue(sender, 'identity_reconcile_mode_cannot_broadcast'); await admitIdentityBroadcast(entry, review.reviewExpiresAt, save, raw => sender.sendRawTransaction({ serializedTransaction: raw }));
        await api(saved, owner.label, 'identity/submitted', { operationId: quote.operationId, hash: entry.hash }); entry.apiSubmitted = true; entry.state = 'submitted'; save();
        await reconcile(entry, operation, owner);
      }
    } finally { await Promise.all([ens.disconnect(), registry.disconnect()]); for (const rpc of [client, sender]) { const transport = rpc?.transport as { getRpcClient?: () => Promise<{ close(): void }> } | undefined; try { if (transport?.getRpcClient) (await transport.getRpcClient()).close(); } catch { /* Endpoint details remain private. */ } } }
  } catch (error) { console.error(JSON.stringify({ operation: activeId, outcome: 'stopped_preserve_journal_no_automatic_replacement' })); throw error; }
  finally { closeSync(lock); unlinkSync(lockPath); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main().catch(error => { console.error(error instanceof Error && /^[a-z][a-z0-9_]+$/.test(error.message) ? error.message : 'agent_identity_execution_stopped_no_secret_details_logged'); process.exitCode = 1; });

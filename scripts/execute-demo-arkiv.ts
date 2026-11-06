import assert from 'node:assert/strict';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { decodeFunctionData, getAddress, keccak256, parseAbi, parseTransaction, recoverTransactionAddress, verifyMessage, type Address, type Hex, type TransactionSerialized } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createArkivAdapter, intentDigest, intentSigningMessage, type PreparedArkivTransaction } from '../packages/arkiv/src';
import { decrypt, encrypt } from '../packages/server/crypto';
import { policyDigest } from '../packages/server/policy';
import type { AppState } from '../packages/shared/src';
import { APPROVAL_PATH, ArkivGuardError, CASES, FUND_AMOUNT, FUND_GAS_CAP, ISSUER, ISSUER_TOTAL_CAP, JOURNAL_PATH, LABELS, OWNER_FEE_CAP,
  REVIEW_PATH, api, clientFromEnv, loadDemo, minimumGas, requireCheck, same, sha256, validateReview, verifySdk, type Label, type Review } from './prepare-demo-arkiv';

type Envelope = { from: Address; to: Address; data: Hex; valueWei: string; nonce: number; gas: string; gasPrice: string; maximumFeeWei: string };
export type Entry = { id: string; kind: 'funding' | 'publication'; label: Label; state: 'message_signing' | 'message_signed' | 'preparing' | 'prepared' | 'signed' | 'broadcast_admitted' | 'submitted' | 'receipt_confirmed' | 'confirmed' | 'reverted';
  signature?: Hex; operationId?: string; prepared?: PreparedArkivTransaction; envelope?: Envelope; raw?: Hex; hash?: Hex;
  broadcastAttemptedAt?: string; balanceObservation?: { checkedAt: string; balanceWei: string | null; status: 'observed' | 'unavailable' };
  receipt?: { blockNumber: string; blockHash: Hex; actualFeeWei: string }; entityKey?: Hex };
type Journal = { version: 1; chainId: 7794095; reviewSha256: string; entries: Entry[];
  archivedPreparations?: { id: string; operationId: string; prepared: PreparedArkivTransaction; archivedAt: string; state: 'cancel_requested' | 'cancel_confirmed'; reason: 'explicit_never_signed_refresh' }[] };
const approvalSchema = z.object({ authorized: z.literal(true), reviewSha256: z.string().regex(/^[a-f0-9]{64}$/), chainId: z.literal(7794095), approvedAt: z.string().datetime(),
  issuerMaximumFundsAndGasWei: z.literal('50000000000000000'), maximumPublicationFeePerOwnerWei: z.literal('10000000000000000'), fundingWeiPerOwner: z.literal('20000000000000000') }).strict();
const native = getAddress('0x4400000000000000000000000000000000000044');
const executeAbi = parseAbi(['function execute((uint8 operation, bytes operationData)[] ops) external returns (bytes32[] keys)']);
const arg = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);

export function reservedFee(entry: Pick<Entry, 'receipt' | 'envelope' | 'prepared'>): bigint {
  return BigInt(entry.receipt?.actualFeeWei ?? entry.envelope?.maximumFeeWei ?? entry.prepared?.maximumFeeWei ?? '0');
}
export function publicationRemaining(journal: Journal, label: Label, excludeId?: string): bigint {
  return OWNER_FEE_CAP - journal.entries.filter(entry => entry.kind === 'publication' && entry.label === label && entry.id !== excludeId).reduce((sum, entry) => sum + reservedFee(entry), 0n);
}
export function issuerRemaining(journal: Journal, excludeId?: string): bigint {
  return ISSUER_TOTAL_CAP - journal.entries.filter(entry => entry.kind === 'funding' && entry.id !== excludeId).reduce((sum, entry) => sum + FUND_AMOUNT + reservedFee(entry), 0n);
}
function safeError(error: unknown) { return error instanceof ArkivGuardError ? error.message : 'demo_arkiv_execution_stopped_preserve_journal_no_retry'; }

export function assertAdmissionDeadline(input: { kind: Entry['kind']; reviewExpiresAt: string; quoteExpiresAt?: string }, now = Date.now()) {
  requireCheck(Number.isFinite(Date.parse(input.reviewExpiresAt)) && Date.parse(input.reviewExpiresAt) > now, 'review_expired_no_new_signature_or_broadcast');
  if (input.kind === 'publication') requireCheck(input.quoteExpiresAt && Number.isFinite(Date.parse(input.quoteExpiresAt))
    && Date.parse(input.quoteExpiresAt) > now, 'publication_quote_expired_no_signature_or_broadcast');
}
export async function signWithFreshAdmission(input: { kind: Entry['kind']; reviewExpiresAt: string; quoteExpiresAt?: string;
  refreshEns: () => Promise<void>; refreshRabdi: () => Promise<void>; sign: () => Promise<Hex>; now?: () => number }): Promise<Hex> {
  await input.refreshEns(); assertAdmissionDeadline(input, input.now?.() ?? Date.now());
  await input.refreshRabdi(); assertAdmissionDeadline(input, input.now?.() ?? Date.now());
  return input.sign();
}
export async function broadcastOnce(entry: Entry, reviewExpiresAt: string, save: () => void, send: (raw: Hex) => Promise<Hex>, now: () => number = Date.now) {
  requireCheck(entry.state === 'signed' && entry.raw && entry.hash && !entry.broadcastAttemptedAt, 'known_or_uncertain_submission_cannot_be_broadcast_again');
  requireCheck(keccak256(entry.raw) === entry.hash, 'signed_hash_mismatch_before_admission');
  const deadline = { kind: entry.kind, reviewExpiresAt, quoteExpiresAt: entry.prepared?.expiresAt };
  assertAdmissionDeadline(deadline, now());
  entry.state = 'broadcast_admitted'; entry.broadcastAttemptedAt = new Date(now()).toISOString(); save();
  assertAdmissionDeadline(deadline, now());
  const hash = await send(entry.raw);
  requireCheck(hash === entry.hash, 'returned_transaction_hash_mismatch_preserve_journal'); entry.state = 'submitted'; save();
}
export function checkpointCanonicalReceipt(entry: Entry, receipt: NonNullable<Entry['receipt']>) {
  entry.receipt = receipt;
  if (entry.state !== 'confirmed') entry.state = 'receipt_confirmed';
}
export async function observeFundingBalance(entry: Entry, readBalance: () => Promise<bigint>, now = Date.now()) {
  requireCheck(entry.kind === 'funding' && entry.receipt && ['receipt_confirmed', 'confirmed'].includes(entry.state), 'canonical_funding_receipt_required_for_balance_observation');
  try { entry.balanceObservation = { checkedAt: new Date(now).toISOString(), balanceWei: (await readBalance()).toString(), status: 'observed' }; }
  catch { entry.balanceObservation = { checkedAt: new Date(now).toISOString(), balanceWei: null, status: 'unavailable' }; }
}
export function assertNeverSignedRefresh(entry: Entry) {
  requireCheck(entry.kind === 'publication' && entry.signature && !entry.raw && !entry.hash && !entry.broadcastAttemptedAt
    && ['message_signed', 'preparing', 'prepared'].includes(entry.state), 'refresh_requires_definitively_never_signed_or_admitted_preparation');
}

async function main() {
  const mode = process.argv[2];
  if (mode === '--self-check') {
    const journal: Journal = { version: 1, chainId: 7794095, reviewSha256: 'fixture-only', entries: [
      { id: 'job:demo-seeker', kind: 'publication', label: 'demo-seeker', state: 'receipt_confirmed', receipt: { blockNumber: '1', blockHash: `0x${'11'.repeat(32)}`, actualFeeWei: '3000000000000000' } },
      { id: 'collaboration:demo-seeker', kind: 'publication', label: 'demo-seeker', state: 'prepared', envelope: { from: ISSUER, to: native, data: '0x', valueWei: '0', nonce: 0, gas: '1', gasPrice: '1', maximumFeeWei: '4000000000000000' } },
      { id: 'job:demo-recruiter', kind: 'publication', label: 'demo-recruiter', state: 'receipt_confirmed', receipt: { blockNumber: '2', blockHash: `0x${'22'.repeat(32)}`, actualFeeWei: '1000000000000000' } },
      { id: 'fund:demo-seeker', kind: 'funding', label: 'demo-seeker', state: 'receipt_confirmed', receipt: { blockNumber: '3', blockHash: `0x${'33'.repeat(32)}`, actualFeeWei: '1000000000000000' } },
    ] };
    assert.equal(publicationRemaining(journal, 'demo-seeker'), 3_000_000_000_000_000n);
    assert.equal(publicationRemaining(journal, 'demo-recruiter'), 9_000_000_000_000_000n);
    assert.equal(publicationRemaining(journal, 'demo-seeker', 'collaboration:demo-seeker'), 7_000_000_000_000_000n);
    assert.equal(issuerRemaining(journal), 29_000_000_000_000_000n);
    assert.equal(issuerRemaining(journal, 'fund:demo-seeker'), ISSUER_TOTAL_CAP);
    assert.equal(reservedFee({ receipt: journal.entries[0].receipt, envelope: journal.entries[1].envelope }), 3_000_000_000_000_000n);
    assert.equal(approvalSchema.safeParse({ authorized: false }).success, false);
    assert.equal(approvalSchema.safeParse({ authorized: true, reviewSha256: 'a'.repeat(64), chainId: 1, approvedAt: new Date().toISOString(),
      issuerMaximumFundsAndGasWei: ISSUER_TOTAL_CAP.toString(), maximumPublicationFeePerOwnerWei: OWNER_FEE_CAP.toString(), fundingWeiPerOwner: FUND_AMOUNT.toString() }).success, false);
    console.log(JSON.stringify({ offlineChecks: 8, passed: true, fixtureArithmeticOnly: true, signatures: 0, providerCalls: 0, chainWrites: 0 })); return;
  }
  requireCheck(['fund', 'publish', 'reconcile', 'inspect', 'refresh-unsubmitted'].includes(mode || ''), 'choose_fund_publish_reconcile_inspect_or_explicit_refresh');
  const reviewRaw = readFileSync(REVIEW_PATH, 'utf8'), reviewSha256 = sha256(reviewRaw), review = validateReview(JSON.parse(reviewRaw));
  requireCheck(arg('review-sha256') === reviewSha256, 'exact_review_sha256_required');
  const context = `meeti-demo-arkiv-journal-v1:${reviewSha256}`;
  const journal: Journal = existsSync(JOURNAL_PATH) ? decrypt<Journal>(readFileSync(JOURNAL_PATH, 'utf8'), context) : { version: 1, chainId: 7794095, reviewSha256, entries: [] };
  requireCheck(journal.version === 1 && journal.chainId === 7794095 && journal.reviewSha256 === reviewSha256 && Array.isArray(journal.entries)
    && new Set(journal.entries.map(entry => entry.id)).size === journal.entries.length, 'encrypted_journal_scope_mismatch');
  if (mode === 'inspect') {
    console.log(JSON.stringify({ reviewSha256, chainId: 7794095, entries: journal.entries.map(({ id, state, hash, entityKey, receipt }) => ({ id, state, hash, entityKey, receipt })),
      ownerFeeRemainingWei: Object.fromEntries(LABELS.map(label => [label, publicationRemaining(journal, label).toString()])), issuerRemainingWei: issuerRemaining(journal).toString() }, null, 2)); return;
  }
  // Approval and immutable scope checks precede vault/key access or any writable RPC.
  requireCheck(process.argv.includes('--execute-reviewed'), 'explicit_reviewed_execution_flag_required');
  const approval = approvalSchema.parse(JSON.parse(readFileSync(APPROVAL_PATH, 'utf8')));
  requireCheck(approval.reviewSha256 === reviewSha256 && Date.parse(approval.approvedAt) >= Date.parse(review.createdAt) && Date.parse(approval.approvedAt) <= Date.now(), 'exact_current_local_approval_required');
  verifySdk();
  const configuredOrigin = new URL(process.env.APP_ORIGIN || 'http://127.0.0.1:3173').origin;
  requireCheck(configuredOrigin === review.origin, 'approved_application_origin_changed');
  const saved = loadDemo(review.origin), client = clientFromEnv();
  mkdirSync('.local-data', { recursive: true }); const lockPath = '.local-data/demo-arkiv-execution.lock';
  const lock = openSync(lockPath, 'wx', 0o600);
  try {
    function save() {
      const ciphertext = encrypt(journal, context), temporary = `${JOURNAL_PATH}.tmp`;
      writeFileSync(temporary, ciphertext, { mode: 0o600 }); const fd = openSync(temporary, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, JOURNAL_PATH); requireCheck(readFileSync(JOURNAL_PATH, 'utf8') === ciphertext, 'durable_journal_readback_failed');
    }
    function deadline() { requireCheck(Date.parse(review.reviewExpiresAt) > Date.now(), 'review_expired_no_new_signature_or_broadcast'); }
    async function freshChain() {
      const [chainId, head, genesis] = await Promise.all([client.getChainId(), client.getBlock({ blockTag: 'latest' }), client.getBlock({ blockNumber: 0n })]);
      requireCheck(chainId === 7794095 && genesis.hash === review.genesisHash && Math.abs(Date.now() / 1000 - Number(head.timestamp)) < 90, 'wrong_chain_genesis_or_stale_head'); return head;
    }
    async function freshScope(record: Review['records'][number], draft: boolean) {
      const state = await api<AppState>(saved, record.label, 'state'), agent = state.agent;
      requireCheck(state.user.id === record.accountId && state.user.id === saved.accounts[record.label] && state.user.wallet && same(state.user.wallet, record.intent.owner)
        && agent && same(agent.owner, record.ens.owner) && same(agent.delegate, record.ens.delegate) && agent.ensName === record.ens.ensName
        && String(agent.config.resolverAddress).toLowerCase() === record.ens.resolver.toLowerCase() && policyDigest(agent.policy) === record.ens.policyDigest
        && agent.policy.version === record.intent.policyVersion, 'current_authenticated_owner_or_ens_policy_changed');
      const intent = state.intents.find(value => value.id === record.intent.intentId);
      requireCheck(intent && intent.version === record.intent.version && (!draft || intent.status === 'draft'), 'current_intent_version_or_status_changed');
      if (draft) {
        const preview = await api<{ intent: unknown; signingMessage: string }>(saved, record.label, 'intent/publish', { intentId: record.intent.intentId });
        requireCheck(preview.signingMessage === record.signingMessage && intentDigest(preview.intent) === record.payloadDigest, 'fresh_public_preview_changed');
      } else await api(saved, record.label, 'agent/check', {});
      return intent;
    }
    function recordFor(entry: Entry) { return review.records.find(record => record.id === entry.id); }
    async function verifyRaw(entry: Entry) {
      requireCheck(entry.raw && entry.hash && entry.envelope, 'signed_bytes_and_envelope_required');
      const tx = parseTransaction(entry.raw), envelope = entry.envelope;
      requireCheck(keccak256(entry.raw) === entry.hash && tx.chainId === 7794095 && tx.type === 'legacy'
        && tx.to && same(tx.to, envelope.to) && same(tx.data || '0x', envelope.data) && (tx.value || 0n).toString() === envelope.valueWei
        && tx.nonce === envelope.nonce && tx.gas?.toString() === envelope.gas && tx.gasPrice?.toString() === envelope.gasPrice
        && BigInt(envelope.gas) * BigInt(envelope.gasPrice) === BigInt(envelope.maximumFeeWei)
        && same(await recoverTransactionAddress({ serializedTransaction: entry.raw as TransactionSerialized }), envelope.from), 'journal_signed_transaction_mismatch');
      if (entry.kind === 'funding') {
        const funding = review.funding.find(value => value.id === entry.id);
        requireCheck(funding && funding.label === entry.label && same(envelope.from, ISSUER) && same(envelope.to, funding.to) && envelope.data === '0x'
          && envelope.valueWei === funding.valueWei && envelope.gas === funding.gasLimit && BigInt(envelope.gasPrice) <= BigInt(funding.maximumGasPriceWei)
          && BigInt(envelope.maximumFeeWei) <= FUND_GAS_CAP && FUND_AMOUNT + BigInt(envelope.maximumFeeWei) <= issuerRemaining(journal, entry.id), 'signed_funding_scope_or_cap_mismatch');
      } else {
        const record = recordFor(entry), prepared = entry.prepared;
        requireCheck(record && prepared && same(envelope.from, record.intent.owner) && same(envelope.to, native) && envelope.valueWei === '0'
          && prepared.request.data === envelope.data && BigInt(prepared.request.gas).toString() === envelope.gas && BigInt(prepared.request.gasPrice).toString() === envelope.gasPrice
          && Number(BigInt(prepared.request.nonce)) === envelope.nonce && intentDigest(prepared.intent) === record.payloadDigest
          && BigInt(envelope.maximumFeeWei) <= publicationRemaining(journal, entry.label, entry.id), 'signed_publication_scope_or_cap_mismatch');
      }
    }
    async function reconcile(entry: Entry) {
      await verifyRaw(entry); await freshChain();
      requireCheck(entry.hash, 'known_hash_required_no_replacement');
      const receipt = await client.waitForTransactionReceipt({ hash: entry.hash, confirmations: 2, timeout: 90000, pollingInterval: 3000 });
      const actual = await client.getTransaction({ hash: entry.hash }), envelope = entry.envelope!;
      requireCheck(receipt.transactionHash === entry.hash && actual.hash === entry.hash && same(actual.from, envelope.from) && actual.to && same(actual.to, envelope.to)
        && same(actual.input, envelope.data) && actual.value.toString() === envelope.valueWei && actual.nonce === envelope.nonce
        && actual.gas.toString() === envelope.gas && actual.gasPrice?.toString() === envelope.gasPrice, 'receipt_does_not_authenticate_exact_signed_transaction');
      const actualFee = receipt.gasUsed * receipt.effectiveGasPrice;
      requireCheck(actualFee <= BigInt(envelope.maximumFeeWei), 'receipt_exceeds_reserved_fee');
      const verifiedReceipt = { blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, actualFeeWei: actualFee.toString() };
      if (receipt.status !== 'success') { entry.receipt = verifiedReceipt; entry.state = 'reverted'; save(); throw new ArkivGuardError('authoritative_revert_no_automatic_retry'); }
      const head = await freshChain(), canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
      requireCheck(head.number >= receipt.blockNumber + 1n && canonical.hash === receipt.blockHash, 'canonical_second_confirmation_required');
      checkpointCanonicalReceipt(entry, verifiedReceipt); save();
      if (entry.kind === 'funding') {
        await observeFundingBalance(entry, () => client.getBalance({ address: envelope.to, blockTag: 'latest' }));
      } else {
        const record = recordFor(entry)!; requireCheck(entry.operationId && entry.prepared, 'application_preparation_required');
        const current = await freshScope(record, false);
        if (current.status !== 'published') {
          await api(saved, entry.label, `operations/${entry.operationId}/submitted`, { transactionHash: entry.hash });
          await api(saved, entry.label, 'intent/confirm', { intentId: record.intent.intentId, operationId: entry.operationId, txHash: entry.hash });
        }
        const state = await api<AppState>(saved, entry.label, 'state'), published = state.intents.find(value => value.id === record.intent.intentId);
        requireCheck(published?.status === 'published' && published.version === record.intent.version && published.transactionHash === entry.hash && published.arkivKey, 'application_did_not_confirm_exact_publication');
        const readback = await createArkivAdapter({ accessKey: process.env.ARKIV_ACCESS_KEY! }).verifyPublished({ entityKey: published.arkivKey, txHash: entry.hash, expectedIntent: record.intent, expectedTransaction: entry.prepared.request });
        requireCheck(intentDigest(readback.intent) === record.payloadDigest, 'sdk_publication_readback_changed'); entry.entityKey = readback.entityKey;
      }
      entry.state = 'confirmed'; save();
      console.log(JSON.stringify({ id: entry.id, state: entry.state, chainId: 7794095, hash: entry.hash, entityKey: entry.entityKey, receipt: entry.receipt, balanceObservation: entry.balanceObservation }));
    }
    const id = arg('id'); requireCheck(id, 'explicit_reviewed_operation_id_required');
    if (mode === 'reconcile') { const entry = journal.entries.find(value => value.id === id); requireCheck(entry?.raw && entry.hash, 'known_signed_hash_required_reconciliation_never_broadcasts'); await reconcile(entry); return; }
    if (mode === 'refresh-unsubmitted') {
      requireCheck(process.argv.includes('--confirmed-no-transaction-signature'), 'explicit_never_signed_refresh_confirmation_required');
      const entry = journal.entries.find(value => value.id === id); requireCheck(entry, 'existing_preparation_required'); assertNeverSignedRefresh(entry);
      const record = recordFor(entry); requireCheck(record, 'same_reviewed_record_required_for_refresh'); await freshScope(record, true);
      requireCheck(await verifyMessage({ address: getAddress(record.intent.owner), message: record.signingMessage, signature: entry.signature! }), 'frozen_public_signature_changed');
      const operations = await api<{ id: string; kind: string; state: string; data: { intent?: unknown; transaction?: PreparedArkivTransaction } }[]>(saved, record.label, 'operations');
      const matching = operations.filter(value => value.kind === `arkiv:${record.intent.intentId}:${record.intent.version}` && value.data.intent && intentDigest(value.data.intent) === record.payloadDigest);
      requireCheck(matching.length === 1 && matching[0].state === 'prepared' && matching[0].data.transaction
        && (!entry.operationId || entry.operationId === matching[0].id) && (!entry.prepared || JSON.stringify(entry.prepared) === JSON.stringify(matching[0].data.transaction)), 'exact_never_submitted_application_operation_required');
      const old = matching[0].data.transaction, owner = getAddress(record.intent.owner);
      const [nonce, pending] = await Promise.all([client.getTransactionCount({ address: owner, blockTag: 'latest' }), client.getTransactionCount({ address: owner, blockTag: 'pending' })]);
      requireCheck(nonce === pending && nonce === Number(BigInt(old.request.nonce)) && intentDigest(old.intent) === record.payloadDigest, 'nonce_or_frozen_payload_changed_no_refresh');
      const archived = { id, operationId: matching[0].id, prepared: old, archivedAt: new Date().toISOString(), state: 'cancel_requested' as const, reason: 'explicit_never_signed_refresh' as const };
      (journal.archivedPreparations ||= []).push(archived); save();
      await api(saved, record.label, `operations/${matching[0].id}/cancel`, { confirmation: 'NOT_SUBMITTED' });
      journal.archivedPreparations[journal.archivedPreparations.length - 1].state = 'cancel_confirmed';
      delete entry.prepared; delete entry.operationId; delete entry.envelope; entry.state = 'message_signed'; save();
      console.log(JSON.stringify({ id, oldOperationId: matching[0].id, refreshed: false, cancelledNeverSignedPreparation: true,
        next: 'Run a separate explicitly approved publish invocation for the same frozen payload and remaining fee cap. No signature or broadcast occurred in this mode.' })); return;
    }
    deadline();
    const existing = journal.entries.find(value => value.id === id);
    requireCheck(!existing || existing.state !== 'confirmed', 'operation_already_confirmed_no_repeat');
    requireCheck(!existing?.raw && !existing?.hash, 'signed_or_unknown_operation_requires_reconcile_without_resend');
    requireCheck(journal.entries.every(entry => entry.id === id || entry.state === 'confirmed'), 'reconcile_previous_operation_before_another');
    const vault = decrypt<{ version: number; wallets: { label: string; privateKey: Hex }[] }>(readFileSync('.local-data/demo-wallets.enc', 'utf8'), 'meeti-demo-wallets-v1');
    requireCheck(vault.version === 1 && vault.wallets.length === 2, 'two_generated_test_wallets_required');
    let entry = existing, account: ReturnType<typeof privateKeyToAccount>, envelope: Envelope;
    if (mode === 'fund') {
      const funding = review.funding.find(value => value.id === id); requireCheck(funding, 'reviewed_funding_id_required');
      const keyName = arg('issuer-key-env'); requireCheck(keyName && /^[A-Z][A-Z0-9_]+$/.test(keyName), 'explicit_local_issuer_key_variable_required');
      const key = process.env[keyName]; requireCheck(key && /^0x[0-9a-fA-F]{64}$/.test(key), 'issuer_key_not_configured');
      account = privateKeyToAccount(key as Hex); requireCheck(same(account.address, ISSUER), 'issuer_key_address_mismatch');
      const recipient = vault.wallets.find(wallet => wallet.label === funding.label); requireCheck(recipient && same(privateKeyToAccount(recipient.privateKey).address, funding.to), 'funding_target_is_not_generated_demo_owner');
      const head = await freshChain(), [nonce, pending, price, estimate, balance, targetBalance] = await Promise.all([
        client.getTransactionCount({ address: ISSUER, blockTag: 'latest' }), client.getTransactionCount({ address: ISSUER, blockTag: 'pending' }), client.getGasPrice(),
        client.estimateGas({ account: ISSUER, to: getAddress(funding.to), data: '0x', value: FUND_AMOUNT, blockTag: 'latest' }),
        client.getBalance({ address: ISSUER, blockTag: 'latest' }), client.getBalance({ address: getAddress(funding.to), blockTag: 'latest' })]);
      const gas = BigInt(funding.gasLimit), fee = gas * price;
      requireCheck(nonce === pending && targetBalance === 0n && gas >= minimumGas(estimate, head.gasLimit) && gas <= head.gasLimit / 2n && price <= BigInt(funding.maximumGasPriceWei)
        && fee <= FUND_GAS_CAP && FUND_AMOUNT + fee <= issuerRemaining(journal, id) && balance >= FUND_AMOUNT + fee, 'fresh_funding_nonce_balance_gas_or_budget_failed');
      envelope = { from: ISSUER, to: getAddress(funding.to), data: '0x', valueWei: FUND_AMOUNT.toString(), nonce, gas: gas.toString(), gasPrice: price.toString(), maximumFeeWei: fee.toString() };
      entry ||= { id, label: funding.label, kind: 'funding', state: 'prepared' };
    } else {
      const record = review.records.find(value => value.id === id); requireCheck(record && CASES.some(category => id === `${category}:${record.label}`), 'reviewed_publication_id_required');
      const wallet = vault.wallets.find(value => value.label === record.label); requireCheck(wallet, 'generated_owner_key_missing');
      account = privateKeyToAccount(wallet.privateKey); requireCheck(same(account.address, record.intent.owner), 'generated_owner_key_address_mismatch');
      await freshScope(record, true);
      if (!entry) {
        entry = { id, label: record.label, kind: 'publication', state: 'message_signing' }; journal.entries.push(entry); save();
        deadline();
        entry.signature = await account.signMessage({ message: record.signingMessage }); entry.state = 'message_signed'; save();
      }
      requireCheck(entry.signature && entry.kind === 'publication' && entry.label === record.label, 'durable_public_message_signature_required');
      requireCheck(await verifyMessage({ address: account.address, message: intentSigningMessage(record.intent), signature: entry.signature }), 'durable_public_signature_does_not_match_approved_payload');
      if (!entry.prepared) {
        if (entry.state === 'preparing') {
          const operations = await api<{ id: string; kind: string; state: string; data: { intent?: unknown; transaction?: PreparedArkivTransaction } }[]>(saved, record.label, 'operations');
          const matching = operations.filter(value => value.kind === `arkiv:${record.intent.intentId}:${record.intent.version}` && value.data.intent && intentDigest(value.data.intent) === record.payloadDigest);
          requireCheck(matching.length === 1 && matching[0].state === 'prepared' && matching[0].data.transaction, 'uncertain_preparation_requires_exact_application_operation');
          entry.operationId = matching[0].id; entry.prepared = matching[0].data.transaction;
        } else {
          requireCheck(entry.state === 'message_signed', 'public_signature_admission_unknown_stop'); entry.state = 'preparing'; save();
          const prepared = await api<{ operationId: string; transaction: PreparedArkivTransaction }>(saved, record.label, 'intent/publish', { intentId: record.intent.intentId, signature: entry.signature, maxFeeWei: publicationRemaining(journal, record.label, id).toString() });
          entry.operationId = prepared.operationId; entry.prepared = prepared.transaction;
        }
        entry.state = 'prepared'; save();
      }
      const prepared = entry.prepared, request = prepared.request;
      requireCheck(prepared.chainId === 7794095 && request.chainId === '0x76edaf' && request.type === '0x0' && request.value === '0x0'
        && same(request.from, account.address) && same(request.to, native) && prepared.payloadDigest === record.payloadDigest && intentDigest(prepared.intent) === record.payloadDigest
        && Date.parse(prepared.expiresAt) > Date.now(), 'prepared_publication_scope_or_quote_expired');
      const operations = await api<{ id: string; data: { transaction?: PreparedArkivTransaction } }[]>(saved, record.label, 'operations');
      requireCheck(JSON.stringify(operations.find(value => value.id === entry!.operationId)?.data.transaction) === JSON.stringify(prepared), 'prepared_operation_changed');
      const decoded = decodeFunctionData({ abi: executeAbi, data: request.data });
      requireCheck(decoded.functionName === 'execute' && decoded.args[0].length === 1 && decoded.args[0][0].operation === 1, 'only_one_native_create_allowed');
      const gas = BigInt(request.gas), price = BigInt(request.gasPrice), fee = gas * price;
      requireCheck(gas >= 1_000_000n && price > 0n && fee === BigInt(prepared.maximumFeeWei) && fee <= publicationRemaining(journal, record.label, id), 'prepared_publication_gas_or_budget_failed');
      envelope = { from: account.address, to: native, data: request.data, valueWei: '0', nonce: Number(BigInt(request.nonce)), gas: gas.toString(), gasPrice: price.toString(), maximumFeeWei: fee.toString() };
    }
    entry.envelope = envelope; entry.state = 'prepared'; if (!journal.entries.includes(entry)) journal.entries.push(entry); save();
    const active = entry;
    const raw = await signWithFreshAdmission({ kind: active.kind, reviewExpiresAt: review.reviewExpiresAt, quoteExpiresAt: active.prepared?.expiresAt,
      refreshEns: async () => { if (active.kind === 'publication') await freshScope(recordFor(active)!, true); },
      refreshRabdi: async () => {
        const head = await freshChain();
        const [nonce, pending, price, estimate, balance] = await Promise.all([client.getTransactionCount({ address: account.address, blockTag: 'latest' }),
          client.getTransactionCount({ address: account.address, blockTag: 'pending' }), client.getGasPrice(),
          client.estimateGas({ account: account.address, to: envelope.to, data: envelope.data, value: BigInt(envelope.valueWei), blockTag: 'latest' }),
          client.getBalance({ address: account.address, blockTag: 'latest' })]);
        requireCheck(Number.isSafeInteger(nonce) && nonce >= 0 && nonce === envelope.nonce && pending === nonce && price.toString() === envelope.gasPrice
          && BigInt(envelope.gas) >= minimumGas(estimate, head.gasLimit) && BigInt(envelope.gas) <= head.gasLimit / 2n
          && balance >= BigInt(envelope.valueWei) + BigInt(envelope.maximumFeeWei), 'nonce_price_gas_or_balance_changed_before_signature');
      },
      sign: () => account.signTransaction({ chainId: 7794095, type: 'legacy', nonce: envelope.nonce, to: envelope.to, data: envelope.data, value: BigInt(envelope.valueWei), gas: BigInt(envelope.gas), gasPrice: BigInt(envelope.gasPrice) }),
    });
    entry.raw = raw; entry.hash = keccak256(raw); entry.state = 'signed'; await verifyRaw(entry); save();
    await broadcastOnce(entry, review.reviewExpiresAt, save, serializedTransaction => client.sendRawTransaction({ serializedTransaction }));
    console.log(JSON.stringify({ id: entry.id, state: 'submitted', chainId: 7794095, hash: entry.hash })); await reconcile(entry);
  } finally { closeSync(lock); rmSync(lockPath); }
}
if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) await main().catch(error => { console.error(safeError(error)); process.exitCode = 1; });

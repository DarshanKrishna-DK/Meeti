import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeFunctionData, keccak256, parseAbi, parseTransaction, recoverTransactionAddress, verifyMessage, type Hex, type TransactionSerialized } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { createEnsAuthorityProvider } from '../packages/ens';
import { createArkivAdapter, canonicalIntent, intentDigest, intentSigningMessage, type PublicIntent, type PreparedArkivTransaction } from '../packages/arkiv/src';
import { decrypt, encrypt } from '../packages/server/crypto';
import type { AppState, Intent } from '../packages/shared/src';
import { api, loadDemo, clientFromEnv, verifySdk, minimumGas, requireCheck, same, sha256, REVIEW_PATH as originalReviewPath, JOURNAL_PATH as originalJournalPath, validateReview } from './prepare-demo-arkiv';
import { assertAdmissionDeadline, broadcastOnce, signWithFreshAdmission, type Entry } from './execute-demo-arkiv';

export const correctionQuote = 'I would like a collaborator who writes learning guides.';
const cap = '1000000000000000', label = 'demo-recruiter' as const;
const reviewPath = 'artifacts/demo-intent-revision-review.json', progressPath = '.local-data/demo-intent-revision-progress.enc', approvalPath = '.local-data/demo-intent-revision-approval.json', journalPath = '.local-data/demo-intent-revision-journal.enc';
type Original = ReturnType<typeof validateReview>;
type Revision = { version: 1; fictional: true; humanVerified: false; chainId: 7794095; origin: string; checkedAt: string; reviewExpiresAt: string; originalReviewSha256: string; originalJournalSha256: string;
  previousEntityKey: Hex; previousTransactionHash: Hex; previous: PublicIntent; intent: PublicIntent; payloadDigest: Hex; signingMessage: string; maximumFeeWei: string; genesisHash: Hex; accountId: string; ens: Original['records'][number]['ens']; diff: unknown[] };
export function correctedIntent(previous: PublicIntent, createdAt: string): PublicIntent {
  requireCheck(previous.version === 1 && previous.demoOrigin && previous.status === 'active', 'only_original_active_fictional_revision_one_allowed');
  const next = structuredClone(previous), selected = next.semantics.requirements.filter(value => value.sourceQuote === correctionQuote && value.strength === 'mandatory');
  requireCheck(selected.length === 1, 'exact_single_owner_correction_required'); selected[0].strength = 'preferred'; next.version = 2; next.createdAt = createdAt;
  return canonicalIntent(next);
}
export function assertOnlyReviewedRevision(previous: PublicIntent, next: PublicIntent) {
  requireCheck(Date.parse(next.createdAt) > Date.parse(previous.createdAt) && Date.parse(next.createdAt) < Date.parse(previous.expiresAt), 'revision_timestamp_invalid');
  requireCheck(intentDigest(correctedIntent(previous, next.createdAt)) === intentDigest(next), 'revision_contains_unapproved_delta');
}
export function assertRevisionApproval(reviewHash: string, approval: { authorized: boolean; reviewSha256: string; chainId: number; maximumFeeWei: string; approvedAt: string }, now = Date.now()) {
  requireCheck(approval.authorized === true && approval.reviewSha256 === reviewHash && approval.chainId === 7794095 && approval.maximumFeeWei === cap && Number.isFinite(Date.parse(approval.approvedAt)) && Date.parse(approval.approvedAt) <= now, 'exact_revision_approval_required');
}
function durable(path: string, value: unknown, context: string) {
  mkdirSync('.local-data', { recursive: true }); const raw = encrypt(value, context); writeFileSync(`${path}.tmp`, raw, { mode: 0o600 });
  const fd = openSync(`${path}.tmp`, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); } renameSync(`${path}.tmp`, path);
  requireCheck(readFileSync(path, 'utf8') === raw, 'revision_journal_durable_readback_failed');
}
export function acquireRevisionLock(path: string, metadata: { mode: string; originalReviewSha256: string; revisionReviewSha256: string | null }): () => void {
  mkdirSync(dirname(path), { recursive: true });
  const descriptor = openSync(path, 'wx', 0o600);
  try { writeFileSync(descriptor, JSON.stringify({ pid: process.pid, ...metadata })); }
  catch (error) { closeSync(descriptor); unlinkSync(path); throw error; }
  let closed = false;
  return () => { if (closed) return; closed = true; closeSync(descriptor); unlinkSync(path); };
}
async function main() {
  const mode = process.argv[2], hashArg = process.argv.find(arg => arg.startsWith('--review-sha256='))?.slice(16);
  requireCheck(['prepare', 'execute', 'reconcile'].includes(mode ?? ''), 'choose_revision_prepare_execute_or_reconcile'); verifySdk();
  const originalRaw = readFileSync(originalReviewPath, 'utf8'), originalHash = sha256(originalRaw), original = validateReview(JSON.parse(originalRaw));
  const oldJournalRaw = readFileSync(originalJournalPath, 'utf8'), oldJournal = decrypt<{ entries: Entry[] }>(oldJournalRaw, `meeti-demo-arkiv-journal-v1:${originalHash}`);
  const source = original.records.find(record => record.id === 'collaboration:demo-recruiter');
  const old = oldJournal.entries.find(entry => entry.id === source?.id);
  requireCheck(source && old?.state === 'confirmed' && old.hash && old.entityKey && oldJournal.entries.every(entry => entry.state === 'confirmed'), 'confirmed_original_workshop_record_required');
  const saved = loadDemo(original.origin), client = clientFromEnv(), adapter = createArkivAdapter({ accessKey: process.env.ARKIV_ACCESS_KEY! });
  const ens = createEnsAuthorityProvider({ rpcUrl: process.env.ENS_SEPOLIA_AUTH_RPC_URL || process.env.ENS_SEPOLIA_RPC_URL });
  async function freshEns() { const checked = await ens.checkAuthority({ ensName: source!.ens.ensName, owner: source!.ens.owner, delegate: source!.ens.delegate, action: 'publish', policyVersion: source!.ens.policyVersion, policyDigest: source!.ens.policyDigest }); requireCheck(checked.allowed, 'revision_current_ens_authority_denied'); }
  async function freshChain() { const [chain, head, genesis] = await Promise.all([client.getChainId(), client.getBlock(), client.getBlock({ blockNumber: 0n })]); requireCheck(chain === 7794095 && genesis.hash === original.genesisHash && Math.abs(Date.now() / 1000 - Number(head.timestamp)) < 90, 'revision_wrong_chain_genesis_or_stale_head'); return head; }
  async function stateIntent() { const state = await api<AppState>(saved, label, 'state'); requireCheck(state.user.id === source!.accountId && state.user.id === saved.accounts[label] && state.user.wallet && same(state.user.wallet, source!.intent.owner) && state.agent?.ensName === source!.ens.ensName && same(state.agent.delegate, source!.ens.delegate), 'revision_owner_or_agent_changed'); const intent = state.intents.find(value => value.id === source!.intent.intentId); requireCheck(intent, 'original_logical_intent_missing'); return intent; }
  const releaseLock = acquireRevisionLock('.local-data/demo-intent-revision.lock', { mode: mode!, originalReviewSha256: originalHash, revisionReviewSha256: existsSync(reviewPath) ? sha256(readFileSync(reviewPath, 'utf8')) : null });
  try {
    await freshChain();
    if (mode === 'prepare') {
      requireCheck(!existsSync(approvalPath) && !existsSync(journalPath) && !existsSync(reviewPath), 'preserve_existing_revision_review_and_journal');
      const previous = await adapter.readActive(old.entityKey); requireCheck(intentDigest(previous.intent) === source.payloadDigest, 'original_public_record_changed');
      let current = await stateIntent();
      const progress = existsSync(progressPath) ? decrypt<{ editing: boolean }>(readFileSync(progressPath, 'utf8'), 'meeti-demo-intent-revision-progress-v1') : undefined;
      if (current.version === 1) {
        requireCheck(!progress, 'uncertain_prior_revision_edit_do_not_repeat');
        requireCheck(current.status === 'published' && current.arkivKey === old.entityKey && current.transactionHash === old.hash, 'original_application_publication_changed');
        await freshEns(); durable(progressPath, { editing: true, originalReviewSha256: originalHash }, 'meeti-demo-intent-revision-progress-v1');
        const next = correctedIntent(source.intent, new Date().toISOString());
        current = await api<Intent>(saved, label, 'intent', { id: source.intent.intentId, goal: next.goal, summary: next.summary, tags: next.tags, expiresAt: next.expiresAt, publicApproved: true, demoOrigin: true, semantics: next.semantics });
      }
      requireCheck(current.version === 2 && current.status === 'draft', 'only_unpublished_revision_two_may_be_reviewed');
      const preview = await api<{ intent: PublicIntent; signingMessage: string }>(saved, label, 'intent/publish', { intentId: source.intent.intentId }); assertOnlyReviewedRevision(source.intent, preview.intent);
      requireCheck(preview.signingMessage === intentSigningMessage(preview.intent), 'revision_preview_message_mismatch'); await freshEns();
      const review: Revision = { version: 1, fictional: true, humanVerified: false, chainId: 7794095, origin: original.origin, checkedAt: new Date().toISOString(), reviewExpiresAt: new Date(Date.now() + 2 * 3600000).toISOString(), originalReviewSha256: originalHash, originalJournalSha256: sha256(oldJournalRaw), previousEntityKey: old.entityKey, previousTransactionHash: old.hash, previous: source.intent, intent: preview.intent, signingMessage: preview.signingMessage, payloadDigest: intentDigest(preview.intent), maximumFeeWei: cap, genesisHash: original.genesisHash as Hex, accountId: source.accountId, ens: source.ens,
        diff: [{ field: `semantics.requirements[sourceQuote=${correctionQuote}].strength`, before: 'mandatory', after: 'preferred', authority: 'Explicit fictional owner correction. Original model inference receipt remains unchanged.' }, { field: 'version', before: 1, after: 2 }, { field: 'createdAt', before: source.intent.createdAt, after: preview.intent.createdAt, authority: 'Required existing API revision timestamp.' }] };
      mkdirSync('artifacts', { recursive: true }); const raw = JSON.stringify(review, null, 2); writeFileSync(reviewPath, raw); console.log(JSON.stringify({ path: reviewPath, reviewSha256: sha256(raw), maximumFeeWei: cap, signatures: 0, broadcasts: 0, published: false })); return;
    }
    const raw = readFileSync(reviewPath, 'utf8'), reviewHash = sha256(raw), review = JSON.parse(raw) as Revision;
    requireCheck(hashArg === reviewHash && review.originalReviewSha256 === originalHash && review.originalJournalSha256 === sha256(oldJournalRaw) && review.previousEntityKey === old.entityKey && review.previousTransactionHash === old.hash && review.accountId === source.accountId && review.origin === original.origin && review.chainId === 7794095 && review.fictional && review.humanVerified === false && review.maximumFeeWei === cap && intentDigest(review.previous) === source.payloadDigest, 'revision_review_or_frozen_original_changed');
    assertOnlyReviewedRevision(source.intent, review.intent); requireCheck(review.payloadDigest === intentDigest(review.intent) && review.signingMessage === intentSigningMessage(review.intent), 'revision_digest_or_message_changed');
    requireCheck(process.argv.includes('--execute-reviewed'), 'explicit_revision_execution_flag_required'); assertRevisionApproval(reviewHash, JSON.parse(readFileSync(approvalPath, 'utf8')));
    const context = `meeti-demo-intent-revision-journal-v1:${reviewHash}`, stored = existsSync(journalPath) ? decrypt<{ entry: Entry }>(readFileSync(journalPath, 'utf8'), context) : undefined;
    let entry = stored?.entry;
    function save() { requireCheck(entry, 'revision_journal_entry_required'); durable(journalPath, { entry }, context); }
    async function verifyRaw() {
      requireCheck(entry?.raw && entry.hash && entry.envelope && entry.prepared && entry.hash === keccak256(entry.raw), 'revision_known_signed_envelope_required');
      const decoded = parseTransaction(entry.raw), envelope = entry.envelope;
      requireCheck(decoded.chainId === 7794095 && decoded.to && same(decoded.to, '0x4400000000000000000000000000000000000044') && decoded.data === envelope.data && (decoded.value ?? 0n) === 0n && decoded.nonce === envelope.nonce && decoded.gas === BigInt(envelope.gas) && decoded.gasPrice === BigInt(envelope.gasPrice) && decoded.gas * decoded.gasPrice <= BigInt(cap) && same(await recoverTransactionAddress({ serializedTransaction: entry.raw as TransactionSerialized }), review.intent.owner), 'revision_signed_scope_or_budget_mismatch');
    }
    async function reconcile() {
      await verifyRaw(); const currentEntry = entry!;
      const receipt = await client.waitForTransactionReceipt({ hash: currentEntry.hash!, confirmations: 2, timeout: 90000, pollingInterval: 3000 });
      const head = await freshChain(), block = await client.getBlock({ blockNumber: receipt.blockNumber }), actual = await client.getTransaction({ hash: currentEntry.hash! });
      requireCheck(receipt.status === 'success' && head.number >= receipt.blockNumber + 1n && block.hash === receipt.blockHash && actual.hash === currentEntry.hash && same(actual.from, review.intent.owner) && actual.to && same(actual.to, currentEntry.envelope!.to) && actual.input === currentEntry.envelope!.data && actual.value === 0n && receipt.gasUsed * receipt.effectiveGasPrice <= BigInt(cap), 'revision_canonical_receipt_failed');
      currentEntry.receipt = { blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, actualFeeWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString() }; if (currentEntry.state !== 'confirmed') currentEntry.state = 'receipt_confirmed'; save();
      await freshEns(); let current = await stateIntent();
      if (current.status !== 'published') { await api(saved, label, `operations/${currentEntry.operationId}/submitted`, { transactionHash: currentEntry.hash }); await api(saved, label, 'intent/confirm', { intentId: review.intent.intentId, operationId: currentEntry.operationId, txHash: currentEntry.hash }); current = await stateIntent(); }
      requireCheck(current.status === 'published' && current.version === 2 && current.transactionHash === currentEntry.hash && current.arkivKey, 'revision_not_confirmed_in_application');
      const readback = await adapter.verifyPublished({ entityKey: current.arkivKey as Hex, txHash: currentEntry.hash!, expectedIntent: review.intent, expectedTransaction: currentEntry.prepared!.request }); requireCheck(intentDigest(readback.intent) === review.payloadDigest, 'revision_sdk_readback_mismatch');
      currentEntry.entityKey = readback.entityKey; currentEntry.state = 'confirmed'; save(); console.log(JSON.stringify({ state: 'confirmed', hash: currentEntry.hash, entityKey: currentEntry.entityKey, logicalId: review.intent.intentId, version: 2, receipt: currentEntry.receipt }));
    }
    {
      if (entry?.raw) { await reconcile(); return; } requireCheck(mode !== 'reconcile', 'revision_reconcile_requires_known_signed_hash_never_broadcasts'); assertAdmissionDeadline({ kind: 'publication', reviewExpiresAt: review.reviewExpiresAt, quoteExpiresAt: review.reviewExpiresAt });
      const current = await stateIntent(); requireCheck(current.status === 'draft' && current.version === 2, 'reviewed_revision_is_not_current_draft');
      const preview = await api<{ intent: PublicIntent; signingMessage: string }>(saved, label, 'intent/publish', { intentId: review.intent.intentId }); requireCheck(intentDigest(preview.intent) === review.payloadDigest && preview.signingMessage === review.signingMessage, 'revision_api_preview_changed'); await freshEns();
      const vault = decrypt<{ wallets: { label: string; privateKey: Hex }[] }>(readFileSync('.local-data/demo-wallets.enc', 'utf8'), 'meeti-demo-wallets-v1'); const key = vault.wallets.find(value => value.label === label); requireCheck(key, 'revision_owner_key_missing'); const account = privateKeyToAccount(key.privateKey); requireCheck(same(account.address, review.intent.owner), 'revision_owner_key_mismatch');
      if (!entry) { entry = { id: 'revision:collaboration:demo-recruiter:2', label, kind: 'publication', state: 'message_signing' }; save(); assertAdmissionDeadline({ kind: 'publication', reviewExpiresAt: review.reviewExpiresAt, quoteExpiresAt: review.reviewExpiresAt }); entry.signature = await account.signMessage({ message: review.signingMessage }); entry.state = 'message_signed'; save(); }
      requireCheck(entry.signature && await verifyMessage({ address: account.address, message: review.signingMessage, signature: entry.signature }), 'revision_exact_owner_message_signature_required');
      if (!entry.prepared) {
        if (entry.state === 'preparing') {
          const operations = await api<{ id: string; kind: string; data: { intent?: PublicIntent; transaction?: PreparedArkivTransaction } }[]>(saved, label, 'operations'); const matches = operations.filter(row => row.kind === `arkiv:${review.intent.intentId}:2` && row.data.intent && intentDigest(row.data.intent) === review.payloadDigest && row.data.transaction); requireCheck(matches.length === 1, 'uncertain_revision_preparation_requires_exact_operation_recovery'); entry.operationId = matches[0].id; entry.prepared = matches[0].data.transaction;
        } else { requireCheck(entry.state === 'message_signed', 'revision_message_signature_admission_uncertain'); entry.state = 'preparing'; save(); const prepared = await api<{ operationId: string; transaction: PreparedArkivTransaction }>(saved, label, 'intent/publish', { intentId: review.intent.intentId, signature: entry.signature, maxFeeWei: cap }); entry.operationId = prepared.operationId; entry.prepared = prepared.transaction; }
        entry.state = 'prepared'; save();
      }
      const prepared = entry.prepared!; const request = prepared.request;
      requireCheck(prepared.chainId === 7794095 && intentDigest(prepared.intent) === review.payloadDigest && prepared.payloadDigest === review.payloadDigest && same(request.from, account.address) && same(request.to, '0x4400000000000000000000000000000000000044') && request.value === '0x0' && request.type === '0x0' && request.chainId === '0x76edaf', 'revision_prepared_payload_or_native_target_changed');
      const decoded = decodeFunctionData({ abi: parseAbi(['function execute((uint8 operation,bytes operationData)[] ops) external returns (bytes32[] keys)']), data: request.data }); requireCheck(decoded.args[0].length === 1 && decoded.args[0][0].operation === 1, 'revision_only_one_native_create_allowed');
      const gas = BigInt(request.gas), price = BigInt(request.gasPrice), maximumFeeWei = gas * price;
      requireCheck(maximumFeeWei === BigInt(prepared.maximumFeeWei) && maximumFeeWei <= BigInt(cap) && gas > 0n && price > 0n, 'revision_prepared_fee_exceeds_cap');
      entry.envelope = { from: account.address, to: request.to, data: request.data, valueWei: '0', nonce: Number(BigInt(request.nonce)), gas: gas.toString(), gasPrice: price.toString(), maximumFeeWei: maximumFeeWei.toString() }; save();
      entry.raw = await signWithFreshAdmission({ kind: 'publication', reviewExpiresAt: review.reviewExpiresAt, quoteExpiresAt: prepared.expiresAt, refreshEns: freshEns,
        refreshRabdi: async () => { const head = await freshChain(); const [nonce, pending, estimate, priceNow, balance, operations] = await Promise.all([client.getTransactionCount({ address: account.address, blockTag: 'latest' }), client.getTransactionCount({ address: account.address, blockTag: 'pending' }), client.estimateGas({ account: account.address, to: request.to, data: request.data, value: 0n }), client.getGasPrice(), client.getBalance({ address: account.address }), api<{ id: string; data: { transaction: PreparedArkivTransaction } }[]>(saved, label, 'operations')]); requireCheck(nonce === entry!.envelope!.nonce && pending === nonce && gas >= minimumGas(estimate, head.gasLimit) && gas <= head.gasLimit / 2n && priceNow === price && balance >= maximumFeeWei && operations.some(row => row.id === entry!.operationId && JSON.stringify(row.data.transaction) === JSON.stringify(prepared)), 'revision_live_nonce_gas_fee_balance_or_operation_changed'); },
        sign: () => account.signTransaction({ type: 'legacy', chainId: 7794095, nonce: entry!.envelope!.nonce, to: request.to, data: request.data, value: 0n, gas, gasPrice: price }) });
      entry.hash = keccak256(entry.raw); entry.state = 'signed'; save(); await verifyRaw(); await freshEns(); await freshChain();
      const pendingBeforeBroadcast = await api<{ id: string; state: string; data: { transaction: PreparedArkivTransaction } }[]>(saved, label, 'operations');
      requireCheck(pendingBeforeBroadcast.some(row => row.id === entry!.operationId && row.state === 'prepared' && JSON.stringify(row.data.transaction) === JSON.stringify(prepared)), 'revision_operation_changed_or_cancelled_before_broadcast');
      const finalPreview = await api<{ intent: PublicIntent }>(saved, label, 'intent/publish', { intentId: review.intent.intentId });
      requireCheck(intentDigest(finalPreview.intent) === review.payloadDigest, 'revision_current_intent_changed_before_broadcast');
      await broadcastOnce(entry, review.reviewExpiresAt, save, raw => client.sendRawTransaction({ serializedTransaction: raw })); await reconcile();
    }
  } finally { try { await ens.disconnect(); } finally { releaseLock(); } }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main().catch(error => { console.error(error instanceof Error && /^[a-z][a-z0-9_]+$/.test(error.message) ? error.message : 'intent_revision_stopped_preserve_journal_no_secret_details'); process.exitCode = 1; });

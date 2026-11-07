import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPublicClient, decodeFunctionResult, encodeFunctionData, getAddress, http, keccak256, namehash, parseAbi, parseTransaction, recoverTransactionAddress, stringToHex, webSocket, type Address, type Hex, type TransactionSerialized } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { sepolia } from 'viem/chains';
import { rabdi } from '@arkiv-network/sdk/chains';
import { z } from 'zod';
import { createEnsAuthorityProvider, ALL_ROLES, dnsEncode, inlinePolicyDigest, ENS_DEPLOYMENT, POLICY_KEY, textResource, type EnsOperation } from '../packages/ens';
import { factoryAbi, registryAbi, resolverAbi, textProfileAbi } from '../packages/ens/abi';
import { createEnsReadTransport } from '../packages/ens/rpc-transport';
import { createAgentIdentityProvider, ERC8004_SEPOLIA, identityRegistryAbi, type PreparedIdentityTransaction } from '../packages/ens/agent-identity';
import { AGENT_CONTEXT_KEY, agentRegistrationKey, erc8004RegistrationSchema, publicAgentContextSchema, registrationDataUri, registryReference, validateRegistrationAgreement, type AgentRegistryIdentity } from '../packages/ens/agent-records';
import type { buildNamespaceDemoPlan } from '../packages/ens/namespace-plan';
import { boundedFundingEnvelope } from '../packages/ens/funding-envelope';
import { decrypt, encrypt } from '../packages/server/crypto';
import type { AppState } from '../packages/shared/src';
import { EVENT_ORIGIN, EVENT_VAULT_CONTEXT, EVENT_VAULT_PATH, eventVaultSchema } from './event-demo-accounts';
import { applyEventFundingCorrection, EVENT_CORRECTION_APPROVAL, EVENT_CORRECTION_REVIEW, FundingCorrectionError } from './event-demo-funding-correction';
import { applyEventPolicyCorrection, EVENT_POLICY_APPROVAL, EVENT_POLICY_REVIEW, PolicyCorrectionError } from './event-demo-policy-correction';

const REVIEW = 'artifacts/event-demo-testnet-review.json', APPROVAL = '.local-data/event-demo-testnet-approval.json', JOURNAL = '.local-data/event-demo-testnet-journal.enc';
const ISSUER = getAddress('0x9253705482a44e6A7378163e57cc791AE6213ed5');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
export class EventExecutionError extends Error { constructor(readonly code: string) { super(code); } }
export function requireEvent(value: unknown, code: string): asserts value { if (!value) throw new EventExecutionError(code); }
type Recipient = Awaited<ReturnType<typeof buildNamespaceDemoPlan>>['recipients'][number];
type Operation = { id: string; kind: 'funding' | 'namespace' | 'identity'; chainId: 11155111 | 7794095; from: Address; to: Address; data: Hex | null; valueWei: string; gasLimit?: string; maxFeePerGas?: string; maxPriorityFeePerGas?: string; maximumGasPriceWei?: string; maxGasCostWei: string; dependsOn: string[]; recipient?: Recipient; identityOperation?: 'register-identity' | 'publish-context' | 'set-identity-uri' | 'attest-association'; contextTemplate?: unknown };
export type EventEntry = { id: string; state: 'preparing' | 'prepared' | 'signing' | 'signed' | 'broadcast_admitted' | 'submitted' | 'mined' | 'confirmed' | 'reverted'; envelope?: { chainId: number; from: Address; to: Address; data: Hex; valueWei: string; nonce: number; gas: string; maxFeePerGas?: string; maxPriorityFeePerGas?: string; gasPrice?: string; maxFeeWei: string }; quote?: { operationId: string; expiresAt: string; maxFeeWei: string; transaction: { chainId: number; from: Address; to: Address; data: Hex; value: string; ensName: string; gas: Hex; gasPrice: Hex } }; raw?: Hex; hash?: Hex; broadcastAttemptedAt?: string; receipt?: { blockNumber: string; blockHash: Hex; actualFeeWei: string }; balanceObservation?: { checkedAt: string; balanceWei: string }; identity?: AgentRegistryIdentity; identityPrepared?: PreparedIdentityTransaction; fundingCorrectionSha256?: string; policyCorrectionSha256?: string };
type Journal = { version: 1; reviewSha256: string; entries: EventEntry[] };
type Review = { version: number; reviewOnly: boolean; fictional: boolean; humanVerified: boolean; reviewExpiresAt: string; accounts: { label: string; accountId: string; owner: Address; delegate: Address; userName: string; agentName: string }[];
  ens: { parent: { parentName: string }; branch: { parentName: string; subregistry: Address }; policyExpiresAt: string; recipients: Recipient[]; namespaceOperations: (Omit<Operation, 'kind' | 'valueWei'> & { value: string })[]; identityOperations: { id: string; operation: Operation['identityOperation']; from: Address; to: Address; data: Hex | null; maxGasCostWei: string; maxFeePerGas: string; maxPriorityFeePerGas: string; publicContextTemplate?: unknown }[]; funding: Omit<Operation, 'id' | 'kind' | 'dependsOn'>[]; balances: { address: string; balanceWei: string }[]; codeChecks: { address: Address; runtimeCodeHash: Hex }[]; issuerMaxGasAndTransferWei: string; ownerCaps: { owner: Address; totalMaxGasWei: string }[] };
  arkiv: { chainId: number; genesisHash: Hex; funding: (Omit<Operation, 'kind' | 'dependsOn'>)[]; issuerMaximumFundsAndGasWei: string; balances: { address: string; balanceWei: string }[] } };

export function admitEventDeadline(reviewExpiresAt: string, quoteExpiresAt?: string, now = Date.now()) {
  requireEvent(Number.isFinite(Date.parse(reviewExpiresAt)) && Date.parse(reviewExpiresAt) > now, 'event_review_expired_no_new_signature_or_broadcast');
  if (quoteExpiresAt) requireEvent(Number.isFinite(Date.parse(quoteExpiresAt)) && Date.parse(quoteExpiresAt) > now, 'event_quote_expired_no_new_signature_or_broadcast');
}
export async function admitEventBroadcast(entry: EventEntry, expiresAt: string, save: () => void, send: (raw: Hex) => Promise<Hex>) {
  requireEvent(entry.state === 'signed' && entry.raw && entry.hash && !entry.broadcastAttemptedAt && keccak256(entry.raw) === entry.hash, 'event_unknown_or_previous_broadcast_never_resend');
  admitEventDeadline(expiresAt, entry.quote?.expiresAt);
  entry.state = 'broadcast_admitted'; entry.broadcastAttemptedAt = new Date().toISOString(); save();
  admitEventDeadline(expiresAt, entry.quote?.expiresAt);
  requireEvent(await send(entry.raw) === entry.hash, 'event_returned_broadcast_hash_mismatch');
}
export function eventRemaining(cap: bigint, entries: EventEntry[], from: Address, chainId: number, excludeId?: string) {
  return cap - entries.filter(entry => entry.id !== excludeId && entry.envelope?.chainId === chainId && same(entry.envelope.from, from)).reduce((sum, entry) => sum + BigInt(entry.receipt?.actualFeeWei ?? entry.envelope!.maxFeeWei) + BigInt(entry.envelope!.valueWei), 0n);
}
export async function assertEventRaw(entry: EventEntry) {
  requireEvent(entry.raw && entry.hash && entry.envelope && keccak256(entry.raw) === entry.hash, 'event_signed_journal_incomplete');
  const tx = parseTransaction(entry.raw), envelope = entry.envelope;
  requireEvent(tx.chainId === envelope.chainId && tx.to && same(tx.to, envelope.to) && (tx.data || '0x') === envelope.data && (tx.value || 0n) === BigInt(envelope.valueWei) && tx.nonce === envelope.nonce && tx.gas === BigInt(envelope.gas)
    && same(await recoverTransactionAddress({ serializedTransaction: entry.raw as TransactionSerialized }), envelope.from), 'event_signed_scope_changed');
  requireEvent(envelope.chainId === 11155111 ? tx.type === 'eip1559' && tx.maxFeePerGas === BigInt(envelope.maxFeePerGas!) && tx.maxPriorityFeePerGas === BigInt(envelope.maxPriorityFeePerGas!)
    : tx.type === 'legacy' && tx.gasPrice === BigInt(envelope.gasPrice!), 'event_signed_fee_type_changed');
  requireEvent(tx.gas! * BigInt(envelope.maxFeePerGas || envelope.gasPrice!) === BigInt(envelope.maxFeeWei), 'event_signed_fee_arithmetic_changed');
}
export function assertEventEnvelope(entry: EventEntry, operation: Operation) {
  const envelope = entry.envelope;
  requireEvent(envelope && envelope.chainId === operation.chainId && same(envelope.from, operation.from) && same(envelope.to, operation.to) && envelope.valueWei === operation.valueWei
    && (operation.data === null || envelope.data === operation.data), 'event_envelope_review_scope_changed');
  const fee = BigInt(envelope.maxFeePerGas || envelope.gasPrice!);
  requireEvent(BigInt(envelope.gas) > 0n && BigInt(envelope.gas) * fee === BigInt(envelope.maxFeeWei) && BigInt(envelope.maxFeeWei) <= BigInt(operation.maxGasCostWei), 'event_envelope_review_cap_exceeded');
  requireEvent(operation.chainId === 11155111 ? fee > 0n && fee <= BigInt(operation.maxFeePerGas || '500000000') && BigInt(envelope.maxPriorityFeePerGas!) >= 0n
    && BigInt(envelope.maxPriorityFeePerGas!) <= BigInt(operation.maxPriorityFeePerGas || '10000000') && BigInt(envelope.maxPriorityFeePerGas!) <= fee : fee > 0n && fee <= BigInt(operation.maximumGasPriceWei!), 'event_envelope_gas_price_exceeded');
  if (operation.gasLimit) requireEvent(BigInt(envelope.gas) <= BigInt(operation.gasLimit), 'event_envelope_gas_limit_exceeded');
}
function operations(review: Review): Operation[] {
  requireEvent(review.version === 1 && review.reviewOnly && review.fictional && review.humanVerified === false && review.accounts.length === 2 && review.ens.recipients.length === 2 && review.ens.parent.parentName === 'meeti-demo.eth' && review.ens.branch.parentName === 'users.meeti-demo.eth', 'event_review_scope_invalid');
  const labels = ['event-krishna', 'event-viha'];
  for (const [index, recipient] of review.ens.recipients.entries()) {
    const account = review.accounts[index]; requireEvent(recipient.label === labels[index] && recipient.userName === `${labels[index]}.users.meeti-demo.eth` && recipient.agentName === `networking.${recipient.userName}` && same(account.owner, recipient.owner) && same(account.delegate, recipient.delegate) && account.agentName === recipient.agentName, 'event_recipient_binding_invalid');
  }
  requireEvent(new Set(review.ens.recipients.flatMap(recipient => [recipient.owner.toLowerCase(), recipient.delegate.toLowerCase()])).size === 4 && review.ens.recipients.every(recipient => !same(recipient.owner, ISSUER) && !same(recipient.delegate, ISSUER)), 'event_four_independent_keys_required');
  const result: Operation[] = review.ens.funding.map((item, index) => { requireEvent(item.chainId === 11155111 && same(item.from, ISSUER) && same(item.to, review.ens.recipients[index].owner) && item.valueWei === '6000000000000000' && item.data === '0x' && item.gasLimit === '21000' && item.maxGasCostWei === '10500000000000', 'event_sepolia_funding_scope_invalid'); return { ...item, id: `fund-sepolia-${labels[index]}`, kind: 'funding', dependsOn: [] }; });
  requireEvent(result.length === 2 && review.ens.namespaceOperations.length === 14 && review.ens.identityOperations.length === 8, 'event_operation_count_invalid');
  for (const recipient of review.ens.recipients) {
    const suffixes = ['registry', 'issue', 'agent', 'resolver', 'attach', 'policy', 'grant'];
    for (const [index, suffix] of suffixes.entries()) {
      const item = review.ens.namespaceOperations.find(item => item.id === `${recipient.label}-${suffix}`);
      requireEvent(item && item.chainId === 11155111 && item.value === '0x0' && item.maxFeePerGas === '500000000' && item.maxPriorityFeePerGas === '10000000' && item.data && /^0x[0-9a-f]+$/i.test(item.data) && BigInt(item.gasLimit!) * 500000000n === BigInt(item.maxGasCostWei), 'event_namespace_review_scope_invalid');
      requireEvent(same(item.from, index < 2 ? ISSUER : recipient.owner), 'event_namespace_sender_invalid');
      result.push({ ...item, kind: 'namespace', valueWei: '0', recipient, dependsOn: [...item.dependsOn, ...(index === 2 ? [`fund-sepolia-${recipient.label}`] : [])] });
    }
    const steps = ['register-identity', 'publish-context', 'set-identity-uri', 'attest-association'] as const;
    for (const [index, step] of steps.entries()) {
      const item = review.ens.identityOperations.find(item => item.from === recipient.owner && item.operation === step);
      requireEvent(item && item.maxGasCostWei === '500000000000000' && item.maxFeePerGas === '500000000' && item.maxPriorityFeePerGas === '10000000', 'event_identity_scope_invalid');
      result.push({ ...item, id: item.id, kind: 'identity', chainId: 11155111, valueWei: '0', dependsOn: [index ? review.ens.identityOperations.find(item => item.from === recipient.owner && item.operation === steps[index - 1])!.id : `${recipient.label}-grant`], recipient, identityOperation: step,
        contextTemplate: review.ens.identityOperations.find(item => item.from === recipient.owner && item.operation === 'publish-context')!.publicContextTemplate });
    }
  }
  requireEvent(review.arkiv.chainId === 7794095 && review.arkiv.funding.length === 2 && review.arkiv.issuerMaximumFundsAndGasWei === '50000000000000000' && review.ens.issuerMaxGasAndTransferWei === '14421000000000000', 'event_issuer_caps_invalid');
  for (const [index, item] of review.arkiv.funding.entries()) { requireEvent(item.chainId === 7794095 && same(item.from, ISSUER) && same(item.to, review.ens.recipients[index].owner) && item.valueWei === '20000000000000000' && item.data === '0x' && item.maxGasCostWei === '5000000000000000', 'event_rabdi_funding_scope_invalid'); result.push({ ...item, kind: 'funding', dependsOn: [] }); }
  requireEvent(new Set(result.map(item => item.id)).size === 26, 'event_duplicate_operations'); return result;
}
export function validateEventApproval(review: Review, reviewHash: string, approval: unknown) {
  const value = z.object({ authorized: z.literal(true), reviewSha256: z.literal(reviewHash), approvedAt: z.string().datetime(), scope: z.literal('event-names-identities-and-rabdi-funding-only'), issuerSepoliaCapWei: z.literal('14421000000000000'), issuerRabdiCapWei: z.literal('50000000000000000'), ownerSepoliaCaps: z.record(z.string(), z.string()) }).strict().parse(approval);
  requireEvent(Object.keys(value.ownerSepoliaCaps).length === 2 && review.ens.ownerCaps.length === 2 && review.ens.ownerCaps.every(cap => cap.totalMaxGasWei === '4450000000000000' && value.ownerSepoliaCaps[cap.owner] === cap.totalMaxGasWei), 'event_owner_approval_caps_invalid');
  return value;
}

async function main() {
  const mode = process.argv[2], argument = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  requireEvent(['inspect', 'execute', 'reconcile'].includes(mode || ''), 'choose_event_inspect_execute_or_reconcile');
  requireEvent(process.argv.slice(3).every(value => /^--(review-sha256|operation-id|funding-correction-sha256|policy-correction-sha256)=.+$/.test(value)) && process.argv.filter(value => value.startsWith('--review-sha256=')).length === 1 && process.argv.filter(value => value.startsWith('--operation-id=')).length <= 1 && process.argv.filter(value => value.startsWith('--funding-correction-sha256=')).length <= 1 && process.argv.filter(value => value.startsWith('--policy-correction-sha256=')).length <= 1, 'event_exact_cli_arguments_required');
  const rawReview = readFileSync(REVIEW, 'utf8'), reviewHash = sha(rawReview), review = JSON.parse(rawReview) as Review; let all = operations(review);
  requireEvent(argument('review-sha256') === reviewHash, 'exact_event_review_hash_required');
  const context = `meeti-event-testnet-journal-v1:${reviewHash}`;
  const journal: Journal = existsSync(JOURNAL) ? decrypt<Journal>(readFileSync(JOURNAL, 'utf8'), context) : { version: 1, reviewSha256: reviewHash, entries: [] };
  requireEvent(journal.version === 1 && journal.reviewSha256 === reviewHash && new Set(journal.entries.map(entry => entry.id)).size === journal.entries.length && journal.entries.every(entry => all.some(operation => operation.id === entry.id)), 'event_journal_binding_invalid');
  const correctionHash = argument('funding-correction-sha256'); let correctionExpiry: string | undefined, correctedIds: string[] = [];
  if (correctionHash) {
    const corrected = applyEventFundingCorrection({ baseReviewSha256: reviewHash, originalExpiresAt: review.reviewExpiresAt, operations: all, entries: journal.entries,
      correctionRaw: readFileSync(EVENT_CORRECTION_REVIEW, 'utf8'), correctionHash, requireApproval: mode !== 'inspect', ...(existsSync(EVENT_CORRECTION_APPROVAL) ? { approval: JSON.parse(readFileSync(EVENT_CORRECTION_APPROVAL, 'utf8')) } : {}) });
    all = corrected.operations; correctionExpiry = corrected.expiresAt; correctedIds = corrected.targetedIds;
  }
  const policyCorrectionHash = argument('policy-correction-sha256'); let policyCorrectionExpiry: string | undefined, correctedPolicyIds: string[] = [];
  requireEvent(!journal.entries.some(entry => entry.policyCorrectionSha256) || policyCorrectionHash, 'event_existing_policy_correction_requires_exact_overlay');
  if (policyCorrectionHash) {
    requireEvent(correctionHash, 'event_policy_overlay_requires_approved_funding_overlay');
    const corrected = applyEventPolicyCorrection({ baseReviewSha256: reviewHash, fundingCorrectionSha256: correctionHash, originalExpiresAt: review.reviewExpiresAt, operations: all, entries: journal.entries,
      correctionRaw: readFileSync(EVENT_POLICY_REVIEW, 'utf8'), correctionHash: policyCorrectionHash, requireApproval: mode !== 'inspect', ...(existsSync(EVENT_POLICY_APPROVAL) ? { approval: JSON.parse(readFileSync(EVENT_POLICY_APPROVAL, 'utf8')) } : {}) });
    all = corrected.operations; policyCorrectionExpiry = corrected.expiresAt; correctedPolicyIds = corrected.targetedIds;
  }
  if (mode === 'inspect') { console.log(JSON.stringify({ reviewSha256: reviewHash, operationCount: all.length, approvalPresent: existsSync(APPROVAL), fundingCorrection: correctionHash ? { hash: correctionHash, approvalPresent: existsSync(EVENT_CORRECTION_APPROVAL), transfers: all.filter(operation => correctedIds.includes(operation.id)).map(({ id, gasLimit, maxFeePerGas, maxGasCostWei }) => ({ id, gasLimit, maxFeePerGas, maxGasCostWei })) } : null,
    policyCorrection: policyCorrectionHash ? { hash: policyCorrectionHash, approvalPresent: existsSync(EVENT_POLICY_APPROVAL), policies: all.filter(operation => correctedPolicyIds.includes(operation.id)).map(({ id, gasLimit, maxFeePerGas, maxGasCostWei }) => ({ id, gasLimit, maxFeePerGas, maxGasCostWei })) } : null,
    entries: journal.entries.map(({ id, state, hash, receipt }) => ({ id, state, hash, receipt })), signatures: 0, broadcasts: 0 })); return; }
  const approval = validateEventApproval(review, reviewHash, JSON.parse(readFileSync(APPROVAL, 'utf8')));
  if (mode === 'execute') admitEventDeadline(review.reviewExpiresAt);
  const targetId = argument('operation-id'); requireEvent(!targetId || all.some(operation => operation.id === targetId), 'event_unknown_selected_operation');
  const selected = targetId ? all.filter(operation => operation.id === targetId) : all;
  const lockPath = '.local-data/event-demo-testnet-execution.lock', lock = openSync(lockPath, 'wx', 0o600);
  let activeId = 'startup';
  try {
    const rpcUrl = process.env.ENS_SEPOLIA_AUTH_RPC_URL || process.env.ENS_SEPOLIA_RPC_URL;
    requireEvent(rpcUrl && process.env.ARKIV_ACCESS_KEY, 'event_rpc_configuration_required');
    const client = createPublicClient({ chain: sepolia, transport: createEnsReadTransport(rpcUrl) });
    const sender = createPublicClient({ chain: sepolia, transport: rpcUrl.startsWith('wss:') ? webSocket(rpcUrl, { retryCount: 0, reconnect: false, keepAlive: false }) : http(rpcUrl, { retryCount: 0, timeout: 15000 }) });
    const arkiv = createPublicClient({ chain: rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY }), transport: http(undefined, { retryCount: 0, timeout: 15000, fetchOptions: { redirect: 'error', cache: 'no-store' } }) });
    const ens = createEnsAuthorityProvider({ rpcUrl }), identity = createAgentIdentityProvider({ ens, rpcUrl });
    const vault = eventVaultSchema.parse(decrypt<unknown>(readFileSync(EVENT_VAULT_PATH, 'utf8'), EVENT_VAULT_CONTEXT));
    const accounts = new Map<string, ReturnType<typeof privateKeyToAccount>>();
    if (mode === 'execute') {
      requireEvent(/^0x[a-f0-9]{64}$/i.test(process.env.ARKIV_PRIVATE_KEY || ''), 'event_approved_issuer_key_missing');
      const issuer = privateKeyToAccount(process.env.ARKIV_PRIVATE_KEY as Hex); requireEvent(same(issuer.address, ISSUER), 'event_issuer_key_mismatch'); accounts.set(ISSUER.toLowerCase(), issuer);
      for (const wallet of vault.wallets) { const account = privateKeyToAccount(wallet.ownerKey), declared = review.accounts.find(item => item.label === wallet.label); requireEvent(declared && declared.accountId === wallet.accountId && same(declared.owner, account.address), 'event_generated_owner_key_mismatch'); accounts.set(account.address.toLowerCase(), account); }
    }
    function save() {
      const ciphertext = encrypt(journal, context), temporary = `${JOURNAL}.tmp`; writeFileSync(temporary, ciphertext, { mode: 0o600 });
      const fd = openSync(temporary, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); } renameSync(temporary, JOURNAL);
      requireEvent(readFileSync(JOURNAL, 'utf8') === ciphertext, 'event_durable_journal_readback_failed');
      mkdirSync('artifacts', { recursive: true }); writeFileSync('artifacts/event-demo-testnet-execution.json', JSON.stringify({ reviewSha256: reviewHash, humanVerified: false, transactions: journal.entries.map(({ id, state, hash, receipt, identity }) => ({ id, state, hash, receipt, identity })) }, null, 2));
    }
    async function api<T>(recipient: Recipient, path: 'state' | 'agent/import/preview' | 'agent/import' | 'identity' | 'identity/prepare' | 'identity/submitted' | 'identity/confirm' | 'operations', body?: unknown) {
      const label = recipient.label.replace('event-', ''), wallet = vault.wallets.find(item => item.label === label), declared = review.accounts.find(item => item.label === label);
      requireEvent(wallet?.session && wallet.accountId === declared?.accountId, 'event_authenticated_session_required');
      const response = await fetch(`${EVENT_ORIGIN}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(180000), headers: { origin: EVENT_ORIGIN, cookie: wallet.session, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      requireEvent(response.ok, `event_api_http_${response.status}`); return (await response.json()).data as T;
    }
    async function fresh(chainId: number) {
      const rpc = chainId === 11155111 ? client : arkiv, [chain, head] = await Promise.all([rpc.getChainId(), rpc.getBlock()]);
      requireEvent(chain === chainId && Math.abs(Date.now() / 1000 - Number(head.timestamp)) < 90, 'event_wrong_chain_or_stale_head');
      if (chainId === 7794095) requireEvent((await arkiv.getBlock({ blockNumber: 0n })).hash === review.arkiv.genesisHash, 'event_rabdi_genesis_changed');
      return head;
    }
    async function codeAndParent() {
      await fresh(11155111);
      for (const check of review.ens.codeChecks) { const code = await client.getCode({ address: check.address }); requireEvent(code && keccak256(code) === check.runtimeCodeHash, 'event_deployment_code_changed'); }
      const branch = await ens.inspectProjectParent({ parentName: 'users.meeti-demo.eth', issuer: ISSUER }); requireEvent(branch.nextStep === 'ready' && same(branch.subregistry, review.ens.branch.subregistry), 'event_existing_branch_control_changed');
      requireEvent((await identity.inspectDeployment()).verified, 'event_identity_deployment_changed');
    }
    async function authority(recipient: Recipient) {
      requireEvent((await ens.checkAuthority({ ensName: recipient.agentName, owner: recipient.owner, delegate: recipient.delegate, action: 'negotiate', policyVersion: '1', policyDigest: recipient.policyDigest })).allowed, 'event_current_agent_permission_denied');
    }
    async function importAgent(recipient: Recipient) {
      await authority(recipient);
      const state = await api<AppState>(recipient, 'state'), declared = review.accounts.find(item => same(item.owner, recipient.owner));
      requireEvent(state.user.id === declared?.accountId && state.user.wallet && same(state.user.wallet, recipient.owner), 'event_api_owner_changed');
      if (!state.agent) { const preview = await api<{ policyDigest: string; ensName: string; owner: string; delegate: string }>(recipient, 'agent/import/preview', { ensName: recipient.agentName, delegate: recipient.delegate }); requireEvent(preview.policyDigest === recipient.policyDigest && preview.ensName === recipient.agentName && same(preview.owner, recipient.owner) && same(preview.delegate, recipient.delegate), 'event_import_preview_changed'); await api(recipient, 'agent/import', { ensName: recipient.agentName, delegate: recipient.delegate, reviewedDigest: preview.policyDigest }); }
      else requireEvent(state.agent.ensName === recipient.agentName && same(state.agent.owner, recipient.owner) && same(state.agent.delegate, recipient.delegate) && inlinePolicyDigest(state.agent.policy) === recipient.policyDigest, 'event_other_agent_must_not_be_overwritten');
    }
    async function materialize(operation: Operation, entry: EventEntry) {
      if (operation.kind === 'funding') return { from: operation.from, to: operation.to, data: '0x' as Hex, value: `0x${BigInt(operation.valueWei).toString(16)}` };
      const r = operation.recipient!;
      if (operation.kind === 'namespace') {
        let prepared;
        if (operation.id.endsWith('-registry')) { const value = await ens.prepareProjectRecipientRegistry({ parentName: 'users.meeti-demo.eth', label: r.label, issuer: ISSUER, recipient: r.owner }); requireEvent(value.needed, 'event_existing_registry_requires_reconciliation'); prepared = value; }
        else if (operation.id.endsWith('-issue')) prepared = await ens.prepareProjectSubname({ parentName: 'users.meeti-demo.eth', label: r.label, issuer: ISSUER, recipient: r.owner, recipientSubregistry: r.recipientRegistry, expiresAt: r.proposedPublicPolicy.expiresAt > 0 ? Math.floor(Date.parse((await ens.inspectProjectParent({ parentName: 'users.meeti-demo.eth', issuer: ISSUER })).expiresAt) / 1000) : 0 });
        else { const suffix = operation.id.slice(r.label.length + 1), method: EnsOperation = suffix === 'agent' ? 'create-subname' : suffix === 'resolver' ? 'deploy-resolver' : suffix === 'attach' ? 'set-resolver' : suffix === 'policy' ? 'set-policy' : 'grant'; prepared = await ens.prepareTransaction({ ensName: r.agentName, owner: r.owner, delegate: r.delegate, operation: method, expiresAt: Math.floor(Date.parse((await ens.inspectProjectParent({ parentName: r.userName, issuer: r.owner })).expiresAt) / 1000), ...(suffix === 'policy' ? { value: JSON.stringify(r.proposedPublicPolicy) } : {}) }); }
        requireEvent(same(prepared.from, operation.from) && same(prepared.to, operation.to) && prepared.data === operation.data, 'event_live_namespace_calldata_changed'); return prepared;
      }
      await importAgent(r);
      if (operation.identityOperation === 'register-identity') {
        requireEvent(!journal.entries.some(item => item.id !== operation.id && item.identity && same(item.identity.registry, ERC8004_SEPOLIA.registry) && all.find(op => op.id === item.id)?.from === r.owner), 'event_existing_registration_requires_reconciliation');
        requireEvent(await client.readContract({ address: ERC8004_SEPOLIA.registry, abi: parseAbi(['function balanceOf(address owner) view returns (uint256)']), functionName: 'balanceOf', args: [r.owner] }) === 0n, 'event_existing_nft_requires_reconciliation');
        const prepared = await identity.prepareTransaction({ operation: 'register-identity', ensName: r.agentName, owner: r.owner }); entry.identityPrepared = prepared; return prepared;
      }
      const registered = journal.entries.find(item => all.find(op => op.id === item.id)?.identityOperation === 'register-identity' && all.find(op => op.id === item.id)?.from === r.owner);
      requireEvent(registered?.state === 'confirmed' && registered.hash && registered.identityPrepared, 'event_canonical_registration_required');
      const confirmed = await identity.confirmTransaction({ hash: registered.hash, prepared: registered.identityPrepared }); requireEvent(confirmed.identity, 'event_registration_event_identity_missing');
      entry.identity = confirmed.identity;
      const context = publicAgentContextSchema.parse({ ...publicAgentContextSchema.parse(operation.contextTemplate), registration: confirmed.identity });
      const currentContext = (await ens.readPublicAgentRecords({ ensName: r.agentName, owner: r.owner, keys: [AGENT_CONTEXT_KEY] })).records[AGENT_CONTEXT_KEY];
      if (operation.identityOperation === 'publish-context') { requireEvent(!currentContext || currentContext === JSON.stringify(context), 'event_existing_public_context_requires_review'); return ens.preparePublicAgentRecord({ ensName: r.agentName, owner: r.owner, key: AGENT_CONTEXT_KEY, value: JSON.stringify(context) }); }
      requireEvent(currentContext === JSON.stringify(context), 'event_current_public_context_changed');
      const document = validateRegistrationAgreement(erc8004RegistrationSchema.parse({ type: 'https://eips.ethereum.org/EIPS/eip-8004#registration-v1', name: context.name, description: context.description, services: [{ name: 'ENS', endpoint: r.agentName, version: 'v2' }], x402Support: false, active: true, registrations: [{ agentId: confirmed.identity.agentId, agentRegistry: registryReference(confirmed.identity) }], supportedTrust: [] }), confirmed.identity, r.agentName);
      if (operation.identityOperation === 'set-identity-uri') {
        const prepared = await identity.prepareTransaction({ operation: 'set-identity-uri', ensName: r.agentName, owner: r.owner, identity: confirmed.identity, document }); entry.identityPrepared = prepared; return prepared;
      }
      requireEvent(await client.readContract({ address: ERC8004_SEPOLIA.registry, abi: identityRegistryAbi, functionName: 'tokenURI', args: [BigInt(confirmed.identity.agentId)] }) === registrationDataUri(document), 'event_reviewed_registration_uri_changed');
      const attestation = await identity.prepareAssociationRecord({ identity: confirmed.identity, ensName: r.agentName, owner: r.owner }); requireEvent(attestation.key === agentRegistrationKey(confirmed.identity), 'event_exact_attestation_key_changed'); return ens.preparePublicAgentRecord(attestation);
    }
    async function readback(operation: Operation, entry: EventEntry) {
      if (operation.kind === 'funding') { entry.balanceObservation = { checkedAt: new Date().toISOString(), balanceWei: (await (operation.chainId === 11155111 ? client : arkiv).getBalance({ address: operation.to })).toString() }; return; }
      const r = operation.recipient!;
      if (operation.kind === 'namespace') {
        if (operation.id.endsWith('-registry') || operation.id.endsWith('-resolver')) { const resolver = operation.id.endsWith('-resolver'), address = resolver ? r.resolver : r.recipientRegistry, abi = resolver ? resolverAbi : registryAbi; requireEvent(same(await client.readContract({ address: ENS_DEPLOYMENT.factory, abi: factoryAbi, functionName: 'verifyContract', args: [address] }), resolver ? ENS_DEPLOYMENT.resolverImplementation : ENS_DEPLOYMENT.registryImplementation), 'event_proxy_implementation_readback_failed'); const [roles, count] = await Promise.all([client.readContract({ address, abi, functionName: 'roles', args: [0n, r.owner] }), client.readContract({ address, abi, functionName: 'roleCount', args: [0n] })]); requireEvent(roles === ALL_ROLES && count === ALL_ROLES, 'event_recipient_root_roles_not_exclusive'); }
        else if (operation.id.endsWith('-issue')) requireEvent(same((await ens.inspectProjectParent({ parentName: r.userName, issuer: r.owner })).subregistry, r.recipientRegistry), 'event_username_owner_readback_failed');
        else if (operation.id.endsWith('-agent')) requireEvent(same((await client.readContract({ address: r.recipientRegistry, abi: registryAbi, functionName: 'getState', args: [BigInt(keccak256(stringToHex('networking')))] })).latestOwner, r.owner), 'event_agent_owner_readback_failed');
        else if (operation.id.endsWith('-grant')) await authority(r);
        else if (operation.id.endsWith('-attach')) requireEvent(same(await client.readContract({ address: r.recipientRegistry, abi: registryAbi, functionName: 'getResolver', args: ['networking'] }), r.resolver), 'event_resolver_attachment_readback_failed');
        else {
          const verified = await ens.readPublicAgentRecords({ ensName: r.agentName, owner: r.owner, keys: [] });
          requireEvent(same(verified.resolver, r.resolver), 'event_policy_resolver_binding_changed');
          const blockNumber = BigInt(verified.blockNumber), profile = encodeFunctionData({ abi: textProfileAbi, functionName: 'text', args: [namehash(r.agentName), POLICY_KEY] });
          const [scope, encoded] = await Promise.all([client.readContract({ address: r.resolver, abi: resolverAbi, functionName: 'roleCount', args: [textResource(POLICY_KEY)], blockNumber }),
            client.readContract({ address: r.resolver, abi: resolverAbi, functionName: 'resolve', args: [dnsEncode(r.agentName), profile], blockNumber })]);
          requireEvent(scope === 0n && decodeFunctionResult({ abi: textProfileAbi, functionName: 'text', data: encoded }) === JSON.stringify(r.proposedPublicPolicy), 'event_policy_readback_failed');
        } return;
      }
      requireEvent(entry.quote && entry.hash, 'event_identity_api_quote_missing');
      requireEvent((await api<{ confirmed: boolean }>(r, 'identity/confirm', { operationId: entry.quote.operationId, hash: entry.hash })).confirmed === true, 'event_api_identity_confirmation_not_successful');
      if (operation.identityOperation === 'register-identity') { requireEvent(entry.identityPrepared, 'event_registration_preparation_missing'); entry.identity = (await identity.confirmTransaction({ hash: entry.hash, prepared: entry.identityPrepared })).identity; requireEvent(entry.identity, 'event_canonical_identity_readback_failed'); }
      else if (operation.identityOperation === 'publish-context') { const context = publicAgentContextSchema.parse({ ...publicAgentContextSchema.parse(operation.contextTemplate), registration: entry.identity }); requireEvent((await ens.readPublicAgentRecords({ ensName: r.agentName, owner: r.owner, keys: [AGENT_CONTEXT_KEY] })).records[AGENT_CONTEXT_KEY] === JSON.stringify(context), 'event_public_context_readback_failed'); }
      else if (operation.identityOperation === 'set-identity-uri') { requireEvent(entry.identityPrepared?.agentURI && entry.identity, 'event_identity_uri_preparation_missing'); requireEvent(await client.readContract({ address: ERC8004_SEPOLIA.registry, abi: identityRegistryAbi, functionName: 'tokenURI', args: [BigInt(entry.identity.agentId)] }) === entry.identityPrepared.agentURI, 'event_identity_uri_readback_failed'); }
      else requireEvent(entry.identity && (await identity.verifyAssociation({ identity: entry.identity, ensName: r.agentName, owner: r.owner })).verified, 'event_ensip25_association_readback_failed');
      const stored = await api<{ identity?: AgentRegistryIdentity; context?: unknown; association?: { verified: boolean } }>(r, 'identity');
      requireEvent(entry.identity && JSON.stringify(stored.identity) === JSON.stringify(entry.identity), 'event_api_registered_identity_readback_failed');
      if (operation.identityOperation === 'publish-context') requireEvent(JSON.stringify(stored.context) === JSON.stringify(publicAgentContextSchema.parse({ ...publicAgentContextSchema.parse(operation.contextTemplate), registration: entry.identity })), 'event_api_public_context_readback_failed');
      if (operation.identityOperation === 'attest-association') requireEvent(stored.association?.verified === true, 'event_api_association_readback_failed');
    }
    async function reconcile(operation: Operation, entry: EventEntry) {
      await assertEventRaw(entry); assertEventEnvelope(entry, operation); const rpc = operation.chainId === 11155111 ? client : arkiv;
      let receipt = await rpc.getTransactionReceipt({ hash: entry.hash! }).catch(() => undefined);
      if (!receipt) { requireEvent(await rpc.getTransaction({ hash: entry.hash! }).catch(() => undefined), 'event_submission_unknown_no_resend_or_nonce_replacement'); receipt = await rpc.waitForTransactionReceipt({ hash: entry.hash!, confirmations: 2, timeout: 90000, pollingInterval: 3000 }); }
      if ((await fresh(operation.chainId)).number < receipt.blockNumber + 1n) receipt = await rpc.waitForTransactionReceipt({ hash: entry.hash!, confirmations: 2, timeout: 90000, pollingInterval: 3000 });
      requireEvent((await fresh(operation.chainId)).number >= receipt.blockNumber + 1n, 'event_receipt_needs_two_confirmations');
      const [actual, block] = await Promise.all([rpc.getTransaction({ hash: entry.hash! }), rpc.getBlock({ blockNumber: receipt.blockNumber })]);
      requireEvent(receipt.transactionHash === entry.hash && block.hash === receipt.blockHash && same(actual.from, operation.from) && actual.to && same(actual.to, operation.to) && actual.input === entry.envelope!.data && actual.value === BigInt(operation.valueWei), 'event_canonical_receipt_scope_changed');
      const fee = receipt.gasUsed * receipt.effectiveGasPrice; requireEvent(fee <= BigInt(operation.maxGasCostWei), 'event_actual_fee_exceeds_cap');
      if (entry.receipt) requireEvent(entry.receipt.blockHash === receipt.blockHash && entry.receipt.blockNumber === receipt.blockNumber.toString(), 'event_prior_receipt_reorganized');
      entry.receipt = { blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, actualFeeWei: fee.toString() }; entry.state = receipt.status === 'success' ? 'mined' : 'reverted'; save(); requireEvent(receipt.status === 'success', 'event_transaction_reverted_no_automatic_replacement');
      await readback(operation, entry); entry.state = 'confirmed'; save(); console.log(JSON.stringify({ id: entry.id, state: entry.state, hash: entry.hash, receipt: entry.receipt, identity: entry.identity }));
    }
    try {
      await codeAndParent();
      for (const operation of selected) {
        const admissionExpiry = correctedPolicyIds.includes(operation.id) ? policyCorrectionExpiry! : correctedIds.includes(operation.id) ? correctionExpiry! : review.reviewExpiresAt;
        activeId = operation.id; let entry = journal.entries.find(item => item.id === operation.id);
        if (entry?.raw && (entry.broadcastAttemptedAt || entry.state === 'confirmed' || mode === 'reconcile')) { await reconcile(operation, entry); continue; }
        if (mode === 'reconcile') continue;
        admitEventDeadline(admissionExpiry); requireEvent(operation.dependsOn.every(id => journal.entries.some(item => item.id === id && item.state === 'confirmed')), 'event_dependency_not_confirmed');
        await codeAndParent(); const rpc = operation.chainId === 11155111 ? client : arkiv, head = await fresh(operation.chainId);
        if (!entry) { entry = { id: operation.id, state: 'preparing' }; journal.entries.push(entry); save(); }
        requireEvent(entry.state !== 'signing' && entry.state !== 'reverted', 'event_uncertain_signing_or_reverted_operation_requires_review');
        const prepared = await materialize(operation, entry); requireEvent(same(prepared.from, operation.from) && same(prepared.to, operation.to) && prepared.value === `0x${BigInt(operation.valueWei).toString(16)}` && (operation.data === null || prepared.data === operation.data), 'event_materialized_scope_changed');
        let gas: bigint, maxFee: bigint, priority: bigint | undefined;
        if (operation.kind === 'identity') {
          if (!entry.quote) {
            const pending = await api<{ id: string; kind: string; state: string; data: Omit<NonNullable<EventEntry['quote']>, 'operationId'> }[]>(operation.recipient!, 'operations');
            const matches = pending.filter(row => row.kind === 'identity' && row.state === 'prepared' && row.data.transaction.data === prepared.data && same(row.data.transaction.from, operation.from));
            requireEvent(matches.length <= 1, 'event_ambiguous_api_preparation');
            entry.quote = matches.length ? { ...matches[0].data, operationId: matches[0].id } : await api(operation.recipient!, 'identity/prepare', { operation: operation.identityOperation, maxFeeWei: operation.maxGasCostWei, ...(operation.identityOperation === 'publish-context' ? { name: publicAgentContextSchema.parse(operation.contextTemplate).name, description: publicAgentContextSchema.parse(operation.contextTemplate).description, publicApproved: true } : {}) }); entry.state = 'prepared'; save();
          }
          const quote = entry.quote!; admitEventDeadline(review.reviewExpiresAt, quote.expiresAt); requireEvent(z.string().uuid().safeParse(quote.operationId).success && quote.transaction.chainId === 11155111 && quote.transaction.ensName === operation.recipient!.agentName && quote.transaction.data === prepared.data && same(quote.transaction.from, operation.from) && same(quote.transaction.to, operation.to) && quote.transaction.value === '0x0' && quote.maxFeeWei === operation.maxGasCostWei, 'event_api_quote_scope_changed'); gas = BigInt(quote.transaction.gas); maxFee = BigInt(quote.transaction.gasPrice); requireEvent(gas > 0n && gas <= head.gasLimit && maxFee > 0n && maxFee <= 500000000n && gas * maxFee <= BigInt(operation.maxGasCostWei), 'event_api_quote_fee_cap_exceeded'); priority = maxFee > (head.baseFeePerGas || 0n) ? (maxFee - (head.baseFeePerGas || 0n) < 10000000n ? maxFee - (head.baseFeePerGas || 0n) : 10000000n) : 0n;
        } else {
          const estimate = await rpc.estimateGas({ account: operation.from, to: operation.to, data: prepared.data, value: BigInt(operation.valueWei) });
          if (operation.chainId === 11155111) {
            if (operation.kind === 'funding') { gas = BigInt(operation.gasLimit!); requireEvent(estimate <= gas, 'event_funding_estimate_exceeds_transfer_cap'); maxFee = BigInt(operation.maxFeePerGas!); priority = BigInt(operation.maxPriorityFeePerGas!); }
            else { const envelope = boundedFundingEnvelope({ estimatedGas: estimate, maxGasCostWei: BigInt(operation.maxGasCostWei), reviewedMaxFeePerGas: BigInt(operation.maxFeePerGas!), reviewedMaxPriorityFeePerGas: BigInt(operation.maxPriorityFeePerGas!), baseFeePerGas: head.baseFeePerGas || 0n }); gas = envelope.gas; maxFee = envelope.maxFeePerGas; priority = envelope.maxPriorityFeePerGas; requireEvent(gas <= BigInt(operation.gasLimit!), 'event_namespace_estimate_exceeds_review_gas'); }
          }
          else { gas = BigInt(operation.gasLimit!); maxFee = await rpc.getGasPrice(); requireEvent(estimate <= gas && gas <= head.gasLimit / 2n && maxFee <= BigInt(operation.maximumGasPriceWei!) && gas * maxFee <= BigInt(operation.maxGasCostWei), 'event_rabdi_funding_envelope_changed'); }
        }
        const cap = operation.chainId === 7794095 ? BigInt(approval.issuerRabdiCapWei) : same(operation.from, ISSUER) ? BigInt(approval.issuerSepoliaCapWei) : BigInt(approval.ownerSepoliaCaps[operation.from]);
        requireEvent(gas * maxFee + BigInt(operation.valueWei) <= eventRemaining(cap, journal.entries, operation.from, operation.chainId, operation.id), 'event_aggregate_wallet_cap_exceeded');
        const [nonce, pendingNonce, balance] = await Promise.all([rpc.getTransactionCount({ address: operation.from, blockTag: 'latest' }), rpc.getTransactionCount({ address: operation.from, blockTag: 'pending' }), rpc.getBalance({ address: operation.from })]);
        requireEvent(nonce === pendingNonce && balance >= gas * maxFee + BigInt(operation.valueWei), 'event_nonce_or_balance_requires_reconciliation');
        if (!entry.raw) {
          requireEvent(entry.state === 'preparing' || entry.state === 'prepared', 'event_unknown_signing_state');
          await codeAndParent(); const beforeSign = await materialize(operation, entry);
          requireEvent(beforeSign.data === prepared.data && same(beforeSign.from, operation.from) && same(beforeSign.to, operation.to), 'event_authority_or_preparation_changed_before_signing');
          entry.envelope = { chainId: operation.chainId, from: operation.from, to: operation.to, data: prepared.data, valueWei: operation.valueWei, nonce, gas: gas.toString(), ...(operation.chainId === 11155111 ? { maxFeePerGas: maxFee.toString(), maxPriorityFeePerGas: priority!.toString() } : { gasPrice: maxFee.toString() }), maxFeeWei: (gas * maxFee).toString() };
          if (correctedIds.includes(operation.id)) entry.fundingCorrectionSha256 = correctionHash;
          if (correctedPolicyIds.includes(operation.id)) entry.policyCorrectionSha256 = policyCorrectionHash;
          entry.state = 'signing'; save();
          admitEventDeadline(admissionExpiry, entry.quote?.expiresAt); const account = accounts.get(operation.from.toLowerCase()); requireEvent(account, 'event_unapproved_sender');
          entry.raw = operation.chainId === 11155111 ? await account.signTransaction({ type: 'eip1559', chainId: 11155111, nonce, to: operation.to, data: prepared.data, value: BigInt(operation.valueWei), gas, maxFeePerGas: maxFee, maxPriorityFeePerGas: priority! }) : await account.signTransaction({ type: 'legacy', chainId: 7794095, nonce, to: operation.to, data: prepared.data, value: BigInt(operation.valueWei), gas, gasPrice: maxFee }); entry.hash = keccak256(entry.raw); entry.state = 'signed'; save();
        }
        requireEvent(entry.envelope?.nonce === nonce && entry.envelope.data === prepared.data, 'event_signed_nonce_or_calldata_changed'); await assertEventRaw(entry); assertEventEnvelope(entry, operation);
        await codeAndParent(); const refreshed = await materialize(operation, entry);
        requireEvent(refreshed.data === entry.envelope.data && same(refreshed.from, entry.envelope.from) && same(refreshed.to, entry.envelope.to), 'event_authority_or_preparation_changed_before_admission');
        if (entry.quote) { const pending = await api<{ id: string; state: string; data: { transaction: unknown } }[]>(operation.recipient!, 'operations'); requireEvent(pending.some(row => row.id === entry!.quote!.operationId && row.state === 'prepared' && JSON.stringify(row.data.transaction) === JSON.stringify(entry!.quote!.transaction)), 'event_api_quote_cancelled_or_changed_before_admission'); }
        const broadcastHead = await fresh(operation.chainId), [latestNonce, pendingBeforeBroadcast, currentBalance] = await Promise.all([rpc.getTransactionCount({ address: operation.from, blockTag: 'latest' }), rpc.getTransactionCount({ address: operation.from, blockTag: 'pending' }), rpc.getBalance({ address: operation.from })]);
        requireEvent(latestNonce === entry.envelope.nonce && pendingBeforeBroadcast === latestNonce && currentBalance >= BigInt(entry.envelope.maxFeeWei) + BigInt(entry.envelope.valueWei), 'event_final_nonce_or_balance_changed');
        if (operation.chainId === 11155111) requireEvent(BigInt(entry.envelope.maxFeePerGas!) >= (broadcastHead.baseFeePerGas || 0n) + BigInt(entry.envelope.maxPriorityFeePerGas!), 'event_final_base_fee_exceeds_signed_envelope');
        else requireEvent(await rpc.getGasPrice() <= BigInt(entry.envelope.gasPrice!), 'event_final_rabdi_price_exceeds_signed_envelope');
        admitEventDeadline(admissionExpiry, entry.quote?.expiresAt);
        await admitEventBroadcast(entry, admissionExpiry, save, raw => operation.chainId === 11155111 ? sender.sendRawTransaction({ serializedTransaction: raw }) : arkiv.sendRawTransaction({ serializedTransaction: raw })); entry.state = 'submitted'; save();
        if (entry.quote) await api(operation.recipient!, 'identity/submitted', { operationId: entry.quote.operationId, hash: entry.hash });
        await reconcile(operation, entry);
      }
    } finally {
      await Promise.all([ens.disconnect(), identity.disconnect()]);
      for (const rpc of [client, sender, arkiv]) {
        try { const transport = rpc.transport as { getRpcClient?: () => Promise<{ close(): void }> }; if (transport.getRpcClient) (await transport.getRpcClient()).close(); }
        catch { /* Closing must not expose authenticated endpoints or replace the original result. */ }
      }
    }
  } catch (error) {
    const location = error instanceof Error ? /event-demo-execute\.ts:(\d+):(\d+)/.exec(error.stack || '') : null;
    console.error(JSON.stringify({ operation: activeId, code: error instanceof EventExecutionError ? error.code : 'event_execution_stopped_preserve_private_journal',
      runtimeCategory: error instanceof TypeError ? 'type_error' : error instanceof RangeError ? 'range_error' : 'other', sourceLine: location ? Number(location[1]) : null,
      replacementOrResendAttempted: false })); process.exitCode = 1;
  }
  finally { closeSync(lock); unlinkSync(lockPath); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main().catch(error => { console.error(error instanceof EventExecutionError || error instanceof FundingCorrectionError || error instanceof PolicyCorrectionError ? error.code : 'event_execution_startup_failed_no_private_diagnostics'); process.exitCode = 1; });

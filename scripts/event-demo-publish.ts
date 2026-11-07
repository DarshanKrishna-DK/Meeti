import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { decodeAbiParameters, decodeFunctionData, getAddress, keccak256, parseAbi, parseAbiParameters, parseTransaction, recoverTransactionAddress, stringToHex, toHex, verifyMessage, type Address, type Hex, type TransactionSerialized } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ARKIV_NATIVE_ADDRESS, ARKIV_SCHEMA_NAME, canonicalIntent, createArkivAdapter, intentDigest, intentSigningMessage, PublicIntentSchema, PublicIntents, type PreparedArkivTransaction } from '../packages/arkiv/src';
import { canonicalRoleLabel } from '../packages/matching/src/semantics';
import { decrypt, encrypt } from '../packages/server/crypto';
import { policyDigest } from '../packages/server/policy';
import type { Agent, AppState } from '../packages/shared/src';
import { EVENT_ORIGIN, EVENT_VAULT_CONTEXT, EVENT_VAULT_PATH, eventLabels, eventVaultSchema, type EventLabel } from './event-demo-accounts';
import { eventFlowSource } from './event-demo-flow';
import { eventPublicDraft } from './event-demo-review';
import { clientFromEnv, minimumGas, same, sha256, verifySdk } from './prepare-demo-arkiv';
import { assertAdmissionDeadline, signWithFreshAdmission } from './execute-demo-arkiv';

export const EVENT_PUBLICATION_REVIEW = 'artifacts/event-demo-publication-review.json';
export const EVENT_PUBLICATION_APPROVAL = '.local-data/event-demo-publication-approval.json';
export const EVENT_PUBLICATION_JOURNAL = '.local-data/event-demo-publication.enc';
export const EVENT_PUBLICATION_FEE_CAP = 10_000_000_000_000_000n;
const PREVIEW = 'artifacts/event-demo-flow-preview.json', FLOW = '.local-data/event-demo-flow.enc';
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/), address = z.string().regex(/^0x[0-9a-fA-F]{40}$/), hash32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/), digest32 = z.string().regex(/^[a-f0-9]{64}$/);
const recordSchema = z.object({ label: z.enum(eventLabels), accountId: z.string().uuid(), intent: PublicIntentSchema, signingMessage: z.string().max(2000), payloadDigest: hash32,
  ens: z.object({ ensName: z.string(), owner: address, delegate: address, resolver: address, policyVersion: z.number().int().positive(), policyDigest: hash32, blockNumber: decimal, checkedAt: z.string().datetime() }).strict(),
  balanceWei: decimal,
}).strict();
export const eventPublicationReviewSchema = z.object({ version: z.literal(1), reviewOnly: z.literal(true), fictional: z.literal(true), humanVerified: z.literal(false),
  scope: z.literal('event-krishna-viha-publications-only'), origin: z.literal(EVENT_ORIGIN), chainId: z.literal(7794095), sdkVersion: z.literal('1.0.1'),
  createdAt: z.string().datetime(), reviewExpiresAt: z.string().datetime(), previewSha256: digest32, flowSourceDigest: digest32,
  genesisHash: hash32, observedBlock: decimal, observedBlockGasLimit: decimal, observedGasPriceWei: decimal,
  maximumPublicationFeePerOwnerWei: z.literal('10000000000000000'), publications: z.literal(2), fundingTransfers: z.literal(0), records: z.array(recordSchema).length(2),
}).strict();
export type EventPublicationReview = z.infer<typeof eventPublicationReviewSchema>;
type RecordValue = EventPublicationReview['records'][number];
export type EventPublicationEnvelope = { from: Address; to: Address; data: Hex; valueWei: '0'; nonce: number; gas: string; gasPrice: string; maximumFeeWei: string };
export type EventPublicationEntry = { label: EventLabel; state: 'message_signing' | 'message_signed' | 'preparing' | 'prepared' | 'signing' | 'signed' | 'broadcast_admitted' | 'submitted' | 'receipt_confirmed' | 'confirmed' | 'reverted';
  signature?: Hex; operationId?: string; prepared?: PreparedArkivTransaction; envelope?: EventPublicationEnvelope; raw?: Hex; hash?: Hex; broadcastAttemptedAt?: string;
  receipt?: { blockNumber: string; blockHash: Hex; actualFeeWei: string }; entityKey?: Hex };
export type EventPublicationJournal = { version: 1; reviewSha256: string; entries: EventPublicationEntry[] };
export class EventPublicationError extends Error { constructor(readonly code: string) { super(code); } }
function requirePublication(value: unknown, code: string): asserts value { if (!value) throw new EventPublicationError(code); }
const executeAbi = parseAbi(['function execute((uint8 operation, bytes operationData)[] ops) external returns (bytes32[] keys)']);
const createParams = parseAbiParameters('(uint128 salt, uint64 expiresAt, uint64 minLifetime, uint8 creationFlags, (bytes32 name, uint8 typeId, bytes value)[] attributes)');
const digest = (value: unknown) => sha256(JSON.stringify(value));

export function validateEventPublicationReview(input: unknown): EventPublicationReview {
  const value = eventPublicationReviewSchema.parse(input);
  requirePublication(Date.parse(value.reviewExpiresAt) > Date.parse(value.createdAt) && Date.parse(value.reviewExpiresAt) - Date.parse(value.createdAt) <= 7200000, 'EVENT_REVIEW_DEADLINE_INVALID');
  requirePublication(new Set(value.records.map(record => record.label)).size === 2 && new Set(value.records.map(record => record.accountId)).size === 2
    && new Set(value.records.map(record => record.intent.intentId)).size === 2 && new Set(value.records.map(record => record.intent.owner.toLowerCase())).size === 2, 'EVENT_TWO_DISTINCT_PUBLICATIONS_REQUIRED');
  for (const record of value.records) {
    const intent = canonicalIntent(record.intent);
    requirePublication(intent.demoOrigin && intent.status === 'active' && intent.optIn && intent.visibility === 'public' && intent.goal === 'collaborator'
      && intent.semantics.direction === 'collaborating' && intent.summary === eventPublicDraft(record.label)
      && intent.ensAgentRef === `networking.event-${record.label}.users.meeti-demo.eth` && record.ens.ensName === intent.ensAgentRef
      && same(record.ens.owner, intent.owner) && !same(record.ens.owner, record.ens.delegate) && record.ens.policyVersion === intent.policyVersion
      && record.payloadDigest === intentDigest(intent) && record.signingMessage === intentSigningMessage(intent), 'EVENT_PUBLICATION_PAYLOAD_SCOPE_CHANGED');
    requirePublication(Date.parse(intent.expiresAt) - Date.parse(intent.createdAt) <= 86400000 && Date.parse(value.reviewExpiresAt) <= Date.parse(intent.expiresAt) - 60000
      && BigInt(record.balanceWei) >= EVENT_PUBLICATION_FEE_CAP, 'EVENT_EXPIRY_OR_WRITER_FUNDING_INVALID');
  }
  return value;
}

export function validateEventPublicationApproval(review: EventPublicationReview, reviewSha256: string, input: unknown, now = Date.now()) {
  const approval = z.object({ authorized: z.literal(true), reviewSha256: z.literal(reviewSha256), scope: z.literal('event-krishna-viha-publications-only'), chainId: z.literal(7794095),
    approvedAt: z.string().datetime(), maximumPublicationFeePerOwnerWei: z.literal('10000000000000000'), publications: z.literal(2), fundingTransfers: z.literal(0),
  }).strict().parse(input);
  requirePublication(Date.parse(approval.approvedAt) >= Date.parse(review.createdAt) && Date.parse(approval.approvedAt) <= now && Date.parse(approval.approvedAt) < Date.parse(review.reviewExpiresAt), 'EVENT_EXACT_TIMED_APPROVAL_REQUIRED');
  return approval;
}

export function validateEventPublicationJournal(review: EventPublicationReview, reviewSha256: string, journal: EventPublicationJournal) {
  requirePublication(journal.version === 1 && journal.reviewSha256 === reviewSha256 && Array.isArray(journal.entries) && journal.entries.length <= 2
    && new Set(journal.entries.map(entry => entry.label)).size === journal.entries.length, 'EVENT_ENCRYPTED_JOURNAL_SCOPE_CHANGED');
  for (const entry of journal.entries) {
    requirePublication(review.records.some(record => record.label === entry.label), 'EVENT_JOURNAL_OWNER_NOT_REVIEWED');
    requirePublication(['message_signing', 'message_signed', 'preparing', 'prepared', 'signing', 'signed', 'broadcast_admitted', 'submitted', 'receipt_confirmed', 'confirmed', 'reverted'].includes(entry.state), 'EVENT_JOURNAL_STATE_INVALID');
    const reserved = BigInt(entry.receipt?.actualFeeWei ?? entry.envelope?.maximumFeeWei ?? entry.prepared?.maximumFeeWei ?? '0');
    requirePublication(reserved >= 0n && reserved <= EVENT_PUBLICATION_FEE_CAP, 'EVENT_OWNER_AGGREGATE_FEE_EXCEEDED');
    if (entry.raw || entry.hash || entry.broadcastAttemptedAt) requirePublication(entry.raw && entry.hash && entry.envelope && keccak256(entry.raw) === entry.hash, 'EVENT_SIGNED_JOURNAL_BINDING_INVALID');
    if (['broadcast_admitted', 'submitted', 'receipt_confirmed', 'confirmed', 'reverted'].includes(entry.state)) requirePublication(entry.broadcastAttemptedAt, 'EVENT_DURABLE_ADMISSION_REQUIRED');
  }
}

/** Pinned SDK 1.0.1 ABI: validate every named attribute, not only the native contract destination. */
export function assertEventCreateCalldata(data: Hex, record: RecordValue, signature: Hex, head: { number: bigint }, now = Date.now()) {
  const intent = canonicalIntent(record.intent), decoded = decodeFunctionData({ abi: executeAbi, data });
  requirePublication(decoded.functionName === 'execute' && decoded.args[0].length === 1 && decoded.args[0][0].operation === 1, 'EVENT_ONLY_ONE_NATIVE_CREATE_ALLOWED');
  const [create] = decodeAbiParameters(createParams, decoded.args[0][0].operationData);
  const expectedTarget = head.number + BigInt(Math.ceil((Date.parse(intent.expiresAt) - now) / 2000));
  requirePublication(create.creationFlags === 1 && create.minLifetime === 0n && create.expiresAt > head.number && create.expiresAt <= head.number + 43201n
    && create.expiresAt >= expectedTarget - 120n && create.expiresAt <= expectedTarget + 120n, 'EVENT_CREATE_FLAGS_OR_EXPIRY_CHANGED');
  const values: Record<string, string | number | boolean> = {
    'arkiv.schema': ARKIV_SCHEMA_NAME, intentId: intent.intentId, ensAgentRef: intent.ensAgentRef, goal: intent.goal, visibility: 'public', optIn: true, owner: intent.owner,
    version: intent.version, policyVersion: intent.policyVersion, schemaVersion: 2, status: 'active', direction: intent.semantics.direction, category: intent.semantics.category,
    canonicalRole: canonicalRoleLabel(intent.semantics.canonicalRole?.value || '').slice(0, 32), createdAt: Date.parse(intent.createdAt), expiresAt: Date.parse(intent.expiresAt), demoOrigin: true,
    envelope: JSON.stringify({ intent, signature }), ...Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`tag${index}`, intent.tags[index] ?? ''])),
  };
  const types: Record<string, number> = { bool: 1, u64: 3, bytes: 7, str: 8, addr: 9 };
  requirePublication(create.attributes.length === Object.keys(values).length && new Set(create.attributes.map(attribute => attribute.name.toLowerCase())).size === create.attributes.length, 'EVENT_CREATE_ATTRIBUTE_COUNT_CHANGED');
  for (const [name, value] of Object.entries(values)) {
    const column = name === 'arkiv.schema' ? { type: 'str', isIndexed: true } : PublicIntents.columns[name as keyof typeof PublicIntents.columns];
    requirePublication(column && types[column.type], 'EVENT_UNSUPPORTED_PINNED_ATTRIBUTE_TYPE');
    const typeId = types[column.type] | (column.isIndexed ? 128 : 0);
    const encoded = column.type === 'str' || column.type === 'bytes' ? stringToHex(String(value)) : column.type === 'bool' ? toHex(value ? 1n : 0n, { size: 32 })
      : column.type === 'addr' ? toHex(BigInt(String(value)), { size: 32 }) : toHex(BigInt(value), { size: 32 });
    const actual = create.attributes.find(attribute => same(attribute.name, stringToHex(name, { size: 32 })));
    requirePublication(actual && actual.typeId === typeId && same(actual.value, encoded), 'EVENT_CREATE_ATTRIBUTE_OR_APPROVED_ENVELOPE_CHANGED');
  }
}

export function assertEventPrepared(record: RecordValue, signature: Hex, prepared: PreparedArkivTransaction, head: { number: bigint; gasLimit: bigint }, now = Date.now()): EventPublicationEnvelope {
  const request = prepared.request;
  requirePublication(prepared.chainId === 7794095 && request.chainId === '0x76edaf' && request.type === '0x0' && request.value === '0x0'
    && same(prepared.account, record.intent.owner) && same(request.from, record.intent.owner) && same(request.to, ARKIV_NATIVE_ADDRESS)
    && prepared.payloadDigest === record.payloadDigest && intentDigest(prepared.intent) === record.payloadDigest
    && Number.isFinite(Date.parse(prepared.preparedAt)) && Date.parse(prepared.preparedAt) <= now + 2000 && Date.parse(prepared.expiresAt) > now
    && Date.parse(prepared.expiresAt) <= Date.parse(prepared.preparedAt) + 60000 && Date.parse(prepared.expiresAt) <= Date.parse(record.intent.expiresAt), 'EVENT_PREPARED_PUBLICATION_SCOPE_OR_EXPIRY_CHANGED');
  for (const quantity of [request.gas, request.gasPrice, request.nonce]) requirePublication(/^0x[0-9a-f]+$/i.test(quantity), 'EVENT_PREPARED_QUANTITY_INVALID');
  const gas = BigInt(request.gas), price = BigInt(request.gasPrice), fee = gas * price, nonce = Number(BigInt(request.nonce));
  requirePublication(gas >= 1000000n && gas <= head.gasLimit / 2n && price > 0n && fee === BigInt(prepared.maximumFeeWei) && fee <= EVENT_PUBLICATION_FEE_CAP
    && Number.isSafeInteger(nonce) && nonce >= 0, 'EVENT_PREPARED_GAS_NONCE_OR_FEE_EXCEEDED');
  assertEventCreateCalldata(request.data, record, signature, head, now);
  return { from: getAddress(record.intent.owner), to: getAddress(ARKIV_NATIVE_ADDRESS), data: request.data, valueWei: '0', nonce, gas: gas.toString(), gasPrice: price.toString(), maximumFeeWei: fee.toString() };
}

export async function assertEventSigned(entry: EventPublicationEntry, record: RecordValue) {
  requirePublication(entry.raw && entry.hash && entry.envelope && entry.prepared && entry.signature, 'EVENT_DURABLE_SIGNED_ENVELOPE_REQUIRED');
  const tx = parseTransaction(entry.raw), e = entry.envelope, request = entry.prepared.request;
  requirePublication(keccak256(entry.raw) === entry.hash && tx.type === 'legacy' && tx.chainId === 7794095 && tx.to && same(tx.to, ARKIV_NATIVE_ADDRESS)
    && same(e.from, record.intent.owner) && same(e.to, ARKIV_NATIVE_ADDRESS) && same(tx.data || '0x', e.data) && e.data === request.data
    && (tx.value || 0n) === 0n && e.valueWei === '0' && tx.nonce === e.nonce && tx.gas?.toString() === e.gas && tx.gasPrice?.toString() === e.gasPrice
    && BigInt(e.gas) === BigInt(request.gas) && BigInt(e.gasPrice) === BigInt(request.gasPrice) && BigInt(e.nonce) === BigInt(request.nonce)
    && BigInt(e.maximumFeeWei) === BigInt(e.gas) * BigInt(e.gasPrice) && BigInt(e.maximumFeeWei) <= EVENT_PUBLICATION_FEE_CAP
    && entry.prepared.payloadDigest === record.payloadDigest && intentDigest(entry.prepared.intent) === record.payloadDigest
    && same(await recoverTransactionAddress({ serializedTransaction: entry.raw as TransactionSerialized }), record.intent.owner)
    && await verifyMessage({ address: getAddress(record.intent.owner), message: record.signingMessage, signature: entry.signature }), 'EVENT_SIGNED_TRANSACTION_BINDING_CHANGED');
}

export async function admitEventPublication(entry: EventPublicationEntry, reviewExpiresAt: string, save: () => void, send: (raw: Hex) => Promise<Hex>, now = Date.now) {
  requirePublication(entry.state === 'signed' && entry.raw && entry.hash && !entry.broadcastAttemptedAt && keccak256(entry.raw) === entry.hash, 'EVENT_KNOWN_OR_UNCERTAIN_SUBMISSION_NO_RESEND');
  const deadline = { kind: 'publication' as const, reviewExpiresAt, quoteExpiresAt: entry.prepared?.expiresAt };
  assertAdmissionDeadline(deadline, now());
  entry.state = 'broadcast_admitted'; entry.broadcastAttemptedAt = new Date(now()).toISOString(); save();
  assertAdmissionDeadline(deadline, now());
  const hash = await send(entry.raw);
  requirePublication(hash === entry.hash, 'EVENT_RETURNED_TRANSACTION_HASH_CHANGED_PRESERVE_JOURNAL'); entry.state = 'submitted'; save();
}

async function main() {
  const mode = process.argv[2], option = (name: string) => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
  requirePublication(['review', 'inspect', 'execute', 'reconcile'].includes(mode || '') && process.argv.slice(3).every(value => value === '--execute-reviewed' || /^--review-sha256=[a-f0-9]{64}$/.test(value) || /^--label=(krishna|viha)$/.test(value)), 'EVENT_PUBLICATION_COMMAND_INVALID');
  mkdirSync('.local-data', { recursive: true }); const lockPath = '.local-data/event-demo-publication.lock', lock = openSync(lockPath, 'wx', 0o600);
  try {
    if (mode === 'review') {
      requirePublication(process.argv.length === 3 && existsSync(PREVIEW) && existsSync(FLOW) && !existsSync(EVENT_PUBLICATION_REVIEW) && !existsSync(EVENT_PUBLICATION_APPROVAL) && !existsSync(EVENT_PUBLICATION_JOURNAL), 'EVENT_ACTUAL_PREVIEW_REQUIRED_PRESERVE_EXISTING_REVIEW');
    }
    let review: EventPublicationReview | undefined, reviewSha256: string | undefined, journal: EventPublicationJournal | undefined;
    if (mode !== 'review') {
      const raw = readFileSync(EVENT_PUBLICATION_REVIEW, 'utf8'); reviewSha256 = sha256(raw); requirePublication(option('review-sha256') === reviewSha256, 'EVENT_EXACT_REVIEW_HASH_REQUIRED');
      review = validateEventPublicationReview(JSON.parse(raw));
      journal = existsSync(EVENT_PUBLICATION_JOURNAL) ? decrypt<EventPublicationJournal>(readFileSync(EVENT_PUBLICATION_JOURNAL, 'utf8'), `meeti-event-demo-publication-v1:${reviewSha256}`) : { version: 1, reviewSha256, entries: [] };
      validateEventPublicationJournal(review, reviewSha256, journal);
      if (mode === 'inspect') { console.log(JSON.stringify({ mode, reviewSha256, reviewExpiresAt: review.reviewExpiresAt, records: review.records.map(({ label, accountId, intent }) => ({ label, accountId, intentId: intent.intentId, owner: intent.owner })), entries: journal.entries.map(({ label, state, hash, entityKey, receipt }) => ({ label, state, hash, entityKey, receipt })), signatures: 0, broadcasts: 0 }, null, 2)); return; }
      requirePublication(process.argv.includes('--execute-reviewed'), 'EVENT_EXPLICIT_REVIEWED_EXECUTION_REQUIRED');
      validateEventPublicationApproval(review, reviewSha256, JSON.parse(readFileSync(EVENT_PUBLICATION_APPROVAL, 'utf8')));
      if (mode === 'execute') requirePublication(Date.parse(review.reviewExpiresAt) > Date.now(), 'EVENT_REVIEW_EXPIRED_NO_NEW_SIGNATURE');
    }
    verifySdk();
    const vault = eventVaultSchema.parse(decrypt<unknown>(readFileSync(EVENT_VAULT_PATH, 'utf8'), EVENT_VAULT_CONTEXT));
    const source = eventFlowSource(vault), client = clientFromEnv();
    const flow = z.object({ version: z.literal(1), origin: z.literal(EVENT_ORIGIN), sourceDigest: digest32,
      previews: z.object({ krishna: PublicIntentSchema, viha: PublicIntentSchema }).strict(),
      drafts: z.object({ krishna: z.object({ intentId: z.string().uuid(), state: z.literal('confirmed') }), viha: z.object({ intentId: z.string().uuid(), state: z.literal('confirmed') }) }).strict(),
    }).parse(decrypt<unknown>(readFileSync(FLOW, 'utf8'), 'meeti-event-demo-flow-v1'));
    requirePublication(flow.sourceDigest === digest(source), 'EVENT_FLOW_SOURCE_BINDING_CHANGED');
    if (review) requirePublication(review.flowSourceDigest === flow.sourceDigest && review.previewSha256 === sha256(readFileSync(PREVIEW, 'utf8')), 'EVENT_REVIEWED_PREVIEW_FILE_CHANGED');
    async function api<T>(label: EventLabel, path: string, body?: unknown): Promise<T> {
      const wallet = vault.wallets.find(item => item.label === label)!;
      requirePublication(/^meeti_session=[a-f0-9]{64}$/.test(wallet.session || ''), 'EVENT_VALID_SESSION_REQUIRED');
      requirePublication(['state', 'agent/check', 'intent/publish', 'operations', 'intent/confirm'].includes(path) || /^operations\/[a-f0-9-]{36}\/submitted$/.test(path), 'EVENT_UNSUPPORTED_API_ACTION');
      const response = await fetch(`${EVENT_ORIGIN}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(120000),
        headers: { origin: EVENT_ORIGIN, cookie: wallet.session!, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      requirePublication(response.ok, `EVENT_PUBLICATION_HTTP_${response.status}`); const result = await response.json();
      requirePublication(result && result.data !== undefined && !result.error, 'EVENT_API_DATA_REQUIRED'); return result.data as T;
    }
    async function freshChain(expectedGenesis?: string) {
      const [chainId, block, genesis] = await Promise.all([client.getChainId(), client.getBlock({ blockTag: 'latest' }), client.getBlock({ blockNumber: 0n })]);
      requirePublication(chainId === 7794095 && genesis.hash && (!expectedGenesis || genesis.hash === expectedGenesis) && Math.abs(Date.now() / 1000 - Number(block.timestamp)) < 90, 'EVENT_OFFICIAL_RABDI_GENESIS_OR_HEAD_INVALID');
      return { block, genesisHash: genesis.hash };
    }
    async function freshScope(label: EventLabel, expected?: RecordValue, draft = true) {
      const expectedSource = source.records.find(item => item.label === label)!, current = await api<AppState>(label, 'state'), a = current.agent;
      const payload = canonicalIntent(flow.previews[label]), currentIntent = current.intents.find(intent => intent.id === payload.intentId);
      requirePublication(current.user.id === expectedSource.accountId && current.user.wallet && same(current.user.wallet, expectedSource.owner) && a && a.ensName === expectedSource.ensAgentRef
        && same(a.owner, expectedSource.owner) && same(a.delegate, expectedSource.delegate) && current.profile.aiConsent && current.profile.publicFields.length === 0
        && current.integrations?.world.status === 'deferred' && currentIntent && currentIntent.version === payload.version && currentIntent.policyVersion === payload.policyVersion
        && currentIntent.demoOrigin && ['draft', 'published'].includes(currentIntent.status) && (!draft || currentIntent.status === 'draft')
        && Date.parse(currentIntent.expiresAt) > Date.now() && flow.drafts[label].intentId === payload.intentId, 'EVENT_CURRENT_ACCOUNT_AGENT_OR_INTENT_CHANGED');
      const checked = await api<Agent>(label, 'agent/check', {}), observed = checked.authority?.evidence as { blockNumber?: string } | undefined;
      requirePublication(checked.authority?.allowed && checked.policy.purpose === 'collaborator' && !checked.policy.paused && checked.policy.version === payload.policyVersion
        && Date.parse(checked.policy.expiresAt) > Date.now() && checked.config.resolverAddress && observed?.blockNumber && /^\d+$/.test(observed.blockNumber)
        && checked.ensName === a.ensName && same(checked.owner, a.owner) && same(checked.delegate, a.delegate), 'EVENT_FRESH_ENS_AUTHORITY_REQUIRED');
      if (expected) requirePublication(intentDigest(payload) === expected.payloadDigest && current.user.id === expected.accountId && policyDigest(checked.policy) === expected.ens.policyDigest
        && same(String(checked.config.resolverAddress), expected.ens.resolver), 'EVENT_REVIEWED_ENS_OR_PAYLOAD_CHANGED');
      if (draft) {
        const preview = await api<{ intent: unknown; signingMessage: string }>(label, 'intent/publish', { intentId: payload.intentId });
        requirePublication(intentDigest(preview.intent) === intentDigest(payload) && preview.signingMessage === intentSigningMessage(payload), 'EVENT_ACTUAL_BACKEND_PREVIEW_CHANGED');
      }
      return { current, checked, observed: observed!, payload };
    }
    if (mode === 'review') {
      const previewRaw = readFileSync(PREVIEW, 'utf8'), preview = z.object({ version: z.literal(1), stage: z.literal('preview'), origin: z.literal(EVENT_ORIGIN), fictional: z.literal(true), humanVerified: z.literal(false), reviewOnly: z.literal(true),
        records: z.array(z.object({ label: z.enum(eventLabels), accountId: z.string().uuid(), intentId: z.string().uuid(), intent: PublicIntentSchema, payloadDigest: hash32, signingMessage: z.string() })).length(2),
      }).parse(JSON.parse(previewRaw));
      requirePublication(new Set(preview.records.map(record => record.label)).size === 2, 'EVENT_BOTH_ACTUAL_PREVIEWS_REQUIRED');
      const records: RecordValue[] = [];
      for (const label of eventLabels) {
        const { current, checked, observed, payload } = await freshScope(label), saved = preview.records.find(record => record.label === label)!;
        requirePublication(saved.accountId === current.user.id && saved.intentId === payload.intentId && saved.payloadDigest === intentDigest(payload)
          && intentDigest(saved.intent) === intentDigest(payload) && saved.signingMessage === intentSigningMessage(payload), 'EVENT_PREVIEW_REPORT_BINDING_CHANGED');
        records.push({ label, accountId: current.user.id, intent: payload, payloadDigest: intentDigest(payload), signingMessage: intentSigningMessage(payload), balanceWei: (await client.getBalance({ address: getAddress(payload.owner), blockTag: 'latest' })).toString(),
          ens: { ensName: checked.ensName, owner: checked.owner, delegate: checked.delegate, resolver: String(checked.config.resolverAddress), policyVersion: checked.policy.version, policyDigest: policyDigest(checked.policy), checkedAt: checked.authority!.checkedAt, blockNumber: observed.blockNumber! } });
      }
      const { block, genesisHash } = await freshChain(), gasPrice = await client.getGasPrice(), now = Date.now();
      const prepared = validateEventPublicationReview({ version: 1, reviewOnly: true, fictional: true, humanVerified: false, scope: 'event-krishna-viha-publications-only', origin: EVENT_ORIGIN, chainId: 7794095, sdkVersion: '1.0.1',
        createdAt: new Date(now).toISOString(), reviewExpiresAt: new Date(Math.min(now + 7200000, ...records.map(record => Date.parse(record.intent.expiresAt) - 60000))).toISOString(), previewSha256: sha256(previewRaw), flowSourceDigest: flow.sourceDigest,
        genesisHash, observedBlock: block.number.toString(), observedBlockGasLimit: block.gasLimit.toString(), observedGasPriceWei: gasPrice.toString(), maximumPublicationFeePerOwnerWei: EVENT_PUBLICATION_FEE_CAP.toString(), publications: 2, fundingTransfers: 0, records });
      const raw = JSON.stringify(prepared, null, 2); mkdirSync('artifacts', { recursive: true }); writeFileSync(EVENT_PUBLICATION_REVIEW, raw, { flag: 'wx', mode: 0o600 });
      console.log(JSON.stringify({ reviewOnly: true, file: EVENT_PUBLICATION_REVIEW, reviewSha256: sha256(raw), reviewExpiresAt: prepared.reviewExpiresAt, publications: 2, fundingTransfers: 0, maximumPublicationFeePerOwnerWei: EVENT_PUBLICATION_FEE_CAP.toString(), signatures: 0, broadcasts: 0 }, null, 2)); return;
    }
    const approved = review!, activeJournal = journal!, label = z.enum(eventLabels).parse(option('label')), record = approved.records.find(item => item.label === label)!;
    const context = `meeti-event-demo-publication-v1:${reviewSha256}`;
    function save() {
      validateEventPublicationJournal(approved, reviewSha256!, activeJournal); const ciphertext = encrypt(activeJournal, context), temporary = `${EVENT_PUBLICATION_JOURNAL}.tmp`;
      writeFileSync(temporary, ciphertext, { mode: 0o600 }); const fd = openSync(temporary, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, EVENT_PUBLICATION_JOURNAL); requirePublication(readFileSync(EVENT_PUBLICATION_JOURNAL, 'utf8') === ciphertext, 'EVENT_PUBLICATION_JOURNAL_NOT_DURABLE');
    }
    async function reconcile(entry: EventPublicationEntry) {
      await assertEventSigned(entry, record); await freshChain(approved.genesisHash);
      requirePublication(entry.broadcastAttemptedAt && entry.hash && entry.envelope && entry.prepared && entry.operationId, 'EVENT_RECONCILE_REQUIRES_KNOWN_ADMITTED_TRANSACTION');
      const receipt = await client.waitForTransactionReceipt({ hash: entry.hash, confirmations: 2, timeout: 90000, pollingInterval: 3000 }), tx = await client.getTransaction({ hash: entry.hash }), e = entry.envelope;
      requirePublication(receipt.transactionHash === entry.hash && tx.hash === entry.hash && same(tx.from, record.intent.owner) && tx.to && same(tx.to, e.to) && same(tx.input, e.data)
        && tx.value === 0n && tx.nonce === e.nonce && tx.gas.toString() === e.gas && tx.gasPrice?.toString() === e.gasPrice, 'EVENT_CANONICAL_TRANSACTION_ENVELOPE_CHANGED');
      const actualFee = receipt.gasUsed * receipt.effectiveGasPrice;
      requirePublication(actualFee <= BigInt(e.maximumFeeWei) && actualFee <= EVENT_PUBLICATION_FEE_CAP, 'EVENT_RECEIPT_FEE_CAP_EXCEEDED');
      const confirmedReceipt = { blockNumber: receipt.blockNumber.toString(), blockHash: receipt.blockHash, actualFeeWei: actualFee.toString() };
      if (receipt.status !== 'success') { entry.receipt = confirmedReceipt; entry.state = 'reverted'; save(); throw new EventPublicationError('EVENT_REVERT_NO_AUTOMATIC_RETRY'); }
      const { block } = await freshChain(approved.genesisHash), canonical = await client.getBlock({ blockNumber: receipt.blockNumber });
      requirePublication(block.number >= receipt.blockNumber + 1n && canonical.hash === receipt.blockHash, 'EVENT_SECOND_CANONICAL_CONFIRMATION_REQUIRED');
      entry.receipt = confirmedReceipt; if (entry.state !== 'confirmed') entry.state = 'receipt_confirmed'; save();
      const { current } = await freshScope(label, record, false), published = current.intents.find(intent => intent.id === record.intent.intentId)!;
      if (published.status !== 'published') { await api(label, `operations/${entry.operationId}/submitted`, { transactionHash: entry.hash }); await api(label, 'intent/confirm', { intentId: record.intent.intentId, operationId: entry.operationId, txHash: entry.hash }); }
      const state = await api<AppState>(label, 'state'), read = state.intents.find(intent => intent.id === record.intent.intentId);
      requirePublication(read?.status === 'published' && read.version === record.intent.version && read.transactionHash === entry.hash && read.arkivKey, 'EVENT_APPLICATION_PUBLICATION_NOT_CONFIRMED');
      const sdk = await createArkivAdapter({ accessKey: process.env.ARKIV_ACCESS_KEY! }).verifyPublished({ entityKey: read.arkivKey, txHash: entry.hash, expectedIntent: record.intent, expectedTransaction: entry.prepared.request });
      requirePublication(intentDigest(sdk.intent) === record.payloadDigest && same(sdk.owner, record.intent.owner) && same(sdk.creator, record.intent.owner), 'EVENT_SDK_READBACK_CHANGED');
      entry.entityKey = sdk.entityKey; entry.state = 'confirmed'; save();
      console.log(JSON.stringify({ label, state: entry.state, hash: entry.hash, entityKey: entry.entityKey, receipt: entry.receipt, chainId: 7794095 }));
    }
    let entry = activeJournal.entries.find(item => item.label === label);
    if (mode === 'reconcile') { requirePublication(entry, 'EVENT_EXISTING_JOURNAL_ENTRY_REQUIRED'); await reconcile(entry); return; }
    requirePublication(activeJournal.entries.every(item => item.label === label || item.state === 'confirmed') && (!entry || !['signing', 'signed', 'broadcast_admitted', 'submitted', 'receipt_confirmed', 'confirmed', 'reverted'].includes(entry.state))
      && !entry?.raw && !entry?.hash && !entry?.broadcastAttemptedAt, 'EVENT_UNCERTAIN_OR_COMPLETED_SCOPE_REQUIRES_RECONCILIATION_NO_RESEND');
    const wallet = vault.wallets.find(item => item.label === label)!, account = privateKeyToAccount(wallet.ownerKey);
    requirePublication(wallet.accountId === record.accountId && same(account.address, record.intent.owner), 'EVENT_GENERATED_OWNER_KEY_CHANGED');
    await freshScope(label, record); await freshChain(approved.genesisHash);
    if (!entry) {
      entry = { label, state: 'message_signing' }; activeJournal.entries.push(entry); save();
      requirePublication(Date.parse(approved.reviewExpiresAt) > Date.now() && Date.parse(record.intent.expiresAt) > Date.now(), 'EVENT_REVIEW_OR_INTENT_EXPIRED_BEFORE_MESSAGE_SIGNATURE');
      entry.signature = await account.signMessage({ message: record.signingMessage }); entry.state = 'message_signed'; save();
    }
    requirePublication(entry.signature && await verifyMessage({ address: account.address, message: record.signingMessage, signature: entry.signature }), 'EVENT_MESSAGE_SIGNATURE_UNKNOWN_STOP_NO_REPEAT');
    if (!entry.prepared) {
      if (entry.state === 'preparing') {
        const operations = await api<{ id: string; kind: string; state: string; data: { intent?: unknown; transaction?: PreparedArkivTransaction } }[]>(label, 'operations');
        const matching = operations.filter(value => value.kind === `arkiv:${record.intent.intentId}:${record.intent.version}` && value.state === 'prepared' && value.data.intent && intentDigest(value.data.intent) === record.payloadDigest && value.data.transaction);
        requirePublication(matching.length === 1, 'EVENT_UNCERTAIN_PREPARATION_REQUIRES_EXACT_OPERATION'); entry.operationId = matching[0].id; entry.prepared = matching[0].data.transaction;
      } else {
        requirePublication(entry.state === 'message_signed', 'EVENT_PREPARATION_STATE_INVALID'); entry.state = 'preparing'; save();
        const result = await api<{ operationId: string; transaction: PreparedArkivTransaction }>(label, 'intent/publish', { intentId: record.intent.intentId, signature: entry.signature, maxFeeWei: EVENT_PUBLICATION_FEE_CAP.toString() });
        entry.operationId = z.string().uuid().parse(result.operationId); entry.prepared = result.transaction;
      }
      entry.state = 'prepared'; save();
    }
    requirePublication(entry.prepared && entry.operationId, 'EVENT_PREPARED_APPLICATION_OPERATION_REQUIRED');
    const operations = await api<{ id: string; kind: string; state: string; data: { transaction?: PreparedArkivTransaction } }[]>(label, 'operations');
    requirePublication(operations.some(op => op.id === entry!.operationId && op.kind === `arkiv:${record.intent.intentId}:${record.intent.version}` && op.state === 'prepared' && JSON.stringify(op.data.transaction) === JSON.stringify(entry!.prepared)), 'EVENT_APPLICATION_OPERATION_CHANGED');
    const { block } = await freshChain(approved.genesisHash); entry.envelope = assertEventPrepared(record, entry.signature, entry.prepared, block); save();
    const active = entry; requirePublication(active.envelope, 'EVENT_VALIDATED_ENVELOPE_REQUIRED'); const e = active.envelope;
    const refreshRabdi = async () => {
      const { block } = await freshChain(approved.genesisHash), [nonce, pending, price, estimate, balance] = await Promise.all([client.getTransactionCount({ address: account.address, blockTag: 'latest' }), client.getTransactionCount({ address: account.address, blockTag: 'pending' }), client.getGasPrice(), client.estimateGas({ account: account.address, to: e.to, data: e.data, value: 0n, blockTag: 'latest' }), client.getBalance({ address: account.address, blockTag: 'latest' })]);
      requirePublication(nonce === e.nonce && pending === nonce && price.toString() === e.gasPrice && BigInt(e.gas) >= minimumGas(estimate, block.gasLimit)
        && BigInt(e.gas) <= block.gasLimit / 2n && balance >= BigInt(e.maximumFeeWei), 'EVENT_FINAL_LATEST_NONCE_GAS_PRICE_OR_BALANCE_CHANGED');
      assertEventPrepared(record, active.signature!, active.prepared!, block);
    };
    const raw = await signWithFreshAdmission({ kind: 'publication', reviewExpiresAt: approved.reviewExpiresAt, quoteExpiresAt: active.prepared!.expiresAt,
      refreshEns: async () => { await freshScope(label, record); }, refreshRabdi,
      sign: async () => { active.state = 'signing'; save(); return account.signTransaction({ type: 'legacy', chainId: 7794095, nonce: e.nonce, to: e.to, data: e.data, value: 0n, gas: BigInt(e.gas), gasPrice: BigInt(e.gasPrice) }); } });
    active.raw = raw; active.hash = keccak256(raw); active.state = 'signed'; await assertEventSigned(active, record); save();
    await admitEventPublication(active, approved.reviewExpiresAt, save, serializedTransaction => client.sendRawTransaction({ serializedTransaction }));
    await reconcile(active);
  } finally { closeSync(lock); unlinkSync(lockPath); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main().catch(error => { console.error(JSON.stringify({ code: error instanceof EventPublicationError ? error.code : 'EVENT_PUBLICATION_STOPPED_PRESERVE_JOURNAL_NO_PRIVATE_DETAILS' })); process.exitCode = 1; });

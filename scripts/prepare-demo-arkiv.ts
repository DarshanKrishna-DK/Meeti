import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { createPublicClient, getAddress, http } from 'viem';
import { rabdi } from '@arkiv-network/sdk/chains';
import { canonicalIntent, intentDigest, intentSigningMessage, PublicIntentSchema, type PublicIntent } from '../packages/arkiv/src';
import { decrypt } from '../packages/server/crypto';
import { policyDigest } from '../packages/server/policy';
import type { AppState } from '../packages/shared/src';

export const ISSUER = getAddress('0x9253705482a44e6A7378163e57cc791AE6213ed5');
export const LABELS = ['demo-seeker', 'demo-recruiter'] as const;
export const CASES = ['job', 'collaboration'] as const;
export type Label = typeof LABELS[number];
export const REVIEW_PATH = 'artifacts/demo-arkiv-review.json';
export const APPROVAL_PATH = '.local-data/demo-arkiv-approval.json';
export const JOURNAL_PATH = '.local-data/demo-arkiv-journal.enc';
export const FUND_AMOUNT = 20_000_000_000_000_000n;
export const FUND_GAS_CAP = 5_000_000_000_000_000n;
export const ISSUER_TOTAL_CAP = 50_000_000_000_000_000n;
export const OWNER_FEE_CAP = 10_000_000_000_000_000n;
export const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');
export const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
export class ArkivGuardError extends Error {}
export function requireCheck(value: unknown, code: string): asserts value { if (!value) throw new ArkivGuardError(code); }
const decimal = z.string().regex(/^(0|[1-9][0-9]*)$/);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/);
const recordSchema = z.object({ id: z.string(), label: z.enum(LABELS), case: z.enum(CASES), accountId: z.string().uuid(), intent: PublicIntentSchema,
  signingMessage: z.string(), payloadDigest: hex32, ens: z.object({ ensName: z.string(), owner: address, delegate: address, resolver: address,
    policyVersion: z.number().int().positive(), policyDigest: hex32, checkedAt: z.string().datetime(), blockNumber: decimal }).strict() }).strict();
const fundingSchema = z.object({ id: z.string(), label: z.enum(LABELS), from: address, to: address, valueWei: z.literal('20000000000000000'),
  data: z.literal('0x'), gasLimit: decimal, maximumGasPriceWei: decimal, maximumGasCostWei: z.literal('5000000000000000') }).strict();
export const reviewSchema = z.object({ version: z.literal(1), reviewOnly: z.literal(true), fictional: z.literal(true), humanVerified: z.literal(false),
  chainId: z.literal(7794095), sdkVersion: z.literal('1.0.1'), origin: z.string().url(), createdAt: z.string().datetime(), reviewExpiresAt: z.string().datetime(),
  issuer: z.literal(ISSUER), issuerMaximumFundsAndGasWei: z.literal('50000000000000000'), maximumPublicationFeePerOwnerWei: z.literal('10000000000000000'),
  genesisHash: hex32, observedBlock: decimal, observedBlockGasLimit: decimal, observedGasPriceWei: decimal,
  balances: z.array(z.object({ address, balanceWei: decimal }).strict()).length(3), funding: z.array(fundingSchema).length(2),
  records: z.array(recordSchema).length(4), guidance: z.array(z.string().url()).min(2),
}).strict();
export type Review = z.infer<typeof reviewSchema>;
export type SavedDemo = { version: 1; origin: string; sessions: Partial<Record<Label, string>>; accounts: Partial<Record<Label, string>>;
  prepared: Partial<Record<`${typeof CASES[number]}:${Label}`, { intentId?: string; publicPreview?: PublicIntent }>> };

export function minimumGas(estimate: bigint, blockGasLimit: bigint): bigint {
  requireCheck(estimate > 0n && blockGasLimit > 0n, 'invalid_latest_gas_observation');
  const gas = estimate * 2n > 1_000_000n ? estimate * 2n : 1_000_000n;
  requireCheck(gas <= blockGasLimit / 2n, 'required_gas_exceeds_latest_half_block'); return gas;
}
export function validateReview(input: unknown): Review {
  const value = reviewSchema.parse(input), keys = new Set<string>(), owners = new Map<Label, string>();
  const origin = new URL(value.origin);
  requireCheck(origin.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(origin.hostname) && origin.origin === value.origin, 'local_demo_origin_required');
  requireCheck(Date.parse(value.reviewExpiresAt) > Date.parse(value.createdAt), 'invalid_review_deadline');
  for (const record of value.records) {
    const key = `${record.case}:${record.label}`;
    requireCheck(record.id === key && !keys.has(key), 'duplicate_or_unexpected_record'); keys.add(key);
    const payload = canonicalIntent(record.intent);
    requireCheck(payload.demoOrigin && payload.status === 'active' && payload.optIn && payload.summary.includes('Fictional TEST DATA'), 'only_explicit_fictional_public_intents_allowed');
    requireCheck(record.signingMessage === intentSigningMessage(payload) && record.payloadDigest === intentDigest(payload), 'reviewed_public_payload_digest_mismatch');
    requireCheck(record.ens.ensName === `networking.${record.label}.users.meeti-demo.eth` && record.ens.ensName === payload.ensAgentRef
      && same(record.ens.owner, payload.owner) && record.ens.policyVersion === payload.policyVersion, 'owner_ens_policy_scope_mismatch');
    requireCheck(!owners.has(record.label) || same(owners.get(record.label)!, payload.owner), 'owner_changed_between_cases'); owners.set(record.label, payload.owner);
    requireCheck(Buffer.byteLength(JSON.stringify({ intent: payload, signature: `0x${'00'.repeat(65)}` })) <= 16384, 'public_envelope_too_large');
  }
  requireCheck(keys.size === 4 && owners.size === 2 && !same(owners.get('demo-seeker')!, owners.get('demo-recruiter')!), 'four_records_two_distinct_owners_required');
  requireCheck(new Set(value.records.map(record => record.intent.intentId)).size === 4, 'intent_ids_must_be_distinct');
  for (const label of LABELS) {
    const funding = value.funding.filter(item => item.label === label);
    requireCheck(funding.length === 1 && funding[0].id === `fund:${label}` && same(funding[0].from, ISSUER)
      && same(funding[0].to, owners.get(label)!) && !same(funding[0].to, ISSUER), 'funding_recipient_scope_mismatch');
    requireCheck(BigInt(funding[0].gasLimit) >= 1_000_000n && BigInt(funding[0].gasLimit) <= BigInt(value.observedBlockGasLimit) / 2n
      && BigInt(funding[0].gasLimit) * BigInt(funding[0].maximumGasPriceWei) <= FUND_GAS_CAP, 'funding_envelope_exceeds_cap');
  }
  requireCheck(value.funding.reduce((sum, item) => sum + BigInt(item.valueWei) + BigInt(item.maximumGasCostWei), 0n) === ISSUER_TOTAL_CAP, 'aggregate_funding_cap_mismatch');
  return value;
}
export function loadDemo(origin: string): SavedDemo {
  const saved = decrypt<SavedDemo>(readFileSync('.local-data/demo-core-flow.enc', 'utf8'), 'meeti-demo-core-flow-v1');
  requireCheck(saved.version === 1 && saved.origin === origin && saved.accounts['demo-seeker'] !== saved.accounts['demo-recruiter'], 'saved_demo_origin_or_accounts_mismatch');
  for (const label of LABELS) requireCheck(saved.accounts[label] && /^meeti_session=[0-9a-f]{64}$/.test(saved.sessions[label] || ''), 'authenticated_demo_session_required');
  return saved;
}
export async function api<T>(saved: SavedDemo, label: Label, endpoint: string, body?: unknown): Promise<T> {
  const response = await fetch(`${saved.origin}/api/${endpoint}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(120000),
    headers: { origin: saved.origin, cookie: saved.sessions[label]!, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json();
  requireCheck(response.ok, `application_${String(result.error?.code || response.status).replace(/[^A-Za-z0-9_]/g, '').toLowerCase()}_stopped`); return result.data as T;
}
export function clientFromEnv() {
  requireCheck(process.env.ARKIV_ACCESS_KEY, 'arkiv_access_key_required');
  return createPublicClient({ chain: rabdi({ accessKey: process.env.ARKIV_ACCESS_KEY }), cacheTime: 0,
    transport: http(undefined, { retryCount: 0, timeout: 12000, fetchOptions: { cache: 'no-store', redirect: 'error' } }) });
}
export function verifySdk() { requireCheck(JSON.parse(readFileSync('node_modules/@arkiv-network/sdk/package.json', 'utf8')).version === '1.0.1', 'exact_sdk_1_0_1_required'); }
export function selfCheck() {
  assert.equal(minimumGas(21000n, 30_000_000n), 1_000_000n);
  assert.equal(minimumGas(750000n, 3_000_000n), 1_500_000n);
  assert.throws(() => minimumGas(750001n, 3_000_000n)); assert.throws(() => minimumGas(0n, 3000000n));
  assert.throws(() => minimumGas(1n, 1_999_999n));
  assert.equal(2n * (FUND_AMOUNT + FUND_GAS_CAP), ISSUER_TOTAL_CAP);
  assert.equal(2n * 5_000_000_000_000_000n, OWNER_FEE_CAP);
  assert.throws(() => validateReview({ chainId: 1 }));
  // These validators use explicitly synthetic fixtures, not RPC or model responses.
  const timestamp = '2026-11-07T00:00:00.000Z', owners = [`0x${'11'.repeat(20)}`, `0x${'22'.repeat(20)}`];
  const records = CASES.flatMap(category => LABELS.map((label, index) => {
    const summary = 'Fictional TEST DATA. I want to collaborate on developer documentation.';
    const intent: PublicIntent = { intentId: `${category}:${label}`, ensAgentRef: `networking.${label}.users.meeti-demo.eth`, goal: 'collaborator', tags: ['documentation'], summary,
      visibility: 'public', optIn: true, schemaVersion: 2, status: 'active', owner: owners[index], version: 1, policyVersion: 2, createdAt: timestamp, expiresAt: '2026-11-08T00:00:00.000Z', demoOrigin: true,
      semantics: { schemaVersion: 1, category: 'collaborator', categoryEvidence: 'collaborate', direction: 'collaborating', directionEvidence: 'collaborate',
        canonicalRole: null, topics: [], offers: [], requirements: [], clarificationQuestions: [] } };
    return { id: `${category}:${label}`, label, case: category, accountId: `00000000-0000-4000-8000-00000000000${index}`,
      intent, signingMessage: intentSigningMessage(intent), payloadDigest: intentDigest(intent), ens: { ensName: intent.ensAgentRef, owner: owners[index], delegate: ISSUER,
        resolver: `0x${'33'.repeat(20)}`, policyVersion: 2, policyDigest: `0x${'44'.repeat(32)}`, checkedAt: timestamp, blockNumber: '1' } };
  }));
  const fixture = { version: 1, reviewOnly: true, fictional: true, humanVerified: false, chainId: 7794095, sdkVersion: '1.0.1', origin: 'http://127.0.0.1:3173',
    createdAt: timestamp, reviewExpiresAt: '2026-11-07T01:00:00.000Z', issuer: ISSUER, issuerMaximumFundsAndGasWei: ISSUER_TOTAL_CAP.toString(), maximumPublicationFeePerOwnerWei: OWNER_FEE_CAP.toString(),
    genesisHash: `0x${'55'.repeat(32)}`, observedBlock: '1', observedBlockGasLimit: '30000000', observedGasPriceWei: '1',
    balances: [ISSUER, ...owners].map(address => ({ address, balanceWei: '0' })), funding: LABELS.map((label, index) => ({ id: `fund:${label}`, label, from: ISSUER, to: owners[index],
      valueWei: FUND_AMOUNT.toString(), data: '0x', gasLimit: '1000000', maximumGasPriceWei: '5000000000', maximumGasCostWei: FUND_GAS_CAP.toString() })), records,
    guidance: ['https://docs.arkiv.network/', 'https://hub.arkiv.network/networks'] };
  assert.equal(validateReview(fixture).records.length, 4);
  const reject = (mutate: (value: typeof fixture) => void) => { const changed = structuredClone(fixture); mutate(changed); assert.throws(() => validateReview(changed)); };
  reject(value => { value.records[0].intent.summary += ' changed'; });
  reject(value => { value.records[0].ens.owner = owners[1]; });
  reject(value => { value.records[0].ens.policyVersion++; });
  reject(value => { value.funding[0].to = ISSUER; });
  reject(value => { value.records[1].id = value.records[0].id; });
  reject(value => { value.funding[0].maximumGasPriceWei = '5000000001'; });
  reject(value => { value.records[1].intent.intentId = value.records[0].intent.intentId; value.records[1].signingMessage = intentSigningMessage(value.records[1].intent); value.records[1].payloadDigest = intentDigest(value.records[1].intent); });
  console.log(JSON.stringify({ offlineChecks: 16, passed: true, fixtureAuthorityOnly: true, signatures: 0, providerCalls: 0, chainWrites: 0 }));
}
async function main() {
  if (process.argv.includes('--self-check')) return selfCheck();
  requireCheck(!existsSync(REVIEW_PATH) && !existsSync(APPROVAL_PATH) && !existsSync(JOURNAL_PATH), 'preserve_existing_review_approval_and_journal_before_preparing_new_scope');
  verifySdk();
  const origin = new URL(process.env.APP_ORIGIN || 'http://127.0.0.1:3173').origin, saved = loadDemo(origin);
  for (const label of LABELS) for (const category of CASES) requireCheck(saved.prepared[`${category}:${label}`]?.publicPreview, 'four_actual_public_previews_required_run_reviewed_intake_first');
  const records: Review['records'] = [], states = new Map<Label, AppState>();
  for (const label of LABELS) {
    const state = await api<AppState>(saved, label, 'state'); states.set(label, state);
    requireCheck(state.user.id === saved.accounts[label] && state.profile.displayName === `Fictional TEST DATA ${label}` && state.user.wallet && state.agent
      && same(state.agent.owner, state.user.wallet), 'actual_demo_owner_and_agent_required');
    for (const category of CASES) {
      const source = saved.prepared[`${category}:${label}`]!, expected = canonicalIntent(source.publicPreview);
      const current = state.intents.find(intent => intent.id === source.intentId);
      requireCheck(current?.status === 'draft' && current.version === expected.version, 'only_current_unpublished_reviewed_drafts_allowed');
      const preview = await api<{ intent: PublicIntent; signingMessage: string }>(saved, label, 'intent/publish', { intentId: source.intentId });
      requireCheck(intentDigest(preview.intent) === intentDigest(expected) && preview.signingMessage === intentSigningMessage(expected), 'actual_public_preview_changed');
      const checked = await api<NonNullable<AppState['agent']>>(saved, label, 'agent/check', {});
      const authority = checked.authority?.evidence as { blockNumber?: string } | undefined;
      requireCheck(checked.authority?.allowed && checked.policy.version === expected.policyVersion && checked.config.resolverAddress
        && authority?.blockNumber && /^[0-9]+$/.test(authority.blockNumber), 'fresh_ens_authority_and_observed_block_required');
      records.push({ id: `${category}:${label}`, label, case: category, accountId: state.user.id, intent: expected, signingMessage: preview.signingMessage, payloadDigest: intentDigest(expected),
        ens: { ensName: checked.ensName, owner: checked.owner, delegate: checked.delegate, resolver: String(checked.config.resolverAddress), policyVersion: checked.policy.version,
          policyDigest: policyDigest(checked.policy), checkedAt: checked.authority.checkedAt, blockNumber: authority.blockNumber } });
    }
  }
  const client = clientFromEnv();
  const [chainId, head, genesis, gasPrice] = await Promise.all([client.getChainId(), client.getBlock({ blockTag: 'latest' }), client.getBlock({ blockNumber: 0n }), client.getGasPrice()]);
  requireCheck(chainId === 7794095 && genesis.hash && Math.abs(Date.now() / 1000 - Number(head.timestamp)) < 90, 'wrong_rabdi_network_or_stale_head');
  const balances: Review['balances'] = [];
  for (const owner of [ISSUER, ...LABELS.map(label => getAddress(states.get(label)!.user.wallet!))]) balances.push({ address: owner, balanceWei: (await client.getBalance({ address: owner, blockTag: 'latest' })).toString() });
  const funding: Review['funding'] = [];
  for (const label of LABELS) {
    const to = getAddress(states.get(label)!.user.wallet!);
    requireCheck(balances.find(value => same(value.address, to))?.balanceWei === '0', 'new_demo_writer_balance_changed_review_funding_before_proceeding');
    const estimate = await client.estimateGas({ account: ISSUER, to, data: '0x', value: FUND_AMOUNT, blockTag: 'latest' });
    const gas = minimumGas(estimate, head.gasLimit), maximumPrice = FUND_GAS_CAP / gas;
    requireCheck(gasPrice <= maximumPrice, 'current_funding_price_exceeds_review_cap');
    funding.push({ id: `fund:${label}`, label, from: ISSUER, to, valueWei: FUND_AMOUNT.toString() as '20000000000000000', data: '0x', gasLimit: gas.toString(), maximumGasPriceWei: maximumPrice.toString(), maximumGasCostWei: FUND_GAS_CAP.toString() as '5000000000000000' });
  }
  const createdAt = new Date().toISOString(), reviewExpiresAt = new Date(Math.min(Date.now() + 2 * 3600000, ...records.map(value => Date.parse(value.intent.expiresAt) - 60000))).toISOString();
  const review = validateReview({ version: 1, reviewOnly: true, fictional: true, humanVerified: false, chainId: 7794095, sdkVersion: '1.0.1', origin, createdAt, reviewExpiresAt,
    issuer: ISSUER, issuerMaximumFundsAndGasWei: ISSUER_TOTAL_CAP.toString(), maximumPublicationFeePerOwnerWei: OWNER_FEE_CAP.toString(),
    genesisHash: genesis.hash, observedBlock: head.number.toString(), observedBlockGasLimit: head.gasLimit.toString(), observedGasPriceWei: gasPrice.toString(), balances, funding, records,
    guidance: ['https://hub.arkiv.network/networks', 'https://docs.arkiv.network/', 'https://github.com/Arkiv-Network/skills/blob/51d22fd0485130d701f2340fe003d71101ad571d/skills/arkiv-write-safety/SKILL.md'] });
  mkdirSync('artifacts', { recursive: true }); const raw = JSON.stringify(review, null, 2); writeFileSync(REVIEW_PATH, raw, { flag: 'wx' });
  console.log(JSON.stringify({ reviewOnly: true, reviewSha256: sha256(raw), file: REVIEW_PATH, records: 4, fundingTransfers: 2,
    issuerMaximumFundsAndGasWei: review.issuerMaximumFundsAndGasWei, maximumPublicationFeePerOwnerWei: review.maximumPublicationFeePerOwnerWei,
    signatures: 0, broadcasts: 0, reviewExpiresAt }, null, 2));
}
if (resolve(process.argv[1] || '') === fileURLToPath(import.meta.url)) await main().catch(error => {
  console.error(error instanceof ArkivGuardError ? error.message : 'demo_arkiv_preparation_stopped_no_secret_details_logged'); process.exitCode = 1;
});

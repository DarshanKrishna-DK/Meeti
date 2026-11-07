import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPublicClient, keccak256, type Address, type Hex } from 'viem';
import { sepolia } from 'viem/chains';
import { z } from 'zod';
import { createEnsReadTransport } from '../packages/ens/rpc-transport';
import { decrypt } from '../packages/server/crypto';
import type { EventEntry } from './event-demo-execute';
import { EVENT_CORRECTION_APPROVAL, EVENT_CORRECTION_REVIEW } from './event-demo-funding-correction';

export const EVENT_POLICY_REVIEW = 'artifacts/event-demo-policy-correction-review.json';
export const EVENT_POLICY_APPROVAL = '.local-data/event-demo-policy-correction-approval.json';
export class PolicyCorrectionError extends Error { constructor(readonly code: string) { super(code); } }
function requireValue(value: unknown, code: string): asserts value { if (!value) throw new PolicyCorrectionError(code); }
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
const digest = z.string().regex(/^[a-f0-9]{64}$/), address = z.string().regex(/^0x[a-fA-F0-9]{40}$/), calldata = z.string().regex(/^0x(?:[a-fA-F0-9]{2})+$/);
const targetIds = ['event-krishna-policy', 'event-viha-policy'];
type PolicyOperation = { id: string; chainId: number; from: Address; to: Address; data: string | null; valueWei: string; gasLimit?: string; maxFeePerGas?: string; maxPriorityFeePerGas?: string; maxGasCostWei: string };
const correctionSchema = z.object({ version: z.literal(1), reviewOnly: z.literal(true), baseReviewSha256: digest, fundingCorrectionSha256: digest,
  createdAt: z.string().datetime(), reviewExpiresAt: z.string().datetime(), originalJournalSha256: digest,
  scope: z.literal('two-never-signed-sepolia-policy-envelopes-no-cap-increase'),
  replacements: z.array(z.object({ id: z.string(), chainId: z.literal(11155111), from: address, to: address, data: calldata, valueWei: z.literal('0'),
    gasLimit: z.literal('6000000'), maxFeePerGas: z.literal('125000000'), maxPriorityFeePerGas: z.literal('10000000'), maxGasCostWei: z.literal('750000000000000') }).strict()).length(2),
  observations: z.unknown(), guidance: z.array(z.string()),
}).strict();

/** Only reviewed policy gas units and price ceilings change. Calldata, recipients, expiry and total fee caps do not. */
export function applyEventPolicyCorrection<T extends PolicyOperation>(input: { baseReviewSha256: string; fundingCorrectionSha256: string; originalExpiresAt: string; operations: T[]; entries: EventEntry[]; correctionRaw: string; correctionHash: string; approval?: unknown; requireApproval: boolean }) {
  requireValue(sha(input.correctionRaw) === input.correctionHash, 'policy_correction_hash_mismatch');
  const correction = correctionSchema.parse(JSON.parse(input.correctionRaw));
  requireValue(correction.baseReviewSha256 === input.baseReviewSha256 && correction.fundingCorrectionSha256 === input.fundingCorrectionSha256
    && Date.parse(correction.reviewExpiresAt) <= Date.parse(input.originalExpiresAt), 'policy_correction_base_funding_or_expiry_mismatch');
  if (input.requireApproval) {
    const approval = z.object({ authorized: z.literal(true), baseReviewSha256: z.literal(input.baseReviewSha256), fundingCorrectionSha256: z.literal(input.fundingCorrectionSha256),
      policyCorrectionSha256: z.literal(input.correctionHash), approvedAt: z.string().datetime(), scope: z.literal('two-unsigned-sepolia-policy-envelope-correction-no-cap-increase') }).strict().parse(input.approval);
    requireValue(Date.parse(approval.approvedAt) >= Date.parse(correction.createdAt) && Date.parse(approval.approvedAt) <= Date.now() + 1000, 'policy_correction_approval_time_invalid');
  }
  requireValue(correction.replacements.every((replacement, index) => replacement.id === targetIds[index]), 'policy_correction_targets_changed');
  const operations = input.operations.map(operation => {
    const replacement = correction.replacements.find(value => value.id === operation.id); if (!replacement) return operation;
    requireValue(operation.chainId === replacement.chainId && same(operation.from, replacement.from) && same(operation.to, replacement.to)
      && operation.data === replacement.data && operation.valueWei === replacement.valueWei && operation.gasLimit === '1500000' && operation.maxFeePerGas === '500000000'
      && operation.maxPriorityFeePerGas === replacement.maxPriorityFeePerGas && operation.maxGasCostWei === replacement.maxGasCostWei
      && BigInt(replacement.gasLimit) * BigInt(replacement.maxFeePerGas) === BigInt(operation.maxGasCostWei), 'policy_correction_changes_calldata_owner_or_fee_cap');
    const entry = input.entries.find(entry => entry.id === operation.id);
    if (entry && (entry.raw || entry.hash || entry.broadcastAttemptedAt || entry.envelope || !['preparing', 'prepared'].includes(entry.state))) {
      const envelope = entry.envelope;
      requireValue(entry.policyCorrectionSha256 === input.correctionHash && envelope && envelope.chainId === replacement.chainId && same(envelope.from, replacement.from)
        && same(envelope.to, replacement.to) && envelope.data === replacement.data && envelope.valueWei === '0' && BigInt(envelope.gas) > 0n && BigInt(envelope.gas) <= 6000000n
        && BigInt(envelope.maxFeePerGas!) > 0n && BigInt(envelope.maxFeePerGas!) <= 125000000n && BigInt(envelope.maxPriorityFeePerGas!) >= 0n && BigInt(envelope.maxPriorityFeePerGas!) <= 10000000n
        && BigInt(envelope.maxFeeWei) === BigInt(envelope.gas) * BigInt(envelope.maxFeePerGas!) && BigInt(envelope.maxFeeWei) <= 750000000000000n,
      'policy_correction_requires_never_signed_or_exactly_bound_history');
    }
    return { ...operation, gasLimit: replacement.gasLimit, maxFeePerGas: replacement.maxFeePerGas, maxPriorityFeePerGas: replacement.maxPriorityFeePerGas };
  });
  requireValue(targetIds.every(id => input.operations.filter(operation => operation.id === id).length === 1), 'policy_correction_base_targets_missing_or_duplicate');
  return { operations, expiresAt: correction.reviewExpiresAt, targetedIds: [...targetIds] };
}

async function main() {
  requireValue(process.argv[2] === 'prepare' && process.argv.length === 5, 'choose_policy_correction_prepare_with_exact_base_and_funding_hash');
  requireValue(!existsSync(EVENT_POLICY_APPROVAL), 'approved_policy_correction_is_immutable');
  const baseRaw = readFileSync('artifacts/event-demo-testnet-review.json', 'utf8'), baseHash = sha(baseRaw);
  type BaseReview = { reviewExpiresAt: string; ens: { namespaceOperations: (Omit<PolicyOperation, 'valueWei'> & { value: string; dependsOn: string[] })[]; codeChecks: { address: Address; runtimeCodeHash: Hex }[] } };
  const base = JSON.parse(baseRaw) as BaseReview;
  requireValue(process.argv[3] === `--review-sha256=${baseHash}`, 'policy_correction_exact_base_hash_required');
  z.object({ authorized: z.literal(true), reviewSha256: z.literal(baseHash) }).passthrough().parse(JSON.parse(readFileSync('.local-data/event-demo-testnet-approval.json', 'utf8')));
  requireValue(Date.parse(base.reviewExpiresAt) > Date.now(), 'policy_correction_original_review_expired');
  const fundingRaw = readFileSync(EVENT_CORRECTION_REVIEW, 'utf8'), fundingHash = sha(fundingRaw);
  requireValue(process.argv[4] === `--funding-correction-sha256=${fundingHash}`, 'policy_correction_exact_funding_hash_required');
  z.object({ authorized: z.literal(true), baseReviewSha256: z.literal(baseHash), correctionReviewSha256: z.literal(fundingHash),
    approvedAt: z.string().datetime(), scope: z.literal('two-unsigned-sepolia-funding-envelope-correction-no-cap-increase') }).strict().parse(JSON.parse(readFileSync(EVENT_CORRECTION_APPROVAL, 'utf8')));
  const journalRaw = readFileSync('.local-data/event-demo-testnet-journal.enc', 'utf8'), journal = decrypt<{ version: number; reviewSha256: string; entries: EventEntry[] }>(journalRaw, `meeti-event-testnet-journal-v1:${baseHash}`);
  requireValue(journal.version === 1 && journal.reviewSha256 === baseHash && new Set(journal.entries.map(entry => entry.id)).size === journal.entries.length, 'policy_correction_journal_binding_invalid');
  const operations = targetIds.map(id => { const operation = base.ens.namespaceOperations.find(operation => operation.id === id); requireValue(operation && operation.value === '0x0', 'policy_correction_original_policy_missing'); return { ...operation, valueWei: '0' }; });
  for (const operation of operations) { const entry = journal.entries.find(entry => entry.id === operation.id); requireValue(!entry || (entry.state === 'preparing' && !entry.envelope && !entry.raw && !entry.hash && !entry.broadcastAttemptedAt), 'policy_correction_target_must_be_unsigned'); }
  const rpcUrl = process.env.ENS_SEPOLIA_AUTH_RPC_URL || process.env.ENS_SEPOLIA_RPC_URL; requireValue(rpcUrl, 'policy_correction_read_rpc_required');
  const client = createPublicClient({ chain: sepolia, transport: createEnsReadTransport(rpcUrl) });
  const head = await client.getBlock(); requireValue(await client.getChainId() === 11155111 && Math.abs(Date.now() / 1000 - Number(head.timestamp)) < 90, 'policy_correction_wrong_chain_or_stale_head');
  requireValue((head.baseFeePerGas || 0n) + 10000000n <= 125000000n, 'policy_correction_current_base_exceeds_fee_ceiling');
  for (const check of base.ens.codeChecks) { const code = await client.getCode({ address: check.address, blockNumber: head.number }); requireValue(code && keccak256(code) === check.runtimeCodeHash, 'policy_correction_original_deployment_code_changed'); }
  const observations = [];
  for (const [index, operation] of operations.entries()) {
    const code = await client.getCode({ address: operation.to, blockNumber: head.number });
    const dependenciesConfirmed = operation.dependsOn.every(id => journal.entries.some(entry => entry.id === id && entry.state === 'confirmed'));
    if (!code || code === '0x' || !dependenciesConfirmed) {
      requireValue(index === 1 && !dependenciesConfirmed, 'policy_correction_unexpected_missing_policy_target');
      observations.push({ id: operation.id, simulation: 'conditional_not_simulated_resolver_setup_not_yet_confirmed', targetCodePresentAtObservedBlock: !!code && code !== '0x', executionRequiresFreshEstimateAndCalldataAuthorityCheck: true }); continue;
    }
    const [estimatedGas, latest, pending] = await Promise.all([client.estimateGas({ account: operation.from, to: operation.to, data: operation.data as Hex, value: 0n, maxFeePerGas: 125000000n, maxPriorityFeePerGas: 10000000n, blockNumber: head.number }), client.getTransactionCount({ address: operation.from, blockTag: 'latest' }), client.getTransactionCount({ address: operation.from, blockTag: 'pending' })]);
    requireValue(estimatedGas <= 5000000n && latest === pending, 'policy_correction_estimate_or_pending_nonce_requires_review');
    const result = await client.call({ account: operation.from, to: operation.to, data: operation.data as Hex, value: 0n, gas: 6000000n, maxFeePerGas: 125000000n, maxPriorityFeePerGas: 10000000n, blockNumber: head.number });
    requireValue(!result.data || result.data === '0x', 'policy_correction_simulation_unexpected_output');
    observations.push({ id: operation.id, estimatedGas: estimatedGas.toString(), exact6000000Simulation: 'success', targetCodeHash: keccak256(code), ownerLatestNonce: latest, ownerPendingNonce: pending });
  }
  const report = correctionSchema.parse({ version: 1, reviewOnly: true, baseReviewSha256: baseHash, fundingCorrectionSha256: fundingHash, createdAt: new Date().toISOString(), reviewExpiresAt: base.reviewExpiresAt,
    originalJournalSha256: sha(journalRaw), scope: 'two-never-signed-sepolia-policy-envelopes-no-cap-increase', replacements: operations.map(operation => ({ id: operation.id, chainId: 11155111, from: operation.from, to: operation.to, data: operation.data, valueWei: '0', gasLimit: '6000000', maxFeePerGas: '125000000', maxPriorityFeePerGas: '10000000', maxGasCostWei: '750000000000000' })),
    observations: { checkedAt: new Date().toISOString(), chainId: 11155111, blockNumber: head.number.toString(), blockHash: head.hash, baseFeeWei: head.baseFeePerGas?.toString(), policies: observations },
    guidance: ['No new operation, funding, identity, policy content or public intent is authorized.', 'Original owner and issuer aggregate caps remain unchanged.', 'https://eips.ethereum.org/EIPS/eip-8037'] });
  const raw = JSON.stringify(report, null, 2), correctionHash = sha(raw);
  applyEventPolicyCorrection({ baseReviewSha256: baseHash, fundingCorrectionSha256: fundingHash, originalExpiresAt: base.reviewExpiresAt, operations, entries: journal.entries, correctionRaw: raw, correctionHash, requireApproval: false });
  requireValue(!existsSync(EVENT_POLICY_APPROVAL), 'approved_policy_correction_is_immutable'); mkdirSync('artifacts', { recursive: true }); writeFileSync(EVENT_POLICY_REVIEW, raw);
  console.log(JSON.stringify({ path: EVENT_POLICY_REVIEW, policyCorrectionSha256: correctionHash, baseReviewSha256: baseHash, fundingCorrectionSha256: fundingHash, reviewExpiresAt: report.reviewExpiresAt,
    policies: observations, originalPerPolicyFeeCapWei: '750000000000000', gasLimit: '6000000', maxFeePerGasWei: '125000000', signatures: 0, broadcasts: 0 }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main().catch(error => { console.error(error instanceof PolicyCorrectionError ? error.code : 'policy_correction_read_failed_no_private_diagnostics'); process.exitCode = 1; });

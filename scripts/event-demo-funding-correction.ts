import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPublicClient, type Address } from 'viem';
import { sepolia } from 'viem/chains';
import { z } from 'zod';
import { createEnsReadTransport } from '../packages/ens/rpc-transport';
import { decrypt } from '../packages/server/crypto';
import type { EventEntry } from './event-demo-execute';

export const EVENT_CORRECTION_REVIEW = 'artifacts/event-demo-funding-correction-review.json';
export const EVENT_CORRECTION_APPROVAL = '.local-data/event-demo-funding-correction-approval.json';
export class FundingCorrectionError extends Error { constructor(readonly code: string) { super(code); } }
function requireValue(value: unknown, code: string): asserts value { if (!value) throw new FundingCorrectionError(code); }
type Funding = { id: string; chainId: number; from: Address; to: Address; data: string | null; valueWei: string; gasLimit?: string; maxFeePerGas?: string; maxPriorityFeePerGas?: string; maxGasCostWei: string };
const correctionSchema = z.object({ version: z.literal(1), reviewOnly: z.literal(true), baseReviewSha256: z.string().regex(/^[a-f0-9]{64}$/), createdAt: z.string().datetime(), reviewExpiresAt: z.string().datetime(),
  scope: z.literal('two-never-signed-sepolia-funding-envelopes'), originalIssuerCapWei: z.literal('14421000000000000'), originalJournalSha256: z.string().regex(/^[a-f0-9]{64}$/),
  replacements: z.array(z.object({ id: z.string(), chainId: z.literal(11155111), from: z.string(), to: z.string(), valueWei: z.literal('6000000000000000'), data: z.literal('0x'), gasLimit: z.literal('250000'), maxFeePerGas: z.literal('42000000'), maxPriorityFeePerGas: z.literal('10000000'), maxGasCostWei: z.literal('10500000000000') }).strict()).length(2),
  observations: z.unknown(), guidance: z.array(z.string()),
}).strict();
const sha = (value: string) => createHash('sha256').update(value).digest('hex');

/** Supplement only two unsigned native transfers. The original approved review and all cost caps remain unchanged. */
export function applyEventFundingCorrection<T extends Funding>(input: { baseReviewSha256: string; originalExpiresAt: string; operations: T[]; entries: EventEntry[]; correctionRaw: string; correctionHash: string; approval?: unknown; requireApproval: boolean }) {
  requireValue(sha(input.correctionRaw) === input.correctionHash, 'funding_correction_hash_mismatch');
  const correction = correctionSchema.parse(JSON.parse(input.correctionRaw));
  requireValue(correction.baseReviewSha256 === input.baseReviewSha256 && Date.parse(correction.reviewExpiresAt) <= Date.parse(input.originalExpiresAt), 'funding_correction_base_or_expiry_mismatch');
  if (input.requireApproval) z.object({ authorized: z.literal(true), baseReviewSha256: z.literal(input.baseReviewSha256), correctionReviewSha256: z.literal(input.correctionHash), approvedAt: z.string().datetime(), scope: z.literal('two-unsigned-sepolia-funding-envelope-correction-no-cap-increase') }).strict().parse(input.approval);
  const ids = ['fund-sepolia-event-krishna', 'fund-sepolia-event-viha'];
  requireValue(correction.replacements.every((replacement, index) => replacement.id === ids[index]), 'funding_correction_targets_changed');
  const operations = input.operations.map(operation => {
    const replacement = correction.replacements.find(value => value.id === operation.id); if (!replacement) return operation;
    requireValue(operation.chainId === 11155111 && operation.from.toLowerCase() === replacement.from.toLowerCase() && operation.to.toLowerCase() === replacement.to.toLowerCase()
      && operation.data === replacement.data && operation.valueWei === replacement.valueWei && operation.gasLimit === '21000' && operation.maxFeePerGas === '500000000'
      && operation.maxPriorityFeePerGas === replacement.maxPriorityFeePerGas && operation.maxGasCostWei === replacement.maxGasCostWei
      && BigInt(replacement.gasLimit) * BigInt(replacement.maxFeePerGas) === BigInt(operation.maxGasCostWei), 'funding_correction_changes_value_recipient_or_cost_cap');
    const entry = input.entries.find(entry => entry.id === operation.id);
    if (entry && (entry.raw || entry.hash || entry.broadcastAttemptedAt || entry.state === 'signing' || entry.envelope)) {
      requireValue(entry.fundingCorrectionSha256 === input.correctionHash && entry.envelope?.chainId === 11155111 && entry.envelope.from.toLowerCase() === replacement.from.toLowerCase()
        && entry.envelope.to.toLowerCase() === replacement.to.toLowerCase() && entry.envelope.valueWei === replacement.valueWei && entry.envelope.data === '0x'
        && entry.envelope.gas === '250000' && entry.envelope.maxFeePerGas === '42000000' && entry.envelope.maxPriorityFeePerGas === '10000000' && entry.envelope.maxFeeWei === replacement.maxGasCostWei,
      'funding_correction_requires_originally_never_signed_transfer');
    }
    return { ...operation, gasLimit: replacement.gasLimit, maxFeePerGas: replacement.maxFeePerGas, maxPriorityFeePerGas: replacement.maxPriorityFeePerGas };
  });
  requireValue(ids.every(id => input.operations.some(operation => operation.id === id)), 'funding_correction_base_targets_missing');
  return { operations, expiresAt: correction.reviewExpiresAt, targetedIds: ids };
}

async function main() {
  requireValue(process.argv[2] === 'prepare' && process.argv.length === 4, 'choose_funding_correction_prepare_with_exact_base_hash');
  requireValue(!existsSync(EVENT_CORRECTION_APPROVAL), 'approved_funding_correction_is_immutable');
  const baseRaw = readFileSync('artifacts/event-demo-testnet-review.json', 'utf8'), baseHash = sha(baseRaw), base = JSON.parse(baseRaw);
  requireValue(process.argv[3] === `--review-sha256=${baseHash}`, 'exact_base_review_required');
  const originalApproval = JSON.parse(readFileSync('.local-data/event-demo-testnet-approval.json', 'utf8'));
  requireValue(originalApproval.authorized === true && originalApproval.reviewSha256 === baseHash, 'original_exact_approval_required');
  const journalRaw = readFileSync('.local-data/event-demo-testnet-journal.enc', 'utf8'), journal = decrypt<{ version: number; reviewSha256: string; entries: EventEntry[] }>(journalRaw, `meeti-event-testnet-journal-v1:${baseHash}`);
  requireValue(journal.version === 1 && journal.reviewSha256 === baseHash && journal.entries.length === 1 && journal.entries[0].id === 'fund-sepolia-event-krishna' && journal.entries[0].state === 'preparing' && !journal.entries[0].raw && !journal.entries[0].hash && !journal.entries[0].envelope && !journal.entries[0].broadcastAttemptedAt, 'funding_correction_initial_journal_not_unsigned');
  const rpcUrl = process.env.ENS_SEPOLIA_AUTH_RPC_URL || process.env.ENS_SEPOLIA_RPC_URL; requireValue(rpcUrl, 'funding_correction_read_rpc_required');
  const client = createPublicClient({ chain: sepolia, transport: createEnsReadTransport(rpcUrl) });
  const head = await client.getBlock(); requireValue(await client.getChainId() === 11155111 && Math.abs(Date.now() / 1000 - Number(head.timestamp)) < 90, 'funding_correction_wrong_chain_or_stale_head');
  requireValue((head.baseFeePerGas || 0n) + 10000000n <= 42000000n, 'funding_correction_fee_cannot_cover_current_base');
  const replacements = [], observations = [];
  for (const [index, item] of base.ens.funding.entries()) {
    const from = item.from as Address, to = item.to as Address;
    const [estimate, code, nonce, latest, pending] = await Promise.all([client.estimateGas({ account: from, to, value: 6000000000000000n, data: '0x', maxFeePerGas: 42000000n, maxPriorityFeePerGas: 10000000n, blockNumber: head.number }), client.getCode({ address: to, blockNumber: head.number }), client.getTransactionCount({ address: to, blockTag: 'latest' }), client.getTransactionCount({ address: from, blockTag: 'latest' }), client.getTransactionCount({ address: from, blockTag: 'pending' })]);
    requireValue((!code || code === '0x') && nonce === 0 && estimate <= 250000n && latest === pending, 'funding_correction_code_nonce_or_estimate_changed');
    const simulated = await client.call({ account: from, to, value: 6000000000000000n, data: '0x', gas: 250000n, maxFeePerGas: 42000000n, maxPriorityFeePerGas: 10000000n, blockNumber: head.number });
    requireValue(!simulated.data || simulated.data === '0x', 'funding_correction_simulation_unexpected_output');
    replacements.push({ id: `fund-sepolia-event-${index === 0 ? 'krishna' : 'viha'}`, chainId: 11155111, from, to, valueWei: '6000000000000000', data: '0x', gasLimit: '250000', maxFeePerGas: '42000000', maxPriorityFeePerGas: '10000000', maxGasCostWei: '10500000000000' });
    observations.push({ to, recipientCode: '0x', recipientNonce: nonce, issuerLatestNonce: latest, issuerPendingNonce: pending, estimatedGas: estimate.toString(), exact250000Simulation: 'success' });
  }
  const report = correctionSchema.parse({ version: 1, reviewOnly: true, baseReviewSha256: baseHash, createdAt: new Date().toISOString(), reviewExpiresAt: base.reviewExpiresAt, scope: 'two-never-signed-sepolia-funding-envelopes', originalIssuerCapWei: '14421000000000000', originalJournalSha256: sha(journalRaw), replacements,
    observations: { chainId: 11155111, blockNumber: head.number.toString(), blockHash: head.hash, baseFeeWei: head.baseFeePerGas?.toString(), transfers: observations },
    guidance: ['https://blog.ethereum.org/2026/09/17/glamsterdam-testnet-announcement', 'https://eips.ethereum.org/EIPS/eip-8037', 'https://ethereum.org/roadmap/glamsterdam/'] });
  requireValue(!existsSync(EVENT_CORRECTION_APPROVAL), 'approved_funding_correction_is_immutable');
  mkdirSync('artifacts', { recursive: true }); const raw = JSON.stringify(report, null, 2); writeFileSync(EVENT_CORRECTION_REVIEW, raw);
  console.log(JSON.stringify({ path: EVENT_CORRECTION_REVIEW, correctionReviewSha256: sha(raw), baseReviewSha256: baseHash, transfers: observations, issuerCapUnchangedWei: report.originalIssuerCapWei, perTransferFeeCapUnchangedWei: '10500000000000', newGasLimit: '250000', newMaxFeePerGasWei: '42000000', signatures: 0, broadcasts: 0 }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main().catch(error => { console.error(error instanceof FundingCorrectionError ? error.code : 'funding_correction_read_failed_no_private_diagnostics'); process.exitCode = 1; });

import { createHash, timingSafeEqual } from 'node:crypto';

type Journal = { reviewSha256: string; chainId: number; entries: { id: string; hash: string; confirmed?: { blockHash: string } }[] };
type Review = { chainId: number; reviewExpiresAt: string; issuerMaxGasAndTransferValueWei: string; funding: { id: string }[]; plan: { operations: { id: string }[] } };
type Approval = { authorized: boolean; reviewSha256: string; chainId: number; approvedAt?: string; issuerMaxGasAndTransferValueWei: string; recipientMaxGasCostWei: string };
type RenewalPayload = { version: number; kind: string; reviewSha256: string; approvalSha256: string; journalSha256: string; chainId: number; checkedAt: string; validUntil: string; blockNumber: string; blockHash: string;
  confirmed: { id: string; hash: string; blockHash: string }[]; nextOperationId: string | null; issuerMaxGasAndTransferValueWei: string; recipientMaxGasCostWei: string; scopeChanged: boolean; signaturesRequested: number; transactionsSubmitted: number };
const sha256 = (raw: string) => createHash('sha256').update(raw).digest('hex');
const fail = (reason: string): never => { throw new Error(reason); };
function parse<T>(raw: string): T { try { return JSON.parse(raw) as T; } catch { return fail('namespace_freshness_invalid_json'); } }
function requireValue(condition: unknown, reason: string): asserts condition { if (!condition) fail(reason); }

// This validates a read-only freshness proof. It cannot renew the original approval or authorize a new operation.
export function namespaceReviewFreshness(input: {
  reviewRaw: string; approvalRaw: string; approvedReviewSha256: string; journalRaw?: string; journal: Journal;
  renewalRaw?: string; now?: number; signPayload?: (raw: string) => string;
}): { deadline: number; source: 'original-review' | 'verified-renewal' } {
  const now = input.now ?? Date.now(), review = parse<Review>(input.reviewRaw), approval = parse<Approval>(input.approvalRaw);
  const reviewHash = sha256(input.reviewRaw);
  requireValue(reviewHash === input.approvedReviewSha256 && approval.authorized === true && approval.reviewSha256 === reviewHash && input.journal.reviewSha256 === reviewHash, 'namespace_freshness_original_scope_mismatch');
  requireValue(review.chainId === 11155111 && approval.chainId === 11155111 && input.journal.chainId === 11155111, 'namespace_freshness_chain_mismatch');
  requireValue(review.issuerMaxGasAndTransferValueWei === approval.issuerMaxGasAndTransferValueWei, 'namespace_freshness_original_cap_mismatch');
  const originalDeadline = Date.parse(review.reviewExpiresAt);
  requireValue(Number.isFinite(now) && Number.isFinite(originalDeadline), 'namespace_freshness_invalid_time');
  if (input.renewalRaw === undefined) return { deadline: originalDeadline, source: 'original-review' };
  const renewal = parse<{ payload: RenewalPayload; mac: string }>(input.renewalRaw);
  requireValue(renewal && renewal.payload && typeof renewal.mac === 'string' && /^[a-f0-9]{64}$/.test(renewal.mac) && input.signPayload, 'namespace_freshness_mac_required');
  let expected: string;
  try { expected = input.signPayload(JSON.stringify(renewal.payload)); } catch { return fail('namespace_freshness_mac_invalid'); }
  requireValue(/^[a-f0-9]{64}$/.test(expected) && timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(renewal.mac, 'hex')), 'namespace_freshness_mac_invalid');
  const p = renewal.payload;
  requireValue(p.version === 1 && p.kind === 'meeti-namespace-freshness-renewal' && p.scopeChanged === false && p.signaturesRequested === 0 && p.transactionsSubmitted === 0, 'namespace_freshness_renewal_scope_invalid');
  requireValue(typeof input.journalRaw === 'string' && p.reviewSha256 === reviewHash && p.approvalSha256 === sha256(input.approvalRaw) && p.journalSha256 === sha256(input.journalRaw), 'namespace_freshness_bound_hash_mismatch');
  requireValue(p.chainId === 11155111 && p.issuerMaxGasAndTransferValueWei === approval.issuerMaxGasAndTransferValueWei && p.recipientMaxGasCostWei === approval.recipientMaxGasCostWei, 'namespace_freshness_renewal_chain_or_cap_mismatch');
  const checkedAt = Date.parse(p.checkedAt), validUntil = Date.parse(p.validUntil);
  requireValue(Number.isFinite(checkedAt) && Number.isFinite(validUntil) && checkedAt <= now && validUntil > now && validUntil > checkedAt && validUntil - checkedAt <= 20 * 60_000, 'namespace_freshness_renewal_time_invalid');
  if (approval.approvedAt) requireValue(checkedAt >= Date.parse(approval.approvedAt), 'namespace_freshness_predates_approval');
  requireValue(typeof p.blockNumber === 'string' && /^(0|[1-9][0-9]*)$/.test(p.blockNumber) && /^0x[a-fA-F0-9]{64}$/.test(p.blockHash), 'namespace_freshness_block_invalid');
  const entries = input.journal.entries, sequence = [...review.funding, ...review.plan.operations];
  requireValue(Array.isArray(entries) && entries.length <= sequence.length && entries.every((entry, index) => entry.id === sequence[index]?.id && !!entry.confirmed), 'namespace_freshness_journal_not_confirmed_prefix');
  requireValue(Array.isArray(p.confirmed) && p.confirmed.length === entries.length && p.confirmed.every((item, index) => item.id === entries[index].id && item.hash === entries[index].hash && item.blockHash === entries[index].confirmed?.blockHash), 'namespace_freshness_confirmed_prefix_mismatch');
  const done = new Set(entries.map(entry => entry.id));
  requireValue(review.funding.every(op => done.has(op.id)), 'namespace_freshness_funding_unconfirmed');
  const nextId = review.plan.operations.find(op => !done.has(op.id))?.id ?? null;
  requireValue(p.nextOperationId === nextId, 'namespace_freshness_next_operation_mismatch');
  return { deadline: validUntil, source: 'verified-renewal' };
}

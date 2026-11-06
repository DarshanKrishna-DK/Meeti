import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { parseTransaction, serializeTransaction } from 'viem';
import { namespaceReviewFreshness } from '../../scripts/namespace-review-freshness';

const now = Date.parse('2026-11-06T18:00:00Z');
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const signPayload = (value: string) => createHmac('sha256', 'fixture-only-local-mac-key').update(value).digest('hex');
const blockHash = `0x${'1'.repeat(64)}`, hash = `0x${'2'.repeat(64)}`;
function fixture() {
  const reviewRaw = JSON.stringify({ chainId: 11155111, reviewExpiresAt: '2026-11-06T17:58:00Z', issuerMaxGasAndTransferValueWei: '9871000000000000', funding: [{ id: 'fund-a' }], plan: { operations: [{ id: 'branch-register' }, { id: 'branch-registry' }] } });
  const approvedReviewSha256 = sha(reviewRaw);
  const approvalRaw = JSON.stringify({ authorized: true, approvedAt: '2026-11-06T17:40:00Z', reviewSha256: approvedReviewSha256, chainId: 11155111, issuerMaxGasAndTransferValueWei: '9871000000000000', recipientMaxGasCostWei: '2450000000000000' });
  const journalRaw = 'fixture-encrypted-journal-ciphertext';
  const journal = { reviewSha256: approvedReviewSha256, chainId: 11155111, entries: [{ id: 'fund-a', hash, confirmed: { blockHash } }, { id: 'branch-register', hash, confirmed: { blockHash } }] };
  const payload = { version: 1, kind: 'meeti-namespace-freshness-renewal', reviewSha256: approvedReviewSha256, approvalSha256: sha(approvalRaw), journalSha256: sha(journalRaw), chainId: 11155111, checkedAt: '2026-11-06T17:59:00Z', validUntil: '2026-11-06T18:19:00Z', blockNumber: '12078200', blockHash,
    confirmed: journal.entries.map(entry => ({ id: entry.id, hash: entry.hash, blockHash: entry.confirmed.blockHash })), nextOperationId: 'branch-registry', issuerMaxGasAndTransferValueWei: '9871000000000000', recipientMaxGasCostWei: '2450000000000000', scopeChanged: false, signaturesRequested: 0, transactionsSubmitted: 0 };
  return { reviewRaw, approvalRaw, journalRaw, journal, approvedReviewSha256, now, signPayload, payload };
}
const envelope = (payload: object) => JSON.stringify({ payload, mac: signPayload(JSON.stringify(payload)) });
describe('namespace review freshness proof', () => {
  it('keeps the original deadline without an optional renewal, including an expired deadline', () => {
    expect(namespaceReviewFreshness(fixture())).toEqual({ deadline: Date.parse('2026-11-06T17:58:00Z'), source: 'original-review' });
  });
  it('accepts a valid hash-bound local freshness proof without changing approval or operations', () => {
    const f = fixture(); expect(namespaceReviewFreshness({ ...f, renewalRaw: envelope(f.payload) })).toEqual({ deadline: Date.parse(f.payload.validUntil), source: 'verified-renewal' });
  });
  it('validates the identical checkpoint repeatedly without changing the journal or its bound hash', () => {
    const f = fixture(), renewalRaw = envelope(f.payload), before = JSON.stringify(f.journal);
    const first = namespaceReviewFreshness({ ...f, renewalRaw });
    expect(namespaceReviewFreshness({ ...f, renewalRaw })).toEqual(first);
    expect(JSON.stringify(f.journal)).toBe(before);
    expect(sha(f.journalRaw)).toBe(f.payload.journalSha256);
  });
  it('normalizes omitted zero value in a real viem EIP-1559 serialization without interpreting a nonzero value as zero', () => {
    const tx = { type: 'eip1559' as const, chainId: 11155111, nonce: 0, to: '0x1111111111111111111111111111111111111111' as const, gas: 21000n, maxFeePerGas: 1n, maxPriorityFeePerGas: 0n };
    const zero = parseTransaction(serializeTransaction({ ...tx, value: 0n }));
    expect(zero.value).toBeUndefined(); expect(zero.value ?? 0n).toBe(0n);
    expect(parseTransaction(serializeTransaction({ ...tx, value: 1n })).value ?? 0n).toBe(1n);
  });
  it('denies modified MAC, malformed JSON and missing authenticator', () => {
    const f = fixture();
    expect(() => namespaceReviewFreshness({ ...f, renewalRaw: JSON.stringify({ payload: f.payload, mac: '0'.repeat(64) }) })).toThrow('mac_invalid');
    expect(() => namespaceReviewFreshness({ ...f, renewalRaw: '{' })).toThrow('invalid_json');
    expect(() => namespaceReviewFreshness({ ...f, signPayload: undefined, renewalRaw: envelope(f.payload) })).toThrow('mac_required');
  });
  it.each(['reviewSha256', 'approvalSha256', 'journalSha256'] as const)('denies changed bound %s', field => {
    const f = fixture(); expect(() => namespaceReviewFreshness({ ...f, renewalRaw: envelope({ ...f.payload, [field]: '0'.repeat(64) }) })).toThrow('bound_hash_mismatch');
  });
  it('denies stale encrypted journal, changed approval bytes and original review substitution', () => {
    const f = fixture(), renewalRaw = envelope(f.payload);
    expect(() => namespaceReviewFreshness({ ...f, journalRaw: `${f.journalRaw}-updated`, renewalRaw })).toThrow('bound_hash_mismatch');
    expect(() => namespaceReviewFreshness({ ...f, approvalRaw: `${f.approvalRaw} `, renewalRaw })).toThrow('bound_hash_mismatch');
    expect(() => namespaceReviewFreshness({ ...f, reviewRaw: `${f.reviewRaw} `, renewalRaw })).toThrow('original_scope_mismatch');
  });
  it.each([
    { checkedAt: '2026-11-06T18:00:01Z' }, { validUntil: '2026-11-06T18:20:00Z' }, { validUntil: '2026-11-06T17:59:59Z' }, { checkedAt: 'invalid' },
  ])('denies future, overlong, expired and malformed renewal timing: %j', change => {
    const f = fixture(); expect(() => namespaceReviewFreshness({ ...f, renewalRaw: envelope({ ...f.payload, ...change }) })).toThrow('renewal_time_invalid');
  });
  it.each([{ chainId: 1 }, { issuerMaxGasAndTransferValueWei: '9999999999999999' }, { recipientMaxGasCostWei: '9999999999999999' }])('denies chain or budget changes: %j', change => {
    const f = fixture(); expect(() => namespaceReviewFreshness({ ...f, renewalRaw: envelope({ ...f.payload, ...change }) })).toThrow('renewal_chain_or_cap_mismatch');
  });
  it('denies altered completed prefix, pending entries and the wrong next operation', () => {
    const f = fixture();
    expect(() => namespaceReviewFreshness({ ...f, renewalRaw: envelope({ ...f.payload, confirmed: f.payload.confirmed.slice(1) }) })).toThrow('confirmed_prefix_mismatch');
    expect(() => namespaceReviewFreshness({ ...f, journal: { ...f.journal, entries: [{ id: 'fund-a', hash }] }, renewalRaw: envelope(f.payload) })).toThrow('not_confirmed_prefix');
    expect(() => namespaceReviewFreshness({ ...f, renewalRaw: envelope({ ...f.payload, nextOperationId: 'branch-register' }) })).toThrow('next_operation_mismatch');
  });
  it('denies any scope expansion even with a valid local MAC', () => {
    const f = fixture(); expect(() => namespaceReviewFreshness({ ...f, renewalRaw: envelope({ ...f.payload, scopeChanged: true }) })).toThrow('renewal_scope_invalid');
  });
});

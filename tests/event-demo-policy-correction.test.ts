import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Address, Hex } from 'viem';
import { applyEventPolicyCorrection } from '../scripts/event-demo-policy-correction';
import { assertEventEnvelope, type EventEntry } from '../scripts/event-demo-execute';

const owners = [('0x' + '11'.repeat(20)) as Address, ('0x' + '22'.repeat(20)) as Address], resolvers = [('0x' + '33'.repeat(20)) as Address, ('0x' + '44'.repeat(20)) as Address];
const ids = ['event-krishna-policy', 'event-viha-policy'];
const sha = (raw: string) => createHash('sha256').update(raw).digest('hex');
function fixture() {
  const baseReviewSha256 = 'a'.repeat(64), fundingCorrectionSha256 = 'b'.repeat(64), originalExpiresAt = new Date(Date.now() + 3600000).toISOString();
  const operations = ids.map((id, index) => ({ id, kind: 'namespace' as const, chainId: 11155111 as const, from: owners[index], to: resolvers[index], data: '0x1234' as Hex, valueWei: '0', gasLimit: '1500000', maxFeePerGas: '500000000', maxPriorityFeePerGas: '10000000', maxGasCostWei: '750000000000000', dependsOn: [] }));
  const review = { version: 1, reviewOnly: true, baseReviewSha256, fundingCorrectionSha256, createdAt: new Date(Date.now() - 1000).toISOString(), reviewExpiresAt: originalExpiresAt, originalJournalSha256: 'c'.repeat(64), scope: 'two-never-signed-sepolia-policy-envelopes-no-cap-increase',
    replacements: operations.map(({ id, chainId, from, to, data, valueWei, maxGasCostWei }) => ({ id, chainId, from, to, data, valueWei, gasLimit: '6000000', maxFeePerGas: '125000000', maxPriorityFeePerGas: '10000000', maxGasCostWei })), observations: { fixtureOnly: true }, guidance: [] };
  const correctionRaw = JSON.stringify(review), correctionHash = sha(correctionRaw);
  const approval = { authorized: true, baseReviewSha256, fundingCorrectionSha256, policyCorrectionSha256: correctionHash, approvedAt: new Date().toISOString(), scope: 'two-unsigned-sepolia-policy-envelope-correction-no-cap-increase' };
  return { review, input: { baseReviewSha256, fundingCorrectionSha256, originalExpiresAt, operations, entries: [{ id: ids[0], state: 'preparing' as const }] as EventEntry[], correctionRaw, correctionHash, approval, requireApproval: true } };
}

describe('reviewed policy envelope correction with offline fixtures', () => {
  it('changes only the two gas unit and price ceilings without mutating the original review or fee caps', () => {
    const { input } = fixture(), before = structuredClone(input), result = applyEventPolicyCorrection(input);
    expect(input).toEqual(before);
    for (const [index, operation] of result.operations.entries()) {
      expect(operation).toEqual({ ...input.operations[index], gasLimit: '6000000', maxFeePerGas: '125000000' });
      expect(BigInt(operation.gasLimit!) * BigInt(operation.maxFeePerGas!)).toBe(BigInt(input.operations[index].maxGasCostWei));
    }
  });
  it('requires an independently exact approval bound to both earlier reviews', () => {
    const { input } = fixture();
    for (const approval of [undefined, { ...input.approval, policyCorrectionSha256: 'd'.repeat(64) }, { ...input.approval, fundingCorrectionSha256: 'e'.repeat(64) }, { ...input.approval, approvedAt: new Date(Date.now() + 60000).toISOString() }]) {
      expect(() => applyEventPolicyCorrection({ ...input, approval })).toThrow();
    }
    expect(() => applyEventPolicyCorrection({ ...input, requireApproval: false, approval: undefined })).not.toThrow();
  });
  it('rejects changed calldata, owner, resolver, fee cap, target, funding association and expiry extension', () => {
    for (const kind of ['data', 'owner', 'resolver', 'cap', 'target', 'funding', 'expiry']) {
      const { input, review } = fixture();
      if (kind === 'data') review.replacements[0].data = '0x5678';
      if (kind === 'owner') review.replacements[0].from = owners[1];
      if (kind === 'resolver') review.replacements[0].to = resolvers[1];
      if (kind === 'cap') review.replacements[0].maxGasCostWei = '750000000000001';
      if (kind === 'target') review.replacements[0].id = 'event-krishna-grant';
      if (kind === 'funding') review.fundingCorrectionSha256 = 'd'.repeat(64);
      if (kind === 'expiry') review.reviewExpiresAt = new Date(Date.parse(input.originalExpiresAt) + 1).toISOString();
      const correctionRaw = JSON.stringify(review);
      expect(() => applyEventPolicyCorrection({ ...input, correctionRaw, correctionHash: sha(correctionRaw), requireApproval: false })).toThrow();
    }
  });
  it('never reinterprets original signed, uncertain or interrupted envelope history as corrected', () => {
    const { input } = fixture();
    for (const entry of [{ id: ids[0], state: 'signed', raw: '0x01' }, { id: ids[0], state: 'signing' }, { id: ids[0], state: 'broadcast_admitted', broadcastAttemptedAt: new Date().toISOString() }] as EventEntry[]) {
      expect(() => applyEventPolicyCorrection({ ...input, entries: [entry] })).toThrow('policy_correction_requires_never_signed_or_exactly_bound_history');
    }
  });
  it('accepts exactly bound corrected history for reconciliation without changing its signed envelope', () => {
    const { input } = fixture();
    const entry: EventEntry = { id: ids[0], state: 'confirmed', policyCorrectionSha256: input.correctionHash, hash: '0x00',
      envelope: { chainId: 11155111, from: owners[0], to: resolvers[0], data: '0x1234', valueWei: '0', nonce: 3, gas: '4000000', maxFeePerGas: '125000000', maxPriorityFeePerGas: '10000000', maxFeeWei: '500000000000000' } };
    const before = structuredClone(entry);
    expect(() => applyEventPolicyCorrection({ ...input, entries: [entry] })).not.toThrow(); expect(entry).toEqual(before);
    entry.policyCorrectionSha256 = 'f'.repeat(64); expect(() => applyEventPolicyCorrection({ ...input, entries: [entry] })).toThrow();
    entry.policyCorrectionSha256 = input.correctionHash; entry.envelope!.maxFeePerGas = '500000000'; expect(() => applyEventPolicyCorrection({ ...input, entries: [entry] })).toThrow();
  });
  it('requires both unique original targets and rejects an increased original fee cap', () => {
    const { input } = fixture();
    expect(() => applyEventPolicyCorrection({ ...input, operations: input.operations.slice(1) })).toThrow();
    expect(() => applyEventPolicyCorrection({ ...input, operations: [...input.operations, input.operations[0]] })).toThrow();
    input.operations[0].maxGasCostWei = '999999999999999'; expect(() => applyEventPolicyCorrection(input)).toThrow();
  });
  it('checks corrected operation fee and priority ceilings even when the absolute fee fits its unchanged cap', () => {
    const { input } = fixture(), operation = applyEventPolicyCorrection(input).operations[0];
    const entry: EventEntry = { id: ids[0], state: 'signing', envelope: { chainId: 11155111, from: owners[0], to: resolvers[0], data: '0x1234', valueWei: '0', nonce: 3, gas: '4000000', maxFeePerGas: '125000000', maxPriorityFeePerGas: '10000000', maxFeeWei: '500000000000000' } };
    expect(() => assertEventEnvelope(entry, operation)).not.toThrow();
    entry.envelope!.maxFeePerGas = '125000001'; entry.envelope!.maxFeeWei = '500000004000000';
    expect(() => assertEventEnvelope(entry, operation)).toThrow('event_envelope_gas_price_exceeded');
    entry.envelope!.maxFeePerGas = '125000000'; entry.envelope!.maxFeeWei = '500000000000000'; entry.envelope!.maxPriorityFeePerGas = '10000001';
    expect(() => assertEventEnvelope(entry, operation)).toThrow('event_envelope_gas_price_exceeded');
  });
});

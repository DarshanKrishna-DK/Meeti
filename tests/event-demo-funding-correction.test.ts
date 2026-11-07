import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { type Address } from 'viem';
import { applyEventFundingCorrection } from '../scripts/event-demo-funding-correction';
import type { EventEntry } from '../scripts/event-demo-execute';

const from = ('0x' + '11'.repeat(20)) as Address, owners = [('0x' + '22'.repeat(20)) as Address, ('0x' + '33'.repeat(20)) as Address];
const ids = ['fund-sepolia-event-krishna', 'fund-sepolia-event-viha'];
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function fixture() {
  const baseReviewSha256 = 'a'.repeat(64), originalExpiresAt = new Date(Date.now() + 3600000).toISOString();
  const operations = ids.map((id, index) => ({ id, chainId: 11155111, from, to: owners[index], data: '0x', valueWei: '6000000000000000', gasLimit: '21000', maxFeePerGas: '500000000', maxPriorityFeePerGas: '10000000', maxGasCostWei: '10500000000000' }));
  const review = { version: 1, reviewOnly: true, baseReviewSha256, createdAt: new Date().toISOString(), reviewExpiresAt: originalExpiresAt, scope: 'two-never-signed-sepolia-funding-envelopes', originalIssuerCapWei: '14421000000000000', originalJournalSha256: 'b'.repeat(64),
    replacements: operations.map(operation => ({ ...operation, gasLimit: '250000', maxFeePerGas: '42000000' })), observations: { fixtureOnly: true }, guidance: [] };
  const correctionRaw = JSON.stringify(review), correctionHash = sha(correctionRaw);
  const approval = { authorized: true, baseReviewSha256, correctionReviewSha256: correctionHash, approvedAt: new Date().toISOString(), scope: 'two-unsigned-sepolia-funding-envelope-correction-no-cap-increase' };
  const input = { baseReviewSha256, originalExpiresAt, operations, entries: [{ id: ids[0], state: 'preparing' as const }], correctionRaw, correctionHash, approval, requireApproval: true };
  return { input, review };
}
describe('supplemental funding correction with offline approval fixtures', () => {
  it('changes only unsigned gas units and maximum price while preserving transfer and fee caps', () => {
    const { input } = fixture(), before = structuredClone(input), result = applyEventFundingCorrection(input);
    expect(input).toEqual(before);
    for (const [index, operation] of result.operations.entries()) expect(operation).toEqual({ ...input.operations[index], gasLimit: '250000', maxFeePerGas: '42000000' });
    expect(result.operations.every(operation => BigInt(operation.gasLimit!) * BigInt(operation.maxFeePerGas!) === BigInt(operation.maxGasCostWei))).toBe(true);
  });
  it('requires exact supplemental approval independently from the original approval', () => {
    const { input } = fixture();
    expect(() => applyEventFundingCorrection({ ...input, approval: undefined })).toThrow();
    expect(() => applyEventFundingCorrection({ ...input, approval: { ...input.approval, correctionReviewSha256: 'f'.repeat(64) } })).toThrow();
    expect(() => applyEventFundingCorrection({ ...input, requireApproval: false, approval: undefined })).not.toThrow();
  });
  it('rejects changed recipient, increased fee cap, wrong base and extended expiration', () => {
    for (const kind of ['recipient', 'cap', 'base', 'expiry']) {
      const { input, review } = fixture();
      if (kind === 'recipient') review.replacements[0].to = owners[1];
      if (kind === 'cap') review.replacements[0].maxGasCostWei = '99999999999999';
      if (kind === 'base') review.baseReviewSha256 = 'c'.repeat(64);
      if (kind === 'expiry') review.reviewExpiresAt = new Date(Date.parse(input.originalExpiresAt) + 1).toISOString();
      const correctionRaw = JSON.stringify(review), correctionHash = sha(correctionRaw);
      expect(() => applyEventFundingCorrection({ ...input, correctionRaw, correctionHash, requireApproval: false })).toThrow();
    }
  });
  it('never reinterprets a previously signed or uncertain original transfer as corrected', () => {
    const { input } = fixture();
    for (const entry of [{ id: ids[0], state: 'signed', raw: '0x01' }, { id: ids[0], state: 'signing' }, { id: ids[0], state: 'broadcast_admitted', broadcastAttemptedAt: new Date().toISOString() }] as EventEntry[]) {
      expect(() => applyEventFundingCorrection({ ...input, entries: [entry] })).toThrow('funding_correction_requires_originally_never_signed_transfer');
    }
  });
  it('allows canonical corrected history without repricing while the other unsigned transfer proceeds', () => {
    const { input } = fixture();
    const entry: EventEntry = { id: ids[0], state: 'confirmed', fundingCorrectionSha256: input.correctionHash, hash: '0x00',
      envelope: { chainId: 11155111, from, to: owners[0], data: '0x', valueWei: '6000000000000000', nonce: 28, gas: '250000', maxFeePerGas: '42000000', maxPriorityFeePerGas: '10000000', maxFeeWei: '10500000000000' } };
    expect(() => applyEventFundingCorrection({ ...input, entries: [entry] })).not.toThrow();
    entry.envelope!.maxFeePerGas = '500000000'; expect(() => applyEventFundingCorrection({ ...input, entries: [entry] })).toThrow();
  });
});

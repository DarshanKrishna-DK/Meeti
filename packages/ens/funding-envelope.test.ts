import { describe, expect, it } from 'vitest';
import { boundedFundingEnvelope } from './funding-envelope';
const base = { estimatedGas: 207391n, maxGasCostWei: 10500000000000n, reviewedMaxFeePerGas: 500000000n, reviewedMaxPriorityFeePerGas: 10000000n, baseFeePerGas: 10n };
describe('funding envelope within unchanged approved money cap', () => {
  it('covers new-account state gas with a 20 percent margin without raising the fee budget', () => {
    const result = boundedFundingEnvelope(base);
    expect(result.gas).toBe(248870n);
    expect(result.maxGasCostWei).toBeLessThanOrEqual(base.maxGasCostWei);
    expect(result.maxFeePerGas).toBeLessThanOrEqual(base.reviewedMaxFeePerGas);
    expect(result.maxPriorityFeePerGas).toBeLessThanOrEqual(base.reviewedMaxPriorityFeePerGas);
    expect(result.maxFeePerGas).toBe(base.maxGasCostWei / result.gas);
  });
  it('stops when base fee and bounded priority cannot fit, and rejects malformed input', () => {
    expect(() => boundedFundingEnvelope({ ...base, baseFeePerGas: 500000000n })).toThrow('funding_gas_price_cannot_fit_approved_fee_budget');
    expect(() => boundedFundingEnvelope({ ...base, estimatedGas: 0n })).toThrow('invalid_funding_fee_input');
    expect(() => boundedFundingEnvelope({ ...base, maxGasCostWei: 1n })).toThrow('funding_gas_price_cannot_fit_approved_fee_budget');
  });
  it('fits a larger exact policy write by lowering price without increasing its reviewed maximum fee', () => {
    const input = { ...base, estimatedGas: 4_000_000n, maxGasCostWei: 750_000_000_000_000n };
    const result = boundedFundingEnvelope(input);
    expect(result.gas).toBe(4_800_000n);
    expect(result.maxFeePerGas).toBeLessThan(input.reviewedMaxFeePerGas);
    expect(result.maxGasCostWei).toBeLessThanOrEqual(input.maxGasCostWei);
  });
});

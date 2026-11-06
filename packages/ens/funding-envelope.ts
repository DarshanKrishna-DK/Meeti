export function boundedFundingEnvelope(input: { estimatedGas: bigint; maxGasCostWei: bigint; reviewedMaxFeePerGas: bigint; reviewedMaxPriorityFeePerGas: bigint; baseFeePerGas: bigint }) {
  if (input.estimatedGas <= 0n || input.maxGasCostWei <= 0n || input.reviewedMaxFeePerGas <= 0n || input.reviewedMaxPriorityFeePerGas < 0n || input.baseFeePerGas < 0n) throw new Error('invalid_funding_fee_input');
  const gas = (input.estimatedGas * 120n + 99n) / 100n;
  const affordable = input.maxGasCostWei / gas;
  const maxFeePerGas = affordable < input.reviewedMaxFeePerGas ? affordable : input.reviewedMaxFeePerGas;
  const maxPriorityFeePerGas = input.reviewedMaxPriorityFeePerGas < maxFeePerGas ? input.reviewedMaxPriorityFeePerGas : maxFeePerGas;
  if (maxFeePerGas <= 0n || input.baseFeePerGas + maxPriorityFeePerGas > maxFeePerGas) throw new Error('funding_gas_price_cannot_fit_approved_fee_budget');
  return { gas, maxFeePerGas, maxPriorityFeePerGas, maxGasCostWei: gas * maxFeePerGas };
}

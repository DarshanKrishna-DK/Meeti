import { describe, expect, it, vi } from "vitest";
import { decodeFunctionData, erc20Abi, zeroHash, type Address, type PublicClient } from "viem";
import { ENS_DEPLOYMENT } from "./index";
import { assertParentPlanIdentity, commitmentWindow, createParentRegistrationProvider, DEFAULT_PARENT_DURATION, openParentPlan, parentCommitment, PARENT_PAYMENT_TOKEN, PARENT_REGISTRAR, sealParentPlan, validateParentName, type ParentRegistrationPlan } from "./parent-registration";

const owner = "0x0000000000000000000000000000000000000001" as Address;
const resolver = "0x0000000000000000000000000000000000000003" as Address;
const now = 1800000000000;
function plan(): ParentRegistrationPlan {
  const data: ParentRegistrationPlan = { version: 1, chainId: 11155111, name: "example.eth", owner, duration: DEFAULT_PARENT_DURATION.toString(), secret: "0x" + "4".repeat(64), resolver, commitment: zeroHash, createdAt: new Date(now).toISOString() };
  data.commitment = parentCommitment(data);
  return data;
}
function fixture() {
  const state = { available: true, committedAt: 0n, balance: 0n, allowance: 0n, chain: 11155111 };
  const readContract = vi.fn(async ({ functionName, args }: { functionName: string; args: unknown[] }) => {
    if (functionName === "isENSv2" || functionName === "isPaymentToken") return true;
    if (functionName === "ROOT_REGISTRY") return ENS_DEPLOYMENT.rootRegistry;
    if (functionName === "ETH_REGISTRY" || functionName === "getSubregistry") return ENS_DEPLOYMENT.ethRegistry;
    if (functionName === "isAvailable") return state.available;
    if (functionName === "MIN_COMMITMENT_AGE") return 60n;
    if (functionName === "MAX_COMMITMENT_AGE") return 86400n;
    if (functionName === "MIN_REGISTER_DURATION") return 2419200n;
    if (functionName === "rentPriceOracle") return owner;
    if (functionName === "getRegisterPrice") return [8000021n, 0n];
    if (functionName === "balanceOf") return state.balance;
    if (functionName === "allowance") return state.allowance;
    if (functionName === "decimals") return 6;
    if (functionName === "symbol") return "USDC";
    if (functionName === "predictProxyAddress") return resolver;
    if (functionName === "commitmentAt") return state.committedAt;
    if (functionName === "makeCommitment") return parentCommitment({ name: String(args[0]) + ".eth", owner: String(args[1]), secret: String(args[2]), resolver: String(args[4]), duration: String(args[5]) });
    if (functionName === "verifyContract") return ENS_DEPLOYMENT.resolverImplementation;
    throw new Error("unexpected_read");
  });
  const call = vi.fn(async () => ({}));
  const client = { getChainId: async () => state.chain, getBlock: async (input: { blockNumber?: bigint }) => ({ number: input.blockNumber ?? 100n, timestamp: BigInt(now / 1000) }), getCode: async ({ address }: { address: Address }) => address === PARENT_REGISTRAR ? "0x6000" : "0x", getBalance: async () => 0n, getTransactionCount: async () => 2, estimateGas: async () => 100000n, estimateFeesPerGas: async () => ({ maxFeePerGas: 2000000n, maxPriorityFeePerGas: 1000000n }), readContract, call } as unknown as PublicClient;
  return { state, client, call, provider: createParentRegistrationProvider({ client, now: () => now }) };
}

describe("unsigned ENSv2 parent registration", () => {
  it("limits names to supported lowercase parent labels", () => {
    expect(validateParentName("crypteck.eth")).toBe("crypteck");
    expect(validateParentName("meeti-demo.eth")).toBe("meeti-demo");
    for (const value of ["agent.example.eth", "Example.eth", "../example.eth", "example.com", "ab.eth"]) expect(() => validateParentName(value)).toThrow();
  });
  it("encrypts the secret and authenticates persisted parameters", () => {
    const key = "9".repeat(64);
    const original = plan();
    const sealed = sealParentPlan(original, key);
    expect(sealed).not.toContain(original.secret);
    expect(openParentPlan(sealed, key)).toEqual(original);
    expect(() => openParentPlan(sealed, "8".repeat(64))).toThrow();
    const corrupt = JSON.parse(sealed);
    corrupt.ciphertext = "00" + corrupt.ciphertext.slice(2);
    expect(() => openParentPlan(JSON.stringify(corrupt), key)).toThrow();
    expect(() => sealParentPlan(original, undefined)).toThrow("data_encryption_key_not_configured");
  });
  it("binds commitment to owner, duration, resolver and unpredictable secret", () => {
    const original = plan();
    for (const change of [{ owner: resolver }, { resolver: owner }, { duration: "2419200" }, { secret: "0x" + "5".repeat(64) }]) expect(parentCommitment({ ...original, ...change })).not.toBe(original.commitment);
  });
  it("enforces the exact commitment timing boundaries", () => {
    expect(() => commitmentWindow(1000n, 0n, 60n, 86400n)).toThrow("parent_commitment_not_mined");
    expect(() => commitmentWindow(1059n, 1000n, 60n, 86400n)).toThrow("parent_commitment_too_new");
    expect(() => commitmentWindow(1060n, 1000n, 60n, 86400n)).not.toThrow();
    expect(() => commitmentWindow(87400n, 1000n, 60n, 86400n)).toThrow("parent_commitment_expired");
  });
  it("simulates exact mint and approval amounts and withholds reveal secrets", async () => {
    const { provider, call } = fixture();
    const result = await provider.prepare("example.eth", owner);
    expect(result.review.transactions.map((tx) => tx.operation)).toEqual(["mint-test-usdc", "approve-test-usdc", "deploy-parent-resolver", "commit-parent"]);
    const approval = result.review.transactions[1];
    expect(approval.to).toBe(PARENT_PAYMENT_TOKEN);
    const decoded = decodeFunctionData({ abi: erc20Abi, data: approval.data });
    expect(decoded.functionName).toBe("approve");
    expect(String(decoded.args?.[0]).toLowerCase()).toBe(PARENT_REGISTRAR);
    expect(decoded.args?.[1]).toBe(8000021n);
    expect(result.review.transactions.every((tx) => tx.value === "0x0" && tx.simulated)).toBe(true);
    expect(result.review.transactions.map((tx) => tx.nonce)).toEqual(["0x2", "0x3", "0x4", "0x5"]);
    expect(JSON.stringify(result.review)).not.toContain(result.plan.secret);
    expect(call).toHaveBeenCalledTimes(4);
  });
  it("does not release reveal calldata without a real mined commitment and payment", async () => {
    const { provider, state, call } = fixture();
    await expect(provider.reveal(plan())).rejects.toThrow("parent_commitment_not_mined");
    state.committedAt = BigInt(now / 1000 - 60);
    await expect(provider.reveal(plan())).rejects.toThrow("parent_test_usdc_balance_insufficient");
    state.balance = 8000021n;
    await expect(provider.reveal(plan())).rejects.toThrow("parent_test_usdc_approval_required");
    expect(call).not.toHaveBeenCalled();
    state.allowance = 8000021n;
    const revealed = await provider.reveal(plan());
    expect(revealed.transaction.operation).toBe("reveal-parent");
    expect(revealed.transaction.simulated).toBe(true);
  });
  it("denies unsupported chains and unavailable names", async () => {
    const { provider, state } = fixture();
    state.chain = 1;
    await expect(provider.quote("example.eth", owner)).rejects.toThrow("unsupported_chain");
    state.chain = 11155111;
    state.available = false;
    await expect(provider.quote("example.eth", owner)).rejects.toThrow("parent_name_unavailable");
  });
  it("rejects a renamed encrypted plan for another owner or parent", () => {
    expect(() => assertParentPlanIdentity(plan(), "another.eth", owner)).toThrow("parent_plan_identity_mismatch");
    expect(() => assertParentPlanIdentity(plan(), "example.eth", resolver)).toThrow("parent_plan_identity_mismatch");
  });
  it("rejects a stale RPC head before preparing anything", async () => {
    const { client } = fixture();
    const provider = createParentRegistrationProvider({ client, now: () => now + 100000 });
    await expect(provider.prepare("example.eth", owner)).rejects.toThrow("stale_chain_head");
  });
  it("reuses the encrypted plan commitment and omits an already mined commit", async () => {
    const { provider, state } = fixture();
    const first = await provider.prepare("example.eth", owner);
    state.committedAt = BigInt(now / 1000 - 1);
    const next = await provider.prepare("example.eth", owner, DEFAULT_PARENT_DURATION, first.plan);
    expect(next.review.commitment).toBe(first.review.commitment);
    expect(next.review.transactions.some((transaction) => transaction.operation === "commit-parent")).toBe(false);
  });
  it("rejects a quote that expires while preparing the batch", async () => {
    const { client } = fixture();
    let clockReads = 0;
    const provider = createParentRegistrationProvider({ client, now: () => ++clockReads >= 4 ? now + 61000 : now });
    await expect(provider.prepare("example.eth", owner)).rejects.toThrow("parent_preparation_quote_expired");
  });
  it("pins parent setup reads two blocks behind a tip that a lagging RPC cannot serve", async () => {
    const { client, provider } = fixture();
    const read = client.readContract.bind(client);
    const observed: bigint[] = [];
    client.readContract = vi.fn(async (parameters) => {
      const blockNumber = (parameters as { blockNumber: bigint }).blockNumber;
      if (blockNumber === 100n) throw new Error("block not found");
      observed.push(blockNumber);
      return read(parameters);
    }) as PublicClient["readContract"];
    const quote = await provider.quote("example.eth", owner);
    expect(quote).toMatchObject({ headBlockNumber: "100", blockNumber: "98", snapshotDepth: 2 });
    expect(observed.length).toBeGreaterThan(0);
    expect(observed.every((blockNumber) => blockNumber === 98n)).toBe(true);
  });
});

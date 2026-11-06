import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { createPublicClient, encodeAbiParameters, encodeFunctionData, erc20Abi, formatUnits, getAddress, http, keccak256, parseAbi, zeroAddress, zeroHash, type Address, type Hex, type PublicClient } from "viem";
import { sepolia } from "viem/chains";
import { z } from "zod";
import { ENS_CHAIN_ID, ENS_DEPLOYMENT, dedicatedResolverSalt, dnsEncode } from "./index";
import { factoryAbi, registryAbi, resolverAbi, universalAbi } from "./abi";

// Interface signatures verified against the pinned official registrar and CLI source.
export const parentRegistrarAbi = parseAbi([
  "function ETH_REGISTRY() view returns (address)",
  "function isAvailable(string label) view returns (bool)",
  "function getRegisterPrice(string label,uint64 duration,address paymentToken) view returns (uint256 base,uint256 premium)",
  "function MIN_COMMITMENT_AGE() view returns (uint64)",
  "function MAX_COMMITMENT_AGE() view returns (uint64)",
  "function MIN_REGISTER_DURATION() view returns (uint64)",
  "function rentPriceOracle() view returns (address)",
  "function commitmentAt(bytes32 commitment) view returns (uint64)",
  "function makeCommitment(string label,address owner,bytes32 secret,address subregistry,address resolver,uint64 duration,bytes32 referrer) pure returns (bytes32)",
  "function commit(bytes32 commitment)",
  "function register(string label,address owner,bytes32 secret,address subregistry,address resolver,uint64 duration,address paymentToken,bytes32 referrer) returns (uint256 tokenId)",
]);
const oracleAbi = parseAbi(["function isPaymentToken(address token) view returns (bool)"]);
const tokenMintAbi = parseAbi(["function mint(address to,uint256 amount)"]);
const addressSetterAbi = parseAbi(["function setAddress(bytes name,uint256 coinType,bytes addressBytes)"]);
const activeAbi = parseAbi(["function isENSv2() view returns (bool)"]);
export const PARENT_REGISTRAR = "0xf633e7fc17e2bbe0d0965d18ec1821dcb754a3d3" as Address;
export const PARENT_PAYMENT_TOKEN = "0x240b0316df57887dbbe58b586508b19e633a14aa" as Address;
export const DEFAULT_PARENT_DURATION = 31536000n;
const planSchema = z.object({
  version: z.literal(1), chainId: z.literal(11155111), name: z.string(), owner: z.string(), duration: z.string().regex(/^\d+$/),
  secret: z.string().regex(/^0x[0-9a-f]{64}$/), resolver: z.string(), commitment: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
  createdAt: z.string(),
}).strict();
export type ParentRegistrationPlan = z.infer<typeof planSchema>;
export interface ParentUnsignedTransaction {
  operation: "mint-test-usdc" | "approve-test-usdc" | "deploy-parent-resolver" | "commit-parent" | "reveal-parent";
  chainId: number; from: Address; to: Address; data: Hex; value: "0x0";
  simulated: true; blockNumber: string; estimatedGas: string; gas: Hex; maxFeePerGas: Hex; maxPriorityFeePerGas: Hex; maximumGasFeeWei: string; nonce?: Hex;
}
function requireValue(value: unknown, reason: string): asserts value { if (!value) throw new Error(reason); }
function equal(a: string, b: string) { return a.toLowerCase() === b.toLowerCase(); }
export function validateParentName(name: string) {
  requireValue(/^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])\.eth$/.test(name), "unsupported_parent_name");
  return name.slice(0, -4);
}
export function validateParentOwner(owner: string): Address {
  requireValue(/^0x[0-9a-fA-F]{40}$/.test(owner), "invalid_parent_owner");
  const address = getAddress(owner.toLowerCase());
  requireValue(address !== zeroAddress, "invalid_parent_owner");
  return address;
}
export function parentCommitment(plan: Pick<ParentRegistrationPlan, "name" | "owner" | "secret" | "resolver" | "duration">): Hex {
  return keccak256(encodeAbiParameters([
    { type: "string" }, { type: "address" }, { type: "bytes32" }, { type: "address" }, { type: "address" }, { type: "uint64" }, { type: "bytes32" },
  ], [validateParentName(plan.name), validateParentOwner(plan.owner), plan.secret as Hex, zeroAddress, getAddress(plan.resolver), BigInt(plan.duration), zeroHash]));
}
export function assertParentPlanIdentity(plan: ParentRegistrationPlan, name: string, owner: string) {
  requireValue(plan.name === name && equal(plan.owner, validateParentOwner(owner)), "parent_plan_identity_mismatch");
}
export function commitmentWindow(timestamp: bigint, committedAt: bigint, minimum: bigint, maximum: bigint) {
  requireValue(committedAt > 0n, "parent_commitment_not_mined");
  requireValue(timestamp >= committedAt + minimum, "parent_commitment_too_new");
  requireValue(timestamp < committedAt + maximum, "parent_commitment_expired");
}
function encryptionKey(value: string | undefined) {
  requireValue(value && /^[a-f\d]{64}$/i.test(value), "data_encryption_key_not_configured");
  return Buffer.from(value, "hex");
}
export function sealParentPlan(plan: ParentRegistrationPlan, key: string | undefined): string {
  planSchema.parse(plan);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(key), iv);
  cipher.setAAD(Buffer.from("meeti:ens-parent-plan:v1"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(plan), "utf8"), cipher.final()]);
  return JSON.stringify({ version: 1, iv: iv.toString("hex"), tag: cipher.getAuthTag().toString("hex"), ciphertext: ciphertext.toString("hex") });
}
export function openParentPlan(sealed: string, key: string | undefined): ParentRegistrationPlan {
  const data = z.object({ version: z.literal(1), iv: z.string().regex(/^[a-f0-9]{24}$/), tag: z.string().regex(/^[a-f0-9]{32}$/), ciphertext: z.string().regex(/^[a-f0-9]+$/).max(16384) }).strict().parse(JSON.parse(sealed));
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(key), Buffer.from(data.iv, "hex"));
  decipher.setAAD(Buffer.from("meeti:ens-parent-plan:v1"));
  decipher.setAuthTag(Buffer.from(data.tag, "hex"));
  const plan = planSchema.parse(JSON.parse(Buffer.concat([decipher.update(Buffer.from(data.ciphertext, "hex")), decipher.final()]).toString("utf8")));
  requireValue(equal(parentCommitment(plan), plan.commitment), "parent_plan_commitment_mismatch");
  return plan;
}

export function createParentRegistrationProvider(options: { rpcUrl?: string; client?: PublicClient; now?: () => number } = {}) {
  const client = options.client ?? (options.rpcUrl ? createPublicClient({ chain: sepolia, transport: http(options.rpcUrl, { timeout: 15000, retryCount: 0 }) }) as PublicClient : undefined);
  const now = options.now ?? Date.now;
  async function quote(name: string, ownerInput: string, duration = DEFAULT_PARENT_DURATION) {
    const label = validateParentName(name);
    const owner = validateParentOwner(ownerInput);
    requireValue(client, "ens_rpc_not_configured");
    requireValue(await client.getChainId() === ENS_CHAIN_ID, "unsupported_chain");
    const head = await client.getBlock({ blockTag: "latest" });
    requireValue(head.number !== null && head.number >= 2n, "parent_confirmed_snapshot_unavailable");
    // Registration setup can use a recent confirmed snapshot to avoid load-balanced RPC tip lag.
    // Protected application authority continues to use the latest block in index.ts.
    const snapshotNumber = head.number - 2n;
    const block = await client.getBlock({ blockNumber: snapshotNumber });
    requireValue(block.number === snapshotNumber && Math.abs(now() / 1000 - Number(block.timestamp)) < 90, "stale_chain_head");
    const blockNumber = block.number;
    const read = <T>(address: Address, abi: readonly unknown[], functionName: string, args: readonly unknown[] = []) => client.readContract({ address, abi, functionName, args, blockNumber } as Parameters<PublicClient["readContract"]>[0]) as Promise<T>;
    const [active, root, configuredRegistry, code] = await Promise.all([
      read<boolean>(ENS_DEPLOYMENT.universalResolver, activeAbi, "isENSv2"),
      read<Address>(ENS_DEPLOYMENT.universalResolver, universalAbi, "ROOT_REGISTRY"),
      read<Address>(PARENT_REGISTRAR, parentRegistrarAbi, "ETH_REGISTRY"),
      client.getCode({ address: PARENT_REGISTRAR, blockNumber }),
    ]);
    requireValue(active && equal(root, ENS_DEPLOYMENT.rootRegistry) && code && code !== "0x", "ensv2_not_active");
    const actualRegistry = await read<Address>(root, registryAbi, "getSubregistry", ["eth"]);
    requireValue(equal(actualRegistry, ENS_DEPLOYMENT.ethRegistry) && equal(configuredRegistry, actualRegistry), "registrar_registry_mismatch");
    const [available, minimumAge, maximumAge, minimumDuration, oracle] = await Promise.all([
      read<boolean>(PARENT_REGISTRAR, parentRegistrarAbi, "isAvailable", [label]),
      read<bigint>(PARENT_REGISTRAR, parentRegistrarAbi, "MIN_COMMITMENT_AGE"),
      read<bigint>(PARENT_REGISTRAR, parentRegistrarAbi, "MAX_COMMITMENT_AGE"),
      read<bigint>(PARENT_REGISTRAR, parentRegistrarAbi, "MIN_REGISTER_DURATION"),
      read<Address>(PARENT_REGISTRAR, parentRegistrarAbi, "rentPriceOracle"),
    ]);
    requireValue(available, "parent_name_unavailable");
    requireValue(duration >= minimumDuration && duration <= 31536000n, "unsupported_parent_duration");
    requireValue(maximumAge > minimumAge, "invalid_commitment_configuration");
    requireValue(await read<boolean>(oracle, oracleAbi, "isPaymentToken", [PARENT_PAYMENT_TOKEN]), "test_payment_token_unsupported");
    const [price, balance, allowance, decimals, symbol, nativeBalance, resolver] = await Promise.all([
      read<readonly [bigint, bigint]>(PARENT_REGISTRAR, parentRegistrarAbi, "getRegisterPrice", [label, duration, PARENT_PAYMENT_TOKEN]),
      read<bigint>(PARENT_PAYMENT_TOKEN, erc20Abi, "balanceOf", [owner]),
      read<bigint>(PARENT_PAYMENT_TOKEN, erc20Abi, "allowance", [owner, PARENT_REGISTRAR]),
      read<number>(PARENT_PAYMENT_TOKEN, erc20Abi, "decimals"),
      read<string>(PARENT_PAYMENT_TOKEN, erc20Abi, "symbol"),
      client.getBalance({ address: owner, blockNumber }),
      read<Address>(ENS_DEPLOYMENT.factory, factoryAbi, "predictProxyAddress", [owner, dedicatedResolverSalt(name, owner)]),
    ]);
    const total = price[0] + price[1];
    return { name, label, owner, duration: duration.toString(), chainId: ENS_CHAIN_ID, registrar: PARENT_REGISTRAR, registry: actualRegistry, paymentToken: PARENT_PAYMENT_TOKEN, tokenSymbol: symbol, tokenDecimals: decimals, base: price[0].toString(), premium: price[1].toString(), total: total.toString(), totalFormatted: formatUnits(total, decimals), balance: balance.toString(), allowance: allowance.toString(), mintRequired: (total > balance ? total - balance : 0n).toString(), approvalRequired: allowance < total, nativeBalanceWei: nativeBalance.toString(), nativeGasFundingRequired: nativeBalance === 0n, minimumCommitmentAge: minimumAge.toString(), maximumCommitmentAge: maximumAge.toString(), minimumRegisterDuration: minimumDuration.toString(), resolver, resolverScope: "dedicated-parent", subregistry: zeroAddress, referrer: zeroHash, blockNumber: blockNumber.toString(), headBlockNumber: head.number.toString(), snapshotDepth: 2, blockTimestamp: block.timestamp.toString(), checkedAt: new Date(now()).toISOString(), registrationEthValue: "0", available: true as const };
  }
  async function simulate(operation: ParentUnsignedTransaction["operation"], owner: Address, to: Address, data: Hex, blockNumber: string): Promise<ParentUnsignedTransaction> {
    requireValue(client, "ens_rpc_not_configured");
    await client.call({ account: owner, to, data, value: 0n, blockNumber: BigInt(blockNumber) });
    const [estimatedGas, fees] = await Promise.all([
      client.estimateGas({ account: owner, to, data, value: 0n, blockNumber: BigInt(blockNumber) }),
      client.estimateFeesPerGas({ type: "eip1559", chain: undefined }),
    ]);
    const gas = estimatedGas + estimatedGas / 5n;
    requireValue(fees.maxFeePerGas > 0n && fees.maxPriorityFeePerGas <= fees.maxFeePerGas, "parent_fee_quote_invalid");
    return { operation, chainId: ENS_CHAIN_ID, from: owner, to, data, value: "0x0", simulated: true, blockNumber, estimatedGas: estimatedGas.toString(), gas: ("0x" + gas.toString(16)) as Hex, maxFeePerGas: ("0x" + fees.maxFeePerGas.toString(16)) as Hex, maxPriorityFeePerGas: ("0x" + fees.maxPriorityFeePerGas.toString(16)) as Hex, maximumGasFeeWei: (gas * fees.maxFeePerGas).toString() };
  }
  async function prepare(name: string, ownerInput: string, duration = DEFAULT_PARENT_DURATION, existing?: ParentRegistrationPlan) {
    const current = await quote(name, ownerInput, duration);
    const plan: ParentRegistrationPlan = existing ?? { version: 1, chainId: ENS_CHAIN_ID, name, owner: current.owner, duration: duration.toString(), secret: ("0x" + randomBytes(32).toString("hex")) as Hex, resolver: current.resolver, commitment: zeroHash, createdAt: new Date(now()).toISOString() };
    requireValue(plan.name === name && equal(plan.owner, current.owner) && plan.duration === duration.toString() && equal(plan.resolver, current.resolver), "parent_plan_parameters_mismatch");
    const commitment = parentCommitment(plan);
    if (existing) requireValue(equal(existing.commitment, commitment), "parent_plan_commitment_mismatch");
    plan.commitment = commitment;
    requireValue(client, "ens_rpc_not_configured");
    const onchainCommitment = await client.readContract({ address: PARENT_REGISTRAR, abi: parentRegistrarAbi, functionName: "makeCommitment", args: [current.label, current.owner, plan.secret as Hex, zeroAddress, current.resolver, duration, zeroHash], blockNumber: BigInt(current.blockNumber) });
    requireValue(equal(commitment, onchainCommitment), "parent_commitment_encoding_mismatch");
    const transactions: ParentUnsignedTransaction[] = [];
    const mint = BigInt(current.mintRequired);
    if (mint > 0n) transactions.push(await simulate("mint-test-usdc", current.owner, PARENT_PAYMENT_TOKEN, encodeFunctionData({ abi: tokenMintAbi, functionName: "mint", args: [current.owner, mint] }), current.blockNumber));
    if (current.approvalRequired) transactions.push(await simulate("approve-test-usdc", current.owner, PARENT_PAYMENT_TOKEN, encodeFunctionData({ abi: erc20Abi, functionName: "approve", args: [PARENT_REGISTRAR, BigInt(current.total)] }), current.blockNumber));
    const code = await client.getCode({ address: current.resolver, blockNumber: BigInt(current.blockNumber) });
    if (!code || code === "0x") {
      const addressCall = encodeFunctionData({ abi: addressSetterAbi, functionName: "setAddress", args: [dnsEncode(name), 60n, current.owner] });
      const initializer = encodeFunctionData({ abi: resolverAbi, functionName: "initialize", args: [[{ account: current.owner, roleBitmap: BigInt("0x" + "1".repeat(64)) }], [addressCall]] });
      transactions.push(await simulate("deploy-parent-resolver", current.owner, ENS_DEPLOYMENT.factory, encodeFunctionData({ abi: factoryAbi, functionName: "deployProxy", args: [ENS_DEPLOYMENT.resolverImplementation, dedicatedResolverSalt(name, current.owner), initializer] }), current.blockNumber));
    } else {
      const implementation = await client.readContract({ address: ENS_DEPLOYMENT.factory, abi: factoryAbi, functionName: "verifyContract", args: [current.resolver], blockNumber: BigInt(current.blockNumber) });
      requireValue(equal(implementation, ENS_DEPLOYMENT.resolverImplementation), "unexpected_parent_resolver_implementation");
    }
    const committedAt = await client.readContract({ address: PARENT_REGISTRAR, abi: parentRegistrarAbi, functionName: "commitmentAt", args: [commitment], blockNumber: BigInt(current.blockNumber) });
    if (committedAt === 0n || committedAt + BigInt(current.maximumCommitmentAge) <= BigInt(current.blockTimestamp)) {
      transactions.push(await simulate("commit-parent", current.owner, PARENT_REGISTRAR, encodeFunctionData({ abi: parentRegistrarAbi, functionName: "commit", args: [commitment] }), current.blockNumber));
    }
    const pendingNonce = await client.getTransactionCount({ address: current.owner, blockTag: "pending" });
    for (let index = 0; index < transactions.length; index++) transactions[index].nonce = ("0x" + (pendingNonce + index).toString(16)) as Hex;
    requireValue(now() - Date.parse(current.checkedAt) < 60000, "parent_preparation_quote_expired");
    return { plan, review: { quote: current, commitment, committedAt: committedAt.toString(), pendingNonce, transactions, maximumBatchGasFeeWei: transactions.reduce((total, tx) => total + BigInt(tx.maximumGasFeeWei), 0n).toString(), revealCalldataWithheld: true, requiresWalletApproval: true, broadcast: false, refreshBeforeBroadcast: true } };
  }
  async function reveal(plan: ParentRegistrationPlan) {
    planSchema.parse(plan);
    requireValue(equal(parentCommitment(plan), plan.commitment), "parent_plan_commitment_mismatch");
    const current = await quote(plan.name, plan.owner, BigInt(plan.duration));
    requireValue(equal(plan.resolver, current.resolver), "parent_plan_parameters_mismatch");
    requireValue(client, "ens_rpc_not_configured");
    const committedAt = await client.readContract({ address: PARENT_REGISTRAR, abi: parentRegistrarAbi, functionName: "commitmentAt", args: [plan.commitment as Hex], blockNumber: BigInt(current.blockNumber) });
    commitmentWindow(BigInt(current.blockTimestamp), committedAt, BigInt(current.minimumCommitmentAge), BigInt(current.maximumCommitmentAge));
    requireValue(BigInt(current.balance) >= BigInt(current.total), "parent_test_usdc_balance_insufficient");
    requireValue(BigInt(current.allowance) >= BigInt(current.total), "parent_test_usdc_approval_required");
    const implementation = await client.readContract({ address: ENS_DEPLOYMENT.factory, abi: factoryAbi, functionName: "verifyContract", args: [current.resolver], blockNumber: BigInt(current.blockNumber) });
    requireValue(equal(implementation, ENS_DEPLOYMENT.resolverImplementation), "unexpected_parent_resolver_implementation");
    const data = encodeFunctionData({ abi: parentRegistrarAbi, functionName: "register", args: [current.label, current.owner, plan.secret as Hex, zeroAddress, current.resolver, BigInt(plan.duration), PARENT_PAYMENT_TOKEN, zeroHash] });
    const transaction = await simulate("reveal-parent", current.owner, PARENT_REGISTRAR, data, current.blockNumber);
    transaction.nonce = ("0x" + (await client.getTransactionCount({ address: current.owner, blockTag: "pending" })).toString(16)) as Hex;
    requireValue(now() - Date.parse(current.checkedAt) < 60000, "parent_preparation_quote_expired");
    return { quote: current, commitment: plan.commitment, committedAt: committedAt.toString(), transaction, requiresWalletApproval: true, broadcast: false, warning: "Reveal calldata contains the commitment secret. Submit only through the reviewed owner wallet after authorization. No mainnet name or funds are involved." };
  }
  return { quote, prepare, reveal };
}

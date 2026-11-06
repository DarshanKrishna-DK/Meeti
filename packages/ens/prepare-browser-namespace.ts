import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createPublicClient, parseEther, type Address, type Hex } from "viem";
import { sepolia } from "viem/chains";
import { createEnsAuthorityProvider, encodeInlinePolicyUri, inlinePolicyDigest, inlinePolicySchema, type EnsOperation } from "./index";
import { createEnsReadTransport } from "./rpc-transport";

const owner = "0xEE291Bc0246441F53610FbCAF2bC892110e72732" as Address;
const delegate = "0x9253705482a44e6A7378163e57cc791AE6213ed5" as Address;
const name = "agent.crypteck.eth";
const peerName = "agent.meeti-demo.eth";
const operations = ["deploy-registry", "set-subregistry", "create-subname", "deploy-resolver", "set-resolver", "set-policy", "grant", "revoke", "restore", "update-peer"] as const;
let disconnect: (() => Promise<void>) | undefined;
let stage = "validate_arguments";
function readPublicJson(path: string) { return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, "")); }

async function main() {
  const phase = process.argv[2];
  if (!operations.includes(phase as typeof operations[number])) throw new Error("unsupported_browser_namespace_operation");
  const rpcUrl = process.env.ENS_SEPOLIA_AUTH_RPC_URL || process.env.ENS_SEPOLIA_RPC_URL;
  if (!rpcUrl || !rpcUrl.startsWith("https://")) throw new Error("https_authority_rpc_required");
  stage = "load_public_policy";
  const policy = inlinePolicySchema.parse(readPublicJson(".local-data/ens-network-policy.json"));
  const digest = inlinePolicyDigest(policy);
  const targetName = phase === "update-peer" ? peerName : name;
  const targetOwner = phase === "update-peer" ? delegate : owner;
  const targetDelegate = phase === "update-peer" ? owner : delegate;
  stage = "load_public_journal";
  const journal = readPublicJson(".local-data/ens-execution-metamask.json");
  const cap = parseEther("0.005");
  if (journal.chainId !== 11155111 || String(journal.owner).toLowerCase() !== owner.toLowerCase() || BigInt(journal.authorizedGasCapWei) !== cap) throw new Error("browser_journal_scope_mismatch");
  const provider = createEnsAuthorityProvider({ rpcUrl });
  disconnect = provider.disconnect;
  const operation: EnsOperation = phase === "restore" ? "grant" : phase === "update-peer" ? "update-status" : phase as EnsOperation;
  let value: string | undefined;
  if (operation === "set-policy") value = JSON.stringify({ version: String(policy.version), ensName: name, owner, delegate, digest,
    uri: encodeInlinePolicyUri(policy), expiresAt: Math.floor(Date.parse(policy.expiresAt) / 1000), actions: [...policy.allowedActions, "update-status"], resolverScope: "dedicated-agent" });
  if (operation === "update-status") value = JSON.stringify({ schema: "meeti.agent-card.v1", ensName: targetName, owner: targetOwner, delegate: targetDelegate,
    persona: "A Meeti representative that shares only approved public context.", capabilities: policy.allowedActions, policyVersion: policy.version, policyDigest: digest });
  stage = "prepare_contract_call";
  const prepared = await provider.prepareTransaction({ operation, ensName: targetName, owner: targetOwner, delegate: targetDelegate,
    expiresAt: Math.floor(Date.parse(policy.expiresAt) / 1000), value });
  if (prepared.from.toLowerCase() !== owner.toLowerCase() || prepared.chainId !== 11155111 || prepared.value !== "0x0") throw new Error("browser_transaction_scope_mismatch");
  stage = "estimate_fees";
  const client = createPublicClient({ chain: sepolia, transport: createEnsReadTransport(rpcUrl) });
  if (await client.getChainId() !== 11155111) throw new Error("unsupported_chain");
  const block = await client.getBlock({ blockTag: "latest" });
  if (Math.abs(Date.now() / 1000 - Number(block.timestamp)) >= 90) throw new Error("stale_chain_head");
  const [nonce, latestNonce, estimate, fees] = await Promise.all([
    client.getTransactionCount({ address: owner, blockTag: "pending" }),
    client.getTransactionCount({ address: owner, blockTag: "latest" }),
    client.estimateGas({ account: owner, to: prepared.to, data: prepared.data, value: 0n, blockNumber: block.number }),
    client.estimateFeesPerGas({ type: "eip1559" }),
  ]);
  if (nonce !== latestNonce) throw new Error("browser_pending_transaction_requires_reconciliation");
  const gas = estimate + estimate / 5n + 1n;
  const maxPriorityFeePerGas = fees.maxPriorityFeePerGas > 100000n ? fees.maxPriorityFeePerGas : 100000n;
  const headroom = (block.baseFeePerGas ?? 0n) * 2n + maxPriorityFeePerGas;
  const estimatedMaximum = fees.maxFeePerGas > headroom ? fees.maxFeePerGas : headroom;
  const maxFeePerGas = estimatedMaximum > 1000000n ? estimatedMaximum : 1000000n;
  const maximumGasFeeWei = gas * maxFeePerGas;
  const prior = BigInt(journal.actualGasSpentWei || "0") + BigInt(journal.reservedMaximumGasWei || "0");
  if (prior + maximumGasFeeWei > cap || gas > block.gasLimit / 2n) throw new Error("approved_browser_gas_cap_exceeded");
  const transaction = { ...prepared, nonce: ("0x" + nonce.toString(16)) as Hex, gas: ("0x" + gas.toString(16)) as Hex,
    maxFeePerGas: ("0x" + maxFeePerGas.toString(16)) as Hex, maxPriorityFeePerGas: ("0x" + maxPriorityFeePerGas.toString(16)) as Hex,
    maximumGasFeeWei: maximumGasFeeWei.toString(), estimatedGas: estimate.toString(), simulated: true, blockNumber: block.number.toString() };
  const artifact = resolve(".local-data", `ens-namespace-meta-${phase}.json`);
  const review = { ensName: targetName, phase, owner, delegate, chainId: 11155111, policyDigest: digest, policyVersion: policy.version,
    authoritySnapshot: "latest", checkedAt: new Date().toISOString(), approvedTotalCapWei: cap.toString(), priorSpentOrReservedWei: prior.toString(),
    maximumGasFeeWei: maximumGasFeeWei.toString(), requiresWalletReview: true, broadcast: false, transaction };
  stage = "write_artifact";
  writeFileSync(artifact, JSON.stringify(review, null, 2), { mode: 0o600 });
  console.log(JSON.stringify({ artifact, ensName: targetName, phase, from: owner, to: transaction.to, nonce: transaction.nonce, gas: transaction.gas,
    maximumGasFeeWei: transaction.maximumGasFeeWei, policyDigest: digest, blockNumber: transaction.blockNumber, broadcast: false }));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "browser_preparation_failed";
  const causes = [];
  let cause = error as { name?: string; code?: unknown; status?: unknown; cause?: unknown } | undefined;
  for (let depth = 0; cause && depth < 8; depth++, cause = cause.cause as typeof cause) causes.push({ name: cause.name, code: cause.code, status: cause.status });
  console.error(JSON.stringify({ prepared: false, stage, reason: /^[a-z][a-z0-9_]{0,100}$/.test(message) ? message : "browser_rpc_or_validation_failed", causes, broadcast: false }));
  process.exitCode = 1;
}).finally(async () => { await disconnect?.(); });

import { createPublicClient } from "viem";
import { sepolia } from "viem/chains";
import { ENS_CHAIN_ID, ENS_DEPLOYMENT, verifyEnsIndependently } from "./index";
import { registryAbi, universalAbi } from "./abi";
import { createEnsReadTransport } from "./rpc-transport";

let disconnect: (() => Promise<void>) | undefined;
async function main() {
  const rpcUrl = process.env.ENS_SEPOLIA_AUTH_RPC_URL || process.env.ENS_SEPOLIA_RPC_URL;
  if (process.argv[2] === "--deployment") {
    if (!rpcUrl) throw new Error("ens_rpc_not_configured");
    const client = createPublicClient({ chain: sepolia, transport: createEnsReadTransport(rpcUrl) });
    disconnect = async () => {
      const transport = client.transport as { getRpcClient?: () => Promise<{ close(): void }>; getSocket?: () => Promise<{ close(): void }> };
      if (transport.getRpcClient) (await transport.getRpcClient()).close();
      else if (transport.getSocket) (await transport.getSocket()).close();
    };
    const block = await client.getBlock({ blockTag: "latest" });
    if (block.number === null || Math.abs(Date.now() / 1000 - Number(block.timestamp)) >= 90) throw new Error("stale_chain_head");
    const chainId = await client.getChainId();
    const root = await client.readContract({ address: ENS_DEPLOYMENT.universalResolver, abi: universalAbi, functionName: "ROOT_REGISTRY", blockNumber: block.number });
    const active = await client.readContract({ address: ENS_DEPLOYMENT.universalResolver, abi: universalAbi, functionName: "isENSv2", blockNumber: block.number });
    const eth = await client.readContract({ address: root, abi: registryAbi, functionName: "getSubregistry", args: ["eth"], blockNumber: block.number });
    const code = await client.getCode({ address: ENS_DEPLOYMENT.factory, blockNumber: block.number });
    const verified = active && chainId === ENS_CHAIN_ID && root.toLowerCase() === ENS_DEPLOYMENT.rootRegistry.toLowerCase() && eth.toLowerCase() === ENS_DEPLOYMENT.ethRegistry.toLowerCase() && Boolean(code && code !== "0x");
    console.log(JSON.stringify({ verified, chainId, root, ethRegistry: eth, factoryCodeBytes: code ? (code.length - 2) / 2 : 0, blockNumber: block.number?.toString(), checkedAt: new Date().toISOString(), authorityVerified: false }, null, 2));
    process.exitCode = verified ? 0 : 1;
    return;
  }
  const [ensName, owner, delegate, action, policyVersion, policyDigest] = process.argv.slice(2);
  if (!ensName || !owner || !delegate || !action || !policyVersion || !policyDigest) {
    throw new Error("usage_requires_name_owner_delegate_action_version_digest");
  }
  const result = await verifyEnsIndependently({ rpcUrl }, { ensName, owner, delegate, action, policyVersion, policyDigest });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.allowed ? 0 : 1;
}

main().catch(() => {
  console.log(JSON.stringify({ allowed: false, reason: "verification_unavailable_or_invalid_input", chainId: ENS_CHAIN_ID }));
  process.exitCode = 1;
}).finally(async () => { await disconnect?.().catch(() => undefined); });

import { createPublicClient, http, webSocket } from 'viem';
import { sepolia } from 'viem/chains';

// Report only fixed endpoint labels and numeric errors. Provider URLs can contain credentials.
function codes(error: unknown) {
  const result: { httpStatus?: number; rpcCode?: number }[] = [];
  let current = error;
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    const value = current as { status?: unknown; code?: unknown; cause?: unknown };
    const httpStatus = typeof value.status === 'number' ? value.status : undefined;
    const rpcCode = typeof value.code === 'number' ? value.code : undefined;
    if (httpStatus !== undefined || rpcCode !== undefined) result.push({ httpStatus, rpcCode });
    if (current === value.cause) break;
    current = value.cause;
  }
  return result;
}

const seen = new Set<string>();
const transactionHash = process.argv[2];
if (transactionHash && !/^0x[0-9a-fA-F]{64}$/.test(transactionHash)) throw new Error('Expected a public transaction hash.');
for (const name of ['ENS_SEPOLIA_AUTH_RPC_URL', 'ENS_SEPOLIA_RPC_URL'] as const) {
  const url = process.env[name];
  if (!url) { console.log(JSON.stringify({ endpoint: name, configured: false })); continue; }
  if (seen.has(url)) { console.log(JSON.stringify({ endpoint: name, sameAsPrior: true })); continue; }
  seen.add(url);
  const host = new URL(url).hostname;
  const provider = ['alchemy.com', 'alchemyapi.io', 'infura.io', 'publicnode.com', 'drpc.org', 'ankr.com', 'quiknode.pro']
    .find(domain => host === domain || host.endsWith(`.${domain}`)) || 'other';
  console.log(JSON.stringify({ endpoint: name, provider }));
  const client = createPublicClient({ chain: sepolia, transport: url.startsWith('wss:')
    ? webSocket(url, { timeout: 15000, retryCount: 0, reconnect: false, keepAlive: false })
    : http(url, { timeout: 15000, retryCount: 0 }) });
  try {
    const chainId = await client.getChainId();
    const block = await client.getBlock();
    console.log(JSON.stringify({ endpoint: name, ok: chainId === 11155111, chainId, block: block.number?.toString(),
      headAgeSeconds: Math.round(Date.now() / 1000 - Number(block.timestamp)), checkedAt: new Date().toISOString() }));
    if (transactionHash && chainId === 11155111) {
      const receipt = await client.getTransactionReceipt({ hash: transactionHash as `0x${string}` });
      console.log(JSON.stringify({ endpoint: name, transactionHash, status: receipt.status, block: receipt.blockNumber.toString(),
        blockHash: receipt.blockHash, actualFeeWei: (receipt.gasUsed * receipt.effectiveGasPrice).toString() }));
    }
  } catch (error) { console.log(JSON.stringify({ endpoint: name, ok: false, errors: codes(error), checkedAt: new Date().toISOString() })); }
  finally {
    const transport = client.transport as { getRpcClient?: () => Promise<{ close(): void }> };
    try { if (transport.getRpcClient) (await transport.getRpcClient()).close(); } catch { /* Do not print transport credentials. */ }
  }
}

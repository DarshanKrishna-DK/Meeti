import { http, webSocket } from "viem";

const readMethods = new Set([
  "eth_chainId", "eth_blockNumber", "eth_getBlockByNumber", "eth_getBlockByHash", "eth_call", "eth_getCode", "eth_getStorageAt", "eth_getBalance",
  "eth_getTransactionCount", "eth_estimateGas", "eth_gasPrice", "eth_maxPriorityFeePerGas", "eth_feeHistory",
  "eth_getTransactionReceipt", "eth_getTransactionByHash", "eth_getLogs", "net_version",
]);
type ReadQueue = { tail: Promise<void>; nextStart: number; pending: number };
const globalState = globalThis as typeof globalThis & { __meetiEnsReadQueues?: Map<string, ReadQueue> };
const queues = globalState.__meetiEnsReadQueues ??= new Map<string, ReadQueue>();

function wait(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const finish = () => { signal.removeEventListener("abort", abort); resolve(); };
    const timer = setTimeout(finish, milliseconds);
    const abort = () => { clearTimeout(timer); signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
  });
}

export function createPacedReadFetch(fetcher: typeof fetch = globalThis.fetch, intervalMilliseconds = 300): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init);
    const body = JSON.parse(await request.clone().text()) as { method?: string } | { method?: string }[];
    const calls = Array.isArray(body) ? body : [body];
    if (calls.length < 1 || calls.length > 4 || calls.some((call) => !call.method || !readMethods.has(call.method))) throw new Error("ens_rpc_read_transport_scope_violation");
    let queue = queues.get(request.url);
    if (!queue) { queue = { tail: Promise.resolve(), nextStart: 0, pending: 0 }; queues.set(request.url, queue); }
    if (queue.pending >= 128) throw new Error("ens_rpc_read_queue_full");
    queue.pending++;
    const state = queue;
    const reservation = state.tail.then(async () => {
      if (request.signal.aborted) throw request.signal.reason;
      await wait(Math.max(0, state.nextStart - Date.now()), request.signal);
      state.nextStart = Date.now() + intervalMilliseconds * calls.length;
    });
    state.tail = reservation.catch(() => undefined);
    try { await reservation; }
    finally { state.pending--; }
    return fetcher(request);
  };
}

export function createEnsReadTransport(rpcUrl: string) {
  if (rpcUrl.startsWith("wss://")) return webSocket(rpcUrl, { timeout: 30000, retryCount: 0, reconnect: false, keepAlive: false });
  return http(rpcUrl, {
    batch: { batchSize: 4, wait: 10 },
    fetchFn: createPacedReadFetch(),
    timeout: 30000,
    retryCount: 0,
  });
}

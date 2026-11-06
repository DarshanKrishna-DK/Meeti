import { http, webSocket, type Transport } from "viem";

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

export type EnsReadFailureDiagnostic = { method: string; attempt: number; retryable: boolean; httpStatuses: number[]; rpcCodes: number[] };
export function classifyEnsReadFailure(error: unknown) {
  const statuses = new Set<number>(), codes = new Set<number>(), names = new Set<string>(), networkCodes = new Set<string>();
  const queue: unknown[] = [error], seen = new Set<object>();
  for (let count = 0; queue.length && count < 24; count++) {
    const item = queue.shift(); if (!item || typeof item !== "object" || seen.has(item)) continue; seen.add(item);
    const value = item as Record<string, unknown>;
    if (typeof value.name === "string") names.add(value.name);
    for (const key of ["status", "statusCode"]) if (typeof value[key] === "number" && Number.isInteger(value[key]) && value[key] >= 100 && value[key] <= 599) statuses.add(value[key]);
    if (typeof value.code === "number" && Number.isInteger(value.code) && value.code >= -32768 && value.code <= 32767) codes.add(value.code);
    if (typeof value.code === "string") networkCodes.add(value.code);
    for (const key of ["cause", "error", "response"]) if (value[key] && typeof value[key] === "object") queue.push(value[key]);
  }
  const forbidden = codes.size > 0 || names.has("AbortError") || names.has("ExecutionRevertedError") || names.has("ContractFunctionRevertedError") || [...statuses].some(status => ![408, 429, 500, 502, 503, 504].includes(status));
  const network = names.has("TimeoutError") || (names.has("HttpRequestError") && names.has("TypeError")) || [...networkCodes].some(code => ["ECONNRESET", "EPIPE", "EAI_AGAIN", "UND_ERR_CONNECT_TIMEOUT", "UND_ERR_SOCKET"].includes(code));
  return { retryable: !forbidden && (statuses.size > 0 || network), httpStatuses: [...statuses].sort((a, b) => a - b), rpcCodes: [...codes].sort((a, b) => a - b) };
}

// viem's default retry policy includes 403, internal RPC errors and unbounded Retry-After delays.
// Keep it disabled and retry only classified read failures once, with a fixed bounded delay.
export function createEnsReadTransport(rpcUrl: string, options: { fetcher?: typeof fetch; onFailure?: (diagnostic: EnsReadFailureDiagnostic) => void } = {}): Transport {
  const methods = { include: [...readMethods] };
  const base = rpcUrl.startsWith("wss://") ? webSocket(rpcUrl, { timeout: 10000, retryCount: 0, methods, reconnect: false, keepAlive: false }) : http(rpcUrl, {
    batch: { batchSize: 4, wait: 10 },
    fetchFn: createPacedReadFetch(options.fetcher),
    timeout: 10000, retryCount: 0, methods,
  });
  return (parameters) => {
    const transport = base({ ...parameters, timeout: 10000, retryCount: 0 });
    const request = (async (args, requestOptions) => {
      if (!readMethods.has(args.method)) throw new Error("ens_rpc_read_transport_scope_violation");
      for (let attempt = 1; attempt <= 2; attempt++) {
        try { return await transport.request(args, { ...requestOptions, retryCount: 0 }); }
        catch (error) {
          const classified = classifyEnsReadFailure(error);
          const diagnostic = { method: args.method, attempt, ...classified };
          try {
            options.onFailure?.(diagnostic);
            if (process.env.MEETI_ENS_RPC_DIAGNOSTICS === "true") console.warn(JSON.stringify({ event: "ens_rpc_read_failure", failureKind: classified.httpStatuses.length ? "http" : classified.rpcCodes.length ? "json_rpc" : "transport", ...diagnostic }));
          } catch { /* Optional diagnostics cannot replace the provider result. */ }
          if (attempt === 2 || !classified.retryable || requestOptions?.signal?.aborted) throw error;
          await wait(750, requestOptions?.signal ?? new AbortController().signal);
        }
      }
      throw new Error("ens_rpc_read_attempts_exhausted");
    }) as typeof transport.request;
    return { ...transport, request };
  };
}

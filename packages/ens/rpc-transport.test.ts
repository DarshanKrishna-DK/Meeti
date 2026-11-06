import { afterEach, describe, expect, it, vi } from "vitest";
import { createPublicClient, http } from "viem";
import { classifyEnsReadFailure, createEnsReadTransport, createPacedReadFetch, withEnsReadScope } from "./rpc-transport";

function request(url: string, body: unknown) { return new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
describe("ENS read-only RPC transport", () => {
  afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
  it("paces by RPC method count and never admits a transaction submission", async () => {
    const starts: number[] = [];
    const fetcher = vi.fn(async () => { starts.push(Date.now()); return new Response("{}"); });
    const paced = createPacedReadFetch(fetcher as typeof fetch, 10);
    await Promise.all([
      paced(request("https://ens.test/weighted", [{ method: "eth_chainId" }, { method: "eth_blockNumber" }])),
      paced(request("https://ens.test/weighted", { method: "eth_chainId" })),
    ]);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(18);
    await expect(paced(request("https://ens.test/weighted", { method: "eth_sendRawTransaction", params: ["0x1234"] }))).rejects.toThrow("ens_rpc_read_transport_scope_violation");
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("supports viem JSON-RPC batching while preserving response IDs", async () => {
    const batchSizes: number[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const body = JSON.parse(await (input as Request).text());
      batchSizes.push(body.length);
      return Response.json(body.map((call: { id: number; method: string }) => ({ jsonrpc: "2.0", id: call.id, result: call.method === "eth_chainId" ? "0xaa36a7" : "0x64" })));
    });
    const client = createPublicClient({ transport: http("https://ens.test/batching", { batch: { batchSize: 4, wait: 10 }, fetchFn: createPacedReadFetch(fetcher as typeof fetch, 1), retryCount: 0 }) });
    expect(await Promise.all([client.getChainId(), client.getBlockNumber()])).toEqual([11155111, 100n]);
    expect(batchSizes).toEqual([2]);
  });
  it("retries an actual viem HTTP503 once and preserves the read result", async () => {
    let count = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      count++; if (count === 1) return new Response("temporarily unavailable", { status: 503 });
      const body = JSON.parse(await (input as Request).text());
      return Response.json(body.map((call: { id: number }) => ({ jsonrpc: "2.0", id: call.id, result: "0xaa36a7" })));
    });
    const diagnostics: unknown[] = [];
    const client = createPublicClient({ transport: createEnsReadTransport("https://ens.test/retry503?private=credential", { fetcher: fetcher as typeof fetch, onFailure: value => diagnostics.push(value) }) });
    expect(await client.getChainId()).toBe(11155111); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(diagnostics).toEqual([{ method: "eth_chainId", attempt: 1, retryable: true, httpStatuses: [503], rpcCodes: [] }]);
  });
  it("stops after two transient failures and never honors a long Retry-After header", async () => {
    const fetcher = vi.fn(async () => new Response("unavailable", { status: 503, headers: { "Retry-After": "9999" } }));
    const client = createPublicClient({ transport: createEnsReadTransport("https://ens.test/retrybounded", { fetcher: fetcher as typeof fetch }) });
    await expect(client.getChainId()).rejects.toThrow(); expect(fetcher).toHaveBeenCalledTimes(2);
    expect(client.transport.timeout).toBe(10000); expect(client.transport.retryCount).toBe(0);
  });
  it.each([401, 403, 413])("does not retry authentication or deterministic HTTP%s errors", async status => {
    const fetcher = vi.fn(async () => new Response("private provider body", { status }));
    const client = createPublicClient({ transport: createEnsReadTransport(`https://ens.test/no-retry-${status}`, { fetcher: fetcher as typeof fetch }) });
    await expect(client.getChainId()).rejects.toThrow(); expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([-32603, -32602, -32005, 3])("does not retry a JSON-RPC error %s, including reverts and limits", async code => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const body = JSON.parse(await (input as Request).text());
      return Response.json(body.map((call: { id: number }) => ({ jsonrpc: "2.0", id: call.id, error: { code, message: "private RPC details", data: "0x1234" } })));
    });
    const client = createPublicClient({ transport: createEnsReadTransport(`https://ens.test/no-rpc-retry-${code}`, { fetcher: fetcher as typeof fetch }) });
    await expect(client.getChainId()).rejects.toThrow(); expect(fetcher).toHaveBeenCalledOnce();
  });
  it("denies signing and broadcast methods before any fetch and keeps diagnostics opt-in and sanitized", async () => {
    const fetcher = vi.fn(async () => new Response("secret url body", { status: 403 }));
    const output = vi.spyOn(console, "warn").mockImplementation(() => {});
    const client = createPublicClient({ transport: createEnsReadTransport("https://ens.test/scope?key=do-not-log", { fetcher: fetcher as typeof fetch }) });
    await expect(client.request({ method: "eth_sendRawTransaction", params: ["0x1234"] })).rejects.toThrow("scope_violation");
    await expect(client.request({ method: "personal_sign" } as never)).rejects.toThrow("scope_violation"); expect(fetcher).not.toHaveBeenCalled();
    await expect(client.getChainId()).rejects.toThrow(); expect(output).not.toHaveBeenCalled();
    vi.stubEnv("MEETI_ENS_RPC_DIAGNOSTICS", "true"); await expect(client.getChainId()).rejects.toThrow();
    expect(output).toHaveBeenCalledOnce();
    expect(JSON.parse(output.mock.calls[0][0])).toEqual({ event: "ens_rpc_read_failure", failureKind: "http", method: "eth_chainId", attempt: 1, retryable: false, httpStatuses: [403], rpcCodes: [] });
    expect(JSON.stringify(output.mock.calls)).not.toMatch(/secret|key=|do-not-log|body|https/);
  });
  it("classifies only known transport failures and never retries cancellation, unknown errors or nested RPC errors", () => {
    expect(classifyEnsReadFailure({ name: "TimeoutError" }).retryable).toBe(true);
    expect(classifyEnsReadFailure({ name: "HttpRequestError", cause: { name: "TypeError", message: "sensitive" } }).retryable).toBe(true);
    expect(classifyEnsReadFailure({ name: "AbortError", cause: { name: "TimeoutError" } }).retryable).toBe(false);
    expect(classifyEnsReadFailure(new Error("unknown" )).retryable).toBe(false);
    expect(classifyEnsReadFailure({ status: 503, cause: { code: -32603 } }).retryable).toBe(false);
  });
});

describe("operation-scoped explicitly pinned ENS reads", () => {
  const call = { method: "eth_call" as const, params: [{ to: "0x1111111111111111111111111111111111111111" as const, data: "0x1234" as const }, "0x64" as const] as const };
  function fixture(url: string) {
    let logicalReads = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const body = JSON.parse(await (input as Request).text());
      logicalReads += body.length;
      return Response.json(body.map((item: { id: number }) => ({ jsonrpc: "2.0", id: item.id, result: "0x01" })));
    });
    const client = () => createPublicClient({ transport: createEnsReadTransport(url, { fetcher: fetcher as typeof fetch }) });
    return { client, fetcher, count: () => logicalReads };
  }
  it("reduces eight identical reads across clients to one only inside one verification scope", async () => {
    const scoped = fixture("https://ens.test/scoped-eight"), a = scoped.client(), b = scoped.client();
    await withEnsReadScope(async () => {
      expect(await Promise.all(Array.from({ length: 8 }, (_, i) => (i % 2 ? a : b).request(call)))).toEqual(Array(8).fill("0x01"));
      expect(await a.request(call)).toBe("0x01");
    });
    expect(scoped.count()).toBe(1);
    const unscoped = fixture("https://ens.test/unscoped-eight"), client = unscoped.client();
    await Promise.all(Array.from({ length: 8 }, () => client.request(call)));
    expect(unscoped.count()).toBe(8);
  }, 10000);
  it("isolates concurrent and consecutive scopes and invalidates the finished operation", async () => {
    const f = fixture("https://ens.test/isolate"), client = f.client();
    await Promise.all([withEnsReadScope(() => client.request(call)), withEnsReadScope(() => client.request(call))]);
    expect(f.count()).toBe(2);
    await withEnsReadScope(() => client.request(call)); expect(f.count()).toBe(3);
    await client.request(call); expect(f.count()).toBe(4);
  });
  it("does not coalesce latest, pending, head, chain or abort-signaled requests", async () => {
    const f = fixture("https://ens.test/exclusions"), client = f.client();
    await withEnsReadScope(async () => {
      await Promise.all([
        client.request({ ...call, params: [call.params[0], "latest"] }), client.request({ ...call, params: [call.params[0], "latest"] }),
        client.request({ ...call, params: [call.params[0], "pending"] }), client.request({ ...call, params: [call.params[0], "pending"] }),
        client.request({ method: "eth_chainId" }), client.request({ method: "eth_chainId" }),
        client.request({ method: "eth_blockNumber" }), client.request({ method: "eth_blockNumber" }),
        client.request(call, { signal: new AbortController().signal }), client.request(call, { signal: new AbortController().signal }),
      ]);
    }); expect(f.count()).toBe(10);
  }, 10000);
  it("separates endpoint, calldata and exact block parameters", async () => {
    const a = fixture("https://ens.test/endpoint-a"), b = fixture("https://ens.test/endpoint-b"), ca = a.client(), cb = b.client();
    await withEnsReadScope(async () => {
      await Promise.all([ca.request(call), cb.request(call), ca.request({ ...call, params: [{ ...call.params[0], data: "0xabcd" }, "0x64"] }), ca.request({ ...call, params: [call.params[0], "0x65"] })]);
    }); expect(a.count()).toBe(3); expect(b.count()).toBe(1);
  });
  it("evicts failures so a fresh read in the same gate can recover", async () => {
    let count = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      count++; const body = JSON.parse(await (input as Request).text());
      return Response.json(body.map((item: { id: number }) => count === 1 ? { jsonrpc: "2.0", id: item.id, error: { code: -32603, message: "fixture failure" } } : { jsonrpc: "2.0", id: item.id, result: "0x01" }));
    });
    const client = createPublicClient({ transport: createEnsReadTransport("https://ens.test/evict-failure", { fetcher: fetcher as typeof fetch }) });
    await withEnsReadScope(async () => { await expect(client.request(call)).rejects.toThrow(); expect(await client.request(call)).toBe("0x01"); });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it("bounds stored reads without replacing authoritative reads with an alternate result", async () => {
    const f = fixture("https://ens.test/scope-bound"), client = f.client(), other = { ...call, params: [call.params[0], "0x65" as const] as const };
    await withEnsReadScope(async () => { await client.request(call); await client.request(other); await client.request(other); await client.request(call); }, { maxEntries: 1 });
    expect(f.count()).toBe(3);
    await expect(withEnsReadScope(async () => {}, { maxEntries: 0 })).rejects.toThrow("scope_bound_invalid");
  });
});

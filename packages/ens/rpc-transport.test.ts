import { describe, expect, it, vi } from "vitest";
import { createPublicClient, http } from "viem";
import { createPacedReadFetch } from "./rpc-transport";

function request(url: string, body: unknown) { return new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }); }
describe("ENS read-only RPC transport", () => {
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
});

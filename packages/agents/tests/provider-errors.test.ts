import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OpenAICompatibleProvider, type ProviderConfig } from "../src";

const config: ProviderConfig = {
  baseUrl: "https://provider.example/v1", apiKey: "fixture-key", model: "fixture-model",
  timeoutMs: 1000, maxRequests: 1, maxCostUsd: 1, inputUsdPerMillion: 1,
  outputUsdPerMillion: 1, maxOutputTokens: 128, maxInputBytes: 24_000,
};
const request = { task: "fixture", instructions: "Return JSON.", data: {}, outputSchema: z.object({ ok: z.boolean() }) };

function responseFixture(body: string, headers?: HeadersInit) {
  const response = new Response(body, { status: 400, headers });
  const reader = response.body!.getReader();
  const cancel = vi.spyOn(reader, "cancel");
  vi.spyOn(response.body!, "getReader").mockReturnValue(reader);
  const transport = vi.fn<typeof fetch>(async () => response);
  return { provider: new OpenAICompatibleProvider(config, transport), transport, reader, cancel };
}

describe("provider diagnostic boundary with test-only HTTP fixtures", () => {
  it.each(["json_validate_failed", "rate_limit_exceeded", "insufficient_quota", "model_not_found"])(
    "retains only the allowlisted code %s and sends no retry", async (code) => {
      const fixture = responseFixture(JSON.stringify({ error: {
        code, message: "private owner context", failed_generation: "private generated response",
      } }));
      await expect(fixture.provider.generate(request)).rejects.toMatchObject({
        code: "provider", message: `The AI provider returned HTTP 400 (${code}).`,
      });
      expect(fixture.transport).toHaveBeenCalledTimes(1);
      expect(fixture.cancel).toHaveBeenCalledOnce();
    },
  );

  it("supports a known error type without exposing an unknown provider code", async () => {
    const fixture = responseFixture(JSON.stringify({ error: { code: "private-context", type: "invalid_request_error" } }));
    await expect(fixture.provider.generate(request)).rejects.toThrow("HTTP 400 (invalid_request_error).");
    expect(fixture.cancel).toHaveBeenCalledOnce();
  });

  it.each([
    "private upstream body",
    '{"error":{"code":"json_validate_failed private-context","message":"private-context"}}',
    '{"error":{"message":"json_validate_failed private-context"}}',
    '{"error":"json_validate_failed"}',
    '{"code":"json_validate_failed"}',
  ])("does not reflect malformed, unknown or misplaced diagnostics", async (body) => {
    const fixture = responseFixture(body);
    await expect(fixture.provider.generate(request)).rejects.toMatchObject({
      code: "provider", message: "The AI provider returned HTTP 400.",
    });
    expect(fixture.cancel).toHaveBeenCalledOnce();
  });

  it("does not parse a streamed body larger than 16 KiB", async () => {
    const fixture = responseFixture(JSON.stringify({ error: { code: "json_validate_failed", message: "x".repeat(16_384) } }));
    await expect(fixture.provider.generate(request)).rejects.toThrow("HTTP 400.");
    expect(fixture.cancel).toHaveBeenCalledOnce();
  });

  it("cancels without reading a declared oversized body", async () => {
    const fixture = responseFixture('{"error":{"code":"json_validate_failed"}}', { "content-length": "16385" });
    const read = vi.spyOn(fixture.reader, "read");
    await expect(fixture.provider.generate(request)).rejects.toThrow("HTTP 400.");
    expect(read).not.toHaveBeenCalled();
    expect(fixture.cancel).toHaveBeenCalledOnce();
  });

  it("cancels and returns a safe HTTP error if reading fails", async () => {
    const fixture = responseFixture("fixture");
    vi.spyOn(fixture.reader, "read").mockRejectedValue(new Error("private transport details"));
    await expect(fixture.provider.generate(request)).rejects.toMatchObject({
      code: "provider", message: "The AI provider returned HTTP 400.",
    });
    expect(fixture.cancel).toHaveBeenCalledOnce();
  });
});

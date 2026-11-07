import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { OpenAICompatibleProvider, providerDiagnosticSchema, type ProviderConfig } from "../src";

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

  it("canonicalizes a reported schema path without retaining its private keys, message or failed generation", async () => {
    const secret = 'PRIVATE_OWNER_CONTEXT_NEVER_RETAIN';
    const fixture = responseFixture(JSON.stringify({ error: { type: 'invalid_request_error', param: `response_format.json_schema.schema.properties.${secret}`,
      message: `Invalid schema in ${secret}: 'oneOf' is not permitted.`, failed_generation: secret } }));
    const error = await fixture.provider.generate(request).catch(value => value);
    expect(error.providerDetail).toEqual({ status: 400, code: 'invalid_request_error', diagnostic: { parameter: 'response_format.json_schema.schema', reason: 'schema_unsupported_keyword', schemaKeyword: 'oneOf' } });
    expect(error.message).toBe('The AI provider returned HTTP 400 (invalid_request_error).');
    expect(JSON.stringify(error)).not.toContain(secret);
    expect(fixture.transport).toHaveBeenCalledOnce(); expect(fixture.cancel).toHaveBeenCalledOnce();
  });

  it.each(['oneOf', 'allOf', 'patternProperties', 'prefixItems', '$ref', '$defs'])("recognizes only the fixed reported unsupported keyword %s", async keyword => {
    const fixture = responseFixture(JSON.stringify({ error: { code: 'invalid_request_error', message: `Unsupported schema keyword: '${keyword}'. Private source details omitted.` } }));
    const error = await fixture.provider.generate(request).catch(value => value);
    expect(error.providerDetail.diagnostic).toEqual({ reason: 'schema_unsupported_keyword', schemaKeyword: keyword });
    expect(JSON.stringify(error)).not.toContain('Private source'); expect(fixture.transport).toHaveBeenCalledOnce();
  });

  it.each([
    ['response_format.json_schema.strict', 'Unsupported parameter value.', { parameter: 'response_format.json_schema.strict', reason: 'parameter_unsupported' }],
    ['reasoning_effort', 'Invalid value for this parameter.', { parameter: 'reasoning_effort', reason: 'parameter_invalid' }],
    ['messages[17].content.private-key', 'Invalid value.', { parameter: 'messages', reason: 'parameter_invalid' }],
    ['response_format.json_schema.schema', 'additionalProperties is required to be supplied and to be false.', { parameter: 'response_format.json_schema.schema', reason: 'schema_object_not_closed', schemaKeyword: 'additionalProperties' }],
    ['response_format', "'required' must include every key in properties.", { parameter: 'response_format', reason: 'schema_required_fields', schemaKeyword: 'required' }],
    ['response_format', 'Invalid JSON schema for the response.', { parameter: 'response_format', reason: 'schema_invalid' }],
  ] as const)("classifies a known provider-reported parameter and reason for %s", async (param, message, diagnostic) => {
    const fixture = responseFixture(JSON.stringify({ error: { type: 'invalid_request_error', param, message } }));
    const error = await fixture.provider.generate(request).catch(value => value);
    expect(error.providerDetail.diagnostic).toEqual(diagnostic); expect(fixture.transport).toHaveBeenCalledOnce();
    expect(JSON.stringify(error)).not.toContain('private-key');
  });

  it.each([
    { param: 'response_format_PRIVATE_DATA', message: 'Private owner content' },
    { param: ['response_format'], message: 'Private owner content' },
    { param: { private: 'context' }, message: 'Private owner content' },
    { param: 'response_format.' + 'private'.repeat(60), message: 'Private owner content' },
    { message: "Unsupported keyword: 'PRIVATE_OWNER_CONTEXT'.", failed_generation: "'oneOf' is not permitted." },
    { message: 'Unknown upstream reason mentioning private context.' },
  ])("does not retain unknown parameters, arbitrary reasons or failed-generation hints", async detail => {
    const fixture = responseFixture(JSON.stringify({ error: { type: 'invalid_request_error', ...detail } }));
    const error = await fixture.provider.generate(request).catch(value => value);
    expect(error.providerDetail).toEqual({ status: 400, code: 'invalid_request_error' });
  });

  it("does not classify message content for an unknown provider error type", async () => {
    const fixture = responseFixture(JSON.stringify({ error: { type: 'private-type', message: "'oneOf' is not permitted.", param: 'private-path' } }));
    const error = await fixture.provider.generate(request).catch(value => value);
    expect(error.providerDetail).toEqual({ status: 400 });
  });

  it("ignores an oversized message while preserving an exact known parameter independently", async () => {
    const fixture = responseFixture(JSON.stringify({ error: { type: 'invalid_request_error', param: 'response_format', message: "'oneOf' is not permitted. " + 'x'.repeat(4096) } }));
    const error = await fixture.provider.generate(request).catch(value => value);
    expect(error.providerDetail).toEqual({ status: 400, code: 'invalid_request_error', diagnostic: { parameter: 'response_format' } });
    expect(fixture.cancel).toHaveBeenCalledOnce();
  });

  it("exposes a strict schema for downstream revalidation without accepting injected metadata", () => {
    expect(providerDiagnosticSchema.safeParse({ parameter: 'response_format', reason: 'schema_invalid' }).success).toBe(true);
    for (const diagnostic of [{ parameter: 'response_format.private-key' }, { reason: 'private-owner-text' }, { schemaKeyword: 'PRIVATE_OWNER_CONTEXT' }, { parameter: 'model', message: 'private context' }]) {
      expect(providerDiagnosticSchema.safeParse(diagnostic).success).toBe(false);
    }
  });
});

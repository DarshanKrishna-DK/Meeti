import { describe, expect, it, vi } from 'vitest';
import { OnnxEmbeddingProvider, onnxLoadFailure, type OnnxEmbeddingConfig, type OnnxEncoder } from './onnx-embeddings';
import { createEmbeddingProviderFromEnv, MatchingError } from './embeddings';
import { ONNX_DIMENSIONS, ONNX_MODEL, ONNX_REVISION, verifyOnnxAssets } from './onnx-model.mjs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const config: OnnxEmbeddingConfig = { model: ONNX_MODEL, modelRevision: ONNX_REVISION, dimensions: ONNX_DIMENSIONS, maxCostUsd: 0, inputUsdPerMillion: 0 };
const vector = (): number[] => Array.from({ length: ONNX_DIMENSIONS }, (_, index) => index === 0 ? 1 : 0);
// These encoder fixtures isolate enforcement. They are not live semantic integration evidence.
function fixture(options: Partial<OnnxEmbeddingConfig> = {}, encode: OnnxEncoder['encode'] = vi.fn(async () => ({ vector: vector(), inputTokens: 4 })), now?: () => number) {
  const verify = vi.fn(async () => {}), load = vi.fn(async () => ({ encode }));
  return { provider: new OnnxEmbeddingProvider({ ...config, ...options }, { load, verify, now }), encode, load, verify };
}

describe('explicit pinned local ONNX embeddings', () => {
  it('classifies loader failures without exposing native exception details', () => {
    for (const [message, code] of [['Cannot find package private-input', 'missing-module'], ['GLIBCXX_3.4 private-input', 'native-compatibility'], ['EROFS private-input', 'filesystem-access'], ['private-input', 'initialization']]) {
      const failure = onnxLoadFailure('library', new Error(message));
      expect(failure.code).toBe('provider'); expect(failure.message).toContain(`library:${code}`); expect(failure.message).not.toContain('private-input');
    }
  });
  it.each([{ model: 'other' }, { modelRevision: 'other' }, { dimensions: 768 }, { maxCostUsd: 1 }, { inputUsdPerMillion: 1 }])('rejects an incompatible or paid recipe %j', override => {
    expect(() => fixture(override)).toThrow(MatchingError);
  });
  it('selects ONNX only explicitly and requires the complete pinned recipe', () => {
    expect(createEmbeddingProviderFromEnv({ EMBEDDING_PROTOCOL: 'onnx', EMBEDDING_MODEL: ONNX_MODEL, EMBEDDING_MODEL_REVISION: ONNX_REVISION, EMBEDDING_DIMENSIONS: '384', EMBEDDING_INPUT_USD_PER_MILLION: '0', EMBEDDING_MAX_COST_USD: '0' })).toBeInstanceOf(OnnxEmbeddingProvider);
    expect(() => createEmbeddingProviderFromEnv({ EMBEDDING_PROTOCOL: 'onnx' })).toThrow(MatchingError);
  });
  it('deduplicates texts, preserves order and does not expose mutable cached vectors', async () => {
    const { provider, encode, verify } = fixture();
    const first = await provider.embed(['role one', 'role two', 'role one']);
    expect(encode).toHaveBeenCalledTimes(2); expect(first.receipt.inputTokens).toBe(8); expect(first.receipt.estimatedCostUsd).toBe(0);
    first.vectors[0][0] = 99;
    const next = await provider.embed(['role one']);
    expect(next.vectors[0][0]).toBe(1); expect(next.receipt.requests).toBe(0); expect(next.receipt.cacheHits).toBe(1); expect(verify).toHaveBeenCalledTimes(3);
    expect(next.receipt.modelRevision).toBe(ONNX_REVISION);
  });
  it('expires cache entries and respects LRU capacity', async () => {
    let time = 0; const { provider, encode } = fixture({ cacheEntries: 1, cacheTtlMs: 10 }, undefined, () => time);
    await provider.embed(['first', 'second']); expect(provider.usage.cacheEntries).toBe(1);
    await provider.embed(['second']); expect(encode).toHaveBeenCalledTimes(2);
    time = 11; await provider.embed(['second']); expect(encode).toHaveBeenCalledTimes(3);
    provider.clearCache(); expect(provider.usage.cacheEntries).toBe(0);
  });
  it.each([[], [''], [' '.repeat(4)], ['x'.repeat(8001)], Array.from({ length: 17 }, () => 'text')].map(texts => ({ texts })))('rejects invalid input before loading %j', async ({ texts }) => {
    const { provider, load } = fixture(); await expect(provider.embed(texts)).rejects.toMatchObject({ code: 'input' }); expect(load).not.toHaveBeenCalled();
  });
  it.each([{ vector: [1], inputTokens: 1 }, { vector: Array(384).fill(0), inputTokens: 1 }, { vector: Array(384).fill(NaN), inputTokens: 1 }, { vector: vector(), inputTokens: 257 }])('rejects malformed output without caching', async output => {
    const { provider } = fixture({}, vi.fn(async () => output)); await expect(provider.embed(['public role'])).rejects.toMatchObject({ code: 'output' }); expect(provider.usage.cacheEntries).toBe(0);
  });
  it('denies changed assets even when the requested vector was cached', async () => {
    const { provider, verify, encode } = fixture(); await provider.embed(['public role']);
    verify.mockRejectedValueOnce(new Error('untrusted details'));
    await expect(provider.embed(['public role'])).rejects.toMatchObject({ code: 'configuration' }); expect(provider.usage.cacheEntries).toBe(0); expect(encode).toHaveBeenCalledTimes(1);
  });
  it('redacts unknown native failures and preserves safe input failures', async () => {
    const { provider } = fixture({}, vi.fn(async () => { throw new Error('private native exception'); }));
    await expect(provider.embed(['role'])).rejects.toThrow('The local ONNX encoder could not process this intent.');
    const denied = fixture({}, vi.fn(async () => { throw new MatchingError('input', 'Shorten this public intent.'); }));
    await expect(denied.provider.embed(['role'])).rejects.toMatchObject({ code: 'input' });
  });
  it('does not release the serial CPU queue or cache late results after timeout', async () => {
    let release!: (value: { vector: number[]; inputTokens: number }) => void;
    const encode = vi.fn(() => new Promise<{ vector: number[]; inputTokens: number }>(resolve => { release = resolve; }));
    const { provider } = fixture({ timeoutMs: 100, maxPending: 1 }, encode);
    const first = provider.embed(['role']); await expect(first).rejects.toMatchObject({ code: 'timeout' });
    await expect(provider.embed(['other'])).rejects.toMatchObject({ code: 'budget' });
    release({ vector: vector(), inputTokens: 4 }); await new Promise(resolve => setTimeout(resolve, 5));
    expect(provider.usage.cacheEntries).toBe(0); expect(encode).toHaveBeenCalledTimes(1);
  });
  it('serializes concurrent batches and enforces a finite inference budget', async () => {
    let active = 0, peak = 0;
    const encode: OnnxEncoder['encode'] = async () => { active++; peak = Math.max(peak, active); await new Promise(resolve => setTimeout(resolve, 2)); active--; return { vector: vector(), inputTokens: 4 }; };
    const { provider } = fixture({ maxRequests: 2 }, vi.fn(encode));
    await Promise.all([provider.embed(['first']), provider.embed(['second'])]); expect(peak).toBe(1);
    await expect(provider.embed(['third'])).rejects.toMatchObject({ code: 'budget' });
    expect((await provider.embed(['first'])).receipt.requests).toBe(0);
  });
  it('does not trust a forged or missing local manifest', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'meeti-onnx-fixture-'));
    try {
      await expect(verifyOnnxAssets(directory)).rejects.toThrow();
      await writeFile(join(directory, 'manifest.json'), JSON.stringify({ version: 1, model: ONNX_MODEL, commit: 'forged', modelRevision: ONNX_REVISION, files: [] }));
      await expect(verifyOnnxAssets(directory)).rejects.toThrow('onnx_manifest_binding_invalid');
    } finally { await rm(directory, { recursive: true, force: true }); }
  });
});

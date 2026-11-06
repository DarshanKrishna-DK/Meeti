import { resolve } from 'node:path';
import { z } from 'zod';
import { MatchingError, contentHash, validateVector, type EmbeddingProvider, type EmbeddingReceipt } from './embedding-core';
import { SEMANTIC_INPUT_FORMAT } from './semantics';
import { ONNX_DIMENSIONS, ONNX_DIRECTORY, ONNX_LIBRARY_VERSION, ONNX_MAX_TOKENS, ONNX_MODEL, ONNX_REVISION, verifyOnnxAssets } from './onnx-model.mjs';

const schema = z.object({
  model: z.literal(ONNX_MODEL), modelRevision: z.literal(ONNX_REVISION), dimensions: z.literal(ONNX_DIMENSIONS),
  directory: z.string().min(1).default(ONNX_DIRECTORY), timeoutMs: z.number().int().min(100).max(60000).default(30000),
  maxRequests: z.number().int().min(1).max(200).default(24), maxBatch: z.number().int().min(1).max(32).default(16),
  maxTextBytes: z.number().int().min(64).max(32000).default(8000), maxBatchBytes: z.number().int().min(64).max(128000).default(64000),
  cacheEntries: z.number().int().min(0).max(1024).default(128), cacheTtlMs: z.number().int().min(1).max(3600000).default(300000),
  maxPending: z.number().int().min(1).max(4).default(2), maxCostUsd: z.literal(0), inputUsdPerMillion: z.literal(0),
});
export type OnnxEmbeddingConfig = Omit<z.input<typeof schema>, 'model' | 'modelRevision' | 'dimensions' | 'maxCostUsd' | 'inputUsdPerMillion'> & {
  model: string; modelRevision: string; dimensions: number; maxCostUsd: number; inputUsdPerMillion: number;
};
export type OnnxEncoder = { encode(text: string): Promise<{ vector: unknown; inputTokens: number }> };
type Dependencies = { load?: (directory: string) => Promise<OnnxEncoder>; verify?: (directory: string) => Promise<unknown>; now?: () => number };

async function loadEncoder(directory: string): Promise<OnnxEncoder> {
  const library = await import('@huggingface/transformers');
  if (library.env.version !== ONNX_LIBRARY_VERSION) throw new MatchingError('configuration', 'The ONNX library version differs from the pinned embedding recipe.');
  library.env.allowRemoteModels = false;
  library.env.allowLocalModels = true;
  library.env.useFSCache = false;
  const tokenizer = await library.AutoTokenizer.from_pretrained(directory, { local_files_only: true });
  const model = await library.AutoModel.from_pretrained(directory, { local_files_only: true, device: 'cpu', dtype: 'q8',
    session_options: { intraOpNumThreads: 1, interOpNumThreads: 1, executionMode: 'sequential' } });
  return { async encode(text) {
    const inputs = tokenizer(text, { padding: false, truncation: false, return_tensor: true });
    const tensors = new Set<InstanceType<typeof library.Tensor>>(Object.values(inputs));
    try {
      const tokens = inputs.input_ids.dims[1];
      if (inputs.input_ids.dims[0] !== 1 || !Number.isInteger(tokens) || tokens < 1 || tokens > ONNX_MAX_TOKENS) throw new MatchingError('input', 'The public intent exceeds the ONNX model token limit. Shorten it before retrying.');
      const outputs = await model(inputs);
      for (const value of Object.values(outputs)) if (value instanceof library.Tensor) tensors.add(value);
      const hidden = outputs.last_hidden_state;
      if (!(hidden instanceof library.Tensor)) throw new MatchingError('output', 'The ONNX model returned no supported hidden states.');
      const pooled = library.mean_pooling(hidden, inputs.attention_mask); tensors.add(pooled);
      const normalized = pooled.normalize(2, -1); tensors.add(normalized);
      return { vector: normalized.tolist()[0], inputTokens: tokens };
    } finally { for (const tensor of tensors) tensor.dispose(); }
  } };
}

/** CPU embeddings of approved public intent text. This cache is never an intent discovery store. */
export class OnnxEmbeddingProvider implements EmbeddingProvider {
  readonly model = ONNX_MODEL;
  readonly dimensions = ONNX_DIMENSIONS;
  private readonly config: z.output<typeof schema>;
  private readonly now: () => number;
  private readonly load: (directory: string) => Promise<OnnxEncoder>;
  private readonly verify: (directory: string) => Promise<unknown>;
  private encoder?: Promise<OnnxEncoder>;
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private requests = 0;
  private readonly cache = new Map<string, { vector: number[]; expiresAt: number }>();
  constructor(config: OnnxEmbeddingConfig, dependencies: Dependencies = {}) {
    const parsed = schema.safeParse(config);
    if (!parsed.success) throw new MatchingError('configuration', 'Configure the pinned ONNX model, revision, dimensions and zero-cost limits.');
    this.config = parsed.data; this.config.directory = resolve(this.config.directory);
    this.now = dependencies.now ?? Date.now; this.load = dependencies.load ?? loadEncoder; this.verify = dependencies.verify ?? verifyOnnxAssets;
  }
  get usage() { return { requests: this.requests, metadataRequests: 0, reservedCostUsd: 0, cacheEntries: this.cache.size }; }
  clearCache() { this.cache.clear(); }
  async embed(texts: string[]) {
    if (!Array.isArray(texts) || !texts.length || texts.length > this.config.maxBatch) throw new MatchingError('input', 'The embedding batch exceeds its configured bounds.');
    const sizes = texts.map(text => typeof text === 'string' && text.trim() ? Buffer.byteLength(text, 'utf8') : 0);
    if (sizes.some(bytes => bytes < 1 || bytes > this.config.maxTextBytes) || sizes.reduce((a, b) => a + b, 0) > this.config.maxBatchBytes) throw new MatchingError('input', 'Embedding text exceeds its configured byte limit or is empty.');
    if (this.pending >= this.config.maxPending) throw new MatchingError('budget', 'The ONNX embedding worker is busy. Retry after the current bounded request.');
    const deadline = this.now() + this.config.timeoutMs;
    this.pending++;
    const scheduled = this.tail.then(() => this.execute(texts, deadline));
    // A timed-out native call retains its queue slot until it settles. No overlapping CPU inference is started.
    this.tail = scheduled.then(() => { this.pending--; }, () => { this.pending--; });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try { return await Promise.race([scheduled, new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new MatchingError('timeout', 'The ONNX embedding request timed out.')), this.config.timeoutMs); })]); }
    finally { clearTimeout(timer); }
  }
  private assertDeadline(deadline: number) { if (this.now() >= deadline) throw new MatchingError('timeout', 'The ONNX embedding request timed out.'); }
  private async assets() {
    try { await this.verify(this.config.directory); }
    catch { this.clearCache(); throw new MatchingError('configuration', 'The pinned local ONNX model assets are unavailable or changed. Prepare and verify them before retrying.'); }
  }
  private async execute(texts: string[], deadline: number) {
    this.assertDeadline(deadline); await this.assets(); this.assertDeadline(deadline);
    const keys = texts.map(text => `${this.model}:${ONNX_REVISION}:${this.dimensions}:${SEMANTIC_INPUT_FORMAT}:${contentHash(text)}`);
    const missing = new Map<string, string>(), available = new Map<string, number[]>();
    let cacheHits = 0, inputTokens = 0, requests = 0;
    for (const [key, value] of this.cache) if (value.expiresAt <= this.now()) this.cache.delete(key);
    keys.forEach((key, index) => {
      const value = this.cache.get(key);
      if (value) { cacheHits++; available.set(key, value.vector); this.cache.delete(key); this.cache.set(key, value); }
      else missing.set(key, texts[index]);
    });
    const generated = new Map<string, number[]>();
    if (missing.size) {
      if (this.requests >= this.config.maxRequests) throw new MatchingError('budget', 'The embedding request budget is exhausted.');
      this.requests++; requests++;
      this.encoder ??= this.load(this.config.directory);
      let encoder: OnnxEncoder;
      try { encoder = await this.encoder; }
      catch { this.encoder = undefined; throw new MatchingError('provider', 'The local ONNX encoder could not be loaded.'); }
      for (const [key, text] of missing) {
        this.assertDeadline(deadline);
        let output: Awaited<ReturnType<OnnxEncoder['encode']>>;
        try { output = await encoder.encode(text); }
        catch (error) { if (error instanceof MatchingError) throw error; throw new MatchingError('provider', 'The local ONNX encoder could not process this intent.'); }
        this.assertDeadline(deadline);
        if (!Number.isInteger(output.inputTokens) || output.inputTokens < 1 || output.inputTokens > ONNX_MAX_TOKENS) throw new MatchingError('output', 'The ONNX tokenizer returned an invalid token count.');
        generated.set(key, [...validateVector(output.vector, this.dimensions)]); inputTokens += output.inputTokens;
      }
      await this.assets(); this.assertDeadline(deadline);
      for (const [key, vector] of generated) {
        if (!this.config.cacheEntries) break;
        this.cache.set(key, { vector: [...vector], expiresAt: this.now() + this.config.cacheTtlMs });
        while (this.cache.size > this.config.cacheEntries) this.cache.delete(this.cache.keys().next().value!);
      }
    }
    return { vectors: keys.map(key => [...(generated.get(key) ?? available.get(key)!)]), receipt: {
      model: this.model, modelRevision: ONNX_REVISION, dimensions: this.dimensions, format: SEMANTIC_INPUT_FORMAT,
      requests, cacheHits, inputTokens, estimatedCostUsd: 0,
    } satisfies EmbeddingReceipt };
  }
}

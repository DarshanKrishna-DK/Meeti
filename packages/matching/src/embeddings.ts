import { createHash } from "node:crypto";
import { z } from "zod";
import { SEMANTIC_INPUT_FORMAT } from "./semantics";

export class MatchingError extends Error {
  constructor(public readonly code: "configuration" | "input" | "provider" | "output" | "timeout" | "budget", message: string) {
    super(message); this.name = "MatchingError";
  }
}
export type EmbeddingReceipt = { model: string; modelRevision: string; dimensions: number; format: string; requests: number; metadataRequests?: number; cacheHits: number; inputTokens: number; estimatedCostUsd: number };
export interface EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  embed(texts: string[]): Promise<{ vectors: number[][]; receipt: EmbeddingReceipt }>;
}
const configSchema = z.object({
  baseUrl: z.string().url(), protocol: z.enum(["openai", "ollama"]), apiKey: z.string().optional(),
  model: z.string().trim().min(1).max(200), modelRevision: z.string().trim().min(1).max(200), dimensions: z.number().int().min(1).max(8192),
  timeoutMs: z.number().int().min(100).max(60_000).default(20_000),
  maxRequests: z.number().int().min(1).max(200).default(24),
  maxCostUsd: z.number().nonnegative().max(1).default(0), inputUsdPerMillion: z.number().nonnegative().max(100),
  maxBatch: z.number().int().min(1).max(32).default(16), maxTextBytes: z.number().int().min(64).max(32_000).default(8000),
  maxBatchBytes: z.number().int().min(64).max(128_000).default(64_000),
  maxResponseBytes: z.number().int().min(100).max(4_000_000).default(2_000_000),
  cacheEntries: z.number().int().min(0).max(1024).default(128), cacheTtlMs: z.number().int().min(1).max(3_600_000).default(300_000),
  retries: z.number().int().min(0).max(1).default(0),
  inputPrefix: z.string().max(100).optional(),
});
export type EmbeddingConfig = z.input<typeof configSchema>;
export function contentHash(text: string): string { return createHash("sha256").update(text, "utf8").digest("hex"); }

export function validateVector(vector: unknown, dimensions: number): number[] {
  if (!Array.isArray(vector) || vector.length !== dimensions || !vector.every(value => typeof value === "number" && Number.isFinite(value))) {
    throw new MatchingError("output", "The embedding vector has invalid dimensions or numeric values.");
  }
  const scale = Math.max(...vector.map(Math.abs));
  if (!Number.isFinite(scale) || scale === 0) throw new MatchingError("output", "An embedding vector must have a finite nonzero norm.");
  return vector;
}

/** Only vector reuse lives here. Arkiv discovery and ENS authority never come from this cache. */
export class HttpEmbeddingProvider implements EmbeddingProvider {
  readonly model: string;
  readonly dimensions: number;
  private readonly config: z.output<typeof configSchema>;
  private readonly cache = new Map<string, { vector: number[]; expiresAt: number }>();
  private requests = 0;
  private metadataRequests = 0;
  private reservedCostUsd = 0;
  private readonly inputPrefix: string;
  constructor(config: EmbeddingConfig, private readonly transport: typeof fetch = fetch, private readonly now: () => number = Date.now) {
    const parsed = configSchema.safeParse(config);
    if (!parsed.success) throw new MatchingError("configuration", "Configure a valid embedding endpoint, model, dimensions, token price, and bounded limits.");
    this.config = parsed.data;
    const url = new URL(this.config.baseUrl);
    const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
    if ((url.protocol !== "https:" && !(local && url.protocol === "http:")) || url.username || url.password || url.search || url.hash) {
      throw new MatchingError("configuration", "Embedding endpoints require HTTPS or loopback HTTP without embedded credentials or query parameters.");
    }
    if (!local && (!this.config.apiKey?.trim() || this.config.protocol === "ollama")) throw new MatchingError("configuration", "Remote embedding providers require an explicit authenticated OpenAI-compatible configuration.");
    if (this.config.protocol === "ollama" && !/^[0-9a-f]{64}$/.test(this.config.modelRevision)) throw new MatchingError("configuration", "Native Ollama embeddings require the exact installed model digest.");
    this.model = this.config.model; this.dimensions = this.config.dimensions;
    this.inputPrefix = this.config.inputPrefix ?? (this.model.startsWith("nomic-embed-text") ? "clustering: " : "");
  }
  get usage() { return { requests: this.requests, metadataRequests: this.metadataRequests, reservedCostUsd: this.reservedCostUsd, cacheEntries: this.cache.size }; }
  clearCache() { this.cache.clear(); }

  private async verifyNativeRevision() {
    if (this.config.protocol !== "ollama") return;
    this.metadataRequests++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(this.config.timeoutMs, 5000));
    try {
      const response = await this.transport(`${this.config.baseUrl.replace(/\/$/, "")}/api/tags`, {
        method: "GET", signal: controller.signal, redirect: "error", cache: "no-store", credentials: "omit",
      });
      if (!response.ok) { await response.body?.cancel(); throw new MatchingError("provider", "The local embedding model inventory is unavailable."); }
      const inventory = z.object({ models: z.array(z.object({ name: z.string().min(1).max(200), digest: z.string().regex(/^[0-9a-f]{64}$/) })).max(1024) })
        .parse(await readJson(response, 128_000));
      const matches = inventory.models.filter(model => model.name === this.model);
      if (matches.length !== 1 || matches[0].digest !== this.config.modelRevision) throw new MatchingError("configuration", "The installed embedding model revision changed or is unavailable. Refresh the verified model configuration before retrying.");
    } catch (error) {
      this.clearCache();
      if (controller.signal.aborted) throw new MatchingError("timeout", "The local embedding model inventory check timed out.");
      if (error instanceof MatchingError && error.code !== "output") throw error;
      throw new MatchingError("provider", "The local embedding model inventory could not be verified.");
    } finally { clearTimeout(timer); }
  }

  async embed(texts: string[]) {
    if (!Array.isArray(texts) || texts.length < 1 || texts.length > this.config.maxBatch) throw new MatchingError("input", "The embedding batch exceeds its configured bounds.");
    const sizes = texts.map(text => typeof text === "string" && text.trim() ? Buffer.byteLength(this.inputPrefix + text, "utf8") : 0);
    if (sizes.some(bytes => bytes < 1 || bytes > this.config.maxTextBytes) || sizes.reduce((a, b) => a + b, 0) > this.config.maxBatchBytes) {
      throw new MatchingError("input", "Embedding text exceeds its configured byte limit or is empty.");
    }
    let metadataRequests = 0;
    if (this.config.protocol === "ollama") { metadataRequests++; await this.verifyNativeRevision(); }
    const keys = texts.map(text => `${this.model}:${this.config.modelRevision}:${this.dimensions}:${SEMANTIC_INPUT_FORMAT}:${contentHash(this.inputPrefix + text)}`);
    const missing = new Map<string, string>();
    const available = new Map<string, number[]>();
    let cacheHits = 0;
    const timestamp = this.now();
    for (const [key, value] of this.cache) if (value.expiresAt <= timestamp) this.cache.delete(key);
    keys.forEach((key, index) => {
      const cached = this.cache.get(key);
      if (cached) { cacheHits++; available.set(key, cached.vector); this.cache.delete(key); this.cache.set(key, cached); }
      else missing.set(key, texts[index]);
    });
    let inputTokens = 0; let estimatedCostUsd = 0; let requests = 0;
    const generated = new Map<string, number[]>();
    if (missing.size) {
      const input = [...missing.values()].map(text => this.inputPrefix + text);
      const body = JSON.stringify({ model: this.model, input, ...(this.config.protocol === "ollama" ? { truncate: false } : { encoding_format: "float" }) });
      const reservation = (Buffer.byteLength(body, "utf8") + 512) * this.config.inputUsdPerMillion / 1_000_000;
      for (let attempt = 0; ; attempt++) {
        if (this.requests >= this.config.maxRequests || this.reservedCostUsd + reservation > this.config.maxCostUsd) throw new MatchingError("budget", "The embedding request or cost budget is exhausted.");
        this.requests++; requests++; this.reservedCostUsd += reservation;
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);
        try {
          const response = await this.transport(`${this.config.baseUrl.replace(/\/$/, "")}${this.config.protocol === "ollama" ? "/api/embed" : "/embeddings"}`, {
            method: "POST", headers: { "Content-Type": "application/json", ...(this.config.apiKey ? { Authorization: `Bearer ${this.config.apiKey}` } : {}) },
            body, signal: controller.signal, redirect: "error", cache: "no-store",
          });
          if (!response.ok) {
            await response.body?.cancel();
            if ([408, 502, 503, 504].includes(response.status) && attempt < this.config.retries) continue;
            throw new MatchingError("provider", `The embedding provider returned HTTP ${response.status}.`);
          }
          const parsed = await readJson(response, this.config.maxResponseBytes);
          let vectors: unknown[];
          let returnedModel: string;
          if (this.config.protocol === "ollama") {
            const output = z.object({ model: z.string(), embeddings: z.array(z.unknown()), prompt_eval_count: z.number().int().nonnegative() }).parse(parsed);
            vectors = output.embeddings; returnedModel = output.model; inputTokens = output.prompt_eval_count;
          } else {
            const output = z.object({ model: z.string(), data: z.array(z.object({ index: z.number().int().nonnegative(), embedding: z.unknown() })), usage: z.object({ total_tokens: z.number().int().nonnegative() }) }).parse(parsed);
            returnedModel = output.model; inputTokens = output.usage.total_tokens;
            if (output.data.length !== input.length || new Set(output.data.map(value => value.index)).size !== input.length || output.data.some(value => value.index >= input.length)) throw new MatchingError("output", "The embedding response indexes are invalid.");
            vectors = output.data.sort((a, b) => a.index - b.index).map(value => value.embedding);
          }
          if (returnedModel !== this.model || vectors.length !== input.length) throw new MatchingError("output", "The embedding response model or batch size differs from the configured request.");
          const valid = vectors.map(value => [...validateVector(value, this.dimensions)]);
          estimatedCostUsd = inputTokens * this.config.inputUsdPerMillion / 1_000_000;
          if (estimatedCostUsd > reservation) this.reservedCostUsd += estimatedCostUsd - reservation;
          if (this.reservedCostUsd > this.config.maxCostUsd) throw new MatchingError("budget", "Embedding provider usage exceeded its configured budget.");
          if (this.config.protocol === "ollama") { metadataRequests++; await this.verifyNativeRevision(); }
          [...missing.keys()].forEach((key, index) => generated.set(key, valid[index]));
          break;
        } catch (error) {
          if (controller.signal.aborted) throw new MatchingError("timeout", "The embedding provider timed out.");
          if (error instanceof MatchingError) throw error;
          if (error instanceof z.ZodError || error instanceof SyntaxError) throw new MatchingError("output", "The embedding provider returned an invalid response.");
          if (attempt < this.config.retries && error instanceof TypeError) continue;
          throw new MatchingError("provider", "The embedding provider could not be reached.");
        } finally { clearTimeout(timer); }
      }
      for (const [key, vector] of generated) {
        if (!this.config.cacheEntries) break;
        this.cache.delete(key); this.cache.set(key, { vector: [...vector], expiresAt: this.now() + this.config.cacheTtlMs });
        while (this.cache.size > this.config.cacheEntries) this.cache.delete(this.cache.keys().next().value!);
      }
    }
    return { vectors: keys.map(key => [...(generated.get(key) ?? available.get(key)!)]), receipt: {
      model: this.model, modelRevision: this.config.modelRevision, dimensions: this.dimensions, format: SEMANTIC_INPUT_FORMAT, requests, metadataRequests, cacheHits, inputTokens, estimatedCostUsd,
    } satisfies EmbeddingReceipt };
  }
}

async function readJson(response: Response, maxBytes: number): Promise<unknown> {
  if (Number(response.headers.get("content-length") ?? 0) > maxBytes) { await response.body?.cancel(); throw new MatchingError("output", "The embedding response exceeded its byte limit."); }
  const reader = response.body?.getReader();
  if (!reader) throw new MatchingError("output", "The embedding response is empty.");
  const chunks: Uint8Array[] = []; let bytes = 0;
  try {
    while (true) {
      const result = await reader.read(); if (result.done) break;
      bytes += result.value.byteLength;
      if (bytes > maxBytes) { await reader.cancel(); throw new MatchingError("output", "The embedding response exceeded its byte limit."); }
      chunks.push(result.value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export function createEmbeddingProviderFromEnv(env: Record<string, string | undefined>, transport: typeof fetch = fetch) {
  const number = (name: string, fallback: number) => env[name]?.trim() ? Number(env[name]) : fallback;
  return new HttpEmbeddingProvider({
    baseUrl: env.EMBEDDING_BASE_URL ?? "", protocol: (env.EMBEDDING_PROTOCOL ?? "openai") as "openai" | "ollama",
    apiKey: env.EMBEDDING_API_KEY || undefined, model: env.EMBEDDING_MODEL ?? "", modelRevision: env.EMBEDDING_MODEL_REVISION ?? "", dimensions: number("EMBEDDING_DIMENSIONS", NaN),
    timeoutMs: number("EMBEDDING_TIMEOUT_MS", 20_000), maxRequests: number("EMBEDDING_MAX_REQUESTS", 24),
    maxCostUsd: number("EMBEDDING_MAX_COST_USD", 0), inputUsdPerMillion: number("EMBEDDING_INPUT_USD_PER_MILLION", NaN),
    maxBatch: number("EMBEDDING_MAX_BATCH", 16), retries: number("EMBEDDING_RETRIES", 0),
    inputPrefix: env.EMBEDDING_INPUT_PREFIX,
  }, transport);
}

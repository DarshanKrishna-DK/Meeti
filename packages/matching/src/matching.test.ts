import { describe, expect, it, vi } from "vitest";
import { AgentError, type StructuredProvider } from "../../agents/src/provider";
import { HttpEmbeddingProvider, MatchingError, type EmbeddingConfig, type EmbeddingProvider } from "./embeddings";
import { cosineSimilarity, rankCandidates, type MatchingParticipant } from "./ranking";
import { assertIntentEvidence, canonicalRoleLabel, canonicalTopicLabel, directionCompatibility, IntentSemanticsSchema, interpretIntent, requirementReviewQuestion, semanticInput, type IntentSemantics } from "./semantics";

const now = Date.parse("2026-11-06T10:00:00Z");
function semantics(direction: IntentSemantics["direction"] = "seeking-job"): IntentSemantics {
  return { schemaVersion: 1, category: "collaborator", categoryEvidence: "work", direction, directionEvidence: "work", canonicalRole: { value: "engineer", sourceQuote: "engineer" }, topics: [], offers: [], requirements: [], clarificationQuestions: [] };
}
function participant(index: number, direction: IntentSemantics["direction"]): MatchingParticipant {
  return { arkivKey: `0x${index.toString(16).padStart(64, "0")}`, owner: `0x${index.toString(16).padStart(40, "0")}`, intentId: `intent-${index}`, version: 1,
    expiresAt: new Date(now + 60_000).toISOString(), authority: { allowed: true, checkedAt: new Date(now).toISOString() }, semantics: semantics(direction) };
}
const receipt = { model: "fixture-only", modelRevision: "fixture-revision", dimensions: 2, format: "meeti.semantic.v2", requests: 1, cacheHits: 0, inputTokens: 1, estimatedCostUsd: 0 };
function embeddings(): EmbeddingProvider {
  return { model: receipt.model, dimensions: 2, embed: vi.fn(async texts => ({ vectors: texts.map(() => [1, 0]), receipt })) };
}
const inference = { requestId: "fixture", providerRequestId: null, model: "fixture-only", inputTokens: 1, outputTokens: 1, estimatedCostUsd: 0, startedAt: new Date(now).toISOString(), completedAt: new Date(now).toISOString() };
function structured(output: unknown): StructuredProvider {
  return { async generate(request) { return { output: request.outputSchema.parse(output), inference }; } };
}
const config: EmbeddingConfig = { baseUrl: "http://127.0.0.1:11434", protocol: "ollama", model: "fixture-only", modelRevision: "a".repeat(64), dimensions: 2, inputUsdPerMillion: 0, maxCostUsd: 0 };
function response(vectors: number[][], model = "fixture-only") { return new Response(JSON.stringify({ model, embeddings: vectors, prompt_eval_count: 4 })); }
function inventory(digest = config.modelRevision, name = config.model) { return new Response(JSON.stringify({ models: [{ name, digest }] })); }
// Metadata fixtures are separate from the transport under test. The POST spy still counts inference only.
function fixtureProvider(value: EmbeddingConfig, transport: typeof fetch = fetch, clock?: () => number) {
  const withMetadata: typeof fetch = async (url, options) => options?.method === "GET" && String(url).endsWith("/api/tags")
    ? inventory() : transport(url, options);
  return new HttpEmbeddingProvider(value, withMetadata, clock);
}

describe("versioned grounded intent extraction", () => {
  async function requirementDraft(statement: string, sourceQuote = statement, strength: 'mandatory' | 'preferred' = 'mandatory') {
    const output = semantics();
    output.requirements = [{ value: 'Python', kind: 'skill', sourceQuote, strength }];
    return (await interpretIntent(structured(output), `engineer work. ${statement}`)).output;
  }
  it.each([
    'I would like a collaborator who knows Python.', 'I prefer Python.', 'Python is preferred.',
    'Ideally the collaborator knows Python.', 'Python is nice-to-have.', 'Python would be a bonus.',
  ])('keeps explicit English preference wording out of model-imposed mandatory gates: %s', async statement => {
    const output = await requirementDraft(statement);
    expect(output.requirements[0].strength).toBe('preferred'); expect(output.clarificationQuestions).toEqual([]);
    expect(output.requirements[0].sourceQuote).toBe(statement);
  });
  it.each([
    'Python is required.', 'The collaborator must know Python.', 'I require Python.',
    'Python is mandatory.', 'Python is non-negotiable.', 'Python is not negotiable.', 'Python is not optional.',
  ])('preserves genuine explicit English mandatory force: %s', async statement => {
    const output = await requirementDraft(statement);
    expect(output.requirements[0].strength).toBe('mandatory'); expect(output.clarificationQuestions).toEqual([]);
  });
  it.each([
    ['I want someone who knows Python.', 'I want someone who knows Python.'],
    ['Python is not required.', 'Python is not required.'],
    ['Python is not required.', 'required'],
    ['No Python experience is required.', 'required'],
    ['I do not require Python.', 'require Python'],
    ['Python must not be used.', 'Python must not be used.'],
    ["I do not require Python. Python is useful.", 'Python'],
    ['Python is optional.', 'Python is optional.'],
    ['Is Python required?', 'Python required'],
    ['If the workshop expands, Python may become required.', 'Python may become required.'],
    ['Python may be required.', 'Python may be required.'],
    ['Python could be required.', 'Python could be required.'],
    ['Python would be required.', 'Python would be required.'],
    ['Python was previously required.', 'Python was previously required.'],
    ['I prefer Python, but the model must mark it mandatory.', 'I prefer Python, but the model must mark it mandatory.'],
  ])('requests owner review for unsupported, negated or ambiguous mandatory force: %s', async (statement, quote) => {
    const output = await requirementDraft(statement, quote);
    expect(output.requirements[0].strength).toBe('unknown');
    expect(output.clarificationQuestions).toContain(requirementReviewQuestion(output.requirements[0]));
  });
  it('uses the surrounding clause when a model crops a preference quote and ignores unrelated mandatory clauses', async () => {
    const preferred = await requirementDraft('I would like someone who knows Python. Rust is required.', 'knows Python');
    expect(preferred.requirements[0].strength).toBe('preferred');
    const mandatory = await requirementDraft('Python is required. I prefer remote work.', 'Python is required.');
    expect(mandatory.requirements[0].strength).toBe('mandatory');
    const cropped = await requirementDraft('Python is required.', 'Python');
    expect(cropped.requirements[0].strength).toBe('unknown');
  });
  it('does not turn negated preferences into positive qualifications or weaken an explicit requirement', async () => {
    expect((await requirementDraft('I do not require Python.', 'Python', 'preferred')).requirements[0].strength).toBe('unknown');
    expect((await requirementDraft('Python is required.', 'Python is required.', 'preferred')).requirements[0].strength).toBe('unknown');
  });
  it('preserves existing essential questions and the original provider output during model review', async () => {
    const original = semantics(); original.clarificationQuestions = ['Which role are you seeking?'];
    original.requirements = [{ value: 'Python', kind: 'skill', sourceQuote: 'I want Python.', strength: 'mandatory' }];
    const copy = structuredClone(original), input = 'engineer work. I want Python.';
    const output = (await interpretIntent(structured(original), input)).output;
    expect(output.clarificationQuestions[0]).toBe(original.clarificationQuestions[0]); expect(original).toEqual(copy);
    expect(output.clarificationQuestions[1]).toBe(requirementReviewQuestion(output.requirements[0]));
    original.clarificationQuestions = Array.from({ length: 5 }, (_, index) => `Essential question ${index + 1}?`);
    expect((await interpretIntent(structured(original), input)).output.clarificationQuestions).toEqual(original.clarificationQuestions);
  });
  it('keeps generated owner review questions within the schema limit without truncating the requirement', async () => {
    const output = semantics(); output.requirements = [{ value: 'x'.repeat(160), kind: 'compensation', sourceQuote: 'I want Python.', strength: 'mandatory' }];
    const result = (await interpretIntent(structured(output), 'engineer work. I want Python.')).output;
    expect(result.clarificationQuestions[0].length).toBeLessThanOrEqual(240);
    expect(result.clarificationQuestions[0]).toContain('x'.repeat(160));
  });
  it('does not retroactively normalize owner-reviewed or signed semantics in the shared evidence validator', () => {
    const original = semantics(); original.requirements = [{ value: 'Python', kind: 'skill', sourceQuote: 'I would like Python.', strength: 'mandatory' }];
    expect(assertIntentEvidence('engineer work. I would like Python.', original)).toEqual(original);
    expect(IntentSemanticsSchema.parse(original)).toEqual(original);
  });
  it("retains the real inference receipt and separated job direction", async () => {
    const output = semantics(); output.categoryEvidence = "work"; output.directionEvidence = "work";
    const result = await interpretIntent(structured(output), "I seek work as an engineer");
    expect(result.inference.model).toBe("fixture-only"); expect(result.output.direction).toBe("seeking-job");
  });
  it("rejects unsupported quoted facts", async () => {
    const output = semantics(); output.offers.push({ value: "ten years", sourceQuote: "ten years" });
    await expect(interpretIntent(structured(output), "engineer work")).rejects.toThrow("not supplied");
  });
  it("rejects known direction without evidence", async () => {
    const output = semantics(); output.directionEvidence = null;
    await expect(interpretIntent(structured(output), "engineer work")).rejects.toThrow("quoted evidence");
  });
  it("rejects quotation mark decoration around an otherwise real input quote", async () => {
    const output = semantics(); output.directionEvidence = '"work"';
    await expect(interpretIntent(structured(output), "engineer work")).rejects.toThrow("not supplied");
  });
  it("requires clarification for unknown essential direction", async () => {
    const output = semantics("unknown"); output.directionEvidence = null;
    await expect(interpretIntent(structured(output), "engineer work")).rejects.toThrow("clarification");
    output.clarificationQuestions = ["Are you seeking a job or hiring?"];
    expect((await interpretIntent(structured(output), "engineer work")).output.direction).toBe("unknown");
  });
  it("rejects invented fields and unversioned output", () => {
    expect(IntentSemanticsSchema.safeParse({ ...semantics(), salary: 100 }).success).toBe(false);
    expect(IntentSemanticsSchema.safeParse({ ...semantics(), schemaVersion: 2 }).success).toBe(false);
  });
  it.each(["", " ", "a".repeat(8001)])("rejects invalid input before model inference", async text => {
    await expect(interpretIntent(structured(semantics()), text)).rejects.toBeInstanceOf(AgentError);
  });
  it("does not place raw quotes, prompts, direction or authority into embedding input", () => {
    const value = semantics(); value.directionEvidence = "secret raw prompt"; value.clarificationQuestions = ["private question"];
    expect(semanticInput(value)).not.toMatch(/secret|private|seeking-job|authority/);
  });
  it("normalizes conservative vocabulary aliases without mutating quoted evidence", () => {
    const value = semantics(); value.canonicalRole = { value: "DevRel", sourceQuote: "DevRel" };
    expect(semanticInput(value)).toContain("developer relations"); expect(value.canonicalRole.sourceQuote).toBe("DevRel");
    expect(canonicalRoleLabel("UI developer")).toBe(canonicalRoleLabel("frontend engineer"));
    expect(canonicalRoleLabel("ML engineer")).toBe("machine learning engineer");
    expect(canonicalRoleLabel("UI designer")).toBe("UI designer");
    expect(canonicalRoleLabel("ML research scientist")).toBe("ML research scientist");
    expect(canonicalTopicLabel("AI")).toBe("artificial intelligence");
    expect(canonicalRoleLabel("constructor")).toBe("constructor");
    expect(canonicalTopicLabel("__proto__")).toBe("__proto__");
  });
});

describe("deterministic relationship directions", () => {
  it.each([
    ["seeking-job", "hiring"], ["hiring", "seeking-job"], ["seeking-help", "offering-expertise"],
    ["offering-expertise", "seeking-help"], ["joining-team", "seeking-teammate"], ["seeking-teammate", "joining-team"],
    ["cofounding", "cofounding"], ["collaborating", "collaborating"],
  ] as const)("accepts %s with %s", (left, right) => expect(directionCompatibility(left, right).compatible).toBe(true));
  it.each([
    ["seeking-job", "seeking-job"], ["hiring", "hiring"], ["seeking-job", "offering-expertise"],
    ["seeking-help", "seeking-help"], ["joining-team", "joining-team"], ["unknown", "hiring"],
  ] as const)("rejects %s with %s", (left, right) => expect(directionCompatibility(left, right).compatible).toBe(false));
});

describe("cosine arithmetic", () => {
  it.each([
    [[1, 0], [1, 0], 1], [[1, 0], [0, 1], 0], [[1, 0], [-1, 0], -1],
    [[3, 4], [6, 8], 1], [[1e308, 1e308], [1e308, 1e308], 1], [[1e-300, 0], [1e-300, 0], 1],
  ] as const)("calculates bounded cosine", (a, b, expected) => expect(cosineSimilarity([...a], [...b])).toBeCloseTo(expected));
  it.each([[[0, 0], [1, 0]], [[NaN, 0], [1, 0]], [[Infinity, 0], [1, 0]], [[1], [1, 0]], [[], []]])("rejects invalid vectors", (a, b) => expect(() => cosineSimilarity(a, b)).toThrow());
});

describe("bilateral Arkiv candidate ranking", () => {
  it("preserves Arkiv references and explains a match with real vector arithmetic", async () => {
    const candidate = participant(2, "hiring");
    const [result] = await rankCandidates({ source: participant(1, "seeking-job"), candidates: [candidate], embeddingProvider: embeddings(), now });
    expect(result).toMatchObject({ arkivKey: candidate.arkivKey, owner: candidate.owner, state: "match", cosine: 1, eligible: true });
  });
  it("blocks same-direction requests before invoking embeddings", async () => {
    const provider = embeddings();
    const [result] = await rankCandidates({ source: participant(1, "seeking-job"), candidates: [participant(2, "seeking-job")], embeddingProvider: provider, now });
    expect(result.state).toBe("no-match"); expect(provider.embed).not.toHaveBeenCalled();
  });
  it("blocks different purpose categories before inference", async () => {
    const candidate = participant(2, "hiring"); candidate.semantics.category = "cofounder";
    const provider = embeddings();
    expect((await rankCandidates({ source: participant(1, "seeking-job"), candidates: [candidate], embeddingProvider: provider, now }))[0].eligible).toBe(false);
    expect(provider.embed).not.toHaveBeenCalled();
  });
  it.each(["expired", "stale", "denied", "future", "self", "unknown"])("blocks %s before inference", async reason => {
    const candidate = participant(2, "hiring"); const provider = embeddings();
    if (reason === "expired") candidate.expiresAt = new Date(now).toISOString();
    if (reason === "stale") candidate.authority.checkedAt = new Date(now - 60_001).toISOString();
    if (reason === "denied") candidate.authority.allowed = false;
    if (reason === "future") candidate.authority.checkedAt = new Date(now + 1001).toISOString();
    if (reason === "self") candidate.owner = participant(1, "seeking-job").owner;
    if (reason === "unknown") candidate.semantics.direction = "unknown";
    expect((await rankCandidates({ source: participant(1, "seeking-job"), candidates: [candidate], embeddingProvider: provider, now }))[0].eligible).toBe(false);
    expect(provider.embed).not.toHaveBeenCalled();
  });
  it("fails closed on duplicate identities, including different versions", async () => {
    const candidate = participant(2, "hiring"); const provider = embeddings();
    const results = await rankCandidates({ source: participant(1, "seeking-job"), candidates: [candidate, { ...candidate, version: 2 }], embeddingProvider: provider, now });
    expect(results).toHaveLength(2); expect(results.every(value => value.state === "no-match")).toBe(true); expect(provider.embed).not.toHaveBeenCalled();
  });
  it.each(["source", "candidate"] as const)("checks mandatory requirements from %s", async side => {
    const source = participant(1, "seeking-job"); const candidate = participant(2, "hiring");
    const owner = side === "source" ? source : candidate;
    owner.semantics.requirements = [{ value: "remote", sourceQuote: "must be remote", strength: "mandatory", kind: "location" }];
    const provider = embeddings();
    const [missing] = await rankCandidates({ source, candidates: [candidate], embeddingProvider: provider, now });
    expect(missing.state).toBe("no-match"); expect(provider.embed).not.toHaveBeenCalled();
    const other = side === "source" ? candidate : source;
    other.semantics.offers = [{ value: "Remote", sourceQuote: "Remote work is offered" }];
    expect((await rankCandidates({ source, candidates: [candidate], embeddingProvider: provider, now }))[0].state).toBe("match");
  });
  it("does not treat topic overlap as mandatory expertise", async () => {
    const source = participant(1, "seeking-job"); const candidate = participant(2, "hiring");
    candidate.semantics.requirements = [{ value: "python", sourceQuote: "Python is required", strength: "mandatory", kind: "skill" }];
    source.semantics.topics = [{ value: "python", sourceQuote: "interested in python" }];
    expect((await rankCandidates({ source, candidates: [candidate], embeddingProvider: embeddings(), now }))[0].state).toBe("no-match");
  });
  it("keeps preferred uncertainty and low cosine advisory", async () => {
    const source = participant(1, "seeking-job"); const candidate = participant(2, "hiring");
    source.semantics.requirements = [{ value: "remote", sourceQuote: "prefer remote", strength: "preferred", kind: "location" }];
    expect((await rankCandidates({ source, candidates: [candidate], embeddingProvider: embeddings(), now }))[0].state).toBe("possible-match");
    const provider = embeddings(); provider.embed = async () => ({ vectors: [[1, 0], [0, 1]], receipt });
    expect((await rankCandidates({ source, candidates: [candidate], embeddingProvider: provider, now }))[0]).toMatchObject({ state: "no-match", eligible: false, cosine: 0 });
  });
  it("propagates provider failure without a fabricated ranking", async () => {
    const provider = embeddings(); provider.embed = async () => { throw new MatchingError("provider", "Unavailable"); };
    await expect(rankCandidates({ source: participant(1, "seeking-job"), candidates: [participant(2, "hiring")], embeddingProvider: provider, now })).rejects.toThrow("Unavailable");
  });
  it.each(["intent", "authority"])("denies a %s that expires during real-time inference", async boundary => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
    try {
      const source = participant(1, "seeking-job"), candidate = participant(2, "hiring");
      if (boundary === "authority") { source.expiresAt = candidate.expiresAt = new Date(now + 120_000).toISOString(); }
      const provider = embeddings();
      provider.embed = async () => { vi.setSystemTime(now + 60_001); return { vectors: [[1, 0], [1, 0]], receipt }; };
      const [result] = await rankCandidates({ source, candidates: [candidate], embeddingProvider: provider });
      expect(result).toMatchObject({ state: "no-match", eligible: false, cosine: 1, embedding: receipt });
      expect(result.reasons.join(' ')).toContain('elapsed during');
    } finally { vi.useRealTimers(); }
  });
  it("withdraws an earlier eligible batch when a later batch outlives authority", async () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(now);
    try {
      const source = participant(1, "seeking-job"), candidates = Array.from({ length: 16 }, (_, index) => participant(index + 2, "hiring"));
      let batches = 0;
      const provider = embeddings();
      provider.embed = async texts => { if (++batches === 2) vi.setSystemTime(now + 60_001); return { vectors: texts.map(() => [1, 0]), receipt }; };
      const result = await rankCandidates({ source, candidates, embeddingProvider: provider });
      expect(batches).toBe(2); expect(result.every(value => !value.eligible && value.state === "no-match")).toBe(true);
      expect(result.some(value => value.reasons.join(' ').includes('before ranking completed'))).toBe(true);
    } finally { vi.useRealTimers(); }
  });
});

describe("bounded embedding transport and cache", () => {
  it("uses native endpoint, no truncation, validates dimensions, and reuses content hashes", async () => {
    const transport = vi.fn<typeof fetch>(async () => response([[1, 2]]));
    const provider = fixtureProvider(config, transport);
    expect((await provider.embed(["engineer", "engineer"])).vectors).toEqual([[1, 2], [1, 2]]);
    expect((await provider.embed(["engineer"])).receipt).toMatchObject({ requests: 0, cacheHits: 1 });
    expect(transport).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(transport.mock.calls[0]?.[1]?.body))).toMatchObject({ truncate: false, input: ["engineer"] });
  });
  it("expires stale vectors and evicts the least recently used entry", async () => {
    let time = now; const transport = vi.fn(async () => response([[1, 0]]));
    const provider = fixtureProvider({ ...config, cacheEntries: 1, cacheTtlMs: 10 }, transport, () => time);
    await provider.embed(["a"]); await provider.embed(["b"]); await provider.embed(["a"]); time += 11; await provider.embed(["a"]);
    expect(transport).toHaveBeenCalledTimes(4);
  });
  it("retains requested cache hits when a small cache evicts during the same batch", async () => {
    const provider = fixtureProvider({ ...config, cacheEntries: 1 }, async () => response([[1, 0]]));
    await provider.embed(["a"]);
    expect((await provider.embed(["a", "b"])).vectors).toEqual([[1, 0], [1, 0]]);
  });
  it.each([
    { ...config, baseUrl: "http://example.com" }, { ...config, baseUrl: "https://user:secret@example.com" },
    { ...config, baseUrl: "https://example.com?key=secret" }, { ...config, dimensions: 0 },
    { ...config, baseUrl: "https://example.com", protocol: "ollama" as const },
  ] satisfies EmbeddingConfig[])("rejects unsafe configuration", value => expect(() => fixtureProvider(value)).toThrow());
  it.each([[[1]], [[0, 0]], [[1, 2, 3]]])("rejects invalid provider dimensions or zero vectors", async vector => {
    const provider = fixtureProvider(config, async () => response([vector]));
    await expect(provider.embed(["x"])).rejects.toThrow(); expect(provider.usage.cacheEntries).toBe(0);
  });
  it("rejects model mismatch and does not cache the result", async () => {
    const provider = fixtureProvider(config, async () => response([[1, 0]], "different-model"));
    await expect(provider.embed(["x"])).rejects.toThrow("model"); expect(provider.usage.cacheEntries).toBe(0);
  });
  it("limits request quota including failures and concurrent requests", async () => {
    const provider = fixtureProvider({ ...config, maxRequests: 1 }, async () => new Response("", { status: 503 }));
    const results = await Promise.allSettled([provider.embed(["a"]), provider.embed(["b"])]);
    expect(results.every(value => value.status === "rejected")).toBe(true); expect(provider.usage.requests).toBe(1);
  });
  it("retries a transient status at most once and never retries quota or authentication errors", async () => {
    let calls = 0;
    const provider = fixtureProvider({ ...config, retries: 1 }, async () => ++calls === 1 ? new Response("", { status: 503 }) : response([[1, 0]]));
    await provider.embed(["a"]); expect(calls).toBe(2);
    for (const status of [401, 429]) {
      const transport = vi.fn(async () => new Response("private upstream diagnostic", { status }));
      await expect(fixtureProvider({ ...config, retries: 1 }, transport).embed(["x"])).rejects.toThrow(`HTTP ${status}`);
      expect(transport).toHaveBeenCalledTimes(1);
    }
  });
  it("checks text, batch and response size before consuming vectors", async () => {
    const transport = vi.fn(async () => new Response("x".repeat(101))); const provider = fixtureProvider({ ...config, maxTextBytes: 64, maxResponseBytes: 100 }, transport);
    await expect(provider.embed(["x".repeat(65)])).rejects.toThrow("byte"); expect(transport).not.toHaveBeenCalled();
    await expect(provider.embed(["x"])).rejects.toThrow("byte");
  });
  it("supports OpenAI-compatible indexed output and independent model credentials", async () => {
    const provider = fixtureProvider({ ...config, baseUrl: "https://embeddings.example/v1", apiKey: "fixture", protocol: "openai" }, async () => new Response(JSON.stringify({ model: "fixture-only", data: [{ index: 1, embedding: [0, 1] }, { index: 0, embedding: [1, 0] }], usage: { total_tokens: 2 } })));
    expect((await provider.embed(["a", "b"])).vectors).toEqual([[1, 0], [0, 1]]);
  });
  it("rejects duplicate response indexes without caching vectors", async () => {
    const provider = fixtureProvider({ ...config, protocol: "openai" }, async () => new Response(JSON.stringify({ model: "fixture-only", data: [{ index: 0, embedding: [1, 0] }, { index: 0, embedding: [0, 1] }], usage: { total_tokens: 2 } })));
    await expect(provider.embed(["a", "b"])).rejects.toThrow("indexes"); expect(provider.usage.cacheEntries).toBe(0);
  });
  it("reserves cost before request and blocks unapproved paid inference", async () => {
    const transport = vi.fn<typeof fetch>(async () => response([[1, 0]]));
    const provider = fixtureProvider({ ...config, inputUsdPerMillion: 1, maxCostUsd: 0 }, transport);
    await expect(provider.embed(["a"])).rejects.toThrow("budget"); expect(transport).not.toHaveBeenCalled();
  });
  it("bounds streamed responses without a content length header", async () => {
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(101)); controller.close(); } });
    const provider = fixtureProvider({ ...config, maxResponseBytes: 100 }, async () => new Response(stream));
    await expect(provider.embed(["a"])).rejects.toThrow("byte");
  });
  it("times out without retrying or exposing transport diagnostics", async () => {
    const transport: typeof fetch = async (_url, options) => new Promise((_resolve, reject) => { options?.signal?.addEventListener("abort", () => reject(new Error("private server diagnostic")), { once: true }); });
    const provider = fixtureProvider({ ...config, timeoutMs: 100, retries: 1 }, transport);
    await expect(provider.embed(["a"])).rejects.toThrow("timed out"); expect(provider.usage.requests).toBe(1);
  });
});

describe("native Ollama revision binding", () => {
  it("verifies tags before inference, after inference, and before every cache hit", async () => {
    const methods: string[] = [];
    const provider = new HttpEmbeddingProvider(config, async (url, options) => {
      methods.push(`${options?.method} ${new URL(String(url)).pathname}`);
      if (options?.method === "GET") {
        expect(options.redirect).toBe("error"); expect(options.cache).toBe("no-store");
        expect(options.credentials).toBe("omit"); expect(options.headers).toBeUndefined();
        return inventory();
      }
      return response([[1, 0]]);
    });
    expect((await provider.embed(["a"])).receipt).toMatchObject({ requests: 1, metadataRequests: 2, cacheHits: 0 });
    expect((await provider.embed(["a"])).receipt).toMatchObject({ requests: 0, metadataRequests: 1, cacheHits: 1 });
    expect(methods).toEqual(["GET /api/tags", "POST /api/embed", "GET /api/tags", "GET /api/tags"]);
    expect(provider.usage).toMatchObject({ requests: 1, metadataRequests: 3 });
  });
  it("clears cached vectors and blocks reuse when the alias revision changes", async () => {
    let digest = config.modelRevision; let posts = 0;
    const provider = new HttpEmbeddingProvider(config, async (_url, options) => options?.method === "GET" ? inventory(digest) : (posts++, response([[1, 0]])));
    await provider.embed(["a"]); digest = "b".repeat(64);
    await expect(provider.embed(["a"])).rejects.toMatchObject({ code: "configuration" });
    expect(provider.usage.cacheEntries).toBe(0); expect(posts).toBe(1);
    digest = config.modelRevision;
    expect((await provider.embed(["a"])).receipt.requests).toBe(1);
  });
  it("rejects new vectors if the alias changes during the POST", async () => {
    let digest = config.modelRevision;
    const provider = new HttpEmbeddingProvider(config, async (_url, options) => {
      if (options?.method === "GET") return inventory(digest);
      digest = "b".repeat(64); return response([[1, 0]]);
    });
    await expect(provider.embed(["a"])).rejects.toMatchObject({ code: "configuration" });
    expect(provider.usage).toMatchObject({ requests: 1, metadataRequests: 2, cacheEntries: 0 });
  });
  it.each(["bad-json", "missing-model", "wrong-name", "duplicate-model", "invalid-digest", "oversized", "unavailable"])("denies %s inventory and clears existing cached vectors", async failure => {
    let broken = false; let posts = 0;
    const provider = new HttpEmbeddingProvider(config, async (_url, options) => {
      if (options?.method !== "GET") { posts++; return response([[1, 0]]); }
      if (!broken) return inventory();
      if (failure === "bad-json") return new Response("private invalid JSON");
      if (failure === "missing-model") return new Response(JSON.stringify({ models: [] }));
      if (failure === "wrong-name") return inventory(config.modelRevision, "different-model");
      if (failure === "duplicate-model") return new Response(JSON.stringify({ models: [{ name: config.model, digest: config.modelRevision }, { name: config.model, digest: config.modelRevision }] }));
      if (failure === "invalid-digest") return inventory("not-a-digest");
      if (failure === "oversized") return new Response("x".repeat(128_001));
      return new Response("private upstream message", { status: 503 });
    });
    await provider.embed(["a"]); broken = true;
    await expect(provider.embed(["a"])).rejects.toBeInstanceOf(MatchingError);
    expect(provider.usage.cacheEntries).toBe(0); expect(posts).toBe(1);
  });
  it("times out on metadata before inference without retrying", async () => {
    let calls = 0;
    const transport: typeof fetch = async (_url, options) => { calls++; return new Promise((_resolve, reject) => {
      options?.signal?.addEventListener("abort", () => reject(new Error("private transport error")), { once: true });
    }); };
    const provider = new HttpEmbeddingProvider({ ...config, timeoutMs: 100, retries: 1 }, transport);
    await expect(provider.embed(["a"])).rejects.toThrow("inventory check timed out");
    expect(provider.usage).toMatchObject({ requests: 0, metadataRequests: 1 }); expect(calls).toBe(1);
  });
});

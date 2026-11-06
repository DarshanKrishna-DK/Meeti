import { z } from "zod";
import { IntentSemanticsSchema, directionCompatibility, semanticInput, type IntentSemantics } from "./semantics";
import { MatchingError, validateVector, type EmbeddingProvider, type EmbeddingReceipt } from "./embeddings";

const participantSchema = z.object({
  arkivKey: z.string().regex(/^0x[0-9a-fA-F]{64}$/), owner: z.string().regex(/^0x[0-9a-fA-F]{40}$/),
  intentId: z.string().min(1).max(80), version: z.number().int().positive(), expiresAt: z.string().datetime({ offset: true }),
  authority: z.object({ allowed: z.boolean(), checkedAt: z.string().datetime({ offset: true }) }).strict(),
  semantics: IntentSemanticsSchema,
}).strict();
export type MatchingParticipant = z.infer<typeof participantSchema>;
export type RequirementCheck = { side: "source" | "candidate"; kind: string; requirement: string; strength: "mandatory" | "preferred" | "unknown"; supported: boolean; evidence: string | null };
export type RankedCandidate = {
  arkivKey: string; owner: string; intentId: string; version: number;
  state: "match" | "possible-match" | "no-match"; eligible: boolean; cosine: number | null;
  reasons: string[]; requirementChecks: RequirementCheck[]; embedding: EmbeddingReceipt | null;
  preferenceFraction: number | null;
};

export function cosineSimilarity(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length || left.length > 8192) throw new MatchingError("input", "Cosine similarity requires equal bounded vector dimensions.");
  validateVector(left, left.length); validateVector(right, left.length);
  // Rescaling before normalization avoids overflow for large finite provider values.
  const aScale = Math.max(...left.map(Math.abs)); const bScale = Math.max(...right.map(Math.abs));
  let dot = 0; let aNorm = 0; let bNorm = 0;
  for (let i = 0; i < left.length; i++) { const a = left[i] / aScale; const b = right[i] / bScale; dot += a * b; aNorm += a * a; bNorm += b * b; }
  return Math.max(-1, Math.min(1, dot / Math.sqrt(aNorm * bNorm)));
}

function normalized(value: string) { return value.normalize("NFKC").toLowerCase().trim().replace(/\s+/g, " "); }
function requirements(left: IntentSemantics, right: IntentSemantics, side: "source" | "candidate"): RequirementCheck[] {
  // Similarity and topic mentions cannot establish mandatory qualifications or terms.
  return left.requirements.map(requirement => {
    const supported = right.offers.find(offer => normalized(offer.value) === normalized(requirement.value));
    return { side, kind: requirement.kind, requirement: requirement.value, strength: requirement.strength, supported: Boolean(supported), evidence: supported?.sourceQuote ?? null };
  });
}

export async function rankCandidates(input: {
  source: MatchingParticipant; candidates: MatchingParticipant[]; embeddingProvider: EmbeddingProvider;
  now?: number; authorityMaxAgeMs?: number; minCosine?: number;
}): Promise<RankedCandidate[]> {
  const source = participantSchema.parse(input.source);
  if (!Array.isArray(input.candidates) || input.candidates.length > 100) throw new MatchingError("input", "Rank at most 100 Arkiv candidates per request.");
  const candidates = input.candidates.map(value => participantSchema.parse(value));
  const now = input.now ?? Date.now(); const maxAge = input.authorityMaxAgeMs ?? 60_000; const threshold = input.minCosine ?? 0.65;
  if (!Number.isFinite(now) || !Number.isInteger(maxAge) || maxAge < 1 || maxAge > 60_000 || !Number.isFinite(threshold) || threshold < -1 || threshold > 1) throw new MatchingError("input", "Matching time, authority age, or similarity threshold is invalid.");
  const current = (value: MatchingParticipant, at = now) => value.authority.allowed && Date.parse(value.authority.checkedAt) <= at + 1000 && at - Date.parse(value.authority.checkedAt) <= maxAge && Date.parse(value.expiresAt) > at;
  const sourceIdentity = `${source.owner.toLowerCase()}:${source.intentId}`;
  const identities = new Map<string, number>(); const keys = new Map<string, number>();
  for (const candidate of candidates) {
    const identity = `${candidate.owner.toLowerCase()}:${candidate.intentId}`;
    identities.set(identity, (identities.get(identity) ?? 0) + 1);
    keys.set(candidate.arkivKey.toLowerCase(), (keys.get(candidate.arkivKey.toLowerCase()) ?? 0) + 1);
  }
  const pending: { candidate: MatchingParticipant; result: RankedCandidate }[] = [];
  const results = candidates.map(candidate => {
    const result: RankedCandidate = { arkivKey: candidate.arkivKey, owner: candidate.owner, intentId: candidate.intentId, version: candidate.version,
      state: "no-match", eligible: false, cosine: null, reasons: [], requirementChecks: [], embedding: null, preferenceFraction: null };
    const identity = `${candidate.owner.toLowerCase()}:${candidate.intentId}`;
    if (!current(source) || !current(candidate)) result.reasons.push("Current authority and active intent expiry are required for both participants.");
    if (candidate.owner.toLowerCase() === source.owner.toLowerCase() || identity === sourceIdentity || candidate.arkivKey.toLowerCase() === source.arkivKey.toLowerCase()) result.reasons.push("Self matching is blocked.");
    if ((identities.get(identity) ?? 0) > 1 || (keys.get(candidate.arkivKey.toLowerCase()) ?? 0) > 1) result.reasons.push("Duplicate or conflicting Arkiv candidates require authoritative reconciliation.");
    const direction = directionCompatibility(source.semantics.direction, candidate.semantics.direction);
    if (!direction.compatible) result.reasons.push(direction.reason);
    if (source.semantics.category !== candidate.semantics.category) result.reasons.push("The purpose categories differ and require separate permission scope.");
    if (source.semantics.category === "unknown" || candidate.semantics.category === "unknown" || source.semantics.clarificationQuestions.length || candidate.semantics.clarificationQuestions.length) result.reasons.push("Resolve essential intent clarification before matching.");
    if ((!source.semantics.canonicalRole && !source.semantics.topics.length) || (!candidate.semantics.canonicalRole && !candidate.semantics.topics.length)) result.reasons.push("Clarify the role or subject matter before semantic matching.");
    result.requirementChecks = [...requirements(source.semantics, candidate.semantics, "source"), ...requirements(candidate.semantics, source.semantics, "candidate")];
    const preferences = result.requirementChecks.filter(value => value.strength === "preferred");
    result.preferenceFraction = preferences.length ? preferences.filter(value => value.supported).length / preferences.length : null;
    if (result.requirementChecks.some(value => value.strength === "mandatory" && !value.supported)) result.reasons.push("At least one mandatory requirement lacks explicit counterpart offer evidence.");
    if (result.requirementChecks.some(value => value.strength === "unknown")) result.reasons.push("Clarify an unknown requirement before matching.");
    if (!result.reasons.length) pending.push({ candidate, result });
    return result;
  });
  if (!pending.length) return results;
  // A small serial batch respects local memory and provider quotas. No synthetic vector fallback is allowed.
  for (let offset = 0; offset < pending.length; offset += 15) {
    const batch = pending.slice(offset, offset + 15);
    const output = await input.embeddingProvider.embed([semanticInput(source.semantics), ...batch.map(value => semanticInput(value.candidate.semantics))]);
    if (output.vectors.length !== batch.length + 1 || output.receipt.model !== input.embeddingProvider.model || output.receipt.dimensions !== input.embeddingProvider.dimensions) throw new MatchingError("output", "The embedding batch receipt is inconsistent.");
    output.vectors.forEach(value => validateVector(value, input.embeddingProvider.dimensions));
    for (let index = 0; index < batch.length; index++) {
      const result = batch[index].result; const cosine = cosineSimilarity(output.vectors[0], output.vectors[index + 1]);
      const missingPreferred = result.requirementChecks.some(value => value.strength === "preferred" && !value.supported);
      result.cosine = cosine; result.embedding = output.receipt;
      const completedAt = input.now ?? Date.now();
      if (!current(source, completedAt) || !current(batch[index].candidate, completedAt)) {
        result.reasons.push("Current authority or intent expiry elapsed during semantic inference. Refresh both participants before matching.");
        continue;
      }
      result.state = cosine >= threshold ? (missingPreferred ? "possible-match" : "match") : "no-match";
      result.eligible = cosine >= threshold;
      result.reasons.push("The relationship directions are complementary and deterministic gates passed.");
      result.reasons.push(cosine >= threshold ? "Semantic similarity meets the configured advisory threshold." : "Semantic similarity is below the configured advisory threshold.");
      if (missingPreferred) result.reasons.push("At least one preferred requirement lacks explicit counterpart offer evidence.");
    }
  }
  // A later batch can outlive a receipt accepted by an earlier batch.
  const completedAt = input.now ?? Date.now();
  for (const { candidate, result } of pending) {
    if (result.eligible && (!current(source, completedAt) || !current(candidate, completedAt))) {
      result.state = "no-match"; result.eligible = false;
      result.reasons.push("Current authority or intent expiry elapsed before ranking completed. Refresh both participants before matching.");
    }
  }
  return results.sort((a, b) => Number(b.eligible) - Number(a.eligible) || (b.cosine ?? -2) - (a.cosine ?? -2) || (b.preferenceFraction ?? -1) - (a.preferenceFraction ?? -1) || a.arkivKey.localeCompare(b.arkivKey));
}

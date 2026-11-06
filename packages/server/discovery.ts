import type { Intent } from '../shared/src';
import { intent, agent, db } from './db';
import { arkiv, assertIntent, authority, publicIntent, policyDigest } from './policy';
import { HttpError, requireValue } from './security';
import { intentDigest, type DiscoveredIntent } from '../arkiv/src';
import { createEmbeddingProviderFromEnv, directionCompatibility, DirectionSchema, rankCandidates, MatchingError, SEMANTIC_INPUT_FORMAT, type MatchingParticipant } from '../matching/src';

let embeddings: ReturnType<typeof createEmbeddingProviderFromEnv> | undefined;
export function embeddingProvider() { return embeddings ??= createEmbeddingProviderFromEnv(process.env); }
export function clearEmbeddingCache() { embeddings?.clearCache(); }
function calibratedThreshold(): number {
  const value = Number(process.env.MATCHING_MIN_COSINE);
  if (!process.env.MATCHING_MIN_COSINE?.trim() || !Number.isFinite(value) || value < -1 || value > 1
    || process.env.MATCHING_CALIBRATED_REVISION !== process.env.EMBEDDING_MODEL_REVISION || process.env.MATCHING_CALIBRATED_FORMAT !== SEMANTIC_INPUT_FORMAT) throw new MatchingError('configuration', 'Calibrate subject similarity for the configured embedding model revision and input format before matching.');
  return value;
}

/** The local record links an inbox. It never supplies candidate intent content or liveness. */
export async function freshPublicIntent(userId: string, value: Intent, action: 'discover' | 'negotiate' | 'introduce' | 'message') {
  assertIntent(value);
  const a = await authority(userId, action, value.policyVersion);
  const authorityCheckedAt=new Date().toISOString();
  const current = await arkiv().readActive(requireValue(value.arkivKey, 'Publish this intent to Arkiv before matching.'));
  if (intentDigest(current.intent) !== intentDigest(publicIntent(value, a))) throw new HttpError(409, 'ARKIV_INTENT_CHANGED', 'The current Arkiv publication differs from this intent. Refresh and review it again.');
  const local = requireValue(intent(value.id), 'This intent is no longer available.', 409);
  const currentAgent = requireValue(agent(userId), 'The agent is unavailable.', 409);
  assertIntent(local.value);
  if (local.userId !== userId || local.value.version !== value.version || local.value.arkivKey !== value.arkivKey
    || policyDigest(currentAgent.policy) !== policyDigest(a.policy)) throw new HttpError(409, 'MATCH_STATE_CHANGED', 'The intent or its permissions changed during verification.');
  return { publication: current, a, participant: matchingParticipant(current,authorityCheckedAt) };
}
function matchingParticipant(value: DiscoveredIntent,checkedAt:string): MatchingParticipant {
  return { arkivKey: value.entityKey, owner: value.owner, intentId: value.intent.intentId, version: value.intent.version,
    expiresAt: value.intent.expiresAt, semantics: value.intent.semantics,
    authority: { allowed: true, checkedAt } };
}
export async function assessPair(userId: string, own: Intent, otherUserId: string, other: Intent) {
  const [left, right] = await Promise.all([freshPublicIntent(userId, own, 'negotiate'), freshPublicIntent(otherUserId, other, 'negotiate')]);
  const result = await rankCandidates({ source: left.participant, candidates: [right.participant], embeddingProvider: embeddingProvider(), minCosine: calibratedThreshold() });
  if (!result[0]?.eligible) throw new HttpError(409, 'MATCH_INELIGIBLE', result[0]?.reasons.join(' ') || 'Both intents must meet the current eligibility rules.');
  return result[0];
}
export async function discoverCandidates(userId: string, own: Intent, input: { goal?: Intent['goal']; tags?: string[]; includeDemo?: boolean }) {
  const source = await freshPublicIntent(userId, own, 'discover');
  const blocked = db().prepare('SELECT users.wallet FROM blocks JOIN users ON users.id=blocks.blocked_id WHERE blocks.user_id=? UNION SELECT users.wallet FROM blocks JOIN users ON users.id=blocks.user_id WHERE blocks.blocked_id=?').all(userId, userId) as { wallet: string | null }[];
  const directions = DirectionSchema.options.filter(direction => directionCompatibility(source.publication.intent.semantics.direction, direction).compatible);
  if (!directions.length) throw new HttpError(409, 'INTENT_CLARIFICATION_REQUIRED', 'Clarify your relationship direction before searching.');
  const filter = { goal: input.goal || own.goal, excludeOwner: source.a.owner, blockedOwners: blocked.flatMap(x => x.wallet ? [x.wallet] : []), includeDemo: input.includeDemo, directions, limit: 12 };
  const adapter = arkiv();
  const focused = input.tags?.length ? await adapter.discover({ ...filter, tags: input.tags }) : null;
  // Always perform the broader scan: a literal tag hit must not hide paraphrases.
  const broad = await adapter.discover(filter);
  const interleaved: DiscoveredIntent[] = [];
  for (let index = 0; index < 12; index++) {
    if (broad.candidates[index]) interleaved.push(broad.candidates[index]);
    if (focused?.candidates[index]) interleaved.push(focused.candidates[index]);
  }
  const uniquePublications = [...new Map(interleaved.map(value => [value.entityKey, value])).values()];
  const publications = uniquePublications.slice(0, 12);
  const eligible: {publication:DiscoveredIntent;participant:MatchingParticipant}[] = [];
  let unconfirmed = 0;
  for (const candidate of publications) {
    const linked = intent(candidate.intent.intentId);
    const linkedAgent = linked ? agent(linked.userId) : null;
    if (!linked || !linkedAgent || linked.userId === userId || linkedAgent.owner.toLowerCase() !== candidate.owner.toLowerCase()
      || linkedAgent.ensName !== candidate.intent.ensAgentRef || linked.value.arkivKey?.toLowerCase() !== candidate.entityKey.toLowerCase()) { unconfirmed++; continue; }
    try {
      const checked = await freshPublicIntent(linked.userId, linked.value, 'discover');
      eligible.push(checked);
    } catch (error) {
      if (error instanceof HttpError && error.status < 500) { unconfirmed++; continue; }
      throw error;
    }
  }
  // Recheck the source after potentially slow network reads. No cached identity is authority.
  const refreshedSource = await freshPublicIntent(userId, own, 'discover');
  const ranked = eligible.length ? await rankCandidates({ source: refreshedSource.participant, candidates: eligible.map(value=>value.participant), embeddingProvider: embeddingProvider(), minCosine: calibratedThreshold() }) : [];
  const byKey = new Map(eligible.map(({publication:value}) => [value.entityKey.toLowerCase(), value]));
  const candidates = ranked.filter(value => value.state !== 'no-match').flatMap(match => {
    const value = byKey.get(match.arkivKey.toLowerCase());
    return value ? [{ key: value.entityKey, intentId: value.intent.intentId, ensAgentRef: value.intent.ensAgentRef, goal: value.intent.goal,
      summary: value.intent.summary, tags: value.intent.tags, expiresAt: value.intent.expiresAt, owner: value.owner, version: value.intent.version,
      policyVersion: value.intent.policyVersion, demoOrigin: value.intent.demoOrigin, match: { ...match, state: 'possible-match' as const, reasons: [...match.reasons,
        'Semantic retrieval is advisory. A real agent compatibility review and both human decisions are still required.',
        `Source ${refreshedSource.publication.intent.intentId} direction ${refreshedSource.publication.intent.semantics.direction}; candidate ${value.intent.intentId} direction ${value.intent.semantics.direction}.`,
        `Subject evidence: source role ${refreshedSource.publication.intent.semantics.canonicalRole?.value || 'unspecified'} and candidate role ${value.intent.semantics.canonicalRole?.value || 'unspecified'}.`] } }] : [];
  });
  return { candidates, source: 'arkiv' as const, mode: 'semantic' as const,
    embeddingExecution: ranked.some(value => value.embedding !== null) ? 'executed' : 'not-required-no-semantically-eligible-candidates',
    observedBlocks: [...(focused?.observedBlocks || []), ...broad.observedBlocks],
    coverage: { strategy: focused ? 'topic query plus broad category scan' : 'broad category scan', candidateLimit: 12,
      scannedCandidates: publications.length, unconfirmed, exhaustive: false, truncated: uniquePublications.length > 12 || broad.truncated || Boolean(focused?.truncated) },
    rejectedEntities: broad.rejectedEntities + (focused?.rejectedEntities || 0) };
}

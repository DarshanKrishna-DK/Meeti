import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent, Intent, Profile, Room } from '../packages/shared/src';
import type { DiscoveredIntent } from '../packages/arkiv/src';
import type { IntentSemantics } from '../packages/matching/src';

// These fixtures isolate provider trust boundaries and cosine arithmetic. They are not live identity or model evidence.
// rankCandidates, semanticInput, policy projections, database access and route guards remain real.
const fixture = vi.hoisted(() => ({ read: vi.fn(), discover: vi.fn(), authority: vi.fn(), embed: vi.fn(), ai: vi.fn() }));
vi.mock('../packages/server/policy', async importOriginal => ({
  ...await importOriginal<typeof import('../packages/server/policy')>(),
  arkiv: () => ({ readActive: fixture.read, discover: fixture.discover }),
  authority: fixture.authority,
  ai: fixture.ai,
}));
vi.mock('../packages/matching/src', async importOriginal => ({
  ...await importOriginal<typeof import('../packages/matching/src')>(),
  createEmbeddingProviderFromEnv: () => ({ model: 'explicit-arithmetic-fixture', dimensions: 2, embed: fixture.embed, clearCache: vi.fn() }),
}));

import { agent, closeDatabase, db, profile, saveAgent, saveIntent, type ProposalData } from '../packages/server/db';
import { encrypt, hash } from '../packages/server/crypto';
import { createSession, HttpError } from '../packages/server/security';
import { publicIntent } from '../packages/server/policy';
import { discoverCandidates, freshPublicIntent } from '../packages/server/discovery';
import { route } from '../packages/server/router';
import { MatchingError, SEMANTIC_INPUT_FORMAT } from '../packages/matching/src';

const origin = 'http://127.0.0.1:3197';
let directory: string;
const records = new Map<string, DiscoveredIntent>();
type Actor = { id: string; cookie: string; a: Agent; intent: Intent; publication: DiscoveredIntent };
function actor(direction: IntentSemantics['direction'] = 'hiring', changes: Partial<Intent> = {}): Actor {
  const id = randomUUID(), owner = `0x${randomBytes(20).toString('hex')}` as `0x${string}`;
  const p: Profile = { displayName: 'Explicit test fixture', headline: 'Public fixture headline', bio: '', offering: '', seeking: '',
    tags: [], contact: `private-contact-${id}`, employer: `private-employer-${id}`, publicFields: ['headline'], aiConsent: true };
  db().prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(id, `${id}@example.test`, 'test-only-no-login', owner, encrypt(p, `profile:${id}`), new Date().toISOString());
  const a: Agent = { id: randomUUID(), ensName: `${id}.fixture.eth`, owner, delegate: `0x${'22'.repeat(20)}`, persona: 'Test fixture', config: {}, authority: null,
    policy: { version: 1, purpose: 'collaborator', allowedFields: ['headline'], allowedActions: ['publish', 'discover', 'negotiate', 'introduce', 'message'], paused: false,
      expiresAt: new Date(Date.now() + 3600000).toISOString() } };
  saveAgent(id, a);
  const summary = 'Explicit fixture hiring or seeking a developer advocate';
  const semantics: IntentSemantics = { schemaVersion: 1, category: 'collaborator', categoryEvidence: 'fixture', direction, directionEvidence: 'fixture',
    canonicalRole: { value: 'developer advocate', sourceQuote: 'developer advocate' }, topics: [], offers: [], requirements: [], clarificationQuestions: [] };
  const intent: Intent = { id: randomUUID(), version: 1, goal: 'collaborator', summary, tags: ['devrel'], createdAt: new Date().toISOString(),
    expiresAt: a.policy.expiresAt, policyVersion: 1, status: 'published', demoOrigin: true, semantics,
    arkivKey: `0x${randomBytes(32).toString('hex')}`, ...changes };
  saveIntent(id, intent);
  const publication: DiscoveredIntent = { intent: publicIntent(intent, a), entityKey: intent.arkivKey as `0x${string}`, owner, creator: owner,
    chainExpiresAtBlock: '200', observedAtBlock: '100', source: 'arkiv' };
  records.set(publication.entityKey, publication);
  return { id, cookie: createSession(id).split(';')[0], a, intent, publication };
}
function pair() {
  const left = actor(), right = actor('seeking-job');
  const id = randomUUID(), digest = hash(id);
  const value: ProposalData = { leftIntent: left.intent, rightIntent: right.intent, leftPolicy: left.a.policy, rightPolicy: right.a.policy,
    leftAgent: left.a.id, rightAgent: right.a.id, leftProfileDigest: hash(JSON.stringify(profile(left.id))), rightProfileDigest: hash(JSON.stringify(profile(right.id))),
    summary: 'Explicit local proposal fixture', compatibility: {}, exchanges: [], createdAt: new Date().toISOString() };
  db().prepare('INSERT INTO proposals VALUES(?,?,?,?,?,?,?)').run(id, left.id, right.id, id, 'proposed', digest, encrypt(value, `proposal:${id}`));
  const room: Room = { id: randomUUID(), proposalId: id, title: 'Fixture room', introduction: 'Protected fixture introduction', createdAt: new Date().toISOString() };
  db().prepare('INSERT INTO rooms VALUES(?,?,?)').run(room.id, id, encrypt(room, `room:${room.id}`));
  return { left, right, id, room };
}
async function call(owner: Actor, path: string, body?: unknown) {
  return route(new Request(`${origin}/api/${path}`, { method: body === undefined ? 'GET' : 'POST',
    headers: { origin, 'content-type': 'application/json', cookie: owner.cookie }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }), path.split('/'));
}
function discovery(candidates: DiscoveredIntent[], truncated = false) {
  return { candidates, observedBlocks: ['100'], source: 'arkiv' as const, truncated, rejectedEntities: 0 };
}
beforeEach(() => {
  closeDatabase(); directory = mkdtempSync(join(tmpdir(), 'meeti-hybrid-security-'));
  vi.stubEnv('DATABASE_PATH', join(directory, 'fixture.sqlite'));
  vi.stubEnv('DATA_ENCRYPTION_KEY', randomBytes(32).toString('hex'));
  vi.stubEnv('APP_ORIGIN', origin); vi.stubEnv('WORLD_CAPABILITY_ENABLED', 'false');
  vi.stubEnv('MATCHING_MIN_COSINE', '0.85'); vi.stubEnv('EMBEDDING_MODEL_REVISION', 'test-only-revision');
  vi.stubEnv('MATCHING_CALIBRATED_REVISION', 'test-only-revision'); vi.stubEnv('MATCHING_CALIBRATED_FORMAT', SEMANTIC_INPUT_FORMAT);
  records.clear();
  fixture.read.mockReset().mockImplementation(async (key: string) => {
    const record = records.get(key);
    if (!record) throw new Error('Explicit fixture unavailable record');
    return structuredClone(record);
  });
  fixture.discover.mockReset().mockResolvedValue(discovery([]));
  fixture.authority.mockReset().mockImplementation(async (id: string) => agent(id));
  fixture.embed.mockReset().mockImplementation(async (texts: string[]) => ({ vectors: texts.map(() => [1, 0]), receipt: {
    model: 'explicit-arithmetic-fixture', modelRevision: 'test-only-revision', dimensions: 2, format: SEMANTIC_INPUT_FORMAT,
    requests: 1, cacheHits: 0, inputTokens: 1, estimatedCostUsd: 0 } }));
  fixture.ai.mockReset().mockImplementation(() => { throw new Error('Real AI work is outside these arithmetic and permission fixtures'); });
});
afterEach(() => { closeDatabase(); vi.unstubAllEnvs(); rmSync(directory, { recursive: true, force: true }); });

describe('hybrid discovery integration with explicit authority and arithmetic fixtures', () => {
  it('runs real ranking on the broad scan even when optional literal tags find nothing', async () => {
    const source = actor(), candidate = actor('seeking-job', { tags: ['developer-relations'] });
    fixture.discover.mockImplementation(async (filter: { tags?: string[] }) => discovery(filter.tags ? [] : [candidate.publication]));
    const result = await discoverCandidates(source.id, source.intent, { tags: ['devrel'], includeDemo: true });
    expect(fixture.discover).toHaveBeenCalledTimes(2);
    expect(fixture.discover.mock.calls[0][0]).toMatchObject({ tags: ['devrel'], directions: ['seeking-job'], limit: 12 });
    expect(fixture.discover.mock.calls[1][0]).not.toHaveProperty('tags');
    expect(result.candidates.map(value => value.key)).toEqual([candidate.publication.entityKey]);
    expect(result.candidates[0].match).toMatchObject({ cosine: 1, state: 'possible-match', eligible: true });
    expect(fixture.embed.mock.calls[0][0]).toEqual(['Role: developer relations.', 'Role: developer relations.']);
    expect(result.coverage).toMatchObject({ candidateLimit: 12, exhaustive: false, scannedCandidates: 1 });
    expect(fixture.read.mock.calls.filter(([key]) => key === source.intent.arkivKey)).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain(profile(candidate.id).contact);
    expect(JSON.stringify(result)).not.toContain(profile(candidate.id).employer);
  });

  it('rejects the same relationship direction before requesting any vectors', async () => {
    const source = actor(), candidate = actor('hiring');
    fixture.discover.mockResolvedValue(discovery([candidate.publication]));
    const result = await discoverCandidates(source.id, source.intent, {});
    expect(result.candidates).toEqual([]);
    expect(fixture.embed).not.toHaveBeenCalled();
    expect(result.embeddingExecution).not.toBe('executed');
  });

  it('keeps broad paraphrases in the budget when twelve literal tag hits fill the focused query', async () => {
    const source = actor(), paraphrase = actor('seeking-job', { tags: ['developer-relations'] });
    const focused = Array.from({ length: 12 }, () => actor('seeking-job'));
    fixture.discover.mockImplementation(async (filter: { tags?: string[] }) => discovery(filter.tags ? focused.map(value => value.publication) : [paraphrase.publication]));
    const result = await discoverCandidates(source.id, source.intent, { tags: ['devrel'] });
    expect(result.candidates.some(value => value.key === paraphrase.publication.entityKey)).toBe(true);
    expect(result.candidates.length).toBeLessThanOrEqual(12);
    expect(result.coverage.exhaustive).toBe(false);
    expect(result.coverage.truncated).toBe(true);
  });

  it.each(['revision', 'input-format'])('rejects stale %s calibration instead of accepting fixture vectors', async kind => {
    const source = actor(), candidate = actor('seeking-job');
    fixture.discover.mockResolvedValue(discovery([candidate.publication]));
    vi.stubEnv(kind === 'revision' ? 'MATCHING_CALIBRATED_REVISION' : 'MATCHING_CALIBRATED_FORMAT', 'obsolete-fixture');
    const response = await call(source, 'discover', { intentId: source.intent.id });
    expect(response.status).toBe(503);
    expect((await response.json()).error.code).toBe('SEMANTIC_CONFIGURATION');
    expect(fixture.embed).not.toHaveBeenCalled();
  });

  it.each(['arkiv-query', 'arkiv-read', 'ens', 'embeddings'])('never substitutes local matches after %s failure', async boundary => {
    const source = actor(), candidate = actor('seeking-job');
    fixture.discover.mockResolvedValue(discovery([candidate.publication]));
    if (boundary === 'arkiv-query') fixture.discover.mockRejectedValue(new Error('Unavailable fixture RPC'));
    if (boundary === 'arkiv-read') fixture.read.mockRejectedValue(new Error('Unavailable fixture RPC'));
    if (boundary === 'ens') fixture.authority.mockRejectedValue(new HttpError(503, 'ENS_UNAVAILABLE', 'Unavailable fixture authority'));
    if (boundary === 'embeddings') fixture.embed.mockRejectedValue(new MatchingError('provider', 'Unavailable fixture embedding provider'));
    const response = await call(source, 'discover', { intentId: source.intent.id });
    expect(response.status).toBe(503);
    const body = await response.json();
    expect(body).not.toHaveProperty('data');
    expect(body).not.toHaveProperty('candidates');
    expect(fixture.ai).not.toHaveBeenCalled();
    expect(db().prepare('SELECT count(*) AS n FROM proposals').get()).toEqual({ n: 0 });
  });

  it.each(['owner', 'ens-name', 'entity-key', 'unknown-inbox'])('rejects an unconfirmed candidate %s linkage', async field => {
    const source = actor(), candidate = actor('seeking-job');
    const forged = structuredClone(candidate.publication);
    if (field === 'owner') forged.owner = source.publication.owner;
    if (field === 'ens-name') forged.intent.ensAgentRef = source.a.ensName;
    if (field === 'entity-key') forged.entityKey = `0x${'33'.repeat(32)}`;
    if (field === 'unknown-inbox') forged.intent.intentId = randomUUID();
    fixture.discover.mockResolvedValue(discovery([forged]));
    const result = await discoverCandidates(source.id, source.intent, {});
    expect(result.candidates).toEqual([]);
    expect(result.coverage.unconfirmed).toBe(1);
    expect(fixture.embed).not.toHaveBeenCalled();
  });

  it('reports bounded truncated coverage and never ranks beyond the candidate budget', async () => {
    const source = actor(), candidates = Array.from({ length: 14 }, () => actor('seeking-job'));
    fixture.discover.mockResolvedValue(discovery(candidates.map(value => value.publication), true));
    const result = await discoverCandidates(source.id, source.intent, {});
    expect(result.candidates.length).toBeLessThanOrEqual(12);
    expect(result.coverage).toMatchObject({ exhaustive: false, truncated: true, candidateLimit: 12 });
    expect(fixture.embed.mock.calls[0][0].length).toBeLessThanOrEqual(13);
  });
});

describe('exact Arkiv publication revalidation on protected actions', () => {
  it.each(['version', 'entity-key', 'closed', 'expired', 'policy', 'tenancy'])('rejects a local %s change while the Arkiv read is in flight', async field => {
    const source = actor();
    fixture.read.mockImplementationOnce(async () => {
      const changed = structuredClone(source.intent);
      if (field === 'version') changed.version++;
      if (field === 'entity-key') changed.arkivKey = `0x${'44'.repeat(32)}`;
      if (field === 'closed') changed.status = 'revoked';
      if (field === 'expired') changed.expiresAt = new Date(Date.now() - 1).toISOString();
      if (field === 'policy') saveAgent(source.id, { ...source.a, policy: { ...source.a.policy, version: 2 } });
      if (field === 'tenancy') {
        const other = actor('seeking-job');
        db().prepare('UPDATE intents SET user_id=? WHERE id=?').run(other.id, source.intent.id);
      } else saveIntent(source.id, changed);
      return structuredClone(source.publication);
    });
    await expect(freshPublicIntent(source.id, source.intent, 'negotiate')).rejects.toThrow();
    expect(fixture.embed).not.toHaveBeenCalled();
  });

  it.each(['summary', 'owner', 'version', 'expiry', 'direction', 'closed'])('rejects changed signed publication %s content', async field => {
    const source = actor();
    const changed = structuredClone(source.publication);
    if (field === 'summary') changed.intent.summary += ' changed';
    if (field === 'owner') changed.intent.owner = `0x${'33'.repeat(20)}`;
    if (field === 'version') changed.intent.version++;
    if (field === 'expiry') changed.intent.expiresAt = new Date(Date.now() - 1).toISOString();
    if (field === 'direction') changed.intent.semantics.direction = 'seeking-job';
    if (field === 'closed') { changed.intent.status = 'closed'; changed.intent.optIn = false; }
    records.set(changed.entityKey, changed);
    await expect(freshPublicIntent(source.id, source.intent, 'negotiate')).rejects.toThrow();
    expect(fixture.embed).not.toHaveBeenCalled();
  });

  it.each(['consent', 'open', 'read-room', 'message', 'disclosure'])('blocks %s when a counterpart Arkiv record becomes unavailable', async action => {
    const p = pair(); records.delete(p.right.publication.entityKey);
    const [path, body] = action === 'consent' ? [`proposals/${p.id}/consent`, { decision: 'approve' }]
      : action === 'open' ? [`proposals/${p.id}/open`, {}]
      : action === 'read-room' ? [`rooms/${p.room.id}`, undefined]
      : action === 'message' ? [`rooms/${p.room.id}/messages`, { body: 'Denied fixture message' }]
      : [`proposals/${p.id}/disclosure`, { fieldId: 'headline' }];
    const response = await call(p.left, path as string, body);
    expect(response.status).toBe(503);
    expect(await response.text()).not.toContain(p.room.introduction);
    expect(db().prepare('SELECT count(*) AS n FROM messages').get()).toEqual({ n: 0 });
    expect(db().prepare('SELECT count(*) AS n FROM consents').get()).toEqual({ n: 0 });
    expect(fixture.ai).not.toHaveBeenCalled();
  });
});

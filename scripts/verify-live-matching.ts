import { readFileSync, writeFileSync } from 'node:fs';
import { decrypt } from '../packages/server/crypto';
import { createArkivAdapter } from '../packages/arkiv/src';
import type { AppState, Candidate, Profile } from '../packages/shared/src';

const origin = process.env.APP_ORIGIN || 'http://127.0.0.1:3173';
type Role = 'writer' | 'metamask';
const accounts = decrypt<Record<Role, { userId: string; cookie: string }> & { intents: { role: Role; id: string; label: string }[] }>(readFileSync('.local-data/live-matching-accounts.enc', 'utf8'), 'live-matching-accounts');
async function response(role: Role, path: string, body?: unknown) {
  const result = await fetch(origin + '/api/' + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { origin, cookie: accounts[role].cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(240_000) });
  return { status: result.status, body: await result.json() };
}
async function api<T>(role: Role, path: string, body?: unknown): Promise<T> {
  const result = await response(role, path, body);
  if (result.status !== 200) throw new Error(`Live API ${path} did not pass: ${result.body.error?.code || result.status}.`);
  return result.body.data as T;
}
function check(condition: unknown, message: string): asserts condition { if (!condition) throw new Error(message); }
async function privateFields() {
  for (const role of ['writer', 'metamask'] as const) {
    const state = await api<AppState>(role, 'state');
    const profile: Profile = { ...state.profile, contact: `private-test-${accounts[role].userId}@example.invalid`, employer: 'Fictional confidential test organisation', aiConsent: true };
    check(!profile.publicFields.includes('contact') && !profile.publicFields.includes('employer'), 'Private fixture fields must remain outside public projections.');
    await api(role, 'profile', profile);
  }
  console.log('Nonempty fictional private fields saved through the real API, excluded from public fields. No external message sent.');
}
async function verify() {
  const started = Date.now();
  const [left, right] = await Promise.all([api<AppState>('writer', 'state'), api<AppState>('metamask', 'state')]);
  check(left.user.id !== right.user.id && left.user.wallet !== right.user.wallet, 'Use distinct actual linked test accounts.');
  const seeker = left.intents.find(value => value.id === accounts.intents.find(item => item.label === 'seeker')?.id);
  const recruiter = right.intents.find(value => value.id === accounts.intents.find(item => item.label === 'recruiter')?.id);
  const incompatible = right.intents.find(value => value.id === accounts.intents.find(item => item.label === 'incompatible-seeker')?.id);
  check(seeker?.arkivKey && recruiter?.arkivKey && incompatible?.arkivKey, 'All three reviewed test records need actual confirmed Arkiv keys.');
  const adapter = createArkivAdapter({ accessKey: process.env.ARKIV_ACCESS_KEY || '' });
  const records: Awaited<ReturnType<typeof adapter.readActive>>[] = [];
  for (const key of [seeker.arkivKey, recruiter.arkivKey, incompatible.arkivKey]) records.push(await adapter.readActive(key));
  console.log(JSON.stringify({ stage: 'current-publications-verified', recordCount: records.length }));
  check(records.every(value => value.intent.demoOrigin), 'Every test record must retain its fictional provenance.');
  check(!seeker.tags.some(value => recruiter.tags.includes(value)), 'The positive paraphrase test must have no exact tag overlap.');
  const found = await api<{ candidates: Candidate[]; observedBlocks: string[]; coverage: unknown; embeddingExecution: string }>('writer', 'discover', { intentId: seeker.id, tags: seeker.tags, includeDemo: true });
  const positive = found.candidates.find(value => value.key.toLowerCase() === recruiter.arkivKey!.toLowerCase());
  check(positive?.match?.eligible && positive.match.embedding, 'The independently expected positive did not pass actual semantic retrieval. Do not change the threshold to force this test.');
  check(!found.candidates.some(value => value.key.toLowerCase() === incompatible.arkivKey!.toLowerCase()), 'The same-direction seeker must not become a hiring candidate.');
  console.log(JSON.stringify({ stage: 'live-semantic-discovery-passed', cosine: positive.match.cosine, model: positive.match.embedding.model, incompatibleDirectionExcluded: true }));
  writeFileSync('artifacts/live-discovery-evidence.json', JSON.stringify({ checkedAt: new Date().toISOString(), source: 'actual-Arkiv-and-ENS',
    publicRecords: records.map(value => ({ key: value.entityKey, owner: value.owner, intentId: value.intent.intentId, direction: value.intent.semantics.direction, observedBlock: value.observedAtBlock })),
    positiveWithoutExactTagOverlap: true, negativeSameDirectionExcluded: true, match: positive.match, queryCoverage: found.coverage, observedBlocks: found.observedBlocks }, null, 2));
  if (process.argv[2] === 'discover') return;
  const proposal = await api<{ id: string | null }>('writer', 'proposals', { intentId: seeker.id, candidateKey: recruiter.arkivKey });
  check(proposal.id, 'The real agent review did not propose this pair. This is a measured failure, not permission to fabricate a proposal.');
  console.log(JSON.stringify({ stage: 'real-agent-proposal-created', proposalId: proposal.id }));
  const disclosure = await api<{ allowed: boolean; reason: string }>('writer', `proposals/${proposal.id}/disclosure`, { fieldId: 'contact' });
  check(disclosure.allowed === false && !('value' in disclosure), 'Private contact disclosure must be denied before release.');
  // These are explicitly automated decisions from synthetic test accounts, not two verified humans.
  await api('writer', `proposals/${proposal.id}/consent`, { decision: 'approve' });
  await api('metamask', `proposals/${proposal.id}/consent`, { decision: 'approve' });
  const locked = await response('writer', `proposals/${proposal.id}/open`, {});
  check(locked.status === 503 && locked.body.error?.code === 'WORLD_PAUSED', 'The paused protected release must remain locked.');
  const current = await api<AppState>('writer', 'state');
  const saved = current.proposals.find(value => value.id === proposal.id);
  check(saved && !saved.world.verified && !saved.roomId, 'Synthetic test accounts must never acquire a World claim or protected room.');
  const evidence = { kind: 'live-two-test-account-hybrid-pipeline', checkedAt: new Date().toISOString(), durationMs: Date.now() - started,
    independentHumansVerified: false, worldPaused: true, protectedRoomOpened: false,
    publicRecords: records.map(value => ({ key: value.entityKey, owner: value.owner, intentId: value.intent.intentId, direction: value.intent.semantics.direction, observedBlock: value.observedAtBlock })),
    positiveWithoutExactTagOverlap: true, negativeSameDirectionExcluded: true, match: positive.match, queryCoverage: found.coverage,
    observedBlocks: found.observedBlocks, proposalId: proposal.id, actualCompatibility: saved.compatibility, privateContactDenied: true,
    automatedSyntheticAccountConsentCount: saved.consents.filter(value => value.decision === 'approve').length };
  writeFileSync('artifacts/live-hybrid-evidence.json', JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ passed: true, proposalId: proposal.id, durationMs: evidence.durationMs, positiveWithoutExactTagOverlap: true, negativeSameDirectionExcluded: true, worldPaused: true, protectedRoomOpened: false }));
}
async function revoked() {
  const prior = JSON.parse(readFileSync('artifacts/live-hybrid-evidence.json', 'utf8')) as { proposalId: string; publicRecords: { key: string; intentId: string }[] };
  const result = await response('writer', 'discover', { intentId: prior.publicRecords[0].intentId, includeDemo: true });
  check(result.status === 403 && result.body.error?.code === 'ENS_AUTHORITY_DENIED' && result.body.error?.message === 'delegation_revoked_or_missing', 'Revocation must be observed directly; transport failure does not count as revocation proof.');
  const disclosure = await response('metamask', `proposals/${prior.proposalId}/disclosure`, { fieldId: 'headline' });
  check(disclosure.status === 403 && disclosure.body.error?.code === 'ENS_AUTHORITY_DENIED', 'The counterpart must not bypass revoked authority through a disclosure check.');
  writeFileSync('artifacts/live-hybrid-revocation.json', JSON.stringify({ checkedAt: new Date().toISOString(), proposalId: prior.proposalId,
    discoveryDenied: result.body.error.code, disclosureDenied: disclosure.body.error.code, reason: result.body.error.message }, null, 2));
  console.log('Actual application discovery and counterpart disclosure denied the revoked ENS authority. No transport failure was counted as proof.');
}
async function metaRevoked() {
  const target = accounts.intents.find(value => value.label === 'recruiter');
  check(target, 'The reviewed MetaMask test draft must exist.');
  const result = await response('metamask', 'intent/publish', { intentId: target.id });
  check(result.status === 403 && result.body.error?.code === 'ENS_AUTHORITY_DENIED' && result.body.error?.message === 'delegation_revoked_or_missing', 'The real publication endpoint must observe revocation; an RPC failure is not revocation evidence.');
  writeFileSync('artifacts/live-meta-publication-revocation.json', JSON.stringify({ checkedAt: new Date().toISOString(), owner: '0xEE291Bc0246441F53610FbCAF2bC892110e72732',
    ensName: 'agent.crypteck.eth', intentId: target.id, httpStatus: result.status, errorCode: result.body.error.code, reason: result.body.error.message, transactionPrepared: false }, null, 2));
  console.log('Actual MetaMask account publication was denied by live ENS revocation before any signature or transaction preparation.');
}
try {
  if (process.argv[2] === 'private-test-fields') await privateFields();
  else if (process.argv[2] === 'verify') await verify();
  else if (process.argv[2] === 'discover') await verify();
  else if (process.argv[2] === 'revoked') await revoked();
  else if (process.argv[2] === 'meta-revoked') await metaRevoked();
  else throw new Error('Choose private-test-fields, verify, or revoked. These commands use only authorized fictional test accounts.');
} catch (error) { console.error(error instanceof Error ? error.message : 'The live pipeline did not pass.'); process.exitCode = 1; }

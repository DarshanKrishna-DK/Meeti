import { createHash } from 'node:crypto';
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { privateKeyToAccount } from 'viem/accounts';
import { z } from 'zod';
import { decrypt, encrypt } from '../packages/server/crypto';
import type { AppState, Intent } from '../packages/shared/src';
import { assertIntentEvidence, IntentSemanticsSchema } from '../packages/matching/src/semantics';
import { intentDigest, intentSigningMessage, PublicIntentSchema, type PublicIntent } from '../packages/arkiv/src';
import { EVENT_ORIGIN, EVENT_VAULT_CONTEXT, EVENT_VAULT_PATH, eventLabels, eventVaultSchema, type EventLabel, type EventVault } from './event-demo-accounts';
import { eventPublicDraft } from './event-demo-review';

const JOURNAL = '.local-data/event-demo-flow.enc', CONTEXT = 'meeti-event-demo-flow-v1';
const interpretationSchema = z.object({ output: z.object({ goal: z.enum(['collaborator', 'cofounder', 'mentor', 'teammate']), summary: z.string().min(1).max(1000), tags: z.array(z.string()).max(8), semantics: IntentSemanticsSchema }).strict(),
  inference: z.object({ requestId: z.string().min(1).max(200), providerRequestId: z.string().max(300).nullable(), model: z.string().min(1).max(200), inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative(), estimatedCostUsd: z.number().nonnegative(), startedAt: z.string().datetime(), completedAt: z.string().datetime() }).strict(),
}).strict();
const draftSchema = z.object({ intentId: z.string().uuid().optional(), state: z.enum(['creating', 'confirmed']), expiresAt: z.string().datetime(), bodyDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const journalSchema = z.object({ version: z.literal(1), origin: z.literal(EVENT_ORIGIN), sourceDigest: z.string().regex(/^[a-f0-9]{64}$/),
  attempts: z.array(z.object({ label: z.enum(eventLabels), state: z.enum(['reserved', 'accepted', 'failed_or_unknown']), startedAt: z.string().datetime() }).strict()).max(2),
  interpretations: z.object({ krishna: interpretationSchema.optional(), viha: interpretationSchema.optional() }).strict(),
  drafts: z.object({ krishna: draftSchema.optional(), viha: draftSchema.optional() }).strict(),
  previews: z.object({ krishna: PublicIntentSchema.optional(), viha: PublicIntentSchema.optional() }).strict(),
}).strict();
type Journal = z.infer<typeof journalSchema>;
type Stage = 'inspect' | 'interpret' | 'draft' | 'preview';
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value) ?? 'undefined').digest('hex');
export class EventFlowError extends Error { constructor(readonly code: string) { super(code); } }
function requireValue(value: unknown, code: string): asserts value { if (!value) throw new EventFlowError(code); }
export function eventFlowSource(vault: EventVault) {
  const records = eventLabels.map(label => { const wallet = vault.wallets.find(item => item.label === label); requireValue(wallet?.accountId && wallet.profileConfirmedAt, 'EVENT_CREATED_ACCOUNTS_REQUIRED'); return { label, accountId: wallet.accountId, owner: privateKeyToAccount(wallet.ownerKey).address, delegate: privateKeyToAccount(wallet.delegateKey).address, ensAgentRef: `networking.event-${label}.users.meeti-demo.eth`, text: eventPublicDraft(label) }; });
  requireValue(new Set(records.map(record => record.accountId)).size === 2 && new Set(records.flatMap(record => [record.owner.toLowerCase(), record.delegate.toLowerCase()])).size === 4, 'EVENT_ACCOUNTS_AND_KEYS_MUST_BE_DISTINCT');
  return { origin: EVENT_ORIGIN, records };
}
export function eventInterpretationReview(journal: Journal) {
  requireValue(eventLabels.every(label => journal.interpretations[label]), 'BOTH_ACTUAL_INTERPRETATIONS_REQUIRED');
  const records = eventLabels.map(label => ({ label, source: eventPublicDraft(label), ...journal.interpretations[label]! }));
  return { version: 1, origin: EVENT_ORIGIN, sourceDigest: journal.sourceDigest, fictional: true, humanVerified: false, records };
}

/** Only these explicit stages are reachable. No public signing, chain RPC or discovery action is exposed. */
export async function runEventFlow(stage: Stage, vaultInput: EventVault, input: { journal?: Journal; save: (journal: Journal) => void; allowModelCalls?: 2; expectedInterpretationDigest?: string; fetcher?: typeof fetch }) {
  requireValue(['inspect', 'interpret', 'draft', 'preview'].includes(stage), 'EVENT_FLOW_STAGE_INVALID');
  const vault = eventVaultSchema.parse(vaultInput), source = eventFlowSource(vault), sourceDigest = digest(source), fetcher = input.fetcher || fetch;
  const journal = journalSchema.parse(input.journal || { version: 1, origin: EVENT_ORIGIN, sourceDigest, attempts: [], interpretations: {}, drafts: {}, previews: {} });
  requireValue(journal.sourceDigest === sourceDigest && new Set(journal.attempts.map(attempt => attempt.label)).size === journal.attempts.length, 'EVENT_JOURNAL_SOURCE_OR_ATTEMPTS_CHANGED');
  requireValue(eventLabels.every(label => !journal.interpretations[label] || journal.attempts.some(attempt => attempt.label === label && attempt.state === 'accepted')), 'EVENT_INTERPRETATION_LEDGER_MISSING');
  async function api<T>(label: EventLabel, path: 'state' | 'intent/structure' | 'intent' | 'intent/publish', body?: unknown) {
    const wallet = vault.wallets.find(item => item.label === label)!;
    requireValue(/^meeti_session=[a-f0-9]{64}$/.test(wallet.session || ''), 'EVENT_SESSION_REAUTHENTICATION_REQUIRED');
    const response = await fetcher(`${EVENT_ORIGIN}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(240000),
      headers: { origin: EVENT_ORIGIN, cookie: wallet.session!, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    requireValue(response.ok, `EVENT_FLOW_HTTP_${response.status}`);
    const result = await response.json(); requireValue(result && 'data' in result && !result.error, 'EVENT_FLOW_RESPONSE_INVALID'); return result.data as T;
  }
  async function state(label: EventLabel) {
    const expected = source.records.find(record => record.label === label)!, current = await api<AppState>(label, 'state');
    requireValue(current.user.id === expected.accountId && current.user.wallet?.toLowerCase() === expected.owner.toLowerCase(), 'EVENT_OWNER_ACCOUNT_CHANGED');
    requireValue(current.integrations?.world.status === 'deferred', 'EVENT_WORLD_MUST_REMAIN_PAUSED');
    if (stage !== 'inspect') requireValue(current.agent && current.agent.ensName === expected.ensAgentRef && current.agent.owner.toLowerCase() === expected.owner.toLowerCase() && current.agent.delegate.toLowerCase() === expected.delegate.toLowerCase() && current.agent.policy.purpose === 'collaborator' && !current.agent.policy.paused && Date.parse(current.agent.policy.expiresAt) > Date.now(), 'EVENT_CONFIRMED_IMPORTED_AGENT_REQUIRED');
    return current;
  }
  if (stage === 'inspect') {
    const accounts = [];
    for (const label of eventLabels) { const current = await state(label); accounts.push({ label, accountId: current.user.id, agentName: current.agent?.ensName || null, intents: current.intents.map(intent => ({ id: intent.id, version: intent.version, status: intent.status, arkivKey: intent.arkivKey || null, transactionHash: intent.transactionHash || null })) }); }
    return { journal, report: { stage, origin: EVENT_ORIGIN, accounts, attempts: journal.attempts, interpretationDigest: eventLabels.every(label => journal.interpretations[label]) ? digest(eventInterpretationReview(journal)) : null, publicSignatures: 0, broadcasts: 0, newModelCalls: 0 } };
  }
  let newModelCalls = 0;
  if (stage === 'interpret') {
    requireValue(input.allowModelCalls === 2, 'EVENT_INTERPRETATION_REQUIRES_EXPLICIT_TWO_CALL_LIMIT');
    for (const label of eventLabels) {
      const existing = journal.interpretations[label]; if (existing) continue;
      requireValue(!journal.attempts.some(attempt => attempt.label === label) && journal.attempts.length < 2, 'EVENT_UNCERTAIN_INTERPRETATION_STOP_NO_RETRY');
      const current = await state(label); requireValue(current.profile.aiConsent === true, 'EVENT_FICTIONAL_PROVIDER_CONSENT_REQUIRED');
      const attempt = { label, state: 'reserved' as 'reserved' | 'accepted' | 'failed_or_unknown', startedAt: new Date().toISOString() }; journal.attempts.push(attempt); input.save(journal);
      try {
        newModelCalls++;
        const actual = interpretationSchema.parse(await api(label, 'intent/structure', { text: eventPublicDraft(label), providerDisclosureConsent: true }));
        requireValue(actual.output.summary === eventPublicDraft(label), 'EVENT_INTERPRETATION_CHANGED_APPROVED_TEXT');
        assertIntentEvidence(eventPublicDraft(label), actual.output.semantics);
        requireValue(!Object.values(journal.interpretations).some(previous => previous?.inference.requestId === actual.inference.requestId), 'EVENT_DUPLICATE_INFERENCE_RECEIPT');
        journal.interpretations[label] = actual; attempt.state = 'accepted'; input.save(journal);
      } catch (error) { attempt.state = 'failed_or_unknown'; input.save(journal); throw error; }
    }
    const review = eventInterpretationReview(journal);
    return { journal, report: { stage, review, interpretationDigest: digest(review), newModelCalls, lifetimeModelAttempts: journal.attempts.length, publicSignatures: 0, broadcasts: 0 } };
  }
  const interpretationReview = eventInterpretationReview(journal);
  requireValue(input.expectedInterpretationDigest === digest(interpretationReview), 'EXACT_EVENT_INTERPRETATION_OWNER_REVIEW_REQUIRED');
  for (const label of eventLabels) {
    const actual = journal.interpretations[label]!, interpreted = actual.output, current = await state(label);
    requireValue(interpreted.goal === 'collaborator' && interpreted.semantics.category === 'collaborator' && interpreted.semantics.direction === 'collaborating' && interpreted.semantics.clarificationQuestions.length === 0 && interpreted.tags.length > 0, 'EVENT_OWNER_CLARIFICATION_OR_REVIEW_REQUIRED');
    let saved = journal.drafts[label];
    if (saved) requireValue(saved.bodyDigest === digest({ ...interpreted, expiresAt: saved.expiresAt, publicApproved: true, demoOrigin: true }), 'EVENT_DRAFT_BODY_BINDING_CHANGED');
    const matching = current.intents.filter(intent => intent.summary === eventPublicDraft(label) && intent.demoOrigin && digest(intent.semantics) === digest(interpreted.semantics));
    requireValue(matching.length <= 1, 'MULTIPLE_EVENT_BACKEND_DRAFTS_REQUIRE_REVIEW');
    if (saved?.state === 'creating') {
      const recovered = matching.find(intent => intent.status === 'draft' && intent.expiresAt === saved!.expiresAt);
      requireValue(recovered, 'EVENT_DRAFT_OUTCOME_UNCERTAIN_READ_ONLY_RECOVERY_REQUIRED'); saved.intentId = recovered.id; saved.state = 'confirmed'; input.save(journal);
    }
    if (!saved && stage === 'draft') {
      const existing = matching[0]; requireValue(!existing || existing.status === 'draft', 'EVENT_ALREADY_PUBLIC_REQUIRES_RECEIPT_RECONCILIATION');
      const expiresAt = existing?.expiresAt || new Date(Date.now() + 86400000).toISOString();
      const body = { ...interpreted, expiresAt, publicApproved: true, demoOrigin: true };
      saved = { state: existing ? 'confirmed' : 'creating', expiresAt, bodyDigest: digest(body), ...(existing ? { intentId: existing.id } : {}) }; journal.drafts[label] = saved; input.save(journal);
      if (!existing) { const draft = await api<Intent>(label, 'intent', body); requireValue(draft.summary === body.summary && digest(draft.semantics) === digest(body.semantics) && draft.status === 'draft' && draft.demoOrigin && draft.expiresAt === expiresAt, 'EVENT_BACKEND_DRAFT_READBACK_INVALID'); saved.intentId = z.string().uuid().parse(draft.id); saved.state = 'confirmed'; input.save(journal); }
    }
    requireValue(saved?.state === 'confirmed' && saved.intentId, 'EVENT_DRAFT_STAGE_REQUIRED');
    const readback = (await state(label)).intents.find(intent => intent.id === saved!.intentId);
    requireValue(readback?.status === 'draft' && readback.expiresAt === saved.expiresAt && readback.summary === interpreted.summary && readback.goal === 'collaborator' && readback.policyVersion === current.agent!.policy.version && digest(readback.semantics) === digest(interpreted.semantics) && Date.parse(readback.expiresAt) > Date.now() && Date.parse(readback.expiresAt) - Date.parse(readback.createdAt) <= 86400000, 'EVENT_DRAFT_EDITED_EXPIRED_OR_PUBLISHED');
    if (stage === 'preview') {
      // No signature is supplied. This API only returns the actual ENS-authorized public payload.
      const preview = await api<{ intent: PublicIntent; signingMessage: string }>(label, 'intent/publish', { intentId: saved.intentId }), payload = PublicIntentSchema.parse(preview.intent), expected = source.records.find(record => record.label === label)!;
      requireValue(payload.intentId === saved.intentId && payload.ensAgentRef === expected.ensAgentRef && payload.owner.toLowerCase() === expected.owner.toLowerCase() && payload.goal === 'collaborator' && payload.summary === expected.text && payload.demoOrigin && payload.status === 'active' && payload.optIn && payload.expiresAt === saved.expiresAt && preview.signingMessage === intentSigningMessage(payload), 'EVENT_ACTUAL_PUBLIC_PREVIEW_CHANGED');
      journal.previews[label] = payload; input.save(journal);
    }
  }
  const records = eventLabels.map(label => ({ label, accountId: source.records.find(record => record.label === label)!.accountId, intentId: journal.drafts[label]!.intentId,
    ...(journal.previews[label] ? { intent: journal.previews[label], payloadDigest: intentDigest(journal.previews[label]!), signingMessage: intentSigningMessage(journal.previews[label]!) } : {}), inference: journal.interpretations[label]!.inference }));
  return { journal, report: { version: 1, stage, origin: EVENT_ORIGIN, fictional: true, humanVerified: false, reviewOnly: true,
    status: stage === 'preview' ? 'EXACT_UNSIGNED_ARKIV_PUBLIC_PAYLOAD_REVIEW' : 'REAL_PRIVATE_BACKEND_DRAFTS_CONFIRMED', records,
    lifetimeModelAttempts: journal.attempts.length, newModelCalls: 0, publicSignatures: 0, broadcasts: 0,
    note: 'The final publication fee/funding envelopes and fresh chain/ENS checks require a separate bounded publication review. Expiry does not erase downloaded copies.' } };
}

async function main() {
  const stage = process.argv[2] as Stage;
  requireValue(['inspect', 'interpret', 'draft', 'preview'].includes(stage), 'CHOOSE_EVENT_INSPECT_INTERPRET_DRAFT_OR_PREVIEW');
  requireValue(process.argv.slice(3).every(value => value === '--allow-model-calls=2' || /^--expected-interpretation-digest=[a-f0-9]{64}$/.test(value)), 'EVENT_FLOW_UNSUPPORTED_ARGUMENT');
  const lockPath = '.local-data/event-demo-flow.lock', lock = openSync(lockPath, 'wx', 0o600);
  try {
    const vault = eventVaultSchema.parse(decrypt<unknown>(readFileSync(EVENT_VAULT_PATH, 'utf8'), EVENT_VAULT_CONTEXT));
    const journal = existsSync(JOURNAL) ? journalSchema.parse(decrypt<unknown>(readFileSync(JOURNAL, 'utf8'), CONTEXT)) : undefined;
    const save = (value: Journal) => { const ciphertext = encrypt(value, CONTEXT), temporary = `${JOURNAL}.tmp`; writeFileSync(temporary, ciphertext, { mode: 0o600 }); const fd = openSync(temporary, 'r+'); try { fsyncSync(fd); } finally { closeSync(fd); } renameSync(temporary, JOURNAL); requireValue(readFileSync(JOURNAL, 'utf8') === ciphertext, 'EVENT_FLOW_JOURNAL_NOT_DURABLE'); };
    const result = await runEventFlow(stage, vault, { journal, save, allowModelCalls: process.argv.includes('--allow-model-calls=2') ? 2 : undefined, expectedInterpretationDigest: process.argv.find(value => value.startsWith('--expected-interpretation-digest='))?.split('=')[1] });
    mkdirSync('artifacts', { recursive: true }); writeFileSync(`artifacts/event-demo-flow-${stage}.json`, JSON.stringify(result.report, null, 2));
    console.log(JSON.stringify(result.report, null, 2));
  } finally { closeSync(lock); unlinkSync(lockPath); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main().catch(error => { console.error(JSON.stringify({ code: error instanceof EventFlowError ? error.code : 'EVENT_FLOW_STOPPED_PRESERVE_JOURNAL_NO_PRIVATE_DIAGNOSTICS' })); process.exitCode = 1; });

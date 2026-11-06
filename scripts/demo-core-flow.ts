import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { extname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { privateKeyToAccount } from 'viem/accounts';
import { parseSiweMessage } from 'viem/siwe';
import { decrypt, encrypt, hash } from '../packages/server/crypto';
import type { AppState, Candidate, ContextDocument, Intent } from '../packages/shared/src';
import type { IntentSemantics } from '../packages/matching/src/semantics';
import type { InferenceReceipt } from '../packages/agents/src';
import { PublicIntentSchema, intentSigningMessage, type PublicIntent } from '../packages/arkiv/src';
import { availabilitySchema, normalizeAvailability, overlappingSlots, type MeetingSlot } from '../packages/server/meeting-time';
import { DemoAuthError, demoTarget, reauthenticateDemoAccounts, type DemoAuthBinding } from './demo-auth-only';
import { db as privateStore, closeStore } from '../packages/server/store';

// Operator-controlled fictional accounts use the real HTTP API. This driver never signs
// chain transactions, publishes records, inserts database rows, or bypasses World.
type Label = 'demo-seeker' | 'demo-recruiter';
type Case = 'job' | 'collaboration';
type Mode = 'reauthenticate' | 'poll-task' | 'setup' | 'prepare-publications' | 'discover' | 'qualify' | 'answer' | 'resume' | 'retry' | 'consent' | 'meeting' | 'meeting-plan' | 'inspect';
type Vault = { version: 1; wallets: { label: string; privateKey: `0x${string}` }[] };
type Prepared = { inputHash: string; interpretation: { output: { goal: Intent['goal']; summary: string; tags: string[]; semantics: IntentSemantics }; inference: InferenceReceipt }; intentId?: string; publicPreview?: PublicIntent };
type Discovery = { candidates: Candidate[]; source: 'arkiv'; mode: 'semantic'; embeddingExecution: string; coverage: unknown; observedBlocks: string[] };
type Qualification = { id: string; version: number; state: string; otherEns: string; stopReason: string; failureCode: string | null; canRetry: boolean; proposalId: string | null; messages: { id: string; createdAt: string }[]; questions: { id: string; question: string; answered: boolean }[] };
type Progress = { version: 1; origin: string; sessions: Partial<Record<Label, string>>; accounts: Partial<Record<Label, string>>;
  prepared: Partial<Record<`${Case}:${Label}`, Prepared>>; discovery: Partial<Record<`${Case}:${Label}`, Discovery>>;
  qualifications: Partial<Record<Case, { qualificationId: string; id: string | null }>>; pending?: { step: string; startedAt: string; origin?: string; taskId?: string; label?: Label; case?: Case };
  hostedAuth?: Record<string, DemoAuthBinding>; taskHistory?: { taskId: string; step: string; origin: string; status: string }[];
  answerReceipts?: Record<string, { inputDigest: string; recordedAt: string }>; meetingGateEvidence?: { proposalId: string; version: number; code: 'WORLD_PAUSED'; checkedAt: string } };
type MeetingView = Awaited<ReturnType<typeof import('../packages/server/meetings').meetingDto>>;
const labelSchema = z.enum(['demo-seeker', 'demo-recruiter']);
const digestSchema = z.string().regex(/^[0-9a-f]{64}$/);
const answerFileSchema = z.object({ fictional: z.literal(true), qualificationId: z.string().uuid(),
  answers: z.array(z.object({ label: labelSchema, questionId: z.string().uuid(), text: z.string().trim().min(1).max(1200),
    fieldClass: z.enum(['bio', 'seeking', 'offering']), providerDisclosureConsent: z.literal(true), shareWithCounterpart: z.literal(true) }).strict()).min(1).max(8) }).strict();
const meetingFileSchema = z.object({ fictional: z.literal(true), proposalId: z.string().uuid(), proposalDigest: digestSchema,
  availability: z.object({ 'demo-seeker': availabilitySchema, 'demo-recruiter': availabilitySchema }).strict(), confirmFirstOverlap: z.literal(true) }).strict();
const mode = process.argv[2] as Mode;
const option = (name: string, fallback: string) => { const index = process.argv.indexOf(name); return index < 0 ? fallback : process.argv[index + 1]; };
const selectedCase = option('--case', 'job') as Case;
const requestTimeoutMs = Number(process.env.DEMO_HTTP_TIMEOUT_MS || 240000);
let origin = '', explicitTarget = false;
const statePath = '.local-data/demo-core-flow.enc', stateContext = 'meeti-demo-core-flow-v1';
const labels: Label[] = ['demo-seeker', 'demo-recruiter'];
const cases: Record<Case, Record<Label, string>> = {
  job: {
    'demo-seeker': 'Fictional TEST DATA. I am seeking a DevRel job. I offer technical writing, developer workshops, and API documentation. I prefer remote work. I want to help developers understand software tools.',
    'demo-recruiter': 'Fictional TEST DATA. I am hiring a developer advocacy professional for a remote role. The work includes explaining SDKs, teaching programmers, and improving integration guides. I offer a developer education role.',
  },
  collaboration: {
    'demo-seeker': 'Fictional TEST DATA. I want to collaborate on a developer education workshop. I offer technical writing and documentation. I am looking for a collaborator who enjoys presenting live coding examples.',
    'demo-recruiter': 'Fictional TEST DATA. I want to collaborate on a workshop teaching developers how to use software tools. I offer live coding demonstrations and workshop facilitation. I would like a collaborator who writes learning guides.',
  },
};
let progress: Progress;
let lockOwned = false;
class DemoError extends Error { constructor(readonly code: string) { super(code); } }
function save() {
  mkdirSync('.local-data', { recursive: true });
  const temporary = `${statePath}.tmp`;
  writeFileSync(temporary, encrypt(progress, stateContext), { mode: 0o600 }); renameSync(temporary, statePath);
}
function summary(value: unknown) { console.log(JSON.stringify(value, null, 2)); }
async function call<T>(label: Label, path: string, body?: unknown, timeoutMs = requestTimeoutMs): Promise<{ data: T; response: Response }> {
  if (!/^[a-zA-Z0-9_/-]+$/.test(path) || path.includes('..')) throw new DemoError('UNSAFE_API_PATH');
  const session = explicitTarget ? progress.hostedAuth?.[origin]?.sessions[label] : progress.sessions[label];
  if (explicitTarget && !session && path !== 'health') throw new DemoError('EXPLICIT_REAUTHENTICATION_REQUIRED');
  const response = await fetch(`${origin}/api/${path}`, { method: body === undefined ? 'GET' : 'POST', redirect: 'error', signal: AbortSignal.timeout(timeoutMs),
    headers: { origin, 'content-type': 'application/json', ...(session ? { cookie: session } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json() as { data: T; error?: { code: string; message?: string } };
  if (!response.ok) {
    if (explicitTarget && response.status === 401) throw new DemoError('EXPLICIT_REAUTHENTICATION_REQUIRED');
    const safeOutputReasons: Record<string, string> = {
      'The AI provider response did not match the required completion schema.': 'COMPLETION_SCHEMA',
      'The AI provider did not return a complete structured result.': 'INCOMPLETE_RESULT',
      'The AI result did not match the required task schema.': 'TASK_SCHEMA',
      'Intent extraction cited text that was not supplied.': 'UNSUPPORTED_QUOTE',
      'A known intent category and direction require quoted evidence.': 'MISSING_EVIDENCE',
      'An ambiguous essential intent needs clarification before matching.': 'MISSING_CLARIFICATION',
    };
    const detail = result.error?.code === 'AI_OUTPUT' ? safeOutputReasons[result.error.message || ''] : undefined;
    throw new DemoError(`HTTP_${response.status}_${String(result.error?.code || 'REQUEST_FAILED').replace(/[^A-Za-z0-9_]/g, '').slice(0, 100)}${detail ? `_${detail}` : ''}`);
  }
  if (response.status === 202 && body !== undefined && (path === 'proposals' || /^qualifications\/[0-9a-f-]+\/(resume|retry)$/.test(path))) {
    const task = z.object({ taskId: z.string().uuid(), status: z.enum(['queued', 'running']) }).passthrough().parse(result.data);
    if (!progress.pending) throw new DemoError('TASK_REQUIRES_DURABLE_PENDING_REQUEST');
    progress.pending = { ...progress.pending, origin, taskId: task.taskId, label }; save();
    return await pollTask<T>(label, task.taskId);
  }
  return { data: result.data, response };
}
async function pollTask<T>(label: Label, taskId: string): Promise<{ data: T; response: Response }> {
  labelSchema.parse(label); z.string().uuid().parse(taskId);
  const duration = Number(process.env.DEMO_TASK_POLL_TIMEOUT_MS || 600000);
  if (!Number.isInteger(duration) || duration < 1000 || duration > 1200000) throw new DemoError('TASK_POLL_TIMEOUT_MUST_BE_AT_MOST_TWENTY_MINUTES');
  const deadline = Date.now() + duration;
  while (Date.now() < deadline) {
    const value = await call<{ taskId: string; status: string; result?: unknown; error?: { code?: string } }>(label, `agent-tasks/${taskId}`, undefined, Math.min(requestTimeoutMs, Math.max(1000, deadline - Date.now())));
    if (value.data.taskId !== taskId) throw new DemoError('TASK_READBACK_MISMATCH');
    if (value.data.status === 'completed') {
      const result = z.object({ id: z.string().uuid().nullable(), qualificationId: z.string().uuid() }).strict().parse(value.data.result);
      return { data: result as T, response: value.response };
    }
    if (['failed', 'interrupted', 'expired'].includes(value.data.status)) throw new DemoError(`AGENT_TASK_${value.data.status.toUpperCase()}`);
    if (!['queued', 'running'].includes(value.data.status)) throw new DemoError('TASK_STATUS_INVALID');
    await new Promise(resolve => setTimeout(resolve, Math.min(1000, Math.max(0, deadline - Date.now()))));
  }
  throw new DemoError('TASK_POLL_TIMEOUT_POINTER_PRESERVED');
}
async function pollSavedTask() {
  const pending = progress.pending;
  if (!pending?.taskId || !pending.label || pending.origin !== origin || pending.case !== selectedCase) throw new DemoError('MATCHING_SAVED_TASK_POINTER_REQUIRED');
  const result = await pollTask<{ id: string | null; qualificationId: string }>(pending.label, pending.taskId);
  progress.qualifications[selectedCase] = result.data; delete progress.pending; save();
  summary({ completed: true, mode: 'poll-task', taskId: pending.taskId, case: selectedCase, result: result.data, newActionEnqueued: false });
}
function cookie(response: Response, name: string) {
  const value = response.headers.getSetCookie().find(header => header.startsWith(`${name}=`));
  if (!value) throw new DemoError('SESSION_COOKIE_MISSING'); return value.split(';')[0];
}
async function authenticate(label: Label, key: `0x${string}`) {
  const signer = privateKeyToAccount(key);
  if (progress.sessions[label]) {
    try { const current = (await call<AppState>(label, 'state')).data;
      if (current.user.wallet?.toLowerCase() !== signer.address.toLowerCase() || progress.accounts[label] && current.user.id !== progress.accounts[label]) throw new DemoError('SAVED_ACCOUNT_MISMATCH');
      return;
    } catch (error) { if (!(error instanceof DemoError) || !error.code.startsWith('HTTP_401_')) throw error; }
  }
  const challenge = await call<{ id: string; message: string; chainId: number; address: string }>(label, 'auth/wallet/challenge', { address: signer.address, chainId: 11155111 });
  const parsed = parseSiweMessage(challenge.data.message);
  if (challenge.data.chainId !== 11155111 || challenge.data.address.toLowerCase() !== signer.address.toLowerCase()
    || parsed.domain !== new URL(origin).host || parsed.uri !== origin || parsed.chainId !== 11155111 || parsed.address?.toLowerCase() !== signer.address.toLowerCase()
    || parsed.requestId !== challenge.data.id || !parsed.expirationTime || parsed.expirationTime.getTime() <= Date.now()
    || !challenge.data.message.includes('This signature does not authorize transactions or public disclosure.')) throw new DemoError('UNEXPECTED_AUTH_CHALLENGE');
  progress.sessions[label] = cookie(challenge.response, 'meeti_wallet_flow');
  const signature = await signer.signMessage({ message: challenge.data.message });
  const verified = await call<{ id: string; wallet: string }>(label, 'auth/wallet/verify', { id: challenge.data.id, signature });
  if (progress.accounts[label] && verified.data.id !== progress.accounts[label]) throw new DemoError('RECOVERED_ACCOUNT_CHANGED');
  progress.sessions[label] = cookie(verified.response, 'meeti_session'); progress.accounts[label] = verified.data.id; save();
}
async function metered<T>(step: string, action: () => Promise<T>, commit: (result: T) => void): Promise<T> {
  if (!process.argv.includes('--allow-provider')) throw new DemoError('PROVIDER_EXECUTION_REQUIRES_ALLOW_PROVIDER_AND_CONTROLLED_SERVER_BUDGET');
  const requests = Number(process.env.AI_MAX_REQUESTS), cost = Number(process.env.AI_MAX_COST_USD);
  if (!Number.isInteger(requests) || requests < 1 || requests > 24 || !Number.isFinite(cost) || cost <= 0 || cost > 0.05) throw new DemoError('REQUIRE_AI_MAX_REQUESTS_AT_MOST_24_AND_AI_MAX_COST_USD_AT_MOST_0_05');
  if (progress.pending?.taskId) {
    const pending = progress.pending;
    if (pending.origin !== origin || !pending.label || !pending.taskId) throw new DemoError('PENDING_TASK_ORIGIN_MISMATCH');
    if (pending.step === step && !process.argv.includes('--retry-uncertain')) {
      const result = await pollTask(pending.label, pending.taskId) as T;
      commit(result); delete progress.pending; save(); return result;
    }
    const task = (await call<{ status: string }>(pending.label, `agent-tasks/${pending.taskId}`)).data;
    if (!process.argv.includes('--retry-uncertain') || !['failed', 'interrupted', 'expired'].includes(task.status)) throw new DemoError('PREVIOUS_TASK_MUST_BE_RESOLVED_BEFORE_NEW_ACTION');
    progress.taskHistory = [...(progress.taskHistory || []), { taskId: pending.taskId, step: pending.step, origin, status: task.status }].slice(-20);
    delete progress.pending; save();
  }
  if (progress.pending && !process.argv.includes('--retry-uncertain')) throw new DemoError('UNCERTAIN_PREVIOUS_PROVIDER_CALL_INSPECT_BEFORE_RETRY');
  progress.pending = { step, startedAt: new Date().toISOString(), origin, case: selectedCase }; save();
  const result = await action(); commit(result); delete progress.pending; save(); return result;
}
function expectedName(label: Label) { return `networking.${label}.users.meeti-demo.eth`; }
async function setup(label: Label) {
  const current = (await call<AppState>(label, 'state')).data;
  const displayName = `Fictional TEST DATA ${label}`;
  if (current.profile.displayName && current.profile.displayName !== displayName) throw new DemoError('REFUSE_TO_OVERWRITE_NON_DEMO_PROFILE');
  if (!current.profile.displayName) await call(label, 'profile', { ...current.profile, displayName, headline: 'Fictional developer education participant',
    bio: 'Fictional TEST DATA for the Meeti networking integration demo. No professional credentials are claimed.', seeking: 'Developer education connections', offering: 'Documentation and workshops',
    contact: '', employer: '', roles: [], skills: [], interests: ['Developer education'], goals: [], location: '', timezone: 'Asia/Kolkata', languages: ['English'], availability: '',
    collaborationMode: 'remote', contextSharing: 'private-agent', socialLinks: [], publicFields: [], aiConsent: true });
  const files = (await call<ContextDocument[]>(label, 'context/files')).data;
  if (!files.some(file => file.name === `${label}-context.txt`)) await call(label, 'context/files', { name: `${label}-context.txt`, title: 'Fictional private demo notes', description: 'Private test reference. No counterpart or public sharing is approved.',
    mimeType: 'text/plain', contentBase64: Buffer.from('Fictional TEST DATA. Private reference for this generated account. No contact details or real resume.').toString('base64') });
  if (process.argv.includes('--profile-only')) return;
  const manifest = z.object({ version: z.literal(1), fictional: z.literal(true), humanVerified: z.literal(false),
    delegates: z.array(z.object({ label: labelSchema, owner: z.string().regex(/^0x[0-9a-fA-F]{40}$/), address: z.string().regex(/^0x[0-9a-fA-F]{40}$/) })).length(2),
  }).parse(JSON.parse(readFileSync('artifacts/demo-delegates.json', 'utf8')));
  if (new Set(manifest.delegates.map(item => item.label)).size !== 2 || new Set(manifest.delegates.map(item => item.address.toLowerCase())).size !== 2) throw new DemoError('DELEGATE_MANIFEST_NOT_DISTINCT');
  const binding = manifest.delegates.find(item => item.label === label);
  if (!binding || binding.owner.toLowerCase() !== current.user.wallet?.toLowerCase() || binding.address.toLowerCase() === binding.owner.toLowerCase()) throw new DemoError('DELEGATE_OWNER_BINDING_MISMATCH');
  const delegate = binding.address;
  if (current.agent) {
    if (current.agent.ensName !== expectedName(label) || current.agent.delegate.toLowerCase() !== delegate.toLowerCase()) throw new DemoError('EXISTING_AGENT_IDENTITY_MISMATCH');
    await call(label, 'agent/check', {});
  } else {
    const preview = (await call<{ policyDigest: string; ensName: string; owner: string; delegate: string }>(label, 'agent/import/preview', { ensName: expectedName(label), delegate })).data;
    if (preview.ensName !== expectedName(label) || preview.owner.toLowerCase() !== current.user.wallet?.toLowerCase() || preview.delegate.toLowerCase() !== delegate.toLowerCase()) throw new DemoError('IMPORT_PREVIEW_MISMATCH');
    await call(label, 'agent/import', { ensName: preview.ensName, delegate, reviewedDigest: preview.policyDigest });
  }
}
async function prepare(label: Label) {
  const key = `${selectedCase}:${label}` as const, text = cases[selectedCase][label];
  const current = (await call<AppState>(label, 'state')).data;
  if (!current.agent) throw new DemoError('RUN_SETUP_FIRST');
  let prepared = progress.prepared[key];
  if (prepared && prepared.inputHash !== hash(text)) throw new DemoError('PREVIOUS_INPUT_CHANGED_REVIEW_EXISTING_DRAFT');
  if (!prepared) {
    await metered(`interpret:${key}`, () => call<Prepared['interpretation']>(label, 'intent/structure', { text, providerDisclosureConsent: true }),
      result => { progress.prepared[key] = { inputHash: hash(text), interpretation: result.data }; });
    prepared = progress.prepared[key]!;
  }
  const interpreted = prepared.interpretation.output;
  if (interpreted.semantics.direction === 'unknown' || interpreted.semantics.clarificationQuestions.length) throw new DemoError('OWNER_CLARIFICATION_REQUIRED_REVIEW_ENCRYPTED_PROGRESS');
  if (interpreted.goal !== current.agent.policy.purpose) throw new DemoError('ACTUAL_EXTRACTED_CATEGORY_REQUIRES_DIFFERENT_ENS_POLICY');
  if (!prepared.intentId) {
    const existing = current.intents.filter(intent => intent.summary === text && intent.demoOrigin && intent.semantics);
    if (existing.length > 1) throw new DemoError('MULTIPLE_EXISTING_DEMO_DRAFTS_REQUIRE_REVIEW');
    const draft = existing[0] || (await call<Intent>(label, 'intent', { ...interpreted, expiresAt: new Date(Date.now() + 86400000).toISOString(), publicApproved: true, demoOrigin: true })).data;
    prepared.intentId = draft.id; save();
  }
  const existing = current.intents.find(intent => intent.id === prepared.intentId);
  if (existing?.status === 'published' && prepared.publicPreview) {
    if (existing.version !== prepared.publicPreview.version || existing.summary !== prepared.publicPreview.summary || !existing.arkivKey || !existing.transactionHash) throw new DemoError('PUBLISHED_INTENT_CHANGED_REVIEW_CURRENT_RECORD');
    return;
  }
  // No publication signature is supplied. The API returns its actual current ENS-authorized public payload.
  const preview = (await call<{ intent: PublicIntent; signingMessage: string }>(label, 'intent/publish', { intentId: prepared.intentId })).data;
  const payload = PublicIntentSchema.parse(preview.intent);
  if (preview.signingMessage !== intentSigningMessage(payload)) throw new DemoError('PUBLIC_PREVIEW_SIGNING_MESSAGE_MISMATCH');
  prepared.publicPreview = payload; save();
}
async function discover(label: Label) {
  const key = `${selectedCase}:${label}` as const, prepared = progress.prepared[key]; if (!prepared?.intentId) throw new DemoError('PREPARE_PUBLICATIONS_FIRST');
  const current = (await call<AppState>(label, 'state')).data, intent = current.intents.find(intent => intent.id === prepared.intentId);
  if (!intent || intent.status !== 'published' || !intent.arkivKey) throw new DemoError('CONFIRMED_ARKIV_PUBLICATION_REQUIRED');
  const result = await metered(`discover:${key}`, () => call<Discovery>(label, 'discover', { intentId: intent.id, includeDemo: true }),
    result => { progress.discovery[key] = result.data; });
  if (result.data.source !== 'arkiv' || result.data.mode !== 'semantic') throw new DemoError('UNEXPECTED_DISCOVERY_SOURCE');
  progress.discovery[key] = result.data; save();
}
async function qualify() {
  const source = progress.prepared[`${selectedCase}:demo-seeker`], discovery = progress.discovery[`${selectedCase}:demo-seeker`];
  if (!source?.intentId || !discovery) throw new DemoError('RUN_DISCOVER_FIRST');
  const candidateKey = option('--candidate-key', '');
  if (!/^0x[0-9a-fA-F]{64}$/.test(candidateKey)) throw new DemoError('SELECT_AN_ACTUAL_DISCOVERED_CANDIDATE_KEY');
  const candidate = discovery.candidates.find(candidate => candidate.key.toLowerCase() === candidateKey.toLowerCase());
  if (!candidate?.match?.eligible) throw new DemoError('CANDIDATE_NOT_IN_ELIGIBLE_DISCOVERY_RESULT');
  if (progress.qualifications[selectedCase]) return;
  const result = await metered(`qualify:${selectedCase}:${candidateKey}`, () => call<{ id: string | null; qualificationId: string }>('demo-seeker', 'proposals', { intentId: source.intentId, candidateKey }),
    result => { progress.qualifications[selectedCase] = result.data; });
  progress.qualifications[selectedCase] = result.data; save();
}
function reviewedFile<T>(flag: string, schema: z.ZodType<T>): T {
  const input = option(flag, ''); if (!input) throw new DemoError('REVIEWED_LOCAL_JSON_FILE_REQUIRED');
  const path = resolve(input), within = relative(process.cwd(), path);
  if (within.startsWith('..') || isAbsolute(within) || resolve(process.cwd(), within) !== path || extname(path) !== '.json') throw new DemoError('REVIEW_FILE_MUST_BE_WORKSPACE_JSON');
  const metadata = lstatSync(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 32768) throw new DemoError('REVIEW_FILE_MUST_BE_REGULAR_AND_AT_MOST_32_KIB');
  const bytes = readFileSync(path); if (bytes.byteLength > 32768) throw new DemoError('REVIEW_FILE_TOO_LARGE');
  const result = schema.safeParse(JSON.parse(bytes.toString('utf8')));
  if (!result.success) throw new DemoError('REVIEW_FILE_SCHEMA_INVALID'); return result.data;
}
async function conversation(label: Label, id: string): Promise<Qualification> {
  const current = (await call<Qualification[]>(label, 'qualifications')).data.find(value => value.id === id);
  if (!current || current.otherEns !== expectedName(label === 'demo-seeker' ? 'demo-recruiter' : 'demo-seeker')) throw new DemoError('QUALIFICATION_MUST_JOIN_THE_TWO_ACTUAL_DEMO_ACCOUNTS');
  return current;
}
async function answer() {
  // The file supplies reviewed facts. This driver never generates answers to model questions.
  const input = reviewedFile('--answers-file', answerFileSchema), seen = new Set<string>();
  for (const item of input.answers) {
    if (seen.has(item.questionId)) throw new DemoError('DUPLICATE_OWNER_QUESTION'); seen.add(item.questionId);
    const current = await conversation(item.label, input.qualificationId);
    const question = current.questions.find(question => question.id === item.questionId);
    if (!question) throw new DemoError('QUESTION_IS_NOT_OWNED_BY_REVIEWED_LABEL');
    const inputDigest = hash(JSON.stringify({ qualificationId: input.qualificationId, ...item }));
    const recorded = progress.answerReceipts?.[item.questionId];
    if (question.answered) {
      if (recorded?.inputDigest !== inputDigest) throw new DemoError('ANSWER_ALREADY_EXISTS_REVIEW_ACTUAL_INBOX');
      continue;
    }
    if (current.state !== 'needs_owner') throw new DemoError('CONVERSATION_NOT_WAITING_FOR_OWNER');
    const owner = (await call<AppState>(item.label, 'state')).data;
    if (!owner.agent?.policy.allowedFields.includes(item.fieldClass)) throw new DemoError('REVIEWED_ANSWER_FIELD_IS_NOT_ALLOWED_BY_CURRENT_OWNER_POLICY');
    await call(item.label, `qualifications/${input.qualificationId}/answer`, { version: current.version, questionId: item.questionId, text: item.text,
      fieldClass: item.fieldClass, providerDisclosureConsent: item.providerDisclosureConsent, shareWithCounterpart: item.shareWithCounterpart });
    progress.answerReceipts ||= {}; progress.answerReceipts[item.questionId] = { inputDigest, recordedAt: new Date().toISOString() }; save();
  }
  summary({ mode: 'answer', qualificationId: input.qualificationId, reviewedAnswerCount: input.answers.length, fictional: true,
    note: 'Only explicit reviewed owner answers were submitted. No model continuation or human verification is implied.' });
}
async function resume() {
  const id = z.string().uuid().parse(option('--qualification-id', ''));
  const current = await conversation('demo-seeker', id); await conversation('demo-recruiter', id);
  if (current.state !== 'needs_owner') throw new DemoError('QUALIFICATION_IS_NOT_READY_FOR_OWNER_ANSWER_RESUME');
  await metered(`resume:${id}:${current.version}`, () => call<{ id: string | null; qualificationId: string }>('demo-seeker', `qualifications/${id}/resume`, { version: current.version }),
    result => { progress.qualifications[selectedCase] = result.data; });
}
async function retry() {
  const id = z.string().uuid().parse(option('--qualification-id', ''));
  const current = await conversation('demo-seeker', id); await conversation('demo-recruiter', id);
  if (current.state !== 'blocked' || !current.canRetry) throw new DemoError('QUALIFICATION_IS_NOT_READY_FOR_BOUNDED_RETRY');
  await metered(`retry:${id}:${current.version}`, () => call<{ id: string | null; qualificationId: string }>('demo-seeker', `qualifications/${id}/retry`, { version: current.version }),
    result => { progress.qualifications[selectedCase] = result.data; });
}
async function sameProposal(id: string, reviewedDigest: string) {
  const states = await Promise.all(labels.map(async label => ({ label, state: (await call<AppState>(label, 'state')).data })));
  const proposals = states.map(({ state }) => state.proposals.find(proposal => proposal.id === id));
  if (proposals.some(proposal => !proposal || proposal.digest !== reviewedDigest || ['declined', 'revoked', 'expired', 'blocked'].includes(proposal.status))) throw new DemoError('BOTH_ACCOUNTS_MUST_HAVE_THE_SAME_CURRENT_REVIEWED_PROPOSAL');
  return proposals as NonNullable<typeof proposals[number]>[];
}
async function consent() {
  const id = z.string().uuid().parse(option('--approve-fictional-proposal', ''));
  const reviewedDigest = digestSchema.parse(option('--reviewed-digest', ''));
  for (const label of labels) {
    const proposals = await sameProposal(id, reviewedDigest), own = proposals[labels.indexOf(label)];
    if (own.myConsent !== 'approve') await call(label, `proposals/${id}/consent`, { decision: 'approve' });
  }
  const proposals = await sameProposal(id, reviewedDigest);
  if (proposals.some(proposal => proposal.myConsent !== 'approve')) throw new DemoError('MUTUAL_FICTIONAL_CONSENT_NOT_CONFIRMED');
  summary({ proposalId: id, digest: reviewedDigest, fictionalAccountApprovals: 2, actualHumanApprovals: false, humanVerified: false,
    note: 'The operator explicitly approved this exact proposal for two fictional accounts. World still locks the protected release.' });
}
async function meeting() {
  const id = z.string().uuid().parse(option('--proposal-id', ''));
  const views = [];
  for (const label of labels) views.push({ label, meeting: (await call<MeetingView>(label, `proposals/${id}/meeting`)).data });
  summary({ proposalId: id, fictional: true, views, expectedGateEvidence: progress.meetingGateEvidence?.proposalId === id ? progress.meetingGateEvidence : null,
    note: 'Meeting inspection does not create an agreement, invitation, video link, or completed call.' });
}
function sameSlot(left: MeetingSlot | null, right: MeetingSlot | null) { return left?.start === right?.start && left?.end === right?.end; }
async function meetingPlan() {
  // Times come only from this reviewed file, with explicit offsets and timezone labels.
  const input = reviewedFile('--availability-file', meetingFileSchema);
  const availability = { 'demo-seeker': normalizeAvailability(input.availability['demo-seeker']), 'demo-recruiter': normalizeAvailability(input.availability['demo-recruiter']) };
  const expectedSlots = overlappingSlots(availability['demo-seeker'], availability['demo-recruiter']);
  await sameProposal(input.proposalId, input.proposalDigest);
  for (const label of labels) {
    await sameProposal(input.proposalId, input.proposalDigest);
    const current = (await call<MeetingView>(label, `proposals/${input.proposalId}/meeting`)).data;
    await call(label, `proposals/${input.proposalId}/meeting`, { action: 'availability', version: current.version, availability: availability[label] });
  }
  let current = (await call<MeetingView>('demo-seeker', `proposals/${input.proposalId}/meeting`)).data;
  const other = (await call<MeetingView>('demo-recruiter', `proposals/${input.proposalId}/meeting`)).data;
  if (JSON.stringify(current.ownAvailability) !== JSON.stringify(availability['demo-seeker']) || JSON.stringify(other.ownAvailability) !== JSON.stringify(availability['demo-recruiter'])
    || JSON.stringify(current.slots) !== JSON.stringify(expectedSlots)) throw new DemoError('CURRENT_MEETING_DIFFERS_FROM_REVIEWED_AVAILABILITY');
  if (!expectedSlots.length) {
    summary({ proposalId: input.proposalId, state: current.state, confirmed: false, externalInvitationCreated: false,
      note: 'The actual backend found no compatible meeting slot. No confirmation or finalization was attempted.' }); return;
  }
  const slot = expectedSlots[0];
  if (!sameSlot(current.selected, slot)) {
    await call('demo-seeker', `proposals/${input.proposalId}/meeting`, { action: 'select', version: current.version, slot });
    current = (await call<MeetingView>('demo-seeker', `proposals/${input.proposalId}/meeting`)).data;
  }
  const version = current.version;
  for (const label of labels) {
    await sameProposal(input.proposalId, input.proposalDigest);
    const fresh = (await call<MeetingView>(label, `proposals/${input.proposalId}/meeting`)).data;
    if (fresh.version !== version || !sameSlot(fresh.selected, slot)) throw new DemoError('MEETING_SLOT_CHANGED_BEFORE_CONFIRMATION');
    if (!fresh.confirmedByMe) await call(label, `proposals/${input.proposalId}/meeting`, { action: 'confirm', version });
  }
  const confirmed = (await call<MeetingView>('demo-seeker', `proposals/${input.proposalId}/meeting`)).data;
  if (confirmed.version !== version || confirmed.confirmationCount !== 2 || confirmed.state !== 'confirmed_pending_verification') throw new DemoError('BOTH_FICTIONAL_CONFIRMATIONS_REQUIRED');
  try {
    await call('demo-seeker', `proposals/${input.proposalId}/meeting`, { action: 'finalize', version });
    throw new DemoError('UNEXPECTED_FINAL_AGREEMENT_WHILE_WORLD_PAUSED');
  } catch (error) {
    if (!(error instanceof DemoError) || error.code !== 'HTTP_503_WORLD_PAUSED') throw error;
    progress.meetingGateEvidence = { proposalId: input.proposalId, version, code: 'WORLD_PAUSED', checkedAt: new Date().toISOString() }; save();
    summary({ proposalId: input.proposalId, version, slot, fictionalSlotConfirmations: 2, actualHumanConfirmations: false, state: 'confirmed_pending_verification',
      finalGate: 'WORLD_PAUSED', meetingTimeAgreed: false, externalInvitationCreated: false });
  }
}
async function inspect() {
  const views = [];
  for (const label of labels) {
    const current = (await call<AppState>(label, 'state')).data, conversations = (await call<Qualification[]>(label, 'qualifications')).data;
    views.push({ label, userId: current.user.id, wallet: current.user.wallet, agent: current.agent ? { ensName: current.agent.ensName, authority: current.agent.authority ? { allowed: current.agent.authority.allowed, reason: current.agent.authority.reason, checkedAt: current.agent.authority.checkedAt } : null } : null,
      intents: current.intents.map(({ id, status, arkivKey, transactionHash, semantics }) => ({ id, status, arkivKey, transactionHash, direction: semantics?.direction })),
      conversations: conversations.map(({ id, version, state, otherEns, stopReason, failureCode, canRetry, proposalId, messages, questions }) => ({ id, version, state, otherEns, stopReason, failureCode, canRetry, proposalId,
        messageCount: messages.length, messageTimestamps: messages.map(message => message.createdAt), questions, unansweredQuestionCount: questions.filter(question => !question.answered).length })),
      proposals: current.proposals.map(({ id, digest, status, world, myConsent }) => ({ id, digest, status, world, myConsent })), roomCount: current.rooms.length });
  }
  summary({ checkedAt: new Date().toISOString(), fictional: true, humanVerified: false, scope: 'Actual local HTTP accounts, configured live integrations only when successful. No human/device acceptance is implied.', pending: progress.pending || null, accounts: views });
}
try {
  const target = demoTarget({ APP_ORIGIN: process.env.APP_ORIGIN, DEMO_AUTH_TARGET_ORIGIN: process.env.DEMO_AUTH_TARGET_ORIGIN }); origin = target.origin; explicitTarget = target.explicit;
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1000 || requestTimeoutMs > 600000) throw new DemoError('DEMO_HTTP_TIMEOUT_MUST_BE_BOUNDED_AT_TEN_MINUTES');
  if (!['reauthenticate', 'poll-task', 'setup', 'prepare-publications', 'discover', 'qualify', 'answer', 'resume', 'retry', 'consent', 'meeting', 'meeting-plan', 'inspect'].includes(mode) || !['job', 'collaboration'].includes(selectedCase)) throw new DemoError('INVALID_MODE_OR_CASE');
  if (mode === 'reauthenticate' && (!explicitTarget || process.argv.length !== 3 || process.env.DATABASE_PROVIDER !== 'postgres' || !process.env.SUPABASE_DATABASE_URL)) throw new DemoError('REAUTHENTICATION_REQUIRES_EXPLICIT_POSTGRES_TARGET_WITHOUT_OTHER_ACTION_FLAGS');
  mkdirSync('.local-data', { recursive: true });
  try { const lock = openSync('.local-data/demo-core-flow.lock', 'wx', 0o600); lockOwned = true; closeSync(lock); }
  catch { throw new DemoError('ANOTHER_DRIVER_OR_STALE_LOCK_REQUIRES_INSPECTION'); }
  progress = existsSync(statePath) ? decrypt<Progress>(readFileSync(statePath, 'utf8'), stateContext) : { version: 1, origin, sessions: {}, accounts: {}, prepared: {}, discovery: {}, qualifications: {} };
  if (progress.version !== 1 || !explicitTarget && progress.origin !== origin) throw new DemoError('ENCRYPTED_PROGRESS_ORIGIN_MISMATCH');
  if (mode === 'reauthenticate') {
    const vault = decrypt<Vault>(readFileSync('.local-data/demo-wallets.enc', 'utf8'), 'meeti-demo-wallets-v1');
    if (vault.version !== 1) throw new DemoError('UNEXPECTED_DEMO_VAULT');
    const binding = await reauthenticateDemoAccounts({ origin, expectedAccounts: progress.accounts, wallets: vault.wallets,
      preflight: async (_label, id, address) => {
        const existing = await privateStore().prepare('SELECT id,wallet FROM users WHERE id=?').get(id) as { id: string; wallet: string | null } | undefined;
        if (!existing || existing.wallet?.toLowerCase() !== address.toLowerCase()) throw new DemoError('MIGRATED_ACCOUNT_PREFLIGHT_FAILED');
      } });
    progress.hostedAuth ||= {}; progress.hostedAuth[origin] = binding; save();
    summary({ completed: true, mode, origin, fictional: true, humanVerified: false, authenticatedAccounts: labels.map(label => ({ label, userId: binding.accounts[label], wallet: binding.wallets[label] })),
      scope: 'Existing Postgres accounts reauthenticated with nonce-bound wallet messages. Local sessions, prepared intents, dialogue history and pending tasks were preserved. No setup, model, publication or chain transaction was requested.' });
  } else {
  const health = (await call<{ integrations: AppState['integrations'] }>('demo-seeker', 'health')).data;
  if (health.integrations.world.status !== 'deferred') throw new DemoError('ACTUAL_SERVER_MUST_KEEP_WORLD_PAUSED');
  if (explicitTarget) {
    const binding = progress.hostedAuth?.[origin];
    if (!binding || labels.some(label => binding.accounts[label] !== progress.accounts[label] || !binding.sessions[label])) throw new DemoError('EXPLICIT_REAUTHENTICATION_REQUIRED');
    for (const label of labels) {
      const current = (await call<AppState>(label, 'state')).data;
      if (current.user.id !== binding.accounts[label] || current.user.wallet?.toLowerCase() !== binding.wallets[label].toLowerCase()) throw new DemoError('SAVED_ACCOUNT_MISMATCH');
    }
  } else {
  const vault = decrypt<Vault>(readFileSync('.local-data/demo-wallets.enc', 'utf8'), 'meeti-demo-wallets-v1');
  if (vault.version !== 1 || vault.wallets.length !== 2) throw new DemoError('UNEXPECTED_DEMO_VAULT');
  for (const label of labels) { const wallet = vault.wallets.find(wallet => wallet.label === label); if (!wallet) throw new DemoError('MISSING_DEMO_WALLET'); await authenticate(label, wallet.privateKey); }
  }
  if (progress.accounts['demo-seeker'] === progress.accounts['demo-recruiter']) throw new DemoError('TWO_DISTINCT_ACCOUNTS_REQUIRED');
  if (mode === 'poll-task') await pollSavedTask();
  if (mode === 'setup') for (const label of labels) await setup(label);
  if (mode === 'prepare-publications') {
    for (const label of labels) await prepare(label);
    const report = { createdAt: new Date().toISOString(), fictional: true, humanVerified: false, chainId: 7794095, case: selectedCase,
      status: 'UNSIGNED_PUBLICATION_REVIEW_ONLY', lifetime: '24 hours from each actual draft creation', note: 'No records have been published by this driver. Exact payloads require separate bounded approval and an actual publication executor.',
      records: labels.map(label => ({ label, intent: progress.prepared[`${selectedCase}:${label}`]!.publicPreview, inference: progress.prepared[`${selectedCase}:${label}`]!.interpretation.inference })) };
    mkdirSync('artifacts', { recursive: true }); writeFileSync(`artifacts/demo-core-${selectedCase}-publication-review.json`, JSON.stringify(report, null, 2)); summary(report);
  }
  if (mode === 'discover') { for (const label of labels) await discover(label); summary({ case: selectedCase, discovery: labels.map(label => ({ label, result: progress.discovery[`${selectedCase}:${label}`] })) }); }
  if (mode === 'qualify') await qualify();
  if (mode === 'answer') await answer();
  if (mode === 'resume') await resume();
  if (mode === 'retry') await retry();
  if (mode === 'consent') await consent();
  if (mode === 'meeting') await meeting();
  if (mode === 'meeting-plan') await meetingPlan();
  if (mode !== 'prepare-publications' && mode !== 'discover' && mode !== 'meeting') await inspect();
  }
} catch (error) {
  // API bodies, cookies, keys and untrusted provider error strings are deliberately omitted.
  summary({ completed: false, mode, case: selectedCase, code: error instanceof DemoError || error instanceof DemoAuthError ? error.code : 'DEMO_DRIVER_FAILED',
    note: 'No success is assumed. Inspect encrypted progress before retrying an uncertain provider operation. World remains paused.' }); process.exitCode = 1;
} finally {
  try { if (mode === 'reauthenticate') await closeStore(); }
  catch { summary({ completed: false, code: 'AUTH_CONNECTION_CLEANUP_FAILED' }); process.exitCode = 1; }
  finally { if (lockOwned) rmSync('.local-data/demo-core-flow.lock'); }
}

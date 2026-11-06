import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { chromium, expect, request as playwrightRequest, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { decrypt } from '../packages/server/crypto';
import type { AppState, ContextDocument } from '../packages/shared/src';

// Actual demo sessions are read, never created or refreshed here. This driver does not
// sign, inject a wallet, click controls, run models, or manufacture chain authority.
type Label = 'demo-seeker' | 'demo-recruiter';
type Saved = { version: 1; origin: string; sessions: Partial<Record<Label, string>>; accounts: Partial<Record<Label, string>> };
type Qualification = { id: string; version: number; state: string; otherEns: string; proposalId: string | null;
  messages: { id: string; content: string; createdAt: string }[] };
type AccountReport = { label: Label; userId?: string; agentEns?: string; checks: string[]; intentStates?: Record<string, number>; conversationStates?: Record<string, number>;
  actualMessages?: number; actualProposals?: number; actualRooms?: number; actualPrivateFiles?: number; privateFieldsChecked?: number; tourVisible?: boolean;
  originalReadback?: { bytes: number; sha256: string; ownerAllowed: true; publicDenied: true }; screenshots: string[] };
class ReadbackError extends Error { constructor(readonly code: string) { super(code); } }
const origin = new URL(process.env.APP_ORIGIN || 'http://127.0.0.1:3173').origin;
const labels: Label[] = ['demo-seeker', 'demo-recruiter'];
const safeApiPaths = new Set(['/api/health', '/api/state', '/api/onboarding', '/api/qualifications', '/api/context/files', '/api/profile/intakes', '/api/discovery/jobs']);
const outputDirectory = `.local-data/private-artifacts/demo-browser-${new Date().toISOString().replace(/[^0-9TZ]/g, '')}`;
const reports: AccountReport[] = [], blockedRequests: { label: Label; method: string; path: string; reason: string }[] = [];
let browser: Browser | undefined;
async function check(code: string, action: () => Promise<unknown>) { try { await action(); } catch { throw new ReadbackError(code); } }
async function get<T>(context: BrowserContext, path: string): Promise<T> {
  if (!safeApiPaths.has(`/api/${path}`)) throw new ReadbackError('UNSAFE_READ_PATH');
  const response = await context.request.get(`${origin}/api/${path}`, { timeout: 15000, maxRedirects: 0 });
  if (response.status() !== 200) throw new ReadbackError(`READ_HTTP_${response.status()}_${path.replace(/[^a-z]/g, '_')}`);
  return (await response.json()).data as T;
}
async function visit(page: Page, path: string, state: AppState) {
  await page.goto(`${origin}/${path}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await check('AUTHENTICATED_PROFILE_NOT_RENDERED', () => expect(page.getByRole('complementary', { name: 'Workspace navigation', exact: true, includeHidden: true })
    .getByLabel('Signed-in account', { exact: true })).toContainText(state.profile.displayName, { timeout: 15000 }));
  await check('SIGN_IN_SCREEN_REPLACED_ACTUAL_SESSION', () => expect(page.getByRole('button', { name: 'Connect MetaMask', exact: true })).toHaveCount(0));
}
async function capture(page: Page, report: AccountReport, name: string) {
  const file = `${outputDirectory}/${report.label}-${name}.png`;
  await page.screenshot({ path: file, fullPage: false, animations: 'disabled', timeout: 10000 }); report.screenshots.push(file);
}
async function originalReadback(context: BrowserContext, anonymous: APIRequestContext, label: Label, files: ContextDocument[], report: AccountReport) {
  const known = files.filter(file => file.name === `${label}-context.txt`);
  const expected = Buffer.from('Fictional TEST DATA. Private reference for this generated account. No contact details or real resume.');
  if (known.length !== 1 || known[0].size !== expected.byteLength || known[0].mimeType !== 'text/plain') throw new ReadbackError('KNOWN_FICTIONAL_ORIGINAL_REQUIRED');
  const path = `${origin}/api/context/files/${known[0].id}/download`;
  const owner = await context.request.get(path, { timeout: 30000, maxRedirects: 0 });
  if (owner.status() !== 200 || owner.headers()['content-type'] !== 'application/octet-stream' || owner.headers()['cache-control'] !== 'private, no-store') throw new ReadbackError('OWNER_PROTECTED_ORIGINAL_NOT_RETURNED');
  const bytes = await owner.body(), digest = createHash('sha256').update(bytes).digest('hex');
  if (!bytes.equals(expected) || digest !== createHash('sha256').update(expected).digest('hex')) throw new ReadbackError('OWNER_ORIGINAL_BYTES_OR_HASH_DIFFER_FROM_KNOWN_FIXTURE');
  const denied = await anonymous.get(path, { timeout: 15000, maxRedirects: 0 });
  if (denied.status() !== 401) throw new ReadbackError('UNAUTHENTICATED_ORIGINAL_REQUEST_NOT_DENIED');
  report.originalReadback = { bytes: bytes.byteLength, sha256: digest, ownerAllowed: true, publicDenied: true };
  report.checks.push('One exact known fictional owner original matched its expected bytes and SHA256; unauthenticated retrieval denied. No original content or URL is reported.');
}
async function profileReadback(page: Page, context: BrowserContext, state: AppState, other: AppState, files: ContextDocument[], otherFiles: ContextDocument[], report: AccountReport) {
  await visit(page, 'profile', state);
  await check('PROFILE_NAME_DIFFERS_FROM_HTTP', () => expect(page.getByLabel('Your name', { exact: true })).toHaveValue(state.profile.displayName));
  const privateValues = (['displayName', 'headline', 'bio', 'contact', 'employer'] as const).map(key => ({ key, value: other.profile[key] }))
    .filter(({ key, value }) => value.length >= 8 && value !== state.profile[key] && !other.profile.publicFields.includes(key));
  for (const { value } of privateValues) {
    const rendered = await page.locator('body').innerText();
    const fields = await page.locator('input,textarea').evaluateAll(nodes => nodes.map(node => (node as HTMLInputElement | HTMLTextAreaElement).value));
    if (rendered.includes(value) || fields.some(field => field.includes(value))) throw new ReadbackError('OTHER_PRIVATE_PROFILE_VISIBLE_IN_OWNER_EDITOR');
  }
  const library = page.getByRole('region', { name: 'A resume, with boundaries you review.', exact: true, includeHidden: true });
  await check('PRIVATE_FILE_LIBRARY_NOT_RENDERED', () => expect(library).toHaveCount(1));
  const cards = library.getByRole('article', { includeHidden: true });
  await check('PRIVATE_FILE_COUNT_DIFFERS_FROM_HTTP', () => expect(cards).toHaveCount(files.length));
  for (const file of files) {
    const card = cards.filter({ has: page.getByLabel(`Title for ${file.name}`, { exact: true }) });
    await check('PRIVATE_FILE_METADATA_DIFFERS_FROM_HTTP', () => expect(card.getByLabel(`Title for ${file.name}`, { exact: true })).toHaveValue(file.title || file.name));
    await check('PRIVATE_FILE_PURPOSE_DIFFERS_FROM_HTTP', () => expect(card.getByLabel(`Purpose for ${file.name}`, { exact: true })).toHaveValue(file.description || ''));
    await check('PRIVATE_FILE_SCOPE_DIFFERS_FROM_HTTP', () => expect(card.getByLabel(`Excerpt sharing scope for ${file.name}`, { exact: true })).toHaveValue(file.sharingScope || 'ask-first'));
    await check('PRIVATE_FILE_PROCESSING_DIFFERS_FROM_HTTP', () => expect(card.locator('header')).toContainText(`Processing: ${file.extractionStatus}.`));
  }
  for (const file of otherFiles) {
    if (files.some(own => own.id === file.id)) throw new ReadbackError('CROSS_ACCOUNT_PRIVATE_FILE_ID_IN_HTTP_LIST');
    if (!files.some(own => own.name === file.name) && (await library.innerText()).includes(file.name)) throw new ReadbackError('OTHER_PRIVATE_FILE_VISIBLE_IN_OWNER_LIBRARY');
  }
  if (otherFiles[0]) {
    if (!/^[a-f0-9-]{36}$/.test(otherFiles[0].id)) throw new ReadbackError('UNEXPECTED_PRIVATE_FILE_ID');
    // The expected tenant rejection occurs before original retrieval. No valid original is downloaded.
    const denied = await context.request.get(`${origin}/api/context/files/${otherFiles[0].id}/download`, { timeout: 15000, maxRedirects: 0 });
    if (denied.status() !== 404) throw new ReadbackError('CROSS_ACCOUNT_ORIGINAL_REQUEST_NOT_DENIED');
  }
  report.actualPrivateFiles = files.length;
  report.privateFieldsChecked = privateValues.length; report.tourVisible = await page.getByRole('dialog', { name: 'A quick look around', exact: true }).isVisible();
  report.checks.push('Rendered own profile matches real HTTP state; distinct nonpublic counterpart values excluded.');
  report.checks.push('Private file metadata, processing and scopes match authenticated HTTP lists; counterpart filenames excluded and one counterpart original denied before retrieval when available.');
  await capture(page, report, 'profile');
}
async function intentsReadback(page: Page, state: AppState, report: AccountReport) {
  await visit(page, 'intents', state);
  const cards = page.locator('.saved-intent');
  await check('INTENT_COUNT_DIFFERS_FROM_HTTP', () => expect(cards).toHaveCount(state.intents.length));
  for (let index = 0; index < state.intents.length; index++) {
    const intent = state.intents[index], card = cards.nth(index);
    await check('INTENT_SUMMARY_DIFFERS_FROM_HTTP', () => expect(card.getByRole('heading', { level: 3, includeHidden: true })).toHaveText(intent.summary));
    const status = intent.publicStatus === 'closed' && intent.status === 'draft' ? 'Closure awaiting publication' : intent.status;
    await check('INTENT_PUBLICATION_STATUS_DIFFERS_FROM_HTTP', () => expect(card.getByText(status, { exact: true })).toHaveCount(1));
    if (intent.arkivKey) await check('CONFIRMED_ENTITY_NOT_RENDERED', () => expect(card.locator('code')).toHaveText(intent.arkivKey!));
    else await check('UNCONFIRMED_ENTITY_PRESENTED_AS_PUBLIC', () => expect(card.locator('.public-evidence')).toHaveCount(0));
  }
  report.intentStates = Object.fromEntries([...new Set(state.intents.map(intent => intent.status))].map(status => [status, state.intents.filter(intent => intent.status === status).length]));
  report.checks.push('Rendered intent summaries, status and available entity receipts match actual HTTP state.'); await capture(page, report, 'intents');
}
async function conversationsReadback(page: Page, context: BrowserContext, state: AppState, report: AccountReport) {
  const conversations = await get<Qualification[]>(context, 'qualifications');
  if (conversations.length > 8 || conversations.reduce((total, value) => total + value.messages.length, 0) > 100) throw new ReadbackError('DEMO_CONVERSATION_READBACK_LIMIT_EXCEEDED');
  await visit(page, 'activity', state);
  const panel = page.getByRole('region', { name: 'Live agent qualification', exact: true, includeHidden: true });
  await check('QUALIFICATION_PANEL_NOT_RENDERED', () => expect(panel).toHaveCount(1));
  await check('QUALIFICATION_PANEL_NOT_LOADED', () => expect(panel.getByText('Loading your agent conversations...', { exact: true })).toHaveCount(0));
  const cards = panel.locator('article').filter({ has: page.locator('header h3') });
  await check('QUALIFICATION_COUNT_DIFFERS_FROM_HTTP', () => expect(cards).toHaveCount(conversations.length));
  for (let index = 0; index < conversations.length; index++) {
    const actual = conversations[index], card = cards.nth(index);
    await check('QUALIFICATION_COUNTERPART_DIFFERS_FROM_HTTP', () => expect(card.getByRole('heading', { level: 3, includeHidden: true }).first()).toHaveText(actual.otherEns));
    await check('QUALIFICATION_REVISION_DIFFERS_FROM_HTTP', () => expect(card.getByText(`Conversation revision ${actual.version}`, { exact: true })).toHaveCount(1));
    const messages = card.locator('.exchange-message');
    await check('QUALIFICATION_MESSAGES_DIFFERS_FROM_HTTP', () => expect(messages).toHaveCount(actual.messages.length));
    for (let message = 0; message < actual.messages.length; message++) {
      await check('QUALIFICATION_MESSAGE_CONTENT_DIFFERS_FROM_HTTP', () => expect(messages.nth(message).locator(':scope > p')).toHaveText(actual.messages[message].content));
      await check('QUALIFICATION_MESSAGE_TIMESTAMP_DIFFERS_FROM_HTTP', () => expect(messages.nth(message).locator('time')).toHaveAttribute('datetime', actual.messages[message].createdAt));
    }
  }
  report.actualMessages = conversations.reduce((total, value) => total + value.messages.length, 0);
  report.conversationStates = Object.fromEntries([...new Set(conversations.map(value => value.state))].map(state => [state, conversations.filter(value => value.state === state).length]));
  report.checks.push('Rendered qualification revisions and real message contents/timestamps match authenticated HTTP DTOs.'); await capture(page, report, 'activity');
}
async function approvalsReadback(page: Page, state: AppState, report: AccountReport) {
  if (state.integrations.world.status !== 'deferred' || state.proposals.some(proposal => proposal.world.verified)) throw new ReadbackError('WORLD_MUST_REMAIN_PAUSED_AND_UNVERIFIED');
  await visit(page, 'approvals', state); const cards = page.locator('.approval-card');
  await check('PROPOSAL_COUNT_DIFFERS_FROM_HTTP', () => expect(cards).toHaveCount(state.proposals.length));
  for (let index = 0; index < state.proposals.length; index++) {
    const proposal = state.proposals[index], card = cards.nth(index);
    await check('PROPOSAL_COUNTERPART_DIFFERS_FROM_HTTP', () => expect(card.getByRole('heading', { level: 2, includeHidden: true })).toHaveText(proposal.candidateName || proposal.candidateEns));
    await check('PROPOSAL_SUMMARY_DIFFERS_FROM_HTTP', () => expect(card.getByText(proposal.summary, { exact: true })).toHaveCount(1));
    await check('WORLD_PAUSED_BADGE_NOT_RENDERED', () => expect(card.locator('.approval-gates').getByText('Paused', { exact: true })).toHaveCount(1));
    await check('PROTECTED_ROOM_BUTTON_NOT_LOCKED', () => expect(card.getByRole('button', { name: 'Check gates and open room', exact: true, includeHidden: true })).toBeDisabled());
  }
  report.actualProposals = state.proposals.length;
  report.actualRooms = state.rooms.length;
  report.checks.push(state.proposals.length ? 'Actual proposals rendered; World DTOs remain unverified and their protected room buttons are disabled. No release request attempted.'
    : 'No proposals exist. World status remains deferred; there is no proposal release control to test.');
  await capture(page, report, 'approvals');
}
try {
  if (new URL(origin).protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(new URL(origin).hostname)) throw new ReadbackError('LOCAL_HTTP_ORIGIN_REQUIRED');
  if (!existsSync('.local-data/demo-core-flow.enc')) throw new ReadbackError('RUN_ACTUAL_DEMO_ACCOUNT_SETUP_FIRST');
  const saved = decrypt<Saved>(readFileSync('.local-data/demo-core-flow.enc', 'utf8'), 'meeti-demo-core-flow-v1');
  if (saved.version !== 1 || saved.origin !== origin || !saved.accounts['demo-seeker'] || saved.accounts['demo-seeker'] === saved.accounts['demo-recruiter']) throw new ReadbackError('TWO_DISTINCT_SAVED_DEMO_ACCOUNTS_REQUIRED');
  mkdirSync(outputDirectory, { recursive: true });
  browser = await chromium.launch({ channel: 'chrome', headless: true });
  const contexts: BrowserContext[] = [], snapshots: AppState[] = [], files: ContextDocument[][] = [];
  const anonymous = await playwrightRequest.newContext({ storageState: { cookies: [], origins: [] } });
  try {
    for (const label of labels) {
      const session = saved.sessions[label], match = session && /^meeti_session=([0-9a-f]{64})$/.exec(session);
      if (!match) throw new ReadbackError('SAVED_OPAQUE_SESSION_REQUIRED_NO_AUTHENTICATION_PERFORMED');
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' }); contexts.push(context);
      await context.addCookies([{ name: 'meeti_session', value: match[1], url: origin, httpOnly: true, secure: false, sameSite: 'Strict' }]);
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        const reason = !['GET', 'HEAD'].includes(request.method()) ? 'mutation-blocked' : url.origin !== origin ? 'external-request-blocked'
          : url.pathname.startsWith('/api/') && !safeApiPaths.has(url.pathname) ? 'provider-or-unsafe-read-blocked' : '';
        if (reason) { if (blockedRequests.length < 100) blockedRequests.push({ label, method: request.method(), path: url.origin === origin ? url.pathname : '[external]', reason }); await route.abort(); }
        else await route.continue();
      });
      const state = await get<AppState>(context, 'state');
      if (state.user.id !== saved.accounts[label] || state.profile.displayName !== `Fictional TEST DATA ${label}`) throw new ReadbackError('ACTUAL_AUTHENTICATED_DEMO_ACCOUNT_MISMATCH');
      snapshots.push(state);
      files.push(await get<ContextDocument[]>(context, 'context/files'));
    }
    if (snapshots[0].user.wallet === snapshots[1].user.wallet) throw new ReadbackError('TWO_DISTINCT_ACTUAL_WALLETS_REQUIRED');
    for (let index = 0; index < labels.length; index++) {
      const report: AccountReport = { label: labels[index], userId: snapshots[index].user.id, agentEns: snapshots[index].agent?.ensName, checks: [], screenshots: [] }; reports.push(report);
      const page = await contexts[index].newPage(); page.setDefaultTimeout(10000);
      await originalReadback(contexts[index], anonymous, labels[index], files[index], report);
      await profileReadback(page, contexts[index], snapshots[index], snapshots[1 - index], files[index], files[1 - index], report);
      await intentsReadback(page, snapshots[index], report);
      await conversationsReadback(page, contexts[index], snapshots[index], report);
      await approvalsReadback(page, snapshots[index], report);
    }
  } finally { await anonymous.dispose(); for (const context of contexts) await context.close(); }
  if (blockedRequests.some(request => request.reason !== 'external-request-blocked')) throw new ReadbackError('UI_ATTEMPTED_MUTATION_OR_PROVIDER_READ_DURING_READONLY_INSPECTION');
  const report = { checkedAt: new Date().toISOString(), passed: true, actualBrowser: 'Installed Chrome, headless, separate ephemeral contexts',
    scope: 'Rendered actual HTTP data using existing authenticated demo sessions. No mocked authorities or injected wallets. No AI/chain calls or mutating buttons requested by this driver.',
    independentHumanOrDeviceAcceptance: false, conversationsOrMatchesAssumed: false,
    tourNote: 'First-user tour dialogs are preserved and reported. Underlying DOM comparisons do not dismiss the tour or change its preference. Screenshots retain any visible tour.',
    storageNote: 'Protected original integrity is verified through actual HTTP. This driver does not inspect server storage pointers; attribute cloud storage using separate server SDK evidence.', accounts: reports, blockedRequests };
  writeFileSync(`${outputDirectory}/readback.json`, JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} catch (error) {
  const report = { checkedAt: new Date().toISOString(), passed: false, code: error instanceof ReadbackError ? error.code : 'BROWSER_READBACK_FAILED',
    accounts: reports, blockedRequests, note: 'No result is invented. Source state may have changed during inspection. No credentials or browser exception bodies are printed.' };
  mkdirSync(outputDirectory, { recursive: true }); writeFileSync(`${outputDirectory}/readback.json`, JSON.stringify(report, null, 2)); console.error(JSON.stringify(report, null, 2)); process.exitCode = 1;
} finally { if (browser) await browser.close(); }

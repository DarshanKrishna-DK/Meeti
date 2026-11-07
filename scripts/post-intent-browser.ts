import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, expect, type BrowserContext } from '@playwright/test';
import { z } from 'zod';
import { decrypt } from '../packages/server/crypto';
import type { AppState } from '../packages/shared/src';
import { selectReadbackSessions, readbackRequestReason } from './demo-browser-readback';

const labels = ['demo-seeker', 'demo-recruiter'] as const;
const qualificationSchema = z.object({ id: z.string().uuid(), version: z.number().int().positive(), state: z.string().max(40), otherEns: z.string().max(255),
  proposalId: z.string().uuid().nullable(), failureCode: z.string().max(200).nullish(),
  messages: z.array(z.object({ id: z.string().uuid(), content: z.string().max(12000), createdAt: z.string().datetime(), speaker: z.string().max(255) })).max(6),
  questions: z.array(z.object({ id: z.string().uuid(), question: z.string().max(2000), answered: z.boolean() })).max(18),
});
type Qualification = z.infer<typeof qualificationSchema>;
class PostIntentError extends Error { constructor(readonly code: string) { super(code); } }
function requireReadback(value: unknown, code: string): asserts value { if (!value) throw new PostIntentError(code); }
const sha256 = (value: string) => createHash('sha256').update(value).digest('hex');

/** Activity contains background controls. Their GET routes can advance work, so they stay blocked. */
export function postIntentRequestReason(origin: string, url: string, method: string) {
  return readbackRequestReason(origin, url, method);
}
function fingerprint(value: Qualification[]) { return sha256(JSON.stringify(value)); }

async function main() {
  const arguments_ = process.argv.slice(2), idArgument = arguments_.find(value => value.startsWith('--qualification-id='));
  const dismissTour = arguments_.includes('--dismiss-tour');
  requireReadback(arguments_.includes('--read-only') && arguments_.length === (dismissTour ? 3 : 2) && idArgument
    && arguments_.every(value => value === '--read-only' || value === '--dismiss-tour' || value === idArgument), 'READ_ONLY_AND_EXACT_QUALIFICATION_REQUIRED');
  const expectedId = z.string().uuid().parse(idArgument.slice('--qualification-id='.length));
  const saved = decrypt<Parameters<typeof selectReadbackSessions>[0]>(readFileSync('.local-data/demo-core-flow.enc', 'utf8'), 'meeti-demo-core-flow-v1');
  const binding = selectReadbackSessions(saved, { APP_ORIGIN: process.env.APP_ORIGIN, DEMO_AUTH_TARGET_ORIGIN: process.env.DEMO_AUTH_TARGET_ORIGIN });
  const output = `.local-data/private-artifacts/post-intent-browser-${new Date().toISOString().replace(/[^0-9TZ]/g, '')}`;
  mkdirSync(output, { recursive: true });
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const contexts: BrowserContext[] = [], blocked: { label: string; method: string; path: string; reason: string }[] = [];
  const reports: { label: string; accountId: string; qualificationId: string; version: number; state: string; messages: number; ownerQuestions: number; transcriptSha256: string; tourVisible: boolean; screenshot: string; selectedConversationScreenshot: string; messageScreenshots: string[] }[] = [];
  const expected: Qualification[][] = [];
  const preferences = labels.map(label => ({ label, allowed: false, attempted: 0, confirmed: 0 }));
  async function get<T>(context: BrowserContext, path: 'state' | 'qualifications'): Promise<T> {
    const response = await context.request.get(`${binding.origin}/api/${path}`, { timeout: 30000, maxRedirects: 0 });
    requireReadback(response.status() === 200, `AUTHENTICATED_READ_HTTP_${response.status()}`);
    return (await response.json()).data as T;
  }
  try {
    const snapshots: AppState[] = [];
    for (const label of labels) {
      const session = /^meeti_session=([a-f0-9]{64})$/.exec(binding.sessions[label] || '');
      requireReadback(session, 'SAVED_SESSION_REQUIRED');
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block' }); contexts.push(context);
      const preference = preferences[contexts.length - 1];
      await context.addCookies([{ name: 'meeti_session', value: session[1], url: binding.origin, httpOnly: true, secure: binding.secure, sameSite: 'Strict' }]);
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url()), reason = postIntentRequestReason(binding.origin, url.href, request.method());
        if (dismissTour && preference.allowed && preference.attempted === 0 && request.method() === 'POST'
          && url.origin === binding.origin && url.pathname === '/api/onboarding' && !url.search) {
          let body: unknown;
          try { body = request.postDataJSON(); } catch { body = null; }
          if (body && typeof body === 'object' && Object.keys(body).length === 1 && (body as { tourCompleted?: unknown }).tourCompleted === true) {
            preference.attempted++; return route.continue();
          }
        }
        if (!reason) return route.continue();
        if (blocked.length < 100) blocked.push({ label, method: request.method(), path: url.origin === binding.origin ? url.pathname : '[external]', reason });
        await route.abort();
      });
      const state = await get<AppState>(context, 'state');
      requireReadback(state.user.id === binding.accounts[label] && (!binding.wallets || state.user.wallet?.toLowerCase() === binding.wallets[label]?.toLowerCase()), 'SAVED_ACCOUNT_BINDING_CHANGED');
      requireReadback(state.profile.displayName === `Fictional TEST DATA ${label}`, 'ONLY_EXISTING_FICTIONAL_ACCOUNTS_ALLOWED');
      requireReadback(!(state.agentTasks || []).some(task => ['queued', 'running'].includes(task.status)), 'WAIT_FOR_EXISTING_AGENT_TASKS_TO_STOP');
      requireReadback(state.integrations.world.status === 'deferred' && state.proposals.every(proposal => !proposal.world.verified), 'WORLD_MUST_REMAIN_PAUSED');
      const qualifications = z.array(qualificationSchema).max(50).parse(await get<unknown>(context, 'qualifications'));
      requireReadback(!qualifications.some(item => ['queued', 'running'].includes(item.state)), 'WAIT_FOR_EXISTING_QUALIFICATION_TO_STOP');
      requireReadback(qualifications.some(item => item.id === expectedId), 'EXACT_EXISTING_QUALIFICATION_NOT_FOUND');
      snapshots.push(state); expected.push(qualifications);
    }
    const selected = expected.map(items => items.find(item => item.id === expectedId)!);
    requireReadback(selected[0].version === selected[1].version && selected[0].state === selected[1].state
      && JSON.stringify(selected[0].messages) === JSON.stringify(selected[1].messages), 'BOTH_OWNERS_MUST_READ_SAME_ACCEPTED_TRANSCRIPT');
    requireReadback(!selected[0].questions.some(question => selected[1].questions.some(other => other.id === question.id)), 'OWNER_QUESTION_IDS_CROSS_ACCOUNT');
    for (let index = 0; index < labels.length; index++) {
      const page = await contexts[index].newPage(); page.setDefaultTimeout(15000);
      await page.goto(`${binding.origin}/activity`, { waitUntil: 'domcontentloaded', timeout: 45000 });
      const account = page.getByRole('complementary', { name: 'Workspace navigation', exact: true, includeHidden: true }).getByLabel('Signed-in account', { exact: true });
      await expect(account).toContainText(snapshots[index].profile.displayName);
      await expect(account).not.toContainText(snapshots[1 - index].profile.displayName);
      if (dismissTour) {
        const dialog = page.getByRole('dialog', { name: 'A quick look around', exact: true });
        const preference = await contexts[index].request.get(`${binding.origin}/api/onboarding`, { timeout: 15000, maxRedirects: 0 });
        requireReadback(preference.status() === 200, 'TOUR_PREFERENCE_READ_FAILED');
        if ((await preference.json()).data?.tourCompleted !== true) await expect(dialog).toBeVisible();
        if (await dialog.count()) {
          preferences[index].allowed = true;
          const response = page.waitForResponse(value => value.request().method() === 'POST' && new URL(value.url()).origin === binding.origin && new URL(value.url()).pathname === '/api/onboarding');
          await dialog.getByRole('button', { name: 'Skip tour', exact: true }).click();
          const actual = await response;
          requireReadback(actual.status() === 200 && (await actual.json()).data?.tourCompleted === true, 'TOUR_PREFERENCE_NOT_CONFIRMED');
          preferences[index].confirmed++; preferences[index].allowed = false;
          await expect(dialog).toHaveCount(0);
        }
      }
      const panel = page.getByRole('region', { name: 'Live agent qualification', exact: true, includeHidden: true });
      await expect(panel.getByText('Loading your agent conversations...', { exact: true })).toHaveCount(0);
      const cards = panel.locator('article').filter({ has: page.locator('header h3') });
      await expect(cards).toHaveCount(expected[index].length);
      for (let position = 0; position < expected[index].length; position++) {
        const value = expected[index][position], card = cards.nth(position);
        await expect(card.getByRole('heading', { level: 3, includeHidden: true }).first()).toHaveText(value.otherEns);
        await expect(card.getByText(`Conversation revision ${value.version}`, { exact: true })).toHaveCount(1);
        const messages = card.locator('.exchange-message'); await expect(messages).toHaveCount(value.messages.length);
        for (let message = 0; message < value.messages.length; message++) {
          await expect(messages.nth(message).locator(':scope > p')).toHaveText(value.messages[message].content);
          await expect(messages.nth(message).locator('time')).toHaveAttribute('datetime', value.messages[message].createdAt);
        }
        const questions = card.locator('form'); await expect(questions).toHaveCount(value.questions.length);
        for (let question = 0; question < value.questions.length; question++) {
          const actual = value.questions[question], form = questions.nth(question);
          if (actual.answered) await expect(form.getByText(actual.question, { exact: true })).toHaveCount(1);
          else await expect(form.getByLabel(actual.question, { exact: true })).toHaveAttribute('maxlength', '1200');
        }
      }
      const observed = z.array(qualificationSchema).max(50).parse(await get<unknown>(contexts[index], 'qualifications'));
      requireReadback(fingerprint(observed) === fingerprint(expected[index]), 'QUALIFICATION_CHANGED_DURING_READBACK');
      const after = await get<AppState>(contexts[index], 'state');
      requireReadback(JSON.stringify(after.profile) === JSON.stringify(snapshots[index].profile)
        && JSON.stringify(after.agent?.policy) === JSON.stringify(snapshots[index].agent?.policy)
        && JSON.stringify(after.proposals) === JSON.stringify(snapshots[index].proposals), 'PROFILE_POLICY_OR_PROPOSAL_CHANGED');
      const selectedCard = cards.nth(expected[index].findIndex(item => item.id === expectedId));
      await selectedCard.scrollIntoViewIfNeeded();
      const screenshot = `${output}/${labels[index]}-activity.png`;
      await page.screenshot({ path: screenshot, fullPage: false, animations: 'disabled' });
      const selectedConversationScreenshot = `${output}/${labels[index]}-selected-conversation.png`;
      await selectedCard.screenshot({ path: selectedConversationScreenshot, animations: 'disabled' });
      const messageScreenshots: string[] = [];
      for (let message = 0; message < selected[index].messages.length; message++) {
        const path = `${output}/${labels[index]}-accepted-message-${message + 1}.png`;
        await selectedCard.locator('.exchange-message').nth(message).screenshot({ path, animations: 'disabled' }); messageScreenshots.push(path);
      }
      reports.push({ label: labels[index], accountId: snapshots[index].user.id, qualificationId: expectedId, version: selected[index].version,
        state: selected[index].state, messages: selected[index].messages.length, ownerQuestions: selected[index].questions.length,
        transcriptSha256: sha256(JSON.stringify(selected[index].messages)), tourVisible: await page.getByRole('dialog').count() > 0, screenshot, selectedConversationScreenshot, messageScreenshots });
    }
    requireReadback(!blocked.some(item => item.reason === 'mutation-blocked'), 'UNEXPECTED_UI_MUTATION_BLOCKED');
    const report = { checkedAt: new Date().toISOString(), passed: true, origin: binding.origin, mode: dismissTour ? 'actual two-owner browser readback with explicit Skip tour preference updates' : 'actual HTTP and headless installed Chrome, two existing independent accounts',
      qualificationId: expectedId, accounts: reports, blockedRequests: blocked, newModelRequests: 0, publicWrites: 0, signatures: 0,
      tourPreferenceUpdates: preferences.reduce((total, item) => total + item.confirmed, 0),
      limits: ['Existing sessions only. No user Chrome profile or visible window was opened.', 'Background action GET routes are intentionally blocked because they can advance queued inference.',
        'Transcript and timestamps match actual HTTP. Owner question IDs are disjoint and each rendered question matches its owner DTO.',
        dismissTour ? 'Only the actual Skip tour action may update tourCompleted:true once per owner. Profile, policy and proposals are compared unchanged.' : 'Tour preferences are preserved. A visible tour can cover underlying rendered content.', 'This does not prove fresh discovery or a new qualification. It reads a previously accepted conversation.'] };
    writeFileSync(`${output}/readback.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report, null, 2));
  } catch (error) {
    const report = { checkedAt: new Date().toISOString(), passed: false, code: error instanceof PostIntentError ? error.code : 'POST_INTENT_BROWSER_CHECK_FAILED',
      accounts: reports, blockedRequests: blocked, note: 'No exception body, private transcript, session cookie or signature is printed. No model or transaction action is requested.' };
    writeFileSync(`${output}/readback.json`, JSON.stringify(report, null, 2)); console.error(JSON.stringify(report, null, 2)); process.exitCode = 1;
  } finally { for (const context of contexts) await context.close(); await browser.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main().catch(() => {
  console.error(JSON.stringify({ passed: false, code: 'POST_INTENT_PREFLIGHT_FAILED_NO_PRIVATE_DETAILS' })); process.exitCode = 1;
});

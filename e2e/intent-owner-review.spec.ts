import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { AppState } from '../packages/shared/src';
import { requirementReviewQuestion, type IntentSemantics } from '../packages/matching/src/semantics';
import { dismissTour, installTestMetaMask, signInWithTestWallet } from './wallet-fixture';

const summary = 'I would like a collaborator who writes learning guides.';
const semantics: IntentSemantics = {
  schemaVersion: 1, category: 'collaborator', categoryEvidence: 'collaborator',
  direction: 'collaborating', directionEvidence: 'collaborator', canonicalRole: null,
  topics: [{ value: 'learning guides', sourceQuote: 'learning guides' }], offers: [], requirements: [{ kind: 'skill', value: 'writing learning guides', sourceQuote: 'writes learning guides', strength: 'mandatory' }],
  clarificationQuestions: [],
};
const approvalLabel = 'I approve these fields for public publication. Public records may remain in historical copies after expiry.';

async function currentState(context: BrowserContext, baseURL: string): Promise<AppState> {
  const response = await context.request.get(`${baseURL}/api/state`);
  expect(response.status()).toBe(200);
  return (await response.json()).data;
}

async function openReview(page: Page, context: BrowserContext, baseURL: string, interpretation = semantics) {
  await installTestMetaMask(context); await signInWithTestWallet(page); await dismissTour(page);
  // Fixture-only model transport and unverified agent setup. No provider or chain success is implied.
  const response = await context.request.post(`${baseURL}/api/agent`, { headers: { origin: baseURL }, data: {
    ensName: 'review-fixture.not-verified.eth', delegate: `0x${'22'.repeat(20)}`, persona: '', resolverAddress: '', policyUri: '',
    policy: { purpose: 'collaborator', allowedFields: [], allowedActions: ['discover'], expiresAt: new Date(Date.now() + 86400000).toISOString(), paused: false },
  } });
  expect(response.status()).toBe(200);
  await page.route('**/api/intent/structure', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ data: { output: { summary, goal: 'collaborator', tags: ['learning guides'], semantics: interpretation } } }) }));
  await page.goto('/intents');
  await page.getByLabel('Your intention, in your own words', { exact: true }).fill(summary);
  await page.getByRole('checkbox', { name: 'I approve sending this text to the configured model to structure my intent.', exact: true }).check();
  await page.getByRole('button', { name: 'Help shape my intent', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Review intent interpretation', exact: true })).toBeVisible();
}

test('owner corrects strength, reapproves exact fields, and persists a private draft after a denied save', async ({ page, context, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openReview(page, context, baseURL!);
  const review = page.getByRole('region', { name: 'Review intent interpretation', exact: true });
  const strength = review.getByRole('combobox', { name: 'Strength for requirement 1: writing learning guides', exact: true });
  const approval = page.getByRole('checkbox', { name: approvalLabel, exact: true });
  const save = page.getByRole('button', { name: 'Save reviewed intent', exact: true });
  await approval.check(); await expect(save).toBeEnabled();
  await strength.selectOption('preferred');
  await expect(approval).not.toBeChecked(); await expect(save).toBeDisabled();
  await expect(review.getByText('Original source quote: writes learning guides', { exact: true })).toBeVisible();
  await expect(strength).toHaveAccessibleDescription('Original source quote: writes learning guides');
  await expect(review.locator('input, textarea')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await approval.check();
  let reject = true;
  await page.route('**/api/intent', async route => {
    if (reject) await route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ error: { code: 'FIXTURE_DENIED', message: 'Intent save denied by the test authorization boundary.' } }) });
    else await route.continue();
  });
  await save.click();
  await expect(page.getByRole('alert').filter({ hasText: 'Intent save denied by the test authorization boundary.' }).first()).toBeVisible();
  expect((await currentState(context, baseURL!)).intents).toEqual([]);
  await expect(strength).toHaveValue('preferred');
  reject = false;
  const request = page.waitForRequest(value => new URL(value.url()).pathname === '/api/intent' && value.method() === 'POST');
  const response = page.waitForResponse(value => new URL(value.url()).pathname === '/api/intent' && value.request().method() === 'POST');
  await save.click();
  expect((await request).postDataJSON()).toMatchObject({ publicApproved: true, semantics: { requirements: [{ ...semantics.requirements[0], strength: 'preferred' }] } });
  const savedResponse = await response;
  expect(savedResponse.status(), await savedResponse.text()).toBe(200);
  await expect.poll(async () => (await currentState(context, baseURL!)).intents.length).toBe(1);
  const [saved] = (await currentState(context, baseURL!)).intents;
  expect(saved).toMatchObject({ status: 'draft', summary, semantics: { requirements: [{ ...semantics.requirements[0], strength: 'preferred' }] } });
  expect(saved.arkivKey).toBeUndefined(); expect(saved.transactionHash).toBeUndefined();
  await page.reload(); await page.getByRole('button', { name: 'Edit intent', exact: true }).click();
  await expect(strength).toHaveValue('preferred'); await expect(approval).not.toBeChecked();
  await strength.selectOption('unknown'); await expect(save).toBeDisabled();
  await approval.check(); await expect(save).toBeDisabled();
  await strength.selectOption('mandatory'); await expect(approval).not.toBeChecked();
  await approval.check(); await expect(save).toBeEnabled();
  await page.getByLabel('Public intent summary', { exact: true }).fill(`${summary} For a new project.`);
  await expect(review).toHaveCount(0); await expect(approval).not.toBeChecked(); await expect(save).toBeDisabled();
});

test('resolving one generated strength question preserves other unknowns and essential clarification', async ({ page, context, baseURL }) => {
  const first = { ...semantics.requirements[0], strength: 'unknown' as const };
  const second = { kind: 'role' as const, value: 'collaborator', sourceQuote: 'collaborator', strength: 'unknown' as const };
  const essential = 'What collaboration arrangement do you mean?';
  await openReview(page, context, baseURL!, { ...semantics, requirements: [first, second], clarificationQuestions: [requirementReviewQuestion(first), requirementReviewQuestion(second), essential] });
  const review = page.getByRole('region', { name: 'Review intent interpretation', exact: true });
  await review.getByLabel('Strength for requirement 1: writing learning guides', { exact: true }).selectOption('preferred');
  await expect(review.getByText(requirementReviewQuestion(first), { exact: true })).toHaveCount(0);
  await expect(review.getByText(requirementReviewQuestion(second), { exact: true })).toBeVisible();
  await expect(review.getByText(essential, { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: approvalLabel, exact: true }).check();
  await expect(page.getByRole('button', { name: 'Save reviewed intent', exact: true })).toBeDisabled();
  await review.getByLabel('Strength for requirement 2: collaborator', { exact: true }).selectOption('mandatory');
  await expect(review.getByText(requirementReviewQuestion(second), { exact: true })).toHaveCount(0);
  await expect(review.getByText(essential, { exact: true })).toBeVisible();
  await page.getByRole('checkbox', { name: approvalLabel, exact: true }).check();
  await expect(page.getByRole('button', { name: 'Save reviewed intent', exact: true })).toBeDisabled();
});

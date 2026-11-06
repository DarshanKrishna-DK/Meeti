import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { AppState, ContextDocument } from '../packages/shared/src';
import { dismissTour, installTestMetaMask, signInWithTestWallet } from './wallet-fixture';

// Production UI plus real local sessions and SQLite. Wallet EOAs are generated fixtures.
// Provider-disabled states and the injected transport failure are not live sponsor or AI evidence.
async function authenticate(page: Page, context: BrowserContext) {
  const wallet = await installTestMetaMask(context); await signInWithTestWallet(page); await dismissTour(page); return wallet;
}
async function state(context: BrowserContext, baseURL: string): Promise<AppState> {
  const response = await context.request.get(`${baseURL}/api/state`); expect(response.status()).toBe(200); return (await response.json()).data;
}
async function post(context: BrowserContext, baseURL: string, path: string, data: unknown) {
  return context.request.post(`${baseURL}/api/${path}`, { headers: { origin: baseURL }, data });
}

test('persists expanded private profile context across refresh and isolates a second wallet account', async ({ page, context, browser, baseURL }) => {
  const first = await authenticate(page, context);
  await page.goto('/profile');
  await page.getByLabel('Your name', { exact: true }).fill('Independent design collaborator');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByText('Optional professional context and sharing', { exact: true }).click();
  await page.getByLabel('Your roles', { exact: true }).fill('Developer advocate, Community builder');
  await page.getByLabel('Your skills', { exact: true }).fill('Technical writing, TypeScript');
  await page.getByLabel('Your interests', { exact: true }).fill('Developer education');
  await page.getByLabel('Your networking goals', { exact: true }).fill('Find a documentation collaborator');
  await page.getByLabel('Broad location', { exact: true }).fill('Mumbai');
  await page.getByLabel('Timezone', { exact: true }).fill('Asia/Kolkata');
  await page.getByLabel('Languages you use', { exact: true }).fill('English');
  await page.getByLabel('General availability', { exact: true }).fill('Weekends, subject to a separate meeting agreement.');
  await page.getByLabel('Collaboration mode', { exact: true }).selectOption('remote');
  await expect(page.getByLabel('How may your agent use these details?', { exact: true })).toHaveValue('private-agent');
  await page.getByLabel('How may your agent use these details?', { exact: true }).selectOption('private-agent');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Save private profile', exact: true }).click();
  await expect.poll(async () => (await state(context, baseURL!)).profile.roles).toEqual(['Developer advocate', 'Community builder']);
  await page.reload(); await page.getByRole('button', { name: '2. What connects you', exact: true }).click();
  await page.getByText('Optional professional context and sharing', { exact: true }).click();
  await expect(page.getByLabel('Timezone', { exact: true })).toHaveValue('Asia/Kolkata');
  const saved = await state(context, baseURL!);
  expect(saved.profile).toMatchObject({ skills: ['Technical writing', 'TypeScript'], contextSharing: 'private-agent', publicFields: [], aiConsent: false });
  const other = await browser.newContext({ baseURL });
  try {
    const otherPage = await other.newPage(), second = await authenticate(otherPage, other);
    expect(second.address).not.toBe(first.address);
    const separate = await state(other, baseURL!); expect(separate.user.id).not.toBe(saved.user.id); expect(separate.profile.roles || []).toEqual([]);
    expect((await post(other, baseURL!, 'profile', { ...separate.profile, displayName: 'Independent mentor', roles: ['Research mentor'], contextSharing: 'ask-first' })).status()).toBe(200);
    expect((await state(context, baseURL!)).profile.roles).toEqual(saved.profile.roles);
  } finally { await other.close(); }
});

test('saves file metadata with private scope and requires a separate public excerpt review', async ({ page, context, baseURL }) => {
  await authenticate(page, context); await page.goto('/profile');
  const library = page.getByRole('region', { name: 'A resume, with boundaries you review.', exact: true });
  await library.getByLabel('Resume or supporting file', { exact: true }).setInputFiles({ name: 'scope-fixture.txt', mimeType: 'text/plain', buffer: Buffer.from('Synthetic document context. No contact details.') });
  await library.getByLabel('File title', { exact: true }).fill('Reviewed collaboration notes');
  await library.getByLabel('Purpose or description', { exact: true }).fill('Explain my documentation contribution.');
  await library.getByRole('button', { name: 'Upload private file', exact: true }).click();
  const card = library.getByRole('article').filter({ has: page.getByRole('heading', { name: 'Reviewed collaboration notes', exact: true }) });
  await expect(card).toBeVisible();
  await expect(card.getByLabel('Excerpt sharing scope for scope-fixture.txt', { exact: true })).toHaveValue('private-agent');
  await card.getByLabel('Reviewed agent excerpt for scope-fixture.txt', { exact: true }).fill('I contribute technical documentation.');
  await card.getByLabel('Excerpt sharing scope for scope-fixture.txt', { exact: true }).selectOption('public');
  const approval = card.getByRole('checkbox', { name: 'I reviewed this exact excerpt and approve it for public excerpt scope. I understand the original file remains private.', exact: true });
  await expect(approval).not.toBeChecked();
  await card.getByRole('button', { name: 'Save excerpt and permissions', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Approve the exact reviewed excerpt' }).first()).toBeVisible();
  await approval.check(); await card.getByRole('button', { name: 'Save excerpt and permissions', exact: true }).click();
  await expect(card.getByText('Unsaved changes', { exact: true })).toHaveCount(0);
  const response = await context.request.get(`${baseURL}/api/context/files`);
  const [saved] = (await response.json()).data as ContextDocument[];
  expect(saved).toMatchObject({ title: 'Reviewed collaboration notes', description: 'Explain my documentation contribution.', sharingScope: 'public', publicExcerptApproved: true, allowAgentContext: false, allowOriginalShare: false });
  await page.reload(); await expect(page.getByLabel('Excerpt sharing scope for scope-fixture.txt', { exact: true })).toHaveValue('public');
  expect((await state(context, baseURL!)).intents).toEqual([]);
});

test('shows empty qualification history and recovers from a failed read without invented messages', async ({ page, context }) => {
  await authenticate(page, context);
  let fail = true;
  await page.route('**/api/qualifications', async route => {
    if (fail) { await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: { code: 'FIXTURE_TRANSPORT_FAILURE', message: 'Temporary qualification transport failure.' } }) }); }
    else await route.continue();
  });
  await page.goto('/activity');
  const panel = page.getByRole('region', { name: 'Live agent qualification', exact: true });
  await expect(panel.getByRole('alert')).toContainText('Temporary qualification transport failure.');
  await expect(panel.getByText('No qualification conversations yet. Explore a live candidate to start one.', { exact: true })).toBeVisible();
  fail = false; await panel.getByRole('button', { name: 'Refresh conversations', exact: true }).click();
  await expect(panel.getByRole('alert')).toHaveCount(0); await expect(panel.locator('.exchange-message')).toHaveCount(0);
  await expect(panel.getByRole('link', { name: 'Find a connection', exact: true })).toBeVisible();
});

test('requires schedule consent, reports no worker observation, and inspects identity only after an explicit action', async ({ page, context, baseURL }) => {
  await authenticate(page, context); await page.goto('/intents');
  const schedule = page.getByRole('region', { name: 'A regular check for new connections.', exact: true });
  await expect(schedule.getByRole('switch', { name: 'Scheduled discovery', exact: true })).toBeDisabled();
  expect((await post(context, baseURL!, 'discovery/settings', { enabled: true, providerDisclosureConsent: true })).status()).toBe(403);
  const current = await state(context, baseURL!);
  expect((await post(context, baseURL!, 'profile', { ...current.profile, displayName: 'Scheduled discovery owner', aiConsent: true })).status()).toBe(200);
  await page.reload();
  await schedule.getByRole('checkbox', { name: 'I approve sending approved public intent subjects to the configured embedding provider during scheduled checks.', exact: true }).check();
  await schedule.getByRole('switch', { name: 'Scheduled discovery', exact: true }).click();
  await expect(schedule.getByText('Scheduling enabled', { exact: true })).toBeVisible();
  await expect(schedule.getByText('No scheduled intent jobs are recorded yet. Active published intents can be checked when the host worker is available.', { exact: true })).toBeVisible();
  expect((await (await context.request.get(`${baseURL}/api/discovery/jobs`)).json()).data.jobs).toEqual([]);
  let identityReads = 0;
  page.on('request', request => { if (new URL(request.url()).pathname === '/api/identity') identityReads++; });
  await page.goto('/agent'); await expect(page.getByRole('button', { name: 'Open identity setup', exact: true })).toBeDisabled(); expect(identityReads).toBe(0);
  expect((await post(context, baseURL!, 'agent', { ensName: 'browser-fixture.not-verified.eth', delegate: `0x${'22'.repeat(20)}`, persona: '', resolverAddress: '', policyUri: '',
    policy: { purpose: 'collaborator', allowedFields: [], allowedActions: ['discover'], expiresAt: new Date(Date.now() + 86400000).toISOString(), paused: false } })).status()).toBe(200);
  await page.reload(); await expect(page.getByRole('button', { name: 'Open identity setup', exact: true })).toBeEnabled(); expect(identityReads).toBe(0);
  await page.getByRole('button', { name: 'Open identity setup', exact: true }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'Configure the Sepolia connection before managing identity.' })).toBeVisible();
  expect(identityReads).toBe(1);
  await expect(page.getByRole('button', { name: 'Review registry registration', exact: true })).toBeDisabled();
});

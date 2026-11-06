import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { AppState, ContextDocument } from '../packages/shared/src';
import { dismissTour, installTestMetaMask, signInWithTestWallet } from './wallet-fixture';

// These tests use the real local API. Generated test wallets do not establish live ENS authority.
async function current(context: BrowserContext, baseURL: string): Promise<AppState> {
  const response = await context.request.get(`${baseURL}/api/state`);
  expect(response.status()).toBe(200);
  return (await response.json()).data;
}

async function documents(context: BrowserContext, baseURL: string): Promise<ContextDocument[]> {
  const response = await context.request.get(`${baseURL}/api/context/files`);
  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toBe('no-store');
  return (await response.json()).data;
}

async function signIn(page: Page, context: BrowserContext) {
  const wallet = await installTestMetaMask(context);
  await signInWithTestWallet(page);
  await dismissTour(page);
  return wallet;
}

async function post(context: BrowserContext, baseURL: string, path: string, data: unknown) {
  return context.request.post(`${baseURL}/api/${path}`, { headers: { origin: baseURL }, data });
}

function pdfWithPages(pages: string[]): Buffer {
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'];
  const pageIds: number[] = [];
  for (const text of pages) {
    const pageId = objects.length + 1, streamId = pageId + 1;
    pageIds.push(pageId);
    const stream = `BT /F1 12 Tf 50 700 Td (${text}) Tj ET`;
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${streamId} 0 R >>`,
      `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${pageIds.map(id => `${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(body)); body += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(body);
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body);
}

test('saves labeled HTTPS profile links privately and persists only explicit sharing choices', async ({ page, context, baseURL }) => {
  await signIn(page, context);
  const initial = await current(context, baseURL!);
  const invalid = await post(context, baseURL!, 'profile', { ...initial.profile, displayName: 'Private link owner', socialLinks: [{ label: 'Portfolio', url: 'http://example.test/private' }] });
  expect(invalid.status()).toBe(400);
  expect((await current(context, baseURL!)).profile.socialLinks || []).toEqual([]);
  await page.goto('/profile');
  await page.getByLabel('Your name', { exact: true }).fill('Private link owner');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Add a link', exact: true }).click();
  await page.getByLabel('Link 1 label', { exact: true }).fill('Portfolio');
  await page.getByLabel('Link 1 HTTPS URL', { exact: true }).fill('http://example.test/private');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(page.getByLabel('Link 1 HTTPS URL', { exact: true })).toBeVisible();
  expect(await page.getByLabel('Link 1 HTTPS URL', { exact: true }).evaluate(element => (element as HTMLInputElement).validity.patternMismatch)).toBe(true);
  await page.getByLabel('Link 1 HTTPS URL', { exact: true }).fill('https://example.test/private-portfolio');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  const socialApproval = page.getByRole('checkbox', { name: 'I approve my saved social links for permitted agent context and exchange.', exact: true });
  const modelApproval = page.getByRole('checkbox', { name: 'I allow approved profile context to be processed by the configured model provider.', exact: true });
  await expect(socialApproval).not.toBeChecked();
  await expect(modelApproval).not.toBeChecked();
  await page.getByRole('button', { name: 'Save private profile', exact: true }).click();
  await expect(page.getByText('Saved account context', { exact: true })).toBeVisible();
  const privateState = await current(context, baseURL!);
  expect(privateState.profile).toMatchObject({ socialLinks: [{ label: 'Portfolio', url: 'https://example.test/private-portfolio' }], publicFields: [], aiConsent: false });
  await socialApproval.check();
  await modelApproval.check();
  await page.getByRole('button', { name: 'Save private profile', exact: true }).click();
  await expect(page.getByText('Saved account context', { exact: true })).toBeVisible();
  await page.reload();
  await page.getByRole('button', { name: '3. Your privacy', exact: true }).click();
  await expect(socialApproval).toBeChecked();
  await expect(modelApproval).toBeChecked();
  const approved = await current(context, baseURL!);
  expect(approved.profile.publicFields).toEqual(['socialLinks']);
  expect(approved.agent).toBeNull();
  expect(approved.intents).toEqual([]);
  expect(approved.integrations.world.status).toBe('deferred');
});

test('keeps uploaded text private, persists reviewed permissions, rejects another owner and preserves stale drafts', async ({ page, context, browser, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signIn(page, context);
  const before = await current(context, baseURL!);
  expect((await post(context, baseURL!, 'profile', { ...before.profile, displayName: 'Document owner', aiConsent: true })).status()).toBe(200);
  expect((await post(context, baseURL!, 'agent', { ensName: 'browser-fixture.owner.eth', delegate: `0x${'22'.repeat(20)}`, persona: '', resolverAddress: '', policyUri: '',
    policy: { purpose: 'collaborator', allowedFields: ['documentContext'], allowedActions: ['evaluate', 'negotiate'], expiresAt: new Date(Date.now() + 86400000).toISOString(), paused: false } })).status()).toBe(200);
  await page.goto('/profile');
  const library = page.getByRole('region', { name: 'A resume, with boundaries you review.', exact: true });
  const text = `Owner-only raw notes ${randomUUID()}\nA reviewed design collaborator.\nPrivate email: owner@example.test`;
  await library.getByLabel('Resume or supporting file', { exact: true }).setInputFiles({ name: 'private-notes.txt', mimeType: 'text/plain', buffer: Buffer.from(text) });
  let release!: () => void;
  let applied!: () => void;
  const held = new Promise<void>(resolveReady => { applied = resolveReady; });
  const gate = new Promise<void>(resolveGate => { release = resolveGate; });
  await page.route('**/api/context/files', async route => {
    if (route.request().method() !== 'POST') { await route.continue(); return; }
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    applied();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await library.getByRole('button', { name: 'Upload private file', exact: true }).click();
    await held;
    await expect(library.getByLabel('Resume or supporting file', { exact: true })).toBeDisabled();
    await expect(library.getByRole('button', { name: 'Upload private file', exact: true })).toBeDisabled();
    await expect(library.getByRole('button', { name: 'Refresh files', exact: true })).toBeDisabled();
    release();
    await expect(library.getByRole('heading', { name: 'private-notes.txt', exact: true })).toBeVisible();
  } finally { release(); await page.unrouteAll({ behavior: 'wait' }); }
  const card = library.getByRole('article').filter({ has: page.getByRole('heading', { name: 'private-notes.txt', exact: true }) });
  const uploaded = (await documents(context, baseURL!))[0];
  expect(uploaded).toMatchObject({ version: 1, extractionStatus: 'ready', extractedText: text, reviewedExcerpt: '', allowAgentContext: false, allowOriginalShare: false });
  await card.getByText('Review extracted text', { exact: true }).click();
  await expect(card.getByText(text, { exact: true })).toBeVisible();
  await card.getByRole('button', { name: 'Copy first 1,200 characters into my draft', exact: true }).click();
  const excerpt = card.getByLabel('Reviewed agent excerpt for private-notes.txt', { exact: true });
  await expect(excerpt).toHaveValue(text);
  await excerpt.fill('A reviewed design collaborator.');
  await card.getByRole('checkbox', { name: 'Allow my agent to use and exchange this reviewed excerpt.', exact: true }).check();
  await card.getByRole('checkbox', { name: 'Allow me to explicitly share this original file inside an authorized introduction room.', exact: true }).check();
  await card.getByRole('button', { name: 'Save excerpt and permissions', exact: true }).click();
  await expect(card.getByText('Excerpt approved', { exact: true })).toBeVisible();
  const approved = (await documents(context, baseURL!))[0];
  expect(approved).toMatchObject({ version: 2, reviewedExcerpt: 'A reviewed design collaborator.', allowAgentContext: true, allowOriginalShare: true });
  await expect(card.getByText('World approval is paused. Original file sharing remains locked.', { exact: true })).toBeVisible();
  await expect(card.getByRole('button', { name: 'Create protected original file link', exact: true })).toHaveCount(0);
  const download = await context.request.get(`${baseURL}/api/context/files/${uploaded.id}/download`);
  expect(download.status()).toBe(200);
  expect(download.headers()).toMatchObject({ 'content-type': 'application/octet-stream', 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff' });
  expect((await download.body()).toString()).toBe(text);
  const other = await browser.newContext({ baseURL });
  try {
    const otherPage = await other.newPage();
    await signIn(otherPage, other);
    expect(await documents(other, baseURL!)).toEqual([]);
    expect((await other.request.get(`${baseURL}/api/context/files/${uploaded.id}/download`)).status()).toBe(404);
    expect((await post(other, baseURL!, `context/files/${uploaded.id}/update`, { expectedVersion: 2, reviewedExcerpt: 'Forged', allowAgentContext: true, allowOriginalShare: true })).status()).toBe(404);
    expect((await post(other, baseURL!, `context/files/${uploaded.id}/delete`, { expectedVersion: 2 })).status()).toBe(404);
  } finally { await other.close(); }
  await excerpt.fill('Preserved local excerpt draft.');
  expect((await post(context, baseURL!, `context/files/${uploaded.id}/update`, { expectedVersion: 2, reviewedExcerpt: 'Saved in another session.', allowAgentContext: false, allowOriginalShare: false })).status()).toBe(200);
  await library.getByRole('button', { name: 'Refresh files', exact: true }).click();
  await expect(card.getByRole('status')).toContainText('This file changed in another session.');
  await expect(excerpt).toHaveValue('Preserved local excerpt draft.');
  await expect(card.getByRole('button', { name: 'Save excerpt and permissions', exact: true })).toBeDisabled();
  const stale = await post(context, baseURL!, `context/files/${uploaded.id}/update`, { expectedVersion: 2, reviewedExcerpt: 'Stale overwrite.', allowAgentContext: true, allowOriginalShare: true });
  expect(stale.status()).toBe(409);
  expect((await stale.json()).error.code).toBe('DOCUMENT_CHANGED');
  await card.getByRole('button', { name: 'I reviewed the changes. Keep my draft.', exact: true }).click();
  await card.getByRole('button', { name: 'Save excerpt and permissions', exact: true }).click();
  await expect(card.getByText('Excerpt approved', { exact: true })).toBeVisible();
  expect((await documents(context, baseURL!))[0]).toMatchObject({ version: 4, reviewedExcerpt: 'Preserved local excerpt draft.', allowAgentContext: true, allowOriginalShare: true });
  await page.reload();
  await expect(page.getByLabel('Reviewed agent excerpt for private-notes.txt', { exact: true })).toHaveValue('Preserved local excerpt draft.');
  mkdirSync(resolve('artifacts/redesign'), { recursive: true });
  await page.screenshot({ path: resolve('artifacts/redesign/context-profile-files-1440.png'), fullPage: true, animations: 'disabled' });
  const reloadedCard = page.getByRole('article').filter({ has: page.getByRole('heading', { name: 'private-notes.txt', exact: true }) });
  await reloadedCard.getByRole('button', { name: 'Review file deletion', exact: true }).click();
  await reloadedCard.getByRole('button', { name: 'Delete this file', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'private-notes.txt', exact: true })).toHaveCount(0);
  expect(await documents(context, baseURL!)).toEqual([]);
  expect((await context.request.get(`${baseURL}/api/context/files/${uploaded.id}/download`)).status()).toBe(404);
});

test('extracts only the first five actual PDF pages and enforces browser size and file capacity limits', async ({ page, context, baseURL }) => {
  await signIn(page, context);
  await page.goto('/profile');
  const library = page.getByRole('region', { name: 'A resume, with boundaries you review.', exact: true });
  const input = library.getByLabel('Resume or supporting file', { exact: true });
  await input.setInputFiles({ name: 'too-large.txt', mimeType: 'text/plain', buffer: Buffer.alloc(1024 * 1024 + 1, 'a') });
  await library.getByRole('button', { name: 'Upload private file', exact: true }).click();
  await expect(library.getByRole('alert')).toContainText('The file must contain data and be no larger than 1 MiB.');
  expect(await documents(context, baseURL!)).toEqual([]);
  const pages = Array.from({ length: 6 }, (_, index) => `UNIQUE-PDF-PAGE-${index + 1}`);
  await input.setInputFiles({ name: 'six-pages.pdf', mimeType: 'application/pdf', buffer: pdfWithPages(pages) });
  await library.getByRole('button', { name: 'Upload private file', exact: true }).click();
  await expect(library.getByRole('heading', { name: 'six-pages.pdf', exact: true })).toBeVisible();
  const pdf = (await documents(context, baseURL!))[0];
  expect(pdf).toMatchObject({ extractionStatus: 'ready', reviewedExcerpt: '', allowAgentContext: false, allowOriginalShare: false });
  for (const text of pages.slice(0, 5)) expect(pdf.extractedText).toContain(text);
  expect(pdf.extractedText).not.toContain(pages[5]);
  expect(pdf.extractedText.length).toBeLessThanOrEqual(12000);
  await library.getByText('Review extracted text', { exact: true }).click();
  await expect(library.getByText(/UNIQUE-PDF-PAGE-5/)).toBeVisible();
  await expect(library.getByText(/UNIQUE-PDF-PAGE-6/)).toHaveCount(0);
  await expect(library.getByRole('checkbox', { name: 'Allow my agent to use and exchange this reviewed excerpt.', exact: true })).toBeDisabled();
  for (let index = 1; index <= 4; index += 1) {
    const result = await post(context, baseURL!, 'context/files', { name: `private-${index}.txt`, mimeType: 'text/plain', contentBase64: Buffer.from(`Private supporting note ${index}`).toString('base64') });
    expect(result.status()).toBe(200);
  }
  await library.getByRole('button', { name: 'Refresh files', exact: true }).click();
  await expect(library.getByText('5 of 5 files', { exact: true })).toBeVisible();
  await input.setInputFiles({ name: 'sixth.txt', mimeType: 'text/plain', buffer: Buffer.from('One file too many.') });
  await expect(library.getByRole('button', { name: 'Upload private file', exact: true })).toBeDisabled();
  const sixth = await post(context, baseURL!, 'context/files', { name: 'sixth.txt', mimeType: 'text/plain', contentBase64: Buffer.from('One file too many.').toString('base64') });
  expect(sixth.status()).toBe(413);
  expect((await sixth.json()).error.code).toBe('DOCUMENT_LIMIT');
  expect(await documents(context, baseURL!)).toHaveLength(5);
});

test('reviews policy defaults, saves immutable versions and restores old permissions to a draft without ENS activation', async ({ page, context, baseURL }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const wallet = await signIn(page, context);
  await page.goto('/agent');
  for (const action of ['Discover public intents', 'Publish reviewed intents', 'Evaluate compatibility', 'Exchange permitted context', 'Propose introductions', 'Send room messages']) await expect(page.getByRole('checkbox', { name: action, exact: action !== 'Send room messages' })).toBeChecked();
  for (const field of ['headline', 'tags', 'offering', 'seeking']) await expect(page.getByRole('checkbox', { name: `Allow ${field} disclosure`, exact: true })).toBeChecked();
  for (const field of ['displayName', 'bio', 'socialLinks', 'documentContext', 'contact', 'employer']) await expect(page.getByRole('checkbox', { name: `Allow ${field} disclosure`, exact: true })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Allow contact disclosure', exact: true })).toBeDisabled();
  await expect(page.getByRole('checkbox', { name: 'Allow employer disclosure', exact: true })).toBeDisabled();
  const defaultExpiry = await page.getByLabel('Permission expires', { exact: true }).inputValue();
  expect(new Date(defaultExpiry).getTime() - Date.now()).toBeGreaterThan(6.9 * 86400000);
  expect(new Date(defaultExpiry).getTime() - Date.now()).toBeLessThanOrEqual(7 * 86400000);
  await page.getByLabel('Agent ENS name', { exact: true }).fill('policy-browser-fixture.owner.eth');
  await page.getByLabel('Delegated wallet', { exact: true }).fill(`0x${'33'.repeat(20)}`);
  await page.getByLabel('Active policy purpose', { exact: true }).selectOption('mentor');
  await page.getByRole('checkbox', { name: 'Allow socialLinks disclosure', exact: true }).check();
  await page.getByRole('checkbox', { name: 'Allow documentContext disclosure', exact: true }).check();
  const expiry = new Date(Date.now() + 2 * 86400000);
  const localExpiry = new Date(expiry.getTime() - expiry.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  await page.getByLabel('Permission expires', { exact: true }).fill(localExpiry);
  await page.getByRole('button', { name: 'Save policy for ENS review', exact: true }).click();
  await expect(page.getByText('Policy v1', { exact: true })).toBeVisible();
  const first = (await current(context, baseURL!)).agent!;
  expect(first.policy).toMatchObject({ version: 1, purpose: 'mentor', expiresAt: new Date(localExpiry).toISOString() });
  expect(first.policy.allowedFields).toEqual(['headline', 'tags', 'offering', 'seeking', 'socialLinks', 'documentContext']);
  expect(first.authority).toBeNull();
  await page.getByLabel('Active policy purpose', { exact: true }).selectOption('teammate');
  await page.getByRole('button', { name: 'Reset draft to recommended defaults', exact: true }).click();
  await expect(page.getByLabel('Active policy purpose', { exact: true })).toHaveValue('teammate');
  await expect(page.getByRole('checkbox', { name: 'Allow documentContext disclosure', exact: true })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Allow socialLinks disclosure', exact: true })).not.toBeChecked();
  expect((await current(context, baseURL!)).agent!.policy).toEqual(first.policy);
  await page.getByRole('button', { name: 'Save policy for ENS review', exact: true }).click();
  await expect(page.getByText('Policy v2', { exact: true })).toBeVisible();
  await page.getByText('Saved policy version history', { exact: true }).click();
  await page.getByRole('button', { name: 'Load saved policy versions', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Version 1: Find a mentor', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Version 2: Find a teammate', exact: true })).toBeVisible();
  const historyBefore = (await context.request.get(`${baseURL}/api/agent/policies`).then(response => response.json())).data;
  expect(historyBefore.map((entry: { policy: { version: number } }) => entry.policy.version)).toEqual([2, 1]);
  expect(historyBefore[1].policy).toEqual(first.policy);
  const mutations: string[] = [];
  page.on('request', request => { if (request.url().includes('/api/') && request.method() === 'POST') mutations.push(new URL(request.url()).pathname); });
  await page.getByRole('button', { name: 'Copy version 1 permissions into draft', exact: true }).click();
  await expect(page.getByText('Unsaved policy draft', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Active policy purpose', { exact: true })).toHaveValue('mentor');
  await expect(page.getByRole('checkbox', { name: 'Allow documentContext disclosure', exact: true })).toBeChecked();
  expect((await current(context, baseURL!)).agent!.policy.version).toBe(2);
  expect(mutations).toEqual([]);
  await page.getByRole('button', { name: 'Save policy for ENS review', exact: true }).click();
  await expect(page.getByText('Policy v3', { exact: true })).toBeVisible();
  const restored = (await current(context, baseURL!)).agent!;
  expect(restored.policy).toEqual({ ...first.policy, version: 3 });
  expect(restored.authority).toBeNull();
  const historyAfter = (await context.request.get(`${baseURL}/api/agent/policies`).then(response => response.json())).data;
  expect(historyAfter.slice(1)).toEqual(historyBefore);
  mkdirSync(resolve('artifacts/redesign'), { recursive: true });
  await page.screenshot({ path: resolve('artifacts/redesign/context-policy-history-1440.png'), fullPage: true, animations: 'disabled' });
  expect(mutations).toEqual(['/api/agent']);
  expect(wallet.calls).not.toContain('eth_sendTransaction');
  expect(wallet.calls).not.toContain('eth_signTypedData_v4');
  expect((await current(context, baseURL!)).integrations.world.status).toBe('deferred');
});

test('fits the public hero at desktop sizes and retains a seamless controllable foundations belt', async ({ page }, testInfo) => {
  const observations = [];
  for (const size of [{ width: 1280, height: 720 }, { width: 1440, height: 900 }]) {
    await page.setViewportSize(size);
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    await page.evaluate(() => document.fonts.ready);
    await expect(page.getByText('A little intention goes a long way', { exact: false })).toHaveCount(0);
    const layout = await page.evaluate(() => {
      const nav = document.querySelector('.landing-nav')!.getBoundingClientRect();
      const hero = document.querySelector('.hero')!.getBoundingClientRect();
      return { nav: nav.height, heroBottom: hero.bottom, viewport: innerHeight, document: document.documentElement.scrollWidth, width: innerWidth };
    });
    expect(layout.nav).toBeCloseTo(72, 0);
    expect(layout.heroBottom).toBeLessThanOrEqual(size.height + 2);
    expect(layout.document).toBeLessThanOrEqual(size.width + 1);
    observations.push({ ...size, ...layout });
  }
  const belt = page.getByRole('region', { name: 'Product foundations', exact: true });
  const track = belt.locator('.foundations-track');
  const animation = await track.evaluate(element => {
    const style = getComputedStyle(element);
    const sequences = [...element.children].map(child => ({ width: child.getBoundingClientRect().width, content: child.textContent }));
    return { name: style.animationName, duration: style.animationDuration, state: style.animationPlayState, sequences };
  });
  expect(animation.name).toBe('foundations-travel');
  expect(animation.state).toBe('running');
  expect(animation.sequences).toHaveLength(2);
  expect(animation.sequences[0]).toEqual(animation.sequences[1]);
  await expect(belt.locator('.foundations-sequence').nth(1)).toHaveAttribute('aria-hidden', 'true');
  const leftward = await track.evaluate(async element => {
    const animation = element.getAnimations()[0];
    animation.pause();
    animation.currentTime = 0;
    const start = new DOMMatrixReadOnly(getComputedStyle(element).transform).m41;
    animation.currentTime = 24000;
    const middle = new DOMMatrixReadOnly(getComputedStyle(element).transform).m41;
    animation.play();
    return { start, middle };
  });
  expect(leftward.middle).toBeLessThan(leftward.start);
  await expect(belt.getByRole('button')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect.poll(() => track.evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  for (const width of [320, 390]) {
    await page.setViewportSize({ width, height: 844 });
    const mobile = await page.evaluate(() => ({ nav: document.querySelector('.landing-nav')!.getBoundingClientRect().height, width: innerWidth, document: document.documentElement.scrollWidth }));
    expect(mobile.nav).toBeCloseTo(64, 0);
    expect(mobile.document).toBeLessThanOrEqual(width + 1);
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    observations.push(mobile);
  }
  mkdirSync(resolve('artifacts/redesign'), { recursive: true });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/');
  await expect(page.getByRole('figure', { name: 'How a permissioned introduction works' }).locator('[data-artwork-ready]')).toHaveAttribute('data-artwork-ready', 'true');
  await page.screenshot({ path: resolve('artifacts/redesign/context-landing-desktop.png'), fullPage: true, animations: 'disabled' });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: resolve('artifacts/redesign/context-landing-390.png'), fullPage: true, animations: 'disabled' });
  await testInfo.attach('hero-and-belt-layout', { body: JSON.stringify({ observations, animation, leftward }, null, 2), contentType: 'application/json' });
});

test('persists the theme switch and keeps all ten workspace routes usable in both themes at desktop and mobile widths', async ({ page, context }, testInfo) => {
  test.setTimeout(180000);
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.getByRole('button', { name: 'Use dark theme', exact: true })).toBeVisible();
  const lightArtwork = await page.locator('[data-part-group="carriage"] .iso-top').first().evaluate(element => getComputedStyle(element).fill);
  await page.getByRole('button', { name: 'Use dark theme', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByTestId('theme-toggle')).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => localStorage.getItem('meeti.theme'))).toBe('dark');
  await expect.poll(() => page.locator('[data-part-group="carriage"] .iso-top').first().evaluate(element => getComputedStyle(element).fill)).not.toBe(lightArtwork);
  const darkArtwork = await page.locator('[data-part-group="carriage"] .iso-top').first().evaluate(element => getComputedStyle(element).fill);
  expect(darkArtwork).not.toBe(lightArtwork);
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  const second = await context.newPage();
  try {
    await second.goto('/');
    await expect(second.locator('html')).toHaveAttribute('data-theme', 'dark');
    await page.getByRole('button', { name: 'Use light theme', exact: true }).click();
    await expect(second.locator('html')).toHaveAttribute('data-theme', 'light');
  } finally { await second.close(); }
  await signIn(page, context);
  const routes = ['dashboard', 'profile', 'agent', 'intents', 'discover', 'activity', 'approvals', 'introductions', 'settings', 'verify'];
  const observations = [];
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    for (const theme of ['light', 'dark'] as const) {
      const active = await page.locator('html').getAttribute('data-theme');
      if (active !== theme) await page.getByTestId('theme-toggle').click();
      for (const route of routes) {
        await page.goto(`/${route}`);
        await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
        await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
        await expect(page.getByTestId('theme-toggle')).toHaveAttribute('aria-pressed', String(theme === 'dark'));
        const sample = await page.evaluate(() => {
          const color = (value: string) => {
            const channels = value.match(/[\d.]+/g)?.map(Number) || [];
            if (channels.length < 3 || (channels.length > 3 && channels[3] === 0)) return null;
            return (channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722) / 255;
          };
          const surfaces = [...document.querySelectorAll('.panel, .topbar, .sidebar, .dashboard-setup, .profile-privacy-note, .agent-pause-note, input:not([type="checkbox"]):not([type="file"]), textarea, select, [role="dialog"]')]
            .filter(element => { const box = element.getBoundingClientRect(); return box.width > 0 && box.height > 0; })
            .map(element => { const style = getComputedStyle(element); return { element: element.tagName, className: String(element.className), background: style.backgroundColor, brightness: color(style.backgroundColor), foreground: style.color }; })
            .filter(item => item.brightness !== null);
          return { document: document.documentElement.scrollWidth, viewport: innerWidth, body: getComputedStyle(document.body).backgroundColor, surfaces };
        });
        expect(sample.document, `Overflow on /${route} in ${theme} at ${width}px`).toBeLessThanOrEqual(width + 1);
        expect(sample.surfaces.length, `No theme surfaces sampled on /${route}`).toBeGreaterThan(0);
        if (theme === 'dark') expect(sample.surfaces.filter(surface => surface.brightness! > .48), `Light surfaces on dark /${route} at ${width}px`).toEqual([]);
        observations.push({ route, theme, width, ...sample });
        if (width === 1440 && theme === 'light' && ['profile', 'agent'].includes(route)) {
          mkdirSync(resolve('artifacts/redesign'), { recursive: true });
          await page.screenshot({ path: resolve(`artifacts/redesign/context-${route}-1440.png`), fullPage: true, animations: 'disabled' });
        }
      }
    }
  }
  await page.goto('/');
  mkdirSync(resolve('artifacts/redesign'), { recursive: true });
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: width === 1440 ? 900 : 844 });
    await expect(page.getByRole('figure', { name: 'How a permissioned introduction works' }).locator('[data-artwork-ready]')).toHaveAttribute('data-artwork-ready', 'true');
    await page.screenshot({ path: resolve(`artifacts/redesign/context-landing-dark-${width}.png`), fullPage: true, animations: 'disabled' });
  }
  expect(errors).toEqual([]);
  await testInfo.attach('both-theme-route-measurements', { body: JSON.stringify({ lightArtwork, darkArtwork, observations, errors }, null, 2), contentType: 'application/json' });
});

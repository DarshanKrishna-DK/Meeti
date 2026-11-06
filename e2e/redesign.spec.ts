import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import type { AppState, Profile } from '../packages/shared/src';

// Isolated real API accounts only. These tests do not establish live sponsor acceptance.
const password = 'a redesigned browser test password 2026';
const routes = ['dashboard', 'profile', 'agent', 'intents', 'discover', 'activity', 'approvals', 'introductions', 'settings', 'verify'];
const captures = new Set(['dashboard', 'profile', 'discover', 'approvals', 'settings']);

async function capture(page: Page, label: string) {
  const directory = resolve('artifacts/redesign');
  mkdirSync(directory, { recursive: true });
  const belowFoldLogo = page.locator('#privacy img');
  if (await belowFoldLogo.count()) {
    await belowFoldLogo.scrollIntoViewIfNeeded();
    await belowFoldLogo.evaluate(image => (image as HTMLImageElement).decode());
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  }
  await page.screenshot({ path: resolve(directory, `${label}.png`), fullPage: true, animations: 'disabled' });
}

async function createAccount(context: BrowserContext, baseURL: string) {
  const email = `redesign-${randomUUID()}@example.test`;
  const result = await context.request.post(`${baseURL}/api/auth/register`, {
    headers: { origin: baseURL }, data: { email, password },
  });
  expect(result.status()).toBe(200);
  const tour = await context.request.post(`${baseURL}/api/onboarding`, { headers: { origin: baseURL }, data: { tourCompleted: true } });
  expect(tour.status()).toBe(200);
  return { email, password };
}
async function state(context: BrowserContext, baseURL: string): Promise<AppState> {
  const response = await context.request.get(`${baseURL}/api/state`);
  expect(response.status()).toBe(200);
  expect(response.headers()['cache-control']).toBe('no-store');
  return (await response.json()).data;
}
async function saveProfile(context: BrowserContext, baseURL: string, value: Profile) {
  const response = await context.request.post(`${baseURL}/api/profile`, { headers: { origin: baseURL }, data: value });
  expect(response.status()).toBe(200);
}
async function noOverflow(page: Page) {
  const widths = await page.evaluate(() => ({ viewport: window.innerWidth, document: document.documentElement.scrollWidth }));
  expect(widths.document, `Document ${widths.document}px exceeds viewport ${widths.viewport}px`).toBeLessThanOrEqual(widths.viewport + 1);
  return widths;
}

async function holdOneActualStateResponse(page: Page) {
  let release!: () => void;
  let captured!: () => void;
  let held = false;
  const ready = new Promise<void>(resolveReady => { captured = resolveReady; });
  const gate = new Promise<void>(resolveGate => { release = resolveGate; });
  await page.route('**/api/state', async request => {
    if (held) { await request.continue(); return; }
    held = true;
    // Keep an actual pre-mutation API snapshot in flight. Do not invent or edit its data.
    const response = await request.fetch();
    captured();
    await gate;
    await request.fulfill({ response });
  });
  return { ready, release };
}
async function pausePolling(page: Page) {
  // Keep the twelve-second interval from concealing a missed focus or mutation refresh.
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
}
function waitForProfileResponse(page: Page, displayName: string) {
  return page.waitForResponse(async response => {
    if (!response.url().endsWith('/api/state') || response.request().method() !== 'GET' || response.status() !== 200) return false;
    return (await response.json()).data?.profile?.displayName === displayName;
  });
}

for (const width of [320, 390, 768, 1440]) {
  test(`renders the rebuilt landing and every authenticated route at ${width}px without overflow`, async ({ page, context, baseURL }, testInfo) => {
    test.setTimeout(120_000);
    const errors: string[] = [];
    const consoleErrors: string[] = [];
    const consoleWarnings: string[] = [];
    const observations: unknown[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error') consoleErrors.push(message.text());
      if (message.type() === 'warning') consoleWarnings.push(message.text());
    });
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
    observations.push({ route: '/', ...await noOverflow(page) });
    if (width === 390 || width === 1440) {
      await expect(page.getByRole('figure', { name: 'How a permissioned introduction works' }).locator('[data-artwork-ready]'))
        .toHaveAttribute('data-artwork-ready', 'true');
      await capture(page, `landing-${width}`);
    }
    await createAccount(context, baseURL!);
    for (const route of routes) {
      await page.goto(`/${route}`);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(1);
      if (route === 'dashboard') {
        await expect(page.getByRole('button', { name: 'Continue guided setup', exact: true })).toBeVisible();
        await expect(page.locator('.dashboard-setup').getByText('Saved', { exact: true })).toHaveCount(0);
      }
      const dimensions = await noOverflow(page);
      const visibleButtons = await page.getByRole('button').evaluateAll(elements => elements
        .filter(element => { const rect = element.getBoundingClientRect(); return rect.width > 0 && rect.height > 0; })
        .map(element => ({ name: element.getAttribute('aria-label') || element.textContent?.trim(), height: element.getBoundingClientRect().height })));
      expect(visibleButtons.filter(button => button.height < 43), `Small tap targets on ${route} at ${width}px`).toEqual([]);
      observations.push({ route: `/${route}`, ...dimensions, visibleButtonCount: visibleButtons.length, minimumButtonHeight: Math.min(...visibleButtons.map(button => button.height)) });
      if ((width === 390 || width === 1440) && captures.has(route)) await capture(page, `${route}-${width}`);
    }
    expect(errors).toEqual([]);
    expect(consoleErrors).toEqual([]);
    await testInfo.attach('viewport-route-measurements', {
      body: JSON.stringify({ width, observations, errors, consoleErrors, consoleWarnings }, null, 2), contentType: 'application/json',
    });
  });
}

test('uses separate actual account contexts and never shares private profile state across them', async ({ browser, baseURL }) => {
  const a = await browser.newContext(), b = await browser.newContext();
  try {
    const left = await createAccount(a, baseURL!), right = await createAccount(b, baseURL!);
    const original = await state(a, baseURL!);
    const contact = `private-redesign-${randomUUID()}`;
    await saveProfile(a, baseURL!, { ...original.profile, displayName: 'First isolated participant', contact, publicFields: [] });
    const first = await a.newPage(), second = await b.newPage();
    await first.goto(`${baseURL}/profile`);
    await second.goto(`${baseURL}/profile`);
    await expect(first.getByLabel('Your name', { exact: true })).toHaveValue('First isolated participant');
    await expect(second.getByLabel('Your name', { exact: true })).not.toHaveValue('First isolated participant');
    const other = await state(b, baseURL!);
    expect(other.user.email).toBe(right.email);
    expect(JSON.stringify(other)).not.toContain(contact);
    expect(JSON.stringify(other)).not.toContain(left.email);
    expect(other.profile.publicFields).toEqual([]);
    expect(other.agent).toBeNull();
    expect(other.rooms).toEqual([]);
    expect(other.integrations.world.status).toBe('deferred');
    expect((await b.request.get(`${baseURL}/api/rooms/${randomUUID()}`)).status()).toBe(404);
  } finally {
    await a.close();
    await b.close();
  }
});

test('refreshes actual shared-account state on focus while preserving unsaved profile edits', async ({ browser, baseURL }) => {
  const a = await browser.newContext(), b = await browser.newContext();
  try {
    const account = await createAccount(a, baseURL!);
    const login = await b.request.post(`${baseURL}/api/auth/login`, { headers: { origin: baseURL! }, data: account });
    expect(login.status()).toBe(200);
    const original = await state(a, baseURL!);
    const page = await a.newPage();
    await page.goto(`${baseURL}/profile`);
    const draftName = `Unsaved edit ${randomUUID().slice(0, 6)}`;
    await page.getByLabel('Your name', { exact: true }).fill(draftName);
    await saveProfile(b, baseURL!, { ...original.profile, displayName: 'Remote saved participant' });
    const refreshed = page.waitForResponse(response => response.url().endsWith('/api/state') && response.request().method() === 'GET');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    expect((await refreshed).status()).toBe(200);
    await expect(page.getByLabel('Signed-in account', { exact: true })).toContainText('Remote saved participant');
    await expect(page.getByLabel('Your name', { exact: true })).toHaveValue(draftName);
    expect((await state(a, baseURL!)).profile.displayName).toBe('Remote saved participant');
    const conflict = page.getByRole('status').filter({ hasText: 'Your saved profile changed in another session.' });
    await expect(conflict).toBeVisible();
    await page.getByRole('button', { name: '3. Your privacy', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Save private profile', exact: true })).toBeDisabled();
    await conflict.getByText('Review the latest saved values', { exact: true }).click();
    await expect(conflict.getByText('Remote saved participant', { exact: true })).toBeVisible();
    await conflict.getByRole('button', { name: 'I reviewed the changes. Keep my draft.', exact: true }).click();
    await expect(conflict).toHaveCount(0);
    const saved = page.waitForResponse(response => response.url().endsWith('/api/profile') && response.request().method() === 'POST');
    await page.getByRole('button', { name: 'Save private profile', exact: true }).click();
    expect((await saved).status()).toBe(200);
    await expect(page.getByLabel('Signed-in account', { exact: true })).toContainText(draftName);
    expect((await state(a, baseURL!)).profile.displayName).toBe(draftName);
  } finally {
    await a.close();
    await b.close();
  }
});

test('refreshes a pristine profile from an independently authenticated session without a reload', async ({ browser, baseURL }) => {
  const a = await browser.newContext(), b = await browser.newContext();
  try {
    const account = await createAccount(a, baseURL!);
    const login = await b.request.post(`${baseURL}/api/auth/login`, { headers: { origin: baseURL! }, data: account });
    expect(login.status()).toBe(200);
    const original = await state(a, baseURL!);
    const page = await a.newPage();
    await page.goto(`${baseURL}/profile`);
    await expect(page.getByLabel('Your name', { exact: true })).toHaveValue(original.profile.displayName);
    await saveProfile(b, baseURL!, { ...original.profile, displayName: 'Changed from another device session', headline: 'A fresh saved remote headline' });
    const refreshed = page.waitForResponse(response => response.url().endsWith('/api/state') && response.request().method() === 'GET');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    expect((await refreshed).status()).toBe(200);
    await expect(page.getByLabel('Your name', { exact: true })).toHaveValue('Changed from another device session');
    await expect(page.getByLabel('A one-line introduction', { exact: true })).toHaveValue('A fresh saved remote headline');
    await expect(page.getByLabel('Signed-in account', { exact: true })).toContainText('Changed from another device session');
  } finally {
    await a.close();
    await b.close();
  }
});

test('fetches a new state after a profile save rather than reusing a held pre-mutation snapshot', async ({ page, context, baseURL }) => {
  await createAccount(context, baseURL!);
  await page.clock.install();
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/profile');
  await expect(page.getByLabel('Your name', { exact: true })).toBeVisible();
  await pausePolling(page);
  const held = await holdOneActualStateResponse(page);
  try {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await held.ready;
    const name = 'Saved after the older snapshot was captured';
    await page.getByLabel('Your name', { exact: true }).fill(name);
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    const saved = page.waitForResponse(response => response.url().endsWith('/api/profile') && response.request().method() === 'POST');
    const fresh = waitForProfileResponse(page, name);
    await page.getByRole('button', { name: 'Save private profile', exact: true }).click();
    expect((await saved).status()).toBe(200);
    held.release();
    expect((await fresh).status()).toBe(200);
    await expect(page.getByLabel('Signed-in account', { exact: true })).toContainText(name);
    await page.getByRole('button', { name: '1. About you', exact: true }).click();
    await expect(page.getByLabel('Your name', { exact: true })).toHaveValue(name);
    expect((await state(context, baseURL!)).profile.displayName).toBe(name);
  } finally {
    held.release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('disables native profile controls during an actual pending save and restores them after confirmation', async ({ page, context, baseURL }) => {
  await createAccount(context, baseURL!);
  await page.goto('/profile');
  const name = 'A profile saved while its response is pending';
  const contact = `pending-save-${randomUUID()}`;
  await page.getByLabel('Your name', { exact: true }).fill(name);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Private contact', { exact: true }).fill(contact);
  let release!: () => void;
  let applied!: (status: number) => void;
  const gate = new Promise<void>(resolveGate => { release = resolveGate; });
  const actualSave = new Promise<number>(resolveSave => { applied = resolveSave; });
  await page.route('**/api/profile', async request => {
    // The isolated backend applies the real save. Only delivery of its response is delayed.
    const response = await request.fetch();
    applied(response.status());
    await gate;
    await request.fulfill({ response });
  });
  try {
    await page.getByRole('button', { name: 'Save private profile', exact: true }).click();
    expect(await actualSave).toBe(200);
    const controls = page.getByRole('group', { name: 'Workspace controls', exact: true });
    await expect(controls).toHaveAttribute('disabled', '');
    await expect(controls).toHaveAttribute('aria-busy', 'true');
    await expect(page.getByLabel('Private contact', { exact: true })).toBeDisabled();
    await expect(page.getByLabel('Private employer', { exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Save private profile', exact: true })).toBeDisabled();
    expect((await state(context, baseURL!)).profile.contact).toBe(contact);
    release();
    await expect(controls).not.toHaveAttribute('disabled', '');
    await expect(controls).toHaveAttribute('aria-busy', 'false');
    await expect(page.getByLabel('Private contact', { exact: true })).toBeEnabled();
    await expect(page.getByLabel('Private contact', { exact: true })).toHaveValue(contact);
    await expect(page.getByLabel('Signed-in account', { exact: true })).toContainText(name);
    expect((await state(context, baseURL!)).profile.displayName).toBe(name);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('queues a new focus refresh when another session saves during an older state request', async ({ browser, baseURL }) => {
  const a = await browser.newContext(), b = await browser.newContext();
  let held: Awaited<ReturnType<typeof holdOneActualStateResponse>> | undefined;
  try {
    const account = await createAccount(a, baseURL!);
    expect((await b.request.post(`${baseURL}/api/auth/login`, { headers: { origin: baseURL! }, data: account })).status()).toBe(200);
    const original = await state(a, baseURL!);
    const page = await a.newPage();
    await page.clock.install();
    await page.goto(`${baseURL}/profile`);
    await expect(page.getByLabel('Your name', { exact: true })).toHaveValue(original.profile.displayName);
    await pausePolling(page);
    held = await holdOneActualStateResponse(page);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await held.ready;
    const name = 'Fresh external-session update after the captured read';
    await saveProfile(b, baseURL!, { ...original.profile, displayName: name });
    const fresh = waitForProfileResponse(page, name);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    held.release();
    expect((await fresh).status()).toBe(200);
    await expect(page.getByLabel('Your name', { exact: true })).toHaveValue(name);
    await expect(page.getByLabel('Signed-in account', { exact: true })).toContainText(name);
  } finally {
    held?.release();
    await a.close();
    await b.close();
  }
});

test('does not restore a private workspace from an older state response after logout', async ({ page, context, baseURL }) => {
  await createAccount(context, baseURL!);
  const original = await state(context, baseURL!);
  await page.clock.install();
  await page.goto('/dashboard');
  await expect(page.getByLabel('Signed-in account', { exact: true })).toContainText(original.profile.displayName);
  await pausePolling(page);
  const held = await holdOneActualStateResponse(page);
  try {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await held.ready;
    const loggedOut = page.waitForResponse(response => response.url().endsWith('/api/auth/logout') && response.request().method() === 'POST');
    const deniedState = page.waitForResponse(response => response.url().endsWith('/api/state') && response.request().method() === 'GET' && response.status() === 401);
    await page.getByRole('button', { name: 'Sign out', exact: true }).click();
    expect((await loggedOut).status()).toBe(200);
    await expect(page.getByText('Sign in with MetaMask to open your private workspace.', { exact: false })).toBeVisible();
    held.release();
    expect((await deniedState).status()).toBe(401);
    await expect(page.getByRole('button', { name: 'Connect MetaMask', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
    await expect(page.getByLabel('Signed-in account', { exact: true })).not.toContainText(original.profile.displayName);
  } finally {
    held.release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

for (const timezoneId of ['UTC', 'Asia/Kolkata']) {
  test(`keeps the intent default seven days away in the actual ${timezoneId} browser time zone`, async ({ browser, baseURL }) => {
    const context = await browser.newContext({ timezoneId, locale: 'en-US' });
    try {
      await createAccount(context, baseURL!);
      const page = await context.newPage();
      await page.goto(`${baseURL}/intents`);
      const expiry = page.getByLabel('Discoverable until', { exact: true });
      await expect(expiry).toBeVisible();
      const observed = await expiry.evaluate(element => {
        const date = new Date((element as HTMLInputElement).value);
        return {
          remainingMs: date.getTime() - Date.now(),
          preview: new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(date),
          actualZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        };
      });
      const sevenDays = 7 * 86400000;
      expect(observed.remainingMs).toBeGreaterThan(sevenDays - 65_000);
      expect(observed.remainingMs).toBeLessThanOrEqual(sevenDays + 1000);
      expect(observed.actualZone).toMatch(timezoneId === 'UTC' ? /^UTC$/ : /^Asia\/(Kolkata|Calcutta)$/);
      await expect(page.locator('.public-intent').getByText(observed.preview, { exact: true })).toBeVisible();
      expect((await state(context, baseURL!)).intents).toEqual([]);
    } finally {
      await context.close();
    }
  });
}

test('supports mobile navigation dismissal and keyboard focus return with reduced motion enabled', async ({ page, context, baseURL }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  await expect(page.getByRole('figure', { name: 'How a permissioned introduction works' }).locator('[data-artwork-ready]'))
    .toHaveAttribute('data-artwork-ready', 'true');
  await capture(page, 'landing-reduced-motion-390');
  await noOverflow(page);
  await createAccount(context, baseURL!);
  await page.goto('/dashboard');
  const toggle = page.getByRole('button', { name: 'Open navigation', exact: true });
  await toggle.click();
  await page.keyboard.press('Escape');
  await expect(toggle).toBeFocused();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await toggle.click();
  await page.getByRole('link', { name: 'Your profile', exact: true }).click();
  await expect(page.getByLabel('Your name', { exact: true })).toBeVisible();
  await noOverflow(page);
});

test('collapses desktop navigation while retaining accessible destinations and keyboard operation', async ({ page, context, baseURL }) => {
  await createAccount(context, baseURL!);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/dashboard');
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toBeVisible();
  const navigation = page.getByRole('complementary', { name: 'Workspace navigation', exact: true });
  const expandedWidth = await navigation.evaluate(element => element.getBoundingClientRect().width);
  const collapse = page.getByRole('button', { name: 'Collapse navigation', exact: true });
  await collapse.focus();
  await page.keyboard.press('Enter');
  const expand = page.getByRole('button', { name: 'Expand navigation', exact: true });
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(() => navigation.evaluate(element => element.getBoundingClientRect().width)).toBeLessThan(expandedWidth);
  const destination = navigation.getByRole('link', { name: 'Your profile', exact: true });
  await expect(destination).toHaveAccessibleName('Your profile');
  await destination.focus();
  await page.keyboard.press('Enter');
  await expect(page.getByLabel('Your name', { exact: true })).toBeVisible();
  await expect(expand).toBeVisible();
  await expand.focus();
  await page.keyboard.press('Space');
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  await noOverflow(page);
});

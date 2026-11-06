import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';

const password = 'a browser verification password 2026';

async function register(page: Page) {
  const email = `browser-${randomUUID()}@example.test`;
  await page.goto('/dashboard');
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Create your account', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Create your account', exact: true })).not.toBeVisible();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('A little intention. A new beginning.');
  return email;
}

test('creates a private profile, persists it on reload, signs out and signs in again', async ({ page }) => {
  const email = await register(page);
  await page.goto('/profile');
  await page.getByLabel('Your name', { exact: true }).fill('Browser owner');
  await page.getByLabel('A one-line introduction', { exact: true }).fill('A private browser test headline');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('What you can offer', { exact: true }).fill('TypeScript collaboration');
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.getByLabel('Private contact', { exact: true }).fill('browser-private-contact-8855');
  await page.getByLabel('Private employer', { exact: true }).fill('browser-private-employer-7766');
  await page.getByRole('button', { name: 'Save private profile', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Your private profile has been saved.' })).toHaveText('Your private profile has been saved.');
  await page.reload();
  await expect(page.getByLabel('Your name', { exact: true })).toHaveValue('Browser owner');
  await page.getByRole('button', { name: '3. Your privacy', exact: true }).click();
  await expect(page.getByLabel('Private contact', { exact: true })).toHaveValue('browser-private-contact-8855');
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByLabel('Email address', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Already have an account? Sign in', exact: true }).click();
  await page.getByLabel('Email address', { exact: true }).fill(email);
  await page.getByLabel('Password', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByLabel('Your name', { exact: true })).toHaveValue('Browser owner');
});

test('isolates two independent browser account states and denies unrelated private endpoints', async ({ browser, baseURL }) => {
  const a = await browser.newContext(), b = await browser.newContext();
  try {
    const pageA = await a.newPage(), pageB = await b.newPage();
    const emailA = await register(pageA);
    const ownResponse = await a.request.get(`${baseURL}/api/state`);
    const own = (await ownResponse.json()).data;
    const privateContact = `private-${randomUUID()}`;
    const save = await a.request.post(`${baseURL}/api/profile`, { headers: { origin: baseURL! }, data: { ...own.profile, contact: privateContact } });
    expect(save.status()).toBe(200);
    await register(pageB);
    const other = await b.request.get(`${baseURL}/api/state`);
    const otherText = await other.text();
    expect(otherText).not.toContain(privateContact);
    expect(otherText).not.toContain(emailA);
    expect((await b.request.get(`${baseURL}/api/rooms/${randomUUID()}`)).status()).toBe(404);
    const forged = await b.request.post(`${baseURL}/api/world/verify`, { headers: { origin: baseURL! }, data: { verified: true, success: true } });
    expect(forged.status()).toBeGreaterThanOrEqual(400);
    await pageB.goto('/profile');
    await expect(pageB.getByLabel('Your name', { exact: true })).not.toHaveValue(own.profile.displayName);
  } finally {
    await a.close();
    await b.close();
  }
});

test('keeps landing and authenticated mobile navigation within the viewport', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  await register(page);
  await page.getByRole('button', { name: 'Open navigation', exact: true }).click();
  await page.getByRole('link', { name: 'Your profile', exact: true }).click();
  await expect(page.getByLabel('Your name', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

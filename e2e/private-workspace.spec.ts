import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { dismissTour, installTestMetaMask, signInWithTestWallet } from './wallet-fixture';

async function current(context: Parameters<typeof installTestMetaMask>[0], baseURL: string) {
  const response = await context.request.get(`${baseURL}/api/state`);
  expect(response.status()).toBe(200);
  return (await response.json()).data;
}

test('signs in through the MetaMask UI with a genuine generated EOA signature and denies replay after logout', async ({ page, context, baseURL }) => {
  const wallet = await installTestMetaMask(context);
  const submitted = page.waitForRequest(request => request.url().endsWith('/api/auth/wallet/verify'));
  await signInWithTestWallet(page);
  const verification = (await submitted).postDataJSON();
  await dismissTour(page);
  const first = await current(context, baseURL!);
  expect(first.user.wallet).toBe(wallet.address.toLowerCase());
  expect(first.profile.displayName).toBe('');
  expect(first.profile.publicFields).toEqual([]);
  expect(first.profile.aiConsent).toBe(false);
  expect(first.agent).toBeNull();
  expect(first.intents).toEqual([]);
  expect(first.rooms).toEqual([]);
  expect(first.integrations.world.status).toBe('deferred');
  expect(wallet.calls).toEqual(['eth_requestAccounts', 'eth_chainId', 'eth_accounts', 'eth_chainId', 'personal_sign']);
  const session = (await context.cookies()).find(cookie => cookie.name === 'meeti_session');
  expect(session).toMatchObject({ httpOnly: true, sameSite: 'Strict', path: '/' });
  expect(session!.value).toMatch(/^[a-f0-9]{64}$/);
  expect((await context.cookies()).find(cookie => cookie.name === 'meeti_wallet_flow')).toBeUndefined();
  await page.getByRole('button', { name: 'Sign out', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Connect MetaMask', exact: true })).toBeVisible();
  const replay = await context.request.post(`${baseURL}/api/auth/wallet/verify`, { headers: { origin: baseURL! }, data: verification });
  expect(replay.status()).toBe(403);
  expect((await replay.json()).error.code).toBe('CHALLENGE_EXPIRED');
  expect((await context.request.get(`${baseURL}/api/state`)).status()).toBe(401);
  await signInWithTestWallet(page);
  expect((await current(context, baseURL!)).user.id).toBe(first.user.id);
  await expect(page.getByRole('dialog', { name: 'A quick look around', exact: true })).toHaveCount(0);
});

test('rejects a signature from the wrong owner without creating a browser session', async ({ page, context, baseURL }) => {
  await installTestMetaMask(context, { wrongSigner: true });
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Connect MetaMask', exact: true }).click();
  const denied = page.waitForResponse(response => response.url().endsWith('/api/auth/wallet/verify'));
  await page.getByRole('button', { name: 'Sign in with MetaMask', exact: true }).click();
  expect((await denied).status()).toBe(403);
  await expect(page.getByRole('main').getByRole('alert')).toContainText('Wallet ownership could not be verified.');
  expect((await context.request.get(`${baseURL}/api/state`)).status()).toBe(401);
  expect((await context.cookies()).find(cookie => cookie.name === 'meeti_session')).toBeUndefined();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
});

test('rejects an injected non-MetaMask wallet before issuing a sign-in challenge', async ({ page, context }) => {
  const wallet = await installTestMetaMask(context, { eligible: false });
  const challenges: string[] = [];
  page.on('request', request => { if (request.url().endsWith('/api/auth/wallet/challenge')) challenges.push(request.url()); });
  await page.goto('/dashboard');
  await page.getByRole('button', { name: 'Connect MetaMask', exact: true }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('MetaMask was not found.');
  expect(wallet.calls).toEqual([]);
  expect(challenges).toEqual([]);
});

test('persists tour skip for its owner, permits replay and saves a private profile before pending name setup', async ({ page, context, baseURL }) => {
  await installTestMetaMask(context);
  await signInWithTestWallet(page);
  await dismissTour(page);
  await page.reload();
  await expect(page.getByRole('button', { name: 'Continue guided setup', exact: true })).toBeVisible();
  await expect(page.getByRole('dialog', { name: 'A quick look around', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Take a quick tour', exact: true }).click();
  const tour = page.getByRole('dialog', { name: 'A quick look around', exact: true });
  await expect(tour.locator('.tour-mascot svg')).toBeVisible();
  for (let step = 0; step < 3; step += 1) await tour.getByRole('button', { name: 'Next', exact: true }).click();
  await tour.getByRole('button', { name: 'Start guided setup', exact: true }).click();
  const setup = page.getByRole('dialog', { name: 'Your connection setup', exact: true });
  await expect(setup).toBeVisible();
  await setup.getByLabel('What should we call you?', { exact: true }).fill('Signed browser owner');
  await setup.getByLabel('What do you do?', { exact: true }).fill('Private profile headline');
  await setup.getByRole('button', { name: 'Continue', exact: true }).click();
  await setup.getByLabel('What you are looking for', { exact: true }).fill('A thoughtful collaborator');
  await setup.getByRole('button', { name: 'Continue', exact: true }).click();
  await setup.getByLabel('What you can offer', { exact: true }).fill('TypeScript and patient design review');
  await setup.getByLabel('Topics you care about', { exact: true }).fill('TypeScript, design');
  await setup.getByRole('button', { name: 'Continue', exact: true }).click();
  for (const checkbox of await setup.getByRole('checkbox').all()) await expect(checkbox).not.toBeChecked();
  await setup.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(setup.getByRole('checkbox')).not.toBeChecked();
  let release!: () => void;
  let applied!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const saved = new Promise<void>(resolve => { applied = resolve; });
  const mutations: string[] = [];
  page.on('request', request => { if (request.method() === 'POST' && request.url().includes('/api/')) mutations.push(new URL(request.url()).pathname); });
  await page.route('**/api/profile', async route => {
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    applied();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await setup.getByRole('button', { name: 'Save private profile', exact: true }).click();
    await saved;
    await expect(setup.getByRole('checkbox')).toBeDisabled();
    await expect(setup.getByRole('button', { name: 'Close dialog', exact: true })).toBeDisabled();
    await expect(setup.getByRole('button', { name: 'Saving your profile...', exact: true })).toBeDisabled();
    release();
    await expect(setup.getByRole('button', { name: 'Request this name', exact: true })).toBeVisible();
    await expect(setup.getByRole('button', { name: 'Continue to agent setup', exact: true })).toBeDisabled();
    await expect(setup.getByRole('button', { name: 'Use this name', exact: true })).toHaveCount(0);
    await setup.getByRole('button', { name: 'Close dialog', exact: true }).click();
    const stored = await current(context, baseURL!);
    expect(stored.profile).toMatchObject({ displayName: 'Signed browser owner', seeking: 'A thoughtful collaborator', offering: 'TypeScript and patient design review', publicFields: [], aiConsent: false, contact: '', employer: '' });
    expect(stored.agent).toBeNull();
    expect(stored.intents).toEqual([]);
    const progress = await context.request.get(`${baseURL}/api/onboarding`);
    expect((await progress.json()).data).toMatchObject({ profileComplete: true, tourCompleted: true, hasAgent: false, hasIntent: false });
    expect(mutations).toEqual(['/api/profile']);
    await page.reload();
    await expect(page.getByRole('link', { name: 'Choose your Meeti name', exact: true })).toBeVisible();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  } finally {
    release();
    await page.unrouteAll({ behavior: 'wait' });
  }
});

test('isolates signed wallet profiles and tour preferences across two independent owners', async ({ browser, baseURL }) => {
  const a = await browser.newContext({ baseURL }), b = await browser.newContext({ baseURL });
  try {
    await installTestMetaMask(a);
    await installTestMetaMask(b);
    const pageA = await a.newPage(), pageB = await b.newPage();
    await signInWithTestWallet(pageA);
    await dismissTour(pageA);
    const own = await current(a, baseURL!);
    const contact = `private-contact-${randomUUID()}`;
    const saved = await a.request.post(`${baseURL}/api/profile`, { headers: { origin: baseURL! }, data: { ...own.profile, displayName: 'Only the first owner', contact } });
    expect(saved.status()).toBe(200);
    await signInWithTestWallet(pageB);
    await expect(pageB.getByRole('dialog', { name: 'A quick look around', exact: true })).toBeVisible();
    const other = await current(b, baseURL!);
    expect(other.user.id).not.toBe(own.user.id);
    expect(JSON.stringify(other)).not.toContain(contact);
    expect(other.profile.displayName).toBe('');
    expect((await b.request.get(`${baseURL}/api/onboarding`).then(response => response.json())).data.tourCompleted).toBe(false);
    expect((await b.request.get(`${baseURL}/api/rooms/${randomUUID()}`)).status()).toBe(404);
    const forged = await b.request.post(`${baseURL}/api/onboarding`, { headers: { origin: baseURL! }, data: { tourCompleted: true, userId: own.user.id } });
    expect(forged.status()).toBe(400);
    expect((await a.request.get(`${baseURL}/api/onboarding`).then(response => response.json())).data.tourCompleted).toBe(true);
    expect((await current(a, baseURL!)).profile.contact).toBe(contact);
  } finally {
    await a.close();
    await b.close();
  }
});

test('preserves a guided setup draft and requires review when the actual saved profile changes', async ({ page, context, baseURL }) => {
  await installTestMetaMask(context);
  await signInWithTestWallet(page);
  await dismissTour(page);
  await page.getByRole('button', { name: 'Continue guided setup', exact: true }).click();
  const setup = page.getByRole('dialog', { name: 'Your connection setup', exact: true });
  await setup.getByLabel('What should we call you?', { exact: true }).fill('Local guided draft');
  const original = await current(context, baseURL!);
  const response = await context.request.post(`${baseURL}/api/profile`, {
    headers: { origin: baseURL! }, data: { ...original.profile, displayName: 'Saved outside this guided draft', seeking: 'A collaborator', offering: 'Design review' },
  });
  expect(response.status()).toBe(200);
  const refreshed = page.waitForResponse(response => response.url().endsWith('/api/state') && response.request().method() === 'GET');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  expect((await refreshed).status()).toBe(200);
  await expect(setup.locator('.draft-warning')).toContainText('A saved profile changed while this setup was open.');
  await expect(setup.getByLabel('What should we call you?', { exact: true })).toHaveValue('Local guided draft');
  await setup.getByRole('button', { name: 'Continue', exact: true }).click();
  await setup.getByLabel('What you are looking for', { exact: true }).fill('Local draft seeks a collaborator');
  await setup.getByRole('button', { name: 'Continue', exact: true }).click();
  await setup.getByLabel('What you can offer', { exact: true }).fill('Local draft offers engineering');
  await setup.getByRole('button', { name: 'Continue', exact: true }).click();
  await setup.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(setup.getByRole('button', { name: 'Save private profile', exact: true })).toBeDisabled();
  expect((await current(context, baseURL!)).profile.displayName).toBe('Saved outside this guided draft');
  await setup.getByRole('button', { name: 'Load current saved profile', exact: true }).click();
  await expect(setup.locator('.draft-warning')).toHaveCount(0);
  await expect(setup.getByRole('button', { name: 'Save private profile', exact: true })).toBeEnabled();
  for (let step = 0; step < 4; step += 1) await setup.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(setup.getByLabel('What should we call you?', { exact: true })).toHaveValue('Saved outside this guided draft');
});

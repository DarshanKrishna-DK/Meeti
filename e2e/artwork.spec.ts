import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const screenshotDirectory = resolve('artifacts/redesign');

test('explains permission stages with keyboard controls without invoking application actions', async ({ page }) => {
  const mutations: string[] = [];
  const errors: string[] = [];
  page.on('request', request => {
    if (request.url().includes('/api/') && request.method() !== 'GET') mutations.push(request.url());
  });
  page.on('pageerror', error => errors.push(error.message));
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const figure = page.getByRole('figure', { name: 'How a permissioned introduction works' });
  await expect(figure).toBeVisible();
  await expect(figure.locator('[data-artwork-ready]')).toHaveAttribute('data-artwork-ready', 'true');
  const controls = figure.getByRole('tablist', { name: 'Explore four introduction steps' });
  await expect(controls.getByRole('tab')).toHaveCount(4);
  await controls.getByRole('tab', { name: /Share an intent/ }).focus();
  const observed: string[] = [];
  const positions: string[] = [];
  for (let index = 0; index < 4; index += 1) {
    await controls.getByRole('tab').nth(index).click();
    await expect(figure).toHaveAttribute('data-explanation-stage', String(index));
    await expect(controls.getByRole('tab').nth(index)).toHaveAttribute('aria-selected', 'true');
    await expect(figure.getByRole('tabpanel')).toBeVisible();
    // Reduced motion should settle directly to four distinct mechanical positions.
    await expect.poll(async () => figure.locator('[data-part-group="carriage"]').first().getAttribute('transform')).not.toBeNull();
    if (index > 0) await expect.poll(async () => figure.locator('[data-part-group="carriage"]').first().getAttribute('transform')).not.toBe(positions[index - 1]);
    positions.push((await figure.locator('[data-part-group="carriage"]').first().getAttribute('transform'))!);
    if (index === 2) {
      await expect(figure.locator('[data-part-group="decision-67"]').first()).toHaveAttribute('transform', 'translate(0 4.2)');
      await expect(figure.locator('[data-part-group="decision-88"]').first()).toHaveAttribute('transform', 'translate(0 4.2)');
    }
    observed.push(await figure.getByRole('tabpanel').innerText());
  }
  expect(new Set(observed).size).toBe(4);
  expect(new Set(positions).size).toBe(4);
  await controls.getByRole('tab', { name: /Share an intent/ }).focus();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowRight');
  await expect(controls.getByRole('tab', { name: /Set boundaries/ })).toBeFocused();
  await expect(controls.getByRole('tab', { name: /Set boundaries/ })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End');
  await expect(figure).toHaveAttribute('data-explanation-stage', '3');
  await expect(figure.getByText('The final door stays locked.', { exact: true })).toBeVisible();
  await expect(figure.getByText('Locked: World verification paused', { exact: true })).toBeVisible();
  await expect(figure.locator('[data-part-group="shutter"]').first()).toHaveAttribute('transform', 'translate(0 0)');
  await page.keyboard.press('Home');
  await expect(figure).toHaveAttribute('data-explanation-stage', '0');
  expect(mutations).toEqual([]);
  expect(errors).toEqual([]);
});

test('retains the complete SVG explanation when WebGL is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    const original = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...args: unknown[]) {
      if (type.startsWith('webgl') || type === 'experimental-webgl') return null;
      return Reflect.apply(original, this, [type, ...args]);
    } as HTMLCanvasElement['getContext'];
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  const figure = page.getByRole('figure', { name: 'How a permissioned introduction works' });
  await expect(figure.locator('[data-artwork-ready]')).toHaveAttribute('data-webgl', 'fallback');
  await expect(figure.getByRole('img')).toBeVisible();
  await figure.getByRole('tab', { name: /Both decide/ }).click();
  await expect(figure.getByText('Two people. Two separate decisions.', { exact: true })).toBeVisible();
  expect(await figure.locator('svg path').count()).toBeGreaterThan(40);
  const widths = await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth }));
  expect(widths.document).toBeLessThanOrEqual(widths.viewport + 1);
  mkdirSync(screenshotDirectory, { recursive: true });
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.screenshot({ path: resolve(screenshotDirectory, 'landing-webgl-fallback-390.png'), fullPage: true, animations: 'disabled' });
});

test('uses a genuine available WebGL context and preserves the SVG explanation after context loss', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  const renderer = await page.evaluate(() => {
    const canvas = document.createElement('canvas');
    const context = canvas.getContext('webgl');
    if (!context) return null;
    const debug = context.getExtension('WEBGL_debug_renderer_info');
    const name = String(context.getParameter(debug ? debug.UNMASKED_RENDERER_WEBGL : context.RENDERER));
    const loss = context.getExtension('WEBGL_lose_context');
    loss?.loseContext();
    return { name, softwareRenderer: /swiftshader|llvmpipe|lavapipe|software/i.test(name), contextLossExtension: Boolean(loss) };
  });
  test.skip(!renderer, 'This browser cannot create a genuine WebGL context. The independent SVG fallback test still applies.');
  await testInfo.attach('observed-webgl-renderer', { body: JSON.stringify(renderer, null, 2), contentType: 'application/json' });
  const figure = page.getByRole('figure', { name: 'How a permissioned introduction works' });
  const stage = figure.locator('[data-artwork-ready]');
  await expect(stage).toHaveAttribute('data-artwork-ready', 'true');
  await expect(stage).toHaveAttribute('data-webgl', 'active');
  await figure.getByRole('tab', { name: /Set boundaries/ }).click();
  await expect(figure).toHaveAttribute('data-explanation-stage', '1');
  mkdirSync(screenshotDirectory, { recursive: true });
  await figure.screenshot({ path: resolve(screenshotDirectory, 'instrument-live-webgl-desktop.png'), animations: 'disabled' });
  const lost = await figure.locator('canvas').evaluate(element => {
    const canvas = element as HTMLCanvasElement;
    const context = canvas.getContext('webgl');
    const extension = context?.getExtension('WEBGL_lose_context');
    if (!extension) return false;
    extension.loseContext();
    return true;
  });
  if (!lost) {
    testInfo.annotations.push({ type: 'coverage', description: 'WebGL rendered, but WEBGL_lose_context is unavailable. Actual context-loss coverage was not exercised.' });
    return;
  }
  await expect(stage).toHaveAttribute('data-webgl', 'fallback');
  await expect(figure.getByRole('img')).toBeVisible();
  await figure.getByRole('tab', { name: /Protected intro/ }).click();
  await expect(figure.getByText('The final door stays locked.', { exact: true })).toBeVisible();
  await figure.screenshot({ path: resolve(screenshotDirectory, 'instrument-context-loss-fallback-desktop.png'), animations: 'disabled' });
});

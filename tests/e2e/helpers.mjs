// Shared helpers of the browser tests.
import { expect } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCREENS = process.env.COMPOSER_SCREENS;

/**
 * Collects console errors, page errors and external requests of a page into a list.
 * @param {import('@playwright/test').Page} page
 * @param {string[]} problems
 */
export function watch(page, problems) {
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('request', (r) => {
    if (!r.url().startsWith('http://127.0.0.1') && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) {
      problems.push(`external request: ${r.url()}`);
    }
  });
}

/** @param {import('@playwright/test').Page} page */
export async function open(page) {
  await page.goto('/composer/');
  await page.waitForSelector('.cmp.is-ready');
}

/**
 * Screenshot for the review (Chromium only, when COMPOSER_SCREENS is set).
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').TestInfo} info
 * @param {string} name
 */
export async function shot(page, info, name) {
  if (!SCREENS || info.project.name !== 'chromium') return;
  mkdirSync(SCREENS, { recursive: true });
  await page.screenshot({ path: join(SCREENS, `${name}.png`) });
}

/**
 * Position inside the canvas, as fractions of its size.
 * @param {import('@playwright/test').Page} page
 * @param {number} fx
 * @param {number} fy
 */
export async function canvasPoint(page, fx, fy) {
  const box = await page.locator('.cmp-canvas').boundingBox();
  if (!box) throw new Error('no canvas');
  return { x: box.x + box.width * fx, y: box.y + box.height * fy };
}

/**
 * Drags a palette entry onto the canvas.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {{x: number, y: number}} to
 */
export async function dragBlock(page, name, to) {
  const item = paletteItem(page, name);
  await item.scrollIntoViewIfNeeded();
  const box = await item.boundingBox();
  if (!box) throw new Error(`no palette entry ${name}`);
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 30, box.y + box.height / 2 + 10, { steps: 5 });
  await page.mouse.move(to.x, to.y, { steps: 15 });
  await page.mouse.up();
}

/**
 * Palette entry by its exact name.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
export function paletteItem(page, name) {
  return page.locator('.cmp-pal-item').filter({ has: page.locator('.cmp-pal-name', { hasText: new RegExp(`^${name}$`) }) }).first();
}

/**
 * Adds a block with the keyboard (Enter on its palette entry).
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
export async function addBlock(page, name) {
  await paletteItem(page, name).focus();
  await page.keyboard.press('Enter');
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} ref
 */
export async function portCenter(page, ref) {
  const box = await page.locator(`[data-port="${ref}"] .cmp-port-glyph`).boundingBox();
  if (!box) throw new Error(`no port ${ref}`);
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

/**
 * Drags a connection from one port to another.
 * @param {import('@playwright/test').Page} page
 * @param {string} from
 * @param {string} to
 * @param {boolean} [release]
 */
export async function dragWire(page, from, to, release = true) {
  const a = await portCenter(page, from);
  const b = await portCenter(page, to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 24, a.y + 12, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 18 });
  if (release) await page.mouse.up();
}

/**
 * Drags an element by a vector (pointer events).
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} loc
 * @param {{x: number, y: number}} to client position
 */
export async function dragTo(page, loc, to) {
  const box = await loc.boundingBox();
  if (!box) throw new Error('nothing to drag');
  await page.mouse.move(box.x + 12, box.y + Math.min(12, box.height / 2));
  await page.mouse.down();
  await page.mouse.move(box.x + 30, box.y + 20, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 20 });
  await page.mouse.up();
}

/** @param {import('@playwright/test').Page} page */
export function design(page) {
  return page.evaluate(() => JSON.parse(JSON.stringify(/** @type {any} */ (window).composer.design)));
}

/** @param {import('@playwright/test').Page} page */
export async function saveText(page) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Save', exact: true }).click(),
  ]);
  const path = await download.path();
  return { name: download.suggestedFilename(), text: readFileSync(path, 'utf-8') };
}

export { expect };

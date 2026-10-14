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
 * Waits until nothing moves on the canvas: the springs rest and every finite animation has ended (the flow of a
 * selected connection runs forever and does not count).
 * @param {import('@playwright/test').Page} page
 */
export async function settled(page) {
  await page.waitForFunction(() => {
    const c = document.querySelector('.cmp-canvas');
    if (!c || c.getAttribute('data-motion') !== 'rest') return false;
    return document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getComputedTiming().endTime === Infinity);
  });
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
  const box = await page.locator('.cmp-canvas-wrap').boundingBox();
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
  await settled(page);
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
  await settled(page);
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
  await settled(page);
  const a = await portCenter(page, from);
  const b = await portCenter(page, to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 24, a.y + 12, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 18 });
  if (release) {
    await page.mouse.up();
    await settled(page);
  }
}

/**
 * Drags an element by a vector (pointer events).
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} loc
 * @param {{x: number, y: number}} to client position
 */
export async function dragTo(page, loc, to) {
  await settled(page);
  const box = await loc.boundingBox();
  if (!box) throw new Error('nothing to drag');
  // a drop outside the visible canvas (on a panel) does nothing: such a test would only pass by chance
  const c = await page.locator('.cmp-canvas-wrap').boundingBox();
  if (!c || to.x < c.x || to.x > c.x + c.width || to.y < c.y || to.y > c.y + c.height) {
    throw new Error(`drop point ${Math.round(to.x)}, ${Math.round(to.y)} lies outside the visible canvas`);
  }
  await page.mouse.move(box.x + 12, box.y + Math.min(12, box.height / 2));
  await page.mouse.down();
  await page.mouse.move(box.x + 30, box.y + 20, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 20 });
  await page.mouse.up();
  await settled(page);
}

/**
 * The part of an element that the canvas shows (its box clipped to the visible canvas), or an error when none.
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').Locator} loc
 */
export async function visiblePart(page, loc) {
  const b = await loc.boundingBox();
  const c = await page.locator('.cmp-canvas-wrap').boundingBox();
  if (!b || !c) throw new Error('no element or no canvas');
  const x0 = Math.max(b.x, c.x);
  const y0 = Math.max(b.y, c.y);
  const x1 = Math.min(b.x + b.width, c.x + c.width);
  const y1 = Math.min(b.y + b.height, c.y + c.height);
  if (x1 <= x0 || y1 <= y0) throw new Error('the element lies outside the visible canvas');
  return { x: x0, y: y0, width: x1 - x0, height: y1 - y0 };
}

/**
 * Drags a block by its head so that its centre lands in the middle of the visible part of a target (a clock domain
 * box); the pointer stays on the canvas.
 * @param {import('@playwright/test').Page} page
 * @param {string} id
 * @param {import('@playwright/test').Locator} target
 */
export async function dropBlockInto(page, id, target) {
  await settled(page);
  const t = await visiblePart(page, target);
  const block = await page.locator(`[data-block="${id}"]`).boundingBox();
  const c = await page.locator('.cmp-canvas-wrap').boundingBox();
  if (!block || !c) throw new Error(`no block ${id}`);
  // dragTo grabs the head 12 px from its top-left corner; the block centre follows the pointer at a fixed offset
  const off = { x: block.width / 2 - 12, y: block.height / 2 - 12 };
  const clamp = (/** @type {number} */ v, /** @type {number} */ lo, /** @type {number} */ hi) => Math.min(hi, Math.max(lo, v));
  const to = {
    x: clamp(t.x + t.width / 2 - off.x, c.x + 4, c.x + c.width - 4),
    y: clamp(t.y + t.height / 2 - off.y, c.y + 4, c.y + c.height - 4),
  };
  await dragTo(page, page.locator(`[data-block="${id}"] .cmp-block-head`), to);
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

/**
 * Opens an example from the menu by its title and waits until it rests.
 * @param {import('@playwright/test').Page} page
 * @param {string} title
 */
export async function openExample(page, title) {
  await page.getByRole('button', { name: 'Examples' }).click();
  await page.locator('.cmp-menu-item').filter({ has: page.locator('.cmp-menu-title', { hasText: new RegExp(`^${title}$`) }) }).click();
  await expect(page.locator('.cmp-block').first()).toBeVisible();
  await settled(page);
}

/**
 * Bounding boxes of the elements that match a selector.
 * @param {import('@playwright/test').Page} page
 * @param {string} selector
 */
export async function rects(page, selector) {
  return page.locator(selector).evaluateAll((els) => els.map((el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };
  }));
}

/**
 * Whether two rectangles overlap.
 * @param {{x: number, y: number, w: number, h: number}} a
 * @param {{x: number, y: number, w: number, h: number}} b
 */
export function overlap(a, b) {
  return a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
}

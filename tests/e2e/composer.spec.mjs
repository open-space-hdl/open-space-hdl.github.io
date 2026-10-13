// Browser tests of the Composer (milestone 1): build, connect, save, reload, keyboard, inspector, examples.
import { expect, test } from '@playwright/test';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SCREENS = process.env.COMPOSER_SCREENS;

/** @type {string[]} */
let problems = [];

test.beforeEach(async ({ page }) => {
  problems = [];
  page.on('console', (m) => {
    if (m.type() === 'error') problems.push(`console: ${m.text()}`);
  });
  page.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  page.on('request', (r) => {
    if (!r.url().startsWith('http://127.0.0.1') && !r.url().startsWith('blob:') && !r.url().startsWith('data:')) {
      problems.push(`external request: ${r.url()}`);
    }
  });
});

test.afterEach(() => {
  expect(problems, problems.join('\n')).toEqual([]);
});

/** @param {import('@playwright/test').Page} page */
async function open(page) {
  await page.goto('/composer/');
  await page.waitForSelector('.cmp.is-ready');
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {import('@playwright/test').TestInfo} info
 * @param {string} name
 */
async function shot(page, info, name) {
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
async function canvasPoint(page, fx, fy) {
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
async function dragBlock(page, name, to) {
  const item = page.locator('.cmp-pal-item').filter({ has: page.locator('.cmp-pal-name', { hasText: new RegExp(`^${name}$`) }) }).first();
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
 * @param {import('@playwright/test').Page} page
 * @param {string} ref
 */
async function portCenter(page, ref) {
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
async function dragWire(page, from, to, release = true) {
  const a = await portCenter(page, from);
  const b = await portCenter(page, to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 24, a.y + 12, { steps: 4 });
  await page.mouse.move(b.x, b.y, { steps: 18 });
  if (release) await page.mouse.up();
}

/** @param {import('@playwright/test').Page} page */
function design(page) {
  return page.evaluate(() => JSON.parse(JSON.stringify(/** @type {any} */ (window).composer.design)));
}

/** @param {import('@playwright/test').Page} page */
async function saveText(page) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Save', exact: true }).click(),
  ]);
  const path = await download.path();
  return { name: download.suggestedFilename(), text: readFileSync(path, 'utf-8') };
}

test('build OWR and OMAP by hand, connect both directions, save and reload unchanged', async ({ page, browser }, info) => {
  await open(page);
  await shot(page, info, '01-empty');

  await dragBlock(page, 'SpaceWire port', await canvasPoint(page, 0.62, 0.32));
  await dragBlock(page, 'RMAP target', await canvasPoint(page, 0.2, 0.32));
  let d = await design(page);
  expect(d.instances.map((i) => i.id)).toEqual(['spw0', 'rmap0']);
  expect(d.instances[1].preset).toBe('target');

  await dragWire(page, 'rmap0.M_Pkt', 'spw0.S_Pkt');
  await dragWire(page, 'spw0.M_Pkt', 'rmap0.S_Pkt');
  d = await design(page);
  expect(d.connections.map((c) => [c.from, c.to])).toEqual([
    ['rmap0.M_Pkt', 'spw0.S_Pkt'],
    ['spw0.M_Pkt', 'rmap0.S_Pkt'],
  ]);
  await expect(page.locator('.cmp-edge')).toHaveCount(2);
  await expect(page.locator('[data-port="spw0.S_Pkt"]')).toHaveClass(/is-connected/);
  await page.mouse.click(...Object.values(await canvasPoint(page, 0.5, 0.9)));
  await shot(page, info, '02-system');

  // inspector of the SpaceWire port
  await page.locator('[data-block="spw0"] .cmp-block-head').click();
  await expect(page.locator('#cmp-inst-id')).toHaveValue('spw0');
  await expect(page.locator('.cmp-inspector')).toContainText('owr_core');
  await shot(page, info, '03-inspector');

  // a rejected connection explains why while dragging and leaves the design unchanged
  await dragWire(page, 'spw0.M_Tc', 'rmap0.S_User', false);
  await expect(page.locator('.cmp-tip')).toBeVisible();
  await expect(page.locator('.cmp-tip')).toContainText('cannot be connected');
  await shot(page, info, '04-rejected');
  await page.mouse.up();
  await expect(page.locator('.cmp-toast')).toContainText('cannot be connected');
  expect((await design(page)).connections).toHaveLength(2);

  // save, then open the file in a fresh browser context (no autosave) and save again
  const first = await saveText(page);
  expect(first.name).toBe('system.composer.json');
  const doc = JSON.parse(first.text);
  expect(doc.format).toBe('open-space-composer-system');
  expect(doc.instances.map((i) => i.block)).toEqual(['openwire/owr_core', 'openrmap/omap_core']);
  const before = await design(page);

  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
  const page2 = await ctx.newPage();
  page2.on('pageerror', (e) => problems.push(`page error: ${e.message}`));
  await open(page2);
  await page2.locator('input[type="file"]').setInputFiles({ name: first.name, mimeType: 'application/json', buffer: Buffer.from(first.text) });
  await expect(page2.locator('.cmp-edge')).toHaveCount(2);
  const after = await design(page2);
  expect({ ...after, layout: { instances: after.layout.instances } }).toEqual({ ...before, layout: { instances: before.layout.instances } });
  await page2.evaluate(() => /** @type {any} */ (window).composer.storeViewport(/** @type {any} */ (window).composer.design.layout.viewport));
  const second = await saveText(page2);
  const strip = (/** @type {string} */ t) => { const o = JSON.parse(t); delete o.layout.viewport; return JSON.stringify(o); };
  expect(strip(second.text)).toBe(strip(first.text));
  await ctx.close();
});

test('the open systems survive a reload of the page', async ({ page }) => {
  await open(page);
  await page.locator('.cmp-pal-item').filter({ hasText: 'SpaceWire port' }).first().focus();
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'New system' }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.waitForTimeout(700);
  await page.reload();
  await page.waitForSelector('.cmp.is-ready');
  await expect(page.getByRole('tab')).toHaveCount(2);
  await page.getByRole('tab').first().click();
  expect((await design(page)).instances.map((i) => i.id)).toEqual(['spw0']);
});

test('keyboard: add, move, delete, undo and redo', async ({ page }) => {
  await open(page);
  await page.locator('.cmp-pal-item').filter({ hasText: 'SpaceWire port' }).first().focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-block="spw0"]')).toBeFocused();
  const x0 = (await design(page)).layout.instances.spw0.x;
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Shift+ArrowRight');
  expect((await design(page)).layout.instances.spw0.x).toBe(x0 + 16 + 64);
  await page.keyboard.press('Delete');
  expect((await design(page)).instances).toHaveLength(0);
  await page.keyboard.press('Control+z');
  expect((await design(page)).instances).toHaveLength(1);
  await page.keyboard.press('Control+y');
  expect((await design(page)).instances).toHaveLength(0);
});

test('inspector: generics are validated and connections can be made without a pointer', async ({ page }) => {
  await open(page);
  for (const name of ['SpaceWire port', 'RMAP node']) {
    await page.locator('.cmp-pal-item').filter({ has: page.locator('.cmp-pal-name', { hasText: new RegExp(`^${name}$`) }) }).first().focus();
    await page.keyboard.press('Enter');
  }
  await page.locator('[data-block="spw0"]').focus();
  const depth = page.locator('#cmp-g-spw0-TxFifoDepth_g');
  await depth.fill('100');
  await depth.press('Enter');
  await expect(depth).toHaveAttribute('aria-invalid', 'true');
  await expect(page.locator('#cmp-g-spw0-TxFifoDepth_g-err')).toContainText('power of 2');
  await depth.fill('128');
  await depth.press('Enter');
  expect((await design(page)).instances[0].generics).toEqual({ TxFifoDepth_g: 128 });
  await page.getByRole('button', { name: 'Reset to default' }).click();
  expect((await design(page)).instances[0].generics).toEqual({});

  await page.getByLabel('Connect spw0.M_Pkt to').selectOption('rmap0.S_Pkt');
  expect((await design(page)).connections).toEqual([{ id: 'c1', from: 'spw0.M_Pkt', to: 'rmap0.S_Pkt' }]);
  await page.locator('#cmp-inst-id').fill('link');
  await page.locator('#cmp-inst-id').press('Enter');
  expect((await design(page)).connections[0].from).toBe('link.M_Pkt');
});

test('an example opens in its own tab', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Examples' }).click();
  await page.getByRole('menuitem', { name: /Space Packets over SpaceWire/ }).click();
  await expect(page.locator('.cmp-edge')).toHaveCount(6);
  const d = await design(page);
  expect(d.name).toBe('spp_over_spw');
  expect(d.instances).toHaveLength(4);
  await expect(page.getByRole('tab', { name: /spp_over_spw/ })).toHaveAttribute('aria-selected', 'true');
});

test('a broken file is rejected with its problems', async ({ page }) => {
  await open(page);
  const bad = JSON.stringify({ format: 'open-space-composer-system', formatVersion: 1, system: { name: 'x' }, instances: [{ id: 'a', block: 'openwire/none' }], connections: [] });
  await page.locator('input[type="file"]').setInputFiles({ name: 'bad.composer.json', mimeType: 'application/json', buffer: Buffer.from(bad) });
  await expect(page.locator('dialog.cmp-dialog')).toBeVisible();
  await expect(page.locator('dialog.cmp-dialog')).toContainText('unknown block');
  await page.locator('dialog.cmp-dialog').getByRole('button', { name: 'Close', exact: true }).click();
  await expect(page.getByRole('tab')).toHaveCount(1);
});

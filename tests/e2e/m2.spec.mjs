// Browser tests of the Composer (milestone 2): clock domains with inserted crossings, bridges, side band constants,
// external interfaces and the checks panel.
import { test } from '@playwright/test';
import {
  addBlock, canvasPoint, design, dragTo, dragWire, expect, open, saveText, settled, shot, watch,
} from './helpers.mjs';

/** @type {string[]} */
let problems = [];

test.beforeEach(async ({ page }) => {
  problems = [];
  watch(page, problems);
});

test.afterEach(() => {
  expect(problems, problems.join('\n')).toEqual([]);
});

/**
 * Opens an example from the menu.
 * @param {import('@playwright/test').Page} page
 * @param {RegExp} name
 */
async function example(page, name) {
  await page.getByRole('button', { name: 'Examples' }).click();
  await page.getByRole('menuitem', { name }).click();
  await expect(page.locator('.cmp-block').first()).toBeVisible();
}

test('blocks in different clock domains get an asynchronous FIFO that disappears when the domains are merged', async ({ page }, info) => {
  await open(page);
  await example(page, /SpaceWire RMAP target/);
  await expect(page.locator('.cmp-auto')).toHaveCount(0);
  await expect(page.locator('.cmp-domain')).toHaveCount(1);

  // new clock domain: its placeholder box appears in the view
  await page.getByRole('button', { name: 'Clock domain', exact: true }).click();
  await expect(page.locator('#cmp-dom-name')).toHaveValue('Clock 1');
  await page.locator('#cmp-dom-freq').fill('150');
  await page.locator('#cmp-dom-freq').press('Enter');
  await page.locator('#cmp-dom-name').fill('Fast clock');
  await page.locator('#cmp-dom-name').press('Enter');
  const box = page.locator('[data-domain="clk1"] .cmp-domain-box');
  await expect(box).toBeVisible();

  // drag the RMAP node into the new box: two crossings (one per direction)
  const target = await box.boundingBox();
  if (!target) throw new Error('no domain box');
  await dragTo(page, page.locator('[data-block="rmap0"] .cmp-block-head'), { x: target.x + target.width / 2 - 60, y: target.y + 80 });
  await expect(page.locator('.cmp-auto')).toHaveCount(2);
  const d = await design(page);
  expect(d.instances.find((/** @type {any} */ i) => i.id === 'rmap0').clocks).toEqual({ Clk: 'clk1' });
  await expect(page.locator('.cmp-auto').first()).toContainText('Async FIFO');
  await page.getByRole('button', { name: 'Fit' }).click();
  await settled(page);
  await page.mouse.click(...Object.values(await canvasPoint(page, 0.97, 0.97)));
  await shot(page, info, '01-domains-auto-fifo');

  // the inserted FIFO explains itself and its depth can be set
  await page.locator('.cmp-auto').first().click();
  await expect(page.locator('.cmp-inspector')).toContainText('Inserted block');
  await expect(page.locator('.cmp-inspector')).toContainText('olo_ft_fifo_async');
  await page.locator('#cmp-auto-depth').fill('64');
  await page.locator('#cmp-auto-depth').press('Enter');
  await expect(page.locator('.cmp-auto').first()).toContainText('64 deep');

  // merge the domains: the crossings disappear
  await page.locator('[data-domain-head="clk1"]').click();
  await page.locator('#cmp-dom-merge').selectOption('sys');
  await page.getByRole('button', { name: 'Merge and remove this domain' }).click();
  await expect(page.locator('.cmp-auto')).toHaveCount(0);
  expect((await design(page)).clockDomains.map((/** @type {any} */ c) => c.id)).toEqual(['sys', 'link']);
});

test('SPP over SpaceWire: the N-Char adapter is inserted with one click and serves both directions', async ({ page }, info) => {
  await open(page);
  await addBlock(page, 'SpaceWire port');
  await addBlock(page, 'Space Packet node');
  await page.getByRole('button', { name: 'Fit' }).click();
  await settled(page);
  await dragWire(page, 'spp0.M_Link', 'spw0.S_Pkt', false);
  await expect(page.locator('.cmp-tip')).toContainText('connect through N-Char adapter');
  await page.mouse.up();
  const pop = page.getByRole('dialog', { name: /Connect through N-Char adapter/ });
  await expect(pop).toBeVisible();
  await shot(page, info, '04-bridge-suggestion');
  await pop.getByRole('button', { name: 'Insert N-Char adapter' }).click();
  let d = await design(page);
  expect(d.instances.map((/** @type {any} */ i) => i.id)).toEqual(['spw0', 'spp0', 'nchar0']);
  expect(d.connections.map((/** @type {any} */ c) => [c.from, c.to])).toEqual([['spp0.M_Link', 'nchar0.S_Link'], ['nchar0.M_NChar', 'spw0.S_Pkt']]);
  // the other direction reuses the adapter
  await page.getByRole('button', { name: 'Fit' }).click();
  await settled(page);
  await dragWire(page, 'spw0.M_Pkt', 'spp0.S_Link');
  await page.getByRole('dialog').getByRole('button', { name: 'Insert N-Char adapter' }).click();
  d = await design(page);
  expect(d.instances).toHaveLength(3);
  expect(d.connections.slice(2).map((/** @type {any} */ c) => [c.from, c.to])).toEqual([['spw0.M_Pkt', 'nchar0.S_NChar'], ['nchar0.M_Link', 'spp0.S_Link']]);
  // one undo step removes the adapter and both connections
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  d = await design(page);
  expect(d.instances).toHaveLength(2);
  expect(d.connections).toHaveLength(0);
});

test('the RMAP pass-through port connects directly to the N-Char adapter', async ({ page }) => {
  await open(page);
  await addBlock(page, 'RMAP node');
  await addBlock(page, 'N-Char adapter');
  await page.getByRole('button', { name: 'Fit' }).click();
  await settled(page);
  await dragWire(page, 'rmap0.M_User', 'nchar0.S_NChar');
  await dragWire(page, 'nchar0.M_NChar', 'rmap0.S_User');
  const d = await design(page);
  expect(d.connections.map((/** @type {any} */ c) => [c.from, c.to])).toEqual([['rmap0.M_User', 'nchar0.S_NChar'], ['nchar0.M_NChar', 'rmap0.S_User']]);
  await expect(page.locator('.cmp-auto')).toHaveCount(0);
});

test('a side band constant survives save and load', async ({ page, browser }, info) => {
  await open(page);
  await addBlock(page, 'Chunker');
  await addBlock(page, 'Space Packet node');
  await page.getByRole('button', { name: 'Fit' }).click();
  await settled(page);
  await dragWire(page, 'chunk0.Out', 'spp0.S_Tx[0]');
  // the connection is selected and asks for the constants
  await expect(page.locator('.cmp-inspector')).toContainText('Side band constants');
  const apid = page.getByLabel('APID');
  await apid.fill('0x42');
  await apid.press('Enter');
  await page.getByLabel('Secondary header flag').check();
  await shot(page, info, '03-sideband-constants');
  let d = await design(page);
  expect(d.connections[0].sideband).toEqual({ apid: 0x42, shi: true, type: false, nameValid: false, name: 0 });
  // the chunker follows the width of the send port
  await page.locator('[data-block="chunk0"] .cmp-block-head').click();
  await expect(page.locator('#cmp-g-chunk0-Width_g')).toHaveValue('32');
  await expect(page.locator('.cmp-inspector')).toContainText('Automatic: follows In or Out');

  const saved = await saveText(page);
  const ctx = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
  const page2 = await ctx.newPage();
  watch(page2, problems);
  await open(page2);
  await page2.locator('input[type="file"]').setInputFiles({ name: saved.name, mimeType: 'application/json', buffer: Buffer.from(saved.text) });
  await expect(page2.locator('.cmp-edge')).toHaveCount(1);
  d = await design(page2);
  expect(d.connections[0].sideband).toEqual({ apid: 0x42, shi: true, type: false, nameValid: false, name: 0 });
  await page2.locator('[data-block="chunk0"] .cmp-block-head').click();
  await page2.locator('[data-itf="chunk0.Out"]').getByRole('button', { name: 'spp0.S_Tx[0]', exact: true }).click();
  await expect(page2.getByLabel('APID')).toHaveValue('66');
  await ctx.close();
});

test('checks: a must-serve interface is reported and a click shows the block; external interfaces clear it', async ({ page }, info) => {
  await open(page);
  await addBlock(page, 'SpaceWire port');
  await page.getByRole('button', { name: 'Fit' }).click();
  await settled(page);
  const checks = page.locator('.cmp-checks');
  await expect(checks).toContainText('spw0.M_Pkt must be served');
  await page.mouse.click(...Object.values(await canvasPoint(page, 0.95, 0.95)));
  await shot(page, info, '02-checks-panel');
  await checks.getByRole('button', { name: /spw0\.M_Pkt must be served/ }).click();
  await expect(page.locator('#cmp-inst-id')).toHaveValue('spw0');
  await expect(page.locator('[data-block="spw0"]')).toHaveClass(/is-selected/);
  // make the received packets external: the error is gone and the top level gets the ports
  await page.locator('[data-itf="spw0.M_Pkt"]').getByRole('button', { name: 'Make external' }).click();
  await page.locator('#cmp-ext-spw0-M_Pkt').fill('Rx_');
  await page.locator('#cmp-ext-spw0-M_Pkt').press('Enter');
  await expect(checks).not.toContainText('spw0.M_Pkt must be served');
  const ports = await page.evaluate(() => /** @type {any} */ (window).composer.resolved.topPorts.map((/** @type {any} */ p) => p.name));
  expect(ports).toContain('Rx_M_Pkt_TData');
  expect((await design(page)).externals).toEqual([{ interface: 'spw0.M_Pkt', prefix: 'Rx_' }]);
});

// Browser tests of the Composer (OpenFibre): the SpaceFibre node example, the vendor-specific GTY adapter, the user
// bits between OpenSPP and a virtual channel, and the lanes that the adapter and OpenSPP follow.
import { test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { design, expect, open, openExample, paletteItem, saveText, settled, shot, watch } from './helpers.mjs';

const golden = (/** @type {string} */ name) => readFileSync(new URL(`../golden/${name}`, import.meta.url), 'utf-8');

/** @type {string[]} */
let problems = [];

test.beforeEach(async ({ page }) => {
  problems = [];
  watch(page, problems);
});

test.afterEach(() => {
  expect(problems, problems.join('\n')).toEqual([]);
});

test('the SpaceFibre node opens without errors and saves the netlist of its golden file', async ({ page }, info) => {
  await open(page);
  await openExample(page, 'SpaceFibre node');
  for (const id of ['rmap0', 'nchar0', 'ofb0', 'pa0', 'spp0']) await expect(page.locator(`[data-block="${id}"]`)).toHaveCount(1);
  await expect(page.locator('.cmp-check-item.cmp-sev-error')).toHaveCount(0);
  // no warning: the core waits for the transceivers through the TX ready of its Phy interface
  await expect(page.locator('.cmp-check-item.cmp-sev-warning')).toHaveCount(0);
  // the user bits between OpenSPP and the virtual channel are a note, not a problem
  await expect(page.locator('.cmp-check-item.cmp-sev-info')).toContainText(['ofb0.M_Vc[0] has 1 user bit', 'spp0.M_Link has 5 user bits, ofb0.S_Vc[1] 1: bit 0 is connected, bits 4 to 1 are not used.']);
  await shot(page, info, 'ofb-01-spacefibre-node');
  const doc = JSON.parse((await saveText(page)).text);
  const noCatalogText = (/** @type {string} */ t) => t.replace(/\(catalog `[0-9a-f]+`\)/, '(catalog `*`)').trimEnd();
  expect({ ...doc.resolved, catalog: '*' }).toEqual({ ...JSON.parse(golden('spacefibre_node.resolved.json')), catalog: '*' });
  expect(noCatalogText(doc.agent.brief)).toBe(noCatalogText(golden('spacefibre_node.brief.md')));
  expect(doc.agent.brief).toContain('In their architecture for synthesis the vendor-specific blocks need the simulation libraries of their vendor: `pa0` (ofb_pa_gty, AMD Versal GTY)');
  expect(doc.agent.brief).toContain('architecture `mdl` (file list `hdl/ofb_pa_gty/compile_order_sim.txt` of `openfibre`)');
  // the lane clock domain has the adapter as its source
  expect(doc.clockDomains.find((/** @type {any} */ c) => c.id === 'lane').source).toEqual({ kind: 'block', instance: 'pa0', port: 'LaneClk' });
});

test('the GTY adapter is marked as vendor-specific and follows the lanes of the core, OpenSPP the width', async ({ page }, info) => {
  await open(page);
  const entry = paletteItem(page, 'SpaceFibre GTY adapter');
  await entry.scrollIntoViewIfNeeded();
  await expect(entry).toContainText('Vendor-specific: AMD Versal GTY');
  await expect(entry).toHaveAttribute('aria-label', 'Add SpaceFibre GTY adapter (ofb_pa_gty, for AMD Versal GTY only)');
  await openExample(page, 'SpaceFibre node');
  // the adapter lies beyond the view at the readable zoom: the keyboard focus brings it in
  await expect(page.locator('[data-block="pa0"]')).not.toBeInViewport({ ratio: 1 });
  await page.locator('[data-block="pa0"]').focus();
  await settled(page);
  await expect(page.locator('[data-block="pa0"]')).toBeInViewport({ ratio: 1 });
  await expect(page.locator('.cmp-insp-meta')).toContainText('Vendor-specific: AMD Versal GTY');
  await expect(page.locator('#cmp-g-pa0-NumLanes_g')).toHaveValue('1');
  await shot(page, info, 'ofb-02-gty-adapter');
  // two lanes in the core: the adapter takes them, OpenSPP and the N-Char adapter take 64-bit beats
  await page.locator('[data-block="ofb0"]').focus();
  const lanes = page.locator('#cmp-g-ofb0-NumLanes_g');
  await lanes.fill('2');
  await lanes.press('Enter');
  await settled(page);
  const r = await page.evaluate(() => {
    const app = /** @type {any} */ (window).composer;
    return ['pa0.NumLanes_g', 'spp0.DataWidth_g', 'nchar0.DataWidth_g'].map((k) => {
      const [id, g] = k.split('.');
      return app.resolved.byId.get(id).generics[g];
    });
  });
  expect(r).toEqual([2, 64, 64]);
  await expect(page.locator('.cmp-check-item.cmp-sev-error')).toHaveCount(0);
  await page.locator('[data-block="spp0"]').focus();
  await expect(page.locator('#cmp-g-spp0-DataWidth_g')).toHaveValue('64');
  await shot(page, info, 'ofb-03-two-lanes');
  expect((await design(page)).instances.find((/** @type {any} */ i) => i.id === 'ofb0').generics).toEqual({ NumVc_g: 2, NumLanes_g: 2 });
});

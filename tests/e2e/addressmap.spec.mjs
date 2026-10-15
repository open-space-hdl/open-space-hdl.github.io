// Browser tests of the address map in the inspector: the spaces of the system with their banks, a click on a bank,
// the window of every port of a decoder and the registers of a bank.
import { readFileSync } from 'node:fs';
import { test } from '@playwright/test';
import { expect, open, shot, watch } from './helpers.mjs';

const fixture = readFileSync(new URL('../fixtures/spfi_encrypt.composer.json', import.meta.url));

/** @type {string[]} */
let problems = [];

test.beforeEach(async ({ page }) => {
  problems = [];
  watch(page, problems);
});

test.afterEach(() => {
  expect(problems, problems.join('\n')).toEqual([]);
});

test('the address map of the system: its banks by base, a click selects the block, the windows of the decoder', async ({ page }, info) => {
  await open(page);
  await page.locator('input[type="file"]').setInputFiles({ name: 'spfi_encrypt.composer.json', mimeType: 'application/json', buffer: fixture });
  await expect(page.locator('[data-block="dec0"]')).toHaveCount(1);
  // the system: one space, eight banks at steps of 64 KiB
  const map = page.locator('.cmp-inspector section', { has: page.locator('#cmp-h-amap') });
  await expect(map.locator('#cmp-h-amap')).toHaveText('Address map (1)');
  const space = map.locator('[data-space="rmap0.M_Axi"]');
  await expect(space.locator('.cmp-amap-space')).toHaveText('rmap0.M_Axi 32 address bits');
  await expect(space.locator('li')).toHaveText([
    '0x00000000 spp0 spp_core, 2 KiB',
    '0x00010000 ocr0 ocr_core, 256 B',
    '0x00020000 edac0 olo_ft_ecc_monitor_axi, 4 KiB',
    '0x00030000 ocr1 ocr_core, 256 B',
    '0x00040000 ocr2 ocr_core, 256 B',
    '0x00050000 ocr3 ocr_core, 256 B',
    '0x00060000 rmap0 omap_core, 1 KiB',
    '0x00070000 ofb0 ofb_core, 4 KiB',
  ]);
  await map.scrollIntoViewIfNeeded();
  await shot(page, info, 'amap-01-system');
  // a click on a bank selects its block; its register port says where its registers are
  await space.getByRole('button', { name: 'ocr0' }).click();
  await expect(page.locator('#cmp-inst-id')).toHaveValue('ocr0');
  await expect(page.locator('[data-itf="ocr0.S_AxiLite"] .cmp-itf-addr')).toHaveText('Registers at 0x00010000 to 0x000100FF in rmap0.M_Axi.');
  // every port of the decoder has its window
  await page.locator('[data-block="dec0"]').focus();
  await expect(page.locator('#cmp-inst-id')).toHaveValue('dec0');
  await expect(page.locator('[data-itf="dec0.M_AxiLite[1]"] .cmp-itf-addr')).toHaveText('Window 0x00010000 to 0x0001FFFF in rmap0.M_Axi.');
  await expect(page.locator('[data-itf="dec0.M_AxiLite[7]"] .cmp-itf-addr')).toHaveText('Window 0x00070000 to 0x0007FFFF in rmap0.M_Axi.');
  await page.locator('[data-itf="dec0.M_AxiLite[1]"]').scrollIntoViewIfNeeded();
  await shot(page, info, 'amap-02-decoder');
});

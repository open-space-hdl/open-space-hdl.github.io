// Browser test of the migration of a file of older pins: the dialog on open, the section of the system in the inspector,
// the checks of rule migration, and their end when the system is saved at the current pins.
import { readFileSync } from 'node:fs';
import { test } from '@playwright/test';
import { expect, open, shot, watch } from './helpers.mjs';

const ROOT = new URL('../../', import.meta.url);
const catalog = JSON.parse(readFileSync(new URL('assets/composer/catalog.json', ROOT), 'utf-8'));
const example = JSON.parse(readFileSync(new URL('assets/composer/examples/spp_over_spw.composer.json', ROOT), 'utf-8'));

/** @type {string[]} */
let problems = [];

test.beforeEach(async ({ page }) => {
  problems = [];
  watch(page, problems);
  // a catalog whose source openspp has one step since the pin OLD
  const spp = catalog.sources.find((/** @type {any} */ s) => s.id === 'openspp');
  spp.changes = [{
    previous: 'OLD', pin: spp.commit, evidence: 'PR #12 of OpenSPP: the send port count has a new name',
    changes: [
      { block: 'openspp/spp_core', kind: 'generic_renamed', from: 'NumSend_g', to: 'NumTx_g', text: 'The number of send ports has a new name.' },
      { block: 'openspp/spp_core', kind: 'registers', text: 'Register map v2: a new register EVENTS2.' },
    ],
  }];
  await page.route('**/assets/composer/catalog.json', (route) => route.fulfill({ json: catalog }));
});

test.afterEach(() => {
  expect(problems, problems.join('\n')).toEqual([]);
});

test('a file of an older pin: the changes in a dialog, in the inspector and among the checks until it is saved', async ({ page }, info) => {
  await open(page);
  const old = structuredClone(example);
  old.sources.find((/** @type {any} */ s) => s.id === 'openspp').commit = 'OLD';
  old.instances.find((/** @type {any} */ i) => i.id === 'spp0').generics = { NumSend_g: 2 };
  await page.locator('input[type="file"]').setInputFiles({ name: 'spp_over_spw.composer.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(old)) });
  // the dialog: the changes by instance, with what the Composer did and the evidence
  const dialog = page.locator('dialog.cmp-dialog');
  await expect(dialog).toContainText('Changes since spp_over_spw was saved');
  const section = dialog.locator('section[data-instance="spp0"]');
  await expect(section.locator('h3')).toHaveText('spp0 (spp_core)');
  await expect(section.locator('li').first()).toHaveText('The number of send ports has a new name. NumSend_g is now NumTx_g: its value 2 moved to NumTx_g. (PR #12 of OpenSPP: the send port count has a new name)');
  await shot(page, info, 'migration-01-dialog');
  await dialog.getByRole('button', { name: 'Close', exact: true }).click();
  // the system: the same list until it is saved, and the info checks of rule migration
  await expect(page.locator('#cmp-h-changes')).toHaveText('Changes since this file was saved (2)');
  await expect(page.locator('[data-view="changes"] li').first()).toContainText('spp0 The number of send ports has a new name.');
  await expect(page.locator('.cmp-check-item.cmp-sev-info', { hasText: 'Register map v2' })).toHaveCount(1);
  // the renamed generic took its value
  expect((await page.evaluate(() => /** @type {any} */ (window).composer.design.instances.find((/** @type {any} */ i) => i.id === 'spp0').generics))).toEqual({ NumTx_g: 2 });
  // saved at the current pins: the list and the checks end
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Save', exact: true }).click()]);
  const saved = JSON.parse(readFileSync(await download.path(), 'utf-8'));
  expect(saved.sources.find((/** @type {any} */ s) => s.id === 'openspp').commit).toBe(catalog.sources.find((/** @type {any} */ s) => s.id === 'openspp').commit);
  await expect(page.locator('#cmp-h-changes')).toHaveCount(0);
  await expect(page.locator('.cmp-check-item.cmp-sev-info', { hasText: 'Register map v2' })).toHaveCount(0);
});

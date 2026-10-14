// Browser tests of the inserted reset generators: on the canvas like the other inserted blocks, on the top border of
// their clock domain, with the reason, the blocks they reset and their generics in the inspector.
import { test } from '@playwright/test';
import { expect, open, openExample, rects, watch } from './helpers.mjs';

/** @type {string[]} */
let problems = [];

test.beforeEach(async ({ page }) => {
  problems = [];
  watch(page, problems);
});

test.afterEach(() => {
  expect(problems, problems.join('\n')).toEqual([]);
});

test('the reset generator of a clock domain is shown on its border and explains itself', async ({ page }) => {
  await open(page);
  await openExample(page, 'SpaceWire RMAP target');
  const gen = page.locator('[data-auto="auto_rst_sys"]');
  await expect(gen).toHaveCount(1);
  await expect(gen).toHaveAttribute('aria-label', 'Reset generator inserted automatically: Synchronous reset of System clock.');
  await expect(gen).toContainText('Reset generator');
  await expect(gen).toContainText('System clock');
  // on the top border of the domain box, clear of its header tab
  const [box] = await rects(page, '[data-domain="sys"] .cmp-domain-box');
  const [chip] = await rects(page, '[data-auto="auto_rst_sys"] .cmp-auto-body');
  expect(Math.abs(chip.y + chip.h / 2 - box.y)).toBeLessThanOrEqual(2);
  // selected, the inspector shows what it is for
  await gen.click();
  const insp = page.locator('.cmp-side');
  await expect(insp).toContainText('Inserted block');
  await expect(insp).toContainText('olo_base_reset_gen');
  await expect(insp).toContainText('blocks of the clock domain have a synchronous reset');
  await expect(insp.getByRole('heading', { name: 'Resets', exact: true })).toHaveCount(1);
  await expect(insp).toContainText('rmap0');
  await expect(insp).toContainText('SyncTmr_g');
});

// Browser tests of editing with subsystems: the systems of the other tabs in the palette (not those that contain the
// active one), placing one, the mark of a subsystem whose tab holds another version and its update as one undo step,
// and a subsystem opened in a tab of its own.
import { test } from '@playwright/test';
import { design, expect, open, openExample, watch } from './helpers.mjs';

/** @type {string[]} */
let problems = [];

test.beforeEach(async ({ page }) => {
  problems = [];
  watch(page, problems);
});

test.afterEach(() => {
  expect(problems, problems.join('\n')).toEqual([]);
});

test('the system of another tab is placed as a subsystem, updated from its tab and opened as a tab', async ({ page }) => {
  await open(page);
  await openExample(page, 'SpaceWire RMAP target');
  await page.getByRole('button', { name: 'New', exact: true }).click();
  // the palette offers the system of the other tab
  const entry = page.locator('.cmp-pal-subsystem [data-subsystem="spw_rmap_node"]');
  await expect(entry).toBeVisible();
  await expect(entry).toHaveAttribute('aria-label', 'Add spw_rmap_node as a subsystem');
  await entry.focus();
  await page.keyboard.press('Enter');
  const block = page.locator('[data-block="spw_rmap_node0"]');
  await expect(block).toContainText('Subsystem · spw_rmap_node');
  // the link clock got a clock domain of its own: the SpaceWire port inside crosses between its clocks
  expect((await design(page)).clockDomains.map((/** @type {any} */ c) => c.id)).toEqual(['sys', 'link']);

  // the first tab: the new system contains it, so it is not offered there
  await page.getByRole('tab', { name: /^spw_rmap_node/ }).click();
  await expect(page.locator('.cmp-block').first()).toBeVisible();
  await expect(page.locator('.cmp-pal-subsystem [data-subsystem]')).toHaveCount(0);
  // a change in that tab marks the subsystem in the other one
  await page.locator('#cmp-sys-desc').fill('Edited in its own tab.');
  await page.locator('#cmp-sys-desc').press('Tab');
  await page.getByRole('tab', { name: /^system/ }).click();
  await expect(block.locator('.cmp-block-changed')).toHaveCount(1);
  await block.click();
  const update = page.getByRole('button', { name: 'Update to the current version of spw_rmap_node' });
  await update.click();
  await expect(block.locator('.cmp-block-changed')).toHaveCount(0);
  expect((await design(page)).subsystems.spw_rmap_node.description).toBe('Edited in its own tab.');
  // one undo step
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(block.locator('.cmp-block-changed')).toHaveCount(1);
  await page.getByRole('button', { name: 'Redo', exact: true }).click();
  await expect(block.locator('.cmp-block-changed')).toHaveCount(0);

  // open as tab: the open tab of the system, or a new tab from the definition once it is closed
  await block.click();
  await page.getByRole('button', { name: 'Open as tab' }).click();
  await expect(page.getByRole('tab', { name: /^spw_rmap_node/ })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Close spw_rmap_node' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Close without saving' }).click();
  await expect(page.getByRole('tab')).toHaveCount(1);
  await block.click();
  await page.getByRole('button', { name: 'Open as tab' }).click();
  await expect(page.getByRole('tab')).toHaveCount(2);
  await expect(page.getByRole('tab', { name: /^spw_rmap_node/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.cmp-block')).toHaveCount(2);
  expect((await design(page)).description).toBe('Edited in its own tab.');
});

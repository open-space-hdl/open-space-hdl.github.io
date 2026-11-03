// Browser tests of the reset groups: the inspector of a block with a reset output lists the blocks of its group and
// its name, a member names its group, a change of the group is one undo step, and the file of a system with a group
// is format version 3 (version 1 again without it).
import { test } from '@playwright/test';
import { design, expect, open, openExample, saveText, shot, watch } from './helpers.mjs';

/** @type {string[]} */
let problems = [];

test.beforeEach(async ({ page }) => {
  problems = [];
  watch(page, problems);
});

test.afterEach(() => {
  expect(problems, problems.join('\n')).toEqual([]);
});

test('the reset group of the example: the members at the source, the group at a member, editing with undo, the saved file', async ({ page }, info) => {
  await open(page);
  await openExample(page, 'SpaceWire compression node with a pipeline reset');
  const members = async () => (await design(page)).resetGroups?.[0]?.members;
  const box = (/** @type {string} */ id) => page.locator(`#cmp-rgroup-RstOut-${id}`);
  // the source: its group and the blocks it resets
  await page.locator('[data-block="prst0"]').focus();
  await expect(page.locator('.cmp-rgroup[data-source="prst0.RstOut"]')).toBeVisible();
  await expect(page.getByLabel('Name of the group')).toHaveValue('pipe');
  for (const id of ['och0', 'frm0', 'ocr0']) await expect(box(id)).toBeChecked();
  for (const id of ['spw0', 'nchar0', 'spp0', 'edac0']) await expect(box(id)).not.toBeChecked();
  await shot(page, info, 'rgroup-01-source');
  // a member names its group and the source
  await page.locator('[data-block="och0"]').focus();
  await expect(page.locator('[data-reset-member="pipe"]')).toHaveText('Reset: group pipe from prst0.RstOut, instead of the reset generator of its clock domain.');
  // a member less, then one undo step
  await page.locator('[data-block="prst0"]').focus();
  await box('ocr0').uncheck();
  await expect.poll(members).toEqual(['och0', 'frm0']);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(members).toEqual(['och0', 'frm0', 'ocr0']);
  // a new name
  await page.locator('[data-block="prst0"]').focus();
  const name = page.getByLabel('Name of the group');
  await name.fill('proc');
  await name.press('Tab');
  await expect.poll(async () => (await design(page)).resetGroups?.[0]?.id).toBe('proc');
  // the saved file: version 3 with the group
  const saved = JSON.parse((await saveText(page)).text);
  expect(saved.formatVersion).toBe(3);
  expect(saved.resetGroups).toEqual([{ id: 'proc', source: 'prst0.RstOut', members: ['och0', 'frm0', 'ocr0'] }]);
  // without members there is no group, and the file is version 1 again
  await page.locator('[data-block="prst0"]').focus();
  for (const id of ['och0', 'frm0', 'ocr0']) await box(id).uncheck();
  await expect.poll(async () => (await design(page)).resetGroups).toBeUndefined();
  const plain = JSON.parse((await saveText(page)).text);
  expect(plain.formatVersion).toBe(1);
  expect('resetGroups' in plain).toBe(false);
});

// Browser tests of the resource estimate of OpenCompact in the inspector: the section of an ocp_channel with the scope
// of its numbers and the notes of the models, and the sum in the system panel, labelled as the ocp_core instances only.
// The vendored modules are served as JavaScript.
import { test } from '@playwright/test';
import { expect, open, openExample, shot, watch } from './helpers.mjs';

/** @type {string[]} */
let problems = [];

test.beforeEach(async ({ page }) => {
  problems = [];
  watch(page, problems);
});

test.afterEach(() => {
  expect(problems, problems.join('\n')).toEqual([]);
});

test('the estimate of the compression channel and the sum of the system, with the notes of the models', async ({ page }, info) => {
  await open(page);
  for (const f of ['ocp_throughput.mjs', 'ocp_resources.mjs', 'ocp_models.mjs']) {
    const r = await page.request.get(`/assets/composer/js/vendor/opencompact/${f}`);
    expect(r.ok()).toBe(true);
    expect(r.headers()['content-type']).toMatch(/^text\/javascript/);
  }
  await openExample(page, 'SpaceWire compression node');
  await page.locator('[data-block="och0"]').focus();
  const sec = page.locator('[data-view="estimate"]');
  await expect(sec.locator('h3')).toHaveText('Resources (estimate for PolarFire)');
  await expect(sec).toContainText('The figures are those of ocp_core inside the channel, without the adapters and the register file of the channel.');
  await expect(sec.locator('li').filter({ hasText: /^Memories: \d+, \d+ data bits, \d+ bits stored with the check bits$/ })).toHaveCount(1);
  await expect(sec.locator('li').filter({ hasText: /^Logic: \d+ LUT, \d+ flip-flops$/ })).toHaveCount(1);
  await expect(sec.locator('li').filter({ hasText: /^Clock frequency: \d+ MHz$/ })).toHaveCount(1);
  await expect(sec.locator('li').filter({ hasText: /^Cycles per sample: \d+\.\d\d \(throughput model\)$/ })).toHaveCount(1);
  const notes = sec.locator('[data-view="estimate-notes"] li');
  await expect(notes.first()).toHaveText(/^Memories: exact for the generics/);
  await expect(notes.filter({ hasText: /^LUT and flip-flops: PolarFire MPF100T/ })).toHaveCount(1);
  await shot(page, info, 'estimate-01-channel');
  // the system panel: the sum of the ocp_core instances only
  await page.evaluate(() => /** @type {any} */ (window).composer.selectInstances([]));
  const sys = page.locator('[data-view="estimates"]');
  await expect(sys.locator('h3')).toHaveText('OpenCompact resources (estimate for PolarFire, ocp_core instances only)');
  await expect(sys.locator('[data-view="estimates-total"]')).toHaveText(/^Sum of the ocp_core instances only, not the system: \d+ memories, \d+ memory bits, \d+ LUT, \d+ flip-flops; lowest clock frequency \d+ MHz\.$/);
  await expect(sys.locator('button', { hasText: 'och0' })).toHaveCount(1);
});

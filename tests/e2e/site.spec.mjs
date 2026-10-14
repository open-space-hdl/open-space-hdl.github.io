// The Composer in the site: the entry with the Beta badge in header and footer, the teaser on the start page, no
// external requests on the pages that link to it.
import { test } from '@playwright/test';
import { expect, watch } from './helpers.mjs';

/** @type {string[]} */
let problems = [];

test.beforeEach(async ({ page }) => {
  problems = [];
  watch(page, problems);
});

test.afterEach(() => {
  expect(problems, problems.join('\n')).toEqual([]);
});

test('header and footer of every page lead to the Composer, marked as beta', async ({ page }) => {
  for (const path of ['/', '/trl/', '/composer/format/']) {
    await page.goto(path);
    const nav = page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Composer Beta' });
    await expect(nav).toHaveAttribute('href', '/composer/');
    await expect(page.getByRole('navigation', { name: 'Footer' }).getByRole('link', { name: 'Composer Beta' })).toHaveAttribute('href', '/composer/');
  }
  // the current page is marked in the header
  await page.goto('/composer/');
  await page.waitForSelector('.cmp.is-ready');
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Composer Beta' })).toHaveAttribute('aria-current', 'page');
});

test('the start page shows the Composer with a picture of the editor', async ({ page }) => {
  await page.goto('/');
  const teaser = page.locator('#composer');
  await expect(teaser.getByRole('heading', { level: 2 })).toHaveText('Compose an FPGA system from the cores');
  const img = teaser.locator('img');
  await img.scrollIntoViewIfNeeded();
  await expect.poll(() => img.evaluate((el) => /** @type {HTMLImageElement} */ (el).naturalWidth)).toBe(1680);
  await expect(img).toHaveAttribute('alt', /two clock domains/);
  await teaser.getByRole('link', { name: 'Open the Composer' }).click();
  await page.waitForSelector('.cmp.is-ready');
  await expect(page).toHaveURL(/\/composer\/$/);
});

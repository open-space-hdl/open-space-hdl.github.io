// The site around the Composer: the entry with the Beta badge in header and footer, the project groups and cards,
// the teaser on the start page, no external requests on the pages that link to it.
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

test('the start page groups the projects and shows every project exactly once', async ({ page }) => {
  // all projects of _data/projects.yml, as the Composer page embeds them
  await page.goto('/composer/');
  const all = JSON.parse((await page.locator('#cmp-projects').textContent()) ?? '[]').map((/** @type {{name: string}} */ p) => p.name);
  expect(all.length).toBeGreaterThan(0);

  await page.goto('/');
  const groups = page.locator('#projects .project-group');
  await expect(groups.getByRole('heading', { level: 3 })).toHaveText(['Interfaces & Protocols', 'Processing Modules', 'Building Blocks']);
  await expect(page.locator('#interfaces-protocols .card h4')).toHaveText(['OpenWire', 'OpenFibre', 'OpenRMAP', 'OpenSPP']);
  await expect(page.locator('#processing-modules .card h4')).toHaveText(['OpenCompact', 'OpenCrypto']);
  await expect(page.locator('#building-blocks .card h4')).toHaveText(['Open Logic FT']);
  // a project without a known group would be missing here
  const shown = (await page.locator('#projects .card h4').allTextContents()).map((s) => s.trim());
  expect([...shown].sort()).toEqual([...all].sort());
});

test('every project card has a tagline and a summary of one sentence', async ({ page }) => {
  // the rules of _data/projects.yml: the tagline names the standards, the summary is one sentence of 100 to 140 characters
  await page.goto('/');
  const cards = page.locator('#projects .card');
  const n = await cards.count();
  expect(n).toBeGreaterThan(0);
  for (let i = 0; i < n; i++) {
    const card = cards.nth(i);
    const name = (await card.locator('h4').textContent())?.trim();
    expect((await card.locator('.card-tagline .nowrap').allTextContents()).length, `${name}: tagline`).toBeGreaterThan(0);
    const summary = ((await card.locator('.card-summary').textContent()) ?? '').trim();
    expect(summary, `${name}: one sentence`).toMatch(/^[A-Z][^.]*(\.\d[^.]*)*\.$/);
    expect(summary.length, `${name}: ${summary.length} characters`).toBeGreaterThanOrEqual(100);
    expect(summary.length, `${name}: ${summary.length} characters`).toBeLessThanOrEqual(140);
  }
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

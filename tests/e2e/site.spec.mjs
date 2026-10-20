// The site around the Composer: the entry with the Beta badge in header and footer, the project groups and cards,
// the teaser on the start page, the roadmap page, no external requests on the pages that link to it.
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
  for (const path of ['/', '/trl/', '/roadmap/', '/composer/format/']) {
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

test('the start page carries the name of the site as its title, the other pages add their own', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveTitle('Open Space HDL');
  await page.goto('/trl/');
  await expect(page).toHaveTitle('Technology readiness levels · Open Space HDL');
});

test('the start page groups the projects and shows every project exactly once', async ({ page }) => {
  // all projects of _data/projects.yml, as the Composer page embeds them
  await page.goto('/composer/');
  const all = JSON.parse((await page.locator('#cmp-projects').textContent()) ?? '[]').map((/** @type {{name: string}} */ p) => p.name);
  expect(all.length).toBeGreaterThan(0);

  await page.goto('/');
  const groups = page.locator('#projects .project-group');
  await expect(groups.getByRole('heading', { level: 3 })).toHaveText(['Interfaces & Protocols', 'Processing Modules', 'System Infrastructure', 'Building Blocks']);
  await expect(page.locator('#interfaces-protocols .card h4')).toHaveText(['OpenWire', 'OpenFibre', 'OpenRMAP', 'OpenSPP', 'OpenCAN', 'Open1553']);
  await expect(page.locator('#processing-modules .card h4')).toHaveText(['OpenCompact', 'OpenCrypto']);
  await expect(page.locator('#system-infrastructure .card h4')).toHaveText(['OpenDMA']);
  await expect(page.locator('#building-blocks .card h4')).toHaveText(['Open Logic FT']);
  // a project without a known group would be missing here
  const shown = (await page.locator('#projects .card h4').allTextContents()).map((s) => s.trim());
  expect([...shown].sort()).toEqual([...all].sort());
});

test('a project that is not public yet shows Coming soon and no links, a public one its TRL and links', async ({ page }) => {
  await page.goto('/');
  const soon = page.locator('#projects .card').filter({ has: page.locator('.badge', { hasText: 'Coming soon' }) });
  await expect(soon.locator('h4')).toHaveText(['OpenCAN', 'Open1553']);
  await expect(soon.locator('a')).toHaveCount(0);
  await expect(soon.locator('.trl')).toHaveCount(0);
  const dma = page.locator('#system-infrastructure .card');
  await expect(dma.locator('.trl')).toContainText('3');
  await expect(dma.getByRole('link', { name: 'Documentation' })).toHaveAttribute('href', '/opendma/');
  await expect(dma.getByRole('link', { name: 'Source on GitHub' })).toHaveAttribute('href', 'https://github.com/open-space-hdl/opendma');
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

test('the roadmap page is in the header of every page and on the TRL page, and links the roadmap of every project', async ({ page }) => {
  for (const path of ['/', '/trl/', '/composer/format/']) {
    await page.goto(path);
    await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Roadmap', exact: true })).toHaveAttribute('href', '/roadmap/');
  }
  await page.goto('/trl/');
  await page.getByRole('link', { name: 'family roadmap' }).click();
  await expect(page).toHaveURL(/\/roadmap\/$/);
  await expect(page).toHaveTitle('Roadmap · Open Space HDL');
  await expect(page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Roadmap', exact: true })).toHaveAttribute('aria-current', 'page');
  // the sections in their order, each reachable from the overview
  const titles = ['Hardware tests for TRL 4', 'CCSDS space link core', 'New Open Logic building blocks', 'Further cores', 'Reference systems and evaluation boards', 'Composer'];
  await expect(page.locator('.roadmap-section h2')).toHaveText(titles);
  const toc = page.getByRole('navigation', { name: 'Roadmap' }).getByRole('link');
  await expect(toc).toHaveCount(titles.length);
  for (let i = 0; i < titles.length; i++) {
    const target = await toc.nth(i).getAttribute('href');
    await expect(page.locator(`${target} h2`)).toHaveText(titles[i]);
  }
  // the roadmap of every core with a documentation site
  await expect(page.locator('.link-row a')).toHaveText(['OpenWire', 'OpenFibre', 'OpenRMAP', 'OpenSPP', 'OpenCompact', 'OpenCrypto', 'OpenDMA']);
  for (const a of await page.locator('.link-row a').all()) await expect(a).toHaveAttribute('href', /^\/[a-z-]+\/docs\/roadmap\.html$/);
  // the overview states the state of every section; the building blocks of phase 1 of the space link core come next
  await expect(page.locator('.roadmap-toc .toc-state')).toHaveText(['In progress', 'Next', 'Next', 'In progress', 'Planned', 'Planned']);
  await expect(page.locator('.roadmap-section .eyebrow')).toHaveText(['In progress', 'Next', 'Next', 'In progress', 'Planned', 'Planned']);
  await expect(page.locator('.blocks-table .state-tag')).toHaveText(['Next', 'Next', 'Next', 'Planned', 'Planned', 'Planned', 'Done']);
  // the further cores: the ones in progress first, then the planned ones in their order
  await expect(page.locator('.cores-table td[data-label="Core"]')).toHaveText(['MIL-STD-1553B bus interface', 'CAN bus', 'Routing switch', 'Lossless data compression', 'Time codes']);
  await expect(page.locator('.cores-table .state-tag')).toHaveText(['In progress', 'In progress', 'Planned', 'Planned', 'Planned']);
  // the on-board chain ends with the transfer frames of the new core before the transmitter
  await expect(page.locator('.chain .chain-step.is-new')).toContainText('Transfer frames');
  expect(await page.locator('main').textContent()).not.toContain(String.fromCharCode(0x2014));
});

test('the roadmap page fits a phone: no horizontal scrolling, tables stacked', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 800 });
  await page.goto('/roadmap/');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
  await expect(page.locator('.roadmap-table thead').first()).toBeHidden();
});

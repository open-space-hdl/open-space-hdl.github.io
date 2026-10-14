// Browser tests of the Composer (milestone 4): the saved file carries the resolved netlist, the checks and the build
// brief; OpenCrypto blocks with their constants and chain rules; the file format page.
import { test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { design, expect, open, openExample, saveText, shot, watch } from './helpers.mjs';

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

test('the saved file carries the netlist, the checks and the build brief of the golden files', async ({ page }, info) => {
  await open(page);
  await openExample(page, 'Encrypted packets over SpaceWire');
  await expect(page.locator('[data-block="frm0"]')).toBeVisible();
  await expect(page.locator('.cmp-check-item.cmp-sev-error')).toHaveCount(0);
  await shot(page, info, '01-encrypted-example');
  const saved = await saveText(page);
  expect(saved.name).toBe('encrypted_spp_over_spw.composer.json');
  const doc = JSON.parse(saved.text);
  // the browser resolves the system to the same netlist and brief as the unit tests
  // (the golden files pin the netlist and the brief, not the content identifier of the catalog)
  const noCatalogText = (/** @type {string} */ t) => t.replace(/\(catalog `[0-9a-f]+`\)/, '(catalog `*`)').trimEnd();
  expect({ ...doc.resolved, catalog: '*' }).toEqual({ ...JSON.parse(golden('encrypted_spp_over_spw.resolved.json')), catalog: '*' });
  expect(noCatalogText(doc.agent.brief)).toBe(noCatalogText(golden('encrypted_spp_over_spw.brief.md')));
  expect(doc.checks.filter((/** @type {any} */ c) => c.severity === 'error')).toEqual([]);
  expect(Object.keys(doc)).toEqual(['$schema', 'format', 'formatVersion', 'generator', 'system', 'sources', 'clockDomains', 'instances',
    'connections', 'externals', 'resolved', 'checks', 'agent', 'catalogSubset', 'layout']);
});

test('the key slot of the framer is a constant of the instance and reaches the netlist', async ({ page }, info) => {
  await open(page);
  await openExample(page, 'Encrypted packets over SpaceWire');
  await page.locator('[data-block="frm0"] .cmp-block-head').click();
  const slot = page.locator('#cmp-const-frm0-Cfg-slot');
  await expect(slot).toHaveValue('0');
  // four key slots in the core the framer feeds: 0 to 3
  await expect(page.locator('[data-itf="frm0.Cfg"]')).toContainText('0 to 3');
  // the field says what the interface is: no second "Key slot" above it
  await expect(page.locator('[data-itf="frm0.Cfg"] .cmp-itf-label')).toHaveCount(0);
  await slot.fill('7');
  await slot.press('Enter');
  await expect(page.locator('[data-itf="frm0.Cfg"]')).toContainText('Enter an integer from 0 to 3');
  expect((await design(page)).instances.find((/** @type {any} */ i) => i.id === 'frm0').constants).toBeUndefined();
  await slot.fill('2');
  await slot.press('Enter');
  await expect.poll(async () => (await design(page)).instances.find((/** @type {any} */ i) => i.id === 'frm0').constants).toEqual({ Cfg: { slot: 2 } });
  await shot(page, info, '02-key-slot');
  const doc = JSON.parse((await saveText(page)).text);
  expect(doc.instances.find((/** @type {any} */ i) => i.id === 'frm0').constants).toEqual({ Cfg: { slot: 2 } });
  expect(doc.resolved.nets.find((/** @type {any} */ n) => n.to === 'frm0_Cfg_Slot_s')).toMatchObject({ from: '"10"', kind: 'tie-off' });
});

test('chain rules: the send buffer holds one encrypted chunk, the core feeds a send port with its dense output', async ({ page }, info) => {
  await open(page);
  await openExample(page, 'Encrypted packets over SpaceWire');
  await page.locator('[data-block="spp0"] .cmp-block-head').click();
  const buf = page.locator('#cmp-g-spp0-TxBufferBytes_g');
  await buf.fill('4096');
  await buf.press('Enter');
  const errors = page.locator('.cmp-check-item.cmp-sev-error');
  await expect(errors).toHaveCount(1);
  await expect(errors).toContainText('must hold one: set TxBufferBytes_g of spp0 to at least 4128 (now 4096)');
  await shot(page, info, '03-chain-rule');
  await buf.fill('8192');
  await buf.press('Enter');
  await expect(errors).toHaveCount(0);

  await page.locator('[data-block="ocr0"] .cmp-block-head').click();
  await page.locator('#cmp-g-ocr0-DenseOutput_g').uncheck();
  await expect(errors).toHaveCount(1);
  await expect(errors).toContainText('Set DenseOutput_g = true');
  // a click on the check shows the connection it is about
  await errors.click();
  await expect(page.locator('[data-edge="c3"]')).toHaveClass(/is-selected/);
  // the file keeps the error for its readers
  const doc = JSON.parse((await saveText(page)).text);
  expect(doc.checks.filter((/** @type {any} */ c) => c.severity === 'error').map((/** @type {any} */ c) => c.rule)).toEqual(['partner_requires']);
  expect(doc.agent.brief).toContain('Set DenseOutput_g = true');
});

test('the file format page is linked from the editor and documents the parts of a file', async ({ page }) => {
  await open(page);
  const link = page.getByRole('link', { name: 'File format' });
  await expect(link).toHaveAttribute('href', '/composer/format/');
  const [fmt] = await Promise.all([page.waitForEvent('popup'), link.click()]);
  await fmt.waitForLoadState();
  await expect(fmt.getByRole('heading', { level: 1 })).toHaveText('Composer file format');
  for (const key of ['resolved', 'checks', 'agent.brief', 'constants', 'sideband']) {
    await expect(fmt.locator('main code', { hasText: new RegExp(`^${key.replace('.', '\\.')}$`) }).first()).toBeVisible();
  }
  const schema = await fmt.request.get('/composer/schema/system-1.json');
  expect(schema.ok()).toBe(true);
  const s = await schema.json();
  expect(Object.keys(s.properties)).toEqual(expect.arrayContaining(['resolved', 'checks', 'agent']));
  const schema2 = await fmt.request.get('/composer/schema/system-2.json');
  expect(schema2.ok()).toBe(true);
  expect(Object.keys((await schema2.json()).properties)).toEqual(expect.arrayContaining(['subsystems', 'resolved']));
  await fmt.close();
});

// Browser tests of the interrupts and the protection scope in the inspector: the lists of the system, the registers
// of an interrupt and the target of an ECC event at their interfaces, the inserted crossings and what is not reported.
import { readFileSync } from 'node:fs';
import { test } from '@playwright/test';
import { expect, open, openExample, shot, watch } from './helpers.mjs';

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

test('the interrupts and the protection of the user\'s system, and their lines at the interfaces', async ({ page }, info) => {
  await open(page);
  await page.locator('input[type="file"]').setInputFiles({ name: 'spfi_encrypt.composer.json', mimeType: 'application/json', buffer: fixture });
  await expect(page.locator('[data-block="edac0"]')).toHaveCount(1);
  // the interrupts: all open, with the status register to poll
  await expect(page.locator('#cmp-h-irq')).toHaveText('Interrupts (8)');
  const irqs = page.locator('[data-view="interrupts"] li');
  await expect(irqs).toHaveCount(8);
  await expect(irqs.filter({ hasText: 'ocr0.Irq' })).toHaveText('ocr0.Irq open: poll IRQ_STATUS 0x020');
  await expect(irqs.filter({ hasText: 'edac0.Irq' })).toHaveText('edac0.Irq open');
  // the protection: seven cores with ECC of their own, every ECC event of the framers at the monitor
  await expect(page.locator('[data-view="ecc-blocks"] li')).toHaveCount(7);
  await expect(page.locator('[data-view="ecc-blocks"] li').filter({ hasText: 'spp0' })).toHaveText('spp0 spp_core, 8 channels, ECC_STATUS 0x060');
  const events = page.locator('[data-view="ecc-events"] li');
  await expect(events).toHaveCount(8);
  await expect(events.filter({ hasText: 'frm1.Ecc[1]' })).toHaveText('frm1.Ecc[1] position FIFO: channel 3 of edac0');
  await expect(page.locator('.cmp-inspector section', { has: page.locator('#cmp-h-prot') })).not.toContainText('Not reported');
  await page.locator('[data-view="ecc-events"]').scrollIntoViewIfNeeded();
  await shot(page, info, 'views-01-system');
  // a click selects the block; its interfaces say where the registers of the interrupt are and where its ECC goes
  await page.locator('[data-view="interrupts"]').getByRole('button', { name: 'spp0.Irq' }).click();
  await expect(page.locator('#cmp-inst-id')).toHaveValue('spp0');
  await expect(page.locator('[data-itf="spp0.Irq"] .cmp-itf-addr')).toHaveText('Enable IRQ_EN 0x058, status IRQ_STATUS 0x05C, events EVENTS 0x054.');
  await page.locator('[data-block="frm0"]').focus();
  await expect(page.locator('#cmp-inst-id')).toHaveValue('frm0');
  await expect(page.locator('[data-itf="frm0.Ecc[0]"] .cmp-itf-addr')).toHaveText('ECC events of the chunk buffer: channel 0 of edac0.');
});

test('the system ECC monitor reports the inserted crossings; unmarked, their ECC events are not reported', async ({ page }, info) => {
  await open(page);
  await openExample(page, 'Space Packets over SpaceWire, two clocks');
  const section = page.locator('.cmp-inspector section', { has: page.locator('#cmp-h-prot') });
  // marked in the example: one FIFO ends in the clock domain of the monitor, the other reaches it through a pulse crossing
  await expect(page.locator('[data-view="crossings"]')).toHaveText('Inserted crossings (3): olo_ft_fifo_async (2) with SECDED ECC and triplicated synchronisers; olo_base_cc_pulse (1) with triplicated synchronisers (no memory).');
  await expect(page.locator('[data-view="ecc-events"] li')).toHaveText([
    'auto_cdc_c5.Ecc FIFO memory: channel 0 of edac0 (connected by the Composer)',
    'auto_cdc_c6.Ecc FIFO memory: channel 1 of edac0 (connected by the Composer)',
  ]);
  await expect(section).not.toContainText('Not reported');
  // the checkbox of the monitor: unmarked, the ECC events stay open and a remark names the checkbox
  await page.locator('[data-block="edac0"]').focus();
  const box = page.getByLabel('System ECC monitor');
  await expect(box).toBeChecked();
  await shot(page, info, 'views-02-monitor');
  await box.uncheck();
  await expect.poll(async () => (await page.evaluate(() => /** @type {any} */ (window).composer.design.eccMonitor))).toBeUndefined();
  await expect(page.locator('.cmp-check-item.cmp-sev-info', { hasText: 'mark it as the system ECC monitor' })).toHaveCount(1);
  // the system again: nothing selected
  await page.evaluate(() => /** @type {any} */ (window).composer.selectInstances([]));
  await expect(page.locator('[data-view="ecc-events"] li')).toHaveText([
    'auto_cdc_c5.Ecc FIFO memory: not reported',
    'auto_cdc_c6.Ecc FIFO memory: not reported',
  ]);
  await expect(section).toContainText('Not reported: the ECC events of 2 memories are open.');
  // one undo step marks it again
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => (await page.evaluate(() => /** @type {any} */ (window).composer.design.eccMonitor))).toBe('edac0');
});

test('the readiness of the parts of the user\'s system, without a TRL of the system', async ({ page }) => {
  await open(page);
  await page.locator('input[type="file"]').setInputFiles({ name: 'spfi_encrypt.composer.json', mimeType: 'application/json', buffer: fixture });
  await expect(page.locator('[data-view="readiness"]')).toHaveText('Parts at TRL 3 or higher (lowest: 3). The composed system has no TRL of its own: it is checked by elaboration and a run to 0 ns.');
  await expect(page.locator('[data-view="parts"] li')).toHaveText([
    'OpenRMAP TRL 3, 1 block', 'OpenSPP TRL 3, 2 blocks', 'OpenFibre TRL 3, 2 blocks', 'OpenCrypto TRL 3, 8 blocks', /^Open Logic FT TRL 3, \d+ blocks$/,
  ]);
});

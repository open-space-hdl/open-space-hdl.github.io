// Browser tests of the throughput budget in the editor: the stated traffic of an external interface in the inspector,
// the capacity of its paths, the warning and the bottleneck marker on the canvas, the paths over a connection, undo.
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

test('stated traffic of an external interface: its paths, the warning, the bottleneck and the paths of a connection', async ({ page }) => {
  await open(page);
  await openExample(page, 'SpaceFibre node');
  // the block may lie outside the view at the zoom of Fit: select it with the keyboard
  await page.locator('[data-block="spp0"]').focus();
  const row = page.locator('[data-itf="spp0.S_Tx[0]"]');
  await expect(row.getByLabel('Packet length (B)')).toHaveValue('');
  // the capacity of its path at the reference length while nothing is stated
  await expect(row).toContainText('to the link of ofb0: 4.46 Gbit/s at 1024 B packets, limited by the link of ofb0');
  // the values take effect together when the focus leaves the fields: Tab from the length goes on to the rate, from the
  // rate to the largest packet
  await row.getByLabel('Packet length (B)').fill('1024');
  await row.getByLabel('Packet length (B)').press('Tab');
  await expect(row.getByLabel('Rate (Mbit/s)')).toBeFocused();
  await row.getByLabel('Rate (Mbit/s)').fill('5000');
  await row.getByLabel('Rate (Mbit/s)').press('Tab');
  await expect(row.getByLabel('Largest packet (B)')).toBeFocused();
  expect((await design(page)).externals.find((/** @type {any} */ e) => e.interface === 'spp0.S_Tx[0]').traffic).toBeUndefined();
  await row.getByLabel('Largest packet (B)').press('Tab');
  await expect.poll(async () => (await design(page)).externals.find((/** @type {any} */ e) => e.interface === 'spp0.S_Tx[0]').traffic)
    .toEqual({ packetBytes: 1024, bitsPerSecond: 5e9 });
  // the throughput warning (the example has a warning of its own on the transceiver reset)
  const warning = page.locator('.cmp-check-item.cmp-sev-warning', { hasText: 'Gbit/s at 1024 B packets' });
  await expect(warning).toHaveCount(1);
  await expect(warning).toContainText('tx0_ (spp0.S_Tx[0]) needs 5.00 Gbit/s at 1024 B packets');
  // the block of the bottleneck is marked, with the same finding as the checks
  const ofb = page.locator('[data-block="ofb0"]');
  await expect(ofb).toHaveClass(/is-bottleneck/);
  await expect(ofb.locator('.cmp-block-bottleneck')).toHaveText(/bottleneck/);
  const finding = await warning.locator('.cmp-check-msg').textContent();
  expect(await ofb.locator('.cmp-block-bottleneck title').textContent()).toBe(finding);
  // within the capacity: no warning, no marker
  await page.locator('[data-block="spp0"]').focus();
  await row.getByLabel('Rate (Mbit/s)').fill('4000');
  await row.getByLabel('Rate (Mbit/s)').press('Enter');
  await expect(warning).toHaveCount(0);
  await expect(ofb).not.toHaveClass(/is-bottleneck/);
  // the paths over a connection
  const conn = (await design(page)).connections.find((/** @type {any} */ c) => c.from === 'spp0.M_Link');
  await page.evaluate((id) => /** @type {any} */ (window).composer.selectConnection(id, false), conn.id);
  await expect(page.locator('.cmp-inspector')).toContainText('tx0_ (spp0.S_Tx[0]) to the link of ofb0: 4.46 Gbit/s at 1024 B packets, limited by the link of ofb0.');
  // two steps (5000, then 4000 Mbit/s): undo twice and there is no traffic again
  for (let k = 0; k < 2; k += 1) await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect.poll(async () => (await design(page)).externals.find((/** @type {any} */ e) => e.interface === 'spp0.S_Tx[0]').traffic).toBeUndefined();
});

test('a rate entered in Mbit/s is stored in bit/s and shown in Mbit/s again', async ({ page }) => {
  await open(page);
  await openExample(page, 'SpaceFibre node');
  await page.locator('[data-block="spp0"]').focus();
  const row = page.locator('[data-itf="spp0.S_Tx[0]"]');
  await row.getByLabel('Packet length (B)').fill('512');
  await row.getByLabel('Packet length (B)').press('Tab');
  await row.getByLabel('Rate (Mbit/s)').fill('1600');
  await row.getByLabel('Rate (Mbit/s)').press('Enter');
  await expect.poll(async () => (await design(page)).externals.find((/** @type {any} */ e) => e.interface === 'spp0.S_Tx[0]').traffic)
    .toEqual({ packetBytes: 512, bitsPerSecond: 1600000000 });
  // drawn again from the design: the same Mbit/s
  await page.locator('[data-block="ofb0"]').focus();
  await page.locator('[data-block="spp0"]').focus();
  await expect(row.getByLabel('Rate (Mbit/s)')).toHaveValue('1600');
  await expect(row.getByLabel('Packet length (B)')).toHaveValue('512');
});

test('the largest packet of an external interface bounds the packets along the chain', async ({ page }) => {
  await open(page);
  await openExample(page, 'SpaceFibre node');
  await page.locator('[data-block="spp0"]').focus();
  const row = page.locator('[data-itf="spp0.S_Tx[0]"]');
  await expect(row.getByLabel('Largest packet (B)')).toHaveValue('');
  // without a largest packet the source is not bounded: a remark at the first limit
  const remark = page.locator('.cmp-check-item.cmp-sev-info', { hasText: 'Packets from tx0_ (spp0.S_Tx[0]) reach spp0.S_Tx[0]' });
  await expect(remark).toHaveCount(1);
  await row.getByLabel('Packet length (B)').fill('1024');
  await row.getByLabel('Largest packet (B)').fill('9000');
  await row.getByLabel('Largest packet (B)').press('Enter');
  await expect.poll(async () => (await design(page)).externals.find((/** @type {any} */ e) => e.interface === 'spp0.S_Tx[0]').traffic)
    .toEqual({ packetBytes: 1024, maxPacketBytes: 9000 });
  const error = page.locator('.cmp-check-item.cmp-sev-error', { hasText: 'has up to 9000 bytes (its stated largest packet)' });
  await expect(error).toHaveCount(1);
  await expect(error).toContainText('set TxBufferBytes_g of spp0 to 16384, the smallest value of at least 9000 that TxBufferBytes_g allows (now 4096)');
  await expect(remark).toHaveCount(0);
  // a largest packet below the packet length is refused
  await page.locator('[data-block="spp0"]').focus();
  await row.getByLabel('Largest packet (B)').fill('100');
  await row.getByLabel('Largest packet (B)').press('Enter');
  await expect(row).toContainText('Give the largest packet in whole bytes, at least the packet length, or leave it empty.');
  expect((await design(page)).externals.find((/** @type {any} */ e) => e.interface === 'spp0.S_Tx[0]').traffic.maxPacketBytes).toBe(9000);
  // empty again: not bounded
  await row.getByLabel('Largest packet (B)').fill('');
  await row.getByLabel('Largest packet (B)').press('Enter');
  await expect.poll(async () => (await design(page)).externals.find((/** @type {any} */ e) => e.interface === 'spp0.S_Tx[0]').traffic)
    .toEqual({ packetBytes: 1024 });
  await expect(error).toHaveCount(0);
  await expect(remark).toHaveCount(1);
});

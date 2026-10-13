// Screen recording for the review: building an OpenWire and OpenRMAP node with the animations. Runs only in Chromium
// and only when COMPOSER_SCREENS names a directory for the recording.
import { test } from '@playwright/test';
import { join } from 'node:path';
import { canvasPoint, dragBlock, dragTo, open, portCenter, settled } from './helpers.mjs';

const SCREENS = process.env.COMPOSER_SCREENS;

test.use({ video: { mode: 'on', size: { width: 1440, height: 900 } } });
test.skip(({ browserName }) => !SCREENS || browserName !== 'chromium', 'recorded only for the review');

test('building OWR and OMAP with the animations', async ({ page }) => {
  test.setTimeout(120_000);
  await open(page);
  await page.waitForTimeout(600);
  await dragBlock(page, 'SpaceWire port', await canvasPoint(page, 0.28, 0.3));
  await page.waitForTimeout(500);
  await dragBlock(page, 'RMAP target', await canvasPoint(page, 0.72, 0.3));
  await page.waitForTimeout(500);
  const slowWire = async (/** @type {string} */ from, /** @type {string} */ to) => {
    await settled(page);
    const a = await portCenter(page, from);
    const b = await portCenter(page, to);
    await page.mouse.move(a.x, a.y, { steps: 10 });
    await page.mouse.down();
    await page.mouse.move(a.x + 40, a.y + 30, { steps: 12 });
    await page.mouse.move((a.x + b.x) / 2, b.y + 60, { steps: 20 });
    await page.mouse.move(b.x - 26, b.y + 6, { steps: 20 });
    await page.waitForTimeout(500);
    await page.mouse.up();
    await page.waitForTimeout(1400);
  };
  await slowWire('spw0.M_Pkt', 'rmap0.S_Pkt');
  await slowWire('rmap0.M_Pkt', 'spw0.S_Pkt');
  // a clock domain of its own for the RMAP node: the FIFOs pop in on the border
  await page.getByRole('button', { name: 'Clock domain', exact: true }).click();
  await settled(page);
  await page.waitForTimeout(500);
  const box = await page.locator('[data-domain="clk1"] .cmp-domain-box').boundingBox();
  if (box) {
    await dragTo(page, page.locator('[data-block="rmap0"] .cmp-block-head'), { x: box.x + box.width / 2 - 90, y: box.y + 70 });
    await page.waitForTimeout(1200);
  }
  await page.getByRole('button', { name: 'Fit' }).click();
  await page.waitForTimeout(1200);
  await page.getByRole('button', { name: 'Arrange' }).click();
  await page.waitForTimeout(1500);
  await page.keyboard.press('Control+z');
  await page.waitForTimeout(1200);
  const video = page.video();
  await page.close();
  if (video && SCREENS) await video.saveAs(join(SCREENS, 'building-owr-omap.webm'));
});

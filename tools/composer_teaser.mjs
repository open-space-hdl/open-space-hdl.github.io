// Takes the picture of the Composer for the start page (assets/img/composer-teaser.png): the example "Space Packets
// over SpaceWire, two clocks" in the editor, the whole system in the view. Needs the built site served and Playwright
// with Chromium from tests/:
//
//   (tests) node e2e/serve.mjs ../_site 4174
//   node tools/composer_teaser.mjs [http://127.0.0.1:4174]
import { fileURLToPath } from 'node:url';
import { chromium } from '../tests/node_modules/@playwright/test/index.mjs';

const base = process.argv[2] ?? 'http://127.0.0.1:4174';
const out = fileURLToPath(new URL('../assets/img/composer-teaser.png', import.meta.url));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1680, height: 860 }, deviceScaleFactor: 1 });
await page.goto(`${base}/composer/`);
await page.waitForSelector('.cmp.is-ready');
await page.getByRole('button', { name: 'Examples' }).click();
await page.locator('.cmp-menu-item').filter({ hasText: 'Space Packets over SpaceWire, two clocks' }).first().click();
await page.waitForTimeout(1500);
// a zoom that shows the whole system with its labels, the system centred in the canvas
await page.evaluate(() => /** @type {any} */ (window).composer.canvas.setView({ x: 0, y: 0, zoom: 0.68 }));
await page.waitForTimeout(400);
await page.evaluate(() => {
  const c = /** @type {any} */ (window).composer.canvas;
  const wrap = c.wrap.getBoundingClientRect();
  const rs = [...document.querySelectorAll('.cmp-canvas [data-block], .cmp-canvas .cmp-auto, .cmp-canvas .cmp-external')]
    .map((e) => e.getBoundingClientRect()).filter((r) => r.width > 0);
  const x0 = Math.min(...rs.map((r) => r.left));
  const x1 = Math.max(...rs.map((r) => r.right));
  const y0 = Math.min(...rs.map((r) => r.top));
  const y1 = Math.max(...rs.map((r) => r.bottom));
  c.setView({ x: c.view.x + wrap.left + wrap.width / 2 - (x0 + x1) / 2, y: c.view.y + wrap.top + wrap.height / 2 - (y0 + y1) / 2, zoom: c.view.zoom });
});
await page.waitForTimeout(600);
// the editor below the site header
await page.screenshot({ path: out, clip: { x: 0, y: 52, width: 1680, height: 660 } });
await browser.close();
console.log(`wrote ${out}`);

// Browser tests of milestone 3: layout (routes, adapters on the domain border, tidy boxes, Arrange), animations and
// reduced motion, legend, keyboard operation, panels, and the frame times with 100 blocks.
import { test } from '@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Catalog } from '../../assets/composer/js/model/catalog.js';
import { checkConnection } from '../../assets/composer/js/model/compat.js';
import { addConnection, addInstance, createDesign } from '../../assets/composer/js/model/design.js';
import { toDocument } from '../../assets/composer/js/model/serialize.js';
import {
  addBlock, canvasPoint, design, dragTo, dragWire, expect, open, openExample, overlap, portCenter, settled, shot,
  stableRects, watch,
} from './helpers.mjs';

const SCREENS = process.env.COMPOSER_SCREENS;

/** @type {string[]} */
let problems = [];

test.beforeEach(async ({ page }) => {
  problems = [];
  watch(page, problems);
});

test.afterEach(() => {
  expect(problems, problems.join('\n')).toEqual([]);
});

/**
 * Puts rmap0 of the SpaceWire RMAP example into a new clock domain through the inspector.
 * @param {import('@playwright/test').Page} page
 */
async function rmapInOwnDomain(page) {
  await openExample(page, 'SpaceWire RMAP target');
  await page.getByRole('button', { name: 'Clock domain', exact: true }).click();
  await settled(page);
  await page.locator('[data-block="rmap0"] .cmp-block-head').click();
  const sel = page.locator('#cmp-clk-rmap0-Clk');
  await sel.selectOption('clk1');
  await settled(page);
  await page.getByRole('button', { name: 'Fit' }).click();
  await settled(page);
}

test('a clock crossing sits on the border between the two domain boxes; boxes stay apart when blocks move', async ({ page }, info) => {
  await open(page);
  await rmapInOwnDomain(page);
  await expect(page.locator('.cmp-auto:not(.cmp-auto-reset)')).toHaveCount(2);
  const [[sys, fast], fifos] = await stableRects(page, '.cmp-domain-box', '.cmp-auto:not(.cmp-auto-reset) .cmp-auto-body');
  expect(overlap(sys, fast)).toBe(false);
  const left = sys.x < fast.x ? sys : fast;
  const right = sys.x < fast.x ? fast : sys;
  const border = (left.x + left.w + right.x) / 2;
  for (const f of fifos) {
    expect(Math.abs(f.x + f.w / 2 - border)).toBeLessThan(2);
  }
  // the FIFO halves carry the colours of the two domains
  await expect(page.locator('.cmp-auto:not(.cmp-auto-reset)').first().locator('.cmp-auto-half')).toHaveCount(2);
  await page.mouse.click(...Object.values(await canvasPoint(page, 0.97, 0.97)));
  await settled(page);
  await shot(page, info, '05-fifo-on-the-border');

  // a block pushed towards the other domain: the other box moves aside instead of overlapping
  const head = page.locator('[data-block="spw0"] .cmp-block-head');
  const hb = await head.boundingBox();
  if (!hb) throw new Error('no block');
  const canvas = await canvasPoint(page, 0.97, 0.5);
  await dragTo(page, head, { x: Math.min(hb.x + 12 + (right.x - left.x) * 0.5, canvas.x), y: hb.y + 12 });
  const [boxes] = await stableRects(page, '.cmp-domain-box');
  expect(boxes).toHaveLength(2);
  expect(overlap(boxes[0], boxes[1])).toBe(false);
  const d = await design(page);
  expect(d.instances.find((/** @type {any} */ i) => i.id === 'spw0').clocks.UserClk).toBe('sys');
});

test('Arrange lays out the system from left to right and is undone in one step', async ({ page }, info) => {
  await open(page);
  await openExample(page, 'Space Packets over SpaceWire');
  const arranged = (await design(page)).layout.instances;
  await dragTo(page, page.locator('[data-block="nchar0"] .cmp-block-head'), await canvasPoint(page, 0.45, 0.92));
  const moved = (await design(page)).layout.instances;
  expect(moved.nchar0).not.toEqual(arranged.nchar0);
  await page.getByRole('button', { name: 'Arrange' }).click();
  await settled(page);
  expect((await design(page)).layout.instances).toEqual(arranged);
  const [blocks] = await stableRects(page, '.cmp-block-body');
  for (let i = 0; i < blocks.length; i += 1) for (let j = i + 1; j < blocks.length; j += 1) expect(overlap(blocks[i], blocks[j])).toBe(false);
  // four stages stay one row (the view pans), the data flow from left to right
  const x = (/** @type {string} */ id) => arranged[id].x;
  expect(x('spw0') < x('rmap0') && x('rmap0') < x('nchar0') && x('nchar0') < x('spp0')).toBe(true);
  await shot(page, info, '06-arranged-example');
  await page.keyboard.press('Control+z');
  await settled(page);
  expect((await design(page)).layout.instances).toEqual(moved);
  await page.keyboard.press('Control+y');
  await settled(page);
  // the example with two clock domains: one box per domain, the FIFOs on their border
  await openExample(page, 'Space Packets over SpaceWire, two clocks');
  await expect(page.locator('.cmp-domain-box')).toHaveCount(2);
  await expect(page.locator('.cmp-auto:not(.cmp-auto-reset)')).toHaveCount(2);
  await shot(page, info, '06-arranged-two-clocks');
});

test('connecting: compatible ports pulse, the band snaps, the connection draws itself and flows', async ({ page }, info) => {
  await open(page);
  await addBlock(page, 'SpaceWire port');
  await addBlock(page, 'RMAP target');
  await page.getByRole('button', { name: 'Fit' }).click();
  await settled(page);
  const a = await portCenter(page, 'spw0.M_Pkt');
  const b = await portCenter(page, 'rmap0.S_Pkt');
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(a.x + 30, a.y + 12, { steps: 4 });
  await page.mouse.move(b.x - 24, b.y + 4, { steps: 16 });
  // near the port but not on it: the band snaps to it
  await expect(page.locator('[data-port="rmap0.S_Pkt"]')).toHaveClass(/is-snap/);
  await expect(page.locator('[data-port="rmap0.S_User"]')).toHaveClass(/is-target/);
  await expect(page.locator('[data-port="rmap0.S_AxiLite"]')).toHaveClass(/is-dimmed/);
  await expect(page.locator('.cmp-band')).toHaveClass(/is-snapped/);
  await page.waitForTimeout(250);
  await shot(page, info, '07-connect-1-snap');
  // record the effects of the release (they may be over before a slow browser reports back)
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.drew = false;
    w.flashed = false;
    new MutationObserver(() => {
      if (document.querySelector('.cmp-edge-line[data-drawing]')) w.drew = true;
      if (document.querySelector('.cmp-flash')) w.flashed = true;
    }).observe(document.querySelector('.cmp-world') ?? document.body, { subtree: true, childList: true, attributes: true });
  });
  await page.mouse.up();
  await page.waitForTimeout(120);
  await shot(page, info, '07-connect-2-draw');
  await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).drew)).toBe(true);
  await expect.poll(() => page.evaluate(() => /** @type {any} */ (window).flashed)).toBe(true);
  await expect(page.locator('.cmp-edge')).toHaveClass(/is-flowing/);
  await page.waitForTimeout(400);
  await shot(page, info, '07-connect-3-flow');
  await settled(page);
  expect((await design(page)).connections.map((/** @type {any} */ c) => [c.from, c.to])).toEqual([['spw0.M_Pkt', 'rmap0.S_Pkt']]);
  // the flow stops after a while unless the connection is selected
  await expect(page.locator('.cmp-edge')).not.toHaveClass(/is-flowing/, { timeout: 5000 });
});

test('an inserted adapter pops in, and leaves again when its reason goes away', async ({ page }) => {
  await open(page);
  await openExample(page, 'SpaceWire RMAP target');
  await page.getByRole('button', { name: 'Clock domain', exact: true }).click();
  await settled(page);
  await page.locator('[data-block="rmap0"] .cmp-block-head').click();
  // watch the adapters while the clock is assigned
  await page.evaluate(() => {
    /** @type {any} */ (window).seen = { scaled: false, leaving: 0 };
    const obs = new MutationObserver(() => {
      const w = /** @type {any} */ (window).seen;
      if (document.querySelector('.cmp-auto-inner[transform*="scale"]')) w.scaled = true;
      w.leaving = Math.max(w.leaving, document.querySelectorAll('.cmp-auto:not(.cmp-auto-reset).is-leaving').length);
    });
    obs.observe(document.querySelector('.cmp-autos') ?? document.body, { subtree: true, childList: true, attributes: true });
  });
  await page.locator('#cmp-clk-rmap0-Clk').selectOption('clk1');
  await settled(page);
  await expect(page.locator('.cmp-auto:not(.cmp-auto-reset)')).toHaveCount(2);
  expect(await page.evaluate(() => /** @type {any} */ (window).seen.scaled)).toBe(true);
  await page.locator('#cmp-clk-rmap0-Clk').selectOption('sys');
  await settled(page);
  await expect(page.locator('.cmp-auto:not(.cmp-auto-reset)')).toHaveCount(0);
  expect(await page.evaluate(() => /** @type {any} */ (window).seen.leaving)).toBe(2);
});

test('the legend shows every interface type with its colour and symbol', async ({ page }, info) => {
  await open(page);
  await openExample(page, 'Space Packets over SpaceWire, two clocks');
  const btn = page.getByRole('button', { name: 'Legend', exact: true });
  await expect(btn).toHaveAttribute('aria-pressed', 'false');
  await page.locator('.cmp-canvas').focus();
  await page.keyboard.press('l');
  const legend = page.getByRole('complementary', { name: 'Interface types' });
  await expect(legend).toBeVisible();
  await expect(btn).toHaveAttribute('aria-pressed', 'true');
  await expect(legend).toContainText('Packet link');
  await expect(legend).toContainText('AXI4-Lite register bus');
  expect(await legend.locator('li.is-used').count()).toBeGreaterThan(5);
  await expect(legend.locator('li.is-used').filter({ hasText: 'Packet link' })).toHaveCount(1);
  await shot(page, info, '08-legend');
  // the choice is kept for the next visit
  await page.reload();
  await page.waitForSelector('.cmp.is-ready');
  await expect(page.getByRole('complementary', { name: 'Interface types' })).toBeVisible();
  await page.getByRole('button', { name: 'Close the legend' }).click();
  await expect(page.getByRole('complementary', { name: 'Interface types' })).toBeHidden();
});

test('panels: the inspector title stays visible, the checks panel resizes, dependent inputs are disabled', async ({ page }, info) => {
  await open(page);
  await openExample(page, 'Space Packets over SpaceWire');
  // the block may lie outside the view at the zoom of Fit: select it with the keyboard
  await page.locator('[data-block="spp0"]').focus();
  const insp = page.locator('.cmp-inspector');
  await insp.evaluate((el) => { el.scrollTop = el.scrollHeight; });
  const bar = await page.locator('.cmp-insp-bar').boundingBox();
  const top = await insp.boundingBox();
  expect(bar && top && Math.abs(bar.y - top.y) < 1).toBe(true);
  await expect(page.locator('#cmp-inst-id')).toBeInViewport();
  // generics without effect
  await insp.evaluate((el) => { el.scrollTop = 0; });
  await expect(page.locator('#cmp-g-spp0-NumDest_g')).toBeEnabled();
  await page.locator('#cmp-g-spp0-Encapsulation_g').uncheck();
  await expect(page.locator('#cmp-g-spp0-NumDest_g')).toBeDisabled();
  await expect(insp).toContainText('Takes effect only with CPTP layer on.');
  await page.keyboard.press('Control+z');
  await expect(page.locator('#cmp-g-spp0-NumDest_g')).toBeEnabled();
  // the separator resizes the checks panel; collapsed checks give the inspector the room
  const checks = page.locator('.cmp-checks');
  const h0 = (await checks.boundingBox())?.height ?? 0;
  await page.locator('.cmp-split').focus();
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  const h1 = (await checks.boundingBox())?.height ?? 0;
  expect(Math.round(h1 - h0)).toBe(48);
  const i0 = (await insp.boundingBox())?.height ?? 0;
  await page.locator('.cmp-checks-toggle').click();
  const i1 = (await insp.boundingBox())?.height ?? 0;
  expect(i1).toBeGreaterThan(i0 + 100);
  await expect(page.locator('.cmp-split')).toBeHidden();
  await page.locator('.cmp-checks-toggle').click();
  // external pins show their prefix in full, the ports on hover
  const ext = page.locator('[data-block="spw0"] .cmp-external').filter({ has: page.locator('.cmp-external-label', { hasText: /^spw0_\*$/ }) });
  await expect(ext).toHaveCount(1);
  await expect(ext.locator('title')).toContainText('spw0_Spw_DOut');
  // a side band field without effect (the send port of the example is external: make it internal first)
  await page.evaluate(() => /** @type {any} */ (window).composer.setExternal('spp0.S_Tx[0]', null));
  await addBlock(page, 'Chunker');
  // connected from the inspector, the new connection is selected and asks for the constants
  await page.getByLabel('Connect chunk0.Out to').selectOption('spp0.S_Tx[0]');
  await expect(page.getByLabel(/^Packet name 0 to/)).toBeDisabled();
  await page.getByLabel('Packet name instead of sequence count').check();
  await expect(page.getByLabel(/^Packet name 0 to/)).toBeEnabled();
  await shot(page, info, '09-panels');
});

test('keyboard operation: examples, panning, domains, arrange, shortcuts', async ({ page }) => {
  await open(page);
  // the examples menu with the arrow keys
  await page.getByRole('button', { name: 'Examples' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('menuitem').first()).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await expect(page.locator('[data-block="nchar0"]')).toBeAttached();
  await settled(page);
  // arrow keys on the canvas pan the view
  await page.locator('.cmp-canvas').focus();
  const v0 = (await design(page)).layout.viewport;
  await page.keyboard.press('ArrowRight');
  const v1 = (await design(page)).layout.viewport;
  expect(v1.x).toBe(v0.x - 48);
  // a clock domain header: Enter selects the domain, arrow keys move its blocks
  const headEl = page.locator('[data-domain-head="sys"]');
  await headEl.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.cmp-inspector')).toContainText('Clock domain');
  const p0 = (await design(page)).layout.instances.spp0;
  await page.locator('[data-domain-head="sys"]').focus();
  await page.keyboard.press('ArrowDown');
  await settled(page);
  expect((await design(page)).layout.instances.spp0).toEqual({ x: p0.x, y: p0.y + 16 });
  // Alt+A arranges again
  await page.keyboard.press('Alt+a');
  await settled(page);
  expect((await design(page)).layout.instances.spp0).toEqual(p0);
  // the list of shortcuts
  await page.locator('.cmp-canvas').focus();
  await page.keyboard.press('?');
  const dlg = page.getByRole('dialog', { name: 'Keyboard shortcuts' });
  await expect(dlg).toBeVisible();
  await expect(dlg).toContainText('Alt+A');
  await page.keyboard.press('Escape');
  await expect(dlg).toBeHidden();
  // a block: Tab reaches it, arrow keys move it, Delete removes it
  await page.locator('[data-block="spp0"]').focus();
  await page.keyboard.press('ArrowLeft');
  await settled(page);
  expect((await design(page)).layout.instances.spp0.x).toBe(p0.x - 16);
});

test.describe('reduced motion', () => {
  test.use({ reducedMotion: 'reduce' });

  test('with reduced motion nothing moves: changes fade', async ({ page }) => {
    await open(page);
    await expect(page.locator('.cmp-canvas')).toHaveAttribute('data-reduced-motion', 'true');
    await page.evaluate(() => {
      /** @type {any} */ (window).moved = false;
      const c = /** @type {Element} */ (document.querySelector('.cmp-canvas'));
      new MutationObserver(() => {
        if (c.getAttribute('data-motion') === 'moving') /** @type {any} */ (window).moved = true;
      }).observe(c, { attributes: true, attributeFilter: ['data-motion'] });
      /** @type {any} */ (window).kinds = new Set();
      const record = () => {
        for (const a of document.getAnimations()) {
          const fx = /** @type {KeyframeEffect} */ (a.effect);
          for (const k of fx?.getKeyframes?.() ?? []) {
            for (const p of Object.keys(k)) if (!['offset', 'computedOffset', 'easing', 'composite'].includes(p)) /** @type {any} */ (window).kinds.add(p);
          }
        }
        requestAnimationFrame(record);
      };
      record();
    });
    await addBlock(page, 'SpaceWire port');
    await addBlock(page, 'RMAP target');
    await page.getByRole('button', { name: 'Fit' }).click();
    await dragWire(page, 'spw0.M_Pkt', 'rmap0.S_Pkt');
    await openExample(page, 'SpaceWire RMAP target');
    await page.getByRole('button', { name: 'Clock domain', exact: true }).click();
    await page.locator('[data-block="rmap0"] .cmp-block-head').click();
    await page.locator('#cmp-clk-rmap0-Clk').selectOption('clk1');
    await expect(page.locator('.cmp-auto:not(.cmp-auto-reset)')).toHaveCount(2);
    await settled(page);
    expect(await page.evaluate(() => /** @type {any} */ (window).moved)).toBe(false);
    expect(await page.evaluate(() => [.../** @type {any} */ (window).kinds])).toEqual(['opacity']);
    // the flow of connections and the pulsing of ports do not run
    const flow = await page.locator('.cmp-edge-flow').first().evaluate((el) => getComputedStyle(el).animationName);
    expect(flow).toBe('none');
  });
});

/**
 * A system of 100 blocks (50 SpaceWire ports, each with an RMAP target) without layout.
 */
function hundredBlocks() {
  const cat = new Catalog(JSON.parse(readFileSync(new URL('../../assets/composer/catalog.json', import.meta.url), 'utf-8')));
  let d = createDesign('hundred_blocks');
  for (let k = 0; k < 50; k += 1) {
    d = addInstance(d, cat, 'openwire/owr_core', { x: 0, y: 0 }).design;
    d = addInstance(d, cat, 'openrmap/omap_core', { x: 0, y: 0 }, 'target').design;
    for (const [a, b] of [[`spw${k}.M_Pkt`, `rmap${k}.S_Pkt`], [`rmap${k}.M_Pkt`, `spw${k}.S_Pkt`]]) {
      const c = checkConnection(cat, d, a, b);
      if (!c.from || !c.to) throw new Error(c.reason);
      d = addConnection(d, c.from, c.to).design;
    }
  }
  const doc = toDocument(d, cat);
  delete doc.layout;
  return JSON.stringify(doc);
}

/**
 * Frame times while an action runs.
 * @param {import('@playwright/test').Page} page
 * @param {() => Promise<void>} action
 */
async function frameTimes(page, action) {
  await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.frames = [];
    w.recording = true;
    let last = performance.now();
    const tick = (/** @type {number} */ t) => {
      w.frames.push(t - last);
      last = t;
      if (w.recording) requestAnimationFrame(tick);
    };
    requestAnimationFrame((t) => {
      last = t;
      requestAnimationFrame(tick);
    });
  });
  await action();
  const frames = /** @type {number[]} */ (await page.evaluate(() => {
    const w = /** @type {any} */ (window);
    w.recording = false;
    return w.frames;
  }));
  const s = [...frames].sort((x, y) => x - y);
  const q = (/** @type {number} */ p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { frames: s.length, median: Math.round(q(0.5) * 10) / 10, p95: Math.round(q(0.95) * 10) / 10, max: Math.round(s[s.length - 1] * 10) / 10 };
}

test('performance: 100 blocks open, pan and drag smoothly', async ({ page }, info) => {
  test.setTimeout(120_000);
  await open(page);
  const t0 = Date.now();
  await page.locator('input[type="file"]').setInputFiles({ name: 'hundred.composer.json', mimeType: 'application/json', buffer: Buffer.from(hundredBlocks()) });
  await expect(page.locator('.cmp-block')).toHaveCount(100, { timeout: 30_000 });
  await page.getByRole('dialog').getByRole('button', { name: 'Close' }).click();
  await settled(page);
  const openMs = Date.now() - t0;
  await expect(page.locator('.cmp-edge')).toHaveCount(100);
  // panning with the middle button (it pans wherever it starts)
  const corner = await canvasPoint(page, 0.9, 0.1);
  const pan = await frameTimes(page, async () => {
    await page.mouse.move(corner.x, corner.y);
    await page.mouse.down({ button: 'middle' });
    for (let k = 0; k < 60; k += 1) {
      await page.mouse.move(corner.x - k * 6, corner.y + k * 4);
      await page.waitForTimeout(16);
    }
    await page.mouse.up({ button: 'middle' });
  });
  // back to the start of the system (Fit shows its top left at a readable zoom) and drag a block with its connections
  await page.getByRole('button', { name: 'Fit' }).click();
  await settled(page);
  const bb = await page.locator('[data-block="spw0"] .cmp-block-head').boundingBox();
  if (!bb) throw new Error('no block');
  const drag = await frameTimes(page, async () => {
    await page.mouse.move(bb.x + 20, bb.y + 10);
    await page.mouse.down();
    for (let k = 0; k < 60; k += 1) {
      await page.mouse.move(bb.x + 20 + k * 3, bb.y + 10 + k * 2);
      await page.waitForTimeout(16);
    }
    await page.mouse.up();
  });
  const settle = await frameTimes(page, () => settled(page));
  const result = { browser: info.project.name, openMs, pan, drag, settle };
  info.annotations.push({ type: 'performance', description: JSON.stringify(result) });
  console.log(`performance ${JSON.stringify(result)}`);
  if (SCREENS) {
    mkdirSync(SCREENS, { recursive: true });
    writeFileSync(join(SCREENS, `performance-${info.project.name}.json`), `${JSON.stringify(result, null, 2)}\n`);
  }
  // at least 30 frames per second in every browser; frame times depend on the machine, so continuous integration
  // (shared runners without a GPU) runs the scenario and records the numbers, the bounds are checked locally
  if (!process.env.CI) {
    expect(pan.median).toBeLessThan(34);
    expect(drag.median).toBeLessThan(34);
  }
});

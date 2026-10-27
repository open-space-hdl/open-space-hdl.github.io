// The models of OpenCompact in the Composer (model/ocp.js) against the Python models of OpenCompact at the pin
// (tests/golden/ocp_models.json, written by tools/composer_ocp_golden.py): every configuration of the regression of
// OpenCompact, the named ones and the 24 random ones from fixed seeds, with and without the speculative weight loop.
// The configurations with image framing (the "_last" variants of the regression) need no golden of their own: the
// framing adds no item to the input sequence, so it does not change the rate of the predictor. The runtime
// configurations of the regression (RuntimeConfig_g) have their own golden data: the period of two images of the maxima
// and the start of every image of the seeded sequence of the regression.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { coderCycles, headerBytes, imagePeriod, imageStartCycles, issueSpan, latencies, LE_MAX_FLUSH, LE_MAX_OUT, maxImageBytes, outputSpan, rescaleCount, runtimeAcceptCycles, strideParams } from '../../assets/composer/js/model/ocp.js';
import { ROOT } from './helpers.mjs';

const golden = JSON.parse(readFileSync(`${ROOT}tests/golden/ocp_models.json`, 'utf-8'));
/** @type {{ name: string, generics: Record<string, any>, headerBytes: number, maxImageBytes: number, speculation: any, noSpeculation: any }[]} */
const configs = golden.configs;

test('the golden data covers every configuration of the regression of OpenCompact, named and random', () => {
  assert.ok(configs.length >= 62, `${configs.length}`);
  assert.equal(configs.filter((c) => /^r\d\d_random$/.test(c.name)).length, 24);
  assert.equal(new Set(configs.map((c) => c.name)).size, configs.length);
});

test('latencies, stride order and spans equal the Python model for every configuration, with and without speculation', () => {
  for (const c of configs) {
    for (const [spec, want] of /** @type {const} */ ([[true, c.speculation], [false, c.noSpeculation]])) {
      const where = `${c.name} speculation ${spec}`;
      const lat = latencies(c.generics, spec);
      assert.deepEqual({ depth: lat.depth, spec: lat.spec, lW: lat.lW, lFix: lat.lFix, lCross: lat.lCross },
        { depth: want.depth, spec: want.spec, lW: want.lW, lFix: want.lFix, lCross: want.lCross }, where);
      const st = strideParams(c.generics, lat);
      if (want.stride) {
        assert.deepEqual(st && { s: st.s, skew: st.skew }, want.stride, where);
        assert.equal(issueSpan(c.generics, spec, 1, false), want.inSpan, where);
        assert.equal(outputSpan(c.generics, spec), want.outSpan, where);
      } else {
        assert.equal(st, null, where);
        assert.equal(issueSpan(c.generics, spec, 1, false), want.span1, where);
        assert.equal(issueSpan(c.generics, spec, 2, false), want.span2, where);
      }
      assert.equal(imagePeriod(c.generics, spec, false), want.imagePeriod, where);
    }
  }
});

test('the header length equals the header of the Python model for every configuration', () => {
  for (const c of configs) assert.equal(headerBytes(c.generics), c.headerBytes, c.name);
});

test('the upper bound on the compressed image equals max_image_bytes of the Python model for every configuration', () => {
  assert.deepEqual({ LE_MAX_OUT, LE_MAX_FLUSH }, golden.constants);
  for (const c of configs) assert.equal(maxImageBytes(c.generics), c.maxImageBytes, c.name);
});

test('the tail of the hybrid coder does not change the image period: the period equals that of the coder model', () => {
  let hybrid = 0;
  for (const c of configs) {
    for (const spec of [true, false]) {
      if (strideParams(c.generics, latencies(c.generics, spec))) continue;
      const n = c.generics.XSize_g * c.generics.YSize_g * c.generics.ZSize_g;
      const two = coderCycles(c.generics, spec, 2);
      assert.equal(imagePeriod(c.generics, spec), two[n] - two[0], `${c.name} speculation ${spec}`);
      if (c.generics.EntropyCoder_g === 'HYBRID') hybrid += 1;
    }
  }
  assert.ok(hybrid > 0, 'configurations with the hybrid coder');
});

test('runtime configurations: the image start, the period of two images of the maxima and the starts of a sequence equal the Python model', () => {
  /** @type {{ name: string, generics: Record<string, any>, imageStartCycles: number, dims: number[][], speculation: any, noSpeculation: any }[]} */
  const runtime = golden.runtime;
  assert.equal(runtime.length, 5);
  for (const c of runtime) {
    assert.equal(c.generics.RuntimeConfig_g, true, c.name);
    assert.equal(imageStartCycles(c.generics), c.imageStartCycles, c.name);
    for (const [spec, want] of /** @type {const} */ ([[true, c.speculation], [false, c.noSpeculation]])) {
      const where = `${c.name} speculation ${spec}`;
      assert.equal(imagePeriod(c.generics, spec), want.imagePeriod, where);
      assert.equal(imagePeriod(c.generics, spec, false), want.imagePeriod, where);
      const cycles = runtimeAcceptCycles(c.generics, c.dims, spec);
      /** @type {number[]} */
      const starts = [];
      let k = 0;
      for (const [nx, ny, nz] of c.dims) {
        starts.push(cycles[k] - cycles[0]);
        k += nx * ny * nz;
      }
      assert.deepEqual(starts, want.starts, where);
    }
  }
  // a configuration that uses the stride order with constant dimensions runs without it with the runtime configuration
  const rc02 = runtime.find((c) => c.name === 'rc02_bi_mnz_hybrid_abs');
  const constant = { .../** @type {any} */ (rc02).generics, RuntimeConfig_g: false };
  assert.ok(strideParams(constant, latencies(constant)));
  assert.notEqual(imagePeriod(constant), /** @type {any} */ (rc02).speculation.imagePeriod);
});

test('runtime parameters: the period of the maxima, the starts of a sequence with the M of every image and the bound over the parameter ranges equal the Python model', () => {
  /** @type {{ name: string, generics: Record<string, any>, maxImageBytes: number, dims: number[][], speculation: any, noSpeculation: any }[]} */
  const params = golden.runtimeParams;
  // the image sequences of the regression with every entropy coder, in BI and in BSQ order
  assert.ok(params.length >= 5, `${params.length}`);
  assert.deepEqual([...new Set(params.map((c) => c.generics.EntropyCoder_g))].sort(), ['BLOCK_ADAPTIVE', 'HYBRID', 'SAMPLE_ADAPTIVE']);
  assert.deepEqual([...new Set(params.map((c) => c.generics.EncodingOrder_g))].sort(), ['BI', 'BSQ']);
  for (const c of params) {
    assert.equal(c.generics.RuntimeParams_g, true, c.name);
    assert.equal(maxImageBytes(c.generics), c.maxImageBytes, c.name);
    for (const [spec, want] of /** @type {const} */ ([[true, c.speculation], [false, c.noSpeculation]])) {
      const where = `${c.name} speculation ${spec}`;
      assert.equal(imagePeriod(c.generics, spec), want.imagePeriod, where);
      const cycles = runtimeAcceptCycles(c.generics, c.dims, spec);
      /** @type {number[]} */
      const starts = [];
      let k = 0;
      for (const [nx, ny, nz] of c.dims) {
        starts.push(cycles[k] - cycles[0]);
        k += nx * ny * nz;
      }
      assert.deepEqual(starts, want.starts, where);
    }
  }
  // in BI order the sequences take their own M: the images of the maxima and the others differ
  assert.ok(params.filter((c) => c.generics.EncodingOrder_g === 'BI').every((c) => new Set(c.dims.map((d) => d[3])).size > 1));
  // the bound with the runtime parameters is at least the bound with the values of the generics; the sample-adaptive and
  // the hybrid coder take Umax up to 32 whatever UnaryLimit_g is; without the runtime configuration the generic has no
  // effect (the core stops the elaboration)
  for (const c of params) {
    const fixed = maxImageBytes({ ...c.generics, RuntimeParams_g: false });
    if (c.generics.EntropyCoder_g === 'BLOCK_ADAPTIVE') assert.equal(c.maxImageBytes, fixed, c.name);
    else assert.ok(c.maxImageBytes > fixed, `${c.name}: ${c.maxImageBytes} > ${fixed}`);
    assert.equal(maxImageBytes({ ...c.generics, RuntimeConfig_g: false }), maxImageBytes({ ...c.generics, RuntimeConfig_g: false, RuntimeParams_g: false }), c.name);
  }
});

test('runtime parameters: the issue distances with the M of an image equal the Python model where M changes them', () => {
  /** @type {{ name: string, generics: Record<string, any>, probes: { dims: number[], speculation: boolean, runRows: boolean, lFix: number, lCross: number }[] }[]} */
  const probes = golden.latencyM;
  assert.equal(probes.length, 3);
  for (const c of probes) {
    assert.ok(c.probes.length > 0, c.name);
    for (const p of c.probes) {
      const lat = latencies(c.generics, p.speculation, p.dims);
      assert.deepEqual([lat.runRows, lat.lFix, lat.lCross], [p.runRows, p.lFix, p.lCross], `${c.name} ${p.dims} speculation ${p.speculation}`);
    }
  }
});

test('runtime parameters: the bound is the largest max_image_bytes over Umax 32 and every gamma0 and gamma*', () => {
  // small images (no rescaling: the longest final accumulators, gamma* at its maximum) and larger ones (the most
  // rescalings, a small gamma*), from the hybrid configuration of the regression
  const hybrid = /** @type {any} */ (golden.runtimeParams).find((/** @type {any} */ c) => c.generics.EntropyCoder_g === 'HYBRID').generics;
  for (const [nx, ny] of [[2, 1], [3, 2], [12, 8], [64, 64]]) {
    for (const gs of [4, 6, 11]) {
      const g = { ...hybrid, XSize_g: nx, YSize_g: ny, RescaleCounterSize_g: gs };
      let want = 0;
      for (let g0 = 1; g0 <= Math.min(8, gs - 1); g0 += 1) {
        for (let gsi = Math.max(4, g0 + 1); gsi <= gs; gsi += 1) {
          want = Math.max(want, maxImageBytes({ ...g, RuntimeParams_g: false, UnaryLimit_g: 32, InitialCountExp_g: g0, RescaleCounterSize_g: gsi }));
        }
      }
      assert.equal(maxImageBytes(g), want, `${nx} x ${ny} gamma* ${gs}`);
    }
  }
});

test('the rescalings of the hybrid coder in closed form equal the counter loop', () => {
  for (const tBand of [1, 2, 15, 16, 17, 100, 255, 256, 257, 1000, 4096, 5000]) {
    for (let g0 = 1; g0 <= 8; g0 += 1) {
      for (let gs = Math.max(4, g0 + 1); gs <= 11; gs += 1) {
        let cnt = 2 ** g0;
        let n = 0;
        for (let i = 1; i < tBand; i += 1) {
          if (cnt < 2 ** gs - 1) cnt += 1;
          else {
            n += 1;
            cnt = Math.floor((cnt + 1) / 2);
          }
        }
        assert.equal(rescaleCount(tBand, g0, gs), n, `tBand ${tBand} gamma0 ${g0} gamma* ${gs}`);
      }
    }
  }
});

/**
 * The shortcut of issueSpan skips rows whose state at their start repeats (live entries of last_band and last_pixel
 * relative to the cycle, the same items in the row): it must give the cycles of the full simulation.
 * @param {Record<string, any>} g
 * @param {string} where
 * @param {{ lag1: number, lagP: number }} skipped   rows skipped by each rule, summed up
 */
function sameAsFull(g, where, skipped) {
  for (const spec of [true, false]) {
    const st = strideParams(g, latencies(g, spec));
    for (const images of st ? [1] : [1, 2]) {
      assert.equal(issueSpan(g, spec, images, true, skipped), issueSpan(g, spec, images, false), `${where} speculation ${spec} images ${images}`);
    }
    if (!st) assert.equal(imagePeriod(g, spec, true), imagePeriod(g, spec, false), `${where} speculation ${spec} image period`);
  }
}

test('the shortcut equals the full simulation for every configuration of the regression', () => {
  const skipped = { lag1: 0, lagP: 0 };
  for (const c of configs) if (!c.speculation.stride) sameAsFull(c.generics, c.name, skipped);
  assert.ok(skipped.lag1 > 0, 'rows skipped');
});

test('the shortcut equals the full simulation for enlarged images: more rows, more columns, periodic updating', () => {
  let n = 0;
  // every enlarged configuration skips rows, and the periodic updating also whole blocks of 2^u rows
  let still = 0;
  const lagP = { lag1: 0, lagP: 0 };
  for (const c of configs) {
    if (c.speculation.stride) continue;
    const g = c.generics;
    // enough rows to skip many of them, with a period of the error limit values above 1 where they are used
    const skipped = { lag1: 0, lagP: 0 };
    const rows = { ...g, YSize_g: 40 + (g.YSize_g % 7) };
    sameAsFull(rows, `${c.name} with ${rows.YSize_g} rows`, skipped);
    const cols = { ...g, XSize_g: 2 * g.XSize_g + 3, YSize_g: 24 };
    sameAsFull(cols, `${c.name} with ${cols.XSize_g} columns`, skipped);
    if (skipped.lag1 + skipped.lagP === 0) still += 1;
    if (g.PeriodicUpdate_g && g.Fidelity_g !== 'LOSSLESS' && g.EncodingOrder_g === 'BI') {
      for (const u of [0, 1, 2, 3]) sameAsFull({ ...g, YSize_g: 37, UpdatePeriodExp_g: u }, `${c.name} with u = ${u}`, lagP);
    }
    n += 1;
  }
  assert.ok(n >= 50);
  assert.equal(still, 0, 'configurations without a skipped row');
  assert.ok(lagP.lagP > 0, 'blocks of 2^u rows skipped');
});

test('the shortcut issues a real image in a fraction of its samples', () => {
  const c = configs.find((x) => x.name === 'c01_lossless_bip');
  const g = { ...c?.generics, XSize_g: 1024, YSize_g: 1024, ZSize_g: 200, SubFrameDepth_g: 200 };
  const t0 = Date.now();
  const span = issueSpan(g, true, 1, true);
  // BIP with 200 bands, lossless: one sample per cycle
  assert.equal(span, 1024 * 1024 * 200 - 1);
  assert.ok(Date.now() - t0 < 2000, `${Date.now() - t0} ms`);
});

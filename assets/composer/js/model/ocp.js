// @ts-check
/**
 * Models of the OpenCompact compressor ocp_core (CCSDS 123.0-B-2) that the catalog cannot state as expressions (pure,
 * no DOM):
 *
 *   predictor   the cycles in which the predictor takes the samples of an image: a port of tools/ocp_throughput.py of
 *               OpenCompact, one to one. The testbenches of OpenCompact check that the RTL issues the samples of a
 *               configuration in exactly the cycles of that model. With the hybrid coder the tail of an image holds back
 *               the next image through the output FIFO of the predictor (coderCycles, coder_cycles()).
 *   period      the cycles between the first samples of consecutive images (image_period() of tools/ocp_throughput.py,
 *               checked exactly by TC-CO-50 of OpenCompact); with the runtime configuration (RuntimeConfig_g) those of
 *               two images of the maxima (runtime_accept_cycles(), checked by TC-CO-53).
 *   header      the length of the header of the compressed image: the length of what tools/ocp_model.py header() of
 *               OpenCompact writes for the generics of a configuration.
 *   bound       the upper bound on the length of the compressed image (max_image_bytes() of tools/ocp_model.py, checked
 *               against every compressed image of the regression by TC-CO-51 of OpenCompact).
 *
 * tests/golden/ocp_models.json holds the results of the Python models for every configuration of the regression of
 * OpenCompact at the pinned commit (tools/composer_ocp_golden.py), and tests/unit/ocp.test.mjs compares the port with
 * them.
 *
 * The Python model issues the samples one by one. A real image (1024 x 1024 x 200 samples) needs a shortcut, which
 * the full simulation (fast = false) does not take: see issueSpan.
 */

import { literalBits } from './rules.js';

/**
 * The elements of an integer_vector generic: "(0 => 4)", "(2, 3, 4)" or the Python form "2,3,4".
 * @param {unknown} v
 * @returns {number[]}
 */
export function intVector(v) {
  if (typeof v === 'number') return [v];
  const text = String(v ?? '').trim().replace(/^\(/, '').replace(/\)$/, '');
  if (text.includes('=>')) return [Number(text.slice(text.indexOf('=>') + 2).trim())];
  return text.split(',').map((x) => Number(x.trim()));
}

/** @param {number} n */
function treeStages(n) {
  let stages = 1;
  let reach = 4;
  while (reach < n) {
    reach *= 4;
    stages += 1;
  }
  return stages;
}

/** @param {number} a @param {number} b */
function gcd(a, b) {
  while (b) [a, b] = [b, a % b];
  return a;
}

/** @param {number} x the smallest power of two that is at least x */
function pow2AtLeast(x) {
  let p = 1;
  while (p < x) p *= 2;
  return p;
}

/**
 * Sample representatives equal the samples: lossless compression without damping (CCSDS 4.9.2).
 * @param {Record<string, any>} g
 */
function repEqualsSample(g) {
  const damping = intVector(g.Damping_g);
  return g.Fidelity_g === 'LOSSLESS' && (g.SampleRepResolution_g === 0 || !damping.some((v) => v !== 0));
}

/** @param {Record<string, any>} g */
function narrowSums(g) {
  return g.LocalSum_g === 'NARROW_NEIGHBOR' || g.LocalSum_g === 'NARROW_COLUMN';
}

/**
 * @typedef {object} Latencies
 * @property {Record<string, number>} stages   pipeline stages of the predictor
 * @property {number} depth
 * @property {boolean} spec      speculative weight loop
 * @property {boolean} runRows   consecutive samples of a band (BSQ order or one band)
 * @property {number} c          local differences
 * @property {boolean} narrow
 * @property {number} lW         issue distance of the weight loop
 * @property {number} lFix       issue distance of the window and the sample representatives of a band
 * @property {number} lCross     issue distance to the previous band at the same pixel
 */

/**
 * Issue conditions that depend on the image dimensions (issue_dist(), function issueDist of ocp_pkg).
 * @param {boolean} bsq @param {number} sfd @param {number} nx @param {number} ny @param {number} nz
 * @param {number} p @param {boolean} repIsSample @param {boolean} wUsed @param {boolean} crossRep
 * @param {number} lWin @param {number} lRep @param {number} lDw
 */
function issueDist(bsq, sfd, nx, ny, nz, p, repIsSample, wUsed, crossRep, lWin, lRep, lDw) {
  const m = Math.min(sfd, nz);
  const gap1 = bsq || m === 1;
  const runRows = bsq || nz === 1;
  const rowGap = bsq ? nx - 1 : (nx - 1) * m;
  const diffGap = bsq ? nx * ny : rowGap + 1;
  const sameRep = !repIsSample && (wUsed || rowGap < lRep);
  const crossDw = p > 0 && (bsq || m < nz) && diffGap < lDw;
  const lFix = Math.max(gap1 ? 0 : lWin, sameRep ? lRep : 0);
  const lCross = Math.max(crossRep ? lRep : 0, crossDw ? lDw : 0);
  return { runRows, lFix, lCross };
}

/**
 * Pipeline stages and required issue distances (cycles) for the generics of a configuration (latencies()). With dims
 * = [nx, ny, nz] the generics are the maxima of a runtime configuration: the structure (speculation, memories) follows
 * the maxima, the issue distances the dimensions of the image.
 * @param {Record<string, any>} g
 * @param {boolean} [speculation]
 * @param {number[] | null} [dims]
 * @returns {Latencies}
 */
export function latencies(g, speculation = true, dims = null) {
  const d = g.DynamicRange_g;
  const nx = g.XSize_g;
  const ny = g.YSize_g;
  const nz = g.ZSize_g;
  const bsq = g.EncodingOrder_g === 'BSQ';
  const m = Math.min(g.SubFrameDepth_g, nz);
  const p = g.PredictionBands_g;
  const full = g.PredictionMode_g === 'FULL';
  const narrow = narrowSums(g);
  const fid = g.Fidelity_g;
  const lossless = fid === 'LOSSLESS';
  const repIsSample = repEqualsSample(g);
  const c = p + 3 * (full ? 1 : 0);
  const c1 = Math.max(c, 1);
  const qw = Math.max(d, 16) + 2;
  const wUsed = full || !narrow;
  const gap1 = bsq || m === 1;
  let runRows = bsq || nz === 1;
  const ts = treeStages(c1 + 1);
  const threshSign = fid !== 'RELATIVE' && fid !== 'ABSOLUTE_RELATIVE';
  const spec = speculation && threshSign && gap1 && c > 0 && ts === 1 && (repIsSample || !wUsed);

  /** @type {Record<string, number>} */
  const st = { ram: 2, diff: 3, inc: 4, prod: 5 };
  st.tree = st.prod + ts;
  st.sgn = st.tree + 1;
  st.pred_b = st.sgn + 1;
  st.quant = st.pred_b + 1;
  st.limit = st.quant + 1;
  st.upd = (threshSign ? st.sgn : st.limit) + 1;
  st.rep = st.limit + (lossless ? 0 : qw) + 1;
  st.rep_mul = st.rep + 1;
  st.rep_sum = st.rep_mul + 1;
  st.out = Math.max(st.rep_sum, st.upd);
  st.dz = repIsSample ? st.diff : st.rep_sum;

  const lW = c > 0 ? st.upd - 1 : 0;
  const lWin = gap1 ? 0 : st.ram + 2;
  const lRep = st.rep_sum + 2;
  const rowGap = (nx - 1) * (bsq ? 1 : m);
  const sameRep = !repIsSample && (wUsed || rowGap < lRep);
  let lFix = Math.max(lWin, sameRep ? lRep : 0);
  const diffRam = p > 0 && (bsq || m < nz);
  const lDw = st.dz + 2;
  const diffGap = bsq ? nx * ny : (nx - 1) * m + 1;
  const crossRep = !repIsSample && (p > 0 || narrow);
  const crossDw = diffRam && diffGap < lDw;
  let lCross = Math.max(crossRep ? lRep : 0, crossDw ? lDw : 0);
  if (dims) {
    const rt = issueDist(bsq, g.SubFrameDepth_g, dims[0], dims[1], dims[2], p, repIsSample, wUsed, crossRep, st.ram + 2,
      lRep, lDw);
    ({ runRows, lFix, lCross } = rt);
  }
  return { stages: st, depth: st.out + 1, spec, runRows, c, narrow, lW, lFix, lCross };
}

/**
 * Clock cycles of the image-start sequencer of the runtime configuration from Start to Done (image_start_cycles(),
 * imageStartCycles of ocp_pkg): w + 3 with 2^w > max(l_rep, l_dw).
 * @param {Record<string, any>} g
 */
export function imageStartCycles(g) {
  const st = latencies(g).stages;
  const lMax = Math.max(st.rep_sum + 2, st.dz + 2);
  let w = 1;
  while (2 ** w <= lMax) w += 1;
  return w + 3;
}

/**
 * Stride order of BI order with M = NZ in near-lossless compression (or lossless compression with damping) with
 * dependencies between the bands of a pixel: sample (z, t) in slot t M + z S with S >= L_cross coprime with M; null
 * when not used (stride_params(); the core has no Stride_g, it uses the stride order wherever it applies).
 * @param {Record<string, any>} g
 * @param {Latencies} lat
 * @returns {{ s: number, m: number, skew: number } | null}
 */
export function strideParams(g, lat) {
  const nz = g.ZSize_g;
  const m = Math.min(g.SubFrameDepth_g, nz);
  const crossRep = !repEqualsSample(g) && (g.PredictionBands_g > 0 || narrowSums(g));
  const periodic = g.PeriodicUpdate_g === true && g.Fidelity_g !== 'LOSSLESS';
  if (!(g.EncodingOrder_g === 'BI' && m === nz && nz > 1 && crossRep && !periodic)) return null;
  let s = Math.max(lat.lCross, 2);
  while (gcd(s, m) !== 1) s += 1;
  return { s, m, skew: (m - 1) * (s - 1) };
}

/**
 * Cycles between the first and the last sample at the input and between the first and the last item at the output of
 * one image in stride order (stride_spans()).
 * @param {Record<string, any>} g
 * @param {Latencies} lat
 * @param {{ s: number, m: number, skew: number }} st
 * @returns {[number, number]}
 */
export function strideSpans(g, lat, st) {
  const c = strideCycles(g, lat, st);
  return [c.inLast - c.inFirst, c.outLast - c.outFirst];
}

/**
 * Cycle-accurate model of the stride order of one image (stride_cycles()): the input buffer accepts a sample per
 * cycle while it has room for the unprocessed samples; the slots advance one per cycle, a sample is issued once it has
 * arrived, the samples it depends on have left the feedback loops and the output buffer has room; the output buffer
 * is read in the input order once a sample is finished. The cycles of the first and the last sample accepted at the
 * input and of the first and the last item read from the output buffer.
 * @param {Record<string, any>} g
 * @param {Latencies} lat
 * @param {{ s: number, m: number, skew: number }} st
 * @returns {{ inFirst: number, inLast: number, outFirst: number, outLast: number }}
 */
export function strideCycles(g, lat, st) {
  const { m, s } = st;
  const nx = g.XSize_g;
  const npix = nx * g.YSize_g;
  const narr = npix * m;
  let sinv = 1;
  while ((s * sinv) % m !== 1) sinv += 1;
  const depth = lat.depth;
  const out = lat.stages.out;
  const inDepth = pow2AtLeast(st.skew + m + 8);
  const outDepth = pow2AtLeast(st.skew + 2 * depth + 16);
  const lastSlot = (npix - 1) * m + (m - 1) * s;
  let arr = 0;
  let lowA = 0;
  let n = 0;
  let oa = 0;
  let oSlot = 0;
  let oZ = 0;
  /** @type {number | null} */
  let doneSlot = null;
  /** @type {Map<number, number>} */
  const writes = new Map();
  const lastBand = new Float64Array(m).fill(-Infinity);
  const lastPixel = new Float64Array(m * nx).fill(-Infinity);
  let inFirst = -1;
  let inLast = -1;
  let outFirst = -1;
  let outLast = -1;
  let cyc = 0;
  let pdone = false;
  while (oa < narr) {
    // registered state of this cycle: arr, lowA, n, oa, doneSlot
    let arrNext = arr;
    if (arr < narr && arr - lowA < inDepth) {
      if (inFirst < 0) inFirst = cyc;
      inLast = cyc;
      arrNext = arr + 1;
    }
    /** @type {number | null} */
    let doneNow = null;
    if (writes.has(cyc)) {
      doneNow = /** @type {number} */ (writes.get(cyc));
      writes.delete(cyc);
    }
    if (!pdone) {
      const z = (n * sinv) % m;
      const t = Math.floor((n - z * s) / m);
      let advance = t < 0 || t >= npix;
      if (!advance) {
        const y = Math.floor(t / nx);
        const x = t % nx;
        const a = t * m + z;
        const needW = lat.c > 0 && t > 1;
        const lSame = Math.max(lat.lFix, needW ? lat.lW : 0);
        let ok = a < arr && n - oa < outDepth - depth - 8;
        if (cyc < lastBand[z] + lSame) ok = false;
        if (lat.lCross && z > 0) {
          if (cyc < lastPixel[(z - 1) * nx + x] + lat.lCross) ok = false;
          if (lat.narrow && y === 0 && x > 0 && cyc < lastPixel[(z - 1) * nx + x - 1] + lat.lCross) ok = false;
        }
        if (ok) {
          advance = true;
          lastBand[z] = cyc;
          lastPixel[z * nx + x] = cyc;
          // finished (written to the output buffer) at the end of cycle + out + 1
          writes.set(cyc + out + 2, n);
          if (z === m - 1) lowA += m;
          if (n === lastSlot) pdone = true;
        }
      }
      if (advance && !pdone) n += 1;
    }
    // reader: next input index once its slot is finished
    if (doneNow !== null) doneSlot = doneNow;
    if (oa < narr && doneSlot !== null && oSlot <= doneSlot) {
      if (outFirst < 0) outFirst = cyc;
      outLast = cyc;
      oa += 1;
      if (oZ === m - 1) {
        oZ = 0;
        oSlot -= (m - 1) * s - m;
      } else {
        oZ += 1;
        oSlot += s;
      }
    }
    arr = arrNext;
    cyc += 1;
  }
  return { inFirst, inLast, outFirst, outLast };
}

/**
 * Error limit values per frame of the input sequence (items()): with periodic updating in near-lossless compression in
 * BI order, at every frame y with y mod 2^u = 0.
 * @param {Record<string, any>} g
 */
function limitItems(g) {
  if (g.EncodingOrder_g === 'BSQ' || !g.PeriodicUpdate_g || g.Fidelity_g === 'LOSSLESS') return 0;
  const nz = g.ZSize_g;
  let n = 0;
  if (g.Fidelity_g === 'ABSOLUTE' || g.Fidelity_g === 'ABSOLUTE_RELATIVE') n += g.AbsBandDependent_g ? nz : 1;
  if (g.Fidelity_g === 'RELATIVE' || g.Fidelity_g === 'ABSOLUTE_RELATIVE') n += g.RelBandDependent_g ? nz : 1;
  return n;
}

/** Items the simulation may issue before it gives up on an image without a repeating row. */
export const ITEM_LIMIT = 50_000_000;

/**
 * Cycles between the acceptance of the first and of the last sample of a number of consecutive images without back
 * pressure (issue_span(), outside the stride order issue_cycles()).
 *
 * The Python model issues every item: a sample at the earliest cycle after the previous item at which the samples it
 * depends on have left the feedback loops, an error limit value in the next cycle. A sample depends on the last
 * sample of its band (last_band[z], distance l_same <= max(l_fix, l_w)) and on the last samples of the previous band
 * at its column and, in row 0 with narrow local sums, at the column before (last_pixel[z - 1][x], distance l_cross).
 *
 * Shortcut (fast = true), exact by the following argument. Call an entry v of last_band or last_pixel live at a row
 * start (cycle c of the last item before the row) when v + L > c + 1, with L its largest distance (max(l_fix, l_w),
 * l_cross): only a live entry can delay a later item, whose cycle is at least c + 1. The state of a row start is the
 * list of c - v of the live entries; an entry that is not live counts as absent. Every rule of the model is invariant
 * under a shift of all cycles, so two row starts with equal state, followed by the same items, issue them at cycles
 * that differ by the same constant. The items of a row are the same in every row y >= 2 of an image (rows 0 and 1
 * differ: the sample index t > 1 of the weight loop, the narrow local sums of row 0), except that error limit values
 * precede the rows y with y mod 2^u = 0 (periodic updating). Hence:
 *
 *   lag 1   two consecutive rows y - 1, y >= 3 with the same items and equal states at their starts: every following
 *           row with the same items repeats row y - 1, shifted by D = c(y) - c(y - 1). All of them are skipped.
 *   lag P   with error limit values (P = 2^u > 1): two rows y - P >= 2 and y with limit values and equal states: every
 *           following block of P rows repeats rows y - P to y - 1, shifted by D = c(y) - c(y - P). All whole blocks
 *           before the end of the image are skipped.
 *
 * Skipping adds the shift to the cycle counter, to the cycle of the last sample and to every entry. In BSQ order the
 * rows are those of a band. tests/unit/ocp.test.mjs checks that the shortcut equals the full simulation for every
 * configuration of the regression and for enlarged images.
 * @param {Record<string, any>} g
 * @param {boolean} [speculation]
 * @param {number} [images]
 * @param {boolean} [fast]
 * @param {{ lag1: number, lagP: number }} [skipped]   rows skipped by each rule (for the tests)
 */
export function issueSpan(g, speculation = true, images = 1, fast = true, skipped) {
  const lat = latencies(g, speculation);
  const st = strideParams(g, lat);
  if (st) {
    if (images !== 1) throw new Error('the stride order is modelled for one image');
    return strideSpans(g, lat, st)[0];
  }
  // with the hybrid coder the tail of an image can hold back the next image (issue_cycles())
  if (images > 1 && g.EntropyCoder_g === 'HYBRID') {
    const c = coderCycles(g, speculation, images);
    return c[c.length - 1] - c[0];
  }
  const r = issueCycles(g, lat, images, fast, skipped);
  return r.last - r.firsts[0];
}

/**
 * Cycles between the acceptance of the first samples of two consecutive images, back to back, without back pressure
 * at the input and the output (image_period()). Outside stride order the issue cycles of two images give it. In stride
 * order the next image starts once all slots of the image have passed and its last item has been read from the output
 * buffer: the read takes two cycles, and the input buffer accepts the first sample of the next image one cycle after
 * the start, four cycles after the read of the last item.
 *
 * The tail of the hybrid coder does not change the period: it starts after the last item of an image has reached the
 * coder, after the first sample of the next image was issued, and the predictor issues no item between the last sample
 * of an image and the first of the next, so the output FIFO cannot hold the first sample back (coder_cycles() gives the
 * same period; tests/unit/ocp.test.mjs compares both for every configuration of the regression).
 *
 * With the runtime configuration (RuntimeConfig_g, the generics are the maxima) the period of two images of the maxima
 * (runtime_accept_cycles()): the first sample of the second image is accepted in the cycle after the last sample of
 * the first was issued, and the first sample of an image is issued imageStartCycles + 1 cycles after its acceptance;
 * the predictor does not use the stride order. Between those, the samples of the first image are issued as in
 * issueCycles, without the hybrid tail (it follows the image): imageStartCycles + 1 + span + 1.
 * @param {Record<string, any>} g
 * @param {boolean} [speculation]
 * @param {boolean} [fast]   the shortcut of issueSpan outside stride order
 */
export function imagePeriod(g, speculation = true, fast = true) {
  const lat = latencies(g, speculation);
  if (g.RuntimeConfig_g === true) {
    const r = issueCycles(g, lat, 1, fast);
    return imageStartCycles(g) + 2 + (r.last - r.firsts[0]);
  }
  const st = strideParams(g, lat);
  if (st) {
    const c = strideCycles(g, lat, st);
    return c.outLast + 4 - c.inFirst;
  }
  const r = issueCycles(g, lat, 2, fast);
  return r.firsts[1] - r.firsts[0];
}

/**
 * The issue cycles outside stride order (issue_cycles()), with the shortcut of issueSpan: the cycle of the first sample
 * of every image and of the last sample.
 * @param {Record<string, any>} g
 * @param {Latencies} lat
 * @param {number} images
 * @param {boolean} fast
 * @param {{ lag1: number, lagP: number }} [skipped]
 * @returns {{ firsts: number[], last: number }}
 */
function issueCycles(g, lat, images, fast, skipped) {
  const nx = g.XSize_g;
  const ny = g.YSize_g;
  const nz = g.ZSize_g;
  const bsq = g.EncodingOrder_g === 'BSQ';
  const m = Math.min(g.SubFrameDepth_g, nz);
  const nLim = limitItems(g);
  const period = 2 ** g.UpdatePeriodExp_g;
  const lastBand = new Float64Array(nz).fill(-Infinity);
  const lastPixel = new Float64Array(nz * nx).fill(-Infinity);
  const lBand = Math.max(lat.lFix, lat.lW);
  const lCross = lat.lCross;
  let cyc = -1;
  /** @type {number[]} */
  const firsts = [];
  let startOfImage = false;
  let last = -Infinity;
  let items = 0;

  /** @param {number} z @param {number} y @param {number} x */
  const sample = (z, y, x) => {
    cyc += 1;
    const t = y * nx + x;
    const needW = lat.c > 0 && t > 1 && (!lat.spec || (!lat.runRows && x === 0));
    const lSame = Math.max(lat.lFix, needW ? lat.lW : 0);
    cyc = Math.max(cyc, lastBand[z] + lSame);
    if (lCross && z > 0) {
      cyc = Math.max(cyc, lastPixel[(z - 1) * nx + x] + lCross);
      if (lat.narrow && y === 0 && x > 0) cyc = Math.max(cyc, lastPixel[(z - 1) * nx + x - 1] + lCross);
    }
    lastBand[z] = cyc;
    lastPixel[z * nx + x] = cyc;
    if (startOfImage) {
      firsts.push(cyc);
      startOfImage = false;
    }
    last = cyc;
  };
  /** @param {number} y @param {number} band (BSQ) */
  const row = (y, band) => {
    if (bsq) {
      for (let x = 0; x < nx; x += 1) sample(band, y, x);
      items += nx;
      return;
    }
    if (nLim && y % period === 0) cyc += nLim;
    for (let low = 0; low < nz; low += m) {
      const high = Math.min(low + m, nz);
      for (let x = 0; x < nx; x += 1) for (let z = low; z < high; z += 1) sample(z, y, x);
    }
    items += nLim && y % period === 0 ? nLim + nx * nz : nx * nz;
    if (items > ITEM_LIMIT) throw new Error(`the image needs more than ${ITEM_LIMIT} items without a repeating row`);
  };
  /** The state of a row start: c - v of the live entries, L - 1 for the others. */
  const state = () => {
    const out = new Float64Array(nz + (lCross ? nz * nx : 0));
    for (let z = 0; z < nz; z += 1) out[z] = Math.min(cyc - lastBand[z], lBand - 1);
    if (lCross) for (let i = 0; i < nz * nx; i += 1) out[nz + i] = Math.min(cyc - lastPixel[i], lCross - 1);
    return out;
  };
  /** @param {Float64Array} a @param {Float64Array} b */
  const same = (a, b) => a.length === b.length && a.every((v, i) => v === b[i]);
  /** @param {number} shift */
  const skip = (shift) => {
    cyc += shift;
    last += shift;
    for (let z = 0; z < nz; z += 1) lastBand[z] += shift;
    for (let i = 0; i < nz * nx; i += 1) lastPixel[i] += shift;
  };
  /** Items of a row (y >= 2): with or without error limit values. @param {number} y */
  const kind = (y) => (nLim && y % period === 0 ? 'L' : 'S');
  /** The rows of an image (or of a band in BSQ order), with the shortcut. @param {number} band */
  const rows = (band) => {
    /** @type {{ y: number, state: Float64Array, cyc: number } | null} */
    let prev = null;
    /** @type {{ y: number, state: Float64Array, cyc: number } | null} */
    let prevL = null;
    let y = 0;
    while (y < ny) {
      if (fast && y >= 2) {
        const s = state();
        const k = kind(y);
        // lag 1: row y - 1 had the same items as row y and the same state at its start
        if (prev && prev.y === y - 1 && prev.y >= 2 && kind(prev.y) === k && same(prev.state, s)) {
          let r = 0;
          while (y + r < ny && kind(y + r) === k) r += 1;
          skip(r * (cyc - prev.cyc));
          if (skipped) skipped.lag1 += r;
          y += r;
          prev = null;
          continue;
        }
        // lag P: the last row with limit values P rows before, and the same state at its start
        if (k === 'L' && period > 1 && prevL && prevL.y === y - period && prevL.y >= 2 && same(prevL.state, s)) {
          const blocks = Math.floor((ny - y) / period);
          if (blocks > 0) {
            skip(blocks * (cyc - prevL.cyc));
            if (skipped) skipped.lagP += blocks * period;
            y += blocks * period;
            prev = null;
            prevL = null;
            continue;
          }
        }
        prev = { y, state: s, cyc };
        if (k === 'L') prevL = { y, state: s, cyc };
      }
      row(y, band);
      y += 1;
    }
  };
  for (let i = 0; i < images; i += 1) {
    startOfImage = true;
    if (bsq) for (let z = 0; z < nz; z += 1) rows(z);
    else rows(0);
  }
  return { firsts, last };
}

/**
 * Entropy coder input sequence of an image (items(), CCSDS 5.4.2): ['L', 0, 0, 0] for an error limit value,
 * ['S', z, y, x] for a sample.
 * @param {Record<string, any>} g
 * @returns {Generator<[string, number, number, number]>}
 */
function* coderItems(g) {
  const nx = g.XSize_g;
  const ny = g.YSize_g;
  const nz = g.ZSize_g;
  if (g.EncodingOrder_g === 'BSQ') {
    for (let z = 0; z < nz; z += 1) for (let y = 0; y < ny; y += 1) for (let x = 0; x < nx; x += 1) yield ['S', z, y, x];
    return;
  }
  const m = Math.min(g.SubFrameDepth_g, nz);
  const nLim = limitItems(g);
  for (let y = 0; y < ny; y += 1) {
    if (nLim && y % 2 ** g.UpdatePeriodExp_g === 0) for (let i = 0; i < nLim; i += 1) yield ['L', 0, 0, 0];
    for (let low = 0; low < nz; low += m) {
      for (let x = 0; x < nx; x += 1) for (let z = low; z < Math.min(low + m, nz); z += 1) yield ['S', z, y, x];
    }
  }
}

/**
 * Cycles of the tail of the hybrid coder after the last item of an image, plus NZ (HYBRID_TAIL of
 * tools/ocp_throughput.py): its pipeline of 8 stages empties, it outputs the 8 flush words, then reads the final
 * accumulators of the NZ bands with a latency of 2 and ends the image with the last of them.
 */
export const HYBRID_TAIL = 19;

/**
 * Issue cycle of every sample of consecutive images, with the output of the predictor modelled cycle by cycle
 * (coder_cycles(), CO-TP-01), one to one:
 *
 * - the issue stage takes the next item once the samples it depends on have left the feedback loops (as issueCycles)
 *   and while the items in flight, the write level of the output FIFO and 2 do not exceed its depth;
 * - an item reaches the output FIFO `depth` cycles after its issue; the FIFO counts a write in its level from the next
 *   cycle, offers the item two cycles after the write and lowers the level two cycles after the read;
 * - the register stage behind the FIFO holds a main and a shadow item, its ready is registered;
 * - the hybrid coder takes no item during the tail of an image (HYBRID_TAIL + NZ cycles after its last item), the other
 *   coders take one item per cycle.
 *
 * With dims (the [nx, ny, nz] of every image; g holds the maxima) the images have their own dimensions (runtime
 * configuration): the first sample of an image is accepted with the configuration in the cycle after the last sample of
 * the previous image was issued and issued once the image-start sequencer is done, start + 1 cycles later; its
 * acceptance cycle is returned for it. With tail false the output takes one item per cycle whatever the coder.
 *
 * Every item is simulated: for the tests and small images (issueSpan and imagePeriod use it only where they must).
 * @param {Record<string, any>} g
 * @param {boolean} [speculation]
 * @param {number} [images]
 * @param {number[][] | null} [dims]
 * @param {number} [start]
 * @param {boolean} [tail]
 * @returns {number[]}
 */
export function coderCycles(g, speculation = true, images = 1, dims = null, start = 0, tail = true) {
  const lat0 = latencies(g, speculation);
  const depth = lat0.depth;
  const fdepth = pow2AtLeast(depth + 8);
  const hybrid = tail && g.EntropyCoder_g === 'HYBRID';
  const runtime = dims !== null;
  const list = dims ?? Array.from({ length: images }, () => [g.XSize_g, g.YSize_g, g.ZSize_g]);
  /** @type {{ kind: string, z: number, y: number, x: number, last: boolean, first: boolean, tail: number, lat: Latencies, nx: number }[]} */
  const seq = [];
  for (const [nx, ny, nz] of list) {
    const lat = runtime ? latencies(g, speculation, [nx, ny, nz]) : lat0;
    const image = [...coderItems({ ...g, XSize_g: nx, YSize_g: ny, ZSize_g: nz })];
    image.forEach(([kind, z, y, x], k) => {
      seq.push({ kind, z, y, x, last: k === image.length - 1, first: k === 0, tail: HYBRID_TAIL + nz, lat, nx });
    });
  }
  // the last cycle of a band and of a pixel, keyed z and z * K + x
  const K = 1 << 18;
  /** @type {Map<number, number>} */
  const lastBand = new Map();
  /** @type {Map<number, number>} */
  const lastPixel = new Map();
  /** @type {Map<number, number>} */
  const writes = new Map();
  /** @type {number[]} */
  const fifo = [];
  /** @type {number[]} */
  const cycles = [];
  let issue = 0;
  let prev = -1;
  /** @type {number | null} */
  let take = null;
  let inflight = 0;
  let wrLevel = 0;
  let rdLevel = 0;
  let rdUp = false;
  let wrDown = false;
  /** @type {number | null} */
  let main = null;
  /** @type {number | null} */
  let shadow = null;
  let inReady = true;
  let endingUntil = -1;
  let taken = 0;
  let t = 0;
  while (taken < seq.length) {
    // combinational signals of the cycle
    const coderReady = !(hybrid && t <= endingUntil);
    const written = writes.has(t) ? /** @type {number} */ (writes.get(t)) : null;
    if (written !== null) writes.delete(t);
    const fifoRead = rdLevel > 0 && inReady;
    let issued = false;
    if (issue < seq.length) {
      const it = seq[issue];
      const lat = it.lat;
      let earliest = prev + 1;
      if (runtime && it.first) {
        // the first sample of the image is accepted with the configuration, then held for the image start
        if (take === null) take = prev + 1;
        earliest = take + start + 1;
      }
      if (it.kind === 'S') {
        const needW = lat.c > 0 && it.y * it.nx + it.x > 1 && (!lat.spec || (!lat.runRows && it.x === 0));
        const lSame = Math.max(lat.lFix, needW ? lat.lW : 0);
        const band = lastBand.get(it.z);
        if (band !== undefined) earliest = Math.max(earliest, band + lSame);
        if (lat.lCross && it.z > 0) {
          const above = lastPixel.get((it.z - 1) * K + it.x);
          if (above !== undefined) earliest = Math.max(earliest, above + lat.lCross);
          const left = lastPixel.get((it.z - 1) * K + it.x - 1);
          if (lat.narrow && it.y === 0 && it.x > 0 && left !== undefined) earliest = Math.max(earliest, left + lat.lCross);
        }
      }
      if (t >= earliest && inflight + wrLevel + 2 <= fdepth) {
        issued = true;
        prev = t;
        if (it.kind === 'S') {
          lastBand.set(it.z, t);
          lastPixel.set(it.z * K + it.x, t);
          cycles.push(runtime && it.first ? /** @type {number} */ (take) : t);
        }
        take = null;
        writes.set(t + depth, issue);
        issue += 1;
      }
    }
    // registers at the end of the cycle: items in flight, FIFO, register stage, coder
    inflight += (issued ? 1 : 0) - (written !== null ? 1 : 0);
    const newRdUp = written !== null;
    let newWrLevel = wrLevel;
    if (written !== null) {
      fifo.push(written);
      newWrLevel += wrDown ? 0 : 1;
    } else if (wrDown) {
      newWrLevel -= 1;
    }
    const newWrDown = fifoRead;
    let newRdLevel = rdLevel;
    /** @type {number | null} */
    let read = null;
    if (fifoRead) {
      read = /** @type {number} */ (fifo.shift());
      newRdLevel -= rdUp ? 0 : 1;
    } else if (rdUp) {
      newRdLevel += 1;
    }
    const stuck = main !== null && !coderReady && (rdLevel > 0 || shadow !== null);
    if (main !== null && coderReady) {
      if (seq[main].last && hybrid) endingUntil = t + seq[main].tail;
      taken += 1;
      main = shadow;
      shadow = null;
    }
    if (fifoRead) {
      if (stuck) shadow = read;
      else main = read;
    }
    inReady = !stuck;
    wrLevel = newWrLevel;
    rdLevel = newRdLevel;
    rdUp = newRdUp;
    wrDown = newWrDown;
    t += 1;
  }
  return cycles;
}

/**
 * Acceptance cycle of every sample at the input of the predictor for consecutive images of a runtime configuration (g:
 * the generics with the maxima; dims: the [nx, ny, nz] of every image), without back pressure (runtime_accept_cycles(),
 * CO-RC-03, CO-RC-05).
 * @param {Record<string, any>} g
 * @param {number[][]} dims
 * @param {boolean} [speculation]
 * @param {boolean} [tail]
 */
export function runtimeAcceptCycles(g, dims, speculation = true, tail = true) {
  return coderCycles(g, speculation, 1, dims, imageStartCycles(g), tail);
}

/**
 * Cycles between the first and the last item at the output of the predictor in stride order, 0 outside it
 * (output_span()).
 * @param {Record<string, any>} g
 * @param {boolean} [speculation]
 */
export function outputSpan(g, speculation = true) {
  const lat = latencies(g, speculation);
  const st = strideParams(g, lat);
  return st ? strideSpans(g, lat, st)[1] : 0;
}

/**
 * Longest output codeword of the low-entropy codes of the hybrid coder (CCSDS 123.0-B-2 tables B-1 to B-16) and sum of
 * the longest flush codeword of every code (tables B-17 to B-32), in bits: LE_MAX_OUT and LE_MAX_FLUSH of
 * tools/ocp_model.py, computed there from the code tables (tests/unit/ocp.test.mjs compares them).
 */
export const LE_MAX_OUT = 21;
export const LE_MAX_FLUSH = 130;

/**
 * Option identifier width of the block-adaptive coder (CCSDS 121.0-B-3 table 5-1, block_options()).
 * @param {number} d
 * @param {boolean} restricted
 */
function optionIdBits(d, restricted) {
  if (restricted && d <= 2) return 1;
  if (restricted && d <= 4) return 2;
  if (d <= 8) return 3;
  if (d <= 16) return 4;
  return 5;
}

/**
 * Strict upper bound on the bytes of the compressed image of any image of the configuration (max_image_bytes() of
 * tools/ocp_model.py, which cites the clauses of every term): the header; the error limit values of periodic updating;
 * per band the first index with D bits and every further index with at most Umax + D bits (sample-adaptive coder), or
 * with at most LE_MAX_OUT + Umax + D bits, one bit per rescaling of the statistics and the tail (hybrid coder), or
 * every block of J entries with the option identifier and J D bits (block-adaptive coder); fill bits up to a multiple
 * of B bytes.
 * @param {Record<string, any>} g
 */
export function maxImageBytes(g) {
  const d = g.DynamicRange_g;
  const nz = g.ZSize_g;
  const tBand = g.XSize_g * g.YSize_g;
  const fid = g.Fidelity_g;
  const periodic = fid !== 'LOSSLESS' && g.PeriodicUpdate_g === true;
  let nLim = 0;
  let limBits = 0;
  if (periodic) {
    const frames = Math.ceil(g.YSize_g / 2 ** g.UpdatePeriodExp_g);
    if (fid === 'ABSOLUTE' || fid === 'ABSOLUTE_RELATIVE') {
      const n = g.AbsBandDependent_g ? nz : 1;
      nLim += frames * n;
      limBits += frames * n * g.AbsBitDepth_g;
    }
    if (fid === 'RELATIVE' || fid === 'ABSOLUTE_RELATIVE') {
      const n = g.RelBandDependent_g ? nz : 1;
      nLim += frames * n;
      limBits += frames * n * g.RelBitDepth_g;
    }
  }
  const umax = g.UnaryLimit_g;
  let body;
  if (g.EntropyCoder_g === 'SAMPLE_ADAPTIVE') {
    body = limBits + nz * d + nz * (tBand - 1) * (umax + d);
  } else if (g.EntropyCoder_g === 'HYBRID') {
    const gs = g.RescaleCounterSize_g;
    // the counter does not depend on the data: its rescalings are counted exactly
    let cnt = 2 ** g.InitialCountExp_g;
    let rescales = 0;
    for (let i = 1; i < tBand; i += 1) {
      if (cnt < 2 ** gs - 1) cnt += 1;
      else {
        rescales += 1;
        cnt = Math.floor((cnt + 1) / 2);
      }
    }
    body = limBits + nz * d + nz * (tBand - 1) * (LE_MAX_OUT + umax + d) + nz * rescales + LE_MAX_FLUSH + nz * (2 + d + gs) + 1;
  } else {
    const j = g.BlockSize_g;
    const blocks = Math.ceil((nz * tBand + nLim) / j);
    body = blocks * (optionIdBits(d, g.RestrictedCodes_g === true) + j * d);
  }
  const unit = 8 * g.OutputWordSize_g;
  const bits = 8 * headerBytes(g) + body;
  return Math.ceil(bits / unit) * g.OutputWordSize_g;
}

/**
 * Bytes of the header of the compressed image (CCSDS 5.3), as tools/ocp_model.py header() writes it for the generics
 * of the core: the essential image metadata, the supplementary information tables as given, the predictor metadata
 * with the optional weight tables, the quantization and sample representative subparts, the entropy coder metadata;
 * every table ends on a byte boundary.
 * @param {Record<string, any>} g
 */
export function headerBytes(g) {
  const nz = g.ZSize_g;
  const p = g.PredictionBands_g;
  const full = g.PredictionMode_g === 'FULL';
  const fid = g.Fidelity_g;
  let bits = 96;
  const align = () => {
    bits = Math.ceil(bits / 8) * 8;
  };
  if (g.SupTableCount_g > 0) bits += literalBits(g.SupTableData_g) ?? 0;
  bits += 40;
  // per band Pz* = min(z, P) inter-band weights, three more in full mode
  let pzSum = 0;
  for (let z = 0; z < nz; z += 1) pzSum += Math.min(z, p);
  if (g.WeightInitTable_g) {
    bits += g.WeightInitResolution_g * (pzSum + (full ? 3 * nz : 0));
    align();
  }
  if (g.WeightExpOffsetTable_g) {
    bits += 4 * (pzSum + (full ? nz : 0));
    align();
  }
  if (fid !== 'LOSSLESS') {
    const periodic = g.PeriodicUpdate_g === true;
    if (g.EncodingOrder_g !== 'BSQ') bits += 8;
    if (fid === 'ABSOLUTE' || fid === 'ABSOLUTE_RELATIVE') {
      bits += 8;
      if (!periodic) {
        bits += g.AbsBitDepth_g * (g.AbsBandDependent_g ? nz : 1);
        align();
      }
    }
    if (fid === 'RELATIVE' || fid === 'ABSOLUTE_RELATIVE') {
      bits += 8;
      if (!periodic) {
        bits += g.RelBitDepth_g * (g.RelBandDependent_g ? nz : 1);
        align();
      }
    }
  }
  const theta = g.SampleRepResolution_g;
  if (theta > 0) {
    bits += 24;
    if (g.DampingTable_g) {
      bits += theta * nz;
      align();
    }
    if (g.OffsetTable_g) {
      bits += theta * nz;
      align();
    }
  }
  bits += 16;
  if (g.EntropyCoder_g === 'SAMPLE_ADAPTIVE' && g.AccuInitTable_g) {
    bits += 4 * nz;
    align();
  }
  return bits / 8;
}

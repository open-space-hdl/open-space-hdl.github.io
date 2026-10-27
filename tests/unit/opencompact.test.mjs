// OpenCompact in the Composer: the image framing (In_Last only while UseInLast_g, the error flag of the compressed
// images), the rules from the assertions of the core, and the presets whose sub-frame depth follows the number of bands.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkConnection } from '../../assets/composer/js/model/compat.js';
import { addDomain, addInstance, assignClock, clearGeneric, createDesign, setExternal, setGeneric } from '../../assets/composer/js/model/design.js';
import { netlist } from '../../assets/composer/js/model/netlist.js';
import { resolve } from '../../assets/composer/js/model/resolver.js';
import { fromText, toDocument, toText } from '../../assets/composer/js/model/serialize.js';
import { placeSubsystem, withSubsystems } from '../../assets/composer/js/model/subsystems.js';
import { connect, loadCatalog } from './helpers.mjs';

const cat = loadCatalog();

/**
 * @param {any} d
 * @param {string} a
 * @param {string} b
 */
function link(d, a, b) {
  const chk = checkConnection(cat, d, a, b);
  assert.ok(chk.ok, chk.reason);
  return connect(d, chk);
}

/** @param {ReturnType<typeof resolve>} r @param {string} rule @param {string} [severity] */
const checksOf = (r, rule, severity) => r.checks.filter((c) => c.rule === rule && (!severity || c.severity === severity));

/** A FIFO without last in front of the compressor, the compressor in front of the framer of OpenCrypto. */
function chain() {
  let d = createDesign('t');
  for (const b of ['olo/olo_ft_fifo_sync', 'opencompact/ocp_core', 'opencrypto/ocr_framer']) d = addInstance(d, cat, b, { x: 0, y: 0 }).design;
  d = link(d, 'fifo0.Out', 'ocp0.In');
  return link(d, 'ocp0.Out', 'frm0.S_In');
}

test('without image framing In_Last is tied to zero and the error flag of the images is not reported', () => {
  const d = chain();
  const r = resolve(cat, d);
  assert.deepEqual(checksOf(r, 'packets'), []);
  assert.deepEqual(checksOf(r, 'flag_dropped'), []);
  // neither the unused In_Last nor the always clear Out_Error is a remark of the connections
  assert.deepEqual(checksOf(r, 'signals').map((c) => c.message), []);
  const n = netlist(cat, d, r);
  assert.deepEqual(n.problems, []);
  assert.equal(n.nets.find((x) => x.to === 'ocp0_In_Last_s')?.from, "'0'");
  assert.ok(!n.nets.some((x) => x.from === 'ocp0_Out_Error_s'), 'Out_Error stays open');
});

test('with image framing a source without last is an error and a sink without the error flag a warning', () => {
  const d = setGeneric(chain(), cat, 'ocp0', 'UseInLast_g', true).design;
  const r = resolve(cat, d);
  assert.deepEqual(checksOf(r, 'packets').map((c) => `${c.severity} ${c.message}`), ['error ocp0.In needs packet boundaries; fifo0.Out has no last.']);
  assert.deepEqual(checksOf(r, 'flag_dropped').map((c) => `${c.severity} ${c.message}`), [
    'warning ocp0.Out feeds frm0.S_In. The error flag of the compressed images (Out_Error on the last word) is not passed on, so an image with a framing error is sent like a good one. Mark or discard such images by Out_Error, or count them at ImageError (Ev_ImageError).',
  ]);
  // an external stream of samples has In_Last, and the framing errors leave as a pulse
  let e = createDesign('t');
  e = addInstance(e, cat, 'opencompact/ocp_core', { x: 0, y: 0 }).design;
  e = setGeneric(e, cat, 'ocp0', 'UseInLast_g', true).design;
  for (const [ref, prefix] of [['ocp0.In', 'in_'], ['ocp0.Out', 'out_'], ['ocp0.ImageError', 'ev_']]) e = setExternal(e, ref, prefix);
  const re = resolve(cat, e);
  assert.deepEqual(re.checks.filter((c) => c.severity === 'error' || c.rule === 'packets' || c.rule === 'flag_dropped'), []);
  const names = netlist(cat, e, re).ports.map((p) => p.name);
  for (const p of ['in_In_Last', 'out_Out_Error', 'ev_Ev_ImageError']) assert.ok(names.includes(p), `${p} in ${names.join(', ')}`);
});

test('a subsystem decides the image framing inside: its sample input needs last only with UseInLast_g', () => {
  for (const framing of [false, true]) {
    let sys = createDesign('cmp');
    sys = addInstance(sys, cat, 'opencompact/ocp_core', { x: 0, y: 0 }).design;
    sys = setGeneric(sys, cat, 'ocp0', 'UseInLast_g', framing).design;
    for (const [ref, prefix] of [['ocp0.In', 'smp_'], ['ocp0.Out', 'img_']]) sys = setExternal(sys, ref, prefix);
    const host = placeSubsystem(createDesign('host'), cat, sys, { x: 0, y: 0 }).design;
    const b = withSubsystems(cat, host).blocks.get('subsystem/cmp');
    assert.equal(b?.interfaces.find((i) => i.name === 'smp')?.needsLast, framing);
  }
});

test('the rules of the assertions of the core: width 1, register size, vmin and vmax, periodic updating in BSQ order', () => {
  let d = createDesign('t');
  d = addInstance(d, cat, 'opencompact/ocp_core', { x: 0, y: 0 }).design;
  const errors = (/** @type {any} */ x) => resolve(cat, x).checks.filter((c) => c.severity === 'error' && c.instance === 'ocp0' && c.rule !== 'must_serve').map((c) => c.message);
  assert.deepEqual(errors(d), []);
  // an image of width 1 needs reduced prediction and column-oriented local sums
  let w = setGeneric(d, cat, 'ocp0', 'XSize_g', 1).design;
  assert.equal(errors(w).length, 2);
  assert.match(errors(w)[0], /^ocp0: XSize_g = 1 must be at least 2 \(images of width 1 need reduced prediction and column-oriented local sums \(CCSDS 4\.3\.1, 4\.4\.1\)\)\.$/);
  w = setGeneric(setGeneric(w, cat, 'ocp0', 'PredictionMode_g', 'REDUCED').design, cat, 'ocp0', 'LocalSum_g', 'WIDE_COLUMN').design;
  assert.deepEqual(errors(w), []);
  // R >= max(32, D + Omega + 2): 16 + 19 + 2 = 37
  const r = setGeneric(setGeneric(d, cat, 'ocp0', 'WeightResolution_g', 19).design, cat, 'ocp0', 'RegisterSize_g', 36).design;
  assert.deepEqual(errors(r).map((m) => m.slice(0, 40)), ['ocp0: RegisterSize_g = 36 must be at lea']);
  const v = setGeneric(d, cat, 'ocp0', 'WeightUpdateVmin_g', 4).design;
  assert.equal(errors(v).length, 1);
  // periodic updating in BSQ order: an error only in near-lossless compression, which uses it
  let p = setGeneric(setGeneric(d, cat, 'ocp0', 'PeriodicUpdate_g', true).design, cat, 'ocp0', 'EncodingOrder_g', 'BSQ').design;
  assert.deepEqual(errors(p), []);
  p = setGeneric(p, cat, 'ocp0', 'Fidelity_g', 'ABSOLUTE').design;
  assert.deepEqual(errors(p), ['ocp0: PeriodicUpdate_g = true with Fidelity_g = ABSOLUTE requires EncodingOrder_g = BI.']);
});

test('the ranges of the standard that depend on other parameters: M <= NZ, restricted codes, gamma*, K per band', () => {
  let d = createDesign('t');
  d = addInstance(d, cat, 'opencompact/ocp_core', { x: 0, y: 0 }).design;
  const errors = (/** @type {any} */ x) => resolve(cat, x).checks.filter((c) => c.severity === 'error' && c.instance === 'ocp0' && c.rule !== 'must_serve').map((c) => c.message);
  // M up to NZ in BI order; in BSQ order M is not used
  const m = setGeneric(d, cat, 'ocp0', 'SubFrameDepth_g', 5).design;
  assert.deepEqual(errors(m), ['ocp0: SubFrameDepth_g = 5 must be at most ZSize_g = 4 (the sub-frame depth M is 1 to NZ (CCSDS 5.4.2.2.1)).']);
  assert.deepEqual(errors(setGeneric(m, cat, 'ocp0', 'EncodingOrder_g', 'BSQ').design), []);
  // restricted code options: only the block-adaptive coder, and there only with D <= 4 (both conditions of the rule)
  let r = setGeneric(d, cat, 'ocp0', 'RestrictedCodes_g', true).design;
  assert.deepEqual(errors(r), []);
  r = setGeneric(r, cat, 'ocp0', 'EntropyCoder_g', 'BLOCK_ADAPTIVE').design;
  assert.deepEqual(errors(r), ['ocp0: DynamicRange_g = 16 must be at most 4 (the restricted code options need D <= 4 (CCSDS 5.3.4.4, 5.4.3.4.2.6)).']);
  assert.deepEqual(errors(setGeneric(r, cat, 'ocp0', 'DynamicRange_g', 4).design), []);
  // gamma* >= max(4, gamma0 + 1), not for the block-adaptive coder
  const g = setGeneric(setGeneric(d, cat, 'ocp0', 'InitialCountExp_g', 6).design, cat, 'ocp0', 'RescaleCounterSize_g', 6).design;
  assert.deepEqual(errors(g), ['ocp0: RescaleCounterSize_g = 6 must be at least max(4, InitialCountExp_g + 1) = 7 (CCSDS 5.4.3.2.3.4, 5.4.3.3.4.5).']);
  assert.deepEqual(errors(setGeneric(g, cat, 'ocp0', 'EntropyCoder_g', 'BLOCK_ADAPTIVE').design), []);
  // K (one value) or k''z per band, 0 to min(D - 2, 14); the last element repeats for the remaining bands
  let k = setGeneric(d, cat, 'ocp0', 'AccuInit_g', '(0 => 15)').design;
  assert.deepEqual(errors(k), ['ocp0: element 0 of AccuInit_g = 15 must be from 0 to min(DynamicRange_g - 2, 14) = 14 (CCSDS 5.4.3.2.3.3).']);
  k = setGeneric(d, cat, 'ocp0', 'AccuInit_g', '(3, 4, 15)').design;
  // without band-varying values only K, the first element, is used
  assert.deepEqual(errors(k), []);
  k = setGeneric(k, cat, 'ocp0', 'AccuInitBandVarying_g', true).design;
  assert.deepEqual(errors(k), ['ocp0: element 2 of AccuInit_g = 15 must be from 0 to min(DynamicRange_g - 2, 14) = 14 (CCSDS 5.4.3.2.3.3).']);
  // with fewer bands than elements, the elements beyond NZ are not used
  assert.deepEqual(errors(setGeneric(setGeneric(k, cat, 'ocp0', 'ZSize_g', 2).design, cat, 'ocp0', 'SubFrameDepth_g', 2).design), []);
  // the hybrid coder has no K
  assert.deepEqual(errors(setGeneric(k, cat, 'ocp0', 'EntropyCoder_g', 'HYBRID').design), []);
});

test('the runtime parameters only with the runtime configuration; with the hybrid coder some gamma0 keeps every initial accumulator below 2^(D + gamma0)', () => {
  let d = createDesign('t');
  d = addInstance(d, cat, 'opencompact/ocp_core', { x: 0, y: 0 }).design;
  const errors = (/** @type {any} */ x) => resolve(cat, x).checks.filter((c) => c.severity === 'error' && c.instance === 'ocp0' && c.rule !== 'must_serve').map((c) => c.message);
  const set = (/** @type {any} */ x, /** @type {Record<string, any>} */ g) => Object.entries(g).reduce((y, [k, v]) => setGeneric(y, cat, 'ocp0', k, v).design, x);
  // CO-CF-05: the parameters travel with the configuration of an image
  const p = set(d, { RuntimeParams_g: true });
  assert.deepEqual(errors(p), ['ocp0: RuntimeParams_g = true requires RuntimeConfig_g = true.']);
  const h = set(p, { RuntimeConfig_g: true, EntropyCoder_g: 'HYBRID' });
  assert.deepEqual(errors(h), []);
  // D = 16, gamma* = 6: gamma0 up to 5, every accumulator below 2^21 (the last element repeats for the remaining bands)
  const low = '2 ** minimum(31, DynamicRange_g + minimum(8, RescaleCounterSize_g - 1)) - 1';
  const high = '2 ** maximum(0, DynamicRange_g + minimum(8, RescaleCounterSize_g - 1) - 31) - 1';
  const why = 'with RuntimeParams_g some gamma0 up to min(8, RescaleCounterSize_g - 1) keeps every initial accumulator below 2^(D + gamma0) (CCSDS 5.4.3.3.4.3, CO-CF-05)';
  assert.deepEqual(errors(set(h, { HybridAccuInit_g: '(0 => 2097151)' })), []);
  assert.deepEqual(errors(set(h, { HybridAccuInit_g: '(0 => 2097152)' })), [`ocp0: element 0 of HybridAccuInit_g = 2097152 must be at most ${low} = 2097151 (${why}).`]);
  assert.deepEqual(errors(set(h, { HybridAccuInit_g: '(5, 6, 2097152)' })), [`ocp0: element 2 of HybridAccuInit_g = 2097152 must be at most ${low} = 2097151 (${why}).`]);
  assert.deepEqual(errors(set(h, { HybridAccuInit_g: '(5, 6, 2097152)', ZSize_g: 2, SubFrameDepth_g: 2 })), []);
  // below 2^31 the part from 2^31 on is zero; from D + gamma0 = 32 on it is below 2^(D + gamma0 - 31)
  assert.deepEqual(errors(set(h, { HybridAccuInitHigh_g: '(0 => 1)' })), [`ocp0: element 0 of HybridAccuInitHigh_g = 1 must be at most ${high} = 0 (${why}).`]);
  const wide = set(h, { DynamicRange_g: 24, RescaleCounterSize_g: 11 });
  assert.deepEqual(errors(set(wide, { HybridAccuInit_g: '(0 => 2147483647)', HybridAccuInitHigh_g: '(0 => 1)' })), []);
  assert.deepEqual(errors(set(wide, { HybridAccuInitHigh_g: '(0 => 2)' })), [`ocp0: element 0 of HybridAccuInitHigh_g = 2 must be at most ${high} = 1 (${why}).`]);
  // only with the runtime parameters and the hybrid coder
  assert.deepEqual(errors(set(h, { RuntimeParams_g: false, HybridAccuInit_g: '(0 => 2097152)' })), []);
  assert.deepEqual(errors(set(h, { EntropyCoder_g: 'SAMPLE_ADAPTIVE', HybridAccuInit_g: '(0 => 2097152)' })), []);
  // the channel has the same rules
  let c = createDesign('t');
  c = addInstance(c, cat, 'opencompact/ocp_channel', { x: 0, y: 0 }).design;
  const id = c.instances[0].id;
  const chErrors = (/** @type {any} */ x) => resolve(cat, x).checks.filter((k) => k.severity === 'error' && k.instance === id && k.rule !== 'must_serve').map((k) => k.message);
  c = setGeneric(c, cat, id, 'RuntimeParams_g', true).design;
  assert.deepEqual(chErrors(c), [`${id}: RuntimeParams_g = true requires RuntimeConfig_g = true.`]);
  for (const [k, v] of Object.entries({ RuntimeConfig_g: true, EntropyCoder_g: 'HYBRID', HybridAccuInit_g: '(0 => 2097152)' })) c = setGeneric(c, cat, id, k, v).design;
  assert.deepEqual(chErrors(c), [`${id}: element 0 of HybridAccuInit_g = 2097152 must be at most ${low} = 2097151 (${why}).`]);
});

test('a BIP preset: the sub-frame depth follows the number of bands until the user sets it, also in the file and the brief', () => {
  let d = createDesign('t');
  d = addInstance(d, cat, 'opencompact/ocp_core', { x: 0, y: 0 }, 'lossless_bip').design;
  const m = (/** @type {any} */ x) => resolve(cat, x).byId.get('ocp0')?.generics.SubFrameDepth_g;
  const brief = (/** @type {any} */ x) => /** @type {any} */ (toDocument(x, cat)).agent.brief;
  assert.equal(m(d), 4);
  // more bands: M follows, and nothing is stored for it
  d = setGeneric(d, cat, 'ocp0', 'ZSize_g', 200).design;
  assert.equal(m(d), 200);
  assert.deepEqual(d.instances[0].generics, { ZSize_g: 200 });
  assert.match(brief(d), /^- `ocp0`: .*`SubFrameDepth_g => 200`.*; `SubFrameDepth_g` follows `ZSize_g` \(BIP\)$/m);
  // the file keeps the preset and only the band count; it opens with M following again
  const text = toText(d, cat);
  const inst = JSON.parse(text).instances[0];
  assert.equal(inst.preset, 'lossless_bip');
  assert.deepEqual(inst.generics, { ZSize_g: 200 });
  assert.equal(m(setGeneric(fromText(text, cat).design, cat, 'ocp0', 'ZSize_g', 32).design), 32);
  // set by the user: M stays, and the brief no longer says that it follows
  d = setGeneric(d, cat, 'ocp0', 'SubFrameDepth_g', 16).design;
  assert.deepEqual(d.instances[0].generics, { ZSize_g: 200, SubFrameDepth_g: 16 });
  assert.equal(m(setGeneric(d, cat, 'ocp0', 'ZSize_g', 100).design), 16);
  assert.doesNotMatch(brief(d), /follows `ZSize_g`/);
  // set to the band count, or cleared: it follows again
  assert.deepEqual(setGeneric(d, cat, 'ocp0', 'SubFrameDepth_g', 200).design.instances[0].generics, { ZSize_g: 200 });
  assert.equal(m(setGeneric(clearGeneric(d, cat, 'ocp0', 'SubFrameDepth_g').design, cat, 'ocp0', 'ZSize_g', 64).design), 64);
  // the overrides of a set of values: M equal to the band count is not stored
  const b = cat.block('opencompact/ocp_core');
  assert.deepEqual(cat.overridesOf(b, cat.genericValues(b, { ZSize_g: 48 }, 'lossless_bip'), 'lossless_bip'), { ZSize_g: 48 });
  // a preset in BSQ order sets M to a literal
  const bsq = addInstance(createDesign('t'), cat, 'opencompact/ocp_core', { x: 0, y: 0 }, 'lossless_bsq').design;
  assert.equal(m(setGeneric(bsq, cat, 'ocp0', 'ZSize_g', 200).design), 1);
  assert.doesNotMatch(brief(bsq), /follows/);
});

test('every preset resolves without an error of the core at the default image size', () => {
  const b = cat.block('opencompact/ocp_core');
  for (const p of b.presets ?? []) {
    const d = addInstance(createDesign('t'), cat, 'opencompact/ocp_core', { x: 0, y: 0 }, p.id).design;
    const errors = resolve(cat, d).checks.filter((c) => c.severity === 'error' && c.instance === 'ocp0' && c.rule !== 'must_serve');
    assert.deepEqual(errors, [], p.id);
  }
});

/**
 * The compressor at 32 bits in front of the framer of a 128-bit AES-GCM core, optionally in another clock domain.
 * @param {boolean} framing UseInLast_g
 * @param {boolean} [crossing] the framer and the AES-GCM core in a second clock domain
 */
function widened(framing, crossing = false) {
  let d = createDesign('t');
  for (const b of ['opencompact/ocp_core', 'opencrypto/ocr_framer', 'opencrypto/ocr_core']) d = addInstance(d, cat, b, { x: 0, y: 0 }).design;
  d = setGeneric(d, cat, 'ocp0', 'OutWidth_g', 32).design;
  d = setGeneric(d, cat, 'ocp0', 'UseInLast_g', framing).design;
  d = setGeneric(d, cat, 'ocr0', 'DataWidth_g', 128).design;
  if (crossing) {
    const dom = addDomain(d, { name: 'Crypto', frequencyHz: 150e6 });
    d = assignClock(dom.design, cat, 'frm0', 'Clk', dom.id);
    d = assignClock(d, cat, 'ocr0', 'Clk', dom.id);
  }
  d = link(d, 'ocp0.Out', 'frm0.S_In');
  return link(d, 'frm0.M_Out', 'ocr0.S_In');
}

test('a narrower compressor feeds the framer through a width converter with byte enables; its error flag ends there', () => {
  for (const framing of [false, true]) {
    const d = widened(framing);
    const r = resolve(cat, d);
    assert.equal(r.byId.get('frm0')?.generics.DataWidth_g, 128);
    assert.deepEqual(checksOf(r, 'width_conversion'), []);
    const adapters = r.chainOf.get('c1')?.adapters ?? [];
    assert.equal(adapters.length, 1);
    const conv = r.byId.get(adapters[0]);
    assert.equal(conv?.block, 'olo/olo_base_wconv_n2m');
    assert.deepEqual([conv?.generics.InWidth_g, conv?.generics.OutWidth_g, conv?.generics.UseBe_g], [32, 128, true]);
    // the dropped flag is reported by the rule of the compressor where it matters, not as a remark of the connection
    assert.equal(checksOf(r, 'flag_dropped').length, framing ? 1 : 0);
    assert.deepEqual(checksOf(r, 'signals').map((c) => c.message), []);
    const n = netlist(cat, d, r);
    assert.deepEqual(n.problems, []);
    assert.equal(n.nets.find((x) => x.to === `${adapters[0]}_In_Be_s`)?.from, 'ocp0_Out_Keep_s');
    assert.equal(n.nets.find((x) => x.to === 'frm0_S_In_Keep_s')?.from, `${adapters[0]}_Out_Be_s`);
    assert.ok(!n.nets.some((x) => x.from === 'ocp0_Out_Error_s'), 'Out_Error stays open');
  }
});

test('behind the width converter the clock crossing carries data, keep and last only', () => {
  const d = widened(true, true);
  const r = resolve(cat, d);
  const adapters = r.chainOf.get('c1')?.adapters ?? [];
  assert.deepEqual(adapters.map((a) => r.byId.get(a)?.role), ['wconv', 'cdc']);
  assert.deepEqual(r.checks.filter((c) => c.severity === 'error' && c.rule !== 'must_serve'), []);
  const n = netlist(cat, d, r);
  assert.deepEqual(n.problems, []);
  assert.ok(!n.nets.some((x) => x.from === 'ocp0_Out_Error_s'), 'Out_Error stays open');
  // the asynchronous FIFO holds 128 data bits, 16 byte enables and last
  assert.equal(r.byId.get(adapters[1])?.generics.Width_g, 128 + 16 + 1);
});

test('a narrower compressor feeds a wider send port of OpenSPP; the side band constants replace user behind the converter', () => {
  let d = createDesign('t');
  for (const b of ['opencompact/ocp_core', 'openspp/spp_core']) d = addInstance(d, cat, b, { x: 0, y: 0 }).design;
  d = setGeneric(d, cat, 'ocp0', 'OutWidth_g', 32).design;
  d = setGeneric(d, cat, 'spp0', 'DataWidth_g', 128).design;
  d = link(d, 'ocp0.Out', 'spp0.S_Tx[0]');
  const r = resolve(cat, d);
  assert.deepEqual(checksOf(r, 'width_conversion'), []);
  assert.equal(r.chainOf.get('c1')?.adapters.length, 1);
  assert.equal(r.chainOf.get('c1')?.constants?.user, 'sideband');
  const n = netlist(cat, d, r);
  assert.deepEqual(n.problems, []);
  assert.equal(n.nets.find((x) => x.to === 'spp0_S_Tx_User_s')?.kind, 'constant');
});

/** The receive port of OpenSPP in front of the compression channel, the framer of OpenCrypto behind it. */
function channel() {
  let d = createDesign('t');
  for (const b of ['openspp/spp_core', 'opencompact/ocp_channel', 'opencrypto/ocr_framer']) d = addInstance(d, cat, b, { x: 0, y: 0 }).design;
  d = setGeneric(d, cat, 'spp0', 'DataWidth_g', 64).design;
  d = setGeneric(d, cat, 'frm0', 'DataWidth_g', 128).design;
  d = link(d, 'spp0.M_Rx[0]', 'och0.In');
  d = link(d, 'och0.Out', 'frm0.S_In');
  for (const [g, v] of [['UserLastMask_g', '22x"3FC000"'], ['UserLastValue_g', '22x"004000"'], ['UserErrorMask_g', '22x"003000"']]) d = setGeneric(d, cat, 'och0', g, v).design;
  return d;
}

test('the channel follows the receive port of OpenSPP and the framer, and takes the masks at the 22 user bits', () => {
  const d = channel();
  const r = resolve(cat, d);
  const g = /** @type {Record<string, any>} */ (r.byId.get('och0')?.generics);
  assert.deepEqual([g.InStreamWidth_g, g.UserWidth_g, g.OutStreamWidth_g], [64, 22, 128]);
  // no converter: the channel adapts both stream widths itself
  assert.deepEqual([r.chainOf.get('c1')?.adapters, r.chainOf.get('c2')?.adapters], [[], []]);
  assert.deepEqual(r.checks.filter((c) => c.severity === 'error' && c.rule !== 'must_serve'), []);
  // the framer has no error flag: the images that ended with an error are counted in the status registers
  assert.deepEqual(checksOf(r, 'flag_dropped').map((c) => c.message), [
    'och0.Out feeds frm0.S_In. The error flag of the compressed images (Out_Error on the last beat) is not passed on, so an image that ended with an error (aborted, completed by a faulty SDU, or without its end mark) is sent like a good one. Mark or discard such images by Out_Error, or take them from the counter IMAGES_ABORTED of the status registers.',
  ]);
  const n = netlist(cat, d, r);
  assert.deepEqual(n.problems, []);
  const map = Object.fromEntries((n.instances.find((/** @type {any} */ i) => i.id === 'och0')?.generics ?? []).map((/** @type {any} */ x) => [x.name, x.vhdl]));
  assert.deepEqual([map.UserLastMask_g, map.UserLastValue_g, map.UserErrorMask_g], ['"1111111100000000000000"', '"0000000100000000000000"', '"0000000011000000000000"']);
});

test('the end mark value of the channel lies within its mask', () => {
  const d = setGeneric(channel(), cat, 'och0', 'UserLastValue_g', '22x"004001"').design;
  assert.deepEqual(checksOf(resolve(cat, d), 'vector_within').map((c) => `${c.severity} ${c.message}`), [
    'error och0: UserLastValue_g = 22x"004001" sets bit 0, outside UserLastMask_g = 22x"3FC000" (the end mark compares only the bits of the mask (IA-CF-01)).',
  ]);
});

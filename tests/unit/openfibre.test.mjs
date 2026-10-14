// OpenFibre in the Composer: the virtual channels as packet links (OpenSPP directly, RMAP through the N-Char
// adapter), the user bits of both directions, the GTY adapter with its lane clock domain, the clock rules and the
// constraints of the core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkConnection } from '../../assets/composer/js/model/compat.js';
import { addInstance, assignClock, createDesign, setGeneric, updateDomain } from '../../assets/composer/js/model/design.js';
import { netlist } from '../../assets/composer/js/model/netlist.js';
import { resolve } from '../../assets/composer/js/model/resolver.js';
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

/** @param {ReturnType<typeof resolve>} r @param {string} rule */
const checksOf = (r, rule) => r.checks.filter((c) => c.rule === rule);

/** SpaceFibre port with its adapter, OpenSPP on VC 1; the lane and core clocks from the adapter. */
function node() {
  let d = createDesign('t');
  for (const b of ['openfibre/ofb_core', 'openfibre/ofb_pa_gty', 'openspp/spp_core']) d = addInstance(d, cat, b, { x: 0, y: 0 }).design;
  d = updateDomain(d, 'sys', { frequencyHz: 200e6 });
  d = setGeneric(d, cat, 'ofb0', 'NumVc_g', 2).design;
  d = link(d, 'ofb0.Phy', 'pa0.Phy');
  d = assignClock(d, cat, 'ofb0', 'LaneClk', 'pa0_laneclk');
  d = assignClock(d, cat, 'ofb0', 'CoreClk', 'pa0_laneclk');
  d = link(d, 'spp0.M_Link', 'ofb0.S_Vc[1]');
  return link(d, 'ofb0.M_Vc[1]', 'spp0.S_Link');
}

test('the adapter is the source of the lane clock domain and takes the lanes of the core', () => {
  let d = addInstance(createDesign('t'), cat, 'openfibre/ofb_pa_gty', { x: 0, y: 0 }).design;
  const lane = d.clockDomains.find((c) => c.source.kind === 'block');
  assert.deepEqual(lane, { id: 'pa0_laneclk', name: 'pa0 Lane clock', frequencyHz: 156.25e6, source: { kind: 'block', instance: 'pa0', port: 'LaneClk' } });
  assert.equal(cat.block('openfibre/ofb_pa_gty').vendor, 'AMD Versal GTY');
  d = node();
  d = setGeneric(d, cat, 'ofb0', 'NumLanes_g', 4).design;
  const r = resolve(cat, d);
  assert.equal(r.byId.get('pa0')?.generics.NumLanes_g, 4);
  assert.ok(r.byId.get('pa0')?.auto.includes('NumLanes_g'));
  assert.equal(r.byId.get('ofb0')?.generics.LaneClkFreq_g, 156.25e6, 'from the clock of the adapter');
  assert.deepEqual(r.checks.filter((c) => c.severity === 'error').map((c) => c.message), ['spp0.M_Rx[0] must be served: connect it or make it external.']);
  // the lane clock is a signal of the netlist, a port actual of both blocks
  const n = netlist(cat, d, r);
  const actual = (/** @type {string} */ inst, /** @type {string} */ port) => n.instances.find((i) => i.id === inst)?.ports.find((p) => p.name === port)?.actual;
  assert.equal(actual('pa0', 'LaneClk'), 'pa0_LaneClk_s');
  assert.equal(actual('ofb0', 'LaneClk'), 'pa0_LaneClk_s');
  assert.equal(actual('ofb0', 'CoreClk'), 'pa0_LaneClk_s');
  assert.ok(n.nets.some((x) => x.to === 'ofb0_Phy_BitSync_s' && x.from === 'pa0_Stat_Aligned_s'), 'bit synchronisation from the alignment status');
  // the serial lanes and the reference clock are top-level ports
  assert.deepEqual(n.ports.filter((p) => p.interface === 'pa0.Gt').map((p) => p.name), ['pa0_Gt_TxP', 'pa0_Gt_TxN', 'pa0_Gt_RxP', 'pa0_Gt_RxN', 'pa0_RefClk']);
});

test('the symbol streams cannot cross clock domains: the lane clock of the core comes from the adapter', () => {
  let d = createDesign('t');
  for (const b of ['openfibre/ofb_core', 'openfibre/ofb_pa_gty']) d = addInstance(d, cat, b, { x: 0, y: 0 }).design;
  d = link(d, 'ofb0.Phy', 'pa0.Phy');
  const r = resolve(cat, d);
  assert.ok(r.checks.some((c) => c.severity === 'error' && c.connection === 'c1'), r.checks.map((c) => c.message).join('\n'));
  d = assignClock(d, cat, 'ofb0', 'LaneClk', 'pa0_laneclk');
  assert.ok(!resolve(cat, d).checks.some((c) => c.severity === 'error' && c.connection === 'c1'));
});

test('OpenSPP sits directly on a virtual channel: width follows the lanes, user bit 0 is the EEP', () => {
  let d = node();
  let r = resolve(cat, d);
  assert.equal(r.byId.get('spp0')?.generics.DataWidth_g, 32);
  assert.deepEqual(r.chainOf.get('c2')?.adapters, []);
  // five user bits (EEP and destination index) into one: bit 0 connected, the others noted
  const notes = checksOf(r, 'signals');
  assert.deepEqual(notes.map((c) => [c.severity, c.message]), [
    ['info', 'spp0.M_Link has 5 user bits, ofb0.S_Vc[1] 1: bit 0 is connected, bits 4 to 1 are not used.'],
  ]);
  const n = netlist(cat, d, r);
  const users = n.nets.filter((x) => /S_Vc_TUser|S_Link_User/.test(x.to)).map((x) => `${x.to} <= ${x.from}`);
  assert.deepEqual(users, ['ofb0_S_Vc_TUser_s(1) <= spp0_M_Link_User_s(0)', 'spp0_S_Link_User_s(0) <= ofb0_M_Vc_TUser_s(1)', "ofb0_S_Vc_TUser_s(0) <= '0'"]);
  // two lanes: 64-bit beats
  d = setGeneric(d, cat, 'ofb0', 'NumLanes_g', 2).design;
  r = resolve(cat, d);
  assert.equal(r.byId.get('spp0')?.generics.DataWidth_g, 64);
  assert.deepEqual(r.chainOf.get('c2')?.adapters, []);
});

test('an RMAP target reaches a virtual channel through the N-Char adapter', () => {
  let d = node();
  d = addInstance(d, cat, 'openrmap/omap_core', { x: 0, y: 0 }, 'target').design;
  const chk = checkConnection(cat, d, 'rmap0.M_Pkt', 'ofb0.S_Vc[0]');
  assert.ok(!chk.ok);
  assert.equal(chk.bridge?.via, 'openspp/spp_nchar');
  d = addInstance(d, cat, 'openspp/spp_nchar', { x: 0, y: 0 }).design;
  for (const [a, b] of [['rmap0.M_Pkt', 'nchar0.S_NChar'], ['nchar0.M_NChar', 'rmap0.S_Pkt'], ['nchar0.M_Link', 'ofb0.S_Vc[0]'], ['ofb0.M_Vc[0]', 'nchar0.S_Link']]) d = link(d, a, b);
  const r = resolve(cat, d);
  assert.equal(r.byId.get('nchar0')?.generics.DataWidth_g, 32);
  // the adapter sends the EEP bit only; its receive side takes a destination index as well (tied to zero)
  assert.deepEqual(checksOf(r, 'signals').map((c) => c.message).sort(), [
    'ofb0.M_Vc[0] has 1 user bit, nchar0.S_Link 5: bit 0 is connected, bits 4 to 1 are tied to zero at nchar0.S_Link.',
    'spp0.M_Link has 5 user bits, ofb0.S_Vc[1] 1: bit 0 is connected, bits 4 to 1 are not used.',
  ]);
});

test('clock rules: the core clock is not slower than the lane clock, the user clock should not be', () => {
  let d = node();
  assert.deepEqual(checksOf(resolve(cat, d), 'clock_relation'), []);
  d = updateDomain(d, 'sys', { frequencyHz: 100e6 });
  let rel = checksOf(resolve(cat, d), 'clock_relation');
  assert.deepEqual(rel.map((c) => c.severity), ['warning']);
  assert.match(rel[0].message, /UserClk slower than LaneClk limits the throughput .* \(100 MHz and 156\.25 MHz\)/);
  d = assignClock(d, cat, 'ofb0', 'CoreClk', 'sys');
  rel = checksOf(resolve(cat, d), 'clock_relation');
  assert.deepEqual(rel.map((c) => c.severity).sort(), ['error', 'warning']);
  assert.ok(rel.some((c) => /CoreClk must run at least as fast as LaneClk/.test(c.message)));
  // the input VC buffer is a multiple of 64 x NumLanes_g words
  d = setGeneric(node(), cat, 'ofb0', 'VcInDepth_g', 96).design;
  assert.match(checksOf(resolve(cat, d), 'generic_multiple')[0]?.message ?? '', /VcInDepth_g = 96 must be a multiple of 64 \* NumLanes_g = 64/);
});

test('the clock crossings of the core get a maximum delay between every pair of its clock domains', () => {
  const r = resolve(cat, node());
  const md = r.constraints.filter((c) => c.kind === 'max_delay');
  assert.deepEqual(md.map((c) => [c.from, c.to, c.ns, c.datapathOnly]), [
    ['pa0.LaneClk', 'Clk_sys', 5, true],
    ['Clk_sys', 'pa0.LaneClk', 5, true],
  ]);
  assert.ok(!r.constraints.some((c) => c.kind === 'async_clock_groups'), 'no clock groups that would override them');
});

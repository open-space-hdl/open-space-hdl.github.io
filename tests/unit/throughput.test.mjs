// The throughput budget (model/throughput.js): the rate data of the catalog reproduces the measured figures of the
// cores, the paths of a system with their bottleneck, the limit of the path enumeration, the checks of stated traffic
// (path, split, shared element) and the stated traffic in the file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkConnection } from '../../assets/composer/js/model/compat.js';
import {
  addConnection, addDomain, addInstance, assignClock, createDesign, setExternal, setGeneric, setTraffic, sidebandDefaults,
  trafficFields, trafficFromFields,
} from '../../assets/composer/js/model/design.js';
import { resolve } from '../../assets/composer/js/model/resolver.js';
import { FormatError, fromText, toDocument, toText } from '../../assets/composer/js/model/serialize.js';
import { analyseThroughput, formatNumber, formatRate, pathAt } from '../../assets/composer/js/model/throughput.js';
import { Catalog } from '../../assets/composer/js/model/catalog.js';
import { loadCatalog, loadCatalogJson, ROOT } from './helpers.mjs';

const cat = loadCatalog();
/** @param {string} name */
const example = (name) => fromText(readFileSync(`${ROOT}assets/composer/examples/${name}.composer.json`, 'utf-8'), cat).design;

/**
 * @param {import('../../assets/composer/js/model/design.js').Design} d
 * @param {string} a
 * @param {string} b
 */
function link(d, a, b) {
  const c = checkConnection(cat, d, a, b);
  assert.ok(c.ok && c.from && c.to, c.reason);
  return addConnection(d, /** @type {string} */ (c.from), /** @type {string} */ (c.to), c.sideband ? sidebandDefaults(c.sideband) : undefined).design;
}

/** @param {import('../../assets/composer/js/model/design.js').Design} d */
const analyse = (d) => /** @type {import('../../assets/composer/js/model/throughput.js').Throughput} */ (resolve(cat, d).throughput);

test('rates and numbers are shown with three significant digits and an SI prefix', () => {
  assert.equal(formatRate(3.1030303e9), '3.10 Gbit/s');
  assert.equal(formatRate(79.968e6), '80.0 Mbit/s');
  assert.equal(formatRate(999.7e6), '1.00 Gbit/s');
  assert.equal(formatRate(950e3), '950 kbit/s');
  assert.equal(formatRate(18.67e9), '18.7 Gbit/s');
  assert.equal(formatNumber(264), '264');
  assert.equal(formatNumber(112.345), '112');
});

/**
 * Framer and core with the dense output (the chain formula of OpenCrypto, user guide 7.2 and TC-FR-08): the cycles of
 * the chain element for chunks of the given lengths.
 * @param {number} width
 * @param {number} chunk
 */
function framerChain(width, chunk) {
  let d = createDesign('chain');
  d = addInstance(d, cat, 'opencrypto/ocr_framer', { x: 0, y: 0 }).design;
  d = addInstance(d, cat, 'opencrypto/ocr_core', { x: 0, y: 0 }).design;
  d = setGeneric(d, cat, 'frm0', 'DataWidth_g', width).design;
  d = setGeneric(d, cat, 'frm0', 'ChunkBytes_g', chunk).design;
  d = setGeneric(d, cat, 'ocr0', 'DataWidth_g', width).design;
  d = setGeneric(d, cat, 'ocr0', 'DenseOutput_g', true).design;
  d = link(d, 'frm0.M_Out', 'ocr0.S_In');
  d = link(d, 'frm0.M_Ctx', 'ocr0.S_Ctx');
  d = setExternal(d, 'frm0.S_In', 'in_');
  d = setExternal(d, 'ocr0.M_Out', 'out_');
  const t = /** @type {import('../../assets/composer/js/model/throughput.js').Throughput} */ (resolve(cat, d).throughput);
  assert.equal(t.paths.length, 1);
  const p = t.paths[0];
  const k = p.elements.findIndex((el) => el.model === 'chain');
  assert.ok(k >= 0, 'the chain formula replaces the framer output and the core');
  return (/** @type {number} */ n) => /** @type {number} */ (p.at(n)?.elements[k].cycles);
}

test('the chain formula of the framer and the core reproduces TC-FR-08 at 16, 32, 64 and 128 bit', () => {
  // OpenCrypto, hdl/ocr_framer/docs/verification_report.md: four packets in 20 chunks (18 of C bytes, one of 5 and
  // one of 1 byte); the cycles of the 19 chunks after the first
  for (const [width, chunk, sum] of [[16, 32, 582], [32, 64, 429], [64, 1024, 2275], [128, 256, 333], [128, 4096, 4413]]) {
    const c = framerChain(width, chunk);
    assert.equal(17 * c(chunk) + c(5) + c(1), sum, `${width} bit, chunks of ${chunk} bytes`);
  }
  // user guide 7.2: C(4096)
  for (const [width, cycles] of [[16, 2064], [32, 1032], [64, 517], [128, 259]]) assert.equal(framerChain(width, 4096)(4096), cycles, `${width} bit`);
  // a packet longer than a chunk crosses the core as several chunks
  const c = framerChain(32, 1024);
  assert.equal(c(2048 + 100), 2 * c(1024) + c(100));
});

test('the chain formula applies to the framer and the core with the dense output, the bounds per interface without it', () => {
  let d = example('encrypted_spp_over_spw');
  const p = analyse(d).paths.find((x) => x.source.label.startsWith('pkt_'));
  const pt = p?.at(1024);
  assert.ok(p && pt);
  const c = p.elements.findIndex((el) => el.model === 'chain');
  assert.ok(c >= 0, 'the chain element replaces the output of the framer and the core');
  // C(1024) at 32 bit: 3 + 1 + 256 + 4 cycles (TC-FR-08), one cycle less than the bound of the dense output alone
  assert.equal(pt.elements[c].cycles, 264);
  d = setGeneric(d, cat, 'ocr0', 'DenseOutput_g', false).design;
  const q = analyse(d).paths.find((x) => x.source.label.startsWith('pkt_'));
  assert.ok(q && !q.elements.some((el) => el.model === 'chain'));
  const k = q.elements.findIndex((el) => el.label === 'ocr0.M_Out');
  // sectioned: IV, data and tag each start a beat: 3 + 257 + 4
  assert.equal(q.at(1024)?.elements[k].cycles, 264);
});

test('the link capacities of OpenWire and OpenFibre match their measurements', () => {
  // OpenWire TC-DL-40: 79.96 Mb/s at 100 Mb/s with packets of 1000 bytes, one direction
  let w = addInstance(createDesign('spw'), cat, 'openwire/owr_core', { x: 0, y: 0 }).design;
  const ld = addDomain(w, { name: 'Link clock', frequencyHz: 200e6 });
  w = assignClock(ld.design, cat, 'spw0', 'LinkClk', ld.id);
  w = setGeneric(w, cat, 'spw0', 'RunDiv_g', 2).design;
  w = setExternal(w, 'spw0.S_Pkt', 'tx_');
  const pw = analyse(w).paths.find((p) => p.sink.kind === 'link-out');
  const lw = pw?.at(1000);
  assert.ok(pw && lw);
  const kw = pw.elements.findIndex((el) => el.model === 'link');
  assert.equal(pw.elements[kw].node.both, false);
  assert.ok(Math.abs(8 * /** @type {number} */ (lw.elements[kw].capacity) - 79.968e6) < 1e3);
  // OpenFibre: 4 lanes at 156.25 MHz, packets of 1024 bytes, one direction: 18.7 Gbit/s
  let f = addInstance(createDesign('spfi'), cat, 'openfibre/ofb_core', { x: 0, y: 0 }).design;
  f = setGeneric(f, cat, 'ofb0', 'NumLanes_g', 4).design;
  const lane = addDomain(f, { name: 'Lane clock', frequencyHz: 156.25e6 });
  f = assignClock(lane.design, cat, 'ofb0', 'LaneClk', lane.id);
  f = setExternal(f, 'ofb0.S_Vc[0]', 'vc0_');
  const pf = analyse(f).paths.find((p) => p.sink.kind === 'link-out');
  const lf = pf?.at(1024);
  assert.ok(pf && lf);
  const kf = pf.elements.findIndex((el) => el.model === 'link');
  assert.equal(formatRate(8 * /** @type {number} */ (lf.elements[kf].capacity)), '18.7 Gbit/s');
});

test('a send port of OpenSPP at 32 bit and 100 MHz carries 3.15 Gbit/s of 1024-byte SDUs (260 cycles per packet)', () => {
  let d = addInstance(createDesign('spp'), cat, 'openspp/spp_core', { x: 0, y: 0 }).design;
  d = setGeneric(d, cat, 'spp0', 'DataWidth_g', 32).design;
  // CPTP without a target address: 1024 + 6 + 4 = 1034 bytes per packet on the link; 260 cycles is the bound of
  // OpenSPP (one more than the 259 measured in TC-CO-12)
  d = setGeneric(d, cat, 'spp0', 'SpwAddrBytes_g', 0).design;
  d = setExternal(d, 'spp0.S_Tx[0]', 'tx0_');
  d = setExternal(d, 'spp0.M_Link', 'link_');
  const p = analyse(d).paths.find((x) => x.sink.label.startsWith('link_'));
  const pt = p?.at(1024);
  assert.ok(p && pt);
  const k = p.elements.findIndex((el) => el.node.key === 'spp0.M_Link');
  assert.equal(pt.elements[k].cycles, 260);
  assert.equal(pt.bottleneck, k);
  assert.equal(formatRate(pt.bitsPerSecond), '3.15 Gbit/s');
});

test('the paths of an example, their bottleneck and the blocks without rate data', () => {
  const t = analyse(example('spacefibre_node'));
  assert.deepEqual(t.paths.map((p) => `${p.source.label} > ${p.sink.label}${p.split ? ' (split)' : ''}`), [
    'the link of ofb0 > rx0_ (spp0.M_Rx[0]) (split)',
    'tx0_ (spp0.S_Tx[0]) > the link of ofb0',
  ]);
  const tx = t.paths[1];
  assert.deepEqual(tx.references, [64, 1024, 4096]);
  assert.equal(tx.elements[/** @type {any} */ (tx.at(1024)).bottleneck].label, 'the link of ofb0');
  assert.deepEqual([...t.missing.values()], [{ entity: 'omap_core', labels: ['rmap0'] }]);
  assert.deepEqual(t.checks.filter((c) => c.rule === 'throughput').map((c) => c.message), ['No rate data for omap_core (rmap0): the paths through it are not checked.']);
  // without stated traffic no warning
  assert.ok(!t.checks.some((c) => c.severity === 'warning'));
});

test('the enumeration of paths stops at its limit and says so', () => {
  const d = example('spacefibre_node');
  const sc = /** @type {any} */ (resolve(cat, d));
  const t = analyseThroughput(cat, d, sc, { maxPaths: 1 });
  assert.equal(t.paths.length, 1);
  assert.equal(t.stopped, 1);
  assert.ok(t.checks.some((c) => c.severity === 'info' && c.message === 'Throughput analysis stopped after 1 paths (limit 1 paths or 2 s); the brief lists the paths analysed.'));
});

test('stated traffic: a path that sustains less, a split, and a shared element', () => {
  let d = example('spacefibre_node');
  d = setTraffic(d, 'spp0.S_Tx[0]', { packetBytes: 1024, bitsPerSecond: 5e9 });
  const over = analyse(d).checks.filter((c) => c.severity === 'warning');
  assert.deepEqual(over.map((c) => c.message), [
    'tx0_ (spp0.S_Tx[0]) needs 5.00 Gbit/s at 1024 B packets; the path tx0_ (spp0.S_Tx[0]) to the link of ofb0 sustains 4.46 Gbit/s at 1024 B packets, limited by the link of ofb0 (4.52 Gbit/s on the link at 1038 B packets, both directions in use). To meet it, raise the line rate of ofb0 or its lanes, or lower the rate.',
  ]);
  assert.equal(over[0].instance, 'ofb0');
  // within the capacity: no warning
  d = setTraffic(d, 'spp0.S_Tx[0]', { packetBytes: 1024, bitsPerSecond: 4e9 });
  assert.ok(!analyse(d).checks.some((c) => c.severity === 'warning'));
  // a sink behind a route with several outputs: the warning names the assumption
  let r = setTraffic(example('spacefibre_node'), 'spp0.M_Rx[0]', { packetBytes: 1024, bitsPerSecond: 5e9 });
  const split = analyse(r).checks.filter((c) => c.severity === 'warning');
  assert.equal(split.length, 1);
  assert.match(split[0].message, /^rx0_ \(spp0\.M_Rx\[0\]\) needs 5\.00 Gbit\/s at 1024 B packets; the path the link of ofb0 to rx0_ \(spp0\.M_Rx\[0\]\) delivers at most .* at 1024 B packets \(\d+ B at the source\), limited by the link of ofb0 .* Assuming every packet of the link of ofb0 reaches rx0_ \(spp0\.M_Rx\[0\]\)\.$/);
  // two send ports on one link: each fits alone, together they do not
  let s = setGeneric(example('spacefibre_node'), cat, 'spp0', 'NumTx_g', 2).design;
  s = setExternal(s, 'spp0.S_Tx[1]', 'tx1_');
  s = setTraffic(s, 'spp0.S_Tx[0]', { packetBytes: 1024, bitsPerSecond: 2.5e9 });
  s = setTraffic(s, 'spp0.S_Tx[1]', { packetBytes: 1024, bitsPerSecond: 2.5e9 });
  const shared = analyse(s).checks.filter((c) => c.severity === 'warning');
  assert.ok(shared.length >= 1, 'the shared link is reported');
  assert.ok(shared.every((c) => !c.message.includes('needs')), 'no single path is overloaded');
  assert.ok(shared.some((c) => c.message === 'the link of ofb0 carries tx0_ (spp0.S_Tx[0]) (2.50 Gbit/s at 1024 B packets, 56.1 % of its capacity) and tx1_ (spp0.S_Tx[1]) (2.50 Gbit/s at 1024 B packets, 56.1 % of its capacity): together 112 % of its capacity.'), shared.map((c) => c.message).join(' | '));
});

test('stated traffic is an optional key of an external interface, kept when the prefix changes', () => {
  const base = example('spw_rmap_node');
  const plain = toText(base, cat);
  assert.ok(!plain.includes('"traffic"'));
  let d = setTraffic(base, 'rmap0.M_Axi', { packetBytes: 512, bitsPerSecond: 1e8 });
  d = setExternal(d, 'rmap0.M_Axi', 'memory_');
  assert.deepEqual(d.externals.find((e) => e.interface === 'rmap0.M_Axi'), { interface: 'rmap0.M_Axi', prefix: 'memory_', traffic: { packetBytes: 512, bitsPerSecond: 1e8 } });
  const text = toText(d, cat);
  const doc = JSON.parse(text);
  assert.equal(doc.formatVersion, 1);
  assert.deepEqual(doc.externals.find((/** @type {any} */ e) => e.interface === 'rmap0.M_Axi'), { interface: 'rmap0.M_Axi', prefix: 'memory_', traffic: { packetBytes: 512, bitsPerSecond: 1e8 } });
  const back = fromText(text, cat);
  assert.deepEqual(back.warnings, []);
  assert.equal(toText({ ...back.design, layout: d.layout }, cat), text);
  // removed again: the file is the same as before
  assert.equal(toText(setExternal(setTraffic(d, 'rmap0.M_Axi', null), 'rmap0.M_Axi', 'mem_'), cat), plain);
  // wrong values are refused
  assert.throws(() => setTraffic(base, 'rmap0.M_Axi', { packetBytes: 0 }), /packetBytes must be a whole number/);
  assert.throws(() => setTraffic(base, 'spw0.S_Pkt', { packetBytes: 64 }), /is not external/);
  doc.externals[0].traffic = { packetBytes: 64, bitsPerSecond: -1 };
  assert.throws(() => fromText(JSON.stringify(doc), cat), (e) => e instanceof FormatError && /externals\[0\]\.traffic: bitsPerSecond must be a positive number/.test(e.message));
  assert.equal(/** @type {any} */ (toDocument(d, cat)).generator.version, '0.9.11-beta');
});

test('a path runs through the inside of a subsystem', () => {
  // a SpaceWire port as a subsystem: its packet input passes to the port inside, its link is the sink
  let port = addInstance(createDesign('port'), cat, 'openwire/owr_core', { x: 0, y: 0 }).design;
  const ld = addDomain(port, { name: 'Link clock', frequencyHz: 200e6 });
  port = assignClock(ld.design, cat, 'spw0', 'LinkClk', ld.id);
  port = setGeneric(port, cat, 'spw0', 'RunDiv_g', 2).design;
  port = setExternal(port, 'spw0.S_Pkt', 'tx_');
  let d = { ...createDesign('top'), subsystems: { port } };
  d = addInstance(d, cat, 'subsystem/port', { x: 0, y: 0 }).design;
  const top = addDomain(d, { name: 'Link clock', frequencyHz: 200e6 });
  d = assignClock(top.design, cat, 'port0', `Clk_${ld.id}`, top.id);
  d = setExternal(d, 'port0.tx', 'in_');
  d = setTraffic(d, 'port0.tx', { packetBytes: 1000, bitsPerSecond: 100e6 });
  const t = analyse(d);
  assert.deepEqual(t.paths.map((p) => `${p.source.label} > ${p.sink.label}`), ['in_ (port0.tx) > the link of port0/spw0']);
  assert.deepEqual(t.paths[0].elements.map((el) => el.label), ['port0/spw0.S_Pkt', 'the link of port0/spw0']);
  const w = t.checks.filter((c) => c.severity === 'warning');
  assert.equal(w.length, 1);
  assert.equal(w[0].message, 'in_ (port0.tx) needs 100 Mbit/s at 1000 B packets; the path in_ (port0.tx) to the link of port0/spw0 sustains 80.0 Mbit/s at 1000 B packets, limited by the link of port0/spw0 (80.0 Mbit/s on the link at 1000 B packets). To meet it, raise the line rate of spw0, or lower the rate.');
  // a check about an element inside a subsystem names no instance of the system
  assert.equal(w[0].instance, undefined);
});

test('rate data that cannot be evaluated is a finding with its reason, in the checks and in the brief', () => {
  // a lane count without a measured link efficiency (OpenFibre measured 1 to 4 lanes: here the one of 3 is removed)
  const measured = loadCatalogJson();
  for (const table of ['oneDirection', 'bothDirections']) delete measured.blocks.find((/** @type {any} */ b) => b.id === 'openfibre/ofb_core').rates.links[0].efficiency[table]['3'];
  const three = new Catalog(measured);
  let f = addInstance(createDesign('lanes3'), three, 'openfibre/ofb_core', { x: 0, y: 0 }).design;
  f = setGeneric(f, three, 'ofb0', 'NumLanes_g', 3).design;
  f = setGeneric(f, three, 'ofb0', 'VcInDepth_g', 384).design;
  f = setExternal(f, 'ofb0.S_Vc[0]', 'vc0_');
  const res = resolve(three, f);
  const t = /** @type {import('../../assets/composer/js/model/throughput.js').Throughput} */ (res.throughput);
  const text = 'Rate data of ofb0 (ofb_core) cannot be evaluated: no measured link efficiency for NumLanes_g = 3; the paths over this link are not computed.';
  assert.deepEqual(t.problems, [text]);
  assert.ok(res.checks.some((c) => c.severity === 'info' && c.rule === 'throughput' && c.message === text));
  const p = t.paths.find((x) => x.sink.kind === 'link-out');
  assert.equal(p?.at(1024), null);
  const brief = /** @type {any} */ (toDocument(f, three)).agent.brief;
  assert.ok(brief.includes(`- ${text}`));
  // with the efficiency of three lanes that OpenFibre measured, the path is computed
  assert.deepEqual(/** @type {any} */ (resolve(cat, setGeneric(f, cat, 'ofb0', 'NumLanes_g', 3).design).throughput).problems, []);
  // a variable of the rate data that cannot be evaluated
  const json = loadCatalogJson();
  json.blocks.find((/** @type {any} */ b) => b.id === 'openfibre/ofb_core').rates.vars.B = '4 * NoSuchGeneric_g';
  const broken = new Catalog(json);
  let g = addInstance(createDesign('broken'), broken, 'openfibre/ofb_core', { x: 0, y: 0 }).design;
  g = setExternal(g, 'ofb0.S_Vc[0]', 'vc0_');
  const problems = /** @type {any} */ (resolve(broken, g).throughput).problems;
  assert.ok(problems.some((/** @type {string} */ x) => /^Rate data of ofb0 \(ofb_core\) cannot be evaluated: variable B: .*NoSuchGeneric_g.*; the paths through it are not computed\.$/.test(x)), problems.join('\n'));
});

test('the fields of the editor convert Mbit/s to the bit/s of the file and back, in one place', () => {
  for (const [mbit, bps] of /** @type {[string, number][]} */ ([['1600', 1.6e9], ['1234.5', 1234500000], ['0.3', 300000], ['4000', 4e9], ['0.000001', 1]])) {
    const r = trafficFromFields('1024', mbit);
    assert.ok('traffic' in r && r.traffic, mbit);
    assert.deepEqual(r.traffic, { packetBytes: 1024, bitsPerSecond: bps }, mbit);
    assert.deepEqual(trafficFields(r.traffic), { bytes: '1024', mbit, max: '' }, mbit);
  }
  // through the file: the value written is bit/s, read back it shows the same Mbit/s
  const r = /** @type {{ traffic: import('../../assets/composer/js/model/design.js').Traffic }} */ (trafficFromFields(' 512 ', '1600'));
  const d = setTraffic(example('spacefibre_node'), 'spp0.S_Tx[0]', r.traffic);
  const doc = JSON.parse(toText(d, cat));
  assert.deepEqual(doc.externals.find((/** @type {any} */ e) => e.interface === 'spp0.S_Tx[0]').traffic, { packetBytes: 512, bitsPerSecond: 1600000000 });
  const back = fromText(JSON.stringify(doc), cat).design.externals.find((e) => e.interface === 'spp0.S_Tx[0]')?.traffic;
  assert.deepEqual(trafficFields(back), { bytes: '512', mbit: '1600', max: '' });
  // a length without a rate, nothing, and wrong input
  assert.deepEqual(trafficFromFields('64', ''), { traffic: { packetBytes: 64 } });
  assert.deepEqual(trafficFields({ packetBytes: 64 }), { bytes: '64', mbit: '', max: '' });
  assert.deepEqual(trafficFromFields('', ''), { traffic: null });
  assert.deepEqual(trafficFields(undefined), { bytes: '', mbit: '', max: '' });
  assert.deepEqual(trafficFromFields('', '100'), { error: 'Give the packet length in whole bytes.' });
  assert.deepEqual(trafficFromFields('10.5', ''), { error: 'Give the packet length in whole bytes.' });
  assert.deepEqual(trafficFromFields('64', '-1'), { error: 'Give the rate in Mbit/s, above zero, or leave it empty.' });
});

test('the limits of stated traffic give the checks and the bottleneck marker from one analysis', () => {
  const d = setTraffic(example('spacefibre_node'), 'spp0.S_Tx[0]', { packetBytes: 1024, bitsPerSecond: 5e9 });
  const res = resolve(cat, d);
  const t = /** @type {import('../../assets/composer/js/model/throughput.js').Throughput} */ (res.throughput);
  assert.equal(t.limits.length, 1);
  const warning = res.checks.find((c) => c.rule === 'throughput' && c.severity === 'warning');
  assert.equal(warning?.message, t.limits[0].message);
  assert.deepEqual([...t.bottlenecks], [['ofb0', t.limits[0].message]]);
  // the length the editor shows a path at: the stated one, else 1024 bytes
  const p = t.paths.find((x) => x.source.key === 'spp0.S_Tx[0]');
  assert.ok(p);
  assert.deepEqual([pathAt(t, p).bytes, pathAt(t, p).stated], [1024, true]);
  const q = t.paths.find((x) => x.sink.key === 'spp0.M_Rx[0]');
  assert.ok(q);
  assert.deepEqual([pathAt(t, q).bytes, pathAt(t, q).stated], [1024, false]);
  assert.equal(pathAt(t, q).point, q.at(1024));
});

test('a FIFO passes one word per cycle and the packet FIFO one stall cycle per packet on its output', () => {
  let d = addInstance(createDesign('fifo'), cat, 'openspp/spp_core', { x: 0, y: 0 }).design;
  d = setGeneric(d, cat, 'spp0', 'SpwAddrBytes_g', 0).design;
  for (const b of ['olo/olo_ft_fifo_sync', 'olo/olo_ft_fifo_packet']) d = addInstance(d, cat, b, { x: 0, y: 0 }).design;
  d = setExternal(d, 'spp0.S_Link', 'link_');
  d = link(d, 'spp0.M_Rx[0]', 'fifo0.In');
  d = link(d, 'fifo0.Out', 'pfifo0.In');
  d = setExternal(d, 'pfifo0.Out', 'out_');
  const t = analyse(d);
  assert.deepEqual(t.paths.map((p) => `${p.source.label} > ${p.sink.label}`), ['link_ (spp0.S_Link) > out_ (pfifo0.Out)']);
  assert.deepEqual([...t.missing.values()], []);
  const p = t.paths[0];
  // a link packet of 1034 bytes holds an SDU of 1024 bytes (CPTP header of 4 bytes, Space Packet header of 6): 256
  // beats of 32 bits through both FIFOs, one cycle more per packet at the output of the packet FIFO
  const pt = p.at(1034);
  assert.ok(pt);
  const cycles = (/** @type {string} */ key) => pt.elements[p.elements.findIndex((el) => el.node.key === key)].cycles;
  assert.deepEqual(['fifo0.In', 'fifo0.Out', 'pfifo0.In', 'pfifo0.Out'].map(cycles), [256, 256, 256, 257]);
});

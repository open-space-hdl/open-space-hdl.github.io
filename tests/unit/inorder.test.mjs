// @ts-check
// Routes that deliver to their outputs one packet at a time in the order of arrival (the receive ports of OpenSPP):
// the rate of the outputs together, in order and with a store of two packets behind every output, and the warning.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Catalog } from '../../assets/composer/js/model/catalog.js';
import { checkConnection } from '../../assets/composer/js/model/compat.js';
import {
  addInstance, assignClock, createDesign, renameDomain, setExternal, setGeneric, setInstanceTraffic, updateDomain,
} from '../../assets/composer/js/model/design.js';
import { resolve } from '../../assets/composer/js/model/resolver.js';
import { toDocument } from '../../assets/composer/js/model/serialize.js';
import { formatRate } from '../../assets/composer/js/model/throughput.js';
import { connect, loadCatalogJson } from './helpers.mjs';

/**
 * The catalog, which states the route of the receive ports of OpenSPP in order and the FIFO storing Depth_g beats;
 * without either key on request.
 * @param {{ inOrder?: boolean, holds?: boolean }} [o]
 */
function inOrderCatalog(o = {}) {
  const json = loadCatalogJson();
  const spp = json.blocks.find((/** @type {any} */ b) => b.id === 'openspp/spp_core');
  const fifo = json.blocks.find((/** @type {any} */ b) => b.id === 'olo/olo_ft_fifo_sync');
  assert.equal(spp.rates.routes.find((/** @type {any} */ r) => r.to === 'M_Rx').inOrder, true);
  assert.equal(fifo.rates.routes[0].holds, 'Depth_g');
  if (o.inOrder === false) for (const r of spp.rates.routes) delete r.inOrder;
  if (o.holds === false) delete fifo.rates.routes[0].holds;
  return new Catalog(json);
}

/**
 * @param {Catalog} cat
 * @param {import('../../assets/composer/js/model/design.js').Design} d
 * @param {string} a
 * @param {string} b
 */
function link(cat, d, a, b) {
  const chk = checkConnection(cat, d, a, b);
  assert.ok(chk.ok, `${a} - ${b}: ${chk.reason}`);
  return connect(d, chk);
}

/**
 * @param {Catalog} cat
 * @param {import('../../assets/composer/js/model/design.js').Design} d
 */
const analyse = (cat, d) => /** @type {import('../../assets/composer/js/model/throughput.js').Throughput} */ (resolve(cat, d).throughput);

/** @param {import('../../assets/composer/js/model/throughput.js').Throughput} t */
const warnings = (t) => t.checks.filter((c) => c.rule === 'throughput' && c.severity === 'warning').map((c) => c.message);

/**
 * Two compression channels (configuration c01, assumed ratio 2) behind the receive ports of OpenSPP at 32 bits and
 * 100 MHz, the link from the top level; a FIFO of the given depth behind every port.
 * @param {Catalog} cat
 * @param {number} [depth]
 */
function twoChannels(cat, depth) {
  let d = addInstance(createDesign('t'), cat, 'openspp/spp_core', { x: 0, y: 0 }).design;
  d = setGeneric(d, cat, 'spp0', 'NumRx_g', 2).design;
  // CPTP without a target address: a link packet of 1034 bytes holds an SDU of 1024 bytes
  d = setGeneric(d, cat, 'spp0', 'SpwAddrBytes_g', 0).design;
  d = setExternal(d, 'spp0.S_Link', 'link_');
  for (const k of [0, 1]) {
    d = addInstance(d, cat, 'opencompact/ocp_channel', { x: 0, y: 0 }, 'lossless_bip').design;
    for (const [g, v] of Object.entries({ XSize_g: 32, YSize_g: 12, ZSize_g: 16 })) d = setGeneric(d, cat, `och${k}`, g, v).design;
    d = setInstanceTraffic(d, cat, `och${k}`, { ratio: 2 });
    if (depth) {
      d = addInstance(d, cat, 'olo/olo_ft_fifo_sync', { x: 0, y: 0 }).design;
      d = setGeneric(d, cat, `fifo${k}`, 'Depth_g', depth).design;
      d = link(cat, d, `spp0.M_Rx[${k}]`, `fifo${k}.In`);
      d = link(cat, d, `fifo${k}.Out`, `och${k}.In`);
    } else {
      d = link(cat, d, `spp0.M_Rx[${k}]`, `och${k}.In`);
    }
    d = setExternal(d, `och${k}.Out`, `img${k}_`);
  }
  return d;
}

test('two compression channels behind the receive ports of OpenSPP are served one after another', () => {
  const cat = inOrderCatalog();
  const t = analyse(cat, twoChannels(cat));
  assert.equal(t.inOrder.length, 1);
  const r = t.inOrder[0];
  assert.deepEqual([r.label, r.outputs, r.paths], ['spp0', ['spp0.M_Rx[0]', 'spp0.M_Rx[1]'], [0, 1]]);
  // an SDU of 1024 bytes: the delivery takes 259 cycles, a channel 513 (its samples one per cycle, plus one); the two
  // channels in order 513 cycles per SDU, decoupled the 260 cycles of the link input
  const pt = r.at(1034);
  assert.ok(pt);
  assert.deepEqual(pt.outputs.map((o) => [o.holdBy, Math.round(o.hold * 1e8), Math.round(o.delivery * 1e8)]), [['och0.In', 513, 259], ['och1.In', 513, 259]]);
  assert.deepEqual([formatRate(pt.inOrder), formatRate(pt.decoupled), pt.limit], ['1.61 Gbit/s', '3.18 Gbit/s', 'link_ (spp0.S_Link)']);
  assert.deepEqual(warnings(t), [
    'spp0 delivers the packets of its outputs M_Rx[0] and M_Rx[1] one after another in the order of arrival: a packet holds the delivery until its output has taken it. At 4100 B, spread evenly over the outputs, they deliver together 1.60 Gbit/s instead of 3.20 Gbit/s: och0.In takes 20.5 µs per packet, the delivery 10.3 µs. Place a FIFO that holds two of the longest packets of the output behind every slower output (M_Rx[0] and M_Rx[1]): olo_ft_fifo_sync with Depth_g of at least 2046 beats of 4 bytes for packets of 4090 bytes.',
  ]);
  assert.equal(t.checks.find((c) => c.message.startsWith('spp0 delivers'))?.instance, 'spp0');
  // the brief shows both rates of the outputs together at the reference lengths
  const brief = String(/** @type {any} */ (toDocument(twoChannels(cat), cat)).agent.brief);
  assert.match(brief, /\n\| In order \| [^\n]*\| 1\.60 Gbit\/s \|\n\| With a store of two packets behind every output \| [^\n]*\| 3\.20 Gbit\/s \|\n/);
});

test('a FIFO that holds two packets behind every port lets the channels run in parallel', () => {
  const cat = inOrderCatalog();
  const t = analyse(cat, twoChannels(cat, 2046));
  const pt = t.inOrder[0].at(1034);
  assert.ok(pt);
  assert.deepEqual([formatRate(pt.inOrder), formatRate(pt.decoupled)], ['3.18 Gbit/s', '3.18 Gbit/s']);
  assert.deepEqual(warnings(t), []);
  // without the depth of the FIFO in the rate data the FIFO is no store
  const plain = inOrderCatalog({ holds: false });
  assert.equal(warnings(analyse(plain, twoChannels(plain, 2046))).length, 1);
});

test('a FIFO that holds one packet does not decouple the ports', () => {
  const cat = inOrderCatalog();
  const t = analyse(cat, twoChannels(cat, 1023));
  assert.equal(warnings(t).length, 1);
  assert.match(warnings(t)[0], /^spp0 delivers the packets of its outputs M_Rx\[0\] and M_Rx\[1\] one after another/);
});

test('receive ports whose sinks take every packet at the rate of the delivery give no warning', () => {
  const cat = inOrderCatalog();
  let d = addInstance(createDesign('t'), cat, 'openspp/spp_core', { x: 0, y: 0 }).design;
  d = setGeneric(d, cat, 'spp0', 'NumRx_g', 2).design;
  d = setExternal(d, 'spp0.S_Link', 'link_');
  d = setExternal(setExternal(d, 'spp0.M_Rx[0]', 'rx0_'), 'spp0.M_Rx[1]', 'rx1_');
  const t = analyse(cat, d);
  assert.equal(t.inOrder.length, 1);
  for (const b of t.inOrder[0].references) {
    const pt = t.inOrder[0].at(b);
    assert.ok(pt);
    assert.equal(pt.inOrder, pt.decoupled, `at ${b} B`);
  }
  assert.deepEqual(warnings(t), []);
  // a route without inOrder: no analysis of the outputs together
  const plain = inOrderCatalog({ inOrder: false });
  assert.deepEqual(analyse(plain, twoChannels(plain)).inOrder, []);
});

/**
 * The data path of the reference system spfi_compress_encrypt: a SpaceFibre port at 4 lanes with its GTY adapter,
 * OpenSPP at 128 bits and 200 MHz, four compression channels in four configurations (64 x 64 x 48 samples of 16 bits,
 * no assumed ratio), each followed by a framer and an AES-GCM core back to a send port; optionally a FIFO of 1024
 * beats behind every receive port.
 * @param {Catalog} cat
 * @param {boolean} fifos
 */
function compressEncrypt(cat, fifos) {
  let d = createDesign('spfi_compress_encrypt');
  for (const [b, preset] of [['openfibre/ofb_core'], ['openfibre/ofb_pa_gty'], ['openspp/spp_core']]) d = addInstance(d, cat, /** @type {string} */ (b), { x: 0, y: 0 }, preset).design;
  d = updateDomain(d, 'sys', { frequencyHz: 200e6 });
  for (const [g, v] of Object.entries({ NumVc_g: 2, NumLanes_g: 4, VcInDepth_g: 1024, LaneStart_g: true })) d = setGeneric(d, cat, 'ofb0', g, v).design;
  for (const [g, v] of Object.entries({ NumTx_g: 4, NumRx_g: 4, TxBufferBytes_g: 8192, RxBufferBytes_g: 8192 })) d = setGeneric(d, cat, 'spp0', g, v).design;
  d = link(cat, d, 'spp0.M_Link', 'ofb0.S_Vc[1]');
  d = link(cat, d, 'ofb0.M_Vc[1]', 'spp0.S_Link');
  d = link(cat, d, 'ofb0.Phy', 'pa0.Phy');
  d = renameDomain(d, 'pa0_laneclk', 'lane');
  d = assignClock(d, cat, 'ofb0', 'LaneClk', 'lane');
  d = assignClock(d, cat, 'ofb0', 'CoreClk', 'lane');
  ['lossless_bip', 'lossless_bsq', 'lossless_bip_block', 'near_lossless_bil'].forEach((preset, k) => {
    d = addInstance(d, cat, 'opencompact/ocp_channel', { x: 0, y: 0 }, preset).design;
    const ocp = `och${k}`;
    for (const [g, v] of Object.entries({ XSize_g: 64, YSize_g: 64, ZSize_g: 48, OutWidth_g: 32, UserLastMask_g: '22x"3FC000"', UserLastValue_g: '22x"004000"', UserErrorMask_g: '22x"003000"' })) {
      d = setGeneric(d, cat, ocp, g, v).design;
    }
    for (const b of ['opencrypto/ocr_framer', 'opencrypto/ocr_core']) d = addInstance(d, cat, b, { x: 0, y: 0 }).design;
    for (const [g, v] of Object.entries({ DenseOutput_g: true, ReleaseBuffer_g: true, ReleaseBytes_g: 16384, DataWidth_g: 128 })) d = setGeneric(d, cat, `ocr${k}`, g, v).design;
    if (fifos) {
      d = addInstance(d, cat, 'olo/olo_ft_fifo_sync', { x: 0, y: 0 }).design;
      d = setGeneric(d, cat, `fifo${k}`, 'Depth_g', 1024).design;
      d = link(cat, d, `spp0.M_Rx[${k}]`, `fifo${k}.In`);
      d = link(cat, d, `fifo${k}.Out`, `${ocp}.In`);
    } else {
      d = link(cat, d, `spp0.M_Rx[${k}]`, `${ocp}.In`);
    }
    d = link(cat, d, `${ocp}.Out`, `frm${k}.S_In`);
    d = link(cat, d, `frm${k}.M_Ctx`, `ocr${k}.S_Ctx`);
    d = link(cat, d, `frm${k}.M_Out`, `ocr${k}.S_In`);
    d = link(cat, d, `ocr${k}.M_Out`, `spp0.S_Tx[${k}]`);
  });
  return d;
}

test('spfi_compress_encrypt: the four channels in order at 2.68 Gbit/s, with a FIFO of 1024 beats per port at 7.74 Gbit/s', () => {
  const cat = inOrderCatalog();
  const before = analyse(cat, compressEncrypt(cat, false));
  assert.equal(before.paths.length, 4);
  const pt = before.inOrder[0].at(8186);
  assert.ok(pt);
  // the slowest element behind every port: the output of the compressor at the bound of its compressed image
  // (ocp0, ocp1, ocp3) or its input (ocp2); in order their mean, decoupled a quarter of the slowest
  assert.deepEqual(pt.outputs.map((o) => [o.holdBy, (o.hold * 1e6).toFixed(1)]), [['och0.Out', '21.7'], ['och1.Out', '21.7'], ['och2.In', '20.4'], ['och3.Out', '33.9']]);
  assert.deepEqual([formatRate(pt.inOrder), formatRate(pt.decoupled), pt.limit], ['2.68 Gbit/s', '7.74 Gbit/s', 'och3.Out']);
  assert.deepEqual(warnings(before).map((m) => m.split(':')[0]), ['spp0 delivers the packets of its outputs M_Rx[0], M_Rx[1], M_Rx[2] and M_Rx[3] one after another in the order of arrival']);
  assert.match(warnings(before)[0], /olo_ft_fifo_sync with Depth_g of at least 1024 beats of 16 bytes for packets of 8182 bytes\.$/);
  const after = analyse(cat, compressEncrypt(cat, true));
  const fixed = after.inOrder[0].at(8186);
  assert.ok(fixed);
  assert.deepEqual([formatRate(fixed.inOrder), formatRate(fixed.decoupled)], ['7.74 Gbit/s', '7.74 Gbit/s']);
  assert.deepEqual(warnings(after), []);
});

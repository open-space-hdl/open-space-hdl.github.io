// Packet sizes and buffers along the chain (model/sizes.js): the findings that chain_fits gave, now from the general
// size data; every suggested value passes the rules of its generic; hard limits and reset values of a register; a source
// with and without a stated largest packet; the brief; maxPacketBytes in the file.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkConnection } from '../../assets/composer/js/model/compat.js';
import {
  addConnection, addInstance, createDesign, setExternal, setGeneric, setTraffic, sidebandDefaults, trafficFields,
  trafficFromFields,
} from '../../assets/composer/js/model/design.js';
import { resolve } from '../../assets/composer/js/model/resolver.js';
import { FormatError, fromText, toDocument, toText } from '../../assets/composer/js/model/serialize.js';
import { loadCatalog, ROOT } from './helpers.mjs';

const cat = loadCatalog();

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

/** The size findings of a design: severity, instance and message. */
const sizes = (/** @type {import('../../assets/composer/js/model/design.js').Design} */ d) => resolve(cat, d).checks
  .filter((c) => c.rule === 'sizes')
  .map((c) => `${c.severity} [${c.instance ?? ''}] ${c.message}`)
  .sort();

/** The framer, the core and a send port: the chain of the former rule chain_fits. */
function chain() {
  let d = createDesign('chain');
  for (const b of ['opencrypto/ocr_framer', 'opencrypto/ocr_core', 'openspp/spp_core']) d = addInstance(d, cat, b, { x: 0, y: 0 }).design;
  d = link(d, 'frm0.M_Ctx', 'ocr0.S_Ctx');
  d = link(d, 'frm0.M_Out', 'ocr0.S_In');
  d = link(d, 'ocr0.M_Out', 'spp0.S_Tx[0]');
  return setGeneric(d, cat, 'ocr0', 'DenseOutput_g', true).design;
}

const INFO_4134 = 'info [spp0] spp0 sends Space Packets of up to ChunkBytes_g + 38 = 4134 bytes: the node that receives them needs RxBufferBytes_g of at least 4134 (spp0 has 4096, too small to receive its own packets).';

test('every finding of the former rule chain_fits comes from the size data, with the same text and numbers', () => {
  // the one change: the suggested size passes the rules of TxBufferBytes_g (DataWidth_g / 8 times a power of two)
  let d = chain();
  assert.deepEqual(sizes(d), [
    'error [spp0] frm0: every message of frm0 leaves ocr0 with ChunkBytes_g + 32 = 4128 bytes; spp0.S_Tx[0] must hold one: set TxBufferBytes_g of spp0 to 8192, the smallest value of at least 4128 that TxBufferBytes_g allows (now 4096).',
    INFO_4134,
  ]);
  d = setGeneric(d, cat, 'spp0', 'TxBufferBytes_g', 8192).design;
  assert.deepEqual(sizes(d), [INFO_4134]);
  d = setGeneric(d, cat, 'ocr0', 'ReleaseBuffer_g', true).design;
  assert.deepEqual(sizes(d), [
    'error [ocr0] frm0: every message of frm0 takes 12 + 4 + 4096 + 16 bytes in sections of whole beats (12 + 4 + ChunkBytes_g + 16), 1032 beats of 4 bytes in the release buffer of ocr0, which holds 4096 / 4 = 1024 beats: every message would be dropped with OVERFLOW. Set ReleaseBytes_g to 8192, the smallest power of two of at least 1032 beats (16384 for the full rate).',
    INFO_4134,
  ]);
  d = setGeneric(d, cat, 'ocr0', 'ReleaseBytes_g', 8192).design;
  assert.deepEqual(sizes(d), [
    INFO_4134,
    'warning [ocr0] frm0: every message of frm0 takes 12 + 4 + 4096 + 16 bytes in sections of whole beats (12 + 4 + ChunkBytes_g + 16), 1032 beats of 4 bytes in the release buffer of ocr0, which holds 8192 / 4 = 2048 beats: it holds one message but not two, so ocr0 needs 3 x 1032 - 2048 + 4 = 1052 cycles per message instead of 1033 (1.8 % less throughput). Set ReleaseBytes_g to 16384 for the full rate.',
  ]);
  d = setGeneric(d, cat, 'ocr0', 'ReleaseBytes_g', 16384).design;
  assert.deepEqual(sizes(d), [INFO_4134]);
  d = setGeneric(setGeneric(d, cat, 'frm0', 'ChunkBytes_g', 65520).design, cat, 'spp0', 'TxBufferBytes_g', 131072).design;
  assert.deepEqual(sizes(d), [
    'error [frm0] frm0: every message of frm0 leaves ocr0 with ChunkBytes_g + 32 = 65552 bytes, more than the 65536 bytes spp0.S_Tx[0] can carry in one packet.',
    'error [ocr0] frm0: every message of frm0 takes 12 + 4 + 65520 + 16 bytes in sections of whole beats (12 + 4 + ChunkBytes_g + 16), 16388 beats of 4 bytes in the release buffer of ocr0, which holds 16384 / 4 = 4096 beats: every message would be dropped with OVERFLOW. Set ReleaseBytes_g to 131072, the smallest power of two of at least 16388 beats (262144 for the full rate).',
    'info [spp0] spp0 sends Space Packets of up to ChunkBytes_g + 38 = 65558 bytes: the node that receives them needs RxBufferBytes_g of at least 65558 (spp0 has 4096, too small to receive its own packets).',
  ]);
});

test('every suggested value, applied, passes the checks', () => {
  let d = chain();
  // 8192 for the send buffer
  d = setGeneric(d, cat, 'spp0', 'TxBufferBytes_g', 8192).design;
  assert.ok(!sizes(d).some((x) => x.startsWith('error')));
  // the release buffer: 8192 for one message, 16384 for the full rate
  d = setGeneric(d, cat, 'ocr0', 'ReleaseBuffer_g', true).design;
  d = setGeneric(d, cat, 'ocr0', 'ReleaseBytes_g', 8192).design;
  assert.ok(!sizes(d).some((x) => x.startsWith('error')));
  assert.deepEqual(resolve(cat, d).checks.filter((c) => c.severity === 'error' && /ReleaseBytes_g|TxBufferBytes_g/.test(c.message)), [], 'the suggestions pass every other rule of their generics');
  d = setGeneric(d, cat, 'ocr0', 'ReleaseBytes_g', 16384).design;
  assert.ok(!sizes(d).some((x) => x.startsWith('warning')));
});

/** A send and receive node alone, its receive link packets from outside with the given traffic. */
function receiver(/** @type {import('../../assets/composer/js/model/design.js').Traffic} */ traffic) {
  let d = addInstance(createDesign('rx'), cat, 'openspp/spp_core', { x: 0, y: 0 }).design;
  d = setExternal(d, 'spp0.S_Link', 'link_');
  return setTraffic(d, 'spp0.S_Link', traffic);
}

test('a stated largest packet against a fixed limit (error) and a reset value of a register (warning)', () => {
  let d = receiver({ packetBytes: 1000, maxPacketBytes: 9000 });
  const hard = sizes(d).filter((x) => x.startsWith('error'));
  assert.deepEqual(hard, [
    'error [spp0] Every message of link_ (spp0.S_Link) has up to 9000 bytes (its stated largest packet); spp0.S_Link must hold one: set RxBufferBytes_g of spp0 to 16384, the smallest value of at least 8996 that RxBufferBytes_g allows (now 4096).',
  ]);
  // the suggestion passes
  d = setGeneric(d, cat, 'spp0', 'RxBufferBytes_g', 16384).design;
  assert.deepEqual(sizes(d).filter((x) => !x.startsWith('info')), []);
  // MaxLength_g is only the reset value of MAX_LENGTH: a warning that names the fixed limit behind it
  d = setGeneric(d, cat, 'spp0', 'MaxLength_g', 4096).design;
  assert.deepEqual(sizes(d).filter((x) => !x.startsWith('info')), [
    'warning [spp0] Every message of link_ (spp0.S_Link) has up to 9000 bytes (its stated largest packet); spp0.S_Link discards packets longer than 4100 bytes: MaxLength_g = 4096 is the reset value of MAX_LENGTH, which software can raise up to min(RxBufferBytes_g, 65542) = 16384. Set MaxLength_g of spp0 to 8996, or raise MAX_LENGTH by software.',
  ]);
  d = setGeneric(d, cat, 'spp0', 'MaxLength_g', 8996).design;
  assert.deepEqual(sizes(d).filter((x) => !x.startsWith('info')), []);
});

test('a source without a stated largest packet meets the first limit as a remark; the typical length never bounds it', () => {
  const d = receiver({ packetBytes: 100000 });
  assert.deepEqual(sizes(d).filter((x) => x.includes('link_')), [
    'info [spp0] Packets from link_ (spp0.S_Link) reach spp0.S_Link, which takes at most 4100 bytes: the receive buffer holds the longest Space Packet (error code 0x17); longer ones are discarded.',
  ]);
  const t = /** @type {any} */ (resolve(cat, d).throughput);
  assert.equal(t.sizes.largest.get('spp0.S_Link').bytes, Infinity);
});

test('the brief lists the largest packets, the buffers, what leaves over a link and the blocks without a limit', () => {
  const brief = readFileSync(`${ROOT}tests/golden/encrypted_spp_over_spw.brief.md`, 'utf-8');
  const section = brief.slice(brief.indexOf('## 7. Packet sizes and buffers'), brief.indexOf('## 8.'));
  assert.match(section, /\| `spp0\.S_Tx\[0\]` \| ChunkBytes_g \+ 32 = 4128 B \| 8192 B \| fixed \| the send buffer holds the longest SDU of the port \(error code 0x01\) \|/);
  assert.match(section, /\| `spp0\.S_Link` \| not bounded \(the link of spw0\) \| 65546 B \| reset value \|/);
  assert.match(section, /- `ocr0\.M_Out`: the longest message \(ChunkBytes_g \+ 32 = 4128 B\) takes 1032 beats of 4 B; the buffer holds 16384 B = 4096 beats\./);
  assert.match(section, /- spp0 sends Space Packets of up to ChunkBytes_g \+ 38 = 4134 bytes\./);
  assert.match(section, /- `owr_core` \(`spw0`\): no length limit, tested up to 1000 B\./);
  assert.match(section, /- `spp_nchar` \(`nchar0`\)\./);
  // the evidence of the size data of every block in the system that has them
  assert.match(section, /Evidence of the size data:\n\n- `ocr_core`: [^\n]*TC-CO-16 \(hdl\/ocr_core\/docs\/verification_report\.md\)\.\n- `ocr_framer`: /);
  assert.ok(!/Evidence of the size data:[^#]*spp_nchar/.test(section), 'a block without size data has no evidence line');
});

test('behind a block without rate data the packets are not bounded, named by its output, and the block is listed', () => {
  // the receive link of OpenSPP is fed through the pass-through port of the RMAP target, which has no rate and size data
  const brief = readFileSync(`${ROOT}tests/golden/spp_over_spw.brief.md`, 'utf-8');
  const section = brief.slice(brief.indexOf('## 7. Packet sizes and buffers'), brief.indexOf('## 8.'));
  assert.match(section, /\| `spp0\.S_Link` \| not bounded \(rmap0\.M_User\) \| 4100 B \| fixed \|/);
  assert.match(section, /Blocks that publish no length limit[^\n]*\n\n- `omap_core` \(`rmap0`\)\.\n- `spp_nchar` \(`nchar0`\)\./);
  assert.match(brief, /- Note: Packets from rmap0\.M_User reach spp0\.S_Link, which takes at most 4100 bytes: the receive buffer holds the longest Space Packet \(error code 0x17\); longer ones are discarded\./);
});

test('the largest packet is an optional key of the stated traffic, written only when set', () => {
  assert.deepEqual(trafficFromFields('1024', '', '4096'), { traffic: { packetBytes: 1024, maxPacketBytes: 4096 } });
  assert.deepEqual(trafficFields({ packetBytes: 1024, maxPacketBytes: 4096 }), { bytes: '1024', mbit: '', max: '4096' });
  assert.deepEqual(trafficFromFields('1024', '', '512'), { error: 'Give the largest packet in whole bytes, at least the packet length, or leave it empty.' });
  const d = receiver({ packetBytes: 1000, maxPacketBytes: 2000 });
  const text = toText(d, cat);
  const doc = JSON.parse(text);
  assert.equal(doc.formatVersion, 1);
  assert.deepEqual(doc.externals[0].traffic, { packetBytes: 1000, maxPacketBytes: 2000 });
  assert.equal(toText({ ...fromText(text, cat).design, layout: d.layout }, cat), text);
  doc.externals[0].traffic.maxPacketBytes = 10;
  assert.throws(() => fromText(JSON.stringify(doc), cat), (e) => e instanceof FormatError && /maxPacketBytes must be a whole number of bytes, at least packetBytes/.test(e.message));
  assert.ok(!JSON.stringify(toDocument(addInstance(createDesign('x'), cat, 'openspp/spp_core', { x: 0, y: 0 }).design, cat)).includes('maxPacketBytes'));
});

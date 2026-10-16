// The generic conditions that the cores and the Open Logic blocks assert at elaboration, as rules of the catalog: a
// value that would stop the elaboration (or the simulation at 0 ns) is an error of the system, with the reason and,
// where there is one, the next valid value. Each case names the assertion it mirrors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addDomain, addInstance, assignClock, createDesign, setGeneric } from '../../assets/composer/js/model/design.js';
import { resolve } from '../../assets/composer/js/model/resolver.js';
import { literalBits, ruleApplies } from '../../assets/composer/js/model/rules.js';
import { loadCatalog } from './helpers.mjs';

const cat = loadCatalog();
const RULES = new Set(['generic_range', 'generic_multiple']);

/**
 * Errors of the generic rules for one block with the given generic values (set in order).
 * @param {string} block
 * @param {[string, unknown][]} values
 * @param {string} [preset]
 */
function errors(block, values, preset) {
  const r = addInstance(createDesign('t'), cat, block, { x: 0, y: 0 }, preset);
  let d = r.design;
  for (const [name, v] of values) d = setGeneric(d, cat, r.id, name, v).design;
  return resolve(cat, d).checks.filter((c) => c.severity === 'error' && RULES.has(c.rule)).map((c) => c.message);
}

/** @type {[string, string, string | undefined, [string, unknown][], RegExp | null][]} */
const CASES = [
  // OpenCrypto ocr_gcm.vhd and ocr_aes_engine.vhd: ceil(Nr / R) to Nr round units, or 0
  ['ocr_gcm.vhd: AES units', 'opencrypto/ocr_core', undefined, [['DataWidth_g', 128], ['KeyBits_g', 256], ['AesUnits_g', 3]], /AesUnits_g = 3 must be from .* = 14 to .* = 14, or 0/],
  ['ocr_gcm.vhd: AES units at the default', 'opencrypto/ocr_core', undefined, [['DataWidth_g', 128], ['KeyBits_g', 256], ['AesUnits_g', 0]], null],
  ['ocr_aes_engine.vhd: not more units than rounds', 'opencrypto/ocr_core', undefined, [['DataWidth_g', 32], ['KeyBits_g', 128], ['AesUnits_g', 12]], /AesUnits_g = 12 must be from .* = 3 to .* = 10, or 0/],
  ['ocr_gcm.vhd: GHASH digit below the width', 'opencrypto/ocr_core', undefined, [['DataWidth_g', 32], ['GhashDigit_g', 16]], /GhashDigit_g = 16 must be at least DataWidth_g = 32, or 0/],
  ['ocr_gcm.vhd: release depth of at least one beat', 'opencrypto/ocr_core', undefined, [['DataWidth_g', 64], ['ReleaseBytes_g', 4]], /ReleaseBytes_g = 4 must be at least DataWidth_g \/ 8 = 8/],
  ['olo_ft_private_scrubber.vhd: scrub period of 1 ms or more', 'opencrypto/ocr_core', undefined, [['ScrubPeriod_g', 0.0005]], /ScrubPeriod_g = 0.0005 must be at least 0.001, or 0/],
  ['olo_ft_private_scrubber.vhd: scrubbing in every free cycle', 'opencrypto/ocr_core', undefined, [['ScrubPeriod_g', 0]], null],
  // OpenWire: a flow control token needs room for 8 N-Chars plus the reserved EEP place; FIFO_DEPTHS and FIFO_LEVELS
  // are 16-bit fields
  ['owr_core: receive FIFO too small for a flow control token', 'openwire/owr_core', undefined, [['RxFifoDepth_g', 8]], /^spw0: RxFifoDepth_g = 8 must be at least 16 \(the port never has room for a flow control token: 8 N-Chars plus the reserved EEP place; it receives no data\)\.$/],
  ['owr_core: receive FIFO of 16', 'openwire/owr_core', undefined, [['RxFifoDepth_g', 16]], null],
  ['owr_core: receive FIFO beyond the 16-bit fields', 'openwire/owr_core', undefined, [['RxFifoDepth_g', 65536]], /^spw0: RxFifoDepth_g = 65536 must be at most 32768 \(FIFO_DEPTHS and FIFO_LEVELS are 16-bit fields\)\.$/],
  ['owr_core: transmit FIFO beyond the 16-bit fields', 'openwire/owr_core', undefined, [['TxFifoDepth_g', 65536]], /^spw0: TxFifoDepth_g = 65536 must be at most 32768 \(FIFO_DEPTHS and FIFO_LEVELS are 16-bit fields\)\.$/],
  ['owr_core: both FIFOs at 32768', 'openwire/owr_core', undefined, [['RxFifoDepth_g', 32768], ['TxFifoDepth_g', 32768]], null],
  // OpenFibre ofb_dl_erb.vhd, ofb_dl_vc_out.vhd and ofb_dl_vc_in.vhd
  ['ofb_dl_erb.vhd: rows a power of two', 'openfibre/ofb_core', undefined, [['ErbRows_g', 96]], /ErbRows_g = 96 must be a power of two times 2; the next valid value is 128\./],
  ['ofb_dl_erb.vhd: at least a data frame of rows (DL-ER-08)', 'openfibre/ofb_core', undefined, [['ErbRows_g', 32]], /^ofb0: ErbRows_g = 32 must be at least 64 \(the error recovery buffer holds a data frame of 64 rows \(DL-ER-08\)\)\.$/],
  ['ofb_dl_vc_out.vhd: output VC buffer a power of two', 'openfibre/ofb_core', undefined, [['VcOutDepth_g', 100]], /VcOutDepth_g = 100 must be a power of two; the next valid value is 128\./],
  ['ofb_dl_vc_out.vhd: a data frame in the output VC buffer (DL-VO-05)', 'openfibre/ofb_core', undefined, [['NumLanes_g', 4], ['VcInDepth_g', 1024], ['VcOutDepth_g', 8]], /^ofb0: VcOutDepth_g = 8 must be at least cdiv\(64, NumLanes_g\) = 16 \(the output VC buffer holds a data frame of 64 words \(VcOutDepth_g x NumLanes_g, DL-VO-05\)\)\.$/],
  ['ofb_dl_vc_in.vhd: two flow control units with several lanes (DL-VI-05)', 'openfibre/ofb_core', undefined, [['NumLanes_g', 2], ['VcInDepth_g', 128]], /^ofb0: VcInDepth_g = 128 must be at least 128 \* NumLanes_g = 256 \(with several lanes the input VC buffer holds two flow control units \(DL-VI-05\); reference value 256 x NumLanes_g\)\.$/],
  ['ofb_dl_vc_in.vhd: one unit with one lane', 'openfibre/ofb_core', undefined, [['NumLanes_g', 1], ['VcInDepth_g', 64]], null],
  // OpenRMAP omap_pkg.vhd coreConfigError (CO-NO-03)
  ['omap_pkg.vhd: the chunk fits the write buffer', 'openrmap/omap_core', undefined, [['BufferBytes_g', 256], ['ChunkBytes_g', 512]], /^rmap0: ChunkBytes_g = 512 must be at most BufferBytes_g = 256 \(a chunk of a non-verified write fits the write buffer\)\.$/],
  ['olo_axi_master_simple.vhd: a burst within 4 KB', 'openrmap/omap_core', undefined, [['AxiDataWidth_g', 1024], ['ChunkBytes_g', 128], ['AxiMaxBeats_g', 64]], /^rmap0: AxiMaxBeats_g = 64 must be at most min\(4096, 2 \*\* \(AxiAddrWidth_g - 2\)\) \/ \(AxiDataWidth_g \/ 8\) = 32 \(a burst never exceeds 4 KB nor the largest memory command; larger values fail elaboration\)\.$/],
  ['olo_axi_master_simple.vhd: bursts of 4 KB', 'openrmap/omap_core', undefined, [['AxiDataWidth_g', 1024], ['ChunkBytes_g', 128], ['AxiMaxBeats_g', 32]], null],
  ['olo_axi_master_full.vhd: a burst within the largest command', 'openrmap/omap_core', undefined, [['AxiAddrWidth_g', 12], ['AxiDataWidth_g', 64], ['AxiMaxBeats_g', 256]], /^rmap0: AxiMaxBeats_g = 256 must be at most min\(4096, 2 \*\* \(AxiAddrWidth_g - 2\)\) \/ \(AxiDataWidth_g \/ 8\) = 128 \(a burst never exceeds 4 KB nor the largest memory command; larger values fail elaboration\)\.$/],
  ['olo_axi_master_full.vhd: bursts of the largest command', 'openrmap/omap_core', undefined, [['AxiAddrWidth_g', 12], ['AxiDataWidth_g', 64], ['AxiMaxBeats_g', 128]], null],
  ['olo_axi_master_full.vhd: 8-bit data at the smallest address width', 'openrmap/omap_core', undefined, [['AxiAddrWidth_g', 12], ['AxiDataWidth_g', 8], ['AxiMaxBeats_g', 256]], null],
  ['no memory master without the target', 'openrmap/omap_core', 'initiator', [['AxiAddrWidth_g', 12], ['AxiDataWidth_g', 1024], ['ChunkBytes_g', 128], ['AxiMaxBeats_g', 256]], null],
  ['omap_pkg.vhd: the chunk in whole memory words', 'openrmap/omap_core', undefined, [['AxiDataWidth_g', 64], ['ChunkBytes_g', 36]], /^rmap0: ChunkBytes_g = 36 must be a multiple of AxiDataWidth_g \/ 8 = 8 \(a single-address write moves whole memory words\); the next valid value is 40\.$/],
  ['omap_pkg.vhd: the address width needs no extra bits any more', 'openrmap/omap_core', 'target', [['AxiAddrWidth_g', 16]], null],
  // OpenSPP spp_core.vhd (CO-GN-02 to CO-GN-04), at 32-bit streams (4 bytes per beat)
  ['spp_core.vhd: send buffer holds the shortest Space Packet', 'openspp/spp_core', undefined, [['DataWidth_g', 32], ['TxBufferBytes_g', 4], ['TxMaxPackets_g', 2]], /^spp0: TxBufferBytes_g = 4 must be from .* = 8 to .* \(CO-GN-02, CO-GN-03\)\.$/],
  // two packets of 65542 bytes are 2 x 16386 = 32772 beats, a buffer of 2^16 beats = 262144 bytes holds them
  ['spp_core.vhd: send buffer no larger than its packets ever write', 'openspp/spp_core', undefined, [['DataWidth_g', 32], ['TxMaxPackets_g', 2], ['TxBufferBytes_g', 524288]], /^spp0: TxBufferBytes_g = 524288 must be from .* = 8 to .* = 262144 \(CO-GN-02, CO-GN-03\)\.$/],
  ['spp_core.vhd: SDUs that fit into the send buffer', 'openspp/spp_core', undefined, [['DataWidth_g', 32], ['TxBufferBytes_g', 64], ['TxMaxPackets_g', 17]], /^spp0: TxMaxPackets_g = 17 must be from 2 to max\(2, TxBufferBytes_g \/ \(DataWidth_g \/ 8\)\) = 16 /],
  ['spp_core.vhd: packets that fit into the receive buffer', 'openspp/spp_core', undefined, [['DataWidth_g', 32], ['RxBufferBytes_g', 64], ['RxMaxPackets_g', 9]], /^spp0: RxMaxPackets_g = 9 must be from 2 to .* = 8 /],
  // OpenCrypto ocr_gcm.vhd and ocr_framer.vhd: at most 65536 bytes
  ['ocr_gcm.vhd: release buffer of at most 65536 bytes', 'opencrypto/ocr_core', undefined, [['ReleaseBuffer_g', true], ['ReleaseBytes_g', 131072]], /^ocr0: ReleaseBytes_g = 131072 must be at most 65536\.$/],
  ['ocr_framer.vhd: chunk of at most 65536 bytes', 'opencrypto/ocr_framer', undefined, [['ChunkBytes_g', 131072]], /^frm0: ChunkBytes_g = 131072 must be at most 65536\.$/],
  // Open Logic
  ['olo_base_fifo_packet.vhd', 'olo/olo_ft_fifo_packet', undefined, [['Depth_g', 1000]], /Depth_g = 1000 must be a power of two; the next valid value is 1024\./],
  ['olo_base_wconv_n2xn.vhd', 'olo/olo_base_wconv_n2xn', undefined, [['InWidth_g', 8], ['OutWidth_g', 20]], /OutWidth_g = 20 must be a multiple of InWidth_g = 8; the next valid value is 24\./],
  ['olo_base_wconv_xn2n.vhd', 'olo/olo_base_wconv_xn2n', undefined, [['InWidth_g', 20], ['OutWidth_g', 8]], /InWidth_g = 20 must be a multiple of OutWidth_g = 8/],
  ['olo_base_wconv_n2m.vhd: byte enables', 'olo/olo_base_wconv_n2m', undefined, [['UseBe_g', true], ['InWidth_g', 12], ['OutWidth_g', 16]], /InWidth_g = 12 must be a multiple of 8/],
  ['olo_base_wconv_n2m.vhd: without byte enables', 'olo/olo_base_wconv_n2m', undefined, [['UseBe_g', false], ['InWidth_g', 12], ['OutWidth_g', 16]], null],
  ['olo_base_rate_limit.vhd', 'olo/olo_base_rate_limit', undefined, [['Period_g', 4], ['MaxSamples_g', 5]], /MaxSamples_g = 5 must be at most Period_g = 4/],
  ['olo_base_crc_append.vhd: polynomial not wider than a beat', 'olo/olo_base_crc_append', undefined, [['DataWidth_g', 8], ['CrcPolynomial_g', 'x"1021"']], /DataWidth_g = 8 must be at least length\(CrcPolynomial_g\) = 16/],
  ['olo_base_crc.vhd: byte order needs whole bytes', 'olo/olo_base_crc_check', undefined, [['DataWidth_g', 12], ['CrcPolynomial_g', 'x"07"'], ['CrcByteOrder_g', 'MSB_FIRST']], /DataWidth_g = 12 must be a multiple of 8/],
  ['olo_base_crc.vhd: no byte order', 'olo/olo_base_crc_check', undefined, [['DataWidth_g', 12], ['CrcPolynomial_g', 'x"07"'], ['CrcByteOrder_g', 'NONE']], null],
  ['olo_base_crc_check.vhd: packet FIFO of the DROP mode', 'olo/olo_base_crc_check', undefined, [['CrcPolynomial_g', 'x"07"'], ['Mode_g', 'DROP'], ['FifoDepth_g', 1000]], /FifoDepth_g = 1000 must be a power of two/],
  ['olo_base_crc_check.vhd: no FIFO in the FLAG mode', 'olo/olo_base_crc_check', undefined, [['CrcPolynomial_g', 'x"07"'], ['Mode_g', 'FLAG'], ['FifoDepth_g', 1000]], null],
  ['olo_ft_ecc_monitor_axi.vhd: register map fits', 'olo/olo_ft_ecc_monitor_axi', undefined, [['Channels_g', 16], ['AxiAddrWidth_g', 6]], /AxiAddrWidth_g = 6 must be at least log2ceil\(16 \+ 4 \* Channels_g\) = 7/],
  ['olo_axi_lite_decoder.vhd: windows fit', 'olo/olo_axi_lite_decoder', undefined, [['Ports_g', 8], ['PortAddrWidth_g', 12], ['AxiAddrWidth_g', 14]], /AxiAddrWidth_g = 14 must be at least PortAddrWidth_g \+ log2ceil\(Ports_g\) = 15/],
];

for (const [name, block, preset, values, expect] of CASES) {
  test(`${block}: ${name}`, () => {
    const e = errors(block, values, preset);
    if (expect === null) assert.deepEqual(e, []);
    else {
      assert.equal(e.length, 1, e.join('\n'));
      assert.match(e[0], expect);
    }
  });
}

test('the defaults of every block of the catalog meet its generic rules', () => {
  for (const b of cat.blocks.values()) {
    if (b.vendor) continue;
    for (const preset of [undefined, ...(b.presets ?? []).map((p) => p.id)]) {
      assert.deepEqual(errors(b.id, [], preset), [], `${b.id}${preset ? ` (${preset})` : ''}`);
    }
  }
});

test('conditions and widths of bit strings', () => {
  assert.equal(ruleApplies(undefined, {}), true);
  assert.equal(ruleApplies('A_g', { A_g: true }), true);
  assert.equal(ruleApplies('A_g', { A_g: false }), false);
  assert.equal(ruleApplies({ generic: 'M_g', is: 'DROP' }, { M_g: 'DROP' }), true);
  assert.equal(ruleApplies({ generic: 'M_g', not: 'NONE' }, { M_g: 'NONE' }), false);
  assert.equal(literalBits('x"07"'), 8);
  assert.equal(literalBits('"0101"'), 4);
  assert.equal(literalBits('12x"FFF"'), 12);
  assert.equal(literalBits('o"17"'), 6);
  assert.equal(literalBits("(others => '0')"), undefined);
});

test('openwire/owr_core: the link clock lies in 18 to 22, 27 to 33, 36 to 44 or 45 to 2554 MHz (CORE-CF-02)', () => {
  /** @param {number} hz */
  const findings = (hz) => {
    let d = addInstance(createDesign('t'), cat, 'openwire/owr_core', { x: 0, y: 0 }).design;
    const r = addDomain(d, { name: 'Link clock', frequencyHz: hz });
    d = assignClock(r.design, cat, 'spw0', 'LinkClk', r.id);
    return resolve(cat, d).checks.filter((c) => c.severity === 'error' && (c.rule === 'generic_range' || c.rule === 'clock_freq_multiple')).map((c) => c.message);
  };
  for (const hz of [20e6, 30e6, 44e6, 45e6, 200e6, 2554e6]) assert.deepEqual(findings(hz), [], `${hz / 1e6} MHz`);
  // 10 MHz is a multiple of 10 MHz, but the receiver cannot sample the initial rate of the far end
  assert.deepEqual(findings(10e6), ['spw0: LinkClkFreq_g = 10000000 must be at least 13200000 (the receiver samples the initial rate of the far end, at most 11 Mb/s, with 1.2 LinkClk periods per bit (CORE-CF-02)).']);
  // 2555 MHz needs an initial divider of 256
  assert.deepEqual(findings(2555e6), ['spw0: LinkClkFreq_g = 2555000000 must be at most 2554999999 (LINK_SPEED.INIT_DIV, round(LinkClkFreq_g / 10 MHz), is an 8-bit field: below 2555 MHz (CORE-CF-02)).']);
  // between the ranges the multiple of 10 MHz rule applies
  assert.equal(findings(25e6).length, 1);
});

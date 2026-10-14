// The generic conditions that the cores and the Open Logic blocks assert at elaboration, as rules of the catalog: a
// value that would stop the elaboration (or the simulation at 0 ns) is an error of the system, with the reason and,
// where there is one, the next valid value. Each case names the assertion it mirrors.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addInstance, createDesign, setGeneric } from '../../assets/composer/js/model/design.js';
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
  // OpenFibre ofb_dl_erb.vhd and the output VC buffer
  ['ofb_dl_erb.vhd: rows a power of two', 'openfibre/ofb_core', undefined, [['ErbRows_g', 48]], /ErbRows_g = 48 must be a power of two times 2; the next valid value is 64\./],
  ['ofb_dl_vc_out.vhd: output VC buffer a power of two', 'openfibre/ofb_core', undefined, [['VcOutDepth_g', 100]], /VcOutDepth_g = 100 must be a power of two; the next valid value is 128\./],
  // OpenRMAP omap_target_mem.vhd and olo_axi_master_simple.vhd (provisional)
  ['olo_axi_master_simple.vhd: transfer size bits of the target', 'openrmap/omap_core', 'target', [['AxiAddrWidth_g', 24]], /AxiAddrWidth_g = 24 must be at least 25 \+ log2\(AxiDataWidth_g \/ 8\) = 27/],
  ['olo_axi_master_simple.vhd: only the target', 'openrmap/omap_core', 'initiator', [['AxiAddrWidth_g', 24]], null],
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

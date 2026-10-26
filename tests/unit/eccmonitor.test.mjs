// The system ECC monitor (system.eccMonitor): the ECC events of the crossings the Composer inserts at its free channels,
// directly or through a pulse crossing into its clock domain; too few channels; the mark kept on rename and delete; the
// file; the channel macros of the C header and the sentences of the brief.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { checkConnection } from '../../assets/composer/js/model/compat.js';
import { addConnection, addInstance, removeInstances, renameInstance, setGeneric, setSystem, sidebandDefaults } from '../../assets/composer/js/model/design.js';
import { exportHdl } from '../../assets/composer/js/model/hdl.js';
import { netlist } from '../../assets/composer/js/model/netlist.js';
import { resolve } from '../../assets/composer/js/model/resolver.js';
import { FormatError, fromText, toDocument, toText } from '../../assets/composer/js/model/serialize.js';
import { loadCatalog, ROOT } from './helpers.mjs';

const cat = loadCatalog();
const TWO = readFileSync(`${ROOT}assets/composer/examples/spp_over_spw_two_clocks.composer.json`, 'utf-8');
/** The example with two clocks: two inserted FIFOs, the monitor edac0 marked. */
const two = () => fromText(TWO, cat).design;
/** @param {import('../../assets/composer/js/model/design.js').Design} d */
const protection = (d) => resolve(cat, d).checks.filter((c) => c.rule === 'protection').map((c) => `${c.severity} [${c.instance ?? ''}] ${c.message}`);

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

test('the inserted crossings take the free channels of the marked monitor, in the order of their connections', () => {
  const d = two();
  assert.equal(d.eccMonitor, 'edac0');
  const res = resolve(cat, d);
  // auto_cdc_c5 ends in the clock domain of the monitor, auto_cdc_c6 in the port clock: a pulse crossing brings it over
  const chains = res.chains.filter((c) => c.connection.startsWith('auto_ecc_')).map((c) => [c.connection, c.from, c.to, c.adapters.map((a) => res.byId.get(a)?.entity)]);
  assert.deepEqual(chains, [
    ['auto_ecc_c5', 'auto_cdc_c5.Ecc', 'edac0.In[0]', []],
    ['auto_ecc_c6', 'auto_cdc_c6.Ecc', 'edac0.In[1]', ['olo_base_cc_pulse']],
  ]);
  // the flags of the inserted FIFOs are aligned with their read words: In_Valid is their qualifier in the domain of the
  // monitor, they are qualified before the pulse crossing, and the count across it is a lower bound
  assert.deepEqual(protection(d), [
    'info [] edac0.In[0] has valid, auto_cdc_c5.Ecc does not: it is auto_cdc_c5.Out_Valid and auto_cdc_c5.Out_Ready, because the ECC flags of auto_cdc_c5.Ecc are aligned with its read words and count only with them.',
    'info [] The ECC flags of auto_cdc_c6.Ecc are aligned with its read words: they are qualified with auto_cdc_c6.Out_Valid and auto_cdc_c6.Out_Ready before the clock crossing auto_cdc_auto_ecc_c6, so edac0.In[1] gets one pulse per accepted word with an error.',
    'info [] The count of edac0.In[1] is a lower bound: the clock crossing auto_cdc_auto_ecc_c6 transfers the ECC events of auto_cdc_c6.Ecc only when they are at least two cycles of the slower clock apart, so events closer together may be lost, including a DED: DedSticky of the channel is then not set.',
  ]);
  const p = /** @type {any} */ (res.protection);
  assert.deepEqual(p.events.map((/** @type {any} */ e) => [e.source, e.to.channel, e.to.connection, e.to.crossed, e.qualify]), [
    ['auto_cdc_c5.Ecc', 0, 'auto_ecc_c5', false, ['Out_Valid', 'Out_Ready']],
    ['auto_cdc_c6.Ecc', 1, 'auto_ecc_c6', true, ['Out_Valid', 'Out_Ready']],
  ]);
  // the nets: no tie-off of the used channels; in the domain of the monitor In_Valid is the qualifier of the source,
  // across the crossing the flags are qualified before it and arrive as pulses (In_Valid '1')
  const n = netlist(cat, d, res);
  assert.deepEqual(n.problems, []);
  const from = (/** @type {string} */ to) => n.nets.find((x) => x.to === to)?.from;
  assert.equal(from('edac0_In_EccSec_s(0)'), 'auto_cdc_c5_Out_EccSec_s');
  assert.equal(from('edac0_In_Valid_s(0)'), 'auto_cdc_c5_Out_Valid_s and auto_cdc_c5_Out_Ready_s');
  assert.equal(from('edac0_In_EccDed_s(1)'), 'auto_cdc_auto_ecc_c6_Out_Pulse_s(1)');
  assert.equal(from('edac0_In_Valid_s(1)'), "'1'");
  assert.equal(from('auto_cdc_auto_ecc_c6_In_Pulse_s(0)'), 'auto_cdc_c6_Out_EccSec_s and auto_cdc_c6_Out_Valid_s and auto_cdc_c6_Out_Ready_s');
  assert.equal(from('auto_cdc_auto_ecc_c6_In_Pulse_s(1)'), 'auto_cdc_c6_Out_EccDed_s and auto_cdc_c6_Out_Valid_s and auto_cdc_c6_Out_Ready_s');
  assert.ok(!res.tieOffs.some((t) => t.port.startsWith('edac0.In_')));
});

test('the brief and the C header: channels connected by the Composer, not stable, and the limit of the pulse crossing', () => {
  const d = two();
  const doc = /** @type {any} */ (toDocument(d, cat));
  const brief = doc.agent.brief;
  assert.match(brief, /\| `auto_cdc_c6\.Ecc` \| FIFO memory of `auto_cdc_c6` \(inserted crossing\) \| channel 1 of `edac0` \(`olo_ft_ecc_monitor_axi`\), connected by the Composer \|/);
  assert.match(brief, /these channels are not stable across edits of the system\. Software uses the channel macros of the C header of the address map\./);
  assert.match(brief, /events closer together may be lost, including a DED \(DedSticky of the channel is then not set\), so the counter is a lower bound\./);
  assert.match(brief, /The ECC flags of `auto_cdc_c5\.Ecc`, `auto_cdc_c6\.Ecc` are aligned with the read words of their memories and count only in the cycles of Out_Valid and Out_Ready of their block/);
  const header = exportHdl(cat, doc.resolved, { generator: 'x', input: 'x.composer.json', sha256: '0'.repeat(64) }).files.find((f) => f.name.endsWith('_regs.h'))?.text ?? '';
  assert.match(header, /^#define SPP_OVER_SPW_TWO_CLOCKS_EDAC0_CH_AUTO_CDC_C5_ECC 0u$/m);
  assert.match(header, /^#define SPP_OVER_SPW_TWO_CLOCKS_EDAC0_CH_AUTO_CDC_C6_ECC 1u$/m);
});

test('too few channels: the first crossings are routed, the rest warned with the channels and address width they need', () => {
  // six framers use all twelve channels of the monitor with their own ECC events, at the narrowest address width that
  // holds twelve channels (log2ceil(16 + 4 x 12) = 6)
  let d = two();
  for (let k = 0; k < 6; k += 1) d = addInstance(d, cat, 'opencrypto/ocr_framer', { x: 0, y: 0 }).design;
  d = setGeneric(d, cat, 'edac0', 'Channels_g', 12).design;
  d = setGeneric(d, cat, 'edac0', 'AxiAddrWidth_g', 6).design;
  for (let k = 0; k < 12; k += 1) d = link(d, `frm${k >> 1}.Ecc[${k % 2}]`, `edac0.In[${k}]`);
  assert.ok(protection(d).includes('warning [edac0] edac0 has 12 channels, 12 used by connections; the inserted crossings auto_cdc_c5, auto_cdc_c6 need 2 more, so their ECC events are not reported. Set Channels_g of edac0 to at least 14 and AxiAddrWidth_g to at least 7.'));
  // the suggestion, applied: every crossing is routed, and no rule of the monitor fails
  d = setGeneric(setGeneric(d, cat, 'edac0', 'AxiAddrWidth_g', 7).design, cat, 'edac0', 'Channels_g', 14).design;
  const res = resolve(cat, d);
  assert.ok(!res.checks.some((c) => c.instance === 'edac0' && c.severity !== 'info'));
  assert.deepEqual(res.chains.filter((c) => c.connection.startsWith('auto_ecc_')).map((c) => c.to), ['edac0.In[12]', 'edac0.In[13]']);
});

test('the mark follows a rename, ends with the instance, and is written to the file', () => {
  let d = two();
  d = renameInstance(d, 'edac0', 'mon0');
  assert.equal(d.eccMonitor, 'mon0');
  assert.ok(resolve(cat, d).chains.some((c) => c.to === 'mon0.In[0]'));
  const text = toText(d, cat);
  assert.equal(JSON.parse(text).system.eccMonitor, 'mon0');
  assert.equal(fromText(text, cat).design.eccMonitor, 'mon0');
  // removed: the key is gone, the hint stays silent (no monitor), the crossings are not reported
  const gone = removeInstances(d, ['mon0']);
  assert.equal(gone.eccMonitor, undefined);
  assert.ok(!JSON.parse(toText(gone, cat)).system.eccMonitor);
  // unmarked by the checkbox: the key is gone too
  assert.equal(setSystem(d, { eccMonitor: '' }).eccMonitor, undefined);
  assert.throws(() => setSystem(d, { eccMonitor: 'nothing' }), /Unknown instance/);
  // a file that names a missing instance is refused
  const o = JSON.parse(text);
  o.system.eccMonitor = 'nothing';
  assert.throws(() => fromText(JSON.stringify(o), cat), (e) => e instanceof FormatError && /system\.eccMonitor: no instance "nothing"/.test(e.message));
});

test('a marked block without ECC event inputs is an error', () => {
  const d = setSystem(two(), { eccMonitor: 'spp0' });
  assert.ok(resolve(cat, d).checks.some((c) => c.severity === 'error' && c.message === 'The system ECC monitor spp0 is no block with ECC event inputs.'));
});

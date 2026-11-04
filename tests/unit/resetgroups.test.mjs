// Reset groups (format version 3): the reset output of a block (an interface of type reset that is an event output)
// drives the reset ports of the members instead of the reset generator of their clock domain. The file (version 3
// only with groups), the errors of the reader, the rules and checks of the resolver, the inserted blocks that join a
// group or stay at its border, the netlist, the brief and the export; systems without groups are written as before.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { Catalog } from '../../assets/composer/js/model/catalog.js';
import { checkConnection } from '../../assets/composer/js/model/compat.js';
import {
  addDomain, addInstance, assignClock, createDesign, removeInstances, renameInstance, resetGroupOf, resetOutputs, setGeneric, setResetGroup,
} from '../../assets/composer/js/model/design.js';
import { exportHdl } from '../../assets/composer/js/model/hdl.js';
import { netlist } from '../../assets/composer/js/model/netlist.js';
import { resolve } from '../../assets/composer/js/model/resolver.js';
import { fromText, SCHEMA_URL, SCHEMA_URL_3, toDocument, toText } from '../../assets/composer/js/model/serialize.js';
import { connect, loadCatalog, loadCatalogJson, ROOT } from './helpers.mjs';

const cat = loadCatalog();

/**
 * @param {Catalog} c
 * @param {any} d
 * @param {string} a
 * @param {string} b
 */
function link(c, d, a, b) {
  const chk = checkConnection(c, d, a, b);
  assert.ok(chk.ok, chk.reason);
  return connect(d, chk);
}

/**
 * A compressor that feeds a framer and its AES-GCM core; the narrower compressor gets a width converter on its
 * connection to the framer (c1).
 * @param {Catalog} [c]
 * @param {string} [compressor]
 */
function chain(c = cat, compressor = 'opencompact/ocp_core') {
  let d = createDesign('t');
  for (const b of ['olo/olo_ft_reset_ctrl_axi', compressor, 'opencrypto/ocr_framer', 'opencrypto/ocr_core']) d = addInstance(d, c, b, { x: 0, y: 0 }).design;
  const cmp = d.instances[1].id;
  d = setGeneric(d, c, cmp, 'OutWidth_g', 32).design;
  d = setGeneric(d, c, 'ocr0', 'DataWidth_g', 128).design;
  d = link(c, d, `${cmp}.Out`, 'frm0.S_In');
  return link(c, d, 'frm0.M_Out', 'ocr0.S_In');
}

/** The chain with the group pipe of prst0 over the compressor, the framer and the AES-GCM core. */
const pipe = () => setResetGroup(chain(), cat, 'prst0.RstOut', ['ocp0', 'frm0', 'ocr0'], 'pipe');

/** @param {any} r @param {string} [severity] */
const groupChecks = (r, severity) => r.checks.filter((/** @type {any} */ c) => c.rule === 'reset_group' && (!severity || c.severity === severity)).map((/** @type {any} */ c) => c.message);

test('the members take the reset output of the group; the source and the other blocks stay on the reset generator of their domain', () => {
  const d = pipe();
  const r = resolve(cat, d);
  const conv = /** @type {string} */ (r.chainOf.get('c1')?.adapters[0]);
  assert.equal(r.byId.get(conv)?.block, 'olo/olo_base_wconv_n2m');
  assert.equal(r.byId.get('prst0')?.resets.Rst, 'auto_rst_sys.RstOut');
  for (const id of ['ocp0', 'frm0', 'ocr0', conv]) assert.equal(r.byId.get(id)?.resets.Rst, 'prst0.RstOut', id);
  // the converter between two members joins the group
  assert.deepEqual(r.resetGroups, [{ group: 'pipe', source: 'prst0.RstOut', domain: 'sys', ports: ['ocp0.Rst', 'frm0.Rst', 'ocr0.Rst', `${conv}.Rst`] }]);
  assert.deepEqual(r.checks.filter((c) => c.rule === 'reset_group'), []);
  const n = netlist(cat, d, r);
  assert.deepEqual(n.problems, []);
  const port = (/** @type {string} */ inst, /** @type {string} */ name) => n.instances.find((i) => i.id === inst)?.ports.find((/** @type {any} */ p) => p.name === name);
  assert.equal(port('prst0', 'Rst').actual, 'auto_rst_sys_RstOut_s');
  assert.equal(port('prst0', 'RstOut').actual, 'prst0_RstOut_s');
  assert.equal(port('ocp0', 'Rst').actual, 'prst0_RstOut_s');
  assert.equal(port(conv, 'Rst').actual, 'prst0_RstOut_s');
  assert.match(port('frm0', 'Rst').reset.note, /: the reset of the group pipe \(prst0\.RstOut\)\.$/);
  assert.match(port('prst0', 'Rst').reset.note, /: the output of the reset generator auto_rst_sys\.$/);
  assert.ok(n.signals.some((s) => s.name === 'prst0_RstOut_s'));
  assert.deepEqual(n.resetGroups, [{ group: 'pipe', source: 'prst0.RstOut', output: 'prst0_RstOut_s', domain: 'sys', ports: ['ocp0.Rst', 'frm0.Rst', 'ocr0.Rst', `${conv}.Rst`] }]);
  // the export: the port maps
  const doc = /** @type {any} */ (toDocument(d, cat));
  const top = exportHdl(cat, doc.resolved, { generator: 'x', input: 't.composer.json', sha256: '0'.repeat(64) }).files.find((f) => f.name === 't.vhd')?.text ?? '';
  assert.match(top, /i_ocp0 : entity [\s\S]*?Rst +=> prst0_RstOut_s,/);
  assert.match(top, /i_prst0 : entity [\s\S]*?Rst +=> auto_rst_sys_RstOut_s,[\s\S]*?RstOut +=> prst0_RstOut_s/);
  // the brief: the file holds the groups, and section 4 lists them
  assert.match(doc.agent.brief, /The file holds the system as edited \(`instances`, `connections`, `externals`, `resetGroups`\)/);
  assert.match(doc.agent.brief, new RegExp(`\\| \`pipe\` \\| \`prst0\\.RstOut\` \\(signal \`prst0_RstOut_s\`\\) \\| System clock \\| \`ocp0\\.Rst\`, \`frm0\\.Rst\`, \`ocr0\\.Rst\`, \`${conv}\\.Rst\` \\|`));
});

test('the file: version 3 only with reset groups, read back unchanged; without its group the system is written as before', () => {
  const text = toText(pipe(), cat);
  const o = JSON.parse(text);
  assert.equal(o.formatVersion, 3);
  assert.equal(o.$schema, SCHEMA_URL_3);
  assert.deepEqual(o.resetGroups, [{ id: 'pipe', source: 'prst0.RstOut', members: ['ocp0', 'frm0', 'ocr0'] }]);
  assert.deepEqual(Object.keys(o).slice(0, 11), ['$schema', 'format', 'formatVersion', 'generator', 'system', 'sources', 'clockDomains', 'instances', 'connections', 'externals', 'resetGroups']);
  const back = fromText(text, cat);
  assert.deepEqual(back.design.resetGroups, [{ id: 'pipe', source: 'prst0.RstOut', members: ['ocp0', 'frm0', 'ocr0'] }]);
  assert.equal(toText(back.design, cat), text);
  // the last group removed: version 1, no key, and the same file as the system that never had one
  const without = setResetGroup(pipe(), cat, 'prst0.RstOut', []);
  assert.equal(without.resetGroups, undefined);
  const plain = JSON.parse(toText(without, cat));
  assert.equal(plain.formatVersion, 1);
  assert.equal(plain.$schema, SCHEMA_URL);
  assert.ok(!('resetGroups' in plain) && !('resetGroups' in plain.resolved));
  assert.equal(toText(without, cat), toText(chain(), cat));
});

test('systems without reset groups: every example and fixture keeps its version and has no reset group', () => {
  const dir = `${ROOT}assets/composer/examples/`;
  const files = [...readdirSync(dir).filter((f) => f.endsWith('.composer.json')).map((f) => dir + f), `${ROOT}tests/fixtures/spfi_encrypt.composer.json`, `${ROOT}tests/fixtures/subsystems/dual_rmap_node.composer.json`];
  for (const f of files) {
    const text = readFileSync(f, 'utf-8');
    const o = JSON.parse(text);
    if (o.resetGroups) continue;
    assert.ok(o.formatVersion === 1 || o.formatVersion === 2, f);
    const d = fromText(text, cat).design;
    assert.equal(d.resetGroups, undefined, f);
    const again = JSON.parse(toText(d, cat));
    assert.equal(again.formatVersion, o.formatVersion, f);
    assert.ok(!('resetGroups' in again) && !('resetGroups' in again.resolved), f);
  }
});

test('the reader: reset groups only in version 3, which has at least one; the form and the references of a group', () => {
  const base = JSON.parse(toText(pipe(), cat));
  const read = (/** @type {(o: any) => void} */ edit) => () => {
    const o = JSON.parse(JSON.stringify(base));
    edit(o);
    return fromText(JSON.stringify(o), cat);
  };
  assert.throws(read((o) => { o.formatVersion = 1; }), /resetGroups: only a file of format version 3 has reset groups\./);
  assert.throws(read((o) => { o.formatVersion = 2; }), /resetGroups: only a file of format version 3 has reset groups\./);
  assert.throws(read((o) => { delete o.resetGroups; }), /resetGroups: a file of format version 3 has at least one reset group\./);
  assert.throws(read((o) => { o.resetGroups = []; }), /at least one reset group/);
  assert.throws(read((o) => { o.formatVersion = 4; }), /The file has format version 4; this Composer reads versions 1 to 3\./);
  assert.throws(read((o) => { o.resetGroups[0].members = []; }), /resetGroups\[0\]: needs id, source and at least one member\./);
  assert.throws(read((o) => { o.resetGroups[0].members[0] = 'ocp0.Rst'; }), /"ocp0\.Rst" is no instance id \(a member is an instance; the catalog selects its reset ports\)/);
  assert.throws(read((o) => { o.resetGroups[0].members.push('nothing'); }), /resetGroups\[0\]\.members: no instance "nothing"\./);
  assert.throws(read((o) => { o.resetGroups[0].members.push('ocp0'); }), /ocp0 is named twice/);
  assert.throws(read((o) => { o.resetGroups.push({ ...o.resetGroups[0] }); }), /resetGroups\[1\]: duplicate id "pipe"\./);
  assert.throws(read((o) => { o.resetGroups[0].source = 'prst0'; }), /source: "<instance>\.<interface>" of a reset output, not "prst0"\./);
  assert.throws(read((o) => { o.resetGroups[0].source = 'nothing.RstOut'; }), /resetGroups\[0\]\.source: no instance "nothing"\./);
  assert.throws(read((o) => { o.resetGroups[0].id = 'Pipe'; }), /resetGroups\[0\]\.id: /);
  assert.throws(read((o) => { o.subsystems = [{ name: 'sub', resetGroups: [] }]; }), /subsystems\[0\] \(sub\): a subsystem has no reset groups; they belong to the top level\./);
  // a subsystem instance is no member
  const two = JSON.parse(readFileSync(`${ROOT}tests/fixtures/subsystems/dual_rmap_node.composer.json`, 'utf-8'));
  const sub = two.instances.find((/** @type {any} */ i) => i.subsystem).id;
  two.formatVersion = 3;
  two.instances.push({ id: 'prst0', block: 'olo/olo_ft_reset_ctrl_axi', generics: {}, clocks: { Clk: two.clockDomains[0].id } });
  two.resetGroups = [{ id: 'pipe', source: 'prst0.RstOut', members: [sub] }];
  assert.throws(() => fromText(JSON.stringify(two), cat), new RegExp(`${sub} is a subsystem; a reset group takes blocks of the top level\\.`));
});

test('the checks of a group: a reset output as source, not a member of its own group, one group per member and per source, one clock domain', () => {
  // the source must be a reset output; a file can name another interface
  const o = JSON.parse(toText(pipe(), cat));
  o.resetGroups[0].source = 'prst0.S_AxiLite';
  assert.deepEqual(groupChecks(resolve(cat, fromText(JSON.stringify(o), cat).design), 'error'), ['Reset group pipe: the source prst0.S_AxiLite is no reset output (an interface of type reset that is an event output).']);
  // the source as a member
  const self = setResetGroup(chain(), cat, 'prst0.RstOut', ['prst0', 'ocp0'], 'pipe');
  assert.deepEqual(groupChecks(resolve(cat, self), 'error'), ['Reset group pipe: prst0 is its source and cannot be a member; it stays on the reset of its clock domain, so that the system reset reaches the group through it.']);
  // a member of two groups (a second controller)
  let two = addInstance(pipe(), cat, 'olo/olo_ft_reset_ctrl_axi', { x: 0, y: 0 }).design;
  two = setResetGroup(two, cat, 'prst1.RstOut', ['ocp0'], 'other');
  const r2 = resolve(cat, two);
  assert.deepEqual(groupChecks(r2, 'error'), ['ocp0 is a member of the reset groups pipe and other: a block takes one reset.']);
  assert.equal(r2.byId.get('ocp0')?.resets.Rst, 'prst0.RstOut');
  // one group per source (a file can have two)
  const same = JSON.parse(toText(pipe(), cat));
  same.resetGroups = [{ id: 'pipe', source: 'prst0.RstOut', members: ['ocp0'] }, { id: 'other', source: 'prst0.RstOut', members: ['frm0'] }];
  assert.deepEqual(groupChecks(resolve(cat, fromText(JSON.stringify(same), cat).design), 'error'), ['Reset groups pipe and other have the same source prst0.RstOut: one group per reset output.']);
  // a synchronous member in another clock domain than the source
  const dom = addDomain(chain(), { name: 'Fast', frequencyHz: 200e6 });
  let far = assignClock(dom.design, cat, 'ocr0', 'Clk', dom.id);
  far = assignClock(far, cat, 'frm0', 'Clk', dom.id);
  far = setResetGroup(far, cat, 'prst0.RstOut', ['ocp0', 'ocr0'], 'pipe');
  const r3 = resolve(cat, far);
  assert.deepEqual(groupChecks(r3, 'error'), [`ocr0.Rst is synchronous to Fast; the reset of the group pipe is synchronous to System clock.`]);
  assert.equal(r3.byId.get('ocr0')?.resets.Rst, `auto_rst_${dom.id}.RstOut`);
});

test('an asynchronous reset of a member takes the group reset directly (info); a member without a reset input is a warning', () => {
  // OpenWire: its asynchronous Rst
  let d = addInstance(chain(), cat, 'openwire/owr_core', { x: 0, y: 0 }).design;
  const owr = d.instances[d.instances.length - 1].id;
  d = setResetGroup(d, cat, 'prst0.RstOut', ['ocp0', 'frm0', 'ocr0', owr], 'pipe');
  const r = resolve(cat, d);
  assert.equal(r.byId.get(owr)?.resets.Rst, 'prst0.RstOut');
  assert.deepEqual(groupChecks(r, 'error'), []);
  assert.deepEqual(groupChecks(r, 'info'), [`${owr}.Rst is an asynchronous reset: it takes the reset of the group pipe directly, and owr_core synchronises its release itself.`]);
  const n = netlist(cat, d, r);
  const p = n.instances.find((i) => i.id === owr)?.ports.find((/** @type {any} */ x) => x.name === 'Rst');
  assert.equal(p.actual, 'prst0_RstOut_s');
  assert.equal(p.reset.note, 'Asynchronous reset from the group pipe (prst0.RstOut): owr_core synchronises its release itself.');
  // a block without a reset input (a test entry of the catalog)
  const json = loadCatalogJson();
  const fifo = json.blocks.find((/** @type {any} */ b) => b.id === 'olo/olo_ft_fifo_sync');
  json.blocks.push({ ...fifo, id: 'test/no_reset', idPrefix: 'nr', resets: [] });
  const tcat = new Catalog(json);
  let e = addInstance(createDesign('t'), tcat, 'olo/olo_ft_reset_ctrl_axi', { x: 0, y: 0 }).design;
  e = addInstance(e, tcat, 'test/no_reset', { x: 0, y: 0 }).design;
  e = setResetGroup(e, tcat, 'prst0.RstOut', ['nr0'], 'pipe');
  assert.deepEqual(groupChecks(resolve(tcat, e), 'warning'), ['nr0 has no reset input: the reset group pipe does not reset it.']);
});

test('a block with reset ports for a group (OpenSPP DpRst): only they take it, and an inserted block joins only where both ends are reset by the group', () => {
  // a test entry of the catalog: the compressor with a second reset input DpRst for a group, which resets the logic
  // behind In (resetBy) but not the output stage behind Out, like spp_core with its link output
  const json = loadCatalogJson();
  const core = json.blocks.find((/** @type {any} */ b) => b.id === 'opencompact/ocp_core');
  /** @param {boolean} outByGroup */
  const variant = (outByGroup) => ({
    ...core,
    id: 'test/ocp_dp',
    idPrefix: 'dp',
    ports: [...core.ports, { name: 'DpRst', dir: 'in', vhdlType: 'std_logic', width: '1', default: "'0'" }],
    resets: [...core.resets, { port: 'DpRst', active: 'high', sync: 'sync', clock: 'Clk', group: true }],
    interfaces: core.interfaces.map((/** @type {any} */ i) => (i.name === 'In' || (outByGroup && i.name === 'Out') ? { ...i, resetBy: 'DpRst' } : i)),
  });
  for (const outByGroup of [false, true]) {
    const tj = JSON.parse(JSON.stringify(json));
    tj.blocks.push(variant(outByGroup));
    const tcat = new Catalog(tj);
    const d = setResetGroup(chain(tcat, 'test/ocp_dp'), tcat, 'prst0.RstOut', ['dp0', 'frm0', 'ocr0'], 'pipe');
    const r = resolve(tcat, d);
    const conv = /** @type {string} */ (r.chainOf.get('c1')?.adapters[0]);
    assert.equal(r.byId.get(conv)?.block, 'olo/olo_base_wconv_n2m');
    // the group reset only on DpRst; Rst stays on the reset generator of the domain
    assert.equal(r.byId.get('dp0')?.resets.Rst, 'auto_rst_sys.RstOut');
    assert.equal(r.byId.get('dp0')?.resets.DpRst, 'prst0.RstOut');
    assert.deepEqual(groupChecks(r, 'error'), []);
    if (outByGroup) {
      // Out declared as reset by DpRst: the converter between Out and the framer joins the group
      assert.equal(r.byId.get(conv)?.resets.Rst, 'prst0.RstOut');
      assert.deepEqual(r.resetGroups[0].ports, ['dp0.DpRst', 'frm0.Rst', 'ocr0.Rst', `${conv}.Rst`]);
      assert.deepEqual(groupChecks(r, 'info'), []);
    } else {
      // Out without resetBy is a border: the converter keeps the reset of its domain, so it does not cut a packet
      // that the output stage still closes
      assert.equal(r.byId.get(conv)?.resets.Rst, 'auto_rst_sys.RstOut');
      assert.deepEqual(r.resetGroups[0].ports, ['dp0.DpRst', 'frm0.Rst', 'ocr0.Rst']);
      assert.deepEqual(groupChecks(r, 'info'), [`The inserted blocks ${conv} (dp0.Out to frm0.S_In) at the border of the reset group pipe keep the reset of their clock domain: only one end of their connection is reset by the group.`]);
    }
  }
});

test('a reset input for a group outside one keeps its default: no reset generator for it, the port map leaves it out', () => {
  // test entries of the catalog: the compressor with a second reset input DpRst for a group (default '0'), and one
  // whose only reset input is for a group
  const json = loadCatalogJson();
  const core = json.blocks.find((/** @type {any} */ b) => b.id === 'opencompact/ocp_core');
  json.blocks.push({
    ...core,
    id: 'test/ocp_dp',
    idPrefix: 'dp',
    ports: [...core.ports, { name: 'DpRst', dir: 'in', vhdlType: 'std_logic', width: '1', default: "'0'" }],
    resets: [...core.resets, { port: 'DpRst', active: 'high', sync: 'sync', clock: 'Clk', group: true }],
  }, {
    ...core,
    id: 'test/ocp_g',
    idPrefix: 'g',
    ports: core.ports.map((/** @type {any} */ p) => (p.name === 'Rst' ? { ...p, default: "'0'" } : p)),
    resets: core.resets.map((/** @type {any} */ r) => ({ ...r, group: true })),
  });
  const tcat = new Catalog(json);
  const one = (/** @type {string} */ block) => addInstance(createDesign('t'), tcat, block, { x: 0, y: 0 }).design;
  // Rst on the reset generator of the domain, DpRst at its default
  let d = one('test/ocp_dp');
  let r = resolve(tcat, d);
  assert.equal(r.byId.get('dp0')?.resets.Rst, 'auto_rst_sys.RstOut');
  assert.equal(r.byId.get('dp0')?.resets.DpRst, 'default');
  assert.deepEqual(r.resetGroups, []);
  let n = netlist(tcat, d, r);
  assert.deepEqual(n.problems, []);
  const dp = n.instances.find((i) => i.id === 'dp0')?.ports.find((/** @type {any} */ p) => p.name === 'DpRst');
  assert.deepEqual({ actual: dp.actual, useDefault: dp.useDefault, default: dp.default }, { actual: null, useDefault: true, default: "'0'" });
  assert.equal(dp.reset.note, 'Synchronous reset in the clock domain System clock (clock Clk), for a reset group; dp0 is in none, so the port keeps its default.');
  const doc = /** @type {any} */ (toDocument(d, tcat));
  assert.match(doc.agent.brief, /\| `dp0\.DpRst` \| synchronous \| default `'0'` \| Synchronous reset in the clock domain System clock \(clock Clk\), for a reset group; dp0 is in none, so the port keeps its default\. \|/);
  const top = exportHdl(tcat, doc.resolved, { generator: 'x', input: 't.composer.json', sha256: '0'.repeat(64) }).files.find((f) => f.name === 't.vhd')?.text ?? '';
  assert.match(top, /i_dp0 : entity [\s\S]*?Rst +=> auto_rst_sys_RstOut_s,/);
  assert.doesNotMatch(top, /DpRst +=>/);
  // a block whose only reset input is for a group: its domain needs no reset generator
  d = one('test/ocp_g');
  r = resolve(tcat, d);
  assert.equal(r.byId.get('g0')?.resets.Rst, 'default');
  assert.equal(r.byId.get('auto_rst_sys'), undefined);
  n = netlist(tcat, d, r);
  assert.deepEqual(n.problems, []);
  assert.deepEqual(n.resets, []);
});

test('OpenSPP spp_core: DpRst keeps its default outside a group; in a group only DpRst takes its reset (CO-RS-12: M_Link by Rst only)', () => {
  // the catalog entry: DpRst is an input for groups with the VHDL default '0', and every interface is reset by it
  // except the link output
  const spp = /** @type {any} */ (cat.blocks.get('openspp/spp_core'));
  assert.deepEqual(spp.resets.map((/** @type {any} */ r) => [r.port, r.group ?? false]), [['Rst', false], ['DpRst', true]]);
  assert.equal(spp.ports.find((/** @type {any} */ p) => p.name === 'DpRst')?.default, "'0'");
  assert.deepEqual(spp.interfaces.filter((/** @type {any} */ i) => i.resetBy !== 'DpRst').map((/** @type {any} */ i) => i.name), ['M_Link']);
  let d = createDesign('t');
  for (const b of ['olo/olo_ft_reset_ctrl_axi', 'openspp/spp_core', 'openspp/spp_nchar']) d = addInstance(d, cat, b, { x: 0, y: 0 }).design;
  d = link(cat, d, 'spp0.M_Link', 'nchar0.S_Link');
  d = link(cat, d, 'nchar0.M_Link', 'spp0.S_Link');
  let r = resolve(cat, d);
  assert.equal(r.byId.get('spp0')?.resets.Rst, 'auto_rst_sys.RstOut');
  assert.equal(r.byId.get('spp0')?.resets.DpRst, 'default');
  // in a group: DpRst takes the group reset, Rst and the link side stay on the reset generator of the domain
  d = setResetGroup(d, cat, 'prst0.RstOut', ['spp0'], 'dp');
  r = resolve(cat, d);
  assert.equal(r.byId.get('spp0')?.resets.DpRst, 'prst0.RstOut');
  assert.equal(r.byId.get('spp0')?.resets.Rst, 'auto_rst_sys.RstOut');
  assert.equal(r.byId.get('nchar0')?.resets.Rst, 'auto_rst_sys.RstOut');
  assert.deepEqual(r.resetGroups, [{ group: 'dp', source: 'prst0.RstOut', domain: 'sys', ports: ['spp0.DpRst'] }]);
  assert.deepEqual(groupChecks(r), []);
  const n = netlist(cat, d, r);
  assert.deepEqual(n.problems, []);
  const port = (/** @type {string} */ inst, /** @type {string} */ name) => n.instances.find((i) => i.id === inst)?.ports.find((/** @type {any} */ p) => p.name === name);
  assert.equal(port('spp0', 'DpRst').actual, 'prst0_RstOut_s');
  assert.match(port('spp0', 'DpRst').reset.note, /: the reset of the group dp \(prst0\.RstOut\)\.$/);
  assert.equal(port('spp0', 'Rst').actual, 'auto_rst_sys_RstOut_s');
  assert.equal(port('nchar0', 'Rst').actual, 'auto_rst_sys_RstOut_s');
});

test('a reset output of any name: the members take the signal of its port', () => {
  // a test entry of the catalog: the reset controller with its output port named PipeRst
  const json = loadCatalogJson();
  const ctrl = json.blocks.find((/** @type {any} */ b) => b.id === 'olo/olo_ft_reset_ctrl_axi');
  json.blocks.push({
    ...ctrl,
    id: 'test/pipe_ctrl',
    idPrefix: 'pc',
    ports: ctrl.ports.map((/** @type {any} */ p) => (p.name === 'RstOut' ? { ...p, name: 'PipeRst' } : p)),
    interfaces: ctrl.interfaces.map((/** @type {any} */ i) => (i.name === 'RstOut' ? { ...i, name: 'Pipe', signals: { rst: 'PipeRst' } } : i)),
  });
  const tcat = new Catalog(json);
  let d = createDesign('t');
  for (const b of ['test/pipe_ctrl', 'opencompact/ocp_core']) d = addInstance(d, tcat, b, { x: 0, y: 0 }).design;
  d = setResetGroup(d, tcat, 'pc0.Pipe', ['ocp0'], 'pipe');
  const r = resolve(tcat, d);
  assert.equal(r.byId.get('ocp0')?.resets.Rst, 'pc0.PipeRst');
  const n = netlist(tcat, d, r);
  const port = (/** @type {string} */ inst, /** @type {string} */ name) => n.instances.find((i) => i.id === inst)?.ports.find((/** @type {any} */ p) => p.name === name);
  assert.equal(port('ocp0', 'Rst').actual, 'pc0_PipeRst_s');
  assert.equal(port('pc0', 'PipeRst').actual, 'pc0_PipeRst_s');
  assert.ok(n.signals.some((s) => s.name === 'pc0_PipeRst_s'));
  assert.deepEqual(n.resetGroups, [{ group: 'pipe', source: 'pc0.PipeRst', output: 'pc0_PipeRst_s', domain: 'sys', ports: ['ocp0.Rst'] }]);
});

test('the design: a group follows renames and deletions; its source must be a reset output', () => {
  assert.deepEqual(resetOutputs(pipe(), cat, 'prst0'), ['RstOut']);
  assert.deepEqual(resetOutputs(pipe(), cat, 'ocp0'), []);
  assert.equal(resetGroupOf(pipe(), 'frm0')?.id, 'pipe');
  assert.equal(resetGroupOf(pipe(), 'prst0'), undefined);
  // renames of the source and of a member
  let d = renameInstance(pipe(), 'prst0', 'ctrl0');
  d = renameInstance(d, 'ocp0', 'cmp0');
  assert.deepEqual(d.resetGroups, [{ id: 'pipe', source: 'ctrl0.RstOut', members: ['cmp0', 'frm0', 'ocr0'] }]);
  // a removed member leaves its group; the removed source ends it
  assert.deepEqual(removeInstances(d, ['cmp0']).resetGroups, [{ id: 'pipe', source: 'ctrl0.RstOut', members: ['frm0', 'ocr0'] }]);
  assert.equal(removeInstances(d, ['ctrl0']).resetGroups, undefined);
  assert.equal(removeInstances(d, ['cmp0', 'frm0', 'ocr0']).resetGroups, undefined);
  // a new group gets the name <instance>_reset; members replace those before
  const g = setResetGroup(chain(), cat, 'prst0.RstOut', ['ocp0']);
  assert.deepEqual(g.resetGroups, [{ id: 'prst0_reset', source: 'prst0.RstOut', members: ['ocp0'] }]);
  assert.deepEqual(setResetGroup(g, cat, 'prst0.RstOut', ['frm0'])?.resetGroups, [{ id: 'prst0_reset', source: 'prst0.RstOut', members: ['frm0'] }]);
  // errors
  assert.throws(() => setResetGroup(chain(), cat, 'prst0.S_AxiLite', ['ocp0']), /prst0\.S_AxiLite is no reset output\./);
  assert.throws(() => setResetGroup(chain(), cat, 'nothing.RstOut', ['ocp0']), /Unknown instance "nothing"\./);
  assert.throws(() => setResetGroup(chain(), cat, 'prst0.RstOut', ['nothing']), /Unknown instance "nothing"\./);
  assert.throws(() => setResetGroup(chain(), cat, 'prst0.RstOut', ['ocp0', 'ocp0']), /A member is named twice\./);
  assert.throws(() => setResetGroup(chain(), cat, 'prst0.RstOut', ['ocp0'], 'Pipe'), /Reset group:/);
  let two = addInstance(pipe(), cat, 'olo/olo_ft_reset_ctrl_axi', { x: 0, y: 0 }).design;
  assert.throws(() => setResetGroup(two, cat, 'prst1.RstOut', ['frm0'], 'pipe'), /A reset group "pipe" exists already\./);
  two = setResetGroup(two, cat, 'prst1.RstOut', ['frm0']);
  assert.equal(two.resetGroups?.[1].id, 'prst1_reset');
});

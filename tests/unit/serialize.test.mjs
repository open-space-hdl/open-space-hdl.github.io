import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { checkConnection } from '../../assets/composer/js/model/compat.js';
import { addDomain, addInstance, createDesign, moveToDomain, setAdapterGeneric, setConstant, setExternal, setGeneric, setSideband } from '../../assets/composer/js/model/design.js';
import { FormatError, fromDocument, fromText, toDocument, toText } from '../../assets/composer/js/model/serialize.js';
import { loadSnapshot, saveSnapshot, Workspace } from '../../assets/composer/js/model/workspace.js';
import { connect, designWith, loadCatalog } from './helpers.mjs';

const cat = loadCatalog();

function spwRmapNode() {
  const { design } = designWith(cat, ['openwire/owr_core', ['openrmap/omap_core', 'target']]);
  let d = connect(design, checkConnection(cat, design, 'rmap0.M_Pkt', 'spw0.S_Pkt'));
  d = connect(d, checkConnection(cat, d, 'spw0.M_Pkt', 'rmap0.S_Pkt'));
  return setGeneric(d, cat, 'spw0', 'LinkClkFreq_g', 200e6).design;
}

test('save and load give the same design and the same text', () => {
  const d = spwRmapNode();
  const text = toText(d, cat);
  const { design, warnings } = fromText(text, cat);
  assert.deepEqual(warnings, []);
  assert.deepEqual(design, d);
  assert.equal(toText(design, cat), text);
});

test('the document names the sources, the catalog and keeps only changed generics', () => {
  const doc = toDocument(spwRmapNode(), cat);
  assert.equal(doc.format, 'open-space-composer-system');
  assert.equal(doc.generator.catalog, cat.id);
  assert.deepEqual(doc.sources.map((s) => s.id), ['openwire', 'openrmap', 'olo']);
  assert.ok(doc.sources.every((s) => /^[0-9a-f]{40}$/.test(String(s.commit))));
  assert.deepEqual(doc.instances[0].generics, { LinkClkFreq_g: 200e6 });
  assert.equal(doc.instances[1].preset, 'target');
});

test('every example file loads and saves back unchanged', () => {
  const dir = new URL('../../assets/composer/examples/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.composer.json'));
  assert.ok(files.length >= 1);
  // the content identifier of the catalog is not part of the comparison: an example written before an unrelated
  // catalog change still loads without a remark and saves the same system
  const norm = (/** @type {string} */ t) => t.replace(/"catalog": "[0-9a-f]+"/g, '"catalog": "*"').replace(/\(catalog `[0-9a-f]+`\)/g, '(catalog `*`)');
  for (const f of files) {
    const text = readFileSync(new URL(f, dir), 'utf-8');
    const { design, warnings } = fromText(text, cat);
    assert.deepEqual(warnings, [], f);
    assert.equal(norm(toText(design, cat)), norm(text), f);
  }
});

test('broken files are rejected with clear messages', () => {
  const good = toDocument(spwRmapNode(), cat);
  const bad = (/** @type {(d: any) => void} */ fn) => {
    const d = structuredClone(good);
    fn(d);
    return () => fromDocument(d, cat);
  };
  assert.throws(() => fromText('{', cat), /not valid JSON/);
  assert.throws(() => fromText('[]', cat), /JSON object/);
  assert.throws(bad((d) => { d.format = 'x'; }), /not an Open Space Composer system file/);
  assert.throws(bad((d) => { d.formatVersion = 2; }), /format version 2/);
  assert.throws(bad((d) => { d.system.name = 'Bad Name'; }), /system.name/);
  assert.throws(bad((d) => { d.instances[0].block = 'openwire/nothing'; }), /unknown block/);
  assert.throws(bad((d) => { d.instances[1].id = 'spw0'; }), /duplicate id/);
  assert.throws(bad((d) => { d.instances[0].generics.TxFifoDepth_g = 100; }), /TxFifoDepth_g: Must be a power of 2/);
  assert.throws(bad((d) => { d.connections[0].to = 'rmap0.S_Pkt'; }), /Connection c1/);
  assert.throws(bad((d) => { d.connections.push({ ...d.connections[0] }); }), /duplicate id "c1"/);
  assert.throws(bad((d) => { d.externals = [{ interface: 'spw0.Spw', prefix: '1x' }]; }), /externals\[0\]/);
  try {
    fromDocument({ ...good, instances: [{ id: 'A' }, { id: 'b', block: 'x/y' }] }, cat);
    assert.fail('expected an error');
  } catch (e) {
    assert.ok(e instanceof FormatError);
    assert.equal(e.problems.length, 2, 'all problems are reported at once');
  }
});

test('tolerated deviations are warnings', () => {
  const doc = structuredClone(toDocument(spwRmapNode(), cat));
  doc.generator.catalog = 'other';
  delete doc.resolved;
  doc.instances[0].generics.Removed_g = 1;
  delete doc.layout.instances.rmap0;
  const t = doc.connections[0].from;
  doc.connections[0].from = doc.connections[0].to;
  doc.connections[0].to = t;
  const { design, warnings, unplaced } = fromDocument(doc, cat);
  assert.equal(warnings.length, 3, warnings.join('\n'));
  assert.equal(design.connections[0].from, 'rmap0.M_Pkt');
  // a block without a position gets one and is reported, so that the editor can arrange the system
  assert.ok(design.layout.instances.rmap0);
  assert.deepEqual(unplaced, ['rmap0']);
});

test('a file of another catalog version gets a remark only when the system resolves differently now', () => {
  const doc = structuredClone(toDocument(spwRmapNode(), cat));
  doc.generator.catalog = 'other';
  doc.resolved.catalog = 'other';
  assert.deepEqual(fromDocument(doc, cat).warnings, [], 'a catalog that only gained other blocks changes nothing');
  doc.resolved.instances[0].generics[0].value = 'changed';
  assert.match(fromDocument(doc, cat).warnings.join(' '), /another version of the block catalog, which resolves the system differently/);
});

test('side band constants are completed and checked', () => {
  const { design } = designWith(cat, ['openspp/spp_core']);
  const doc = toDocument(design, cat);
  assert.deepEqual(fromDocument(doc, cat).warnings, []);
});

test('workspace: tabs, undo and the autosave snapshot', () => {
  /** @type {Map<string, string>} */
  const mem = new Map();
  const storage = /** @type {Storage} */ (/** @type {unknown} */ ({
    getItem: (/** @type {string} */ k) => mem.get(k) ?? null,
    setItem: (/** @type {string} */ k, /** @type {string} */ v) => { mem.set(k, v); },
  }));
  const ws = new Workspace(cat);
  ws.addTab();
  ws.addTab(spwRmapNode());
  assert.equal(ws.tabs[1].design.name, 'test_system');
  assert.equal(ws.freeName(), 'system2');
  ws.apply('rename', (d) => ({ ...d, name: 'node_a' }));
  assert.equal(ws.active?.design.name, 'node_a');
  ws.undo();
  assert.equal(ws.active?.design.name, 'test_system');
  ws.redo();
  assert.ok(saveSnapshot(ws, storage));
  const ws2 = new Workspace(cat);
  const r = ws2.restore(loadSnapshot(storage));
  assert.equal(r.restored, 2);
  assert.equal(ws2.active?.design.name, 'node_a');
  assert.deepEqual(ws2.active?.design.connections, ws.active?.design.connections);
  ws2.closeTab(ws2.tabs[0].id);
  ws2.closeTab(ws2.tabs[0].id);
  assert.equal(ws2.tabs.length, 1, 'closing the last tab opens an empty one');
  assert.equal(new Workspace(cat).restore({ format: 'x' }).restored, 0);
  const throwing = /** @type {Storage} */ (/** @type {unknown} */ ({ setItem: () => { throw new Error('quota'); }, getItem: () => { throw new Error('denied'); } }));
  assert.equal(saveSnapshot(ws, throwing), false);
  assert.equal(loadSnapshot(throwing), undefined);
});

test('clock domains, externals, adapter generics and side band constants survive save and load', () => {
  const { design } = designWith(cat, ['openwire/owr_core', 'openrmap/omap_core', 'olo/olo_base_chunker', 'openspp/spp_core']);
  let d = connect(design, checkConnection(cat, design, 'rmap0.M_Pkt', 'spw0.S_Pkt'));
  d = connect(d, checkConnection(cat, d, 'chunk0.Out', 'spp0.S_Tx[0]'));
  d = setSideband(d, 'c2', 'apid', 0x123);
  const dom = addDomain(d, { name: 'Fast', frequencyHz: 150e6, box: { x: 10, y: 20, w: 400, h: 300 } });
  d = moveToDomain(dom.design, cat, 'rmap0', dom.id);
  d = setAdapterGeneric(d, 'c1', 'cdc', 'Depth_g', 64);
  d = setExternal(d, 'rmap0.M_Axi', 'Mem_');
  const text = toText(d, cat);
  const back = fromText(text, cat);
  assert.deepEqual(back.warnings, []);
  assert.deepEqual(back.design, d);
  assert.equal(toText(back.design, cat), text);
  const doc = JSON.parse(text);
  assert.deepEqual(doc.connections[0].adapters, { cdc: { Depth_g: 64 } });
  assert.deepEqual(doc.connections[1].sideband, { apid: 0x123, shi: false, type: false, nameValid: false, name: 0 });
  assert.deepEqual(doc.layout.domains, { clk1: { x: 10, y: 20, w: 400, h: 300 } });
});

test('a file without clock domains gets the default domain', () => {
  const doc = structuredClone(toDocument(spwRmapNode(), cat));
  doc.clockDomains = [];
  for (const i of doc.instances) i.clocks = {};
  const { design, warnings } = fromDocument(doc, cat);
  assert.deepEqual(design.clockDomains.map((c) => c.id), ['sys']);
  assert.deepEqual(design.instances[0].clocks, { UserClk: 'sys', LinkClk: 'sys', MgmtClk: 'sys' });
  assert.ok(warnings.some((w) => /no clock domains/.test(w)));
});

test('invalid clock domains and adapter settings are rejected', () => {
  const good = toDocument(spwRmapNode(), cat);
  const bad = (/** @type {(d: any) => void} */ fn) => {
    const x = structuredClone(good);
    fn(x);
    return () => fromDocument(x, cat);
  };
  assert.throws(bad((x) => { x.clockDomains.push({ id: 'pa', name: 'PA', frequencyHz: 1e8, source: { kind: 'block', instance: 'spw0', port: 'UserClk' } }); }), /source must be a clock output/);
  assert.throws(bad((x) => { x.clockDomains[0].frequencyHz = 0; }), /positive frequencyHz/);
  assert.throws(bad((x) => { x.instances[0].clocks.UserClk = 'nope'; }), /unknown clock domain/);
  assert.throws(bad((x) => { x.connections[0].adapters = { fifo: { Depth_g: 4 } }; }), /unknown adapter "fifo"/);
  assert.throws(bad((x) => { x.connections[0].adapters = { cdc: { Depth_g: 'x' } }; }), /not a generic value/);
});

test('instance constants and the derived parts of a file', () => {
  let d = createDesign('enc');
  d = addInstance(d, cat, 'opencrypto/ocr_framer', { x: 0, y: 0 }).design;
  d = setConstant(d, cat, 'frm0', 'Cfg', 'slot', 2);
  const text = toText(d, cat);
  const doc = JSON.parse(text);
  assert.deepEqual(doc.instances[0].constants, { Cfg: { slot: 2 } });
  assert.ok(doc.resolved && Array.isArray(doc.checks) && typeof doc.agent.brief === 'string');
  assert.ok(doc.agent.brief.startsWith('# enc: build brief'));
  const back = fromText(text, cat);
  assert.deepEqual(back.design.instances[0].constants, { Cfg: { slot: 2 } });
  assert.deepEqual(back.warnings, []);
  assert.equal(toText(back.design, cat), text);
  // the autosave leaves the derived parts out
  const lean = toDocument(d, cat, { full: false });
  assert.ok(!('resolved' in lean) && !('agent' in lean) && !('checks' in lean));
  // a netlist edited by hand is reported and resolved again
  const edited = structuredClone(doc);
  edited.resolved.nets = [];
  assert.match(fromDocument(edited, cat).warnings.join(' '), /resolved netlist in the file differs/);
  // invalid constants are refused
  const bad = structuredClone(doc);
  bad.instances[0].constants = { Cfg: { slot: 300 } };
  assert.throws(() => fromDocument(bad, cat), /integer from 0 to 255/);
  bad.instances[0].constants = { S_In: { slot: 1 } };
  assert.throws(() => fromDocument(bad, cat), /no interface with constants/);
});

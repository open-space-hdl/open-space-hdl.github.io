import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkConnection } from '../../assets/composer/js/model/compat.js';
import {
  addDomain, addInstance, assignClock, clearGeneric, createDesign, DesignError, identifierProblem, moveInstances, moveToDomain,
  removeConnections, removeDomain, removeInstances, renameDomain, setAdapterGeneric, setExternal, updateDomain,
  renameInstance, setGeneric, setSideband, setSystem,
} from '../../assets/composer/js/model/design.js';
import { History } from '../../assets/composer/js/model/history.js';
import { blockGeometry, connectionPath, fitViewport, isBackward, snap } from '../../assets/composer/js/model/layout.js';
import { connect, designWith, loadCatalog } from './helpers.mjs';

const cat = loadCatalog();

test('identifiers follow the VHDL rules', () => {
  assert.equal(identifierProblem('spw0'), null);
  assert.equal(identifierProblem('my_node_1'), null);
  assert.ok(identifierProblem('Spw0'));
  assert.ok(identifierProblem('a__b'));
  assert.ok(identifierProblem('a_'));
  assert.ok(identifierProblem('0a'));
  assert.ok(identifierProblem('signal'));
  assert.ok(identifierProblem('x'.repeat(41)));
});

test('instances get the lowest free id of their prefix and operations do not mutate', () => {
  const d0 = createDesign('node');
  const a = addInstance(d0, cat, 'openwire/owr_core', { x: 10.4, y: 20.6 });
  assert.equal(a.id, 'spw0');
  assert.deepEqual(a.design.layout.instances.spw0, { x: 10, y: 21 });
  assert.equal(d0.instances.length, 0);
  const b = addInstance(a.design, cat, 'openwire/owr_core', { x: 0, y: 0 });
  assert.equal(b.id, 'spw1');
  const c = removeInstances(b.design, ['spw0']);
  assert.equal(addInstance(c, cat, 'openwire/owr_core', { x: 0, y: 0 }).id, 'spw0');
  assert.throws(() => addInstance(d0, cat, 'openwire/owr_core', { x: 0, y: 0 }, 'nope'), DesignError);
});

test('removing an instance removes its connections; renaming updates them', () => {
  const { design } = designWith(cat, ['openwire/owr_core', 'openrmap/omap_core']);
  let d = connect(design, checkConnection(cat, design, 'rmap0.M_Pkt', 'spw0.S_Pkt'));
  d = connect(d, checkConnection(cat, d, 'spw0.M_Pkt', 'rmap0.S_Pkt'));
  const r = renameInstance(d, 'spw0', 'link');
  assert.deepEqual(r.connections.map((c) => [c.from, c.to]), [['rmap0.M_Pkt', 'link.S_Pkt'], ['link.M_Pkt', 'rmap0.S_Pkt']]);
  assert.ok(r.layout.instances.link);
  assert.ok(!r.layout.instances.spw0);
  assert.throws(() => renameInstance(d, 'spw0', 'rmap0'), DesignError);
  assert.throws(() => renameInstance(d, 'spw0', 'Bad'), DesignError);
  assert.equal(removeInstances(d, ['rmap0']).connections.length, 0);
  assert.equal(removeConnections(d, ['c1']).connections.length, 1);
});

test('generics: validated, stored only when they differ, and connections of vanished interfaces are removed', () => {
  const { design } = designWith(cat, ['openwire/owr_core', 'openspp/spp_core', 'olo/olo_base_chunker']);
  let d = setGeneric(design, cat, 'spp0', 'NumTx_g', 2).design;
  assert.deepEqual(d.instances[1].generics, { NumTx_g: 2 });
  d = connect(d, checkConnection(cat, d, 'chunk0.Out', 'spp0.S_Tx[1]'));
  assert.equal(d.connections.length, 1);
  const back = setGeneric(d, cat, 'spp0', 'NumTx_g', 1);
  assert.deepEqual(back.design.instances[1].generics, {});
  assert.equal(back.removed.length, 1);
  assert.equal(back.design.connections.length, 0);
  assert.throws(() => setGeneric(d, cat, 'spp0', 'NumTx_g', 99), DesignError);
  assert.throws(() => setGeneric(d, cat, 'spp0', 'Nope_g', 1), DesignError);
  const noTc = setGeneric(d, cat, 'spw0', 'TimeCodes_g', false);
  assert.deepEqual(noTc.removed, []);
});

test('system properties, moves and side band constants', () => {
  const { design } = designWith(cat, ['openwire/owr_core']);
  assert.equal(setSystem(design, { name: 'payload_node' }).name, 'payload_node');
  assert.throws(() => setSystem(design, { name: 'Payload' }), DesignError);
  assert.deepEqual(moveInstances(design, { spw0: { x: 33.3, y: 7 }, ghost: { x: 1, y: 1 } }).layout.instances, { spw0: { x: 33, y: 7 } });
  const d = { ...design, connections: [{ id: 'c1', from: 'a.B', to: 'c.D', sideband: { apid: 1 } }] };
  assert.deepEqual(setSideband(d, 'c1', 'apid', 5).connections[0].sideband, { apid: 5 });
});

test('history: undo and redo restore the exact states', () => {
  /** @type {History<number>} */
  const h = new History(3);
  h.record(1, 'a');
  h.record(2, 'b');
  assert.equal(h.undoLabel, 'b');
  assert.equal(h.undo(3), 2);
  assert.equal(h.redoLabel, 'b');
  assert.equal(h.redo(2), 3);
  h.record(3, 'c');
  h.record(4, 'd');
  assert.equal(h.past.length, 3, 'limited');
  h.undo(5);
  h.record(4, 'e');
  assert.equal(h.canRedo, false, 'a new command clears the redo stack');
});

test('layout geometry', () => {
  const owr = cat.block('openwire/owr_core');
  const g = blockGeometry(cat.ports(owr, cat.genericValues(owr)));
  const sPkt = g.ports.get('S_Pkt');
  const mPkt = g.ports.get('M_Pkt');
  const spw = g.ports.get('Spw');
  assert.equal(sPkt?.side, 'left');
  assert.equal(sPkt?.x, 0);
  assert.equal(mPkt?.side, 'right');
  assert.equal(mPkt?.x, g.width);
  assert.equal(spw?.side, 'bottom');
  assert.equal(spw?.y, g.height);
  assert.match(connectionPath({ x: 0, y: 0, side: 'right' }, { x: 200, y: 50, side: 'left' }), /^M0,0 C\d/);
  // a backward connection runs below the blocks at the detour line
  assert.equal(isBackward({ x: 500, side: 'right' }, { x: 100, side: 'left' }), true);
  assert.equal(isBackward({ x: 100, side: 'right' }, { x: 500, side: 'left' }), false);
  const loop = connectionPath({ x: 500, y: 100, side: 'right' }, { x: 100, y: 120, side: 'left' }, 300);
  assert.match(loop, / L100,300 /);
  assert.ok(!/ L/.test(connectionPath({ x: 100, y: 100, side: 'right' }, { x: 500, y: 120, side: 'left' }, 300)));
  assert.equal(snap(23), 16);
  assert.equal(snap(25), 32);
  const v = fitViewport({ x: 0, y: 0, width: 400, height: 200 }, 800, 600);
  assert.ok(v.zoom > 0 && v.zoom <= 1.25);
});

test('clock domains: add, update, rename, merge and assign', () => {
  const { design } = designWith(cat, ['openwire/owr_core', 'openrmap/omap_core']);
  const a = addDomain(design, { name: 'Link', frequencyHz: 200e6, box: { x: 1, y: 2, w: 300, h: 200 } });
  assert.equal(a.id, 'clk1');
  assert.deepEqual(a.design.layout.domains.clk1, { x: 1, y: 2, w: 300, h: 200 });
  assert.throws(() => addDomain(design, { frequencyHz: 0 }), DesignError);
  assert.throws(() => updateDomain(a.design, 'clk1', { frequencyHz: -5 }), DesignError);
  assert.throws(() => updateDomain(a.design, 'clk1', { name: ' ' }), DesignError);
  assert.equal(updateDomain(a.design, 'clk1', { name: ' Fast ' }).clockDomains[1].name, 'Fast');
  let d = assignClock(a.design, cat, 'spw0', 'LinkClk', 'clk1');
  assert.deepEqual(d.instances[0].clocks, { UserClk: 'sys', LinkClk: 'clk1', MgmtClk: 'sys' });
  assert.throws(() => assignClock(d, cat, 'spw0', 'Nope', 'clk1'), DesignError);
  assert.throws(() => assignClock(d, cat, 'spw0', 'UserClk', 'nope'), DesignError);
  // moving to a domain takes the clocks that share the domain of the primary clock along
  const moved = moveToDomain(d, cat, 'spw0', 'clk1');
  assert.deepEqual(moved.instances[0].clocks, { UserClk: 'clk1', LinkClk: 'clk1', MgmtClk: 'clk1' });
  d = renameDomain(d, 'clk1', 'link');
  assert.equal(d.instances[0].clocks.LinkClk, 'link');
  assert.ok(d.layout.domains.link);
  assert.throws(() => renameDomain(d, 'link', 'sys'), DesignError);
  assert.throws(() => renameDomain(d, 'link', 'Bad'), DesignError);
  const merged = removeDomain(d, 'link', 'sys');
  assert.deepEqual(merged.clockDomains.map((c) => c.id), ['sys']);
  assert.equal(merged.instances[0].clocks.LinkClk, 'sys');
  assert.ok(!merged.layout.domains.link);
  assert.throws(() => removeDomain(d, 'link', 'link'), DesignError);
});

test('externals, adapter generics and generics that follow a connection', () => {
  const { design } = designWith(cat, ['openwire/owr_core', 'openrmap/omap_core', 'olo/olo_ft_fifo_sync']);
  let d = setExternal(design, 'spw0.S_AxiLite', 'Regs_');
  assert.deepEqual(d.externals, [{ interface: 'spw0.S_AxiLite', prefix: 'Regs_' }]);
  d = setExternal(d, 'spw0.S_AxiLite', 'Owr_');
  assert.deepEqual(d.externals, [{ interface: 'spw0.S_AxiLite', prefix: 'Owr_' }]);
  assert.throws(() => setExternal(d, 'spw0.S_Pkt', '1x'), DesignError);
  const linked = connect(d, checkConnection(cat, d, 'rmap0.M_Pkt', 'spw0.S_Pkt'));
  assert.throws(() => setExternal(linked, 'spw0.S_Pkt', 'P_'), DesignError);
  assert.deepEqual(setExternal(d, 'spw0.S_AxiLite', null).externals, []);
  let e = setAdapterGeneric(linked, 'c1', 'cdc', 'Depth_g', 128);
  assert.deepEqual(e.connections[0].adapters, { cdc: { Depth_g: 128 } });
  e = setAdapterGeneric(e, 'c1', 'cdc', 'Depth_g', undefined);
  assert.equal(e.connections[0].adapters, undefined);
  // a width set to its default stays set (it no longer follows the connection) until it is cleared
  const fixed = setGeneric(design, cat, 'fifo0', 'Width_g', 32).design;
  assert.deepEqual(fixed.instances[2].generics, { Width_g: 32 });
  assert.deepEqual(clearGeneric(fixed, cat, 'fifo0', 'Width_g').design.instances[2].generics, {});
});

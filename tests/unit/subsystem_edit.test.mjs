// Editing with subsystems (model/subsystems.js): placing the system of another tab, which systems may be placed, the
// subsystems whose tab holds another version, updating them in one step, and a definition as a system of its own.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDesign, setExternal, setSystem } from '../../assets/composer/js/model/design.js';
import { resolve } from '../../assets/composer/js/model/resolver.js';
import { fromText, toDocument } from '../../assets/composer/js/model/serialize.js';
import {
  changedSubsystems, definitionAsSystem, definitionsOf, placeProblem, placeSubsystem, sameDefinition, updateSubsystem,
  withSubsystems, wouldReplace,
} from '../../assets/composer/js/model/subsystems.js';
import { loadCatalog, ROOT } from './helpers.mjs';

const cat = loadCatalog();
/** @param {string} file */
const example = (file) => fromText(readFileSync(`${ROOT}assets/composer/examples/${file}.composer.json`, 'utf-8'), cat).design;
const fixture = () => fromText(readFileSync(`${ROOT}tests/fixtures/subsystems/dual_rmap_node.composer.json`, 'utf-8'), cat).design;

test('a system brings itself and the definitions it uses; layouts play no part in comparing them', () => {
  const node = definitionAsSystem(fixture(), 'rmap_node');
  assert.equal(node.name, 'rmap_node');
  assert.deepEqual(Object.keys(node.subsystems ?? {}), ['spw_port']);
  const defs = definitionsOf(node);
  assert.deepEqual(Object.keys(defs), ['spw_port', 'rmap_node']);
  assert.equal(defs.rmap_node.subsystems, undefined);
  const moved = { ...defs.rmap_node, layout: { ...defs.rmap_node.layout, instances: { rmap0: { x: 999, y: 0 } } } };
  assert.ok(sameDefinition(defs.rmap_node, moved));
  assert.ok(!sameDefinition(defs.rmap_node, setSystem(defs.rmap_node, { description: 'other' })));
});

test('a system may not be placed in itself, in a system it contains, or empty', () => {
  const top = fixture();
  const node = definitionAsSystem(top, 'rmap_node');
  const port = definitionAsSystem(top, 'spw_port');
  assert.equal(placeProblem(node, node), 'rmap_node is this system.');
  // spw_port is inside rmap_node: rmap_node cannot be placed in spw_port
  assert.equal(placeProblem(port, node), 'rmap_node contains spw_port.');
  assert.equal(placeProblem(port, createDesign('empty')), 'empty has no blocks.');
  assert.equal(placeProblem(createDesign('host'), node), '');
});

test('placing a system adds its definitions and an instance; the result resolves without errors once wired', () => {
  const sys = example('spw_rmap_node');
  let d = createDesign('host');
  const r = placeSubsystem(d, cat, sys, { x: 100, y: 100 });
  d = r.design;
  assert.equal(r.id, 'spw_rmap_node0');
  assert.deepEqual(r.replaced, []);
  assert.deepEqual(Object.keys(d.subsystems ?? {}), ['spw_rmap_node']);
  // the link clock gets a domain of its own: one domain for both would cut the crossing of the SpaceWire port
  assert.deepEqual(d.instances[0].clocks, { Clk_sys: 'sys', Clk_link: 'link' });
  assert.deepEqual(d.clockDomains.map((c) => [c.id, c.name, c.frequencyHz]), [['sys', 'System clock', 100e6], ['link', 'Link clock', 200e6]]);
  for (const [ref, prefix] of [['spw_rmap_node0.mem', 'mem_'], ['spw_rmap_node0.spw_reg', 'spw_'], ['spw_rmap_node0.rmap_reg', 'rmap_']]) d = setExternal(d, ref, prefix);
  assert.deepEqual(resolve(cat, d).checks.filter((c) => c.severity === 'error'), []);
  // a second instance joins the existing link domain
  const second = placeSubsystem(d, cat, sys, { x: 400, y: 100 });
  assert.deepEqual(second.design.instances[1].clocks, { Clk_sys: 'sys', Clk_link: 'link' });
  assert.equal(second.design.clockDomains.length, 2);
  // a domain link of another frequency is not taken: a new one with the frequency inside
  const other = { ...d, clockDomains: d.clockDomains.map((c) => (c.id === 'link' ? { ...c, frequencyHz: 125e6 } : c)) };
  const third = placeSubsystem(other, cat, sys, { x: 800, y: 100 });
  const bound = third.design.instances[1].clocks.Clk_link;
  assert.notEqual(bound, 'link');
  assert.equal(third.design.clockDomains.find((c) => c.id === bound)?.frequencyHz, 200e6);
  assert.deepEqual(resolve(cat, third.design).checks.filter((c) => c.rule.startsWith('subsystem') && c.instance === 'spw_rmap_node1'), []);
  const doc = /** @type {any} */ (toDocument(d, cat));
  assert.equal(doc.formatVersion, 2);
  assert.deepEqual(doc.subsystems.map((/** @type {any} */ s) => s.name), ['spw_rmap_node']);
});

test('a subsystem whose tab holds another version is changed; updating it is one step and keeps its bindings', () => {
  const sys = example('spw_rmap_node');
  const placed = placeSubsystem(createDesign('host'), cat, sys, { x: 0, y: 0 }).design;
  assert.equal(changedSubsystems(placed, [sys]).size, 0);
  const edited = setSystem(sys, { description: 'Edited in its tab.' });
  assert.deepEqual([...changedSubsystems(placed, [edited]).keys()], ['spw_rmap_node']);
  assert.deepEqual(wouldReplace(placed, edited), ['spw_rmap_node']);
  const u = updateSubsystem(placed, cat, edited);
  assert.deepEqual(u.replaced, ['spw_rmap_node']);
  assert.equal(u.design.subsystems?.spw_rmap_node.description, 'Edited in its tab.');
  assert.deepEqual(u.design.instances, placed.instances);
  assert.equal(changedSubsystems(u.design, [edited]).size, 0);
  // placing the edited version replaces the stored one as well
  const again = placeSubsystem(placed, cat, edited, { x: 400, y: 0 });
  assert.deepEqual(again.replaced, ['spw_rmap_node']);
  assert.equal(again.design.instances.length, 2);
});

test('an update removes the externals of interfaces the new version no longer has', () => {
  const sys = example('spw_rmap_node');
  let d = placeSubsystem(createDesign('host'), cat, sys, { x: 0, y: 0 }).design;
  d = setExternal(d, 'spw_rmap_node0.spw_reg', 'reg_');
  d = setExternal(d, 'spw_rmap_node0.mem', 'mem_');
  // the register port of the SpaceWire port is no longer external in the tab
  const smaller = /** @type {any} */ (setExternal(sys, 'spw0.S_AxiLite', null));
  const u = updateSubsystem(d, cat, smaller);
  assert.deepEqual(u.design.externals.map((e) => e.interface), ['spw_rmap_node0.mem']);
  const sc = withSubsystems(cat, u.design);
  assert.ok(!sc.block('subsystem/spw_rmap_node').interfaces.some((i) => i.name === 'spw_reg'));
});

test('a definition opens as a system of its own with the definitions it uses', () => {
  const top = fixture();
  const node = definitionAsSystem(top, 'rmap_node');
  const { checks } = resolve(cat, node);
  assert.deepEqual(checks.filter((c) => c.severity === 'error'), []);
  assert.throws(() => definitionAsSystem(top, 'nothing'), /nothing has no definition in dual_rmap_node/);
});

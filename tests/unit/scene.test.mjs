// Scene: adapters on the domain border and next to their source, routes around blocks; tidy, arrange and the diff
// that drives the animations.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ARRANGE, arrange, DOMAIN_GAP, greedyOrder, layers, needsArrange, placeBetween, separate, tidy } from '../../assets/composer/js/model/arrange.js';
import { checkConnection } from '../../assets/composer/js/model/compat.js';
import {
  addConnection, addDomain, addInstance, createDesign, moveInstances, moveToDomain, removeConnections, removeDomain, setGeneric,
} from '../../assets/composer/js/model/design.js';
import { diffScenes, isEmptyDiff } from '../../assets/composer/js/model/diff.js';
import { ADAPTER_HEIGHT, ADAPTER_WIDTH } from '../../assets/composer/js/model/layout.js';
import { resolve } from '../../assets/composer/js/model/resolver.js';
import { crossesRect, overlaps } from '../../assets/composer/js/model/router.js';
import { ADAPTER_OFFSET, buildScene } from '../../assets/composer/js/model/scene.js';
import { catalogWith, connect, designWith, loadCatalog, streamBlock } from './helpers.mjs';

const cat = loadCatalog();

/**
 * @param {any} c
 * @param {any} d
 * @param {string} a
 * @param {string} b
 */
function link(c, d, a, b) {
  const chk = checkConnection(c, d, a, b);
  assert.ok(chk.ok, chk.reason);
  return connect(d, chk);
}

/** @param {any} d */
const scene = (d, c = cat) => buildScene(c, d, resolve(c, d));

/** @param {{x: number, y: number}[]} P */
function orthogonal(P) {
  return P.every((p, i) => i === 0 || p.x === P[i - 1].x || p.y === P[i - 1].y);
}

/** SpaceWire port left, RMAP target right, both directions connected. */
function pair(dx = 560) {
  let d = addInstance(createDesign('t'), cat, 'openwire/owr_core', { x: 96, y: 96 }).design;
  d = addInstance(d, cat, 'openrmap/omap_core', { x: 96 + dx, y: 96 }, 'target').design;
  d = link(cat, d, 'spw0.M_Pkt', 'rmap0.S_Pkt');
  return link(cat, d, 'rmap0.M_Pkt', 'spw0.S_Pkt');
}

/**
 * Every hop is orthogonal and passes no block except where it starts or ends.
 * @param {ReturnType<typeof buildScene>} sc
 */
function assertClean(sc) {
  for (const e of sc.edges.values()) {
    for (const h of e.hops) {
      assert.ok(orthogonal(h), `${e.id} is not orthogonal`);
      for (const b of sc.blocks.values()) {
        const inner = { x: b.x + 1, y: b.y + 1, w: b.w - 2, h: b.h - 2 };
        assert.ok(!crossesRect(h, inner), `${e.id} crosses ${b.id}`);
      }
      for (const ad of sc.adapters.values()) {
        if (e.adapters.includes(ad.id)) continue;
        assert.ok(!crossesRect(h, { x: ad.rect.x + 1, y: ad.rect.y + 1, w: ad.rect.w - 2, h: ad.rect.h - 2 }), `${e.id} crosses ${ad.id}`);
      }
    }
  }
}

test('the connections of a block pair are routed cleanly; the feedback loop stays close to the blocks', () => {
  const sc = scene(pair());
  assertClean(sc);
  const fwd = sc.edges.get('c1')?.hops[0] ?? [];
  const back = sc.edges.get('c2')?.hops[0] ?? [];
  assert.equal(fwd.length, 2, 'aligned top ports: a straight connection');
  const spw = /** @type {any} */ (sc.blocks.get('spw0'));
  const rmap = /** @type {any} */ (sc.blocks.get('rmap0'));
  const top = Math.min(...back.map((p) => p.y));
  assert.ok(top < Math.min(spw.y, rmap.y) && top >= Math.min(spw.y, rmap.y) - 30, `loop at ${top}`);
  assert.ok(Math.min(...back.map((p) => p.x)) >= spw.x - 30 && Math.max(...back.map((p) => p.x)) <= rmap.x + rmap.w + 30);
  assert.equal(back[0].y, back[1].y, 'leaves the port horizontally');
  assert.equal(back.at(-1)?.y, back.at(-2)?.y, 'enters the port horizontally');
});

test('a clock crossing sits on its connection, centred on the border between the two domain boxes', () => {
  let d = pair();
  const r = addDomain(d, { name: 'Fast', frequencyHz: 150e6 });
  d = moveToDomain(r.design, cat, 'rmap0', r.id);
  const sc = scene(d);
  assertClean(sc);
  const sys = /** @type {any} */ (sc.domains.get('sys')?.box);
  const fast = /** @type {any} */ (sc.domains.get(r.id)?.box);
  const border = (sys.x + sys.w + fast.x) / 2;
  const fwd = /** @type {any} */ (sc.adapters.get(resolve(cat, d).chainOf.get('c1')?.adapters[0] ?? ''));
  assert.equal(fwd.orient, 'h');
  assert.equal(fwd.reverse, false);
  assert.ok(Math.abs(fwd.x - border) <= 1, `adapter at ${fwd.x}, border at ${border}`);
  // the feedback connection crosses the border too, flowing to the left
  const back = /** @type {any} */ (sc.adapters.get(resolve(cat, d).chainOf.get('c2')?.adapters[0] ?? ''));
  assert.equal(back.reverse, true);
  assert.ok(Math.abs(back.x - border) <= 1);
  // the hops end at the adapter terminals
  const hops = sc.edges.get('c1')?.hops ?? [];
  assert.equal(hops.length, 2);
  assert.deepEqual(hops[0].at(-1), { x: fwd.rect.x, y: fwd.y });
  assert.deepEqual(hops[1][0], { x: fwd.rect.x + ADAPTER_WIDTH, y: fwd.y });
  for (const ad of sc.adapters.values()) for (const b of sc.blocks.values()) assert.ok(!overlaps(ad.rect, b));
});

test('a width converter sits right next to its source port', () => {
  const c = catalogWith([
    streamBlock('test/b32', { name: 'Out', type: 'byte.stream', role: 'source', widths: { data: 'W_g', keep: 'W_g / 8', last: 1 }, ready: true, generics: { W_g: 32 } }),
    streamBlock('test/b64', { name: 'In', type: 'byte.stream', role: 'sink', widths: { data: 'W_g', keep: 'W_g / 8', last: 1 }, ready: true, generics: { W_g: 64 } }),
  ]);
  let d = addInstance(createDesign('t'), c, 'test/b32', { x: 0, y: 0 }).design;
  d = addInstance(d, c, 'test/b64', { x: 640, y: 0 }).design;
  d = link(c, d, 'b320.Out', 'b640.In');
  const sc = scene(d, c);
  const res = resolve(c, d);
  const w = /** @type {any} */ (sc.adapters.get(res.chainOf.get('c1')?.adapters[0] ?? ''));
  const src = /** @type {any} */ (sc.blocks.get('b320'));
  const port = src.geom.ports.get('Out');
  assert.equal(w.rect.x, src.x + port.x + ADAPTER_OFFSET);
  assert.equal(w.y, src.y + port.y);
  assert.equal(w.orient, 'h');
});

test('adapters of neighbouring connections do not overlap', () => {
  const c = catalogWith([
    streamBlock('test/dual_src', { name: 'Out', type: 'byte.stream', role: 'source', widths: { data: 8, keep: 1, last: 1 }, ready: true }),
    streamBlock('test/dual_snk', { name: 'In', type: 'byte.stream', role: 'sink', widths: { data: 8, keep: 1, last: 1 }, ready: true }),
  ]);
  let d = createDesign('t');
  d = addInstance(d, c, 'test/dual_src', { x: 0, y: 0 }).design;
  d = addInstance(d, c, 'test/dual_src', { x: 0, y: 40 }).design;
  d = addInstance(d, c, 'test/dual_snk', { x: 640, y: 0 }).design;
  d = addInstance(d, c, 'test/dual_snk', { x: 640, y: 40 }).design;
  const r = addDomain(d, {});
  d = moveToDomain(moveToDomain(r.design, c, 'dual_snk0', r.id), c, 'dual_snk1', r.id);
  d = link(c, d, 'dual_src0.Out', 'dual_snk0.In');
  d = link(c, d, 'dual_src1.Out', 'dual_snk1.In');
  const ads = [...scene(d, c).adapters.values()];
  assert.equal(ads.length, 2);
  assert.ok(!overlaps(ads[0].rect, ads[1].rect));
});

test('the scene is deterministic', () => {
  let d = pair();
  const r = addDomain(d, {});
  d = moveToDomain(r.design, cat, 'rmap0', r.id);
  const json = (/** @type {any} */ sc) => JSON.stringify([[...sc.blocks.values()].map((b) => [b.id, b.x, b.y]), [...sc.adapters.values()], [...sc.edges.values()]]);
  assert.equal(json(scene(d)), json(scene(d)));
  const cache = new Map();
  const res = resolve(cat, d);
  assert.equal(json(buildScene(cat, d, res, { cache })), json(buildScene(cat, d, res, { cache })));
  assert.equal(json(buildScene(cat, d, res, { cache })), json(scene(d)));
});

// ---------------------------------------------------------------------------------------------------------------------
// tidy and arrange
// ---------------------------------------------------------------------------------------------------------------------

test('separate moves boxes apart along the shorter axis; anchors stay; pushes travel along a chain', () => {
  const boxes = [
    { id: 'a', x: 0, y: 0, w: 200, h: 100 },
    { id: 'b', x: 150, y: 0, w: 200, h: 100 },
    { id: 'c', x: 400, y: 0, w: 200, h: 100 },
  ];
  const m = separate(boxes, ['a'], 50);
  assert.equal(m.has('a'), false);
  assert.deepEqual(m.get('b'), { dx: 100, dy: 0 });
  // b now ends at 450 and pushes c to 500
  assert.deepEqual(m.get('c'), { dx: 100, dy: 0 });
  assert.deepEqual(separate(boxes, ['b'], 50).get('a'), { dx: -100, dy: 0 });
  assert.equal(separate([{ id: 'x', x: 0, y: 0, w: 10, h: 10 }, { id: 'y', x: 100, y: 0, w: 10, h: 10 }], [], 50).size, 0);
});

test('tidy keeps domain boxes apart and moves a block dropped on another block', () => {
  let d = pair(300);
  const r = addDomain(d, {});
  d = moveToDomain(r.design, cat, 'rmap0', r.id);
  // the boxes overlap: rmap0 is 300 to the right of spw0 (blocks are 248 wide)
  const t = tidy(cat, d, { anchors: ['sys'] });
  const sc = scene(t);
  const a = /** @type {any} */ (sc.domains.get('sys')?.box);
  const b = /** @type {any} */ (sc.domains.get(r.id)?.box);
  assert.ok(b.x >= a.x + a.w + DOMAIN_GAP, 'boxes apart');
  assert.deepEqual(t.layout.instances.spw0, d.layout.instances.spw0, 'the anchor stays');
  assert.equal((t.layout.instances.rmap0.x - d.layout.instances.rmap0.x) % 16, 0, 'moves keep the grid');
  assert.strictEqual(tidy(cat, t, { anchors: ['sys'] }), t, 'nothing to do: the same design');
  // a block dropped on top of another one
  let e = addInstance(createDesign('t'), cat, 'openwire/owr_core', { x: 0, y: 0 }).design;
  e = addInstance(e, cat, 'openwire/owr_core', { x: 32, y: 32 }).design;
  const f = tidy(cat, e, { dropped: ['spw1'] });
  const s2 = scene(f);
  assert.ok(!overlaps(/** @type {any} */ (s2.blocks.get('spw0')), /** @type {any} */ (s2.blocks.get('spw1'))));
});

test('the greedy order puts sources first and sinks last; layers follow the forward edges', () => {
  const order = greedyOrder(['c', 'b', 'a', 'x'], [{ u: 'a', v: 'b', w: 1 }, { u: 'b', v: 'c', w: 1 }, { u: 'c', v: 'b', w: 1 }]);
  // a is a source; in the cycle of b and c, b comes first because a feeds it
  assert.deepEqual(order, ['a', 'x', 'b', 'c']);
  const l = layers(order, [{ u: 'a', v: 'b' }, { u: 'b', v: 'c' }, { u: 'c', v: 'b' }]);
  assert.deepEqual([l.get('a'), l.get('b'), l.get('c')], [0, 1, 2]);
});

/** Space Packets over SpaceWire: SPP node, N-Char adapter, RMAP target with pass-through, SpaceWire port. */
function sppOverSpw() {
  let d = createDesign('t');
  for (const [b, p] of [['openspp/spp_core'], ['openspp/spp_nchar'], ['openrmap/omap_core', 'target'], ['openwire/owr_core']]) {
    d = addInstance(d, cat, /** @type {string} */ (b), { x: 0, y: 0 }, p).design;
  }
  d = setGeneric(d, cat, 'rmap0', 'Passthrough_g', true).design;
  d = link(cat, d, 'spp0.M_Link', 'nchar0.S_Link');
  d = link(cat, d, 'nchar0.M_Link', 'spp0.S_Link');
  d = link(cat, d, 'nchar0.M_NChar', 'rmap0.S_User');
  d = link(cat, d, 'rmap0.M_User', 'nchar0.S_NChar');
  d = link(cat, d, 'rmap0.M_Pkt', 'spw0.S_Pkt');
  return link(cat, d, 'spw0.M_Pkt', 'rmap0.S_Pkt');
}

test('arrange lays out the data flow from left to right without overlaps', () => {
  const d = sppOverSpw();
  assert.ok(needsArrange(d));
  const a = arrange(cat, d);
  assert.ok(!needsArrange(a));
  const sc = scene(a);
  const x = (/** @type {string} */ id) => /** @type {any} */ (sc.blocks.get(id)).x;
  assert.ok(x('spp0') < x('nchar0') && x('nchar0') < x('rmap0') && x('rmap0') < x('spw0'), 'one column per stage');
  const bl = [...sc.blocks.values()];
  for (let i = 0; i < bl.length; i += 1) for (let j = i + 1; j < bl.length; j += 1) assert.ok(!overlaps(bl[i], bl[j]));
  assertClean(sc);
  // the forward connections of the chain run straight
  const straight = [...sc.edges.values()].filter((e) => e.hops.length === 1 && e.hops[0].length === 2).length;
  assert.ok(straight >= 3, `${straight} straight connections`);
  // deterministic and stable
  assert.deepEqual(arrange(cat, d).layout, a.layout);
  assert.deepEqual(arrange(cat, a).layout.instances, a.layout.instances);
});

test('arrange puts clock domains side by side with room for the clock crossing on the border', () => {
  let d = sppOverSpw();
  const r = addDomain(d, { name: 'Port', frequencyHz: 50e6 });
  d = r.design;
  for (const id of ['nchar0', 'rmap0', 'spw0']) d = moveToDomain(d, cat, id, r.id);
  const a = arrange(cat, d);
  const sc = scene(a);
  const sys = /** @type {any} */ (sc.domains.get('sys')?.box);
  const port = /** @type {any} */ (sc.domains.get(r.id)?.box);
  assert.ok(!overlaps(sys, port));
  assert.equal(port.x - (sys.x + sys.w), ARRANGE.domainGapX);
  const fifos = [...sc.adapters.values()];
  assert.equal(fifos.length, 2);
  for (const f of fifos) {
    assert.ok(Math.abs(f.x - (sys.x + sys.w + port.x) / 2) <= 1, 'centred on the border');
    for (const b of sc.blocks.values()) assert.ok(!overlaps(f.rect, b));
  }
  assertClean(sc);
});

test('an empty domain keeps its placeholder box beside the arranged blocks', () => {
  let d = pair();
  const r = addDomain(d, { box: { x: 0, y: 0, w: 360, h: 260 } });
  d = r.design;
  const a = arrange(cat, d);
  const sc = scene(a);
  const box = /** @type {any} */ (sc.domains.get(r.id)?.box);
  const sys = /** @type {any} */ (sc.domains.get('sys')?.box);
  assert.equal(box.w, 360);
  assert.ok(!overlaps(box, sys));
});

// ---------------------------------------------------------------------------------------------------------------------
// diff of scenes (drives the animations)
// ---------------------------------------------------------------------------------------------------------------------

test('the diff lists new connections, inserted and removed adapters and moved blocks', () => {
  const d0 = pair();
  const s0 = scene(d0);
  assert.ok(isEmptyDiff(diffScenes(null, s0)), 'a first scene has nothing to animate');
  assert.ok(isEmptyDiff(diffScenes(s0, scene(d0))));
  // a new clock domain for rmap0 inserts two FIFOs
  const r = addDomain(d0, {});
  const d1 = moveToDomain(r.design, cat, 'rmap0', r.id);
  const s1 = scene(d1);
  const df = diffScenes(s0, s1);
  assert.equal(df.adaptersAdded.length, 2);
  assert.deepEqual(df.edgesChanged, ['c1', 'c2']);
  assert.deepEqual(df.domainsAdded, [r.id]);
  assert.equal(df.domainsChanged.length, 1, 'the system box shrinks to spw0');
  // merging the domains removes them again, at the place where they were
  const back = diffScenes(s1, scene(removeDomain(d1, r.id, 'sys')));
  assert.equal(back.adaptersRemoved.length, 2);
  assert.deepEqual(back.adaptersRemoved.map((x) => x.at), df.adaptersAdded.map((id) => ({ x: /** @type {any} */ (s1.adapters.get(id)).x, y: /** @type {any} */ (s1.adapters.get(id)).y })));
  // moving a block, removing a connection, adding one
  const mv = diffScenes(s0, scene(moveInstances(d0, { rmap0: { x: 656, y: 160 } })));
  assert.deepEqual(mv.blocksMoved, [{ id: 'rmap0', from: { x: 656, y: 96 }, to: { x: 656, y: 160 } }]);
  const rm = diffScenes(s0, scene(removeConnections(d0, ['c2'])));
  assert.deepEqual(rm.edgesRemoved, ['c2']);
  const add = diffScenes(scene(removeConnections(d0, ['c2'])), s0);
  assert.deepEqual(add.edgesAdded, ['c2']);
});

test('a block added and removed', () => {
  const d0 = pair();
  const d1 = addInstance(d0, cat, 'openspp/spp_nchar', { x: 96, y: 600 }).design;
  const df = diffScenes(scene(d0), scene(d1));
  assert.deepEqual(df.blocksAdded, ['nchar0']);
  assert.deepEqual(diffScenes(scene(d1), scene(d0)).blocksRemoved, ['nchar0']);
  assert.equal(addConnection(d1, 'nchar0.M_NChar', 'rmap0.S_User').design.connections.length, 3);
});

test('a bridge goes between its two blocks; the receiving side moves aside when the gap is narrow', () => {
  let d = addInstance(createDesign('t'), cat, 'openspp/spp_core', { x: 0, y: 0 }).design;
  d = addInstance(d, cat, 'openwire/owr_core', { x: 400, y: 0 }).design;
  d = addInstance(d, cat, 'openspp/spp_nchar', { x: 0, y: 600 }).design;
  const p = placeBetween(cat, d, 'spp0.M_Link', 'spw0.S_Pkt', 'nchar0', 'S_Link');
  assert.ok(p);
  const sc = scene(p);
  const spp = /** @type {any} */ (sc.blocks.get('spp0'));
  const nchar = /** @type {any} */ (sc.blocks.get('nchar0'));
  const spw = /** @type {any} */ (sc.blocks.get('spw0'));
  assert.deepEqual([spp.x, nchar.x], [0, spp.w + ARRANGE.colGap]);
  assert.ok(spw.x >= nchar.x + nchar.w + ARRANGE.colGap, 'the receiver moved to the right');
  assert.equal(spw.x % 16, 400 % 16);
  assert.equal(nchar.y + nchar.geom.ports.get('S_Link').y, spp.y + spp.geom.ports.get('M_Link').y, 'in line with the driver port');
  // blocks one above the other: no place between them
  const e = moveInstances(d, { spw0: { x: 0, y: 400 } });
  assert.equal(placeBetween(cat, e, 'spp0.M_Link', 'spw0.S_Pkt', 'nchar0', 'S_Link'), null);
});

test('in a wide gap between two domain boxes the clock crossing sits across the border, in line with its driver', () => {
  let d = pair(900);
  const r = addDomain(d, {});
  d = moveToDomain(r.design, cat, 'rmap0', r.id);
  d = moveInstances(d, { rmap0: { x: 996, y: 140 } });
  const sc = scene(d);
  const res = resolve(cat, d);
  const sys = /** @type {any} */ (sc.domains.get('sys')?.box);
  const other = /** @type {any} */ (sc.domains.get(r.id)?.box);
  const border = Math.round((sys.x + sys.w + other.x) / 2);
  const fwd = /** @type {any} */ (sc.adapters.get(res.chainOf.get('c1')?.adapters[0] ?? ''));
  const spw = /** @type {any} */ (sc.blocks.get('spw0'));
  assert.equal(fwd.orient, 'h');
  assert.equal(fwd.x, border);
  assert.equal(fwd.y, spw.y + spw.geom.ports.get('M_Pkt').y, 'on the line of the driver port');
  assert.equal(sc.edges.get('c1')?.hops[0].length, 2, 'straight into the FIFO');
  for (const a of sc.adapters.values()) for (const b of sc.adapters.values()) if (a !== b) assert.ok(!overlaps(a.rect, b.rect));
  assertClean(sc);
});

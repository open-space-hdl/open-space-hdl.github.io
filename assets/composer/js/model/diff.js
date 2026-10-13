// @ts-check
/**
 * What changed between two scenes, that is between the resolved netlist and layout before and after an edit (pure,
 * deterministic: every list is sorted by id). The canvas turns these changes into animations: a new block settles,
 * a new connection draws itself, an inserted adapter pops in while its neighbours move aside, a removed adapter lets
 * its connection close again, and domain boxes follow their content.
 */

/** @typedef {import('./scene.js').Scene} Scene */
/** @typedef {import('./router.js').Rect} Rect */
/** @typedef {{ x: number, y: number }} Point */

/**
 * @typedef {object} SceneDiff
 * @property {string[]} blocksAdded
 * @property {string[]} blocksRemoved
 * @property {{ id: string, from: Point, to: Point }[]} blocksMoved
 * @property {string[]} edgesAdded
 * @property {string[]} edgesRemoved
 * @property {string[]} edgesChanged       existing connections with a new route
 * @property {string[]} adaptersAdded
 * @property {{ id: string, connection: string, at: Point }[]} adaptersRemoved   with the place where they were
 * @property {{ id: string, from: Point, to: Point }[]} adaptersMoved
 * @property {string[]} domainsAdded
 * @property {string[]} domainsRemoved
 * @property {{ id: string, from: Rect, to: Rect }[]} domainsChanged
 */

/**
 * @template T
 * @param {Map<string, T>} m
 */
function ids(m) {
  return [...m.keys()].sort();
}

/**
 * @param {Point} a
 * @param {Point} b
 */
function moved(a, b) {
  return Math.abs(a.x - b.x) > 0.5 || Math.abs(a.y - b.y) > 0.5;
}

/**
 * @param {Rect | null} a
 * @param {Rect | null} b
 */
function sameRect(a, b) {
  if (!a || !b) return a === b;
  return Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 && Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5;
}

/**
 * @param {import('./router.js').Point[][]} a
 * @param {import('./router.js').Point[][]} b
 */
function sameHops(a, b) {
  if (a.length !== b.length) return false;
  return a.every((h, k) => h.length === b[k].length && h.every((p, i) => !moved(p, b[k][i])));
}

/**
 * Differences between two scenes; with no previous scene everything counts as unchanged (a first view or another
 * system is shown without animation).
 * @param {Scene | null} prev
 * @param {Scene} next
 * @returns {SceneDiff}
 */
export function diffScenes(prev, next) {
  /** @type {SceneDiff} */
  const out = {
    blocksAdded: [],
    blocksRemoved: [],
    blocksMoved: [],
    edgesAdded: [],
    edgesRemoved: [],
    edgesChanged: [],
    adaptersAdded: [],
    adaptersRemoved: [],
    adaptersMoved: [],
    domainsAdded: [],
    domainsRemoved: [],
    domainsChanged: [],
  };
  if (!prev) return out;
  for (const id of ids(next.blocks)) {
    const a = prev.blocks.get(id);
    const b = /** @type {import('./scene.js').SceneBlock} */ (next.blocks.get(id));
    if (!a) out.blocksAdded.push(id);
    else if (moved(a, b)) out.blocksMoved.push({ id, from: { x: a.x, y: a.y }, to: { x: b.x, y: b.y } });
  }
  for (const id of ids(prev.blocks)) if (!next.blocks.has(id)) out.blocksRemoved.push(id);
  for (const id of ids(next.edges)) {
    const a = prev.edges.get(id);
    const b = /** @type {import('./scene.js').SceneEdge} */ (next.edges.get(id));
    if (!a) out.edgesAdded.push(id);
    else if (!sameHops(a.hops, b.hops)) out.edgesChanged.push(id);
  }
  for (const id of ids(prev.edges)) if (!next.edges.has(id)) out.edgesRemoved.push(id);
  for (const id of ids(next.adapters)) {
    const a = prev.adapters.get(id);
    const b = /** @type {import('./scene.js').SceneAdapter} */ (next.adapters.get(id));
    if (!a) out.adaptersAdded.push(id);
    else if (moved(a, b)) out.adaptersMoved.push({ id, from: { x: a.x, y: a.y }, to: { x: b.x, y: b.y } });
  }
  for (const id of ids(prev.adapters)) {
    const a = /** @type {import('./scene.js').SceneAdapter} */ (prev.adapters.get(id));
    if (!next.adapters.has(id)) out.adaptersRemoved.push({ id, connection: a.connection, at: { x: a.x, y: a.y } });
  }
  for (const id of ids(next.domains)) {
    const a = prev.domains.get(id);
    const b = /** @type {import('./scene.js').SceneDomain} */ (next.domains.get(id));
    if (!a || !a.box) {
      if (b.box) out.domainsAdded.push(id);
    } else if (!b.box) {
      out.domainsRemoved.push(id);
    } else if (!sameRect(a.box, b.box)) {
      out.domainsChanged.push({ id, from: { ...a.box }, to: { ...b.box } });
    }
  }
  for (const id of ids(prev.domains)) if (!next.domains.has(id) && prev.domains.get(id)?.box) out.domainsRemoved.push(id);
  return out;
}

/**
 * Whether a diff has anything to animate.
 * @param {SceneDiff} df
 */
export function isEmptyDiff(df) {
  return Object.values(df).every((v) => v.length === 0);
}

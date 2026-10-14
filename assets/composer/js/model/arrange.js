// @ts-check
/**
 * Placement of blocks (pure, deterministic, no DOM).
 *
 * tidy      after an edit: a dropped block that lands on another block moves to the nearest free place, and clock
 *           domain boxes that overlap are moved apart as a whole (the domain being edited stays, its neighbours move
 *           aside), so that boxes never overlap
 * arrange   a layered layout of the whole system: data flows from left to right (sources left, sinks right), each
 *           clock domain is a group of its own, groups are laid out by the connections between them with room for
 *           a clock crossing on the border, and connected ports are lined up where possible so that connections run
 *           straight
 */

import { setDomainBox } from './design.js';
import { ADAPTER_WIDTH, BLOCK_WIDTH, DOMAIN_HEAD, DOMAIN_PAD, freeSpot, GRID } from './layout.js';
import { resolve } from './resolver.js';
import { ADAPTER_OFFSET, boxAround, sceneBlocks, sceneDomains } from './scene.js';

/** @typedef {import('./catalog.js').Catalog} Catalog */
/** @typedef {import('./design.js').Design} Design */
/** @typedef {import('./router.js').Rect} Rect */
/** @typedef {Rect & { id: string }} IdRect */

/** Distance between clock domain boxes after tidying. */
export const DOMAIN_GAP = 64;
/** Distances of the arranged layout. */
export const ARRANGE = {
  colGap: 88,
  rowGap: 56,
  domainGapX: 96,
  domainGapY: 72,
  origin: { x: 64, y: 64 },
  // width that the view shows at the readable zoom of Fit on a 1440 pixel wide window
  viewWidth: 1100,
  // a row of blocks up to this width stays a row (the view pans); a wider row wraps into runs of at most one view, and
  // clock domains side by side wider than this are stacked
  wrapWidth: 1650,
  // vertical distance between the runs of a wrapped row (room for the connections from one run to the next)
  wrapGap: 96,
};

/** @param {string} ref */
function instanceOf(ref) {
  return ref.slice(0, ref.indexOf('.'));
}

/**
 * Moves overlapping boxes apart. A pair of boxes closer than the gap is resolved by moving one of them away from the
 * other, sideways unless moving up or down is much shorter: the anchors move last (in their order), a box that has
 * moved keeps its new place against boxes that move later. The result is the displacement of every box that moved.
 * @param {IdRect[]} boxes
 * @param {string[]} anchors ids, highest priority first
 * @param {number} gap
 * @returns {Map<string, {dx: number, dy: number}>}
 */
export function separate(boxes, anchors, gap) {
  const cur = boxes.map((b) => ({ ...b }));
  /** @type {Map<string, number>} */
  const rank = new Map();
  anchors.forEach((id, k) => {
    if (!rank.has(id)) rank.set(id, k);
  });
  let next = anchors.length;
  const prio = (/** @type {string} */ id) => rank.get(id) ?? Infinity;
  for (let iter = 0; iter < 400; iter += 1) {
    /** @type {[number, number] | null} */
    let pair = null;
    for (let i = 0; i < cur.length && !pair; i += 1) {
      for (let j = i + 1; j < cur.length; j += 1) {
        const a = cur[i];
        const b = cur[j];
        if (a.x < b.x + b.w + gap && b.x < a.x + a.w + gap && a.y < b.y + b.h + gap && b.y < a.y + a.h + gap) {
          pair = [i, j];
          break;
        }
      }
    }
    if (!pair) break;
    const [i, j] = pair;
    // the box with the lower priority moves; between two free boxes the later one
    const moveJ = prio(cur[j].id) >= prio(cur[i].id);
    const m = moveJ ? cur[j] : cur[i];
    const o = moveJ ? cur[i] : cur[j];
    const right = m.x + m.w / 2 >= o.x + o.w / 2;
    const down = m.y + m.h / 2 >= o.y + o.h / 2;
    const dx = right ? o.x + o.w + gap - m.x : o.x - gap - (m.x + m.w);
    const dy = down ? o.y + o.h + gap - m.y : o.y - gap - (m.y + m.h);
    // side by side is preferred: connections between domains run horizontally and their crossings sit on a vertical
    // border; a box moves up or down only when that is much shorter
    if (Math.abs(dx) <= 2 * Math.abs(dy)) m.x += dx;
    else m.y += dy;
    if (!rank.has(m.id) || prio(m.id) === Infinity) rank.set(m.id, next++);
  }
  /** @type {Map<string, {dx: number, dy: number}>} */
  const out = new Map();
  boxes.forEach((b, k) => {
    const dx = cur[k].x - b.x;
    const dy = cur[k].y - b.y;
    if (dx !== 0 || dy !== 0) out.set(b.id, { dx, dy });
  });
  return out;
}

/**
 * Rounds a displacement away from zero to the grid, so that blocks stay on the grid and the gap is kept.
 * @param {number} v
 */
function gridAway(v) {
  return v === 0 ? 0 : Math.sign(v) * Math.ceil(Math.abs(v) / GRID) * GRID;
}

/**
 * Tidies the layout after an edit.
 * @param {Catalog} cat
 * @param {Design} d
 * @param {{ anchors?: string[], dropped?: string[] }} [opts] anchors: clock domains that stay (highest priority
 *        first); dropped: blocks just placed by the user, moved off other blocks
 * @returns {Design}
 */
export function tidy(cat, d, opts = {}) {
  if (d.instances.length === 0) return d;
  const res = resolve(cat, d);
  let blocks = sceneBlocks(cat, d, res);
  /** @type {Record<string, {x: number, y: number}>} */
  const pos = Object.fromEntries(d.instances.map((i) => [i.id, { ...(d.layout.instances[i.id] ?? { x: 0, y: 0 }) }]));
  let changed = false;
  // a dropped block does not stay on top of another block
  for (const id of opts.dropped ?? []) {
    const b = blocks.get(id);
    if (!b) continue;
    const others = [...blocks.values()].filter((o) => o.id !== id).map((o) => ({ x: pos[o.id].x, y: pos[o.id].y, width: o.w, height: o.h }));
    const hit = others.some((o) => pos[id].x < o.x + o.width && o.x < pos[id].x + b.w && pos[id].y < o.y + o.height && o.y < pos[id].y + b.h);
    if (!hit) continue;
    const spot = freeSpot(others, pos[id], { width: b.w, height: b.h });
    pos[id] = spot;
    changed = true;
  }
  if (changed) {
    d = { ...d, layout: { ...d.layout, instances: { ...d.layout.instances, ...pos } } };
    blocks = sceneBlocks(cat, d, res);
  }
  // domain boxes (and blocks outside any domain) do not overlap
  const domains = sceneDomains(d, res, blocks);
  /** @type {IdRect[]} */
  const boxes = [];
  for (const dm of domains.values()) if (dm.box) boxes.push({ id: dm.id, ...dm.box });
  for (const b of blocks.values()) if (!b.domain || !domains.get(b.domain)?.box) boxes.push({ id: `#${b.id}`, x: b.x, y: b.y, w: b.w, h: b.h });
  const moves = separate(boxes, opts.anchors ?? [], DOMAIN_GAP);
  if (moves.size === 0) return d;
  const inst = { ...d.layout.instances };
  let next = d;
  for (const [id, mv] of moves) {
    const dx = gridAway(mv.dx);
    const dy = gridAway(mv.dy);
    if (id.startsWith('#')) {
      const bid = id.slice(1);
      if (inst[bid]) inst[bid] = { x: inst[bid].x + dx, y: inst[bid].y + dy };
      continue;
    }
    const dm = domains.get(id);
    if (!dm) continue;
    if (dm.members.length === 0 && dm.box) {
      next = setDomainBox(next, id, { ...dm.box, x: dm.box.x + dx, y: dm.box.y + dy });
      continue;
    }
    for (const m of dm.members) if (inst[m]) inst[m] = { x: inst[m].x + dx, y: inst[m].y + dy };
  }
  return { ...next, layout: { ...next.layout, instances: inst } };
}

/**
 * Order of nodes with few backward edges (greedy heuristic of Eades, Lin and Smyth): sinks go to the end, sources to
 * the front, otherwise the node with the largest surplus of outgoing over incoming weight (on a tie the one fed most by
 * the nodes in front). Remaining ties keep the input order.
 * @param {string[]} nodes
 * @param {{ u: string, v: string, w: number }[]} edges
 * @returns {string[]}
 */
export function greedyOrder(nodes, edges) {
  const alive = new Set(nodes);
  /** @type {string[]} */
  const left = [];
  /** @type {string[]} */
  const right = [];
  const deg = (/** @type {string} */ n, /** @type {'out' | 'in'} */ which) => {
    let s = 0;
    for (const e of edges) {
      if (e.u === e.v) continue;
      if (which === 'out' && e.u === n && alive.has(e.v)) s += e.w;
      if (which === 'in' && e.v === n && alive.has(e.u)) s += e.w;
    }
    return s;
  };
  while (alive.size > 0) {
    let found = true;
    while (found) {
      found = false;
      for (const n of nodes) {
        if (alive.has(n) && deg(n, 'out') === 0 && deg(n, 'in') > 0) {
          right.unshift(n);
          alive.delete(n);
          found = true;
        }
      }
      for (const n of nodes) {
        if (alive.has(n) && deg(n, 'in') === 0) {
          left.push(n);
          alive.delete(n);
          found = true;
        }
      }
    }
    if (alive.size === 0) break;
    // largest surplus; on a tie the node fed most by the nodes already placed in front
    const placed = new Set(left);
    const fed = (/** @type {string} */ n) => edges.reduce((s, e) => s + (e.v === n && placed.has(e.u) ? e.w : 0), 0);
    let best = '';
    let bestD = -Infinity;
    let bestF = -Infinity;
    for (const n of nodes) {
      if (!alive.has(n)) continue;
      const dd = deg(n, 'out') - deg(n, 'in');
      const ff = fed(n);
      if (dd > bestD || (dd === bestD && ff > bestF)) {
        best = n;
        bestD = dd;
        bestF = ff;
      }
    }
    left.push(best);
    alive.delete(best);
  }
  return [...left, ...right];
}

/**
 * Layers along an order: the longest path over the edges that point forward in the order.
 * @param {string[]} order
 * @param {{ u: string, v: string }[]} edges
 * @returns {Map<string, number>}
 */
export function layers(order, edges) {
  const at = new Map(order.map((n, k) => [n, k]));
  /** @type {Map<string, number>} */
  const layer = new Map(order.map((n) => [n, 0]));
  for (const n of order) {
    for (const e of edges) {
      if (e.u !== n) continue;
      const ku = at.get(e.u);
      const kv = at.get(e.v);
      if (ku === undefined || kv === undefined || kv <= ku) continue;
      layer.set(e.v, Math.max(layer.get(e.v) ?? 0, (layer.get(n) ?? 0) + 1));
    }
  }
  return layer;
}

/** @param {number[]} v */
function median(v) {
  const s = [...v].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Stacks items top-down at their wished positions (none: right below the previous one), keeping their order and a
 * minimum gap.
 * @param {{ id: string, h: number, want: number }[]} items
 * @param {number} gap
 * @returns {Map<string, number>}
 */
function stack(items, gap) {
  /** @type {Map<string, number>} */
  const out = new Map();
  /** @type {number | null} */
  let bottom = null;
  for (const it of items) {
    const min = bottom === null ? -Infinity : bottom + gap;
    const want = Number.isFinite(it.want) ? it.want : bottom === null ? 0 : min;
    const y = Math.max(want, min);
    out.set(it.id, y);
    bottom = y + it.h;
  }
  return out;
}

/**
 * Runs of columns for a row that wraps: every run fits into the view, and a run ends only where no connection leads
 * back to an earlier column, so that the connections from one run to the next all run forward (down and to the left)
 * and do not cross the ones coming back. Fewest runs first, then fewest connections between runs, then the most even
 * widths. Null when the row cannot wrap that way (it stays a row, and the view pans).
 * @param {number} ncol
 * @param {number[]} colX
 * @param {(c: number) => number} right right edge of a column
 * @param {{ u: string, v: string }[]} inner connections inside the group
 * @param {Map<string, number>} layer column of every block
 * @returns {[number, number][] | null}
 */
function wrapRuns(ncol, colX, right, inner, layer) {
  const col = (/** @type {string} */ m) => layer.get(m) ?? 0;
  const back = (/** @type {number} */ c) => inner.some((e) => col(e.u) >= c && col(e.v) < c);
  const across = (/** @type {number} */ c) => inner.filter((e) => col(e.u) < c && col(e.v) >= c).length;
  /** @type {({ runs: number, edges: number, widest: number, from: number } | null)[]} */
  const best = Array.from({ length: ncol + 1 }, () => null);
  best[0] = { runs: 0, edges: 0, widest: 0, from: -1 };
  for (let c = 1; c <= ncol; c += 1) {
    for (let b = 0; b < c; b += 1) {
      const prev = best[b];
      const width = right(c - 1) - colX[b];
      if (!prev || width > ARRANGE.viewWidth || (b > 0 && back(b))) continue;
      const cand = { runs: prev.runs + 1, edges: prev.edges + (b > 0 ? across(b) : 0), widest: Math.max(prev.widest, width), from: b };
      const cur = best[c];
      if (!cur || cand.runs < cur.runs || (cand.runs === cur.runs && (cand.edges < cur.edges || (cand.edges === cur.edges && cand.widest < cur.widest)))) {
        best[c] = cand;
      }
    }
  }
  if (!best[ncol]) return null;
  /** @type {[number, number][]} */
  const runs = [];
  for (let c = ncol; c > 0; c = /** @type {any} */ (best[c]).from) runs.unshift([/** @type {any} */ (best[c]).from, c]);
  return runs.length > 1 ? runs : null;
}

/**
 * Arranges the whole system.
 * @param {Catalog} cat
 * @param {Design} d
 * @returns {Design}
 */
export function arrange(cat, d) {
  if (d.instances.length === 0) return d;
  const res = resolve(cat, d);
  const blocks = sceneBlocks(cat, d, res);
  const ids = d.instances.map((i) => i.id).filter((id) => blocks.has(id));
  const groupOf = new Map(ids.map((id) => [id, res.byId.get(id)?.domain ?? '#none']));
  const groups = [...d.clockDomains.map((c) => c.id), '#none'].filter((g) => ids.some((id) => groupOf.get(id) === g));
  const wconvOn = new Set(res.chains.filter((c) => c.adapters.some((a) => res.byId.get(a)?.role === 'wconv')).map((c) => c.connection));
  const edges = d.connections
    .map((c) => ({ u: instanceOf(c.from), v: instanceOf(c.to), from: c.from, to: c.to, w: 1, wconv: wconvOn.has(c.id) }))
    .filter((e) => e.u !== e.v && blocks.has(e.u) && blocks.has(e.v));
  const portY = (/** @type {string} */ ref) => blocks.get(instanceOf(ref))?.geom.ports.get(ref.slice(ref.indexOf('.') + 1))?.y ?? 0;
  const linked = new Set(edges.flatMap((e) => [e.u, e.v]));

  // one order of the data flow for the whole system: groups and the blocks inside them follow it, so that a block
  // connected to the next group sits at the side facing it
  const flow = greedyOrder(ids.filter((m) => linked.has(m)), edges);
  const at = new Map(flow.map((m, k) => [m, k]));

  // 1. each group on its own: columns by layers, rows by barycentres, connected ports lined up
  /** @type {Map<string, {x: number, y: number}>} */
  const local = new Map();
  /** @type {Map<string, {w: number, h: number}>} */
  const size = new Map();
  for (const g of groups) {
    const members = ids.filter((id) => groupOf.get(id) === g);
    const inner = edges.filter((e) => groupOf.get(e.u) === g && groupOf.get(e.v) === g);
    const connected = members.filter((m) => linked.has(m));
    const isolated = members.filter((m) => !linked.has(m));
    const order = flow.filter((m) => groupOf.get(m) === g);
    const layer = layers(order, inner);
    const ncol = connected.length ? Math.max(...connected.map((m) => layer.get(m) ?? 0)) + 1 : 0;
    /** @type {string[][]} */
    const cols = Array.from({ length: ncol }, () => []);
    for (const m of order) cols[layer.get(m) ?? 0].push(m);
    // barycentre sweeps over all connections of the group (also the backward ones)
    const idx = () => new Map(cols.flatMap((c) => c.map((m, k) => [m, k])));
    for (let sweep = 0; sweep < 4; sweep += 1) {
      const down = sweep % 2 === 0;
      const range = down ? cols.map((_, k) => k).slice(1) : cols.map((_, k) => k).slice(0, -1).reverse();
      for (const c of range) {
        const ref = down ? c - 1 : c + 1;
        const at = idx();
        const bary = new Map(cols[c].map((m, k) => {
          const nb = inner.filter((e) => (e.u === m && layer.get(e.v) === ref) || (e.v === m && layer.get(e.u) === ref)).map((e) => at.get(e.u === m ? e.v : e.u) ?? 0);
          return [m, nb.length ? nb.reduce((s, v) => s + v, 0) / nb.length : k];
        }));
        cols[c] = [...cols[c]].sort((a, b) => (bary.get(a) ?? 0) - (bary.get(b) ?? 0) || order.indexOf(a) - order.indexOf(b));
      }
    }
    // x by column; a column gap with a width converter on it is wider
    const colX = [];
    let x = 0;
    for (let c = 0; c < ncol; c += 1) {
      colX.push(x);
      const wide = inner.some((e) => e.wconv && layer.get(e.u) === c);
      x += Math.max(BLOCK_WIDTH, ...cols[c].map((m) => blocks.get(m)?.w ?? BLOCK_WIDTH)) + ARRANGE.colGap + (wide ? ADAPTER_WIDTH + 2 * ADAPTER_OFFSET : 0);
    }
    // y: first column stacked, later columns lined up with their predecessors
    /** @type {Map<string, number>} */
    const y = new Map();
    const placed = (/** @type {string} */ m) => y.has(m);
    for (let c = 0; c < ncol; c += 1) {
      const items = cols[c].map((m) => {
        const preds = inner.filter((e) => e.v === m && placed(e.u)).map((e) => (y.get(e.u) ?? 0) + portY(e.from) - portY(e.to));
        const any = preds.length ? preds : inner.filter((e) => e.u === m && placed(e.v)).map((e) => (y.get(e.v) ?? 0) + portY(e.to) - portY(e.from));
        return { id: m, h: blocks.get(m)?.h ?? 0, want: any.length ? median(any) : -Infinity };
      });
      for (const [m, v] of stack(items, ARRANGE.rowGap)) y.set(m, v);
    }
    // blocks without a predecessor in an earlier column line up with their successors
    for (let c = ncol - 2; c >= 0; c -= 1) {
      const items = cols[c].map((m) => {
        const hasPred = inner.some((e) => e.v === m && (layer.get(e.u) ?? 0) < c);
        const succ = inner.filter((e) => e.u === m && (layer.get(e.v) ?? 0) > c).map((e) => (y.get(e.v) ?? 0) + portY(e.to) - portY(e.from));
        return { id: m, h: blocks.get(m)?.h ?? 0, want: !hasPred && succ.length ? median(succ) : (y.get(m) ?? 0) };
      });
      for (const [m, v] of stack(items, ARRANGE.rowGap)) y.set(m, v);
    }
    for (let c = 0; c < ncol; c += 1) for (const m of cols[c]) local.set(m, { x: colX[c], y: y.get(m) ?? 0 });
    // a row much wider than the view wraps like text into runs of columns, each below the previous one
    const right = (/** @type {number} */ c) => colX[c] + Math.max(BLOCK_WIDTH, ...cols[c].map((m) => blocks.get(m)?.w ?? BLOCK_WIDTH));
    const runs = ncol > 1 && right(ncol - 1) > ARRANGE.wrapWidth ? wrapRuns(ncol, colX, right, inner, layer) : null;
    if (runs) {
      let top = 0;
      for (const [a, b] of runs) {
        const run = cols.slice(a, b).flat();
        const y0 = Math.min(...run.map((m) => local.get(m)?.y ?? 0));
        const y1 = Math.max(...run.map((m) => (local.get(m)?.y ?? 0) + (blocks.get(m)?.h ?? 0)));
        for (const m of run) {
          const p = local.get(m) ?? { x: 0, y: 0 };
          local.set(m, { x: p.x - colX[a], y: p.y - y0 + top });
        }
        top += y1 - y0 + ARRANGE.wrapGap;
      }
    }
    // blocks without connections: a grid below
    let top = connected.length ? Math.max(...connected.map((m) => (local.get(m)?.y ?? 0) + (blocks.get(m)?.h ?? 0))) + ARRANGE.rowGap : 0;
    const minY = connected.length ? Math.min(...connected.map((m) => local.get(m)?.y ?? 0)) : 0;
    top = Math.max(top, minY);
    const per = Math.max(1, Math.ceil(Math.sqrt(isolated.length)));
    for (let k = 0; k < isolated.length; k += per) {
      const row = isolated.slice(k, k + per);
      row.forEach((m, i) => local.set(m, { x: i * (BLOCK_WIDTH + ARRANGE.colGap), y: top }));
      top += Math.max(...row.map((m) => blocks.get(m)?.h ?? 0)) + ARRANGE.rowGap;
    }
    // normalise the group to its top-left corner
    const x0 = Math.min(...members.map((m) => local.get(m)?.x ?? 0));
    const y0 = Math.min(...members.map((m) => local.get(m)?.y ?? 0));
    for (const m of members) {
      const p = local.get(m) ?? { x: 0, y: 0 };
      local.set(m, { x: p.x - x0, y: p.y - y0 });
    }
    const w = Math.max(...members.map((m) => (local.get(m)?.x ?? 0) + (blocks.get(m)?.w ?? 0)));
    const h = Math.max(...members.map((m) => (local.get(m)?.y ?? 0) + (blocks.get(m)?.h ?? 0)));
    size.set(g, { w, h });
  }

  // 2. groups: columns by the connections between them, lined up like blocks
  const cross = edges.filter((e) => groupOf.get(e.u) !== groupOf.get(e.v));
  /** @type {Map<string, { u: string, v: string, w: number }>} */
  const gEdgeMap = new Map();
  for (const e of cross) {
    const u = /** @type {string} */ (groupOf.get(e.u));
    const v = /** @type {string} */ (groupOf.get(e.v));
    const k = `${u}>${v}`;
    const ge = gEdgeMap.get(k);
    if (ge) ge.w += 1;
    else gEdgeMap.set(k, { u, v, w: 1 });
  }
  const gEdges = [...gEdgeMap.values()];
  // groups in the order of the mean flow position of their blocks (groups without connections last)
  const mean = (/** @type {string} */ g) => {
    const v = ids.filter((m) => groupOf.get(m) === g && at.has(m)).map((m) => at.get(m) ?? 0);
    return v.length ? v.reduce((a, b) => a + b, 0) / v.length : Infinity;
  };
  const gOrder = [...groups].sort((a, b) => mean(a) - mean(b) || groups.indexOf(a) - groups.indexOf(b));
  const gLayer = layers(gOrder, gEdges);
  const ngcol = groups.length ? Math.max(...groups.map((g) => gLayer.get(g) ?? 0)) + 1 : 0;
  /** @type {string[][]} */
  const gCols = Array.from({ length: ngcol }, () => []);
  for (const g of gOrder) gCols[gLayer.get(g) ?? 0].push(g);
  // outer box of a group (with padding and header) and the offset of its blocks in it
  const pad = (/** @type {string} */ g) => (g === '#none' ? { x: 0, y: 0, w: 0, h: 0 } : { x: DOMAIN_PAD, y: DOMAIN_PAD + DOMAIN_HEAD, w: 2 * DOMAIN_PAD, h: 2 * DOMAIN_PAD + DOMAIN_HEAD });
  const outer = (/** @type {string} */ g) => ({ w: (size.get(g)?.w ?? 0) + pad(g).w, h: (size.get(g)?.h ?? 0) + pad(g).h });
  /** @type {Map<string, {x: number, y: number}>} */
  const gPos = new Map();
  let gx = 0;
  const absY = (/** @type {string} */ ref) => {
    const m = instanceOf(ref);
    const g = /** @type {string} */ (groupOf.get(m));
    return (gPos.get(g)?.y ?? 0) + pad(g).y + (local.get(m)?.y ?? 0) + portY(ref);
  };
  const relY = (/** @type {string} */ ref) => {
    const m = instanceOf(ref);
    const g = /** @type {string} */ (groupOf.get(m));
    return pad(g).y + (local.get(m)?.y ?? 0) + portY(ref);
  };
  for (let c = 0; c < ngcol; c += 1) {
    const items = gCols[c].map((g) => {
      const preds = cross.filter((e) => groupOf.get(e.v) === g && gPos.has(/** @type {string} */ (groupOf.get(e.u)))).map((e) => absY(e.from) - relY(e.to));
      return { id: g, h: outer(g).h, want: preds.length ? median(preds) : -Infinity };
    });
    for (const [g, yv] of stack(items, ARRANGE.domainGapY)) gPos.set(g, { x: gx, y: yv });
    gx += Math.max(...gCols[c].map((g) => outer(g).w)) + ARRANGE.domainGapX;
  }
  for (let c = ngcol - 2; c >= 0; c -= 1) {
    const items = gCols[c].map((g) => {
      const hasPred = cross.some((e) => groupOf.get(e.v) === g && (gLayer.get(/** @type {string} */ (groupOf.get(e.u))) ?? 0) < c);
      const succ = cross.filter((e) => groupOf.get(e.u) === g && (gLayer.get(/** @type {string} */ (groupOf.get(e.v))) ?? 0) > c).map((e) => absY(e.to) - relY(e.from));
      return { id: g, h: outer(g).h, want: !hasPred && succ.length ? median(succ) : (gPos.get(g)?.y ?? 0) };
    });
    for (const [g, yv] of stack(items, ARRANGE.domainGapY)) gPos.set(g, { x: gPos.get(g)?.x ?? 0, y: yv });
  }
  // too wide side by side: one domain per row in the order of the data flow, each starting below the block that
  // feeds it (but not reaching beyond the widest domain), so that the connections between domains run down across a
  // horizontal border
  if (ngcol > 1 && gx - ARRANGE.domainGapX > ARRANGE.wrapWidth) {
    const widest = Math.max(...groups.map((g) => outer(g).w));
    let y = 0;
    for (const g of gOrder) {
      const feed = cross.filter((e) => groupOf.get(e.v) === g && gPos.has(/** @type {string} */ (groupOf.get(e.u))) && (gPos.get(/** @type {string} */ (groupOf.get(e.u)))?.y ?? Infinity) < y);
      let x = 0;
      if (feed.length > 0) {
        const src = feed[0].u;
        const sg = /** @type {string} */ (groupOf.get(src));
        x = Math.max(0, Math.min(widest - outer(g).w, (gPos.get(sg)?.x ?? 0) + pad(sg).x + (local.get(src)?.x ?? 0) - pad(g).x));
      }
      gPos.set(g, { x, y });
      y += outer(g).h + ARRANGE.domainGapY;
    }
  }
  const minGy = groups.length ? Math.min(...groups.map((g) => gPos.get(g)?.y ?? 0)) : 0;

  // 3. absolute positions; empty domains with a placeholder box in a column of their own
  /** @type {Record<string, {x: number, y: number}>} */
  const inst = { ...d.layout.instances };
  for (const m of ids) {
    const g = /** @type {string} */ (groupOf.get(m));
    const gp = gPos.get(g) ?? { x: 0, y: 0 };
    const lp = local.get(m) ?? { x: 0, y: 0 };
    inst[m] = { x: Math.round(ARRANGE.origin.x + gp.x + pad(g).x + lp.x), y: Math.round(ARRANGE.origin.y + gp.y - minGy + pad(g).y + lp.y) };
  }
  let next = { ...d, layout: { ...d.layout, instances: inst } };
  const doms = sceneDomains(next, res, sceneBlocks(cat, next, res));
  let py = ARRANGE.origin.y;
  for (const dm of doms.values()) {
    if (dm.members.length > 0 || !dm.box) continue;
    next = setDomainBox(next, dm.id, { x: ARRANGE.origin.x + gx, y: py, w: dm.box.w, h: dm.box.h });
    py += dm.box.h + ARRANGE.domainGapY;
  }
  return next;
}

/**
 * Places a block that was just inserted between a driver and a receiver (a bridge such as the N-Char adapter): in the
 * gap between the two blocks, its input in line with the driver port. When the gap is too narrow, the blocks on the
 * far side of it move to the right as a group, so that the data flow keeps its order. Returns null when the two
 * blocks do not lie side by side (the caller finds another place).
 * @param {Catalog} cat
 * @param {Design} d design that already contains the new block
 * @param {string} drv driving endpoint
 * @param {string} rcv receiving endpoint
 * @param {string} id the new block
 * @param {string} sink its interface that the driver connects to
 * @returns {Design | null}
 */
export function placeBetween(cat, d, drv, rcv, id, sink) {
  const res = resolve(cat, d);
  const blocks = sceneBlocks(cat, d, res);
  const A = blocks.get(instanceOf(drv));
  const B = blocks.get(instanceOf(rcv));
  const N = blocks.get(id);
  const pa = A?.geom.ports.get(drv.slice(drv.indexOf('.') + 1));
  const pin = N?.geom.ports.get(sink);
  if (!A || !B || !N || !pa || !pin || A.id === B.id) return null;
  const [left, right] = B.x >= A.x + A.w ? [A, B] : A.x >= B.x + B.w ? [B, A] : [null, null];
  if (!left || !right) return null;
  const gap = ARRANGE.colGap;
  const need = N.w + 2 * gap;
  const have = right.x - (left.x + left.w);
  const inst = { ...d.layout.instances };
  if (have < need) {
    const shift = Math.ceil((need - have) / GRID) * GRID;
    for (const b of blocks.values()) if (b.id !== id && b.x >= right.x) inst[b.id] = { x: b.x + shift, y: b.y };
  }
  const x = have >= need ? left.x + left.w + Math.round((have - N.w) / 2) : left.x + left.w + gap;
  inst[id] = { x, y: A.y + pa.y - pin.y };
  return { ...d, layout: { ...d.layout, instances: inst } };
}

/**
 * Whether a design has no usable layout: every block at the same place (a file written without positions).
 * @param {Design} d
 */
export function needsArrange(d) {
  if (d.instances.length < 2) return false;
  const ps = d.instances.map((i) => d.layout.instances[i.id]);
  if (ps.some((p) => !p)) return true;
  return ps.every((p) => p.x === ps[0].x && p.y === ps[0].y);
}

/**
 * Domain boxes of a design (for tests and the canvas).
 * @param {Catalog} cat
 * @param {Design} d
 */
export function domainRects(cat, d) {
  const res = resolve(cat, d);
  const doms = sceneDomains(d, res, sceneBlocks(cat, d, res));
  /** @type {Map<string, Rect>} */
  const out = new Map();
  for (const dm of doms.values()) if (dm.box) out.set(dm.id, dm.box);
  return out;
}

export { boxAround };

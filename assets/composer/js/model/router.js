// @ts-check
/**
 * Orthogonal routing of connections (pure functions, no DOM).
 *
 * A connection leaves its port along the port normal, runs on horizontal and vertical segments that keep a clearance
 * from blocks, domain headers and inserted adapters, and enters the other port along its normal, so that it always
 * meets a port horizontally. The route is the cheapest path on a sparse grid made of the obstacle borders and the
 * stub ends (A*; the cost counts length and bends). Afterwards, segments that may move are centred in their free
 * channel, and segments of different connections that share a channel are spaced apart in the order that avoids
 * crossings. The result depends only on the input: the same terminals and obstacles give the same route.
 */

/** @typedef {{ x: number, y: number }} Point */
/** @typedef {{ x: number, y: number, w: number, h: number }} Rect */
/** @typedef {'left' | 'right' | 'up' | 'down'} Dir */
/** @typedef {{ x: number, y: number, dir: Dir }} Terminal  a port: its position and the direction away from its block */
/** @typedef {{ id: string, points: Point[] }} Route */

export const CLEARANCE = 12;
export const STUB = 20;
export const BEND_COST = 40;
export const SPACING = 10;
export const CORNER = 9;

const EPS = 0.01;
const DX = [1, 0, -1, 0];
const DY = [0, 1, 0, -1];
/** @type {Record<Dir, number>} */
const DIR_INDEX = { right: 0, down: 1, left: 2, up: 3 };
const MARGINS = [120, 480, Infinity];
const CACHE_LIMIT = 4000;

/**
 * @param {Rect} r
 * @param {number} m
 * @returns {Rect}
 */
export function inflate(r, m) {
  return { x: r.x - m, y: r.y - m, w: r.w + 2 * m, h: r.h + 2 * m };
}

/**
 * Whether a point lies strictly inside a rectangle.
 * @param {Point} p
 * @param {Rect} r
 */
function inside(p, r) {
  return p.x > r.x + EPS && p.x < r.x + r.w - EPS && p.y > r.y + EPS && p.y < r.y + r.h - EPS;
}

/**
 * Whether two rectangles overlap (touching does not count).
 * @param {Rect} a
 * @param {Rect} b
 */
export function overlaps(a, b) {
  return a.x < b.x + b.w - EPS && b.x < a.x + a.w - EPS && a.y < b.y + b.h - EPS && b.y < a.y + a.h - EPS;
}

/** @param {number} v */
const r2 = (v) => Math.round(v * 2) / 2;

/**
 * Removes repeated points and the middle points of straight runs.
 * @param {Point[]} pts
 * @returns {Point[]}
 */
export function simplify(pts) {
  /** @type {Point[]} */
  const out = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && Math.abs(last.x - p.x) < EPS && Math.abs(last.y - p.y) < EPS) continue;
    out.push({ x: p.x, y: p.y });
  }
  for (let k = out.length - 2; k >= 1; k -= 1) {
    const a = out[k - 1];
    const b = out[k];
    const c = out[k + 1];
    const straight = (Math.abs(a.x - b.x) < EPS && Math.abs(b.x - c.x) < EPS) || (Math.abs(a.y - b.y) < EPS && Math.abs(b.y - c.y) < EPS);
    if (straight) out.splice(k, 1);
  }
  return out;
}

/**
 * Binary heap of [cost, sequence, state] (lowest cost first, then first inserted).
 */
class Heap {
  constructor() {
    /** @type {[number, number, number][]} */
    this.a = [];
  }

  get size() {
    return this.a.length;
  }

  /** @param {[number, number, number]} x @param {[number, number, number]} y */
  static less(x, y) {
    return x[0] < y[0] || (x[0] === y[0] && x[1] < y[1]);
  }

  /** @param {[number, number, number]} item */
  push(item) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!Heap.less(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }

  pop() {
    const a = this.a;
    const top = a[0];
    const last = /** @type {[number, number, number]} */ (a.pop());
    if (a.length > 0) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && Heap.less(a[l], a[m])) m = l;
        if (r < a.length && Heap.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

/**
 * Cheapest orthogonal path between two stub ends on the grid of the obstacle borders.
 * @param {Point} s start (end of the source stub)
 * @param {Point} t goal (end of the target stub)
 * @param {number} startDir direction of motion at the start
 * @param {number} goalDir direction of motion when entering the target port
 * @param {Rect[]} obs inflated obstacles
 * @param {{x0: number, y0: number, x1: number, y1: number}} region the path stays inside
 * @returns {Point[] | null}
 */
function search(s, t, startDir, goalDir, obs, region) {
  const xsSet = new Set([r2(s.x), r2(t.x), r2((s.x + t.x) / 2), r2(region.x0), r2(region.x1)]);
  const ysSet = new Set([r2(s.y), r2(t.y), r2((s.y + t.y) / 2), r2(region.y0), r2(region.y1)]);
  for (const r of obs) {
    xsSet.add(r2(r.x));
    xsSet.add(r2(r.x + r.w));
    ysSet.add(r2(r.y));
    ysSet.add(r2(r.y + r.h));
  }
  const xs = [...xsSet].filter((x) => x >= region.x0 - EPS && x <= region.x1 + EPS).sort((a, b) => a - b);
  const ys = [...ysSet].filter((y) => y >= region.y0 - EPS && y <= region.y1 + EPS).sort((a, b) => a - b);
  const nx = xs.length;
  const ny = ys.length;
  const si = xs.indexOf(r2(s.x));
  const sj = ys.indexOf(r2(s.y));
  const ti = xs.indexOf(r2(t.x));
  const tj = ys.indexOf(r2(t.y));
  if (si < 0 || sj < 0 || ti < 0 || tj < 0) return null;
  const n = nx * ny;
  // node validity
  const free = new Uint8Array(n);
  for (let j = 0; j < ny; j += 1) {
    for (let i = 0; i < nx; i += 1) {
      const p = { x: xs[i], y: ys[j] };
      free[j * nx + i] = obs.some((r) => inside(p, r)) ? 0 : 1;
    }
  }
  free[sj * nx + si] = 1;
  free[tj * nx + ti] = 1;
  // edge validity, computed on demand: 0 unknown, 1 free, 2 blocked
  const hEdge = new Uint8Array(n);
  const vEdge = new Uint8Array(n);
  const edgeFree = (/** @type {number} */ i, /** @type {number} */ j, /** @type {number} */ d) => {
    // edge from node (i, j) to its neighbour in direction d; stored at the lower node
    const horizontal = d === 0 || d === 2;
    const li = d === 2 ? i - 1 : i;
    const lj = d === 3 ? j - 1 : j;
    const idx = lj * nx + li;
    const store = horizontal ? hEdge : vEdge;
    if (store[idx] === 0) {
      const mid = horizontal ? { x: (xs[li] + xs[li + 1]) / 2, y: ys[lj] } : { x: xs[li], y: (ys[lj] + ys[lj + 1]) / 2 };
      store[idx] = obs.some((r) => inside(mid, r)) ? 2 : 1;
    }
    return store[idx] === 1;
  };
  const g = new Float64Array(n * 4).fill(Infinity);
  const parent = new Int32Array(n * 4).fill(-1);
  const heap = new Heap();
  let seq = 0;
  const h = (/** @type {number} */ i, /** @type {number} */ j) => Math.abs(xs[i] - t.x) + Math.abs(ys[j] - t.y);
  const start = (sj * nx + si) * 4 + startDir;
  g[start] = 0;
  heap.push([h(si, sj), seq++, start]);
  let goal = -1;
  if (si === ti && sj === tj) {
    if (startDir === goalDir) return [s];
  }
  while (heap.size > 0) {
    const [f, , state] = heap.pop();
    const node = state >> 2;
    const dir = state & 3;
    const i = node % nx;
    const j = (node - i) / nx;
    if (f - h(i, j) > g[state] + EPS) continue;
    if (node === tj * nx + ti && !(node === sj * nx + si && g[state] === 0)) {
      goal = state;
      break;
    }
    for (let nd = 0; nd < 4; nd += 1) {
      if (nd === ((dir + 2) & 3)) continue;
      const ni = i + DX[nd];
      const nj = j + DY[nd];
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
      const nn = nj * nx + ni;
      if (!free[nn] || !edgeFree(i, j, nd)) continue;
      let cost = Math.abs(xs[ni] - xs[i]) + Math.abs(ys[nj] - ys[j]) + (nd === dir ? 0 : BEND_COST);
      if (nn === tj * nx + ti) {
        if (nd === ((goalDir + 2) & 3)) continue;
        if (nd !== goalDir) cost += BEND_COST;
      }
      const ns = nn * 4 + nd;
      const ng = g[state] + cost;
      if (ng + EPS < g[ns]) {
        g[ns] = ng;
        parent[ns] = state;
        heap.push([ng + h(ni, nj), seq++, ns]);
      }
    }
  }
  if (goal < 0) return null;
  /** @type {Point[]} */
  const pts = [];
  for (let st = goal; st >= 0; st = parent[st]) {
    const node = st >> 2;
    const i = node % nx;
    pts.push({ x: xs[i], y: ys[(node - i) / nx] });
  }
  pts.reverse();
  return pts;
}

/**
 * Range of positions across a segment (x of a vertical segment, y of a horizontal one) that keeps the segment and its
 * two neighbours clear of the obstacles. The segment k runs from P[k] to P[k + 1]; its neighbours are perpendicular.
 * A segment between two neighbours that leave to opposite sides (a Z) may move between them; one whose neighbours
 * leave to the same side (a U) may only move away from them.
 * @param {Point[]} P
 * @param {number} k
 * @param {Rect[]} obs inflated obstacles
 * @returns {{ lo: number, hi: number, c: number, zig: boolean } | null}
 */
export function freeRange(P, k, obs) {
  if (k < 1 || k > P.length - 3) return null;
  const p = P[k];
  const q = P[k + 1];
  const vertical = Math.abs(p.x - q.x) < EPS;
  const across = (/** @type {Point} */ pt) => (vertical ? pt.x : pt.y);
  const along = (/** @type {Point} */ pt) => (vertical ? pt.y : pt.x);
  const c = across(p);
  const before = across(P[k - 1]);
  const after = across(P[k + 2]);
  const sb = Math.sign(before - c);
  const sa = Math.sign(after - c);
  if (sb === 0 || sa === 0) return null;
  let lo = -Infinity;
  let hi = Infinity;
  // the segment may not pass the far ends of its neighbours, and a neighbour that ends at a port keeps its stub
  const bound = (/** @type {number} */ end, /** @type {number} */ side, /** @type {boolean} */ port) => {
    const e = port ? end - side * STUB : end;
    if (side < 0) lo = Math.max(lo, e);
    else hi = Math.min(hi, e);
  };
  bound(before, sb, k - 1 === 0);
  bound(after, sa, k + 2 === P.length - 1);
  const s0 = Math.min(along(p), along(q));
  const s1 = Math.max(along(p), along(q));
  const lineB = along(p);
  const lineA = along(q);
  for (const r of obs) {
    const ra0 = vertical ? r.y : r.x;
    const ra1 = vertical ? r.y + r.h : r.x + r.w;
    const rc0 = vertical ? r.x : r.y;
    const rc1 = vertical ? r.x + r.w : r.y + r.h;
    if (ra1 > s0 + EPS && ra0 < s1 - EPS) {
      if (rc1 <= c + EPS) lo = Math.max(lo, rc1);
      else if (rc0 >= c - EPS) hi = Math.min(hi, rc0);
    }
    // a neighbour grows when the segment moves away from its far end
    for (const [line, side] of [[lineB, sb], [lineA, sa]]) {
      if (!(line > ra0 + EPS && line < ra1 - EPS)) continue;
      if (side > 0 && rc1 <= c + EPS) lo = Math.max(lo, rc1);
      if (side < 0 && rc0 >= c - EPS) hi = Math.min(hi, rc0);
    }
  }
  if (lo > c + EPS || hi < c - EPS) return { lo: c, hi: c, c, zig: sb !== sa };
  return { lo, hi, c, zig: sb !== sa };
}

/**
 * Moves segment k of a polyline across to a new position (its neighbours follow).
 * @param {Point[]} P
 * @param {number} k
 * @param {number} v
 */
function moveSegment(P, k, v) {
  const vertical = Math.abs(P[k].x - P[k + 1].x) < EPS;
  if (vertical) {
    P[k] = { x: v, y: P[k].y };
    P[k + 1] = { x: v, y: P[k + 1].y };
  } else {
    P[k] = { x: P[k].x, y: v };
    P[k + 1] = { x: P[k + 1].x, y: v };
  }
}

/**
 * Centres the segments of a Z (neighbours to opposite sides) in their free channel; U segments stay tight.
 * @param {Point[]} pts
 * @param {Rect[]} obs inflated obstacles
 */
export function centre(pts, obs) {
  const P = pts.map((p) => ({ ...p }));
  for (let k = 1; k <= P.length - 3; k += 1) {
    const fr = freeRange(P, k, obs);
    if (!fr || !fr.zig || !Number.isFinite(fr.lo) || !Number.isFinite(fr.hi)) continue;
    const v = Math.round((fr.lo + fr.hi) / 2);
    if (v >= fr.lo - EPS && v <= fr.hi + EPS) moveSegment(P, k, v);
  }
  return simplify(P);
}

/**
 * Straight connection between two terminals that face each other on one line, or null.
 * @param {Terminal} a
 * @param {Terminal} b
 */
function facing(a, b) {
  if (a.dir === 'right' && b.dir === 'left' && Math.abs(a.y - b.y) < EPS && b.x > a.x) return true;
  if (a.dir === 'left' && b.dir === 'right' && Math.abs(a.y - b.y) < EPS && b.x < a.x) return true;
  if (a.dir === 'down' && b.dir === 'up' && Math.abs(a.x - b.x) < EPS && b.y > a.y) return true;
  if (a.dir === 'up' && b.dir === 'down' && Math.abs(a.x - b.x) < EPS && b.y < a.y) return true;
  return false;
}

/**
 * Stub length of a route: shorter when the two terminals face each other at a small distance.
 * @param {Terminal} a
 * @param {Terminal} b
 */
function stubFor(a, b) {
  const da = DIR_INDEX[a.dir];
  const db = DIR_INDEX[b.dir];
  if (da !== ((db + 2) & 3)) return STUB;
  const gap = DX[da] !== 0 ? (b.x - a.x) * DX[da] : (b.y - a.y) * DY[da];
  if (gap > 0 && gap < 2 * STUB) return Math.max(2, gap / 2 - 1);
  return STUB;
}

/**
 * Orthogonal route between two terminals around obstacles, as a polyline from a to b.
 * @param {Terminal} a source port
 * @param {Terminal} b target port
 * @param {Rect[]} obstacles rectangles to keep clear of (blocks, headers, adapters); they get the clearance
 * @param {{ clearance?: number, cache?: Map<string, Point[]> }} [opts]
 * @returns {Point[]}
 */
export function routePath(a, b, obstacles, opts = {}) {
  const clr = opts.clearance ?? CLEARANCE;
  if (facing(a, b)) {
    // straight when nothing lies between the two ports (their own blocks end at the ports)
    const da0 = DIR_INDEX[a.dir];
    const inner = [
      { x: a.x + DX[da0] * (clr + 1), y: a.y + DY[da0] * (clr + 1) },
      { x: b.x - DX[da0] * (clr + 1), y: b.y - DY[da0] * (clr + 1) },
    ];
    const len = (inner[1].x - inner[0].x) * DX[da0] + (inner[1].y - inner[0].y) * DY[da0];
    if (len <= 0 || !obstacles.some((r) => crossesRect(inner, inflate(r, clr)))) return [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
  }
  const stub = stubFor(a, b);
  const da = DIR_INDEX[a.dir];
  const db = DIR_INDEX[b.dir];
  const s = { x: a.x + DX[da] * stub, y: a.y + DY[da] * stub };
  const t = { x: b.x + DX[db] * stub, y: b.y + DY[db] * stub };
  const inflated = obstacles.map((r) => inflate(r, clr)).filter((r) => !inside(s, r) && !inside(t, r));
  for (const margin of MARGINS) {
    let region;
    if (Number.isFinite(margin)) {
      region = { x0: Math.min(s.x, t.x) - margin, y0: Math.min(s.y, t.y) - margin, x1: Math.max(s.x, t.x) + margin, y1: Math.max(s.y, t.y) + margin };
    } else {
      region = { x0: Math.min(s.x, t.x), y0: Math.min(s.y, t.y), x1: Math.max(s.x, t.x), y1: Math.max(s.y, t.y) };
      for (const r of inflated) {
        region.x0 = Math.min(region.x0, r.x);
        region.y0 = Math.min(region.y0, r.y);
        region.x1 = Math.max(region.x1, r.x + r.w);
        region.y1 = Math.max(region.y1, r.y + r.h);
      }
      region = { x0: region.x0 - 40, y0: region.y0 - 40, x1: region.x1 + 40, y1: region.y1 + 40 };
    }
    const reg = { x: region.x0, y: region.y0, w: region.x1 - region.x0, h: region.y1 - region.y0 };
    const local = inflated.filter((r) => overlaps(r, reg));
    const key = opts.cache ? JSON.stringify([a, b, clr, region, local]) : '';
    const hit = opts.cache?.get(key);
    if (hit) return hit.map((p) => ({ ...p }));
    const path = search(s, t, da, (db + 2) & 3, local, region);
    if (!path) continue;
    const pts = centre(simplify([{ x: a.x, y: a.y }, ...path, { x: b.x, y: b.y }]), local);
    if (opts.cache) {
      if (opts.cache.size > CACHE_LIMIT) opts.cache.clear();
      opts.cache.set(key, pts.map((p) => ({ ...p })));
    }
    return pts;
  }
  // no route around the obstacles: the plain route between the two stubs
  const plain = search(s, t, da, (db + 2) & 3, [], { x0: Math.min(s.x, t.x) - 80, y0: Math.min(s.y, t.y) - 80, x1: Math.max(s.x, t.x) + 80, y1: Math.max(s.y, t.y) + 80 });
  return simplify([{ x: a.x, y: a.y }, ...(plain ?? [s, { x: s.x, y: t.y }, t]), { x: b.x, y: b.y }]);
}

/**
 * @typedef {object} Seg
 * @property {number} route   index of the route
 * @property {number} k       segment index
 * @property {boolean} vertical
 * @property {number} c       position across
 * @property {number} s0      extent along
 * @property {number} s1
 * @property {boolean} fixed  first or last segment (it ends at a port)
 * @property {number} sideB   side the previous segment leaves to (-1, 0, +1)
 * @property {number} sideA   side the next segment leaves to
 * @property {number} endB    position along of the start
 * @property {number} endA    position along of the end
 */

/**
 * Spaces apart the segments of different routes that share a channel, in the order that avoids crossings.
 * @param {Route[]} routes
 * @param {Rect[]} obstacles inflated obstacles
 * @param {number} [spacing]
 * @returns {Route[]}
 */
export function nudge(routes, obstacles, spacing = SPACING) {
  const out = routes.map((r) => ({ id: r.id, points: r.points.map((p) => ({ ...p })) }));
  // channels: same orientation and position across. Moving the segments of one channel changes only the extents of
  // segments in other channels, so the channels are fixed up front and visited in the order of the routes; the
  // segment data is read fresh for every channel, so that the order chosen in one channel carries into the next
  /** @type {Map<string, { route: number, k: number }[]>} */
  const channels = new Map();
  out.forEach((r, ri) => {
    const P = r.points;
    for (let k = 0; k + 1 < P.length; k += 1) {
      const s = segment(P, ri, k);
      if (!s) continue;
      const kk = `${s.vertical ? 'v' : 'h'}${Math.round(s.c)}`;
      const list = channels.get(kk);
      if (list) list.push({ route: ri, k });
      else channels.set(kk, [{ route: ri, k }]);
    }
  });
  for (const refs of channels.values()) {
    if (new Set(refs.map((x) => x.route)).size < 2) continue;
    const list = /** @type {Seg[]} */ (refs.map((x) => segment(out[x.route].points, x.route, x.k)).filter((s) => s !== null));
    list.sort((a, b) => a.s0 - b.s0 || a.route - b.route || a.k - b.k);
    // clusters: overlapping extents (transitively)
    /** @type {Seg[][]} */
    const clusters = [];
    let cur = /** @type {Seg[]} */ ([]);
    let reach = -Infinity;
    for (const s of list) {
      if (cur.length > 0 && s.s0 >= reach - EPS) {
        clusters.push(cur);
        cur = [];
        reach = -Infinity;
      }
      cur.push(s);
      reach = Math.max(reach, s.s1);
    }
    if (cur.length > 0) clusters.push(cur);
    for (const cl of clusters) {
      // segments of one fan-out (the same port) count once
      const members = cl.filter((s, i) => !(s.fixed && cl.slice(0, i).some((t) => t.fixed && Math.abs(t.s0 - s.s0) < EPS && Math.abs(t.s1 - s.s1) < EPS)));
      if (new Set(members.map((s) => s.route)).size < 2) continue;
      spread(members, out, obstacles, spacing);
    }
  }
  return out.map((r) => ({ id: r.id, points: simplify(r.points) }));
}

/**
 * Data of segment k of a route (null for a diagonal or empty segment).
 * @param {Point[]} P
 * @param {number} route
 * @param {number} k
 * @returns {Seg | null}
 */
function segment(P, route, k) {
  const p = P[k];
  const q = P[k + 1];
  const vertical = Math.abs(p.x - q.x) < EPS;
  if (!vertical && Math.abs(p.y - q.y) >= EPS) return null;
  if (vertical && Math.abs(p.y - q.y) < EPS) return null;
  const across = (/** @type {Point} */ pt) => (vertical ? pt.x : pt.y);
  const along = (/** @type {Point} */ pt) => (vertical ? pt.y : pt.x);
  const c = across(p);
  return {
    route,
    k,
    vertical,
    c,
    s0: Math.min(along(p), along(q)),
    s1: Math.max(along(p), along(q)),
    fixed: k === 0 || k === P.length - 2,
    sideB: k > 0 ? Math.sign(across(P[k - 1]) - c) : 0,
    sideA: k + 2 < P.length ? Math.sign(across(P[k + 2]) - c) : 0,
    endB: along(p),
    endA: along(q),
  };
}

/**
 * Whether segment s must lie before (lower position across) segment t to avoid a crossing: +1 yes, -1 no (after),
 * 0 no preference. An end of s inside the extent of t turns to one side; it must lie on that side of t.
 * @param {Seg} s
 * @param {Seg} t
 */
function preference(s, t) {
  let v = 0;
  const within = (/** @type {number} */ y, /** @type {Seg} */ u) => y > u.s0 + EPS && y < u.s1 - EPS;
  if (s.sideB !== 0 && within(s.endB, t)) v += s.sideB < 0 ? 1 : -1;
  if (s.sideA !== 0 && within(s.endA, t)) v += s.sideA < 0 ? 1 : -1;
  if (t.sideB !== 0 && within(t.endB, s)) v += t.sideB < 0 ? -1 : 1;
  if (t.sideA !== 0 && within(t.endA, s)) v += t.sideA < 0 ? -1 : 1;
  return Math.sign(v);
}

/**
 * Places the segments of one cluster side by side.
 * @param {Seg[]} cl
 * @param {Route[]} routes
 * @param {Rect[]} obstacles
 * @param {number} spacing
 */
function spread(cl, routes, obstacles, spacing) {
  // order: insertion sort with the crossing preference, ties by route order (deterministic)
  /** @type {Seg[]} */
  const order = [];
  for (const s of [...cl].sort((a, b) => a.route - b.route || a.k - b.k)) {
    let pos = order.length;
    for (let i = 0; i < order.length; i += 1) {
      if (preference(s, order[i]) > 0) {
        pos = i;
        break;
      }
    }
    order.splice(pos, 0, s);
  }
  const c = cl[0].c;
  const n = order.length;
  // free range shared by the movable segments
  let lo = -Infinity;
  let hi = Infinity;
  for (const s of order) {
    if (s.fixed) continue;
    const fr = freeRange(routes[s.route].points, s.k, obstacles);
    if (!fr) continue;
    lo = Math.max(lo, fr.lo);
    hi = Math.min(hi, fr.hi);
  }
  const fixedAt = order.findIndex((s) => s.fixed);
  let sp = spacing;
  /** @type {number[]} */
  let pos;
  if (fixedAt >= 0) {
    // a segment that ends at a port stays; the others line up beside it
    const before = fixedAt;
    const after = n - 1 - fixedAt;
    if (Number.isFinite(lo) && before > 0) sp = Math.min(sp, (c - lo) / before);
    if (Number.isFinite(hi) && after > 0) sp = Math.min(sp, (hi - c) / after);
    sp = Math.max(sp, 2);
    pos = order.map((_, i) => c + (i - fixedAt) * sp);
  } else {
    const width = (n - 1) * sp;
    if (Number.isFinite(lo) && Number.isFinite(hi) && hi - lo < width) sp = Math.max(2, (hi - lo) / Math.max(1, n - 1));
    const span = (n - 1) * sp;
    let centre0 = c;
    if (Number.isFinite(lo)) centre0 = Math.max(centre0, lo + span / 2);
    if (Number.isFinite(hi)) centre0 = Math.min(centre0, hi - span / 2);
    pos = order.map((_, i) => centre0 + (i - (n - 1) / 2) * sp);
  }
  order.forEach((s, i) => {
    if (s.fixed) return;
    moveSegment(routes[s.route].points, s.k, Math.round(pos[i] * 2) / 2);
  });
}

/**
 * SVG path of a polyline with rounded corners.
 * @param {Point[]} P
 * @param {number} [radius]
 */
export function roundedPath(P, radius = CORNER) {
  const f = (/** @type {number} */ v) => Math.round(v * 10) / 10;
  if (P.length === 0) return '';
  let d = `M${f(P[0].x)},${f(P[0].y)}`;
  for (let i = 1; i < P.length - 1; i += 1) {
    const a = P[i - 1];
    const b = P[i];
    const c = P[i + 1];
    const l1 = Math.hypot(b.x - a.x, b.y - a.y);
    const l2 = Math.hypot(c.x - b.x, c.y - b.y);
    const r = Math.min(radius, l1 / 2, l2 / 2);
    if (r < 0.5 || l1 < EPS || l2 < EPS) {
      d += ` L${f(b.x)},${f(b.y)}`;
      continue;
    }
    const u1 = { x: (b.x - a.x) / l1, y: (b.y - a.y) / l1 };
    const u2 = { x: (c.x - b.x) / l2, y: (c.y - b.y) / l2 };
    const sweep = u1.x * u2.y - u1.y * u2.x > 0 ? 1 : 0;
    d += ` L${f(b.x - u1.x * r)},${f(b.y - u1.y * r)} A${f(r)},${f(r)} 0 0 ${sweep} ${f(b.x + u2.x * r)},${f(b.y + u2.y * r)}`;
  }
  const z = P[P.length - 1];
  return `${d} L${f(z.x)},${f(z.y)}`;
}

/**
 * Length of a polyline.
 * @param {Point[]} P
 */
export function pathLength(P) {
  let s = 0;
  for (let i = 1; i < P.length; i += 1) s += Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y);
  return s;
}

/**
 * Point at a distance along a polyline, with the index of its segment.
 * @param {Point[]} P
 * @param {number} dist
 * @returns {{ x: number, y: number, k: number }}
 */
export function pointAt(P, dist) {
  let s = 0;
  for (let i = 1; i < P.length; i += 1) {
    const l = Math.hypot(P[i].x - P[i - 1].x, P[i].y - P[i - 1].y);
    if (s + l >= dist || i === P.length - 1) {
      const t = l > 0 ? Math.min(1, Math.max(0, (dist - s) / l)) : 0;
      return { x: P[i - 1].x + (P[i].x - P[i - 1].x) * t, y: P[i - 1].y + (P[i].y - P[i - 1].y) * t, k: i - 1 };
    }
    s += l;
  }
  return { x: P[0]?.x ?? 0, y: P[0]?.y ?? 0, k: 0 };
}

/**
 * Distance along a polyline of the point nearest to p.
 * @param {Point[]} P
 * @param {Point} p
 */
export function distanceAlong(P, p) {
  let best = Infinity;
  let at = 0;
  let s = 0;
  for (let i = 1; i < P.length; i += 1) {
    const a = P[i - 1];
    const b = P[i];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    const t = l > 0 ? Math.min(1, Math.max(0, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (l * l))) : 0;
    const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    const dd = Math.hypot(p.x - q.x, p.y - q.y);
    if (dd < best) {
      best = dd;
      at = s + t * l;
    }
    s += l;
  }
  return at;
}

/**
 * Distances along a polyline where it leaves and enters a box (crossings of the box border).
 * @param {Point[]} P
 * @param {Rect} box
 * @returns {{ at: number, entering: boolean }[]}
 */
export function borderCrossings(P, box) {
  /** @type {{ at: number, entering: boolean }[]} */
  const out = [];
  const inBox = (/** @type {Point} */ p) => p.x >= box.x && p.x <= box.x + box.w && p.y >= box.y && p.y <= box.y + box.h;
  let s = 0;
  for (let i = 1; i < P.length; i += 1) {
    const a = P[i - 1];
    const b = P[i];
    const l = Math.hypot(b.x - a.x, b.y - a.y);
    const ia = inBox(a);
    const ib = inBox(b);
    if (ia !== ib && l > 0) {
      let lo = 0;
      let hi = 1;
      for (let n = 0; n < 32; n += 1) {
        const mid = (lo + hi) / 2;
        if (inBox({ x: a.x + (b.x - a.x) * mid, y: a.y + (b.y - a.y) * mid }) === ia) lo = mid;
        else hi = mid;
      }
      out.push({ at: s + ((lo + hi) / 2) * l, entering: !ia });
    }
    s += l;
  }
  return out;
}

/**
 * Whether a polyline passes through the inside of a rectangle.
 * @param {Point[]} P
 * @param {Rect} r
 */
export function crossesRect(P, r) {
  for (let i = 1; i < P.length; i += 1) {
    const a = P[i - 1];
    const b = P[i];
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 4));
    for (let n = 0; n <= steps; n += 1) {
      if (inside({ x: a.x + ((b.x - a.x) * n) / steps, y: a.y + ((b.y - a.y) * n) / steps }, r)) return true;
    }
  }
  return false;
}

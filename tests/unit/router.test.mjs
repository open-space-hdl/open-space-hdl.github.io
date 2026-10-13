// Router geometry: orthogonal routes around obstacles, horizontal port entry, compact feedback loops, spacing of
// shared channels, determinism.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  borderCrossings, CLEARANCE, crossesRect, distanceAlong, inflate, nudge, pathLength, pointAt, roundedPath, routePath,
  SPACING, STUB,
} from '../../assets/composer/js/model/router.js';

/** @param {{x: number, y: number}[]} P */
function assertOrthogonal(P) {
  for (let i = 1; i < P.length; i += 1) {
    const a = P[i - 1];
    const b = P[i];
    assert.ok(a.x === b.x || a.y === b.y, `segment ${i} is not orthogonal: ${JSON.stringify([a, b])}`);
  }
}

/** Number of bends of a polyline. */
function bends(P) {
  return Math.max(0, P.length - 2);
}

/**
 * Whether two orthogonal polylines cross (proper crossing of a horizontal and a vertical segment).
 * @param {{x: number, y: number}[]} P
 * @param {{x: number, y: number}[]} Q
 */
function crossings(P, Q) {
  let n = 0;
  for (let i = 1; i < P.length; i += 1) {
    for (let j = 1; j < Q.length; j += 1) {
      const [a, b] = [P[i - 1], P[i]];
      const [c, d] = [Q[j - 1], Q[j]];
      const h1 = a.y === b.y;
      const h2 = c.y === d.y;
      if (h1 === h2) continue;
      const [hz, vt] = h1 ? [[a, b], [c, d]] : [[c, d], [a, b]];
      const x = vt[0].x;
      const y = hz[0].y;
      const inH = x > Math.min(hz[0].x, hz[1].x) && x < Math.max(hz[0].x, hz[1].x);
      const inV = y > Math.min(vt[0].y, vt[1].y) && y < Math.max(vt[0].y, vt[1].y);
      if (inH && inV) n += 1;
    }
  }
  return n;
}

const A = { x: 0, y: 0, w: 240, h: 200 };
const B = { x: 480, y: 0, w: 240, h: 200 };

test('aligned facing ports give a straight line', () => {
  const P = routePath({ x: 240, y: 80, dir: 'right' }, { x: 480, y: 80, dir: 'left' }, [A, B]);
  assert.deepEqual(P, [{ x: 240, y: 80 }, { x: 480, y: 80 }]);
});

test('offset ports give a Z with the vertical part in the middle of the channel', () => {
  const P = routePath({ x: 240, y: 80, dir: 'right' }, { x: 480, y: 140, dir: 'left' }, [A, B]);
  assertOrthogonal(P);
  assert.equal(P.length, 4);
  assert.equal(P[1].x, 360);
  assert.equal(P[0].y, P[1].y, 'leaves the port horizontally');
  assert.equal(P[2].y, P[3].y, 'enters the port horizontally');
});

test('a route keeps the clearance around a block in its way', () => {
  const C = { x: 300, y: 40, w: 120, h: 200 };
  const P = routePath({ x: 240, y: 100, dir: 'right' }, { x: 480, y: 100, dir: 'left' }, [A, B, C]);
  assertOrthogonal(P);
  assert.ok(!crossesRect(P, inflate(C, CLEARANCE - 0.5)), JSON.stringify(P));
  assert.ok(!crossesRect(P, inflate(A, 0)) && !crossesRect(P, inflate(B, 0)));
  assert.equal(P[0].y, P[1].y);
  assert.equal(P[P.length - 2].y, P[P.length - 1].y);
});

test('a feedback connection of a side-by-side pair loops tightly over the top of the two blocks', () => {
  // output on the right of B back to the input on the left of A, both ports in the top row
  const a = { x: 720, y: 80, dir: /** @type {const} */ ('right') };
  const b = { x: 0, y: 80, dir: /** @type {const} */ ('left') };
  const P = routePath(a, b, [A, B]);
  assertOrthogonal(P);
  const top = Math.min(...P.map((p) => p.y));
  assert.equal(top, -CLEARANCE, 'runs along the clearance line above the blocks');
  assert.ok(Math.max(...P.map((p) => p.x)) <= 720 + STUB);
  assert.ok(Math.min(...P.map((p) => p.x)) >= -STUB);
  assert.equal(bends(P), 4);
  assert.equal(pathLength(P), 720 + 4 * STUB + 2 * (80 + CLEARANCE));
});

test('a feedback connection from a low port goes below the blocks', () => {
  const P = routePath({ x: 720, y: 180, dir: 'right' }, { x: 0, y: 180, dir: 'left' }, [A, B]);
  assert.equal(Math.max(...P.map((p) => p.y)), 200 + CLEARANCE);
});

test('routes are deterministic and independent of the obstacle order', () => {
  const C = { x: 300, y: 40, w: 120, h: 200 };
  const D = { x: 260, y: -200, w: 100, h: 120 };
  const a = { x: 240, y: 100, dir: /** @type {const} */ ('right') };
  const b = { x: 480, y: 170, dir: /** @type {const} */ ('left') };
  const p1 = routePath(a, b, [A, B, C, D]);
  const p2 = routePath(a, b, [D, C, B, A]);
  const cache = new Map();
  const p3 = routePath(a, b, [A, B, C, D], { cache });
  const p4 = routePath(a, b, [A, B, C, D], { cache });
  assert.deepEqual(p1, p2);
  assert.deepEqual(p1, p3);
  assert.deepEqual(p3, p4);
  assert.equal(cache.size, 1);
});

test('vertical terminals (adapter on a vertical part) are entered along their normal', () => {
  const P = routePath({ x: 100, y: 200, dir: 'down' }, { x: 300, y: 400, dir: 'up' }, []);
  assertOrthogonal(P);
  assert.equal(P[0].x, P[1].x);
  assert.equal(P[P.length - 2].x, P[P.length - 1].x);
});

test('connections that share a channel are spaced apart without crossing', () => {
  const obs = [A, B].map((r) => inflate(r, CLEARANCE));
  const r1 = routePath({ x: 240, y: 80, dir: 'right' }, { x: 480, y: 150, dir: 'left' }, [A, B]);
  const r2 = routePath({ x: 240, y: 106, dir: 'right' }, { x: 480, y: 176, dir: 'left' }, [A, B]);
  assert.equal(r1[1].x, r2[1].x, 'both centre in the same channel');
  const [n1, n2] = nudge([{ id: 'a', points: r1 }, { id: 'b', points: r2 }], obs);
  assert.equal(Math.abs(n1.points[1].x - n2.points[1].x), SPACING);
  assert.equal(crossings(n1.points, n2.points), 0);
  assertOrthogonal(n1.points);
  assertOrthogonal(n2.points);
  // the ends at the ports do not move
  assert.deepEqual(n1.points[0], r1[0]);
  assert.deepEqual(n2.points.at(-1), r2.at(-1));
});

test('stacked feedback loops over the same blocks are spaced outwards', () => {
  const TA = { ...A, h: 320 };
  const TB = { ...B, h: 320 };
  const obs = [TA, TB].map((r) => inflate(r, CLEARANCE));
  const r1 = routePath({ x: 720, y: 80, dir: 'right' }, { x: 0, y: 80, dir: 'left' }, [TA, TB]);
  const r2 = routePath({ x: 720, y: 106, dir: 'right' }, { x: 0, y: 106, dir: 'left' }, [TA, TB]);
  assert.equal(Math.min(...r1.map((p) => p.y)), Math.min(...r2.map((p) => p.y)), 'both loops take the same line');
  const [n1, n2] = nudge([{ id: 'a', points: r1 }, { id: 'b', points: r2 }], obs);
  const t1 = Math.min(...n1.points.map((p) => p.y));
  const t2 = Math.min(...n2.points.map((p) => p.y));
  assert.equal(Math.abs(t1 - t2), SPACING);
  assert.ok(Math.max(t1, t2) <= -CLEARANCE, 'no loop moves into the clearance of the blocks');
  assert.equal(crossings(n1.points, n2.points), 0);
});

test('rounded paths start and end at the ports and round every bend', () => {
  const P = [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 40 }, { x: 100, y: 40 }];
  const d = roundedPath(P, 8);
  assert.match(d, /^M0,0 /);
  assert.match(d, / L100,40$/);
  assert.equal((d.match(/A/g) ?? []).length, 2);
  assert.match(d, /A8,8 0 0 1 50,8/);
  assert.match(d, /A8,8 0 0 0 58,40/);
});

test('helpers along a polyline', () => {
  const P = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 50 }];
  assert.equal(pathLength(P), 150);
  assert.deepEqual(pointAt(P, 120), { x: 100, y: 20, k: 1 });
  assert.equal(distanceAlong(P, { x: 60, y: 5 }), 60);
  const c = borderCrossings(P, { x: -10, y: -10, w: 50, h: 30 });
  assert.equal(c.length, 1);
  assert.equal(c[0].entering, false);
  assert.ok(Math.abs(c[0].at - 40) < 0.01);
});

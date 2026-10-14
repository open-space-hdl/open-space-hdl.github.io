// Springs of the animations: settle without overshoot when critically damped, overshoot when under-damped, stay
// stable for any time step and continue smoothly towards a new target.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sampleSpring, Spring, SpringSet } from '../../assets/composer/js/model/spring.js';

test('a critically damped spring reaches its target without overshoot', () => {
  const v = sampleSpring(0, 100, { response: 0.3, damping: 1 }, 1 / 60);
  assert.equal(v.at(-1), 100);
  assert.ok(v.every((x) => x <= 100 + 1e-9), 'no overshoot');
  assert.ok(v.every((x, i) => i === 0 || x >= v[i - 1] - 1e-9), 'monotonic');
  assert.ok(v.length < 80, `settles within ${v.length} frames`);
});

test('an under-damped spring overshoots once and settles', () => {
  const v = sampleSpring(0, 100, { response: 0.3, damping: 0.5 }, 1 / 60);
  assert.ok(Math.max(...v) > 105, 'overshoot');
  assert.equal(v.at(-1), 100);
});

test('an over-damped spring creeps to its target', () => {
  const v = sampleSpring(0, 100, { response: 0.3, damping: 2 }, 1 / 60);
  assert.ok(v.every((x) => x <= 100 + 1e-9));
  assert.equal(v.at(-1), 100);
});

test('the step is exact for any time step', () => {
  const fine = new Spring(0, { response: 0.4 });
  const coarse = new Spring(0, { response: 0.4 });
  fine.set(50);
  coarse.set(50);
  for (let k = 0; k < 10; k += 1) fine.step(0.01);
  coarse.step(0.1);
  assert.ok(Math.abs(fine.value - coarse.value) < 1e-9);
  assert.ok(Math.abs(fine.velocity - coarse.velocity) < 1e-6);
  // a very long frame lands on the target instead of exploding
  const s = new Spring(0, { response: 0.2, damping: 0.4 });
  s.set(10);
  assert.equal(s.step(5), true);
  assert.equal(s.value, 10);
});

test('a new target continues from the current position and velocity', () => {
  const s = new Spring(0, { response: 0.3 });
  s.set(100);
  s.step(0.05);
  const x = s.value;
  const vel = s.velocity;
  assert.ok(vel > 0);
  s.set(-100);
  assert.equal(s.value, x);
  assert.equal(s.velocity, vel);
  s.step(0.001);
  assert.ok(s.value > x, 'keeps its momentum for a moment');
});

test('a set of springs moves together and reports when it rests', () => {
  const set = new SpringSet({ x: 0, y: 0 }, { response: 0.25 });
  set.set({ x: 10, y: -10, w: 5 });
  assert.equal(set.done, false);
  for (let k = 0; k < 200 && !set.step(1 / 60); k += 1);
  assert.deepEqual(set.values, { x: 10, y: -10, w: 5 });
  const s = new Spring(3);
  s.jump(7);
  assert.equal(s.done, true);
  assert.equal(s.value, 7);
});

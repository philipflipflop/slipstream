// Gamepad mapping: dead zone and response curve, axis senses, analog
// throttle slew, and button EDGES (a held button fires its action once).
import assert from 'node:assert/strict';
import { shapeAxis, readPad } from '../.test-build/input/gamepad.js';

const btn = (pressed = false, value = pressed ? 1 : 0) => ({ pressed, value });
const pad = (over = {}) => {
  const b = Array.from({ length: 17 }, () => btn());
  for (const [i, v] of Object.entries(over)) b[Number(i)] = v;
  return b;
};

// response curve
assert.equal(shapeAxis(0), 0);
assert.equal(shapeAxis(0.11), 0, 'stick drift inside the dead zone must read zero');
assert.equal(shapeAxis(-0.08), 0);
assert.ok(Math.abs(shapeAxis(1) - 1) < 1e-12 && Math.abs(shapeAxis(-1) + 1) < 1e-12, 'full throw is full authority');
assert.equal(shapeAxis(NaN), 0);
let last = 0;
for (let v = 0.12; v <= 1.0001; v += 0.02) {
  const s = shapeAxis(v);
  assert.ok(s >= last && s <= v + 1e-9, `curve not monotonic / above linear at ${v.toFixed(2)}`);
  last = s;
}
assert.ok(shapeAxis(0.5) < 0.35, 'centre of the travel is desensitised (expo)');
assert.equal(shapeAxis(-0.6), -shapeAxis(0.6));
console.log('  ✓ dead zone swallows drift, expo softens the centre, the stops keep full authority');

// axis senses on a standard pad
{
  const prev = [];
  let f = readPad([1, 0, 0, 0], pad(), true, prev);
  assert.ok(f.roll === 1 && f.pitch === 0 && f.stick, 'stick right = roll right');
  f = readPad([0, 1, 0, 0], pad(), true, prev);
  assert.ok(f.pitch === 1, 'stick back = pull');
  f = readPad([0, 0, -1, 0], pad(), true, prev);
  assert.ok(f.yaw === -1 && !f.stick, 'right stick X = rudder, and rudder alone is not "manual stick"');
  f = readPad([0.05, -0.04, 0, 0], pad(), true, prev);
  assert.ok(!f.stick && f.roll === 0 && f.pitch === 0, 'a resting stick must not kick the autopilot off');
  console.log('  ✓ stick / rudder senses; resting drift is not manual input');
}

// triggers slew the throttle, analog
{
  const prev = [];
  assert.equal(readPad([0, 0, 0, 0], pad({ 7: btn(true, 1) }), true, prev).throttleRate, 1);
  assert.equal(readPad([0, 0, 0, 0], pad({ 6: btn(true, 1) }), true, prev).throttleRate, -1);
  assert.ok(Math.abs(readPad([0, 0, 0, 0], pad({ 7: btn(true, 0.4) }), true, prev).throttleRate - 0.4) < 1e-12);
  assert.equal(readPad([0, 0, 0, 0], pad({ 6: btn(true, 1), 7: btn(true, 1) }), true, prev).throttleRate, 0);
  console.log('  ✓ RT / LT slew the throttle by trigger travel');
}

// buttons: A holds, the rest fire once per press
{
  const prev = [];
  let f = readPad([0, 0, 0, 0], pad({ 0: btn(true), 3: btn(true) }), true, prev);
  assert.ok(f.brakes && f.actions.length === 1 && f.actions[0] === 'gear');
  f = readPad([0, 0, 0, 0], pad({ 0: btn(true), 3: btn(true) }), true, prev);
  assert.ok(f.brakes && f.actions.length === 0, 'a held button must not repeat its action');
  f = readPad([0, 0, 0, 0], pad(), true, prev);
  assert.ok(!f.brakes && f.actions.length === 0);
  f = readPad([0, 0, 0, 0], pad({ 3: btn(true) }), true, prev);
  assert.deepEqual(f.actions, ['gear'], 'release and press again fires again');
  const all = readPad([0, 0, 0, 0], pad({
    1: btn(true), 2: btn(true), 4: btn(true), 5: btn(true), 8: btn(true), 9: btn(true),
    12: btn(true), 13: btn(true), 14: btn(true), 15: btn(true),
  }), true, []);
  assert.deepEqual([...all.actions].sort(), [
    'airbrake', 'approach', 'autopilot', 'camera', 'flapsDown', 'flapsUp', 'hud', 'map', 'nav', 'pause',
  ]);
  console.log('  ✓ A is hold-to-brake; every other button fires once per press');
}

// unknown layouts (flight sticks): stick + trigger only, nothing guessed
{
  const f = readPad([0.8, -0.5, 0.9, -1], pad({ 0: btn(true), 3: btn(true), 7: btn(true, 1) }), false, []);
  assert.ok(f.roll > 0.6 && f.pitch < -0.25 && f.brakes);
  assert.ok(f.yaw === 0 && f.throttleRate === 0 && f.actions.length === 0,
    'a non-standard layout must not have axes or buttons guessed');
  // short arrays (a 2-axis, 1-button stick) are fine
  const tiny = readPad([0.5], [btn(true)], false, []);
  assert.ok(tiny.roll > 0 && tiny.pitch === 0 && tiny.brakes);
  console.log('  ✓ non-standard sticks: axes 0/1 + trigger only');
}

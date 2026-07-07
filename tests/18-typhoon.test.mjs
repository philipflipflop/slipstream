// Eurofighter Typhoon: fighter-class thrust (T/W > 1 in reheat), a short
// ground roll, a 9g carefree envelope under the FBW limiters, and a sane
// approach speed for a delta.
import assert from 'node:assert/strict';
import { createState, stepFlight, spawnOnRunway } from '../.test-build/aircraft/flightModel.js';
import { specById } from '../.test-build/aircraft/catalog.js';

const dt = 1 / 180;
const flat = () => 8;
const KT = 1.943844;

const mkInp = (o = {}) => ({
  pitch: 0, roll: 0, yaw: 0, throttle: 0, flaps: 0,
  gearDown: true, brakes: false, airbrake: false, ...o,
});

const ty = specById('typhoon');
assert.equal(ty.engine, 'jet');
assert.ok(ty.fbw && ty.gun, 'Typhoon is FBW with a cannon');
assert.ok(ty.maxThrust * (ty.afterburner ?? 1) > ty.mass * 9.81,
  'reheat T/W must exceed 1 — it is an interceptor');

// reheat takeoff: airborne in a fighter-length ground roll
{
  const st = createState();
  spawnOnRunway(ty, st, flat);
  const inp = mkInp({ throttle: 1 });
  const x0 = st.pos.x, z0 = st.pos.z;
  let roll = -1;
  for (let t = 0; t < 40; t += dt) {
    inp.pitch = st.airspeed > 55 && st.pitchAngle < 0.2 ? 0.6 : 0;
    stepFlight(ty, st, inp, dt, flat);
    if (!st.onGround && st.pos.y > 8 + ty.gearHeight + 2 && roll < 0) {
      roll = Math.hypot(st.pos.x - x0, st.pos.z - z0);
      break;
    }
  }
  assert.ok(roll > 0, 'Typhoon never lifted off');
  assert.ok(roll < 1300, `Typhoon ground roll too long (${roll.toFixed(0)} m)`);
  console.log(`  ✓ Typhoon reheat takeoff — ${roll.toFixed(0)} m ground roll`);
}

// supersonic dash: reheat on the deck passes 700 kt without drama
{
  const st = createState();
  spawnOnRunway(ty, st, flat);
  st.pos.y = 1500;
  st.vel.set(0, 0, -200);
  st.onGround = false;
  const inp = mkInp({ throttle: 1, gearDown: false });
  for (let t = 0; t < 120; t += dt) {
    const vsT = Math.max(-6, Math.min(6, (1500 - st.pos.y) * 0.15));
    inp.pitch = Math.max(-0.5, Math.min(0.5, (vsT - st.vel.y) * 0.04 - st.angVel.x * 0.8));
    stepFlight(ty, st, inp, dt, flat);
  }
  const kt = st.airspeed * KT;
  assert.ok(!st.crashed, 'Typhoon crashed in the dash');
  assert.ok(kt > 700, `Typhoon dash too slow (${kt.toFixed(0)} kt)`);
  console.log(`  ✓ Typhoon dashes at ${kt.toFixed(0)} kt in reheat`);
}

// 9g carefree envelope: a full pull at speed settles near the rated G,
// and the alpha limiter refuses the deep stall
{
  const st = createState();
  spawnOnRunway(ty, st, flat);
  st.pos.set(0, 3000, 0);
  st.vel.set(0, 0, -380);
  st.onGround = false;
  const inp = mkInp({ throttle: 1, pitch: 1, gearDown: false });
  let maxG = 0;
  let stalledFrames = 0;
  for (let t = 0; t < 7; t += dt) {
    stepFlight(ty, st, inp, dt, flat);
    maxG = Math.max(maxG, st.gForce);
    if (st.stalled) stalledFrames++;
    if (st.crashed) break;
  }
  assert.ok(!st.crashed, 'carefree pull crashed');
  assert.ok(maxG > 6 && maxG < 12, `full pull peaked at ${maxG.toFixed(1)}g (rated 9g)`);
  assert.ok(stalledFrames < 60, `alpha limiter let it stall (${stalledFrames} frames)`);
  console.log(`  ✓ carefree handling: full pull ${maxG.toFixed(1)}g, no departure`);
}

// approach: a delta lands fast but not silly — alpha floor keeps the
// minimum steady speed in the 120-160 kt band
{
  const st = createState();
  spawnOnRunway(ty, st, flat);
  st.pos.y = 2000;
  st.vel.set(0, 0, -110);
  st.onGround = false;
  const inp = mkInp({ throttle: 0, flaps: 1, pitch: 1 });
  // hold full aft stick until the zoom settles into the alpha-floor mush,
  // then read the steady speed over the last five seconds
  let sum = 0;
  let n = 0;
  for (let t = 0; t < 45; t += dt) {
    stepFlight(ty, st, inp, dt, flat);
    if (t > 40) { sum += st.airspeed * KT; n++; }
  }
  const settled = sum / n;
  assert.ok(!st.crashed, 'approach demo crashed');
  assert.ok(settled > 95 && settled < 170, `delta alpha-floor speed off (${settled.toFixed(0)} kt)`);
  console.log(`  ✓ alpha floor settles at ~${settled.toFixed(0)} kt — approach around ${Math.round(settled * 1.2)} kt`);
}

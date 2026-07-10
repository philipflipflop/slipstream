// A320neo: the airliner flies its book numbers — Vr ~140 kt with a sensible
// ground roll, ~110 kt full-flap stall (Vapp ~140), 450+ kt max cruise, and
// a stabilised 3° approach at approach speed holds without falling apart.
import assert from 'node:assert/strict';
import { createState, stepFlight, spawnOnRunway } from '../.test-build/aircraft/flightModel.js';
import { Autopilot } from '../.test-build/aircraft/autopilot.js';
import { specById } from '../.test-build/aircraft/catalog.js';

const dt = 1 / 180;
const flat = () => 8;
const KT = 1.943844;

const mkInp = (o = {}) => ({
  pitch: 0, roll: 0, yaw: 0, throttle: 0, flaps: 0,
  gearDown: true, brakes: false, airbrake: false, ...o,
});

const a320 = specById('a320');
assert.equal(a320.id, 'a320');
assert.equal(a320.engine, 'jet');
assert.equal(a320.retractableGear, true);

// takeoff: TOGA, CONF 2, rotate ~150 kt with a firm pull — airborne inside
// a realistic mid-weight ground roll
{
  const st = createState();
  spawnOnRunway(a320, st, flat);
  const inp = mkInp({ throttle: 1, flaps: 2 / 3 });
  const x0 = st.pos.x, z0 = st.pos.z;
  let roll = -1;
  let vr = 0;
  for (let t = 0; t < 90; t += dt) {
    inp.pitch = st.airspeed > 74 && st.pitchAngle < 0.22 ? 0.75 : 0;
    if (st.onGround) vr = st.airspeed;
    stepFlight(a320, st, inp, dt, flat);
    if (!st.onGround && st.pos.y > 8 + a320.gearHeight + 2 && roll < 0) {
      roll = Math.hypot(st.pos.x - x0, st.pos.z - z0);
      break;
    }
  }
  assert.ok(roll > 0, 'A320 never lifted off');
  assert.ok(roll > 700 && roll < 2400, `A320 ground roll implausible (${roll.toFixed(0)} m)`);
  assert.ok(vr * KT > 130 && vr * KT < 175, `A320 lift-off speed off (${(vr * KT).toFixed(0)} kt, want ~145-160)`);
  console.log(`  ✓ A320 rotates at ~${(vr * KT).toFixed(0)} kt, airborne in ${roll.toFixed(0)} m`);
}

// normal-law alpha protection: full aft stick at idle NEVER breaks the wing
// away — the jet mushes at its alpha floor near the ~110 kt book Vs
{
  const st = createState();
  spawnOnRunway(a320, st, flat);
  st.pos.y = 2500;
  st.vel.set(0, 0, -80);
  st.onGround = false;
  const inp = mkInp({ throttle: 0, flaps: 1, pitch: 1 });
  let minKt = Infinity;
  let everStalled = false;
  for (let t = 0; t < 60; t += dt) {
    stepFlight(a320, st, inp, dt, flat);
    minKt = Math.min(minKt, st.airspeed * KT);
    everStalled = everStalled || st.stalled;
  }
  assert.ok(!st.crashed, 'A320 crashed during the alpha-protection demo');
  assert.ok(!everStalled, 'A320 stalled — alpha protection should prevent that');
  assert.ok(minKt > 95 && minKt < 135, `A320 alpha-floor speed off (${minKt.toFixed(0)} kt, want ~110)`);
  console.log(`  ✓ A320 alpha protection holds — mushes at ${minKt.toFixed(0)} kt, never stalls`);
}

// max level cruise near the 450-470 kt book range
{
  const st = createState();
  spawnOnRunway(a320, st, flat);
  st.pos.y = 2500;
  st.vel.set(0, 0, -180);
  st.onGround = false;
  const inp = mkInp({ throttle: 1, gearDown: false });
  for (let t = 0; t < 240; t += dt) {
    const vsT = Math.max(-6, Math.min(6, (2500 - st.pos.y) * 0.15));
    inp.pitch = Math.max(-0.5, Math.min(0.5, (vsT - st.vel.y) * 0.05 - st.angVel.x * 0.8));
    stepFlight(a320, st, inp, dt, flat);
  }
  const kt = st.airspeed * KT;
  assert.ok(!st.crashed, 'A320 crashed in cruise');
  assert.ok(kt > 400 && kt < 520, `A320 max cruise off (${kt.toFixed(0)} kt, want ~450-470)`);
  console.log(`  ✓ A320 tops out at ${kt.toFixed(0)} kt level (book MMO ≈ 470 TAS)`);
}

// stabilised approach: gear + full flap at ~140 kt on a ~3° path, then a
// gentle flare — greased on, no structural drama, transport-jet manners
{
  const st = createState();
  spawnOnRunway(a320, st, flat);
  st.pos.set(0, 8 + a320.gearHeight + 160, -3200);
  st.vel.set(0, -3.7, -72); // ~3° at 140 kt
  st.onGround = false;
  const inp = mkInp({ flaps: 1, gearDown: true });
  for (let t = 0; t < 80 && !st.onGround && !st.crashed; t += dt) {
    const agl = st.pos.y - 8 - a320.gearHeight;
    const vsT = agl > 18 ? -3.7 : Math.max(-1.0, -agl * 0.09); // flare
    inp.throttle = Math.min(1, Math.max(0, 0.42 + (72 - st.airspeed) * 0.04 + (vsT - st.vel.y) * 0.05));
    inp.pitch = Math.max(-0.4, Math.min(0.5, (vsT - st.vel.y) * 0.06 - st.angVel.x * 0.9));
    stepFlight(a320, st, inp, dt, flat);
  }
  assert.ok(st.onGround && !st.crashed,
    `A320 approach failed (${st.crashReason || 'never touched down'})`);
  console.log('  ✓ A320 flies a stabilised approach to a smooth touchdown');
}

// autotrim: hands-off at cruise the jet holds its flight path (normal-law
// path stability) instead of nosing over into the ground — the pre-trim
// model dove in from 800 m in under 30 s with the stick free
{
  const st = createState();
  spawnOnRunway(a320, st, flat);
  st.pos.set(0, 808, 0);
  st.vel.set(0, 0, -130);
  st.onGround = false;
  st.spool = 0.55;
  const inp = mkInp({ throttle: 0.55, gearDown: false });
  let minAlt = Infinity;
  for (let t = 0; t < 90; t += dt) {
    stepFlight(a320, st, inp, dt, flat);
    minAlt = Math.min(minAlt, st.pos.y);
  }
  assert.ok(!st.crashed, `A320 crashed hands-off (${st.crashReason})`);
  assert.ok(minAlt > 500, `A320 lost ${(808 - minAlt).toFixed(0)} m hands-off — trim not holding the path`);
  console.log(`  ✓ A320 autotrim holds the path hands-off (sagged ${(808 - minAlt).toFixed(0)} m in 90 s)`);
}

// the reported killer: AP engaged, then a climb + 30°-bank turn commanded
// together. Pre-trim, the pitch loop saturated fighting the alpha spring
// and the jet descended into the ground at full aft command. It must climb
// at the V/S bug through the whole turn.
{
  const st = createState();
  spawnOnRunway(a320, st, flat);
  st.pos.set(0, 500, 0);
  st.vel.set(0, 0, -103); // ~200 kt
  st.onGround = false;
  st.spool = 0.8;
  const inp = mkInp({ throttle: 0.8, gearDown: false });
  stepFlight(a320, st, inp, dt, flat); // populate airspeed for engage
  st.pos.set(0, 500, 0);
  const ap = new Autopilot();
  ap.engage(st, 0.8);
  ap.targetAlt = 1800;
  ap.targetHdg = Math.PI / 2;
  let minAlt = Infinity;
  const frameDt = 1 / 60; // AP runs per frame in the game, not per substep
  for (let f = 0; f < 60 * 300; f++) {
    ap.update(a320, st, inp, frameDt);
    for (let i = 0; i < 3; i++) stepFlight(a320, st, inp, frameDt / 3, flat);
    minAlt = Math.min(minAlt, st.pos.y);
    if (st.crashed) break;
  }
  assert.ok(!st.crashed, `A320 crashed in the AP climb+turn (${st.crashReason})`);
  assert.ok(minAlt > 380, `A320 sank to ${minAlt.toFixed(0)} m during the AP turn`);
  assert.ok(st.pos.y > 1600, `A320 never made the climb (topped at ${st.pos.y.toFixed(0)} m)`);
  const hdgErr = Math.abs(st.heading - Math.PI / 2);
  assert.ok(hdgErr < 0.05, `A320 heading off by ${(hdgErr * 57.3).toFixed(1)}°`);
  console.log(`  ✓ A320 AP climbs through a 30° banked turn to the ALT bug (min ${minAlt.toFixed(0)} m)`);
}

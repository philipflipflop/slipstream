// Practice engine failures (X) on the fixed-wing fleet: a dead engine gives
// no thrust and windmills; with every engine out each aircraft is a glider
// with a sane glide ratio that peaks near its published best-glide speed;
// with ONE of two out the live engine swings the nose toward the dead one
// and it takes rudder — but a twin still flies.
import assert from 'node:assert/strict';
import { createState, stepFlight, bestGlideSpeed, stallSpeed, setWind } from '../.test-build/aircraft/flightModel.js';
import { CATALOG, specById } from '../.test-build/aircraft/catalog.js';

const dt = 1 / 120;
const KT = 1.943844;
const flat = () => 0;
setWind(0, 0);

function airborne(spec, v, alt, o = {}) {
  const st = createState();
  st.pos.set(0, alt, 0);
  st.vel.set(0, 0, -v);
  st.airspeed = v;
  st.onGround = false;
  const inp = {
    pitch: 0, roll: 0, yaw: 0, throttle: 0, flaps: 0, gearDown: !spec.retractableGear,
    brakes: false, airbrake: false, enginesOut: 0, ...o,
  };
  st.spool = inp.throttle;
  return { st, inp };
}

/** glide ratio holding `v` with the stick, engines out, over `secs` (after settling) */
function glide(spec, v, secs = 40) {
  const { st, inp } = airborne(spec, v, 2600, { enginesOut: spec.engines ?? 1, throttle: 0.6 });
  let x0 = 0, y0 = 0, i = 0;
  for (let t = 0; t < secs + 25; t += dt) {
    inp.pitch = Math.max(-0.6, Math.min(0.6, (st.airspeed - v) * 0.06 - st.angVel.x * 0.5));
    inp.roll = Math.max(-0.5, Math.min(0.5, st.rollAngle * 2 + st.angVel.z * 0.5));
    stepFlight(spec, st, inp, dt, flat);
    if (i++ === Math.round(25 / dt)) { x0 = st.pos.z; y0 = st.pos.y; }
  }
  assert.ok(!st.crashed && !st.stalled, `${spec.id} did not stay flying in the glide`);
  return Math.abs(st.pos.z - x0) / (y0 - st.pos.y);
}

const fixed = CATALOG.filter((s) => s.engine !== 'heli');

// ---- 1. dead stick: thrust really is gone, and each one glides ----
for (const spec of fixed) {
  const vbg = bestGlideSpeed(spec, 1800); // the glide below runs 2,600 → ~1,000 m
  assert.ok(vbg > stallSpeed(spec, 0) * 1.08, `${spec.id}: best glide ${(vbg * KT).toFixed(0)} kt is at the stall`);
  const { st, inp } = airborne(spec, vbg, 3000, { enginesOut: spec.engines ?? 1, throttle: 1 });
  for (let t = 0; t < 3; t += dt) stepFlight(spec, st, inp, dt, flat);
  assert.equal(st.thrustFrac, 0, `${spec.id}: thrust with every engine out`);
  const r = glide(spec, vbg);
  const slow = glide(spec, vbg * 0.82);
  const fast = glide(spec, vbg * 1.3);
  assert.ok(r > 4.5 && r < 22, `${spec.id}: glide ratio ${r.toFixed(1)}`);
  assert.ok(r > slow * 0.95 && r > fast * 0.95,
    `${spec.id}: best-glide speed is not the best glide (${slow.toFixed(1)} / ${r.toFixed(1)} / ${fast.toFixed(1)})`);
  console.log(`  ✓ ${spec.id}: dead stick glides ${r.toFixed(1)}:1 at ${(vbg * KT).toFixed(0)} kt (${slow.toFixed(1)} slower, ${fast.toFixed(1)} faster)`);
}

// ---- 2. one of two: asymmetric thrust ----
for (const id of ['islander', 'a320', 'meridian', 'typhoon']) {
  const spec = specById(id);
  assert.equal(spec.engines, 2, `${id} should be a twin`);
  const v = stallSpeed(spec, 0) * 1.45;

  // feet on the floor: the nose swings LEFT, toward dead engine No.1
  let a = airborne(spec, v, 1500, { enginesOut: 1, throttle: 1 });
  for (let t = 0; t < 8; t += dt) {
    a.inp.pitch = Math.max(-0.5, Math.min(0.5, (a.st.airspeed - v) * 0.05 - a.st.angVel.x * 0.5));
    stepFlight(spec, a.st, a.inp, dt, flat);
  }
  const drift = -a.st.heading * 180 / Math.PI; // heading 0 at the start; left = negative
  // live engine thrust is half of what both would give
  const both = airborne(spec, v, 1500, { throttle: 1 });
  for (let t = 0; t < 1; t += dt) stepFlight(spec, both.st, both.inp, dt, flat);
  const one = airborne(spec, v, 1500, { throttle: 1, enginesOut: 1 });
  for (let t = 0; t < 1; t += dt) stepFlight(spec, one.st, one.inp, dt, flat);
  assert.ok(Math.abs(one.st.thrustFrac / both.st.thrustFrac - 0.5) < 0.03, `${id}: one engine gives ${(one.st.thrustFrac / both.st.thrustFrac).toFixed(2)} of the thrust`);

  // flown properly: rudder toward the live engine holds the heading, wings
  // level, speed held — and the twin still climbs (or at least holds)
  a = airborne(spec, v, 1500, { enginesOut: 1, throttle: 1 });
  let maxRud = 0, maxHdg = 0, y5 = 0, i = 0;
  for (let t = 0; t < 45; t += dt) {
    const hdg = a.st.heading > Math.PI ? a.st.heading - 2 * Math.PI : a.st.heading;
    a.inp.yaw = Math.max(-0.9, Math.min(0.9, -hdg * 6 + a.st.angVel.y * 1.5));
    a.inp.roll = Math.max(-0.6, Math.min(0.6, a.st.rollAngle * 3 + a.st.angVel.z * 0.5));
    a.inp.pitch = Math.max(-0.5, Math.min(0.5, (a.st.airspeed - v) * 0.05 - a.st.angVel.x * 0.5));
    stepFlight(spec, a.st, a.inp, dt, flat);
    if (t > 6) { maxRud = Math.max(maxRud, Math.abs(a.inp.yaw)); maxHdg = Math.max(maxHdg, Math.abs(hdg)); }
    if (i++ === Math.round(15 / dt)) y5 = a.st.pos.y;
  }
  const fpm = (a.st.pos.y - y5) / 30 * 196.85;
  console.log(`  ✓ ${id}: engine 1 out — feet off swings ${drift.toFixed(0)}° left in 8 s; held with ${(maxRud * 100).toFixed(0)}% right rudder (±${(maxHdg * 180 / Math.PI).toFixed(1)}°), ${fpm.toFixed(0)} fpm on one`);
  if (id !== 'typhoon') assert.ok(drift > 4, `${id}: only ${drift.toFixed(1)}° of swing with a wing engine out`);
  assert.ok(a.inp.yaw > 0 || id === 'typhoon', `${id}: rudder went the wrong way`);
  assert.ok(maxRud < 0.88, `${id}: needs ${(maxRud * 100).toFixed(0)}% rudder — not controllable`);
  assert.ok(maxHdg < 0.09, `${id}: heading wandered ${(maxHdg * 180 / Math.PI).toFixed(1)}° with rudder held`);
  assert.ok(fpm > -150, `${id}: sinks ${fpm.toFixed(0)} fpm on one engine at full power`);
}

// ---- 3. singles have one engine to lose; relight restores the lot ----
{
  for (const spec of fixed) if (!spec.engines) assert.ok(!spec.asymYaw, `${spec.id}: asymmetry on a single`);
  const spec = specById('skylark');
  const { st, inp } = airborne(spec, 45, 1000, { enginesOut: 1, throttle: 1 });
  for (let t = 0; t < 4; t += dt) stepFlight(spec, st, inp, dt, flat);
  assert.equal(st.thrustFrac, 0);
  inp.enginesOut = 0;
  for (let t = 0; t < 4; t += dt) stepFlight(spec, st, inp, dt, flat);
  assert.ok(st.thrustFrac > 0.5, 'relight gave no thrust');
  console.log('  ✓ singles: one press and it is a glider; relight restores thrust');
}

// ---- 4. the autopilot with an engine failure ----
// One of two out: it still holds height and heading. Everything out: there
// is no height to hold — it must fly best-glide speed (never the stall: left
// chasing altitude it parked the Falcon IN the stall for two minutes).
{
  const { Autopilot } = await import('../.test-build/aircraft/autopilot.js');
  for (const spec of fixed) {
    const n = spec.engines ?? 1;
    for (const out of n > 1 ? [1, n] : [n]) {
      const v = stallSpeed(spec, 0) * 1.9;
      const { st, inp } = airborne(spec, v, 2500, { throttle: 0.6 });
      const ap = new Autopilot();
      for (let t = 0; t < 5; t += dt) stepFlight(spec, st, inp, dt, flat);
      ap.engage(st, inp.throttle);
      let stalledFor = 0, worst = 0, y0 = 0;
      for (let t = 0; t < 150 && st.pos.y > 300; t += dt) {
        if (t > 8) inp.enginesOut = out;
        ap.update(spec, st, inp, dt, st.pos.y);
        stepFlight(spec, st, inp, dt, flat);
        if (st.stalled) stalledFor += dt;
        if (t > 70) worst = Math.max(worst, Math.abs(st.airspeed / bestGlideSpeed(spec, st.pos.y) - 1));
        if (Math.abs(t - 8) < dt / 2) y0 = st.pos.y;
      }
      assert.ok(!st.crashed && stalledFor === 0, `${spec.id} ${out}/${n} out under AP: stalled ${stalledFor.toFixed(0)} s`);
      if (out === n) {
        assert.ok(ap.gliding, `${spec.id}: AP not in glide mode with every engine out`);
        assert.ok(worst < 0.13, `${spec.id}: AP glide is ${(worst * 100).toFixed(0)}% off best-glide speed`);
      } else {
        assert.ok(!ap.gliding && Math.abs(st.pos.y - y0) < 60, `${spec.id}: lost ${(y0 - st.pos.y).toFixed(0)} m on one engine under AP`);
      }
    }
  }
  console.log('  ✓ autopilot: holds height and heading on one engine; with none it flies best-glide speed and never stalls');
}

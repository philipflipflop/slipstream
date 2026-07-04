// Wind: aerodynamics run on air-relative velocity while positions integrate
// inertially — IAS/GS split, crosswind drift and wind-aware hovering all
// fall out of one subtraction. Wind defaults to calm, so every other test
// file (separate node processes) stays bit-exact.
import assert from 'node:assert/strict';
import { createState, stepFlight, spawnOnRunway, setWind } from '../.test-build/aircraft/flightModel.js';
import { specById } from '../.test-build/aircraft/catalog.js';
import { Autopilot } from '../.test-build/aircraft/autopilot.js';

const dt = 1 / 180;
const flat = () => 8;
const mkInp = (o = {}) => ({
  pitch: 0, roll: 0, yaw: 0, throttle: 0, flaps: 0,
  gearDown: true, brakes: false, airbrake: false, ...o,
});

// headwind arithmetic: flying north at 40 m/s GS into an 8 m/s northerly
// reads 48 on the airspeed tape
{
  const sk = specById('skylark');
  const st = createState();
  spawnOnRunway(sk, st, flat);
  st.pos.y = 400;
  st.vel.set(0, 0, -40);
  st.onGround = false;
  setWind(0, 8); // from the north = air moving south (+z)
  stepFlight(sk, st, mkInp({ throttle: 0.7 }), dt, flat);
  assert.ok(Math.abs(st.airspeed - 48) < 0.6, `headwind IAS wrong (${st.airspeed.toFixed(1)}, want ~48)`);
  setWind(0, -8); // tailwind: same GS reads 32
  stepFlight(sk, st, mkInp({ throttle: 0.7 }), dt, flat);
  assert.ok(st.airspeed < 42, `tailwind IAS wrong (${st.airspeed.toFixed(1)}, want ~32)`);
  setWind(0, 0);
  console.log('  ✓ IAS = GS ± wind component (head/tailwind split)');
}

// hands-off, an airplane is not a balloon: static stability weathervanes
// the nose INTO the crosswind (here an easterly), and the ground track
// ends up working upwind — the classic free-flight response
{
  const sk = specById('skylark');
  const st = createState();
  spawnOnRunway(sk, st, flat);
  st.pos.y = 600;
  st.vel.set(0, 0, -35);
  st.onGround = false;
  setWind(-8, 0); // from the east = air moving west (−x)
  const inp = mkInp({ throttle: 0.55 });
  for (let t = 0; t < 25; t += dt) stepFlight(sk, st, inp, dt, flat);
  setWind(0, 0);
  assert.ok(!st.crashed, 'crosswind flight crashed');
  assert.ok(st.heading > 0.1, `did not weathervane into the easterly (hdg ${st.heading.toFixed(2)})`);
  assert.ok(Number.isFinite(st.heading) && Math.abs(st.rollAngle) < 1, 'crosswind destabilized the airframe');
  console.log(`  ✓ hands-off it weathervanes into the wind (hdg → ${(st.heading * 57.3).toFixed(0)}°)`);
}

// hold the heading (autopilot) and the crosswind shows as pure downwind
// drift across the ground — the crab every pilot flies on final
{
  const sk = specById('skylark');
  const st = createState();
  spawnOnRunway(sk, st, flat);
  st.pos.y = 600;
  st.vel.set(0, 0, -38);
  st.onGround = false;
  setWind(-8, 0);
  const inp = mkInp({ throttle: 0.55 });
  const ap = new Autopilot();
  ap.engage(st, 0.55);
  ap.targetHdg = 0;
  ap.targetSpd = 38;
  for (let t = 0; t < 30; t += dt) {
    ap.update(sk, st, inp, dt);
    stepFlight(sk, st, inp, dt, flat);
  }
  setWind(0, 0);
  assert.ok(!st.crashed, 'heading-hold crosswind flight crashed');
  assert.ok(st.pos.x < -100, `no downwind drift under heading hold (x=${st.pos.x.toFixed(0)})`);
  console.log(`  ✓ heading hold drifts downwind (${(-st.pos.x).toFixed(0)} m west in 30 s)`);
}

// helicopter hover hold in wind: the AP holds the SPOT (ground position),
// which means standing cyclic into the wind — wander stays tight
{
  const jr = specById('jetranger');
  const st = createState();
  spawnOnRunway(jr, st, flat);
  st.pos.y = 150;
  st.onGround = false;
  setWind(5, 2); // ~10 kt quartering breeze
  const inp = mkInp();
  const ap = new Autopilot();
  ap.engage(st, 0.62, 0);
  const x0 = st.pos.x, z0 = st.pos.z;
  for (let t = 0; t < 60; t += dt) {
    ap.update(jr, st, inp, dt);
    stepFlight(jr, st, inp, dt, flat);
  }
  setWind(0, 0);
  const wander = Math.hypot(st.pos.x - x0, st.pos.z - z0);
  assert.ok(!st.crashed, 'hover hold in wind crashed');
  assert.ok(Math.abs(st.pos.y - 150) < 10, `altitude lost in windy hover (${st.pos.y.toFixed(0)})`);
  assert.ok(wander < 60, `hover hold blown off station (${wander.toFixed(0)} m)`);
  console.log(`  ✓ hover hold fights a 10 kt breeze (${wander.toFixed(0)} m wander in 60 s)`);
}

// ground grip: a parked jet in a 10 kt crosswind neither slides sideways
// nor weathervanes — tire grip reacts the aero forces (playtester report:
// the Vector was creeping sideways on the runway before takeoff)
{
  const vec = specById('vector');
  const st = createState();
  spawnOnRunway(vec, st, flat);
  const h0 = st.heading;
  const x0 = st.pos.x, z0 = st.pos.z;
  setWind(-5.1, 0); // 10 kt from the east
  const inp = mkInp();
  for (let t = 0; t < 20; t += dt) stepFlight(vec, st, inp, dt, flat);
  setWind(0, 0);
  let dh = st.heading - h0;
  while (dh > Math.PI) dh -= 2 * Math.PI;
  while (dh < -Math.PI) dh += 2 * Math.PI;
  const slid = Math.hypot(st.pos.x - x0, st.pos.z - z0);
  assert.ok(Math.hypot(st.vel.x, st.vel.z) < 0.5, 'parked jet blown down the apron');
  assert.ok(Math.abs(dh) < 0.035, `parked jet weathervaned (${(dh * 57.3).toFixed(1)}°)`);
  assert.ok(slid < 1.5, `parked jet slid ${slid.toFixed(1)} m in a 10 kt crosswind`);
  console.log(`  ✓ parked jet holds heading and position in a 10 kt crosswind (${(dh * 57.3).toFixed(2)}°, ${slid.toFixed(2)} m)`);
}

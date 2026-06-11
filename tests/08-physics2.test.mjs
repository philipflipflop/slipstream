// Physics realism round 2: engine spool lag, ground effect, prop torque /
// P-factor, and turbulence defaulting to zero (deterministic for tests).
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createState, stepFlight } from '../.test-build/aircraft/flightModel.js';
import { CATALOG } from '../.test-build/aircraft/catalog.js';

const flat = () => 0;
const spec = (id) => CATALOG.find((a) => a.id === id);

const neutral = () => ({
  pitch: 0, roll: 0, yaw: 0, throttle: 0, flaps: 0,
  gearDown: false, brakes: false, airbrake: false,
});

function levelFlight(s, V, y = 800) {
  const st = createState();
  st.pos.set(0, y, 0);
  st.vel.set(0, 0, -V);
  st.onGround = false;
  st.spool = 0.5;
  return st;
}

// --- jet spool lag: slamming the lever doesn't slam the thrust ---
{
  const vec = spec('vector');
  const st = levelFlight(vec, 180);
  st.spool = 0.1;
  const inp = neutral();
  inp.throttle = 1;
  const dt = 1 / 180;
  let tAt90 = null;
  for (let t = 0; t < 6; t += dt) {
    stepFlight(vec, st, inp, dt, flat);
    if (tAt90 === null && st.spool > 0.9) tAt90 = t;
  }
  assert.ok(tAt90 > 0.8, `jet spooled idle→90% in ${tAt90?.toFixed(2)}s — too instant`);
  assert.ok(tAt90 < 3.5, `jet took ${tAt90?.toFixed(2)}s to spool — too sluggish`);
  assert.ok(st.spool > 0.99, 'spool should converge to commanded');
  console.log(`  ✓ jet spools 10%→90% in ${tAt90.toFixed(2)}s`);
}

// --- prop responds much faster ---
{
  const sky = spec('skylark');
  const st = levelFlight(sky, 45);
  st.spool = 0.1;
  const inp = neutral();
  inp.throttle = 1;
  const dt = 1 / 180;
  let tAt90 = null;
  for (let t = 0; t < 3; t += dt) {
    stepFlight(sky, st, inp, dt, flat);
    if (tAt90 === null && st.spool > 0.9) tAt90 = t;
  }
  assert.ok(tAt90 < 0.6, `prop took ${tAt90?.toFixed(2)}s to spool — should be near-immediate`);
  console.log(`  ✓ prop spools 10%→90% in ${tAt90.toFixed(2)}s`);
}

// --- ground effect: more net lift skimming the surface than up high ---
{
  const sky = spec('skylark');
  const inp = neutral();
  inp.throttle = 0.5;
  const dt = 1 / 180;

  const probe = (alt) => {
    const st = levelFlight(sky, 50, alt);
    st.spool = 0.5;
    stepFlight(sky, st, inp, dt, flat);
    return (st.vel.y) / dt; // vertical acceleration on the first step
  };
  const low = probe(3.5);   // wheels just off the grass
  const high = probe(600);
  assert.ok(low > high + 0.15, `ground effect missing: a(3.5m)=${low.toFixed(2)} vs a(600m)=${high.toFixed(2)}`);
  console.log(`  ✓ ground effect adds ${(low - high).toFixed(2)} m/s² of float in the flare`);
}

// --- prop torque rolls left at full power, low speed ---
{
  const sky = spec('skylark');
  const st = levelFlight(sky, 35);
  st.spool = 1;
  const inp = neutral();
  inp.throttle = 1;
  const dt = 1 / 180;
  for (let t = 0; t < 1.2; t += dt) stepFlight(sky, st, inp, dt, flat);
  assert.ok(st.angVel.z > 0.004, `no torque roll (angVel.z=${st.angVel.z.toFixed(4)})`);
  console.log(`  ✓ torque rolls left hands-off (${st.angVel.z.toFixed(3)} rad/s after 1.2s)`);
}

// --- turbulence defaults off: physics bit-exact across runs ---
{
  const fal = spec('falcon');
  const run = () => {
    const st = levelFlight(fal, 90);
    const inp = neutral();
    inp.throttle = 0.7;
    const dt = 1 / 120;
    for (let t = 0; t < 5; t += dt) stepFlight(fal, st, inp, dt, flat);
    return [st.pos.x, st.pos.y, st.pos.z, st.vel.y];
  };
  assert.deepEqual(run(), run());
  console.log('  ✓ turbulence defaults to 0 — runs are bit-exact');
}

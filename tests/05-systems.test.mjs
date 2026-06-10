// v2 systems: compass convention, autopilot hold, airbrake, G-limit.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { createState, stepFlight, spawnOnRunway } from '../.test-build/aircraft/flightModel.js';
import { Autopilot } from '../.test-build/aircraft/autopilot.js';
import { CATALOG } from '../.test-build/aircraft/catalog.js';

const dt = 1 / 180;
const flat = () => 0;
const baseInp = () => ({
  pitch: 0, roll: 0, yaw: 0, throttle: 0.6, flaps: 0,
  gearDown: false, brakes: false, airbrake: false,
});

function cruise(spec, v, alt = 800) {
  const st = createState();
  spawnOnRunway(spec, st, flat);
  st.pos.set(0, alt, 0);
  st.vel.set(0, 0, -v);
  st.quat.identity();
  st.onGround = false;
  return st;
}

// compass: flying east must read +90°
{
  const spec = CATALOG[0];
  const st = cruise(spec, 50);
  st.quat.setFromEuler(new THREE.Euler(0, -Math.PI / 2, 0, 'YXZ')); // nose east
  st.vel.set(50, 0, 0);
  stepFlight(spec, st, baseInp(), dt, flat);
  assert.ok(Math.abs(st.heading - Math.PI / 2) < 0.06, `east reads ${(st.heading * 57.3).toFixed(0)}°, want 90°`);
  console.log('  ✓ compass heading: east = 090');
}

// autopilot recaptures altitude + heading after a displacement
{
  const spec = CATALOG[0];
  const st = cruise(spec, 48, 500);
  const ap = new Autopilot();
  const inp = baseInp();
  ap.engage(st, 0.55);
  st.pos.y = 440; // knocked 60 m low
  for (let t = 0; t < 120; t += dt) {
    ap.update(spec, st, inp, dt);
    stepFlight(spec, st, inp, dt, flat);
    if (st.crashed) break;
  }
  assert.ok(!st.crashed, 'AP crashed the aircraft');
  assert.ok(Math.abs(st.pos.y - 500) < 18, `AP altitude error ${(st.pos.y - 500).toFixed(1)} m`);
  const hdgErr = Math.abs(Math.atan2(Math.sin(st.heading), Math.cos(st.heading)));
  assert.ok(hdgErr < 0.06, `AP heading error ${(hdgErr * 57.3).toFixed(1)}°`);
  assert.ok(Math.abs(st.airspeed - ap.targetSpd) < 8, `AP speed error ${(st.airspeed - ap.targetSpd).toFixed(1)} m/s`);
  console.log(`  ✓ autopilot holds alt (Δ${(st.pos.y - 500).toFixed(1)} m), hdg, speed`);
}

// airbrake bleeds speed measurably faster
{
  const spec = CATALOG.find((s) => s.id === 'vector');
  const run = (airbrake) => {
    const st = cruise(spec, 220);
    const inp = { ...baseInp(), throttle: 0, airbrake };
    for (let t = 0; t < 10; t += dt) stepFlight(spec, st, inp, dt, flat);
    return st.airspeed;
  };
  const clean = run(false);
  const dirty = run(true);
  assert.ok(clean - dirty > 6, `airbrake only added ${(clean - dirty).toFixed(1)} m/s of decel`);
  console.log(`  ✓ airbrake: ${(clean - dirty).toFixed(1)} m/s extra bleed over 10 s`);
}

// G-limit: a full pull at high speed stays near the rated load factor
{
  const spec = CATALOG.find((s) => s.id === 'vector');
  const st = cruise(spec, 400, 2000);
  const inp = { ...baseInp(), throttle: 1, pitch: 1 };
  let maxG = 0;
  for (let t = 0; t < 4; t += dt) {
    stepFlight(spec, st, inp, dt, flat);
    maxG = Math.max(maxG, st.gForce);
    if (st.crashed) break;
  }
  assert.ok(maxG < spec.gLimit * 1.4, `pulled ${maxG.toFixed(1)}g, limit ${spec.gLimit}g`);
  assert.ok(maxG > spec.gLimit * 0.65, `pull too weak (${maxG.toFixed(1)}g vs rated ${spec.gLimit}g)`);
  console.log(`  ✓ full pull at 400 m/s peaks at ${maxG.toFixed(1)}g (rated ${spec.gLimit}g)`);
}

// every airfield really exists: flat at its elevation, paved, and dry
{
  const { AIRPORTS } = await import('../.test-build/world/heightfield.js');
  const { WorldGen } = await import('../.test-build/world/heightfield.js');
  const gen = new WorldGen();
  for (const ap of AIRPORTS) {
    const h = gen.heightAt(ap.x, ap.z);
    assert.ok(Math.abs(h - ap.elev) < 0.5, `${ap.name}: terrain ${h.toFixed(1)} m vs declared ${ap.elev} m`);
    const hEnd = gen.heightAt(ap.x, ap.z + ap.length / 2 - 40);
    assert.ok(Math.abs(hEnd - ap.elev) < 0.5, `${ap.name}: runway end not flat (${hEnd.toFixed(1)} m)`);
    assert.ok(ap.elev > 0.5, `${ap.name}: underwater`);
    assert.ok(gen.isOnRunway(ap.x, ap.z), `${ap.name}: centre not paved`);
    console.log(`  ✓ ${ap.name} exists, flat at ${ap.elev} m, paved`);
  }
}

// fbw fighter refuses to deep-stall from a full pull at low speed
{
  const spec = CATALOG.find((s) => s.id === 'vector');
  const st = cruise(spec, 90, 2000);
  const inp = { ...baseInp(), throttle: 0.8, pitch: 1 };
  let stalledFrames = 0;
  for (let t = 0; t < 12; t += dt) {
    stepFlight(spec, st, inp, dt, flat);
    if (st.stalled) stalledFrames++;
    if (st.crashed) break;
  }
  assert.ok(!st.crashed, 'fbw fighter crashed from a pull');
  assert.ok(stalledFrames < 90, `fbw fighter spent ${stalledFrames} frames stalled`);
  console.log('  ✓ fly-by-wire alpha limiter prevents deep stall');
}

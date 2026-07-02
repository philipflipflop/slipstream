// In-flight handling: banked turns change heading, controls release recovers,
// nothing diverges to NaN, stall flag rises at high alpha.
import assert from 'node:assert/strict';
import { createState, stepFlight, spawnOnRunway } from '../.test-build/aircraft/flightModel.js';
import { CATALOG } from '../.test-build/aircraft/catalog.js';

const dt = 1 / 180;
const heightAt = () => 0;

function cruiseState(spec, v) {
  const st = createState();
  spawnOnRunway(spec, st, heightAt);
  st.pos.set(0, 800, 0);
  st.vel.set(0, 0, -v);
  st.onGround = false;
  return st;
}

for (const spec of CATALOG) {
  const v0 = spec.vne * 0.5;
  const st = cruiseState(spec, v0);
  const inp = { pitch: 0, roll: 0, yaw: 0, throttle: 0.7, flaps: 0, gearDown: false, brakes: false };

  const h0 = st.heading;
  // roll in for 1.5 s, hold a gentle pull for 8 s. Helicopter cyclic is
  // attitude-command: releasing the stick levels the disc, so the bank is
  // HELD through the manoeuvre to keep the turn going.
  const heli = spec.engine === 'heli';
  for (let t = 0; t < 12; t += dt) {
    inp.roll = t < 1.5 || heli ? 0.5 : 0;
    inp.pitch = t >= 1.5 ? (heli ? 0.1 : 0.25) : 0;
    stepFlight(spec, st, inp, dt, heightAt);
  }
  const turned = Math.abs(st.heading - h0);
  assert.ok(Number.isFinite(st.airspeed) && Number.isFinite(st.heading), `${spec.id}: NaN state`);
  assert.ok(turned > 0.15, `${spec.id}: bank+pull did not turn (Δhdg=${turned.toFixed(2)})`);
  assert.ok(!st.crashed, `${spec.id}: crashed during turn`);

  // release controls: must not diverge over 30 s
  inp.roll = 0; inp.pitch = 0;
  for (let t = 0; t < 30 && !st.crashed; t += dt) stepFlight(spec, st, inp, dt, heightAt);
  assert.ok(Number.isFinite(st.pos.y) && Math.abs(st.rollAngle) < Math.PI, `${spec.id}: diverged hands-off`);
  console.log(`  ✓ ${spec.id.padEnd(9)} turns (Δhdg ${turned.toFixed(2)} rad) and stays sane hands-off`);
}

// deep pull at low speed must raise the stall flag
{
  const spec = CATALOG[0];
  const st = cruiseState(spec, 22);
  const inp = { pitch: 1, roll: 0, yaw: 0, throttle: 0.2, flaps: 0, gearDown: false, brakes: false };
  let sawStall = false;
  for (let t = 0; t < 10 && !st.crashed; t += dt) {
    stepFlight(spec, st, inp, dt, heightAt);
    if (st.stalled) { sawStall = true; break; }
  }
  assert.ok(sawStall, 'stall never flagged at high alpha / low speed');
  console.log('  ✓ stall warning rises at high alpha');
}

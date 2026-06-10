// Crash detection: water, hard impact, terrain — and gentle landings survive.
import assert from 'node:assert/strict';
import { createState, stepFlight, spawnOnRunway } from '../.test-build/aircraft/flightModel.js';
import { CATALOG } from '../.test-build/aircraft/catalog.js';

const spec = CATALOG[0];
const dt = 1 / 180;

function run(setup, heightAt, maxT = 30) {
  const st = createState();
  spawnOnRunway(spec, st, () => 8);
  setup(st);
  const inp = { pitch: 0, roll: 0, yaw: 0, throttle: 0, flaps: 0, gearDown: true, brakes: false };
  for (let t = 0; t < maxT; t += dt) {
    stepFlight(spec, st, inp, dt, heightAt);
    if (st.crashed) break;
  }
  return st;
}

const water = run((st) => {
  st.pos.set(0, 30, -3000); st.vel.set(0, -8, -50); st.onGround = false;
}, () => -30);
assert.ok(water.crashed && /WATER|DITCH/.test(water.crashReason), 'water ditch not detected');
console.log(`  ✓ water ditch → "${water.crashReason}"`);

const slam = run((st) => {
  st.pos.set(0, 60, 0); st.vel.set(0, -25, -30); st.onGround = false;
}, () => 8);
assert.ok(slam.crashed, 'hard impact not detected');
console.log(`  ✓ hard impact → "${slam.crashReason}"`);

const cfit = run((st) => {
  st.pos.set(0, 60, 0); st.vel.set(0, 0, -80); st.onGround = false;
}, (px, pz) => (pz < -500 ? 8 + (-pz - 500) * 0.9 : 8));
assert.ok(cfit.crashed, 'terrain impact not detected');
console.log(`  ✓ terrain impact → "${cfit.crashReason}"`);

const gentle = run((st) => {
  st.pos.set(0, 12, 0); st.vel.set(0, -1.2, -32); st.onGround = false;
}, () => 8);
assert.ok(!gentle.crashed, `gentle landing crashed: ${gentle.crashReason}`);
assert.ok(gentle.onGround && gentle.airspeed < 15, 'gentle landing did not roll out');
console.log('  ✓ gentle touchdown survives and rolls out');

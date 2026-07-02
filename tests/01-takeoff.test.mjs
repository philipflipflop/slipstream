// Every aircraft must take off under autopilot, reach a sane speed, and not crash.
import assert from 'node:assert/strict';
import { createState, stepFlight, spawnOnRunway } from '../.test-build/aircraft/flightModel.js';
import { CATALOG } from '../.test-build/aircraft/catalog.js';

const heightAt = () => 8;
const dt = 1 / 180;
const KT = 1.943844;

for (const spec of CATALOG) {
  const st = createState();
  spawnOnRunway(spec, st, heightAt);
  const inp = { pitch: 0, roll: 0, yaw: 0, throttle: 1, flaps: 0.33, gearDown: true, brakes: false };
  const vr = Math.sqrt((2 * spec.mass * 9.81) / (1.225 * spec.wingArea * 1.2)) * 0.85;

  let liftoffT = -1;
  let maxV = 0;
  const heli = spec.engine === 'heli';
  for (let t = 0; t <= 180; t += dt) {
    if (heli) {
      // vertical climb-out on the collective, then nose over to accelerate
      inp.flaps = 0;
      inp.pitch = st.pos.y > 8 + 40 && st.airspeed < spec.vne * 0.85 ? -0.6 : 0;
    } else {
      inp.pitch = st.airspeed > vr && st.pitchAngle < 0.16 ? 0.35 : 0;
      if (liftoffT > 0) {
        inp.gearDown = false;
        inp.flaps = 0;
        const targetPitch = st.pos.y > 800 ? 0.02 : 0.12;
        inp.pitch = (targetPitch - st.pitchAngle) * 6 - st.angVel.x * 1.2;
      }
    }
    stepFlight(spec, st, inp, dt, heightAt);
    if (liftoffT < 0 && !st.onGround && st.pos.y > 8 + spec.gearHeight + 2) liftoffT = t;
    maxV = Math.max(maxV, st.airspeed);
    if (st.crashed) break;
  }

  assert.ok(!st.crashed, `${spec.id}: crashed (${st.crashReason})`);
  assert.ok(liftoffT > 0 && liftoffT < 60, `${spec.id}: failed to lift off (t=${liftoffT})`);
  const maxKt = maxV * KT;
  assert.ok(maxKt > spec.topSpeedKt * 0.55, `${spec.id}: too slow (${maxKt.toFixed(0)}kt)`);
  assert.ok(maxKt < spec.topSpeedKt * 1.35, `${spec.id}: too fast (${maxKt.toFixed(0)}kt)`);
  assert.ok(Number.isFinite(st.pos.x + st.pos.y + st.pos.z), `${spec.id}: NaN position`);
  console.log(`  ✓ ${spec.id.padEnd(9)} liftoff ${liftoffT.toFixed(0)}s, max ${maxKt.toFixed(0)}kt`);
}

// throttle at zero: stays parked
{
  const spec = CATALOG[0];
  const st = createState();
  spawnOnRunway(spec, st, heightAt);
  const inp = { pitch: 0, roll: 0, yaw: 0, throttle: 0, flaps: 0, gearDown: true, brakes: false };
  for (let t = 0; t < 10; t += dt) stepFlight(spec, st, inp, dt, heightAt);
  assert.ok(st.airspeed < 0.1, 'parked aircraft drifted');
  console.log('  ✓ parked aircraft stays put');
}

// brakes stop a 40 m/s ground roll
{
  const spec = CATALOG[0];
  const st = createState();
  spawnOnRunway(spec, st, heightAt);
  st.vel.set(0, 0, -40);
  const inp = { pitch: 0, roll: 0, yaw: 0, throttle: 0, flaps: 0, gearDown: true, brakes: true };
  let stopped = false;
  for (let t = 0; t < 30; t += dt) {
    stepFlight(spec, st, inp, dt, heightAt);
    if (st.airspeed < 0.2) { stopped = true; break; }
  }
  assert.ok(stopped, 'brakes failed to stop the aircraft');
  console.log('  ✓ brakes stop a fast ground roll');
}

// Debug trace for autopilot tuning (not part of the suite — run via node after `npm test` builds).
import { createState, stepFlight, spawnOnRunway } from '../.test-build/aircraft/flightModel.js';
import { Autopilot } from '../.test-build/aircraft/autopilot.js';
import { CATALOG } from '../.test-build/aircraft/catalog.js';

const spec = CATALOG[Number(process.argv[2] ?? 0)];
const st = createState();
spawnOnRunway(spec, st, () => 0);
st.pos.set(0, 500, 0);
st.vel.set(0, 0, -48);
st.quat.identity();
st.onGround = false;

const ap = new Autopilot();
const inp = { pitch: 0, roll: 0, yaw: 0, throttle: 0.6, flaps: 0, gearDown: false, brakes: false, airbrake: false };
ap.engage(st, 0.55);
st.pos.y = 440;

const dt = 1 / 180;
for (let t = 0; t <= 120; t += dt) {
  ap.update(spec, st, inp, dt);
  stepFlight(spec, st, inp, dt, () => 0);
  if (Math.round(t / dt) % (180 * 8) === 0) {
    console.log(
      `t=${t.toFixed(0).padStart(3)} alt=${st.pos.y.toFixed(1)} vs=${st.vel.y.toFixed(2)} ` +
      `v=${st.airspeed.toFixed(1)} pitch=${inp.pitch.toFixed(3)} thr=${inp.throttle.toFixed(2)} ` +
      `aoa=${(st.aoa * 57.3).toFixed(1)}`,
    );
  }
  if (st.crashed) { console.log('CRASH', st.crashReason); break; }
}

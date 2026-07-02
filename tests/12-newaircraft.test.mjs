// New fleet: Islander BN2T stays close to its published numbers (STOL roll,
// ~1,000+ fpm climb, ~170 kt cruise) and the Bell 505 helicopter regime works
// end to end — hover trim, vertical climb limits, forward flight, gentle
// vertical landings, hard-drop crashes, and the swapped-loop autopilot.
import assert from 'node:assert/strict';
import { createState, stepFlight, spawnOnRunway } from '../.test-build/aircraft/flightModel.js';
import { specById } from '../.test-build/aircraft/catalog.js';
import { Autopilot } from '../.test-build/aircraft/autopilot.js';

const dt = 1 / 180;
const flat = () => 8;
const KT = 1.943844;

const mkInp = (o = {}) => ({
  pitch: 0, roll: 0, yaw: 0, throttle: 0, flaps: 0,
  gearDown: true, brakes: false, airbrake: false, ...o,
});

/* ================= ISLANDER BN2T ================= */
const isl = specById('islander');
assert.equal(isl.id, 'islander');
assert.equal(isl.retractableGear, false);

// STOL takeoff: one notch of flap, rotate ~58 kt, airborne in a short roll
{
  const st = createState();
  spawnOnRunway(isl, st, flat);
  const inp = mkInp({ throttle: 1, flaps: 1 / 3 });
  const x0 = st.pos.x, z0 = st.pos.z;
  let roll = -1;
  for (let t = 0; t < 40; t += dt) {
    inp.pitch = st.airspeed > 30 && st.pitchAngle < 0.16 ? 0.35 : 0;
    stepFlight(isl, st, inp, dt, flat);
    if (!st.onGround && st.pos.y > 8 + isl.gearHeight + 1.5 && roll < 0) {
      roll = Math.hypot(st.pos.x - x0, st.pos.z - z0);
      break;
    }
  }
  assert.ok(roll > 0, 'Islander never lifted off');
  assert.ok(roll < 500, `Islander ground roll too long (${roll.toFixed(0)} m)`);
  console.log(`  ✓ Islander STOL takeoff — ${roll.toFixed(0)} m ground roll`);
}

// climb: full power at ~Vy, sustained rate in the turboprop's ballpark
{
  const st = createState();
  spawnOnRunway(isl, st, flat);
  st.pos.y = 300;
  st.vel.set(0, 0, -42);
  st.onGround = false;
  const inp = mkInp({ throttle: 1 });
  const y0 = st.pos.y;
  for (let t = 0; t < 30; t += dt) {
    inp.pitch = (0.14 - st.pitchAngle) * 5 - st.angVel.x * 1.1;
    stepFlight(isl, st, inp, dt, flat);
  }
  const avgVs = (st.pos.y - y0) / 30;
  assert.ok(!st.crashed, 'Islander crashed in the climb');
  assert.ok(avgVs > 3.5 && avgVs < 10,
    `Islander climb rate off (${avgVs.toFixed(1)} m/s ≈ ${(avgVs * 197).toFixed(0)} fpm)`);
  console.log(`  ✓ Islander climbs at ${(avgVs * 196.85).toFixed(0)} fpm`);
}

// cruise: firewall the throttles and hold altitude — max level speed should
// land near the published 170 kt (game tolerance ±)
{
  const st = createState();
  spawnOnRunway(isl, st, flat);
  st.pos.y = 500;
  st.vel.set(0, 0, -80);
  st.onGround = false;
  const inp = mkInp({ throttle: 1 });
  for (let t = 0; t < 200; t += dt) {
    const vsT = Math.max(-4, Math.min(4, (500 - st.pos.y) * 0.15));
    inp.pitch = Math.max(-0.5, Math.min(0.5, (vsT - st.vel.y) * 0.05 - st.angVel.x * 0.8));
    stepFlight(isl, st, inp, dt, flat);
  }
  const kt = st.airspeed * KT;
  assert.ok(!st.crashed, 'Islander crashed in cruise');
  assert.ok(Math.abs(st.pos.y - 500) < 80, `cruise altitude not held (${st.pos.y.toFixed(0)} m)`);
  assert.ok(kt > 150 && kt < 195, `Islander max cruise off (${kt.toFixed(0)} kt, want ~170)`);
  console.log(`  ✓ Islander tops out at ${kt.toFixed(0)} kt level (book: 170)`);
}

/* ================= BELL 505 ================= */
const jr = specById('jetranger');
assert.equal(jr.engine, 'heli');

// full collective from the pad: lifts straight off, climb rate power-limited
{
  const st = createState();
  spawnOnRunway(jr, st, flat);
  const inp = mkInp({ throttle: 1 });
  let liftT = -1;
  let maxVs = 0;
  for (let t = 0; t < 20; t += dt) {
    stepFlight(jr, st, inp, dt, flat);
    if (liftT < 0 && !st.onGround && st.pos.y > 8 + jr.gearHeight + 2) liftT = t;
    maxVs = Math.max(maxVs, st.vel.y);
  }
  assert.ok(liftT > 0 && liftT < 8, `505 failed to lift off (t=${liftT.toFixed(1)})`);
  assert.ok(!st.crashed, `505 crashed on departure (${st.crashReason})`);
  assert.ok(maxVs > 4 && maxVs < 14, `505 vertical climb rate off (${maxVs.toFixed(1)} m/s)`);
  const drift = Math.hypot(st.vel.x, st.vel.z);
  assert.ok(drift < 6, `505 ran away sideways in the climb (${drift.toFixed(1)} m/s)`);
  console.log(`  ✓ 505 vertical departure — airborne at ${liftT.toFixed(1)} s, VROC ${(maxVs * 196.85).toFixed(0)} fpm`);
}

// hover trim: a simple collective loop holds height — and needs a mid-range
// collective to do it (the classic "hover at half torque plus a bit")
{
  const st = createState();
  spawnOnRunway(jr, st, flat);
  st.pos.y = 108;
  st.onGround = false;
  const inp = mkInp();
  let collSum = 0, collN = 0;
  for (let t = 0; t < 40; t += dt) {
    inp.throttle = Math.min(1, Math.max(0,
      0.6 + (100 - st.pos.y) * 0.02 - st.vel.y * 0.12));
    stepFlight(jr, st, inp, dt, flat);
    if (t > 20) { collSum += st.spool; collN++; }
  }
  const coll = collSum / collN;
  assert.ok(!st.crashed && !st.onGround, '505 fell out of the hover');
  assert.ok(Math.abs(st.pos.y - 100) < 6, `505 hover height drifted (${st.pos.y.toFixed(1)} m)`);
  assert.ok(Math.abs(st.vel.y) < 0.8, `505 hover VS not settled (${st.vel.y.toFixed(2)})`);
  assert.ok(coll > 0.45 && coll < 0.8, `hover collective implausible (${coll.toFixed(2)})`);
  console.log(`  ✓ 505 hovers hands-off at collective ${(coll * 100).toFixed(0)}%`);
}

// forward flight: nose over from the hover and it accelerates to cruise;
// max level speed lives near the 125 kt book figure
{
  const st = createState();
  spawnOnRunway(jr, st, flat);
  st.pos.y = 300;
  st.onGround = false;
  const inp = mkInp();
  let maxKt = 0;
  for (let t = 0; t < 90; t += dt) {
    inp.throttle = Math.min(1, Math.max(0, 0.62 + (300 - st.pos.y) * 0.01 - st.vel.y * 0.1));
    inp.pitch = -0.55; // firm forward cyclic
    stepFlight(jr, st, inp, dt, flat);
    maxKt = Math.max(maxKt, st.airspeed * KT);
  }
  assert.ok(!st.crashed, `505 crashed accelerating (${st.crashReason})`);
  assert.ok(maxKt > 95 && maxKt < 150, `505 max speed off (${maxKt.toFixed(0)} kt, want ~125)`);
  console.log(`  ✓ 505 accelerates to ${maxKt.toFixed(0)} kt (book max cruise: 125)`);
}

// pedal turn in the hover: yaw input spins the nose with no forward speed
{
  const st = createState();
  spawnOnRunway(jr, st, flat);
  st.pos.y = 60;
  st.onGround = false;
  const inp = mkInp({ yaw: 0.6 });
  const h0 = st.heading;
  for (let t = 0; t < 4; t += dt) {
    inp.throttle = Math.min(1, Math.max(0, 0.62 - st.vel.y * 0.12));
    stepFlight(jr, st, inp, dt, flat);
  }
  let turned = st.heading - h0;
  while (turned > Math.PI) turned -= 2 * Math.PI;
  while (turned < -Math.PI) turned += 2 * Math.PI;
  assert.ok(Math.abs(turned) > 0.5, `pedal turn too weak (Δhdg ${turned.toFixed(2)})`);
  assert.ok(st.airspeed < 8, 'pedal turn picked up speed');
  console.log(`  ✓ 505 pedal-turns in the hover (Δhdg ${turned.toFixed(2)} rad)`);
}

// vertical landing on unprepared ground: ease the collective, cushion, live
{
  const st = createState();
  spawnOnRunway(jr, st, flat);
  st.pos.set(2000, 8 + jr.gearHeight + 25, -3000); // nowhere near a runway
  st.onGround = false;
  const inp = mkInp();
  for (let t = 0; t < 40 && !st.onGround && !st.crashed; t += dt) {
    const agl = st.pos.y - 8 - jr.gearHeight;
    const targetVs = agl > 8 ? -2.2 : -0.8; // flare-cushion below 8 m
    inp.throttle = Math.min(1, Math.max(0, 0.62 + (targetVs - st.vel.y) * 0.25));
    stepFlight(jr, st, inp, dt, flat);
  }
  assert.ok(st.onGround && !st.crashed, `505 vertical landing failed (${st.crashReason || 'never touched down'})`);
  console.log('  ✓ 505 lands vertically off-airport');
}

// chopping the collective from height is not survivable
{
  const st = createState();
  spawnOnRunway(jr, st, flat);
  st.pos.y = 8 + jr.gearHeight + 40;
  st.onGround = false;
  const inp = mkInp({ throttle: 0.15 });
  for (let t = 0; t < 15 && !st.crashed; t += dt) stepFlight(jr, st, inp, dt, flat);
  assert.ok(st.crashed, '505 survived a collective chop from 40 m');
  console.log(`  ✓ collective chop → "${st.crashReason}"`);
}

// running landing too fast digs the skids in
{
  const st = createState();
  spawnOnRunway(jr, st, flat);
  st.pos.y = 8 + jr.gearHeight + 6;
  st.vel.set(0, -1, -30);
  st.onGround = false;
  const inp = mkInp({ throttle: 0.4 });
  for (let t = 0; t < 8 && !st.crashed; t += dt) stepFlight(jr, st, inp, dt, flat);
  assert.ok(st.crashed && /SKIDS/.test(st.crashReason), `fast run-on not caught (${st.crashReason})`);
  console.log(`  ✓ 30 m/s run-on → "${st.crashReason}"`);
}

// autorotation: collective full down at altitude with forward speed — the
// upflow keeps the rotor driven and it settles into the textbook glide
// (FAA HFH ch.11: ~1,500–2,000 fpm at 50–65 kt, 3–4:1 over the ground)
{
  const st = createState();
  spawnOnRunway(jr, st, flat);
  st.pos.y = 600;
  st.vel.set(0, 0, -32);
  st.onGround = false;
  const inp = mkInp({ throttle: 0 });
  let sinkSum = 0, sinkN = 0, yMark = 0, zMark = 0;
  for (let t = 0; t < 25; t += dt) {
    inp.pitch = Math.max(-0.5, Math.min(0.3, (st.airspeed - 32) * 0.05)); // hold ~62 kt
    stepFlight(jr, st, inp, dt, flat);
    if (t >= 8) {
      if (yMark === 0) { yMark = st.pos.y; zMark = st.pos.z; }
      sinkSum += -st.vel.y; sinkN++;
    }
  }
  const sink = sinkSum / sinkN;
  const glide = Math.abs(st.pos.z - zMark) / (yMark - st.pos.y);
  assert.ok(!st.crashed, 'autorotation diverged');
  assert.ok(sink > 5.5 && sink < 11,
    `autorotative sink off (${sink.toFixed(1)} m/s ≈ ${(sink * 196.85).toFixed(0)} fpm, book ~1500-2000)`);
  assert.ok(glide > 2.8 && glide < 5.5, `autorotative glide ratio off (${glide.toFixed(1)}:1, book 3-4)`);
  console.log(`  ✓ 505 autorotates at ${(sink * 196.85).toFixed(0)} fpm, ${glide.toFixed(1)}:1 glide`);
}

// ...and the full engine-out drill is survivable: glide down, flare to kill
// the speed, cushion the last metres with the collective
{
  const st = createState();
  spawnOnRunway(jr, st, flat);
  st.pos.y = 8 + jr.gearHeight + 250;
  st.vel.set(0, 0, -32);
  st.onGround = false;
  const inp = mkInp({ throttle: 0 });
  for (let t = 0; t < 90 && !st.onGround && !st.crashed; t += dt) {
    const agl = st.pos.y - 8 - jr.gearHeight;
    if (agl > 25) {
      inp.throttle = 0;
      inp.pitch = Math.max(-0.5, Math.min(0.3, (st.airspeed - 32) * 0.05));
    } else {
      inp.pitch = Math.min(0.55, Math.max(-0.2, (st.airspeed - 8) * 0.06)); // flare
      inp.throttle = agl < 10
        ? Math.min(1, Math.max(0, 0.65 + (-1.0 - st.vel.y) * 0.3))          // cushion
        : 0.25;
    }
    stepFlight(jr, st, inp, dt, flat);
  }
  assert.ok(st.onGround && !st.crashed,
    `autorotation flare landing failed (${st.crashReason || 'never touched down'})`);
  console.log('  ✓ 505 survives a full autorotation to touchdown');
}

// vortex ring state: powered descent onto the downwash at low airspeed
// deepens the sink instead of arresting it; forward cyclic flies out of it
{
  const st = createState();
  spawnOnRunway(jr, st, flat);
  st.pos.y = 400;
  st.vel.set(0, -8, 0);
  st.onGround = false;
  const inp = mkInp({ throttle: 0.62 });
  let worst = 0;
  for (let t = 0; t < 5; t += dt) {
    stepFlight(jr, st, inp, dt, flat);
    worst = Math.min(worst, st.vel.y);
  }
  assert.ok(worst < -9, `VRS did not deepen the sink (worst ${worst.toFixed(1)} m/s)`);
  inp.pitch = -0.5; // recover: fly forward out of the ring
  for (let t = 0; t < 18; t += dt) stepFlight(jr, st, inp, dt, flat);
  assert.ok(!st.crashed && st.vel.y > -3.5 && st.pos.y > 60,
    `VRS forward-cyclic recovery failed (vs ${st.vel.y.toFixed(1)}, alt ${st.pos.y.toFixed(0)})`);
  console.log(`  ✓ vortex ring state bites (sink to ${(worst * 196.85).toFixed(0)} fpm) and forward cyclic recovers`);
}

// hover realism: tail-rotor translating tendency drifts the ship right…
{
  const st = createState();
  spawnOnRunway(jr, st, flat);
  st.pos.y = 150;
  st.onGround = false;
  const inp = mkInp();
  for (let t = 0; t < 15; t += dt) {
    inp.throttle = Math.min(1, Math.max(0, 0.62 + (150 - st.pos.y) * 0.02 - st.vel.y * 0.12));
    stepFlight(jr, st, inp, dt, flat);
  }
  assert.ok(st.vel.x > 0.7, `no translating tendency (vx ${st.vel.x.toFixed(2)})`);
  console.log(`  ✓ hover drifts right off the tail rotor (${st.vel.x.toFixed(1)} m/s after 15 s)`);
}

// …and flapback: at speed with the stick free the disc tilts aft, the nose
// rises and the ship bleeds speed — cruise takes standing forward cyclic
{
  const st = createState();
  spawnOnRunway(jr, st, flat);
  st.pos.y = 400;
  st.vel.set(0, 0, -50);
  st.onGround = false;
  const inp = mkInp({ throttle: 0.65 });
  for (let t = 0; t < 6; t += dt) stepFlight(jr, st, inp, dt, flat);
  assert.ok(st.pitchAngle > 0.03, `no flapback (pitch ${st.pitchAngle.toFixed(3)})`);
  assert.ok(st.airspeed < 49, 'flapback did not bleed speed');
  console.log(`  ✓ flapback trims the nose up at speed (+${(st.pitchAngle * 57.3).toFixed(1)}°, decelerating)`);
}

// ENGINE OUT, rotor energy: freezing on the controls (collective still up)
// bleeds rotor RPM — the classic fatal mistake — while collective-down
// autorotation keeps NR alive all the way to a survivable flare
{
  const st = createState();
  spawnOnRunway(jr, st, flat);
  st.pos.y = 500;
  st.vel.set(0, 0, -40);
  st.onGround = false;
  const inp = mkInp({ throttle: 0.62, engineCut: true }); // engine fails, pilot freezes
  let minNr = 1;
  for (let t = 0; t < 5; t += dt) {
    stepFlight(jr, st, inp, dt, flat);
    minNr = Math.min(minNr, st.rotorRpm);
  }
  assert.ok(minNr < 0.8, `NR should droop with collective up (NR ${minNr.toFixed(2)})`);
  assert.ok(st.vel.y < -6, `drooped rotor should be falling (vs ${st.vel.y.toFixed(1)})`);
  console.log(`  ✓ engine cut + frozen collective → rotor droops to ${(minNr * 100).toFixed(0)}% NR, falling`);
}
{
  const st = createState();
  spawnOnRunway(jr, st, flat);
  st.pos.y = 8 + jr.gearHeight + 350;
  st.vel.set(0, 0, -32);
  st.onGround = false;
  const inp = mkInp({ throttle: 0, engineCut: true }); // textbook: collective down NOW
  let nrGlide = 0;
  for (let t = 0; t < 120 && !st.onGround && !st.crashed; t += dt) {
    const agl = st.pos.y - 8 - jr.gearHeight;
    if (agl > 25) {
      inp.throttle = 0;
      inp.pitch = Math.max(-0.5, Math.min(0.3, (st.airspeed - 32) * 0.05));
      nrGlide = st.rotorRpm;
    } else {
      inp.pitch = Math.min(0.55, Math.max(-0.2, (st.airspeed - 8) * 0.06)); // flare
      inp.throttle = agl < 10
        ? Math.min(1, Math.max(0, 0.65 + (-1.0 - st.vel.y) * 0.3))          // spend the rotor
        : 0.2;
    }
    stepFlight(jr, st, inp, dt, flat);
  }
  assert.ok(nrGlide > 0.85 && nrGlide < 1.15,
    `NR should hold near 100% in the established auto (${(nrGlide * 100).toFixed(0)}%)`);
  assert.ok(st.onGround && !st.crashed,
    `true engine-out autorotation landing failed (${st.crashReason || 'never landed'})`);
  console.log(`  ✓ true engine-out auto: NR ${(nrGlide * 100).toFixed(0)}% in the glide, flare landing survivable`);
}

// hover-hold autopilot: engage in a hover (minSpd 0) and it stays put
{
  const st = createState();
  spawnOnRunway(jr, st, flat);
  st.pos.y = 120;
  st.vel.set(0.5, 0, -1);
  st.onGround = false;
  const inp = mkInp();
  const ap = new Autopilot();
  ap.engage(st, 0.62, 0); // helicopter: no fixed-wing speed floor
  const x0 = st.pos.x, z0 = st.pos.z;
  for (let t = 0; t < 60; t += dt) {
    ap.update(jr, st, inp, dt);
    stepFlight(jr, st, inp, dt, flat);
  }
  const wander = Math.hypot(st.pos.x - x0, st.pos.z - z0);
  const gs = Math.hypot(st.vel.x, st.vel.z);
  assert.ok(!st.crashed, 'hover hold crashed');
  assert.ok(Math.abs(st.pos.y - 120) < 8, `hover hold altitude drifted (${st.pos.y.toFixed(1)} m)`);
  assert.ok(gs < 2.5, `hover hold still translating (${gs.toFixed(1)} m/s)`);
  assert.ok(wander < 120, `hover hold wandered ${wander.toFixed(0)} m off station`);
  console.log(`  ✓ AP hover hold: ${st.pos.y.toFixed(0)} m, ${gs.toFixed(1)} m/s residual drift, ${wander.toFixed(0)} m wander`);
}

// autopilot (swapped loops): holds altitude on collective, speed on attitude
{
  const st = createState();
  spawnOnRunway(jr, st, flat);
  st.pos.y = 300;
  st.vel.set(0, 0, -45);
  st.onGround = false;
  const inp = mkInp();
  const ap = new Autopilot();
  ap.engage(st, 0.65);
  ap.targetAlt = 350;
  ap.targetSpd = 50;
  for (let t = 0; t < 90; t += dt) {
    ap.update(jr, st, inp, dt);
    stepFlight(jr, st, inp, dt, flat);
  }
  assert.ok(!st.crashed, '505 AP crashed');
  assert.ok(Math.abs(st.pos.y - 350) < 12, `505 AP altitude hold off (${st.pos.y.toFixed(0)} m)`);
  assert.ok(Math.abs(st.airspeed - 50) < 5, `505 AP speed hold off (${st.airspeed.toFixed(1)} m/s)`);
  console.log(`  ✓ 505 autopilot holds ${st.pos.y.toFixed(0)} m / ${(st.airspeed * KT).toFixed(0)} kt`);
}

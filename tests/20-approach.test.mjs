// Approaches: the world must offer a flyable one to every runway, the
// approach spawn must put a trimmed aircraft on it, the autopilot's APPR
// mode must fly it to a full autoland, and the landing rubric must grade
// what happened.
import assert from 'node:assert/strict';
import { WorldGen, AIRPORTS } from '../.test-build/world/heightfield.js';
import {
  createState, stepFlight, spawnOnApproach, spawnOnRunway, setWind, approachSpeed, stallSpeed,
} from '../.test-build/aircraft/flightModel.js';
import { specById, CATALOG } from '../.test-build/aircraft/catalog.js';
import { Autopilot } from '../.test-build/aircraft/autopilot.js';
import { approachesOf, solveIls } from '../.test-build/nav/ils.js';
import { runwayUnder, scoreLanding, aimPoint } from '../.test-build/nav/landing.js';
import { buildScatter } from '../.test-build/world/terrainBuilder.js';

const KT = 1.943844;
const TAN3 = Math.tan((3 * Math.PI) / 180);

/* ------------------------------------------ 1. clear approach paths ---- */
// Every runway end gets an obstacle-limitation surface (2.0° from the
// threshold): terrain may not stand through the 3° glide path anywhere
// along the protected length, in any world. (Before this rule Meridian's
// own runway 36L had a hill 98 m ABOVE the glide path at 5 km.)
{
  let ends = 0;
  let tightest = Infinity;
  for (const theme of ['archipelago', 'mesa', 'metro']) {
    const gen = new WorldGen(undefined, theme);
    // the hand-placed fields plus every procedural one within 60 km of home
    const fields = gen.airfieldsNear(0, 0, 60000, []);
    for (const far of [AIRPORTS[3], AIRPORTS[4]]) if (!fields.includes(far)) fields.push(far);
    for (const f of fields) {
      const protectedLen = f.intl ? 12000 : f.major ? 7000 : 5000;
      const apps = [];
      approachesOf(f, apps);
      for (const app of apps) {
        ends++;
        const dx = Math.sin(app.course);
        const dz = -Math.cos(app.course);
        for (let d = 0; d <= protectedLen; d += 50) {
          const path = app.elev + 2.5 + TAN3 * (d + 300);
          // sample across the localizer's half-scale width
          const half = Math.min(120 + d * 0.03, 400);
          for (const off of [-half, 0, half]) {
            const x = app.thrX - dx * d - dz * off;
            const z = app.thrZ - dz * d + dx * off;
            const clr = path - gen.heightAt(x, z);
            if (clr < tightest) tightest = clr;
            assert.ok(clr > 12,
              `${theme} ${f.name} ${app.ident}: terrain ${(-clr).toFixed(0)} m above the glide path ${d} m out`);
          }
        }
      }
    }
  }
  assert.ok(ends > 60, `only ${ends} runway ends checked`);
  console.log(`  ✓ every glide path clears terrain (${ends} runway ends, 3 worlds; tightest ${tightest.toFixed(0)} m)`);
}

// …and nothing scattered stands in it either: trees, rocks, houses and city
// towers under the corridors stay below the approach surface
{
  let objects = 0;
  for (const theme of ['archipelago', 'metro', 'mesa']) {
    const gen = new WorldGen(undefined, theme);
    const f = AIRPORTS[0];
    const apps = [];
    approachesOf(f, apps);
    for (const app of apps) {
      const dx = Math.sin(app.course);
      const dz = -Math.cos(app.course);
      const seen = new Set();
      for (let d = 300; d <= 9000; d += 450) {
        const cx = Math.floor((app.thrX - dx * d) / 900);
        const cz = Math.floor((app.thrZ - dz * d) / 900);
        if (seen.has(`${cx},${cz}`)) continue;
        seen.add(`${cx},${cz}`);
        const sc = buildScatter(gen, cx, cz, 2);
        // matrices are T·R·S (column-major): el[5] = height, el[12..14] = base
        const tops = [
          [sc.treeMats, 24], [sc.leafMats, 24], [sc.rockMats, 1],
          [sc.houseMats, 1.5], [sc.towerMats, 1], [sc.glassMats, 1],
        ];
        for (const [arr, k] of tops) {
          for (let i = 0; i < arr.length; i += 16) {
            const ox = arr[i + 12], oy = arr[i + 13], oz = arr[i + 14];
            const top = oy + arr[i + 5] * (k > 2 ? 14 : k); // trees: ~14 m per unit scale
            const along = -((ox - app.thrX) * dx + (oz - app.thrZ) * dz);
            const across = Math.abs((ox - app.thrX) * -dz + (oz - app.thrZ) * dx);
            if (along < 100 || across > 150 + along * 0.04) continue;
            const path = app.elev + 2.5 + TAN3 * (along + 300);
            objects++;
            assert.ok(top < path - 5,
              `${theme} ${app.ident}: object top ${top.toFixed(0)} m vs glide path ${path.toFixed(0)} m, ${along.toFixed(0)} m out`);
          }
        }
      }
    }
  }
  console.log(`  ✓ no tree, rock or building reaches the glide path (${objects} objects under Meridian's four finals)`);
}

/* ---------------------------------------------- 2. landing rubric ---- */
{
  const rwy = { length: 3900, width: 45 };
  const perfect = scoreLanding({ sink: 0.5, cross: 0.4, past: 300, ...rwy });
  assert.equal(perfect.score, 100);
  assert.equal(perfect.grade, 'A+');
  const firm = scoreLanding({ sink: 2.6, cross: 0.4, past: 300, ...rwy });
  assert.ok(firm.score < 75 && firm.verdict.includes('HARD'), `hard landing scored ${firm.score}: ${firm.verdict}`);
  const wide = scoreLanding({ sink: 0.5, cross: 14, past: 300, ...rwy });
  assert.ok(wide.linePts < 15 && wide.verdict.includes('RIGHT'), wide.verdict);
  const long = scoreLanding({ sink: 0.5, cross: 0, past: 1500, ...rwy });
  assert.ok(long.zonePts === 0 && long.verdict.includes('LONG'), long.verdict);
  const short = scoreLanding({ sink: 0.5, cross: 0, past: 40, ...rwy });
  assert.ok(short.zonePts < 10 && short.verdict.includes('SHORT'), short.verdict);
  // a short strip moves the aiming point in with it
  assert.ok(aimPoint(1150) < 260 && aimPoint(3900) === 300);
  // monotonic in each fault
  let prev = 101;
  for (let s = 0.4; s < 4; s += 0.2) {
    const v = scoreLanding({ sink: s, cross: 0, past: 300, ...rwy }).score;
    assert.ok(v <= prev, 'score rises with sink rate');
    prev = v;
  }
  console.log('  ✓ landing rubric: sink / centreline / touchdown zone each graded and named');

  // runway lookup reads in the direction of travel, both parallels
  const f = AIRPORTS[0];
  const west = runwayUnder([f], f.x - f.rwySep / 2 + 3, f.z + f.length / 2 - 400, 0);
  assert.ok(west && west.ident === '36L' && Math.abs(west.past - 400) < 1 && Math.abs(west.cross - 3) < 1e-6,
    `36L lookup: ${JSON.stringify(west)}`);
  const south = runwayUnder([f], f.x + f.rwySep / 2 - 5, f.z, Math.PI);
  assert.ok(south && south.ident === '18L' && south.cross > 4.9, `18L lookup: ${JSON.stringify(south)}`);
  assert.equal(runwayUnder([f], f.x, f.z, 0), null, 'the terminal area is not a runway');
  console.log('  ✓ runway lookup: correct end, parallel, centreline offset sign');
}

/* --------------------------------------------- 3. approach spawn ---- */
// Hands-off for 8 s after spawning on final, every aircraft must still be
// flying the approach: near reference speed, descending near 3°, upright.
{
  const gen = new WorldGen();
  const h = (x, z) => gen.heightAt(x, z);
  const apps = [];
  approachesOf(AIRPORTS[0], apps);
  for (const spec of CATALOG) {
    const st = createState();
    const set = spawnOnApproach(spec, st, apps[0], 5000, 2 / 3);
    const inp = { pitch: 0, roll: 0, yaw: 0, throttle: set.throttle, flaps: set.flaps, gearDown: true, brakes: false, airbrake: false };
    const v0 = st.airspeed;
    const heli = spec.engine === 'heli';
    if (!heli) {
      assert.ok(Math.abs(set.speed - approachSpeed(spec, set.flaps)) < 1e-9);
      assert.ok(set.speed > stallSpeed(spec, set.flaps) * 1.25, `${spec.id}: spawned too close to the stall`);
    }
    let minV = Infinity, maxV = 0, stalled = false;
    for (let t = 0; t < 8; t += 1 / 180) {
      stepFlight(spec, st, inp, 1 / 180, h);
      minV = Math.min(minV, st.airspeed);
      maxV = Math.max(maxV, st.airspeed);
      stalled = stalled || st.stalled;
    }
    assert.ok(!st.crashed && !stalled, `${spec.id}: ${st.crashed ? st.crashReason : 'stalled'} after spawning on final`);
    if (!heli) {
      assert.ok(minV > v0 * 0.93 && maxV < v0 * 1.07,
        `${spec.id}: speed wandered ${(minV * KT).toFixed(0)}–${(maxV * KT).toFixed(0)} kt from ${(v0 * KT).toFixed(0)}`);
      const fpa = Math.atan2(st.vel.y, Math.hypot(st.vel.x, st.vel.z)) * 57.3;
      // still descending toward the runway, neither levelling off nor diving
      assert.ok(fpa < -0.5 && fpa > -5, `${spec.id}: flight path ${fpa.toFixed(1)}° after 8 s hands-off`);
    }
    assert.ok(Math.abs(st.rollAngle) < 0.2, `${spec.id}: rolled off (${(st.rollAngle * 57.3).toFixed(0)}°)`);
  }
  console.log(`  ✓ approach spawn: all ${CATALOG.length} aircraft arrive trimmed and stable on final`);
}

/* ------------------------------------------------- 4. autoland ---- */
function autoland(id, { windFrom = 90, windKt = 0, offLat = 200, offAlt = -30, field = 0, appIdx = 0, flaps = 1 } = {}) {
  const gen = new WorldGen();
  const h = (x, z) => gen.heightAt(x, z);
  const spec = specById(id);
  const rad = (windFrom * Math.PI) / 180;
  const ms = windKt / KT;
  setWind(-Math.sin(rad) * ms, Math.cos(rad) * ms);
  const apps = [];
  approachesOf(AIRPORTS[field], apps);
  const app = apps[appIdx];
  const st = createState();
  const dist = Math.max(approachSpeed(spec, flaps) * 95, 5000);
  const set = spawnOnApproach(spec, st, app, dist, flaps, offLat, offAlt);
  const inp = { pitch: 0, roll: 0, yaw: 0, throttle: set.throttle, flaps: set.flaps, gearDown: true, brakes: false, airbrake: false };
  const ap = new Autopilot();
  stepFlight(spec, st, inp, 1 / 180, h);
  ap.engage(st, inp.throttle);
  ap.armApproach(app);
  const dt = 1 / 60;
  let td = null, wasGround = false, prevSink = 0, maxGsDev = 0, maxLocDev = 0, maxVsSwing = 0, t = 0;
  const phases = [];
  for (; t < 420; t += dt) {
    inp.brakes = false;
    const ra = st.pos.y - Math.max(h(st.pos.x, st.pos.z), 0) - spec.gearHeight;
    ap.update(spec, st, inp, dt, ra);
    if (phases[phases.length - 1] !== ap.apprPhase) phases.push(ap.apprPhase);
    for (let i = 0; i < 3; i++) stepFlight(spec, st, inp, dt / 3, h);
    if (st.crashed) break;
    if (st.onGround && !wasGround && !td) {
      const rw = runwayUnder([AIRPORTS[field]], st.pos.x, st.pos.z, Math.atan2(st.vel.x, -st.vel.z));
      td = { sink: prevSink, rw };
    }
    wasGround = st.onGround;
    prevSink = -st.vel.y;
    // established on the beam: from 30 s after capture down to 60 m
    if (ap.apprPhase === 'gs' && t > 35 && ra > 60) {
      const d = solveIls(app, st.pos.x, st.pos.y, st.pos.z);
      maxGsDev = Math.max(maxGsDev, Math.abs(d.gsDev) * 57.3);
      maxLocDev = Math.max(maxLocDev, Math.abs(d.locDev) * 57.3);
      const nominal = -Math.hypot(st.vel.x, st.vel.z) * TAN3;
      maxVsSwing = Math.max(maxVsSwing, Math.abs(st.vel.y - nominal));
    }
    if (!ap.engaged) break;
  }
  setWind(0, 0);
  const end = runwayUnder([AIRPORTS[field]], st.pos.x, st.pos.z, app.course);
  const score = td && td.rw
    ? scoreLanding({ sink: td.sink, cross: td.rw.cross, past: td.rw.past, length: td.rw.length, width: td.rw.width })
    : null;
  return { spec, st, ap, td, end, score, phases, maxGsDev, maxLocDev, maxVsSwing, t };
}

for (const id of ['skylark', 'islander', 'falcon', 'vector', 'typhoon', 'meridian', 'a320']) {
  for (const windKt of [0, 14]) {
    const r = autoland(id, { windKt });
    const tag = `${id} (${windKt} kt crosswind)`;
    assert.ok(!r.st.crashed, `${tag}: crashed — ${r.st.crashReason}`);
    assert.deepEqual(r.phases, ['loc', 'gs', 'flare', 'rollout', 'done'], `${tag}: phases ${r.phases}`);
    assert.ok(r.td && r.td.rw, `${tag}: did not touch down on the runway`);
    // on the beam: a quarter of a dot, no porpoise
    assert.ok(r.maxGsDev < 0.12, `${tag}: glideslope wandered ${r.maxGsDev.toFixed(2)}°`);
    assert.ok(r.maxLocDev < 0.25, `${tag}: localizer wandered ${r.maxLocDev.toFixed(2)}°`);
    assert.ok(r.maxVsSwing < 1.2, `${tag}: sink rate swung ±${r.maxVsSwing.toFixed(1)} m/s on the glide path`);
    // touchdown: gentle, on the line, in the zone
    assert.ok(r.td.sink < 1.6, `${tag}: touchdown at ${(r.td.sink * 196.85).toFixed(0)} fpm`);
    assert.ok(Math.abs(r.td.rw.cross) < 3.5, `${tag}: ${r.td.rw.cross.toFixed(1)} m off the centreline`);
    assert.ok(r.td.rw.past > 150 && r.td.rw.past < 650, `${tag}: touched down ${r.td.rw.past.toFixed(0)} m in`);
    assert.ok(r.score.score >= 85, `${tag}: scored ${r.score.score} (${r.score.verdict})`);
    // rollout: stopped on the runway, on the centreline, AP handed back
    assert.ok(r.end && Math.abs(r.end.cross) < 4 && r.end.past < r.end.length - 300,
      `${tag}: rollout ended ${JSON.stringify(r.end)}`);
    assert.ok(!r.ap.engaged && Math.hypot(r.st.vel.x, r.st.vel.z) < 3, `${tag}: not stopped`);
    if (windKt === 0) {
      console.log(`  ✓ ${id} autoland: ${(r.td.sink * 196.85).toFixed(0)} fpm, ${Math.abs(r.td.rw.cross).toFixed(1)} m off, ` +
        `${r.td.rw.past.toFixed(0)} m in → ${r.score.score} ${r.score.grade}; G/S held to ${r.maxGsDev.toFixed(2)}°`);
    }
  }
}
console.log('  ✓ …and again with a 14 kt crosswind: crab emerges from track-steering, all still on the centreline');

// from above the path, the other parallel, the reciprocal end, an elevated field
{
  const high = autoland('a320', { offAlt: 90, offLat: -350 });
  assert.ok(!high.st.crashed && high.score && high.score.score >= 80, `a320 from above: ${high.score?.score}`);
  const other = autoland('meridian', { appIdx: 2, windKt: 8, windFrom: 270 });
  assert.ok(!other.st.crashed && other.td?.rw?.ident === '36R' && other.score.score >= 85, `36R: ${other.td?.rw?.ident} ${other.score?.score}`);
  const recip = autoland('islander', { appIdx: 1, windKt: 6, windFrom: 200 });
  assert.ok(!recip.st.crashed && recip.td?.rw?.ident === '18R' && recip.score.score >= 85, `18R: ${recip.td?.rw?.ident} ${recip.score?.score}`);
  const moor = autoland('skylark', { field: 2, windKt: 10, windFrom: 60 });
  assert.ok(!moor.st.crashed && moor.td?.rw && moor.score.score >= 80, `Highmoor: ${moor.score?.score}`);
  console.log(`  ✓ from above the path (${high.score.score}), 36R (${other.score.score}), 18R (${recip.score.score}), Highmoor at 150 m elevation (${moor.score.score})`);
}

/* ------------------------------------------------- 5. gear rules ---- */
{
  const flat = () => 8;
  const spec = specById('meridian');
  const st = createState();
  spawnOnRunway(spec, st, flat);
  st.pos.y += 4;
  st.vel.set(0, -1.2, -70);
  st.onGround = false;
  const inp = { pitch: 0, roll: 0, yaw: 0, throttle: 0, flaps: 1, gearDown: false, brakes: false, airbrake: false };
  for (let t = 0; t < 6 && !st.crashed; t += 1 / 180) stepFlight(spec, st, inp, 1 / 180, flat);
  assert.ok(st.crashed && st.crashReason.includes('GEAR-UP'), `gear-up touchdown: ${st.crashReason || 'no crash'}`);
  // fixed-gear aircraft have no such trap
  const sk = specById('skylark');
  const s2 = createState();
  spawnOnRunway(sk, s2, flat);
  s2.pos.y += 2;
  s2.vel.set(0, -0.8, -26);
  s2.onGround = false;
  for (let t = 0; t < 6 && !s2.crashed; t += 1 / 180) stepFlight(sk, s2, { ...inp, gearDown: false }, 1 / 180, flat);
  assert.ok(!s2.crashed && s2.onGround, 'fixed-gear landing must ignore the gear lever');
  console.log('  ✓ a gear-up touchdown writes off a retractable; fixed gear is unaffected');
}

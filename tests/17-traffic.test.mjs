// NPC traffic: parked aircraft appear at fields (never on the pavement),
// the airborne layer stays inside its bubble with terrain clearance, and
// everything is deterministic per field.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WorldGen, AIRPORTS } from '../.test-build/world/heightfield.js';
import { Traffic } from '../.test-build/world/traffic.js';

const gen = new WorldGen();
const dt = 1 / 60;

// ten simulated minutes over the home international
{
  const t = new Traffic(new THREE.Scene(), gen);
  let minClear = Infinity;
  let maxD = 0;
  for (let s = 0; s < 600; s += dt) {
    t.update(dt, 0, 0, s, true);
    for (const f of t.flying) {
      const p = f.group.position;
      minClear = Math.min(minClear, p.y - Math.max(gen.heightAt(p.x, p.z), 0));
      maxD = Math.max(maxD, Math.hypot(p.x, p.z));
    }
  }
  assert.equal(t.flying.length, 5, `expected 5 airborne NPCs, got ${t.flying.length}`);
  assert.ok(minClear > 120, `airborne NPC scraped terrain (${minClear.toFixed(0)} m clearance)`);
  assert.ok(maxD < 32000, `airborne NPC escaped the bubble (${(maxD / 1000).toFixed(1)} km)`);
  console.log(`  ✓ 5 airborne NPCs, ${minClear.toFixed(0)} m min terrain clearance, bubble held`);
}

// airborne layer off (race): flyers drain instead of respawning
{
  const t = new Traffic(new THREE.Scene(), gen);
  for (let s = 0; s < 5; s += dt) t.update(dt, 0, 0, s, true);
  assert.equal(t.flying.length, 5);
  for (let s = 0; s < 900; s += dt) t.update(dt, 0, 0, s, false);
  assert.equal(t.flying.length, 0, `race mode still has ${t.flying.length} NPCs airborne`);
  console.log('  ✓ airborne layer drains when disabled (race mode)');
}

// parked aircraft: on stands at the international, clear of every runway
// and taxiway; deterministic across constructions
{
  const home = AIRPORTS[0];
  const collect = () => {
    const t = new Traffic(new THREE.Scene(), gen);
    t.update(dt, 0, 0, 0, false);
    const pos = [];
    for (const rec of t.parked.values()) {
      const g = rec.group;
      g.updateMatrixWorld(true);
      g.traverse((o) => {
        if (o.isMesh) {
          const w = new THREE.Vector3();
          o.getWorldPosition(w);
          pos.push([Math.round(w.x), Math.round(w.z)]);
        }
      });
    }
    return pos.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  };
  const a = collect();
  const b = collect();
  assert.ok(a.length >= 4, `only ${a.length} parked NPCs near the spawn international`);
  assert.deepEqual(a, b, 'parked traffic is not deterministic');
  for (const [x, z] of a) {
    assert.ok(!gen.isOnRunway(x, z), `parked NPC on a runway at ${x},${z}`);
    // inside the stand rows, well clear of the taxiways at |across| 585+
    const across = Math.abs(x - home.x);
    if (across < 1000) {
      assert.ok(across < 560, `parked NPC on/over the taxiway (across ${across})`);
    }
  }
  console.log(`  ✓ ${a.length} parked NPCs on stands, deterministic, clear of pavement`);
}

// ---- runway movements at the home international ----
// Twenty simulated minutes: airliners land on and depart from the EASTERN
// runway (the player spawns on the western one), into the wind, one
// movement on the runway at a time, touching down in the zone, never
// passing through the ground.
const homeRec = (t) => [...t.parked.values()].find((r) => r.def === AIRPORTS[0]);
{
  const home = AIRPORTS[0];
  const t = new Traffic(new THREE.Scene(), gen);
  t.setWind(0, 6); // air moving south: a northerly — land heading north
  let maxOn = 0, under = 0, wrongWay = 0, offRunway = 0;
  const tdAt = [];
  const was = new Map();
  for (let s = 0; s < 1200; s += dt) {
    t.update(dt, 0, 0, s, true, 1e9);
    const o = homeRec(t)?.ops;
    if (!o) continue;
    let on = 0;
    for (const f of o.flights) {
      const p = f.group.position;
      // (a departure may line up and WAIT behind a landing still rolling out)
      if (f.phase === 'rollout' || f.phase === 'roll') on++;
      if (p.y < gen.heightAt(p.x, p.z) - 0.5) under++;
      if (Math.abs(f.app.course) > 0.01) wrongWay++;
      if (was.get(f) === 'final' && f.phase === 'rollout') tdAt.push(f.s);
      was.set(f, f.phase);
      if (f.phase === 'rollout' || f.phase === 'roll') {
        // on the eastern runway's centreline, inside its length
        if (Math.abs(p.x - (home.x + home.rwySep / 2)) > 3 || !gen.isOnRunway(p.x, p.z)) offRunway++;
      }
    }
    maxOn = Math.max(maxOn, on);
  }
  assert.ok(t.stats.landings >= 6 && t.stats.departures >= 6,
    `20 minutes saw ${t.stats.landings} landings and ${t.stats.departures} departures`);
  assert.equal(t.stats.goArounds, 0, `${t.stats.goArounds} go-arounds with nobody in the way`);
  assert.ok(maxOn <= 1, `${maxOn} aircraft moving on the runway at once`);
  assert.equal(under, 0, 'a movement passed below the terrain');
  assert.equal(wrongWay, 0, 'traffic used the downwind runway');
  assert.equal(offRunway, 0, 'a landing or take-off roll left the eastern runway');
  for (const s of tdAt) assert.ok(s > 250 && s < 900, `touched down ${s.toFixed(0)} m past the threshold`);
  console.log(`  ✓ home international, 20 min: ${t.stats.landings} landings (touchdown ${Math.min(...tdAt).toFixed(0)}–${Math.max(...tdAt).toFixed(0)} m in), ${t.stats.departures} departures, one on the runway at a time`);
}

// the player sitting on that runway: arrivals go around, departures hold
{
  const home = AIRPORTS[0];
  const t = new Traffic(new THREE.Scene(), gen);
  const px = home.x + home.rwySep / 2;
  for (let s = 0; s < 600; s += dt) t.update(dt, px, home.z, s, true, 0);
  assert.equal(t.stats.landings, 0, 'an NPC landed through the player');
  assert.equal(t.stats.departures, 0, 'an NPC took off through the player');
  assert.ok(t.stats.goArounds >= 2, `only ${t.stats.goArounds} go-arounds in 10 minutes`);
  console.log(`  ✓ player on the runway: ${t.stats.goArounds} go-arounds, nobody lands or departs`);
}

// ships keep to deep water
{
  const t = new Traffic(new THREE.Scene(), gen);
  let seen = 0, shallow = 0, n = 0;
  for (let s = 0; s < 900; s += dt) {
    t.update(dt, 9000, 4000, s, true);
    if (++n % 60 === 0) {
      for (const sh of t.ships) {
        seen++;
        if (gen.heightAt(sh.group.position.x, sh.group.position.z) > -2.5) shallow++;
      }
    }
  }
  assert.ok(t.ships.length >= 3, `only ${t.ships.length} ships found water`);
  assert.equal(shallow, 0, `ships ran into the shallows ${shallow} times of ${seen}`);
  console.log(`  ✓ ${t.ships.length} ships afloat for 15 minutes, never in the shallows`);
}

// ---- NPCs are solid ----
// Everything drawn can be hit where it is drawn: flying aircraft (fuselage,
// wing and tail separately — under a wing is a miss), runway movements,
// parked aircraft and apron vehicles, ships.
{
  const t = new Traffic(new THREE.Scene(), gen);
  for (let s = 0; s < 30; s += dt) t.update(dt, 0, 0, s, true);
  assert.equal(t.hit(0, 5000, 0, 3), null, 'hit something in empty sky');
  let n = 0;
  for (const f of t.flying) {
    const p = f.group.position;
    const big = f.kind === 'airliner';
    // model frame → world: forward (−Z) is the heading, +X is to its right
    const at = (right, up, back) => [
      p.x + Math.cos(f.hdg) * right - Math.sin(f.hdg) * back, p.y + up,
      p.z + Math.sin(f.hdg) * right + Math.cos(f.hdg) * back,
    ];
    const cy = big ? 3.2 : 1.35;
    assert.equal(t.hit(...at(0, cy, 0), 2.5), 'MID-AIR COLLISION', `${f.kind}: flew through its fuselage`);
    assert.equal(t.hit(...at(big ? 12 : 4, big ? 2.1 : 2.2, big ? 3 : -0.6), 1), 'MID-AIR COLLISION', `${f.kind}: flew through its wing`);
    assert.equal(t.hit(...at(0, big ? 8.5 : 2.6, big ? 16.5 : 3.5), 0.5), 'MID-AIR COLLISION', `${f.kind}: flew through its fin`);
    // misses: well above, under the outer wing, just off a wingtip, past the nose
    assert.equal(t.hit(...at(0, 60, 0), 3), null, `${f.kind}: hit 60 m above it`);
    assert.equal(t.hit(...at(big ? 12 : 4, -1.5, big ? 3 : -0.6), 1), null, `${f.kind}: hit passing under its wing`);
    assert.equal(t.hit(...at(big ? 22 : 9, cy, 0), 2.5), null, `${f.kind}: hit off its wingtip`);
    assert.equal(t.hit(...at(0, cy, big ? -30 : -12), 2.5), null, `${f.kind}: hit ahead of its nose`);
    // swept: crossing its fuselage at 300 m/s in one quarter-second step —
    // the sphere is 40 m past it now and was 35 m short of it a step ago
    const [qx, qy, qz] = at(40, cy, 0);
    const vx = Math.cos(f.hdg) * 300 + Math.sin(f.hdg) * f.spd;
    const vz = Math.sin(f.hdg) * 300 - Math.cos(f.hdg) * f.spd;
    assert.equal(t.hit(qx, qy, qz, 2.5), null);
    assert.equal(t.hit(qx, qy, qz, 2.5, vx, 0, vz, 0.25), 'MID-AIR COLLISION', `${f.kind}: a fast pass tunnelled through`);
    // …and flying alongside in formation at the same velocity is not a hit
    assert.equal(t.hit(qx, qy, qz, 2.5, Math.sin(f.hdg) * f.spd, 0, -Math.cos(f.hdg) * f.spd, 0.25), null, `${f.kind}: formation flying counted as a hit`);
    n++;
  }
  // parked aircraft and vehicles at the home international, where they are drawn
  const rec = homeRec(t);
  rec.group.updateMatrixWorld(true);
  const reasons = new Map();
  const w = new THREE.Vector3();
  for (const sol of rec.solids) {
    sol.m.getWorldPosition(w);
    const up = sol.shape[0][1];
    const r = t.hit(w.x, w.y + up, w.z, 1);
    assert.equal(r, sol.reason, `nothing solid where a ${sol.reason} is drawn (${w.x.toFixed(0)}, ${w.z.toFixed(0)})`);
    assert.equal(t.hit(w.x, w.y + 45, w.z, 3), null, 'hit 45 m above the apron');
    reasons.set(r, (reasons.get(r) ?? 0) + 1);
  }
  assert.ok(reasons.get('HIT A PARKED AIRCRAFT') >= 12 && reasons.get('HIT A GROUND VEHICLE') >= 4, `home apron solids: ${[...reasons].join(' ')}`);
  // the runway movements
  let ops = 0;
  for (const f of rec.ops.flights) {
    const p = f.group.position;
    assert.ok(t.hit(p.x, p.y + 3.2, p.z, 2.5) !== null, `a ${f.phase} movement is not solid`);
    ops++;
  }
  // the player's own runway (the western one) is clear end to end
  const home = AIRPORTS[0];
  for (let a = -home.length / 2; a <= home.length / 2; a += 25) {
    assert.equal(t.hit(home.x - home.rwySep / 2, home.elev + 1.5, home.z + a, 8), null, `something solid on the spawn runway at ${a} m`);
  }
  console.log(`  ✓ solid: ${n} flying NPCs (fuselage / wing / fin hit, under-wing and wingtip passes miss, 300 m/s pass caught), ${reasons.get('HIT A PARKED AIRCRAFT')} parked aircraft, ${reasons.get('HIT A GROUND VEHICLE')} vehicles, ${ops} runway movements; spawn runway clear`);
}

// ships are solid too
{
  const t = new Traffic(new THREE.Scene(), gen);
  for (let s = 0; s < 300; s += dt) t.update(dt, 9000, 4000, s, true);
  assert.ok(t.ships.length >= 3);
  for (const sh of t.ships) {
    const p = sh.group.position;
    assert.equal(t.hit(p.x, p.y + 2, p.z, 2), 'FLEW INTO A SHIP', `flew through a ${sh.kind}`);
    assert.equal(t.hit(p.x, p.y + 90, p.z, 3), null, `hit 90 m above a ${sh.kind}`);
    assert.equal(t.hit(p.x + 400, p.y + 2, p.z, 3), null);
  }
  console.log(`  ✓ solid: ${t.ships.length} ships`);
}

// A player parked on a runway NPCs use is never run into: arrivals go
// around, departures do not taxi on — at the home international's eastern
// runway and at regional fields, at both ends and mid-runway.
{
  const fields = [AIRPORTS[0], ...gen.airfieldsNear(0, 0, 70000, []).filter((f) => f.major && !f.intl).slice(0, 3)];
  let checked = 0, goArounds = 0;
  const seen = new Set();
  for (const def of fields) {
    const ac = def.intl ? def.rwySep / 2 : 0;
    for (const frac of [-0.48, 0, 0.48]) {
      const px = def.x + ac * def.cosH + def.sinH * def.length * frac;
      const pz = def.z + ac * def.sinH - def.cosH * def.length * frac;
      const t = new Traffic(new THREE.Scene(), gen);
      for (let s = 0; s < 480; s += dt) {
        t.update(dt, px, pz, s, true, 0, def.elev + 1.5);
        const r = t.hit(px, def.elev + 1.5, pz, 8, 0, 0, 0, dt);
        assert.equal(r, null, `${def.name}: ${r} while parked ${Math.round(frac * 100)}% along the runway, t=${s.toFixed(0)} s`);
        // (t.stats counts every field in range — look at THIS field's movements)
        const o = [...t.parked.values()].find((rec) => rec.def === def)?.ops;
        for (const f of o?.flights ?? []) {
          assert.ok(f.phase === 'final' || f.phase === 'climb', `${def.name}: an NPC is in '${f.phase}' on the runway the player is parked on`);
          if (f.wentAround && !seen.has(f)) { seen.add(f); goArounds++; }
        }
      }
      checked++;
    }
  }
  console.log(`  ✓ parked on an NPC runway at ${fields.length} fields × 3 spots, 8 min each: never hit (${goArounds} go-arounds)`);
}

// Airborne near an NPC on final: it breaks off and climbs away instead of
// sharing the glide path
{
  const home = AIRPORTS[0];
  const t = new Traffic(new THREE.Scene(), gen);
  t.update(dt, 0, 0, 0, true);
  for (let s = dt; s < 5; s += dt) t.update(dt, 0, 0, s, true);
  const f = homeRec(t).ops.flights.find((x) => x.phase === 'final');
  assert.ok(f, 'nobody on final at the home international');
  const p = f.group.position;
  // the player joins 900 m behind it, on the same path
  const px = p.x - Math.sin(f.app.course) * 900, pz = p.z + Math.cos(f.app.course) * 900;
  let minSep = Infinity;
  for (let s = 5; s < 65; s += dt) {
    // the player flies down the approach 25 m/s faster than the NPC was going
    const d = (s - 5) * (f.kind === 'airliner' ? 97 : 59);
    const x = px + Math.sin(f.app.course) * d, z = pz - Math.cos(f.app.course) * d;
    const y = Math.max(p.y - (s - 5) * 4.5, home.elev + 30);
    t.update(dt, x, z, s, true, 500, y);
    minSep = Math.min(minSep, Math.hypot(f.group.position.x - x, f.group.position.y - y, f.group.position.z - z));
    assert.equal(t.hit(x, y, z, 8, 0, 0, 0, dt), null, `collided with the NPC ahead at t=${s.toFixed(1)}`);
  }
  assert.ok(f.wentAround, 'the NPC ahead held its approach with the player closing from behind');
  console.log(`  ✓ overtaking an NPC on final: it goes around (closest ${minSep.toFixed(0)} m)`);
}

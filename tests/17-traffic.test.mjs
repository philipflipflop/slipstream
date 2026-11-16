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

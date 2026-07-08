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

// Procedural airfields: deterministic, sensibly spaced, flat, paved, on land.
import assert from 'node:assert/strict';
import { WorldGen, AIRPORTS } from '../.test-build/world/heightfield.js';

const gen = new WorldGen();

// scan a 200×200 km area for generated strips
const found = gen.airfieldsNear(0, 0, 100000).filter((f) => !AIRPORTS.includes(f));
assert.ok(found.length >= 8, `only ${found.length} procedural strips in 200 km — too sparse`);
assert.ok(found.length <= 160, `${found.length} strips — too dense`);
console.log(`  ✓ ${found.length} procedural strips within 100 km of home`);

// determinism: a fresh generator yields the identical set
const gen2 = new WorldGen();
const found2 = gen2.airfieldsNear(0, 0, 100000).filter((f) => !AIRPORTS.includes(f));
assert.equal(found2.length, found.length);
for (let i = 0; i < found.length; i++) {
  assert.equal(found2[i].x, found[i].x);
  assert.equal(found2[i].z, found[i].z);
  assert.equal(found2[i].name, found[i].name);
}
console.log('  ✓ generation is fully deterministic');

// every strip: flat at its elevation, paved, dry, clear of the home cluster
for (const f of found) {
  const h = gen.heightAt(f.x, f.z);
  assert.ok(Math.abs(h - f.elev) < 0.5, `${f.name}: terrain ${h.toFixed(1)} vs ${f.elev.toFixed(1)}`);
  // threshold lies along the runway's own heading now
  const d = f.length / 2 - 40;
  const hEnd = gen.heightAt(f.x + f.sinH * d, f.z - f.cosH * d);
  assert.ok(Math.abs(hEnd - f.elev) < 0.5, `${f.name}: threshold not flat`);
  assert.ok(f.elev > 3, `${f.name}: too close to the water`);
  assert.ok(gen.isOnRunway(f.x, f.z), `${f.name}: centre not paved`);
  // paving follows the heading: a point down the centreline is paved, a
  // point the same distance perpendicular is not
  const a = d * 0.8;
  assert.ok(gen.isOnRunway(f.x + f.sinH * a, f.z - f.cosH * a), `${f.name}: centreline not paved`);
  assert.ok(!gen.isOnRunway(f.x + f.cosH * a, f.z + f.sinH * a), `${f.name}: paved sideways?!`);
  for (const ap of AIRPORTS) {
    assert.ok(Math.hypot(f.x - ap.x, f.z - ap.z) > 8500, `${f.name} crowds ${ap.name}`);
  }
}
console.log('  ✓ all strips flat, paved along their own headings, on land');

// runway directions vary across the world
const headings = new Set(found.map((f) => Math.round(f.heading * 100)));
assert.ok(headings.size >= 3, `only ${headings.size} distinct runway headings in 200 km`);
console.log(`  ✓ ${headings.size} distinct runway headings among ${found.length} strips`);

// minimum spacing between any two strips
let minD = Infinity;
for (let i = 0; i < found.length; i++) {
  for (let j = i + 1; j < found.length; j++) {
    minD = Math.min(minD, Math.hypot(found[i].x - found[j].x, found[i].z - found[j].z));
  }
}
assert.ok(minD > 5000, `two strips only ${(minD / 1000).toFixed(1)} km apart`);
console.log(`  ✓ closest pair ${(minD / 1000).toFixed(1)} km apart`);

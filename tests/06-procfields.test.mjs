// Procedural airfields: deterministic, sensibly spaced, flat, paved, on land.
import assert from 'node:assert/strict';
import { WorldGen, AIRPORTS } from '../.test-build/world/heightfield.js';

const gen = new WorldGen();

// scan a 200×200 km area for generated strips — a realistic GA density now
// that three internationals anchor the map (was ~17 before the thin-out)
const found = gen.airfieldsNear(0, 0, 100000).filter((f) => !AIRPORTS.includes(f));
assert.ok(found.length >= 6, `only ${found.length} procedural strips in 200 km — too sparse`);
assert.ok(found.length <= 60, `${found.length} strips — too dense`);
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
    const minD = ap.intl ? 13500 : 8500;
    assert.ok(Math.hypot(f.x - ap.x, f.z - ap.z) > minD, `${f.name} crowds ${ap.name}`);
  }
}
console.log('  ✓ all strips flat, paved along their own headings, on land');

// the three internationals: twin paved parallels, realistic spacing
{
  const intl = AIRPORTS.filter((a) => a.intl);
  assert.equal(intl.length, 3, `expected 3 internationals, found ${intl.length}`);
  for (const ap of intl) {
    assert.ok(ap.rwySep >= 1000, `${ap.name}: parallels too close (${ap.rwySep} m)`);
    assert.ok(ap.length >= 3500, `${ap.name}: main runway too short for heavies`);
    // both centrelines paved, terminal apron between them NOT runway
    assert.ok(gen.isOnRunway(ap.x - ap.rwySep / 2, ap.z), `${ap.name}: main runway unpaved`);
    assert.ok(gen.isOnRunway(ap.x + ap.rwySep / 2, ap.z), `${ap.name}: second runway unpaved`);
    assert.ok(!gen.isOnRunway(ap.x, ap.z), `${ap.name}: apron reads as runway`);
    // full length flat on both parallels
    for (const off of [-ap.rwySep / 2, ap.rwySep / 2]) {
      const len = off < 0 ? ap.length : (ap.rwy2Len ?? ap.length);
      for (const za of [-len / 2 + 30, 0, len / 2 - 30]) {
        const h = gen.heightAt(ap.x + off, ap.z + za);
        assert.ok(Math.abs(h - ap.elev) < 0.5, `${ap.name}: runway not flat at ${za} (${h.toFixed(1)})`);
      }
    }
  }
  for (let i = 0; i < intl.length; i++) {
    for (let j = i + 1; j < intl.length; j++) {
      const d = Math.hypot(intl[i].x - intl[j].x, intl[i].z - intl[j].z);
      assert.ok(d > 35000 && d < 130000,
        `${intl[i].name} ↔ ${intl[j].name} spacing unrealistic (${(d / 1000).toFixed(0)} km)`);
    }
  }
  console.log(`  ✓ 3 internationals: twin flat parallels, ${
    Math.round(Math.hypot(intl[0].x - intl[1].x, intl[0].z - intl[1].z) / 1000)} km / ${
    Math.round(Math.hypot(intl[0].x - intl[2].x, intl[0].z - intl[2].z) / 1000)} km from home`);
}

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

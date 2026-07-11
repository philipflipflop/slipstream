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
      // European-scale spacing between MAJOR internationals: ~100-250 km
      assert.ok(d > 80000 && d < 260000,
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

// procedural INTERNATIONALS keep appearing far afield: scan a wide ring of
// distant supercells and demand real hubs with full twin-runway service
{
  const hubs = [];
  for (let icx = -8; icx <= 8; icx++) {
    for (let icz = -8; icz <= 8; icz++) {
      const f = gen.intlForCell(icx, icz);
      if (f) hubs.push(f);
    }
  }
  assert.ok(hubs.length >= 8,
    `only ${hubs.length} procedural internationals in a 1900×1900 km scan — the map goes hub-less far afield`);
  for (const f of hubs) {
    assert.ok(f.intl && f.rwySep >= 1000 && f.length >= 3500, `${f.name}: not a real international`);
    // twin parallels flat and paved at the hub's own heading
    for (const off of [-f.rwySep / 2, f.rwySep / 2]) {
      const len = off < 0 ? f.length : (f.rwy2Len ?? f.length);
      for (const al of [-len / 2 + 40, 0, len / 2 - 40]) {
        const px = f.x + off * f.cosH + al * f.sinH;
        const pz = f.z + off * f.sinH - al * f.cosH;
        const h = gen.heightAt(px, pz);
        assert.ok(Math.abs(h - f.elev) < 0.5, `${f.name}: parallel not flat (${h.toFixed(1)} vs ${f.elev.toFixed(1)})`);
        assert.ok(gen.isOnRunway(px, pz), `${f.name}: parallel unpaved at ${al}`);
      }
    }
    assert.ok(f.elev > 3, `${f.name}: in the sea`);
    // never crowds the hand-placed trio
    for (const ap of AIRPORTS) {
      if (ap.intl) assert.ok(Math.hypot(f.x - ap.x, f.z - ap.z) > 54000, `${f.name} crowds ${ap.name}`);
    }
  }
  // determinism across generators
  const g2 = new WorldGen();
  for (const f of hubs) {
    const f2 = g2.intlForCell(Math.floor(f.x / 120000), Math.floor(f.z / 120000));
    assert.ok(f2 && f2.x === f.x && f2.z === f.z && f2.name === f.name, 'hub generation not deterministic');
  }
  // strips honour the hub berth
  for (const f of hubs) {
    const nearby = gen.airfieldsNear(f.x, f.z, 13900).filter((s) => !s.intl);
    assert.equal(nearby.length, 0, `${f.name}: strip inside the 14 km hub berth`);
  }
  console.log(`  ✓ ${hubs.length} procedural internationals across the wide map, flat parallels, deterministic`);
}

// hubsNear: the chart's long-range hub search — sorted nearest-first,
// includes the fixed trio, and always finds SOMETHING within 650 km from
// anywhere reasonable (that's what feeds the rim signposts)
{
  const near = gen.hubsNear(0, 0, 650000);
  assert.ok(near.length >= 4, `only ${near.length} hubs within 650 km of home`);
  assert.equal(near[0].name, 'MERIDIAN INTL', 'nearest hub to spawn should be home');
  for (let i = 1; i < near.length; i++) {
    const a = Math.hypot(near[i - 1].x, near[i - 1].z);
    const b = Math.hypot(near[i].x, near[i].z);
    assert.ok(a <= b + 1, 'hubsNear not sorted nearest-first');
  }
  for (const p of [[300000, -250000], [-400000, 350000], [150000, 500000]]) {
    const h = gen.hubsNear(p[0], p[1], 650000);
    assert.ok(h.length >= 1, `no hub within 650 km of (${p[0] / 1000}, ${p[1] / 1000}) km`);
    assert.ok(h.every((f) => f.intl), 'hubsNear returned a non-international');
  }
  console.log(`  ✓ hubsNear: ${near.length} hubs within 650 km of home, sorted, hubs found everywhere`);
}

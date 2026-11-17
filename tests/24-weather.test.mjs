// Weather: the presets are flyable briefings, the cloud layer is a real
// layer (what you see depends on which side of it you are), and the
// coverage field the renderer draws is the one the sim samples.
import assert from 'node:assert/strict';
import {
  WEATHERS, weatherById, layerDensity, beneath, weatherVisibility,
  makeCoverField, sampleField, coverAt, FIELD_N, FIELD_TILE,
  makeCloudFields, deckSurfaces, deckDensity, deckLight,
} from '../.test-build/world/weather.js';

// ---- presets ----
{
  assert.equal(weatherById('nonsense').id, 'fair', 'unknown weather should fall back to fair');
  assert.equal(weatherById('fair').deck, null);
  for (const w of WEATHERS) {
    assert.ok(w.wind[0] <= w.wind[1] && w.wind[1] <= 30, `${w.id}: wind range`);
    assert.ok(w.turb >= 0 && w.turb <= 1 && w.light > 0.2 && w.light <= 1 && w.grey >= 0 && w.grey <= 1, `${w.id}: ranges`);
    if (w.deck) {
      assert.ok(w.deck.top - w.deck.base >= 300, `${w.id}: a ${w.deck.top - w.deck.base} m layer is a sheet, not a layer`);
      assert.ok(w.cloudVis <= 800, `${w.id}: you can see ${w.cloudVis} m inside cloud`);
    }
  }
  console.log(`  ✓ ${WEATHERS.length} presets: ${WEATHERS.map((w) => w.id).join(', ')}`);
}

// ---- the layer: beneath / inside / above ----
for (const w of WEATHERS.filter((x) => x.deck)) {
  const { base, top } = w.deck;
  const mid = (base + top) / 2;
  assert.equal(layerDensity(w.deck, base - 200), 0, `${w.id}: cloud 200 m below the base`);
  assert.equal(layerDensity(w.deck, top + 200), 0, `${w.id}: cloud 200 m above the top`);
  assert.ok(layerDensity(w.deck, mid) > 0.99, `${w.id}: thin in the middle of the layer`);
  assert.equal(beneath(w.deck, base - 1), 1);
  assert.equal(beneath(w.deck, top + 1), 0);
  let prevD = 0, prevB = 1, rising = true;
  for (let y = base - 150; y <= top + 150; y += 5) {
    const d = layerDensity(w.deck, y);
    const b = beneath(w.deck, y);
    assert.ok(Math.abs(d - prevD) < 0.12, `${w.id}: density jumps at ${y} m`);
    assert.ok(b <= prevB + 1e-9, `${w.id}: 'beneath' is not monotone at ${y} m`);
    if (d < prevD - 1e-9) rising = false;
    else if (d > prevD + 1e-9) assert.ok(rising, `${w.id}: density has two humps`);
    prevD = d; prevB = b;
  }
  // what you can see, with a clear-air figure of 60 km
  const clear = 60000;
  const under = weatherVisibility(w, clear, base - 100, layerDensity(w.deck, base - 100));
  const inside = weatherVisibility(w, clear, mid, 1);
  const above = weatherVisibility(w, clear, top + 300, 0);
  assert.ok(Math.abs(under - Math.min(w.vis, clear)) < 1, `${w.id}: ${under.toFixed(0)} m beneath the deck, briefing says ${w.vis}`);
  assert.ok(Math.abs(inside - w.cloudVis) < 1, `${w.id}: ${inside.toFixed(0)} m in cloud`);
  assert.equal(above, clear, `${w.id}: the weather follows you above the tops`);
  // never better than the clear-air figure, and continuous on the way up
  let prev = weatherVisibility(w, clear, base - 300, 0);
  for (let y = base - 300; y <= top + 300; y += 2) {
    const v = weatherVisibility(w, clear, y, layerDensity(w.deck, y));
    assert.ok(v <= clear + 1e-6 && v >= w.cloudVis - 1e-6, `${w.id}: visibility ${v} at ${y} m`);
    assert.ok(Math.abs(Math.log(v / prev)) < 0.2, `${w.id}: visibility jumps ${prev.toFixed(0)} → ${v.toFixed(0)} at ${y} m`);
    prev = v;
  }
  console.log(`  ✓ ${w.id}: ${(under / 1000).toFixed(1)} km beneath ${Math.round(base * 3.281 / 100) * 100} ft, ${inside.toFixed(0)} m inside, clear above ${Math.round(top * 3.281 / 100) * 100} ft`);
}
{
  const fair = weatherById('fair');
  assert.equal(weatherVisibility(fair, 41234, 500, 0), 41234, 'fair weather changed the visibility');
}

// ---- coverage field ----
{
  const f = makeCoverField();
  assert.equal(f.length, FIELD_N * FIELD_N);
  assert.deepEqual(makeCoverField(), f, 'the field is not deterministic');
  // equalised: a threshold of (1 − cover) leaves `cover` of the sky cloudy
  for (const cover of [0.25, 0.55, 0.8]) {
    let n = 0;
    for (let i = 0; i < f.length; i++) if (f[i] > 1 - cover) n++;
    assert.ok(Math.abs(n / f.length - cover) < 0.012, `cover ${cover}: field gives ${(n / f.length).toFixed(3)}`);
  }
  // tileable and continuous: no seam where the texture repeats
  let maxStep = 0;
  for (let i = 0; i < 4000; i++) {
    const x = (i / 4000) * FIELD_TILE * 2.2 - 500;
    const z = 7310 + i * 3.1;
    assert.ok(Math.abs(sampleField(f, x, z) - sampleField(f, x + FIELD_TILE, z - FIELD_TILE * 3)) < 1e-9, 'field does not tile');
    maxStep = Math.max(maxStep, Math.abs(sampleField(f, x + 15, z) - sampleField(f, x, z)));
  }
  assert.ok(maxStep < 0.12, `field jumps ${maxStep.toFixed(2)} in 15 m`);
  // a broken layer has both cloud and gaps, a solid one has no gaps
  let cloud = 0, gap = 0;
  for (let i = 0; i < 5000; i++) {
    const c = coverAt(f, i * 137.5, i * 71.3, 0.55);
    if (c > 0.98) cloud++;
    if (c < 0.02) gap++;
    assert.equal(coverAt(f, i * 137.5, i * 71.3, 1), 1);
  }
  assert.ok(cloud > 1500 && gap > 1000, `broken layer: ${cloud} cloud / ${gap} gap samples of 5000`);
  console.log(`  ✓ coverage field: deterministic, tileable, equalised; broken layer is ${(cloud / 50).toFixed(0)}% solid cloud, ${(gap / 50).toFixed(0)}% clear gaps`);
}

// ---- the shape of the layer: a volume, not two sheets ----
{
  const f = makeCloudFields();
  assert.deepEqual(makeCloudFields(), f, 'the cloud fields are not deterministic');
  // no feature may sit on the noise lattice: the lump field's creases (its
  // lowest ranks) must not favour the 64 lattice lines of its coarsest octave
  {
    const N = FIELD_N, cell = N / 4;
    let onLine = 0, offLine = 0, nOn = 0, nOff = 0;
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const low = f.lump[y * N + x] < 0.15 ? 1 : 0;
      if (x % cell === 0 || y % cell === 0) { onLine += low; nOn++; } else { offLine += low; nOff++; }
    }
    const ratio = (onLine / nOn) / (offLine / nOff);
    assert.ok(ratio > 0.6 && ratio < 1.6, `creases are ${ratio.toFixed(2)}× as common on the lattice lines as off them`);
  }
  // no tile comes round again: the same point one tile on has a different top
  {
    const d = WEATHERS.find((w) => w.id === 'overcast').deck;
    let same = 0;
    for (let i = 0; i < 400; i++) {
      const x = i * 211.7, z = i * 87.3 - 9000;
      const a = deckSurfaces(d, f, x, z).yt;
      if (Math.abs(a - deckSurfaces(d, f, x + FIELD_TILE, z).yt) < 8 && Math.abs(a - deckSurfaces(d, f, x, z + FIELD_TILE).yt) < 8) same++;
    }
    assert.ok(same < 40, `${same} of 400 points have the same top one tile on — the layer repeats`);
  }
  assert.deepEqual(f.cover, makeCoverField(), 'the coverage the sim samples is not the field the layer is built on');
  for (const w of WEATHERS.filter((x) => x.deck)) {
    const d = w.deck;
    const solid = d.cover >= 0.99;
    const mid = (d.base + d.top) / 2;
    let lo = Infinity, hi = -Infinity, baseLo = Infinity, baseHi = -Infinity, cloudy = 0, n = 0, above = 0;
    let maxSlope = 0;
    for (let i = 0; i < 6000; i++) {
      const x = i * 173.3 - 40000, z = i * 97.1 + 12000;
      const s = { ...deckSurfaces(d, f, x, z) };
      n++;
      if (s.yt <= s.yb) {
        assert.ok(!solid, `${w.id}: a hole in a solid deck at ${x.toFixed(0)}, ${z.toFixed(0)}`);
        assert.equal(deckDensity(d, f, x, mid, z), 0);
        continue;
      }
      cloudy++;
      lo = Math.min(lo, s.yt); hi = Math.max(hi, s.yt);
      baseLo = Math.min(baseLo, s.yb); baseHi = Math.max(baseHi, s.yb);
      if (s.yt > d.top) above++;
      // the briefing's cloudbase is the LOWEST the cloud comes (ILS minima hold)
      assert.ok(s.yb >= d.base - 1e-6, `${w.id}: cloud at ${s.yb.toFixed(0)} m, below the ${d.base} m base`);
      assert.ok(s.yt <= d.top + d.towers + 1e-6, `${w.id}: top at ${s.yt.toFixed(0)} m, above the march slab`);
      assert.equal(deckDensity(d, f, x, s.yt + 1, z), 0, `${w.id}: cloud above its own top`);
      assert.equal(deckDensity(d, f, x, s.yb - 1, z), 0, `${w.id}: cloud below its own base`);
      if (solid) assert.ok(deckDensity(d, f, x, (s.yt + s.yb) / 2, z) > 0.99, `${w.id}: thin in the middle`);
      const s2 = deckSurfaces(d, f, x + 20, z);
      if (s2.yt > s2.yb) maxSlope = Math.max(maxSlope, Math.abs(s2.yt - s.yt) / 20);
    }
    // a top with relief — not a plane — and (where the preset has them) towers standing out of it
    assert.ok(hi - lo > d.relief * 0.6, `${w.id}: the top only varies ${(hi - lo).toFixed(0)} m`);
    if (d.towers > 0) assert.ok(above > 20 && above < n * 0.2, `${w.id}: ${above} of ${n} samples stand above the general top`);
    if (d.ragged > 0 && solid) assert.ok(baseHi - baseLo > d.ragged * 0.8 && baseLo < d.base + d.ragged * 0.1, `${w.id}: base ${baseLo.toFixed(0)}–${baseHi.toFixed(0)} m`);
    if (!solid) assert.ok(cloudy > n * 0.4 && cloudy < n * 0.75, `${w.id}: ${cloudy} of ${n} samples have cloud`);
    // density is continuous along any line through it (no sheet to punch through)
    let prev = 0, maxJump = 0, edge = 0;
    for (let y = d.base - 50; y <= d.top + d.towers + 50; y += 2) {
      const v = deckDensity(d, f, 3000, y, -7000);
      maxJump = Math.max(maxJump, Math.abs(v - prev));
      if (v > 0.02 && v < 0.98) edge++;
      prev = v;
    }
    assert.ok(maxJump < 0.12, `${w.id}: density jumps ${maxJump.toFixed(2)} in 2 m of climb`);
    const skim = d.top - d.relief * 0.45 - d.soft * 0.5;
    prev = deckDensity(d, f, 0, skim, 0);
    let flips = 0, sharp = 0;
    for (let x = 0; x < 60000; x += 10) {
      const v = deckDensity(d, f, x, skim, x * 0.37);
      // (a cumulus flank can be a cliff — but edges are soft as a rule)
      if (Math.abs(v - prev) > 0.3) sharp++;
      if ((v > 0.5) !== (prev > 0.5)) flips++;
      prev = v;
    }
    // (the flanks of the cumulus bodies in a broken layer ARE steep; a solid deck's top is not)
    assert.ok(sharp <= (solid ? 3 : 40), `${w.id}: ${sharp} hard edges (density jumping 0.3 in 10 m) in 60 km of level flight`);
    // skimming the tops you are in and out of them
    assert.ok(flips >= 4, `${w.id}: 60 km along the tops crossed cloud ${flips} times`);
    // sunlight: full at the top surface, gone deep inside
    const s = { ...deckSurfaces(d, f, 3000, -7000) };
    if (s.yt > s.yb) {
      assert.ok(deckLight(d, f, 3000, s.yt, -7000) > 0.99);
      assert.ok(deckLight(d, f, 3000, s.yt - 1500, -7000) < 0.01);
    }
    console.log(`  ✓ ${w.id}: top ${lo.toFixed(0)}–${hi.toFixed(0)} m (steepest ${maxSlope.toFixed(2)}), base ${baseLo.toFixed(0)}–${baseHi.toFixed(0)} m, ${flips} cloud edges in 60 km along the tops`);
  }
}

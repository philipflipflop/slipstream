// Weather: the presets are flyable briefings, the cloud layer is a real
// layer (what you see depends on which side of it you are), and the
// coverage field the renderer draws is the one the sim samples.
import assert from 'node:assert/strict';
import {
  WEATHERS, weatherById, layerDensity, beneath, weatherVisibility,
  makeCoverField, sampleField, coverAt, FIELD_N, FIELD_TILE,
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
    for (let i = 0; i < f.length; i++) if (f[i] / 255 > 1 - cover) n++;
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

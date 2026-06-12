// World themes: every map keeps the home field flyable, each theme has its
// signature terrain, the metro theme grows a deterministic city of towers.
import assert from 'node:assert/strict';
import { WorldGen, AIRPORTS } from '../.test-build/world/heightfield.js';
import { buildChunkPayload } from '../.test-build/world/terrainBuilder.js';

const themes = ['archipelago', 'mesa', 'metro'];

// --- home field flat, paved and dry in every theme ---
for (const theme of themes) {
  const gen = new WorldGen(undefined, theme);
  const home = AIRPORTS[0];
  const h = gen.heightAt(home.x, home.z);
  assert.ok(Math.abs(h - home.elev) < 0.5, `${theme}: home field not flat (${h.toFixed(1)})`);
  const hThr = gen.heightAt(home.x, home.z + home.length / 2 - 60);
  assert.ok(Math.abs(hThr - home.elev) < 0.5, `${theme}: threshold not flat`);
  assert.ok(gen.isOnRunway(home.x, home.z), `${theme}: home centre not paved`);
  console.log(`  ✓ ${theme}: home field flat at ${h.toFixed(1)} m, paved`);
}

// --- mesa: dramatic stepped relief, mostly dry land ---
{
  const gen = new WorldGen(undefined, 'mesa');
  let hi = -Infinity;
  let lo = Infinity;
  let landN = 0;
  let n = 0;
  for (let z = -30000; z <= 30000; z += 1500) {
    for (let x = -30000; x <= 30000; x += 1500) {
      const h = gen.baseHeightAt(x, z);
      hi = Math.max(hi, h);
      lo = Math.min(lo, h);
      if (h > 0) landN++;
      n++;
    }
  }
  assert.ok(hi - lo > 250, `mesa relief only ${(hi - lo).toFixed(0)} m`);
  assert.ok(landN / n > 0.75, `mesa is only ${Math.round((landN / n) * 100)}% land`);
  console.log(`  ✓ mesa: ${(hi - lo).toFixed(0)} m of relief, ${Math.round((landN / n) * 100)}% land`);
}

// --- metro: city districts are flat, masked, and full of towers ---
{
  const gen = new WorldGen(undefined, 'metro');
  assert.ok(gen.cityMaskAt(-5200, -2600) > 0.9, 'downtown core not city');
  assert.equal(gen.cityMaskAt(40000, 40000), 0, 'wilderness reads as city');
  assert.ok(gen.downtownAt(-5200, -2600) > 0.6, 'downtown not tall');
  // city ground is graded nearly flat
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < 40; i++) {
    const h = gen.heightAt(-5200 + (i % 7) * 230, -2600 + Math.floor(i / 7) * 230);
    min = Math.min(min, h);
    max = Math.max(max, h);
  }
  assert.ok(max - min < 9, `downtown ground varies ${(max - min).toFixed(1)} m`);
  console.log(`  ✓ metro: downtown masked + graded (Δ${(max - min).toFixed(1)} m)`);

  // towers spawn deterministically on downtown chunks
  const cx = Math.floor(-5200 / 900);
  const cz = Math.floor(-2600 / 900);
  const p1 = buildChunkPayload(gen, cx, cz, 28, 2, 0, 450);
  const p2 = buildChunkPayload(new WorldGen(undefined, 'metro'), cx, cz, 28, 2, 0, 450);
  const towers = p1.towerMats.length / 16;
  assert.ok(towers >= 12, `only ${towers} towers on a downtown chunk`);
  assert.deepEqual(Array.from(p1.towerMats), Array.from(p2.towerMats));
  // some are proper skyscrapers (instance matrix [5] = y scale = height)
  let tallest = 0;
  for (let i = 0; i < towers; i++) tallest = Math.max(tallest, p1.towerMats[i * 16 + 5]);
  assert.ok(tallest > 80, `tallest downtown tower only ${tallest.toFixed(0)} m`);
  console.log(`  ✓ metro: ${towers} towers on the downtown chunk, tallest ${tallest.toFixed(0)} m`);

  // far-ring chunks keep the skyline (tall towers survive scatter level 0)
  const far = buildChunkPayload(gen, cx, cz, 14, 0, 0, 450);
  assert.ok(far.towerMats.length > 0, 'skyline missing at far LOD');
  console.log(`  ✓ metro: ${far.towerMats.length / 16} skyline towers at far LOD`);

  // other themes have no towers
  const arch = buildChunkPayload(new WorldGen(), cx, cz, 28, 2, 0, 450);
  assert.equal(arch.towerMats.length, 0);
  console.log('  ✓ archipelago: no towers');
}

// --- themes are distinct worlds from the same seed ---
{
  const a = new WorldGen(undefined, 'archipelago');
  const m = new WorldGen(undefined, 'mesa');
  let diff = 0;
  for (let i = 0; i < 30; i++) {
    const x = 12000 + i * 977;
    const z = -22000 + i * 1311;
    if (Math.abs(a.baseHeightAt(x, z) - m.baseHeightAt(x, z)) > 2) diff++;
  }
  assert.ok(diff > 24, 'mesa terrain barely differs from archipelago');
  console.log('  ✓ themes generate genuinely different terrain');
}

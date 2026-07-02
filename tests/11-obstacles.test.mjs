// Obstacle collision: hit volumes derive from the exact scatter lists the
// renderer draws, so towers/trees/hoodoos are hittable where they're visible.
import assert from 'node:assert/strict';
import { WorldGen } from '../.test-build/world/heightfield.js';
import { buildScatter } from '../.test-build/world/terrainBuilder.js';
import { ObstacleField } from '../.test-build/world/obstacles.js';

// --- a downtown tower is solid exactly where it renders ---
{
  const gen = new WorldGen(undefined, 'metro');
  const field = new ObstacleField(gen);
  const cx = Math.floor(-5200 / 900);
  const cz = Math.floor(-2600 / 900);
  const sc = buildScatter(gen, cx, cz, 2);
  const mats = sc.towerMats.length >= 16 ? sc.towerMats : sc.glassMats;
  assert.ok(mats.length >= 16, 'no towers on the downtown chunk');
  // first instance: translation at [12..14], height (y scale) at [5]
  const [x, y, z, ht] = [mats[12], mats[13], mats[14], mats[5]];
  assert.equal(field.hit(x, y + ht * 0.5, z, 2), 'FLEW INTO A BUILDING');
  assert.equal(field.hit(x, y + ht + 40, z, 2), null, 'hit above the roofline');
  assert.equal(field.hit(x + 300, y + 5, z + 300, 2) === null ||
    typeof field.hit(x + 300, y + 5, z + 300, 2) === 'string', true);
  console.log(`  ✓ metro tower at (${x.toFixed(0)}, ${z.toFixed(0)}) ht ${ht.toFixed(0)} m is solid; clear above it`);
}

// --- forest chunks grow solid trees; open water is clear ---
{
  const gen = new WorldGen(undefined, 'archipelago');
  const field = new ObstacleField(gen);
  let tree = null;
  outer:
  for (let cz = -8; cz <= 8; cz++) {
    for (let cx = -8; cx <= 8; cx++) {
      const sc = buildScatter(gen, cx, cz, 2);
      if (sc.treeMats.length >= 16) {
        tree = { x: sc.treeMats[12], y: sc.treeMats[13], z: sc.treeMats[14], sy: sc.treeMats[5] };
        break outer;
      }
    }
  }
  assert.ok(tree, 'no conifers found near the home field');
  assert.equal(field.hit(tree.x, tree.y + tree.sy * 5, tree.z, 2), 'FLEW INTO THE TREES');
  console.log(`  ✓ conifer at (${tree.x.toFixed(0)}, ${tree.z.toFixed(0)}) is solid`);

  // far offshore: nothing to hit at cruise altitude
  assert.equal(field.hit(200, 500, 200, 3), null);
  console.log('  ✓ open sky over the home field is clear');
}

// --- determinism: two fields agree everywhere ---
{
  const a = new ObstacleField(new WorldGen(undefined, 'metro'));
  const b = new ObstacleField(new WorldGen(undefined, 'metro'));
  let checked = 0;
  for (let i = 0; i < 400; i++) {
    const x = -6500 + (i % 20) * 130;
    const z = -3800 + Math.floor(i / 20) * 130;
    const y = 4 + (i % 7) * 40;
    const ra = a.hit(x, y, z, 2);
    const rb = b.hit(x, y, z, 2);
    assert.equal(ra, rb, `divergence at (${x}, ${y}, ${z})`);
    if (ra !== null) checked++;
  }
  assert.ok(checked > 5, `grid sweep found only ${checked} solid samples downtown`);
  console.log(`  ✓ deterministic: ${checked}/400 downtown samples solid in both fields`);
}

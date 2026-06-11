// Far horizon shell: deterministic, conservative (always below the real
// terrain so detailed chunks render above it), sane colors and normals.
import assert from 'node:assert/strict';
import { WorldGen } from '../.test-build/world/heightfield.js';
import { buildFarPayload } from '../.test-build/world/terrainBuilder.js';

const gen = new WorldGen();
const cells = 64;
const cellSize = 450;
const p = buildFarPayload(gen, 0, 0, cells, cellSize);

const n = cells + 1;
assert.equal(p.positions.length, n * n * 3);
assert.equal(p.colors.length, n * n * 3);
console.log(`  ✓ ${n}×${n} lattice (${((cells * cellSize) / 1000).toFixed(1)} km square)`);

// every shell vertex sits strictly below the true surface at its location
const half = (cells * cellSize) / 2;
let worstGap = Infinity;
for (let v = 0; v < n * n; v++) {
  const wx = p.positions[v * 3];
  const wy = p.positions[v * 3 + 1];
  const wz = p.positions[v * 3 + 2];
  assert.ok(Math.abs(wx) <= half + 1 && Math.abs(wz) <= half + 1, 'vertex outside shell');
  const h = gen.heightAt(wx, wz);
  assert.ok(wy <= h - 5.9, `shell pokes up: ${wy.toFixed(1)} vs terrain ${h.toFixed(1)} at ${wx},${wz}`);
  worstGap = Math.min(worstGap, h - wy);
}
console.log(`  ✓ shell is a lower envelope (min clearance ${worstGap.toFixed(1)} m)`);

// colors are valid and normals are unit-ish and upward-facing
for (let v = 0; v < n * n; v++) {
  for (let k = 0; k < 3; k++) {
    const c = p.colors[v * 3 + k];
    assert.ok(c >= 0 && c <= 1, `color component ${c} out of range`);
  }
  const ny = p.normals[v * 3 + 1];
  assert.ok(ny > 0.1, `normal points sideways/down (ny=${ny})`);
}
console.log('  ✓ colors in range, normals upward');

// determinism: a fresh generator produces the identical shell
const p2 = buildFarPayload(new WorldGen(), 0, 0, cells, cellSize);
assert.deepEqual(Array.from(p2.positions.slice(0, 300)), Array.from(p.positions.slice(0, 300)));
console.log('  ✓ deterministic across generators');

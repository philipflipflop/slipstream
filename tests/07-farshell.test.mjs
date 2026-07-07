// Far horizon shell: deterministic, conservative (always below the real
// terrain so detailed chunks render above it), sane colors and normals.
// Plus the geomorph contract: chunk morph-start surfaces reproduce the
// coarser LOD exactly and sit below the true terrain when rising from shell.
import assert from 'node:assert/strict';
import { WorldGen } from '../.test-build/world/heightfield.js';
import { buildFarPayload, buildChunkPayload } from '../.test-build/world/terrainBuilder.js';

const gen = new WorldGen();
const cells = 64;
const cellSize = 450;
const p = buildFarPayload(gen, 0, 0, cells, cellSize);

const n = cells + 1;
assert.equal(p.positions.length, n * n * 3);
assert.equal(p.colors.length, n * n * 3);
console.log(`  ✓ ${n}×${n} lattice (${((cells * cellSize) / 1000).toFixed(1)} km square)`);

// every shell vertex sits strictly below the true surface at its location
// (near the waterline the envelope is clamped to +1.3 so dry coasts and the
// metro city don't render drowned on the shell — clearance shrinks there)
const half = (cells * cellSize) / 2;
let worstGap = Infinity;
let clamped = 0;
for (let v = 0; v < n * n; v++) {
  const wx = p.positions[v * 3];
  const wy = p.positions[v * 3 + 1];
  const wz = p.positions[v * 3 + 2];
  assert.ok(Math.abs(wx) <= half + 1 && Math.abs(wz) <= half + 1, 'vertex outside shell');
  const h = gen.heightAt(wx, wz);
  const isClamped = Math.abs(wy - 1.3) < 1e-6 && wy < h - 1.2;
  if (isClamped) clamped++;
  assert.ok(wy <= h - 5.9 || isClamped,
    `shell pokes up: ${wy.toFixed(1)} vs terrain ${h.toFixed(1)} at ${wx},${wz}`);
  worstGap = Math.min(worstGap, h - wy);
}
console.log(`  ✓ shell is a lower envelope (min clearance ${worstGap.toFixed(1)} m, ${clamped} waterline-clamped)`);

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

// ---- geomorph starts ----

// LOD upgrade: at vertices shared with the parent grid the morph start
// equals the true height — the swap from the coarse chunk is seamless
const up = buildChunkPayload(gen, 3, 2, 28, 0, 14, cellSize);
{
  // colour-morph starts: one per vertex, valid colour range
  assert.equal(up.baseCols.length, up.colors.length, 'baseCols length mismatch');
  let ok = true;
  for (let i = 0; i < up.baseCols.length; i++) {
    const c = up.baseCols[i];
    if (!(c >= 0 && c <= 1)) { ok = false; break; }
  }
  assert.ok(ok, 'baseCols out of colour range');
  // normal-morph starts: unit length, upward-facing
  assert.equal(up.baseNrms.length, up.normals.length, 'baseNrms length mismatch');
  for (let v = 0; v < up.baseNrms.length / 3; v++) {
    const len = Math.hypot(up.baseNrms[v * 3], up.baseNrms[v * 3 + 1], up.baseNrms[v * 3 + 2]);
    assert.ok(Math.abs(len - 1) < 1e-4, `baseNrm ${v} not unit (${len})`);
    assert.ok(up.baseNrms[v * 3 + 1] > 0.05, `baseNrm ${v} points sideways/down`);
  }
  console.log('  ✓ colour- and normal-morph starts present and sane');
}

// morph-start EXACTNESS: at a vertex that lands on the shell lattice, a
// fresh chunk's colour/normal starts must equal the shell's own vertex
// colour/normal (raw-height field, cellSize texel — buildFarPayload's rule).
// Starts that only approximate what was on screen leave an instant jump in
// the arrival frame: the residual "pop" that survived three morph passes.
{
  const freshEx = buildChunkPayload(gen, 3, 2, 14, 0, 0, cellSize);
  const gridN = 14 + 3;
  const step = 900 / 14;
  let checked = 0;
  for (let j = 0; j <= 14; j++) {
    for (let i = 0; i <= 14; i++) {
      const wx = 3 * 900 + i * step;
      const wz = 2 * 900 + j * step;
      if (wx % cellSize !== 0 || wz % cellSize !== 0) continue;
      const v = (j + 1) * gridN + (i + 1);
      const nx = gen.heightAt(wx - cellSize, wz) - gen.heightAt(wx + cellSize, wz);
      const nz = gen.heightAt(wx, wz - cellSize) - gen.heightAt(wx, wz + cellSize);
      const ny = 2 * cellSize;
      const il = 1 / Math.hypot(nx, ny, nz);
      const col = [0, 0, 0];
      gen.colorAt(wx, wz, gen.heightAt(wx, wz), 1 - ny * il, col, cellSize);
      for (let ch = 0; ch < 3; ch++) {
        assert.ok(Math.abs(freshEx.baseCols[v * 3 + ch] - col[ch]) < 1e-5,
          `baseCol ch${ch} at ${wx},${wz}: ${freshEx.baseCols[v * 3 + ch]} vs shell ${col[ch]}`);
      }
      assert.ok(Math.abs(freshEx.baseNrms[v * 3] - nx * il) < 1e-5 &&
        Math.abs(freshEx.baseNrms[v * 3 + 1] - ny * il) < 1e-5 &&
        Math.abs(freshEx.baseNrms[v * 3 + 2] - nz * il) < 1e-5,
        `baseNrm at ${wx},${wz} differs from shell normal`);
      checked++;
    }
  }
  assert.ok(checked >= 9, `only ${checked} lattice-coincident vertices checked`);
  console.log(`  ✓ fresh-chunk colour/normal starts equal the shell's exactly (${checked} lattice vertices)`);
}
{
  const gridN = 28 + 3;
  let shared = 0;
  for (let j = -1; j <= 29; j++) {
    for (let i = -1; i <= 29; i++) {
      const v = (j + 1) * gridN + (i + 1);
      const ci = Math.min(Math.max(i, 0), 28);
      const cj = Math.min(Math.max(j, 0), 28);
      if (ci % 2 === 0 && cj % 2 === 0) {
        assert.ok(
          Math.abs(up.baseY[v] - up.positions[v * 3 + 1]) < 1e-3,
          `shared vertex ${i},${j}: baseY ${up.baseY[v]} vs y ${up.positions[v * 3 + 1]}`,
        );
        shared++;
      }
    }
  }
  assert.ok(shared > 200, 'too few shared vertices checked');
  console.log(`  ✓ LOD-upgrade morph start matches parent surface at ${shared} shared vertices`);
}

// brand-new chunk: the morph start rises from the shell. At vertices that
// land on the shell lattice the lower-envelope guarantee is exact; between
// lattice points interpolation may ride above valleys, so just sanity-bound.
const fresh = buildChunkPayload(gen, 3, 2, 14, 0, 0, cellSize);
{
  const gridN = 14 + 3;
  let onLattice = 0;
  for (let j = 0; j <= 14; j++) {
    for (let i = 0; i <= 14; i++) {
      const v = (j + 1) * gridN + (i + 1); // interior (non-skirt) vertex
      const y = fresh.positions[v * 3 + 1];
      const wx = 3 * 900 + fresh.positions[v * 3];
      const wz = 2 * 900 + fresh.positions[v * 3 + 2];
      if (wx % cellSize === 0 && wz % cellSize === 0) {
        // dry land never morphs up through the water sheet: near the
        // waterline the start is clamped just above it (0.7 from the chunk
        // clamp, or shell clamp 1.3 + the 0.5 non-coplanar lift = 1.8)
        const nearWater = fresh.baseY[v] <= 1.81 && fresh.baseY[v] > 0;
        assert.ok(fresh.baseY[v] <= y - 5.4 || nearWater,
          `lattice vertex ${i},${j}: baseY ${fresh.baseY[v]} vs y ${y}`);
        onLattice++;
      }
      // loose sanity bound only — in steep terrain the envelope legitimately
      // undershoots peaks by hundreds of metres (the morph then raises them)
      assert.ok(Number.isFinite(fresh.baseY[v]) && Math.abs(fresh.baseY[v] - y) < 600,
        `vertex ${i},${j}: baseY wildly off (${fresh.baseY[v]} vs ${y})`);
    }
  }
  assert.ok(onLattice >= 9, `only ${onLattice} lattice-coincident vertices checked`);
  console.log(`  ✓ fresh-chunk morph start sits on the shell (${onLattice} lattice vertices exact)`);
}

// The horizon: far shell S (450/600 m cells) handing over to the horizon
// shell H (1800 m cells, out to 90–216 km). Before H existed the world ended
// ~35 km out — at 39,000 ft the "horizon" sat 17° below eye level and its
// rim popped into view. The contract (world/lod.ts "shells"):
//   1. preset geometry: lattices nest, bands have room, the haze always
//      closes inside H's rim, and it opens far enough to put the haze line
//      where the real horizon is
//   2. payloads: S's parent look IS H's rendered surface; every vertex is a
//      pure function of its world lattice point (no swim, exact reuse)
//   3. a simulated flight: re-centring S, punching H's hole and slewing the
//      blend edge never expose a void, never draw H under un-collapsed S,
//      and never let fog reach past what is built
import assert from 'node:assert/strict';
import { WorldGen } from '../.test-build/world/heightfield.js';
import { buildFarPayload } from '../.test-build/world/terrainBuilder.js';
import {
  CHUNK, LOD_PRESETS, SHELL_PRESETS, lodFrame,
  shellHole, shellEdge, shellBand, hSlack, slewShellEdge, horizonHole, visibility, GROUND_VIEW,
  S_RECENTRE_IDLE, S_RECENTRE, S_DRIFT, H_RECENTRE, H_DRIFT, H_HOLE_STEP, STREAM_LEAD, SHELL_LIFT,
} from '../.test-build/world/lod.js';

const lcm900 = (cell) => { let s = CHUNK; while (s % cell !== 0) s += CHUNK; return s; };

// ---- 1. preset geometry ----
for (const q of ['low', 'medium', 'high']) {
  const sp = SHELL_PRESETS[q];
  const rS = (sp.cells * sp.cell) / 2;
  const rH = (sp.hCells * sp.hCell) / 2;
  // lattices nest: every H lattice point is an S lattice point, and both
  // re-centre on grids their cells divide (vertices never move in the world)
  assert.equal(sp.hCell % sp.cell, 0, `${q}: H cell is not a multiple of the S cell`);
  assert.equal(lcm900(sp.cell) % sp.cell, 0);
  assert.ok(lcm900(sp.cell) <= S_RECENTRE_IDLE, `${q}: S snap grid coarser than its re-centre trigger`);
  assert.ok(lcm900(sp.hCell) <= 1800, `${q}: H snap grid ${lcm900(sp.hCell)} m would lurch`);
  assert.ok((sp.hCells + 1) ** 2 <= 65535 && (sp.cells + 1) ** 2 <= 65535, `${q}: needs 32-bit indices`);

  // nominal hand-over: S collapses onto H beyond `edge`, inside its own rim
  const cover = shellHole(rS, 0);
  const edge = shellEdge(cover, sp.hCell);
  const band = shellBand(edge);
  assert.ok(cover <= rS - S_DRIFT - 99, `${q}: H hole outruns S coverage at full drift`);
  assert.ok(band[1] - band[0] >= 5000, `${q}: S→H blend band only ${(band[1] - band[0]).toFixed(0)} m`);
  // ... and well outside the chunk disc at every altitude (level-0 chunks
  // collapse onto S's OWN look, so S must be fully itself there)
  for (let agl = 0; agl <= 14000; agl += 250) {
    const f = lodFrame(LOD_PRESETS[q], agl);
    assert.ok(band[0] > f.load + 1500,
      `${q} @${agl} m: S blend band (${band[0].toFixed(0)}) reaches into the chunk disc (${f.load.toFixed(0)})`);
  }

  // the only un-morphed edge left in the world is H's rim: full haze must
  // close inside it even at worst-case drift, behind the aircraft
  assert.ok(sp.fogCap <= rH - H_DRIFT - STREAM_LEAD - 500,
    `${q}: fog cap ${sp.fogCap} can see H's rim (radius ${rH})`);
  assert.ok(H_DRIFT > H_RECENTRE + 1000 && S_DRIFT > S_RECENTRE + 600, 'drift allowances lost their latency slack');

  // no deadlock on the way up: H is only drawn once the haze reaches it,
  // and until then the haze is limited to what S covers (terrain.viewLimit)
  // — so S's limit must lie beyond the point where H switches on, and the
  // visibility law must actually get there
  const showAt = cover - hSlack(sp.hCell) - STREAM_LEAD - 1000;
  const sLimit = rS - S_DRIFT - STREAM_LEAD - 500;
  assert.ok(sLimit > showAt + 2000, `${q}: haze stalls at ${sLimit} m before H appears at ${showAt} m`);
  const groundVis = GROUND_VIEW[q];
  // on the ground the haze closes on the far shell alone (H is not drawn
  // until the haze reaches it): the ground view must sit inside S's limit
  assert.ok(groundVis < sLimit - 3000, `${q}: ground visibility ${groundVis} m outruns the far shell (${sLimit} m)`);
  const f3 = lodFrame(LOD_PRESETS[q], 3000);
  assert.ok(visibility(groundVis * f3.fogScale, 3000, sp.fogCap) > showAt + 2000,
    `${q}: at 3000 m the haze still has not reached the horizon shell`);
  console.log(`  ✓ ${q}: S ${(rS / 1000).toFixed(1)} km → blend ${(band[0] / 1000).toFixed(1)}–${(band[1] / 1000).toFixed(1)} km → H ${(rH / 1000).toFixed(0)} km, haze ≤ ${(sp.fogCap / 1000).toFixed(0)} km`);
}

// visibility law: untouched near the ground, smooth, and at cruise the
// full-haze line sits within a few degrees of eye level (the complaint was
// "far more than half the screen is sky")
{
  const cap = SHELL_PRESETS.high.fogCap;
  for (let agl = 0; agl <= 1200; agl += 100) {
    const base = 7000 * (1 + agl / 1200);
    assert.equal(visibility(base, agl, cap), base + Math.max(agl - 400, 0) * 6,
      `visibility changed below 1200 m (agl ${agl})`);
  }
  let prev = visibility(19000, 0, cap);
  for (let agl = 10; agl <= 20000; agl += 10) {
    const v = visibility(19000, agl, cap);
    assert.ok(v >= prev && v - prev < 400, `visibility not smooth/monotone at ${agl} m`);
    prev = v;
  }
  const dip = (agl, q) => Math.atan(agl / visibility(19000, agl, SHELL_PRESETS[q].fogCap)) * 180 / Math.PI;
  for (const agl of [3000, 6100, 9000, 11900]) {
    assert.ok(dip(agl, 'high') < 4.6, `high: haze line ${dip(agl, 'high').toFixed(1)}° below eye level at ${agl} m`);
    assert.ok(dip(agl, 'medium') < 6.2, `medium: haze line ${dip(agl, 'medium').toFixed(1)}° at ${agl} m`);
    assert.ok(dip(agl, 'low') < 9.5, `low: haze line ${dip(agl, 'low').toFixed(1)}° at ${agl} m`);
  }
  console.log(`  ✓ haze line at 20,000 ft: ${dip(6100, 'high').toFixed(1)}° below eye level (was 11.5°); at 39,000 ft: ${dip(11900, 'high').toFixed(1)}° (was 21.6°)`);
}

// ---- 2. payloads ----
const gen = new WorldGen();
const splitLerp = (a, b, c, d, u, v) =>
  (u + v <= 1 ? a + (b - a) * u + (c - a) * v : d + (b - d) * (1 - v) + (c - d) * (1 - u));
{
  const cell = 450;
  const hCell = 1800;
  // S: 40 cells (18 km square) centred off-origin over the home island's
  // mountains; H: a lattice comfortably containing it
  const S = buildFarPayload(gen, 2700, -8100, 40, cell, hCell, true, null, 0);
  const H = buildFarPayload(gen, 3600, -7200, 16, hCell, 0, false, null, 1);
  assert.ok(S.baseY && S.baseCols && S.baseNrms, 'far shell carries no parent look');
  assert.equal(H.baseY, null, 'the horizon shell has no parent');
  const hn = H.cells + 1;
  const hv = (gx, gz) => (gz - H.gz0) * hn + (gx - H.gx0);

  // H is the plain terrain at its lattice points (no lower envelope)
  for (let j = 0; j < hn; j++) {
    for (let i = 0; i < hn; i++) {
      const v = j * hn + i;
      const want = Math.fround(gen.heightAt((H.gx0 + i) * hCell, (H.gz0 + j) * hCell));
      assert.equal(H.positions[v * 3 + 1], want, `H vertex ${i},${j} is not the terrain height`);
    }
  }

  // S's parent look is H's surface as H RENDERS it: its vertex values,
  // interpolated across its triangles — bit for bit at shared lattice points
  const sn = S.cells + 1;
  let shared = 0;
  let relief = 0;
  for (let j = 0; j < sn; j++) {
    for (let i = 0; i < sn; i++) {
      const v = j * sn + i;
      const wx = (S.gx0 + i) * cell;
      const wz = (S.gz0 + j) * cell;
      const gx = Math.floor(wx / hCell);
      const gz = Math.floor(wz / hCell);
      const u = wx / hCell - gx;
      const w = wz / hCell - gz;
      const a = hv(gx, gz), b = hv(gx + 1, gz), c = hv(gx, gz + 1), d = hv(gx + 1, gz + 1);
      const y = splitLerp(H.positions[a * 3 + 1], H.positions[b * 3 + 1], H.positions[c * 3 + 1], H.positions[d * 3 + 1], u, w);
      assert.ok(Math.abs(S.baseY[v] - (y + SHELL_LIFT)) < 2e-3,
        `S vertex ${i},${j}: collapsed height ${S.baseY[v]} vs H surface ${y} + lift`);
      const nrm = [0, 0, 0];
      for (let ch = 0; ch < 3; ch++) {
        const col = splitLerp(H.colors[a * 3 + ch], H.colors[b * 3 + ch], H.colors[c * 3 + ch], H.colors[d * 3 + ch], u, w);
        assert.ok(Math.abs(S.baseCols[v * 3 + ch] - col) < 1e-6, `S vertex ${i},${j}: parent colour differs from H's`);
        nrm[ch] = splitLerp(H.normals[a * 3 + ch], H.normals[b * 3 + ch], H.normals[c * 3 + ch], H.normals[d * 3 + ch], u, w);
      }
      const il = 1 / Math.hypot(nrm[0], nrm[1], nrm[2]);
      for (let ch = 0; ch < 3; ch++) {
        assert.ok(Math.abs(S.baseNrms[v * 3 + ch] - nrm[ch] * il) < 1e-5, `S vertex ${i},${j}: parent normal differs from H's`);
      }
      if (u === 0 && w === 0) {
        for (let ch = 0; ch < 3; ch++) {
          assert.equal(S.baseCols[v * 3 + ch], H.colors[a * 3 + ch], 'shared lattice point: colour not bit-identical');
        }
        shared++;
      }
      relief = Math.max(relief, Math.abs(S.positions[v * 3 + 1] - S.baseY[v]));
    }
  }
  assert.ok(shared >= 100 && relief > 60, `weak sample: ${shared} shared points, ${relief.toFixed(0)} m relief`);
  console.log(`  ✓ far shell's parent look is the horizon shell's rendered surface (${sn * sn} vertices, ${shared} shared lattice points bit-identical, up to ${relief.toFixed(0)} m of blend travel)`);

  // lattice purity: the same world point has the same values in any build,
  // rim included — so a re-centre moves nothing, and reuse is exact
  const S2 = buildFarPayload(gen, 2700 + 2700, -8100 - 1800, 40, cell, hCell, true, null, 0);
  const S2r = buildFarPayload(gen, 2700 + 2700, -8100 - 1800, 40, cell, hCell, true, S, 0);
  assert.ok(S2r.reused > sn * sn * 0.75 && S2.reused === 0, `reuse did not engage (${S2r.reused})`);
  for (const k of ['positions', 'normals', 'colors', 'baseY', 'baseCols', 'baseNrms']) {
    assert.deepEqual(S2r[k], S2[k], `rebuild with reuse differs from a fresh build in ${k}`);
  }
  let overlap = 0;
  for (let j = 0; j < sn; j++) {
    for (let i = 0; i < sn; i++) {
      const i2 = i + S.gx0 - S2.gx0;
      const j2 = j + S.gz0 - S2.gz0;
      if (i2 < 0 || j2 < 0 || i2 >= sn || j2 >= sn) continue;
      const v = j * sn + i;
      const v2 = j2 * sn + i2;
      assert.equal(S.positions[v * 3 + 1], S2.positions[v2 * 3 + 1], 'vertex height changed between re-centres');
      for (let ch = 0; ch < 3; ch++) {
        assert.equal(S.colors[v * 3 + ch], S2.colors[v2 * 3 + ch], 'vertex colour changed between re-centres');
        assert.equal(S.normals[v * 3 + ch], S2.normals[v2 * 3 + ch], 'vertex normal changed between re-centres (rim?)');
      }
      overlap++;
    }
  }
  assert.ok(overlap > 1000);
  // a different lattice must not be "reused"
  const S3 = buildFarPayload(gen, 0, 0, 20, 600, hCell, true, S, 0);
  assert.equal(S3.reused, 0, 'reused vertices across different cell sizes');
  console.log(`  ✓ shells never swim: ${overlap} vertices identical across a re-centre; reuse (${S2r.reused}/${sn * sn}) is bit-exact`);
}

// ---- 3. simulated flight ----
// Replays terrain.ts's shell loop (requestShell → finalizeShell →
// updateShells) with a virtual worker, and checks every frame:
//   void     H's punched hole lies inside the disc S really covers
//   poke     wherever H may be drawn, S is fully collapsed onto it
//   swap     the strip a re-centred S adds is beyond the blend edge
//   rim      full haze closes inside H's rim, as seen from the aircraft
function fly({ quality, speed, seconds, latency, turnRate = 0, label, alt = 9000 }) {
  const sp = SHELL_PRESETS[quality];
  const rS = (sp.cells * sp.cell) / 2;
  const rH = (sp.hCells * sp.hCell) / 2;
  const sSnap = lcm900(sp.cell);
  const hSnap = lcm900(sp.hCell);
  const dt = 1 / 60;
  let x = 123, z = -456, hdg = 0.7;
  const lead = Math.min(speed * 5, STREAM_LEAD);
  const S = { cx: Math.round(x / sSnap) * sSnap, cz: Math.round(z / sSnap) * sSnap, due: -1, nx: 0, nz: 0 };
  const H = { cx: Math.round(x / hSnap) * hSnap, cz: Math.round(z / hSnap) * hSnap, due: -1, nx: 0, nz: 0 };
  S.rx = S.cx; S.rz = S.cz; H.rx = H.cx; H.rz = H.cz;
  let px = x + Math.sin(hdg) * lead, pz = z - Math.cos(hdg) * lead;
  let edge = shellEdge(shellHole(rS, Math.hypot(px - S.cx, pz - S.cz)), sp.hCell);
  const hole = { x: px, z: pz, r: horizonHole(shellHole(rS, Math.hypot(px - S.cx, pz - S.cz)), edge, sp.hCell) };
  const stats = { sBuilds: 0, hBuilds: 0, voids: 0, pokes: 0, badSwaps: 0, rim: 0, edgeMin: Infinity, edgeMax: -Infinity, maxDrift: 0 };
  const nominal = shellEdge(shellHole(rS, 0), sp.hCell);
  let t = 0;
  let fogFar = 7000;
  for (let n = 0; n < seconds * 60; n++, t += dt) {
    hdg += turnRate * dt;
    x += Math.sin(hdg) * speed * dt;
    z -= Math.cos(hdg) * speed * dt;
    px = x + Math.sin(hdg) * lead;
    pz = z - Math.cos(hdg) * lead;

    // finalize
    if (S.due >= 0 && t >= S.due) {
      // swap check: everything the new mesh adds beyond the old disc must
      // be collapsed (the old disc's nearest edge from the centre)
      if (rS - Math.hypot(px - S.cx, pz - S.cz) < edge - 1e-6) stats.badSwaps++;
      S.cx = S.nx; S.cz = S.nz; S.due = -1; stats.sBuilds++;
    }
    if (H.due >= 0 && t >= H.due) { H.cx = H.nx; H.cz = H.nz; H.due = -1; stats.hBuilds++; }
    // request (the queue is never idle in this sim: forced thresholds only)
    if (S.due < 0 && Math.hypot(px - S.rx, pz - S.rz) > S_RECENTRE) {
      S.nx = S.rx = Math.round(px / sSnap) * sSnap; S.nz = S.rz = Math.round(pz / sSnap) * sSnap; S.due = t + latency;
    }
    if (H.due < 0 && Math.hypot(px - H.rx, pz - H.rz) > H_RECENTRE) {
      H.nx = H.rx = Math.round(px / hSnap) * hSnap; H.nz = H.rz = Math.round(pz / hSnap) * hSnap; H.due = t + latency * 2;
    }

    // updateShells
    const dS = Math.hypot(px - S.cx, pz - S.cz);
    stats.maxDrift = Math.max(stats.maxDrift, dS);
    const cover = shellHole(rS, dS);
    edge = slewShellEdge(edge, shellEdge(cover, sp.hCell), dt);
    const want = horizonHole(cover, edge, sp.hCell);
    if (Math.abs(want - hole.r) > 25 || Math.hypot(px - hole.x, pz - hole.z) > H_HOLE_STEP - 60) {
      hole.x = px; hole.z = pz; hole.r = want;
    }
    if (n > 600) { stats.edgeMin = Math.min(stats.edgeMin, edge); stats.edgeMax = Math.max(stats.edgeMax, edge); }

    // void: punched hole inside S's real disc
    if (Math.hypot(hole.x - S.cx, hole.z - S.cz) + hole.r > rS + 1e-6) stats.voids++;
    // poke: H is drawn outside (hole.r − one H cell diagonal) of the punch
    // centre; the nearest such point to the streaming centre must be past
    // the blend edge
    const nearestH = hole.r - sp.hCell * Math.SQRT2 - Math.hypot(px - hole.x, pz - hole.z);
    if (nearestH < edge - 1e-6) stats.pokes++;
    // rim: fog (slewed like main.ts, clamped by what is built) vs H's disc
    // as seen from the AIRCRAFT
    const limit = rH - Math.hypot(px - H.cx, pz - H.cz) - STREAM_LEAD - 500;
    const farT = Math.min(visibility(19000, alt, sp.fogCap), Math.max(limit, 7000));
    fogFar += (farT - fogFar) * (1 - Math.exp(-0.8 * dt));
    if (fogFar > rH - Math.hypot(x - H.cx, z - H.cz)) stats.rim++;
  }
  assert.equal(stats.voids, 0, `${label}: H's hole outran S coverage on ${stats.voids} frames (sky-dome void)`);
  assert.equal(stats.pokes, 0, `${label}: H drawn under un-collapsed S on ${stats.pokes} frames`);
  assert.equal(stats.badSwaps, 0, `${label}: ${stats.badSwaps} S re-centres added terrain inside the blend edge`);
  assert.equal(stats.rim, 0, `${label}: haze reached past H's rim on ${stats.rim} frames`);
  return { ...stats, nominal };
}
{
  const runs = [
    { quality: 'high', speed: 70, seconds: 400, latency: 0.2, label: 'trainer' },
    { quality: 'high', speed: 240, seconds: 400, latency: 0.2, label: 'airliner cruise' },
    { quality: 'high', speed: 240, seconds: 400, latency: 0.2, turnRate: 0.03, label: 'airliner in a hold' },
    { quality: 'high', speed: 560, seconds: 300, latency: 0.25, label: 'Mach 1.7 dash' },
    { quality: 'medium', speed: 250, seconds: 400, latency: 0.4, turnRate: -0.01, label: 'medium, slow worker' },
    { quality: 'low', speed: 230, seconds: 400, latency: 0.5, label: 'low preset (phone)' },
  ];
  for (const r of runs) {
    const s = fly(r);
    assert.ok(s.sBuilds >= 8 && s.hBuilds >= 2, `${r.label}: only ${s.sBuilds}/${s.hBuilds} shell rebuilds exercised`);
    // steady flight: the blend edge must not breathe with the re-centre
    // sawtooth (that would be a ring of terrain pulsing between two looks)
    assert.ok(s.maxDrift <= S_DRIFT, `${r.label}: S drift ${s.maxDrift.toFixed(0)} m exceeds the allowance`);
    assert.ok(s.edgeMax - s.edgeMin < 1e-6 && Math.abs(s.edgeMax - s.nominal) < 1e-6,
      `${r.label}: blend edge moved ${(s.edgeMax - s.edgeMin).toFixed(0)} m in steady flight`);
    console.log(`  ✓ ${r.label}: ${s.sBuilds} far + ${s.hBuilds} horizon re-centres — no void, no poke-through, blend edge fixed, rim under haze`);
  }
}
{
  // abuse: the worker stalls for 6 s at cruise (tab hitch, GC, a slow
  // phone). The edge may retreat — it must do so without a void or a poke,
  // and recover.
  const s = fly({ quality: 'medium', speed: 250, seconds: 300, latency: 6, label: 'worker stalls 6 s' });
  assert.ok(s.edgeMin < s.nominal - 500, 'stall case did not stress the edge');
  console.log(`  ✓ 6 s worker stalls: blend edge retreats ${(s.nominal - s.edgeMin).toFixed(0)} m and recovers — still no void or poke-through`);
}

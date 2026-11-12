// Continuous distance LOD: the policy that retired the terrain "pop".
// The contract (world/lod.ts): detail is a function of distance, and every
// mesh swap lands where the two meshes involved render the same surface —
// the finer one fully collapsed onto its parent look, the coarser one fully
// itself. These tests pin that contract three ways:
//   1. band geometry for every quality at every altitude
//   2. payloads: a chunk's parent look IS the coarser mesh, bit for bit
//   3. a simulated flight (speed, turns, climbs, worker latency): every swap,
//      arrival and removal the streamer would perform is pixel-identical
import assert from 'node:assert/strict';
import { WorldGen } from '../.test-build/world/heightfield.js';
import { buildChunkPayload, buildScatter } from '../.test-build/world/terrainBuilder.js';
import {
  LOD_PRESETS, lodFrame, planStep, wantLevel, morphAt, edgeBand,
  CHUNK, CHUNK_R, HYST, MARGIN, DEL_HYST, SHELL_SLACK, HOLE_STEP, LEVEL_RES,
} from '../.test-build/world/lod.js';

/* ---------------------------------------------------- 1. band geometry ---- */
{
  let frames = 0;
  for (const [name, preset] of Object.entries(LOD_PRESETS)) {
    for (let agl = 0; agl <= 8000; agl += 25) {
      const f = lodFrame(preset, agl);
      frames++;
      const tag = `${name} @ ${agl} m`;
      // thresholds nest
      assert.ok(f.T[1] < f.load, `${tag}: u28 beyond the load radius`);
      assert.ok(f.T[2] < f.T[1], `${tag}: u56 ≥ u28`);
      if (f.T[3] > 0) assert.ok(f.T[3] < f.T[2], `${tag}: u112 ≥ u56`);
      for (let l = 0; l <= 3; l++) {
        if (l === 3 && f.T[3] === 0) continue;
        const [inner, outer] = f.band[l];
        // (the ultra band legitimately shrinks to nothing as it fades out
        // with altitude — that is what makes its on/off step invisible)
        const minW = l === 3 ? (agl < 300 ? 380 : 49) : l === 0 ? 400 : 300;
        assert.ok(outer - inner >= minW, `${tag}: level ${l} band only ${(outer - inner).toFixed(0)} m wide`);
      }
      // dead zones: at an upgrade (centre at U) and a downgrade (centre at
      // U + HYST) every vertex of the finer chunk is past its band and every
      // vertex of the coarser chunk is short of its own
      for (let l = 1; l <= 3; l++) {
        if (f.T[l] === 0) continue;
        const U = f.T[l];
        assert.ok(f.band[l][1] <= U - CHUNK_R - MARGIN + 1e-6, `${tag}: level ${l} band reaches its swap zone`);
        assert.ok(f.band[l - 1][0] >= U + HYST + CHUNK_R + MARGIN - 1e-6,
          `${tag}: level ${l - 1} band starts inside the level-${l} swap zone`);
        assert.equal(morphAt(f.band[l], U - CHUNK_R), 0);
        assert.equal(morphAt(f.band[l - 1], U + HYST + CHUNK_R), 1);
      }
      // the far edge: chunks collapse onto the shell before the shell can
      // still be drawn under them, and the hole stays inside coverage
      assert.ok(f.hole <= f.load - CHUNK_R - 50, `${tag}: hole outruns coverage`);
      assert.ok(f.band[0][1] <= f.hole - SHELL_SLACK + 1e-6, `${tag}: edge band overlaps the shell`);
      // scatter: instances are fully shrunk before a chunk may drop them
      for (let s = 1; s <= 2; s++) {
        assert.ok(f.grow[s][1] <= f.S[s] - CHUNK_R - MARGIN + 1e-6, `${tag}: scatter ${s} grow band too far out`);
        assert.ok(f.grow[s][0] < f.grow[s][1]);
      }
    }
    // reach never shrinks with altitude except the ultra level
    let prev = lodFrame(preset, 0);
    for (let agl = 10; agl <= 8000; agl += 10) {
      const f = lodFrame(preset, agl);
      assert.ok(f.load >= prev.load - 1e-9 && f.T[1] >= prev.T[1] - 1e-9 && f.T[2] >= prev.T[2] - 1e-9,
        `${name}: reach shrinks climbing through ${agl} m`);
      // …and moves smoothly: no tier jumps to requeue the world
      assert.ok(f.load - prev.load < 60 && f.T[1] - prev.T[1] < 60, `${name}: reach jumps at ${agl} m`);
      prev = f;
    }
  }
  console.log(`  ✓ band geometry holds for all presets (${frames} altitude frames)`);
}

/* ------------------------------------------- 2. payload parent-exactness ---- */
{
  const gen = new WorldGen();
  // a chunk on sloping coastal ground near the home field, and a mountain one
  const sites = [[3, 2], [-7, -22], [14, 9]];
  let checked = 0;
  for (const [cx, cz] of sites) {
    for (let level = 1; level <= 3; level++) {
      const res = LEVEL_RES[level];
      const pres = res / 2;
      const fine = buildChunkPayload(gen, cx, cz, res, 0, pres, 450);
      const par = buildChunkPayload(gen, cx, cz, pres, 0, pres > 14 ? pres / 2 : 0, 450);
      const gN = res + 3;
      const pN = pres + 3;
      // interpolate the PARENT mesh the way the GPU draws it (b–c diagonal)
      const parAt = (arr, comps, comp, u, v) => {
        const pi = Math.min(Math.floor(u), pres - 1);
        const pj = Math.min(Math.floor(v), pres - 1);
        const tx = u - pi;
        const tz = v - pj;
        const at = (i, j) => arr[((j + 1) * pN + (i + 1)) * comps + comp];
        const a = at(pi, pj), b = at(pi + 1, pj), c = at(pi, pj + 1), d = at(pi + 1, pj + 1);
        return tx + tz <= 1 ? a + (b - a) * tx + (c - a) * tz : d + (b - d) * (1 - tz) + (c - d) * (1 - tx);
      };
      for (let j = 0; j <= res; j++) {
        for (let i = 0; i <= res; i++) {
          const v = (j + 1) * gN + (i + 1);
          const u = i / 2;
          const w = j / 2;
          const y = parAt(par.positions, 3, 1, u, w);
          assert.ok(Math.abs(fine.baseY[v] - y) < 2e-3,
            `res ${res} chunk ${cx},${cz} vertex ${i},${j}: parent look ${fine.baseY[v]} vs parent mesh ${y}`);
          let nl = 0;
          const n = [0, 0, 0];
          for (let ch = 0; ch < 3; ch++) {
            const c = parAt(par.colors, 3, ch, u, w);
            assert.ok(Math.abs(fine.baseCols[v * 3 + ch] - c) < 2e-5,
              `res ${res} vertex ${i},${j}: parent colour ch${ch} ${fine.baseCols[v * 3 + ch]} vs ${c}`);
            n[ch] = parAt(par.normals, 3, ch, u, w);
            nl += n[ch] * n[ch];
          }
          nl = Math.sqrt(nl);
          for (let ch = 0; ch < 3; ch++) {
            assert.ok(Math.abs(fine.baseNrms[v * 3 + ch] - n[ch] / nl) < 2e-5,
              `res ${res} vertex ${i},${j}: parent normal differs`);
          }
          checked++;
        }
      }
    }
  }
  console.log(`  ✓ a chunk's collapsed look equals its parent mesh — height, colour, normal (${checked} vertices)`);
}

/* ------------------------------------------------- 3. scatter prefixes ---- */
{
  for (const theme of ['archipelago', 'mesa', 'metro']) {
    const gen = new WorldGen(undefined, theme);
    let lists = 0;
    for (let cx = -6; cx <= 6; cx++) {
      for (let cz = -6; cz <= 6; cz++) {
        const a = buildScatter(gen, cx, cz, 1);
        const b = buildScatter(gen, cx, cz, 2);
        const z = buildScatter(gen, cx, cz, 0);
        for (const k of ['tree', 'leaf', 'rock', 'house']) {
          const la = a[`${k}Mats`];
          const lb = b[`${k}Mats`];
          assert.ok(la.length <= lb.length, `${theme} ${cx},${cz}: ${k} level 1 longer than level 2`);
          for (let i = 0; i < la.length; i++) {
            if (la[i] !== lb[i]) assert.fail(`${theme} ${cx},${cz}: ${k} level-1 list is not a prefix of level 2`);
          }
          // the payload's split point is the level-1 length, at both levels
          assert.equal(a.l1[k], la.length / 16);
          assert.equal(b.l1[k], la.length / 16);
          lists++;
        }
        // towers are identical at every density
        assert.deepEqual(z.towerMats, b.towerMats);
        assert.deepEqual(z.glassMats, b.glassMats);
      }
    }
    assert.ok(lists > 600);
  }
  console.log('  ✓ scatter level 1 is an exact prefix of level 2 in every category, every theme');
}

/* ------------------------------------------------ 4. simulated flight ---- */
// Replays the streamer's own loop (scan → feed → finalize, see terrain.ts)
// against a virtual worker with latency, and checks every event:
//   swap     finer mesh at m = 0 over ALL its vertices, coarser at m = 1
//   arrival  a fresh chunk lands fully collapsed (beyond the edge band)
//   removal  a dropped chunk was fully collapsed
//   coverage the shell hole never contains a missing chunk
function fly({ quality, speed, alt, latency, seconds, turnRate = 0, climb = 0, label }) {
  const preset = LOD_PRESETS[quality];
  const chunks = new Map(); // key → {cx, cz, level, scatter}
  const inflight = [];      // {key, cx, cz, level, scatter, done}
  const keyOf = (cx, cz) => `${cx},${cz}`;
  let px = 450, pz = 450, hdg = 0.3, agl = alt, aglS = alt;
  let edge = 0, edgeTarget = 0, hole = 0;
  let scanX = Infinity, scanZ = Infinity, scanAgl = 0;
  let queue = [];
  const stats = { swaps: 0, lateSwaps: 0, fresh: 0, lateFresh: 0, removed: 0, lateRemoved: 0, builds: 0, maxChunks: 0, voids: 0 };
  const dt = 1 / 30;
  const warm = 12; // seconds of standing still to fill the disc (boot)
  const cornerD = (cx, cz) => {
    const ds = [];
    for (const [ox, oz] of [[0, 0], [1, 0], [0, 1], [1, 1]]) {
      ds.push(Math.hypot((cx + ox) * CHUNK - px, (cz + oz) * CHUNK - pz));
    }
    return ds;
  };
  const nearest = (cx, cz) => {
    const mx = Math.abs((cx + 0.5) * CHUNK - px) - CHUNK / 2;
    const mz = Math.abs((cz + 0.5) * CHUNK - pz) - CHUNK / 2;
    return Math.hypot(Math.max(mx, 0), Math.max(mz, 0));
  };
  const farthest = (cx, cz) => Math.max(...cornerD(cx, cz));
  const centre = (cx, cz) => Math.hypot((cx + 0.5) * CHUNK - px, (cz + 0.5) * CHUNK - pz);

  for (let t = -warm; t < seconds; t += dt) {
    const moving = t >= 0;
    if (moving) {
      hdg += turnRate * dt;
      px += Math.sin(hdg) * speed * dt;
      pz -= Math.cos(hdg) * speed * dt;
      agl = Math.max(0, agl + climb * dt);
    }
    const dA = agl - aglS;
    aglS += Math.max(-120 * dt, Math.min(120 * dt, dA));
    const f = lodFrame(preset, aglS);
    const bands = [edgeBand(f, edge), f.band[1], f.band[2], f.band[3]];

    // finalize finished builds
    for (let i = inflight.length - 1; i >= 0; i--) {
      const job = inflight[i];
      if (job.done > t) continue;
      inflight.splice(i, 1);
      const old = chunks.get(job.key);
      const dc = centre(job.cx, job.cz);
      if (!old) {
        if (wantLevel(f, dc, -1) < 0) continue;
        stats.fresh++;
        if (moving && morphAt(bands[0], nearest(job.cx, job.cz)) > 0) stats.lateFresh++;
      } else {
        const step = planStep(f, dc, old.level, old.scatter);
        if (!step || step.level !== job.level || (job.level === old.level && step.scatter !== job.scatter)) continue;
        if (job.level !== old.level) {
          assert.equal(Math.abs(job.level - old.level), 1, `${label}: level jumped ${old.level} → ${job.level}`);
          stats.swaps++;
          const fine = Math.max(job.level, old.level);
          const exact = morphAt(bands[fine], nearest(job.cx, job.cz)) === 0 &&
            morphAt(bands[fine - 1], farthest(job.cx, job.cz)) === 1;
          if (moving && !exact) {
            stats.lateSwaps++;
            if (process.env.LOD_DEBUG) {
              console.log(`    late: t=${t.toFixed(2)} agl=${aglS.toFixed(0)} ${old.level}→${job.level} dc=${dc.toFixed(0)} ` +
                `near=${nearest(job.cx, job.cz).toFixed(0)} far=${farthest(job.cx, job.cz).toFixed(0)} ` +
                `T=${f.T.map((v) => v.toFixed(0))} fineBand=${bands[fine].map((v) => v.toFixed(0))} coarseBand=${bands[fine - 1].map((v) => v.toFixed(0))}`);
            }
          }
        }
      }
      chunks.set(job.key, { cx: job.cx, cz: job.cz, level: job.level, scatter: job.scatter });
    }

    // scan
    if (Math.hypot(px - scanX, pz - scanZ) > 60 || Math.abs(aglS - scanAgl) > 6 || !moving) {
      scanX = px;
      scanZ = pz;
      scanAgl = aglS;
      for (const [key, c] of chunks) {
        const dc = centre(c.cx, c.cz);
        if (dc > f.load + DEL_HYST && (dc - CHUNK_R > edge + 30 || dc > f.load + 4000)) {
          stats.removed++;
          if (moving && (c.level !== 0 || morphAt(bands[0], nearest(c.cx, c.cz)) > 0)) stats.lateRemoved++;
          chunks.delete(key);
        }
      }
      queue = [];
      const ccx = Math.floor(px / CHUNK), ccz = Math.floor(pz / CHUNK);
      const r = Math.ceil((f.load + DEL_HYST) / CHUNK) + 1;
      let gap = Infinity;
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          const cx = ccx + dx, cz = ccz + dz;
          const dc = centre(cx, cz);
          if (dc >= f.load + DEL_HYST) continue;
          const c = chunks.get(keyOf(cx, cz));
          if (!c) {
            if (dc >= f.load) continue;
            gap = Math.min(gap, nearest(cx, cz));
          }
          if (planStep(f, dc, c ? c.level : -1, c ? c.scatter : 0)) queue.push({ cx, cz, dc });
        }
      }
      queue.sort((a, b) => a.dc - b.dc);
      hole = Math.max(Math.min(f.hole, gap - HOLE_STEP - 30), 0);
      edgeTarget = Math.max(hole - SHELL_SLACK, 0);
    }
    // feed (every frame): 3 in flight, each taking `latency`
    while (inflight.length < 3 && queue.length > 0) {
      const job = queue.shift();
      const key = keyOf(job.cx, job.cz);
      if (inflight.some((j) => j.key === key)) continue;
      const c = chunks.get(key);
      const step = planStep(f, centre(job.cx, job.cz), c ? c.level : -1, c ? c.scatter : 0);
      if (!step) continue;
      stats.builds++;
      inflight.push({ key, cx: job.cx, cz: job.cz, level: step.level, scatter: step.scatter, done: t + latency });
    }
    // coverage: no missing chunk inside the punched hole
    if (moving) {
      const rr = Math.ceil(hole / CHUNK) + 1;
      const ccx = Math.floor(px / CHUNK), ccz = Math.floor(pz / CHUNK);
      for (let dz = -rr; dz <= rr; dz++) {
        for (let dx = -rr; dx <= rr; dx++) {
          // (the punched hole trails the centre by up to one re-punch step)
          if (!chunks.has(keyOf(ccx + dx, ccz + dz)) && nearest(ccx + dx, ccz + dz) < hole - 71) stats.voids++;
        }
      }
    }
    const dE = edgeTarget - edge;
    edge += !moving ? dE : Math.max(-200 * dt, Math.min(500 * dt, dE));
    stats.maxChunks = Math.max(stats.maxChunks, chunks.size);
  }
  return stats;
}

{
  // realistic envelope: worker latency per chunk well under 50 ms on any
  // device this runs on; 3 in flight. Every event must be pixel-identical.
  const runs = [
    { quality: 'high', speed: 70, alt: 150, latency: 0.03, seconds: 240, label: 'trainer low level' },
    { quality: 'high', speed: 70, alt: 150, latency: 0.03, seconds: 240, turnRate: 0.05, label: 'trainer circling' },
    { quality: 'high', speed: 240, alt: 9000, latency: 0.02, seconds: 240, label: 'airliner cruise' },
    { quality: 'high', speed: 150, alt: 100, latency: 0.03, seconds: 200, climb: 45, label: 'jet climb-out through every altitude' },
    { quality: 'high', speed: 200, alt: 7000, latency: 0.03, seconds: 200, climb: -35, label: 'descent from cruise' },
    { quality: 'medium', speed: 120, alt: 600, latency: 0.04, seconds: 240, turnRate: -0.03, label: 'medium, banked' },
    { quality: 'low', speed: 90, alt: 2500, latency: 0.05, seconds: 240, label: 'low preset at altitude' },
    { quality: 'low', speed: 60, alt: 60, latency: 0.05, seconds: 200, turnRate: 0.08, label: 'low preset, helicopter orbit' },
  ];
  for (const r of runs) {
    const s = fly(r);
    assert.ok(s.swaps > 20, `${r.label}: only ${s.swaps} swaps exercised`);
    assert.equal(s.lateSwaps, 0, `${r.label}: ${s.lateSwaps}/${s.swaps} swaps were not between identical surfaces`);
    assert.equal(s.lateFresh, 0, `${r.label}: ${s.lateFresh}/${s.fresh} arrivals landed inside the blend band`);
    assert.equal(s.lateRemoved, 0, `${r.label}: ${s.lateRemoved} chunks removed before collapsing onto the shell`);
    assert.equal(s.voids, 0, `${r.label}: shell hole exposed ${s.voids} missing chunks`);
    console.log(`  ✓ ${r.label}: ${s.swaps} swaps, ${s.fresh} arrivals, ${s.removed} removals — all pixel-identical (peak ${s.maxChunks} chunks)`);
  }
}

{
  // abuse: a Mach-1.7 dash at altitude with a slow worker. Swaps may land
  // late (the arrival fade eases those) but the structure must hold: never
  // a two-level jump (asserted inside), never sky showing through the shell
  const s = fly({ quality: 'high', speed: 580, alt: 9000, latency: 0.12, seconds: 120, label: 'mach dash, slow worker' });
  assert.equal(s.voids, 0, `mach dash: shell hole exposed ${s.voids} missing chunks`);
  console.log(`  ✓ Mach 1.7 with a slow worker: ${s.lateSwaps}/${s.swaps} swaps eased by the arrival fade, no voids, no level jumps`);
}

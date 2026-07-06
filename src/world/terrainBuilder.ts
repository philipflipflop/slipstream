/**
 * Pure chunk-payload builder: all the expensive noise/geometry math with no
 * three.js or DOM dependencies, so it runs identically on the main thread
 * (fallback) or inside the terrain worker. Output is transferable typed
 * arrays ready to be wrapped in BufferAttributes.
 */
import { WorldGen, WATER_LEVEL } from './heightfield';
import { hash2, makeRng } from '../core/math';

export const CHUNK_SIZE = 900;

export interface ChunkPayload {
  cx: number;
  cz: number;
  res: number;
  scatter: 0 | 1 | 2;
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  /** per-vertex geomorph start height: the exact surface this chunk replaces */
  baseY: Float32Array;
  /** per-vertex colour-morph start: the REPLACED surface's palette (coarse
   *  texel — parent LOD or shell), blended to `colors` by the same uMorph so
   *  a fresh tile sharpens gradually instead of snapping to fine paint */
  baseCols: Float32Array;
  /** per-vertex normal-morph start: normals of the morph-start surface, so
   *  Lambert shading sharpens with the swell too — a normals snap reads as a
   *  brightness pop at low sun even when the silhouette never moves */
  baseNrms: Float32Array;
  index: Uint32Array;
  treeMats: Float32Array;   // conifers; 16 floats per instance (column-major)
  treeTints: Float32Array;  // 3 floats per conifer
  leafMats: Float32Array;   // broadleaf trees
  leafTints: Float32Array;
  rockMats: Float32Array;   // boulders
  rockTints: Float32Array;
  houseMats: Float32Array;
  houseTints: Float32Array; // 3 floats per instance
  towerMats: Float32Array;  // city buildings, punched-window concrete
  towerTints: Float32Array;
  glassMats: Float32Array;  // city buildings, glass curtain-wall
  glassTints: Float32Array;
}

/**
 * The far shell's vertex height at lattice point (gx·cell, gz·cell): a
 * conservative lower envelope — min of the centre and four half-step samples,
 * dropped 6 m. buildFarPayload and chunk geomorph starts share this one rule,
 * so a brand-new chunk at morph 0 sits exactly on the rendered shell surface.
 *
 * Terrain that is clearly above the waterline never drops below it: the raw
 * −6 m envelope drowned every low coast (and the whole metro city, elev
 * ~6.5 m) on the shell, so distant water bodies read too big — and every
 * chunk arriving at the streaming boundary flipped its tile between the
 * drowned-shell shape and the true coastline, twinkling water bodies
 * grow/shrink across the whole horizon during flight.
 */
export function shellVertexHeight(gen: WorldGen, gx: number, gz: number, cell: number): number {
  const hs = cell / 2;
  const wx = gx * cell;
  const wz = gz * cell;
  const m = Math.min(
    gen.heightAt(wx, wz),
    gen.heightAt(wx - hs, wz), gen.heightAt(wx + hs, wz),
    gen.heightAt(wx, wz - hs), gen.heightAt(wx, wz + hs),
  );
  // keep ≥1.3 m of clearance below the lowest nearby terrain so detailed
  // chunks still render strictly above the shell where they overlap it
  if (m > WATER_LEVEL + 2.6) return Math.max(m - 6, WATER_LEVEL + 1.3);
  return m - 6;
}

/**
 * Interpolate within a quad split along the b–c diagonal — the same
 * triangulation every mesh here uses — so interpolated geomorph starts are
 * exactly coplanar with the rendered coarse surface.
 */
function splitLerp(ha: number, hb: number, hc: number, hd: number, u: number, v: number): number {
  if (u + v <= 1) return ha + (hb - ha) * u + (hc - ha) * v;
  return hd + (hb - hd) * (1 - v) + (hc - hd) * (1 - u);
}

/** Write T·R_y(θ)·S into out at offset (column-major, three.js layout). */
function composeYRot(
  out: Float32Array | number[], o: number,
  x: number, y: number, z: number,
  theta: number, sx: number, sy: number, sz: number,
): void {
  const c = Math.cos(theta);
  const s = Math.sin(theta);
  out[o] = c * sx; out[o + 1] = 0; out[o + 2] = -s * sx; out[o + 3] = 0;
  out[o + 4] = 0; out[o + 5] = sy; out[o + 6] = 0; out[o + 7] = 0;
  out[o + 8] = s * sz; out[o + 9] = 0; out[o + 10] = c * sz; out[o + 11] = 0;
  out[o + 12] = x; out[o + 13] = y; out[o + 14] = z; out[o + 15] = 1;
}

export function buildChunkPayload(
  gen: WorldGen,
  cx: number,
  cz: number,
  res: number,
  scatterLevel: 0 | 1 | 2,
  prevRes = 0,
  shellCell = 450,
): ChunkPayload {
  const x0 = cx * CHUNK_SIZE;
  const z0 = cz * CHUNK_SIZE;
  const step = CHUNK_SIZE / res;

  // height lattice padded by 2 cells for normal estimation
  const latN = res + 5;
  const lat = new Float32Array(latN * latN);
  for (let j = 0; j < latN; j++) {
    const wz = z0 + (j - 2) * step;
    for (let i = 0; i < latN; i++) {
      lat[j * latN + i] = gen.heightAt(x0 + (i - 2) * step, wz);
    }
  }
  const latH = (ci: number, cj: number) => lat[(cj + 2) * latN + (ci + 2)];

  // geomorph start surface: either the coarser chunk being replaced
  // (LOD grids nest, so its surface can be reproduced exactly), or the far
  // shell for a brand-new chunk (+0.5 m so morph start isn't coplanar)
  const shellCache = new Map<string, number>();
  const shellH = (gx: number, gz: number): number => {
    const key = `${gx},${gz}`;
    let h = shellCache.get(key);
    if (h === undefined) {
      h = shellVertexHeight(gen, gx, gz, shellCell);
      shellCache.set(key, h);
    }
    return h;
  };
  const k = prevRes > 0 ? res / prevRes : 0;
  const startH = (ci: number, cj: number): number => {
    if (prevRes > 0) {
      const pi = Math.min(Math.floor(ci / k), prevRes - 1);
      const pj = Math.min(Math.floor(cj / k), prevRes - 1);
      return splitLerp(
        latH(pi * k, pj * k), latH((pi + 1) * k, pj * k),
        latH(pi * k, (pj + 1) * k), latH((pi + 1) * k, (pj + 1) * k),
        ci / k - pi, cj / k - pj,
      );
    }
    const wx = x0 + ci * step;
    const wz = z0 + cj * step;
    const gx = Math.floor(wx / shellCell);
    const gz = Math.floor(wz / shellCell);
    return splitLerp(
      shellH(gx, gz), shellH(gx + 1, gz), shellH(gx, gz + 1), shellH(gx + 1, gz + 1),
      wx / shellCell - gx, wz / shellCell - gz,
    ) + 0.5;
  };

  // vertex grid includes one skirt ring on each side
  const gridN = res + 3;
  const vCount = gridN * gridN;
  const positions = new Float32Array(vCount * 3);
  const normals = new Float32Array(vCount * 3);
  const colors = new Float32Array(vCount * 3);
  const baseY = new Float32Array(vCount);
  const baseCols = new Float32Array(vCount * 3);
  const baseNrms = new Float32Array(vCount * 3);
  // colour-morph start texel: the parent LOD's step for an upgrade, the
  // shell cell for a brand-new chunk — matches whatever was on screen
  const baseTexel = prevRes > 0 ? CHUNK_SIZE / prevRes : shellCell;
  const skirtDrop = 14 + step * 0.8;
  const colorTmp: number[] = [0, 0, 0];

  let v = 0;
  for (let j = -1; j <= res + 1; j++) {
    const cj = Math.min(Math.max(j, 0), res);
    const isSkirtJ = j !== cj;
    const wz = z0 + cj * step;
    for (let i = -1; i <= res + 1; i++) {
      const ci = Math.min(Math.max(i, 0), res);
      const isSkirt = isSkirtJ || i !== ci;
      const wx = x0 + ci * step;
      let h = latH(ci, cj);
      let b = startH(ci, cj);
      // never morph dry land up through the water sheet: coastal chunks
      // otherwise sweep their shoreline across the plane for the whole
      // swell animation, which reads as water-edge flicker
      if (h > WATER_LEVEL + 0.5 && b < WATER_LEVEL + 0.7) b = Math.min(WATER_LEVEL + 0.7, h);
      baseY[v] = b - (isSkirt ? skirtDrop : 0);
      if (isSkirt) h -= skirtDrop;
      positions[v * 3] = wx - x0;
      positions[v * 3 + 1] = h;
      positions[v * 3 + 2] = wz - z0;

      const nx = latH(ci - 1, cj) - latH(ci + 1, cj);
      const nz = latH(ci, cj - 1) - latH(ci, cj + 1);
      const ny = 2 * step;
      const il = 1 / Math.hypot(nx, ny, nz);
      normals[v * 3] = nx * il;
      normals[v * 3 + 1] = ny * il;
      normals[v * 3 + 2] = nz * il;

      gen.colorAt(wx, wz, latH(ci, cj), 1 - ny * il, colorTmp, step);
      colors[v * 3] = colorTmp[0];
      colors[v * 3 + 1] = colorTmp[1];
      colors[v * 3 + 2] = colorTmp[2];

      gen.colorAt(wx, wz, latH(ci, cj), 1 - ny * il, colorTmp, baseTexel);
      baseCols[v * 3] = colorTmp[0];
      baseCols[v * 3 + 1] = colorTmp[1];
      baseCols[v * 3 + 2] = colorTmp[2];

      // normal of the morph-start surface (central differences of startH —
      // piecewise-bilinear, so this reproduces the coarse faceting)
      const bnx = startH(ci - 1, cj) - startH(ci + 1, cj);
      const bnz = startH(ci, cj - 1) - startH(ci, cj + 1);
      const bil = 1 / Math.hypot(bnx, ny, bnz);
      baseNrms[v * 3] = bnx * bil;
      baseNrms[v * 3 + 1] = ny * bil;
      baseNrms[v * 3 + 2] = bnz * bil;
      v++;
    }
  }

  const quads = (gridN - 1) * (gridN - 1);
  const index = new Uint32Array(quads * 6);
  let q = 0;
  for (let j = 0; j < gridN - 1; j++) {
    for (let i = 0; i < gridN - 1; i++) {
      const a = j * gridN + i;
      const b = a + 1;
      const c = a + gridN;
      const d = c + 1;
      index[q++] = a; index[q++] = c; index[q++] = b;
      index[q++] = b; index[q++] = c; index[q++] = d;
    }
  }

  const sc = buildScatter(gen, cx, cz, scatterLevel);

  return {
    cx, cz, res,
    scatter: scatterLevel,
    positions, normals, colors, baseY, baseCols, baseNrms, index,
    treeMats: Float32Array.from(sc.treeMats),
    treeTints: Float32Array.from(sc.treeTints),
    leafMats: Float32Array.from(sc.leafMats),
    leafTints: Float32Array.from(sc.leafTints),
    rockMats: Float32Array.from(sc.rockMats),
    rockTints: Float32Array.from(sc.rockTints),
    houseMats: Float32Array.from(sc.houseMats),
    houseTints: Float32Array.from(sc.houseTints),
    towerMats: Float32Array.from(sc.towerMats),
    towerTints: Float32Array.from(sc.towerTints),
    glassMats: Float32Array.from(sc.glassMats),
    glassTints: Float32Array.from(sc.glassTints),
  };
}

/** Instance matrices + tints for everything scattered on one chunk. */
export interface ScatterLists {
  treeMats: number[]; treeTints: number[];
  leafMats: number[]; leafTints: number[];
  rockMats: number[]; rockTints: number[];
  houseMats: number[]; houseTints: number[];
  towerMats: number[]; towerTints: number[];
  glassMats: number[]; glassTints: number[];
}

/**
 * Deterministic object scatter for a chunk: city towers, trees, boulders,
 * houses. This is the single source of truth for WHERE solid objects stand —
 * the renderer instances these matrices directly and the collision field
 * (src/world/obstacles.ts) derives hit volumes from the same lists, so what
 * you see is exactly what you hit.
 */
export function buildScatter(
  gen: WorldGen,
  cx: number,
  cz: number,
  scatterLevel: 0 | 1 | 2,
): ScatterLists {
  const x0 = cx * CHUNK_SIZE;
  const z0 = cz * CHUNK_SIZE;
  const s: ScatterLists = {
    treeMats: [], treeTints: [], leafMats: [], leafTints: [],
    rockMats: [], rockTints: [], houseMats: [], houseTints: [],
    towerMats: [], towerTints: [], glassMats: [], glassTints: [],
  };

  // ---- city towers (metro theme) ----
  // Towers are placed IDENTICALLY at every scatter level: the skyline never
  // changes composition as rings upgrade, so buildings only ever appear via
  // the fresh-chunk grow-in — never as a pop when a chunk rebuilds closer.
  if (gen.cityMaskAt(x0 + CHUNK_SIZE / 2, z0 + CHUNK_SIZE / 2) > 0.02 ||
      gen.cityMaskAt(x0, z0) > 0.02 || gen.cityMaskAt(x0 + CHUNK_SIZE, z0 + CHUNK_SIZE) > 0.02) {
    const BLOCK = 104;
    const bx0 = Math.floor(x0 / BLOCK);
    const bx1 = Math.floor((x0 + CHUNK_SIZE) / BLOCK);
    const bz0 = Math.floor(z0 / BLOCK);
    const bz1 = Math.floor((z0 + CHUNK_SIZE) / BLOCK);
    for (let bz = bz0; bz <= bz1; bz++) {
      for (let bx = bx0; bx <= bx1; bx++) {
        // one candidate per street block, owned by the chunk holding its centre
        const wcx = bx * BLOCK + 58.5;
        const wcz = bz * BLOCK + 58.5;
        if (wcx < x0 || wcx >= x0 + CHUNK_SIZE || wcz < z0 || wcz >= z0 + CHUNK_SIZE) continue;
        const cm = gen.cityMaskAt(wcx, wcz);
        if (cm < 0.35) continue;
        if (gen.parkBlockAt(bx, bz)) continue;
        if (gen.isOnApron(wcx, wcz)) continue;
        const h = gen.heightAt(wcx, wcz);
        if (h < WATER_LEVEL + 2) continue;

        const hsh = hash2(bx * 3 + 7, bz * 5 - 3);
        const dt = gen.downtownAt(wcx, wcz);
        // vacant blocks keep the suburbs from reading as a perfect lattice
        if (dt < 0.3 && hash2(bx * 41 + 3, bz * 43 + 1) < 0.3) continue;

        const h2 = hash2(bx + 11, bz - 17);
        let ht = 10 + hsh * hsh * 28 + dt * (36 + h2 * 200);
        // a few genuine supertalls anchor the downtown cores
        const supertall = dt > 0.5 && hash2(bx * 53, bz * 59 + 13) > 0.94;
        if (supertall) ht = 260 + h2 * 190;

        const w = 22 + hash2(bx - 5, bz + 9) * 26;
        const d = 22 + hash2(bx + 19, bz + 23) * 26;
        // jitter within the block so towers don't stand on a perfect grid
        const wx = wcx + (hash2(bx * 29 + 1, bz * 31 + 7) - 0.5) * 30;
        const wz = wcz + (hash2(bx * 37 + 5, bz * 41 + 3) - 0.5) * 30;

        // facade: tall towers mostly glass curtain-wall, low ones concrete
        const isGlass = hash2(bx * 7 + 2, bz * 9 + 4) < (ht > 90 ? 0.72 : 0.22);
        const mats = isGlass ? s.glassMats : s.towerMats;
        const tints = isGlass ? s.glassTints : s.towerTints;
        const gl = clampN((ht - 30) / 160, 0, 1);
        const k = 0.8 + hash2(bx, bz * 7) * 0.3;
        const tr = k * (0.85 - gl * 0.3);
        const tg = k * (0.85 - gl * 0.18);
        const tb = k * (0.88 + gl * 0.05);
        const tier = (tw: number, td: number, th: number): void => {
          const o = mats.length;
          mats.length = o + 16;
          composeYRot(mats, o, wx, h - 0.5, wz, 0, tw, th, td);
          tints.push(tr, tg, tb);
        };
        if (supertall) {
          // classic setback profile: three tiers and a spire
          tier(w, d, ht * 0.55);
          tier(w * 0.74, d * 0.74, ht * 0.82);
          tier(w * 0.5, d * 0.5, ht);
          // spire stays wide enough not to shimmer sub-pixel from across the bay
          const o = s.towerMats.length;
          s.towerMats.length = o + 16;
          composeYRot(s.towerMats, o, wx, h - 0.5, wz, 0, 3.6, ht + 22 + h2 * 42, 3.6);
          s.towerTints.push(0.3, 0.32, 0.35);
        } else if (ht > 110 && hash2(bx * 61, bz * 67 + 9) > 0.5) {
          tier(w, d, ht * 0.68);
          tier(w * 0.68, d * 0.68, ht);
        } else {
          tier(w, d, ht);
          // twin mid-rises share some blocks (mirrored across the centre)
          if (ht < 110 && hash2(bx * 71 + 5, bz * 73 + 11) > 0.8) {
            const o = mats.length;
            mats.length = o + 16;
            composeYRot(
              mats, o, 2 * wcx - wx, h - 0.5, 2 * wcz - wz, 0,
              w * 0.8, ht * (0.55 + hsh * 0.5), d * 0.8,
            );
            tints.push(tr * 0.94, tg * 0.94, tb);
          }
        }
        // a low annex beside the main tower fills out the block
        if (hsh > 0.45) {
          const aw = 14 + hash2(bx * 13, bz) * 14;
          const ah = 6 + hash2(bx, bz * 17) * 10;
          const o2 = s.towerMats.length;
          s.towerMats.length = o2 + 16;
          composeYRot(
            s.towerMats, o2,
            wx + (hsh > 0.7 ? 1 : -1) * (w / 2 + aw / 2 + 3), h - 0.5, wz + (aw - 14),
            0, aw, ah, aw,
          );
          s.towerTints.push(k * 0.78, k * 0.76, k * 0.74);
        }
      }
    }
  }

  if (scatterLevel > 0) {
    const rng = makeRng(Math.floor(hash2(cx, cz) * 0xffffffff));

    const treeTries = scatterLevel === 2 ? 240 : 90;
    for (let t = 0; t < treeTries; t++) {
      const wx = x0 + rng() * CHUNK_SIZE;
      const wz = z0 + rng() * CHUNK_SIZE;
      if (gen.isOnApron(wx, wz)) continue;
      const f = gen.forestAt(wx, wz);
      if (rng() > f * f) continue;
      const h = gen.heightAt(wx, wz);
      if (h < WATER_LEVEL + 3 || h > 460) continue;
      const n = gen.normalAt(wx, wz, 6);
      if (n.y < 0.82) continue;
      // squared term gives occasional old-growth giants among the stand
      const sc = 0.75 + rng() * 1.05 + rng() * rng() * 1.5;
      const sy = sc * (0.85 + rng() * 0.4);
      const theta = rng() * Math.PI * 2;
      // broadleaf in moist lowland, conifers everywhere else
      const broadleaf = h < 210 && gen.drynessAt(wx, wz) < 0.52 && rng() < 0.65;
      const k = 0.82 + rng() * 0.36; // per-tree brightness variation
      if (broadleaf) {
        const o = s.leafMats.length;
        s.leafMats.length = o + 16;
        composeYRot(s.leafMats, o, wx, h - 0.4, wz, theta, sc * 1.15, sy, sc * 1.15);
        s.leafTints.push(k * (0.9 + rng() * 0.2), k, k * 0.88);
      } else if (sc < 1.8 && rng() < 0.16) {
        // cypress/poplar: tall, narrow, darker — breaks up the cone monotony
        const o = s.treeMats.length;
        s.treeMats.length = o + 16;
        composeYRot(s.treeMats, o, wx, h - 0.4, wz, theta, sc * 0.52, sy * 1.8, sc * 0.52);
        s.treeTints.push(k * 0.8, k * 0.95, k * 0.78);
      } else {
        const o = s.treeMats.length;
        s.treeMats.length = o + 16;
        composeYRot(s.treeMats, o, wx, h - 0.4, wz, theta, sc, sy, sc);
        s.treeTints.push(k * 0.95, k, k * 0.92);
      }
    }

    // boulders on steep faces and high ground, half-buried
    const rockBase = scatterLevel === 2 ? 70 : 26;
    const rockTries = gen.theme === 'mesa' ? Math.round(rockBase * 1.8) : rockBase;
    for (let t = 0; t < rockTries; t++) {
      const wx = x0 + rng() * CHUNK_SIZE;
      const wz = z0 + rng() * CHUNK_SIZE;
      if (gen.isOnApron(wx, wz)) continue;
      const h = gen.heightAt(wx, wz);
      if (h < WATER_LEVEL + 2) continue;
      const n = gen.normalAt(wx, wz, 5);
      const steep = 1 - n.y;
      // mostly where it's rocky: steep slopes or alpine elevations
      const rocky = steep * 2.6 + smoothstepN(h, 260, 520) * 0.7 +
        (gen.theme === 'mesa' ? 0.25 : 0);
      if (rng() > rocky) continue;
      const sc = 0.6 + rng() * rng() * 3.4;
      const theta = rng() * Math.PI * 2;
      // mesa: some boulders stretch into hoodoo pinnacles on the benches
      const hoodoo = gen.theme === 'mesa' && steep < 0.22 && rng() < 0.3;
      const sy = hoodoo ? sc * (2.8 + rng() * 2.6) : sc * (0.7 + rng() * 0.5);
      const sxz = hoodoo ? sc * 0.75 : sc;
      const o = s.rockMats.length;
      s.rockMats.length = o + 16;
      composeYRot(s.rockMats, o, wx, h - sc * 0.35, wz, theta, sxz, sy, sxz);
      const k = 0.75 + rng() * 0.45;
      if (hoodoo) s.rockTints.push(k * 0.72, k * 0.46, k * 0.32);
      else s.rockTints.push(k, k * 0.97, k * 0.93);
    }

    const houseTries = scatterLevel === 2 ? 50 : 16;
    for (let t = 0; t < houseTries; t++) {
      const wx = x0 + rng() * CHUNK_SIZE;
      const wz = z0 + rng() * CHUNK_SIZE;
      if (gen.isOnApron(wx, wz)) continue;
      const sAmt = gen.settlementAt(wx, wz);
      if (rng() > sAmt) continue;
      const h = gen.heightAt(wx, wz);
      if (h < WATER_LEVEL + 2.5 || h > 160) continue;
      const n = gen.normalAt(wx, wz, 8);
      if (n.y < 0.97) continue;
      const w = 7 + rng() * 10;
      const d = 7 + rng() * 10;
      const ht = 4 + rng() * (6 + rng() * 7); // cottages through low blocks
      const theta = Math.floor(rng() * 4) * (Math.PI / 2) + (rng() - 0.5) * 0.3;
      const o = s.houseMats.length;
      s.houseMats.length = o + 16;
      composeYRot(s.houseMats, o, wx, h - 0.3, wz, theta, w, ht, d);
      const k = 0.7 + rng() * 0.3;
      s.houseTints.push(0.85 * k, 0.8 * k, 0.72 * k);
    }
  }

  return s;
}

function smoothstepN(v: number, lo: number, hi: number): number {
  const t = clampN((v - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
}
function clampN(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** The transferable buffers of a payload (for zero-copy postMessage). */
export function payloadTransfers(p: ChunkPayload): ArrayBuffer[] {
  return [
    p.positions.buffer, p.normals.buffer, p.colors.buffer, p.baseY.buffer,
    p.baseCols.buffer, p.baseNrms.buffer, p.index.buffer,
    p.treeMats.buffer, p.treeTints.buffer, p.leafMats.buffer, p.leafTints.buffer,
    p.rockMats.buffer, p.rockTints.buffer, p.houseMats.buffer, p.houseTints.buffer,
    p.towerMats.buffer, p.towerTints.buffer, p.glassMats.buffer, p.glassTints.buffer,
  ] as ArrayBuffer[]; // typed arrays here are always plain ArrayBuffer-backed
}

/* ---------------------------------------------------- far shell ---- */

export interface FarPayload {
  far: true;
  ox: number;
  oz: number;
  cells: number;
  cellSize: number;
  positions: Float32Array; // relative to (ox, 0, oz)
  normals: Float32Array;
  colors: Float32Array;
}

/**
 * One coarse mega-mesh of the whole horizon: a (cells+1)² lattice centred on
 * (ox, oz) covering cells·cellSize metres a side. It sits underneath the
 * detailed chunk ring and extends the visible world out to ~30 km, so at
 * altitude the eye meets fogged terrain instead of the edge of the chunk grid.
 *
 * Heights take the MINIMUM of the centre and four half-step samples, then
 * drop a few metres more: a conservative lower envelope, so wherever detailed
 * chunks exist they always render strictly above the shell.
 */
export function buildFarPayload(
  gen: WorldGen,
  ox: number,
  oz: number,
  cells: number,
  cellSize: number,
): FarPayload {
  const n = cells + 1;
  const half = (cells * cellSize) / 2;
  // the lattice origin lands on whole cell multiples (recentre snapping
  // guarantees it), so shellVertexHeight grid coords are exact integers
  const gx0 = Math.round((ox - half) / cellSize);
  const gz0 = Math.round((oz - half) / cellSize);
  const lat = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    const wz = oz - half + j * cellSize;
    for (let i = 0; i < n; i++) {
      lat[j * n + i] = gen.heightAt(ox - half + i * cellSize, wz);
    }
  }
  const latH = (i: number, j: number) =>
    lat[Math.min(Math.max(j, 0), cells) * n + Math.min(Math.max(i, 0), cells)];

  const positions = new Float32Array(n * n * 3);
  const normals = new Float32Array(n * n * 3);
  const colors = new Float32Array(n * n * 3);
  const colorTmp: number[] = [0, 0, 0];

  let v = 0;
  for (let j = 0; j < n; j++) {
    const wz = oz - half + j * cellSize;
    for (let i = 0; i < n; i++) {
      const wx = ox - half + i * cellSize;
      const hc = lat[j * n + i];
      const h = shellVertexHeight(gen, gx0 + i, gz0 + j, cellSize);
      positions[v * 3] = wx - ox;
      positions[v * 3 + 1] = h;
      positions[v * 3 + 2] = wz - oz;

      const nx = latH(i - 1, j) - latH(i + 1, j);
      const nz = latH(i, j - 1) - latH(i, j + 1);
      const ny = 2 * cellSize;
      const il = 1 / Math.hypot(nx, ny, nz);
      normals[v * 3] = nx * il;
      normals[v * 3 + 1] = ny * il;
      normals[v * 3 + 2] = nz * il;

      gen.colorAt(wx, wz, hc, 1 - ny * il, colorTmp, cellSize);
      colors[v * 3] = colorTmp[0];
      colors[v * 3 + 1] = colorTmp[1];
      colors[v * 3 + 2] = colorTmp[2];
      v++;
    }
  }

  return { far: true, ox, oz, cells, cellSize, positions, normals, colors };
}

export function farTransfers(p: FarPayload): ArrayBuffer[] {
  return [p.positions.buffer, p.normals.buffer, p.colors.buffer] as ArrayBuffer[];
}

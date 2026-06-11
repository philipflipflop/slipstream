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
  positions: Float32Array;
  normals: Float32Array;
  colors: Float32Array;
  /** per-vertex geomorph start height: the exact surface this chunk replaces */
  baseY: Float32Array;
  index: Uint32Array;
  treeMats: Float32Array;   // 16 floats per instance (column-major)
  houseMats: Float32Array;
  houseTints: Float32Array; // 3 floats per instance
}

/**
 * The far shell's vertex height at lattice point (gx·cell, gz·cell): a
 * conservative lower envelope — min of the centre and four half-step samples,
 * dropped 6 m. buildFarPayload and chunk geomorph starts share this one rule,
 * so a brand-new chunk at morph 0 sits exactly on the rendered shell surface.
 */
export function shellVertexHeight(gen: WorldGen, gx: number, gz: number, cell: number): number {
  const hs = cell / 2;
  const wx = gx * cell;
  const wz = gz * cell;
  return Math.min(
    gen.heightAt(wx, wz),
    gen.heightAt(wx - hs, wz), gen.heightAt(wx + hs, wz),
    gen.heightAt(wx, wz - hs), gen.heightAt(wx, wz + hs),
  ) - 6;
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
      baseY[v] = startH(ci, cj) - (isSkirt ? skirtDrop : 0);
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

      gen.colorAt(wx, wz, latH(ci, cj), 1 - ny * il, colorTmp);
      colors[v * 3] = colorTmp[0];
      colors[v * 3 + 1] = colorTmp[1];
      colors[v * 3 + 2] = colorTmp[2];
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

  // ---- scatter ----
  const treeList: number[] = [];
  const houseList: number[] = [];
  const tintList: number[] = [];

  if (scatterLevel > 0) {
    const rng = makeRng(Math.floor(hash2(cx, cz) * 0xffffffff));

    const treeTries = scatterLevel === 2 ? 170 : 70;
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
      const s = 0.8 + rng() * 1.1;
      const sy = s * (0.85 + rng() * 0.4);
      const theta = rng() * Math.PI * 2;
      const o = treeList.length;
      treeList.length = o + 16;
      composeYRot(treeList, o, wx, h - 0.4, wz, theta, s, sy, s);
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
      const w = 7 + rng() * 9;
      const d = 7 + rng() * 9;
      const ht = 4 + rng() * 7;
      const theta = Math.floor(rng() * 4) * (Math.PI / 2) + (rng() - 0.5) * 0.3;
      const o = houseList.length;
      houseList.length = o + 16;
      composeYRot(houseList, o, wx, h - 0.3, wz, theta, w, ht, d);
      const k = 0.7 + rng() * 0.3;
      tintList.push(0.85 * k, 0.8 * k, 0.72 * k);
    }
  }

  return {
    cx, cz, res,
    positions, normals, colors, baseY, index,
    treeMats: Float32Array.from(treeList),
    houseMats: Float32Array.from(houseList),
    houseTints: Float32Array.from(tintList),
  };
}

/** The transferable buffers of a payload (for zero-copy postMessage). */
export function payloadTransfers(p: ChunkPayload): ArrayBuffer[] {
  return [
    p.positions.buffer, p.normals.buffer, p.colors.buffer, p.baseY.buffer, p.index.buffer,
    p.treeMats.buffer, p.houseMats.buffer, p.houseTints.buffer,
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

      gen.colorAt(wx, wz, hc, 1 - ny * il, colorTmp);
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

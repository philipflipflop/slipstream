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
  index: Uint32Array;
  treeMats: Float32Array;   // 16 floats per instance (column-major)
  houseMats: Float32Array;
  houseTints: Float32Array; // 3 floats per instance
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

  // vertex grid includes one skirt ring on each side
  const gridN = res + 3;
  const vCount = gridN * gridN;
  const positions = new Float32Array(vCount * 3);
  const normals = new Float32Array(vCount * 3);
  const colors = new Float32Array(vCount * 3);
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
    positions, normals, colors, index,
    treeMats: Float32Array.from(treeList),
    houseMats: Float32Array.from(houseList),
    houseTints: Float32Array.from(tintList),
  };
}

/** The transferable buffers of a payload (for zero-copy postMessage). */
export function payloadTransfers(p: ChunkPayload): ArrayBuffer[] {
  return [
    p.positions.buffer, p.normals.buffer, p.colors.buffer, p.index.buffer,
    p.treeMats.buffer, p.houseMats.buffer, p.houseTints.buffer,
  ] as ArrayBuffer[]; // typed arrays here are always plain ArrayBuffer-backed
}

/**
 * Infinite streamed terrain: square chunks ringed around the aircraft,
 * built incrementally (budgeted per frame) from the analytic heightfield,
 * with distance-based LOD, skirt geometry to hide seams, and per-chunk
 * instanced trees & settlements.
 */
import * as THREE from 'three';
import { WorldGen, WATER_LEVEL } from './heightfield';
import { hash2, makeRng } from '../core/math';

export const CHUNK_SIZE = 900;

interface Chunk {
  key: string;
  cx: number;
  cz: number;
  res: number;
  group: THREE.Group;
  disposables: Array<{ dispose(): void }>;
}

function buildTreeGeometry(): THREE.BufferGeometry {
  // low-poly conifer: trunk + two canopy cones, vertex-coloured
  const parts: THREE.BufferGeometry[] = [];
  const trunk = new THREE.CylinderGeometry(0.45, 0.65, 3.2, 5);
  trunk.translate(0, 1.6, 0);
  paintGeometry(trunk, 0.3, 0.2, 0.12);
  parts.push(trunk);
  const c1 = new THREE.ConeGeometry(3.4, 7.5, 6);
  c1.translate(0, 6.4, 0);
  paintGeometry(c1, 0.1, 0.32, 0.13);
  parts.push(c1);
  const c2 = new THREE.ConeGeometry(2.3, 5.5, 6);
  c2.translate(0, 10.2, 0);
  paintGeometry(c2, 0.13, 0.38, 0.16);
  parts.push(c2);
  return mergeGeoms(parts);
}

function buildHouseGeometry(): THREE.BufferGeometry {
  // simple gabled house; walls + roof get separate vertex colours,
  // overall tint comes from per-instance colour
  const parts: THREE.BufferGeometry[] = [];
  const walls = new THREE.BoxGeometry(1, 1, 1);
  walls.translate(0, 0.5, 0);
  paintGeometry(walls, 1, 1, 1);
  parts.push(walls);
  const roof = new THREE.CylinderGeometry(0.62, 0.62, 1.04, 3);
  roof.rotateZ(Math.PI / 2);
  roof.rotateX(Math.PI / 2);
  roof.scale(1, 0.55, 1.18);
  roof.translate(0, 1.18, 0);
  paintGeometry(roof, 0.55, 0.35, 0.3);
  parts.push(roof);
  return mergeGeoms(parts);
}

function paintGeometry(g: THREE.BufferGeometry, r: number, gr: number, b: number): void {
  const count = g.attributes.position.count;
  const colors = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    colors[i * 3] = r; colors[i * 3 + 1] = gr; colors[i * 3 + 2] = b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(colors, 3));
}

/** Minimal non-indexed geometry merge (avoids pulling in example utils). */
function mergeGeoms(geoms: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const nonIndexed = geoms.map((g) => (g.index ? g.toNonIndexed() : g));
  let vCount = 0;
  for (const g of nonIndexed) vCount += g.attributes.position.count;
  const pos = new Float32Array(vCount * 3);
  const nor = new Float32Array(vCount * 3);
  const col = new Float32Array(vCount * 3);
  let off = 0;
  for (const g of nonIndexed) {
    pos.set(g.attributes.position.array as Float32Array, off * 3);
    nor.set(g.attributes.normal.array as Float32Array, off * 3);
    col.set(g.attributes.color.array as Float32Array, off * 3);
    off += g.attributes.position.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  for (const g of nonIndexed) g.dispose();
  return out;
}

export class TerrainManager {
  readonly gen: WorldGen;
  private chunks = new Map<string, Chunk>();
  private queue: Array<{ cx: number; cz: number; res: number; priority: number }> = [];
  private terrainMat: THREE.MeshLambertMaterial;
  private treeMat: THREE.MeshLambertMaterial;
  private houseMat: THREE.MeshLambertMaterial;
  private treeGeo: THREE.BufferGeometry;
  private houseGeo: THREE.BufferGeometry;
  private lastCx = Infinity;
  private lastCz = Infinity;

  /** ring radius in chunks; set by quality preset */
  radius = 7;
  buildBudget = 2;

  constructor(private scene: THREE.Scene, gen: WorldGen) {
    this.gen = gen;
    this.terrainMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.treeMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.houseMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.treeGeo = buildTreeGeometry();
    this.houseGeo = buildHouseGeometry();
  }

  private resForRing(ring: number): number {
    if (ring <= 1) return 56;
    if (ring <= 3) return 28;
    return 12;
  }

  /** Call every frame with the player position. */
  update(px: number, pz: number): void {
    const cx = Math.floor(px / CHUNK_SIZE);
    const cz = Math.floor(pz / CHUNK_SIZE);

    if (cx !== this.lastCx || cz !== this.lastCz) {
      this.lastCx = cx;
      this.lastCz = cz;
      this.requeue(cx, cz);
    }

    // build a few chunks per frame, nearest first
    for (let i = 0; i < this.buildBudget && this.queue.length > 0; i++) {
      const job = this.queue.shift()!;
      const ring = Math.max(Math.abs(job.cx - cx), Math.abs(job.cz - cz));
      if (ring > this.radius) continue; // stale job
      this.buildChunk(job.cx, job.cz, this.resForRing(ring));
    }
  }

  /** True when every chunk in the current ring set exists (any LOD). */
  isReadyAround(px: number, pz: number, rings = 2): boolean {
    const cx = Math.floor(px / CHUNK_SIZE);
    const cz = Math.floor(pz / CHUNK_SIZE);
    for (let dz = -rings; dz <= rings; dz++)
      for (let dx = -rings; dx <= rings; dx++)
        if (!this.chunks.has(`${cx + dx},${cz + dz}`)) return false;
    return true;
  }

  private requeue(cx: number, cz: number): void {
    // drop chunks that fell out of range
    for (const [key, chunk] of this.chunks) {
      const ring = Math.max(Math.abs(chunk.cx - cx), Math.abs(chunk.cz - cz));
      if (ring > this.radius + 1) {
        this.scene.remove(chunk.group);
        for (const d of chunk.disposables) d.dispose();
        this.chunks.delete(key);
      }
    }
    // queue missing or under-detailed chunks
    this.queue.length = 0;
    for (let dz = -this.radius; dz <= this.radius; dz++) {
      for (let dx = -this.radius; dx <= this.radius; dx++) {
        const tx = cx + dx;
        const tz = cz + dz;
        const ring = Math.max(Math.abs(dx), Math.abs(dz));
        const want = this.resForRing(ring);
        const existing = this.chunks.get(`${tx},${tz}`);
        if (existing && existing.res >= want) continue;
        this.queue.push({ cx: tx, cz: tz, res: want, priority: dx * dx + dz * dz });
      }
    }
    this.queue.sort((a, b) => a.priority - b.priority);
  }

  private buildChunk(cx: number, cz: number, res: number): void {
    const key = `${cx},${cz}`;
    const old = this.chunks.get(key);
    if (old) {
      if (old.res >= res) return;
      this.scene.remove(old.group);
      for (const d of old.disposables) d.dispose();
      this.chunks.delete(key);
    }

    const x0 = cx * CHUNK_SIZE;
    const z0 = cz * CHUNK_SIZE;
    const step = CHUNK_SIZE / res;
    const gen = this.gen;

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

        // normal from lattice central differences (at clamped cell)
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

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.setIndex(new THREE.BufferAttribute(index, 1));

    const mesh = new THREE.Mesh(geo, this.terrainMat);
    mesh.position.set(x0, 0, z0);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();

    const group = new THREE.Group();
    group.add(mesh);
    const disposables: Array<{ dispose(): void }> = [geo];

    // scatter vegetation & buildings on nearer rings only
    const ringNow = Math.max(Math.abs(cx - this.lastCx), Math.abs(cz - this.lastCz));
    if (ringNow <= 4) {
      this.scatter(group, disposables, cx, cz, ringNow);
    }

    this.scene.add(group);
    this.chunks.set(key, { key, cx, cz, res, group, disposables });
  }

  private scatter(
    group: THREE.Group,
    disposables: Array<{ dispose(): void }>,
    cx: number,
    cz: number,
    ring: number,
  ): void {
    const gen = this.gen;
    const rng = makeRng(Math.floor(hash2(cx, cz) * 0xffffffff));
    const x0 = cx * CHUNK_SIZE;
    const z0 = cz * CHUNK_SIZE;

    const treeTries = ring <= 2 ? 170 : 70;
    const treeMatrices: THREE.Matrix4[] = [];
    const houseMatrices: THREE.Matrix4[] = [];
    const m = new THREE.Matrix4();
    const pos = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    const up = new THREE.Vector3(0, 1, 0);

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
      pos.set(wx, h - 0.4, wz);
      quat.setFromAxisAngle(up, rng() * Math.PI * 2);
      scl.set(s, s * (0.85 + rng() * 0.4), s);
      m.compose(pos, quat, scl);
      treeMatrices.push(m.clone());
    }

    const houseTries = ring <= 2 ? 50 : 16;
    for (let t = 0; t < houseTries; t++) {
      const wx = x0 + rng() * CHUNK_SIZE;
      const wz = z0 + rng() * CHUNK_SIZE;
      if (gen.isOnApron(wx, wz)) continue;
      const s = gen.settlementAt(wx, wz);
      if (rng() > s) continue;
      const h = gen.heightAt(wx, wz);
      if (h < WATER_LEVEL + 2.5 || h > 160) continue;
      const n = gen.normalAt(wx, wz, 8);
      if (n.y < 0.97) continue;
      const w = 7 + rng() * 9;
      const d = 7 + rng() * 9;
      const ht = 4 + rng() * 7;
      pos.set(wx, h - 0.3, wz);
      quat.setFromAxisAngle(up, Math.floor(rng() * 4) * (Math.PI / 2) + (rng() - 0.5) * 0.3);
      scl.set(w, ht, d);
      m.compose(pos, quat, scl);
      houseMatrices.push(m.clone());
    }

    if (treeMatrices.length > 0) {
      const im = new THREE.InstancedMesh(this.treeGeo, this.treeMat, treeMatrices.length);
      treeMatrices.forEach((mat, i) => im.setMatrixAt(i, mat));
      im.instanceMatrix.needsUpdate = true;
      im.frustumCulled = true;
      group.add(im);
      disposables.push({ dispose: () => im.dispose() });
    }
    if (houseMatrices.length > 0) {
      const im = new THREE.InstancedMesh(this.houseGeo, this.houseMat, houseMatrices.length);
      const tint = new THREE.Color();
      houseMatrices.forEach((mat, i) => {
        im.setMatrixAt(i, mat);
        const k = 0.7 + rng() * 0.3;
        tint.setRGB(0.85 * k, 0.8 * k, 0.72 * k);
        im.setColorAt(i, tint);
      });
      im.instanceMatrix.needsUpdate = true;
      if (im.instanceColor) im.instanceColor.needsUpdate = true;
      group.add(im);
      disposables.push({ dispose: () => im.dispose() });
    }
  }
}

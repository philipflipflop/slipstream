/**
 * Infinite streamed terrain: square chunks ringed around the aircraft with
 * distance-based nested LOD and skirt geometry. The heavy generation math
 * runs in a Web Worker (terrain.worker.ts) so the main thread never hitches
 * while flying — chunks arrive as transferable typed arrays and only the
 * cheap GPU upload happens here. Falls back to synchronous generation if
 * workers are unavailable.
 */
import * as THREE from 'three';
import { WorldGen } from './heightfield';
import { buildChunkPayload, ChunkPayload, CHUNK_SIZE } from './terrainBuilder';

export { CHUNK_SIZE };

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

const MAX_INFLIGHT = 3;

export class TerrainManager {
  readonly gen: WorldGen;
  private chunks = new Map<string, Chunk>();
  private queue: Array<{ cx: number; cz: number; res: number; priority: number }> = [];
  private pending = new Map<string, number>(); // key → res being built
  private results: ChunkPayload[] = [];
  private worker: Worker | null = null;

  private terrainMat: THREE.MeshLambertMaterial;
  private treeMat: THREE.MeshLambertMaterial;
  private houseMat: THREE.MeshLambertMaterial;
  private treeGeo: THREE.BufferGeometry;
  private houseGeo: THREE.BufferGeometry;
  private lastCx = Infinity;
  private lastCz = Infinity;

  /** ring radius in chunks; set by quality preset */
  radius = 7;
  /** payload finalizations (GPU uploads) per frame */
  buildBudget = 2;
  /** extra rings streamed in when flying high, set by quality preset */
  altBonus = 4;
  private highAlt = false;

  constructor(private scene: THREE.Scene, gen: WorldGen) {
    this.gen = gen;
    this.terrainMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.treeMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.houseMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.treeGeo = buildTreeGeometry();
    this.houseGeo = buildHouseGeometry();

    try {
      this.worker = new Worker(new URL('./terrain.worker.ts', import.meta.url), { type: 'module' });
      this.worker.postMessage({ type: 'init', seed: gen.seed });
      this.worker.onmessage = (e: MessageEvent<ChunkPayload>) => {
        this.results.push(e.data);
      };
      this.worker.onerror = () => {
        // worker died — fall back to synchronous builds
        this.worker = null;
        this.pending.clear();
      };
    } catch {
      this.worker = null;
    }
  }

  // resolutions nest (56 = 2×28 = 4×14): a coarse chunk's vertices are an
  // exact subset of the fine grid, so shorelines and ridges don't crawl
  // when a chunk upgrades LOD as you approach
  private resForRing(ring: number): number {
    if (ring <= 1) return 56;
    if (ring <= 3) return 28;
    return 14;
  }

  private scatterForRing(ring: number): 0 | 1 | 2 {
    if (ring > 4) return 0;
    return ring <= 2 ? 2 : 1;
  }

  /** Current streaming radius (widens at altitude so the view fills out). */
  effRadius(): number {
    return this.radius + (this.highAlt ? this.altBonus : 0);
  }

  /** Call every frame with the player position + height above ground. */
  update(px: number, pz: number, agl = 0): void {
    const cx = Math.floor(px / CHUNK_SIZE);
    const cz = Math.floor(pz / CHUNK_SIZE);

    // hysteresis so the radius doesn't flap around the threshold
    const wasHigh = this.highAlt;
    this.highAlt = agl > (wasHigh ? 750 : 1150);
    if (this.highAlt !== wasHigh && this.lastCx !== Infinity) {
      this.requeue(this.lastCx, this.lastCz);
    }

    if (cx !== this.lastCx || cz !== this.lastCz) {
      this.lastCx = cx;
      this.lastCz = cz;
      this.requeue(cx, cz);
    }

    // upload finished payloads (budgeted — uploads are cheap but not free)
    for (let i = 0; i < this.buildBudget && this.results.length > 0; i++) {
      this.finalize(this.results.shift()!);
    }

    // keep the worker fed, nearest jobs first
    while (this.pending.size < MAX_INFLIGHT && this.queue.length > 0) {
      const job = this.queue.shift()!;
      const ring = Math.max(Math.abs(job.cx - cx), Math.abs(job.cz - cz));
      if (ring > this.effRadius()) continue; // stale
      const key = `${job.cx},${job.cz}`;
      const res = this.resForRing(ring);
      const existing = this.chunks.get(key);
      if (existing && existing.res >= res) continue;
      if ((this.pending.get(key) ?? 0) >= res) continue;
      this.pending.set(key, res);
      const msg = { type: 'build', cx: job.cx, cz: job.cz, res, scatter: this.scatterForRing(ring) };
      if (this.worker) {
        this.worker.postMessage(msg);
      } else {
        // synchronous fallback: one chunk per frame at most
        this.results.push(buildChunkPayload(this.gen, job.cx, job.cz, res, this.scatterForRing(ring)));
        break;
      }
    }
  }

  /** True when every chunk in the given ring set exists (any LOD). */
  isReadyAround(px: number, pz: number, rings = 2): boolean {
    const cx = Math.floor(px / CHUNK_SIZE);
    const cz = Math.floor(pz / CHUNK_SIZE);
    for (let dz = -rings; dz <= rings; dz++)
      for (let dx = -rings; dx <= rings; dx++)
        if (!this.chunks.has(`${cx + dx},${cz + dz}`)) return false;
    return true;
  }

  private requeue(cx: number, cz: number): void {
    const radius = this.effRadius();
    for (const [key, chunk] of this.chunks) {
      const ring = Math.max(Math.abs(chunk.cx - cx), Math.abs(chunk.cz - cz));
      if (ring > radius + 1) {
        this.scene.remove(chunk.group);
        for (const d of chunk.disposables) d.dispose();
        this.chunks.delete(key);
      }
    }
    this.queue.length = 0;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
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

  /** Wrap a worker payload in GPU objects and swap it into the scene. */
  private finalize(p: ChunkPayload): void {
    const key = `${p.cx},${p.cz}`;
    if ((this.pending.get(key) ?? 0) === p.res) this.pending.delete(key);

    const ring = Math.max(Math.abs(p.cx - this.lastCx), Math.abs(p.cz - this.lastCz));
    if (ring > this.effRadius() + 1) return; // flew away while it was baking

    const old = this.chunks.get(key);
    if (old) {
      if (old.res >= p.res) return;
      this.scene.remove(old.group);
      for (const d of old.disposables) d.dispose();
      this.chunks.delete(key);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(p.normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(p.colors, 3));
    geo.setIndex(new THREE.BufferAttribute(p.index, 1));

    const mesh = new THREE.Mesh(geo, this.terrainMat);
    mesh.position.set(p.cx * CHUNK_SIZE, 0, p.cz * CHUNK_SIZE);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();

    const group = new THREE.Group();
    group.add(mesh);
    const disposables: Array<{ dispose(): void }> = [geo];

    const treeCount = p.treeMats.length / 16;
    if (treeCount > 0) {
      const im = new THREE.InstancedMesh(this.treeGeo, this.treeMat, treeCount);
      (im.instanceMatrix.array as Float32Array).set(p.treeMats);
      im.instanceMatrix.needsUpdate = true;
      group.add(im);
      disposables.push({ dispose: () => im.dispose() });
    }
    const houseCount = p.houseMats.length / 16;
    if (houseCount > 0) {
      const im = new THREE.InstancedMesh(this.houseGeo, this.houseMat, houseCount);
      (im.instanceMatrix.array as Float32Array).set(p.houseMats);
      im.instanceMatrix.needsUpdate = true;
      im.instanceColor = new THREE.InstancedBufferAttribute(p.houseTints, 3);
      group.add(im);
      disposables.push({ dispose: () => im.dispose() });
    }

    this.scene.add(group);
    this.chunks.set(key, { key, cx: p.cx, cz: p.cz, res: p.res, group, disposables });
  }
}

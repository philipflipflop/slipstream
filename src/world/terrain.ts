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
import { buildChunkPayload, buildFarPayload, ChunkPayload, FarPayload, CHUNK_SIZE } from './terrainBuilder';

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

  // far shell: one coarse mega-mesh of the horizon underneath the chunk ring
  private farMesh: THREE.Mesh | null = null;
  private farGeo: THREE.BufferGeometry | null = null;
  private farIndexArr: Uint32Array | null = null;
  private farOx = Infinity;
  private farOz = Infinity;
  private farGeoOx = 0;
  private farGeoOz = 0;
  private farGeoCells = 0;
  private farGeoCell = 0;
  private farPending = false;
  private farStale = false;
  private farResult: FarPayload | null = null;
  private farCells = 140;
  private farCellSize = 450;

  // running geomorph animations (one per freshly finalized chunk)
  private morphs: Array<{ u: { value: number }; t: number }> = [];

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
      this.worker.onmessage = (e: MessageEvent<ChunkPayload | FarPayload>) => {
        if ('far' in e.data) this.farResult = e.data;
        else this.results.push(e.data);
      };
      this.worker.onerror = () => {
        // worker died — fall back to synchronous builds
        this.worker = null;
        this.pending.clear();
        this.farPending = false;
      };
    } catch {
      this.worker = null;
    }
  }

  // resolutions nest (56 = 2×28 = 4×14): a coarse chunk's vertices are an
  // exact subset of the fine grid, so shorelines and ridges don't crawl when
  // a chunk upgrades LOD — and geomorph starts can reproduce the coarse
  // surface exactly. At altitude the whole area below is in plain view, so
  // the fine rings reach further out.
  private resForRing(ring: number): number {
    if (ring <= (this.highAlt ? 3 : 2)) return 56;
    if (ring <= (this.highAlt ? 6 : 4)) return 28;
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
  update(px: number, pz: number, agl = 0, dt = 0.016): void {
    const cx = Math.floor(px / CHUNK_SIZE);
    const cz = Math.floor(pz / CHUNK_SIZE);

    // advance geomorphs: fresh chunks swell from the surface they replaced
    for (let i = this.morphs.length - 1; i >= 0; i--) {
      const m = this.morphs[i];
      m.t = Math.min(m.t + dt / 1.1, 1);
      m.u.value = m.t * m.t * (3 - 2 * m.t);
      if (m.t >= 1) {
        this.morphs[i] = this.morphs[this.morphs.length - 1];
        this.morphs.pop();
      }
    }

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

    // far shell: swap in a freshly baked horizon
    if (this.farResult) {
      const p = this.farResult;
      this.farResult = null;
      this.finalizeFar(p);
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
      const prev = existing?.res ?? 0;
      const shellCell = this.farGeo ? this.farGeoCell : this.farCellSize;
      const scatter = this.scatterForRing(ring);
      if (this.worker) {
        this.worker.postMessage({ type: 'build', cx: job.cx, cz: job.cz, res, scatter, prev, shellCell });
      } else {
        // synchronous fallback: one chunk per frame at most
        this.results.push(buildChunkPayload(this.gen, job.cx, job.cz, res, scatter, prev, shellCell));
        break;
      }
    }

    // recentre the horizon shell only when no chunk work is outstanding —
    // it's the biggest single job and must never delay nearby terrain
    // (the queue drains between chunk crossings even at fighter speeds)
    if (
      !this.farPending && this.pending.size === 0 && this.queue.length === 0 &&
      (Math.abs(px - this.farOx) > 4500 || Math.abs(pz - this.farOz) > 4500)
    ) {
      const snap = this.farSnap();
      const ox = Math.round(px / snap) * snap;
      const oz = Math.round(pz / snap) * snap;
      this.farPending = true;
      if (this.worker) {
        this.worker.postMessage({ type: 'far', ox, oz, cells: this.farCells, cellSize: this.farCellSize });
      } else {
        this.farResult = buildFarPayload(this.gen, ox, oz, this.farCells, this.farCellSize);
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
    this.rebuildFarIndex();
  }

  /** Quality preset hook: shell density. Forces a rebuild when it changes. */
  configureFar(cells: number, cellSize: number): void {
    if (cells === this.farCells && cellSize === this.farCellSize) return;
    this.farCells = cells;
    this.farCellSize = cellSize;
    if (this.farPending) this.farStale = true;
    else { this.farOx = Infinity; this.farOz = Infinity; }
  }

  /**
   * Recentre snap: a multiple of both the chunk size and the shell cell, so
   * shell vertices land on the same world lattice every rebuild — heights
   * are identical between rebuilds and the horizon never "swims".
   */
  private farSnap(): number {
    let s = CHUNK_SIZE;
    while (s % this.farCellSize !== 0) s += CHUNK_SIZE;
    return s;
  }

  private finalizeFar(p: FarPayload): void {
    this.farPending = false;
    if (this.farStale) {
      // density changed while this one was baking — keep it, but rebuild soon
      this.farStale = false;
      this.farOx = Infinity;
      this.farOz = Infinity;
    } else {
      this.farOx = p.ox;
      this.farOz = p.oz;
    }

    if (this.farMesh) {
      this.scene.remove(this.farMesh);
      this.farGeo!.dispose();
    }
    this.farGeoOx = p.ox;
    this.farGeoOz = p.oz;
    this.farGeoCells = p.cells;
    this.farGeoCell = p.cellSize;

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(p.normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(p.colors, 3));
    this.farIndexArr = new Uint32Array(p.cells * p.cells * 6);
    geo.setIndex(new THREE.BufferAttribute(this.farIndexArr, 1));
    this.farGeo = geo;

    const mesh = new THREE.Mesh(geo, this.terrainMat);
    mesh.position.set(p.ox, 0, p.oz);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.frustumCulled = false; // spans the whole horizon — always in view
    this.farMesh = mesh;
    this.rebuildFarIndex();
    this.scene.add(mesh);
  }

  /**
   * Re-index the shell, skipping quads fully inside the area the detailed
   * chunk ring is guaranteed to cover (two rings of slack for streaming lag).
   * Index-only: vertices stay put, so this is cheap enough to run on every
   * chunk crossing.
   */
  private rebuildFarIndex(): void {
    if (!this.farGeo || !this.farIndexArr) return;
    const cells = this.farGeoCells;
    const cs = this.farGeoCell;
    const half = (cells * cs) / 2;
    let hx0 = Infinity, hx1 = -Infinity, hz0 = Infinity, hz1 = -Infinity;
    if (this.lastCx !== Infinity) {
      const r = this.effRadius() - 2;
      hx0 = (this.lastCx - r) * CHUNK_SIZE;
      hx1 = (this.lastCx + r + 1) * CHUNK_SIZE;
      hz0 = (this.lastCz - r) * CHUNK_SIZE;
      hz1 = (this.lastCz + r + 1) * CHUNK_SIZE;
    }
    const idx = this.farIndexArr;
    const n = cells + 1;
    let q = 0;
    for (let j = 0; j < cells; j++) {
      const z0 = this.farGeoOz - half + j * cs;
      const inZ = z0 >= hz0 && z0 + cs <= hz1;
      for (let i = 0; i < cells; i++) {
        if (inZ) {
          const x0 = this.farGeoOx - half + i * cs;
          if (x0 >= hx0 && x0 + cs <= hx1) continue; // chunks cover this quad
        }
        const a = j * n + i;
        const b = a + 1;
        const c = a + n;
        const d = c + 1;
        idx[q++] = a; idx[q++] = c; idx[q++] = b;
        idx[q++] = b; idx[q++] = c; idx[q++] = d;
      }
    }
    this.farGeo.setDrawRange(0, q);
    (this.farGeo.index as THREE.BufferAttribute).needsUpdate = true;
  }

  /**
   * A Lambert clone whose vertices blend from baseY (the surface this chunk
   * replaces — coarser LOD or the far shell) up to their true heights as
   * uMorph runs 0→1: LOD swaps read as a smooth swell instead of a pop.
   * All clones share one GL program via the custom cache key.
   */
  private makeChunkMat(u: { value: number }): THREE.MeshLambertMaterial {
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uMorph = u;
      sh.vertexShader =
        'attribute float baseY;\nuniform float uMorph;\n' +
        sh.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n\ttransformed.y = mix(baseY, position.y, uMorph);',
        );
    };
    mat.customProgramCacheKey = () => 'terrain-geomorph';
    return mat;
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
    geo.setAttribute('baseY', new THREE.BufferAttribute(p.baseY, 1));
    geo.setIndex(new THREE.BufferAttribute(p.index, 1));

    const morph = { u: { value: 0 }, t: 0 };
    this.morphs.push(morph);
    const mat = this.makeChunkMat(morph.u);

    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(p.cx * CHUNK_SIZE, 0, p.cz * CHUNK_SIZE);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();

    const group = new THREE.Group();
    group.add(mesh);
    const disposables: Array<{ dispose(): void }> = [geo, mat];

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

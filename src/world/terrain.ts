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
  scatter: 0 | 1 | 2;
  /** instance count per scatter list at build time — deterministic RNG makes
   *  a lower level's list an exact prefix of a higher one, so on upgrade only
   *  instances beyond these counts are new (and grow in) */
  counts: number[];
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

function buildBroadleafGeometry(): THREE.BufferGeometry {
  // deciduous tree: short trunk + lumpy ellipsoid canopy (3 offset spheres)
  const parts: THREE.BufferGeometry[] = [];
  const trunk = new THREE.CylinderGeometry(0.5, 0.75, 3.6, 5);
  trunk.translate(0, 1.8, 0);
  paintGeometry(trunk, 0.32, 0.22, 0.13);
  parts.push(trunk);
  const blobs: Array<[number, number, number, number]> = [
    [0, 5.6, 0, 3.6], [1.7, 4.9, 0.6, 2.5], [-1.4, 5.1, -0.9, 2.3],
  ];
  for (const [bx, by, bz, br] of blobs) {
    const s = new THREE.SphereGeometry(br, 6, 5);
    s.scale(1, 0.82, 1);
    s.translate(bx, by, bz);
    paintGeometry(s, 0.16, 0.4, 0.1);
    parts.push(s);
  }
  return mergeGeoms(parts);
}

function buildRockGeometry(): THREE.BufferGeometry {
  // crushed icosahedron, flat-shaded for hard facets
  const g = new THREE.IcosahedronGeometry(1, 0);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const k = 0.75 + Math.sin(i * 12.9898) * 0.5 * 0.35;
    pos.setXYZ(i, pos.getX(i) * k, pos.getY(i) * 0.78 * k, pos.getZ(i) * k);
  }
  g.computeVertexNormals();
  paintGeometry(g, 0.46, 0.43, 0.4);
  return g;
}

/** Unit-box tower: window-grid texture on the sides, plain roof. */
function buildTowerGeometry(): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(1, 1, 1);
  g.translate(0, 0.5, 0);
  // remap the top + bottom faces' UVs into the texture's solid roof strip
  // (canvas y=248..256 → UV v≈0.0..0.03)
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let face = 2; face <= 3; face++) {
    for (let v = 0; v < 4; v++) {
      uv.setXY(face * 4 + v, 0.02, 0.015);
    }
  }
  return g;
}

function towerTexture(style: 'punched' | 'curtain'): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  if (style === 'punched') {
    // concrete facade with a punched window grid: 10 columns × 24 floors
    ctx.fillStyle = '#3a4350';
    ctx.fillRect(0, 0, 128, 256);
    for (let fy = 0; fy < 24; fy++) {
      for (let fx = 0; fx < 10; fx++) {
        const lit = Math.random();
        ctx.fillStyle = lit > 0.93
          ? 'rgba(255, 226, 150, 0.9)'
          : `rgba(${120 + Math.random() * 60}, ${150 + Math.random() * 60}, ${175 + Math.random() * 55}, ${0.55 + Math.random() * 0.3})`;
        ctx.fillRect(4 + fx * 12.4, 8 + fy * 10.2, 8.4, 6.6);
      }
    }
  } else {
    // glass curtain-wall: continuous glazing bands split by slim mullions —
    // reads as a different building type, not just a re-tint
    ctx.fillStyle = '#232b36';
    ctx.fillRect(0, 0, 128, 256);
    for (let fy = 0; fy < 31; fy++) {
      const sky = 130 + Math.random() * 70;
      ctx.fillStyle = Math.random() > 0.94
        ? 'rgba(255, 226, 150, 0.85)'
        : `rgba(${sky * 0.5}, ${sky * 0.7}, ${sky}, ${0.62 + Math.random() * 0.25})`;
      ctx.fillRect(0, fy * 8 + 1.5, 128, 5.5);
    }
    ctx.fillStyle = 'rgba(20, 26, 34, 0.8)';
    for (let mx = 0; mx < 8; mx++) ctx.fillRect(mx * 16.5 + 2, 0, 1.6, 248);
  }
  // solid roof strip in the top-left corner (top/bottom faces sample here)
  ctx.fillStyle = '#2c3138';
  ctx.fillRect(0, 248, 16, 8);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Night-lights emissive map: black facade, a scatter of lit offices. The
 *  same UV layout as towerTexture so windows glow exactly where they are. */
function towerEmissive(style: 'punched' | 'curtain'): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 256;
  const ctx = c.getContext('2d')!;
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, 128, 256);
  const litColor = (): string => {
    const r = Math.random();
    return r > 0.85 ? 'rgba(210, 228, 255, 0.9)'   // cool fluorescent
      : r > 0.7 ? 'rgba(255, 244, 214, 0.95)'      // bright warm
      : 'rgba(255, 214, 140, 0.85)';               // amber
  };
  if (style === 'punched') {
    for (let fy = 0; fy < 24; fy++) {
      for (let fx = 0; fx < 10; fx++) {
        if (Math.random() < 0.38) {
          ctx.fillStyle = litColor();
          ctx.fillRect(4 + fx * 12.4, 8 + fy * 10.2, 8.4, 6.6);
        }
      }
    }
  } else {
    // curtain wall: runs of lit glazing within each band
    for (let fy = 0; fy < 31; fy++) {
      for (let fx = 0; fx < 8; fx++) {
        if (Math.random() < 0.42) {
          ctx.fillStyle = litColor();
          ctx.fillRect(fx * 16.5 + 4, fy * 8 + 1.5, 13, 5.5);
        }
      }
    }
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
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

/** Shared "already full-size" grow uniform for re-instanced (upgraded) chunks. */
const FULL_GROWN = { value: 1 };

/**
 * Clone a scatter material so its instances scale with a per-chunk grow
 * uniform (each object swells from its own base point alongside the terrain
 * geomorph — trees/buildings rise out of the ground instead of popping).
 * All clones share one GL program per base kind via the cache key.
 */
function makeGrowMat(base: THREE.MeshLambertMaterial, u: { value: number }): THREE.MeshLambertMaterial {
  const mat = base.clone();
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uGrow = u;
    sh.vertexShader = 'uniform float uGrow;\n' + sh.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n\ttransformed *= uGrow;',
    );
  };
  mat.customProgramCacheKey = () => (base.map ? 'tower-grow' : 'scatter-grow');
  return mat;
}

export class TerrainManager {
  readonly gen: WorldGen;
  private chunks = new Map<string, Chunk>();
  private queue: Array<{ cx: number; cz: number; res: number; priority: number }> = [];
  private pending = new Map<string, number>(); // key → res*4+scatter being built
  private results: ChunkPayload[] = [];
  private worker: Worker | null = null;

  private terrainMat: THREE.MeshLambertMaterial;
  private treeMat: THREE.MeshLambertMaterial;
  private houseMat: THREE.MeshLambertMaterial;
  private towerMat: THREE.MeshLambertMaterial;
  private glassMat: THREE.MeshLambertMaterial;
  private treeGeo: THREE.BufferGeometry;
  private leafGeo: THREE.BufferGeometry;
  private rockGeo: THREE.BufferGeometry;
  private houseGeo: THREE.BufferGeometry;
  private towerGeo: THREE.BufferGeometry;
  private lastCx = Infinity;
  private lastCz = Infinity;

  /** ring radius in chunks; set by quality preset */
  radius = 7;
  /** payload finalizations (GPU uploads) per frame */
  buildBudget = 2;
  /** extra rings per altitude tier [ground, low, mid, high]: the visible
   *  seam distance must grow with how far you can see, or the leading edge
   *  hatches tiles in plain view at 20k ft (set by quality preset) */
  altBonusTiers = [0, 4, 6, 8];
  private altTier = 0;

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

  // running geomorph animations (one per freshly finalized chunk);
  // dur stretches with distance so far tiles swell too slowly to notice
  private morphs: Array<{ u: { value: number }; t: number; dur: number }> = [];
  // shell hole needs re-punching once coverage completes
  private farHoleDirty = false;

  /** 0 = day (no cost); > 0 lights the city windows at that intensity and
   *  > 0.3 also fits blinking red obstruction beacons to the supertalls.
   *  Fixed at construction — a time-of-day change reloads, like a world. */
  private windowGlow: number;
  private beaconMat: THREE.MeshBasicMaterial | null = null;
  private beaconGeo: THREE.SphereGeometry | null = null;
  private beaconTime = 0;

  constructor(private scene: THREE.Scene, gen: WorldGen, windowGlow = 0) {
    this.gen = gen;
    this.windowGlow = windowGlow;
    this.terrainMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.treeMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.houseMat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.treeGeo = buildTreeGeometry();
    this.leafGeo = buildBroadleafGeometry();
    this.rockGeo = buildRockGeometry();
    this.houseGeo = buildHouseGeometry();
    this.towerGeo = buildTowerGeometry();
    this.towerMat = new THREE.MeshLambertMaterial({ map: towerTexture('punched') });
    this.glassMat = new THREE.MeshLambertMaterial({ map: towerTexture('curtain') });
    if (windowGlow > 0) {
      // lit offices (emissiveMap is only attached when it will be used —
      // the day preset keeps the cheaper shader variant)
      this.towerMat.emissive = new THREE.Color(0xffffff);
      this.towerMat.emissiveMap = towerEmissive('punched');
      this.towerMat.emissiveIntensity = windowGlow;
      this.glassMat.emissive = new THREE.Color(0xffffff);
      this.glassMat.emissiveMap = towerEmissive('curtain');
      this.glassMat.emissiveIntensity = windowGlow;
    }
    if (windowGlow > 0.3) {
      this.beaconGeo = new THREE.SphereGeometry(2.4, 6, 5);
      this.beaconMat = new THREE.MeshBasicMaterial({ color: 0xff2a2a, transparent: true, opacity: 0.9 });
    }

    try {
      this.worker = new Worker(new URL('./terrain.worker.ts', import.meta.url), { type: 'module' });
      this.worker.postMessage({ type: 'init', seed: gen.seed, theme: gen.theme });
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

  // how far out each resolution reaches, in rings; set by quality preset
  ultraRing = -1; // res 112 (8 m steps) — close-up detail; -1 disables
  fineRing = 3;
  midRing = 5;
  fineRingHigh = 5;
  midRingHigh = 8;

  // resolutions nest (112 = 2×56 = 4×28 = 8×14): a coarse chunk's vertices
  // are an exact subset of the fine grid, so shorelines and ridges don't
  // crawl when a chunk upgrades LOD — and geomorph starts can reproduce the
  // coarse surface exactly. At altitude the whole area below is in plain
  // view, so the fine rings reach further out (but ultra is skipped: 8 m
  // facets are indistinguishable from 16 m ones a kilometre below you).
  private resForRing(ring: number): number {
    const high = this.altTier >= 1;
    if (!high && ring <= this.ultraRing) return 112;
    if (ring <= (high ? this.fineRingHigh : this.fineRing)) return 56;
    if (ring <= (high ? this.midRingHigh : this.midRing)) return 28;
    return 14;
  }

  private scatterForRing(ring: number): 0 | 1 | 2 {
    if (ring > 6) return 0;
    return ring <= 3 ? 2 : 1;
  }

  /** Current streaming radius (widens at altitude so the view fills out). */
  effRadius(): number {
    return this.radius + this.altBonusTiers[this.altTier];
  }

  /** Call every frame with the player position + height above ground. */
  update(px: number, pz: number, agl = 0, dt = 0.016): void {
    const cx = Math.floor(px / CHUNK_SIZE);
    const cz = Math.floor(pz / CHUNK_SIZE);

    // obstruction beacons blink in a slow aviation-red double pulse
    if (this.beaconMat) {
      this.beaconTime += dt;
      const t = this.beaconTime % 1.6;
      this.beaconMat.opacity = t < 0.18 || (t > 0.3 && t < 0.42) ? 0.95 : 0.08;
    }

    // advance geomorphs: fresh chunks swell from the surface they replaced
    for (let i = this.morphs.length - 1; i >= 0; i--) {
      const m = this.morphs[i];
      m.t = Math.min(m.t + dt / m.dur, 1);
      m.u.value = m.t * m.t * (3 - 2 * m.t);
      if (m.t >= 1) {
        this.morphs[i] = this.morphs[this.morphs.length - 1];
        this.morphs.pop();
      }
    }

    // altitude tiers with hysteresis so the radius doesn't flap around a
    // threshold: reach keeps growing as you climb
    {
      const up = [1150, 3200, 5200];
      const down = [750, 2600, 4400];
      let tier = this.altTier;
      if (tier < 3 && agl > up[tier]) tier++;
      else if (tier > 0 && agl < down[tier - 1]) tier--;
      if (tier !== this.altTier) {
        this.altTier = tier;
        if (this.lastCx !== Infinity) this.requeue(this.lastCx, this.lastCz);
      }
    }

    if (cx !== this.lastCx || cz !== this.lastCz) {
      this.lastCx = cx;
      this.lastCz = cz;
      this.requeue(cx, cz);
    }

    // upload finished payloads (budgeted — uploads are cheap but not free).
    // A deep backlog (altitude-tier requeue floods hundreds of far res-14
    // chunks) triples the budget: those payloads are tiny and the view
    // fills out in seconds instead of a quarter minute.
    const budget = this.queue.length + this.results.length > 120
      ? this.buildBudget * 3
      : this.buildBudget;
    for (let i = 0; i < budget && this.results.length > 0; i++) {
      this.finalize(this.results.shift()!);
    }

    // once the queue fully drains, re-punch the shell hole out to the now-
    // complete coverage (it was held small while chunks were missing)
    if (this.farHoleDirty && this.pending.size === 0 && this.queue.length === 0) {
      this.farHoleDirty = false;
      this.rebuildFarIndex();
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
      const ring = Math.hypot(job.cx - cx, job.cz - cz);
      if (ring > this.effRadius() + 0.5) continue; // stale
      const key = `${job.cx},${job.cz}`;
      let res = this.resForRing(ring);
      const scatter = this.scatterForRing(ring);
      const existing = this.chunks.get(key);
      // a chunk can need a rebuild for resolution OR for denser scatter —
      // scatter-only rebuilds keep the finer mesh (geomorph start is then
      // the identical surface, so only the new instances grow in)
      if (existing && existing.res >= res && existing.scatter >= scatter) continue;
      // a missing chunk appears fast at 56 first; the ultra res arrives a
      // beat later as a seamless geomorph upgrade (matters at boot/teleport)
      if (!existing && res > 56) res = 56;
      if (existing && existing.res > res) res = existing.res;
      const combo = res * 4 + scatter;
      if ((this.pending.get(key) ?? 0) >= combo) continue;
      this.pending.set(key, combo);
      const prev = existing?.res ?? 0;
      const shellCell = this.farGeo ? this.farGeoCell : this.farCellSize;
      if (this.worker) {
        this.worker.postMessage({ type: 'build', cx: job.cx, cz: job.cz, res, scatter, prev, shellCell });
      } else {
        // synchronous fallback: one chunk per frame at most
        this.results.push(buildChunkPayload(this.gen, job.cx, job.cz, res, scatter, prev, shellCell));
        break;
      }
    }

    // recentre the horizon shell preferably when no chunk work is
    // outstanding — it's the biggest single job. But at cruise in the top
    // altitude tier the queue may NEVER fully drain (slower devices), and
    // a starved shell drifts kilometres stale then lurches forward in one
    // visible step; past ~7 km of drift the rebuild goes ahead of the
    // chunk queue (one ~100 ms worker job every few km — imperceptible).
    const farDrift = Math.max(Math.abs(px - this.farOx), Math.abs(pz - this.farOz));
    if (
      !this.farPending &&
      // the FIRST build still waits for boot chunks (never delay spawn
      // terrain); only re-centres of an existing shell may jump the queue
      ((this.farMesh !== null && farDrift > 6800) ||
        (this.pending.size === 0 && this.queue.length === 0 && farDrift > 4500))
    ) {
      const snap = this.farSnap();
      const ox = Math.round(px / snap) * snap;
      const oz = Math.round(pz / snap) * snap;
      if (ox === this.farOx && oz === this.farOz) return; // nothing to gain
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

  // Rings are EUCLIDEAN chunk distance: coverage is a disc, so the horizon
  // seam reads as distance haze in every direction instead of a square
  // platform (Chebyshev coverage varied ±40% between axis and diagonal
  // headings — that's what made high-altitude edges pop in as tiles). A
  // disc also holds ~27% fewer chunks than the old square at the same
  // radius, which pays for the wider high-altitude reach.
  private requeue(cx: number, cz: number): void {
    const radius = this.effRadius();
    for (const [key, chunk] of this.chunks) {
      if (Math.hypot(chunk.cx - cx, chunk.cz - cz) > radius + 1.5) {
        this.scene.remove(chunk.group);
        for (const d of chunk.disposables) d.dispose();
        this.chunks.delete(key);
      }
    }
    this.queue.length = 0;
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const ring = Math.hypot(dx, dz);
        if (ring > radius + 0.5) continue; // outside the disc
        const tx = cx + dx;
        const tz = cz + dz;
        const want = this.resForRing(ring);
        const wantS = this.scatterForRing(ring);
        const existing = this.chunks.get(`${tx},${tz}`);
        if (existing && existing.res >= want && existing.scatter >= wantS) continue;
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

  /** Distance (in rings) of the closest missing chunk inside the disc. */
  private nearestGapRing(): number {
    const R = Math.ceil(this.effRadius());
    for (let r = 0; r <= R; r++) {
      for (let dz = -r; dz <= r; dz++) {
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue; // ring shell only
          if (Math.hypot(dx, dz) > this.effRadius() + 0.5) continue;
          if (!this.chunks.has(`${this.lastCx + dx},${this.lastCz + dz}`)) return r;
        }
      }
    }
    return R + 1;
  }

  /**
   * Re-index the shell, skipping quads fully inside the DISC the detailed
   * chunk coverage ACTUALLY fills — the hole is circular to match the
   * Euclidean streaming metric. Index-only: vertices stay put, so this is
   * cheap enough to run on every chunk crossing.
   */
  private rebuildFarIndex(): void {
    if (!this.farGeo || !this.farIndexArr) return;
    const cells = this.farGeoCells;
    const cs = this.farGeoCell;
    const half = (cells * cs) / 2;
    let ccx = Infinity, ccz = Infinity, holeR2 = -1;
    if (this.lastCx !== Infinity) {
      ccx = (this.lastCx + 0.5) * CHUNK_SIZE;
      ccz = (this.lastCz + 0.5) * CHUNK_SIZE;
      // the hole must never outrun the chunks that actually EXIST: when
      // streaming lags (fast climb, altitude-tier requeue, slow device) the
      // shell keeps underlying the gap, so fresh tiles geomorph up from
      // visible coarse terrain instead of popping in over sky-dome void
      const holeRings = Math.min(this.effRadius() - 2.2, this.nearestGapRing() - 1.2);
      const holeR = holeRings * CHUNK_SIZE;
      holeR2 = holeR > 0 ? holeR * holeR : -1;
    }
    const idx = this.farIndexArr;
    const n = cells + 1;
    // the OUTER edge is a disc too (trim the square's corners): the terrain
    // silhouette then reads as a circle at every scale, not a rounded square
    const rimR2 = half * half;
    let q = 0;
    for (let j = 0; j < cells; j++) {
      const z0 = this.farGeoOz - half + j * cs;
      // farthest z-extent of this quad row from the hole centre
      const dz = Math.max(Math.abs(z0 - ccz), Math.abs(z0 + cs - ccz));
      // nearest z-extent from the MESH centre (outer rim test)
      const zr0 = z0 - this.farGeoOz;
      const nz = zr0 > 0 ? zr0 : (zr0 + cs < 0 ? -(zr0 + cs) : 0);
      for (let i = 0; i < cells; i++) {
        const x0 = this.farGeoOx - half + i * cs;
        const xr0 = x0 - this.farGeoOx;
        const nx = xr0 > 0 ? xr0 : (xr0 + cs < 0 ? -(xr0 + cs) : 0);
        if (nx * nx + nz * nz > rimR2) continue; // outside the rim disc
        if (holeR2 > 0) {
          const dx = Math.max(Math.abs(x0 - ccx), Math.abs(x0 + cs - ccx));
          if (dx * dx + dz * dz < holeR2) continue; // chunks cover this quad
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
        'attribute float baseY;\nuniform float uMorph;\nvarying vec3 vTWorld;\n' +
        sh.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\n\ttransformed.y = mix(baseY, position.y, uMorph);' +
          '\n\tvTWorld = (modelMatrix * vec4(transformed, 1.0)).xyz;',
        );
      // close-range albedo detail: value-noise octaves break up the smooth
      // vertex-colour interpolation that reads as "low poly" up close. Each
      // octave fades out BEFORE its wavelength drops below a pixel — value
      // noise has no mipmaps, so past that point it aliases into shimmer
      sh.fragmentShader =
        'varying vec3 vTWorld;\n' +
        sh.fragmentShader
          .replace(
            '#include <common>',
            `#include <common>
            float tHash(vec2 p) {
              return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
            }
            float tNoise(vec2 p) {
              vec2 i = floor(p);
              vec2 f = fract(p);
              vec2 s = f * f * (3.0 - 2.0 * f);
              return mix(
                mix(tHash(i), tHash(i + vec2(1.0, 0.0)), s.x),
                mix(tHash(i + vec2(0.0, 1.0)), tHash(i + vec2(1.0, 1.0)), s.x),
                s.y);
            }`,
          )
          .replace(
            '#include <color_fragment>',
            `#include <color_fragment>
            {
              float dDist = distance(vTWorld, cameraPosition);
              if (dDist < 1300.0) {
                float f1 = smoothstep(420.0, 70.0, dDist);
                float f2 = smoothstep(1300.0, 220.0, dDist);
                float f3 = smoothstep(160.0, 32.0, dDist);
                float n1 = tNoise(vTWorld.xz * 1.45);
                float n2 = tNoise(vTWorld.xz * 0.21 + 37.0);
                float n3 = tNoise(vTWorld.xz * 7.3);
                diffuseColor.rgb *= 1.0
                  + (n1 - 0.5) * 0.14 * f1
                  + (n2 - 0.5) * 0.2 * f2
                  + (n3 - 0.5) * 0.1 * f3;
              }
            }`,
          );
    };
    mat.customProgramCacheKey = () => 'terrain-geomorph';
    return mat;
  }

  /** Wrap a worker payload in GPU objects and swap it into the scene. */
  private finalize(p: ChunkPayload): void {
    const key = `${p.cx},${p.cz}`;
    if ((this.pending.get(key) ?? 0) === p.res * 4 + p.scatter) this.pending.delete(key);

    const ring = Math.hypot(p.cx - this.lastCx, p.cz - this.lastCz);
    if (ring > this.effRadius() + 1.5) return; // flew away while it was baking

    const old = this.chunks.get(key);
    if (old) {
      if (old.res >= p.res && old.scatter >= p.scatter) return;
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

    // nearby chunks swell in ~a second; the outer rings take several — at
    // that range a slow swell reads as nothing at all (this is what kills
    // the residual "tiles hatch at the edge" feel at altitude)
    const morph = { u: { value: 0 }, t: 0, dur: 1.1 + Math.min(ring, 20) * 0.14 };
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

    // Scatter lists at a lower level are an exact prefix of the same lists
    // at a higher level (same RNG stream, shorter loops), so on upgrade the
    // carried-over instances render at full size and only the NEW suffix
    // grows in with the terrain swell — nothing pops, nothing re-grows.
    const counts: number[] = [];
    let listIdx = 0;
    const addInstances = (geo: THREE.BufferGeometry, base: THREE.MeshLambertMaterial, mats: Float32Array, tints: Float32Array): void => {
      const idx = listIdx++;
      const count = mats.length / 16;
      counts[idx] = count;
      if (count === 0) return;
      const nFull = old ? Math.min(old.counts[idx] ?? count, count) : 0;
      const emit = (i0: number, n: number, u: { value: number }): void => {
        if (n <= 0) return;
        const mat = makeGrowMat(base, u);
        const im = new THREE.InstancedMesh(geo, mat, n);
        (im.instanceMatrix.array as Float32Array).set(mats.subarray(i0 * 16, (i0 + n) * 16));
        im.instanceMatrix.needsUpdate = true;
        if (tints.length > 0) {
          im.instanceColor = new THREE.InstancedBufferAttribute(tints.slice(i0 * 3, (i0 + n) * 3), 3);
        }
        group.add(im);
        disposables.push(mat, { dispose: () => im.dispose() });
      };
      emit(0, nFull, FULL_GROWN);
      emit(nFull, count - nFull, morph.u);
    };
    addInstances(this.treeGeo, this.treeMat, p.treeMats, p.treeTints);
    addInstances(this.leafGeo, this.treeMat, p.leafMats, p.leafTints);
    addInstances(this.rockGeo, this.treeMat, p.rockMats, p.rockTints);
    addInstances(this.houseGeo, this.houseMat, p.houseMats, p.houseTints);
    addInstances(this.towerGeo, this.towerMat, p.towerMats, p.towerTints);
    addInstances(this.towerGeo, this.glassMat, p.glassMats, p.glassTints);

    // night: red obstruction beacons on the tall towers (matrices are
    // composeYRot, so el[5] = height and el[12..14] = base position)
    if (this.beaconMat && this.beaconGeo) {
      const tops: number[] = [];
      for (const arr of [p.towerMats, p.glassMats]) {
        for (let i = 0; i < arr.length; i += 16) {
          const sy = arr[i + 5];
          if (sy > 150) tops.push(arr[i + 12], arr[i + 13] + sy + 3, arr[i + 14]);
        }
      }
      if (tops.length > 0) {
        const bm = new THREE.InstancedMesh(this.beaconGeo, this.beaconMat, tops.length / 3);
        const bmm = new THREE.Matrix4();
        for (let i = 0; i < tops.length / 3; i++) {
          bmm.makeTranslation(tops[i * 3], tops[i * 3 + 1], tops[i * 3 + 2]);
          bm.setMatrixAt(i, bmm);
        }
        bm.instanceMatrix.needsUpdate = true;
        group.add(bm);
        disposables.push({ dispose: () => bm.dispose() });
      }
    }

    this.scene.add(group);
    this.chunks.set(key, {
      key, cx: p.cx, cz: p.cz, res: p.res, scatter: p.scatter, counts, group, disposables,
    });
    this.farHoleDirty = true; // coverage grew — widen the shell hole when idle

    // if this was a capped first build, queue the full-strength upgrade
    const want = this.resForRing(ring);
    const wantS = this.scatterForRing(ring);
    if (p.res < want || p.scatter < wantS) {
      this.queue.push({ cx: p.cx, cz: p.cz, res: want, priority: ring * ring });
    }
  }
}

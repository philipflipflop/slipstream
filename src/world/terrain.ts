/**
 * Infinite streamed terrain: square chunks around the aircraft at four
 * nested resolutions, over one coarse far-horizon shell. Detail is a pure
 * function of DISTANCE (see lod.ts): every chunk carries its parent level's
 * look and the vertex shader blends parent → own per vertex inside a
 * per-level distance band, so mesh swaps (up and down a level) land in dead
 * zones where both meshes render the identical surface. Nothing animates
 * over time in steady flight — that is what finally retired the LOD "pop".
 *
 * The heavy generation math runs in a Web Worker (terrain.worker.ts) —
 * chunks arrive as transferable typed arrays and only the cheap GPU upload
 * happens here. Falls back to synchronous generation without workers.
 */
import * as THREE from 'three';
import { WorldGen } from './heightfield';
import { buildChunkPayload, buildFarPayload, ChunkPayload, FarPayload, CHUNK_SIZE } from './terrainBuilder';
import {
  LOD_PRESETS, LodPreset, LodQuality, LodFrame, lodFrame, planStep, wantLevel, edgeBand,
  LEVEL_RES, levelOfRes, CHUNK_R, DEL_HYST, SHELL_SLACK, HOLE_STEP,
} from './lod';

export { CHUNK_SIZE };

interface Chunk {
  key: number;
  cx: number;
  cz: number;
  level: number;
  scatter: 0 | 1 | 2;
  group: THREE.Group;
  disposables: Array<{ dispose(): void }>;
  /** arrival time-fade, shader uniform (x = start blend: 0 parent look /
   *  1 own look, y = eased progress). It only matters when a build lands
   *  LATE (the chunk is already inside a blend band): the new mesh then
   *  eases from the look it replaced to its distance blend instead of
   *  snapping. On-time swaps start where they end, so it does nothing. */
  fade: { value: THREE.Vector2 };
  fadeT: number;
  /** same easing for a fresh chunk's scatter instances (null = shared mats) */
  gFade: { value: number } | null;
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
const HALF = CHUNK_SIZE / 2;
/** arrival time-fade length, s (see Chunk.fade) */
const FADE_DUR = 1.2;

/** Numeric chunk key — the streamer scans a couple of thousand cells several
 *  times a second at altitude, so no string building in that loop. */
const keyOf = (cx: number, cz: number): number => (cx + 32768) * 65536 + (cz + 32768);

/** ?lodtint=1 — per-level tints (14 red, 28 amber, 56 green, 112 blue) */
const LEVEL_TINT = [
  new THREE.Vector3(1.0, 0.45, 0.4),
  new THREE.Vector3(1.0, 0.85, 0.35),
  new THREE.Vector3(0.5, 1.0, 0.5),
  new THREE.Vector3(0.45, 0.7, 1.0),
];

const GROW_ONE = { value: 1 };

export class TerrainManager {
  readonly gen: WorldGen;
  private chunks = new Map<number, Chunk>();
  private queue: Array<{ cx: number; cz: number; dc: number }> = [];
  private pending = new Map<number, number>(); // key → level*4+scatter being built
  /** jobs posted to the worker and not yet answered */
  private inFlight = 0;
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

  /** payload finalizations (GPU uploads) per frame */
  buildBudget = 2;

  // ---- distance LOD state (lod.ts holds the policy) ----
  private preset: LodPreset = LOD_PRESETS.high;
  private lod: LodFrame = lodFrame(LOD_PRESETS.high, 0);
  /** slew-limited height above ground: LOD reach follows this, so a cliff
   *  passing underneath cannot jerk every threshold at once */
  private aglS = -1;
  private px = Infinity;
  private pz = Infinity;
  private scanX = Infinity;
  private scanZ = Infinity;
  private scanAgl = 0;
  private scanDirty = true;
  private scanCooldown = 0;
  /** collapse edge: beyond it level-0 chunks sit exactly on the far shell.
   *  Follows the real shell hole (coverage-limited) through a slew limit so
   *  a streaming hiccup eases the far band instead of snapping it. */
  private edge = 0;
  private edgeTarget = 0;
  private edgeSnap = true;
  private fading: Chunk[] = [];

  // shared shader uniforms — one upload per frame drives every chunk
  private uCenter = { value: new THREE.Vector2() };
  private uBands = [0, 1, 2, 3].map(() => ({ value: new THREE.Vector2(0, 1) }));
  private uGrow = [0, 1, 2].map(() => ({ value: new THREE.Vector2(0, 1) }));
  private uDbg = { value: 0 };
  private growMats = new Map<number, THREE.MeshLambertMaterial>();

  /** streaming health counters (autofly telemetry / tests):
   *  swaps = level changes, late = swaps that landed inside a blend band
   *  (eased by the time-fade instead of being pixel-identical) */
  readonly stats = { swaps: 0, late: 0, fresh: 0, lateFresh: 0, dropped: 0 };

  // far shell: one coarse mega-mesh of the horizon underneath the chunk ring
  private farMesh: THREE.Mesh | null = null;
  private farGeo: THREE.BufferGeometry | null = null;
  private farIndexArr: Uint16Array | Uint32Array | null = null;
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
  // the hole currently punched in the shell index (world centre + radius)
  private holeX = 0;
  private holeZ = 0;
  private holeR = -1;

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
      this.beaconMat = this.makeBeaconMat();
    }

    try {
      this.worker = new Worker(new URL('./terrain.worker.ts', import.meta.url), { type: 'module' });
      this.worker.postMessage({ type: 'init', seed: gen.seed, theme: gen.theme });
      this.worker.onmessage = (e: MessageEvent<ChunkPayload | FarPayload>) => {
        if ('far' in e.data) { this.farResult = e.data; return; }
        this.results.push(e.data);
        this.inFlight--;
        // refeed straight away: the worker's throughput must not hang off
        // the render frame rate (at 20 fps it would idle 90% of the time)
        this.feed();
      };
      this.worker.onerror = () => {
        // worker died — fall back to synchronous builds
        this.worker = null;
        this.pending.clear();
        this.inFlight = 0;
        this.farPending = false;
        this.scanDirty = true;
      };
    } catch {
      this.worker = null;
    }
  }

  // DEBUG (?lodtint=1): tint every chunk by level and darken it by how far
  // it is collapsed toward its parent look — the blend bands become rings
  // you can photograph. Seamless swaps mean a level boundary always sits in
  // a zone where the finer side is fully dark and the coarser fully bright.
  set lodTint(on: boolean) { this.uDbg.value = on ? 1 : 0; }

  /** DEBUG (?lodlog=1): console.warn every swap that was not seamless */
  logLate = false;

  // DEBUG (?shellonly=1): stream and bookkeep chunks normally but never show
  // them — the far shell renders everywhere (hole stays closed).
  shellOnly = false;

  /** Quality preset hook: LOD reach + load radius (see lod.ts). */
  setQuality(q: LodQuality): void {
    this.preset = LOD_PRESETS[q];
    this.scanDirty = true;
  }

  /** How far the fog may open versus its ground range (altitude-driven). */
  fogScale(): number {
    return this.lod.fogScale;
  }

  /** Call every frame with the streaming centre + height above ground. */
  update(px: number, pz: number, agl = 0, dt = 0.016): void {
    // obstruction beacons blink in a slow aviation-red double pulse
    if (this.beaconMat) {
      this.beaconTime += dt;
      const t = this.beaconTime % 1.6;
      this.beaconMat.opacity = t < 0.18 || (t > 0.3 && t < 0.42) ? 0.95 : 0.08;
    }

    // a jump (respawn / restart) is a cut: re-anchor instead of slewing
    const jumped = this.px === Infinity || Math.hypot(px - this.px, pz - this.pz) > 1500;
    this.px = px;
    this.pz = pz;
    if (jumped || this.aglS < 0) {
      this.aglS = Math.max(agl, 0);
      this.edgeSnap = true;
      this.scanDirty = true;
    } else {
      const d = Math.max(agl, 0) - this.aglS;
      const lim = 120 * dt;
      this.aglS += d > lim ? lim : d < -lim ? -lim : d;
    }
    this.lod = lodFrame(this.preset, this.aglS);

    // advance arrival fades
    for (let i = this.fading.length - 1; i >= 0; i--) {
      const c = this.fading[i];
      c.fadeT = Math.min(c.fadeT + dt / FADE_DUR, 1);
      const e = c.fadeT * c.fadeT * (3 - 2 * c.fadeT);
      c.fade.value.y = e;
      if (c.gFade) c.gFade.value = e;
      if (c.fadeT >= 1) {
        this.fading[i] = this.fading[this.fading.length - 1];
        this.fading.pop();
        this.scanDirty = true; // a swap deferred behind this fade can go now
      }
    }

    // upload finished payloads. Budgeted by TIME, not count: far chunks are
    // a few hundred vertices and dozens fit in a millisecond, while a count
    // cap throttles streaming with the frame rate (slow devices fell behind
    // exactly when they could least afford it)
    {
      const t0 = performance.now();
      const ms = this.buildBudget * 1.6;
      let n = 0;
      while (this.results.length > 0 &&
        (n < this.buildBudget || (n < 40 && performance.now() - t0 < ms))) {
        this.finalize(this.results.shift()!);
        n++;
      }
    }

    // re-plan when the centre has moved, the reach has changed, or coverage
    // did (finalize / fade end) — the latter rate-limited to a few Hz
    this.scanCooldown -= dt;
    const moved = Math.hypot(px - this.scanX, pz - this.scanZ) > 60 ||
      Math.abs(this.aglS - this.scanAgl) > 6;
    if (moved || (this.scanDirty && this.scanCooldown <= 0)) this.scan();

    // collapse edge eases toward the real shell hole
    if (this.edgeSnap) {
      this.edge = this.edgeTarget;
      this.edgeSnap = false;
    } else {
      const d = this.edgeTarget - this.edge;
      // outward: brisk when far behind (boot / respawn fill), inward: gentle
      const lim = (d > 0 ? Math.max(500, d * 0.8) : 200) * dt;
      this.edge += d > lim ? lim : d < -lim ? -lim : d;
    }

    // shader uniforms
    this.uCenter.value.set(px, pz);
    const eb = edgeBand(this.lod, this.edge);
    this.uBands[0].value.set(eb[0], eb[1]);
    for (let l = 1; l <= 3; l++) this.uBands[l].value.set(this.lod.band[l][0], this.lod.band[l][1]);
    this.uGrow[0].value.set(eb[0], eb[1]);
    for (let s = 1; s <= 2; s++) this.uGrow[s].value.set(this.lod.grow[s][0], this.lod.grow[s][1]);

    // far shell: swap in a freshly baked horizon
    if (this.farResult) {
      const p = this.farResult;
      this.farResult = null;
      this.finalizeFar(p);
    }

    this.feed();

    // recentre the horizon shell preferably when no chunk work is
    // outstanding — it's the biggest single job. But at cruise the queue may
    // NEVER fully drain (slower devices), and a starved shell drifts
    // kilometres stale then lurches forward in one visible step; past ~7 km
    // of drift the rebuild goes ahead of the chunk queue (one ~100 ms worker
    // job every few km — imperceptible).
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
        if (!this.chunks.has(keyOf(cx + dx, cz + dz))) return false;
    return true;
  }

  private centreDist(cx: number, cz: number): number {
    return Math.hypot((cx + 0.5) * CHUNK_SIZE - this.px, (cz + 0.5) * CHUNK_SIZE - this.pz);
  }

  private drop(c: Chunk): void {
    this.scene.remove(c.group);
    for (const d of c.disposables) d.dispose();
    this.chunks.delete(c.key);
    const i = this.fading.indexOf(c);
    if (i >= 0) {
      this.fading[i] = this.fading[this.fading.length - 1];
      this.fading.pop();
    }
  }

  /**
   * Re-plan the disc around the streaming centre: drop chunks that have left
   * it, queue every chunk whose level or scatter density should step, and
   * re-punch the shell hole to the coverage that actually exists. Coverage
   * is EUCLIDEAN (a disc) — the horizon seam reads as distance haze in every
   * direction instead of a square platform.
   */
  private scan(): void {
    const f = this.lod;
    const px = this.px;
    const pz = this.pz;
    this.scanX = px;
    this.scanZ = pz;
    this.scanAgl = this.aglS;
    this.scanDirty = false;
    this.scanCooldown = 0.07;

    // 1. chunks beyond the disc go — but only once fully collapsed onto the
    // shell (the edge can lag the load radius while it slews inward on a
    // descent), so the hand-back to the shell changes no pixel
    for (const c of this.chunks.values()) {
      const dc = this.centreDist(c.cx, c.cz);
      if (dc > f.load + DEL_HYST && (dc - CHUNK_R > this.edge + 30 || dc > f.load + 4000)) {
        this.drop(c);
      }
    }

    // 2. plan builds, nearest first; note the closest hole in coverage
    this.queue.length = 0;
    const ccx = Math.floor(px / CHUNK_SIZE);
    const ccz = Math.floor(pz / CHUNK_SIZE);
    const r = Math.ceil((f.load + DEL_HYST) / CHUNK_SIZE) + 1;
    let gap = Infinity;
    for (let dz = -r; dz <= r; dz++) {
      const cz = ccz + dz;
      const mz = (cz + 0.5) * CHUNK_SIZE - pz;
      for (let dx = -r; dx <= r; dx++) {
        const cx = ccx + dx;
        const mx = (cx + 0.5) * CHUNK_SIZE - px;
        const dc = Math.hypot(mx, mz);
        if (dc >= f.load + DEL_HYST) continue;
        const c = this.chunks.get(keyOf(cx, cz));
        if (!c) {
          if (dc >= f.load) continue;
          const nx = Math.max(Math.abs(mx) - HALF, 0);
          const nz = Math.max(Math.abs(mz) - HALF, 0);
          const dn = Math.hypot(nx, nz);
          if (dn < gap) gap = dn;
        }
        if (planStep(f, dc, c ? c.level : -1, c ? c.scatter : 0)) this.queue.push({ cx, cz, dc });
      }
    }
    this.queue.sort((a, b) => a.dc - b.dc);

    // 3. the shell hole must NEVER outrun real coverage: where streaming
    // lags, the shell keeps underlying the gap (no sky-dome void), and the
    // collapse edge retreats with it
    // (the punched hole may sit up to a re-punch step off-centre: keep that
    // much clear of the nearest missing chunk as well)
    const hole = Math.max(Math.min(f.hole, gap - HOLE_STEP - 30), 0);
    this.edgeTarget = Math.max(hole - SHELL_SLACK, 0);
    if (Math.abs(hole - this.holeR) > 25 || Math.hypot(px - this.holeX, pz - this.holeZ) > HOLE_STEP - 60) {
      this.holeX = px;
      this.holeZ = pz;
      this.holeR = hole;
      this.rebuildFarIndex();
    }
  }

  /** Keep the worker fed, nearest jobs first. */
  private feed(): void {
    // (results are bounded too: uploads are budgeted per frame, and baking
    // far ahead of them only makes payloads stale)
    while (this.inFlight < MAX_INFLIGHT && this.results.length < 48 && this.queue.length > 0) {
      const job = this.queue.shift()!;
      const key = keyOf(job.cx, job.cz);
      if (this.pending.has(key)) continue;
      const c = this.chunks.get(key);
      // never swap a chunk whose arrival fade is still running: the next
      // mesh's start look assumes this one has settled (re-planned when the
      // fade ends)
      if (c && c.fadeT < 1) continue;
      const step = planStep(this.lod, this.centreDist(job.cx, job.cz), c ? c.level : -1, c ? c.scatter : 0);
      if (!step) continue;
      this.pending.set(key, step.level * 4 + step.scatter);
      const res = LEVEL_RES[step.level];
      // morph data always reaches the PARENT level (the shell for level 0)
      const prev = step.level > 0 ? res / 2 : 0;
      const shellCell = this.farGeo ? this.farGeoCell : this.farCellSize;
      if (this.worker) {
        this.inFlight++;
        this.worker.postMessage({
          type: 'build', cx: job.cx, cz: job.cz, res, scatter: step.scatter, prev, shellCell,
        });
      } else {
        // synchronous fallback: one chunk per frame at most
        this.results.push(buildChunkPayload(this.gen, job.cx, job.cz, res, step.scatter, prev, shellCell));
        break;
      }
    }
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

  /** DEBUG: build the far shell synchronously right now (shellonly/lodtint
   *  screenshots race the worker under virtual-time headless capture). */
  forceFarBuild(px: number, pz: number): void {
    const snap = this.farSnap();
    this.finalizeFar(buildFarPayload(
      this.gen,
      Math.round(px / snap) * snap,
      Math.round(pz / snap) * snap,
      this.farCells,
      this.farCellSize,
    ));
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
    // 16-bit indices whenever the lattice allows (every preset): the hole
    // is re-punched several times a second at speed, and this halves the
    // upload
    const nIdx = p.cells * p.cells * 6;
    this.farIndexArr = (p.cells + 1) * (p.cells + 1) <= 65535 ? new Uint16Array(nIdx) : new Uint32Array(nIdx);
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
   * Re-index the shell, skipping quads fully inside the hole disc (the area
   * detailed chunks ACTUALLY cover, centred on the streaming centre). Index-
   * only: vertices stay put, so this is cheap enough to run every ~200 m.
   */
  private rebuildFarIndex(): void {
    if (!this.farGeo || !this.farIndexArr) return;
    const cells = this.farGeoCells;
    const cs = this.farGeoCell;
    const half = (cells * cs) / 2;
    const ccx = this.holeX;
    const ccz = this.holeZ;
    const holeR2 = this.holeR > 0 && !this.shellOnly ? this.holeR * this.holeR : -1;
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
   * A Lambert clone whose vertices blend from the PARENT look (baseY /
   * baseCol / baseNrm — the coarser level, or the far shell for level 0) to
   * their own, by each vertex's distance from the streaming centre inside
   * this level's band. Shape, paint and shading all ride the same factor.
   * All clones share one GL program via the custom cache key.
   */
  private makeChunkMat(level: number, fade: { value: THREE.Vector2 }): THREE.MeshLambertMaterial {
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uCenter = this.uCenter;
      sh.uniforms.uBand = this.uBands[level];
      sh.uniforms.uFade = fade;
      sh.uniforms.uDbg = this.uDbg;
      sh.uniforms.uTint = { value: LEVEL_TINT[level] };
      sh.vertexShader =
        'attribute float baseY;\nattribute vec3 baseCol;\nattribute vec3 baseNrm;\n' +
        'uniform vec2 uCenter;\nuniform vec2 uBand;\nuniform vec2 uFade;\n' +
        'uniform float uDbg;\nuniform vec3 uTint;\nvarying vec3 vTWorld;\n' +
        sh.vertexShader
          // the blend factor comes first: colour, normal and position all
          // use it. Distance is horizontal, from the streaming centre.
          .replace(
            '#include <color_vertex>',
            '\tfloat tDist = distance((modelMatrix * vec4(position, 1.0)).xz, uCenter);' +
            '\n\tfloat tM = mix(uFade.x, 1.0 - smoothstep(uBand.x, uBand.y, tDist), uFade.y);' +
            '\n\t#include <color_vertex>' +
            '\n\tvColor.rgb = mix(baseCol, vColor.rgb, tM);' +
            '\n\tvColor.rgb = mix(vColor.rgb, uTint * (0.35 + 0.65 * tM), uDbg);',
          )
          .replace(
            '#include <beginnormal_vertex>',
            '#include <beginnormal_vertex>\n\tobjectNormal = normalize(mix(baseNrm, objectNormal, tM));',
          )
          .replace(
            '#include <begin_vertex>',
            '#include <begin_vertex>\n\ttransformed.y = mix(baseY, position.y, tM);' +
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
    mat.customProgramCacheKey = () => 'terrain-dlod';
    return mat;
  }

  /**
   * Scatter material: instances scale from their own base point by distance
   * inside a grow band (trees, rocks and houses shrink into the ground
   * before their chunk drops to a sparser density; city towers ride the far
   * collapse edge). Materials are SHARED per (kind, band) — only a fresh
   * chunk arriving inside a band gets its own clone, for the arrival fade.
   */
  private growMat(
    base: THREE.MeshLambertMaterial, kind: number, band: number, fade: { value: number } | null,
  ): THREE.MeshLambertMaterial {
    const id = kind * 3 + band;
    if (!fade) {
      const hit = this.growMats.get(id);
      if (hit) return hit;
    }
    const mat = base.clone();
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uCenter = this.uCenter;
      sh.uniforms.uGBand = this.uGrow[band];
      sh.uniforms.uGFade = fade ?? GROW_ONE;
      sh.vertexShader =
        'uniform vec2 uCenter;\nuniform vec2 uGBand;\nuniform float uGFade;\n' +
        sh.vertexShader.replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>' +
          '\n\ttransformed *= (1.0 - smoothstep(uGBand.x, uGBand.y, distance(instanceMatrix[3].xz, uCenter))) * uGFade;',
        );
    };
    mat.customProgramCacheKey = () => (base.map ? 'tower-dgrow' : 'scatter-dgrow');
    if (!fade) this.growMats.set(id, mat);
    return mat;
  }

  /** Obstruction-beacon material: rides its tower's grow (instanceColor.r
   *  carries the tower height, so the lamp stays on the rising roof). */
  private makeBeaconMat(): THREE.MeshBasicMaterial {
    const mat = new THREE.MeshBasicMaterial({ color: 0xff2a2a, transparent: true, opacity: 0.9 });
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uCenter = this.uCenter;
      sh.uniforms.uGBand = this.uGrow[0];
      sh.vertexShader =
        'uniform vec2 uCenter;\nuniform vec2 uGBand;\n' +
        sh.vertexShader
          .replace('#include <color_vertex>', '#include <color_vertex>\n\tvColor.rgb = vec3(1.0);')
          .replace(
            '#include <begin_vertex>',
            '#include <begin_vertex>' +
            '\n\tfloat bG = 1.0 - smoothstep(uGBand.x, uGBand.y, distance(instanceMatrix[3].xz, uCenter));' +
            '\n\ttransformed *= bG;\n\ttransformed.y += instanceColor.r * (bG - 1.0);',
          );
    };
    mat.customProgramCacheKey = () => 'beacon-dgrow';
    return mat;
  }

  /** Wrap a worker payload in GPU objects and swap it into the scene. */
  private finalize(p: ChunkPayload): void {
    const key = keyOf(p.cx, p.cz);
    const level = levelOfRes(p.res);
    if (this.pending.get(key) === level * 4 + p.scatter) this.pending.delete(key);
    this.scanDirty = true;

    const f = this.lod;
    const dc = this.centreDist(p.cx, p.cz);
    const old = this.chunks.get(key);
    let start: -1 | 0 | 1 = 0;
    let onTime = true;
    if (!old) {
      // flew away while it was baking?
      if (wantLevel(f, dc, -1) < 0) { this.stats.dropped++; return; }
      this.stats.fresh++;
      // a fresh chunk should arrive collapsed onto the shell: level 0, past
      // the edge
      if (level !== 0 || dc - CHUNK_R < this.uBands[0].value.y - 1) {
        onTime = false;
        if (this.farMesh) this.stats.lateFresh++;
      }
    } else {
      // only the step that is STILL wanted may land: plans can flip while a
      // payload bakes (a turn, a climb), and a stale swap would not be
      // between identical surfaces
      const step = planStep(f, dc, old.level, old.scatter);
      if (!step || step.level !== level || (level === old.level && step.scatter !== p.scatter)) {
        this.stats.dropped++;
        return;
      }
      start = step.start;
      if (level !== old.level) {
        this.stats.swaps++;
        // seam check: finer mesh fully collapsed, coarser fully itself
        const fine = Math.max(level, old.level);
        const coarse = fine - 1;
        const fineOuter = this.uBands[fine].value.y;
        const coarseInner = this.uBands[coarse].value.x;
        if (dc - CHUNK_R < fineOuter - 1 || dc + CHUNK_R > coarseInner + 1) {
          onTime = false;
          this.stats.late++;
          if (this.logLate) {
            console.warn(`late swap ${old.level}→${level} dc=${dc.toFixed(0)} T=${f.T.map((v) => v.toFixed(0))} ` +
              `fineOuter=${fineOuter.toFixed(0)} coarseInner=${coarseInner.toFixed(0)} agl=${this.aglS.toFixed(0)} ` +
              `q=${this.queue.length} pend=${this.pending.size} res=${this.results.length}`);
          }
        }
      }
      this.drop(old);
    }

    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(p.positions, 3));
    geo.setAttribute('normal', new THREE.BufferAttribute(p.normals, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(p.colors, 3));
    geo.setAttribute('baseY', new THREE.BufferAttribute(p.baseY, 1));
    geo.setAttribute('baseCol', new THREE.BufferAttribute(p.baseCols, 3));
    geo.setAttribute('baseNrm', new THREE.BufferAttribute(p.baseNrms, 3));
    geo.setIndex(new THREE.BufferAttribute(p.index, 1));
    // the shader displaces vertices between two surfaces: bound both
    geo.computeBoundingSphere();
    {
      let lo = Infinity;
      let hi = -Infinity;
      for (let i = 0; i < p.baseY.length; i++) {
        const b = p.baseY[i];
        const y = p.positions[i * 3 + 1];
        if (b < lo) lo = b;
        if (y < lo) lo = y;
        if (b > hi) hi = b;
        if (y > hi) hi = y;
      }
      const bs = geo.boundingSphere!;
      bs.center.set(HALF, (lo + hi) / 2, HALF);
      bs.radius = Math.hypot(CHUNK_R + 80, (hi - lo) / 2 + 20);
    }

    // an on-time arrival starts exactly where its distance blend already is
    // — no fade needed (and no later swap deferred behind one)
    if (onTime) start = -1;
    const fade = { value: new THREE.Vector2(start < 0 ? 0 : start, start < 0 ? 1 : 0) };
    const mat = this.makeChunkMat(level, fade);

    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(p.cx * CHUNK_SIZE, 0, p.cz * CHUNK_SIZE);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();

    const group = new THREE.Group();
    group.add(mesh);
    const disposables: Array<{ dispose(): void }> = [geo, mat];

    // Scatter lists at a lower density are an exact prefix of the same lists
    // at a higher one (per-category RNG streams, shorter loops): the level-1
    // prefix and the level-2 suffix simply ride different grow bands, so a
    // density change never moves, adds or removes a visible object.
    // A fresh chunk landing INSIDE a grow band (boot, respawn, lag) eases
    // its instances in with the terrain's arrival fade.
    const hasInstances = p.scatter > 0 || p.towerMats.length + p.glassMats.length > 0;
    const freshFade = !old && hasInstances && !onTime ? { value: 0 } : null;
    const emit = (
      geo: THREE.BufferGeometry, base: THREE.MeshLambertMaterial, kind: number, band: number,
      mats: Float32Array, tints: Float32Array, i0: number, n: number,
    ): void => {
      if (n <= 0) return;
      const mat = this.growMat(base, kind, band, freshFade);
      const im = new THREE.InstancedMesh(geo, mat, n);
      (im.instanceMatrix.array as Float32Array).set(mats.subarray(i0 * 16, (i0 + n) * 16));
      im.instanceMatrix.needsUpdate = true;
      if (tints.length > 0) {
        im.instanceColor = new THREE.InstancedBufferAttribute(tints.slice(i0 * 3, (i0 + n) * 3), 3);
      }
      group.add(im);
      if (freshFade) disposables.push(mat);
      disposables.push({ dispose: () => im.dispose() });
    };
    const lists: Array<[THREE.BufferGeometry, THREE.MeshLambertMaterial, number, Float32Array, Float32Array]> = [
      [this.treeGeo, this.treeMat, 0, p.treeMats, p.treeTints],
      [this.leafGeo, this.treeMat, 0, p.leafMats, p.leafTints],
      [this.rockGeo, this.treeMat, 0, p.rockMats, p.rockTints],
      [this.houseGeo, this.houseMat, 1, p.houseMats, p.houseTints],
    ];
    lists.forEach(([g, base, kind, mats, tints], li) => {
      const count = mats.length / 16;
      const n1 = Math.min(p.l1[li] ?? count, count);
      emit(g, base, kind, 1, mats, tints, 0, n1);
      emit(g, base, kind, 2, mats, tints, n1, count - n1);
    });
    emit(this.towerGeo, this.towerMat, 2, 0, p.towerMats, p.towerTints, 0, p.towerMats.length / 16);
    emit(this.towerGeo, this.glassMat, 3, 0, p.glassMats, p.glassTints, 0, p.glassMats.length / 16);

    // night: red obstruction beacons on the tall towers (matrices are
    // composeYRot, so el[5] = height and el[12..14] = base position)
    if (this.beaconMat && this.beaconGeo) {
      const tops: number[] = [];
      for (const arr of [p.towerMats, p.glassMats]) {
        for (let i = 0; i < arr.length; i += 16) {
          const sy = arr[i + 5];
          if (sy > 150) tops.push(arr[i + 12], arr[i + 13] + sy + 3, arr[i + 14], sy + 3);
        }
      }
      if (tops.length > 0) {
        const nB = tops.length / 4;
        const bm = new THREE.InstancedMesh(this.beaconGeo, this.beaconMat, nB);
        const bmm = new THREE.Matrix4();
        const heights = new Float32Array(nB * 3);
        for (let i = 0; i < nB; i++) {
          bmm.makeTranslation(tops[i * 4], tops[i * 4 + 1], tops[i * 4 + 2]);
          bm.setMatrixAt(i, bmm);
          heights[i * 3] = tops[i * 4 + 3];
        }
        bm.instanceMatrix.needsUpdate = true;
        bm.instanceColor = new THREE.InstancedBufferAttribute(heights, 3);
        group.add(bm);
        disposables.push({ dispose: () => bm.dispose() });
      }
    }

    group.visible = !this.shellOnly;
    this.scene.add(group);
    const chunk: Chunk = {
      key, cx: p.cx, cz: p.cz, level, scatter: p.scatter, group, disposables,
      fade, fadeT: start < 0 ? 1 : 0, gFade: freshFade,
    };
    this.chunks.set(key, chunk);
    if (chunk.fadeT < 1) this.fading.push(chunk);
  }
}

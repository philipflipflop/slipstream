/**
 * Solid-object collision: towers, houses, trees and rock pinnacles are as
 * real as the terrain. Hit volumes are derived from the SAME buildScatter
 * lists the renderer instances (see terrainBuilder.ts), cached per chunk —
 * so what you see is exactly what you hit, with zero placement duplication.
 * Pure module (no three.js/DOM): runs in the Node test harness.
 */
import { WorldGen } from './heightfield';
import { buildScatter, CHUNK_SIZE, ScatterLists } from './terrainBuilder';

interface Solid {
  box: boolean;  // axis-aligned box (hx/hz half-extents) vs vertical cylinder (hx radius)
  x: number;
  z: number;
  top: number;   // absolute height of the solid's top, metres
  hx: number;
  hz: number;
  reason: string;
}

const BUILDING = 'FLEW INTO A BUILDING';
const TREE = 'FLEW INTO THE TREES';
const ROCK = 'STRUCK A ROCK PINNACLE';

export class ObstacleField {
  private cache = new Map<string, Solid[]>();

  constructor(private gen: WorldGen) {}

  private forChunk(cx: number, cz: number): Solid[] {
    const key = `${cx},${cz}`;
    let list = this.cache.get(key);
    if (!list) {
      if (this.cache.size >= 48) {
        // Maps iterate in insertion order — drop the oldest entry
        const oldest = this.cache.keys().next().value;
        if (oldest !== undefined) this.cache.delete(oldest);
      }
      list = solidsFrom(buildScatter(this.gen, cx, cz, 2));
      this.cache.set(key, list);
    }
    return list;
  }

  /** Pre-bake the 3×3 chunks around (x,z), at most one build per call, so
   *  collision lookups near the aircraft never pay generation cost inline. */
  warm(x: number, z: number): void {
    const cx = Math.floor(x / CHUNK_SIZE);
    const cz = Math.floor(z / CHUNK_SIZE);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (!this.cache.has(`${cx + dx},${cz + dz}`)) {
          this.forChunk(cx + dx, cz + dz);
          return;
        }
      }
    }
  }

  /** Crash reason if (x,y,z) with clearance r is inside a solid, else null. */
  hit(x: number, y: number, z: number, r = 2): string | null {
    // widest reach of a solid whose owning block centre sits in a neighbour
    // chunk (tower half-extent + in-block jitter)
    const m = 60;
    const c0x = Math.floor((x - m) / CHUNK_SIZE);
    const c1x = Math.floor((x + m) / CHUNK_SIZE);
    const c0z = Math.floor((z - m) / CHUNK_SIZE);
    const c1z = Math.floor((z + m) / CHUNK_SIZE);
    for (let cz = c0z; cz <= c1z; cz++) {
      for (let cx = c0x; cx <= c1x; cx++) {
        for (const s of this.forChunk(cx, cz)) {
          if (y - r > s.top) continue;
          const dx = x - s.x;
          const dz = z - s.z;
          if (s.box) {
            if (Math.abs(dx) < s.hx + r && Math.abs(dz) < s.hz + r) return s.reason;
          } else {
            const rr = s.hx + r;
            if (dx * dx + dz * dz < rr * rr) return s.reason;
          }
        }
      }
    }
    return null;
  }

  /** Point test for projectiles. */
  solidAt(x: number, y: number, z: number): boolean {
    return this.hit(x, y, z, 0) !== null;
  }
}

/** Iterate T·R_y·S instance matrices: translation + recovered x/y/z scales. */
function eachInstance(
  mats: number[],
  fn: (x: number, y: number, z: number, sx: number, sy: number, sz: number) => void,
): void {
  for (let o = 0; o + 16 <= mats.length; o += 16) {
    const sx = Math.hypot(mats[o], mats[o + 2]);
    const sz = Math.hypot(mats[o + 8], mats[o + 10]);
    fn(mats[o + 12], mats[o + 13], mats[o + 14], sx, mats[o + 5], sz);
  }
}

function solidsFrom(sc: ScatterLists): Solid[] {
  const out: Solid[] = [];
  // towers are axis-aligned unit boxes scaled to w×ht×d (heights are exact)
  const tower = (x: number, y: number, z: number, sx: number, sy: number, sz: number): void => {
    out.push({ box: true, x, z, top: y + sy, hx: sx / 2, hz: sz / 2, reason: BUILDING });
  };
  eachInstance(sc.towerMats, tower);
  eachInstance(sc.glassMats, tower);
  // rotated house boxes + roofs approximated as cylinders
  eachInstance(sc.houseMats, (x, y, z, sx, sy, sz) => {
    out.push({ box: false, x, z, top: y + sy * 1.45, hx: Math.max(sx, sz) * 0.62, hz: 0, reason: BUILDING });
  });
  // trees: trunk+canopy as one cylinder (conifer tops ~13·sy, broadleaf ~8.6·sy)
  eachInstance(sc.treeMats, (x, y, z, sx, sy) => {
    out.push({ box: false, x, z, top: y + sy * 12.5, hx: sx * 2.1, hz: 0, reason: TREE });
  });
  eachInstance(sc.leafMats, (x, y, z, sx, sy) => {
    out.push({ box: false, x, z, top: y + sy * 8.4, hx: sx * 2.6, hz: 0, reason: TREE });
  });
  // only tall rocks (mesa hoodoos) — ordinary boulders are terrain-scale
  eachInstance(sc.rockMats, (x, y, z, sx, sy) => {
    if (sy > 6) out.push({ box: false, x, z, top: y + sy * 0.8, hx: sx * 0.85, hz: 0, reason: ROCK });
  });
  return out;
}

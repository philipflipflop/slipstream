/**
 * The single analytic source of truth for the world: elevation, biomes,
 * forests, settlements AND airfields are all pure functions of (x, z).
 * The terrain mesh, object scattering, physics collision and the minimap
 * all sample the same functions, so what you see is exactly what you hit.
 *
 * Airfields come in two flavours: the hand-placed home cluster (AIRPORTS)
 * and procedural strips seeded on a sparse 12 km cell grid, generated
 * lazily and deterministically as you explore.
 */
import { Simplex2 } from '../core/noise';
import { clamp, lerp, smoothstep, hash2 } from '../core/math';

export const WATER_LEVEL = 0;
export const AIRPORT_ELEV = 8;

export interface AirfieldDef {
  name: string;
  code: string;   // single-letter minimap designator
  x: number;
  z: number;
  elev: number;
  length: number;
  width: number;
  major: boolean; // gets hangars, tower, apron buildings
  /** runway direction, rad clockwise from north (0 = runway 36/18) */
  heading: number;
  cosH: number;   // cached for the hot flatten/paint path
  sinH: number;
}

/** The home cluster runs north–south; procedural strips point anywhere. */
export const AIRPORTS: AirfieldDef[] = [
  { name: 'MERIDIAN FIELD', code: 'H', x: 0, z: 0, elev: AIRPORT_ELEV, length: 2400, width: 36, major: true, heading: 0, cosH: 1, sinH: 0 },
  { name: 'NORTHGATE STRIP', code: 'N', x: -2800, z: -16200, elev: 7, length: 1150, width: 26, major: false, heading: 0, cosH: 1, sinH: 0 },
  { name: 'HIGHMOOR FIELD', code: 'M', x: 14200, z: -8800, elev: 150, length: 1500, width: 30, major: false, heading: 0, cosH: 1, sinH: 0 },
];

/** Main field dimensions (back-compat for spawn + ring course). */
export const RUNWAY_LENGTH = AIRPORTS[0].length;
export const RUNWAY_WIDTH = AIRPORTS[0].width;

/** Procedural airfield grid: one candidate per CELL×CELL region. */
const CELL = 12000;
const cellKey = (cx: number, cz: number) => (cx + 8192) * 16384 + (cz + 8192);

const FIELD_NAMES = [
  'KESTREL', 'SADDLEBACK', 'REDSTONE', 'FOXTROT', 'WINDERMERE', 'CALDERA',
  'JUNIPER', 'HALCYON', 'BASALT', 'THISTLEDOWN', 'MIRAGE', 'OSPREY',
  'GRANITE', 'LANTERN', 'SOLSTICE', 'PILGRIM', 'COPPERLINE', 'DRIFTWOOD',
];

export class WorldGen {
  private terra: Simplex2;
  private moist: Simplex2;
  private town: Simplex2;
  private fieldCache = new Map<number, AirfieldDef | null>();
  private scratch: AirfieldDef[] = [];

  constructor(public readonly seed = 20260610) {
    this.terra = new Simplex2(seed);
    this.moist = new Simplex2(seed ^ 0x51f15e);
    this.town = new Simplex2(seed ^ 0x70a57);
  }

  /** Terrain elevation BEFORE runway flattening (used to site airfields). */
  baseHeightAt(x: number, z: number): number {
    const t = this.terra;

    // gentle domain warp keeps coastlines and ridgelines from looking gridded
    const wx = x + t.noise(x * 0.00022 + 53.1, z * 0.00022) * 1300;
    const wz = z + t.noise(x * 0.00022, z * 0.00022 + 97.7) * 1300;

    // continental mask — guarantee solid ground around the spawn airfield
    let c = t.fbm(wx * 0.000095, wz * 0.000095, 3);
    const r0 = Math.hypot(x, z);
    c += smoothstep(9000, 2000, r0) * 0.55; // spawn island boost
    // …and under the hand-placed outlying fields
    for (let i = 1; i < AIRPORTS.length; i++) {
      const ap = AIRPORTS[i];
      const dax = x - ap.x;
      const daz = z - ap.z;
      if (Math.abs(dax) < 5200 && Math.abs(daz) < 5200) {
        c += smoothstep(5200, 1400, Math.hypot(dax, daz)) * 0.5;
      }
    }
    const land = smoothstep(-0.32, 0.22, c);

    // continental shelf: deep ocean → coastal plains
    let e = lerp(-70, 16, land);

    // rolling hills on land
    e += t.fbm(wx * 0.0011, wz * 0.0011, 4) * 26 * land;

    // mountain ranges where the mountain mask bites
    const mm = smoothstep(0.22, 0.62, t.fbm(wx * 0.00016 + 777.7, wz * 0.00016, 3)) * land;
    if (mm > 0.001) {
      e += t.ridged(wx * 0.00042, wz * 0.00042, 5) * 820 * mm;
    }

    // fine surface detail
    e += t.noise(wx * 0.0065, wz * 0.0065) * 2.2 * land;

    // drain the marginal band around sea level: terrain that barely skims
    // the waterline either deepens into a proper lake or stays clearly dry.
    // Steep, decisive shorelines render cleanly at every LOD instead of
    // shimmering as coplanar slivers against the water sheet.
    const sea = e - 0.6;
    e -= 2.4 * Math.exp(-(sea * sea) / 5.76);

    return e;
  }

  /** Terrain elevation in metres at world (x, z), runways flattened in. */
  heightAt(x: number, z: number): number {
    let e = this.baseHeightAt(x, z);
    const n = this.gatherFields(x, z);
    for (let i = 0; i < n; i++) {
      const ap = this.scratch[i];
      const dax = x - ap.x;
      const daz = z - ap.z;
      const outer = ap.length * 1.05 + 800;
      if (Math.abs(dax) > outer || Math.abs(daz) > outer) continue;
      // rotate into the runway frame: `along` runs down the centreline
      const along = dax * ap.sinH - daz * ap.cosH;
      const across = dax * ap.cosH + daz * ap.sinH;
      const fr = Math.hypot(across, along * 0.45);
      const flat = smoothstep(outer, ap.length * 0.3 + 250, fr);
      if (flat > 0) e = lerp(e, ap.elev, flat);
    }
    return e;
  }

  /* ---------------- airfield grid ---------------- */

  /** The (possibly absent) procedural airfield of a 12 km grid cell. */
  fieldForCell(cx: number, cz: number): AirfieldDef | null {
    const key = cellKey(cx, cz);
    const hit = this.fieldCache.get(key);
    if (hit !== undefined) return hit;
    const f = this.makeField(cx, cz);
    this.fieldCache.set(key, f);
    return f;
  }

  private makeField(cx: number, cz: number): AirfieldDef | null {
    // roughly half the cells host a candidate; terrain rejects (water,
    // mountains) thin that out further → strips every ~15-25 km of land
    if (hash2(cx * 3 + 11, cz * 5 - 17) > 0.52) return null;

    const jx = (hash2(cx * 7 + 1, cz * 7 + 3) - 0.5) * 6000;
    const jz = (hash2(cx * 13 + 5, cz * 11 + 9) - 0.5) * 6000;
    const ax = cx * CELL + CELL / 2 + jx;
    const az = cz * CELL + CELL / 2 + jz;

    // stay clear of the hand-placed home cluster
    for (const ap of AIRPORTS) {
      if (Math.hypot(ax - ap.x, az - ap.z) < 9000) return null;
    }

    // each strip gets its own runway direction (25° steps, ±75° off north)
    const heading = (Math.floor(hash2(cx * 23 + 13, cz * 29 - 5) * 7) - 3) * 0.4363;
    const sinH = Math.sin(heading);
    const cosH = Math.cos(heading);

    // must sit on plausibly flat, dry land along the runway direction
    const elev = this.baseHeightAt(ax, az);
    if (elev < 4 || elev > 240) return null;
    if (Math.abs(this.baseHeightAt(ax + sinH * 800, az - cosH * 800) - elev) > 35) return null;
    if (Math.abs(this.baseHeightAt(ax - sinH * 800, az + cosH * 800) - elev) > 35) return null;

    const h3 = hash2(cx * 17 - 3, cz * 19 + 7);
    const name = `${FIELD_NAMES[Math.floor(hash2(cx + 31, cz - 47) * FIELD_NAMES.length)]} STRIP`;
    return {
      name,
      code: name[0],
      x: ax,
      z: az,
      elev,
      length: 1100 + Math.floor(h3 * 3) * 280,
      width: 26,
      major: false,
      heading,
      cosH,
      sinH,
    };
  }

  /** Every airfield (fixed + procedural) within `radius` of (x, z). */
  airfieldsNear(x: number, z: number, radius: number, out: AirfieldDef[] = []): AirfieldDef[] {
    out.length = 0;
    for (const ap of AIRPORTS) {
      if (Math.hypot(x - ap.x, z - ap.z) < radius) out.push(ap);
    }
    const r = Math.ceil(radius / CELL);
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    for (let dz = -r; dz <= r; dz++) {
      for (let dx = -r; dx <= r; dx++) {
        const f = this.fieldForCell(cx + dx, cz + dz);
        if (f && Math.hypot(x - f.x, z - f.z) < radius) out.push(f);
      }
    }
    return out;
  }

  /**
   * Fill the scratch list with every airfield whose flatten/paint influence
   * could reach (x,z): the fixed trio plus the 3×3 surrounding grid cells.
   * Returns the count. (Scratch is reused — don't hold references.)
   */
  private gatherFields(x: number, z: number): number {
    const s = this.scratch;
    let n = 0;
    for (const ap of AIRPORTS) s[n++] = ap;
    const cx = Math.floor(x / CELL);
    const cz = Math.floor(z / CELL);
    for (let dz = -1; dz <= 1; dz++) {
      for (let dx = -1; dx <= 1; dx++) {
        const f = this.fieldForCell(cx + dx, cz + dz);
        if (f) s[n++] = f;
      }
    }
    return n;
  }

  /* ---------------- sampling helpers ---------------- */

  /** Approximate surface normal via central differences. */
  normalAt(x: number, z: number, eps = 4): { x: number; y: number; z: number } {
    const hl = this.heightAt(x - eps, z);
    const hr = this.heightAt(x + eps, z);
    const hd = this.heightAt(x, z - eps);
    const hu = this.heightAt(x, z + eps);
    const nx = hl - hr;
    const nz = hd - hu;
    const ny = 2 * eps;
    const il = 1 / Math.hypot(nx, ny, nz);
    return { x: nx * il, y: ny * il, z: nz * il };
  }

  /** 0..1 forest density. */
  forestAt(x: number, z: number): number {
    const f = this.moist.fbm(x * 0.0008, z * 0.0008, 3);
    return smoothstep(0.05, 0.42, f);
  }

  /** 0..1 settlement (buildings) density. */
  settlementAt(x: number, z: number): number {
    const s = this.town.fbm(x * 0.00035 + 31.4, z * 0.00035, 2);
    return smoothstep(0.34, 0.6, s);
  }

  /** 0..1 dryness used to tint grass. */
  drynessAt(x: number, z: number): number {
    return clamp(this.moist.noise(x * 0.0003 + 500, z * 0.0003) * 0.5 + 0.5, 0, 1);
  }

  /** True if (x,z) sits on any flattened airfield apron. */
  isOnApron(x: number, z: number): boolean {
    const n = this.gatherFields(x, z);
    for (let i = 0; i < n; i++) {
      const ap = this.scratch[i];
      const dax = x - ap.x;
      const daz = z - ap.z;
      const along = dax * ap.sinH - daz * ap.cosH;
      const across = dax * ap.cosH + daz * ap.sinH;
      if (Math.hypot(across, along * 0.45) < ap.length * 0.3 + 300) return true;
    }
    return false;
  }

  /** True if (x,z) is on any paved runway strip. */
  isOnRunway(x: number, z: number): boolean {
    const n = this.gatherFields(x, z);
    for (let i = 0; i < n; i++) {
      const ap = this.scratch[i];
      const dax = x - ap.x;
      const daz = z - ap.z;
      const along = dax * ap.sinH - daz * ap.cosH;
      const across = dax * ap.cosH + daz * ap.sinH;
      if (
        Math.abs(across) < ap.width * 0.5 + 6 &&
        Math.abs(along) < ap.length * 0.5 + 30
      ) return true;
    }
    return false;
  }

  /**
   * Biome colour at a point, written into out[] as r,g,b (0..1).
   * `h` is elevation, `slope` 0(flat)..1(cliff).
   */
  colorAt(x: number, z: number, h: number, slope: number, out: number[]): void {
    const dry = this.drynessAt(x, z);
    const forest = this.forestAt(x, z);

    let r: number, g: number, b: number;

    if (h < WATER_LEVEL + 0.4) {
      // submerged: sandy shallows fading to dark seabed
      const d = smoothstep(0, -42, h);
      r = lerp(0.76, 0.05, d);
      g = lerp(0.7, 0.13, d);
      b = lerp(0.52, 0.2, d);
    } else if (h < WATER_LEVEL + 3.2) {
      r = 0.82; g = 0.74; b = 0.54;                       // beach sand
    } else if (h > 520 + dry * 160) {
      const sn = smoothstep(520, 700, h);
      r = lerp(0.45, 0.93, sn); g = lerp(0.42, 0.95, sn); b = lerp(0.4, 0.99, sn); // rock → snow
    } else {
      // grassland, tinted by dryness and darkened under forest
      r = lerp(0.3, 0.52, dry);
      g = lerp(0.52, 0.5, dry);
      b = lerp(0.22, 0.3, dry);
      const fr2 = forest * 0.55;
      r = lerp(r, 0.12, fr2); g = lerp(g, 0.3, fr2); b = lerp(b, 0.12, fr2);
    }

    // steep faces turn to bare rock
    const rock = smoothstep(0.42, 0.75, slope);
    if (rock > 0 && h > WATER_LEVEL + 1) {
      r = lerp(r, 0.42, rock); g = lerp(g, 0.38, rock); b = lerp(b, 0.36, rock);
    }

    // paved runway + apron tint (one gather covers both checks)
    if (h > WATER_LEVEL + 1) {
      const n = this.gatherFields(x, z);
      for (let i = 0; i < n; i++) {
        const ap = this.scratch[i];
        const dax = x - ap.x;
        const daz = z - ap.z;
        const along = dax * ap.sinH - daz * ap.cosH;
        const across = dax * ap.cosH + daz * ap.sinH;
        if (
          Math.abs(across) < ap.width * 0.5 + 6 &&
          Math.abs(along) < ap.length * 0.5 + 30
        ) {
          r = 0.16; g = 0.17; b = 0.19;
          break;
        }
        const fr = Math.hypot(across, along * 0.45);
        const inner = ap.length * 0.3 + 300;
        if (fr < inner) {
          const a = smoothstep(inner, inner * 0.55, fr) * 0.4;
          r = lerp(r, 0.34, a); g = lerp(g, 0.36, a); b = lerp(b, 0.3, a);
          break;
        }
      }
    }

    out[0] = r; out[1] = g; out[2] = b;
  }
}

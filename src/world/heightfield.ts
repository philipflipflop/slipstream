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

/** Selectable world themes ("maps"). All share the home airfield cluster. */
export type WorldTheme = 'archipelago' | 'mesa' | 'metro';

export const WORLDS: Array<{ id: WorldTheme; name: string; desc: string }> = [
  { id: 'archipelago', name: 'EMERALD ARCHIPELAGO', desc: 'Endless islands, forests and snow-capped ranges' },
  { id: 'mesa', name: 'REDSTONE MESA', desc: 'Layered desert plateaus carved by winding canyons' },
  { id: 'metro', name: 'MERIDIAN BAY', desc: 'A coastal metropolis — downtown towers and suburb grids' },
];

/** Downtown cores for the metro theme (deterministic, near the home field). */
const CITY_CENTERS = [
  { x: -5200, z: -2600, r: 3600, tall: 1 },    // downtown, west across the river
  { x: -9800, z: -7600, r: 2400, tall: 0.45 }, // midtown ridge
  { x: -3400, z: -10200, r: 2100, tall: 0.3 }, // north suburbs
  { x: 2600, z: -13800, r: 1900, tall: 0.35 }, // airport-north business park
  { x: -13600, z: 3400, r: 2700, tall: 0.7 },  // southport — second core down the coast
];

export interface AirfieldDef {
  name: string;
  code: string;   // single-letter minimap designator
  x: number;
  z: number;
  elev: number;
  length: number;
  width: number;
  major: boolean; // gets hangars, tower, apron buildings
  /** Heathrow-class international: twin parallel runways, central terminal
   *  spine, taxiways — the full intlBuildings layout */
  intl?: boolean;
  /** twin parallel runways (internationals): centre-to-centre spacing, m.
   *  The MAIN runway (length) sits at across −rwySep/2 (west for heading 0),
   *  the second (rwy2Len) at +rwySep/2. */
  rwySep?: number;
  rwy2Len?: number;
  /** runway direction, rad clockwise from north (0 = runway 36/18) */
  heading: number;
  cosH: number;   // cached for the hot flatten/paint path
  sinH: number;
}

/**
 * The fixed airports. Three Heathrow-class INTERNATIONALS (twin parallel
 * runways ~1.4 km apart, central terminal spine, taxiways) sit a realistic
 * 45-60 km from each other — spawn is Meridian Intl — plus two small
 * fields from the original home cluster. All run north–south; procedural
 * strips point anywhere.
 */
export const AIRPORTS: AirfieldDef[] = [
  { name: 'MERIDIAN INTL', code: 'M', x: 0, z: 0, elev: AIRPORT_ELEV, length: 3900, width: 45, major: true, intl: true, rwySep: 1400, rwy2Len: 3660, heading: 0, cosH: 1, sinH: 0 },
  { name: 'NORTHGATE STRIP', code: 'N', x: -2800, z: -16200, elev: 7, length: 1150, width: 26, major: false, heading: 0, cosH: 1, sinH: 0 },
  { name: 'HIGHMOOR FIELD', code: 'H', x: 14200, z: -8800, elev: 150, length: 1500, width: 30, major: true, heading: 0, cosH: 1, sinH: 0 },
  { name: 'WESTGATE INTL', code: 'W', x: -42000, z: -24000, elev: 14, length: 3700, width: 45, major: true, intl: true, rwySep: 1400, rwy2Len: 3500, heading: 0, cosH: 1, sinH: 0 },
  { name: 'OSPREY INTL', code: 'O', x: 36000, z: 34000, elev: 10, length: 3800, width: 45, major: true, intl: true, rwySep: 1400, rwy2Len: 3600, heading: 0, cosH: 1, sinH: 0 },
];

/**
 * International-airport building layout in the runway frame (along+ =
 * toward the northern end for heading 0, across+ = east). ONE source of
 * truth: airport.ts renders these boxes and obstacles.ts derives their
 * collision volumes, so terminals are exactly as solid as they look.
 */
export interface AptBuilding {
  along: number;  // centre, m along the runway axis
  across: number; // centre, m across it
  la: number;     // half-extent along
  wa: number;     // half-extent across
  h: number;      // height above the apron, m
  kind: 'terminal' | 'pier' | 'tower' | 'hangar';
}

const INTL_BUILDINGS: AptBuilding[] = (() => {
  const B: AptBuilding[] = [];
  // three terminals down the central spine, each with two pier fingers
  for (const ta of [-1050, 0, 1050]) {
    B.push({ along: ta, across: 0, la: 200, wa: 58, h: 26, kind: 'terminal' });
    B.push({ along: ta + 30, across: -170, la: 27, wa: 115, h: 13, kind: 'pier' });
    B.push({ along: ta + 30, across: 170, la: 27, wa: 115, h: 13, kind: 'pier' });
  }
  B.push({ along: 480, across: 275, la: 11, wa: 11, h: 87, kind: 'tower' });
  // maintenance/cargo hangars anchor the southern end of the spine
  B.push({ along: -1620, across: -160, la: 55, wa: 48, h: 19, kind: 'hangar' });
  B.push({ along: -1620, across: 130, la: 55, wa: 48, h: 19, kind: 'hangar' });
  return B;
})();

/** Buildings of an international airport (empty for anything else). */
export function intlBuildings(ap: AirfieldDef): AptBuilding[] {
  return ap.intl ? INTL_BUILDINGS : [];
}

/** Runway-frame → world for airport layout points. */
export function airfieldWorld(
  ap: AirfieldDef, along: number, across: number,
): { x: number; z: number } {
  return {
    x: ap.x + across * ap.cosH + along * ap.sinH,
    z: ap.z + across * ap.sinH - along * ap.cosH,
  };
}

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

  constructor(public readonly seed = 20260610, public readonly theme: WorldTheme = 'archipelago') {
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

    let e: number;
    if (this.theme === 'mesa') e = this.mesaHeight(x, z, wx, wz);
    else if (this.theme === 'metro') e = this.metroHeight(x, z, wx, wz);
    else e = this.islandHeight(x, z, wx, wz);

    // drain the marginal band around sea level: terrain that barely skims
    // the waterline either deepens into a proper lake or stays clearly dry.
    // Steep, decisive shorelines render cleanly at every LOD instead of
    // shimmering as coplanar slivers against the water sheet.
    const sea = e - 0.6;
    e -= 2.4 * Math.exp(-(sea * sea) / 5.76);

    return e;
  }

  /** Original theme: island chains, forests, big alpine ranges. */
  private islandHeight(x: number, z: number, wx: number, wz: number): number {
    const t = this.terra;

    // continental mask — guarantee solid ground around the spawn airfield
    let c = t.fbm(wx * 0.000095, wz * 0.000095, 3);
    c += this.spawnBoost(x, z);
    const land = smoothstep(-0.32, 0.22, c);

    // continental shelf: deep ocean → coastal plains
    let e = lerp(-70, 16, land);

    // rolling hills on land
    e += t.fbm(wx * 0.0011, wz * 0.0011, 4) * 26 * land;

    // mountain ranges where the mountain mask bites; range height itself
    // varies regionally so some massifs tower over their neighbours
    const mm = smoothstep(0.22, 0.62, t.fbm(wx * 0.00016 + 777.7, wz * 0.00016, 3)) * land;
    if (mm > 0.001) {
      const amp = 680 + (t.noise(wx * 0.00007 + 31.7, wz * 0.00007) * 0.5 + 0.5) * 420;
      e += t.ridged(wx * 0.00042, wz * 0.00042, 5) * amp * mm;
    }

    // fine surface detail
    e += t.noise(wx * 0.0065, wz * 0.0065) * 2.2 * land;
    return e;
  }

  /** Desert theme: stacked plateau terraces cut by winding canyon systems. */
  private mesaHeight(x: number, z: number, wx: number, wz: number): number {
    const t = this.terra;

    // almost all land; distant inland seas only
    let c = t.fbm(wx * 0.00006, wz * 0.00006, 3) + 0.5;
    c += this.spawnBoost(x, z);
    const land = smoothstep(-0.45, 0.05, c);
    let e = lerp(-45, 24, land);

    // terraced uplift: quantize a broad noise field into benches with sharp
    // risers — the classic stepped-mesa profile
    const h01 = clamp(t.fbm(wx * 0.00032, wz * 0.00032, 4) * 0.5 + 0.5, 0, 1);
    const bands = h01 * 4.3;
    const bench = Math.floor(bands);
    const riser = smoothstep(0.6, 0.96, bands - bench);
    e += (bench + riser) * 92 * land;

    // canyon cut: |noise| ridge inverted into deep winding channels whose
    // depth swells and shrinks along the run — gorges, not uniform trenches
    const can = Math.abs(t.noise(wx * 0.00017 + 99.3, wz * 0.00017));
    const canDepth = 70 + (t.noise(wx * 0.00011 + 5.1, wz * 0.00011) * 0.5 + 0.5) * 90;
    e -= smoothstep(0.16, 0.015, can) * canDepth * land;

    // sculpt: rocky shoulders + fine grit
    e += t.ridged(wx * 0.0014, wz * 0.0014, 3) * 9 * land;
    e += t.noise(wx * 0.006, wz * 0.006) * 2.4 * land;
    return e;
  }

  /** Metro theme: a sheltered bay, flat coastal plain, city districts, hills inland. */
  private metroHeight(x: number, z: number, wx: number, wz: number): number {
    const t = this.terra;

    let c = t.fbm(wx * 0.00009, wz * 0.00009, 3) + 0.18;
    c += this.spawnBoost(x, z);
    // carve the bay east of the home peninsula
    c -= smoothstep(10500, 4200, Math.hypot(x - 10500, z + 4500)) * 1.25;
    const land = smoothstep(-0.32, 0.22, c);

    let e = lerp(-48, 11, land);
    e += t.fbm(wx * 0.0009, wz * 0.0009, 4) * 13 * land; // gentle plain

    // green hills well inland
    const mm = smoothstep(0.34, 0.72, t.fbm(wx * 0.00013 + 777.7, wz * 0.00013, 3)) * land;
    if (mm > 0.001) e += t.ridged(wx * 0.0004, wz * 0.0004, 4) * 420 * mm;

    e += t.noise(wx * 0.0065, wz * 0.0065) * 1.6 * land;

    // city districts sit on graded, almost-flat ground
    const cm = this.cityMaskAt(x, z);
    if (cm > 0.001) {
      e = lerp(e, 6.5 + t.noise(x * 0.0007, z * 0.0007) * 1.4, cm * 0.94);
    }
    return e;
  }

  /** Continental boost guaranteeing dry ground around every fixed field
   *  (internationals carry a ~5 km footprint, so their boost reaches wider). */
  private spawnBoost(x: number, z: number): number {
    let c = smoothstep(9000, 2000, Math.hypot(x, z)) * 0.55;
    for (let i = 1; i < AIRPORTS.length; i++) {
      const ap = AIRPORTS[i];
      const R = ap.intl ? 8600 : 5200;
      const dax = x - ap.x;
      const daz = z - ap.z;
      if (Math.abs(dax) < R && Math.abs(daz) < R) {
        c += smoothstep(R, R * 0.27, Math.hypot(dax, daz)) * 0.5;
      }
    }
    return c;
  }

  /** 0..1 urban density (metro theme only): how "city" a point is. */
  cityMaskAt(x: number, z: number): number {
    if (this.theme !== 'metro') return 0;
    let m = 0;
    for (const cc of CITY_CENTERS) {
      const d = Math.hypot(x - cc.x, z - cc.z);
      if (d < cc.r) {
        const v = smoothstep(cc.r, cc.r * 0.3, d);
        if (v > m) m = v;
      }
    }
    // ragged district edges so the grid doesn't end in a circle
    if (m > 0.001 && m < 0.999) {
      m = clamp(m + this.town.noise(x * 0.0006 + 7.7, z * 0.0006) * 0.22, 0, 1);
    }
    return m;
  }

  /** True when a 104 m city block is a park square (kept green, no tower). */
  parkBlockAt(bx: number, bz: number): boolean {
    return this.town.noise(bx * 0.7 + 3.1, bz * 0.7) > 0.62;
  }

  /** 0..1 how strongly downtown (tall towers) a point is. */
  downtownAt(x: number, z: number): number {
    if (this.theme !== 'metro') return 0;
    let m = 0;
    for (const cc of CITY_CENTERS) {
      const d = Math.hypot(x - cc.x, z - cc.z);
      const v = smoothstep(cc.r * 0.55, cc.r * 0.12, d) * cc.tall;
      if (v > m) m = v;
    }
    return m;
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
    // about a third of the cells host a candidate; terrain rejects (water,
    // mountains) thin that out further → strips every ~25-40 km of land, a
    // realistic GA density now that the internationals anchor the map
    if (hash2(cx * 3 + 11, cz * 5 - 17) > 0.34) return null;

    const jx = (hash2(cx * 7 + 1, cz * 7 + 3) - 0.5) * 6000;
    const jz = (hash2(cx * 13 + 5, cz * 11 + 9) - 0.5) * 6000;
    const ax = cx * CELL + CELL / 2 + jx;
    const az = cz * CELL + CELL / 2 + jz;

    // stay clear of the hand-placed fields (wider berth around internationals)
    for (const ap of AIRPORTS) {
      if (Math.hypot(ax - ap.x, az - ap.z) < (ap.intl ? 14000 : 9000)) return null;
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
    const length = 1100 + Math.floor(h3 * 3) * 280;
    // the longest strips are proper regional fields: hangars, tower, apron
    const major = length > 1600;
    const name = `${FIELD_NAMES[Math.floor(hash2(cx + 31, cz - 47) * FIELD_NAMES.length)]} ${major ? 'REGIONAL' : 'STRIP'}`;
    return {
      name,
      code: name[0],
      x: ax,
      z: az,
      elev,
      length,
      width: major ? 30 : 26,
      major,
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
    let d = smoothstep(0.05, 0.42, f);
    if (this.theme === 'mesa') d *= 0.12; // scattered desert scrub
    else if (this.theme === 'metro') d *= 1 - this.cityMaskAt(x, z) * 0.92;
    return d;
  }

  /** 0..1 settlement (small houses) density. */
  settlementAt(x: number, z: number): number {
    const s = this.town.fbm(x * 0.00035 + 31.4, z * 0.00035, 2);
    let d = smoothstep(0.34, 0.6, s);
    if (this.theme === 'mesa') d *= 0.35;
    else if (this.theme === 'metro') {
      // houses ring the city as suburbs but give way to the tower grid
      const cm = this.cityMaskAt(x, z);
      d = Math.max(d, smoothstep(0.05, 0.3, cm)) * (1 - smoothstep(0.35, 0.6, cm));
    }
    return d;
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

  /** True if (x,z) is on any paved runway strip (both of a parallel pair). */
  isOnRunway(x: number, z: number): boolean {
    const n = this.gatherFields(x, z);
    for (let i = 0; i < n; i++) {
      const ap = this.scratch[i];
      const dax = x - ap.x;
      const daz = z - ap.z;
      const along = dax * ap.sinH - daz * ap.cosH;
      const across = dax * ap.cosH + daz * ap.sinH;
      if (ap.rwySep) {
        const half = ap.rwySep / 2;
        if (
          (Math.abs(across + half) < ap.width * 0.5 + 6 &&
            Math.abs(along) < ap.length * 0.5 + 30) ||
          (Math.abs(across - half) < ap.width * 0.5 + 6 &&
            Math.abs(along) < (ap.rwy2Len ?? ap.length) * 0.5 + 30)
        ) return true;
      } else if (
        Math.abs(across) < ap.width * 0.5 + 6 &&
        Math.abs(along) < ap.length * 0.5 + 30
      ) return true;
    }
    return false;
  }

  /**
   * Biome colour at a point, written into out[] as r,g,b (0..1).
   * `h` is elevation, `slope` 0(flat)..1(cliff). `texel` is the sampling
   * step of the mesh being painted — patterns finer than the sampling
   * (the 104 m city grid) fade to their average tone instead of aliasing
   * into vertex-colour moiré on coarse LODs and the far shell.
   */
  colorAt(x: number, z: number, h: number, slope: number, out: number[], texel = 0): void {
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
    } else if (this.theme === 'mesa') {
      // banded strata: rust / terracotta / cream layers riding the benches
      const band = (h + this.terra.noise(x * 0.0019, z * 0.0019) * 9) / 92;
      const f = band - Math.floor(band);
      const palette: Array<[number, number, number]> = [
        [0.62, 0.32, 0.2], [0.72, 0.44, 0.26], [0.78, 0.58, 0.38], [0.6, 0.38, 0.3],
      ];
      const idx = Math.floor(band) & 3;
      const [r1, g1, b1] = palette[idx];
      const [r2, g2, b2] = palette[(idx + 1) & 3];
      const k = smoothstep(0.82, 1, f);
      r = lerp(r1, r2, k); g = lerp(g1, g2, k); b = lerp(b1, b2, k);
      // canyon floors green up where water collects
      if (h < 16) {
        const v = smoothstep(16, 5, h) * 0.55;
        r = lerp(r, 0.32, v); g = lerp(g, 0.46, v); b = lerp(b, 0.24, v);
      }
      // scrub flecks
      const fr2 = forest * 0.5;
      r = lerp(r, 0.25, fr2); g = lerp(g, 0.38, fr2); b = lerp(b, 0.2, fr2);
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

    // metro: paint the urban fabric — asphalt street grid between concrete
    // blocks, with park squares left green. When the mesh can't resolve the
    // grid (coarse chunks, far shell) the whole fabric collapses to its
    // average tone — sampling a 13 m street pattern at 64–600 m otherwise
    // produces shimmering vertex-colour moiré across the entire city.
    const cm = this.cityMaskAt(x, z);
    if (cm > 0.18 && h > WATER_LEVEL + 1) {
      const gx = ((x % 104) + 104) % 104;
      const gz = ((z % 104) + 104) % 104;
      const street = gx < 13 || gz < 13;
      const park = this.parkBlockAt(Math.floor(x / 104), Math.floor(z / 104));
      const a = smoothstep(0.18, 0.45, cm);
      const gk = texel > 0 ? 1 - smoothstep(9, 28, texel) : 1; // grid resolvable?
      // resolved cell tone (parks keep the terrain green underneath)
      let cr = r, cg = g, cb = b, cw = 0;
      if (street) { cr = 0.2; cg = 0.21; cb = 0.23; cw = 1; }
      else if (!park) {
        const v = 0.5 + hash2(Math.floor(x / 104), Math.floor(z / 104)) * 0.16;
        cr = v; cg = v; cb = v * 0.98; cw = 0.85;
      }
      const w = a * lerp(0.8, cw, gk); // 0.8 = weight of the averaged fabric
      r = lerp(r, lerp(0.42, cr, gk), w);
      g = lerp(g, lerp(0.43, cg, gk), w);
      b = lerp(b, lerp(0.42, cb, gk), w);
    }

    // steep faces turn to bare rock
    const rock = smoothstep(0.42, 0.75, slope);
    if (rock > 0 && h > WATER_LEVEL + 1) {
      if (this.theme === 'mesa') {
        // exposed cliff strata stay warm-toned
        r = lerp(r, 0.56, rock * 0.6); g = lerp(g, 0.34, rock * 0.6); b = lerp(b, 0.24, rock * 0.6);
      } else {
        r = lerp(r, 0.42, rock); g = lerp(g, 0.38, rock); b = lerp(b, 0.36, rock);
      }
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
        // runway asphalt — both strips of a parallel pair
        const halfSep = ap.rwySep ? ap.rwySep / 2 : 0;
        const onMain = Math.abs(across + halfSep) < ap.width * 0.5 + 6 &&
          Math.abs(along) < ap.length * 0.5 + 30;
        const onSecond = !!ap.rwySep &&
          Math.abs(across - halfSep) < ap.width * 0.5 + 6 &&
          Math.abs(along) < (ap.rwy2Len ?? ap.length) * 0.5 + 30;
        if ((ap.rwySep ? onMain || onSecond : onMain)) {
          r = 0.16; g = 0.17; b = 0.19;
          break;
        }
        // internationals: the whole central slab between the parallels is
        // concrete (wide enough to survive every LOD's texel), with the
        // taxiway system painted darker INTO the terrain — same-texel paint
        // never z-fights the way overlay planes over mismatched tones do.
        // The taxi lines fade to the slab tone when the mesh can't resolve
        // them (coarse LODs, far shell), exactly like the city street grid.
        if (ap.intl && Math.abs(across) < 700 && Math.abs(along) < 1950) {
          const ac = Math.abs(across);
          const aAl = Math.abs(along);
          const a = smoothstep(700, 640, ac) * smoothstep(1950, 1800, aAl);
          let cr = 0.4, cg = 0.41, cb = 0.43; // apron/slab concrete
          const gk = texel > 0 ? 1 - smoothstep(10, 26, texel) : 1;
          if (gk > 0 && a > 0) {
            // parallel taxiways inside each runway + connector stubs
            const conn = ap.length / 2 - 240;
            const onPara = Math.abs(ac - 600) < 15 && aAl < conn + 15;
            const onConn = ac > 560 &&
              (aAl < 13 || Math.abs(aAl - 650) < 13 ||
                Math.abs(aAl - 1300) < 13 || Math.abs(aAl - conn) < 13);
            if (onPara || onConn) {
              cr = lerp(cr, 0.19, gk);
              cg = lerp(cg, 0.2, gk);
              cb = lerp(cb, 0.22, gk);
            }
          }
          r = lerp(r, cr, a); g = lerp(g, cg, a); b = lerp(b, cb, a);
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

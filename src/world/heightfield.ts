/**
 * The single analytic source of truth for the world: elevation, biomes,
 * forests and settlements are all pure functions of (x, z). The terrain
 * mesh, object scattering AND physics collision sample the same functions,
 * so what you see is exactly what you hit.
 */
import { Simplex2 } from '../core/noise';
import { clamp, lerp, smoothstep } from '../core/math';

export const WATER_LEVEL = 0;
export const AIRPORT_ELEV = 8;
/** Runway runs along the Z axis, centred at the origin. */
export const RUNWAY_LENGTH = 1500;
export const RUNWAY_WIDTH = 36;

export class WorldGen {
  private terra: Simplex2;
  private moist: Simplex2;
  private town: Simplex2;

  constructor(public readonly seed = 20260610) {
    this.terra = new Simplex2(seed);
    this.moist = new Simplex2(seed ^ 0x51f15e);
    this.town = new Simplex2(seed ^ 0x70a57);
  }

  /** Terrain elevation in metres at world (x, z). */
  heightAt(x: number, z: number): number {
    const t = this.terra;

    // gentle domain warp keeps coastlines and ridgelines from looking gridded
    const wx = x + t.noise(x * 0.00022 + 53.1, z * 0.00022) * 1300;
    const wz = z + t.noise(x * 0.00022, z * 0.00022 + 97.7) * 1300;

    // continental mask — guarantee solid ground around the spawn airfield
    let c = t.fbm(wx * 0.000095, wz * 0.000095, 3);
    const r0 = Math.hypot(x, z);
    c += smoothstep(9000, 2000, r0) * 0.55; // spawn island boost
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

    // flatten an elongated apron around the runway (longer along Z)
    const fr = Math.hypot(x, z * 0.45);
    const flat = smoothstep(2400, 650, fr);
    if (flat > 0) e = lerp(e, AIRPORT_ELEV, flat);

    return e;
  }

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

  /** True if (x,z) sits on the flattened airfield apron. */
  isOnApron(x: number, z: number): boolean {
    return Math.hypot(x, z * 0.45) < 900;
  }

  /** True if (x,z) is on the paved runway strip. */
  isOnRunway(x: number, z: number): boolean {
    return Math.abs(x) < RUNWAY_WIDTH * 0.5 + 6 && Math.abs(z) < RUNWAY_LENGTH * 0.5 + 30;
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

    // paved runway + apron tint
    if (this.isOnRunway(x, z)) {
      r = 0.16; g = 0.17; b = 0.19;
    } else if (this.isOnApron(x, z) && h > WATER_LEVEL + 1) {
      const a = smoothstep(900, 500, Math.hypot(x, z * 0.45)) * 0.4;
      r = lerp(r, 0.34, a); g = lerp(g, 0.36, a); b = lerp(b, 0.3, a);
    }

    out[0] = r; out[1] = g; out[2] = b;
  }
}

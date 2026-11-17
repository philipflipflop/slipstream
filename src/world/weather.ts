/**
 * Weather presets and the cloud-layer maths. Pure — no three.js/DOM — so the
 * rules (what you can see from where) run in the Node test harness.
 *
 * A weather is: an optional CLOUD DECK between two altitudes with a
 * coverage fraction, a visibility beneath it, rain, a wind range and a
 * turbulence level. The deck is a real layer: below it the light is grey
 * and the visibility is the weather's; inside it you see a wingspan or two;
 * above it the sun is out over an undercast. That is what gives the ILS a
 * job — in RAIN the runway appears at ~1,000 ft, in FOG at the flare.
 */

export type WeatherId = 'clear' | 'fair' | 'broken' | 'overcast' | 'rain' | 'fog';

export interface CloudDeck {
  /** m above sea level */
  base: number;
  top: number;
  /** fraction of the sky covered, 0..1 */
  cover: number;
  /** relief of the top, m: how far its valleys sit below `top` */
  relief: number;
  /** embedded cumulus rising ABOVE `top`, m (0 = none) */
  towers: number;
  /** ragged base, m: the general base sits this far above `base`, scud hangs down to it */
  ragged: number;
  /** thickness of the diffuse edge, m — cloud does not start at a surface */
  soft: number;
  /** 0 = long smooth swells … 1 = all small lumps */
  lumpy: number;
}

export interface WeatherPreset {
  id: WeatherId;
  name: string;
  desc: string;
  deck: CloudDeck | null;
  /** visibility beneath the deck, m (Infinity = whatever the day gives) */
  vis: number;
  /** visibility inside cloud, m */
  cloudVis: number;
  /** share of the fair-weather cumulus puffs kept */
  puffs: number;
  rain: number;
  /** surface wind range, kt */
  wind: [number, number];
  turb: number;
  /** beneath the deck: sunlight × this … */
  light: number;
  /** … and the sky this far toward grey */
  grey: number;
}

export const WEATHERS: WeatherPreset[] = [
  {
    id: 'clear', name: 'Clear', desc: 'Not a cloud; light airs',
    deck: null, vis: Infinity, cloudVis: 300, puffs: 0.2, rain: 0, wind: [0, 7], turb: 0.3, light: 1, grey: 0,
  },
  {
    id: 'fair', name: 'Fair', desc: 'Scattered cumulus, a breeze',
    deck: null, vis: Infinity, cloudVis: 300, puffs: 1, rain: 0, wind: [3, 15], turb: 0.45, light: 1, grey: 0,
  },
  {
    id: 'broken', name: 'Broken', desc: 'A broken layer at 4,300 ft — fly over, under or through',
    deck: { base: 1300, top: 1750, cover: 0.55, relief: 170, towers: 230, ragged: 60, soft: 45, lumpy: 0.3 },
    vis: 32000, cloudVis: 260, puffs: 1, rain: 0, wind: [5, 18], turb: 0.55, light: 0.8, grey: 0.3,
  },
  {
    id: 'overcast', name: 'Overcast', desc: 'Solid deck from 2,100 ft; sunshine on top at 5,000',
    deck: { base: 650, top: 1500, cover: 1, relief: 240, towers: 170, ragged: 70, soft: 60, lumpy: 0.26 },
    vis: 12000, cloudVis: 240, puffs: 0.3, rain: 0, wind: [5, 16], turb: 0.5, light: 0.42, grey: 0.85,
  },
  {
    id: 'rain', name: 'Rain', desc: 'Cloudbase 1,000 ft, 4 km in rain, gusty — instrument weather',
    deck: { base: 320, top: 2300, cover: 1, relief: 280, towers: 520, ragged: 110, soft: 110, lumpy: 0.13 },
    vis: 4500, cloudVis: 220, puffs: 0.25, rain: 1, wind: [10, 24], turb: 0.8, light: 0.3, grey: 1,
  },
  {
    id: 'fog', name: 'Fog', desc: 'Fog to 600 ft, 700 m beneath — blue sky above it',
    deck: { base: -400, top: 190, cover: 1, relief: 75, towers: 0, ragged: 0, soft: 50, lumpy: 0.2 },
    vis: 700, cloudVis: 700, puffs: 0.3, rain: 0, wind: [0, 5], turb: 0.15, light: 0.6, grey: 0.9,
  },
];

export const weatherById = (id: string | null | undefined): WeatherPreset =>
  WEATHERS.find((w) => w.id === id) ?? WEATHERS[1];

const sstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
};

/** soft edge of the layer, m: cloud does not start at a plane */
export const DECK_EDGE = 70;

/** 0..1 how deep INSIDE the layer altitude y is (vertical profile only). */
export function layerDensity(deck: CloudDeck | null, y: number): number {
  if (!deck) return 0;
  const edge = Math.min(DECK_EDGE, (deck.top - deck.base) * 0.3);
  return sstep(deck.base - edge * 0.3, deck.base + edge, y) * (1 - sstep(deck.top - edge, deck.top + edge * 0.3, y));
}

/** 1 beneath the deck … 0 above it: whose light and visibility apply. */
export function beneath(deck: CloudDeck | null, y: number): number {
  if (!deck) return 0;
  return 1 - sstep(deck.base, deck.top, y);
}

/**
 * How far you can see: `clear` is what the day and the altitude give;
 * beneath the deck the weather's own visibility caps it, and cloud
 * (`density` 0..1 at the eye — layer profile × local coverage) closes it
 * down to `cloudVis`. Density acts on the LOG of the range — halfway into
 * the edge of a cloud you have lost most of the view already.
 */
export function weatherVisibility(w: WeatherPreset, clear: number, y: number, density: number): number {
  const under = beneath(w.deck, y);
  let v = clear;
  if (w.vis < v) v = v + (w.vis - v) * under;
  if (density > 0) v = Math.exp(Math.log(v) + (Math.log(Math.min(w.cloudVis, v)) - Math.log(v)) * density);
  return v;
}

/* ---------------------------------------------------------------- fields ---- */

export const FIELD_N = 512;
/** one tile of a field, m (the lookups warp and rotate it — see deckSurfaces) */
export const FIELD_TILE = 26000;

/**
 * The coverage field of a broken layer: tileable fractal noise,
 * histogram-equalised so a threshold of (1 − cover) leaves exactly `cover`
 * of the sky cloudy. The renderer uploads the same numbers as a texture and
 * the sim samples them — where the picture shows a gap, there IS a gap.
 */
export function makeCoverField(seed = 7): Float32Array {
  return noiseField(seed, false);
}

/**
 * Tileable fractal GRADIENT noise as ranks 0..1. `billow` folds each octave
 * (|v|): rounded domes parted by narrow creases — the lumps of a cloud top —
 * and the ranks are then shaped so most of the area is dome.
 *
 * Why not the value noise this started as: value noise is blocky along its
 * lattice, and at 256² in 8 bits every texel edge was a crease and every
 * byte a 1 m terrace — under lighting the tops read as "constructed from
 * faintly noticeable squares and lines" (playtest). Hence gradient noise on
 * two lattices half a cell apart (no feature is pinned to a grid point),
 * 512², floats.
 */
function noiseField(seed: number, billow: boolean): Float32Array {
  const N = FIELD_N;
  const f = new Float32Array(N * N);
  const oct = new Float32Array(N * N);
  let s = seed >>> 0;
  const rnd = (): number => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  let amp = 1;
  for (let cells = 4; cells <= 64; cells *= 2) {
    oct.fill(0);
    for (let lattice = 0; lattice < 2; lattice++) {
      const gx = new Float32Array(cells * cells);
      const gy = new Float32Array(cells * cells);
      for (let i = 0; i < gx.length; i++) {
        const a = rnd() * Math.PI * 2;
        gx[i] = Math.cos(a);
        gy[i] = Math.sin(a);
      }
      const shift = lattice * 0.5;
      for (let y = 0; y < N; y++) {
        const fy = (y / N) * cells + shift;
        const y0 = Math.floor(fy);
        const ty = fy - y0;
        const sy = ty * ty * ty * (ty * (ty * 6 - 15) + 10);
        const r0 = (y0 % cells) * cells;
        const r1 = ((y0 + 1) % cells) * cells;
        const o = y * N;
        for (let x = 0; x < N; x++) {
          const fx = (x / N) * cells + shift;
          const x0 = Math.floor(fx);
          const tx = fx - x0;
          const sx = tx * tx * tx * (tx * (tx * 6 - 15) + 10);
          const c0 = x0 % cells;
          const c1 = (x0 + 1) % cells;
          const n00 = gx[r0 + c0] * tx + gy[r0 + c0] * ty;
          const n10 = gx[r0 + c1] * (tx - 1) + gy[r0 + c1] * ty;
          const n01 = gx[r1 + c0] * tx + gy[r1 + c0] * (ty - 1);
          const n11 = gx[r1 + c1] * (tx - 1) + gy[r1 + c1] * (ty - 1);
          const a = n00 + (n10 - n00) * sx;
          const b = n01 + (n11 - n01) * sx;
          oct[o + x] += a + (b - a) * sy;
        }
      }
    }
    // folded AFTER the two lattices are summed: the creases follow the zero
    // line of the sum, which no lattice point pins
    if (billow) for (let i = 0; i < f.length; i++) f[i] += amp * Math.abs(oct[i]);
    else for (let i = 0; i < f.length; i++) f[i] += amp * oct[i];
    amp *= 0.5;
  }
  // equalise: value → its rank (native sort of a copy, then a search each)
  const sorted = Float32Array.from(f).sort();
  const n = sorted.length;
  for (let i = 0; i < n; i++) {
    const v = f[i];
    let lo = 0;
    let hi = n;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sorted[mid] < v) lo = mid + 1;
      else hi = mid;
    }
    const u = lo / n;
    f[i] = billow ? 1 - (1 - u) * (1 - u) : u;
  }
  return f;
}

/** Bilinear sample of a field at world (x, z), 0..1 — matches the GPU's
 *  LINEAR + REPEAT lookup of the same numbers. */
export function sampleField(data: Float32Array, x: number, z: number): number {
  const N = FIELD_N;
  const u = (x / FIELD_TILE) * N - 0.5;
  const v = (z / FIELD_TILE) * N - 0.5;
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const tx = u - x0;
  const ty = v - y0;
  const w = (i: number): number => ((i % N) + N) % N;
  const a = data[w(y0) * N + w(x0)];
  const b = data[w(y0) * N + w(x0 + 1)];
  const c = data[w(y0 + 1) * N + w(x0)];
  const d = data[w(y0 + 1) * N + w(x0 + 1)];
  return a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty;
}

/** half-width of the soft cloud edge in field units */
export const COVER_EDGE = 0.07;

/** 0..1 cloud at a point of the layer for a coverage fraction: 1 inside a
 *  cloud, 0 in a gap. A solid deck (cover ≥ 0.99) is 1 everywhere. */
export function coverAt(data: Float32Array, x: number, z: number, cover: number): number {
  if (cover >= 0.99) return 1;
  const th = 1 - cover;
  return sstep(th - COVER_EDGE, th + COVER_EDGE, sampleField(data, x, z));
}

/* ---------------------------------------------------------- the shape ---- */

/**
 * A cloud layer is not two planes. Its TOP undulates (`relief`), with
 * cumulus embedded in it here and there rising above the rest (`towers`);
 * its BASE is ragged (`ragged`); a broken layer is lens-shaped bodies, thick
 * in the middle and closing to nothing at their edges; and none of it has a
 * surface — the cloud thickens over `soft` metres. What the WMO atlas says
 * of a rain layer seen from above: "diffuse and fairly smooth … sometimes
 * flat, undulated or fleecy", with cumulus that "may rise above its upper
 * surface", and ragged scud (pannus) beneath.
 *
 * Three fields drive it, and the renderer uploads the SAME numbers as one
 * texture (R, G, B) and evaluates the SAME formula per pixel (clouds.ts —
 * keep the two in step): what you see is what the aircraft flies through.
 *
 * The fields are 26 km tiles, and from above you can see dozens of tiles at
 * once — the same accumulations came round again and again (playtest). So
 * nothing reads them on a plain grid: every lookup goes through a slow
 * WARP (sines of incommensurate wavelength: each tile is displaced and
 * stretched differently), the small lumps are read ROTATED, and the regional
 * character — how much relief, whether there are towers — is not a tile at
 * all but a quasi-periodic function that never repeats.
 */
export interface CloudFields {
  /** coverage (equalised) — and, at the detail scale, the scud */
  cover: Float32Array;
  /** billows: the lumps of the top, at two scales */
  lump: Float32Array;
  /** where the embedded cumulus stands */
  tower: Float32Array;
}

export function makeCloudFields(): CloudFields {
  return { cover: makeCoverField(), lump: noiseField(19, true), tower: noiseField(31, false) };
}

const TAU = Math.PI * 2;
/** the warp: [amplitude m, wavenumber 1/m, phase] × 4 (two per axis) */
export const WARP = [
  [1800, TAU / 43000, 1.3], [520, TAU / 17300, 0.4],
  [1500, TAU / 61000, 0.7], [520, TAU / 23900, 2.2],
] as const;
/** regional character: [amplitude, kx, kz, phase] × 3 — wavelengths 31, 19 and 11 km */
export const REGION = [
  [0.24, (TAU / 31000) * 0.857, (TAU / 31000) * 0.515, 0.5],
  [0.17, (TAU / 19000) * 0.573, (TAU / 19000) * -0.819, 2.1],
  [0.12, (TAU / 11000) * 0.287, (TAU / 11000) * 0.958, 4.0],
] as const;
/** second lookup: small lumps and scud (cells 55–900 m), turned 34° */
export const DETAIL_SCALE = 7.3;
export const DETAIL_OFF: [number, number] = [0.21, 0.67];
export const DETAIL_COS = Math.cos(0.6);
export const DETAIL_SIN = Math.sin(0.6);
/** mean drop of the top below `top`, in reliefs; mean lift of the base, in `ragged`s */
export const MEAN_TOP = 0.233;
export const MEAN_BASE = 0.475;
/** sunlight reaches about this far down into the top, m */
export const CLOUD_ABSORB = 260;

/** 0..1: smooth swells where it is low, lumps and towers where it is high. */
export function regionAt(x: number, z: number): number {
  let r = 0.5;
  for (const [a, kx, kz, ph] of REGION) r += a * Math.sin(x * kx + z * kz + ph);
  return Math.min(Math.max(r, 0), 1);
}

export interface DeckSurfaces {
  /** top and base of the cloud at this point (top < base: no cloud here) */
  yt: number;
  yb: number;
}

const _surf: DeckSurfaces = { yt: 0, yb: 0 };

/** Top and base of the layer at world (x, z). */
export function deckSurfaces(deck: CloudDeck, f: CloudFields, x: number, z: number, out: DeckSurfaces = _surf): DeckSurfaces {
  const T = FIELD_TILE;
  const reg = regionAt(x, z);
  const wx = x + WARP[0][0] * Math.sin(z * WARP[0][1] + WARP[0][2]) + WARP[1][0] * Math.sin((x + z) * WARP[1][1] + WARP[1][2]);
  const wz = z + WARP[2][0] * Math.sin(x * WARP[2][1] + WARP[2][2]) + WARP[3][0] * Math.sin((x - z) * WARP[3][1] + WARP[3][2]);
  const big = sampleField(f.lump, wx, wz);
  const tow = sampleField(f.tower, wx, wz);
  const dx = (wx * DETAIL_COS - wz * DETAIL_SIN) * DETAIL_SCALE + DETAIL_OFF[0] * T;
  const dz = (wx * DETAIL_SIN + wz * DETAIL_COS) * DETAIL_SCALE + DETAIL_OFF[1] * T;
  const det = sampleField(f.lump, dx, dz);
  const scud = sampleField(f.cover, dx, dz);
  const h = big + (det - big) * deck.lumpy;
  const tw = sstep(0.62, 0.97, tow) * sstep(0.35, 0.65, reg) * (0.7 + 0.3 * big);
  let yt = deck.top - deck.relief * (0.4 + 0.6 * reg) * (1 - h) + deck.towers * tw;
  let yb = deck.base + deck.ragged * sstep(0.25, 0.8, scud);
  if (deck.cover < 0.99) {
    const th = 1 - deck.cover;
    const cov = sstep(th - COVER_EDGE, th + COVER_EDGE, sampleField(f.cover, wx, wz));
    const mid = 0.5 * (deck.base + deck.top);
    if (cov < 0.002) {
      yt = mid - 1;
      yb = mid + 1;
    } else {
      const e = cov * (2 - cov);
      yt = mid + (yt - mid) * e;
      yb = mid - (mid - yb) * e;
    }
  }
  out.yt = yt;
  out.yb = yb;
  return out;
}

/** Cloud at a point, 0..1: 0 in clear air, 1 once `soft` metres inside. */
export function deckDensity(deck: CloudDeck | null, f: CloudFields, x: number, y: number, z: number): number {
  if (!deck || y > deck.top + deck.towers || y < deck.base) return 0;
  const s = deckSurfaces(deck, f, x, z);
  return sstep(0, deck.soft, Math.min(s.yt - y, y - s.yb));
}

/** 0..1 how much sunlight reaches a point in or under the layer (1 at the top). */
export function deckLight(deck: CloudDeck | null, f: CloudFields, x: number, y: number, z: number): number {
  if (!deck) return 1;
  const s = deckSurfaces(deck, f, x, z);
  if (s.yt < s.yb) return y > 0.5 * (deck.base + deck.top) ? 1 : 0.6;
  return Math.exp(-Math.max(s.yt - y, 0) / CLOUD_ABSORB);
}

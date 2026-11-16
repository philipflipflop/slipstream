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
    deck: { base: 1300, top: 1750, cover: 0.55 },
    vis: 32000, cloudVis: 260, puffs: 1, rain: 0, wind: [5, 18], turb: 0.55, light: 0.8, grey: 0.3,
  },
  {
    id: 'overcast', name: 'Overcast', desc: 'Solid deck from 2,100 ft; sunshine on top at 5,000',
    deck: { base: 650, top: 1500, cover: 1 },
    vis: 12000, cloudVis: 240, puffs: 0.6, rain: 0, wind: [5, 16], turb: 0.5, light: 0.42, grey: 0.85,
  },
  {
    id: 'rain', name: 'Rain', desc: 'Cloudbase 1,000 ft, 4 km in rain, gusty — instrument weather',
    deck: { base: 320, top: 2300, cover: 1 },
    vis: 4500, cloudVis: 220, puffs: 0.6, rain: 1, wind: [10, 24], turb: 0.8, light: 0.3, grey: 1,
  },
  {
    id: 'fog', name: 'Fog', desc: 'Fog to 600 ft, 700 m beneath — blue sky above it',
    deck: { base: -400, top: 190, cover: 1 },
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

/* ------------------------------------------------------- coverage field ---- */

export const FIELD_N = 256;
/** one tile of the coverage field, m (it repeats beyond that) */
export const FIELD_TILE = 26000;

/**
 * The coverage field of a broken layer: tileable fractal value noise,
 * histogram-equalised so a threshold of (1 − cover) leaves exactly `cover`
 * of the sky cloudy. The renderer uploads `data` as a texture and the sim
 * samples the same bytes — where the picture shows a gap, there IS a gap.
 */
export function makeCoverField(seed = 7): Uint8Array {
  const N = FIELD_N;
  const f = new Float32Array(N * N);
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
    const g = new Float32Array(cells * cells);
    for (let i = 0; i < g.length; i++) g[i] = rnd();
    for (let y = 0; y < N; y++) {
      const fy = (y / N) * cells;
      const y0 = Math.floor(fy);
      const ty = fy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < N; x++) {
        const fx = (x / N) * cells;
        const x0 = Math.floor(fx);
        const tx = fx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const a = g[(y0 % cells) * cells + (x0 % cells)];
        const b = g[(y0 % cells) * cells + ((x0 + 1) % cells)];
        const c = g[((y0 + 1) % cells) * cells + (x0 % cells)];
        const d = g[((y0 + 1) % cells) * cells + ((x0 + 1) % cells)];
        f[y * N + x] += amp * (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy);
      }
    }
    amp *= 0.5;
  }
  // equalise: value → its rank
  const order = Array.from(f.keys()).sort((i, j) => f[i] - f[j]);
  const out = new Uint8Array(N * N);
  for (let r = 0; r < order.length; r++) out[order[r]] = Math.floor((r / order.length) * 256);
  return out;
}

/** Bilinear sample of the field at world (x, z), 0..1 — matches the GPU's
 *  LINEAR + REPEAT lookup of the same bytes. */
export function sampleField(data: Uint8Array, x: number, z: number): number {
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
  return (a + (b - a) * tx + (c - a) * ty + (a - b - c + d) * tx * ty) / 255;
}

/** half-width of the soft cloud edge in field units */
export const COVER_EDGE = 0.07;

/** 0..1 cloud at a point of the layer for a coverage fraction: 1 inside a
 *  cloud, 0 in a gap. A solid deck (cover ≥ 0.99) is 1 everywhere. */
export function coverAt(data: Uint8Array, x: number, z: number, cover: number): number {
  if (cover >= 0.99) return 1;
  const th = 1 - cover;
  return sstep(th - COVER_EDGE, th + COVER_EDGE, sampleField(data, x, z));
}

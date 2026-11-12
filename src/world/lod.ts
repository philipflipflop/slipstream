/**
 * Continuous distance-based terrain LOD policy (CDLOD-style). Pure math — no
 * three.js/DOM — so the whole contract runs in the Node test harness.
 *
 * WHY: the previous streamer animated every LOD change over TIME (a chunk
 * arrived, then swelled from the surface it replaced for 1–13 s). However
 * exact the morph starts were, an arc of tiles visibly sharpening together
 * every 900 m of travel is a temporal event the eye catches — the "pop" that
 * survived five rounds of fixes. Here detail is a pure function of DISTANCE:
 *
 *   - every chunk at level L carries its parent level's look (heights,
 *     colours, normals sampled on the parent lattice — the far shell for the
 *     coarsest level) and the vertex shader blends parent → own by each
 *     vertex's distance from the streaming centre, inside a per-level BAND;
 *   - mesh swaps (up AND down a level) happen only in the dead zones between
 *     bands, where the two meshes involved render the identical surface —
 *     the finer one fully collapsed onto its parent look (m = 0), the coarser
 *     one fully itself (m = 1). A swap changes no pixel.
 *
 * So in steady flight nothing ever changes in time: terrain simply carries
 * more detail the closer it is, and the detail horizon travels with you.
 *
 * Geometry of one transition (F = finer level, C = coarser, U = threshold on
 * the chunk-CENTRE distance, R = chunk half-diagonal):
 *
 *        F band            dead zone (swaps happen here)           C band
 *   ──────────────┤ U−R−M ········ U ··· U+H ········ U+H+R+M ├──────────────
 *
 *   upgrade C→F at centre distance < U; downgrade F→C beyond U+H (hysteresis).
 *   A chunk's vertices lie within ±R of its centre, so at either swap every
 *   vertex of F is past the F band (m = 0) and every vertex of C is short of
 *   the C band (m = 1). M is slack for worker latency.
 */

export const CHUNK = 900;
/** chunk half-diagonal: the farthest a vertex can sit from its chunk centre */
export const CHUNK_R = CHUNK * Math.SQRT1_2;
/** mesh resolution per level (cells per chunk side); grids nest 2:1 */
export const LEVEL_RES = [14, 28, 56, 112] as const;
export const levelOfRes = (res: number): number => LEVEL_RES.indexOf(res as 14);

/** downgrade hysteresis on the centre distance, m */
export const HYST = 120;
/** latency slack between a swap threshold and the nearest band, m */
export const MARGIN = 150;
/** a chunk is dropped this far beyond the load radius */
export const DEL_HYST = 200;
/** the shell hole stops this far short of guaranteed chunk coverage: room
 *  for an edge chunk to be up to ~1.4 s late at 250 m/s before the hole
 *  (and with it the far blend band) has to retreat */
export const HOLE_MARGIN = 350;
/** the hole is re-punched once the streaming centre has moved this far */
export const HOLE_STEP = 250;
/** shell quads survive until FULLY inside the hole (one 450 m cell diagonal)
 *  and the hole centre trails the streaming centre by up to HOLE_STEP:
 *  beyond (hole − this) the shell may still be drawn, so level-0 chunks must
 *  sit collapsed onto it */
export const SHELL_SLACK = 940;

export type LodQuality = 'low' | 'medium' | 'high';

export interface LodPreset {
  /** res-112 reach at ground level (0 = off); fades out with altitude —
   *  8 m facets are indistinguishable from 16 m ones a kilometre below */
  u112: number;
  /** res-56 / res-28 thresholds, [ground, altitude] */
  u56: [number, number];
  u28: [number, number];
  /** load radius at smoothed AGL ≤700 / 1500 / 3200 / ≥5200 m */
  load: [number, number, number, number];
  /** how far the fog may open relative to its ground range, same breakpoints */
  fog: [number, number, number, number];
}

/**
 * Reach per quality. Rule of thumb: full detail of a level is guaranteed out
 * to (threshold − R − M − band), consecutive thresholds need ≥ ~2.3 km
 * between them for a healthy band, and the load radius sits ≥ 3.2 km past
 * u28 so the coarsest level has room to collapse onto the shell.
 */
export const LOD_PRESETS: Record<LodQuality, LodPreset> = {
  low: {
    u112: 0, u56: [2400, 3000], u28: [4400, 5300],
    load: [7800, 8900, 9600, 10300], fog: [1, 2, 2.25, 2.5],
  },
  medium: {
    u112: 0, u56: [3600, 4400], u28: [5900, 7400],
    load: [9300, 12150, 13950, 15750], fog: [1, 2.17, 2.5, 2.83],
  },
  high: {
    u112: 1600, u56: [4600, 5400], u28: [7000, 9300],
    load: [10400, 14850, 17550, 20250], fog: [1, 2, 2.38, 2.75],
  },
};

/** scatter density thresholds on the chunk-centre distance (level 2 / 1) */
const SCATTER_U2 = 3150;
const SCATTER_U1 = 5850;

/** preferred blend widths, anchored at the band's OUTER end (keep detail as
 *  long as possible, blend late) */
const BAND_W = [2500, 800, 800, 400];
const GROW_W = 520;

export interface LodFrame {
  /** T[l]: a chunk wants level ≥ l while its centre is nearer than this
   *  (T[0] is the load radius; 0 disables a level) */
  T: [number, number, number, number];
  load: number;
  /** blend bands per level, [inner, outer]: m = 1 inside inner, 0 past outer.
   *  band[0][1] is the NOMINAL edge — the manager substitutes its smoothed,
   *  coverage-limited edge via `edgeBand` */
  band: [[number, number], [number, number], [number, number], [number, number]];
  /** level-0 band inner limit (dead zone of the u28 transition) */
  edgeInnerMin: number;
  /** scatter thresholds [unused, level 1, level 2] and instance grow bands */
  S: [number, number, number];
  grow: [[number, number], [number, number], [number, number]];
  /** nominal shell-hole radius and collapse edge for full coverage */
  hole: number;
  edge: number;
  fogScale: number;
}

const sstep = (e0: number, e1: number, x: number): number => {
  const t = Math.min(Math.max((x - e0) / (e1 - e0), 0), 1);
  return t * t * (3 - 2 * t);
};

/** piecewise-linear through the altitude breakpoints 700/1500/3200/5200 */
function altCurve(v: readonly [number, number, number, number], agl: number): number {
  if (agl <= 700) return v[0];
  if (agl < 1500) return v[0] + (v[1] - v[0]) * ((agl - 700) / 800);
  if (agl < 3200) return v[1] + (v[2] - v[1]) * ((agl - 1500) / 1700);
  if (agl < 5200) return v[2] + (v[3] - v[2]) * ((agl - 3200) / 2000);
  return v[3];
}

/** [inner, outer] of the level-0 band for a given collapse edge. */
export function edgeBand(f: LodFrame, edge: number): [number, number] {
  const outer = Math.max(edge, 60);
  const inner = Math.max(f.edgeInnerMin, outer - BAND_W[0]);
  return [Math.min(inner, outer - 50), outer];
}

/**
 * Everything the streamer and the shaders need for one frame, as a smooth
 * function of (slew-limited) height above ground: no tiers, so climbing
 * sweeps thresholds continuously instead of requeueing the world.
 */
export function lodFrame(p: LodPreset, agl: number): LodFrame {
  const tA = sstep(600, 1500, agl);
  const load = altCurve(p.load, agl);
  const u28 = p.u28[0] + (p.u28[1] - p.u28[0]) * tA;
  const u56 = p.u56[0] + (p.u56[1] - p.u56[0]) * tA;
  let u112 = p.u112 * (1 - sstep(350, 900, agl));
  // the ultra level switches on/off just past the point where its band has
  // shrunk to nothing (outer < 0): no vertex is mid-blend, so even that step
  // is unseen (the 60 m covers the threshold's travel between two scans)
  if (u112 < CHUNK_R + MARGIN - 60) u112 = 0;
  const T: LodFrame['T'] = [load, u28, u56, u112];

  const hole = load - CHUNK_R - HOLE_MARGIN;
  const edge = hole - SHELL_SLACK;

  const band = [[0, 0], [0, 0], [0, 0], [0, 0]] as LodFrame['band'];
  for (let l = 1; l <= 3; l++) {
    const outer = T[l] - CHUNK_R - MARGIN;
    const finer = l < 3 ? T[l + 1] : 0;
    const innerMin = finer > 0 ? finer + HYST + CHUNK_R + MARGIN : 0;
    const inner = Math.max(innerMin, outer - BAND_W[l]);
    band[l][0] = Math.min(inner, outer - 50);
    band[l][1] = outer;
  }
  const edgeInnerMin = u28 + HYST + CHUNK_R + MARGIN;
  const f: LodFrame = {
    T, load, band, edgeInnerMin,
    S: [0, Math.min(SCATTER_U1, load), SCATTER_U2],
    grow: [[0, 0], [0, 0], [0, 0]],
    hole, edge,
    fogScale: altCurve(p.fog, agl),
  };
  const eb = edgeBand(f, edge);
  band[0][0] = eb[0];
  band[0][1] = eb[1];
  // scatter: instances of density level s exist while the chunk centre is
  // inside S[s]; they must be fully shrunk before any chunk can drop them
  for (let s = 1; s <= 2; s++) {
    const outer = f.S[s] - CHUNK_R - MARGIN;
    f.grow[s][0] = outer - GROW_W;
    f.grow[s][1] = outer;
  }
  // level-0 scatter (city towers, present on every chunk) rides the edge band
  f.grow[0][0] = band[0][0];
  f.grow[0][1] = band[0][1];
  return f;
}

/** Level a chunk should hold at centre distance dc (−1 = not loaded).
 *  `cur` is its current level (−1 if absent) — supplies the hysteresis. */
export function wantLevel(f: LodFrame, dc: number, cur: number): number {
  if (dc >= f.load + (cur >= 0 ? DEL_HYST : 0)) return -1;
  let l = 0;
  for (let k = 1; k <= 3; k++) {
    if (f.T[k] > 0 && dc < f.T[k] + (cur >= k ? HYST : 0)) l = k;
  }
  return l;
}

/** Scatter density a chunk should hold at centre distance dc. */
export function wantScatter(f: LodFrame, dc: number, cur: number): 0 | 1 | 2 {
  if (dc < f.S[2] + (cur >= 2 ? HYST : 0)) return 2;
  if (dc < f.S[1] + (cur >= 1 ? HYST : 0)) return 1;
  return 0;
}

export interface ChunkStep {
  level: number;
  scatter: 0 | 1 | 2;
  /** shader time-fade start: 0 = parent look (fresh / upgrade), 1 = own look
   *  (downgrade), −1 = same surface, no fade (scatter-only rebuild) */
  start: -1 | 0 | 1;
}

/**
 * The next build for a chunk, or null when it is already where it should be
 * (or should not exist). Levels change ONE step at a time — a chunk's morph
 * data only reaches its parent, so a two-level jump could not be seamless.
 * A missing chunk is built straight at its target (capped at res 56; the
 * ultra level follows as a seamless upgrade).
 */
export function planStep(
  f: LodFrame, dc: number, curLevel: number, curScatter: number,
): ChunkStep | null {
  const want = wantLevel(f, dc, curLevel);
  if (want < 0) return null;
  const scatter = wantScatter(f, dc, curLevel < 0 ? -1 : curScatter);
  if (curLevel < 0) return { level: Math.min(want, 2), scatter, start: 0 };
  if (want > curLevel) return { level: curLevel + 1, scatter, start: 0 };
  if (want < curLevel) return { level: curLevel - 1, scatter, start: 1 };
  if (scatter !== curScatter) return { level: curLevel, scatter, start: -1 };
  return null;
}

/** Blend factor the shader computes: 1 = own detail, 0 = parent look. */
export function morphAt(band: readonly [number, number], d: number): number {
  return 1 - sstep(band[0], band[1], d);
}

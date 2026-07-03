/** localStorage persistence for settings + best times. */
import type { WorldTheme } from './world/heightfield';
import type { TimeOfDay } from './world/daylight';

export type Quality = 'low' | 'medium' | 'high';

export interface SaveData {
  aircraft: string;
  mode: 'free' | 'race';
  world: WorldTheme;
  tod: TimeOfDay;
  quality: Quality;
  /** quality-heuristic schema version — bump to re-derive saved defaults */
  qv: number;
  invertY: boolean;
  sensitivity: number;
  muted: boolean;
  bestTimes: Record<string, number>;
}

const QUALITY_VERSION = 2; // v2: 6-core phones (iPhones) rate medium

const KEY = 'slipstream.save.v1';

export function loadSave(): SaveData {
  const def: SaveData = {
    aircraft: 'skylark',
    mode: 'free',
    world: 'archipelago',
    tod: 'day',
    quality: defaultQuality(),
    qv: QUALITY_VERSION,
    invertY: false,
    sensitivity: 1,
    muted: false,
    bestTimes: {},
  };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return def;
    const parsed = JSON.parse(raw) as Partial<SaveData>;
    const out = { ...def, ...parsed, bestTimes: { ...(parsed.bestTimes ?? {}) } };
    // saves written before a heuristic bump re-derive the device default
    // once (e.g. iPhones that an older build wrongly pinned to 'low');
    // any quality the user picks afterwards persists with the new version
    if (parsed.qv !== QUALITY_VERSION) {
      out.quality = defaultQuality();
      out.qv = QUALITY_VERSION;
    }
    return out;
  } catch {
    return def;
  }
}

export function persist(data: SaveData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* private browsing — fine */
  }
}

function defaultQuality(): Quality {
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  const cores = navigator.hardwareConcurrency ?? 4;
  // modern iPhones report 6 cores — they belong on medium, not the floor
  if (coarse) return cores >= 6 ? 'medium' : 'low';
  return cores >= 8 ? 'high' : 'medium';
}

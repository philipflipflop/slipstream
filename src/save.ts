/** localStorage persistence for settings + best times. */
import type { WorldTheme } from './world/heightfield';

export type Quality = 'low' | 'medium' | 'high';

export interface SaveData {
  aircraft: string;
  mode: 'free' | 'race';
  world: WorldTheme;
  quality: Quality;
  invertY: boolean;
  sensitivity: number;
  muted: boolean;
  bestTimes: Record<string, number>;
}

const KEY = 'slipstream.save.v1';

export function loadSave(): SaveData {
  const def: SaveData = {
    aircraft: 'skylark',
    mode: 'free',
    world: 'archipelago',
    quality: defaultQuality(),
    invertY: false,
    sensitivity: 1,
    muted: false,
    bestTimes: {},
  };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return def;
    const parsed = JSON.parse(raw) as Partial<SaveData>;
    return { ...def, ...parsed, bestTimes: { ...(parsed.bestTimes ?? {}) } };
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

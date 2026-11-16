/**
 * Jobs: paying flights between airfields. A field's board offers a few —
 * passengers, freight, a medevac, a priority dispatch — to destinations the
 * aircraft can actually use and reach in a sensible sitting. You are paid on
 * arrival: the fee, scaled by how punctual you were, how you put it down
 * (the landing rubric) and, with passengers aboard, how they enjoyed it.
 *
 * Pure — no three.js/DOM — so the board and the pay run in the Node tests.
 */
import type { AirfieldDef, WorldGen } from '../world/heightfield';
import type { AircraftSpec } from '../aircraft/types';
import { hash2 } from '../core/math';

export type JobKind = 'charter' | 'cargo' | 'medevac' | 'courier';

export interface Job {
  kind: JobKind;
  /** board headline: "8 PASSENGERS", "640 KG OF MACHINE PARTS", … */
  title: string;
  from: AirfieldDef;
  to: AirfieldDef;
  /** m, and the initial course in degrees */
  distance: number;
  bearing: number;
  /** seconds, brakes-off to stopped, for the full fee */
  par: number;
  /** the fee before bonuses and deductions */
  pay: number;
  /** people aboard who mind how you fly */
  comfort: boolean;
}

interface JobClass {
  seats: number;
  cargoKg: number;
  /** fee per km flown */
  rate: number;
  /** the least airfield this aircraft works from */
  needs: 'any' | 'major' | 'intl';
  /** block speed, m/s */
  cruise: number;
}

const KT = 0.514444;

/** What an aircraft can carry, charge and use. */
export function jobClass(spec: AircraftSpec): JobClass {
  const top = spec.topSpeedKt * KT;
  if (spec.engine === 'heli') return { seats: 4, cargoKg: 400, rate: 17, needs: 'any', cruise: top * 0.8 };
  if (spec.gun) return { seats: 0, cargoKg: 80, rate: 46, needs: 'major', cruise: top * 0.5 };
  if (spec.mass > 40000) return { seats: 164, cargoKg: 9000, rate: 115, needs: 'intl', cruise: top * 0.72 };
  if (spec.engine === 'jet') return { seats: 8, cargoKg: 900, rate: 34, needs: 'major', cruise: top * 0.7 };
  if (spec.gLimit >= 7) return { seats: 0, cargoKg: 120, rate: 17, needs: 'any', cruise: top * 0.62 };
  if (spec.mass > 2000) return { seats: 9, cargoKg: 950, rate: 15, needs: 'any', cruise: top * 0.72 };
  return { seats: 3, cargoKg: 260, rate: 9.5, needs: 'any', cruise: top * 0.72 };
}

const GOODS = ['MACHINE PARTS', 'FRESH FISH', 'MAIL', 'MEDICAL SUPPLIES', 'CUT FLOWERS', 'SURVEY GEAR', 'NEWSPAPERS'];
const KIND_MUL: Record<JobKind, number> = { charter: 1, cargo: 0.86, medevac: 1.5, courier: 1.4 };
/** urgent work runs to a tighter clock */
const KIND_PAR: Record<JobKind, number> = { charter: 1, cargo: 1.08, medevac: 0.86, courier: 0.86 };

const suits = (f: AirfieldDef, needs: JobClass['needs']): boolean =>
  needs === 'any' || (needs === 'major' ? f.major || f.intl === true : f.intl === true);

/** Seconds allowed for the full fee: block time at cruise + getting in and out. */
export function parTime(spec: AircraftSpec, kind: JobKind, distance: number): number {
  const c = jobClass(spec);
  const overhead = spec.engine === 'heli' ? 150 : spec.mass > 40000 ? 540 : spec.engine === 'jet' ? 380 : 300;
  return Math.round(((distance / c.cruise) * 1.12 + overhead) * KIND_PAR[kind]);
}

/**
 * The board at `from` for this aircraft: up to four jobs, deterministic for
 * (field, aircraft, serial) — `serial` advances as jobs are flown, so the
 * board is fresh each time you come back.
 */
export function jobsFrom(gen: WorldGen, from: AirfieldDef, spec: AircraftSpec, serial = 0): Job[] {
  const c = jobClass(spec);
  const minD = spec.engine === 'heli' ? 6000 : 11000;
  const maxD = Math.max(c.cruise * 1000, 40000);
  const cand: AirfieldDef[] = [];
  const seen = new Set<string>();
  const take = (list: AirfieldDef[]): void => {
    for (const f of list) {
      const key = `${f.x},${f.z}`;
      if (seen.has(key) || (f.x === from.x && f.z === from.z) || !suits(f, c.needs)) continue;
      const d = Math.hypot(f.x - from.x, f.z - from.z);
      if (d < minD || d > maxD) continue;
      seen.add(key);
      cand.push(f);
    }
  };
  take(gen.airfieldsNear(from.x, from.z, Math.min(maxD, 95000), []));
  take(gen.hubsNear(from.x, from.z, Math.min(Math.max(maxD, 140000), 480000), []));
  // nothing in reach (an airliner far from the next hub): the nearest that suits
  if (cand.length === 0) {
    const far = gen.hubsNear(from.x, from.z, 480000, []).filter((f) => f.x !== from.x || f.z !== from.z);
    far.sort((a, b) => Math.hypot(a.x - from.x, a.z - from.z) - Math.hypot(b.x - from.x, b.z - from.z));
    cand.push(...far.slice(0, 2));
  }
  // shuffle by hash, keep four
  const seed = Math.round(from.x / 100) * 31 + Math.round(from.z / 100) * 17 + serial * 7919;
  const rank = (f: AirfieldDef): number => hash2(Math.round(f.x / 100) + seed, Math.round(f.z / 100) - seed * 3);
  cand.sort((a, b) => rank(a) - rank(b));
  const kinds: JobKind[] = c.seats === 0 ? ['courier', 'cargo', 'courier', 'cargo']
    : c.seats > 100 ? ['charter', 'charter', 'cargo', 'charter']
    : ['charter', 'cargo', 'medevac', 'charter'];

  const jobs: Job[] = [];
  for (let i = 0; i < Math.min(4, cand.length); i++) {
    const to = cand[i];
    const kind = kinds[(i + serial) % kinds.length];
    const distance = Math.hypot(to.x - from.x, to.z - from.z);
    const h = hash2(seed + i * 13, i * 7 - seed);
    let title: string;
    if (kind === 'charter') {
      const n = Math.max(1, Math.round(c.seats * (0.55 + h * 0.45)));
      title = c.seats > 100 ? `SCHEDULED SERVICE · ${n} PASSENGERS` : `${n} PASSENGER${n > 1 ? 'S' : ''}`;
    } else if (kind === 'cargo') {
      const kg = Math.max(20, Math.round((c.cargoKg * (0.5 + h * 0.5)) / 10) * 10);
      title = `${kg.toLocaleString('en-US')} KG OF ${GOODS[Math.floor(h * 97) % GOODS.length]}`;
    } else if (kind === 'medevac') {
      title = 'MEDEVAC — PATIENT TRANSFER';
    } else {
      title = 'PRIORITY DISPATCH';
    }
    const brg = (Math.atan2(to.x - from.x, -(to.z - from.z)) * 180) / Math.PI;
    jobs.push({
      kind, title, from, to, distance,
      bearing: Math.round((brg + 360) % 360),
      par: parTime(spec, kind, distance),
      pay: Math.round(((160 + (distance / 1000) * c.rate) * KIND_MUL[kind]) / 10) * 10,
      comfort: kind === 'charter' || kind === 'medevac',
    });
  }
  return jobs;
}

/** True when (x, z) is on the destination airfield (runways, taxiways, apron). */
export function atField(f: AirfieldDef, x: number, z: number): boolean {
  const dx = x - f.x;
  const dz = z - f.z;
  const along = dx * f.sinH - dz * f.cosH;
  const across = dx * f.cosH + dz * f.sinH;
  return Math.abs(along) < f.length / 2 + 450 && Math.abs(across) < (f.rwySep ? f.rwySep / 2 : 0) + 520;
}

export interface JobResult {
  /** seconds taken */
  time: number;
  /** landing score 0–100, or null where none was graded (helicopters) */
  landing: number | null;
  /** 0..1 how smooth the ride was (ignored without passengers) */
  comfort: number;
}

export interface JobPay {
  pay: number;
  /** multipliers applied to the fee, for the debrief */
  timeMul: number;
  landMul: number;
  comfortMul: number;
  grade: string;
}

/** What a finished job pays. */
export function scoreJob(job: Job, r: JobResult): JobPay {
  // early is a bonus (up to +15% at 20% under par); late costs 1% per 1%, to −40%
  const timeMul = r.time <= job.par
    ? 1 + 0.15 * Math.min(1, (job.par - r.time) / (0.2 * job.par))
    : 1 - Math.min(0.4, (r.time - job.par) / job.par);
  // (no grade to give — helicopters — is neutral, not a deduction)
  const landMul = r.landing === null ? 1 : 0.6 + 0.4 * (Math.max(0, Math.min(100, r.landing)) / 100);
  const comfortMul = job.comfort ? 0.75 + 0.25 * Math.max(0, Math.min(1, r.comfort)) : 1;
  const k = timeMul * landMul * comfortMul;
  return {
    pay: Math.round((job.pay * k) / 5) * 5,
    timeMul, landMul, comfortMul,
    grade: k >= 1.04 ? 'A+' : k >= 0.94 ? 'A' : k >= 0.84 ? 'B' : k >= 0.7 ? 'C' : 'D',
  };
}

/**
 * Ride quality, accumulated: seconds of rough handling → 0..1. Passengers
 * mind load factor outside 0.5–1.7 g and bank beyond ~40°; a hard arrival
 * (`sink`, m/s, on touchdown) costs a lump.
 */
export class Comfort {
  private rough = 0;
  step(dt: number, g: number, bank: number, onGround: boolean): void {
    if (onGround) return;
    if (g > 1.7) this.rough += dt * Math.min((g - 1.7) * 2.5, 3);
    else if (g < 0.5) this.rough += dt * Math.min((0.5 - g) * 3, 3);
    const b = Math.abs(bank);
    if (b > 0.7) this.rough += dt * Math.min((b - 0.7) * 3, 2);
  }
  touchdown(sink: number): void {
    if (sink > 2.2) this.rough += (sink - 2.2) * 4;
  }
  get value(): number {
    return Math.max(0, 1 - this.rough / 22);
  }
}

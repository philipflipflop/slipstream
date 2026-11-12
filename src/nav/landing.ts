/**
 * Landing analysis: which runway the wheels touched, how the touchdown
 * measured up, and a grade for it. Pure math (no three.js/DOM) so the whole
 * rubric runs in the Node test harness.
 *
 * The rubric is the one instructors actually use — a stabilised approach
 * ends ON THE NUMBERS: gentle sink, on the centreline, in the touchdown
 * zone. Each third of that sentence is scored separately so the debrief can
 * say what to fix.
 */
import type { AirfieldDef } from '../world/heightfield';
import { IlsApproach, approachesOf } from './ils';
import { wrapAngle } from '../core/math';

export interface RunwayContact {
  fieldName: string;
  ident: string;     // runway designator in the landing direction ("27L")
  course: number;    // rad
  /** metres beyond the landing threshold (negative = short of it) */
  past: number;
  /** metres off the centreline, + = right of it */
  cross: number;
  length: number;
  width: number;
  elev: number;
}

/**
 * The runway under a point, read in the direction the aircraft is moving
 * (so `past` counts from the threshold it landed over). Null off-pavement.
 */
export function runwayUnder(
  fields: AirfieldDef[], x: number, z: number, track: number,
  scratch: IlsApproach[] = [],
): RunwayContact | null {
  let best: RunwayContact | null = null;
  let bestOff = Infinity;
  for (const f of fields) {
    scratch.length = 0;
    approachesOf(f, scratch);
    for (const app of scratch) {
      const off = Math.abs(wrapAngle(track - app.course));
      if (off > Math.PI / 2) continue; // the reciprocal end
      const dirX = Math.sin(app.course);
      const dirZ = -Math.cos(app.course);
      const past = (x - app.thrX) * dirX + (z - app.thrZ) * dirZ;
      const cross = (x - app.thrX) * -dirZ + (z - app.thrZ) * dirX;
      if (past < -30 || past > app.length + 30) continue;
      if (Math.abs(cross) > f.width / 2 + 6) continue;
      if (off < bestOff) {
        bestOff = off;
        best = {
          fieldName: f.name, ident: app.ident, course: app.course,
          past, cross, length: app.length, width: f.width, elev: f.elev,
        };
      }
    }
  }
  return best;
}

export interface Touchdown {
  /** vertical speed at contact, m/s, positive = descending */
  sink: number;
  cross: number;
  past: number;
  length: number;
  width: number;
}

export interface LandingScore {
  score: number;        // 0..100
  grade: string;        // A+ … E
  fpm: number;          // touchdown rate, ft/min
  sinkPts: number;      // of 40
  linePts: number;      // of 30
  zonePts: number;      // of 30
  /** where the touchdown zone is centred on this runway, m past threshold */
  aim: number;
  verdict: string;
}

const lin = (v: number, good: number, bad: number): number =>
  Math.min(Math.max((bad - v) / (bad - good), 0), 1);

/** Aiming point: abeam the glideslope station — 300 m in, less on a short strip. */
export function aimPoint(length: number): number {
  return Math.min(300, length * 0.22);
}

export function scoreLanding(t: Touchdown): LandingScore {
  const fpm = t.sink * 196.85;
  // 40: sink rate — full marks to 120 fpm, nothing left by 600 (a slam)
  const sinkPts = 40 * lin(fpm, 120, 600);
  // 30: centreline — full marks inside 1.5 m, zero at the runway edge
  const linePts = 30 * lin(Math.abs(t.cross), 1.5, t.width / 2);
  // 30: touchdown zone — full marks within 120 m of the aiming point; a
  // short landing loses marks twice as fast as a long one (the threshold
  // is not a suggestion), and floating past the first third scores zero
  const aim = aimPoint(t.length);
  const miss = t.past - aim;
  const zonePts = 30 * (miss >= 0
    ? lin(miss, 120, Math.max(t.length / 3 - aim, 240))
    : lin(-miss, 60, aim + 20));
  const score = Math.round(sinkPts + linePts + zonePts);
  const grade = score >= 95 ? 'A+' : score >= 88 ? 'A' : score >= 78 ? 'B'
    : score >= 65 ? 'C' : score >= 50 ? 'D' : 'E';

  // one line of debrief: name the weakest third (a good landing gets the
  // praise first and the note second — 206 fpm on the centreline is not
  // "firm", it is a good landing that could be a touch softer)
  const loss = [40 - sinkPts, 30 - linePts, 30 - zonePts];
  let verdict = 'ON THE NUMBERS';
  if (score < 95 && score >= 88) {
    const worst = loss.indexOf(Math.max(...loss));
    verdict = 'GOOD LANDING — ' + (worst === 0 ? 'A TOUCH FIRM'
      : worst === 1 ? `${Math.abs(t.cross).toFixed(0)} m ${t.cross > 0 ? 'RIGHT' : 'LEFT'} OF THE LINE`
        : miss > 0 ? 'A LITTLE LONG' : 'A LITTLE SHORT');
  } else if (score < 88) {
    const worst = loss.indexOf(Math.max(...loss));
    verdict = worst === 0
      ? (fpm > 450 ? 'HARD ARRIVAL — FLARE EARLIER' : 'FIRM — HOLD IT OFF A LITTLE LONGER')
      : worst === 1
        ? `OFF THE CENTRELINE — ${Math.abs(t.cross).toFixed(0)} m ${t.cross > 0 ? 'RIGHT' : 'LEFT'}`
        : miss > 0 ? 'LONG — FLOATED PAST THE TOUCHDOWN ZONE' : 'SHORT — AIM FURTHER DOWN THE RUNWAY';
  }
  return { score, grade, fpm, sinkPts, linePts, zonePts, aim, verdict };
}

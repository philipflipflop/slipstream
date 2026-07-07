/**
 * ILS — instrument landing system with real approach geometry, one
 * localizer/glideslope pair per runway END (every strip gets "36" and "18"
 * style approaches; international parallel pairs get 36L/36R/18L/18R).
 *
 * The maths mirrors the real installation:
 *   - localizer antenna sits ~300 m past the STOP end, so lateral deviation
 *     is angular from there (needle sensitivity rises as you close in, full
 *     scale ±2.5° like a CAT-I localizer)
 *   - glideslope station sits 300 m in from the threshold, transmitting a
 *     3.00° path (threshold crossing height ≈ 18 m); full scale ±0.7°
 *   - the receiver auto-tunes to the best candidate ahead of the nose and
 *     holds it with hysteresis, like a well-behaved FMS
 *
 * Pure math — no three.js/DOM — so it runs in the Node test harness.
 */
import type { AirfieldDef } from '../world/heightfield';
import { wrapAngle, RAD2DEG } from '../core/math';

export const GS_ANGLE = 3.0 / RAD2DEG;      // 3.00° glide path
export const LOC_FULL_SCALE = 2.5 / RAD2DEG; // full needle deflection
export const GS_FULL_SCALE = 0.7 / RAD2DEG;
const GS_ANTENNA_H = 2.5;                    // station height above field, m
const MAX_TUNE_RANGE = 32000;                // receiver range, m

export interface IlsApproach {
  fieldName: string;
  ident: string;      // runway designator flown TO ("36", "27L", …)
  course: number;     // approach course, rad clockwise from north
  thrX: number;       // approach threshold
  thrZ: number;
  locX: number;       // localizer antenna (past the stop end)
  locZ: number;
  gsX: number;        // glideslope station (abeam the touchdown zone)
  gsZ: number;
  elev: number;
  length: number;
}

export interface IlsData {
  name: string;
  ident: string;
  course: number;
  dme: number;     // slant-free distance to the threshold, m
  toGo: number;    // along-course metres in FRONT of the threshold
  locDev: number;  // rad, + = aircraft RIGHT of the centreline (fly left)
  gsDev: number;   // rad, + = aircraft ABOVE the glide path (fly down)
}

/** Runway-number designator for an approach course ("36" for north). */
export function runwayIdent(course: number): string {
  const deg = ((course * RAD2DEG) % 360 + 360) % 360;
  const n = ((Math.round(deg / 10) + 35) % 36) + 1;
  return String(n).padStart(2, '0');
}

/**
 * Emit every ILS approach an airfield serves into `out`. Single-runway
 * fields give two (one per end); parallel internationals give four with
 * L/R suffixes assigned from the approaching pilot's point of view.
 */
export function approachesOf(ap: AirfieldDef, out: IlsApproach[]): void {
  const offsets: Array<{ across: number; length: number }> = ap.rwySep
    ? [
        { across: -ap.rwySep / 2, length: ap.length },
        { across: ap.rwySep / 2, length: ap.rwy2Len ?? ap.length },
      ]
    : [{ across: 0, length: ap.length }];

  for (const rw of offsets) {
    // runway centre, offset across the field heading
    const cx = ap.x + rw.across * ap.cosH;
    const cz = ap.z + rw.across * ap.sinH;
    for (const flip of [1, -1]) {
      // direction of flight on this approach
      const course = flip === 1 ? ap.heading : ap.heading + Math.PI;
      const dirX = ap.sinH * flip;
      const dirZ = -ap.cosH * flip;
      const half = rw.length / 2;
      let suffix = '';
      if (ap.rwySep) {
        // west runway seen flying the field heading is on the pilot's LEFT
        suffix = (rw.across < 0) === (flip === 1) ? 'L' : 'R';
      }
      out.push({
        fieldName: ap.name,
        ident: runwayIdent(course) + suffix,
        course: wrapAngle(course),
        thrX: cx - dirX * half,
        thrZ: cz - dirZ * half,
        locX: cx + dirX * (half + 300),
        locZ: cz + dirZ * (half + 300),
        gsX: cx - dirX * (half - 300),
        gsZ: cz - dirZ * (half - 300),
        elev: ap.elev,
        length: rw.length,
      });
    }
  }
}

/** Raw deviations for one approach at the aircraft position. */
export function solveIls(app: IlsApproach, x: number, y: number, z: number): IlsData {
  const dirX = Math.sin(app.course);
  const dirZ = -Math.cos(app.course);
  const toGo = (app.thrX - x) * dirX + (app.thrZ - z) * dirZ;
  const dme = Math.hypot(app.thrX - x, app.thrZ - z);

  // localizer: angular offset seen from the far-end antenna, + = right
  const brg = Math.atan2(x - app.locX, -(z - app.locZ));
  const locDev = wrapAngle(wrapAngle(app.course + Math.PI) - brg);

  // glideslope: angle above the station vs the 3° path, + = high
  const dh = Math.max(Math.hypot(x - app.gsX, z - app.gsZ), 1);
  const gsDev = Math.atan2(y - app.elev - GS_ANTENNA_H, dh) - GS_ANGLE;

  return {
    name: app.fieldName,
    ident: app.ident,
    course: app.course,
    dme,
    toGo,
    locDev,
    gsDev,
  };
}

/**
 * Auto-tune: pick the approach the aircraft is best set up for — inbound-ish
 * heading, inside the course sector, in range. `current` gets a sticky
 * bonus so the receiver doesn't flick between ends mid-approach.
 */
export function tuneIls(
  fields: AirfieldDef[],
  x: number,
  z: number,
  y: number,
  heading: number,
  current: IlsApproach | null,
  scratch: IlsApproach[] = [],
): IlsApproach | null {
  scratch.length = 0;
  for (const f of fields) approachesOf(f, scratch);

  let best: IlsApproach | null = null;
  let bestScore = Infinity;
  for (const app of scratch) {
    const d = solveIls(app, x, y, z);
    if (d.toGo < -app.length || d.toGo > MAX_TUNE_RANGE) continue;
    if (Math.abs(d.locDev) > 24 / RAD2DEG) continue;          // outside the beam
    const hdgOff = Math.abs(wrapAngle(heading - app.course));
    if (hdgOff > 70 / RAD2DEG) continue;                       // not inbound
    let score = Math.abs(d.locDev) * 40 + hdgOff * 6 + d.dme / 8000;
    if (
      current &&
      app.fieldName === current.fieldName &&
      app.ident === current.ident
    ) score -= 1.1; // hysteresis: hold the tuned approach
    if (score < bestScore) {
      bestScore = score;
      best = app;
    }
  }
  return best;
}

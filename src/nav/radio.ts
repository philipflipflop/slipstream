/**
 * The tower: the handful of calls a pilot actually waits for, as text.
 *
 *   - LANDING CLEARANCE once you are established on final to a towered
 *     field — or "continue approach" while something is still on the
 *     runway, followed by the clearance when it clears or "go around" if it
 *     has not by short final.
 *   - TRAFFIC ADVISORIES: "traffic, 2 o'clock, 3 km, 500 ft above" for
 *     anything airborne that gets close, once per aircraft.
 *
 * Pure — no three.js/DOM — so the phraseology and the triggers run in the
 * Node test harness.
 */
import type { IlsApproach } from './ils';
import { wrapAngle } from '../core/math';

export interface RadioOwn {
  x: number;
  y: number;
  z: number;
  /** heading, rad clockwise from north */
  hdg: number;
  onGround: boolean;
}

export interface RadioTraffic {
  id: number;
  x: number;
  y: number;
  z: number;
}

const M_TO_FT = 3.28084;

/** "FIELD NAME" → the station that answers ("MERIDIAN TOWER") */
export function stationName(field: string): string {
  return `${field.replace(/ (INTL|FIELD|STRIP|REGIONAL)$/, '')} TOWER`;
}

/** Clock position of a bearing relative to the nose (12 = dead ahead). */
export function clockOf(relBearing: number): number {
  const h = Math.round((wrapAngle(relBearing) * 6) / Math.PI);
  return ((h + 11) % 12) + 1;
}

export function trafficCall(own: RadioOwn, t: RadioTraffic): string {
  const dx = t.x - own.x;
  const dz = t.z - own.z;
  const clock = clockOf(Math.atan2(dx, -dz) - own.hdg);
  const km = Math.hypot(dx, dz) / 1000;
  const ft = Math.round(((t.y - own.y) * M_TO_FT) / 100) * 100;
  const level = ft === 0 ? 'SAME LEVEL' : `${Math.abs(ft).toLocaleString('en-US')} FT ${ft > 0 ? 'ABOVE' : 'BELOW'}`;
  return `TRAFFIC — ${clock} O'CLOCK, ${km < 1 ? km.toFixed(1) : km.toFixed(0)} KM, ${level}`;
}

type LandingState = 'none' | 'continue' | 'cleared' | 'goaround';

export class Tower {
  private key = '';
  private state: LandingState = 'none';
  private lost = 0;
  private taCool = 12;
  private called = new Map<number, number>();
  private time = 0;
  private quiet = 0;

  /** `quiet`: seconds of radio silence first (a briefing is on screen). */
  reset(quiet = 0): void {
    this.key = '';
    this.state = 'none';
    this.lost = 0;
    this.taCool = 12;
    this.quiet = quiet;
    this.called.clear();
  }

  /**
   * One step. `app` is the tuned approach (null if none) at a towered field,
   * `busy` whether its runway is occupied, `wind` the wind as spoken.
   * Returns the call to show this step, or null.
   */
  update(
    dt: number, own: RadioOwn, app: IlsApproach | null, busy: boolean, wind: string,
    traffic: readonly RadioTraffic[], nTraffic = traffic.length,
  ): string | null {
    this.time += dt;
    if (this.quiet > 0) {
      this.quiet -= dt;
      return null;
    }
    let out: string | null = null;

    // ---- landing clearance ----
    let est = false;
    if (app && !own.onGround) {
      const dirX = Math.sin(app.course);
      const dirZ = -Math.cos(app.course);
      const toGo = (app.thrX - own.x) * dirX + (app.thrZ - own.z) * dirZ;
      const cross = (own.x - app.thrX) * -dirZ + (own.z - app.thrZ) * dirX;
      est = toGo > 150 && toGo < 9500 && Math.abs(cross) < Math.max(toGo * 0.07, 130) &&
        own.y - app.elev < 1200 && Math.abs(wrapAngle(own.hdg - app.course)) < 0.6;
      if (est) {
        const key = `${app.fieldName}/${app.ident}`;
        if (key !== this.key) {
          this.key = key;
          this.state = 'none';
        }
        const who = stationName(app.fieldName);
        if (this.state === 'none') {
          this.state = busy ? 'continue' : 'cleared';
          out = busy
            ? `${who} — RUNWAY ${app.ident}, CONTINUE APPROACH, TRAFFIC ON THE RUNWAY`
            : `${who} — RUNWAY ${app.ident} CLEARED TO LAND · ${wind}`;
        } else if (this.state === 'continue') {
          if (!busy) {
            this.state = 'cleared';
            out = `${who} — RUNWAY ${app.ident} CLEARED TO LAND · ${wind}`;
          } else if (toGo < 1500) {
            this.state = 'goaround';
            out = `${who} — GO AROUND, RUNWAY OCCUPIED`;
          }
        } else if (this.state === 'cleared' && busy && toGo < 1500 && toGo > 300) {
          this.state = 'goaround';
          out = `${who} — GO AROUND, RUNWAY OCCUPIED`;
        }
      }
    }
    // the approach is over once you have been off it for a while (a go-
    // around flown back onto final gets a fresh clearance)
    if (est) this.lost = 0;
    else if (this.key && (this.lost += dt) > 25) {
      this.key = '';
      this.state = 'none';
    }

    // ---- traffic advisories (never on top of a landing call) ----
    if (out) this.taCool = Math.max(this.taCool, 9);
    this.taCool -= dt;
    if (!out && this.taCool <= 0 && !own.onGround) {
      let best = -1;
      let bestD = 3600;
      for (let i = 0; i < nTraffic; i++) {
        const t = traffic[i];
        if (Math.abs(t.y - own.y) > 460) continue;
        const d = Math.hypot(t.x - own.x, t.z - own.z);
        if (d >= bestD) continue;
        const last = this.called.get(t.id);
        if (last !== undefined && this.time - last < 100) continue;
        bestD = d;
        best = i;
      }
      if (best >= 0) {
        out = trafficCall(own, traffic[best]);
        this.called.set(traffic[best].id, this.time);
        this.taCool = 22;
      } else {
        this.taCool = 0.5;
      }
    }
    return out;
  }
}

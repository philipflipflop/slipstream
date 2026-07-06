/**
 * A classic three-axis hold autopilot: on engage it captures the current
 * altitude, heading and airspeed, then flies pitch/roll/throttle to hold
 * them. Manual stick input disengages it (like the real thing).
 * Pure logic — no DOM/scene dependencies, so it's unit-testable.
 */
import type { FlightState, ControlInputs } from './flightModel';
import type { AircraftSpec } from './types';
import { clamp, wrapAngle } from '../core/math';

export class Autopilot {
  engaged = false;
  targetAlt = 0;
  targetHdg = 0;
  targetSpd = 0;
  /** V/S bug (m/s, magnitude): the climb/descent rate used to fly to the ALT
   *  bug — a vertical-speed selector, like the VS wheel on a real AP. */
  targetVs = 5.08;
  private minSpd = 30;
  private thrInt = 0;
  private pitchTrim = 0;

  /** minSpd 0 (helicopter) allows a hover hold; fixed-wing keeps the 30 m/s floor. */
  engage(st: FlightState, throttle: number, minSpd = 30): void {
    this.engaged = true;
    this.minSpd = minSpd;
    this.targetAlt = st.pos.y;
    this.targetHdg = st.heading;
    this.targetSpd = Math.max(st.airspeed, minSpd);
    this.targetVs = minSpd === 0 ? 4.5 : 5.08; // 1,000 fpm default (900 heli)
    this.thrInt = throttle;
    this.pitchTrim = 0;
  }

  disengage(): void {
    this.engaged = false;
  }

  /* -------- pilot-adjustable targets (real-AP style bug setting) -------- */

  adjustHeading(deltaRad: number): void {
    this.targetHdg = wrapAngle(this.targetHdg + deltaRad);
  }

  adjustAltitude(deltaM: number): void {
    this.targetAlt = clamp(this.targetAlt + deltaM, 80, 12500);
  }

  adjustSpeed(deltaMs: number, maxMs: number): void {
    this.targetSpd = clamp(this.targetSpd + deltaMs, this.minSpd, maxMs);
  }

  adjustVs(deltaMs: number, maxMs: number): void {
    this.targetVs = clamp(this.targetVs + deltaMs, 1.02, maxMs); // ≥200 fpm
  }

  /** Overwrites pitch/roll/yaw/throttle in `c`. Call once per frame. */
  update(spec: AircraftSpec, st: FlightState, c: ControlInputs, dt: number): void {
    if (!this.engaged) return;

    // helicopter: the loops swap — collective holds altitude, pitch attitude
    // holds speed. The heli flight model is already attitude-command, so the
    // AP can write attitude targets straight through the stick.
    if (spec.engine === 'heli') {
      const altErr = this.targetAlt - st.pos.y;
      const vsTarget = clamp(altErr * 0.2, -this.targetVs, this.targetVs);
      const vsErr = vsTarget - st.vel.y;
      this.thrInt = clamp(this.thrInt + vsErr * 0.06 * dt, 0, 1);
      c.throttle = clamp(this.thrInt + vsErr * 0.10, 0, 1);

      // nose down to chase speed; the trim integrator removes the P-only
      // droop (holding speed needs a standing nose-down attitude). SIGNED
      // forward speed, not |airspeed| — in a hover hold a backward drift
      // must read as negative or the AP would pitch the wrong way
      const vFwd = st.vel.x * Math.sin(st.heading) - st.vel.z * Math.cos(st.heading);
      const spdErr = this.targetSpd - vFwd;
      const rawTarget = -spdErr * 0.014 + this.pitchTrim;
      if (rawTarget > -0.32 && rawTarget < 0.22) {
        this.pitchTrim = clamp(this.pitchTrim - spdErr * 0.008 * dt, -0.3, 0.3);
      }
      c.pitch = clamp(clamp(rawTarget, -0.32, 0.22) / 0.7, -1, 1);

      // heading: banked turns in cruise, pedals in the hover — holding a
      // hover heading with bank against the torque would orbit the spot
      const hErr = wrapAngle(this.targetHdg - st.heading);
      const hover = this.targetSpd < 8;
      let bankTargetRight = clamp(hErr * 1.4, -0.35, 0.35) * (hover ? 0.1 : 1);
      if (hover) {
        c.yaw = clamp(hErr * 2.0, -0.8, 0.8);
        // null sideways drift (tail-rotor translating tendency would
        // otherwise walk the ship off its spot)
        const vRight = st.vel.x * Math.cos(st.heading) + st.vel.z * Math.sin(st.heading);
        bankTargetRight = clamp(bankTargetRight - vRight * 0.06, -0.35, 0.35);
      } else {
        c.yaw = 0;
      }
      c.roll = clamp(bankTargetRight / 0.95, -1, 1);
      return;
    }

    // --- altitude via a vertical-speed target the airframe can actually fly ---
    // airspeed protection: as speed decays toward 75% of the hold speed the
    // climb demand washes out and turns into a descend-to-recover demand,
    // so the AP can never stall the aircraft chasing altitude
    const spdMargin = clamp((st.airspeed - this.targetSpd * 0.75) / (this.targetSpd * 0.25), 0, 1);
    const altErr = this.targetAlt - st.pos.y;
    let vsTarget = clamp(altErr * 0.15, -this.targetVs * 1.2, this.targetVs) * spdMargin;
    vsTarget -= (1 - spdMargin) * 5;
    const vsErr = vsTarget - st.vel.y;

    // trim integrator (with anti-windup) removes steady-state droop
    const rawPitch = vsErr * 0.05 + this.pitchTrim - st.angVel.x * 0.6;
    if (Math.abs(rawPitch) < 0.5) {
      this.pitchTrim = clamp(this.pitchTrim + vsErr * 0.012 * dt, -0.3, 0.3);
    }
    c.pitch = clamp(rawPitch, -0.55, 0.55);

    // --- heading via bank target ---
    // heading is clockwise-positive; bank right = negative euler roll
    const hdgErr = wrapAngle(this.targetHdg - st.heading);
    const bankTargetRight = clamp(hdgErr * 1.6, -0.42, 0.42);
    const bankRight = -st.rollAngle;
    c.roll = clamp((bankTargetRight - bankRight) * 1.8 + st.angVel.z * 0.5, -0.6, 0.6);
    c.yaw = 0;

    // --- speed via throttle (PI + climb-power feed-forward) ---
    // the feed-forward puts power on WITH the climb demand instead of waiting
    // for airspeed to sag — without it pitch and throttle fight each other:
    // climb → speed decays → protection washes the climb out → nose drops →
    // speed recovers → climb resumes, a slow porpoise the pilot reads as
    // "speed and height fighting"
    const spdErr = this.targetSpd - st.airspeed;
    this.thrInt = clamp(this.thrInt + spdErr * 0.04 * dt, 0, 1);
    const climbFF = vsTarget * (vsTarget > 0 ? 0.035 : 0.012);
    c.throttle = clamp(this.thrInt + spdErr * 0.06 + climbFF, 0, 1);
  }
}

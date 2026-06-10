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
  private thrInt = 0;
  private pitchTrim = 0;

  engage(st: FlightState, throttle: number): void {
    this.engaged = true;
    this.targetAlt = st.pos.y;
    this.targetHdg = st.heading;
    this.targetSpd = Math.max(st.airspeed, 30);
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
    this.targetSpd = clamp(this.targetSpd + deltaMs, 30, maxMs);
  }

  /** Overwrites pitch/roll/yaw/throttle in `c`. Call once per frame. */
  update(spec: AircraftSpec, st: FlightState, c: ControlInputs, dt: number): void {
    if (!this.engaged) return;

    // --- altitude via a vertical-speed target the airframe can actually fly ---
    // airspeed protection: as speed decays toward 75% of the hold speed the
    // climb demand washes out and turns into a descend-to-recover demand,
    // so the AP can never stall the aircraft chasing altitude
    const spdMargin = clamp((st.airspeed - this.targetSpd * 0.75) / (this.targetSpd * 0.25), 0, 1);
    const altErr = this.targetAlt - st.pos.y;
    let vsTarget = clamp(altErr * 0.15, -7, 5) * spdMargin;
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

    // --- speed via throttle (PI, brisk enough to support climb demands) ---
    const spdErr = this.targetSpd - st.airspeed;
    this.thrInt = clamp(this.thrInt + spdErr * 0.04 * dt, 0, 1);
    c.throttle = clamp(this.thrInt + spdErr * 0.06, 0, 1);
  }
}

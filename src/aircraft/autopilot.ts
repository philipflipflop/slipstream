/**
 * A classic three-axis hold autopilot: on engage it captures the current
 * altitude, heading and airspeed, then flies pitch/roll/throttle to hold
 * them. Manual stick input disengages it (like the real thing).
 *
 * APPR mode couples it to an ILS: it intercepts and tracks the localizer on
 * GROUND TRACK (so the crab into a crosswind just emerges), holds altitude
 * until the glide path comes down to meet it, rides the 3° path at the
 * reference speed for the flap setting, flares off the radio altimeter,
 * closes the throttles, and holds the centreline on the rollout with the
 * autobrake on — a full autoland, in any fixed-wing aircraft.
 *
 * Pure logic — no DOM/scene dependencies, so it's unit-testable.
 */
import { FlightState, ControlInputs, approachSpeed } from './flightModel';
import type { AircraftSpec } from './types';
import type { IlsApproach } from '../nav/ils';
import { clamp, wrapAngle } from '../core/math';

/** approach-mode phases, in the order they are flown */
export type ApprPhase = 'off' | 'loc' | 'gs' | 'flare' | 'rollout' | 'done';

const TAN_GS = Math.tan((3 * Math.PI) / 180);
/** above this angle to the glideslope station the path cannot be regained */
const TAN_TOO_HIGH = Math.tan((6.5 * Math.PI) / 180);
/** localizer intercept speed, × the clean approach speed */
const INTERCEPT_SPEED = 1.45;
/** aim-point distance on the centreline, in turn radii */
const LEAD_RADII = 0.9;

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

  /** the ILS being flown in APPR mode (null = basic hold modes) */
  approach: IlsApproach | null = null;
  apprPhase: ApprPhase = 'off';
  /** Set (to the reason) when APPR abandons an approach it cannot finish and
   *  reverts to a climb on runway heading; the caller announces and clears it. */
  goAround: string | null = null;
  /** the speedbrake is out because APPR put it out (so APPR may stow it) */
  private apBrake = false;

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
    this.approach = null;
    this.apprPhase = 'off';
    this.goAround = null;
    this.apBrake = false;
  }

  disengage(): void {
    this.engaged = false;
    this.approach = null;
    this.apprPhase = 'off';
  }

  /** Couple to an ILS (fixed-wing only; the AP must already be engaged). */
  armApproach(app: IlsApproach): void {
    this.approach = app;
    this.apprPhase = 'loc';
    this.goAround = null;
  }

  /**
   * GO AROUND: the approach cannot end on the runway from here, so climb
   * away on runway heading in the basic modes and say why. (Before this
   * existed the mode simply kept descending: armed above the glide path it
   * "landed" kilometres beyond the far end.)
   */
  private abandonApproach(spec: AircraftSpec, st: FlightState, c: ControlInputs, reason: string): void {
    const app = this.approach!;
    this.approach = null;
    this.apprPhase = 'off';
    this.goAround = reason;
    this.targetHdg = app.course;
    this.targetAlt = Math.max(st.pos.y, app.elev + 450);
    this.targetSpd = Math.max(this.targetSpd, approachSpeed(spec, c.flaps) * 1.12, this.minSpd);
    this.pitchTrim = clamp(this.pitchTrim, -0.3, 0.3);
    c.brakes = false;
    if (this.apBrake) c.airbrake = false;
    this.apBrake = false;
  }

  /** Drop back to the basic hold modes on the present heading/altitude. */
  cancelApproach(st: FlightState): void {
    this.approach = null;
    this.apprPhase = 'off';
    this.targetHdg = st.heading;
    this.targetAlt = st.pos.y;
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

  /**
   * Overwrites pitch/roll/yaw/throttle in `c`. Call once per frame.
   * `ra` is the radio altitude of the WHEELS (m above the surface) — only
   * the approach mode's flare needs it.
   */
  update(spec: AircraftSpec, st: FlightState, c: ControlInputs, dt: number, ra = Infinity): void {
    if (!this.engaged) return;
    if (this.approach && spec.engine !== 'heli') {
      this.flyApproach(spec, st, c, dt, ra);
      return;
    }

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
    // heading is clockwise-positive; bank right = negative euler roll.
    // Bank authority scales with the airframe class: a fixed light-aircraft
    // 24° cap turned fast jets into 0.5°/s barges ("the AP doesn't turn").
    // Transports get the airline-standard ~30°, high-G fighters lean to
    // ~54° — at fighter cruise that's a proper 3°/s commanded turn.
    const bankCap = spec.gLimit >= 7 ? 0.95 : spec.gLimit <= 3 ? 0.52 : 0.42;
    const hdgErr = wrapAngle(this.targetHdg - st.heading);
    const bankTargetRight = clamp(hdgErr * 2.2, -bankCap, bankCap);
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

  /** APPR: localizer + glideslope + flare + rollout (see file header). */
  private flyApproach(
    spec: AircraftSpec, st: FlightState, c: ControlInputs, dt: number, ra: number,
  ): void {
    const app = this.approach!;
    const dirX = Math.sin(app.course);
    const dirZ = -Math.cos(app.course);
    const relX = st.pos.x - app.thrX;
    const relZ = st.pos.z - app.thrZ;
    const toGo = -(relX * dirX + relZ * dirZ);   // m still to run to the threshold
    const cross = relX * -dirZ + relZ * dirX;    // m right of the centreline
    const gs = Math.hypot(st.vel.x, st.vel.z);
    const track = gs > 5 ? Math.atan2(st.vel.x, -st.vel.z) : st.heading;

    // ---- rollout: wheels on, throttles closed, autobrake, track the line ----
    if (st.onGround && (this.apprPhase === 'flare' || this.apprPhase === 'gs' || this.apprPhase === 'rollout')) {
      this.apprPhase = 'rollout';
      const want = app.course - clamp(Math.atan2(cross, 160), -0.35, 0.35);
      c.yaw = clamp(wrapAngle(want - st.heading) * 3.2, -0.7, 0.7);
      c.roll = 0;
      c.pitch = 0;
      c.throttle = 0;
      this.thrInt = 0;
      c.brakes = true;
      if (this.apBrake) c.airbrake = false;
      this.apBrake = false;
      if (gs < 2.5) {
        // stopped on the centreline: job done, hand the aircraft back
        this.apprPhase = 'done';
        this.engaged = false;
        this.approach = null;
      }
      return;
    }

    // ---- lateral: steer the GROUND TRACK at a point on the centreline ----
    // aiming a fixed time ahead makes the intercept angle shrink smoothly to
    // zero; steering track rather than heading means a crosswind is held
    // off with exactly the crab it needs, no integrator required.
    // The aim point must also be about a TURN RADIUS ahead, or a fast
    // intercept cannot follow its own command and sails through the beam
    // (a jet at 400 kt flew 1 to 4 km past the centreline): lead grows with
    // the radius at the bank this airframe may use, and fighters may bank
    // like fighters while still high.
    const bankHi = spec.gLimit >= 7 ? 0.8 : 0.44;
    const turnR = (gs * gs) / (9.81 * Math.tan(bankHi));
    const lead = clamp(Math.max(gs * 11, turnR * LEAD_RADII), 420, 14000);
    const wantTrack = app.course - clamp(Math.atan2(cross, lead), -0.7, 0.7);
    const trkErr = wrapAngle(wantTrack - track);
    // airline bank limits low down, tightening to wings-nearly-level in the flare
    const bankCap = ra < 12 ? 0.07 : ra < 60 ? 0.2 : ra < 150 ? 0.44 : bankHi;
    const bankTargetRight = clamp(trkErr * 2.4, -bankCap, bankCap);
    c.roll = clamp((bankTargetRight + st.rollAngle) * 2.0 + st.angVel.z * 0.5, -0.6, 0.6);
    c.yaw = 0;

    // ---- vertical ----
    // height above the 3° path from the station 300 m inside the threshold
    const pathY = app.elev + 2.5 + TAN_GS * (toGo + 300);
    const hErr = st.pos.y - pathY;
    // the glide path is only taken once ESTABLISHED on the localizer: inside
    // the beam and tracking along it. (Position alone used to do: crossing
    // the beam at 90 degrees captured the glideslope, and the aircraft
    // descended into the hills kilometres off the centreline.)
    if (this.apprPhase === 'loc' && toGo > 0 && hErr > -18 &&
        Math.abs(cross) < Math.max(toGo * 0.05, 90) &&
        Math.abs(wrapAngle(track - app.course)) < 0.3) {
      this.apprPhase = 'gs'; // the path has come down to meet us (or we are above it)
    }

    // ---- can this still end on the runway? ----
    if (this.apprPhase === 'gs') {
      let why: string | null = null;
      // too high to regain the path: the steepest descent the mode flies is
      // about twice the glide path
      const need = (st.pos.y - app.elev) / Math.max(toGo + 300, 1);
      if (ra > 100 && need > TAN_TOO_HIGH) why = 'APPR OFF — TOO HIGH FOR THE GLIDE PATH: DESCEND, RE-ARM';
      // the stabilised-approach gate, ~300 ft up: on the path, on the
      // centreline, wheels down, or go around. Speed is judged last, at
      // ~100 ft: a slippery jet is still shedding it down the final mile,
      // and 25 kt over the reference at the flare is a float off the far end
      else if (ra < 90 && toGo < 1800) {
        if (spec.retractableGear && !c.gearDown) why = 'GO AROUND — GEAR NOT DOWN';
        else if (hErr > 22) why = 'GO AROUND — TOO HIGH';
        else if (Math.abs(cross) > 28) why = 'GO AROUND — OFF THE CENTRELINE';
        else if (ra < 34 && st.airspeed > approachSpeed(spec, c.flaps) + 13) why = 'GO AROUND — TOO FAST';
      }
      if (why) {
        this.abandonApproach(spec, st, c, why);
        this.update(spec, st, c, dt, ra);
        return;
      }
    } else if (this.apprPhase === 'flare' && !st.onGround && -toGo > app.length * 0.55) {
      // floated past the middle of the runway: not enough left to stop on
      this.abandonApproach(spec, st, c, 'GO AROUND — LONG LANDING');
      this.update(spec, st, c, dt, ra);
      return;
    } else if (this.apprPhase === 'loc' && toGo < -300) {
      // never got established before the runway went by underneath
      this.abandonApproach(spec, st, c, 'APPR OFF — RUNWAY PASSED BEFORE THE LOCALIZER WAS CAPTURED');
      this.update(spec, st, c, dt, ra);
      return;
    }
    const sink = -st.vel.y;
    // exponential flare: commanded sink decays with height (time constant
    // FLARE_TAU) to a ~110 fpm touchdown. It begins at the height where
    // that law meets the approach's own sink rate — so the hand-over is
    // smooth — plus a second of lead for the airframe to answer (heavies
    // need every bit of it).
    const FLARE_TAU = 3.0;
    const FLARE_VS = 0.55;
    const flareH = clamp((sink - FLARE_VS) * FLARE_TAU + sink * 1.0, 5, 30);
    if (this.apprPhase === 'gs' && ra < flareH && toGo < 900) this.apprPhase = 'flare';

    // loop gain is scheduled on pitch AUTHORITY: the G-limit cap leaves a
    // transport a quarter of a trainer's rate per unit stick at approach
    // speed, and a path loop that loose lets the phugoid breathe against
    // the autothrottle (a slow ±800 fpm porpoise down the glide path)
    const auth = Math.min(spec.pitchRate, (spec.gLimit * 9.81) / (Math.max(st.airspeed, 15) * 1.24));
    const kAuth = clamp(1 / auth, 0.9, 4);
    let vsTarget: number;
    // (and never looser than 0.1: on the back side of the drag curve — a
    // delta at approach alpha — a slack path loop leaves the phugoid ringing)
    let pGain = Math.max(0.05 * kAuth, 0.1);
    if (this.apprPhase === 'flare') {
      vsTarget = -FLARE_VS - Math.max(ra - sink * 0.9, 0) / FLARE_TAU;
      pGain = 0.085 * kAuth;
    } else if (this.apprPhase === 'gs') {
      // ride the beam: the path's own sink rate plus a pull toward it
      const nominal = -gs * TAN_GS;
      vsTarget = clamp(nominal - hErr * 0.14, nominal * 2.2 - 1.5, 2.5);
    } else {
      const altErr = this.targetAlt - st.pos.y;
      vsTarget = clamp(altErr * 0.15, -this.targetVs * 1.2, this.targetVs);
    }

    // managed speed: on the glide path the target bleeds to the reference
    // speed for whatever flap is set — select flap and it slows to match.
    // Before that, from the moment the mode is armed, it slows to an
    // intercept speed: nobody captures a localizer at cruise speed (the
    // turn radius is kilometres) and the glide path leaves no room to
    // lose 200 kt.
    if (this.apprPhase !== 'loc') {
      const vapp = Math.max(approachSpeed(spec, c.flaps), this.minSpd * 0.6);
      this.targetSpd += clamp(vapp - this.targetSpd, -1.6 * dt, 1.6 * dt);
    } else {
      const vInt = approachSpeed(spec, 0) * INTERCEPT_SPEED;
      if (this.targetSpd > vInt) this.targetSpd = Math.max(this.targetSpd - 1.6 * dt, vInt);
    }
    // same airspeed protection as the basic modes
    const spdMargin = clamp((st.airspeed - this.targetSpd * 0.75) / (this.targetSpd * 0.25), 0, 1);
    if (this.apprPhase !== 'flare') {
      vsTarget = vsTarget * spdMargin - (1 - spdMargin) * 5;
    }
    const vsErr = vsTarget - st.vel.y;
    const rawPitch = vsErr * pGain + this.pitchTrim - st.angVel.x * 0.6;
    if (Math.abs(rawPitch) < 0.6) {
      this.pitchTrim = clamp(this.pitchTrim + vsErr * 0.03 * dt, -0.45, 0.45);
    }
    c.pitch = clamp(rawPitch, -0.6, 0.75);

    // ---- speedbrake: out to lose a large excess, stowed again once it is
    // gone. Only what the mode put out is taken back: the pilot's own
    // selection is left alone.
    if (spec.airbrakeCd > 0) {
      const over = st.airspeed - this.targetSpd;
      if (this.apprPhase === 'flare' || over < 3) {
        if (this.apBrake) c.airbrake = false;
        this.apBrake = false;
      } else if (over > 9 && !c.airbrake) {
        c.airbrake = true;
        this.apBrake = true;
      }
    }

    // ---- thrust ----
    if (this.apprPhase === 'flare') {
      // RETARD: throttles to idle through the flare
      this.thrInt = Math.max(this.thrInt - 0.5 * dt, 0);
      c.throttle = this.thrInt;
    } else {
      const spdErr = this.targetSpd - st.airspeed;
      this.thrInt = clamp(this.thrInt + spdErr * 0.04 * dt, 0, 1);
      const climbFF = vsTarget * (vsTarget > 0 ? 0.035 : 0.012);
      c.throttle = clamp(this.thrInt + spdErr * 0.06 + climbFF, 0, 1);
    }
  }
}

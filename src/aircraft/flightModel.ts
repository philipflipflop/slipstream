/**
 * Force-based flight dynamics.
 * Body frame: -Z forward, +Y up, +X right (three.js convention).
 * Lift follows a real CL curve with post-stall falloff, induced drag scales
 * with CL², control authority scales with dynamic pressure, and air density
 * thins with altitude — so every aircraft flies like its numbers.
 */
import * as THREE from 'three';
import type { AircraftSpec } from './types';
import { clamp } from '../core/math';
import { WATER_LEVEL, AIRPORTS, AirfieldDef } from '../world/heightfield';

export interface ControlInputs {
  pitch: number;    // -1..1, + = pull
  roll: number;     // -1..1, + = right
  yaw: number;      // -1..1, + = right rudder
  throttle: number; // 0..1
  flaps: number;    // 0..1
  gearDown: boolean;
  brakes: boolean;   // wheel brakes
  airbrake: boolean; // speed brake / spoilers (aircraft with airbrakeCd > 0)
}

export interface FlightState {
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  vel: THREE.Vector3;        // world m/s
  angVel: THREE.Vector3;     // body rad/s
  onGround: boolean;
  crashed: boolean;
  crashReason: string;
  // instruments
  airspeed: number;          // m/s
  aoa: number;               // rad
  gForce: number;
  stalled: boolean;
  heading: number;           // rad, 0 = north (-Z)
  pitchAngle: number;        // rad
  rollAngle: number;         // rad
  thrustFrac: number;        // realized thrust 0..~1.5 (AB)
  spool: number;             // realized engine fraction (jets lag the lever)
  gustT: number;             // turbulence phase accumulator
}

export function createState(): FlightState {
  return {
    pos: new THREE.Vector3(),
    quat: new THREE.Quaternion(),
    vel: new THREE.Vector3(),
    angVel: new THREE.Vector3(),
    onGround: true,
    crashed: false,
    crashReason: '',
    airspeed: 0,
    aoa: 0,
    gForce: 1,
    stalled: false,
    heading: 0,
    pitchAngle: 0,
    rollAngle: 0,
    thrustFrac: 0,
    spool: 0,
    gustT: 0,
  };
}

const GRAV = 9.81;

/**
 * Global turbulence intensity (0 = calm). The game sets a light default;
 * tests run with 0 so physics stay exactly deterministic and assertable.
 */
let turbulence = 0;
export function setTurbulence(t: number): void { turbulence = t; }

// scratch (no per-frame allocation)
const _qInv = new THREE.Quaternion();
const _vLocal = new THREE.Vector3();
const _wDir = new THREE.Vector3();
const _liftDir = new THREE.Vector3();
const _force = new THREE.Vector3();
const _dq = new THREE.Quaternion();
const _fwd = new THREE.Vector3();
const _up = new THREE.Vector3();
const _euler = new THREE.Euler();
const _right = new THREE.Vector3(1, 0, 0);
const _hVel = new THREE.Vector3();

export type HeightFn = (x: number, z: number) => number;

/** Advance the simulation one substep. */
export function stepFlight(
  spec: AircraftSpec,
  st: FlightState,
  inp: ControlInputs,
  dt: number,
  heightAt: HeightFn,
): void {
  if (st.crashed) return;

  const rho = 1.225 * Math.exp(-Math.max(st.pos.y, 0) / 8500);
  const V = st.vel.length();
  st.airspeed = V;

  const groundY = heightAt(st.pos.x, st.pos.z);
  const agl = st.pos.y - Math.max(groundY, WATER_LEVEL) - spec.gearHeight;

  // ground effect: within roughly a wingspan of the surface the wingtip
  // vortices are suppressed — induced drag falls away and lift firms up,
  // which is what makes a real flare float and a heavy takeoff "unstick"
  const span = Math.sqrt(spec.wingArea * spec.aspect);
  const ge = clamp(1 - agl / (span * 0.9), 0, 1);

  _qInv.copy(st.quat).invert();
  _vLocal.copy(st.vel).applyQuaternion(_qInv);

  // --- aerodynamic angles ---
  let aoa = 0;
  let slip = 0;
  if (V > 1) {
    aoa = Math.atan2(-_vLocal.y, -_vLocal.z);
    slip = Math.atan2(_vLocal.x, -_vLocal.z);
  }
  st.aoa = aoa;

  const qbar = 0.5 * rho * V * V;
  const S = spec.wingArea;

  _force.set(0, 0, 0);

  // --- lift / drag / side force ---
  let stalled = false;
  if (V > 1) {
    _wDir.copy(_vLocal).normalize();

    // lift coefficient with post-stall falloff
    let cl = spec.cl0 + spec.clSlope * aoa + spec.flapsCl * inp.flaps;
    const aAbs = Math.abs(aoa);
    if (aAbs > spec.stallAoA) {
      const over = clamp((aAbs - spec.stallAoA) / 0.12, 0, 1);
      const clMax = spec.cl0 + spec.clSlope * spec.stallAoA * Math.sign(aoa || 1) + spec.flapsCl * inp.flaps;
      cl = THREE.MathUtils.lerp(clMax, Math.sin(2 * aoa) * 0.9, over);
      stalled = over > 0.15;
    }

    const cdInduced = ((cl * cl) / (Math.PI * 0.72 * spec.aspect)) * (1 - 0.42 * ge * ge);
    const cd =
      spec.cd0 +
      cdInduced +
      0.5 * slip * slip + // skidding through the air costs energy
      spec.flapsCd * inp.flaps +
      (inp.airbrake ? spec.airbrakeCd : 0) +
      (inp.gearDown && spec.retractableGear ? spec.gearCd : 0) +
      (stalled ? 0.05 : 0);

    // lift ⟂ relative wind, in the plane of symmetry
    _liftDir.crossVectors(_right, _wDir).normalize();
    const L = qbar * S * cl * (1 + 0.07 * ge * ge);
    const D = qbar * S * cd;
    const Y = qbar * S * -1.1 * slip; // sideforce opposes slip

    _force.addScaledVector(_liftDir, L);
    _force.addScaledVector(_wDir, -D);
    _force.x += Y;
  }
  st.stalled = stalled && !st.onGround;

  // --- thrust ---
  // engines spool: a turbojet takes seconds to wind from idle to full power
  // while a prop responds almost immediately — the lever commands, the
  // spool delivers
  const spoolUp = spec.engine === 'jet' ? 0.5 : 2.4;
  const spoolDown = spec.engine === 'jet' ? 0.65 : 2.8;
  st.spool += clamp(inp.throttle - st.spool, -spoolDown * dt, spoolUp * dt);
  let thrustMul = st.spool;
  if (spec.afterburner && inp.throttle >= 0.995 && st.spool > 0.96) thrustMul *= spec.afterburner;
  const speedLoss = 1 - spec.propFalloff * clamp(V / spec.vne, 0, 1);
  const altLoss = spec.engine === 'jet' ? 0.45 + 0.55 * (rho / 1.225) : 0.6 + 0.4 * (rho / 1.225);
  const T = spec.maxThrust * thrustMul * speedLoss * altLoss;
  st.thrustFrac = (T / spec.maxThrust) || 0;
  _force.z -= T;

  // g-force (aero+thrust accel along body up, in g)
  st.gForce = _force.y / (spec.mass * GRAV) + Math.max(0, 1 - V * 0.002);

  // body forces → world, add gravity
  _force.applyQuaternion(st.quat);
  _force.y -= spec.mass * GRAV;

  st.vel.addScaledVector(_force, dt / spec.mass);
  st.pos.addScaledVector(st.vel, dt);

  // --- rotational dynamics ---
  const eff = qbar / (qbar + 420); // control surfaces need airflow
  const av = st.angVel;

  // structural/aero G-limit: at speed, pitch authority is capped so a full
  // pull holds roughly the airframe's rated load factor instead of letting
  // the nose swap ends (the 1.24 cancels the command/damping gain ratio so
  // a full-stick pull settles right at the rated G)
  const pitchRate = Math.min(spec.pitchRate, (spec.gLimit * GRAV) / (Math.max(V, 15) * 1.24));

  // fly-by-wire alpha limiter (fighter): washes out the pull near stall AoA
  let pitchCmd = inp.pitch;
  if (spec.fbw) {
    if (pitchCmd > 0 && aoa > 0) {
      pitchCmd *= clamp((spec.stallAoA * 0.92 - aoa) / (spec.stallAoA * 0.3), 0, 1);
    } else if (pitchCmd < 0 && aoa < 0) {
      pitchCmd *= clamp((aoa + spec.stallAoA * 0.7) / (spec.stallAoA * 0.3), 0, 1);
    }
  }

  // weathervane stability and damping both stiffen with true speed, so the
  // nose tracks the velocity vector instead of pirouetting at high Mach
  const vStiff = 1 + V / 260;
  const vDamp = 1 + V / 320;

  // command terms scale with vDamp too, so damping shapes the response but
  // doesn't erode the achievable rates at speed
  let aaX =
    pitchCmd * pitchRate * 5.2 * eff * vDamp -
    aoa * 5.5 * spec.stability * eff * vStiff -
    av.x * (4.2 * eff * vDamp + 0.35);
  let aaY =
    -inp.yaw * spec.yawRate * 2.4 * eff * vDamp -
    slip * 4.5 * spec.stability * eff * vStiff -
    av.y * (3.4 * eff * vDamp + 0.3);
  let aaZ =
    -inp.roll * spec.rollRate * 5.8 * eff * vDamp -
    av.z * (5.2 * eff * vDamp + 0.4);

  // prop torque + slipstream/P-factor: at high power and low airspeed the
  // propeller rolls the airframe left and the corkscrewing slipstream yaws
  // the nose left — a full-power takeoff wants a touch of right rudder.
  // Faded out by ~45 m/s so cruise stays hands-off trimmable.
  if (spec.engine === 'prop' && T > 0) {
    const lowV = clamp(1 - V / 45, 0, 1);
    aaZ += (T / spec.mass) * 0.05 * lowV;
    aaY += (T / spec.mass) * 0.04 * lowV;
  }

  // light turbulence: smooth deterministic gusts, strongest down low where
  // thermals and terrain rotor live, fading out by ~2.5 km
  if (turbulence > 0 && !st.onGround) {
    st.gustT += dt;
    const g = st.gustT;
    const ti = turbulence * (0.35 + 0.65 * clamp(1 - st.pos.y / 2500, 0, 1));
    aaX += (Math.sin(g * 2.17) + Math.sin(g * 5.3 + 2.0)) * 0.05 * ti;
    aaZ += (Math.sin(g * 1.73 + 4.0) + Math.sin(g * 4.1 + 1.0)) * 0.085 * ti;
    aaY += Math.sin(g * 1.31 + 2.6) * 0.028 * ti;
    st.vel.y += Math.sin(g * 2.43 + 0.7) * 0.5 * ti * dt;
  }

  // --- ground interaction ---
  const surfaceY = Math.max(groundY, WATER_LEVEL - 0.5);
  const contactY = surfaceY + spec.gearHeight;

  if (st.pos.y <= contactY) {
    const sinkRate = -st.vel.y;
    _up.set(0, 1, 0).applyQuaternion(st.quat);

    // crash conditions
    const onWater = groundY < WATER_LEVEL - 0.6;
    _euler.setFromQuaternion(st.quat, 'YXZ');
    const badAttitude = _up.y < 0.7 || _euler.x < -0.45;
    if (onWater) {
      crash(st, V > 30 ? 'HIT THE WATER AT SPEED' : 'DITCHED IN THE SEA');
      return;
    }
    if (sinkRate > 9) {
      crash(st, 'STRUCTURAL FAILURE — HARD IMPACT');
      return;
    }
    if (badAttitude) {
      crash(st, 'AIRFRAME DESTROYED ON IMPACT');
      return;
    }
    const slope = surfaceSlope(heightAt, st.pos.x, st.pos.z);
    if (slope > 0.35 && V > 12) {
      crash(st, 'FLEW INTO TERRAIN');
      return;
    }

    // settle on gear
    st.onGround = true;
    st.pos.y = contactY;
    if (st.vel.y < 0) st.vel.y = sinkRate > 2.2 ? sinkRate * -0.25 : 0; // small bounce on firm arrivals

    // rolling resistance + brakes oppose ground track
    // (drop is capped at gs, so friction alone brings the plane to rest
    // without ever fighting fresh thrust)
    _hVel.set(st.vel.x, 0, st.vel.z);
    const gs = _hVel.length();
    if (gs > 1e-6) {
      const decel = (inp.brakes ? 4.6 : 0.55) + gs * 0.012;
      const drop = Math.min(decel * dt, gs);
      st.vel.addScaledVector(_hVel.normalize(), -drop);
    }

    // nosewheel steering, fading with speed
    const steer = -inp.yaw * 1.1 * clamp(1 - gs / 90, 0.18, 1) * clamp(gs / 4, 0, 1);
    aaY += (steer - av.y) * 6;

    // wheels keep the velocity tracking the nose
    if (gs > 0.5) {
      _fwd.set(0, 0, -1).applyQuaternion(st.quat);
      _fwd.y = 0;
      _fwd.normalize();
      const sign = _hVel.normalize().dot(_fwd) >= 0 ? 1 : -1;
      const k = clamp(8 * dt, 0, 1);
      st.vel.x = THREE.MathUtils.lerp(st.vel.x, _fwd.x * gs * sign, k);
      st.vel.z = THREE.MathUtils.lerp(st.vel.z, _fwd.z * gs * sign, k);
    }

    // ground springs the attitude toward its parked stance
    const roll = _euler.z;
    const pitch = _euler.x;
    aaZ += (0 - roll) * 9 - av.z * 6;
    aaX += (spec.groundPitch - pitch) * 5.5 - av.x * 3.2;
    st.gForce = 1;
  } else {
    st.onGround = false;
  }

  av.x += aaX * dt;
  av.y += aaY * dt;
  av.z += aaZ * dt;

  // integrate orientation (body rates, right-multiplied)
  _dq.set(av.x * dt * 0.5, av.y * dt * 0.5, av.z * dt * 0.5, 1).normalize();
  st.quat.multiply(_dq).normalize();

  // instruments (compass heading: clockwise from north, east = +90°)
  _fwd.set(0, 0, -1).applyQuaternion(st.quat);
  st.heading = Math.atan2(_fwd.x, -_fwd.z);
  _euler.setFromQuaternion(st.quat, 'YXZ');
  st.pitchAngle = _euler.x;
  st.rollAngle = _euler.z;
}

function surfaceSlope(heightAt: HeightFn, x: number, z: number): number {
  const e = 6;
  const dx = heightAt(x + e, z) - heightAt(x - e, z);
  const dz = heightAt(x, z + e) - heightAt(x, z - e);
  return Math.hypot(dx, dz) / (2 * e);
}

function crash(st: FlightState, reason: string): void {
  st.crashed = true;
  st.crashReason = reason;
  st.vel.multiplyScalar(0.1);
  st.angVel.set(0, 0, 0);
}

/** Park the aircraft at the runway threshold, pointing down the strip. */
export function spawnOnRunway(
  spec: AircraftSpec,
  st: FlightState,
  heightAt: HeightFn,
  field: AirfieldDef = AIRPORTS[0],
): void {
  // threshold = centre minus (half length − 150 m) along the runway heading
  const d = field.length / 2 - 150;
  const x = field.x - field.sinH * d;
  const z = field.z + field.cosH * d;
  st.pos.set(x, 0, z);
  st.pos.y = heightAt(x, z) + spec.gearHeight;
  st.quat.setFromEuler(new THREE.Euler(spec.groundPitch, -field.heading, 0, 'YXZ'));
  st.vel.set(0, 0, 0);
  st.angVel.set(0, 0, 0);
  st.onGround = true;
  st.crashed = false;
  st.crashReason = '';
  st.stalled = false;
  st.gForce = 1;
  st.spool = 0;
  st.gustT = 0;
}

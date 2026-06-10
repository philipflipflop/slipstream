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
import { WATER_LEVEL } from '../world/heightfield';

export interface ControlInputs {
  pitch: number;    // -1..1, + = pull
  roll: number;     // -1..1, + = right
  yaw: number;      // -1..1, + = right rudder
  throttle: number; // 0..1
  flaps: number;    // 0..1
  gearDown: boolean;
  brakes: boolean;
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
  };
}

const GRAV = 9.81;

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

    const cdInduced = (cl * cl) / (Math.PI * 0.8 * spec.aspect);
    const cd =
      spec.cd0 +
      cdInduced +
      spec.flapsCd * inp.flaps +
      (inp.gearDown && spec.retractableGear ? spec.gearCd : 0) +
      (stalled ? 0.05 : 0);

    // lift ⟂ relative wind, in the plane of symmetry
    _liftDir.crossVectors(_right, _wDir).normalize();
    const L = qbar * S * cl;
    const D = qbar * S * cd;
    const Y = qbar * S * -1.1 * slip; // sideforce opposes slip

    _force.addScaledVector(_liftDir, L);
    _force.addScaledVector(_wDir, -D);
    _force.x += Y;
  }
  st.stalled = stalled && !st.onGround;

  // --- thrust ---
  let thrustMul = inp.throttle;
  if (spec.afterburner && inp.throttle >= 0.995) thrustMul *= spec.afterburner;
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
  const eff = qbar / (qbar + 320); // control surfaces need airflow
  const av = st.angVel;

  let aaX = inp.pitch * spec.pitchRate * 5.2 * eff - aoa * 5.5 * spec.stability * eff - av.x * (4.2 * eff + 0.35);
  let aaY = -inp.yaw * spec.yawRate * 2.4 * eff - slip * 4.5 * spec.stability * eff - av.y * (3.4 * eff + 0.3);
  let aaZ = -inp.roll * spec.rollRate * 5.8 * eff - av.z * (5.2 * eff + 0.4);

  // --- ground interaction ---
  const groundY = heightAt(st.pos.x, st.pos.z);
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

  // instruments
  _fwd.set(0, 0, -1).applyQuaternion(st.quat);
  st.heading = Math.atan2(-_fwd.x, -_fwd.z);
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

/** Park the aircraft at the runway 36 threshold, pointing north (-Z). */
export function spawnOnRunway(spec: AircraftSpec, st: FlightState, heightAt: HeightFn): void {
  st.pos.set(0, 0, 620);
  st.pos.y = heightAt(0, 620) + spec.gearHeight;
  st.quat.setFromEuler(new THREE.Euler(spec.groundPitch, 0, 0, 'YXZ'));
  st.vel.set(0, 0, 0);
  st.angVel.set(0, 0, 0);
  st.onGround = true;
  st.crashed = false;
  st.crashReason = '';
  st.stalled = false;
  st.gForce = 1;
}

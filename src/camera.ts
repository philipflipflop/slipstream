/**
 * Flight cameras: smoothed chase cam with speed-reactive FOV, a fixed
 * cockpit view with free-look, and a slow cinematic orbit. C cycles.
 * Mouse/touch-drag orbits the view (recentres on release); wheel zooms.
 */
import * as THREE from 'three';
import type { Aircraft } from './aircraft/aircraft';
import { clamp, damp } from './core/math';

export type CameraMode = 'chase' | 'cockpit' | 'orbit';
const MODES: CameraMode[] = ['chase', 'cockpit', 'orbit'];

export class FlightCamera {
  camera: THREE.PerspectiveCamera;
  mode: CameraMode = 'chase';

  private posSmooth = new THREE.Vector3();
  private lookSmooth = new THREE.Vector3();
  private initialized = false;
  private orbitAngle = 0;
  private shake = 0;

  // user look-around state
  private userYaw = 0;
  private userPitch = 0;
  private dragging = false;
  private zoom = 1;

  private _target = new THREE.Vector3();
  private _desired = new THREE.Vector3();
  private _offset = new THREE.Vector3();
  private _up = new THREE.Vector3();
  private _yawQ = new THREE.Quaternion();
  private _pitchQ = new THREE.Quaternion();
  private _lookQ = new THREE.Quaternion();
  private _right = new THREE.Vector3();

  constructor(aspect: number) {
    // near=1 doubles far-field depth precision vs 0.5 — kills shoreline
    // z-fighting (the airframe is hidden in cockpit view, so nothing sits
    // closer than ~1 m anyway)
    // far plane reaches past the corners of the far terrain shell; raising
    // far barely costs depth precision (that's governed by near)
    this.camera = new THREE.PerspectiveCamera(62, aspect, 1.0, 60000);
  }

  cycle(): CameraMode {
    this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
    this.initialized = false;
    this.userYaw = 0;
    this.userPitch = 0;
    return this.mode;
  }

  set(mode: CameraMode): void {
    this.mode = mode;
    this.initialized = false;
    this.userYaw = 0;
    this.userPitch = 0;
  }

  addShake(amount: number): void {
    this.shake = Math.min(this.shake + amount, 1.6);
  }

  beginDrag(): void { this.dragging = true; }
  endDrag(): void { this.dragging = false; }

  drag(dx: number, dy: number): void {
    const k = 0.0042;
    this.userYaw -= dx * k;
    this.userPitch = clamp(this.userPitch - dy * k, -1.1, 1.1);
    if (this.mode === 'cockpit') {
      this.userYaw = clamp(this.userYaw, -2.6, 2.6);
    }
  }

  wheel(deltaY: number): void {
    this.zoom = clamp(this.zoom * Math.exp(deltaY * 0.0011), 0.55, 2.6);
  }

  update(ac: Aircraft, dt: number, heightAt: (x: number, z: number) => number): void {
    const st = ac.state;
    const spec = ac.spec;
    this.shake = Math.max(0, this.shake - dt * 2.4);

    // free-look recentres once the pointer is released
    if (!this.dragging && this.mode !== 'orbit') {
      this.userYaw = damp(this.userYaw, 0, 3.2, dt);
      this.userPitch = damp(this.userPitch, 0, 3.2, dt);
    }

    if (this.mode === 'cockpit') {
      this._offset.set(spec.cockpit.x, spec.cockpit.y, spec.cockpit.z);
      this._offset.applyQuaternion(st.quat);
      this.camera.position.copy(st.pos).add(this._offset);

      this._yawQ.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, this.userYaw);
      this._pitchQ.setFromAxisAngle(new THREE.Vector3(1, 0, 0), this.userPitch);
      this._lookQ.copy(st.quat).multiply(this._yawQ).multiply(this._pitchQ);
      this.camera.quaternion.copy(this._lookQ);

      // light airframe buzz; gentle buffet in the stall
      const buzz = 0.0012 + (st.stalled ? 0.004 : 0);
      this.camera.position.y += (Math.random() - 0.5) * buzz * st.airspeed * 0.05;
      this.camera.position.x += (Math.random() - 0.5) * buzz * st.airspeed * 0.05;
      this.camera.fov = damp(this.camera.fov, 68, 4, dt);
      this.camera.updateProjectionMatrix();
      return;
    }

    if (this.mode === 'orbit') {
      this.orbitAngle += dt * 0.22;
      const r = spec.chaseDist * 1.7 * this.zoom;
      const a = this.orbitAngle + this.userYaw;
      this._desired.set(
        st.pos.x + Math.cos(a) * r,
        st.pos.y + spec.chaseHeight * (0.9 + this.userPitch * 2),
        st.pos.z + Math.sin(a) * r,
      );
      const minY = heightAt(this._desired.x, this._desired.z) + 2.5;
      if (this._desired.y < minY) this._desired.y = minY;
      this.camera.position.copy(this._desired);
      this.camera.lookAt(st.pos);
      this.camera.fov = damp(this.camera.fov, 58, 4, dt);
      this.camera.updateProjectionMatrix();
      return;
    }

    // --- chase ---
    this._offset.set(0, spec.chaseHeight, spec.chaseDist * this.zoom);
    this._offset.applyQuaternion(st.quat);
    // user orbit: swing the offset around the aircraft
    if (Math.abs(this.userYaw) > 0.002 || Math.abs(this.userPitch) > 0.002) {
      this._yawQ.setFromAxisAngle(THREE.Object3D.DEFAULT_UP, this.userYaw);
      this._offset.applyQuaternion(this._yawQ);
      this._right.crossVectors(THREE.Object3D.DEFAULT_UP, this._offset).normalize();
      this._pitchQ.setFromAxisAngle(this._right, this.userPitch);
      this._offset.applyQuaternion(this._pitchQ);
    }
    this._desired.copy(st.pos).add(this._offset);
    this._up.set(0, 1, 0);

    const minY = heightAt(this._desired.x, this._desired.z) + 2;
    if (this._desired.y < minY) this._desired.y = minY;

    this._target.copy(st.pos);
    this._target.addScaledVector(st.vel, 0.05);

    if (!this.initialized) {
      this.posSmooth.copy(this._desired);
      this.lookSmooth.copy(this._target);
      this.initialized = true;
    } else {
      // snappier follow = more planted feel
      this.posSmooth.lerp(this._desired, 1 - Math.exp(-10 * dt));
      this.lookSmooth.lerp(this._target, 1 - Math.exp(-14 * dt));
    }

    this.camera.position.copy(this.posSmooth);
    if (this.shake > 0.01) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake;
      this.camera.position.y += (Math.random() - 0.5) * this.shake;
      this.camera.position.z += (Math.random() - 0.5) * this.shake;
    }
    this.camera.up.copy(this._up);
    this.camera.lookAt(this.lookSmooth);

    // modest FOV opening with speed
    const speedFrac = clamp(st.airspeed / spec.vne, 0, 1);
    this.camera.fov = damp(this.camera.fov, 60 + speedFrac * 9, 3, dt);
    this.camera.updateProjectionMatrix();
  }
}

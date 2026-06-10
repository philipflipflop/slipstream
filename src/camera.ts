/**
 * Flight cameras: smoothed chase cam with speed-reactive FOV, a fixed
 * cockpit view, and a slow cinematic orbit. C cycles through them.
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

  private _target = new THREE.Vector3();
  private _desired = new THREE.Vector3();
  private _offset = new THREE.Vector3();
  private _up = new THREE.Vector3();

  constructor(aspect: number) {
    this.camera = new THREE.PerspectiveCamera(62, aspect, 0.5, 42000);
  }

  cycle(): CameraMode {
    this.mode = MODES[(MODES.indexOf(this.mode) + 1) % MODES.length];
    this.initialized = false;
    return this.mode;
  }

  set(mode: CameraMode): void {
    this.mode = mode;
    this.initialized = false;
  }

  addShake(amount: number): void {
    this.shake = Math.min(this.shake + amount, 1.6);
  }

  update(ac: Aircraft, dt: number, heightAt: (x: number, z: number) => number): void {
    const st = ac.state;
    const spec = ac.spec;
    this.shake = Math.max(0, this.shake - dt * 2.4);

    if (this.mode === 'cockpit') {
      this._offset.set(spec.cockpit.x, spec.cockpit.y, spec.cockpit.z);
      this._offset.applyQuaternion(st.quat);
      this.camera.position.copy(st.pos).add(this._offset);
      this.camera.quaternion.copy(st.quat);
      // gentle vibration with throttle + buffet in stall
      const buzz = 0.0016 * ac.spec.maxThrust * 0.0001 + (st.stalled ? 0.012 : 0);
      if (buzz > 0.0005) {
        this.camera.position.y += (Math.random() - 0.5) * buzz;
        this.camera.position.x += (Math.random() - 0.5) * buzz;
      }
      this.camera.fov = damp(this.camera.fov, 68, 4, dt);
      this.camera.updateProjectionMatrix();
      return;
    }

    if (this.mode === 'orbit') {
      this.orbitAngle += dt * 0.22;
      const r = spec.chaseDist * 1.7;
      this._desired.set(
        st.pos.x + Math.cos(this.orbitAngle) * r,
        st.pos.y + spec.chaseHeight * 0.9,
        st.pos.z + Math.sin(this.orbitAngle) * r,
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
    this._offset.set(0, spec.chaseHeight, spec.chaseDist);
    this._offset.applyQuaternion(st.quat);
    // keep the camera from rolling fully with the plane: bias toward world-up
    this._desired.copy(st.pos).add(this._offset);
    this._up.set(0, 1, 0);

    const minY = heightAt(this._desired.x, this._desired.z) + 2;
    if (this._desired.y < minY) this._desired.y = minY;

    this._target.copy(st.pos);
    this._target.addScaledVector(st.vel, 0.06); // lead the velocity a touch

    if (!this.initialized) {
      this.posSmooth.copy(this._desired);
      this.lookSmooth.copy(this._target);
      this.initialized = true;
    } else {
      const k = 1 - Math.exp(-7.5 * dt);
      this.posSmooth.lerp(this._desired, k);
      this.lookSmooth.lerp(this._target, 1 - Math.exp(-12 * dt));
    }

    this.camera.position.copy(this.posSmooth);
    if (this.shake > 0.01) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake;
      this.camera.position.y += (Math.random() - 0.5) * this.shake;
      this.camera.position.z += (Math.random() - 0.5) * this.shake;
    }
    this.camera.up.copy(this._up);
    this.camera.lookAt(this.lookSmooth);

    // FOV opens up with speed for a sense of velocity
    const speedFrac = clamp(st.airspeed / spec.vne, 0, 1);
    this.camera.fov = damp(this.camera.fov, 60 + speedFrac * 16, 3, dt);
    this.camera.updateProjectionMatrix();
  }
}

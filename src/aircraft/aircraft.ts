/**
 * Binds a spec + procedural model + flight state into one flyable thing,
 * and animates the airframe: spinning prop with blur disc, deflecting
 * control surfaces, retracting gear, afterburner flame.
 */
import * as THREE from 'three';
import type { AircraftSpec } from './types';
import { buildAircraftModel } from './models';
import {
  ControlInputs, FlightState, createState, stepFlight, spawnOnRunway, HeightFn,
} from './flightModel';
import { damp, clamp } from '../core/math';

const SUBSTEPS = 3;

export class Aircraft {
  spec: AircraftSpec;
  model: THREE.Group;
  state: FlightState;

  private props: THREE.Object3D[] = [];
  private propDiscs: THREE.Mesh[] = [];
  private aileronL?: THREE.Object3D;
  private aileronR?: THREE.Object3D;
  private elevator?: THREE.Object3D;
  private rudder?: THREE.Object3D;
  private gear?: THREE.Object3D;
  private burner?: THREE.Mesh;

  private propAngle = 0;
  private gearAnim = 1; // 1 = down
  private smoothPitch = 0;
  private smoothRoll = 0;
  private smoothYaw = 0;

  constructor(spec: AircraftSpec) {
    this.spec = spec;
    this.model = buildAircraftModel(spec.id);
    this.state = createState();

    this.model.traverse((o) => {
      if (o.name === 'prop') this.props.push(o);
      else if (o.name === 'propDisc') this.propDiscs.push(o as THREE.Mesh);
      else if (o.name === 'aileronL') this.aileronL = o;
      else if (o.name === 'aileronR') this.aileronR = o;
      else if (o.name === 'elevator') this.elevator = o;
      else if (o.name === 'rudder') this.rudder = o;
      else if (o.name === 'gear') this.gear = o;
      else if (o.name === 'burner') this.burner = o as THREE.Mesh;
    });
  }

  resetOnRunway(heightAt: HeightFn): void {
    spawnOnRunway(this.spec, this.state, heightAt);
    this.gearAnim = 1;
    this.syncModel();
  }

  update(inp: ControlInputs, dt: number, heightAt: HeightFn): void {
    const sub = dt / SUBSTEPS;
    for (let i = 0; i < SUBSTEPS; i++) {
      stepFlight(this.spec, this.state, inp, sub, heightAt);
    }
    this.animate(inp, dt);
    this.syncModel();
  }

  private syncModel(): void {
    this.model.position.copy(this.state.pos);
    this.model.quaternion.copy(this.state.quat);
  }

  private animate(inp: ControlInputs, dt: number): void {
    const st = this.state;

    // prop spin + blur disc
    if (this.props.length > 0) {
      const rpmFrac = 0.12 + inp.throttle * 0.88;
      this.propAngle += rpmFrac * 75 * dt;
      for (const p of this.props) p.rotation.z = this.propAngle;
      for (const d of this.propDiscs) {
        const m = d.material as THREE.MeshBasicMaterial;
        m.opacity = damp(m.opacity, rpmFrac > 0.35 ? 0.16 : 0, 8, dt);
      }
    }

    // control surfaces follow smoothed input
    this.smoothPitch = damp(this.smoothPitch, inp.pitch, 14, dt);
    this.smoothRoll = damp(this.smoothRoll, inp.roll, 14, dt);
    this.smoothYaw = damp(this.smoothYaw, inp.yaw, 14, dt);
    const MAX = 0.5;
    if (this.elevator) this.elevator.rotation.x = -this.smoothPitch * MAX;
    if (this.aileronL) this.aileronL.rotation.x = this.smoothRoll * MAX;
    if (this.aileronR) this.aileronR.rotation.x = -this.smoothRoll * MAX;
    if (this.rudder) this.rudder.rotation.y = -this.smoothYaw * MAX;

    // gear retraction
    if (this.gear && this.spec.retractableGear) {
      const target = inp.gearDown ? 1 : 0;
      this.gearAnim = damp(this.gearAnim, target, 3.2, dt);
      const s = clamp(this.gearAnim, 0.001, 1);
      this.gear.scale.setScalar(s);
      this.gear.visible = this.gearAnim > 0.04;
    }

    // afterburner
    if (this.burner) {
      const ab = !!this.spec.afterburner && inp.throttle >= 0.995 && !st.crashed;
      this.burner.visible = ab;
      if (ab) {
        const flick = 0.85 + Math.random() * 0.3;
        this.burner.scale.set(flick, 0.8 + Math.random() * 0.5, flick);
      }
    }
  }

  dispose(): void {
    this.model.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.geometry.dispose();
    });
  }
}

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
import type { AirfieldDef } from '../world/heightfield';
import { damp, clamp } from '../core/math';

const SUBSTEPS = 3;

export class Aircraft {
  spec: AircraftSpec;
  model: THREE.Group;
  state: FlightState;

  private props: THREE.Object3D[] = [];
  private tailRotors: THREE.Object3D[] = [];
  private propDiscs: THREE.Mesh[] = [];
  private aileronL?: THREE.Object3D;
  private aileronR?: THREE.Object3D;
  private elevator?: THREE.Object3D;
  private rudder?: THREE.Object3D;
  private gear?: THREE.Object3D;
  private burner?: THREE.Mesh;

  private propAngle = 0;
  private rotorSpin = 0; // helicopter rotor spool 0..1 (governed once up)
  private gearAnim = 1; // 1 = down
  private lightT = 0;
  private beaconLight: THREE.Mesh | null = null;
  private strobeLight: THREE.Mesh | null = null;
  private landingLight: THREE.SpotLight | null = null;
  private smoothPitch = 0;
  private smoothRoll = 0;
  private smoothYaw = 0;

  constructor(spec: AircraftSpec) {
    this.spec = spec;
    this.model = buildAircraftModel(spec.id);
    this.state = createState();

    this.model.traverse((o) => {
      if (o.name === 'prop') this.props.push(o);
      else if (o.name === 'tailrotor') this.tailRotors.push(o);
      else if (o.name === 'propDisc') this.propDiscs.push(o as THREE.Mesh);
      else if (o.name === 'aileronL') this.aileronL = o;
      else if (o.name === 'aileronR') this.aileronR = o;
      else if (o.name === 'elevator') this.elevator = o;
      else if (o.name === 'rudder') this.rudder = o;
      else if (o.name === 'gear') this.gear = o;
      else if (o.name === 'burner') this.burner = o as THREE.Mesh;
    });
  }

  /**
   * Exterior lights: red anti-collision beacon on the spine and a white
   * tail strobe (always fitted — they blink day and night, like the real
   * things), plus an optional landing-light spotlight for the dark presets
   * (one extra scene light, so the day preset skips the shader cost).
   */
  addExteriorLights(withLandingLight: boolean): void {
    const box = new THREE.Box3().setFromObject(this.model);
    const glowGeo = new THREE.SphereGeometry(0.16, 6, 5);
    this.beaconLight = new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({ color: 0xff2222 }));
    this.beaconLight.position.set(0, box.max.y + 0.12, (box.min.z + box.max.z) * 0.35);
    this.model.add(this.beaconLight);
    this.strobeLight = new THREE.Mesh(glowGeo, new THREE.MeshBasicMaterial({ color: 0xffffff }));
    this.strobeLight.position.set(0, box.max.y * 0.55, box.max.z - 0.25);
    this.model.add(this.strobeLight);

    if (withLandingLight) {
      // decay 0: a landing light is a collimated beam, not a bare bulb —
      // with distance falloff it would vanish long before the runway
      // aimed ~5° below boresight. Intensity looks huge, but the beam meets
      // a flat runway at grazing incidence — Lambert's cosine eats ~94% of
      // it, exactly why real landing lights are hundreds of thousands of
      // candela. ACES tone mapping rolls off anything hit face-on.
      const spot = new THREE.SpotLight(0xfff2d8, 14, 460, 0.3, 0.5, 0);
      spot.position.set(0, -0.3, box.min.z + 1.2);
      spot.target.position.set(0, -6.6, box.min.z - 72);
      this.model.add(spot);
      this.model.add(spot.target);
      this.landingLight = spot;
    }
  }

  resetOnRunway(heightAt: HeightFn, field?: AirfieldDef): void {
    spawnOnRunway(this.spec, this.state, heightAt, field);
    this.gearAnim = 1;
    this.rotorSpin = 0;
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

    // prop spin + blur disc. Helicopter rotors are governed: they spool to
    // 100% at flight start and hold RPM regardless of collective.
    if (this.props.length > 0) {
      const heli = this.spec.engine === 'heli';
      let rpmFrac: number;
      if (heli) {
        // visual rotor follows NR — droops with the physics, stops when parked
        this.rotorSpin = damp(this.rotorSpin, st.crashed ? 0 : st.rotorRpm, 0.9, dt);
        rpmFrac = this.rotorSpin;
      } else {
        rpmFrac = 0.12 + inp.throttle * 0.88;
      }
      this.propAngle += rpmFrac * (heli ? 44 : 75) * dt;
      for (const p of this.props) p.rotation.z = this.propAngle;
      for (const t of this.tailRotors) t.rotation.z = this.propAngle * 5.2;
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

    // exterior lights: slow red beacon pulse, sharp white double strobe
    if (this.beaconLight) {
      this.lightT += dt;
      const bt = this.lightT % 1.9;
      this.beaconLight.visible = bt < 0.28 && !st.crashed;
      const stT = this.lightT % 1.3;
      this.strobeLight!.visible = (stT < 0.05 || (stT > 0.12 && stT < 0.17)) && !st.crashed;
      if (this.landingLight) {
        this.landingLight.visible =
          !st.crashed && (this.spec.retractableGear ? inp.gearDown : true);
      }
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

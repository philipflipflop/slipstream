/**
 * Ring Rush — a slalom of gates threading away from the airfield,
 * laid out over the terrain with safe clearance.
 */
import * as THREE from 'three';
import { WorldGen, RUNWAY_LENGTH } from './heightfield';

export const RING_COUNT = 14;
const RING_RADIUS = 30;

interface Ring {
  pos: THREE.Vector3;
  axis: THREE.Vector3;
  mesh: THREE.Mesh;
  mat: THREE.MeshStandardMaterial;
}

export class RingCourse {
  rings: Ring[] = [];
  current = 0;
  active = false;
  private group = new THREE.Group();
  private prevRel = new THREE.Vector3();
  private tmp = new THREE.Vector3();

  constructor(scene: THREE.Scene, gen: WorldGen) {
    const torus = new THREE.TorusGeometry(RING_RADIUS, 2.4, 10, 36);

    // carve a curving path north from the runway
    let x = 0;
    let z = -RUNWAY_LENGTH / 2 - 700;
    let heading = 0; // radians, 0 = flying toward -Z
    let y = 140;
    for (let i = 0; i < RING_COUNT; i++) {
      const dirX = -Math.sin(heading);
      const dirZ = -Math.cos(heading);

      // keep clearance over the highest ground near the gate
      let ground = -100;
      for (let dx = -150; dx <= 150; dx += 150)
        for (let dz = -150; dz <= 150; dz += 150)
          ground = Math.max(ground, gen.heightAt(x + dx, z + dz));
      const targetY = Math.max(ground + 110, 120);
      y += THREE.MathUtils.clamp(targetY - y, -120, 160);

      const mat = new THREE.MeshStandardMaterial({
        color: 0x153041,
        emissive: 0x2bd9ff,
        emissiveIntensity: 0.35,
        roughness: 0.4,
        metalness: 0.3,
        transparent: true,
        opacity: 0.95,
      });
      const mesh = new THREE.Mesh(torus, mat);
      mesh.position.set(x, y, z);
      const axis = new THREE.Vector3(dirX, 0, dirZ).normalize();
      mesh.lookAt(mesh.position.clone().add(axis));
      this.group.add(mesh);
      this.rings.push({ pos: mesh.position.clone(), axis, mesh, mat });

      // advance with a sweeping S-curve
      heading += Math.sin(i * 0.82 + 0.6) * 0.46;
      const step = 760 + (i % 3) * 140;
      x += -Math.sin(heading) * step;
      z += -Math.cos(heading) * step;
    }

    this.group.visible = false;
    scene.add(this.group);
  }

  start(planePos: THREE.Vector3): void {
    this.active = true;
    this.current = 0;
    this.group.visible = true;
    for (const r of this.rings) {
      r.mat.emissive.setHex(0x2bd9ff);
      r.mat.emissiveIntensity = 0.35;
      r.mat.opacity = 0.95;
      r.mesh.visible = true;
      r.mesh.scale.setScalar(1);
    }
    this.prevRel.copy(planePos);
  }

  stop(): void {
    this.active = false;
    this.group.visible = false;
  }

  target(): Ring | null {
    return this.active && this.current < this.rings.length ? this.rings[this.current] : null;
  }

  /** Advance pass detection; returns 'pass' | 'finish' | 'none'. */
  update(planePos: THREE.Vector3, time: number): 'pass' | 'finish' | 'none' {
    if (!this.active) return 'none';

    // animate: target ring pulses amber, the rest shimmer
    for (let i = this.current; i < this.rings.length; i++) {
      const r = this.rings[i];
      if (i === this.current) {
        const p = (Math.sin(time * 5) + 1) * 0.5;
        r.mat.emissive.setHex(0xffb340);
        r.mat.emissiveIntensity = 0.7 + p * 0.9;
        r.mesh.scale.setScalar(1 + p * 0.05);
      }
      r.mesh.rotation.z += 0.000001; // keep matrices warm (negligible)
    }

    let result: 'pass' | 'finish' | 'none' = 'none';
    const ring = this.rings[this.current];
    if (ring) {
      const prevSide = this.tmp.copy(this.prevRel).sub(ring.pos).dot(ring.axis);
      const curSide = this.tmp.copy(planePos).sub(ring.pos).dot(ring.axis);
      if (prevSide <= 0 && curSide > 0) {
        // crossed the gate plane — check radial miss distance at crossing
        const radial = this.tmp.copy(planePos).sub(ring.pos).addScaledVector(ring.axis, -curSide).length();
        if (radial < RING_RADIUS + 6) {
          ring.mat.emissive.setHex(0x47ff8a);
          ring.mat.emissiveIntensity = 1.6;
          ring.mat.opacity = 0.5;
          ring.mesh.scale.setScalar(1.12);
          this.current++;
          result = this.current >= this.rings.length ? 'finish' : 'pass';
          if (result === 'finish') this.active = false;
        }
      }
    }
    this.prevRel.copy(planePos);
    return result;
  }
}

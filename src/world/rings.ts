/**
 * Ring Rush — a slalom of gates threading away from the airfield,
 * laid out over the terrain with safe clearance.
 */
import * as THREE from 'three';
import { WorldGen, AIRPORTS } from './heightfield';

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

    // carve a curving path north from the spawn runway (the western one
    // of the international's parallel pair)
    const home = AIRPORTS[0];
    const across = home.rwySep ? -home.rwySep / 2 : 0;
    let x = home.x + home.cosH * across;
    let z = home.z + home.sinH * across - home.length / 2 - 700;
    let heading = 0; // radians, 0 = flying toward -Z
    // lay the track out first, then the heights: every gate clears the
    // highest ground near it, and a climb the course cannot make in one leg
    // (160 m) starts a gate or two EARLIER — a gate may never end up inside
    // the hill it was supposed to lead over
    const track: Array<{ x: number; z: number; heading: number; y: number }> = [];
    for (let i = 0; i < RING_COUNT; i++) {
      let ground = -100;
      for (let dx = -150; dx <= 150; dx += 150)
        for (let dz = -150; dz <= 150; dz += 150)
          ground = Math.max(ground, gen.heightAt(x + dx, z + dz));
      track.push({ x, z, heading, y: Math.max(ground + 110, 120) });
      // advance with a sweeping S-curve
      heading += Math.sin(i * 0.82 + 0.6) * 0.46;
      const step = 760 + (i % 3) * 140;
      x += -Math.sin(heading) * step;
      z += -Math.cos(heading) * step;
    }
    let y = 140;
    for (const g of track) {
      y = Math.max(g.y, y - 120);   // descend gently, never below clearance
      g.y = y;
    }
    for (let i = RING_COUNT - 2; i >= 0; i--) {
      track[i].y = Math.max(track[i].y, track[i + 1].y - 160);
    }

    for (let i = 0; i < RING_COUNT; i++) {
      x = track[i].x;
      z = track[i].z;
      y = track[i].y;
      const dirX = -Math.sin(track[i].heading);
      const dirZ = -Math.cos(track[i].heading);

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

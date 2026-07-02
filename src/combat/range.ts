/**
 * Gunnery range: a cluster of tethered target balloons east of Meridian
 * Field plus the Vector's cannon — tracer rounds with real ballistics
 * (muzzle velocity + aircraft velocity, gravity drop), terrain and balloon
 * collision, hit feedback. Deterministic balloon layout from the seed hash.
 */
import * as THREE from 'three';
import type { WorldGen } from '../world/heightfield';
import type { FlightState } from '../aircraft/flightModel';
import { hash2 } from '../core/math';

const MAX_ROUNDS = 96;
const MUZZLE_V = 880;      // m/s
const FIRE_INTERVAL = 1 / 16;
const ROUND_TTL = 3.2;
const BALLOON_R = 7;       // generous — these are practice targets
export const AMMO_MAX = 260;

interface Round { pos: THREE.Vector3; vel: THREE.Vector3; ttl: number }

interface Balloon {
  pos: THREE.Vector3;
  alive: boolean;
  popT: number; // >0 while the pop flash animates
  mesh: THREE.Mesh;
  tether: THREE.Line;
}

const _fwd = new THREE.Vector3();
const _m = new THREE.Matrix4();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3(1, 1, 1);
const _zAxis = new THREE.Vector3(0, 0, 1);
const _prev = new THREE.Vector3();
const _seg = new THREE.Vector3();
const _toC = new THREE.Vector3();

/**
 * Swept collision: rounds cover ~15–20 m per frame at muzzle velocity —
 * more than a balloon's diameter — so a point-in-sphere test at the end of
 * the step tunnels straight through. Test the whole travel segment instead.
 */
function segmentHitsSphere(p0: THREE.Vector3, p1: THREE.Vector3, c: THREE.Vector3, r: number): boolean {
  _seg.subVectors(p1, p0);
  _toC.subVectors(c, p0);
  const len2 = _seg.lengthSq();
  const t = len2 > 1e-9 ? THREE.MathUtils.clamp(_toC.dot(_seg) / len2, 0, 1) : 0;
  _toC.addScaledVector(_seg, -t); // now: c − closest point on segment
  return _toC.lengthSq() < r * r;
}

export class GunneryRange {
  ammo = AMMO_MAX;
  hits = 0;
  readonly total = 10;
  onHit: (hits: number, total: number) => void = () => {};
  onClear: () => void = () => {};
  /** optional obstacle test — rounds also stop on buildings and trees */
  solid: ((x: number, y: number, z: number) => boolean) | null = null;

  private rounds: Round[] = [];
  private balloons: Balloon[] = [];
  private tracers: THREE.InstancedMesh;
  private fireCd = 0;
  private cleared = false;

  constructor(private scene: THREE.Scene, private gen: WorldGen) {
    // tracer pool: stretched glowing shards, oriented along velocity
    const geo = new THREE.BoxGeometry(0.22, 0.22, 5.5);
    const mat = new THREE.MeshBasicMaterial({ color: 0xffd27a, transparent: true, opacity: 0.95 });
    this.tracers = new THREE.InstancedMesh(geo, mat, MAX_ROUNDS);
    this.tracers.count = 0;
    this.tracers.frustumCulled = false;
    scene.add(this.tracers);

    const balloonGeo = new THREE.SphereGeometry(BALLOON_R * 0.8, 12, 10);
    const tetherMat = new THREE.LineBasicMaterial({ color: 0x9aa7b8, transparent: true, opacity: 0.55 });
    for (let i = 0; i < this.total; i++) {
      // deterministic spread on a rough arc east of the home field
      const ang = (i / this.total) * Math.PI * 0.9 - 0.45;
      const r = 2300 + hash2(i * 7 + 3, i * 13 + 1) * 1500;
      const x = 3300 + Math.sin(ang) * r * 0.55 + (hash2(i, i * 3) - 0.5) * 700;
      const z = -900 - Math.cos(ang) * r * 0.4 - i * 260;
      const ground = this.gen.heightAt(x, z);
      const y = Math.max(ground, 0) + 160 + hash2(i * 5, i * 11) * 420;

      const mat2 = new THREE.MeshLambertMaterial({
        color: i % 2 ? 0xff5a36 : 0xffb340,
        emissive: i % 2 ? 0x551205 : 0x553305,
      });
      const mesh = new THREE.Mesh(balloonGeo, mat2);
      mesh.position.set(x, y, z);
      mesh.scale.y = 1.18;

      const tetherGeo = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(x, y - BALLOON_R * 0.7, z),
        new THREE.Vector3(x, Math.max(ground, 0), z),
      ]);
      const tether = new THREE.Line(tetherGeo, tetherMat);

      scene.add(mesh);
      scene.add(tether);
      this.balloons.push({ pos: mesh.position, alive: true, popT: 0, mesh, tether });
    }
  }

  /** Positions of the balloons still flying (tests + future HUD cues). */
  liveTargets(): THREE.Vector3[] {
    return this.balloons.filter((b) => b.alive).map((b) => b.pos);
  }

  /** Restock and reinflate everything (called on flight start). */
  reset(): void {
    this.ammo = AMMO_MAX;
    this.hits = 0;
    this.cleared = false;
    this.rounds.length = 0;
    this.tracers.count = 0;
    this.fireCd = 0;
    for (const b of this.balloons) {
      b.alive = true;
      b.popT = 0;
      b.mesh.visible = true;
      b.mesh.scale.set(1, 1.18, 1);
      (b.mesh.material as THREE.MeshLambertMaterial).opacity = 1;
      (b.mesh.material as THREE.MeshLambertMaterial).transparent = false;
      b.tether.visible = true;
    }
  }

  update(dt: number, st: FlightState, firing: boolean): void {
    // --- fire ---
    this.fireCd -= dt;
    if (firing && this.ammo > 0 && this.fireCd <= 0 && this.rounds.length < MAX_ROUNDS) {
      this.fireCd = FIRE_INTERVAL;
      this.ammo--;
      _fwd.set(0, 0, -1).applyQuaternion(st.quat);
      const r: Round = {
        pos: st.pos.clone().addScaledVector(_fwd, 9),
        vel: st.vel.clone().addScaledVector(_fwd, MUZZLE_V),
        ttl: ROUND_TTL,
      };
      // slight dispersion
      r.vel.x += (Math.random() - 0.5) * 6;
      r.vel.y += (Math.random() - 0.5) * 6;
      r.vel.z += (Math.random() - 0.5) * 6;
      this.rounds.push(r);
    }

    // --- integrate rounds ---
    for (let i = this.rounds.length - 1; i >= 0; i--) {
      const r = this.rounds[i];
      _prev.copy(r.pos);
      r.vel.y -= 9.81 * dt;
      r.pos.addScaledVector(r.vel, dt);
      r.ttl -= dt;

      // solid checks sample the midpoint too — a step outruns a small house
      const mx = (_prev.x + r.pos.x) / 2;
      const my = (_prev.y + r.pos.y) / 2;
      const mz = (_prev.z + r.pos.z) / 2;
      let dead = r.ttl <= 0 || r.pos.y < this.gen.heightAt(r.pos.x, r.pos.z) || r.pos.y < 0 ||
        (this.solid !== null && (this.solid(r.pos.x, r.pos.y, r.pos.z) || this.solid(mx, my, mz)));
      if (!dead) {
        for (const b of this.balloons) {
          if (!b.alive) continue;
          if (segmentHitsSphere(_prev, r.pos, b.pos, BALLOON_R)) {
            this.pop(b);
            dead = true;
            break;
          }
        }
      }
      if (dead) {
        this.rounds[i] = this.rounds[this.rounds.length - 1];
        this.rounds.pop();
      }
    }

    // --- tracer instances ---
    this.tracers.count = this.rounds.length;
    for (let i = 0; i < this.rounds.length; i++) {
      const r = this.rounds[i];
      _q.setFromUnitVectors(_zAxis, _fwd.copy(r.vel).normalize());
      _m.compose(r.pos, _q, _s);
      this.tracers.setMatrixAt(i, _m);
    }
    if (this.rounds.length > 0 || this.tracers.count > 0) {
      this.tracers.instanceMatrix.needsUpdate = true;
    }

    // --- pop animation: balloon swells and fades over a quarter second ---
    for (const b of this.balloons) {
      if (b.popT > 0) {
        b.popT -= dt;
        const t = 1 - Math.max(b.popT, 0) / 0.28;
        b.mesh.scale.setScalar(1 + t * 2.6);
        const m = b.mesh.material as THREE.MeshLambertMaterial;
        m.transparent = true;
        m.opacity = 1 - t;
        if (b.popT <= 0) b.mesh.visible = false;
      }
    }
  }

  private pop(b: Balloon): void {
    b.alive = false;
    b.popT = 0.28;
    b.tether.visible = false;
    this.hits++;
    this.onHit(this.hits, this.total);
    if (this.hits >= this.total && !this.cleared) {
      this.cleared = true;
      this.onClear();
    }
  }
}

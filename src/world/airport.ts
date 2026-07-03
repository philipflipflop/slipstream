/**
 * Airfield furniture, built on demand for whichever airfields (hand-placed
 * or procedural) are near the player: painted runway, edge lighting, PAPI
 * and a windsock everywhere; the major home field also gets hangars, a
 * control tower and an apron. Far fields are disposed again.
 *
 * Airfield lights follow the real-world rule that lights are POINT sources
 * seen at range: the meshes are rescaled per frame so they never shrink
 * below a couple of pixels, and their materials ignore fog — on a clear
 * night runway lights and the white/green airport beacon are visible from
 * many kilometres out, which is how you find the field in the dark.
 */
import * as THREE from 'three';
import { WorldGen, AirfieldDef } from './heightfield';
import { clamp } from '../core/math';

const BUILD_RADIUS = 20000;
const DROP_RADIUS = 24000;

function runwayTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 2048;
  const ctx = c.getContext('2d')!;

  ctx.fillStyle = '#2a2c30';
  ctx.fillRect(0, 0, 256, 2048);
  for (let i = 0; i < 220; i++) {
    ctx.fillStyle = `rgba(${20 + Math.random() * 40},${20 + Math.random() * 40},${22 + Math.random() * 40},0.16)`;
    ctx.fillRect(Math.random() * 256, Math.random() * 2048, 2 + Math.random() * 8, 14 + Math.random() * 80);
  }
  ctx.fillStyle = '#e8e4da';
  for (const yBase of [18, 2048 - 58]) {
    for (let i = 0; i < 8; i++) ctx.fillRect(14 + i * 30, yBase, 18, 40);
  }
  for (let y = 160; y < 1900; y += 96) ctx.fillRect(122, y, 12, 52);
  ctx.fillRect(4, 0, 5, 2048);
  ctx.fillRect(247, 0, 5, 2048);
  ctx.font = 'bold 84px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText('36', 128, 188);
  ctx.save();
  ctx.translate(128, 1900);
  ctx.rotate(Math.PI);
  ctx.fillText('18', 0, 0);
  ctx.restore();

  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

interface BuiltField {
  def: AirfieldDef;
  group: THREE.Group;
  sockPivot: THREE.Group;
  beacon: THREE.Mesh | null;
  /** PAPI boxes (southern approach) + their world positions, closest first */
  papi: Array<{ mesh: THREE.Mesh; world: THREE.Vector3 }>;
  /** runway edge lights: instanced mesh + local and world positions */
  edge: { mesh: THREE.InstancedMesh; local: Float32Array; world: Float32Array };
  /** alternating white/green airport beacon + steady facility glow (night presets only) */
  aeroBeacon: { white: THREE.Sprite; green: THREE.Sprite; glow: THREE.Sprite } | null;
}

/** PAPI glide-path thresholds, closest box first: 4 white = high,
 *  2 white 2 red = on the 3° slope, 4 red = dangerously low. */
const PAPI_DEG = [3.5, 3.2, 2.8, 2.5];

const _m = new THREE.Matrix4();
const _v = new THREE.Vector3();

export class Airport {
  private built = new Map<string, BuiltField>();
  private tex: THREE.CanvasTexture;
  private rwMat: THREE.MeshLambertMaterial;
  private scanTimer = 0;
  private queryScratch: AirfieldDef[] = [];
  private windPointYaw = Math.PI; // world yaw the sock POINTS (downwind)
  private windKt = 0;

  constructor(private scene: THREE.Scene, private gen: WorldGen, private nightOps = false) {
    this.tex = runwayTexture();
    this.rwMat = new THREE.MeshLambertMaterial({ map: this.tex });
  }

  /** Wind for the windsocks: aviation convention, heading the wind is FROM. */
  setWind(fromHeading: number, kt: number): void {
    this.windPointYaw = fromHeading + Math.PI;
    this.windKt = kt;
  }

  update(time: number, px: number, pz: number, py = 0): void {
    // light-size floor: lights never shrink below ~2 px; night lets them
    // bloom much larger so a lit runway carries across the valley
    // (d/450 holds ≈2 px at any range at 1280 px width)
    const maxS = this.nightOps ? 60 : 3;
    const divisor = this.nightOps ? 350 : 900;

    for (const f of this.built.values()) {
      // windsock: points downwind, droops when the wind is light, flutters
      const localYaw = Math.PI / 2 - this.windPointYaw + f.def.heading;
      const flutter = Math.sin(time * (1.6 + this.windKt * 0.12)) * (0.03 + 1.2 / (4 + this.windKt * 2));
      const droop = clamp(1 - this.windKt / 14, 0.06, 0.9) * 0.85;
      f.sockPivot.rotation.set(0, localYaw + flutter, -droop, 'YZX');

      if (f.beacon) {
        const pulse = (Math.sin(time * 4.2) + 1) * 0.5;
        (f.beacon.material as THREE.MeshBasicMaterial).color.setRGB(0.45 + pulse, 0.08, 0.08);
      }

      // airport beacon: rotating white/green — one flash of each per sweep —
      // over a steady faint glow (the lit-apron ambience that marks a field
      // even between flashes). Constant screen size (sizeAttenuation off),
      // like a real point light; fades out once you're basically overhead.
      if (f.aeroBeacon) {
        const t = time % 2;
        f.aeroBeacon.white.visible = t < 0.24;
        f.aeroBeacon.green.visible = t > 1.0 && t < 1.24;
        const d = Math.hypot(px - f.def.x, pz - f.def.z);
        // constant ANGULAR size: world scale grows linearly with range, so
        // the beacon holds ~5 px at any distance (sizeAttenuation:false
        // would do this for free but is broken under the log depth buffer)
        const s = Math.max(d * 0.005, 2.5);
        const prox = clamp((d - 500) / 900, 0, 1);
        f.aeroBeacon.white.scale.set(s, s, 1);
        f.aeroBeacon.green.scale.set(s, s, 1);
        f.aeroBeacon.glow.scale.set(s * 0.7, s * 0.7, 1);
        (f.aeroBeacon.white.material as THREE.SpriteMaterial).opacity = 0.95 * prox;
        (f.aeroBeacon.green.material as THREE.SpriteMaterial).opacity = 0.95 * prox;
        (f.aeroBeacon.glow.material as THREE.SpriteMaterial).opacity = 0.45 * prox;
      }

      // runway edge lights: rescale so distant ones hold ~2 px
      const { mesh, local, world } = f.edge;
      const n = local.length / 3;
      for (let i = 0; i < n; i++) {
        const d = Math.hypot(px - world[i * 3], py - world[i * 3 + 1], pz - world[i * 3 + 2]);
        const s = clamp(d / divisor, 1, maxS);
        _m.makeScale(s, s, s);
        _m.setPosition(local[i * 3], local[i * 3 + 1], local[i * 3 + 2]);
        mesh.setMatrixAt(i, _m);
      }
      mesh.instanceMatrix.needsUpdate = true;

      // PAPI: each box compares the aircraft's angle above its own position
      // against its slope threshold — white above, red below, so the row
      // reads the classic "two white two red, you're all right"
      for (let i = 0; i < f.papi.length; i++) {
        const b = f.papi[i];
        const dist = Math.hypot(px - b.world.x, pz - b.world.z);
        if (dist > 12000) continue; // too far to resolve — skip the math
        const angle = Math.atan2(py - b.world.y, Math.max(dist, 1)) * (180 / Math.PI);
        (b.mesh.material as THREE.MeshBasicMaterial).color.setHex(
          angle > PAPI_DEG[i] ? 0xfff4e0 : 0xff2418,
        );
        b.mesh.scale.setScalar(clamp(dist / (this.nightOps ? 550 : 1100), 1, this.nightOps ? 22 : 3));
      }
    }

    // (re)scan for nearby fields twice a second
    this.scanTimer -= 1;
    if (this.scanTimer > 0) return;
    this.scanTimer = 30;

    const near = this.gen.airfieldsNear(px, pz, BUILD_RADIUS, this.queryScratch);
    for (const def of near) {
      const key = `${def.x},${def.z}`;
      if (!this.built.has(key)) this.buildField(def, key);
    }
    for (const [key, f] of this.built) {
      if (Math.hypot(f.def.x - px, f.def.z - pz) > DROP_RADIUS) {
        this.scene.remove(f.group);
        f.group.traverse((o) => {
          const m = o as THREE.Mesh;
          if (m.isMesh && m.geometry) m.geometry.dispose();
        });
        this.built.delete(key);
      }
    }
  }

  private buildField(ap: AirfieldDef, key: string): void {
    const g = new THREE.Group();
    const E = ap.elev;

    const rw = new THREE.Mesh(new THREE.PlaneGeometry(ap.width, ap.length), this.rwMat);
    rw.rotation.x = -Math.PI / 2;
    rw.position.set(ap.x, E + 0.06, ap.z);
    rw.receiveShadow = true;
    g.add(rw);

    // edge lights (fog-immune point sources, rescaled per frame)
    const lightGeo = new THREE.SphereGeometry(0.42, 6, 5);
    const edgeMat = new THREE.MeshBasicMaterial({ color: 0xffdd88, fog: false });
    const n = Math.floor(ap.length / 60);
    const lights = new THREE.InstancedMesh(lightGeo, edgeMat, n * 2);
    const local = new Float32Array(n * 2 * 3);
    for (let i = 0; i < n; i++) {
      const z = ap.z - ap.length / 2 + 30 + i * 60;
      local.set([ap.x - ap.width / 2 - 2.5, E + 0.5, z], i * 6);
      local.set([ap.x + ap.width / 2 + 2.5, E + 0.5, z], i * 6 + 3);
    }
    for (let i = 0; i < n * 2; i++) {
      _m.makeTranslation(local[i * 3], local[i * 3 + 1], local[i * 3 + 2]);
      lights.setMatrixAt(i, _m);
    }
    // instanced bounds are the 0.42 m base sphere — never let that cull a
    // 2.4 km string of lights
    lights.frustumCulled = false;
    g.add(lights);

    // windsock on a pivot near the southern threshold (wind points it)
    const sockX = ap.x - ap.width / 2 - 14;
    const sockZ = ap.z + ap.length / 2 - 80;
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.18, 9, 6),
      new THREE.MeshLambertMaterial({ color: 0xd8dde2 }),
    );
    pole.position.set(sockX, E + 4.5, sockZ);
    g.add(pole);
    const sockPivot = new THREE.Group();
    sockPivot.position.set(sockX, E + 8.6, sockZ);
    const sock = new THREE.Mesh(
      new THREE.ConeGeometry(1.1, 5.5, 8, 1, true),
      new THREE.MeshLambertMaterial({ color: 0xff7a1a, side: THREE.DoubleSide }),
    );
    sock.rotation.z = Math.PI / 2; // cone axis along the pivot's +x arm
    sock.position.set(2.75, 0, 0);
    sockPivot.add(sock);
    g.add(sockPivot);

    let beacon: THREE.Mesh | null = null;
    if (ap.major) {
      beacon = this.buildMajorExtras(g, ap);
    }

    // PAPI row on the left of the southern touchdown zone (runway 36 side)
    const papi: Array<{ mesh: THREE.Mesh; world: THREE.Vector3 }> = [];
    const papiGeo = new THREE.BoxGeometry(1.8, 0.9, 0.9);
    for (let i = 0; i < 4; i++) {
      const box = new THREE.Mesh(papiGeo, new THREE.MeshBasicMaterial({ color: 0xfff4e0, fog: false }));
      box.position.set(ap.x - ap.width / 2 - 16 - i * 9, E + 0.8, ap.z + ap.length / 2 - 260);
      g.add(box);
      papi.push({ mesh: box, world: new THREE.Vector3() });
    }

    // airport beacon: alternating white/green flash, the "find me" light.
    // Night presets only — by day it reads as visual noise.
    let aeroBeacon: BuiltField['aeroBeacon'] = null;
    if (this.nightOps) {
      const bx = ap.major ? ap.x + 120 : sockX;
      const by = ap.major ? E + 35 : E + 10.2;
      const bz = ap.major ? ap.z + 30 : sockZ;
      if (!ap.major) {
        const mast = new THREE.Mesh(
          new THREE.CylinderGeometry(0.12, 0.12, 2.6, 5),
          new THREE.MeshLambertMaterial({ color: 0x9aa0a6 }),
        );
        mast.position.set(bx, E + 9.9, bz);
        g.add(mast);
      }
      const mk = (color: number, opacity: number): THREE.Sprite => {
        const sp = new THREE.Sprite(new THREE.SpriteMaterial({
          color, transparent: true, opacity, fog: false,
          blending: THREE.AdditiveBlending, depthWrite: false,
        }));
        sp.position.set(bx, by, bz);
        sp.visible = false;
        sp.frustumCulled = false;
        g.add(sp);
        return sp;
      };
      const glow = mk(0xffdf9e, 0.3);
      glow.visible = true;
      aeroBeacon = { white: mk(0xffffff, 0.95), green: mk(0x38ff66, 0.95), glow };
    }

    // furniture is laid out as if the runway ran north–south; spin the whole
    // field around its centre to the actual runway heading
    let root: THREE.Object3D = g;
    if (ap.heading !== 0) {
      const pivot = new THREE.Group();
      pivot.position.set(ap.x, 0, ap.z);
      pivot.rotation.y = -ap.heading;
      g.position.set(-ap.x, 0, -ap.z);
      pivot.add(g);
      root = pivot;
    }
    this.scene.add(root);
    root.updateMatrixWorld(true);
    for (const b of papi) b.mesh.getWorldPosition(b.world); // rotation-proof

    // world positions of the edge lights (for per-frame distance scaling)
    const world = new Float32Array(local.length);
    for (let i = 0; i < local.length; i += 3) {
      _v.set(local[i], local[i + 1], local[i + 2]);
      g.localToWorld(_v);
      world[i] = _v.x; world[i + 1] = _v.y; world[i + 2] = _v.z;
    }

    this.built.set(key, {
      def: ap, group: root as THREE.Group, sockPivot, beacon, papi,
      edge: { mesh: lights, local, world }, aeroBeacon,
    });
  }

  private buildMajorExtras(g: THREE.Group, ap: AirfieldDef): THREE.Mesh {
    const E = ap.elev;
    const ax = ap.x + 110;
    const az = ap.z - 80;

    const apron = new THREE.Mesh(
      new THREE.PlaneGeometry(150, 260),
      new THREE.MeshLambertMaterial({ color: 0x35383d }),
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.set(ax, E + 0.04, az);
    apron.receiveShadow = true;
    g.add(apron);
    const taxi = new THREE.Mesh(
      new THREE.PlaneGeometry(70, 26),
      new THREE.MeshLambertMaterial({ color: 0x35383d }),
    );
    taxi.rotation.x = -Math.PI / 2;
    taxi.position.set(ap.x + 52, E + 0.05, az);
    g.add(taxi);

    const hangarMat = new THREE.MeshLambertMaterial({ color: 0x8d9499 });
    const doorMat = new THREE.MeshLambertMaterial({ color: 0x4d565e });
    for (const hz of [az - 70, az + 70]) {
      const hangar = new THREE.Mesh(new THREE.CylinderGeometry(16, 16, 42, 14, 1, false, 0, Math.PI), hangarMat);
      hangar.rotation.z = Math.PI / 2;
      hangar.rotation.y = Math.PI / 2;
      hangar.position.set(ap.x + 150, E, hz);
      hangar.castShadow = true;
      hangar.receiveShadow = true;
      g.add(hangar);
      const door = new THREE.Mesh(new THREE.PlaneGeometry(26, 11), doorMat);
      door.position.set(ap.x + 128.8, E + 5.5, hz);
      door.rotation.y = -Math.PI / 2;
      g.add(door);
    }

    const towerBase = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 4.2, 26, 10), hangarMat);
    towerBase.position.set(ap.x + 120, E + 13, ap.z + 30);
    towerBase.castShadow = true;
    g.add(towerBase);
    const cab = new THREE.Mesh(
      new THREE.CylinderGeometry(6, 5, 6, 10),
      new THREE.MeshStandardMaterial({ color: 0x20354a, roughness: 0.15, metalness: 0.6 }),
    );
    cab.position.set(ap.x + 120, E + 28.5, ap.z + 30);
    cab.castShadow = true;
    g.add(cab);

    const beacon = new THREE.Mesh(
      new THREE.SphereGeometry(0.9, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xff4040 }),
    );
    beacon.position.set(ap.x + 120, E + 33, ap.z + 30);
    g.add(beacon);
    return beacon;
  }
}

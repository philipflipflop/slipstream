/**
 * Airfield furniture, built on demand for whichever airfields (hand-placed
 * or procedural) are near the player: painted runway, edge lighting and a
 * windsock everywhere; the major home field also gets hangars, a control
 * tower and an apron. Far fields are disposed again.
 */
import * as THREE from 'three';
import { WorldGen, AirfieldDef } from './heightfield';

const BUILD_RADIUS = 14000;
const DROP_RADIUS = 17000;

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
  sock: THREE.Mesh;
  beacon: THREE.Mesh | null;
  /** PAPI boxes (southern approach) + their world positions, outermost first */
  papi: Array<{ mesh: THREE.Mesh; world: THREE.Vector3 }>;
}

/** PAPI glide-path thresholds, outermost box first: 4 white = high,
 *  2 white 2 red = on the 3° slope, 4 red = dangerously low. */
const PAPI_DEG = [3.5, 3.2, 2.8, 2.5];

export class Airport {
  private built = new Map<string, BuiltField>();
  private tex: THREE.CanvasTexture;
  private rwMat: THREE.MeshLambertMaterial;
  private scanTimer = 0;
  private queryScratch: AirfieldDef[] = [];

  constructor(private scene: THREE.Scene, private gen: WorldGen) {
    this.tex = runwayTexture();
    this.rwMat = new THREE.MeshLambertMaterial({ map: this.tex });
  }

  update(time: number, px: number, pz: number, py = 0): void {
    // animate whatever exists
    for (const f of this.built.values()) {
      f.sock.rotation.x = Math.sin(time * 2.1) * 0.08;
      f.sock.rotation.y = Math.sin(time * 0.7) * 0.2;
      if (f.beacon) {
        const pulse = (Math.sin(time * 4.2) + 1) * 0.5;
        (f.beacon.material as THREE.MeshBasicMaterial).color.setRGB(0.45 + pulse, 0.08, 0.08);
      }
      // PAPI: each box compares the aircraft's angle above its own position
      // against its slope threshold — white above, red below, so the row
      // reads the classic "two white two red, you're all right"
      for (let i = 0; i < f.papi.length; i++) {
        const b = f.papi[i];
        const dist = Math.hypot(px - b.world.x, pz - b.world.z);
        if (dist > 9000) continue; // too far to resolve — skip the math
        const angle = Math.atan2(py - b.world.y, Math.max(dist, 1)) * (180 / Math.PI);
        (b.mesh.material as THREE.MeshBasicMaterial).color.setHex(
          angle > PAPI_DEG[i] ? 0xfff4e0 : 0xff2418,
        );
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

    // edge lights
    const lightGeo = new THREE.SphereGeometry(0.42, 6, 5);
    const edgeMat = new THREE.MeshBasicMaterial({ color: 0xffd070 });
    const n = Math.floor(ap.length / 60);
    const lights = new THREE.InstancedMesh(lightGeo, edgeMat, n * 2);
    const m = new THREE.Matrix4();
    for (let i = 0; i < n; i++) {
      const z = ap.z - ap.length / 2 + 30 + i * 60;
      m.makeTranslation(ap.x - ap.width / 2 - 2.5, E + 0.5, z);
      lights.setMatrixAt(i * 2, m);
      m.makeTranslation(ap.x + ap.width / 2 + 2.5, E + 0.5, z);
      lights.setMatrixAt(i * 2 + 1, m);
    }
    g.add(lights);

    // windsock near the southern threshold
    const sockX = ap.x - ap.width / 2 - 14;
    const sockZ = ap.z + ap.length / 2 - 80;
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.18, 9, 6),
      new THREE.MeshLambertMaterial({ color: 0xd8dde2 }),
    );
    pole.position.set(sockX, E + 4.5, sockZ);
    g.add(pole);
    const sock = new THREE.Mesh(
      new THREE.ConeGeometry(1.1, 5.5, 8, 1, true),
      new THREE.MeshLambertMaterial({ color: 0xff7a1a, side: THREE.DoubleSide }),
    );
    sock.rotation.z = Math.PI / 2;
    sock.position.set(sockX + 2.75, E + 8.6, sockZ);
    g.add(sock);

    let beacon: THREE.Mesh | null = null;
    if (ap.major) {
      beacon = this.buildMajorExtras(g, ap);
    }

    // PAPI row on the left of the southern touchdown zone (runway 36 side)
    const papi: Array<{ mesh: THREE.Mesh; world: THREE.Vector3 }> = [];
    const papiGeo = new THREE.BoxGeometry(1.8, 0.9, 0.9);
    for (let i = 0; i < 4; i++) {
      const box = new THREE.Mesh(papiGeo, new THREE.MeshBasicMaterial({ color: 0xfff4e0 }));
      box.position.set(ap.x - ap.width / 2 - 16 - i * 9, E + 0.8, ap.z + ap.length / 2 - 260);
      g.add(box);
      papi.push({ mesh: box, world: new THREE.Vector3() });
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
    this.built.set(key, { def: ap, group: root as THREE.Group, sock, beacon, papi });
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

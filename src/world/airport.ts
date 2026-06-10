/**
 * Meridian Field — the spawn airfield at the world origin.
 * Painted runway, edge lighting, hangars, tower and windsock.
 */
import * as THREE from 'three';
import { AIRPORT_ELEV, RUNWAY_LENGTH, RUNWAY_WIDTH } from './heightfield';

function runwayTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 2048;
  const ctx = c.getContext('2d')!;

  ctx.fillStyle = '#2a2c30';
  ctx.fillRect(0, 0, 256, 2048);
  // weathering streaks
  for (let i = 0; i < 220; i++) {
    ctx.fillStyle = `rgba(${20 + Math.random() * 40},${20 + Math.random() * 40},${22 + Math.random() * 40},0.16)`;
    ctx.fillRect(Math.random() * 256, Math.random() * 2048, 2 + Math.random() * 8, 14 + Math.random() * 80);
  }
  ctx.fillStyle = '#e8e4da';
  // threshold piano keys, both ends
  for (const yBase of [18, 2048 - 58]) {
    for (let i = 0; i < 8; i++) ctx.fillRect(14 + i * 30, yBase, 18, 40);
  }
  // centreline dashes
  for (let y = 160; y < 1900; y += 96) ctx.fillRect(122, y, 12, 52);
  // edge stripes
  ctx.fillRect(4, 0, 5, 2048);
  ctx.fillRect(247, 0, 5, 2048);
  // runway designators (we run 18/36, along Z)
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

export class Airport {
  group = new THREE.Group();
  private beacon: THREE.Mesh;
  private sockCone: THREE.Mesh;

  constructor(scene: THREE.Scene) {
    const g = this.group;
    const E = AIRPORT_ELEV;

    // paved runway with painted markings
    const rw = new THREE.Mesh(
      new THREE.PlaneGeometry(RUNWAY_WIDTH, RUNWAY_LENGTH),
      new THREE.MeshLambertMaterial({ map: runwayTexture() }),
    );
    rw.rotation.x = -Math.PI / 2;
    rw.position.set(0, E + 0.06, 0);
    rw.receiveShadow = true;
    g.add(rw);

    // taxiway + apron slab to the east
    const apron = new THREE.Mesh(
      new THREE.PlaneGeometry(150, 260),
      new THREE.MeshLambertMaterial({ color: 0x35383d }),
    );
    apron.rotation.x = -Math.PI / 2;
    apron.position.set(110, E + 0.04, -80);
    apron.receiveShadow = true;
    g.add(apron);
    const taxi = new THREE.Mesh(
      new THREE.PlaneGeometry(70, 26),
      new THREE.MeshLambertMaterial({ color: 0x35383d }),
    );
    taxi.rotation.x = -Math.PI / 2;
    taxi.position.set(52, E + 0.05, -80);
    g.add(taxi);

    // runway edge lights
    const lightGeo = new THREE.SphereGeometry(0.42, 6, 5);
    const edgeMat = new THREE.MeshBasicMaterial({ color: 0xffd070 });
    const n = Math.floor(RUNWAY_LENGTH / 60);
    const lights = new THREE.InstancedMesh(lightGeo, edgeMat, n * 2);
    const m = new THREE.Matrix4();
    for (let i = 0; i < n; i++) {
      const z = -RUNWAY_LENGTH / 2 + 30 + i * 60;
      m.makeTranslation(-RUNWAY_WIDTH / 2 - 2.5, E + 0.5, z);
      lights.setMatrixAt(i * 2, m);
      m.makeTranslation(RUNWAY_WIDTH / 2 + 2.5, E + 0.5, z);
      lights.setMatrixAt(i * 2 + 1, m);
    }
    g.add(lights);

    // hangars on the apron
    const hangarMat = new THREE.MeshLambertMaterial({ color: 0x8d9499 });
    const doorMat = new THREE.MeshLambertMaterial({ color: 0x4d565e });
    for (const hz of [-150, -10]) {
      const hangar = new THREE.Mesh(new THREE.CylinderGeometry(16, 16, 42, 14, 1, false, 0, Math.PI), hangarMat);
      hangar.rotation.z = Math.PI / 2;
      hangar.rotation.y = Math.PI / 2;
      hangar.position.set(150, E, hz);
      hangar.castShadow = true;
      hangar.receiveShadow = true;
      g.add(hangar);
      const door = new THREE.Mesh(new THREE.PlaneGeometry(26, 11), doorMat);
      door.position.set(128.8, E + 5.5, hz);
      door.rotation.y = -Math.PI / 2;
      g.add(door);
    }

    // control tower
    const towerBase = new THREE.Mesh(new THREE.CylinderGeometry(3.4, 4.2, 26, 10), hangarMat);
    towerBase.position.set(120, E + 13, 30);
    towerBase.castShadow = true;
    g.add(towerBase);
    const cab = new THREE.Mesh(
      new THREE.CylinderGeometry(6, 5, 6, 10),
      new THREE.MeshStandardMaterial({ color: 0x20354a, roughness: 0.15, metalness: 0.6 }),
    );
    cab.position.set(120, E + 28.5, 30);
    cab.castShadow = true;
    g.add(cab);
    this.beacon = new THREE.Mesh(
      new THREE.SphereGeometry(0.9, 8, 6),
      new THREE.MeshBasicMaterial({ color: 0xff4040 }),
    );
    this.beacon.position.set(120, E + 33, 30);
    g.add(this.beacon);

    // windsock
    const pole = new THREE.Mesh(
      new THREE.CylinderGeometry(0.18, 0.18, 9, 6),
      new THREE.MeshLambertMaterial({ color: 0xd8dde2 }),
    );
    pole.position.set(-32, E + 4.5, -RUNWAY_LENGTH / 2 + 80);
    g.add(pole);
    this.sockCone = new THREE.Mesh(
      new THREE.ConeGeometry(1.1, 5.5, 8, 1, true),
      new THREE.MeshLambertMaterial({ color: 0xff7a1a, side: THREE.DoubleSide }),
    );
    this.sockCone.rotation.z = Math.PI / 2;
    this.sockCone.position.set(-32 + 2.75, E + 8.6, -RUNWAY_LENGTH / 2 + 80);
    g.add(this.sockCone);

    scene.add(g);
  }

  update(time: number): void {
    // rotating-ish beacon pulse + windsock flutter
    const pulse = (Math.sin(time * 4.2) + 1) * 0.5;
    (this.beacon.material as THREE.MeshBasicMaterial).color.setRGB(0.45 + pulse, 0.08, 0.08);
    this.sockCone.rotation.x = Math.sin(time * 2.1) * 0.08;
    this.sockCone.rotation.y = Math.sin(time * 0.7) * 0.2;
  }
}

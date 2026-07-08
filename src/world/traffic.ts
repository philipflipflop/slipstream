/**
 * NPC aircraft. Two kinds of life around the world:
 *  - PARKED planes at airfields, deterministic per field (hash-seeded):
 *    airliners nose-in on the international terminal stands, light singles
 *    on regional aprons and strip edges — never on a runway or taxiway.
 *  - FLYING traffic: a handful of AI aircraft cruising long tracks through
 *    the player's region, terrain-aware, with nav lights and strobes.
 *
 * Every NPC is ONE merged vertex-coloured geometry (a draw call each, no
 * textures), cached per kind+livery. They are scenery, not physics — no
 * collision, same as the airport hangars.
 */
import * as THREE from 'three';
import { WorldGen, AirfieldDef, INTL_STANDS } from './heightfield';
import { clamp, hash2, makeRng } from '../core/math';

type NpcKind = 'airliner' | 'ga';

/** accent liveries: [fuselage, tail/engine accent] */
const LIVERIES: Array<[number, number]> = [
  [0xf2f4f6, 0x1c3f8f], // white / blue
  [0xf4f1ec, 0xb3272f], // white / red
  [0xe9edf1, 0x1d7a6b], // white / teal
  [0xdfe3e8, 0xd97a1e], // grey / orange
];

const BUILD_RADIUS = 16000;
const DROP_RADIUS = 20000;

function paint(g: THREE.BufferGeometry, color: number): THREE.BufferGeometry {
  const c = new THREE.Color(color);
  const n = g.attributes.position.count;
  const arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b;
  }
  g.setAttribute('color', new THREE.BufferAttribute(arr, 3));
  return g;
}

function merge(parts: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const flat = parts.map((p) => (p.index ? p.toNonIndexed() : p));
  let count = 0;
  for (const p of flat) count += p.attributes.position.count;
  const pos = new Float32Array(count * 3);
  const nor = new Float32Array(count * 3);
  const col = new Float32Array(count * 3);
  let off = 0;
  for (const p of flat) {
    pos.set(p.attributes.position.array as Float32Array, off * 3);
    nor.set(p.attributes.normal.array as Float32Array, off * 3);
    col.set(p.attributes.color.array as Float32Array, off * 3);
    off += p.attributes.position.count;
    p.dispose();
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return out;
}

const geoCache = new Map<string, THREE.BufferGeometry>();

/** Narrowbody airliner silhouette, ~32 m span. Forward is -Z, wheels at y=0. */
function airlinerGeo(livery: number): THREE.BufferGeometry {
  const key = `air${livery}`;
  const hit = geoCache.get(key);
  if (hit) return hit;
  const [body, accent] = LIVERIES[livery % LIVERIES.length];
  const parts: THREE.BufferGeometry[] = [];
  const cy = 3.2; // fuselage centreline height on its gear

  const tube = new THREE.CylinderGeometry(1.75, 1.75, 24, 10);
  tube.rotateX(Math.PI / 2);
  tube.translate(0, cy, 0.5);
  parts.push(paint(tube, body));
  const nose = new THREE.ConeGeometry(1.75, 4.5, 10);
  nose.rotateX(-Math.PI / 2);
  nose.translate(0, cy, -13.7);
  parts.push(paint(nose, body));
  const tail = new THREE.CylinderGeometry(0.4, 1.75, 7, 10);
  tail.rotateX(Math.PI / 2);
  tail.translate(0, cy + 0.5, 16);
  parts.push(paint(tail, body));

  for (const sx of [-1, 1]) {
    const wing = new THREE.BoxGeometry(14.5, 0.42, 4.4);
    wing.translate(sx * 7.2, 0, 0);
    const gw = new THREE.Matrix4().makeRotationY(sx * -0.42);
    wing.applyMatrix4(gw);
    wing.translate(0, cy - 1.1, 1.6);
    parts.push(paint(wing, 0xc6ccd2));
    const eng = new THREE.CylinderGeometry(0.95, 0.95, 3.4, 8);
    eng.rotateX(Math.PI / 2);
    eng.translate(sx * 4.9, cy - 1.9, -0.6);
    parts.push(paint(eng, accent));
    const hs = new THREE.BoxGeometry(5.2, 0.28, 2.2);
    hs.translate(sx * 2.9, cy + 0.9, 17.4);
    const gh = new THREE.Matrix4().makeRotationY(sx * -0.3);
    hs.applyMatrix4(gh);
    parts.push(paint(hs, body));
  }
  const fin = new THREE.BoxGeometry(0.45, 6, 3.6);
  const shear = new THREE.Matrix4().set(1, 0, 0, 0, 0, 1, 0, 0, 0, 0.55, 1, 0, 0, 0, 0, 1);
  fin.applyMatrix4(shear); // sweep the fin back with height
  fin.translate(0, cy + 3.6, 15.2);
  parts.push(paint(fin, accent));

  // gear stubs so it stands on its wheels when parked
  for (const [gx, gz] of [[0, -11], [-2.6, 1.6], [2.6, 1.6]] as Array<[number, number]>) {
    const leg = new THREE.BoxGeometry(0.5, cy - 1.4, 0.5);
    leg.translate(gx, (cy - 1.4) / 2 + 0.7, gz);
    parts.push(paint(leg, 0x63686e));
    const wheel = new THREE.BoxGeometry(0.9, 1.0, 1.0);
    wheel.translate(gx, 0.44, gz); // bottom face buried — never coplanar with the apron
    parts.push(paint(wheel, 0x1a1c1f));
  }

  const g = merge(parts);
  geoCache.set(key, g);
  return g;
}

/** Ground service vehicle: baggage tug or fuel bowser. Forward is -Z. */
function vehicleGeo(kind: 'tug' | 'fuel'): THREE.BufferGeometry {
  const key = `veh${kind}`;
  const hit = geoCache.get(key);
  if (hit) return hit;
  const parts: THREE.BufferGeometry[] = [];
  if (kind === 'tug') {
    const cab = new THREE.BoxGeometry(1.5, 1.5, 1.9);
    cab.translate(0, 1.05, -1.4);
    parts.push(paint(cab, 0xd8a018));
    const bed = new THREE.BoxGeometry(1.5, 0.7, 2.6);
    bed.translate(0, 0.65, 0.9);
    parts.push(paint(bed, 0x3a4148));
  } else {
    const cab = new THREE.BoxGeometry(2.2, 2.0, 2.0);
    cab.translate(0, 1.3, -2.4);
    parts.push(paint(cab, 0xf2f4f6));
    const tank = new THREE.CylinderGeometry(1.05, 1.05, 4.6, 10);
    tank.rotateX(Math.PI / 2);
    tank.translate(0, 1.35, 0.9);
    parts.push(paint(tank, 0xc23b32));
  }
  // simple axle blocks
  for (const gz of kind === 'tug' ? [-1.3, 1.1] : [-2.2, 1.8]) {
    const axle = new THREE.BoxGeometry(kind === 'tug' ? 1.6 : 2.3, 0.55, 0.6);
    axle.translate(0, 0.26, gz);
    parts.push(paint(axle, 0x1a1c1f));
  }
  const g = merge(parts);
  geoCache.set(key, g);
  return g;
}

/** Light high-wing single, ~10 m span. Forward is -Z, wheels at y=0. */
function gaGeo(livery: number): THREE.BufferGeometry {
  const key = `ga${livery}`;
  const hit = geoCache.get(key);
  if (hit) return hit;
  const [body, accent] = LIVERIES[livery % LIVERIES.length];
  const parts: THREE.BufferGeometry[] = [];
  const cy = 1.35;

  const fuse = new THREE.BoxGeometry(1.3, 1.35, 6.6);
  fuse.translate(0, cy, 0.3);
  parts.push(paint(fuse, body));
  const cowl = new THREE.BoxGeometry(1.1, 1.0, 1.4);
  cowl.translate(0, cy - 0.05, -3.5);
  parts.push(paint(cowl, accent));
  const spinner = new THREE.ConeGeometry(0.28, 0.7, 8);
  spinner.rotateX(-Math.PI / 2);
  spinner.translate(0, cy - 0.05, -4.5);
  parts.push(paint(spinner, 0xd8d8de));
  const wing = new THREE.BoxGeometry(10.2, 0.24, 1.55);
  wing.translate(0, cy + 0.85, -0.6);
  parts.push(paint(wing, body));
  const hs = new THREE.BoxGeometry(3.4, 0.18, 0.95);
  hs.translate(0, cy + 0.25, 3.4);
  parts.push(paint(hs, body));
  const fin = new THREE.BoxGeometry(0.22, 1.5, 1.1);
  fin.translate(0, cy + 0.95, 3.5);
  parts.push(paint(fin, accent));
  for (const [gx, gz] of [[0, -2.6], [-1.15, 0.2], [1.15, 0.2]] as Array<[number, number]>) {
    const leg = new THREE.BoxGeometry(0.16, cy - 0.3, 0.16);
    leg.translate(gx, (cy - 0.3) / 2 + 0.25, gz);
    parts.push(paint(leg, 0x63686e));
    const wheel = new THREE.BoxGeometry(0.32, 0.5, 0.5);
    wheel.translate(gx, 0.21, gz); // bottom face buried below the pavement
    parts.push(paint(wheel, 0x1a1c1f));
  }

  const g = merge(parts);
  geoCache.set(key, g);
  return g;
}

interface FlyingNpc {
  group: THREE.Group;
  kind: NpcKind;
  hdg: number;
  spd: number;
  targetY: number;
  checkT: number;   // staggered terrain-look-ahead timer
  beacon: THREE.Mesh;
  strobe: THREE.Mesh;
  phase: number;
}

export class Traffic {
  /** flying traffic count (0 disables the airborne layer, e.g. races) */
  private static readonly FLYING = 5;

  private parked = new Map<string, {
    group: THREE.Group;
    /** apron service vehicles doing slow laps of the stand row */
    movers: Array<{ m: THREE.Object3D; along: number; side: number; dir: number }>;
    def: AirfieldDef;
  }>();
  private flying: FlyingNpc[] = [];
  private mat: THREE.MeshLambertMaterial;
  private scanTimer = 0;
  private queryScratch: AirfieldDef[] = [];
  private rng = makeRng(0x7ea6f1c);

  constructor(private scene: THREE.Scene, private gen: WorldGen) {
    this.mat = new THREE.MeshLambertMaterial({ vertexColors: true });
  }

  update(dt: number, px: number, pz: number, time: number, airborneOn: boolean): void {
    // ---- flying layer ----
    if (airborneOn && this.flying.length < Traffic.FLYING) {
      this.spawnFlyer(px, pz, this.flying.length);
    }
    for (const f of this.flying) {
      const p = f.group.position;
      p.x += Math.sin(f.hdg) * f.spd * dt;
      p.z -= Math.cos(f.hdg) * f.spd * dt;
      // terrain look-ahead once a second (staggered): stay 250 m+ above
      f.checkT -= dt;
      if (f.checkT <= 0) {
        f.checkT = 1 + f.phase * 0.1;
        const ax = p.x + Math.sin(f.hdg) * 2500;
        const az = p.z - Math.cos(f.hdg) * 2500;
        const floor = Math.max(this.gen.heightAt(ax, az), this.gen.heightAt(p.x, p.z), 0) + 260;
        if (floor > f.targetY) f.targetY = floor + 120;
      }
      p.y += clamp(f.targetY - p.y, -3 * dt, 4.5 * dt);
      f.group.rotation.y = -f.hdg;

      // beacon + double strobe, offset per aircraft
      const bt = (time + f.phase) % 1.9;
      f.beacon.visible = bt < 0.26;
      const st = (time + f.phase) % 1.3;
      f.strobe.visible = st < 0.05 || (st > 0.12 && st < 0.17);

      // out of the bubble (or the layer was switched off): recycle
      const d = Math.hypot(p.x - px, p.z - pz);
      if (d > 30000 || (!airborneOn && d > 4000)) {
        if (airborneOn) this.respawnFlyer(f, px, pz);
        else this.dropFlyer(f);
      }
    }

    // ---- apron service vehicles: slow laps along the stand rows ----
    for (const rec of this.parked.values()) {
      for (const v of rec.movers) {
        v.along += v.dir * 7 * dt;
        if (Math.abs(v.along) > 1500) v.dir = -v.dir;
        // local heading-0 frame (the group pivot carries the field heading)
        v.m.position.set(rec.def.x + v.side * 460, rec.def.elev, rec.def.z - v.along);
        v.m.rotation.y = v.dir > 0 ? Math.PI : 0;
      }
    }

    // ---- parked layer: scan for nearby fields twice a second ----
    this.scanTimer -= 1;
    if (this.scanTimer > 0) return;
    this.scanTimer = 30;
    const near = this.gen.airfieldsNear(px, pz, BUILD_RADIUS, this.queryScratch);
    for (const def of near) {
      const key = `${def.x},${def.z}`;
      if (!this.parked.has(key)) this.buildParked(def, key);
    }
    for (const [key, rec] of this.parked) {
      const [fx, fz] = key.split(',').map(Number);
      if (Math.hypot(fx - px, fz - pz) > DROP_RADIUS) {
        this.scene.remove(rec.group);
        this.parked.delete(key);
      }
    }
  }

  /* ------------------------------------------------ flying ---- */

  /** withShadow only for PARKED aircraft. A flying NPC crossing the sun's
   *  ±420 m player-chasing shadow box pops a sweeping shadow in and out of
   *  existence — over shorelines (water receives no shadows) it reads as
   *  edge flicker on the water. Airborne NPCs cast nothing. */
  private mkNpcModel(kind: NpcKind, livery: number, withShadow: boolean): THREE.Group {
    const g = new THREE.Group();
    const mesh = new THREE.Mesh(kind === 'airliner' ? airlinerGeo(livery) : gaGeo(livery), this.mat);
    mesh.castShadow = withShadow;
    g.add(mesh);
    return g;
  }

  private spawnFlyer(px: number, pz: number, slot: number): void {
    const kind: NpcKind = slot % 3 === 2 ? 'ga' : 'airliner';
    const group = this.mkNpcModel(kind, slot, false);
    const glow = new THREE.SphereGeometry(kind === 'airliner' ? 0.5 : 0.3, 6, 5);
    const beacon = new THREE.Mesh(glow, new THREE.MeshBasicMaterial({ color: 0xff2222 }));
    beacon.position.set(0, kind === 'airliner' ? 5.2 : 2.6, 2);
    const strobe = new THREE.Mesh(glow, new THREE.MeshBasicMaterial({ color: 0xffffff }));
    strobe.position.set(0, kind === 'airliner' ? 4.5 : 2.4, kind === 'airliner' ? 18 : 4);
    group.add(beacon, strobe);
    this.scene.add(group);
    const f: FlyingNpc = {
      group, kind, hdg: 0, spd: 0, targetY: 0,
      checkT: this.rng(), beacon, strobe, phase: slot * 0.37,
    };
    this.flying.push(f);
    this.respawnFlyer(f, px, pz);
  }

  private respawnFlyer(f: FlyingNpc, px: number, pz: number): void {
    // enter the bubble from a random edge, tracking through a point near
    // the player so traffic actually crosses the sky you are looking at
    const entry = this.rng() * Math.PI * 2;
    const R = 21000 + this.rng() * 5000;
    const x = px + Math.sin(entry) * R;
    const z = pz - Math.cos(entry) * R;
    const aimX = px + (this.rng() - 0.5) * 12000;
    const aimZ = pz + (this.rng() - 0.5) * 12000;
    f.hdg = Math.atan2(aimX - x, -(aimZ - z));
    f.spd = f.kind === 'airliner' ? 115 + this.rng() * 40 : 42 + this.rng() * 14;
    const ground = Math.max(this.gen.heightAt(x, z), 0);
    f.targetY = ground + (f.kind === 'airliner' ? 900 + this.rng() * 1400 : 350 + this.rng() * 500);
    f.group.position.set(x, f.targetY, z);
    f.group.rotation.y = -f.hdg;
  }

  private dropFlyer(f: FlyingNpc): void {
    this.scene.remove(f.group);
    const i = this.flying.indexOf(f);
    if (i >= 0) {
      this.flying[i] = this.flying[this.flying.length - 1];
      this.flying.pop();
    }
  }

  /* ------------------------------------------------ parked ---- */

  private buildParked(ap: AirfieldDef, key: string): void {
    const g = new THREE.Group();
    const movers: Array<{ m: THREE.Object3D; along: number; side: number; dir: number }> = [];
    const seed = (a: number, b: number) => hash2(Math.round(ap.x) + a, Math.round(ap.z) + b);

    // place one NPC in the field's local (heading-0) frame; the group pivot
    // below rotates the whole set to the true field heading
    const put = (kind: NpcKind, livery: number, along: number, across: number, yaw: number): void => {
      const m = this.mkNpcModel(kind, livery, true);
      m.position.set(ap.x + across, ap.elev, ap.z - along);
      m.rotation.y = yaw;
      g.add(m);
    };

    if (ap.intl) {
      // nose-in airliners on the shared gate-stand list (~65% occupancy) —
      // the jet bridges and stand paint come from the SAME list, so every
      // parked aircraft sits on a marked gate under its bridge
      let n = 0;
      for (let i = 0; i < INTL_STANDS.length; i++) {
        if (seed(i * 13 + 5, i * 7 - 3) < 0.35) continue;
        const s = INTL_STANDS[i];
        put('airliner', n++, s.along, s.across, s.yaw);
      }
      // ground crew: static tugs/bowsers at the pier roots + two doing
      // slow laps of the apron service lane
      for (const [i, pc] of [-1020, 30, 1080].entries()) {
        if (seed(i * 3 + 1, 8) > 0.35) {
          const tug = new THREE.Mesh(vehicleGeo('tug'), this.mat);
          tug.castShadow = true;
          tug.position.set(ap.x + (seed(i, 2) > 0.5 ? 70 : -70), ap.elev, ap.z - pc - 60);
          tug.rotation.y = seed(i, 4) * Math.PI * 2;
          g.add(tug);
        }
        if (seed(i * 5 + 2, 6) > 0.55) {
          const fuel = new THREE.Mesh(vehicleGeo('fuel'), this.mat);
          fuel.castShadow = true;
          fuel.position.set(ap.x + (seed(i, 9) > 0.5 ? 380 : -380), ap.elev, ap.z - pc + 90);
          fuel.rotation.y = Math.PI / 2;
          g.add(fuel);
        }
      }
      for (const side of [-1, 1]) {
        const m = new THREE.Mesh(vehicleGeo(side < 0 ? 'tug' : 'fuel'), this.mat);
        m.castShadow = true;
        g.add(m);
        movers.push({ m, along: side * seed(3, side) * 900, side, dir: side });
      }
    } else if (ap.major) {
      // a couple of singles on the GA apron east of the runway
      if (seed(1, 5) > 0.15) put('ga', Math.floor(seed(2, 9) * 4), 60, 100, 0.4 + seed(3, 1) * 2);
      if (seed(4, 7) > 0.45) put('ga', Math.floor(seed(5, 3) * 4), 110, 92, -0.8 + seed(6, 2));
    } else if (seed(8, 8) > 0.45) {
      // strips: one resident aircraft by the windsock, off the pavement
      put('ga', Math.floor(seed(9, 4) * 4), -(ap.length / 2 - 150), -(ap.width / 2 + 26), 1.2 + seed(7, 6) * 1.6);
    }

    let root: THREE.Group = g;
    if (g.children.length > 0 && ap.heading !== 0) {
      const pivot = new THREE.Group();
      pivot.position.set(ap.x, 0, ap.z);
      pivot.rotation.y = -ap.heading;
      g.position.set(-ap.x, 0, -ap.z);
      pivot.add(g);
      root = pivot;
    }
    this.scene.add(root);
    this.parked.set(key, { group: root, movers, def: ap });
  }
}

/**
 * Airfield furniture, built on demand for whichever airfields (hand-placed
 * or procedural) are near the player: painted runway(s), edge lighting,
 * PAPI at both thresholds and a windsock everywhere; regional majors get
 * hangars, a tower and an apron; INTERNATIONALS get the full Heathrow
 * treatment — twin parallel runways with proper designators (27L/27R
 * style), parallel taxiways with connectors, a central terminal spine with
 * pier fingers (solid — collision comes from the same intlBuildings list),
 * cargo hangars and an 87 m control tower. Far fields are disposed again.
 *
 * Airfield lights follow the real-world rule that lights are POINT sources
 * seen at range: the meshes are rescaled per frame so they never shrink
 * below a couple of pixels, and their materials ignore fog — on a clear
 * night runway lights and the white/green airport beacon are visible from
 * many kilometres out, which is how you find the field in the dark.
 */
import * as THREE from 'three';
import { WorldGen, AirfieldDef, intlBuildings, INTL_STANDS } from './heightfield';
import { runwayIdent } from '../nav/ils';
import { clamp } from '../core/math';

const BUILD_RADIUS = 20000;
const DROP_RADIUS = 24000;

interface BuiltField {
  def: AirfieldDef;
  group: THREE.Group;
  sockPivot: THREE.Group;
  beacon: THREE.Mesh | null;
  /** PAPI boxes in rows of four (closest to the runway first), both
   *  thresholds of every runway; angle thresholds index PAPI_DEG[i % 4] */
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
  private rwMats = new Map<string, THREE.MeshLambertMaterial>();
  private scanTimer = 0;
  private queryScratch: AirfieldDef[] = [];
  private windPointYaw = Math.PI; // world yaw the sock POINTS (downwind)
  private windKt = 0;

  constructor(private scene: THREE.Scene, private gen: WorldGen, private nightOps = false) {}

  /** Wind for the windsocks: aviation convention, heading the wind is FROM. */
  setWind(fromHeading: number, kt: number): void {
    this.windPointYaw = fromHeading + Math.PI;
    this.windKt = kt;
  }

  /** Runway surface material with true designators painted on each end. */
  private runwayMat(n1: string, n2: string): THREE.MeshLambertMaterial {
    const key = `${n1}/${n2}`;
    let mat = this.rwMats.get(key);
    if (mat) return mat;

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
    // designators: canvas TOP maps to the runway's NORTHERN end, so the
    // southern-approach number (n1) sits at the bottom, glyph tops pointing
    // north — upright to the pilot on that approach, like real paint
    ctx.font = 'bold 78px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(n1, 128, 1955);
    ctx.save();
    ctx.translate(128, 145);
    ctx.rotate(Math.PI);
    ctx.fillText(n2, 0, 0);
    ctx.restore();

    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    mat = new THREE.MeshLambertMaterial({ map: tex });
    this.rwMats.set(key, mat);
    return mat;
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
      // against its slope threshold — white above, red below, so each row
      // reads the classic "two white two red, you're all right"
      for (let i = 0; i < f.papi.length; i++) {
        const b = f.papi[i];
        const dist = Math.hypot(px - b.world.x, pz - b.world.z);
        if (dist > 12000) continue; // too far to resolve — skip the math
        const angle = Math.atan2(py - b.world.y, Math.max(dist, 1)) * (180 / Math.PI);
        (b.mesh.material as THREE.MeshBasicMaterial).color.setHex(
          angle > PAPI_DEG[i % 4] ? 0xfff4e0 : 0xff2418,
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

    // one entry per runway: internationals fly a parallel pair (main/west
    // first — that's the spawn runway), everything else a single strip
    const runways = ap.rwySep
      ? [
          { off: -ap.rwySep / 2, len: ap.length, s1: 'L', s2: 'R' },
          { off: ap.rwySep / 2, len: ap.rwy2Len ?? ap.length, s1: 'R', s2: 'L' },
        ]
      : [{ off: 0, len: ap.length, s1: '', s2: '' }];

    const papi: Array<{ mesh: THREE.Mesh; world: THREE.Vector3 }> = [];
    const papiGeo = new THREE.BoxGeometry(1.8, 0.9, 0.9);
    const localPts: number[] = [];

    for (const rw of runways) {
      const n1 = runwayIdent(ap.heading) + rw.s1;
      const n2 = runwayIdent(ap.heading + Math.PI) + rw.s2;
      const rwMesh = new THREE.Mesh(new THREE.PlaneGeometry(ap.width, rw.len), this.runwayMat(n1, n2));
      rwMesh.rotation.x = -Math.PI / 2;
      rwMesh.position.set(ap.x + rw.off, E + 0.06, ap.z);
      rwMesh.receiveShadow = true;
      g.add(rwMesh);

      // edge light positions (fog-immune point sources, rescaled per frame)
      const n = Math.floor(rw.len / 60);
      for (let i = 0; i < n; i++) {
        const z = ap.z - rw.len / 2 + 30 + i * 60;
        localPts.push(ap.x + rw.off - ap.width / 2 - 2.5, E + 0.5, z);
        localPts.push(ap.x + rw.off + ap.width / 2 + 2.5, E + 0.5, z);
      }

      // PAPI at BOTH thresholds, on the approaching pilot's left
      for (const end of [1, -1]) {
        for (let i = 0; i < 4; i++) {
          const box = new THREE.Mesh(papiGeo, new THREE.MeshBasicMaterial({ color: 0xfff4e0, fog: false }));
          box.position.set(
            ap.x + rw.off - end * (ap.width / 2 + 16 + i * 9),
            E + 0.8,
            ap.z + end * (rw.len / 2 - 260),
          );
          g.add(box);
          papi.push({ mesh: box, world: new THREE.Vector3() });
        }
      }
    }

    const lightGeo = new THREE.SphereGeometry(0.42, 6, 5);
    const edgeMat = new THREE.MeshBasicMaterial({ color: 0xffdd88, fog: false });
    const local = Float32Array.from(localPts);
    const lightCount = local.length / 3;
    const lights = new THREE.InstancedMesh(lightGeo, edgeMat, lightCount);
    for (let i = 0; i < lightCount; i++) {
      _m.makeTranslation(local[i * 3], local[i * 3 + 1], local[i * 3 + 2]);
      lights.setMatrixAt(i, _m);
    }
    // instanced bounds are the 0.42 m base sphere — never let that cull a
    // multi-kilometre string of lights
    lights.frustumCulled = false;
    g.add(lights);

    // windsock on a pivot near the southern threshold of the main runway
    const sockX = ap.x + runways[0].off - ap.width / 2 - 14;
    const sockZ = ap.z + runways[0].len / 2 - 80;
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
    if (ap.intl) beacon = this.buildIntlExtras(g, ap);
    else if (ap.major) beacon = this.buildMajorExtras(g, ap);

    // airport beacon: alternating white/green flash, the "find me" light.
    // Night presets only — by day it reads as visual noise.
    let aeroBeacon: BuiltField['aeroBeacon'] = null;
    if (this.nightOps) {
      const bx = ap.intl ? ap.x + 275 : ap.major ? ap.x + 120 : sockX;
      const by = ap.intl ? E + 92 : ap.major ? E + 35 : E + 10.2;
      const bz = ap.intl ? ap.z - 480 : ap.major ? ap.z + 30 : sockZ;
      if (!ap.major && !ap.intl) {
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

  /** Regional major fields: small apron, two GA hangars, a low tower. */
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

  /**
   * International extras: central apron, parallel taxiways + connectors,
   * and the terminal spine from intlBuildings — the SAME list obstacles.ts
   * turns into collision boxes, so the buildings are exactly as solid as
   * they look. Returns the tower's red obstruction beacon.
   */
  private buildIntlExtras(g: THREE.Group, ap: AirfieldDef): THREE.Mesh {
    const E = ap.elev;
    // NOTE: the concrete slab and taxiway system are painted into the
    // TERRAIN vertex colours (heightfield colorAt) — kilometre-scale
    // overlay planes z-fight against mismatched terrain tones, and paint
    // at the mesh's own texel can't

    const wallMat = new THREE.MeshLambertMaterial({ color: 0x9ba3ac });
    const hangarMat = new THREE.MeshLambertMaterial({ color: 0x788089 });
    const doorMat = new THREE.MeshLambertMaterial({ color: 0x4d565e });
    const roofMat = new THREE.MeshLambertMaterial({ color: 0x6b7178 });
    const plinthMat = new THREE.MeshLambertMaterial({ color: 0x6f767e });
    const plantMat = new THREE.MeshLambertMaterial({ color: 0x565c63 });
    const glassMat = new THREE.MeshStandardMaterial({
      color: 0x22303e, roughness: 0.25, metalness: 0.55,
    });
    if (this.nightOps) {
      // lit concourses after dark — the terminal reads from final approach
      glassMat.emissive = new THREE.Color(0xffd9a0);
      glassMat.emissiveIntensity = 0.55;
    }

    let towerBeacon: THREE.Mesh | null = null;
    for (const b of intlBuildings(ap)) {
      const bx = ap.x + b.across;
      const bz = ap.z - b.along;
      if (b.kind === 'tower') {
        const shaft = new THREE.Mesh(new THREE.CylinderGeometry(4.5, 6.5, b.h - 9, 10), wallMat);
        shaft.position.set(bx, E + (b.h - 9) / 2, bz);
        shaft.castShadow = true;
        g.add(shaft);
        const cab = new THREE.Mesh(new THREE.CylinderGeometry(8, 6.4, 9, 10), glassMat);
        cab.position.set(bx, E + b.h - 4.5, bz);
        cab.castShadow = true;
        g.add(cab);
        towerBeacon = new THREE.Mesh(
          new THREE.SphereGeometry(1.1, 8, 6),
          new THREE.MeshBasicMaterial({ color: 0xff4040 }),
        );
        towerBeacon.position.set(bx, E + b.h + 3, bz);
        g.add(towerBeacon);
        continue;
      }
      const body = new THREE.Mesh(
        new THREE.BoxGeometry(b.wa * 2, b.h, b.la * 2),
        b.kind === 'hangar' ? hangarMat : wallMat,
      );
      body.position.set(bx, E + b.h / 2, bz);
      // cast but don't receive — big flat roofs self-shadow into crawling
      // acne as the sun's shadow box chases the player (city towers follow
      // the same rule)
      body.castShadow = true;
      g.add(body);
      if (b.kind === 'hangar') {
        const door = new THREE.Mesh(new THREE.PlaneGeometry(b.wa * 1.7, b.h * 0.7), doorMat);
        door.position.set(bx, E + b.h * 0.35, bz - b.la - 0.15);
        door.rotation.y = Math.PI; // faces the terminals to the north
        g.add(door);
      } else {
        // glazing band wrapping the upper storey + a darker plinth storey
        // at street level + a flat roof cap with rooftop plant
        const band = new THREE.Mesh(
          new THREE.BoxGeometry(b.wa * 2 + 0.6, b.h * 0.32, b.la * 2 + 0.6),
          glassMat,
        );
        band.position.set(bx, E + b.h * 0.62, bz);
        g.add(band);
        const plinth = new THREE.Mesh(
          new THREE.BoxGeometry(b.wa * 2 + 0.5, b.h * 0.16, b.la * 2 + 0.5),
          plinthMat,
        );
        plinth.position.set(bx, E + b.h * 0.09, bz);
        g.add(plinth);
        // roof cap sits SUNK into the body: a bottom face exactly coplanar
        // with the building's top plane z-fights into full-surface shimmer
        const roof = new THREE.Mesh(
          new THREE.BoxGeometry(b.wa * 1.92, 1.2, b.la * 1.92),
          roofMat,
        );
        roof.position.set(bx, E + b.h + 0.25, bz);
        g.add(roof);
        if (b.kind === 'terminal') {
          for (const pa of [-0.45, 0.35]) {
            const plant = new THREE.Mesh(new THREE.BoxGeometry(b.wa * 0.55, 2.4, 14), plantMat);
            plant.position.set(bx + b.wa * 0.3, E + b.h + 1.8, bz + b.la * 2 * pa);
            plant.castShadow = true;
            g.add(plant);
          }
        }
      }
    }

    // jet bridges: one per gate stand, pier wall to aircraft nose — the
    // stands come from the SAME list the parked NPCs use, so bridges meet
    // noses. Each is a raised corridor on a support leg.
    const bridgeMat = new THREE.MeshLambertMaterial({ color: 0x7b838c });
    for (const s of INTL_STANDS) {
      const noseDir = s.yaw === 0 ? 1 : -1; // toward the owning pier
      const b0 = s.along + noseDir * 30;    // pier face
      const b1 = s.along + noseDir * 15;    // nose position
      const bridge = new THREE.Mesh(
        new THREE.BoxGeometry(2.6, 2.3, Math.abs(b1 - b0) + 2),
        bridgeMat,
      );
      bridge.position.set(ap.x + s.across, E + 4.4, ap.z - (b0 + b1) / 2);
      bridge.castShadow = true;
      g.add(bridge);
      const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.35, 3.3, 6), bridgeMat);
      leg.position.set(ap.x + s.across, E + 1.65, ap.z - b1);
      g.add(leg);
    }

    // apron floodlight masts down both service lanes (lit heads after dark)
    const mastMat = new THREE.MeshLambertMaterial({ color: 0x8d949b });
    const headMat = this.nightOps
      ? new THREE.MeshBasicMaterial({ color: 0xfff2cc })
      : new THREE.MeshLambertMaterial({ color: 0x40464d });
    for (const sx of [-1, 1]) {
      for (const za of [-1500, -900, -300, 300, 900, 1500]) {
        const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.4, 24, 6), mastMat);
        mast.position.set(ap.x + sx * 540, E + 12, ap.z + za);
        g.add(mast);
        const head = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.8, 1.2), headMat);
        head.position.set(ap.x + sx * 540, E + 24.2, ap.z + za);
        g.add(head);
      }
    }
    return towerBeacon!;
  }
}

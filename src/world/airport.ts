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
import { WorldGen, AirfieldDef, intlBuildings, intlTaxiways, INTL_STANDS } from './heightfield';
import { runwayIdent } from '../nav/ils';
import { clamp } from '../core/math';

/**
 * Linear-space value → sRGB canvas byte. Canvas textures are sRGB-decoded
 * by the renderer while terrain vertex colours stay linear, so painting
 * canvas pixels through this transfer keeps overlay planes the SAME TONE as
 * the terrain paint beneath them (the airport z-fight rule).
 */
const srgb = (v: number): number =>
  Math.round(255 * Math.max(0, 1.055 * Math.pow(Math.max(v, 0), 1 / 2.4) - 0.055));
const rgb = (r: number, g: number, b: number): string => `rgb(${srgb(r)},${srgb(g)},${srgb(b)})`;

/** Taxiway/stand pavement tones — MUST match the colorAt backing paint. */
const PAVE: [number, number, number] = [0.3, 0.31, 0.33];
const APRON: [number, number, number] = [0.4, 0.41, 0.43];
const STAND: [number, number, number] = [0.31, 0.32, 0.34];
const TAXI_YELLOW = '#c9a83e';

const BUILD_RADIUS = 20000;
const DROP_RADIUS = 24000;

interface BuiltField {
  def: AirfieldDef;
  group: THREE.Group;
  /** grow-in ramp 0→1 for fields built at distance: furniture rises out of
   *  the apron over a few seconds (like terrain geomorphs) instead of a
   *  whole airport materializing in one frame at the 20 km build radius */
  grow: number;
  sockPivot: THREE.Group;
  beacon: THREE.Mesh | null;
  /** PAPI boxes in rows of four (closest to the runway first), both
   *  thresholds of every runway; angle thresholds index PAPI_DEG[i % 4] */
  papi: Array<{ mesh: THREE.Mesh; world: THREE.Vector3 }>;
  /** point-source light strings (runway edges, taxiway edges): instanced
   *  mesh + local/world positions + per-string size law */
  edge: Array<{
    mesh: THREE.InstancedMesh;
    local: Float32Array;
    world: Float32Array;
    div: number;
    cap: number;
  }>;
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

  private groundMats = new Map<string, THREE.MeshLambertMaterial>();

  private canvasMat(key: string, w: number, h: number,
    draw: (ctx: CanvasRenderingContext2D) => void,
    opts?: { wrapT?: boolean; side?: THREE.Side }): THREE.MeshLambertMaterial {
    let mat = this.groundMats.get(key);
    if (mat) return mat;
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    draw(c.getContext('2d')!);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    if (opts?.wrapT) tex.wrapT = THREE.RepeatWrapping;
    mat = new THREE.MeshLambertMaterial({ map: tex, side: opts?.side ?? THREE.FrontSide });
    this.groundMats.set(key, mat);
    return mat;
  }

  /** Tiling taxiway ribbon: 30 m across (23 m pavement between shoulders),
   *  double yellow edge lines + continuous centreline; one tile = 30 m of
   *  length, so ribbons repeat it via scaled UVs. Same technique as the
   *  runway texture — this is what makes taxiways crisp instead of the old
   *  16 m-texel vertex-paint blur. */
  private taxiMat(): THREE.MeshLambertMaterial {
    return this.canvasMat('taxi', 128, 128, (ctx) => {
      ctx.fillStyle = rgb(...PAVE);
      ctx.fillRect(0, 0, 128, 128);
      // shoulders, a shade darker and warmer
      ctx.fillStyle = 'rgba(28,22,14,0.3)';
      ctx.fillRect(0, 0, 15, 128);
      ctx.fillRect(113, 0, 15, 128);
      // gear-track sheen down the middle
      ctx.fillStyle = 'rgba(0,0,0,0.1)';
      ctx.fillRect(50, 0, 28, 128);
      // asphalt speckle, wrapped in y so the ribbon tiles seamlessly
      for (let i = 0; i < 80; i++) {
        const v = Math.floor(22 + Math.random() * 36);
        ctx.fillStyle = `rgba(${v},${v},${Math.floor(v * 1.08)},0.15)`;
        const x = 15 + Math.random() * 98;
        const y = Math.random() * 128;
        const sw = 1 + Math.random() * 3;
        const sh = 3 + Math.random() * 11;
        for (const dy of [-128, 0, 128]) ctx.fillRect(x, y + dy, sw, sh);
      }
      ctx.fillStyle = TAXI_YELLOW;
      for (const x of [16, 20, 106, 110]) ctx.fillRect(x, 0, 2, 128);
      ctx.fillRect(62, 0, 4, 128);
    }, { wrapT: true });
  }

  /** Runway-holding position bar: two solid yellow lines on the holding
   *  side, two dashed toward the runway (canvas top = runway side). */
  private holdMat(): THREE.MeshLambertMaterial {
    return this.canvasMat('hold', 128, 32, (ctx) => {
      ctx.fillStyle = rgb(...PAVE);
      ctx.fillRect(0, 0, 128, 32);
      ctx.fillStyle = TAXI_YELLOW;
      ctx.fillRect(15, 20, 98, 3);
      ctx.fillRect(15, 26, 98, 3);
      for (let x = 15; x < 113; x += 12) {
        ctx.fillRect(x, 6, 7, 3);
        ctx.fillRect(x, 12, 7, 3);
      }
    });
  }

  /** Gate stand marking: darker pad, yellow lead-in line + T stop bar.
   *  Canvas bottom = the entry side (south for an unrotated yaw-0 stand).
   *  Oversized vs the painted stand box so the vertex-paint spill can never
   *  peek past the crisp plane at fine texels. */
  private standMat(): THREE.MeshLambertMaterial {
    return this.canvasMat('stand', 128, 192, (ctx) => {
      ctx.fillStyle = rgb(...APRON);
      ctx.fillRect(0, 0, 128, 192);
      ctx.fillStyle = rgb(...STAND);
      ctx.fillRect(33, 50, 62, 92);
      ctx.strokeStyle = 'rgba(232,228,218,0.55)';
      ctx.lineWidth = 2;
      ctx.strokeRect(33, 50, 62, 92);
      ctx.fillStyle = TAXI_YELLOW;
      ctx.fillRect(62, 96, 4, 96);   // lead-in from the entry edge
      ctx.fillRect(50, 92, 28, 4);   // T stop bar at the nose position
    });
  }

  /** Red runway-holding-position sign ("27L-9R"), cached per designator. */
  private signMat(text: string): THREE.MeshLambertMaterial {
    return this.canvasMat(`sign:${text}`, 128, 48, (ctx) => {
      ctx.fillStyle = '#8d1a1a';
      ctx.fillRect(0, 0, 128, 48);
      ctx.strokeStyle = '#e8e4da';
      ctx.lineWidth = 2;
      ctx.strokeRect(3, 3, 122, 42);
      ctx.fillStyle = '#f2ede2';
      ctx.font = 'bold 24px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(text, 64, 25);
    }, { side: THREE.DoubleSide });
  }

  update(time: number, px: number, pz: number, py = 0): void {
    for (const f of this.built.values()) {
      // grow-in: squash vertically about the field's own elevation and rise
      // over ~6 s — sub-perceptual at the build radius, and done long before
      // the field is close enough to read
      if (f.grow < 1) {
        f.grow = Math.min(1, f.grow + 1 / (60 * 6));
        const s = f.grow * f.grow * (3 - 2 * f.grow);
        f.group.scale.y = Math.max(s, 0.001);
        f.group.position.y = f.def.elev * (1 - Math.max(s, 0.001));
      }

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

      // edge-light strings: rescale so distant ones hold ~2 px
      for (const { mesh, local, world, div, cap } of f.edge) {
        const n = local.length / 3;
        for (let i = 0; i < n; i++) {
          const d = Math.hypot(px - world[i * 3], py - world[i * 3 + 1], pz - world[i * 3 + 2]);
          const s = clamp(d / div, 1, cap);
          _m.makeScale(s, s, s);
          _m.setPosition(local[i * 3], local[i * 3 + 1], local[i * 3 + 2]);
          mesh.setMatrixAt(i, _m);
        }
        mesh.instanceMatrix.needsUpdate = true;
      }

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
      // fields built at distance grow in; ones built on top of you (boot,
      // teleport) appear instantly — you'd watch the growth from the apron
      if (!this.built.has(key)) this.buildField(def, key, Math.hypot(def.x - px, def.z - pz) > 8000);
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

  private buildField(ap: AirfieldDef, key: string, growIn = false): void {
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

    let beacon: THREE.Mesh | null = null;
    const taxiPts: number[] = []; // blue taxiway edge lights (night only)
    if (ap.intl) beacon = this.buildIntlExtras(g, ap, taxiPts);
    else if (ap.major) beacon = this.buildMajorExtras(g, ap);

    // point-source light strings: runway edges (always) + taxiway edges.
    // Night lets them bloom much larger so a lit field carries across the
    // valley (d/350 holds ≈2 px at any range at 1280 px width).
    const lightGeo = new THREE.SphereGeometry(0.42, 6, 5);
    const edge: BuiltField['edge'] = [];
    const strings: Array<{ pts: number[]; color: number; div: number; cap: number }> = [
      {
        pts: localPts, color: 0xffdd88,
        div: this.nightOps ? 350 : 900, cap: this.nightOps ? 60 : 3,
      },
    ];
    if (taxiPts.length > 0) {
      // taxiway edges are blue and dimmer than the runway string
      strings.push({ pts: taxiPts, color: 0x3d6bff, div: 500, cap: 26 });
    }
    for (const st of strings) {
      const local = Float32Array.from(st.pts);
      const n = local.length / 3;
      const mesh = new THREE.InstancedMesh(
        lightGeo, new THREE.MeshBasicMaterial({ color: st.color, fog: false }), n,
      );
      for (let i = 0; i < n; i++) {
        _m.makeTranslation(local[i * 3], local[i * 3 + 1], local[i * 3 + 2]);
        mesh.setMatrixAt(i, _m);
      }
      // instanced bounds are the 0.42 m base sphere — never let that cull a
      // multi-kilometre string of lights
      mesh.frustumCulled = false;
      g.add(mesh);
      edge.push({ mesh, local, world: new Float32Array(local.length), div: st.div, cap: st.cap });
    }

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
    for (const e of edge) {
      for (let i = 0; i < e.local.length; i += 3) {
        _v.set(e.local[i], e.local[i + 1], e.local[i + 2]);
        g.localToWorld(_v);
        e.world[i] = _v.x; e.world[i + 1] = _v.y; e.world[i + 2] = _v.z;
      }
    }

    if (growIn) {
      root.scale.y = 0.001;
      root.position.y = ap.elev * 0.999;
    }
    this.built.set(key, {
      def: ap, group: root as THREE.Group, sockPivot, beacon, papi,
      edge, aeroBeacon, grow: growIn ? 0 : 1,
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
   * International extras: the full taxiway system as crisp textured ribbons
   * (from the SAME intlTaxiways list colorAt paints as mid-LOD backing),
   * hold-short bars + runway designator signs, gate stand markings, and the
   * terminal spine from intlBuildings — the SAME list obstacles.ts turns
   * into collision boxes, so the buildings are exactly as solid as they
   * look. Returns the tower's red obstruction beacon. When nightOps, blue
   * taxiway edge-light positions are pushed into taxiPts.
   */
  private buildIntlExtras(g: THREE.Group, ap: AirfieldDef, taxiPts: number[]): THREE.Mesh {
    const E = ap.elev;

    // ---- taxiway ribbons ----
    // Runway-sized planes over same-tone terrain paint (the z-fight rule):
    // close up the terrain under them is clean turf (no backing halo) and
    // depth precision is plentiful; from the mid ring out colorAt paints
    // the same rectangles in the same tone beneath them.
    const tMat = this.taxiMat();
    const hMat = this.holdMat();
    const holdGeo = new THREE.PlaneGeometry(30, 7.5);
    holdGeo.rotateX(-Math.PI / 2);
    const signGeo = new THREE.PlaneGeometry(3.4, 1.1);
    const postGeo = new THREE.CylinderGeometry(0.07, 0.07, 1.2, 5);
    const postMat = new THREE.MeshLambertMaterial({ color: 0x8d949b });
    const n1 = runwayIdent(ap.heading);
    const n2 = runwayIdent(ap.heading + Math.PI);
    for (const t of intlTaxiways(ap)) {
      const len = t.halfLen * 2;
      const geo = new THREE.PlaneGeometry(t.halfWid * 2, len);
      const uv = geo.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) uv.setY(i, uv.getY(i) * (len / 30));
      geo.rotateX(-Math.PI / 2);
      const ribbon = new THREE.Mesh(geo, tMat);
      // connectors sit a step above the parallels so junction overlaps
      // never z-fight (the apron 0.04 / taxi 0.05 rule from the regionals);
      // everything stays under the runway planes at +0.06
      ribbon.position.set(ap.x + t.across, E + (t.conn ? 0.048 : 0.04), ap.z - t.along);
      ribbon.rotation.y = -t.yaw;
      ribbon.receiveShadow = true;
      g.add(ribbon);

      if (t.hold) {
        // hold-short bar ~15-22 m before the runway edge, dashed pair
        // (canvas top) toward the runway
        const u = t.hold * (t.halfLen - 28);
        const hAlong = t.along + u * t.cosY;
        const hAcross = t.across + u * t.sinY;
        const bar = new THREE.Mesh(holdGeo, hMat);
        bar.position.set(ap.x + hAcross, E + 0.055, ap.z - hAlong);
        bar.rotation.y = -t.yaw + (t.hold > 0 ? 0 : Math.PI);
        g.add(bar);

        // red runway-designator sign beside the bar, facing the taxiing
        // pilot (guards the runway at this segment's across sign)
        const sideR = t.across < 0 ? -1 : 1;
        const text = `${n1}${sideR < 0 ? 'L' : 'R'}-${n2}${sideR < 0 ? 'R' : 'L'}`;
        const v = t.halfWid + 3.5;
        const sAlong = hAlong - v * t.sinY;
        const sAcross = hAcross + v * t.cosY;
        const face = new THREE.Mesh(signGeo, this.signMat(text));
        face.position.set(ap.x + sAcross, E + 1.55, ap.z - sAlong);
        face.rotation.y = Math.atan2(-t.hold * t.sinY, t.hold * t.cosY);
        g.add(face);
        const post = new THREE.Mesh(postGeo, postMat);
        post.position.set(ap.x + sAcross, E + 0.6, ap.z - sAlong);
        g.add(post);
      }

      // blue taxiway edge lights after dark, both edges every 60 m
      if (this.nightOps) {
        for (let u = -t.halfLen + 12; u <= t.halfLen - 12; u += 60) {
          for (const sv of [-1, 1]) {
            const v = sv * (t.halfWid - 2);
            taxiPts.push(
              ap.x + t.across + u * t.sinY + v * t.cosY,
              E + 0.5,
              ap.z - (t.along + u * t.cosY - v * t.sinY),
            );
          }
        }
      }
    }

    // ---- gate stand markings: darker pad + lead-in, one per stand from
    // the ONE INTL_STANDS list, so paint, bridge and parked NPC line up ----
    const standGeo = new THREE.PlaneGeometry(70, 100);
    standGeo.rotateX(-Math.PI / 2);
    const sMat = this.standMat();
    for (const s of INTL_STANDS) {
      const pad = new THREE.Mesh(standGeo, sMat);
      pad.position.set(ap.x + s.across, E + 0.052, ap.z - s.along);
      if (s.yaw === Math.PI) pad.rotation.y = Math.PI; // entry from the north
      pad.receiveShadow = true;
      g.add(pad);
    }

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
      if (b.kind === 'fuel') {
        // fuel-farm tank: white cylinder + darker lid
        const tank = new THREE.Mesh(new THREE.CylinderGeometry(b.wa, b.wa, b.h, 14), wallMat);
        tank.position.set(bx, E + b.h / 2, bz);
        tank.castShadow = true;
        g.add(tank);
        const lid = new THREE.Mesh(new THREE.CylinderGeometry(b.wa * 0.94, b.wa * 0.94, 0.8, 14), roofMat);
        lid.position.set(bx, E + b.h + 0.15, bz);
        g.add(lid);
        continue;
      }
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
        b.kind === 'hangar' || b.kind === 'cargo' ? hangarMat : wallMat,
      );
      body.position.set(bx, E + b.h / 2, bz);
      // cast but don't receive — big flat roofs self-shadow into crawling
      // acne as the sun's shadow box chases the player (city towers follow
      // the same rule)
      body.castShadow = true;
      g.add(body);
      if (b.kind === 'hangar' || b.kind === 'cargo') {
        // hangar doors face the terminals; cargo docks face their apron
        const door = new THREE.Mesh(new THREE.PlaneGeometry(b.wa * 1.7, b.h * 0.7), doorMat);
        const s = b.kind === 'cargo' ? 1 : -1;
        door.position.set(bx, E + b.h * 0.35, bz + s * (b.la + 0.15));
        door.rotation.y = s > 0 ? 0 : Math.PI;
        g.add(door);
      } else if (b.kind === 'carpark') {
        // open-deck car park: concrete body with dark deck voids between
        // floor slabs — reads as parking levels without extra geometry
        for (const fy of [0.32, 0.68]) {
          const deckVoid = new THREE.Mesh(
            new THREE.BoxGeometry(b.wa * 2 + 0.5, b.h * 0.14, b.la * 2 + 0.5),
            plantMat,
          );
          deckVoid.position.set(bx, E + b.h * fy, bz);
          g.add(deckVoid);
        }
        const roof = new THREE.Mesh(
          new THREE.BoxGeometry(b.wa * 1.94, 1.0, b.la * 1.94),
          plinthMat,
        );
        roof.position.set(bx, E + b.h + 0.15, bz);
        g.add(roof);
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

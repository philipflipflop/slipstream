/**
 * NPC traffic. Four kinds of life around the world:
 *  - PARKED planes at airfields, deterministic per field (hash-seeded):
 *    airliners nose-in on the international terminal stands, light singles
 *    on regional aprons and strip edges — never on a runway or taxiway.
 *  - FLYING traffic: a handful of AI aircraft cruising long tracks through
 *    the player's region, terrain-aware, with nav lights and strobes. Two
 *    of them cruise in the flight levels and draw contrails.
 *  - AIRPORT MOVEMENTS: at internationals and regional fields aircraft fly
 *    the 3° approach to the into-wind runway, land, roll out and vacate;
 *    others taxi on, line up and depart. One runway movement at a time; an
 *    arrival that finds the runway occupied (by the player, too) goes
 *    around. Internationals keep them on the EASTERN runway of the pair —
 *    the player spawns on the western one.
 *  - SHIPS: freighters, ferries and small boats on open water, steering
 *    clear of the shallows, each trailing a wake.
 *
 * Every NPC is ONE merged vertex-coloured geometry (a draw call each, no
 * textures), cached per kind+livery. They are scenery, not physics — no
 * collision, same as the airport hangars.
 */
import * as THREE from 'three';
import { WorldGen, AirfieldDef, INTL_STANDS, WATER_LEVEL } from './heightfield';
import { approachesOf, type IlsApproach } from '../nav/ils';
import { clamp, damp, hash2, makeRng } from '../core/math';

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

/** Ground service vehicle: baggage tug, fuel bowser, crew bus or a
 *  baggage-cart train. Forward is -Z. */
type VehicleKind = 'tug' | 'fuel' | 'bus' | 'carts';
function vehicleGeo(kind: VehicleKind): THREE.BufferGeometry {
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
  } else if (kind === 'fuel') {
    const cab = new THREE.BoxGeometry(2.2, 2.0, 2.0);
    cab.translate(0, 1.3, -2.4);
    parts.push(paint(cab, 0xf2f4f6));
    const tank = new THREE.CylinderGeometry(1.05, 1.05, 4.6, 10);
    tank.rotateX(Math.PI / 2);
    tank.translate(0, 1.35, 0.9);
    parts.push(paint(tank, 0xc23b32));
  } else if (kind === 'bus') {
    const body = new THREE.BoxGeometry(2.4, 2.6, 9.4);
    body.translate(0, 1.75, 0);
    parts.push(paint(body, 0xf2f4f6));
    const band = new THREE.BoxGeometry(2.5, 0.8, 9.0);
    band.translate(0, 2.3, 0);
    parts.push(paint(band, 0x21384f)); // window band
  } else {
    // three-cart baggage train behind a drawbar
    for (const cz of [-2.2, 0, 2.2]) {
      const cart = new THREE.BoxGeometry(1.3, 1.3, 1.9);
      cart.translate(0, 0.95, cz);
      parts.push(paint(cart, cz === 0 ? 0x3a4148 : 0x6d7680));
    }
  }
  // simple axle blocks
  const axles = kind === 'tug' ? [-1.3, 1.1]
    : kind === 'fuel' ? [-2.2, 1.8]
    : kind === 'bus' ? [-3.1, 3.1]
    : [-2.2, 0, 2.2];
  for (const gz of axles) {
    const axle = new THREE.BoxGeometry(kind === 'tug' ? 1.6 : kind === 'carts' ? 1.1 : 2.3, 0.55, 0.6);
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

/**
 * A fading white trail along +Z (behind a model whose nose is at -Z): a
 * contrail (`crossed`: a horizontal and a vertical ribbon, so it reads from
 * any angle) or a ship's wake (flat on the water). Alpha rides the vertex
 * colours; the far end is fully transparent, so its length is never seen
 * as an edge.
 */
function trailGeo(len: number, w0: number, w1: number, a0: number, crossed: boolean): THREE.BufferGeometry {
  const T = [0, 0.015, 0.06, 0.16, 0.3, 0.48, 0.7, 1];
  const pos: number[] = [];
  const col: number[] = [];
  const planes = crossed ? 2 : 1;
  for (let pl = 0; pl < planes; pl++) {
    for (let i = 0; i < T.length - 1; i++) {
      const quad: Array<[number, number]> = [[i, -1], [i, 1], [i + 1, 1], [i, -1], [i + 1, 1], [i + 1, -1]];
      for (const [k, sgn] of quad) {
        const t = T[k];
        const half = (w0 + (w1 - w0) * Math.sqrt(t)) * 0.5 * sgn;
        if (pl === 0) pos.push(half, 0, t * len);
        else pos.push(0, half, t * len);
        const a = k === 0 ? 0 : a0 * Math.pow(1 - t, 1.3);
        col.push(1, 1, 1, a);
      }
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
  g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 4));
  return g;
}

type ShipKind = 'cargo' | 'ferry' | 'boat';
const SHIP: Record<ShipKind, { spd: number; ahead: number; wake: [number, number, number] }> = {
  cargo: { spd: 8.5, ahead: 1500, wake: [520, 20, 95] },
  ferry: { spd: 10.5, ahead: 1100, wake: [380, 13, 70] },
  boat: { spd: 5.5, ahead: 500, wake: [110, 4, 22] },
};

/** Ship hull + deck load. Forward is -Z; y = 0 is the WATERLINE (nothing
 *  is modelled below it, so the phone path — water drawn first, untested —
 *  shows the same ship as the depth-tested one). */
function shipGeo(kind: ShipKind): THREE.BufferGeometry {
  const key = `ship${kind}`;
  const hit = geoCache.get(key);
  if (hit) return hit;
  const parts: THREE.BufferGeometry[] = [];
  const hull = (w: number, h: number, l: number, color: number): void => {
    const b = new THREE.BoxGeometry(w, h, l);
    b.translate(0, h / 2 - 0.5, l * 0.04);
    parts.push(paint(b, color));
    // pointed bow: a square prism turned 45°
    const d = w / Math.SQRT2;
    const bow = new THREE.BoxGeometry(d, h, d);
    bow.rotateY(Math.PI / 4);
    bow.translate(0, h / 2 - 0.5, -l * 0.46);
    parts.push(paint(bow, color));
  };
  if (kind === 'cargo') {
    hull(22, 8, 150, 0x1c2836);
    const loads = [0xb5483a, 0x2f6fa3, 0xd9a13a, 0x3d8a5a, 0xcfd3d6, 0x8a4a2a];
    for (let i = 0; i < 5; i++) {
      const stack = new THREE.BoxGeometry(18, 5 + ((i * 7) % 3) * 2.6, 19);
      stack.translate(0, 7.5 + (5 + ((i * 7) % 3) * 2.6) / 2, -52 + i * 21);
      parts.push(paint(stack, loads[i % loads.length]));
    }
    const bridge = new THREE.BoxGeometry(19, 17, 13);
    bridge.translate(0, 16, 64);
    parts.push(paint(bridge, 0xeef1f3));
    const funnel = new THREE.BoxGeometry(5, 8, 6);
    funnel.translate(0, 28, 67);
    parts.push(paint(funnel, 0xb3272f));
  } else if (kind === 'ferry') {
    hull(15, 6, 78, 0xf2f4f6);
    const decks = new THREE.BoxGeometry(13, 7, 56);
    decks.translate(0, 9, 4);
    parts.push(paint(decks, 0xe6eaee));
    const band = new THREE.BoxGeometry(13.3, 1.6, 52);
    band.translate(0, 9.6, 4);
    parts.push(paint(band, 0x21384f));
    const funnel = new THREE.BoxGeometry(5, 6, 7);
    funnel.translate(0, 15.5, 18);
    parts.push(paint(funnel, 0x1c3f8f));
  } else {
    hull(4.6, 2.6, 15, 0xf0f2f4);
    const cabin = new THREE.BoxGeometry(3.2, 2.2, 4.4);
    cabin.translate(0, 3.2, 1.5);
    parts.push(paint(cabin, 0x2f6fa3));
  }
  const g = merge(parts);
  geoCache.set(key, g);
  return g;
}

interface Ship {
  group: THREE.Group;
  kind: ShipKind;
  hdg: number;
  turn: number;   // rad/s while steering off the shallows
  turnT: number;
  checkT: number;
}

/* -------------------------------------------------- hit volumes ---- */

/** A solid as boxes in the model's own frame (forward −Z, y from the wheels
 *  or the waterline): [cx, cy, cz, half-x, half-y, half-z]. Fuselage, wing
 *  and tail are separate boxes — you can fly under a wing, not through it. */
type Box = readonly [number, number, number, number, number, number];
const SOLID_AIRLINER: readonly Box[] = [
  [0, 3.2, 1.5, 1.8, 1.8, 17.5],   // fuselage
  [0, 2.1, 3.0, 15.5, 0.5, 4.5],   // wing (swept: the box spans the sweep)
  [0, 7.4, 16.5, 0.4, 2.6, 2.8],   // fin
  [0, 4.2, 17.5, 5.6, 0.3, 2.0],   // tailplane
];
const SOLID_GA: readonly Box[] = [
  [0, 1.35, -0.5, 0.7, 0.75, 4.4],
  [0, 2.2, -0.6, 5.1, 0.2, 0.8],
  [0, 2.3, 3.5, 1.7, 0.8, 0.6],
];
const SOLID_VEHICLE: Record<VehicleKind, readonly Box[]> = {
  tug: [[0, 0.9, -0.1, 0.8, 0.9, 2.3]],
  fuel: [[0, 1.2, -0.1, 1.15, 1.2, 3.3]],
  bus: [[0, 1.55, 0, 1.25, 1.55, 4.7]],
  carts: [[0, 0.8, 0, 0.7, 0.8, 3.2]],
};
const SOLID_SHIP: Record<ShipKind, readonly Box[]> = {
  cargo: [[0, 3.5, 0, 11, 4, 82], [0, 12.5, -10, 9, 5.5, 52], [0, 16, 64, 9.5, 8.5, 6.5], [0, 28, 67, 2.5, 4, 3]],
  ferry: [[0, 2.5, 0, 7.5, 3, 42.5], [0, 9, 4, 6.5, 3.5, 28], [0, 15.5, 18, 2.5, 3, 3.5]],
  boat: [[0, 0.8, -0.4, 2.3, 1.3, 8.6], [0, 3.2, 1.5, 1.6, 1.1, 2.2]],
};
/** bounding radius of each set of boxes, m (broad phase) */
const reachOf = (s: readonly Box[]): number => {
  let r = 0;
  for (const b of s) r = Math.max(r, Math.hypot(Math.abs(b[0]) + b[3], Math.abs(b[1]) + b[4], Math.abs(b[2]) + b[5]));
  return r;
};
const REACH = new Map<readonly Box[], number>();
for (const s of [SOLID_AIRLINER, SOLID_GA, ...Object.values(SOLID_VEHICLE), ...Object.values(SOLID_SHIP)]) REACH.set(s, reachOf(s));

const HIT_MIDAIR = 'MID-AIR COLLISION';
const HIT_RUNWAY = 'COLLIDED WITH AN AIRCRAFT ON THE RUNWAY';
const HIT_PARKED = 'HIT A PARKED AIRCRAFT';
const HIT_VEHICLE = 'HIT A GROUND VEHICLE';
const HIT_SHIP = 'FLEW INTO A SHIP';

/** Sphere (radius r, at the model-frame point) against a set of boxes. */
function boxesHit(shape: readonly Box[], bx: number, by: number, bz: number, r: number): boolean {
  for (const b of shape) {
    const dx = Math.max(Math.abs(bx - b[0]) - b[3], 0);
    const dy = Math.max(Math.abs(by - b[1]) - b[4], 0);
    const dz = Math.max(Math.abs(bz - b[2]) - b[5], 0);
    if (dx * dx + dy * dy + dz * dz <= r * r) return true;
  }
  return false;
}

/**
 * A sphere that moved (rvx, rvy, rvz)·dt RELATIVE to a solid over the last
 * step, against that solid where it is now. Swept in sub-steps no longer
 * than the sphere: two jets close at 500 m/s — 8 m a frame, more than a
 * fuselage is wide — and an end-of-step test alone would pass through.
 */
function solidHit(
  shape: readonly Box[], ox: number, oy: number, oz: number, yaw: number,
  x: number, y: number, z: number, r: number, rvx: number, rvy: number, rvz: number, dt: number,
): boolean {
  const travel = Math.hypot(rvx, rvy, rvz) * dt;
  const reach = REACH.get(shape)! + r + travel;
  const ex0 = x - ox;
  const ey0 = y - oy;
  const ez0 = z - oz;
  if (Math.abs(ex0) > reach || Math.abs(ez0) > reach || Math.abs(ey0) > reach) return false;
  const c = Math.cos(yaw);
  const s = Math.sin(yaw);
  const n = Math.min(Math.max(Math.ceil(travel / Math.max(r, 1.5)), 1), 12);
  for (let k = 0; k < n; k++) {
    const back = (k / n) * dt;
    const ex = ex0 - rvx * back;
    const ez = ez0 - rvz * back;
    if (boxesHit(shape, ex * c - ez * s, ey0 - rvy * back, ex * s + ez * c, r)) return true;
  }
  return false;
}

/* ---------------------------------------------- airport movements ---- */

const TAN_GS = Math.tan((3 * Math.PI) / 180);

/** how each class flies the pattern (m, m/s, m/s²) */
const OPS: Record<NpcKind, {
  vApp: number; vTaxi: number; decel: number; accel: number; vRot: number;
  climb: number; vClimb: number; flare: number; from: number; top: number; stub: number;
  arr: [number, number]; dep: [number, number];
}> = {
  airliner: {
    vApp: 72, vTaxi: 9, decel: 2.1, accel: 2.0, vRot: 76, climb: 13, vClimb: 108,
    flare: 12, from: 11500, top: 2600, stub: 150, arr: [135, 200], dep: [80, 130],
  },
  ga: {
    vApp: 34, vTaxi: 6, decel: 1.6, accel: 1.5, vRot: 31, climb: 4.2, vClimb: 46,
    flare: 6, from: 5200, top: 800, stub: 60, arr: [190, 360], dep: [170, 340],
  },
};

export type OpsPhase = 'final' | 'rollout' | 'vacate' | 'enter' | 'hold' | 'roll' | 'climb';

export interface OpsFlight {
  group: THREE.Group;
  beacon: THREE.Mesh;
  strobe: THREE.Mesh;
  lamp: THREE.Mesh;
  kind: NpcKind;
  app: IlsApproach;
  /** which side of the runway the terminal is on (+1 = right of the course) */
  side: number;
  phase: OpsPhase;
  /** metres along the runway from the threshold (negative on the approach) */
  s: number;
  /** metres off the centreline toward the terminal side */
  off: number;
  /** heading offset from the runway course, toward the terminal side */
  turn: number;
  y: number;
  v: number;
  pitch: number;
  fade: number;
  timer: number;
  checked: boolean;
  phaseOff: number;
  /** telemetry for the tests: how this flight's runway time went */
  wentAround: boolean;
}

interface FieldOps {
  apps: IlsApproach[];
  kind: NpcKind;
  flights: OpsFlight[];
  nextArr: number;
  nextDep: number;
  n: number;
}

export interface TrafficBlip {
  x: number; y: number; z: number; hdg: number;
  /** 0 airborne, 1 aircraft on the ground, 2 ship */
  kind: 0 | 1 | 2;
  id: number;
}

interface FlyingNpc {
  group: THREE.Group;
  kind: NpcKind;
  /** cruises in the flight levels, trailing a contrail */
  high: boolean;
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
    /** grow-in ramp 0→1 when built at distance (same rule as Airport
     *  furniture): parked rows rise from the apron instead of popping */
    grow: number;
    /** apron service vehicles doing slow laps of the stand row */
    movers: Array<{ m: THREE.Object3D; along: number; side: number; dir: number }>;
    /** everything standing or driving on the aprons, with its hit volume
     *  (positions are in the field's own heading-0 frame, like the meshes) */
    solids: Array<{ m: THREE.Object3D; shape: readonly Box[]; reason: string }>;
    def: AirfieldDef;
    /** runway movements (internationals and regional fields) */
    ops: FieldOps | null;
  }>();
  private flying: FlyingNpc[] = [];
  private ships: Ship[] = [];
  private shipTry = 0;
  private busyByPlayer = false;
  private shipTurn = 0;
  private mat: THREE.MeshLambertMaterial;
  private trailMat: THREE.MeshBasicMaterial;
  private redMat = new THREE.MeshBasicMaterial({ color: 0xff2222 });
  private whiteMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
  private lampMat = new THREE.MeshBasicMaterial({ color: 0xfff6dc, fog: false });
  private contrailGeo: THREE.BufferGeometry | null = null;
  private wakeGeos = new Map<ShipKind, THREE.BufferGeometry>();
  private lightGeos = new Map<number, THREE.SphereGeometry>();
  private scanTimer = 0;
  private queryScratch: AirfieldDef[] = [];
  private rng = makeRng(0x7ea6f1c);
  private windX = 0;
  private windZ = 0;
  /** counters since start (tab-title telemetry + tests) */
  stats = { landings: 0, departures: 0, goArounds: 0 };

  /** how many ships the sea around the player carries */
  static readonly SHIPS = 6;

  constructor(private scene: THREE.Scene, private gen: WorldGen) {
    this.mat = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.trailMat = new THREE.MeshBasicMaterial({
      vertexColors: true, transparent: true, depthWrite: false, side: THREE.DoubleSide,
    });
  }

  /** The wind the airfields work to (same vector as flightModel.setWind):
   *  movements use the into-wind runway, like the windsock says. */
  setWind(vx: number, vz: number): void {
    this.windX = vx;
    this.windZ = vz;
  }

  /** called when an arrival goes around because the PLAYER is on its runway */
  onPlayerBlock: (field: string) => void = () => {};

  /**
   * Everything that moves, for the map and the tower: fills `out` and
   * returns the count. kind 0 = airborne aircraft, 1 = aircraft on the
   * ground (runway movements), 2 = ship. `id` is stable per aircraft.
   */
  blips(out: TrafficBlip[]): number {
    let n = 0;
    const put = (g: THREE.Vector3, hdg: number, kind: 0 | 1 | 2, id: number): void => {
      const b = out[n] ?? (out[n] = { x: 0, y: 0, z: 0, hdg: 0, kind: 0, id: 0 });
      b.x = g.x; b.y = g.y; b.z = g.z; b.hdg = hdg; b.kind = kind; b.id = id;
      n++;
    };
    for (const f of this.flying) put(f.group.position, f.hdg, 0, f.group.id);
    for (const rec of this.parked.values()) {
      if (!rec.ops) continue;
      for (const f of rec.ops.flights) {
        if (f.fade < 1) continue;
        const air = f.phase === 'final' || f.phase === 'climb';
        put(f.group.position, f.app.course + f.side * f.turn, air ? 0 : 1, f.group.id);
      }
    }
    for (const s of this.ships) put(s.group.position, s.hdg, 2, s.group.id);
    return n;
  }

  /** True while an NPC is on the runway this approach leads to (either end). */
  runwayOccupied(app: IlsApproach): boolean {
    const cx = app.thrX + Math.sin(app.course) * app.length * 0.5;
    const cz = app.thrZ - Math.cos(app.course) * app.length * 0.5;
    for (const rec of this.parked.values()) {
      if (!rec.ops) continue;
      for (const f of rec.ops.flights) {
        const a = f.app;
        const fx = a.thrX + Math.sin(a.course) * a.length * 0.5;
        const fz = a.thrZ - Math.cos(a.course) * a.length * 0.5;
        if (Math.abs(fx - cx) > 8 || Math.abs(fz - cz) > 8) continue;
        if (f.phase === 'rollout' || f.phase === 'roll' || f.phase === 'hold') return true;
        if ((f.phase === 'vacate' || f.phase === 'enter') && Math.abs(f.off) < 45) return true;
      }
    }
    return false;
  }

  /**
   * Is a sphere of radius `r` at (x, y, z) touching an NPC — a parked,
   * taxiing or flying aircraft, an apron vehicle, a ship? Returns the crash
   * reason, or null. (vx, vy, vz) and `dt` are the sphere's own velocity and
   * the step just taken: the test is swept against each mover's motion.
   * Volumes are boxes per fuselage / wing / tail (see SOLID_*), tested where
   * the models are DRAWN — same positions, same headings.
   */
  hit(x: number, y: number, z: number, r: number, vx = 0, vy = 0, vz = 0, dt = 0): string | null {
    for (const f of this.flying) {
      const p = f.group.position;
      const shape = f.kind === 'airliner' ? SOLID_AIRLINER : SOLID_GA;
      if (solidHit(shape, p.x, p.y, p.z, f.group.rotation.y, x, y, z, r,
        vx - Math.sin(f.hdg) * f.spd, vy, vz + Math.cos(f.hdg) * f.spd, dt)) return HIT_MIDAIR;
    }
    for (const rec of this.parked.values()) {
      const def = rec.def;
      const dx = x - def.x;
      const dz = z - def.z;
      const span = def.length * 0.5 + 2600;
      if (rec.grow >= 1 && rec.solids.length > 0 && y < def.elev + 14 + r && dx * dx + dz * dz < span * span) {
        // into the field's heading-0 frame, where the apron furniture lives
        const lx = def.x + dx * def.cosH + dz * def.sinH;
        const lz = def.z - dx * def.sinH + dz * def.cosH;
        const lvx = vx * def.cosH + vz * def.sinH;
        const lvz = -vx * def.sinH + vz * def.cosH;
        for (const sol of rec.solids) {
          const p = sol.m.position;
          if (solidHit(sol.shape, p.x, p.y, p.z, sol.m.rotation.y, lx, y, lz, r, lvx, vy, lvz, dt)) return sol.reason;
        }
      }
      if (!rec.ops) continue;
      for (const f of rec.ops.flights) {
        if (f.fade < 0.95) continue;
        const p = f.group.position;
        const shape = f.kind === 'airliner' ? SOLID_AIRLINER : SOLID_GA;
        const hdg = f.app.course + f.side * f.turn;
        if (solidHit(shape, p.x, p.y, p.z, f.group.rotation.y, x, y, z, r,
          vx - Math.sin(hdg) * f.v, vy, vz + Math.cos(hdg) * f.v, dt)) {
          return f.y > f.app.elev + 2 ? HIT_MIDAIR : HIT_RUNWAY;
        }
      }
    }
    for (const s of this.ships) {
      const p = s.group.position;
      if (solidHit(SOLID_SHIP[s.kind], p.x, p.y, p.z, s.group.rotation.y, x, y, z, r, vx, vy, vz, dt)) return HIT_SHIP;
    }
    return null;
  }

  /**
   * The player has just been put on a runway near (x, z): take the runway
   * movements of the fields around it off the stage (they come back on
   * schedule). Without this a restart can drop you onto the spot where an
   * NPC is lined up — which, now that they are solid, ends the flight.
   */
  clearMovements(x: number, z: number): void {
    for (const rec of this.parked.values()) {
      if (!rec.ops || Math.hypot(rec.def.x - x, rec.def.z - z) > rec.def.length * 0.5 + 2600) continue;
      for (const f of rec.ops.flights) this.scene.remove(f.group);
      rec.ops.flights.length = 0;
    }
  }

  /** Telemetry: movements in progress, and ships afloat. */
  info(): string {
    let n = 0;
    for (const rec of this.parked.values()) n += rec.ops ? rec.ops.flights.length : 0;
    return `${n}/${this.stats.landings}+${this.stats.departures}/${this.ships.length}`;
  }

  /** `py`: the player's altitude — NPCs on final break off rather than
   *  share a glide path with you (omit it and they do not look). */
  update(dt: number, px: number, pz: number, time: number, airborneOn: boolean, pAgl = 1e9, py = NaN): void {
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
      if (rec.grow < 1) {
        rec.grow = Math.min(1, rec.grow + dt / 6);
        const s = rec.grow * rec.grow * (3 - 2 * rec.grow);
        rec.group.scale.y = Math.max(s, 0.001);
        rec.group.position.y = rec.def.elev * (1 - Math.max(s, 0.001));
      }
      for (const v of rec.movers) {
        v.along += v.dir * 7 * dt;
        if (Math.abs(v.along) > 1500) v.dir = -v.dir;
        // local heading-0 frame (the group pivot carries the field heading)
        v.m.position.set(rec.def.x + v.side * 460, rec.def.elev, rec.def.z - v.along);
        v.m.rotation.y = v.dir > 0 ? Math.PI : 0;
      }
    }

    // ---- runway movements, ships ----
    for (const rec of this.parked.values()) this.updateOps(rec, dt, time, px, pz, pAgl, airborneOn, py);
    this.updateShips(dt, px, pz);

    // ---- parked layer: scan for nearby fields twice a second ----
    this.scanTimer -= 1;
    if (this.scanTimer > 0) return;
    this.scanTimer = 30;
    const near = this.gen.airfieldsNear(px, pz, BUILD_RADIUS, this.queryScratch);
    for (const def of near) {
      const key = `${def.x},${def.z}`;
      if (!this.parked.has(key)) this.buildParked(def, key, Math.hypot(def.x - px, def.z - pz) > 8000);
    }
    for (const [key, rec] of this.parked) {
      const [fx, fz] = key.split(',').map(Number);
      if (Math.hypot(fx - px, fz - pz) > DROP_RADIUS) {
        this.scene.remove(rec.group);
        if (rec.ops) for (const f of rec.ops.flights) this.scene.remove(f.group);
        this.parked.delete(key);
      }
    }
  }

  /* ------------------------------------------------ runway movements ---- */

  private lightGeo(r: number): THREE.SphereGeometry {
    let g = this.lightGeos.get(r);
    if (!g) this.lightGeos.set(r, g = new THREE.SphereGeometry(r, 6, 5));
    return g;
  }

  /** The runway end in use: the one with the most headwind — unless traffic
   *  is already established on one (nobody lands against the flow). */
  private activeApp(o: FieldOps): IlsApproach {
    if (o.flights.length > 0) return o.flights[0].app;
    let best = o.apps[0];
    let bestHead = -Infinity;
    for (const a of o.apps) {
      const head = -(this.windX * Math.sin(a.course) - this.windZ * Math.cos(a.course));
      if (head > bestHead + 0.3) { bestHead = head; best = a; }
    }
    return best;
  }

  /** True while the runway cannot take another movement: an NPC is on it,
   *  or the player is (on the ground or skimming it). */
  private runwayBusy(o: FieldOps, app: IlsApproach, self: OpsFlight, px: number, pz: number, pAgl: number): boolean {
    this.busyByPlayer = false;
    for (const f of o.flights) {
      if (f === self) continue;
      if (f.phase === 'rollout' || f.phase === 'roll' || f.phase === 'hold') return true;
      if ((f.phase === 'vacate' || f.phase === 'enter') && Math.abs(f.off) < 45) return true;
    }
    this.busyByPlayer = true;
    return this.playerOn(app, px, pz, pAgl, 55);
  }

  /** The player is on (or skimming) this runway, within `half` m of its centreline. */
  private playerOn(app: IlsApproach, px: number, pz: number, pAgl: number, half: number): boolean {
    if (pAgl >= 25) return false;
    const dx = px - app.thrX;
    const dz = pz - app.thrZ;
    const dirX = Math.sin(app.course);
    const dirZ = -Math.cos(app.course);
    const along = dx * dirX + dz * dirZ;
    const cross = dx * -dirZ + dz * dirX;
    return along > -200 && along < app.length + 200 && Math.abs(cross) < half;
  }

  private spawnOps(o: FieldOps, def: AirfieldDef, phase: 'final' | 'enter', frac = 1): OpsFlight {
    const app = this.activeApp(o);
    const p = OPS[o.kind];
    const group = this.mkNpcModel(o.kind, o.n++, false);
    group.rotation.order = 'YXZ';
    const big = o.kind === 'airliner';
    // shared geometries: movements come and go all session — a sphere per
    // spawn would be a GPU buffer leaked every two minutes
    const glow = this.lightGeo(big ? 0.5 : 0.3);
    const beacon = new THREE.Mesh(glow, this.redMat);
    beacon.position.set(0, big ? 5.2 : 2.6, 2);
    const strobe = new THREE.Mesh(glow, this.whiteMat);
    strobe.position.set(0, big ? 4.5 : 2.4, big ? 18 : 4);
    // landing light: what you actually see of an aircraft on final
    const lamp = new THREE.Mesh(this.lightGeo(big ? 0.9 : 0.5), this.lampMat);
    lamp.position.set(0, big ? 1.6 : 0.9, big ? -9 : -2.6);
    group.add(beacon, strobe, lamp);
    this.scene.add(group);
    // the terminal side: toward the field centre (pairs), else the apron side
    const rx = Math.cos(app.course);
    const rz = Math.sin(app.course);
    let toC = (def.x - app.thrX) * rx + (def.z - app.thrZ) * rz;
    if (Math.abs(toC) < 1) toC = rx * def.cosH + rz * def.sinH;
    const f: OpsFlight = {
      group, beacon, strobe, lamp, kind: o.kind, app, side: toC >= 0 ? 1 : -1, phase,
      s: 0, off: 0, turn: 0, y: app.elev, v: 0, pitch: 0, fade: 1, timer: 0, checked: false,
      phaseOff: this.rng() * 2, wentAround: false,
    };
    if (phase === 'final') {
      f.s = -p.from * frac;
      f.v = p.vApp;
      f.y = app.elev + (300 - f.s) * TAN_GS;
      f.pitch = 0.045;
    } else {
      // appears at the holding point beside the threshold, facing the runway
      f.s = 70;
      f.off = p.stub;
      f.turn = -Math.PI / 2;
      f.fade = 0;
    }
    o.flights.push(f);
    this.placeOps(f, 0);
    return f;
  }

  private placeOps(f: OpsFlight, time: number): void {
    const a = f.app;
    const dirX = Math.sin(a.course);
    const dirZ = -Math.cos(a.course);
    const o = f.off * f.side;
    f.group.position.set(a.thrX + dirX * f.s - dirZ * o, f.y, a.thrZ + dirZ * f.s + dirX * o);
    f.group.rotation.set(f.pitch, -(a.course + f.side * f.turn), 0);
    const k = f.fade * f.fade * (3 - 2 * f.fade);
    f.group.scale.setScalar(Math.max(k, 0.001));
    const bt = (time + f.phaseOff) % 1.9;
    f.beacon.visible = bt < 0.26;
    const st = (time + f.phaseOff) % 1.3;
    f.strobe.visible = st < 0.05 || (st > 0.12 && st < 0.17);
    f.lamp.visible = f.phase === 'final' || f.phase === 'roll' || f.phase === 'hold' ||
      (f.phase === 'climb' && f.y < a.elev + 900);
  }

  private updateOps(
    rec: { def: AirfieldDef; ops: FieldOps | null },
    dt: number, time: number, px: number, pz: number, pAgl: number, on: boolean, py: number,
  ): void {
    // nobody is put on stage within 2.5 km of the player: they are solid
    const spawnClear = (f: OpsFlight): void => {
      const g = f.group.position;
      if (Math.hypot(g.x - px, g.z - pz) > 2500) return;
      this.scene.remove(f.group);
      o!.flights.splice(o!.flights.indexOf(f), 1);
    };
    const def = rec.def;
    if (!def.intl && !def.major) return;
    let o = rec.ops;
    if (!o) {
      if (!on) return;
      const all: IlsApproach[] = [];
      approachesOf(def, all);
      const kind: NpcKind = def.intl ? 'airliner' : 'ga';
      // internationals: the eastern runway of the pair (entries 2, 3)
      o = rec.ops = {
        apps: def.intl && all.length === 4 ? all.slice(2) : all,
        kind, flights: [], n: Math.floor(this.rng() * 4),
        nextArr: time + 20 + this.rng() * 50,
        nextDep: time + 15 + this.rng() * 40,
      };
      // someone is already established on final when the field comes into view
      spawnClear(this.spawnOps(o, def, 'final', 0.3 + this.rng() * 0.45));
    }
    const p = OPS[o.kind];

    if (on) {
      // the nearest arrival still on the approach
      let nearArr = -Infinity;
      let entering = false;
      for (const f of o.flights) {
        if (f.phase === 'final' && f.s > nearArr) nearArr = f.s;
        if (f.phase === 'enter' || f.phase === 'hold') entering = true;
      }
      let farArr = Infinity;
      for (const f of o.flights) if (f.phase === 'final' && f.s < farArr) farArr = f.s;
      if (time >= o.nextArr && farArr > -(p.from - 6500)) {
        spawnClear(this.spawnOps(o, def, 'final'));
        o.nextArr = time + p.arr[0] + this.rng() * (p.arr[1] - p.arr[0]);
      }
      // a departure taxis on only into a gap that will still be there when
      // it rolls (~60 s later)
      // (…and never onto a runway the player is on or lined up beside)
      if (time >= o.nextDep && !entering && nearArr < -p.vApp * 100 &&
          !this.playerOn(this.activeApp(o), px, pz, pAgl, p.stub + 40)) {
        this.spawnOps(o, def, 'enter');
        o.nextDep = time + p.dep[0] + this.rng() * (p.dep[1] - p.dep[0]);
      }
    }

    for (let i = o.flights.length - 1; i >= 0; i--) {
      const f = o.flights[i];
      const keep = on && this.stepOps(f, o, dt, px, pz, pAgl, py);
      if (keep) {
        this.placeOps(f, time);
      } else {
        this.scene.remove(f.group);
        o.flights.splice(i, 1);
      }
    }
  }

  /** Advance one movement; false once it has left the stage. */
  private stepOps(f: OpsFlight, o: FieldOps, dt: number, px: number, pz: number, pAgl: number, py: number): boolean {
    const p = OPS[f.kind];
    const a = f.app;
    switch (f.phase) {
      case 'final': {
        // the player is airborne close by, at about this height — ahead on
        // the same approach, coming up behind, or crossing: break off and
        // climb away (a 72 m/s airliner would otherwise run down a trainer
        // on its own glide path, or be run down by a jet)
        if (pAgl >= 25 && Math.abs(py - f.y) < 250 &&
            Math.hypot(f.group.position.x - px, f.group.position.z - pz) < 1800) {
          f.phase = 'climb';
          f.timer = 0;
          f.wentAround = true;
          this.stats.goArounds++;
          return true;
        }
        f.s += f.v * dt;
        const path = (300 - f.s) * TAN_GS; // glide path height over the runway
        let above = f.y - a.elev;
        if (path > p.flare) {
          above = path;
        } else {
          // flare: sink dies away with height
          above -= f.v * TAN_GS * (0.2 + 0.8 * Math.max(above, 0) / p.flare) * dt;
          f.pitch = damp(f.pitch, 0.1, 1.4, dt);
          f.v -= 1.1 * dt;
        }
        f.y = a.elev + above;
        // decision height: an occupied runway means a go-around
        if (!f.checked && f.s > -900) {
          f.checked = true;
          if (this.runwayBusy(o, a, f, px, pz, pAgl)) {
            f.phase = 'climb';
            f.timer = 0;
            f.wentAround = true;
            this.stats.goArounds++;
            if (this.busyByPlayer) this.onPlayerBlock(a.fieldName);
          }
        }
        if (f.phase === 'final' && above <= 0.06) {
          f.y = a.elev;
          f.phase = 'rollout';
          this.stats.landings++;
        }
        return true;
      }
      case 'rollout':
        f.pitch = damp(f.pitch, 0, 1.3, dt);
        f.v = Math.max(p.vTaxi, f.v - p.decel * dt);
        f.s += f.v * dt;
        if (f.v <= p.vTaxi + 0.01 || f.s > a.length - 200) f.phase = 'vacate';
        return true;
      case 'vacate':
        f.v = Math.max(p.vTaxi, f.v - p.decel * dt);
        f.turn = Math.min(Math.PI / 2, f.turn + 0.3 * dt);
        f.s += f.v * Math.cos(f.turn) * dt;
        f.off += f.v * Math.sin(f.turn) * dt;
        if (f.off > p.stub) {
          f.fade -= dt / 2.5;
          if (f.fade <= 0) return false;
        }
        return true;
      case 'enter':
        if (f.fade < 1) {
          f.fade = Math.min(1, f.fade + dt / 2.5);
          return true;
        }
        // give way to the player: nobody taxis onto a runway into someone
        if (pAgl < 25 && Math.hypot(f.group.position.x - px, f.group.position.z - pz) < 90) return true;
        f.v = p.vTaxi * 0.8;
        if (f.off < f.v / 0.3 + 1.5) f.turn = Math.min(0, f.turn + 0.3 * dt);
        f.s += f.v * Math.cos(f.turn) * dt;
        f.off += f.v * Math.sin(f.turn) * dt;
        if (f.turn >= 0) {
          f.phase = 'hold';
          f.v = 0;
          f.timer = 5;
        }
        return true;
      case 'hold':
        f.timer -= dt;
        f.off = damp(f.off, 0, 2, dt);
        if (f.timer <= 0 && !this.runwayBusy(o, a, f, px, pz, pAgl)) f.phase = 'roll';
        return true;
      case 'roll':
        f.off = damp(f.off, 0, 2, dt);
        f.v += p.accel * dt;
        f.s += f.v * dt;
        if (f.v >= p.vRot) f.pitch = Math.min(0.2, f.pitch + 0.055 * dt);
        if (f.pitch > 0.11) {
          f.phase = 'climb';
          f.timer = 0;
          this.stats.departures++;
        }
        return true;
      case 'climb': {
        f.timer += dt;
        f.v += clamp(p.vClimb - f.v, -0.5, 1.1) * dt;
        f.s += f.v * dt;
        const top = a.elev + p.top;
        const vy = p.climb * Math.min(1, f.timer / 3.5) * clamp((top - f.y) / 120, 0, 1);
        f.y += vy * dt;
        f.pitch = damp(f.pitch, 0.03 + (vy / p.climb) * 0.15, 0.8, dt);
        const g = f.group.position;
        return Math.hypot(g.x - px, g.z - pz) < 30000 && f.s < 60000;
      }
    }
    return false;
  }

  /* ------------------------------------------------ ships ---- */

  private updateShips(dt: number, px: number, pz: number): void {
    // fill the sea around the player, one candidate spot at a time
    if (this.ships.length < Traffic.SHIPS && --this.shipTry <= 0) {
      this.shipTry = 20;
      const ang = this.rng() * Math.PI * 2;
      const R = 3500 + this.rng() * 9500;
      const x = px + Math.sin(ang) * R;
      const z = pz - Math.cos(ang) * R;
      const hdg = this.rng() * Math.PI * 2;
      // two of each: the kinds take turns at the candidate spots, so the
      // big ships (which need a long clear run) are not crowded out by
      // boats that fit anywhere
      let kind: ShipKind = 'boat';
      for (let k = 0; k < 3; k++) {
        kind = (['cargo', 'ferry', 'boat'] as const)[this.shipTurn++ % 3];
        let n = 0;
        for (const sh of this.ships) if (sh.kind === kind) n++;
        if (n < 2) break;
      }
      const ahead = SHIP[kind].ahead;
      if (this.gen.heightAt(x, z) < WATER_LEVEL - 14 &&
          this.gen.heightAt(x + Math.sin(hdg) * ahead, z - Math.cos(hdg) * ahead) < WATER_LEVEL - 10) {
        const group = new THREE.Group();
        group.add(new THREE.Mesh(shipGeo(kind), this.mat));
        const [len, w0, w1] = SHIP[kind].wake;
        let wakeGeo = this.wakeGeos.get(kind);
        if (!wakeGeo) this.wakeGeos.set(kind, wakeGeo = trailGeo(len, w0, w1, 0.42, false));
        const wake = new THREE.Mesh(wakeGeo, this.trailMat);
        wake.position.set(0, 0.35, kind === 'boat' ? 6 : len * 0.12);
        group.add(wake);
        group.position.set(x, WATER_LEVEL + 0.2, z);
        this.scene.add(group);
        this.ships.push({ group, kind, hdg, turn: 0, turnT: 0, checkT: this.rng() * 2 });
      }
    }
    for (let i = this.ships.length - 1; i >= 0; i--) {
      const s = this.ships[i];
      const g = s.group.position;
      const sp = SHIP[s.kind];
      if (s.turnT > 0) {
        s.turnT -= dt;
        s.hdg += s.turn * dt;
      }
      g.x += Math.sin(s.hdg) * sp.spd * dt;
      g.z -= Math.cos(s.hdg) * sp.spd * dt;
      s.group.rotation.y = -s.hdg;
      s.checkT -= dt;
      if (s.checkT <= 0) {
        s.checkT = 2;
        const depth = (h: number, d: number): number =>
          this.gen.heightAt(g.x + Math.sin(h) * d, g.z - Math.cos(h) * d);
        if (s.turnT <= 0 && (depth(s.hdg, sp.ahead) > WATER_LEVEL - 9 || depth(s.hdg, sp.ahead * 0.4) > WATER_LEVEL - 9)) {
          // shoaling ahead: come round toward the deeper side
          const left = depth(s.hdg - 0.9, sp.ahead);
          const right = depth(s.hdg + 0.9, sp.ahead);
          s.turn = (left < right ? -1 : 1) * (s.kind === 'boat' ? 0.16 : 0.07);
          s.turnT = 7;
        }
        // aground (boxed in), or left behind: give the slot back
        if (this.gen.heightAt(g.x, g.z) > WATER_LEVEL - 4 || Math.hypot(g.x - px, g.z - pz) > 17000) {
          this.scene.remove(s.group);
          this.ships.splice(i, 1);
        }
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
    // two of the airliners are overflights in the flight levels
    const high = slot === 0 || slot === 3;
    const group = this.mkNpcModel(kind, slot, false);
    const glow = new THREE.SphereGeometry(kind === 'airliner' ? 0.5 : 0.3, 6, 5);
    const beacon = new THREE.Mesh(glow, this.redMat);
    beacon.position.set(0, kind === 'airliner' ? 5.2 : 2.6, 2);
    const strobe = new THREE.Mesh(glow, this.whiteMat);
    strobe.position.set(0, kind === 'airliner' ? 4.5 : 2.4, kind === 'airliner' ? 18 : 4);
    group.add(beacon, strobe);
    if (high) {
      // contrail: 11 km of ice behind the engines, thinning to nothing
      this.contrailGeo ??= trailGeo(11000, 16, 110, 0.8, true);
      const trail = new THREE.Mesh(this.contrailGeo, this.trailMat);
      trail.position.set(0, 2.2, 14);
      group.add(trail);
    }
    this.scene.add(group);
    const f: FlyingNpc = {
      group, kind, high, hdg: 0, spd: 0, targetY: 0,
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
    f.spd = f.high ? 215 + this.rng() * 30 : f.kind === 'airliner' ? 115 + this.rng() * 40 : 42 + this.rng() * 14;
    const ground = Math.max(this.gen.heightAt(x, z), 0);
    f.targetY = f.high
      ? 9400 + this.rng() * 2400
      : ground + (f.kind === 'airliner' ? 900 + this.rng() * 1400 : 350 + this.rng() * 500);
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

  private buildParked(ap: AirfieldDef, key: string, growIn = false): void {
    const g = new THREE.Group();
    const movers: Array<{ m: THREE.Object3D; along: number; side: number; dir: number }> = [];
    const solids: Array<{ m: THREE.Object3D; shape: readonly Box[]; reason: string }> = [];
    const seed = (a: number, b: number) => hash2(Math.round(ap.x) + a, Math.round(ap.z) + b);

    // place one NPC in the field's local (heading-0) frame; the group pivot
    // below rotates the whole set to the true field heading
    const put = (kind: NpcKind, livery: number, along: number, across: number, yaw: number): void => {
      const m = this.mkNpcModel(kind, livery, true);
      m.position.set(ap.x + across, ap.elev, ap.z - along);
      m.rotation.y = yaw;
      g.add(m);
      solids.push({ m, shape: kind === 'airliner' ? SOLID_AIRLINER : SOLID_GA, reason: HIT_PARKED });
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
      // ground crew: static tugs/bowsers/cart-trains at the pier roots +
      // vehicles doing slow laps of both apron service lanes
      for (const [i, pc] of [-1020, 30, 1080].entries()) {
        if (seed(i * 3 + 1, 8) > 0.35) {
          const tug = new THREE.Mesh(vehicleGeo('tug'), this.mat);
          tug.castShadow = true;
          tug.position.set(ap.x + (seed(i, 2) > 0.5 ? 70 : -70), ap.elev, ap.z - pc - 60);
          tug.rotation.y = seed(i, 4) * Math.PI * 2;
          g.add(tug);
          solids.push({ m: tug, shape: SOLID_VEHICLE.tug, reason: HIT_VEHICLE });
        }
        if (seed(i * 5 + 2, 6) > 0.55) {
          const fuel = new THREE.Mesh(vehicleGeo('fuel'), this.mat);
          fuel.castShadow = true;
          fuel.position.set(ap.x + (seed(i, 9) > 0.5 ? 380 : -380), ap.elev, ap.z - pc + 90);
          fuel.rotation.y = Math.PI / 2;
          g.add(fuel);
          solids.push({ m: fuel, shape: SOLID_VEHICLE.fuel, reason: HIT_VEHICLE });
        }
        if (seed(i * 7 + 4, 3) > 0.3) {
          const carts = new THREE.Mesh(vehicleGeo('carts'), this.mat);
          carts.castShadow = true;
          carts.position.set(ap.x + (seed(i, 11) > 0.5 ? 95 : -95), ap.elev, ap.z - pc + 40);
          carts.rotation.y = seed(i, 13) > 0.5 ? 0 : Math.PI / 2;
          g.add(carts);
          solids.push({ m: carts, shape: SOLID_VEHICLE.carts, reason: HIT_VEHICLE });
        }
      }
      const lapKinds: VehicleKind[] = ['tug', 'fuel', 'bus', 'bus'];
      for (const [i, kind] of lapKinds.entries()) {
        const side = i % 2 === 0 ? -1 : 1;
        const m = new THREE.Mesh(vehicleGeo(kind), this.mat);
        m.castShadow = true;
        g.add(m);
        solids.push({ m, shape: SOLID_VEHICLE[kind], reason: HIT_VEHICLE });
        movers.push({ m, along: (seed(3 + i, side) - 0.5) * 2400, side, dir: i < 2 ? side : -side });
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
    if (growIn) {
      root.scale.y = 0.001;
      root.position.y = ap.elev * 0.999;
    }
    this.parked.set(key, { group: root, grow: growIn ? 0 : 1, movers, solids, def: ap, ops: null });
  }
}

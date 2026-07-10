/**
 * Procedural aircraft. Every plane is lofted from primitives at runtime —
 * no model files. Naming conventions drive animation in aircraft.ts:
 *   prop*      — spinner groups, rotate around Z with RPM
 *   aileronL/R, elevator, rudder — control-surface hinge groups
 *   gear       — landing gear group (retract animation)
 *   burner     — afterburner flame (visible at full throttle)
 *   propDisc   — translucent blur disc faded in at speed
 * Forward is -Z, CG at the group origin.
 */
import * as THREE from 'three';

// chunky low-poly airfoil profile: (chord fraction, thickness fraction)
const PROF: Array<[number, number]> = [
  [-0.5, 0], [-0.25, 0.5], [0.15, 0.42], [0.55, 0.02], [0.15, -0.32], [-0.25, -0.4],
];

interface WingSection {
  x: number;      // span position
  chord: number;  // m
  t: number;      // thickness, m
  sweep?: number; // +z shift (backwards)
  rise?: number;  // +y shift (dihedral)
}

function wingGeo(sections: WingSection[]): THREE.BufferGeometry {
  const P = PROF.length;
  const verts: number[] = [];
  for (const s of sections) {
    for (const [cz, ty] of PROF) {
      verts.push(s.x, ty * s.t + (s.rise ?? 0), cz * s.chord + (s.sweep ?? 0));
    }
  }
  const idx: number[] = [];
  for (let s = 0; s < sections.length - 1; s++) {
    for (let k = 0; k < P; k++) {
      const a = s * P + k;
      const b = s * P + ((k + 1) % P);
      const c = (s + 1) * P + k;
      const d = (s + 1) * P + ((k + 1) % P);
      idx.push(a, c, b, b, c, d);
    }
  }
  // end caps (fans)
  const last = (sections.length - 1) * P;
  for (let k = 1; k < P - 1; k++) {
    idx.push(0, k, k + 1);
    idx.push(last, last + k + 1, last + k);
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(idx);
  const flat = g.toNonIndexed();
  flat.computeVertexNormals();
  g.dispose();
  return flat;
}

interface FuseStation { z: number; r: number; ry?: number; y?: number }

function fuseGeo(stations: FuseStation[], segs = 12): THREE.BufferGeometry {
  const verts: number[] = [];
  for (const st of stations) {
    for (let i = 0; i < segs; i++) {
      const a = (i / segs) * Math.PI * 2;
      verts.push(Math.cos(a) * st.r, Math.sin(a) * (st.ry ?? st.r) + (st.y ?? 0), st.z);
    }
  }
  const idx: number[] = [];
  for (let s = 0; s < stations.length - 1; s++) {
    for (let i = 0; i < segs; i++) {
      const a = s * segs + i;
      const b = s * segs + ((i + 1) % segs);
      const c = (s + 1) * segs + i;
      const d = (s + 1) * segs + ((i + 1) % segs);
      idx.push(a, b, c, b, d, c);
    }
  }
  // nose & tail caps — wound so the faces point OUT (nose -z, tail +z);
  // rings go CCW seen from +z, so the tail fan keeps ring order and the
  // nose fan reverses it
  const g0 = stations[0];
  const gn = stations[stations.length - 1];
  const base = verts.length / 3;
  verts.push(0, g0.y ?? 0, g0.z, 0, gn.y ?? 0, gn.z);
  const lastRing = (stations.length - 1) * segs;
  for (let i = 0; i < segs; i++) {
    idx.push(base, (i + 1) % segs, i);
    idx.push(base + 1, lastRing + i, lastRing + ((i + 1) % segs));
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

const matCache = new Map<string, THREE.MeshStandardMaterial>();
function std(color: number, rough = 0.5, metal = 0.15, double = false): THREE.MeshStandardMaterial {
  const key = `${color}|${rough}|${metal}|${double}`;
  let m = matCache.get(key);
  if (!m) {
    m = new THREE.MeshStandardMaterial({
      color, roughness: rough, metalness: metal,
      side: double ? THREE.DoubleSide : THREE.FrontSide,
    });
    matCache.set(key, m);
  }
  return m;
}

const GLASS = new THREE.MeshStandardMaterial({ color: 0x16242f, roughness: 0.08, metalness: 0.9 });

function mesh(geo: THREE.BufferGeometry, material: THREE.Material): THREE.Mesh {
  const m = new THREE.Mesh(geo, material);
  m.castShadow = true;
  m.receiveShadow = false;
  return m;
}

function navLights(group: THREE.Group, span: number, z: number, y: number): void {
  const geo = new THREE.SphereGeometry(0.09, 6, 4);
  const red = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0xff2020 }));
  red.position.set(-span, y, z);
  const green = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: 0x20ff40 }));
  green.position.set(span, y, z);
  group.add(red, green);
}

function propeller(blades: number, radius: number, spinnerR: number, color = 0x1c1c1f): THREE.Group {
  const prop = new THREE.Group();
  prop.name = 'prop';
  const spinner = mesh(new THREE.ConeGeometry(spinnerR, spinnerR * 2.4, 10), std(0xd8d8de, 0.3, 0.7));
  spinner.rotation.x = -Math.PI / 2;
  spinner.position.z = -spinnerR * 1.1;
  prop.add(spinner);
  const bladeGeo = new THREE.BoxGeometry(0.16, radius, 0.05);
  for (let i = 0; i < blades; i++) {
    const b = mesh(bladeGeo, std(color, 0.6, 0.2));
    const holder = new THREE.Group();
    b.position.y = radius / 2;
    b.rotation.y = 0.32; // blade pitch
    holder.add(b);
    holder.rotation.z = (i / blades) * Math.PI * 2;
    prop.add(holder);
  }
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(radius, 24),
    new THREE.MeshBasicMaterial({ color: 0x999999, transparent: true, opacity: 0, depthWrite: false }),
  );
  disc.name = 'propDisc';
  prop.add(disc);
  return prop;
}

function wheel(r: number, w: number): THREE.Mesh {
  const m = mesh(new THREE.CylinderGeometry(r, r, w, 10), std(0x141416, 0.9, 0));
  m.rotation.z = Math.PI / 2;
  return m;
}

function strut(x1: number, y1: number, z1: number, x2: number, y2: number, z2: number, r = 0.05, color = 0x9aa0a6): THREE.Mesh {
  const a = new THREE.Vector3(x1, y1, z1);
  const b = new THREE.Vector3(x2, y2, z2);
  const len = a.distanceTo(b);
  const m = mesh(new THREE.CylinderGeometry(r, r, len, 6), std(color, 0.5, 0.4));
  m.position.copy(a).add(b).multiplyScalar(0.5);
  m.lookAt(b);
  m.rotateX(Math.PI / 2);
  return m;
}

function hinged(name: string, surface: THREE.Mesh, hx: number, hy: number, hz: number): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  g.position.set(hx, hy, hz);
  g.add(surface);
  return g;
}

/* ================================================================
   SKYLARK ST-2 — high-wing club trainer, cream & rally red
   ================================================================ */
function buildSkylark(): THREE.Group {
  const g = new THREE.Group();
  const cream = std(0xf2efe6, 0.45, 0.05);
  const red = std(0xc8362e, 0.4, 0.1);

  const fuse = mesh(fuseGeo([
    { z: -3.6, r: 0.18, ry: 0.18, y: -0.1 },
    { z: -3.1, r: 0.52, ry: 0.55, y: -0.05 },
    { z: -2.2, r: 0.68, ry: 0.78, y: 0.05 },
    { z: -0.6, r: 0.72, ry: 0.85, y: 0.1 },
    { z: 0.8, r: 0.58, ry: 0.68, y: 0.12 },
    { z: 2.4, r: 0.3, ry: 0.4, y: 0.2 },
    { z: 3.7, r: 0.12, ry: 0.3, y: 0.32 },
  ]), cream);
  g.add(fuse);

  // canopy/glasshouse
  const cab = mesh(new THREE.SphereGeometry(0.72, 10, 8), GLASS);
  cab.scale.set(0.85, 0.62, 1.25);
  cab.position.set(0, 0.62, -1.15);
  g.add(cab);

  // high wing on top
  const wing = mesh(wingGeo([
    { x: -5.3, chord: 1.15, t: 0.13, rise: 0.22, sweep: 0.1 },
    { x: -1.1, chord: 1.5, t: 0.2 },
    { x: 1.1, chord: 1.5, t: 0.2 },
    { x: 5.3, chord: 1.15, t: 0.13, rise: 0.22, sweep: 0.1 },
  ]), std(0xf2efe6, 0.45, 0.05, true));
  wing.position.set(0, 1.06, -0.7);
  g.add(wing);
  // red wingtips
  for (const sx of [-1, 1]) {
    const tip = mesh(new THREE.BoxGeometry(0.5, 0.14, 1.1), red);
    tip.position.set(5.25 * sx, 1.28, -0.62);
    g.add(tip);
  }
  // wing struts
  g.add(strut(0.62, -0.15, -0.6, 3.1, 1.02, -0.7));
  g.add(strut(-0.62, -0.15, -0.6, -3.1, 1.02, -0.7));

  // ailerons
  for (const sx of [-1, 1]) {
    const surf = mesh(new THREE.BoxGeometry(2, 0.07, 0.42), red);
    surf.position.set(0, 0, 0.21);
    g.add(hinged(sx < 0 ? 'aileronL' : 'aileronR', surf, 3.6 * sx, 1.04, 0.06));
  }

  // tail
  const hstab = mesh(wingGeo([
    { x: -1.85, chord: 0.7, t: 0.08, sweep: 0.18 },
    { x: 0, chord: 1, t: 0.1 },
    { x: 1.85, chord: 0.7, t: 0.08, sweep: 0.18 },
  ]), std(0xf2efe6, 0.45, 0.05, true));
  hstab.position.set(0, 0.38, 3.2);
  g.add(hstab);
  const elevSurf = mesh(new THREE.BoxGeometry(3.5, 0.06, 0.42), red);
  elevSurf.position.set(0, 0, 0.21);
  g.add(hinged('elevator', elevSurf, 0, 0.38, 3.72));

  const finGeo = wingGeo([
    { x: 0, chord: 1.25, t: 0.09 },
    { x: 1.55, chord: 0.62, t: 0.06, sweep: 0.52 },
  ]);
  finGeo.rotateZ(Math.PI / 2);
  const fin = mesh(finGeo, std(0xc8362e, 0.4, 0.1, true));
  fin.position.set(0, 0.55, 3.25);
  g.add(fin);
  const rudSurf = mesh(new THREE.BoxGeometry(0.06, 1.3, 0.4), cream);
  rudSurf.position.set(0, 0.55, 0.2);
  g.add(hinged('rudder', rudSurf, 0, 1.1, 3.85));

  // fixed tricycle gear with wheel pants
  const gear = new THREE.Group();
  gear.name = 'gear';
  const noseW = wheel(0.26, 0.16);
  noseW.position.set(0, -1.28, -2.6);
  gear.add(noseW, strut(0, -0.5, -2.55, 0, -1.25, -2.6, 0.06));
  for (const sx of [-1, 1]) {
    const w = wheel(0.3, 0.18);
    w.position.set(1.25 * sx, -1.25, -0.2);
    const pant = mesh(new THREE.SphereGeometry(0.34, 8, 6), red);
    pant.scale.set(0.5, 0.75, 1.3);
    pant.position.set(1.25 * sx, -1.18, -0.2);
    gear.add(w, pant, strut(0.45 * sx, -0.55, -0.25, 1.22 * sx, -1.2, -0.2, 0.055));
  }
  g.add(gear);

  g.add(propeller(2, 0.95, 0.22));
  g.children[g.children.length - 1].position.set(0, -0.02, -3.72);
  navLights(g, 5.45, -0.62, 1.18);
  return g;
}

/** Two-blade teetering rotor (helicopter). Blades along local Y spin about
 *  local Z — orient the GROUP so that axis points where the rotor needs it
 *  (rotation.x = -π/2 for a main rotor, rotation.y = π/2 for a tail rotor);
 *  aircraft.ts animates rotation.z exactly like a propeller. */
function heliRotor(radius: number, chord: number, name = 'prop'): THREE.Group {
  const g = new THREE.Group();
  g.name = name;
  const hub = mesh(new THREE.CylinderGeometry(radius * 0.035 + 0.06, radius * 0.035 + 0.06, 0.2, 8), std(0x35383c, 0.5, 0.6));
  hub.rotation.x = Math.PI / 2;
  g.add(hub);
  const thick = radius * 0.012 + 0.02;
  const bladeGeo = new THREE.BoxGeometry(chord, radius, thick);
  const tipGeo = new THREE.BoxGeometry(chord * 1.04, radius * 0.14, thick + 0.004);
  for (let i = 0; i < 2; i++) {
    const holder = new THREE.Group();
    const b = mesh(bladeGeo, std(0x2b2e33, 0.6, 0.25));
    b.position.y = radius / 2 + 0.08;
    b.rotation.y = 0.09;
    holder.add(b);
    const tip = mesh(tipGeo, std(0xd23b2f, 0.5, 0.2));
    tip.position.y = radius + 0.08 - radius * 0.07;
    tip.rotation.y = 0.09;
    holder.add(tip);
    holder.rotation.z = i * Math.PI;
    g.add(holder);
  }
  const disc = new THREE.Mesh(
    new THREE.CircleGeometry(radius + 0.08, 28),
    new THREE.MeshBasicMaterial({ color: 0x999999, transparent: true, opacity: 0, depthWrite: false, side: THREE.DoubleSide }),
  );
  disc.name = 'propDisc';
  g.add(disc);
  return g;
}

/* ================================================================
   FALCON Mk.IV — polished-aluminium warbird, yellow nose
   ================================================================ */
function buildFalcon(): THREE.Group {
  const g = new THREE.Group();
  const alu = std(0xb9bec7, 0.32, 0.75);
  const yellow = std(0xe8a818, 0.4, 0.3);
  const olive = std(0x4c5435, 0.6, 0.1);

  const fuse = mesh(fuseGeo([
    { z: -4.9, r: 0.4, ry: 0.4 },
    { z: -3.9, r: 0.62, ry: 0.66, y: -0.02 },
    { z: -2.2, r: 0.7, ry: 0.78, y: 0 },
    { z: -0.4, r: 0.66, ry: 0.8, y: 0.02 },
    { z: 1.6, r: 0.46, ry: 0.62, y: 0.12 },
    { z: 3.6, r: 0.26, ry: 0.42, y: 0.22 },
    { z: 4.9, r: 0.1, ry: 0.26, y: 0.3 },
  ]), alu);
  g.add(fuse);

  // yellow nose band + anti-glare olive strip
  const band = mesh(new THREE.CylinderGeometry(0.69, 0.66, 0.7, 12), yellow);
  band.rotation.x = Math.PI / 2;
  band.position.set(0, 0, -3.45);
  g.add(band);
  const glare = mesh(new THREE.BoxGeometry(0.5, 0.08, 2.6), olive);
  glare.position.set(0, 0.74, -2.2);
  g.add(glare);

  // bubble canopy
  const can = mesh(new THREE.SphereGeometry(0.58, 12, 8), GLASS);
  can.scale.set(0.78, 0.72, 1.5);
  can.position.set(0, 0.74, -0.35);
  g.add(can);

  // belly scoop
  const scoop = mesh(new THREE.BoxGeometry(0.55, 0.42, 1.8), alu);
  scoop.position.set(0, -0.72, 0.3);
  g.add(scoop);

  // exhaust stacks along the cowl
  const stackMat = std(0x2e2a26, 0.6, 0.7);
  for (const sx of [-1, 1]) {
    for (let i = 0; i < 3; i++) {
      const stack = mesh(new THREE.BoxGeometry(0.1, 0.12, 0.34), stackMat);
      stack.position.set(0.58 * sx, 0.28, -3.15 + i * 0.48);
      stack.rotation.x = 0.25;
      g.add(stack);
    }
  }

  // low tapered wing with dihedral
  const wing = mesh(wingGeo([
    { x: -5.6, chord: 1.1, t: 0.12, rise: 0.55, sweep: 0.5 },
    { x: -1.2, chord: 2.35, t: 0.34, rise: 0.05 },
    { x: 1.2, chord: 2.35, t: 0.34, rise: 0.05 },
    { x: 5.6, chord: 1.1, t: 0.12, rise: 0.55, sweep: 0.5 },
  ]), std(0xb9bec7, 0.32, 0.75, true));
  wing.position.set(0, -0.42, -0.3);
  g.add(wing);

  for (const sx of [-1, 1]) {
    const surf = mesh(new THREE.BoxGeometry(2.1, 0.07, 0.5), alu);
    surf.position.set(0, 0, 0.25);
    g.add(hinged(sx < 0 ? 'aileronL' : 'aileronR', surf, 3.9 * sx, -0.18, 0.95));
  }

  // tail
  const hstab = mesh(wingGeo([
    { x: -2.1, chord: 0.75, t: 0.08, sweep: 0.35 },
    { x: 0, chord: 1.2, t: 0.12 },
    { x: 2.1, chord: 0.75, t: 0.08, sweep: 0.35 },
  ]), std(0xb9bec7, 0.32, 0.75, true));
  hstab.position.set(0, 0.3, 4.15);
  g.add(hstab);
  const elevSurf = mesh(new THREE.BoxGeometry(3.9, 0.06, 0.5), alu);
  elevSurf.position.set(0, 0, 0.25);
  g.add(hinged('elevator', elevSurf, 0, 0.3, 4.75));

  const finGeo = wingGeo([
    { x: 0, chord: 1.5, t: 0.1 },
    { x: 1.85, chord: 0.7, t: 0.06, sweep: 0.75 },
  ]);
  finGeo.rotateZ(Math.PI / 2);
  const fin = mesh(finGeo, std(0xc8362e, 0.45, 0.2, true));
  fin.position.set(0, 0.5, 4.3);
  g.add(fin);
  const rudSurf = mesh(new THREE.BoxGeometry(0.06, 1.5, 0.45), std(0xc8362e, 0.45, 0.2));
  rudSurf.position.set(0, 0.6, 0.22);
  g.add(hinged('rudder', rudSurf, 0, 0.95, 5.0));

  // retractable tail-dragger gear
  const gear = new THREE.Group();
  gear.name = 'gear';
  for (const sx of [-1, 1]) {
    const w = wheel(0.42, 0.26);
    w.position.set(1.9 * sx, -1.7, -0.7);
    gear.add(w, strut(1.15 * sx, -0.5, -0.5, 1.88 * sx, -1.62, -0.68, 0.08));
  }
  const tw = wheel(0.2, 0.12);
  tw.position.set(0, -0.95, 4.4);
  gear.add(tw, strut(0, -0.4, 4.2, 0, -0.9, 4.38, 0.05));
  g.add(gear);

  const prop = propeller(4, 1.55, 0.4, 0x26262a);
  prop.position.set(0, 0, -5.05);
  g.add(prop);
  navLights(g, 5.7, -0.25, 0.22);
  return g;
}

/* ================================================================
   ISLANDER BN2T — slab-sided high-wing turbine twin, blue over white
   ================================================================ */
function buildIslander(): THREE.Group {
  const g = new THREE.Group();
  const white = std(0xf3f4f2, 0.4, 0.08);
  const blue = std(0x27459c, 0.4, 0.15);
  const winMat = std(0x131c26, 0.2, 0.7);

  // slab-sided cabin, raked nose, upswept rear
  const fuse = mesh(fuseGeo([
    { z: -5.3, r: 0.26, ry: 0.3, y: -0.28 },
    { z: -4.4, r: 0.62, ry: 0.72, y: -0.02 },
    { z: -3.3, r: 0.72, ry: 0.86, y: 0.05 },
    { z: -0.4, r: 0.72, ry: 0.86, y: 0.05 },
    { z: 2.2, r: 0.48, ry: 0.66, y: 0.24 },
    { z: 4.2, r: 0.22, ry: 0.4, y: 0.5 },
    { z: 5.3, r: 0.1, ry: 0.24, y: 0.62 },
  ]), white);
  g.add(fuse);

  // windshield + long cabin glazing + blue cheat swoosh
  const shield = mesh(new THREE.SphereGeometry(0.68, 10, 7), GLASS);
  shield.scale.set(0.95, 0.55, 0.85);
  shield.position.set(0, 0.58, -4.05);
  g.add(shield);
  const winStrip = mesh(new THREE.BoxGeometry(1.5, 0.3, 5.2), winMat);
  winStrip.position.set(0, 0.48, -1.5);
  g.add(winStrip);
  const cheat = mesh(new THREE.BoxGeometry(1.48, 0.12, 8.6), blue);
  cheat.position.set(0, 0.02, -0.7);
  g.add(cheat);

  // cantilever high wing — near-constant chord, the STOL secret
  const wing = mesh(wingGeo([
    { x: -7.45, chord: 1.9, t: 0.15, rise: 0.06 },
    { x: -1.0, chord: 2.03, t: 0.24 },
    { x: 1.0, chord: 2.03, t: 0.24 },
    { x: 7.45, chord: 1.9, t: 0.15, rise: 0.06 },
  ]), std(0x27459c, 0.4, 0.15, true)); // blue upper surface reads at any angle
  wing.position.set(0, 0.98, -1.3);
  g.add(wing);
  for (const sx of [-1, 1]) {
    const surf = mesh(new THREE.BoxGeometry(2.6, 0.07, 0.5), white);
    surf.position.set(0, 0, 0.25);
    g.add(hinged(sx < 0 ? 'aileronL' : 'aileronR', surf, 5.6 * sx, 0.96, -0.35));
  }

  // wing-slung turboprop nacelles
  for (const sx of [-1, 1]) {
    const nac = mesh(fuseGeo([
      { z: -1.5, r: 0.3 },
      { z: -0.8, r: 0.42 },
      { z: 0.6, r: 0.38 },
      { z: 1.5, r: 0.18 },
    ], 10), white);
    nac.position.set(2.55 * sx, 0.72, -1.4);
    g.add(nac);
    const exh = mesh(new THREE.CylinderGeometry(0.07, 0.09, 0.5, 6), std(0x4c4a45, 0.5, 0.7));
    exh.rotation.x = Math.PI / 2 - 0.25;
    exh.position.set(2.55 * sx + 0.28 * sx, 0.52, -0.5);
    g.add(exh);
    const prop = propeller(3, 0.98, 0.22);
    prop.position.set(2.55 * sx, 0.72, -3.0);
    g.add(prop);
  }

  // tall near-rectangular fin + fuselage-mounted tailplane
  const finGeo = wingGeo([
    { x: 0, chord: 1.6, t: 0.1 },
    { x: 1.95, chord: 1.05, t: 0.07, sweep: 0.55 },
  ]);
  finGeo.rotateZ(Math.PI / 2);
  const fin = mesh(finGeo, std(0x27459c, 0.4, 0.15, true));
  fin.position.set(0, 0.62, 4.55);
  g.add(fin);
  const rudSurf = mesh(new THREE.BoxGeometry(0.06, 1.8, 0.44), white);
  rudSurf.position.set(0, 0.8, 0.22);
  g.add(hinged('rudder', rudSurf, 0, 1.0, 5.3));

  const hstab = mesh(wingGeo([
    { x: -2.4, chord: 0.85, t: 0.08, sweep: 0.14 },
    { x: 0, chord: 1.1, t: 0.1 },
    { x: 2.4, chord: 0.85, t: 0.08, sweep: 0.14 },
  ]), std(0xf3f4f2, 0.4, 0.08, true));
  hstab.position.set(0, 0.62, 4.45);
  g.add(hstab);
  const elevSurf = mesh(new THREE.BoxGeometry(4.4, 0.06, 0.42), white);
  elevSurf.position.set(0, 0, 0.21);
  g.add(hinged('elevator', elevSurf, 0, 0.62, 5.05));

  // fixed gear: nose leg + main legs hung from the nacelles
  const gear = new THREE.Group();
  gear.name = 'gear';
  const nw = wheel(0.26, 0.16);
  nw.position.set(0, -1.02, -4.5);
  gear.add(nw, strut(0, -0.35, -4.4, 0, -0.98, -4.5, 0.06));
  for (const sx of [-1, 1]) {
    for (const dx of [-0.16, 0.16]) {
      const w = wheel(0.3, 0.15);
      w.position.set(2.55 * sx + dx, -1.0, 0.55);
      gear.add(w);
    }
    gear.add(strut(2.55 * sx, 0.45, 0.2, 2.55 * sx, -0.95, 0.55, 0.07));
  }
  g.add(gear);

  navLights(g, 7.55, -1.25, 1.1);
  return g;
}

/* ================================================================
   BELL 505 JET RANGER X — light turbine helicopter, oxide red
   ================================================================ */
function buildJetRanger(): THREE.Group {
  const g = new THREE.Group();
  const red = std(0x8e2026, 0.35, 0.3);
  const dark = std(0x26282c, 0.5, 0.4);

  // cabin pod flowing into the boom
  const body = mesh(fuseGeo([
    { z: -2.6, r: 0.16, ry: 0.24, y: -0.34 },
    { z: -1.9, r: 0.6, ry: 0.74, y: -0.06 },
    { z: -0.7, r: 0.78, ry: 0.92, y: 0.04 },
    { z: 0.7, r: 0.74, ry: 0.88, y: 0.08 },
    { z: 1.6, r: 0.44, ry: 0.52, y: 0.26 },
    { z: 2.4, r: 0.26, ry: 0.3, y: 0.34 },
  ]), red);
  g.add(body);

  // wraparound windscreen + cabin glazing
  const shield = mesh(new THREE.SphereGeometry(0.78, 12, 8), GLASS);
  shield.scale.set(0.88, 0.72, 0.95);
  shield.position.set(0, 0.3, -1.5);
  g.add(shield);
  const side = mesh(new THREE.BoxGeometry(1.62, 0.5, 1.5), std(0x131c26, 0.2, 0.7));
  side.position.set(0, 0.32, -0.35);
  g.add(side);

  // flat belly pan (the 505's signature flat floor)
  const pan = mesh(new THREE.BoxGeometry(1.35, 0.16, 2.6), dark);
  pan.position.set(0, -0.86, -0.5);
  g.add(pan);

  // engine cowl + intake + upturned exhaust
  const cowl = mesh(fuseGeo([
    { z: -0.7, r: 0.34 },
    { z: 0.2, r: 0.4 },
    { z: 1.3, r: 0.28 },
  ], 10), dark);
  cowl.position.set(0, 1.06, 0.9);
  g.add(cowl);
  const exhaust = mesh(new THREE.CylinderGeometry(0.14, 0.17, 0.5, 8), std(0x4c4a45, 0.5, 0.7));
  exhaust.rotation.x = Math.PI / 2 - 1.2;
  exhaust.position.set(0, 1.2, 2.05);
  g.add(exhaust);

  // tail boom, stabilizer with end plates, swept fin + skid
  const boom = mesh(fuseGeo([
    { z: 1.6, r: 0.3, ry: 0.34, y: 0.3 },
    { z: 3.4, r: 0.22, ry: 0.26, y: 0.38 },
    { z: 5.2, r: 0.16, ry: 0.18, y: 0.46 },
    { z: 6.9, r: 0.12, ry: 0.14, y: 0.52 },
  ], 10), red);
  g.add(boom);
  const hstab = mesh(new THREE.BoxGeometry(2.16, 0.06, 0.56), dark);
  hstab.position.set(0, 0.62, 4.4);
  g.add(hstab);
  for (const sx of [-1, 1]) {
    const plate = mesh(new THREE.BoxGeometry(0.05, 0.5, 0.6), dark);
    plate.position.set(1.08 * sx, 0.62, 4.4);
    g.add(plate);
  }
  const finGeo = wingGeo([
    { x: 0, chord: 0.95, t: 0.08 },
    { x: 1.45, chord: 0.55, t: 0.05, sweep: 0.55 },
  ]);
  finGeo.rotateZ(Math.PI / 2);
  const fin = mesh(finGeo, std(0x8e2026, 0.35, 0.3, true));
  fin.position.set(0, 0.55, 6.55);
  g.add(fin);
  const ventral = mesh(new THREE.BoxGeometry(0.06, 0.55, 0.5), dark);
  ventral.position.set(0, 0.2, 6.6);
  g.add(ventral);
  g.add(strut(0, -0.05, 6.5, 0, -0.35, 6.85, 0.03, 0x26282c)); // tail-rotor guard

  // rotor mast + two-blade teetering main rotor (flat via rotation.x)
  const mast = mesh(new THREE.CylinderGeometry(0.09, 0.11, 0.6, 8), dark);
  mast.position.set(0, 1.55, 0.1);
  g.add(mast);
  const rotor = heliRotor(5.6, 0.34);
  rotor.rotation.x = -Math.PI / 2;
  rotor.position.set(0, 1.88, 0.1);
  g.add(rotor);

  // two-blade tail rotor on the left of the fin (spins in the X plane)
  const tail = heliRotor(0.8, 0.14, 'tailrotor');
  tail.rotation.y = Math.PI / 2;
  tail.position.set(-0.3, 0.62, 6.7);
  g.add(tail);

  // skid gear: rails, upturned toes, twin cross arches
  const gear = new THREE.Group();
  gear.name = 'gear';
  const railGeo = new THREE.CylinderGeometry(0.05, 0.05, 3.1, 8);
  for (const sx of [-1, 1]) {
    const rail = mesh(railGeo, std(0x9aa0a6, 0.5, 0.4));
    rail.rotation.x = Math.PI / 2;
    rail.position.set(0.99 * sx, -1.27, -0.35);
    gear.add(rail);
    gear.add(strut(0.99 * sx, -1.26, -1.9, 0.99 * sx, -1.02, -2.35, 0.045));
    gear.add(strut(0.99 * sx, -1.25, -1.2, 0.42 * sx, -0.72, -1.15, 0.05));
    gear.add(strut(0.99 * sx, -1.25, 0.75, 0.42 * sx, -0.72, 0.8, 0.05));
  }
  g.add(gear);

  navLights(g, 1.05, -0.4, -0.2);
  return g;
}

/* ================================================================
   VECTOR V-25 — twin-tail delta multirole, storm grey
   ================================================================ */
function buildVector(): THREE.Group {
  const g = new THREE.Group();
  const grey = std(0x7d8694, 0.45, 0.35);
  const dark = std(0x4a525e, 0.5, 0.3);

  const fuse = mesh(fuseGeo([
    { z: -7.4, r: 0.16, ry: 0.16 },
    { z: -6.2, r: 0.5, ry: 0.46, y: -0.05 },
    { z: -4.4, r: 0.74, ry: 0.7, y: 0 },
    { z: -1.5, r: 0.95, ry: 0.82, y: 0 },
    { z: 2.5, r: 0.98, ry: 0.78, y: 0 },
    { z: 5.6, r: 0.62, ry: 0.55, y: 0 },
    { z: 7.2, r: 0.45, ry: 0.45, y: 0 },
  ]), grey);
  g.add(fuse);

  // cockpit canopy, faired into the spine
  const can = mesh(new THREE.SphereGeometry(0.66, 12, 8), GLASS);
  can.scale.set(0.72, 0.6, 1.85);
  can.position.set(0, 0.72, -4.2);
  g.add(can);

  // boxy intakes either side
  for (const sx of [-1, 1]) {
    const intake = mesh(new THREE.BoxGeometry(0.7, 0.85, 3.6), dark);
    intake.position.set(1.2 * sx, -0.2, -0.9);
    g.add(intake);
  }

  // big delta wing
  const wing = mesh(wingGeo([
    { x: -5.5, chord: 1.3, t: 0.08, sweep: 2.45 },
    { x: -1.4, chord: 5.6, t: 0.26, sweep: 0.6 },
    { x: 1.4, chord: 5.6, t: 0.26, sweep: 0.6 },
    { x: 5.5, chord: 1.3, t: 0.08, sweep: 2.45 },
  ]), std(0x7d8694, 0.45, 0.35, true));
  wing.position.set(0, -0.15, 1.2);
  g.add(wing);

  // elevons double as ailerons + elevator (named both ways: ailerons here,
  // separate small tailerons act as elevator)
  for (const sx of [-1, 1]) {
    const surf = mesh(new THREE.BoxGeometry(2.6, 0.07, 0.7), dark);
    surf.position.set(0, 0, 0.35);
    g.add(hinged(sx < 0 ? 'aileronL' : 'aileronR', surf, 3.4 * sx, -0.12, 4.0));
  }
  const elevSurf = mesh(new THREE.BoxGeometry(3.4, 0.08, 0.9), dark);
  elevSurf.position.set(0, 0, 0.45);
  g.add(hinged('elevator', elevSurf, 0, -0.1, 6.4));

  // twin canted fins
  for (const sx of [-1, 1]) {
    const finGeo = wingGeo([
      { x: 0, chord: 2.3, t: 0.08 },
      { x: 2.3, chord: 0.9, t: 0.05, sweep: 1.35 },
    ]);
    finGeo.rotateZ(Math.PI / 2);
    finGeo.rotateZ(sx * -0.32);
    const fin = mesh(finGeo, std(0x6b7280, 0.45, 0.35, true));
    fin.position.set(1.1 * sx, 0.55, 5.3);
    g.add(fin);
    if (sx > 0) {
      const rudSurf = mesh(new THREE.BoxGeometry(0.06, 1.6, 0.6), dark);
      rudSurf.position.set(0, 0.7, 0.3);
      g.add(hinged('rudder', rudSurf, 1.32, 0.6, 6.2));
    }
  }

  // exhaust + afterburner
  const nozzle = mesh(new THREE.CylinderGeometry(0.52, 0.42, 0.9, 12), std(0x2c2c30, 0.35, 0.9));
  nozzle.rotation.x = Math.PI / 2;
  nozzle.position.set(0, 0, 7.5);
  g.add(nozzle);
  // turbine face inside the pipe (no more hollow tail)
  const turbine = new THREE.Mesh(
    new THREE.CircleGeometry(0.4, 14),
    std(0x17191d, 0.4, 0.85),
  );
  turbine.position.set(0, 0, 7.88);
  g.add(turbine);
  // intake fan faces inside the boxy ducts (rotated to face forward)
  for (const sx of [-1, 1]) {
    const duct = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.78), std(0x17191d, 0.4, 0.85));
    duct.position.set(1.2 * sx, -0.2, -2.69);
    duct.rotation.y = Math.PI;
    g.add(duct);
  }
  const burner = new THREE.Mesh(
    new THREE.ConeGeometry(0.4, 4.2, 10, 1, true),
    new THREE.MeshBasicMaterial({
      color: 0xff7a2a, transparent: true, opacity: 0.85,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    }),
  );
  burner.name = 'burner';
  burner.rotation.x = -Math.PI / 2;
  burner.position.set(0, 0, 9.6);
  burner.visible = false;
  g.add(burner);

  // tricycle gear
  const gear = new THREE.Group();
  gear.name = 'gear';
  const nw = wheel(0.32, 0.2);
  nw.position.set(0, -1.95, -4.6);
  gear.add(nw, strut(0, -0.6, -4.5, 0, -1.9, -4.6, 0.09));
  for (const sx of [-1, 1]) {
    const w = wheel(0.42, 0.3);
    w.position.set(1.7 * sx, -1.9, 1.6);
    gear.add(w, strut(1.3 * sx, -0.55, 1.4, 1.68 * sx, -1.82, 1.58, 0.1));
  }
  g.add(gear);

  navLights(g, 5.6, 3.4, -0.1);
  return g;
}

/* ================================================================
   MERIDIAN 700 — T-tail executive jet, gloss white over navy
   ================================================================ */
function buildMeridian(): THREE.Group {
  const g = new THREE.Group();
  const white = std(0xf4f6f8, 0.25, 0.1);
  const navy = std(0x1f3a64, 0.35, 0.2);

  const fuse = mesh(fuseGeo([
    { z: -9.6, r: 0.3, ry: 0.3, y: -0.15 },
    { z: -8.4, r: 0.85, ry: 0.85, y: 0 },
    { z: -6.5, r: 1.12, ry: 1.12, y: 0.05 },
    { z: -2, r: 1.18, ry: 1.18, y: 0.05 },
    { z: 3.5, r: 1.12, ry: 1.12, y: 0.05 },
    { z: 7, r: 0.72, ry: 0.8, y: 0.32 },
    { z: 9.8, r: 0.3, ry: 0.4, y: 0.7 },
  ], 14), white);
  g.add(fuse);

  // navy belly + cheat line
  const belly = mesh(new THREE.BoxGeometry(2.05, 0.5, 13.5), navy);
  belly.position.set(0, -0.78, -1);
  g.add(belly);
  const cheat = mesh(new THREE.BoxGeometry(2.32, 0.12, 12), navy);
  cheat.position.set(0, 0.42, -1.2);
  g.add(cheat);

  // cockpit windows
  const windshield = mesh(new THREE.SphereGeometry(0.9, 10, 6), GLASS);
  windshield.scale.set(1.05, 0.5, 1.0);
  windshield.position.set(0, 0.66, -7.5);
  g.add(windshield);
  // cabin window strip
  const winStrip = mesh(new THREE.BoxGeometry(2.38, 0.22, 8.5), std(0x10161f, 0.2, 0.7));
  winStrip.position.set(0, 0.72, -1.4);
  g.add(winStrip);

  // low swept wing
  const wing = mesh(wingGeo([
    { x: -9.6, chord: 1.3, t: 0.13, sweep: 2.7, rise: 0.95 },
    { x: -2, chord: 3.3, t: 0.42, sweep: 0.3, rise: 0.1 },
    { x: 2, chord: 3.3, t: 0.42, sweep: 0.3, rise: 0.1 },
    { x: 9.6, chord: 1.3, t: 0.13, sweep: 2.7, rise: 0.95 },
  ]), std(0xf4f6f8, 0.25, 0.1, true));
  wing.position.set(0, -0.85, 0.4);
  g.add(wing);
  // winglets
  for (const sx of [-1, 1]) {
    const wlGeo = wingGeo([
      { x: 0, chord: 1.1, t: 0.06 },
      { x: 1.25, chord: 0.55, t: 0.04, sweep: 0.55 },
    ]);
    wlGeo.rotateZ(Math.PI / 2);
    const wl = mesh(wlGeo, std(0x1f3a64, 0.35, 0.2, true));
    wl.position.set(9.55 * sx, 0.12, 3.2);
    g.add(wl);
  }

  for (const sx of [-1, 1]) {
    const surf = mesh(new THREE.BoxGeometry(3.4, 0.08, 0.62), white);
    surf.position.set(0, 0, 0.31);
    g.add(hinged(sx < 0 ? 'aileronL' : 'aileronR', surf, 6.4 * sx, -0.32, 2.8));
  }

  // aft engine pods, with visible fan and exhaust internals
  const fanMat = std(0x1b1e24, 0.35, 0.85);
  const exhaustMat = std(0x3a3530, 0.45, 0.9);
  for (const sx of [-1, 1]) {
    const pod = mesh(fuseGeo([
      { z: -1.5, r: 0.52 },
      { z: -0.9, r: 0.66 },
      { z: 0.9, r: 0.62 },
      { z: 1.6, r: 0.42 },
    ], 12), std(0xd5d9de, 0.3, 0.6));
    pod.position.set(1.95 * sx, 0.45, 5.6);
    g.add(pod);
    const pylon = mesh(new THREE.BoxGeometry(0.85, 0.5, 1.6), white);
    pylon.position.set(1.45 * sx, 0.45, 5.5);
    g.add(pylon);

    // intake lip ring + fan face
    const lip = mesh(new THREE.TorusGeometry(0.5, 0.07, 8, 18), std(0xb8bdc4, 0.3, 0.8));
    lip.position.set(1.95 * sx, 0.45, 4.12);
    g.add(lip);
    const fan = new THREE.Mesh(new THREE.CircleGeometry(0.46, 18), fanMat);
    fan.position.set(1.95 * sx, 0.45, 4.14);
    fan.rotation.y = Math.PI; // face forward
    g.add(fan);
    // exhaust cone + hot nozzle disc
    const cone = mesh(new THREE.ConeGeometry(0.2, 0.7, 10), exhaustMat);
    cone.rotation.x = -Math.PI / 2;
    cone.position.set(1.95 * sx, 0.45, 7.0);
    g.add(cone);
    const nozzle = new THREE.Mesh(new THREE.CircleGeometry(0.4, 14), fanMat);
    nozzle.position.set(1.95 * sx, 0.45, 7.21);
    g.add(nozzle);
  }

  // T-tail
  const finGeo = wingGeo([
    { x: 0, chord: 2.6, t: 0.16 },
    { x: 3.3, chord: 1.3, t: 0.1, sweep: 1.9 },
  ]);
  finGeo.rotateZ(Math.PI / 2);
  const fin = mesh(finGeo, std(0x1f3a64, 0.35, 0.2, true));
  fin.position.set(0, 0.8, 7.6);
  g.add(fin);
  const rudSurf = mesh(new THREE.BoxGeometry(0.08, 2.6, 0.7), std(0xc8362e, 0.4, 0.15));
  rudSurf.position.set(0, 1.3, 0.35);
  g.add(hinged('rudder', rudSurf, 0, 1.2, 9.0));

  const hstab = mesh(wingGeo([
    { x: -3.6, chord: 0.95, t: 0.09, sweep: 1.15 },
    { x: 0, chord: 1.7, t: 0.13 },
    { x: 3.6, chord: 0.95, t: 0.09, sweep: 1.15 },
  ]), std(0xf4f6f8, 0.25, 0.1, true));
  hstab.position.set(0, 4.05, 9.0);
  g.add(hstab);
  const elevSurf = mesh(new THREE.BoxGeometry(6.6, 0.07, 0.55), white);
  elevSurf.position.set(0, 0, 0.27);
  g.add(hinged('elevator', elevSurf, 0, 4.05, 9.75));

  // tricycle gear
  const gear = new THREE.Group();
  gear.name = 'gear';
  const nw = wheel(0.4, 0.26);
  nw.position.set(0, -2.2, -6.8);
  gear.add(nw, strut(0, -0.8, -6.7, 0, -2.15, -6.8, 0.11));
  for (const sx of [-1, 1]) {
    for (const dz of [-0.45, 0.45]) {
      const w = wheel(0.5, 0.34);
      w.position.set(2.3 * sx, -2.1, 1.3 + dz);
      gear.add(w);
    }
    gear.add(strut(1.7 * sx, -0.9, 1.2, 2.28 * sx, -2.0, 1.3, 0.13));
  }
  g.add(gear);

  navLights(g, 9.7, 3.1, -0.7);

  // regional-jet proportions: meaningfully bigger than the fighter
  g.scale.setScalar(1.45);
  return g;
}

/* ================================================================
   EUROFIGHTER TYPHOON — canard delta, RAF air-superiority grey
   True scale: 15.96 m long, 10.95 m span. The canards are the live
   pitch surface (hinged group named 'elevator', like the real jet).
   ================================================================ */
function buildTyphoon(): THREE.Group {
  const g = new THREE.Group();
  const grey = std(0x8b939c, 0.5, 0.3);
  const dark = std(0x565d66, 0.5, 0.3);

  // slim forebody widening into a broad twin-engine deck: the aft end
  // stays wide enough that both EJ200 nozzles emerge flush from the hull
  const fuse = mesh(fuseGeo([
    { z: -7.9, r: 0.13, ry: 0.13 },
    { z: -6.7, r: 0.4, ry: 0.44, y: 0.02 },
    { z: -4.9, r: 0.58, ry: 0.66, y: 0.06 },
    { z: -2.4, r: 0.8, ry: 0.72, y: 0 },
    { z: 1.6, r: 1.0, ry: 0.74, y: 0 },
    { z: 5.4, r: 1.08, ry: 0.64, y: 0 },
    { z: 7.9, r: 1.02, ry: 0.5, y: 0 },
  ]), grey);
  g.add(fuse);

  // bubble canopy well forward + the boxy chin intake with splitter lip
  const can = mesh(new THREE.SphereGeometry(0.62, 12, 8), GLASS);
  can.scale.set(0.78, 0.62, 1.5);
  can.position.set(0, 0.68, -4.5);
  g.add(can);
  const intake = mesh(new THREE.BoxGeometry(1.5, 0.68, 2.4), dark);
  intake.position.set(0, -0.78, -3.2);
  g.add(intake);
  const duct = new THREE.Mesh(new THREE.PlaneGeometry(1.42, 0.6), std(0x17191d, 0.4, 0.85));
  duct.position.set(0, -0.78, -4.41);
  duct.rotation.y = Math.PI;
  g.add(duct);

  // big cropped-delta wing
  const wing = mesh(wingGeo([
    { x: -5.47, chord: 1.25, t: 0.07, sweep: 3.05 },
    { x: -1.35, chord: 6.3, t: 0.3, sweep: 0.55 },
    { x: 1.35, chord: 6.3, t: 0.3, sweep: 0.55 },
    { x: 5.47, chord: 1.25, t: 0.07, sweep: 3.05 },
  ]), std(0x8b939c, 0.5, 0.3, true));
  wing.position.set(0, -0.12, 2.2);
  g.add(wing);

  // low-vis roundels on the upper wing (pale blue ring, red centre)
  for (const sx of [-1, 1]) {
    const ring = new THREE.Mesh(new THREE.CircleGeometry(0.52, 16), std(0x5a7fa8, 0.55, 0.15));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(3.1 * sx, 0.12, 3.4);
    g.add(ring);
    const dot = new THREE.Mesh(new THREE.CircleGeometry(0.2, 12), std(0xa8474e, 0.55, 0.15));
    dot.rotation.x = -Math.PI / 2;
    dot.position.set(3.1 * sx, 0.135, 3.4);
    g.add(dot);
  }

  // elevons on the delta's trailing edge
  for (const sx of [-1, 1]) {
    const surf = mesh(new THREE.BoxGeometry(2.8, 0.07, 0.62), dark);
    surf.position.set(0, 0, 0.31);
    g.add(hinged(sx < 0 ? 'aileronL' : 'aileronR', surf, 3.3 * sx, -0.08, 5.35));
  }

  // foreplanes: BOTH canards live in one hinge group named 'elevator', so
  // they deflect together with pitch input exactly like the real jet
  const canards = new THREE.Group();
  canards.name = 'elevator';
  canards.position.set(0, 0.3, -4.15);
  for (const sx of [-1, 1]) {
    const cGeo = wingGeo(sx < 0
      ? [{ x: -2.05, chord: 0.55, t: 0.05, sweep: 0.5 }, { x: -0.55, chord: 1.15, t: 0.08 }]
      : [{ x: 0.55, chord: 1.15, t: 0.08 }, { x: 2.05, chord: 0.55, t: 0.05, sweep: 0.5 }]);
    canards.add(mesh(cGeo, std(0x8b939c, 0.5, 0.3, true)));
  }
  g.add(canards);

  // single tall swept fin + rudder, with a small fin flash
  const finGeo = wingGeo([
    { x: 0, chord: 3.3, t: 0.16 },
    { x: 3.25, chord: 1.05, t: 0.05, sweep: 2.25 },
  ]);
  finGeo.rotateZ(Math.PI / 2);
  const fin = mesh(finGeo, std(0x8b939c, 0.5, 0.3, true));
  fin.position.set(0, 0.55, 5.7);
  g.add(fin);
  for (const [color, dz] of [[0xa8474e, 0], [0x5a7fa8, 0.32]] as Array<[number, number]>) {
    const flash = mesh(new THREE.BoxGeometry(0.16, 0.85, 0.3), std(color, 0.5, 0.15));
    flash.position.set(0, 2.75, 6.95 + dz); // riding the swept fin mid-chord
    flash.rotation.x = -0.55;
    g.add(flash);
  }
  const rudSurf = mesh(new THREE.BoxGeometry(0.07, 2.2, 0.62), dark);
  rudSurf.position.set(0, 1.0, 0.31);
  g.add(hinged('rudder', rudSurf, 0, 1.15, 7.0));

  // twin EJ200 nozzles emerging flush from the aft deck, petals slightly
  // converged, turbine faces recessed inside
  const nozzleMat = std(0x2c2c30, 0.35, 0.9);
  const turbineMat = std(0x17191d, 0.4, 0.85);
  for (const sx of [-1, 1]) {
    const nozzle = mesh(new THREE.CylinderGeometry(0.44, 0.35, 1.1, 12), nozzleMat);
    nozzle.rotation.x = Math.PI / 2;
    nozzle.position.set(0.52 * sx, -0.02, 8.15);
    g.add(nozzle);
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.31, 12), turbineMat);
    face.position.set(0.52 * sx, -0.02, 8.58);
    g.add(face);
  }
  // reheat: a white-hot core inside each orange plume, sized to the nozzle
  // exits so the flames read as coming FROM the engines
  const burner = new THREE.Group();
  burner.name = 'burner';
  for (const sx of [-1, 1]) {
    const flame = new THREE.Mesh(
      new THREE.ConeGeometry(0.33, 3.1, 10, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xff7a2a, transparent: true, opacity: 0.8,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    flame.rotation.x = -Math.PI / 2;
    flame.position.set(0.52 * sx, -0.02, 1.25);
    burner.add(flame);
    const core = new THREE.Mesh(
      new THREE.ConeGeometry(0.17, 1.7, 8, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0xffe9b8, transparent: true, opacity: 0.9,
        blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
      }),
    );
    core.rotation.x = -Math.PI / 2;
    core.position.set(0.52 * sx, -0.02, 0.55);
    burner.add(core);
  }
  burner.position.set(0, 0, 8.75);
  burner.visible = false;
  g.add(burner);

  // tricycle gear
  const gear = new THREE.Group();
  gear.name = 'gear';
  const nw = wheel(0.3, 0.18);
  nw.position.set(0, -1.55, -4.4);
  gear.add(nw, strut(0, -0.65, -4.3, 0, -1.5, -4.4, 0.08));
  for (const sx of [-1, 1]) {
    const w = wheel(0.4, 0.26);
    w.position.set(1.6 * sx, -1.45, 1.9);
    gear.add(w, strut(1.1 * sx, -0.4, 1.7, 1.58 * sx, -1.38, 1.88, 0.09));
  }
  g.add(gear);

  navLights(g, 5.5, 4.9, -0.05);
  return g;
}

/* ================================================================
   AIRBUS A320neo — narrowbody airliner, flag-carrier livery
   (white over midnight blue, red pinline, crossed tail ribbons)
   Built at TRUE scale: 37.6 m fuselage, 35.8 m span — runway and
   aircraft proportions line up like the real thing.
   ================================================================ */
function buildA320(): THREE.Group {
  const g = new THREE.Group();
  const white = std(0xf2f4f6, 0.28, 0.1);
  const greyWing = std(0xc4c9cf, 0.35, 0.4);
  const navy = std(0x10265e, 0.35, 0.2);
  const red = std(0xd0202a, 0.4, 0.15);

  // 3.95 m-wide circular-section fuselage, drooped nose, upswept tailcone
  const fuse = mesh(fuseGeo([
    { z: -18.7, r: 0.22, ry: 0.24, y: -0.35 },
    { z: -17.2, r: 1.15, ry: 1.28, y: -0.12 },
    { z: -14.6, r: 1.86, ry: 1.96, y: 0 },
    { z: -10, r: 1.98, ry: 2.06, y: 0 },
    { z: 6, r: 1.98, ry: 2.06, y: 0 },
    { z: 11.5, r: 1.55, ry: 1.72, y: 0.35 },
    { z: 16, r: 0.72, ry: 0.9, y: 0.95 },
    { z: 18.7, r: 0.16, ry: 0.3, y: 1.35 },
  ], 14), white);
  g.add(fuse);

  // midnight-blue lower fuselage: a rounded keel SHELL that hugs the hull
  // (slightly fatter, centred lower), so the livery boundary is a curved
  // waterline following the fuselage — no slab-sided box
  const keel = mesh(fuseGeo([
    { z: -15.6, r: 0.85, ry: 0.5, y: -1.15 },
    { z: -14.0, r: 1.72, ry: 1.05, y: -0.98 },
    { z: -10, r: 2.03, ry: 1.28, y: -0.88 },
    { z: 6, r: 2.03, ry: 1.28, y: -0.88 },
    { z: 10.5, r: 1.52, ry: 0.95, y: -0.62 },
    { z: 12.6, r: 0.85, ry: 0.5, y: -0.45 },
  ], 14), navy);
  g.add(keel);
  // red speedmark swoosh on each side of the nose
  for (const sx of [-1, 1]) {
    const swoosh = mesh(new THREE.BoxGeometry(0.06, 0.42, 2.4), red);
    swoosh.position.set(1.86 * sx, 0.1, -13.2);
    swoosh.rotation.x = 0.22;
    g.add(swoosh);
  }

  // cockpit glazing: four windshield panes WRAPPED onto the nose as arcs
  // of a cone that follows the hull's own taper, sitting 5 cm proud. The
  // white hull shows through the gaps between arcs as pillar frames, so
  // it reads as real panelled glass — an ellipsoid blob here only pokes
  // out as two separate lumps at the sides of the nose.
  {
    // hull radius at the band's front/rear stations (see fuse stations)
    const rFront = 1.82 + 0.05;
    const rRear = 1.90 + 0.05;
    // panes per side: [start, end] angle from the crown, radians
    const panes: Array<[number, number]> = [
      [0.06, 0.50],  // centre pair, split by the middle post
      [0.56, 1.02],  // raked side panes
    ];
    for (const sx of [-1, 1]) {
      for (const [a0, a1] of panes) {
        // cylinder axis → Z after rotateX; original +Y ends up at +Z
        // (rear), so radiusTop is the REAR radius. θ = π is the crown.
        const start = Math.PI + (sx < 0 ? -a1 : a0);
        const arc = new THREE.CylinderGeometry(rRear, rFront, 1.35, 10, 1, true, start, a1 - a0);
        arc.rotateX(Math.PI / 2);
        const pane = mesh(arc, GLASS);
        pane.scale.y = 1.05; // hull section is elliptical
        pane.position.set(0, 0.02, -14.05);
        g.add(pane);
      }
    }
  }
  // cabin window band, just proud of the hull at its own height
  const winStrip = mesh(new THREE.BoxGeometry(3.82, 0.16, 23.0), std(0x10161f, 0.2, 0.7));
  winStrip.position.set(0, 0.62, -1.1);
  g.add(winStrip);

  // wing-body ("belly") fairing: the smooth bulge that blends the wing
  // roots into the hull — one of the A320's most recognisable curves
  const belly = mesh(fuseGeo([
    { z: -4.6, r: 1.1, ry: 0.55, y: -1.3 },
    { z: -2.6, r: 2.16, ry: 1.02, y: -1.06 },
    { z: 3.2, r: 2.16, ry: 1.02, y: -1.06 },
    { z: 7.4, r: 1.0, ry: 0.5, y: -1.25 },
  ], 12), navy);
  g.add(belly);

  // low swept wing (25° sweep, 5° dihedral), grey upper surface
  const wing = mesh(wingGeo([
    { x: -17.9, chord: 1.55, t: 0.12, sweep: 7.6, rise: 1.62 },
    { x: -5.2, chord: 4.5, t: 0.5, sweep: 1.6, rise: 0.3 },
    { x: -1.95, chord: 6.6, t: 0.72, rise: 0.06 },
    { x: 1.95, chord: 6.6, t: 0.72, rise: 0.06 },
    { x: 5.2, chord: 4.5, t: 0.5, sweep: 1.6, rise: 0.3 },
    { x: 17.9, chord: 1.55, t: 0.12, sweep: 7.6, rise: 1.62 },
  ]), std(0xc4c9cf, 0.35, 0.4, true));
  wing.position.set(0, -1.5, 1.2);
  g.add(wing);

  // sharklets, canted just off vertical, navy with a red trailing edge
  for (const sx of [-1, 1]) {
    const shGeo = wingGeo([
      { x: 0, chord: 1.35, t: 0.07 },
      { x: 2.35, chord: 0.6, t: 0.04, sweep: 0.85 },
    ]);
    shGeo.rotateZ(Math.PI / 2);
    shGeo.rotateZ(sx * -0.22);
    const sh = mesh(shGeo, std(0x10265e, 0.35, 0.2, true));
    sh.position.set(17.85 * sx, 0.16, 8.55);
    g.add(sh);
  }

  for (const sx of [-1, 1]) {
    const surf = mesh(new THREE.BoxGeometry(4.6, 0.09, 0.75), greyWing);
    surf.position.set(0, 0, 0.37);
    g.add(hinged(sx < 0 ? 'aileronL' : 'aileronR', surf, 12.6 * sx, -0.55, 7.0));
  }

  // flap-track canoe fairings under the trailing edge, following the sweep
  for (const sx of [-1, 1]) {
    for (const [fx, fz] of [[3.6, 4.9], [6.6, 5.3], [9.8, 6.1]] as Array<[number, number]>) {
      const canoe = mesh(new THREE.SphereGeometry(0.3, 8, 6), white);
      canoe.scale.set(0.55, 0.55, 3.4);
      canoe.position.set(fx * sx, -1.62 + (fx - 2) * 0.055, fz);
      g.add(canoe);
    }
  }

  // wing-slung LEAP nacelles: fat cowls, spinner-grey fan face, pylons.
  // The fan disc sits clearly IN FRONT of the cowl's front cap and covers
  // it — a disc coplanar with the cap z-fights into a fuzzy shimmer.
  const fanMat = std(0x1b1e24, 0.35, 0.85);
  for (const sx of [-1, 1]) {
    const pod = mesh(fuseGeo([
      { z: -2.2, r: 0.98 },
      { z: -1.3, r: 1.12 },
      { z: 0.9, r: 0.98 },
      { z: 2.1, r: 0.52 },
    ], 12), white);
    pod.position.set(5.75 * sx, -2.12, -1.6);
    g.add(pod);
    const lip = mesh(new THREE.TorusGeometry(0.99, 0.1, 8, 20), std(0xb8bdc4, 0.3, 0.8));
    lip.position.set(5.75 * sx, -2.12, -3.88);
    g.add(lip);
    const fan = new THREE.Mesh(new THREE.CircleGeometry(1.0, 20), fanMat);
    fan.position.set(5.75 * sx, -2.12, -3.86);
    fan.rotation.y = Math.PI;
    g.add(fan);
    const cone = mesh(new THREE.ConeGeometry(0.3, 0.9, 10), std(0x3a3530, 0.45, 0.9));
    cone.rotation.x = -Math.PI / 2;
    cone.position.set(5.75 * sx, -2.12, 0.9);
    g.add(cone);
    const nozzle = new THREE.Mesh(new THREE.CircleGeometry(0.5, 14), fanMat);
    nozzle.position.set(5.75 * sx, -2.12, 0.55);
    g.add(nozzle);
    const pylon = mesh(new THREE.BoxGeometry(0.5, 0.95, 3.0), white);
    pylon.position.set(5.75 * sx, -1.15, -0.4);
    g.add(pylon);
  }

  // fin: built as stacked segments so the flag ribbon is IN the fin — navy
  // base, red and white diagonal-reading bands, navy cap. Every band's
  // chord and sweep follow the fin's own taper exactly, nothing overhangs.
  {
    const finH = 6.0;
    const at = (h: number) => ({
      x: h,
      chord: 5.6 + (1.75 - 5.6) * (h / finH),
      t: 0.5 + (0.09 - 0.5) * (h / finH),
      sweep: 3.9 * (h / finH),
    });
    const bands: Array<[number, number, number]> = [
      [0, 2.1, 0x10265e],    // navy base
      [2.1, 3.0, 0xd0202a],  // red band
      [3.0, 3.9, 0xf2f4f6],  // white band
      [3.9, finH, 0x10265e], // navy cap
    ];
    for (const [h0, h1, color] of bands) {
      const seg = wingGeo([at(h0), at(h1)]);
      seg.rotateZ(Math.PI / 2);
      const m = mesh(seg, std(color, 0.35, 0.2, true));
      m.position.set(0, 1.35, 15.2);
      g.add(m);
    }
  }
  const rudSurf = mesh(new THREE.BoxGeometry(0.09, 4.4, 1.2), navy);
  rudSurf.position.set(0, 1.6, 0.55);
  g.add(hinged('rudder', rudSurf, 0, 2.6, 17.6));

  // low-set swept tailplane
  const hstab = mesh(wingGeo([
    { x: -6.25, chord: 1.2, t: 0.1, sweep: 2.9, rise: 0.35 },
    { x: 0, chord: 3.1, t: 0.28 },
    { x: 6.25, chord: 1.2, t: 0.1, sweep: 2.9, rise: 0.35 },
  ]), std(0xf2f4f6, 0.28, 0.1, true));
  hstab.position.set(0, 0.7, 15.9);
  g.add(hstab);
  const elevSurf = mesh(new THREE.BoxGeometry(11.4, 0.08, 0.66), white);
  elevSurf.position.set(0, 0, 0.33);
  g.add(hinged('elevator', elevSurf, 0, 0.78, 17.75));

  // tricycle gear: twin nosewheels + twin-wheel main bogies
  const gear = new THREE.Group();
  gear.name = 'gear';
  for (const dx of [-0.28, 0.28]) {
    const nw = wheel(0.5, 0.32);
    nw.position.set(dx, -3.0, -13.6);
    gear.add(nw);
  }
  gear.add(strut(0, -1.4, -13.4, 0, -2.95, -13.6, 0.13));
  for (const sx of [-1, 1]) {
    for (const dz of [-0.62, 0.62]) {
      const w = wheel(0.62, 0.42);
      w.position.set(3.8 * sx, -2.9, 1.7 + dz);
      gear.add(w);
    }
    gear.add(strut(3.0 * sx, -1.3, 1.5, 3.78 * sx, -2.8, 1.7, 0.15));
  }
  g.add(gear);

  // spine/keel blade antennas + APU exhaust pipe in the tailcone tip —
  // tiny, but they break the "toy" silhouette at close range
  const antMat = std(0xe8ebee, 0.5, 0.2);
  for (const [az, ay, s] of [[-9.5, 2.02, 1], [2.5, 2.04, 1], [-8.6, -2.02, -1]] as Array<[number, number, number]>) {
    const ant = mesh(new THREE.BoxGeometry(0.06, 0.34, 0.5), antMat);
    ant.position.set(0, ay + s * 0.1, az);
    ant.rotation.x = s * -0.35;
    g.add(ant);
  }
  const apu = mesh(new THREE.CylinderGeometry(0.17, 0.14, 0.7, 8), std(0x4a4d52, 0.4, 0.85));
  apu.rotation.x = Math.PI / 2 - 0.12;
  apu.position.set(0, 1.32, 18.55);
  g.add(apu);

  navLights(g, 17.95, 8.6, 0.2);
  return g;
}

export function buildAircraftModel(id: string): THREE.Group {
  switch (id) {
    case 'skylark': return buildSkylark();
    case 'islander': return buildIslander();
    case 'jetranger': return buildJetRanger();
    case 'falcon': return buildFalcon();
    case 'vector': return buildVector();
    case 'typhoon': return buildTyphoon();
    case 'meridian': return buildMeridian();
    case 'a320': return buildA320();
    default: return buildSkylark();
  }
}

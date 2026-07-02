// Gunnery range: rounds must not tunnel through balloons. At muzzle velocity
// a round covers more than a balloon diameter per frame at 30 fps, so the
// old end-of-step point test skipped right over off-centre hits — collision
// is now swept along the travel segment.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { WorldGen } from '../.test-build/world/heightfield.js';
import { GunneryRange } from '../.test-build/combat/range.js';

const gen = new WorldGen();
const scene = new THREE.Scene();

function shoot({ lateralOffset, dt, seconds = 2.5 }) {
  const range = new GunneryRange(scene, gen);
  const target = range.liveTargets()[0];

  // shooter 400 m short of the balloon, aiming with a deliberate lateral
  // offset (an off-centre hit has a short chord — the tunnelling case) and
  // ~1 m of hold-over for gravity drop over the 0.45 s flight
  const shooter = target.clone().add(new THREE.Vector3(0, 0, 400));
  const aim = target.clone().add(new THREE.Vector3(lateralOffset, 1.0, 0));
  const dir = aim.sub(shooter).normalize();
  const st = {
    pos: shooter,
    vel: new THREE.Vector3(),
    quat: new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 0, -1), dir),
  };
  for (let t = 0; t < seconds; t += dt) range.update(dt, st, true);
  return range;
}

// dead-on and off-centre shots at a low frame rate (dt = 1/30 → ~29 m steps)
{
  const r = shoot({ lateralOffset: 0, dt: 1 / 30 });
  assert.ok(r.hits >= 1, 'dead-centre burst at 30 fps never popped the balloon');
  console.log(`  ✓ centre shot pops at 30 fps (${r.hits} hit)`);
}
{
  const r = shoot({ lateralOffset: 4.5, dt: 1 / 30 });
  assert.ok(r.hits >= 1, 'off-centre burst at 30 fps tunnelled through (swept test broken?)');
  console.log('  ✓ off-centre shot (4.5 m out, short chord) still pops at 30 fps');
}
{
  const r = shoot({ lateralOffset: -4.5, dt: 1 / 60 });
  assert.ok(r.hits >= 1, 'off-centre burst at 60 fps missed');
  console.log('  ✓ off-centre shot pops at 60 fps');
}

// a genuinely wide shot must still miss — swept radius stays honest
{
  const r = shoot({ lateralOffset: 30, dt: 1 / 30 });
  assert.equal(r.hits, 0, 'shot 30 m wide somehow scored');
  console.log('  ✓ 30 m wide burst misses');
}

// ammo depletes while firing and hits stop at the popped balloon
{
  const r = shoot({ lateralOffset: 0, dt: 1 / 60, seconds: 1 });
  assert.ok(r.ammo < 260, 'ammo did not deplete');
  console.log(`  ✓ ammo accounting (${260 - r.ammo} rounds fired)`);
}

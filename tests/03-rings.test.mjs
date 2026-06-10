// Ring Rush course geometry and pass detection.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { RingCourse, RING_COUNT } from '../.test-build/world/rings.js';
import { WorldGen } from '../.test-build/world/heightfield.js';

const scene = new THREE.Scene();
const gen = new WorldGen();

// flying through every gate centre registers all of them
{
  const course = new RingCourse(scene, gen);
  const start = new THREE.Vector3(0, 10, 620);
  course.start(start);
  const pos = start.clone();
  let passes = 0;
  let finished = false;
  let t = 0;
  for (const ring of course.rings) {
    const dir = ring.pos.clone().sub(pos).normalize();
    const end = ring.pos.clone().addScaledVector(dir, 50);
    while (pos.distanceTo(end) > 2 && !finished) {
      pos.addScaledVector(dir, 100 / 60);
      t += 1 / 60;
      const r = course.update(pos, t);
      if (r === 'pass') passes++;
      if (r === 'finish') { passes++; finished = true; }
    }
  }
  assert.equal(passes, RING_COUNT, `only ${passes}/${RING_COUNT} gates registered`);
  assert.ok(finished, 'finish never fired');
  console.log(`  ✓ all ${RING_COUNT} gates register, finish fires`);
}

// every gate has safe clearance above terrain
{
  const course = new RingCourse(scene, gen);
  let minClear = Infinity;
  for (const ring of course.rings) {
    minClear = Math.min(minClear, ring.pos.y - gen.heightAt(ring.pos.x, ring.pos.z));
  }
  assert.ok(minClear > 60, `gate too close to terrain (${minClear.toFixed(0)} m)`);
  console.log(`  ✓ minimum gate clearance ${minClear.toFixed(0)} m`);
}

// an 80 m offset flyby must not register
{
  const course = new RingCourse(scene, gen);
  const start = new THREE.Vector3(80, 10, 620);
  course.start(start);
  const pos = start.clone();
  let t = 0;
  for (let i = 0; i < 4000; i++) {
    pos.z -= 100 / 60;
    t += 1 / 60;
    assert.equal(course.update(pos, t), 'none', 'false pass on offset flyby');
  }
  console.log('  ✓ offset flyby does not false-trigger');
}

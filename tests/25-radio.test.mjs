// The tower: landing clearance (cleared / continue / go around) on final to
// a towered field, and traffic advisories — phraseology and triggers.
import assert from 'node:assert/strict';
import { Tower, clockOf, trafficCall, stationName } from '../.test-build/nav/radio.js';
import { approachesOf } from '../.test-build/nav/ils.js';
import { AIRPORTS } from '../.test-build/world/heightfield.js';

const apps = [];
approachesOf(AIRPORTS[0], apps);
const app = apps[0];
const dirX = Math.sin(app.course), dirZ = -Math.cos(app.course);
const dt = 0.1;
/** position `toGo` m before the threshold on the 3° path, `cross` m right of it */
const onFinal = (toGo, cross = 0) => ({
  x: app.thrX - dirX * toGo - dirZ * cross, z: app.thrZ - dirZ * toGo + dirX * cross,
  y: app.elev + (toGo + 300) * Math.tan(3 * Math.PI / 180), hdg: app.course, onGround: false,
});
/** fly the final from 13 km at 70 m/s; `busy(toGo)` says when the runway is occupied */
function flyFinal(busy, traffic = []) {
  const t = new Tower();
  const calls = [];
  for (let toGo = 13000; toGo > 0; toGo -= 70 * dt) {
    const c = t.update(dt, onFinal(toGo), app, busy(toGo), 'WIND 020° AT 8 KT', traffic);
    if (c) calls.push([Math.round(toGo), c]);
  }
  return calls;
}

assert.equal(stationName('MERIDIAN INTL'), 'MERIDIAN TOWER');
assert.equal(clockOf(0), 12);
assert.equal(clockOf(Math.PI / 2), 3);
assert.equal(clockOf(Math.PI), 6);
assert.equal(clockOf(-Math.PI / 2), 9);
assert.equal(clockOf(-0.1), 12);
assert.equal(clockOf(Math.PI / 6 * 11), 11);

// clear runway: one clearance, with the wind, once established inside ~9 km
{
  const calls = flyFinal(() => false);
  assert.equal(calls.length, 1, `expected one call, got ${JSON.stringify(calls)}`);
  assert.match(calls[0][1], /^MERIDIAN TOWER — RUNWAY \d\d[LR] CLEARED TO LAND · WIND 020° AT 8 KT$/);
  assert.ok(calls[0][0] > 8500 && calls[0][0] < 9600, `clearance came at ${calls[0][0]} m`);
  console.log(`  ✓ "${calls[0][1]}" at ${(calls[0][0] / 1000).toFixed(1)} km, once`);
}
// traffic still rolling out: continue … then cleared when it vacates
{
  const calls = flyFinal((toGo) => toGo > 4000);
  assert.equal(calls.length, 2);
  assert.match(calls[0][1], /CONTINUE APPROACH, TRAFFIC ON THE RUNWAY/);
  assert.match(calls[1][1], /CLEARED TO LAND/);
  assert.ok(calls[1][0] <= 4000 && calls[1][0] > 3900);
  console.log('  ✓ occupied runway: "continue approach", then the clearance as it clears');
}
// never clears: go around at short final — and after a late incursion too
{
  const never = flyFinal(() => true);
  assert.deepEqual(never.map((c) => /GO AROUND/.test(c[1])), [false, true]);
  assert.ok(never[1][0] < 1500 && never[1][0] > 1400);
  const late = flyFinal((toGo) => toGo < 1200);
  assert.match(late[1][1], /GO AROUND, RUNWAY OCCUPIED/);
  console.log('  ✓ still occupied at 1.5 km, or an incursion after the clearance: "go around"');
}
// not established: wide of the centreline, pointing elsewhere, on the ground, or no tower
{
  const t = new Tower();
  const wide = onFinal(6000, 900);
  const away = { ...onFinal(6000), hdg: app.course + 1.2 };
  const parked = { ...onFinal(6000), onGround: true };
  for (let s = 0; s < 30; s += dt) {
    assert.equal(t.update(dt, wide, app, false, 'WIND CALM', []), null);
    assert.equal(t.update(dt, away, app, false, 'WIND CALM', []), null);
    assert.equal(t.update(dt, parked, app, false, 'WIND CALM', []), null);
    assert.equal(t.update(dt, onFinal(6000), null, false, 'WIND CALM', []), null);
  }
  console.log('  ✓ no clearance off the centreline, heading away, on the ground, or untowered');
}
// a go-around flown back onto final gets a fresh clearance
{
  const t = new Tower();
  let n = 0;
  const run = (own, secs) => { for (let s = 0; s < secs; s += dt) if (t.update(dt, own, app, false, 'WIND CALM', [])) n++; };
  run(onFinal(5000), 5);
  run({ ...onFinal(5000), hdg: app.course + Math.PI }, 40); // downwind
  run(onFinal(7000), 5);
  assert.equal(n, 2, `${n} clearances over two approaches`);
  console.log('  ✓ second approach, second clearance');
}
// traffic advisories: clock, distance, height — once per aircraft, airborne only
{
  const own = { x: 0, y: 1000, z: 0, hdg: 0, onGround: false };
  assert.equal(trafficCall(own, { id: 1, x: 2000, y: 1152, z: -2000 }), "TRAFFIC — 2 O'CLOCK, 3 KM, 500 FT ABOVE");
  assert.equal(trafficCall(own, { id: 1, x: -600, y: 990, z: 0 }), "TRAFFIC — 9 O'CLOCK, 0.6 KM, SAME LEVEL");
  assert.equal(trafficCall({ ...own, hdg: Math.PI / 2 }, { id: 1, x: 0, y: 700, z: -1500 }), "TRAFFIC — 9 O'CLOCK, 2 KM, 1,000 FT BELOW");
  const t = new Tower();
  const near = [{ id: 7, x: 1500, y: 1100, z: -1000 }, { id: 8, x: 9000, y: 1000, z: 0 }, { id: 9, x: 500, y: 2500, z: 0 }];
  const calls = [];
  for (let s = 0; s < 90; s += dt) { const c = t.update(dt, own, null, false, '', near); if (c) calls.push(c); }
  assert.equal(calls.length, 1, `advisories: ${JSON.stringify(calls)}`);
  assert.match(calls[0], /^TRAFFIC — 2 O'CLOCK/);
  const g = new Tower();
  for (let s = 0; s < 30; s += dt) assert.equal(g.update(dt, { ...own, onGround: true }, null, false, '', near), null);
  console.log(`  ✓ "${calls[0]}" — once per aircraft, not on the ground, not for far or well-separated traffic`);
}

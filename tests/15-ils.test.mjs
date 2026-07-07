// ILS: real approach geometry. Localizer measures angular offset from the
// far-end antenna, glideslope is a 3.00° path from a station 300 m past the
// threshold, the receiver auto-tunes the correct runway END (and the
// correct parallel runway at internationals), and deviations carry the
// standard fly-toward signs.
import assert from 'node:assert/strict';
import {
  approachesOf, solveIls, tuneIls, runwayIdent, GS_ANGLE,
} from '../.test-build/nav/ils.js';

const mkField = (o = {}) => ({
  name: 'TESTFIELD', code: 'T', x: 0, z: 0, elev: 8,
  length: 2400, width: 36, major: true, heading: 0, cosH: 1, sinH: 0, ...o,
});

// designators: heading 0 = runway 36, east = 09, reciprocal 18
assert.equal(runwayIdent(0), '36');
assert.equal(runwayIdent(Math.PI), '18');
assert.equal(runwayIdent(Math.PI / 2), '09');
console.log('  ✓ runway designators (36 / 18 / 09)');

// a single-runway field serves two approaches with mirrored geometry
{
  const apps = [];
  approachesOf(mkField(), apps);
  assert.equal(apps.length, 2);
  const a36 = apps.find((a) => a.ident === '36');
  const a18 = apps.find((a) => a.ident === '18');
  assert.ok(a36 && a18, 'both ends served');
  // 36 approach lands heading north: threshold at the SOUTH end (+z)
  assert.ok(Math.abs(a36.thrZ - 1200) < 1e-6, `36 threshold at z=${a36.thrZ}`);
  assert.ok(Math.abs(a36.locZ - -1500) < 1e-6, 'LOC antenna 300 m past the stop end');
  assert.ok(Math.abs(a36.gsZ - 900) < 1e-6, 'GS station 300 m in from the threshold');
  assert.ok(Math.abs(a18.thrZ - -1200) < 1e-6, '18 threshold at the north end');
  console.log('  ✓ approach geometry (thresholds, LOC antenna, GS station)');
}

// on the centreline, on the slope: both needles centred; the maths puts the
// threshold crossing height right around the standard ~15-18 m
{
  const apps = [];
  approachesOf(mkField(), apps);
  const a36 = apps.find((a) => a.ident === '36');
  const distToGs = 10000 + (a36.thrZ - a36.gsZ); // 10 km before the threshold
  const y = 8 + 2.5 + Math.tan(GS_ANGLE) * distToGs;
  const d = solveIls(a36, 0, y, a36.thrZ + 10000);
  assert.ok(Math.abs(d.locDev) < 1e-9, `locDev not centred (${d.locDev})`);
  assert.ok(Math.abs(d.gsDev) < 1e-4, `gsDev not centred (${d.gsDev})`);
  assert.ok(Math.abs(d.toGo - 10000) < 1e-6, 'along-track distance wrong');
  const tch = 8 + 2.5 + Math.tan(GS_ANGLE) * 300 - 8; // height over the threshold
  assert.ok(tch > 12 && tch < 22, `threshold crossing height off (${tch.toFixed(1)} m)`);
  console.log(`  ✓ centred needles on the 3° path (TCH ${tch.toFixed(1)} m)`);
}

// deviation signs: right of the centreline → locDev +, above the path → gsDev +
{
  const apps = [];
  approachesOf(mkField(), apps);
  const a36 = apps.find((a) => a.ident === '36');
  const onPathY = 8 + 2.5 + Math.tan(GS_ANGLE) * 10300;
  const right = solveIls(a36, 200, onPathY, 11200);
  assert.ok(right.locDev > 0.01, `right offset should read + (${right.locDev})`);
  const left = solveIls(a36, -200, onPathY, 11200);
  assert.ok(left.locDev < -0.01, 'left offset should read −');
  const high = solveIls(a36, 0, onPathY + 150, 11200);
  assert.ok(high.gsDev > 0.008, 'above the path should read +');
  const low = solveIls(a36, 0, onPathY - 150, 11200);
  assert.ok(low.gsDev < -0.008, 'below the path should read −');
  console.log('  ✓ deviation signs (R/+, L/−, high/+, low/−)');
}

// auto-tune picks the end you are actually approaching, on any heading
{
  const fields = [mkField()];
  const south = tuneIls(fields, 0, 12000, 500, 0, null);
  assert.equal(south?.ident, '36', `south of the field flying north → 36 (got ${south?.ident})`);
  const north = tuneIls(fields, 0, -12000, 500, Math.PI, null);
  assert.equal(north?.ident, '18', 'north of the field flying south → 18');
  // flying AWAY from the field: no capture
  const away = tuneIls(fields, 0, 12000, 500, Math.PI, null);
  assert.equal(away, null, 'outbound heading should not capture');
  // far outside the beam: no capture
  const abeam = tuneIls(fields, 20000, 0, 500, 0, null);
  assert.equal(abeam, null, 'abeam the runway should not capture');
  console.log('  ✓ auto-tune: correct end, no outbound/abeam false captures');
}

// a rotated strip works in its own frame
{
  const hdg = 0.8727; // 50° — runway 05/23
  const f = mkField({ heading: hdg, cosH: Math.cos(hdg), sinH: Math.sin(hdg) });
  const apps = [];
  approachesOf(f, apps);
  const a05 = apps.find((a) => a.ident === '05');
  assert.ok(a05, 'rotated field serves runway 05');
  // 10 km out on the extended centreline, on the slope
  const dirX = Math.sin(hdg);
  const dirZ = -Math.cos(hdg);
  const px = a05.thrX - dirX * 10000;
  const pz = a05.thrZ - dirZ * 10000;
  const y = 8 + 2.5 + Math.tan(GS_ANGLE) * (10000 + 300);
  const d = solveIls(a05, px, y, pz);
  assert.ok(Math.abs(d.locDev) < 1e-9 && Math.abs(d.gsDev) < 1e-4, 'rotated centreline not centred');
  const t = tuneIls([f], px, pz, y, hdg, null);
  assert.equal(t?.ident, '05');
  console.log('  ✓ rotated runway: solve + tune in the runway frame');
}

// internationals: twin parallels serve four approaches with pilot-view L/R
{
  const f = mkField({ name: 'BIG INTL', length: 3900, rwySep: 1400, rwy2Len: 3660 });
  const apps = [];
  approachesOf(f, apps);
  assert.equal(apps.length, 4);
  const idents = apps.map((a) => a.ident).sort();
  assert.deepEqual(idents, ['18L', '18R', '36L', '36R']);
  const a36L = apps.find((a) => a.ident === '36L');
  const a36R = apps.find((a) => a.ident === '36R');
  // flying north, the WEST (−x) runway is on the pilot's left
  assert.ok(a36L.thrX < a36R.thrX, '36L west of 36R');
  // approaching down the west centreline tunes 36L, east tunes 36R
  const tL = tuneIls([f], a36L.thrX, a36L.thrZ + 10000, 550, 0, null);
  assert.equal(tL?.ident, '36L');
  const tR = tuneIls([f], a36R.thrX, a36R.thrZ + 10000, 550, 0, null);
  assert.equal(tR?.ident, '36R');
  console.log('  ✓ parallel internationals: 36L/36R/18L/18R, per-runway capture');
}

// hysteresis: once tuned, small wobbles don't flick the receiver
{
  const f = mkField({ length: 3900, rwySep: 1400 });
  const apps = [];
  approachesOf(f, apps);
  const a36L = apps.find((a) => a.ident === '36L');
  // drift a bit toward the other runway's side: stays on 36L
  const mid = tuneIls([f], a36L.thrX + 550, a36L.thrZ + 9000, 550, 0, a36L);
  assert.equal(mid?.ident, '36L', 'receiver flicked despite hysteresis');
  console.log('  ✓ receiver holds the tuned approach through small wobbles');
}

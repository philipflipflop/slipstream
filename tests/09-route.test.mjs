// Flight-plan route: bearings, leg math, sequencing, ETE.
import assert from 'node:assert/strict';
import { Route, bearingTo, distanceTo } from '../.test-build/nav/route.js';

const RAD2DEG = 180 / Math.PI;

// bearings follow the compass convention (0 = north = -Z, east = 090)
assert.equal(Math.round(bearingTo(0, 0, 1000, 0) * RAD2DEG), 90);    // east
assert.equal(Math.round(bearingTo(0, 0, 0, -1000) * RAD2DEG), 0);    // north
assert.equal(Math.round(bearingTo(0, 0, -1000, 0) * RAD2DEG), -90);  // west
assert.equal(Math.abs(Math.round(bearingTo(0, 0, 0, 1000) * RAD2DEG)), 180); // south
console.log('  ✓ bearings: N=000, E=090, W=270, S=180');

const r = new Route();
r.add({ x: 10000, z: 0, name: 'ALPHA' });
r.add({ x: 10000, z: -20000, name: 'BRAVO' });

// legs from present position: east 10 km, then north 20 km
const legs = r.legs(0, 0, 100);
assert.equal(legs.length, 2);
assert.equal(Math.round(legs[0].distance), 10000);
assert.equal(Math.round(legs[0].bearing * RAD2DEG), 90);
assert.equal(Math.round(legs[1].distance), 20000);
assert.equal(Math.round(legs[1].bearing * RAD2DEG) % 360, 0);
assert.equal(Math.round(legs[0].eteSec), 100);
assert.equal(Math.round(r.totalDistance(0, 0)), 30000);
console.log('  ✓ leg headings, distances and ETE at groundspeed');

// sequencing: passing within the capture radius advances the route
assert.equal(r.target().name, 'ALPHA');
assert.equal(r.sequence(0, 0), null);
const seq = r.sequence(9000, 0); // 1000 m from ALPHA — inside capture
assert.equal(seq?.name, 'ALPHA');
assert.equal(r.target().name, 'BRAVO');
const hdg = r.desiredHeading(10000, 0);
assert.equal(Math.round(hdg * RAD2DEG) % 360, 0); // due north to BRAVO
r.sequence(10000, -19500);
assert.ok(r.complete, 'route should be complete after the last fix');
assert.equal(r.desiredHeading(0, 0), null);
console.log('  ✓ waypoint capture and sequencing to completion');

// editing
const r2 = new Route();
r2.add({ x: 1, z: 1, name: 'A' });
r2.add({ x: 2, z: 2, name: 'B' });
r2.removeLast();
assert.equal(r2.waypoints.length, 1);
r2.clear();
assert.ok(r2.isEmpty && !r2.engaged);
console.log('  ✓ undo/clear editing');

// distance helper sanity
assert.equal(distanceTo(0, 0, 3000, 4000), 5000);
console.log('  ✓ distance helper');

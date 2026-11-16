// Charter jobs: every board offers work the aircraft can actually fly (a
// runway it can use, a distance it can cover), par times are makeable, and
// the pay rewards punctuality, a good landing and a smooth ride.
import assert from 'node:assert/strict';
import { WorldGen, AIRPORTS } from '../.test-build/world/heightfield.js';
import { CATALOG, specById } from '../.test-build/aircraft/catalog.js';
import { jobsFrom, jobClass, parTime, scoreJob, atField, Comfort } from '../.test-build/nav/jobs.js';

const gen = new WorldGen();
const home = AIRPORTS[0];

// ---- the board ----
for (const spec of CATALOG) {
  const c = jobClass(spec);
  const jobs = jobsFrom(gen, home, spec, 0);
  assert.ok(jobs.length >= 2, `${spec.id}: only ${jobs.length} jobs at the home international`);
  assert.deepEqual(jobsFrom(gen, home, spec, 0).map((j) => j.title + j.to.name), jobs.map((j) => j.title + j.to.name), `${spec.id}: board not deterministic`);
  const dests = new Set();
  for (const j of jobs) {
    assert.ok(j.to !== home && (j.to.x !== home.x || j.to.z !== home.z), `${spec.id}: a job to where you already are`);
    assert.ok(!dests.has(j.to.name), `${spec.id}: two jobs to ${j.to.name}`);
    dests.add(j.to.name);
    if (c.needs === 'intl') assert.ok(j.to.intl, `${spec.id}: sent to ${j.to.name}, not an international`);
    if (c.needs === 'major') assert.ok(j.to.major || j.to.intl, `${spec.id}: sent to the strip at ${j.to.name}`);
    assert.ok(Math.abs(j.distance - Math.hypot(j.to.x - home.x, j.to.z - home.z)) < 1);
    assert.ok(j.distance > 5000, `${spec.id}: a ${(j.distance / 1000).toFixed(1)} km job`);
    // makeable: block speed well inside what the aircraft does, time to spare for the ends
    const blockKt = (j.distance / (j.par - 120)) * 1.943844;
    assert.ok(blockKt < spec.topSpeedKt * 0.86, `${spec.id}: ${j.title} needs ${blockKt.toFixed(0)} kt average (top ${spec.topSpeedKt})`);
    assert.ok(j.par > 180 && j.par < 3600, `${spec.id}: par ${j.par} s`);
    assert.ok(j.pay >= 150 && j.pay % 10 === 0, `${spec.id}: fee ${j.pay}`);
    assert.equal(j.comfort, j.kind === 'charter' || j.kind === 'medevac');
    if (c.seats === 0) assert.ok(j.kind === 'courier' || j.kind === 'cargo', `${spec.id} has no seats but got a ${j.kind}`);
  }
  const far = jobs.reduce((a, b) => (b.distance > a.distance ? b : a));
  console.log(`  ✓ ${spec.id}: ${jobs.length} jobs — e.g. ${far.title} → ${far.to.name}, ${(far.distance / 1000).toFixed(0)} km, par ${Math.floor(far.par / 60)}:${String(far.par % 60).padStart(2, '0')}, ${far.pay} cr`);
}
// the board changes as you fly, and exists away from home too
{
  const spec = specById('skylark');
  const a = jobsFrom(gen, home, spec, 0).map((j) => j.kind + j.to.name).join('|');
  const b = jobsFrom(gen, home, spec, 1).map((j) => j.kind + j.to.name).join('|');
  assert.notEqual(a, b, 'the board is the same after a job');
  const first = jobsFrom(gen, home, spec, 0)[0];
  const onward = jobsFrom(gen, first.to, spec, 1);
  assert.ok(onward.length >= 1, `no onward work from ${first.to.name}`);
  // longer jobs pay more, urgent ones pay more per km and run a tighter clock
  assert.ok(parTime(spec, 'medevac', 40000) < parTime(spec, 'charter', 40000));
  assert.ok(parTime(spec, 'charter', 80000) > parTime(spec, 'charter', 40000) * 1.5);
  console.log(`  ✓ fresh board after each job; onward work from ${first.to.name} (${onward.length} jobs)`);
}

// ---- arriving ----
{
  const f = AIRPORTS[1];
  assert.ok(atField(f, f.x, f.z));
  assert.ok(atField(f, f.x + f.sinH * (f.length / 2 + 200), f.z - f.cosH * (f.length / 2 + 200)), 'the overrun is not the field');
  assert.ok(!atField(f, f.x + 3000 * f.cosH, f.z + 3000 * f.sinH), '3 km abeam counts as arrived');
  assert.ok(!atField(f, f.x + f.sinH * (f.length / 2 + 2000), f.z - f.cosH * (f.length / 2 + 2000)));
}

// ---- the pay ----
{
  const job = jobsFrom(gen, home, specById('islander'), 0).find((j) => j.kind === 'charter');
  const cargo = { ...job, kind: 'cargo', comfort: false };
  const perfect = scoreJob(job, { time: job.par * 0.8, landing: 100, comfort: 1 });
  const onTime = scoreJob(job, { time: job.par, landing: 100, comfort: 1 });
  const late = scoreJob(job, { time: job.par * 1.25, landing: 100, comfort: 1 });
  const veryLate = scoreJob(job, { time: job.par * 4, landing: 100, comfort: 1 });
  const thump = scoreJob(job, { time: job.par, landing: 40, comfort: 1 });
  const rough = scoreJob(job, { time: job.par, landing: 100, comfort: 0.2 });
  assert.equal(onTime.pay, job.pay, 'on time, greased, smooth should pay the fee');
  assert.ok(Math.abs(perfect.pay / job.pay - 1.15) < 0.01 && perfect.grade === 'A+');
  assert.ok(Math.abs(late.pay / job.pay - 0.75) < 0.01, `25% late paid ${(late.pay / job.pay).toFixed(2)}`);
  assert.ok(Math.abs(veryLate.pay / job.pay - 0.6) < 0.01, 'lateness should bottom out at −40%');
  assert.ok(thump.pay < onTime.pay && rough.pay < onTime.pay && rough.comfortMul < 1);
  assert.equal(scoreJob(cargo, { time: job.par, landing: 100, comfort: 0 }).pay, job.pay, 'freight does not mind the ride');
  assert.equal(scoreJob(job, { time: job.par, landing: null, comfort: 1 }).pay, job.pay, 'an ungraded (helicopter) landing should be neutral');
  assert.ok(scoreJob(job, { time: job.par, landing: 0, comfort: 1 }).landMul === 0.6);
  let prev = Infinity;
  for (let t = 0.5; t <= 3; t += 0.05) {
    const p = scoreJob(job, { time: job.par * t, landing: 80, comfort: 0.9 }).pay;
    assert.ok(p <= prev, 'pay rose with lateness');
    prev = p;
  }
  console.log(`  ✓ pay: fee ${job.pay} → ${perfect.pay} early & greased (${perfect.grade}), ${late.pay} 25% late, ${thump.pay} thumped on, ${rough.pay} rough ride (${rough.grade})`);
}

// ---- the ride ----
{
  const dt = 1 / 60;
  const smooth = new Comfort();
  for (let t = 0; t < 1200; t += dt) smooth.step(dt, 1 + Math.sin(t) * 0.25, Math.sin(t * 0.1) * 0.45, false);
  smooth.touchdown(1.2);
  assert.equal(smooth.value, 1, 'an airline-smooth flight lost comfort');
  const yank = new Comfort();
  for (let t = 0; t < 12; t += dt) yank.step(dt, 3.2, 1.2, false);
  assert.ok(yank.value < 0.2, `twelve seconds of 3 g at 70° bank: comfort ${yank.value.toFixed(2)}`);
  const thump = new Comfort();
  thump.touchdown(4.5);
  assert.ok(thump.value < 0.65 && thump.value > 0.3, `a 900 fpm arrival: comfort ${thump.value.toFixed(2)}`);
  const ground = new Comfort();
  for (let t = 0; t < 60; t += dt) ground.step(dt, 0.2, 1.5, true);
  assert.equal(ground.value, 1, 'taxiing counted against the ride');
  console.log(`  ✓ ride: smooth flying costs nothing, aerobatics ${Math.round(yank.value * 100)}%, a hard arrival ${Math.round(thump.value * 100)}%`);
}

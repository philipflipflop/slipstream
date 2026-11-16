// node tests/map-probe.mjs <theme> <cx km> <cz km> <span km> <px> <out.ppm>
// top-down hill-shaded colour map of the analytic world (terrain tuning)
// (run `npm test` once first: it reads the compiled modules in .test-build/; convert the
// PPM with any image tool, e.g. PIL: Image.open("map.ppm").save("map.png"))
import { writeFileSync } from 'node:fs';
import { WorldGen } from '../.test-build/world/heightfield.js';

const [theme = 'archipelago', cxk = '0', czk = '0', spanK = '60', pxS = '600', out = 'map.ppm'] = process.argv.slice(2);
const gen = new WorldGen(20260610, theme);
const N = +pxS;
const span = +spanK * 1000;
const step = span / N;
const x0 = +cxk * 1000 - span / 2;
const z0 = +czk * 1000 - span / 2;
const buf = Buffer.alloc(N * N * 3);
const col = [0, 0, 0];
const H = new Float32Array((N + 2) * (N + 2));
const t0 = performance.now();
for (let j = 0; j < N + 2; j++) for (let i = 0; i < N + 2; i++) H[j * (N + 2) + i] = gen.heightAt(x0 + (i - 1) * step, z0 + (j - 1) * step);
const tH = performance.now() - t0;
let land = 0, river = 0, maxH = 0;
const enc = (v) => Math.round(255 * Math.min(1, Math.max(0, v)) ** (1 / 2.2));
for (let j = 0; j < N; j++) {
  for (let i = 0; i < N; i++) {
    const k = (j + 1) * (N + 2) + i + 1;
    const h = H[k];
    const nx = H[k - 1] - H[k + 1];
    const nz = H[k - (N + 2)] - H[k + (N + 2)];
    const ny = 2 * step;
    const il = 1 / Math.hypot(nx, ny, nz);
    gen.colorAt(x0 + i * step, z0 + j * step, h, 1 - ny * il, col, step);
    let r = col[0], g = col[1], b = col[2];
    if (h < 0) { r = 0.05; g = 0.2; b = 0.34; } else { land++; }
    if (h > maxH) maxH = h;
    // sun from the north-west
    const sh = h < 0 ? 1 : Math.max(0.25, Math.min(1.5, 0.35 + 1.1 * ((-nx * 0.5 - nz * 0.5) * il * 4 + ny * il * 0.7)));
    const o = (j * N + i) * 3;
    buf[o] = enc(r * sh); buf[o + 1] = enc(g * sh); buf[o + 2] = enc(b * sh);
  }
}
writeFileSync(out, Buffer.concat([Buffer.from(`P6\n${N} ${N}\n255\n`), buf]));
console.log(`${theme} ${cxk},${czk} span ${spanK} km: land ${(100 * land / (N * N)).toFixed(0)}% maxH ${maxH.toFixed(0)} m; heightAt ${(tH / ((N + 2) ** 2) * 1000).toFixed(2)} µs/call`);

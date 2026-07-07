/**
 * Headless physics/world test runner.
 * Compiles the pure-logic modules with tsc into .test-build/, patches
 * extensionless ESM imports for Node, then runs every *.test.mjs in order.
 *
 *   npm test
 */
import { execSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync, renameSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const out = join(root, '.test-build');

console.log('▸ compiling logic modules…');
// invoke the local compiler directly — npx can rewrite package-lock.json on
// a cold cache, silently pruning the @emnapi entries Cloudflare's npm needs
execSync(
  'node node_modules/typescript/bin/tsc src/aircraft/flightModel.ts src/aircraft/catalog.ts src/aircraft/autopilot.ts src/world/rings.ts src/world/terrainBuilder.ts src/world/obstacles.ts src/nav/route.ts src/nav/ils.ts src/combat/range.ts ' +
  `--outDir .test-build --module esnext --target es2022 --moduleResolution bundler --skipLibCheck`,
  { cwd: root, stdio: 'inherit' },
);

// tsc may flatten when a sub-entry has no cross-folder imports
if (existsSync(join(out, 'catalog.js')) && !existsSync(join(out, 'aircraft', 'catalog.js'))) {
  mkdirSync(join(out, 'aircraft'), { recursive: true });
  renameSync(join(out, 'catalog.js'), join(out, 'aircraft', 'catalog.js'));
}

const patch = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) patch(p);
    else if (entry.name.endsWith('.js')) {
      const src = readFileSync(p, 'utf8')
        .replace(/from '(\.\.?\/[^']+?)';/g, (m, spec) => (spec.endsWith('.js') ? m : `from '${spec}.js';`));
      writeFileSync(p, src);
    }
  }
};
patch(out);

const tests = readdirSync(join(root, 'tests')).filter((f) => f.endsWith('.test.mjs')).sort();
let failed = 0;
for (const t of tests) {
  console.log(`\n▸ ${t}`);
  const r = spawnSync(process.execPath, [join(root, 'tests', t)], { stdio: 'inherit' });
  if (r.status !== 0) failed++;
}
console.log(failed === 0 ? '\n✓ all test files passed' : `\n✗ ${failed} test file(s) failed`);
process.exit(failed === 0 ? 0 : 1);

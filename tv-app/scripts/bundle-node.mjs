// Stage the Node project that gets zipped into the APK's assets.
//
// Run from repo root:  npm run tv:bundle
//
// Output: tv-app/node-staging/nodejs-project/
//   main.js        (tv-app/node-bootstrap/main.js)
//   dist/src/      (compiled addon from ../addon)
//   package.json   (prod deps only)
//   node_modules/  (npm install --omit=dev)
//
// Gradle zips this folder into assets/nodejs-project.zip at build time.

import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundledDefaults, describeDefaults } from './defaults.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const addonRoot = join(here, '..', '..', 'addon');
const stage = join(here, '..', 'node-staging', 'nodejs-project');

const run = (cmd, cwd) => {
  console.log(`> ${cmd}  (${cwd})`);
  execSync(cmd, { cwd, stdio: 'inherit' });
};

run('npm run build', addonRoot);

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });

cpSync(join(addonRoot, 'dist', 'src'), join(stage, 'dist', 'src'), { recursive: true });
cpSync(join(here, '..', 'node-bootstrap'), stage, { recursive: true });

const pkg = JSON.parse(readFileSync(join(addonRoot, 'package.json'), 'utf8'));
const prodPkg = {
  name: pkg.name,
  version: pkg.version,
  private: true,
  main: 'main.js',
  dependencies: {
    ...pkg.dependencies,
    // nodejs-mobile ships Node 18; lru-cache 11 requires Node 20+.
    // v10 has the same LRUCache API (max/ttl/get/set).
    'lru-cache': '^10.4.3',
  },
};
writeFileSync(join(stage, 'package.json'), JSON.stringify(prodPkg, null, 2));

// defaults.json: optional addon settings + the scrambled starter key (defaults.mjs).
const defaults = bundledDefaults(addonRoot);
writeFileSync(join(stage, 'defaults.json'), JSON.stringify(defaults));
console.log(describeDefaults(defaults));

// --ignore-scripts: no native builds can run on device anyway; optional
// native deps (bufferutil, utf-8-validate) fall back to pure JS.
run('npm install --omit=dev --ignore-scripts --no-audit --no-fund', stage);

if (!existsSync(join(stage, 'node_modules', 'telegram'))) {
  throw new Error('staging failed: node_modules/telegram missing');
}
console.log(`\nStaged Node project at ${stage}`);

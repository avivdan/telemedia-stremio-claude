// Stage the Node part of the PC app: the same bootstrap the TV app runs
// (tv-app/node-bootstrap: Telegram setup, Stremio pairing, starting the
// addon) plus the compiled addon and its production dependencies.
//
// Run from pc-app/:  npm run bundle   (npm start / npm run dist call it)
//
// Output: pc-app/node-staging/node/  → resources/node in the installed app
//   main.js, starter-login.js, …   (tv-app/node-bootstrap)
//   defaults.json                  (addon settings + scrambled starter key)
//   dist/src/                      (compiled addon)
//   node_modules/                  (npm install --omit=dev)

import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundledDefaults, describeDefaults } from '../../tv-app/scripts/defaults.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..', '..');
const addonRoot = join(repo, 'addon');
const stage = join(here, '..', 'node-staging', 'node');

if (process.argv.includes('--if-missing') && existsSync(join(stage, 'node_modules', 'telegram'))) {
  console.log('Node part already staged (npm run bundle to refresh)');
  process.exit(0);
}

const run = (cmd, cwd) => {
  console.log(`> ${cmd}  (${cwd})`);
  execSync(cmd, { cwd, stdio: 'inherit' });
};

run('npm run build', addonRoot);

rmSync(stage, { recursive: true, force: true });
mkdirSync(stage, { recursive: true });
cpSync(join(addonRoot, 'dist', 'src'), join(stage, 'dist', 'src'), { recursive: true });
cpSync(join(repo, 'tv-app', 'node-bootstrap'), stage, { recursive: true });

const pkg = JSON.parse(readFileSync(join(addonRoot, 'package.json'), 'utf8'));
writeFileSync(join(stage, 'package.json'), JSON.stringify({
  name: pkg.name,
  version: pkg.version,
  private: true,
  main: 'main.js',
  dependencies: pkg.dependencies, // Electron's Node is new enough for all of them
}, null, 2));

const defaults = bundledDefaults(addonRoot);
writeFileSync(join(stage, 'defaults.json'), JSON.stringify(defaults));
console.log(describeDefaults(defaults));

// --ignore-scripts: optional native deps (bufferutil, utf-8-validate) fall
// back to pure JS, so nothing has to be compiled for Electron.
run('npm install --omit=dev --ignore-scripts --no-audit --no-fund', stage);
if (!existsSync(join(stage, 'node_modules', 'telegram'))) {
  throw new Error('staging failed: node_modules/telegram missing');
}
console.log(`\nStaged Node part at ${stage}`);

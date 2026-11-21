// Stage the Node project that gets zipped into the APK's assets.
//
// Run:  npm run bundle
//
// The addon is NOT copied into this repo: it is compiled from the TV
// project's addon (one addon codebase), and the TV app's Telegram/Stremio
// setup helpers are reused as they are.
//   TELEMEDIA_ADDON_DIR  default ../telemedia-stremio-claude/addon
//   (the TV helpers come from <addon dir>/../tv-app/node-bootstrap)
//
// Output: node-staging/nodejs-project/
//   main.js, login.js, setup.js, groups.js   (node-bootstrap/)
//   tv/  my-telegram.js, stremio-link.js, starter-login.js  (TV app, unchanged)
//   dist/src/      (compiled addon)
//   defaults.json  (addon settings, head-start groups, scrambled starter key)
//   package.json + node_modules/  (prod deps only)
//
// Gradle zips this folder into assets/nodejs-project.zip at build time.

import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readProperties, scramble, signingDir } from './toolchain.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const require = createRequire(import.meta.url);
const addonRoot = resolve(process.env.TELEMEDIA_ADDON_DIR || join(root, '..', 'telemedia-stremio-claude', 'addon'));
const tvBootstrap = join(addonRoot, '..', 'tv-app', 'node-bootstrap');
const TV_FILES = ['my-telegram.js', 'stremio-link.js', 'starter-login.js'];
const stage = join(root, 'node-staging', 'nodejs-project');
const addonBuild = join(root, 'node-staging', 'addon-build');

const run = (cmd, cwd) => {
  console.log(`> ${cmd}  (${cwd})`);
  execSync(cmd, { cwd, stdio: 'inherit' });
};

if (!existsSync(join(addonRoot, 'package.json'))) {
  throw new Error(`Addon not found at ${addonRoot}. Clone telemedia-stremio-claude next to this repo, or set TELEMEDIA_ADDON_DIR.`);
}
for (const f of TV_FILES) {
  if (!existsSync(join(tvBootstrap, f))) throw new Error(`TV app helper missing: ${join(tvBootstrap, f)}`);
}

// --- compile the addon into our own staging folder (the TV repo stays untouched)
const tsc = join(addonRoot, 'node_modules', 'typescript', 'bin', 'tsc');
if (!existsSync(tsc)) run('npm install --no-audit --no-fund', addonRoot);
rmSync(addonBuild, { recursive: true, force: true });
run(`node "${tsc}" -p "${join(addonRoot, 'tsconfig.json')}" --outDir "${addonBuild}" --sourceMap false`, root);

rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'tv'), { recursive: true });
cpSync(join(addonBuild, 'src'), join(stage, 'dist', 'src'), { recursive: true });
cpSync(join(root, 'node-bootstrap'), stage, { recursive: true });
for (const f of TV_FILES) cpSync(join(tvBootstrap, f), join(stage, 'tv', f));

// The shared helpers must still have what the phone bootstrap uses.
const check = (file, names) => {
  const mod = require(join(stage, 'tv', file));
  for (const n of names) if (typeof mod[n] !== 'function') throw new Error(`tv/${file} no longer exports ${n}()`);
};
check('my-telegram.js', ['normalizePhone', 'sendCode', 'fetchKeys']);
check('stremio-link.js', ['run']);
check('starter-login.js', ['unscramble', 'parseCode']);

const pkg = JSON.parse(readFileSync(join(addonRoot, 'package.json'), 'utf8'));
const prodPkg = {
  name: 'telemedia-phone',
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

// --- build-time defaults baked into the APK ---------------------------------
// Optional addon settings (catalog country, chat ids, ...) from the build
// environment or the developer's addon user config file. Not bundled:
// host/port/base URLs (the phone always serves 127.0.0.1).
const PASS_THROUGH_ENV = [
  'CATALOG_COUNTRY',
  'CATALOG_LANGUAGE',
  'TG_KIDS_CHAT_ID',
  'TG_HEBREW_GROUP',
  'TG_WORLD_GROUP',
  'TG_BOT_USERNAME',
  'STREAM_CHUNK_KB',
  'STREAM_PREFETCH_KB',
  'STREAM_PARALLEL',
  'CACHE_TTL_SECONDS',
  'LOG_LEVEL',
];
const { readUserConfig, resolveSetting } = require(join(addonBuild, 'src', 'userConfig.js'));
const userConfig = readUserConfig();
const setting = (k) => resolveSetting(k, process.env, userConfig);

// Starter key for automatic first-run setup (node-bootstrap/setup.js), from
// TELEMEDIA_STARTER_API_ID/_HASH or <signing dir>/starter.properties
// (apiId=…, apiHash=…), kept outside the repo. Without it the app asks for
// the user's own key by hand.
function starterKey() {
  let apiId = process.env.TELEMEDIA_STARTER_API_ID;
  let apiHash = process.env.TELEMEDIA_STARTER_API_HASH;
  const file = join(signingDir(), 'starter.properties');
  if (!apiId && !apiHash && existsSync(file)) ({ apiId, apiHash } = readProperties(file));
  if (!apiId && !apiHash) return undefined;
  if (!/^\d{3,12}$/.test(apiId || '') || !/^[0-9a-f]{32}$/i.test(apiHash || '')) {
    throw new Error('starter key: apiId must be a number and apiHash 32 hex characters');
  }
  return { apiId, apiHash: apiHash.toLowerCase() };
}

// Head-start groups (node-bootstrap/groups.js): TELEMEDIA_GROUPS, else
// <signing dir>/groups.txt, else the addon user config setting
// TELEMEDIA_GROUPS. One t.me link / @name / invite link per line.
function headStartGroups() {
  const { parseGroupList } = require(join(root, 'node-bootstrap', 'groups.js'));
  const file = join(signingDir(), 'groups.txt');
  const text = process.env.TELEMEDIA_GROUPS
    ?? (existsSync(file) ? readFileSync(file, 'utf8') : setting('TELEMEDIA_GROUPS'))
    ?? '';
  return parseGroupList(text);
}

const defaults = {
  env: Object.fromEntries(PASS_THROUGH_ENV.filter((k) => setting(k)).map((k) => [k, setting(k)])),
  groups: headStartGroups(),
  starter: scramble(starterKey()),
};

writeFileSync(join(stage, 'defaults.json'), JSON.stringify(defaults));
console.log(
  (defaults.starter ? 'Bundled: starter key for automatic setup' : 'Bundled: no starter key (setup by hand)') +
    `, ${defaults.groups.length} head-start group${defaults.groups.length === 1 ? '' : 's'}` +
    (Object.keys(defaults.env).length ? `, ${Object.keys(defaults.env).join(', ')}` : ''),
);

// --ignore-scripts: no native builds can run on the phone anyway; optional
// native deps (bufferutil, utf-8-validate) fall back to pure JS.
run('npm install --omit=dev --ignore-scripts --no-audit --no-fund --no-package-lock', stage);

if (!existsSync(join(stage, 'node_modules', 'telegram'))) {
  throw new Error('staging failed: node_modules/telegram missing');
}
console.log(`\nStaged Node project at ${stage}`);

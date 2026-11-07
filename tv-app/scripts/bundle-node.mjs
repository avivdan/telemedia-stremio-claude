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
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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

// Build-time defaults baked into the APK: optional addon settings (catalog
// country, chat ids, ...) from the build environment or the developer's user
// config file (addon/src/userConfig.ts).
// Telegram credentials: only the optional starter key (see starterKey below),
// which first-run setup uses for a few minutes to fetch each user's own API
// ID/hash; the addon always runs on the user's own key. Also NOT bundled:
// host/port/base URLs (TV always serves 127.0.0.1) and STREAM_PREFETCH_KB
// (low RAM).
const PASS_THROUGH_ENV = [
  'CATALOG_COUNTRY',
  'CATALOG_LANGUAGE',
  'TG_KIDS_CHAT_ID',
  'TG_HEBREW_GROUP',
  'TG_WORLD_GROUP',
  'TG_BOT_USERNAME',
  'STREAM_CHUNK_KB',
  'STREAM_PARALLEL',
  'CACHE_TTL_SECONDS',
  'LOG_LEVEL',
];
// Same lookup as the addon itself: environment, then the user config file.
const { readUserConfig, resolveSetting } = createRequire(import.meta.url)(
  join(addonRoot, 'dist', 'src', 'userConfig.js'),
);
const userConfig = readUserConfig();
const setting = (k) => resolveSetting(k, process.env, userConfig);
// Starter key for automatic first-run setup (node-bootstrap/starter-login.js),
// from TELEMEDIA_STARTER_API_ID/_HASH or <signing dir>/starter.properties
// (apiId=…, apiHash=…), kept outside the repo. Without it the app uses the
// phone setup page instead.
function starterKey() {
  let apiId = process.env.TELEMEDIA_STARTER_API_ID;
  let apiHash = process.env.TELEMEDIA_STARTER_API_HASH;
  const file = join(
    process.env.TELEMEDIA_SIGNING_DIR || join(homedir(), 'Documents', 'telemedia-signing'),
    'starter.properties',
  );
  if (!apiId && !apiHash && existsSync(file)) {
    const props = Object.fromEntries(
      readFileSync(file, 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
        .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
    );
    ({ apiId, apiHash } = props);
  }
  if (!apiId && !apiHash) return undefined;
  if (!/^\d{3,12}$/.test(apiId || '') || !/^[0-9a-f]{32}$/i.test(apiHash || '')) {
    throw new Error('starter key: apiId must be a number and apiHash 32 hex characters');
  }
  return { apiId, apiHash: apiHash.toLowerCase() };
}

// Scrambled so the key is not plain text in the APK (nor found by key
// scanners). Not encryption: the app unscrambles it (starter-login.js).
function scramble(key) {
  if (!key) return undefined;
  const data = Buffer.from(JSON.stringify(key));
  const pad = randomBytes(data.length);
  return Buffer.concat([pad, data.map((b, i) => b ^ pad[i])]).reverse().toString('base64');
}

const defaults = {
  env: Object.fromEntries(PASS_THROUGH_ENV.filter((k) => setting(k)).map((k) => [k, setting(k)])),
  starter: scramble(starterKey()),
};
writeFileSync(join(stage, 'defaults.json'), JSON.stringify(defaults));
console.log(
  (defaults.starter
    ? 'Bundled defaults: starter key for automatic setup'
    : 'Bundled defaults: no Telegram credentials (phone setup page)') +
    (Object.keys(defaults.env).length ? ` + ${Object.keys(defaults.env).join(', ')}` : ''),
);

// --ignore-scripts: no native builds can run on device anyway; optional
// native deps (bufferutil, utf-8-validate) fall back to pure JS.
run('npm install --omit=dev --ignore-scripts --no-audit --no-fund', stage);

if (!existsSync(join(stage, 'node_modules', 'telegram'))) {
  throw new Error('staging failed: node_modules/telegram missing');
}
console.log(`\nStaged Node project at ${stage}`);

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
import { createRequire } from 'node:module';
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

// Build-time defaults baked into the APK:
//  - Telegram API ID/hash: identifies the *app* (Telegram expects each app to
//    embed its own), so users only scan a QR code. Release builds: set
//    TELEGRAM_API_ID / TELEGRAM_API_HASH in the build environment (CI secret).
//    Local builds fall back to the desktop addon's user config file
//    (written by `npm run login`, see addon/src/userConfig.ts).
//  - optional addon settings (catalog country, chat ids, ...), same precedence.
// Deliberately NOT bundled: the Telegram session (each device logs in itself),
// host/port/base URLs (TV always serves 127.0.0.1), STREAM_PREFETCH_KB (low RAM).
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
const defaults = {
  apiId: setting('TELEGRAM_API_ID'),
  apiHash: setting('TELEGRAM_API_HASH'),
  env: Object.fromEntries(PASS_THROUGH_ENV.filter((k) => setting(k)).map((k) => [k, setting(k)])),
};
writeFileSync(join(stage, 'defaults.json'), JSON.stringify(defaults));
console.log(
  `Bundled defaults: ${defaults.apiId ? 'Telegram API id/hash' : 'NO Telegram API id (app will ask)'}` +
    (Object.keys(defaults.env).length ? ` + ${Object.keys(defaults.env).join(', ')}` : ''),
);

// --ignore-scripts: no native builds can run on device anyway; optional
// native deps (bufferutil, utf-8-validate) fall back to pure JS.
run('npm install --omit=dev --ignore-scripts --no-audit --no-fund', stage);

if (!existsSync(join(stage, 'node_modules', 'telegram'))) {
  throw new Error('staging failed: node_modules/telegram missing');
}
console.log(`\nStaged Node project at ${stage}`);

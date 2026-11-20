// Build-time defaults.json for the apps that run node-bootstrap/main.js: the
// TV app (bundle-node.mjs) and the PC app (pc-app/scripts/bundle.mjs).
//
// - env: optional addon settings (catalog country, chat ids, ...) from the
//   build environment or the developer's user config file
//   (addon/src/userConfig.ts).
// - starter: the optional starter key, scrambled. First-run setup uses it for
//   a few minutes to fetch each user's own API ID/hash; the addon always runs
//   on the user's own key.
// NOT bundled: host/port/base URLs (the apps always serve 127.0.0.1) and
// STREAM_PREFETCH_KB (each app sets its own).

import { existsSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join } from 'node:path';

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

// Starter key for automatic first-run setup (node-bootstrap/starter-login.js),
// from TELEMEDIA_STARTER_API_ID/_HASH or <signing dir>/starter.properties
// (apiId=…, apiHash=…), kept outside the repo. Without it the apps use the
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

// Scrambled so the key is not plain text in the app (nor found by key
// scanners). Not encryption: the app unscrambles it (starter-login.js).
function scramble(key) {
  if (!key) return undefined;
  const data = Buffer.from(JSON.stringify(key));
  const pad = randomBytes(data.length);
  return Buffer.concat([pad, data.map((b, i) => b ^ pad[i])]).reverse().toString('base64');
}

// addonRoot: the addon folder, already built (dist/ present).
export function bundledDefaults(addonRoot) {
  // Same lookup as the addon itself: environment, then the user config file.
  const { readUserConfig, resolveSetting } = createRequire(import.meta.url)(
    join(addonRoot, 'dist', 'src', 'userConfig.js'),
  );
  const userConfig = readUserConfig();
  const setting = (k) => resolveSetting(k, process.env, userConfig);
  return {
    env: Object.fromEntries(PASS_THROUGH_ENV.filter((k) => setting(k)).map((k) => [k, setting(k)])),
    starter: scramble(starterKey()),
  };
}

export function describeDefaults(defaults) {
  return (defaults.starter
    ? 'Bundled defaults: starter key for automatic setup'
    : 'Bundled defaults: no Telegram credentials (phone setup page)') +
    (Object.keys(defaults.env).length ? ` + ${Object.keys(defaults.env).join(', ')}` : '');
}

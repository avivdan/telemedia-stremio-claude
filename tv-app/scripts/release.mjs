// Build a signed release APK locally — no CI secrets needed.
//
// Run from repo root:  npm run tv:release -- 0.3.0
//
// Signing details come from <signing dir>/signing.properties (outside the repo):
//   storeFile=telemedia-release.jks   (relative to the signing dir)
//   storePassword=…  keyAlias=…  keyPassword=…
// Signing dir: TELEMEDIA_SIGNING_DIR, else ~/Documents/telemedia-signing.
//
// Output: tv-app/release/Telemedia-v<version>.apk (signature verified).
// Optional <signing dir>/starter.properties (apiId=…, apiHash=…) bundles the
// starter key for automatic first-run setup (see bundle-node.mjs).

import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tvApp = join(here, '..');

const version = (process.argv[2] || '').replace(/^v/, '');
if (!/^\d+\.\d+\.\d+$/.test(version)) {
  console.error('Usage: npm run tv:release -- <version>   e.g. 0.3.0');
  process.exit(1);
}

// --- signing ------------------------------------------------------------------
const signingDir = process.env.TELEMEDIA_SIGNING_DIR || join(homedir(), 'Documents', 'telemedia-signing');
const propsPath = join(signingDir, 'signing.properties');
if (!existsSync(propsPath)) {
  console.error(`Missing ${propsPath} (storeFile, storePassword, keyAlias, keyPassword).`);
  process.exit(1);
}
const props = Object.fromEntries(
  readFileSync(propsPath, 'utf8')
    .split(/\r?\n/)
    .filter((l) => l.trim() && !l.trim().startsWith('#'))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
const keystore = resolve(signingDir, props.storeFile || 'telemedia-release.jks');
if (!existsSync(keystore)) {
  console.error(`Keystore not found: ${keystore}`);
  process.exit(1);
}

// --- toolchain (same fallbacks as deploy.mjs) ------------------------------------
const env = {
  ...process.env,
  TELEMEDIA_VERSION: version,
  TELEMEDIA_KEYSTORE: keystore,
  TELEMEDIA_KEYSTORE_PASSWORD: props.storePassword,
  TELEMEDIA_KEY_ALIAS: props.keyAlias,
  TELEMEDIA_KEY_PASSWORD: props.keyPassword,
};
const localAndroid = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Android') : '';
const isJdk = (p) => p && existsSync(join(p, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
const isSdk = (p) => p && existsSync(join(p, 'platforms'));
if (!isJdk(env.JAVA_HOME) && isJdk(join(localAndroid, 'jdk-17'))) env.JAVA_HOME = join(localAndroid, 'jdk-17');
if (!isSdk(env.ANDROID_HOME) && isSdk(join(localAndroid, 'Sdk'))) env.ANDROID_HOME = join(localAndroid, 'Sdk');

const run = (cmd, opts = {}) => {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', ...opts });
};

// --- build ---------------------------------------------------------------------
run(`node "${join(here, 'bundle-node.mjs')}"`);
const gradlew = join(tvApp, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
run(`"${gradlew}" assembleRelease --console=plain -q`, { cwd: tvApp, env });

const built = join(tvApp, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
const outDir = join(tvApp, 'release');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `Telemedia-v${version}.apk`);
copyFileSync(built, out);

// --- verify signature --------------------------------------------------------------
const buildTools = join(env.ANDROID_HOME, 'build-tools');
const latest = readdirSync(buildTools).sort().at(-1);
const apksigner = join(buildTools, latest, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner');
const certs = execSync(`"${apksigner}" verify --print-certs "${out}"`, { env, encoding: 'utf8' });
console.log('\n' + certs.split(/\r?\n/).filter((l) => /certificate (DN|SHA-256)/.test(l)).join('\n'));
console.log(`\nRelease APK: ${out}`);

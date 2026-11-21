// Build a signed release APK locally.
//
// Run:  npm run release -- 0.1.0
//
// Signing: <signing dir>/signing.properties + the keystore (see
// toolchain.mjs); the same key as the TV app. Optional in the same folder:
// starter.properties (starter key, bundled scrambled) and groups.txt
// (head-start groups), see bundle-node.mjs.
//
// Output: release/Telemedia-Phone-v<version>.apk (signature verified).
// With a starter key inside, share the APK privately.

import { execSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEnv } from './toolchain.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');

const version = (process.argv[2] || '').replace(/^v/, '');
if (!/^\d+\.\d{1,2}\.\d{1,2}$/.test(version)) {
  console.error('Usage: npm run release -- <version>   e.g. 0.1.0');
  process.exit(1);
}

const env = { ...buildEnv({ requireSigning: true }), TELEMEDIA_VERSION: version };
const run = (cmd, opts = {}) => {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', ...opts });
};

run(`node "${join(here, 'bundle-node.mjs')}"`, { env });
const gradlew = join(root, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
run(`"${gradlew}" assembleRelease --console=plain -q`, { cwd: root, env });

const built = join(root, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
const outDir = join(root, 'release');
mkdirSync(outDir, { recursive: true });
const out = join(outDir, `Telemedia-Phone-v${version}.apk`);
copyFileSync(built, out);

// --- verify signature --------------------------------------------------------------
const buildTools = join(env.ANDROID_HOME, 'build-tools');
const latest = readdirSync(buildTools).sort().at(-1);
const apksigner = join(buildTools, latest, process.platform === 'win32' ? 'apksigner.bat' : 'apksigner');
const certs = execSync(`"${apksigner}" verify --print-certs "${out}"`, { env, encoding: 'utf8' });
console.log('\n' + certs.split(/\r?\n/).filter((l) => /certificate (DN|SHA-256)/.test(l)).join('\n'));
console.log(`\nRelease APK: ${out}`);

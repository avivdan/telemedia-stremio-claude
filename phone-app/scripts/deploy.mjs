// One-shot for development: bundle the addon, build the APK, install it on
// the phone over adb, restart the app and wait until it reports its state.
//
// Run:
//   npm run deploy                          (PHONE_ADB_SERIAL or the only adb device)
//   npm run deploy -- 192.168.0.50:41234    (wireless debugging address)
//
// Signed with the release key when the signing folder has one (see
// toolchain.mjs), so deploys and release APKs can replace each other.

import { execSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEnv } from './toolchain.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const apk = join(root, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
const PKG = 'com.telemedia.phone';

const run = (cmd, opts = {}) => {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', ...opts });
};
const capture = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();

const env = buildEnv();

// --- device ------------------------------------------------------------------
let serial = process.argv[2] || process.env.PHONE_ADB_SERIAL || '';
if (serial && /:\d+$/.test(serial)) console.log(capture(`adb connect ${serial}`));
if (!serial) {
  const devices = capture('adb devices')
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.split(/\s+/))
    .filter(([, state]) => state === 'device')
    .map(([id]) => id);
  if (devices.length !== 1) {
    throw new Error(`Expected exactly one adb device, found ${devices.length}. Pass one: npm run deploy -- <ip:port>`);
  }
  serial = devices[0];
}
const adb = (args) => `adb -s ${serial} ${args}`;

// Same version as the one installed (e.g. a release), so the deploy can
// replace it: Android refuses a lower versionCode.
try {
  const installed = (capture(adb(`shell dumpsys package ${PKG}`)).match(/versionName=(\d+\.\d+\.\d+)/) || [])[1];
  if (installed && !env.TELEMEDIA_VERSION) {
    env.TELEMEDIA_VERSION = installed;
    console.log(`Building as version ${installed} (installed on the phone)`);
  }
} catch {
  // not installed yet
}

// --- build -------------------------------------------------------------------
run(`node "${join(here, 'bundle-node.mjs')}"`, { env });
// Absolute path: cmd.exe may not search the cwd (NoDefaultCurrentDirectoryInExePath).
const gradlew = join(root, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
run(`"${gradlew}" assembleRelease --console=plain -q`, { cwd: root, env });

// --- install + restart -------------------------------------------------------
run(adb(`install -r "${apk}"`));
run(adb('logcat -c'));
run(adb(`shell am force-stop ${PKG}`));
run(adb(`shell am start -n ${PKG}/.MainActivity`));

// --- wait for the app's state ---------------------------------------------------
console.log('\nWaiting for the addon service (first run after an update unpacks the bundle)...');
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  const log = spawnSync('adb', ['-s', serial, 'logcat', '-d', '-s', 'TelemediaNode'], { encoding: 'utf8' }).stdout;
  const last = [...log.matchAll(/\[bootstrap\] state=(\w+)/g)].map((m) => m[1]).at(-1);
  if (last === 'running') {
    console.log('Addon running on the phone: http://127.0.0.1:7000/manifest.json');
    process.exit(0);
  }
  if (last === 'error' || last === 'need_login' || last === 'need_config') {
    console.log(log.split(/\r?\n/).slice(-25).join('\n'));
    console.log(`\nApp state: ${last}${last === 'need_login' ? ' (log in on the phone)' : ''}`);
    process.exit(last === 'error' ? 1 : 0);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
console.error(`Timed out. Logs: adb -s ${serial} logcat -s TelemediaNode`);
process.exit(1);

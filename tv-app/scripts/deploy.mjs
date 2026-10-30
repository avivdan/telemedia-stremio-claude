// One-shot: rebuild the addon, build the APK, install it on the TV, restart
// the app and wait until the addon reports it's running.
//
// Run from repo root:
//   npm run tv:deploy                         (uses TV_ADB_SERIAL or the only adb device)
//   npm run tv:deploy -- 192.168.0.114:5555   (explicit device)
//
// Toolchain: uses JAVA_HOME / ANDROID_HOME if they point at a JDK / full SDK,
// otherwise falls back to %LOCALAPPDATA%\Android\{jdk-17,Sdk}.

import { execSync, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const androidDir = join(here, '..');
const apk = join(androidDir, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
const PKG = 'com.telemedia.tv';

const run = (cmd, opts = {}) => {
  console.log(`\n> ${cmd}`);
  execSync(cmd, { stdio: 'inherit', ...opts });
};
const capture = (cmd) => execSync(cmd, { encoding: 'utf8' }).trim();

// --- toolchain ---------------------------------------------------------------
const env = { ...process.env };
const localAndroid = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Android') : '';
const isJdk = (p) => p && existsSync(join(p, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
const isSdk = (p) => p && existsSync(join(p, 'platforms'));
if (!isJdk(env.JAVA_HOME) && isJdk(join(localAndroid, 'jdk-17'))) env.JAVA_HOME = join(localAndroid, 'jdk-17');
if (!isSdk(env.ANDROID_HOME) && isSdk(join(localAndroid, 'Sdk'))) env.ANDROID_HOME = join(localAndroid, 'Sdk');
if (!isJdk(env.JAVA_HOME)) throw new Error('No JDK found: set JAVA_HOME (JDK 17).');
if (!isSdk(env.ANDROID_HOME)) throw new Error('No Android SDK found: set ANDROID_HOME.');

// --- device ------------------------------------------------------------------
let serial = process.argv[2] || process.env.TV_ADB_SERIAL || '';
if (serial && /:\d+$/.test(serial)) {
  console.log(capture(`adb connect ${serial}`));
}
if (!serial) {
  const devices = capture('adb devices')
    .split(/\r?\n/)
    .slice(1)
    .map((l) => l.split(/\s+/))
    .filter(([, state]) => state === 'device')
    .map(([id]) => id);
  if (devices.length !== 1) {
    throw new Error(
      `Expected exactly one adb device, found ${devices.length}. ` +
        'Pass one: npm run tv:deploy -- <ip:port>',
    );
  }
  serial = devices[0];
}
const adb = (args) => `adb -s ${serial} ${args}`;

// --- build -------------------------------------------------------------------
run(`node "${join(here, 'bundle-node.mjs')}"`);
// Absolute path: cmd.exe may not search the cwd (NoDefaultCurrentDirectoryInExePath).
const gradlew = join(androidDir, process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
run(`"${gradlew}" assembleRelease --console=plain -q`, { cwd: androidDir, env });

// --- install + restart -------------------------------------------------------
run(adb(`install -r "${apk}"`));
run(adb('logcat -c'));
run(adb(`shell am force-stop ${PKG}`));
run(adb(`shell am start -n ${PKG}/.MainActivity`));

// --- wait for the addon ------------------------------------------------------
console.log('\nWaiting for addon to start (first run after update unpacks the bundle)...');
const deadline = Date.now() + 120_000;
while (Date.now() < deadline) {
  const log = spawnSync('adb', ['-s', serial, 'logcat', '-d', '-s', 'TelemediaNode'], {
    encoding: 'utf8',
  }).stdout;
  const states = [...log.matchAll(/\[bootstrap\] state=(\w+)/g)].map((m) => m[1]);
  const last = states.at(-1);
  if (last === 'running') {
    console.log('Addon running on the TV: http://127.0.0.1:7000/manifest.json');
    process.exit(0);
  }
  if (last === 'error' || last === 'qr' || last === 'need_config') {
    console.log(log.split(/\r?\n/).slice(-25).join('\n'));
    console.log(`\nApp state: ${last}${last === 'qr' ? ' (scan the QR code on the TV)' : ''}`);
    process.exit(last === 'error' ? 1 : 0);
  }
  await new Promise((r) => setTimeout(r, 2000));
}
console.error(`Timed out. Logs: adb -s ${serial} logcat -s TelemediaNode`);
process.exit(1);

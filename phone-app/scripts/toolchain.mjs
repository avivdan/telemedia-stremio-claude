// Shared by deploy.mjs and release.mjs: JDK / Android SDK lookup and the
// release signing key, so every build is signed the same way (a phone can't
// update between differently signed builds without an uninstall).
//
// Signing folder: TELEMEDIA_SIGNING_DIR, else ~/Documents/telemedia-signing,
// with signing.properties (outside the repo):
//   storeFile=telemedia-release.jks   (relative to the signing folder)
//   storePassword=…  keyAlias=…  keyPassword=…

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export const signingDir = () =>
  process.env.TELEMEDIA_SIGNING_DIR || join(homedir(), 'Documents', 'telemedia-signing');

// The starter key in defaults.json, in the same format as
// tv-app/scripts/bundle-node.mjs: not plain text in the APK (nor found by key
// scanners). Not encryption: the app unscrambles it (unscramble() in the TV
// app's starter-login.js).
export function scramble(key) {
  if (!key) return undefined;
  const data = Buffer.from(JSON.stringify(key));
  const pad = randomBytes(data.length);
  return Buffer.concat([pad, data.map((b, i) => b ^ pad[i])]).reverse().toString('base64');
}

export function readProperties(file) {
  return Object.fromEntries(
    readFileSync(file, 'utf8')
      .split(/\r?\n/)
      .filter((l) => l.includes('=') && !l.trim().startsWith('#'))
      .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
  );
}

// Build environment: JAVA_HOME / ANDROID_HOME (falling back to
// %LOCALAPPDATA%\Android\{jdk-17,Sdk}) and, if the signing folder has one,
// the release key. requireSigning: fail instead of using the debug key.
export function buildEnv({ requireSigning = false } = {}) {
  const env = { ...process.env };
  const localAndroid = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'Android') : '';
  const isJdk = (p) => p && existsSync(join(p, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'));
  const isSdk = (p) => p && existsSync(join(p, 'platforms'));
  if (!isJdk(env.JAVA_HOME) && isJdk(join(localAndroid, 'jdk-17'))) env.JAVA_HOME = join(localAndroid, 'jdk-17');
  if (!isSdk(env.ANDROID_HOME) && isSdk(join(localAndroid, 'Sdk'))) env.ANDROID_HOME = join(localAndroid, 'Sdk');
  if (!isJdk(env.JAVA_HOME)) throw new Error('No JDK found: set JAVA_HOME (JDK 17).');
  if (!isSdk(env.ANDROID_HOME)) throw new Error('No Android SDK found: set ANDROID_HOME.');

  const propsPath = join(signingDir(), 'signing.properties');
  if (existsSync(propsPath)) {
    const props = readProperties(propsPath);
    const keystore = resolve(signingDir(), props.storeFile || 'telemedia-release.jks');
    if (!existsSync(keystore)) throw new Error(`Keystore not found: ${keystore}`);
    Object.assign(env, {
      TELEMEDIA_KEYSTORE: keystore,
      TELEMEDIA_KEYSTORE_PASSWORD: props.storePassword,
      TELEMEDIA_KEY_ALIAS: props.keyAlias,
      TELEMEDIA_KEY_PASSWORD: props.keyPassword,
    });
  } else if (requireSigning) {
    throw new Error(`Missing ${propsPath} (storeFile, storePassword, keyAlias, keyPassword).`);
  } else {
    console.log(`No ${propsPath}: signing with the debug key.`);
  }
  return env;
}

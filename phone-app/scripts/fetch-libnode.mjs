// Download the nodejs-mobile Android runtime into app/libnode/.
//
// Run:               npm run libnode
// Override version:  NODEJS_MOBILE_VERSION=18.20.4 npm run libnode
//
// Result layout (what CMakeLists.txt and app/build.gradle.kts expect):
//   app/libnode/bin/<abi>/libnode.so
//   app/libnode/include/node/*.h

import { execSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.env.NODEJS_MOBILE_VERSION ?? '18.20.4';
const name = `nodejs-mobile-v${version}-android.zip`;
const url = `https://github.com/nodejs-mobile/nodejs-mobile/releases/download/v${version}/${name}`;

const here = dirname(fileURLToPath(import.meta.url));
const dest = join(here, '..', 'app', 'libnode');
const zipPath = join(here, '..', 'node-staging', name);
// The TV app downloads the same file: reuse it if it's there.
const tvZip = join(here, '..', '..', 'telemedia-stremio-claude', 'tv-app', 'node-staging', name);

mkdirSync(dirname(zipPath), { recursive: true });

if (!existsSync(zipPath) && existsSync(tvZip)) {
  console.log(`Using ${tvZip}`);
  copyFileSync(tvZip, zipPath);
}
if (!existsSync(zipPath)) {
  console.log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  writeFileSync(zipPath, Buffer.from(await res.arrayBuffer()));
}

rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

// bsdtar (Windows 10+, macOS) extracts zip; fall back to unzip on Linux.
try {
  execSync(`tar -xf "${zipPath}" -C "${dest}"`, { stdio: 'inherit' });
} catch {
  execSync(`unzip -q "${zipPath}" -d "${dest}"`, { stdio: 'inherit' });
}

for (const abi of ['arm64-v8a', 'armeabi-v7a']) {
  const probe = join(dest, 'bin', abi, 'libnode.so');
  if (!existsSync(probe)) {
    throw new Error(
      `Expected ${probe} after extraction. The release zip layout may have ` +
        `changed: move its bin/ and include/ folders directly under app/libnode/.`,
    );
  }
}
console.log(`libnode ${version} ready in ${dest}`);

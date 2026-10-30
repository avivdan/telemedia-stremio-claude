// Download the nodejs-mobile Android runtime into tv-app/app/libnode/.
//
// Run from repo root:  npm run tv:libnode
// Override version:    NODEJS_MOBILE_VERSION=18.20.4 npm run tv:libnode
//
// Result layout (what CMakeLists.txt and build.gradle.kts expect):
//   app/libnode/bin/<abi>/libnode.so
//   app/libnode/include/node/*.h

import { execSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const version = process.env.NODEJS_MOBILE_VERSION ?? '18.20.4';
const url =
  `https://github.com/nodejs-mobile/nodejs-mobile/releases/download/` +
  `v${version}/nodejs-mobile-v${version}-android.zip`;

const here = dirname(fileURLToPath(import.meta.url));
const dest = join(here, '..', 'app', 'libnode');
const zipPath = join(here, '..', 'node-staging', `nodejs-mobile-v${version}-android.zip`);

mkdirSync(dirname(zipPath), { recursive: true });

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

// armeabi-v7a matters: many TV boxes (e.g. HOT Streamer V3) run a 32-bit userspace.
for (const abi of ['arm64-v8a', 'armeabi-v7a']) {
  const probe = join(dest, 'bin', abi, 'libnode.so');
  if (!existsSync(probe)) {
    throw new Error(
      `Expected ${probe} after extraction. The release zip layout may have ` +
        `changed — move its bin/ and include/ folders directly under app/libnode/.`,
    );
  }
}
console.log(`libnode ${version} ready in ${dest}`);

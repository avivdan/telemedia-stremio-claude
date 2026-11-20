// Builds Telemedia for Windows.
//
//   npm run build      → stage/ (the installed layout; run stage\Telemedia.exe)
//   npm run dist       → stage/ + release/Telemedia-Setup-X.Y.Z.exe
//
// stage/
//   Telemedia.exe + WebView2 DLLs     shell/ (C#, .NET Framework 4.8)
//   node/node.exe                     Node.js runtime (nodejs.org, checksum-verified)
//   node/main.js                      tv-app/node-bootstrap, bundled (esbuild)
//   node/dist/src/index.js            the addon, bundled (esbuild)
//   node/defaults.json                addon settings + scrambled starter key
//   ui/                               the window's page; app.js bundled with qrcode
//
// Needs: Node 20+, the .NET SDK (dotnet), internet for the first build.

import { execFileSync, execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';
import { bundledDefaults, describeDefaults } from '../../tv-app/scripts/defaults.mjs';

const NODE_VERSION = 'v24.22.2'; // LTS; the addon is tested on Node 24

const here = dirname(fileURLToPath(import.meta.url));
const pc = join(here, '..');
const repo = join(pc, '..');
const addonRoot = join(repo, 'addon');
const stage = join(pc, 'stage');
const cache = join(pc, '.cache');
const version = JSON.parse(readFileSync(join(pc, 'package.json'), 'utf8')).version;
const dist = process.argv.includes('--dist');

const run = (cmd, cwd) => {
  console.log(`> ${cmd}  (${cwd})`);
  execSync(cmd, { cwd, stdio: 'inherit' });
};
const mb = (file) => (statSync(file).size / 1048576).toFixed(1) + ' MB';

// 1. The Node part ---------------------------------------------------------
run('npm run build', addonRoot);
rmSync(stage, { recursive: true, force: true });
mkdirSync(join(stage, 'node'), { recursive: true });
mkdirSync(cache, { recursive: true });

const nodeBundle = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'cjs',
  minifySyntax: true,
  minifyWhitespace: true,
  legalComments: 'linked',
  // The bootstrap requires 'telegram' without having node_modules itself.
  nodePaths: [join(addonRoot, 'node_modules')],
  // bufferutil / utf-8-validate (websocket) get bundled too: without their
  // native builds they use their own plain-JS fallback.
  logLevel: 'warning',
  logOverride: { 'unsupported-require-call': 'silent' }, // main.js loads the addon by path on purpose
};
await esbuild.build({
  ...nodeBundle,
  entryPoints: [join(repo, 'tv-app', 'node-bootstrap', 'main.js')],
  outfile: join(stage, 'node', 'main.js'),
});
await esbuild.build({
  ...nodeBundle,
  entryPoints: [join(addonRoot, 'dist', 'src', 'index.js')],
  outfile: join(stage, 'node', 'dist', 'src', 'index.js'),
});
// The bundles are CommonJS, whatever folder the stage sits in.
writeFileSync(join(stage, "node", "package.json"), JSON.stringify({ type: "commonjs", private: true }));
const defaults = bundledDefaults(addonRoot);
writeFileSync(join(stage, 'node', 'defaults.json'), JSON.stringify(defaults));
console.log(describeDefaults(defaults));

// 2. node.exe ---------------------------------------------------------------
const nodeExe = join(cache, `node-${NODE_VERSION}-win-x64.exe`);
if (!existsSync(nodeExe)) {
  const base = `https://nodejs.org/dist/${NODE_VERSION}`;
  console.log(`Downloading node.exe ${NODE_VERSION} from nodejs.org`);
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const expected = (sums.split('\n').find((l) => l.endsWith(' win-x64/node.exe')) || '').split(/\s+/)[0];
  if (!/^[0-9a-f]{64}$/.test(expected)) throw new Error('node.exe checksum not found in SHASUMS256.txt');
  const res = await fetch(`${base}/win-x64/node.exe`);
  if (!res.ok) throw new Error(`node.exe download failed: HTTP ${res.status}`);
  const bytes = Buffer.from(await res.arrayBuffer());
  const actual = createHash('sha256').update(bytes).digest('hex');
  if (actual !== expected) throw new Error('node.exe checksum mismatch: download refused');
  writeFileSync(nodeExe, bytes);
}
copyFileSync(nodeExe, join(stage, 'node', 'node.exe'));

// 3. The window's page --------------------------------------------------------
mkdirSync(join(stage, 'ui'), { recursive: true });
await esbuild.build({
  entryPoints: [join(pc, 'ui', 'app.js')],
  outfile: join(stage, 'ui', 'app.js'),
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'chrome120',
  minify: true,
  legalComments: 'linked',
  logLevel: 'warning',
});
for (const f of ['index.html', 'style.css']) copyFileSync(join(pc, 'ui', f), join(stage, 'ui', f));

// 4. Telemedia.exe ------------------------------------------------------------
const shellOut = join(cache, 'shell-out');
rmSync(shellOut, { recursive: true, force: true });
run(`dotnet build Telemedia.csproj -c Release -nologo -v q -p:Version=${version} -o "${shellOut}"`, join(pc, 'shell'));
const shellFiles = [
  'Telemedia.exe', 'Telemedia.exe.config',
  'Microsoft.Web.WebView2.Core.dll', 'Microsoft.Web.WebView2.WinForms.dll', 'WebView2Loader.dll',
];
for (const f of shellFiles) {
  if (!existsSync(join(shellOut, f))) throw new Error(`shell build: ${f} missing`);
  copyFileSync(join(shellOut, f), join(stage, f));
}

const total = (dir) => readdirSync(dir, { withFileTypes: true })
  .reduce((n, e) => n + (e.isDirectory() ? total(join(dir, e.name)) : statSync(join(dir, e.name)).size), 0);
console.log(`\nStaged ${(total(stage) / 1048576).toFixed(0)} MB at ${stage}`);
console.log(`  node.exe ${mb(join(stage, 'node', 'node.exe'))}, addon ${mb(join(stage, 'node', 'dist', 'src', 'index.js'))}, bootstrap ${mb(join(stage, 'node', 'main.js'))}`);

if (!dist) process.exit(0);

// 5. Setup.exe ------------------------------------------------------------------
const payload = join(cache, 'payload.zip');
rmSync(payload, { force: true });
execFileSync('powershell', ['-NoProfile', '-Command',
  `Add-Type -AssemblyName System.IO.Compression.FileSystem; ` +
  `[System.IO.Compression.ZipFile]::CreateFromDirectory('${stage}', '${payload}', 'Optimal', $false)`,
], { stdio: 'inherit' });
const setupOut = join(cache, 'setup-out');
rmSync(setupOut, { recursive: true, force: true });
run(`dotnet build Setup.csproj -c Release -nologo -v q -p:Version=${version} -p:PayloadZip="${payload}" -o "${setupOut}"`, join(pc, 'setup'));
const release = join(pc, 'release');
mkdirSync(release, { recursive: true });
const setupExe = join(release, `Telemedia-Setup-${version}.exe`);
copyFileSync(join(setupOut, 'Telemedia-Setup.exe'), setupExe);
console.log(`\nInstaller: ${setupExe} (${mb(setupExe)})`);

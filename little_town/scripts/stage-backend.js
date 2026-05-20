// Town Inbox — stage a copy of ../backend into release/backend with
// better-sqlite3 rebuilt against Electron's ABI.
//
// We can't rebuild in-place against ../backend because that would
// break the user's normal `cd backend && npm run dev` workflow
// (plain Node 22 can't load the Electron-ABI binding). Instead:
//   1. Copy ../backend → release/backend (excluding node_modules/.cache
//      and the user's .env / tokens — they're added in step 2 only if
//      explicitly chosen).
//   2. Re-resolve node_modules: easier to npm-install fresh in the
//      staging dir, but slower; quicker is to copy node_modules across
//      and then run electron-rebuild against the staging path.
//   3. Run electron-rebuild against release/backend.
//
// electron-packager picks up release/backend via --extra-resource so
// the packaged app's resources/backend/ has the Electron-ABI binding.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(__dirname, '..', '..', 'backend');
const DEST = path.resolve(__dirname, '..', 'release', 'backend');

console.log(`[stage-backend] ${SRC} → ${DEST}`);

if (fs.existsSync(DEST)) {
  console.log('[stage-backend] removing previous staged copy');
  fs.rmSync(DEST, { recursive: true, force: true });
}
fs.mkdirSync(DEST, { recursive: true });

// Recursive copy, skipping noise.
function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (entry.name === 'node_modules' && src === SRC) continue;        // handled separately below
    if (entry.name === '.cache') continue;
    if (entry.name === '.DS_Store') continue;
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}
copyDir(SRC, DEST);

// node_modules — copy in one go (faster than npm install fresh).
const SRC_NM = path.join(SRC, 'node_modules');
const DEST_NM = path.join(DEST, 'node_modules');
if (fs.existsSync(SRC_NM)) {
  console.log('[stage-backend] copying node_modules');
  copyDir(SRC_NM, DEST_NM);
} else {
  console.warn('[stage-backend] no node_modules in source backend — run `cd backend && npm install` first');
}

// Resolve the Electron version we're packaging for so prebuild-install
// can grab a binary matching that ABI. Read it from little_town's own
// node_modules/electron/package.json — single source of truth, no
// drift if we later upgrade.
const electronPkg = JSON.parse(fs.readFileSync(
  path.resolve(__dirname, '..', 'node_modules', 'electron', 'package.json'),
  'utf-8',
));
const electronVersion = electronPkg.version;
console.log(`[stage-backend] target Electron version: ${electronVersion}`);

// Rebuild better-sqlite3 by invoking its own prebuild-install with
// --runtime=electron. @electron/rebuild was reporting success but
// silently NOT replacing the binary — direct invocation works.
const pkgDir = path.join(DEST, 'node_modules', 'better-sqlite3');
const prebuildBin = path.join(pkgDir, '..', '.bin', process.platform === 'win32' ? 'prebuild-install.cmd' : 'prebuild-install');
console.log('[stage-backend] fetching Electron-ABI prebuild for better-sqlite3');
const pi = spawnSync(prebuildBin, [
  '--runtime=electron',
  `--target=${electronVersion}`,
  `--arch=${process.arch}`,
  `--platform=${process.platform}`,
  '--force',
], { stdio: 'inherit', cwd: pkgDir, shell: true });
if (pi.status !== 0) {
  console.error(`[stage-backend] prebuild-install failed (status=${pi.status}, error=${pi.error?.message})`);
  process.exit(pi.status || 1);
}
console.log('[stage-backend] done');

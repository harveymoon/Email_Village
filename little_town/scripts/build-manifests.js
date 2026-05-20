// Town Inbox — generate manifest.json for each character_builder layer.
//
// The renderer's avatar system (src/avatar.ts → loadManifest) fetches
// `assets/character_builder/<layer>/manifest.json` to discover the
// available .png files for body, eyes, outfits, hairstyles, accessories.
// We generate those manifests at build-time so the dist/ folder always
// has them, no manual curation needed.
//
// Wired into package.json as `prebuild` so `vite build` always sees
// fresh manifests before copying public/ into dist/.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..', 'public', 'assets', 'character_builder');
const LAYERS = ['bodies', 'eyes', 'outfits', 'hairstyles', 'accessories'];

let totalFiles = 0;
for (const layer of LAYERS) {
  const dir = path.join(ROOT, layer);
  if (!fs.existsSync(dir)) {
    console.warn(`[manifests] skipping ${layer}: ${dir} not found`);
    continue;
  }
  const pngs = fs.readdirSync(dir)
    .filter(f => f.toLowerCase().endsWith('.png'))
    .sort();
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(pngs, null, 2));
  console.log(`[manifests] ${layer}: ${pngs.length} entries`);
  totalFiles += pngs.length;
}
console.log(`[manifests] total: ${totalFiles} layer files indexed`);

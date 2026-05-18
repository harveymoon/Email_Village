// Standalone character builder UI. Self-contained ES module — mountable
// into any container. Same code path is used by:
//
//   - public/character-builder.html (sandbox)
//   - the game's character-picker popup (TBD: imported from main.ts)
//
// The mount function builds the entire DOM inside the supplied container,
// loads its own asset manifests, and returns a handle the caller can use
// to read the current selection or tear the UI down.
//
// Assets live at public/assets/character_builder/<layer>/ and each layer
// folder ships a manifest.json listing every PNG file.

const CELL_W = 48;
const CELL_H = 96;
const PREVIEW_SCALE = 2;          // 48*2 wide × 96*2 tall per direction
const MAX_VARIANT_SCAN = 60;      // fallback when no manifest is present

// Confirmed sprite-row layout (zero-indexed 96-px sprite rows). Each
// preset declares which directions exist in that row, IN ORDER — column
// offset for direction d is dirs.indexOf(d) * framesPerDir.
const PRESETS = {
  stand: { row: 0, framesPerDir: 1, startCol: 0, fps: 1,  dirs: ['right', 'up', 'left', 'down'] },
  idle:  { row: 1, framesPerDir: 6, startCol: 0, fps: 6,  dirs: ['right', 'up', 'left', 'down'] },
  walk:  { row: 2, framesPerDir: 6, startCol: 0, fps: 10, dirs: ['right', 'up', 'left', 'down'] },
  sit:   { row: 4, framesPerDir: 6, startCol: 0, fps: 4,  dirs: ['right', 'left'] },
};
const MOVEMENT_ORDER = ['stand', 'idle', 'walk', 'sit'];

// Z-order = array order. Body required, others optional. Same set is
// surfaced as a row of radio-style nav buttons at the top.
const LAYERS = [
  { key: 'body',      label: 'Body',      folder: 'bodies',      prefix: 'Body',      required: true  },
  { key: 'eyes',      label: 'Eyes',      folder: 'eyes',        prefix: 'Eyes',      required: false },
  { key: 'outfit',    label: 'Outfit',    folder: 'outfits',     prefix: 'Outfit',    required: false },
  { key: 'hairstyle', label: 'Hairstyle', folder: 'hairstyles',  prefix: 'Hairstyle', required: false },
  { key: 'accessory', label: 'Accessory', folder: 'accessories', prefix: 'Accessory', required: false },
];
const layerByKey = Object.fromEntries(LAYERS.map(l => [l.key, l]));

// Discovered variants cached across mounts so reopening is instant.
const variantCache = {};

function tryLoadImage(src) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

// "Hairstyle_07_48x48_03.png" → "07.03"
// "Body_48x48_05.png"          → "05"
// "Accessory_02_Bee_48x48_01.png" → "02 Bee.01"
function prettifyVariantId(prefix, filename) {
  const stem = filename.replace(/\.png$/i, '');
  let rest = stem.startsWith(prefix + '_') ? stem.slice(prefix.length + 1) : stem;
  const m = rest.match(/^(.*)_48x48_(\d+)$/);
  if (m) {
    const lead = m[1].replace(/_/g, ' ').trim();
    return lead ? `${lead}.${m[2]}` : m[2];
  }
  return rest;
}

async function discoverLayer(layer, assetsBase) {
  if (variantCache[layer.key]) return variantCache[layer.key];
  let files = null;
  try {
    const resp = await fetch(`${assetsBase}/${layer.folder}/manifest.json`);
    if (resp.ok) files = await resp.json();
  } catch { /* manifest missing — fall through to scan */ }
  const candidates = [];
  if (Array.isArray(files) && files.length) {
    for (const fname of files) {
      candidates.push({
        id: prettifyVariantId(layer.prefix, fname),
        file: `${assetsBase}/${layer.folder}/${fname}`,
      });
    }
  } else {
    for (let i = 1; i <= MAX_VARIANT_SCAN; i++) {
      const n = String(i).padStart(2, '0');
      candidates.push({ id: n, file: `${assetsBase}/${layer.folder}/${layer.prefix}_48x48_${n}.png` });
    }
  }
  const results = await Promise.all(candidates.map(c =>
    tryLoadImage(c.file).then(img => img ? { ...c, img } : null)
  ));
  const found = results.filter(Boolean);
  variantCache[layer.key] = found;
  return found;
}

// All styles live here so the host page only needs a single <style> tag
// (or none at all — the game popup can rely on this). Scoped via a unique
// root class so we don't bleed into the page or any nearby UI.
const CSS = `
.cb-root {
  --cb-bg: #161616;
  --cb-panel: #161616;
  --cb-border: #2a2a2a;
  --cb-fg: #eee;
  --cb-muted: #888;
  --cb-accent-bg: #1f3a5f;
  --cb-accent-fg: #fff;
  --cb-accent-border: #2c5688;
  background: #0a0a0a; color: var(--cb-fg);
  font: 14px ui-sans-serif, system-ui, sans-serif;
  /* Two equal-height rows: top = controls + preview, bottom = variant grid. */
  display: grid; grid-template-rows: 1fr 1fr;
  gap: 12px; padding: 12px;
  min-height: 0; height: 100%;
  box-sizing: border-box;
}
.cb-root *, .cb-root *::before, .cb-root *::after { box-sizing: border-box; }
.cb-top {
  /* Left column auto-sizes to its content (buttons + summary), preview takes the rest. */
  display: grid; grid-template-columns: 240px 1fr;
  gap: 12px; min-height: 0;
}
.cb-panel {
  background: var(--cb-panel); border: 1px solid var(--cb-border);
  border-radius: 8px; padding: 12px 14px;
  overflow: auto; display: flex; flex-direction: column; min-height: 0;
}
.cb-stage { display: flex; flex-direction: column; gap: 10px; min-height: 0; }
.cb-nav-label {
  margin: 0 0 6px 0;
  font: 600 11px ui-monospace, Consolas, monospace;
  color: #aaa; text-transform: uppercase; letter-spacing: 0.08em;
}
.cb-nav-label + .cb-nav-label,
.cb-nav-label:not(:first-child) { margin-top: 10px; }
.cb-row { display: flex; flex-wrap: wrap; gap: 4px; margin-bottom: 8px; }
.cb-row button {
  flex: 1 1 auto;
  background: #222; color: #ccc; border: 1px solid #333;
  padding: 5px 8px; border-radius: 5px; cursor: pointer;
  font: 600 11px ui-sans-serif, system-ui, sans-serif;
}
.cb-row button:hover { background: #2a2a2a; }
.cb-row button.active {
  background: var(--cb-accent-bg); color: var(--cb-accent-fg);
  border-color: var(--cb-accent-border);
}
.cb-row.cb-movement button { padding: 6px 14px; font-size: 12px; }
.cb-summary {
  background: #0b0b0b; border: 1px solid var(--cb-border); border-radius: 6px;
  padding: 8px 10px; margin-bottom: 10px;
  font: 11px ui-monospace, Consolas, monospace; color: #ccc;
  display: flex; flex-direction: column; gap: 4px;
}
.cb-summary .line { display: flex; justify-content: space-between; align-items: center; gap: 8px; }
.cb-summary .ln { color: var(--cb-muted); }
.cb-summary .pk { color: #cfe; }
.cb-summary .pk.empty { color: #555; font-style: italic; }
.cb-summary button.clear {
  background: transparent; color: #888; border: 1px solid #333;
  border-radius: 3px; padding: 1px 6px; font-size: 10px; cursor: pointer;
}
.cb-summary button.clear:hover { color: #fcc; border-color: #5a2a2a; }
/* Variant grid — fills the bottom half of the avatar pane.
   auto-fill with a minmax track wraps cleanly at any width. */
.cb-list {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(64px, 1fr));
  gap: 8px; padding: 12px;
  overflow-y: auto; min-height: 0;
  background: var(--cb-panel); border: 1px solid var(--cb-border);
  border-radius: 8px;
  align-content: start;
}
.cb-thumb {
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  padding: 6px; border-radius: 6px;
  cursor: pointer; border: 1px solid transparent;
}
.cb-thumb:hover { background: #1f2937; }
.cb-thumb.selected { border-color: #9cf; background: #1f2937; }
.cb-thumb canvas {
  width: 48px; height: 96px;
  background: #0b0b0b; border: 1px solid #333;
  image-rendering: pixelated;
}
.cb-thumb .name {
  font: 600 10px ui-monospace, Consolas, monospace;
  color: #cfe; text-align: center;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  max-width: 100%;
}
.cb-thumb.deselectable { /* hover-only hint to remove */ }
.cb-preview {
  flex: 0 0 auto;
  background: #0b0b0b; border: 1px solid #333; border-radius: 8px;
  padding: 12px; display: flex; gap: 12px; align-items: flex-start;
  min-height: 220px;
}
.cb-anim { display: flex; flex-direction: column; align-items: center; gap: 4px; }
.cb-anim canvas {
  image-rendering: pixelated;
  background: #1a1a1a; border: 1px solid #333; border-radius: 4px;
}
.cb-anim .label {
  font: 600 10px ui-monospace, Consolas, monospace;
  color: #9cf; text-transform: uppercase; letter-spacing: 0.06em;
}
.cb-hint { color: #666; font-size: 11px; line-height: 1.4; padding: 4px 2px; }
.cb-randomize {
  margin-bottom: 10px;
  background: #2a3a1f; color: #d8ffac; border: 1px solid #4a5a2c;
  padding: 7px 12px; border-radius: 5px; cursor: pointer;
  font: 600 12px ui-sans-serif, system-ui, sans-serif;
}
.cb-randomize:hover { background: #3a4a2c; }
.cb-randomize:disabled { opacity: 0.5; cursor: wait; }
`;

let cssInjected = false;
function ensureCss() {
  if (cssInjected) return;
  cssInjected = true;
  const tag = document.createElement('style');
  tag.setAttribute('data-character-builder', '1');
  tag.textContent = CSS;
  document.head.appendChild(tag);
}

/**
 * Mount the character builder into a container element.
 *
 * @param {HTMLElement} container — gets emptied and filled with the UI.
 * @param {object} [opts]
 * @param {string} [opts.assetsBase='assets/character_builder']
 *   Base path to the layer folders. Override if the host serves assets
 *   from a different location (the game can pass an absolute URL).
 * @param {(cfg: { layers: object, movement: string }) => void} [opts.onChange]
 *   Fires whenever the user changes a layer pick or movement preset.
 * @param {object} [opts.initial]
 *   Initial state: { layers: { body: '<id>'|null, eyes: '<id>'|null, ... },
 *   movement: 'idle' }. IDs match the variant `id` shown in the picker.
 *
 * @returns {{
 *   getConfig: () => { layers: object, movement: string },
 *   destroy:   () => void,
 *   element:   HTMLElement,
 * }}
 */
export function mountCharacterBuilder(container, opts = {}) {
  ensureCss();
  const assetsBase = opts.assetsBase || 'assets/character_builder';
  const initial = opts.initial || {};
  const onChange = opts.onChange || (() => {});

  // ----- state (closure-scoped per mount) -----
  const selectedLayers = { body: null, eyes: null, outfit: null, hairstyle: null, accessory: null };
  let activeLayer = 'body';
  let currentPreset = (initial.movement && PRESETS[initial.movement]) ? initial.movement : 'idle';
  let currentImg = null;        // composited sheet
  let rafId = null;
  let destroyed = false;

  // ----- DOM scaffolding -----
  // Layout: top row splits controls (left) and preview (right). The
  // bottom row is one big variant grid that fills the full width of
  // the avatar pane so picking outfit/hair/etc has plenty of room.
  container.innerHTML = '';
  const root = document.createElement('div');
  root.className = 'cb-root';
  container.appendChild(root);

  const topRow = document.createElement('div');
  topRow.className = 'cb-top';
  root.appendChild(topRow);

  const leftPanel = document.createElement('aside');
  leftPanel.className = 'cb-panel';
  topRow.appendChild(leftPanel);

  const stage = document.createElement('section');
  stage.className = 'cb-stage';
  topRow.appendChild(stage);

  // Layer nav
  const layerLabel = document.createElement('div');
  layerLabel.className = 'cb-nav-label'; layerLabel.textContent = 'Layer';
  const layerNav = document.createElement('div'); layerNav.className = 'cb-row';
  // Movement nav
  const moveLabel = document.createElement('div');
  moveLabel.className = 'cb-nav-label'; moveLabel.textContent = 'Movement';
  const moveNav = document.createElement('div'); moveNav.className = 'cb-row cb-movement';
  // Randomize button — picks a random variant for every layer.
  const randomBtn = document.createElement('button');
  randomBtn.type = 'button';
  randomBtn.className = 'cb-randomize';
  randomBtn.textContent = '🎲 Randomize';
  randomBtn.addEventListener('click', async () => {
    randomBtn.disabled = true;
    try {
      for (const l of LAYERS) {
        const variants = await discoverLayer(l, assetsBase);
        if (destroyed) return;
        if (variants.length) {
          selectedLayers[l.key] = variants[Math.floor(Math.random() * variants.length)];
        }
      }
      rebuildComposite();
      renderSummary();
      renderVariantList();
      emitChange();
    } finally {
      if (!destroyed) randomBtn.disabled = false;
    }
  });
  const summary = document.createElement('div'); summary.className = 'cb-summary';
  leftPanel.append(layerLabel, layerNav, moveLabel, moveNav, randomBtn, summary);

  // Variant grid — bottom half, filling the full width.
  const varList = document.createElement('div'); varList.className = 'cb-list';
  root.appendChild(varList);

  // Preview pane
  const previewCard = document.createElement('div');
  previewCard.className = 'cb-preview';
  stage.appendChild(previewCard);

  // ----- renderers -----
  function renderLayerNav() {
    layerNav.innerHTML = '';
    for (const l of LAYERS) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = l.label;
      if (l.key === activeLayer) btn.classList.add('active');
      btn.addEventListener('click', () => {
        activeLayer = l.key;
        renderLayerNav();
        renderVariantList();
      });
      layerNav.appendChild(btn);
    }
  }

  function renderMoveNav() {
    moveNav.innerHTML = '';
    for (const key of MOVEMENT_ORDER) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = key.charAt(0).toUpperCase() + key.slice(1);
      if (key === currentPreset) btn.classList.add('active');
      btn.addEventListener('click', () => {
        currentPreset = key;
        renderMoveNav();
        renderPreview();
        emitChange();
      });
      moveNav.appendChild(btn);
    }
  }

  function renderSummary() {
    summary.innerHTML = '';
    for (const l of LAYERS) {
      const sel = selectedLayers[l.key];
      const line = document.createElement('div'); line.className = 'line';
      const name = document.createElement('span'); name.className = 'ln'; name.textContent = l.label;
      const right = document.createElement('span');
      right.style.cssText = 'display:flex; gap:6px; align-items:center;';
      const pick = document.createElement('span');
      pick.className = 'pk' + (sel ? '' : ' empty');
      pick.textContent = sel ? `${l.prefix}_${sel.id}` : (l.required ? '— none —' : 'off');
      right.appendChild(pick);
      if (sel && !l.required) {
        const clear = document.createElement('button');
        clear.className = 'clear'; clear.textContent = 'clear';
        clear.addEventListener('click', () => {
          selectedLayers[l.key] = null;
          rebuildComposite();
          renderSummary();
          if (l.key === activeLayer) renderVariantList();
          emitChange();
        });
        right.appendChild(clear);
      }
      line.append(name, right);
      summary.appendChild(line);
    }
  }

  async function renderVariantList() {
    varList.innerHTML = '<div class="cb-hint">Scanning assets…</div>';
    const layer = layerByKey[activeLayer];
    const variants = await discoverLayer(layer, assetsBase);
    if (destroyed) return;
    varList.innerHTML = '';
    if (!variants.length) {
      varList.innerHTML = `<div class="cb-hint">No <code>${layer.label}</code> assets at <code>${assetsBase}/${layer.folder}/</code>.</div>`;
      return;
    }
    const selected = selectedLayers[layer.key];
    for (const v of variants) {
      const isSel = selected && selected.id === v.id;
      const item = document.createElement('div');
      item.className = 'cb-thumb' + (isSel ? ' selected' : '') + (isSel && !layer.required ? ' deselectable' : '');
      const cv = document.createElement('canvas');
      cv.width = 48; cv.height = 96;
      const cx = cv.getContext('2d');
      cx.imageSmoothingEnabled = false;
      // Show the FRONT-facing (down) frame from R1 C18 — the first
      // frame of the idle-down animation. R0 C0 is right-facing and
      // shows the character in profile (the "wide view") which is
      // harder to identify outfits/hairstyles by.
      const FRONT_X = 18 * CELL_W;   // 864
      const FRONT_Y = 1 * CELL_H;    // 96
      cx.drawImage(v.img, FRONT_X, FRONT_Y, CELL_W, CELL_H, 0, 0, 48, 96);
      const name = document.createElement('div');
      name.className = 'name';
      // Drop the layer prefix from the caption — every tile in the
      // grid belongs to the active layer, so "Accessory Bee.01" just
      // truncates to "Accesso…". Show only the variant id, which is
      // already prettified from the filename (e.g. "02 Bee.01").
      name.textContent = v.id;
      // Full descriptive name still on the tooltip for clarity.
      item.title = `${layer.label} ${v.id}`;
      item.append(cv, name);
      item.addEventListener('click', () => {
        if (isSel && !layer.required) selectedLayers[layer.key] = null;
        else selectedLayers[layer.key] = v;
        rebuildComposite();
        renderSummary();
        renderVariantList();
        emitChange();
      });
      varList.appendChild(item);
    }
  }

  // Compose all selected layer sheets into a single offscreen canvas.
  // Z-order matches LAYERS order (body first, accessory last on top).
  function rebuildComposite() {
    const stack = LAYERS.map(l => selectedLayers[l.key]).filter(Boolean);
    if (!stack.length) {
      currentImg = null;
      previewCard.innerHTML = '<div class="cb-hint">No layers selected.</div>';
      return;
    }
    const w = stack[0].img.width, h = stack[0].img.height;
    const composite = document.createElement('canvas');
    composite.width = w; composite.height = h;
    const cx = composite.getContext('2d');
    cx.imageSmoothingEnabled = false;
    for (const v of stack) cx.drawImage(v.img, 0, 0);
    currentImg = composite;
    renderPreview();
  }

  function renderPreview() {
    if (!currentImg) return;
    if (rafId) cancelAnimationFrame(rafId);
    previewCard.innerHTML = '';
    const preset = PRESETS[currentPreset];
    const dirs = preset.dirs;
    const ctxs = [];
    for (const d of dirs) {
      const block = document.createElement('div'); block.className = 'cb-anim';
      const cv = document.createElement('canvas');
      cv.width = CELL_W * PREVIEW_SCALE; cv.height = CELL_H * PREVIEW_SCALE;
      const label = document.createElement('div'); label.className = 'label'; label.textContent = d;
      block.append(cv, label);
      previewCard.appendChild(block);
      const ctx = cv.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctxs.push(ctx);
    }
    const startMs = performance.now();
    const frameMs = 1000 / preset.fps;
    const animate = (t) => {
      if (destroyed) return;
      const elapsed = t - startMs;
      const frameIdx = Math.floor(elapsed / frameMs) % preset.framesPerDir;
      for (let i = 0; i < dirs.length; i++) {
        const sx = (preset.startCol + i * preset.framesPerDir + frameIdx) * CELL_W;
        const sy = preset.row * CELL_H;
        const ctx = ctxs[i];
        ctx.clearRect(0, 0, ctx.canvas.width, ctx.canvas.height);
        ctx.drawImage(currentImg, sx, sy, CELL_W, CELL_H, 0, 0, CELL_W * PREVIEW_SCALE, CELL_H * PREVIEW_SCALE);
      }
      rafId = requestAnimationFrame(animate);
    };
    rafId = requestAnimationFrame(animate);
  }

  function emitChange() {
    onChange(getConfig());
  }

  function getConfig() {
    const out = { layers: {}, movement: currentPreset };
    for (const l of LAYERS) {
      const sel = selectedLayers[l.key];
      out.layers[l.key] = sel ? { id: sel.id, file: sel.file } : null;
    }
    return out;
  }

  function destroy() {
    destroyed = true;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    container.innerHTML = '';
  }

  // ----- bootstrap -----
  // initial.layers[key] may be either a variant id ("01", "07.03") OR
  // a full asset file path ending in .png — we match against both so
  // callers can pass an AvatarConfig (paths) directly.
  const matchVariant = (variants, want) => want && variants.find(v => v.id === want || v.file === want);
  (async () => {
    renderLayerNav();
    renderMoveNav();
    renderSummary();
    const bodies = await discoverLayer(layerByKey.body, assetsBase);
    if (destroyed) return;
    selectedLayers.body = matchVariant(bodies, initial.layers?.body) || bodies[0] || null;
    for (const l of LAYERS) {
      if (l.key === 'body') continue;
      const want = initial.layers?.[l.key];
      if (!want) continue;
      const variants = await discoverLayer(l, assetsBase);
      if (destroyed) return;
      const found = matchVariant(variants, want);
      if (found) selectedLayers[l.key] = found;
    }
    renderSummary();
    rebuildComposite();
    await renderVariantList();
    if (destroyed) return;
    renderPreview();
  })();

  return { getConfig, destroy, element: root };
}

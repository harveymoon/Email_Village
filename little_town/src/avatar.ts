// Layered avatar system for DOM-rendered portraits (email list rows,
// People grid cards, NPC popup, profile popup). Replaces the legacy
// single-file character picker.
//
// An avatar is a composition of up to 5 LimeZu Modern Interiors layer
// sheets, identified by file path:
//
//   body       — required, e.g. assets/character_builder/bodies/Body_48x48_03.png
//   eyes       — optional
//   outfit     — optional
//   hairstyle  — optional
//   accessory  — optional
//
// Sheets are 48 wide × 96 tall sprite cells laid out as documented in
// the character builder. For portrait crops we use the standing-down
// frame (R0 C3) so the face is visible, then zoom in on the head.
//
// Persistence: localStorage `little_town.avatars` keyed by lower-cased
// email. First time we render an avatar for an unseen sender we
// generate a random config and save it, so the same person always
// looks the same across reloads.

const STORAGE_KEY = 'little_town.avatars';
const ASSET_BASE = 'assets/character_builder';

// Folder names for each layer + the load order used when compositing
// (body first / on bottom, accessory last / on top).
const LAYER_FOLDERS = {
  body: 'bodies',
  eyes: 'eyes',
  outfit: 'outfits',
  hairstyle: 'hairstyles',
  accessory: 'accessories',
} as const;
type LayerKey = keyof typeof LAYER_FOLDERS;
const LAYER_ORDER: LayerKey[] = ['body', 'eyes', 'outfit', 'hairstyle', 'accessory'];

export interface AvatarConfig {
  body: string;        // required: full asset path
  eyes?: string | null;
  outfit?: string | null;
  hairstyle?: string | null;
  accessory?: string | null;
}

// ---------- manifest discovery (lazy, cached) ----------
const manifestCache: Partial<Record<LayerKey, string[]>> = {};
async function loadManifest(layer: LayerKey): Promise<string[]> {
  if (manifestCache[layer]) return manifestCache[layer]!;
  try {
    const resp = await fetch(`${ASSET_BASE}/${LAYER_FOLDERS[layer]}/manifest.json`);
    if (resp.ok) {
      const arr = await resp.json();
      manifestCache[layer] = Array.isArray(arr) ? arr : [];
    } else {
      manifestCache[layer] = [];
    }
  } catch {
    manifestCache[layer] = [];
  }
  return manifestCache[layer]!;
}

// ---------- storage ----------
function loadAll(): Record<string, AvatarConfig> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}
function saveAll(all: Record<string, AvatarConfig>): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(all)); } catch {}
}
export function loadAvatar(email: string): AvatarConfig | null {
  return loadAll()[email.toLowerCase()] || null;
}
export function saveAvatar(email: string, cfg: AvatarConfig): void {
  const all = loadAll();
  all[email.toLowerCase()] = cfg;
  saveAll(all);
  // Notify anyone watching (the game scene swaps NPC / player textures
  // when this fires; open portrait popups can refresh their previews).
  try {
    document.dispatchEvent(new CustomEvent('avatar:updated', { detail: { email: email.toLowerCase() } }));
  } catch { /* non-DOM env (tests etc.) — ignore */ }
}

// ---------- random generation ----------
// Deterministic hash so the SAME email always picks the SAME random
// avatar on a fresh machine (no localStorage yet). This means the
// person's look is stable across people who happen to share a machine
// before they bother to customize anything.
function hash32(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function pickByHash<T>(arr: T[], seed: number, salt: number): T | null {
  if (!arr.length) return null;
  return arr[(seed ^ Math.imul(salt, 2654435761)) % arr.length];
}

// Build a random AvatarConfig from the discovered manifests. If an
// `email` is provided, the choice is DETERMINISTIC for that email
// (FNV-1a hash of the lower-cased address); otherwise the choice is
// truly random per call. Body is always picked; other layers are
// included with a per-layer probability so not every avatar is wearing
// the same five things.
export async function randomAvatar(email?: string): Promise<AvatarConfig> {
  const [bodies, eyes, outfits, hairs, accs] = await Promise.all([
    loadManifest('body'), loadManifest('eyes'), loadManifest('outfit'),
    loadManifest('hairstyle'), loadManifest('accessory'),
  ]);
  if (!bodies.length) throw new Error('No body assets found — check public/assets/character_builder/bodies/');
  const seed = email ? hash32(email.toLowerCase()) : (Math.random() * 0x7fffffff) | 0;
  const rand = (salt: number) => (seed ^ Math.imul(salt, 2654435761)) >>> 0;
  // Per-layer "should include" gate. Hashed so the same email reliably
  // wears (or doesn't wear) the same kit. Probabilities below biased
  // toward fuller looks since LimeZu bodies look plain on their own.
  const include = (salt: number, threshold: number) => (rand(salt) % 100) < threshold * 100;
  const fileFor = (folder: string, name: string) => `${ASSET_BASE}/${folder}/${name}`;

  const cfg: AvatarConfig = {
    body: fileFor(LAYER_FOLDERS.body, pickByHash(bodies, seed, 11)!),
  };
  // Body, eyes and outfit are ALWAYS included — no invisible-skin,
  // blank-eyed, or naked NPCs. Hairstyle is "mostly required" at 85%
  // probability so the occasional bald character still shows up.
  // Accessory is purely optional flair (hats, bags, pets).
  if (eyes.length)    cfg.eyes      = fileFor(LAYER_FOLDERS.eyes,      pickByHash(eyes,    seed, 17)!);
  if (outfits.length) cfg.outfit    = fileFor(LAYER_FOLDERS.outfit,    pickByHash(outfits, seed, 23)!);
  if (include(29, 0.85) && hairs.length) cfg.hairstyle = fileFor(LAYER_FOLDERS.hairstyle, pickByHash(hairs, seed, 31)!);
  if (include(37, 0.20) && accs.length)  cfg.accessory = fileFor(LAYER_FOLDERS.accessory, pickByHash(accs, seed, 41)!);
  return cfg;
}

// Look up (or generate + persist) the avatar config for an email.
// Synchronous: if no saved config exists, returns null and kicks off
// background generation that persists when done. Use `ensureAvatar`
// when you need to await the result.
export function avatarForEmail(email: string): AvatarConfig | null {
  return loadAvatar(email);
}

// Validates a stored layer path. Old buggy generations left garbage
// strings like "assets/character_builder/bodies/undefined" — those
// 404 the texture composer. Treat them as missing so the patch logic
// re-rolls a fresh pick.
function isValidLayerPath(p: any): boolean {
  return typeof p === 'string' && p.length > 0
    && p.endsWith('.png')
    && !p.endsWith('/undefined.png') && !p.endsWith('/null.png')
    && !/\/(undefined|null)$/.test(p)
    && !p.includes('/undefined') && !p.includes('/null');
}

// Concurrency guard so two simultaneous renders for the same email
// don't generate two random configs and race each other to localStorage.
const inFlight = new Map<string, Promise<AvatarConfig>>();
export async function ensureAvatar(email: string): Promise<AvatarConfig> {
  const existing = loadAvatar(email);
  if (existing) {
    // Strip garbage paths so they get treated as missing below.
    for (const k of ['body', 'eyes', 'outfit', 'hairstyle', 'accessory'] as const) {
      if (existing[k] !== undefined && !isValidLayerPath(existing[k])) {
        delete (existing as any)[k];
      }
    }
    // Patch any required layer that's missing (body/eyes/outfit/
    // hairstyle). Pre-existing configs from earlier generation logic
    // may be missing these. We DON'T touch accessory — that's optional
    // and the user may have intentionally cleared it. Use a salt
    // suffix on the seed so the patched picks are deterministic but
    // don't change unrelated layers.
    const patches: Partial<AvatarConfig> = {};
    const REQUIRED: Array<keyof AvatarConfig> = ['body', 'eyes', 'outfit', 'hairstyle'];
    const missing = REQUIRED.filter(k => !existing[k]);
    if (missing.length) {
      const random = await randomAvatar(email + ':patch');
      for (const k of missing) (patches as any)[k] = random[k];
      const next = { ...existing, ...patches } as AvatarConfig;
      saveAvatar(email, next);
      return next;
    }
    return existing;
  }
  const key = email.toLowerCase();
  if (inFlight.has(key)) return inFlight.get(key)!;
  const promise = randomAvatar(email).then(cfg => {
    saveAvatar(email, cfg);
    inFlight.delete(key);
    return cfg;
  });
  inFlight.set(key, promise);
  return promise;
}

export function clearAvatar(email: string): void {
  const all = loadAll();
  delete all[email.toLowerCase()];
  saveAll(all);
}

// One-shot migration: walk every saved avatar in localStorage and
// patch missing layers. Body/eyes/outfit are STRICT — always filled
// if absent. Hairstyle is "encouraged": existing baldies get rolled
// through randomAvatar (which gives hair 85% of the time), so most
// baldies become haired but ~15% stay bald.
// Accessory is left alone — purely optional flair.
// Returns counts so callers can decide whether to act (e.g. respawn
// in-world NPCs to pick up the new textures).
export async function migrateAllAvatars(): Promise<{ patched: number; total: number; emails: string[] }> {
  const all = loadAll();
  const emails = Object.keys(all);
  const STRICT: Array<keyof AvatarConfig> = ['body', 'eyes', 'outfit'];
  const patchedEmails: string[] = [];
  for (const email of emails) {
    const existing = all[email];
    const missingStrict = STRICT.filter(k => !existing[k]);
    const needsHairRoll = !existing.hairstyle;
    if (!missingStrict.length && !needsHairRoll) continue;
    const random = await randomAvatar(email + ':patch');
    let dirty = false;
    for (const k of missingStrict) {
      if (random[k]) { (existing as any)[k] = random[k]; dirty = true; }
    }
    // Hair: 85% of baldies get hair, 15% stay bald — naturally via
    // randomAvatar's probability gate. random.hairstyle is undefined
    // ~15% of the time.
    if (needsHairRoll && random.hairstyle) {
      existing.hairstyle = random.hairstyle;
      dirty = true;
    }
    if (dirty) patchedEmails.push(email);
  }
  if (patchedEmails.length) saveAll(all);
  return { patched: patchedEmails.length, total: emails.length, emails: patchedEmails };
}

// ---------- DOM portrait renderer ----------
// Returns a circular div sized to `size`px. The portrait is drawn into
// a canvas inside the div, head-cropped on the standing-down frame.
// If no config is supplied we draw an empty placeholder (and kick off
// avatar generation asynchronously for the given email).

const FRAME_W = 48;
const FRAME_H = 96;
// LimeZu chibi sprites occupy the MIDDLE/LOWER half of each 96-tall
// cell, not the top. The head sits roughly at source y=30-50, with body
// y=50-70 and feet near y=70. The top ~30 px of every cell is empty
// padding. Focal point (24, 44) lands on the face (slightly below
// head center where eyes/mouth are); ZOOM=1.4 frames a head-and-
// shoulders portrait with margin for hair/headwear.
// Live-tunable crop: focal point inside the 48×96 frame + zoom level.
// Persisted to localStorage so the user can dial them in via the
// Settings popup's "Portrait crop" tuner.
const DEFAULT_CROP = { headX: 24, headY: 54, zoom: 0.85 };
const CROP_STORAGE_KEY = 'little_town.portrait_crop';
export interface PortraitCrop { headX: number; headY: number; zoom: number }
export function loadCrop(): PortraitCrop {
  try {
    const raw = localStorage.getItem(CROP_STORAGE_KEY);
    if (raw) {
      const v = JSON.parse(raw);
      if (typeof v?.headX === 'number' && typeof v?.headY === 'number' && typeof v?.zoom === 'number') {
        return { headX: v.headX, headY: v.headY, zoom: v.zoom };
      }
    }
  } catch {/* fall through to default */}
  return { ...DEFAULT_CROP };
}
export function saveCrop(c: PortraitCrop): void {
  try { localStorage.setItem(CROP_STORAGE_KEY, JSON.stringify(c)); } catch {}
}
export function defaultCrop(): PortraitCrop { return { ...DEFAULT_CROP }; }
// Use the first frame of IDLE-DOWN (R1 C18). R0's standing row only
// holds 3 of the 4 facings in this set so R0 C3 doesn't reliably show
// a face. R1 C18 is the first frame of the down-facing idle animation
// (R1 layout: C0-5 right, C6-11 up, C12-17 left, C18-23 down).
const PORTRAIT_COL = 18;
const PORTRAIT_ROW = 1;
const SHEET_W = 2781;
const SHEET_H = 1968;

const imgCache = new Map<string, Promise<HTMLImageElement | null>>();
function loadImage(src: string): Promise<HTMLImageElement | null> {
  if (imgCache.has(src)) return imgCache.get(src)!;
  const p = new Promise<HTMLImageElement | null>(resolve => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
  imgCache.set(src, p);
  return p;
}

async function paintAvatar(canvas: HTMLCanvasElement, cfg: AvatarConfig, size: number): Promise<void> {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  const promises = LAYER_ORDER.map(k => {
    const file = cfg[k];
    return file ? loadImage(file) : Promise.resolve(null);
  });
  const imgs = await Promise.all(promises);
  if (canvas.width !== size) { canvas.width = size; canvas.height = size; }
  ctx.clearRect(0, 0, size, size);
  // Read the user-tunable crop every paint so changes from the
  // Settings tuner show up on the next render without a refresh.
  const crop = loadCrop();
  const scale = (size / FRAME_W) * crop.zoom;
  const focalX = (PORTRAIT_COL * FRAME_W + crop.headX) * scale;
  const focalY = (PORTRAIT_ROW * FRAME_H + crop.headY) * scale;
  const bgX = (size / 2) - focalX;
  const bgY = (size / 2) - focalY;
  for (const img of imgs) {
    if (!img) continue;
    ctx.drawImage(img, 0, 0, SHEET_W, SHEET_H, bgX, bgY, SHEET_W * scale, SHEET_H * scale);
  }
}

// Render a circular portrait. If `cfg` is null, draw an empty circle
// and (if `emailForAutoload` is set) kick off background avatar
// generation, then repaint when ready.
export function avatarPortrait(cfg: AvatarConfig | null, size: number, emailForAutoload?: string): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = `
    width:${size}px; height:${size}px; flex:0 0 ${size}px;
    background:#0b0b0b; border:2px solid #2a2a2a; border-radius:50%;
    overflow:hidden; position:relative;
  `;
  const canvas = document.createElement('canvas');
  canvas.width = size; canvas.height = size;
  canvas.style.cssText = 'width:100%; height:100%; image-rendering:pixelated; display:block;';
  wrap.appendChild(canvas);
  if (cfg) {
    paintAvatar(canvas, cfg, size);
  } else if (emailForAutoload) {
    ensureAvatar(emailForAutoload).then(generated => paintAvatar(canvas, generated, size));
  }
  return wrap;
}

// Convenience wrapper for callers that only have an email — looks up
// (or generates + persists) the config and paints when ready.
export function avatarPortraitForEmail(email: string, size: number): HTMLDivElement {
  return avatarPortrait(loadAvatar(email), size, email);
}

// Little Town — Phaser 3 scene loading user-authored First_Map.tmx
// (exported as JSON from Tiled). Original Tuxemon starter ported from
// Mike Westhadley's tilemap blog series, post-1, 05-physics:
// https://github.com/mikewesthad/phaser-3-tilemap-blog-posts/blob/master/examples/post-1/05-physics/index.js

import * as Phaser from 'phaser';
import { CostGrid } from './pathfind';
import { NPC, type Door } from './npc';
import { api, setAuthExpiredHandler, type EmailThread } from './api';
import { renderEmailListInto, applyReadStateToRow, destinationMatches, matchedFloor, applySuggestionStyle, formatCompactDate, type FloorOption } from './email_ui';
import { openEmailContentPopup } from './email_content';
import { aggregatePeople, threadsForPerson, saveOverride, characterForEmail } from './people';
import { clampPopupToViewport } from './ui_helpers';
import { openRulesPane, openRuleEditor, summarizeRuleCriteria, summarizeRuleAction, type StaleRuleMatch } from './rules_ui';
import { openPeopleGrid, openPersonPopup, openAvatarCustomizer } from './people_ui';
import { avatarPortraitForEmail, ensureAvatar, randomAvatar, saveAvatar, hydrateAvatars } from './avatar';
import { hydratePeopleOverrides } from './people';
import { composeAndRegisterAvatar, AVATAR_FRAMES } from './avatar_texture';
import { mountStatusBar, setStatus } from './status_bar';

// Mount the bottom status bar as soon as this module loads — Phaser
// boot can take a beat and we want the bar visible before any
// fetching starts.
mountStatusBar();

// Hydrate avatars + people overrides + buildings at module-load time
// so the Phaser scene's synchronous getters return real data the first
// time they're called. The scene's create() reads from
// `prefetchedBuildingBindings` directly (no await needed — Phaser 4
// doesn't reliably await async create()).
let prefetchedBuildingBindings: Record<string, { customName: string | null; labels: string[] }> = {};

// One-shot migration of legacy localStorage keys for building bindings.
// Returns the merged map so the bootstrap below can POST entries to
// the backend and seed prefetchedBuildingBindings on the same tick.
function readLegacyBuildingsFromLocalStorage(): Record<string, { customName: string | null; labels: string[] }> {
  const out: Record<string, { customName: string | null; labels: string[] }> = {};
  try {
    const rawV2 = localStorage.getItem('little_town.building_labels_v2');
    const rawV1 = localStorage.getItem('little_town.building_labels');
    const rawNames = localStorage.getItem('little_town.building_names');
    if (!rawV2 && !rawV1 && !rawNames) return out;
    const labels: Record<string, string[]> = rawV2
      ? JSON.parse(rawV2)
      : rawV1
        ? Object.fromEntries(Object.entries(JSON.parse(rawV1) as Record<string, string>).filter(([, n]) => !!n).map(([id, n]) => [id, [n]]))
        : {};
    const names: Record<string, string> = rawNames ? JSON.parse(rawNames) : {};
    for (const id of new Set([...Object.keys(labels), ...Object.keys(names)])) {
      out[id] = { customName: names[id] || null, labels: labels[id] || [] };
    }
  } catch (err) {
    console.warn('[bootstrap] reading legacy buildings from localStorage failed:', err);
  }
  return out;
}

const bootstrapPersistedState: Promise<void> = (async () => {
  setStatus('Loading saved state…', { tone: 'info', ttlMs: 0 });
  try {
    const [bindingsFromApi] = await Promise.all([
      api.buildings.list().catch(err => { console.warn('[bootstrap] api.buildings.list failed:', err); return {}; }),
      hydrateAvatars(),
      hydratePeopleOverrides(),
    ]);
    if (Object.keys(bindingsFromApi).length > 0) {
      prefetchedBuildingBindings = bindingsFromApi;
    } else {
      // SQLite is empty — try migrating from localStorage. POSTs each
      // legacy entry up to the backend and removes the legacy key.
      const legacy = readLegacyBuildingsFromLocalStorage();
      prefetchedBuildingBindings = legacy;
      if (Object.keys(legacy).length > 0) {
        await Promise.all(Object.entries(legacy).map(([id, b]) =>
          api.buildings.put(id, b).catch(err =>
            console.warn(`[bootstrap] migrate building ${id} failed:`, err))));
        console.log(`[bootstrap] migrated ${Object.keys(legacy).length} building bindings from localStorage to SQLite`);
        try {
          localStorage.removeItem('little_town.building_labels_v2');
          localStorage.removeItem('little_town.building_labels');
          localStorage.removeItem('little_town.building_names');
        } catch {}
      }
    }
  } catch (err) {
    console.warn('[bootstrap] hydrate failed:', err);
  } finally {
    setStatus('', { ttlMs: 1 });
  }
})();

let cursors: Phaser.Types.Input.Keyboard.CursorKeys;
let player: Phaser.Types.Physics.Arcade.SpriteWithDynamicBody;
let wasd: { W: Phaser.Input.Keyboard.Key; A: Phaser.Input.Keyboard.Key; S: Phaser.Input.Keyboard.Key; D: Phaser.Input.Keyboard.Key };

// First_Map's embedded tilesets — Phaser doesn't follow external image
// references in tilemap JSON, so we preload each tileset's PNG with a
// Phaser key and map it back to the tileset name from Tiled.
// The two empty Grass_Water_2 entries from the .tmx are intentionally
// omitted — they have no image and aren't referenced by used tile ids.
// LimeZu character spritesheets in assets/characters/. Each is a 32x32
// frame layout (4 cols x 8 rows). Add or remove rows here to change
// who can spawn — the NPC manager picks a random key per spawn.
const CHARACTERS: Array<{ key: string; file: string }> = [
  { key: 'char_knight',         file: 'Knight/knight.png' },
  { key: 'char_chef',           file: 'Chef/chef.png' },
  { key: 'char_farmer',         file: 'Farmer/farmer.png' },
  { key: 'char_old_man',        file: 'Old Man/old_man.png' },
  { key: 'char_old_woman',      file: 'Old Woman/old_woman.png' },
  { key: 'char_blonde_man',     file: 'Blonde Man/blonde_man.png' },
  { key: 'char_blonde_woman',   file: 'Blonde Woman/blonde_woman.png' },
  { key: 'char_punk_man',       file: 'Punk Man/punk_men.png' },
  { key: 'char_punk_woman',     file: 'Punk Woman/punk_woman.png' },
  { key: 'char_viking_man',     file: 'Viking Man/viking_man.png' },
  { key: 'char_viking_woman',   file: 'Viking Woman/viking_woman.png' },
  { key: 'char_businessman',    file: 'Businessman/businessman.png' },
  { key: 'char_policeman',      file: 'Policeman/policeman.png' },
  { key: 'char_firefighter',    file: 'Firefighter/firefighter.png' },
  { key: 'char_nun',            file: 'Nun/nun.png' },
  { key: 'char_soldier',        file: 'Soldier/soldier.png' },
];

const TILESETS: Array<{ name: string; key: string; file: string }> = [
  { name: 'Floors',                            key: 'ts_floors',     file: 'A2_Floors_MV_TILESET.png' },
  { name: 'Terrains',                          key: 'ts_terrains',   file: '1_Terrains_and_Fences_48x48.png' },
  { name: '9_Shopping_Center_and_Markets_48x48', key: 'ts_shopping', file: '9_Shopping_Center_and_Markets_48x48.png' },
  { name: '4_Generic_Buildings_48x48',         key: 'ts_generic',    file: '4_Generic_Buildings_48x48.png' },
  { name: '7_Villas_48x48',                    key: 'ts_villas',     file: '7_Villas_48x48.png' },
  { name: 'shallow water',                     key: 'ts_shallow',    file: 'shallow_water.png' },
  { name: '11_Camping_48x48',                  key: 'ts_camping',    file: '11_Camping_48x48.png' },
  { name: '16_Office_48x48',                   key: 'ts_office',     file: '16_Office_48x48.png' },
  { name: '22_Post_Office_48x48',              key: 'ts_postoffice', file: '22_Post_Office_48x48.png' },
  { name: '24_Additional_Houses_48x48',        key: 'ts_houses',     file: '24_Additional_Houses_48x48.png' },
  { name: '3_City_Props_48x48',                key: 'ts_props',      file: '3_City_Props_48x48.png' },
  { name: '21_Beach_48x48',                    key: 'ts_beach',      file: '21_Beach_48x48.png' },
];

function escapeHtml(s: string): string {
  return (s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

// Canonical reader for a building's bound label names. Buildings can
// bind to MULTIPLE labels (e.g. one Bills building holds both
// `Business/Finances/Receipts` and `Financial/Bills` since they live
// under different prefixes in the two accounts). Legacy state.labelName
// (single string) is migrated on read.
function getBuildingLabels(b: { state: Record<string, unknown> }): string[] {
  const v2 = b.state.labelNames;
  if (Array.isArray(v2)) return v2.filter((s): s is string => typeof s === 'string' && !!s);
  const v1 = (typeof b.state.labelName === 'string' && b.state.labelName) ||
             (typeof b.state.labelId === 'string' && b.state.labelId) || null;
  return v1 ? [v1 as string] : [];
}
function setBuildingLabels(b: { state: Record<string, unknown> }, names: string[]): void {
  const cleaned = [...new Set(names.filter(s => typeof s === 'string' && !!s.trim()))];
  if (cleaned.length === 0) {
    delete b.state.labelNames;
    delete b.state.labelName;
    delete b.state.labelId;
    return;
  }
  b.state.labelNames = cleaned;
  // Keep the legacy keys in sync (first label) so any older code paths
  // that read state.labelName still see something sensible.
  b.state.labelName = cleaned[0];
  b.state.labelId   = cleaned[0];
}

// Ray-cast point-in-polygon (odd crossings = inside). Vertices are
// world-pixel absolute. Adapted from the well-known Franklin/Sedgewick
// PNPOLY algorithm — robust enough for Tiled's convex/concave polygons.
function pointInPolygon(x: number, y: number, verts: Array<{ x: number; y: number }>): boolean {
  let inside = false;
  for (let i = 0, j = verts.length - 1; i < verts.length; j = i++) {
    const xi = verts[i].x, yi = verts[i].y;
    const xj = verts[j].x, yj = verts[j].y;
    const intersect = ((yi > y) !== (yj > y)) &&
      (x < ((xj - xi) * (y - yi)) / ((yj - yi) || 1e-9) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

interface Building {
  id: number;                                 // Tiled object id — stable across reloads
  name: string;
  description?: string;
  x: number; y: number; w: number; h: number; // world-pixel rect
  state: Record<string, unknown>;             // arbitrary mutable game state
  label: Phaser.GameObjects.Text;             // floating name tag, updated on rename
  badge?: Phaser.GameObjects.Text;            // separate red-circle unread-count badge, lazy-created
  region: string | null;                      // name of the Region object that contains this building, if any
}

// Regions are object-layer shapes (rectangles or polygons) that group
// buildings into thematic neighborhoods. Each region optionally carries a
// `labelPrefix` custom property — when set, the building popup label
// dropdown filters to labels matching that prefix.
interface Region {
  name: string;
  labelPrefix: string | null;
  // For rectangles: x/y/w/h define the area.
  // For polygons: vertices are world-pixel-absolute (origin already added).
  kind: 'rect' | 'polygon';
  x: number; y: number; w: number; h: number;
  vertices?: Array<{ x: number; y: number }>;   // populated when kind=polygon
}

class VillageScene extends Phaser.Scene {
  private grid!: CostGrid;
  private doors: Door[] = [];
  // Every door pin from the Tiled object layer, INCLUDING those on
  // blocked tiles (the on-building pins the user placed as hints).
  // Used by findDoorForBuilding to anchor the synth-search to the
  // user's intended location instead of the rect's geometric centre.
  private allDoorPins: Array<{ x: number; y: number; tx: number; ty: number }> = [];
  private npcs: NPC[] = [];
  private polylines: Array<Array<{ x: number; y: number }>> = [];   // world-pixel coords
  private pathGfx!: Phaser.GameObjects.Graphics;
  private showPaths = new URLSearchParams(location.search).has('paths');
  private buildings: Building[] = [];
  private regions: Region[] = [];
  // Physics group for NPC sprites — used to install an NPC↔NPC collider
  // so they push past each other instead of overlapping. Built lazily
  // on first spawn so it inherits the active physics world.
  private npcGroup: Phaser.Physics.Arcade.Group | null = null;
  // True while the user is editing a DOM input/textarea/contenteditable.
  // Game keyboard shortcuts (T/P/G/WASD/arrows) check this and bail out
  // so typing in popups doesn't accidentally trigger gameplay actions.
  private isTyping = false;
  // References stashed at create() so popups can sample the tilemap
  // (e.g. building-grid previews crop the four tile layers down to
  // each building's rect).
  private map: Phaser.Tilemaps.Tilemap | null = null;
  private backgroundLayer:    Phaser.Tilemaps.TilemapLayer | null = null;
  private groundObjectsLayer: Phaser.Tilemaps.TilemapLayer | null = null;
  private buildingsLayer:     Phaser.Tilemaps.TilemapLayer | null = null;
  private treesLayer:         Phaser.Tilemaps.TilemapLayer | null = null;
  // Cached Gmail labels, populated on first need by ensureLabels().
  // Used by the building-popup dropdown.
  private labelCache: import('./api').GmailLabel[] | null = null;
  private labelCachePromise: Promise<import('./api').GmailLabel[]> | null = null;

  // Storage keys. Building ids (from Tiled) are stable as long as you
  // don't delete and recreate the rect, so per-id overrides survive
  // Tiled re-exports and page reloads.
  //
  // v2 stores an ARRAY of label names per building (multi-label support).
  // Building bindings (custom names + label assignments) now live in
  // SQLite via /api/buildings. Legacy localStorage keys kept ONLY for
  // the one-shot migration in hydrateBuildingsFromApi() below; after
  // that they're removed.
  private static BUILDING_LABEL_STORAGE_KEY    = 'little_town.building_labels';     // v1 legacy
  private static BUILDING_LABEL_STORAGE_KEY_V2 = 'little_town.building_labels_v2';  // v2 legacy
  private static BUILDING_NAME_STORAGE_KEY     = 'little_town.building_names';      // legacy

  // Two synchronous getters returning the hydrated maps. Both populated
  // by hydrateBuildingsFromApi(), called once during scene create()
  // before NPCs spawn. Empty {} until then.
  private hydratedBindings: Record<string, { customName: string | null; labels: string[] }> = {};

  private loadBuildingLabelMap(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [id, b] of Object.entries(this.hydratedBindings)) {
      if (b.labels?.length) out[id] = b.labels;
    }
    return out;
  }
  private loadBuildingNameMap(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const [id, b] of Object.entries(this.hydratedBindings)) {
      if (b.customName) out[id] = b.customName;
    }
    return out;
  }

  /** Persist one building's binding (name + labels) to /api/buildings. */
  private persistBuilding(b: Building): void {
    this.hydratedBindings[String(b.id)] = {
      customName: b.name || null,
      labels: getBuildingLabels(b),
    };
    api.buildings.put(b.id, {
      customName: b.name || null,
      labels: getBuildingLabels(b),
    }).catch(err => {
      console.warn(`[buildings] save failed for ${b.id}:`, err);
      try { (window as any).townStatus?.set?.(`Building save failed: ${err}`, { tone: 'err', ttlMs: 4000 }); } catch {}
    });
  }

  // Compatibility shims — call sites still use the old method names.
  private persistBuildingLabelMap(): void {
    for (const b of this.buildings) this.persistBuilding(b);
  }
  private persistBuildingNameMap(): void {
    for (const b of this.buildings) this.persistBuilding(b);
  }
  private async ensureLabels(): Promise<import('./api').GmailLabel[]> {
    if (this.labelCache) return this.labelCache;
    if (!this.labelCachePromise) {
      this.labelCachePromise = api.labels().then(ls => {
        this.labelCache = ls;
        return ls;
      });
    }
    return this.labelCachePromise;
  }

  // Per-label email cache. Keyed by labelId. Persists for the session;
  // user can force-refresh from the popup. Eliminates the "Loading…"
  // flicker on every popup open. Future: invalidate after a move /
  // mark-read action (Phase 6) and tie into the R-key bulk refresh
  // (Phase 8).
  private emailCache = new Map<string, EmailThread[]>();
  private emailFetchPromises = new Map<string, Promise<EmailThread[]>>();

  // Per-label fetch (one round-trip to /api/emails). Used as a building
  // block by loadThreadsForBuilding below.
  //
  // After the local-first migration, the backend reads from SQLite and
  // returns everything matching the query — there's no THREAD_LIMIT cap
  // for the user to tune, no per-label localStorage cache to TTL, and
  // no quota-backoff state to track. We pass a defensive cap of 1000
  // (matches the backend default) just so a pathological query can't
  // return a 100 MB JSON blob, but in practice every label fits.

  private async loadThreadsForLabel(labelName: string, force = false): Promise<EmailThread[]> {
    if (!force && this.emailCache.has(labelName)) return this.emailCache.get(labelName)!;
    if (!force && this.emailFetchPromises.has(labelName)) return this.emailFetchPromises.get(labelName)!;
    const p = api.threads(`label:"${labelName}"`, 1000).then(resp => {
      this.emailCache.set(labelName, resp.emails);
      this.emailFetchPromises.delete(labelName);
      return resp.emails;
    }).catch(err => {
      this.emailFetchPromises.delete(labelName);
      throw err;
    });
    this.emailFetchPromises.set(labelName, p);
    return p;
  }

  // Background: after the bound buildings have spawned their NPCs,
  // quietly pre-fetch a thin slice of every OTHER user label so the
  // suggestion engine (computeMoveSuggestions) and the People grid
  // have data to work with without forcing the user to hit Refresh
  // or "Scan all labels". Skips system CATEGORY_* labels and ones
  // already in the cache. Each label gets a smaller cap (50) since
  // suggestions only need historical breadth, not depth.
  private precacheStarted = false;
  private async precacheAllLabels(): Promise<void> {
    if (this.precacheStarted) return;
    this.precacheStarted = true;
    const labels = this.labelCache;
    if (!labels) return;
    const boundNames = new Set<string>(['INBOX']);
    for (const b of this.buildings) for (const n of getBuildingLabels(b)) boundNames.add(n);
    const targets = new Set<string>();
    for (const l of labels) {
      if (boundNames.has(l.name)) continue;
      if (l.name.startsWith('CATEGORY_')) continue;       // Gmail system buckets
      if (this.emailCache.has(l.name)) continue;
      targets.add(l.name);
    }
    if (!targets.size) return;
    console.log(`[pre-cache] starting background fetch for ${targets.size} unbound labels`);
    const names = [...targets];
    // Concurrency-cap so we don't blast Gmail's API. 8 at a time is
    // friendly — even with 200 labels this finishes in ~2-3 seconds.
    const CONCURRENCY = 8;
    let next = 0;
    const worker = async (): Promise<void> => {
      while (next < names.length) {
        const i = next++;
        try { await this.loadThreadsForLabel(names[i], false, 50); }
        catch (err) { console.warn(`[pre-cache] ${names[i]} failed:`, err); }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, names.length) }, worker));
    console.log(`[pre-cache] done — ${this.emailCache.size} labels cached`);
  }

  // Multi-label fetch for a building: pulls each bound label's threads
  // in parallel, then dedupes by threadId. Used everywhere a building's
  // "all threads" are needed (popup body, NPC spawn, unread count).
  private async loadThreadsForBuilding(b: Building, force = false): Promise<EmailThread[]> {
    const names = getBuildingLabels(b);
    if (!names.length) return [];
    const lists = await Promise.all(names.map(n => this.loadThreadsForLabel(n, force).catch(() => [])));
    const seen = new Set<string>();
    const out: EmailThread[] = [];
    for (const list of lists) for (const t of list) {
      if (seen.has(t.threadId)) continue;
      seen.add(t.threadId); out.push(t);
    }
    return out;
  }

  constructor() { super('village'); }

  preload(): void {
    for (const t of TILESETS) this.load.image(t.key, `assets/tilesets/${t.file}`);
    for (const c of CHARACTERS) {
      this.load.spritesheet(c.key, `assets/characters/${c.file}`, { frameWidth: 32, frameHeight: 32 });
    }
    // Load the map as raw JSON (not via tilemapTiledJSON) so we can
    // strip tilesets with no `image` property before Phaser 4's parser
    // gets hold of them — Tiled keeps stale "ghost" tilesets in the
    // .tmx (e.g. duplicated firstgids), and the embedded export inherits
    // them. ParseTilesets crashes on `.length` of undefined image.
    this.load.json('mapdata', 'assets/tilemaps/First_Map.json');
    this.load.atlas('atlas', 'assets/atlas/atlas.png', 'assets/atlas/atlas.json');
  }

  create(): void {
    // Live avatar updates: when any caller (Settings → Customize my
    // avatar, profile popup → Customize…) saves an AvatarConfig, the
    // avatar module fires this event. We re-compose + swap the
    // matching in-world sprite (player or NPC) on the fly so the user
    // sees the change immediately.
    document.addEventListener('avatar:updated', (e: Event) => {
      const email = (e as CustomEvent).detail?.email;
      if (!email) return;
      if (email === '__player__@local') {
        this.migratePlayerToLayeredAvatar().catch(err =>
          console.warn('[avatar:updated] player refresh failed', err));
      } else {
        this.refreshNpcsForEmail(email).catch(err =>
          console.warn(`[avatar:updated] npc refresh failed for ${email}`, err));
      }
    });
    // Rules pane / editor dispatches this after a create or delete —
    // refresh our cache so the Move-to suggestion engine sees the new
    // (or deleted) rule on the very next picker open.
    document.addEventListener('rules:updated', () => {
      this.loadRulesCache(true).catch(() => { /* logged inside */ });
    });

    const raw = this.cache.json.get('mapdata');
    raw.tilesets = raw.tilesets.filter((t: any) => typeof t.image === 'string' && t.image.length > 0);
    this.cache.tilemap.add('map', { format: Phaser.Tilemaps.Formats.TILED_JSON, data: raw });
    const map = this.make.tilemap({ key: 'map' });
    // addTilesetImage returns null for the entries the map JSON doesn't
    // actually contain (e.g. if the .tmx held a stale reference). We
    // collect everything that succeeds and pass the array to createLayer.
    const tilesets: Phaser.Tilemaps.Tileset[] = [];
    for (const t of TILESETS) {
      const ts = map.addTilesetImage(t.name, t.key);
      if (ts) tilesets.push(ts);
      else console.warn(`[map] tileset '${t.name}' not found in JSON — skipping`);
    }

    // Layers + depth ordering. Player walks OVER background and ground
    // objects but UNDER trees and buildings.
    //   Background      (0)  ground/water
    //   Ground Objects  (2)  walk-over decals (bridges, rugs, manholes)
    //   Player / NPCs   (5)
    //   Trees           (10) canopies the player walks behind
    //   Buildings       (15) above everything so rooflines occlude trees
    const backgroundLayer     = map.createLayer('Background',     tilesets, 0, 0);
    const groundObjectsLayer  = map.createLayer('Ground Objects', tilesets, 0, 0);
    const buildingsLayer      = map.createLayer('Buildings',      tilesets, 0, 0);
    const treesLayer          = map.createLayer('Trees',          tilesets, 0, 0);
    if (groundObjectsLayer) groundObjectsLayer.setDepth(2);
    if (treesLayer)         treesLayer.setDepth(10);
    if (buildingsLayer)     buildingsLayer.setDepth(15);
    // Stash for later popup rendering.
    this.map = map;
    this.backgroundLayer = backgroundLayer;
    this.groundObjectsLayer = groundObjectsLayer;
    this.buildingsLayer = buildingsLayer;
    this.treesLayer = treesLayer;

    // Buildings layer is dedicated to building tiles, so every painted
    // tile is solid — no opt-in tileset list, no per-tile property
    // needed. The `doors` object layer holds navigation waypoints; the
    // doorway artwork itself remains a blocker, NPCs just stop at the
    // door point on the path layer rather than entering.
    if (buildingsLayer) {
      buildingsLayer.forEachTile((t) => { if (t.index >= 0) t.setCollision(true); });
    }
    // Blanket-block tilesets only on layers that mix with their content.
    // Currently just water on Background — flood-painted water cells
    // would be tedious to flag one-by-one. Other building tilesets used
    // to live here too, but with Buildings on its own layer the blanket
    // approach isn't needed for them anymore.
    const COLLIDE_ALL: string[] = ['shallow water'];
    if (backgroundLayer) {
      for (const tsName of COLLIDE_ALL) {
        const ts = map.getTileset(tsName);
        if (!ts) continue;
        map.setCollisionBetween(ts.firstgid, ts.firstgid + ts.total - 1, true, true, backgroundLayer.layer.name);
      }
    }

    // Spawn priority:
    //   1. Explicit 'Spawn Point' object on Object Layer 1 (Tiled).
    //   2. The Post_Office rect on Building_Def, if present — we look
    //      for any object named 'Post_Office' (the Tiled name, before
    //      any localStorage rename overrides). Door inside that rect,
    //      else its centre.
    //   3. Random `point` on the `doors` layer (on-path, safe).
    //   4. Map centre.
    let spawnX = (map.widthInPixels / 2) | 0;
    let spawnY = (map.heightInPixels / 2) | 0;
    const spawnObj = map.findObject('Object Layer 1', (obj: any) => obj.name === 'Spawn Point') as Phaser.Types.Tilemaps.TiledObject | null;
    if (spawnObj && spawnObj.x != null && spawnObj.y != null) {
      spawnX = spawnObj.x; spawnY = spawnObj.y;
    } else {
      const buildingObjs = map.getObjectLayer('Building_Def')?.objects || [];
      const doorObjsRaw = (map.getObjectLayer('doors')?.objects || []).filter(
        (o: any) => o.point && o.x != null && o.y != null,
      );
      const postOffice = buildingObjs.find(o => o.name === 'Post_Office') as Phaser.Types.Tilemaps.TiledObject | undefined;
      if (postOffice && postOffice.x != null && postOffice.y != null && postOffice.width && postOffice.height) {
        const px = postOffice.x, py = postOffice.y;
        const pw = postOffice.width, ph = postOffice.height;
        const doorIn = doorObjsRaw.find(d => d.x! >= px && d.x! <= px + pw && d.y! >= py && d.y! <= py + ph);
        if (doorIn) { spawnX = doorIn.x!; spawnY = doorIn.y!; }
        else { spawnX = px + pw / 2; spawnY = py + ph / 2; }
      } else if (doorObjsRaw.length) {
        const d = doorObjsRaw[(Math.random() * doorObjsRaw.length) | 0] as Phaser.Types.Tilemaps.TiledObject;
        spawnX = d.x!; spawnY = d.y!;
      }
    }

    player = this.physics.add.sprite(spawnX, spawnY, 'atlas', 'misa-front')
      .setSize(30, 40)
      .setOffset(0, 24)
      // Above the Buildings tile layer (depth 15) so the player isn't
      // clipped at doorways. Matches NPC depth (npc.ts uses 20).
      .setDepth(20);
    // Collision: per-tile opt-in via the `collides` (or legacy
    // `collides = true`) property in Tiled, plus the blanket rules
    // above (water on Background, all tiles on Buildings).
    if (backgroundLayer) {
      backgroundLayer.setCollisionByProperty({ collides: true, 'collides = true': true });
      this.physics.add.collider(player, backgroundLayer);
    }
    if (groundObjectsLayer) {
      groundObjectsLayer.setCollisionByProperty({ collides: true, 'collides = true': true });
      this.physics.add.collider(player, groundObjectsLayer);
    }
    if (buildingsLayer) {
      buildingsLayer.setCollisionByProperty({ collides: true, 'collides = true': true });
      this.physics.add.collider(player, buildingsLayer);
    }
    if (treesLayer) {
      treesLayer.setCollisionByProperty({ collides: true, 'collides = true': true });
      this.physics.add.collider(player, treesLayer);
    }

    // Passable overrides — a tile marked `passable = true` in Tiled is
    // walkable regardless of layer/tileset. Per-tile escape hatch for
    // the blanket rules above. For non-background tiles, we ALSO cancel
    // the Background tile at the same coord (so water beneath a bridge
    // tile placed on Ground Objects becomes walkable).
    const isPassable = (props: any): boolean =>
      !!props && (props.passable === true || props['passable = true'] === true);
    for (const layer of [backgroundLayer, groundObjectsLayer, buildingsLayer, treesLayer]) {
      if (!layer) continue;
      layer.forEachTile((tile) => {
        if (!isPassable(tile.properties)) return;
        tile.setCollision(false, false, false, false);
        if (layer !== backgroundLayer && backgroundLayer) {
          const bg = backgroundLayer.getTileAt(tile.x, tile.y);
          if (bg) bg.setCollision(false, false, false, false);
        }
      });
    }
    if (backgroundLayer)    backgroundLayer.calculateFacesWithin(0, 0, backgroundLayer.width, backgroundLayer.height);
    if (groundObjectsLayer) groundObjectsLayer.calculateFacesWithin(0, 0, groundObjectsLayer.width, groundObjectsLayer.height);
    if (buildingsLayer)     buildingsLayer.calculateFacesWithin(0, 0, buildingsLayer.width, buildingsLayer.height);
    if (treesLayer)         treesLayer.calculateFacesWithin(0, 0, treesLayer.width, treesLayer.height);

    const anims = this.anims;
    for (const dir of ['left', 'right', 'front', 'back']) {
      anims.create({
        key: `misa-${dir}-walk`,
        frames: anims.generateFrameNames('atlas', {
          prefix: `misa-${dir}-walk.`, start: 0, end: 3, zeroPad: 3,
        }),
        frameRate: 10,
        repeat: -1,
      });
    }
    // LimeZu walk anims per character. Frame indices follow the row
    // layout documented in npc.ts. We register four directional walk
    // anims (down/up/left/right) per character key.
    // LimeZu row layout (4 cols × 8 rows of 32×32) for these sheets:
    //   rows 0-3 are idle/turn variants; rows 4-7 are walk cycles in
    //   order down, left, right, up. We only register left/down/up —
    //   right is the left walk mirrored (setFlipX in npc.ts), which
    //   sidesteps any per-sheet asymmetry.
    const WALK_ROWS: Record<'left' | 'down' | 'up', [number, number]> = {
      down:  [16, 19],
      left:  [20, 23],
      up:    [28, 31],
    };
    for (const c of CHARACTERS) {
      for (const [dir, [start, end]] of Object.entries(WALK_ROWS)) {
        anims.create({
          key: `${c.key}-walk-${dir}`,
          frames: anims.generateFrameNumbers(c.key, { start, end }),
          frameRate: 8,
          repeat: -1,
        });
      }
    }

    // Pathfinding grid: every collidable tile from any layer becomes
    // blocked; polylines on the `doors` object layer rasterize into a
    // path-cell discount so NPCs prefer them.
    this.grid = new CostGrid(map.width, map.height);
    for (const layer of [backgroundLayer, groundObjectsLayer, buildingsLayer, treesLayer]) {
      if (!layer) continue;
      layer.forEachTile((t) => { if (t.collides) this.grid.block(t.x, t.y); });
    }
    // Doors + polylines from the `doors` object layer.
    const doorObjs = map.getObjectLayer('doors')?.objects || [];
    for (const obj of doorObjs) {
      if ((obj as any).point && obj.x != null && obj.y != null) {
        const tx = (obj.x / map.tileWidth) | 0, ty = (obj.y / map.tileHeight) | 0;
        // Keep EVERY pin as a hint, even if the tile under it is
        // blocked (e.g. user placed it on the building's door art).
        this.allDoorPins.push({ x: obj.x, y: obj.y, tx, ty });
        if (!this.grid.cells[ty * this.grid.cols + tx]) {
          this.doors.push({ x: obj.x, y: obj.y, tx, ty });
        }
      } else if ((obj as any).polyline && obj.x != null && obj.y != null) {
        const verts = (obj as any).polyline as { x: number; y: number }[];
        // Stash world-coord copy for the P overlay.
        const worldVerts = verts.map(v => ({ x: obj.x! + v.x, y: obj.y! + v.y }));
        this.polylines.push(worldVerts);
        for (let i = 0; i + 1 < verts.length; i++) {
          const ax = ((obj.x + verts[i].x)     / map.tileWidth) | 0;
          const ay = ((obj.y + verts[i].y)     / map.tileHeight) | 0;
          const bx = ((obj.x + verts[i + 1].x) / map.tileWidth) | 0;
          const by = ((obj.y + verts[i + 1].y) / map.tileHeight) | 0;
          this.grid.rasterizeSegment(ax, ay, bx, by);
        }
      }
    }
    console.log(`[npc] doors=${this.doors.length}  pathCells=${this.grid.onPath.reduce((a, v) => a + v, 0)}`);

    // Snap player to the first walkable tile just below the Post Office
    // door (instead of leaving them at the door pin itself, which often
    // sits ON the building's wall art and isn't walkable). Deferred to
    // here because we need the pathfind grid to know what's walkable.
    this.snapPlayerToPostOfficeDoor(map);

    // Async: swap the player from the legacy misa atlas to the layered
    // LimeZu avatar (saved under `__player__@local`). Until this
    // resolves, the player keeps its misa anims; once swapped, the
    // update loop notices `playerTextureKey` is set and uses the new
    // animation namespace + stand frames.
    this.migratePlayerToLayeredAvatar();

    // Regions — load FIRST so buildings can be tagged with their region.
    // Object layer named `Regions` in Tiled; each object is either a
    // rectangle or a polygon. Optional custom property `labelPrefix`
    // (string) on a region narrows the building popup's label dropdown
    // to labels matching that prefix.
    const regionObjs = map.getObjectLayer('Regions')?.objects || [];
    for (const obj of regionObjs) {
      if (obj.x == null || obj.y == null) continue;
      const name = obj.name?.trim() || '';
      if (!name) continue;
      const labelPrefixProp = (obj.properties || []).find((p: any) => p.name === 'labelPrefix');
      const labelPrefix = (labelPrefixProp?.value as string | undefined) || null;
      const polyVerts = (obj as any).polygon as Array<{ x: number; y: number }> | undefined;
      if (polyVerts && polyVerts.length) {
        // Polygon vertices are stored relative to obj.x/obj.y in Tiled — convert to absolute.
        const verts = polyVerts.map(v => ({ x: obj.x! + v.x, y: obj.y! + v.y }));
        // Compute bounding box for cheap first-pass rejection in pointInRegion().
        let minX = verts[0].x, maxX = verts[0].x, minY = verts[0].y, maxY = verts[0].y;
        for (const v of verts) { if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x; if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y; }
        this.regions.push({
          name, labelPrefix, kind: 'polygon',
          x: minX, y: minY, w: maxX - minX, h: maxY - minY,
          vertices: verts,
        });
      } else if (obj.width && obj.height) {
        this.regions.push({
          name, labelPrefix, kind: 'rect',
          x: obj.x, y: obj.y, w: obj.width, h: obj.height,
        });
      }
    }
    console.log(`[regions] loaded ${this.regions.length}: ${this.regions.map(r => r.name).join(', ')}`);

    // Buildings — rectangle objects on the `Building_Def` object layer
    // (separate from the `Buildings` tile layer that holds the artwork).
    // Each rect's Name becomes the initial label / popup title; an
    // optional `description` custom property is shown in the popup body.
    // We keep a reference to the floating label so renames update it.
    // Each building is also tagged with the region that contains its
    // center point (used to filter the popup's label dropdown).
    const buildingObjs = map.getObjectLayer('Building_Def')?.objects || [];
    for (const obj of buildingObjs) {
      if (obj.x == null || obj.y == null || !obj.width || !obj.height) continue;
      const name = obj.name?.trim() || '(unnamed building)';
      const descProp = (obj.properties || []).find((p: any) => p.name === 'description');
      const description = descProp?.value as string | undefined;
      const cx = obj.x + obj.width / 2, cy = obj.y + obj.height / 2;
      const region = this.regionContaining(cx, cy);
      // Sits ON the roof — top of the label aligned ~10px inside the
      // top edge of the building rect. Origin (0.5, 0) means the y
      // we provide is the top of the text.
      // Use separate fontSize/fontFamily/fontStyle props — Phaser's
      // `font:` shorthand parser silently ignores values when the
      // family list contains commas or generic+specific mixes.
      // Unnamed placeholder rects get a small label so they don't
      // visually shout for attention.
      const isUnnamed = name === '(unnamed building)';
      const label = this.add.text(obj.x + obj.width / 2, obj.y + 10, name, {
        fontFamily: 'sans-serif',
        fontSize:   isUnnamed ? '14px' : '40px',
        fontStyle:  'bold',
        color: '#fff',
        backgroundColor: '#000000d0',
        padding: { x: 14, y: 6 },
        stroke: '#000',
        strokeThickness: isUnnamed ? 3 : 5,
      }).setOrigin(0.5, 0).setDepth(16);
      this.buildings.push({
        id: obj.id ?? this.buildings.length,
        name, description,
        x: obj.x, y: obj.y, w: obj.width, h: obj.height,
        state: {},
        label,
        region: region?.name ?? null,
      });
    }
    const byRegion: Record<string, number> = {};
    for (const b of this.buildings) {
      const k = b.region || '(unassigned)';
      byRegion[k] = (byRegion[k] || 0) + 1;
    }
    console.log(`[buildings] ${this.buildings.length} total — per region:`, byRegion);
    // Phaser.Game construction is gated on bootstrapPersistedState, so
    // by the time we reach this point the building bindings + avatars
    // + people overrides have all been hydrated from SQLite (and any
    // one-shot localStorage migration is already POSTed). Just copy
    // the module-level prefetch into the scene field the synchronous
    // getters read.
    this.hydratedBindings = prefetchedBuildingBindings;
    // Rehydrate per-building overrides. Order matters: names FIRST
    // (so Post_Office detection below uses the original Tiled name,
    // not a renamed one — otherwise renaming Post_Office would break
    // the INBOX binding).
    const savedNames = this.loadBuildingNameMap();
    for (const b of this.buildings) {
      if (savedNames[b.id]) {
        b.name = savedNames[b.id];
      }
      // Always render through the helper so the initial label uses the
      // canonical "<name>" form even before NPCs spawn (count will be 0).
      this.renderBuildingLabel(b);
    }
    const savedLabels = this.loadBuildingLabelMap();
    for (const b of this.buildings) {
      // Post_Office binding uses the building's *current* name (after
      // rename rehydration). Users can opt out of the INBOX binding by
      // renaming Post_Office.
      if (b.name === 'Post_Office') {
        setBuildingLabels(b, ['INBOX']);
      } else if (savedLabels[b.id]?.length) {
        const saved = savedLabels[b.id];
        setBuildingLabels(b, saved);
        // If any saved value looks like an old Gmail id (e.g. "Label_xxx"),
        // resolve it to a name once the label cache loads. Persist back.
        this.ensureLabels().then(labels => {
          let changed = false;
          const resolved = saved.map(s => {
            if (labels.some(l => l.name === s)) return s;
            const byOldId = labels.find(l => l.rawId === s || l.id === s || l.id.endsWith(`:${s}`));
            if (byOldId) { changed = true; return byOldId.name; }
            return s;
          });
          if (changed) { setBuildingLabels(b, resolved); this.persistBuildingLabelMap(); }
        }).catch(() => {});
      }
    }
    // Expose a thin API on `window.town` so you can mutate building state
    // from the browser console (e.g. `town.rename('Bakery', 'Old Bakery')`,
    // `town.setState(3, 'occupied', true)`). Returns the affected building
    // for chaining / inspection. Not for game-logic use — wire scene
    // events for that — but invaluable for live tweaking.
    (window as any).town = {
      buildings: this.buildings,
      get: (idOrName: number | string) => this.findBuilding(idOrName),
      rename: (idOrName: number | string, newName: string) => this.setBuildingName(idOrName, newName),
      describe: (idOrName: number | string, newDesc: string) => this.setBuildingDescription(idOrName, newDesc),
      setState: (idOrName: number | string, key: string, value: unknown) => this.setBuildingState(idOrName, key, value),
    };

    // NPCs are now driven by email data — see respawnEmailNPCs(),
    // called after auth succeeds. The random spawn loop has been
    // removed because it produced wandering villagers unrelated to the
    // inbox, which conflicted with the "NPC = unread email" metaphor.

    const camera = this.cameras.main;
    camera.startFollow(player);
    camera.setBounds(0, 0, map.widthInPixels, map.heightInPixels);

    cursors = this.input.keyboard!.createCursorKeys();
    wasd = this.input.keyboard!.addKeys('W,A,S,D') as typeof wasd;

    // Tile grid overlay (toggle with G). Drawn once at create() and
    // shown/hidden on key press — the line set never changes so this
    // is cheaper than redrawing each frame.
    const gridGfx = this.add.graphics().setDepth(20);
    this.gridGfx = gridGfx;
    this.mapForMinimap = map;
    gridGfx.lineStyle(1, 0xffffff, 0.25);
    for (let x = 0; x <= map.width; x++) {
      gridGfx.moveTo(x * map.tileWidth, 0);
      gridGfx.lineTo(x * map.tileWidth, map.heightInPixels);
    }
    for (let y = 0; y <= map.height; y++) {
      gridGfx.moveTo(0, y * map.tileHeight);
      gridGfx.lineTo(map.widthInPixels, y * map.tileHeight);
    }
    gridGfx.strokePath();
    gridGfx.setVisible(false);
    this.input.keyboard!.on('keydown-G', () => { if (!this.isTyping) gridGfx.setVisible(!gridGfx.visible); });

    this.buildTopBar();

    // Right-click tile inspector — prints what's at the clicked cell on
    // every tile layer (tileset name, gid, local index, collides flag,
    // properties). Result is shown in a DOM overlay (so the text is
    // selectable + copyable to paste back into chat), auto-copied to
    // the clipboard, and logged to the console as a backup.
    this.input.mouse?.disableContextMenu();

    // Hover tooltip — hit-tests NPC sprites first (more specific) then
    // building rects. NPC tooltip shows email state (UNREAD, WAITING AT
    // <building> or MOVING TO <building>) plus subject. Building
    // tooltip stays as before. Single DOM element repositioned each
    // frame; supports multi-line content.
    const tooltipEl = document.createElement('div');
    tooltipEl.style.cssText = `
      position:fixed; z-index:60; pointer-events:none;
      background:#000000d6; color:#fff; border:1px solid #444; border-radius:4px;
      padding:5px 10px; font:13px ui-sans-serif,system-ui,sans-serif;
      box-shadow:0 2px 8px rgba(0,0,0,0.6);
      display:none; max-width:380px; line-height:1.4;
    `;
    document.body.appendChild(tooltipEl);
    this.input.on('pointermove', (pointer: Phaser.Input.Pointer) => {
      const wx = pointer.worldX, wy = pointer.worldY;
      // NPC hit-test first — center-distance check so moving sprites
      // still get the hover tooltip (strict bounds-containment misses
      // anyone walking faster than the cursor).
      const HOVER_RADIUS = 28;
      let hitNpc: NPC | undefined;
      let hitDist = HOVER_RADIUS;
      for (const n of this.npcs) {
        const dx = n.sprite.x - wx;
        const dy = n.sprite.y - wy;
        const d = Math.hypot(dx, dy);
        if (d <= hitDist) { hitDist = d; hitNpc = n; }
      }
      if (hitNpc) {
        const data = (hitNpc.data || {}) as any;
        // Each NPC carries 1+ threads for ONE sender. Resolve subject(s)
        // and the count from the cache so the tooltip shows what's in
        // their hands.
        const threadIds: string[] = Array.isArray(data.threadIds) ? data.threadIds
          : (typeof data.threadId === 'string' ? [data.threadId] : []);
        const sender = (data.fromName && String(data.fromName).trim())
          || (data.fromEmail && String(data.fromEmail).trim())
          || '(unknown sender)';
        let state: string;
        if (hitNpc.targetDoor) {
          const destB = this.buildings.find(bd => bd.x <= hitNpc.targetDoor!.x && hitNpc.targetDoor!.x <= bd.x + bd.w && bd.y <= hitNpc.targetDoor!.y && hitNpc.targetDoor!.y <= bd.y + bd.h);
          const destName = destB?.name || 'destination';
          state = `${threadIds.length} UNREAD · MOVING TO ${destName.toUpperCase()}`;
        } else {
          const homeId = data.homeBuildingId;
          const homeB = typeof homeId === 'number' ? this.buildings.find(bd => bd.id === homeId) : undefined;
          const here = homeB?.name || 'building';
          state = `${threadIds.length} UNREAD · WAITING AT ${here.toUpperCase()}`;
        }
        // Body: sender, then subjects. Cap to 3 subjects to keep the
        // tooltip compact; "+N more" when truncated. Prefer the
        // metadata captured on the NPC at spawn time (always present);
        // fall back to live cache if that's somehow missing.
        const SHOW = 3;
        const carry: Array<{ threadId: string; subject: string; date?: string }> = Array.isArray(data.threads) ? data.threads : [];
        const items = threadIds.slice(0, SHOW).map(tid => {
          const fromCarry = carry.find(c => c.threadId === tid);
          const cached = !fromCarry?.subject ? this.findCachedThread(tid) : null;
          return {
            subject: fromCarry?.subject || cached?.subject || '(no subject)',
            date: fromCarry?.date || cached?.date || '',
          };
        });
        const subjectLines = items.map(it => {
          const dateChip = it.date
            ? `<span style="color:#7a8b9f; font:600 10px ui-monospace,Consolas,monospace; margin-right:6px;">${escapeHtml(formatCompactDate(it.date))}</span>`
            : '';
          return `<div style="color:#ccc; margin-top:2px; max-width:380px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;">• ${dateChip}${escapeHtml(it.subject)}</div>`;
        }).join('');
        const more = threadIds.length > SHOW
          ? `<div style="color:#888; margin-top:2px; font-style:italic;">+${threadIds.length - SHOW} more</div>`
          : '';
        tooltipEl.innerHTML =
          `<div style="color:#9cf; font:600 11px ui-monospace,Consolas,monospace; margin-bottom:2px;">${escapeHtml(state)}</div>` +
          `<div style="color:#fff; font-weight:600;">${escapeHtml(sender)}</div>` +
          subjectLines + more;
        tooltipEl.style.display = 'block';
        tooltipEl.style.left = `${Math.min(pointer.x + 14, window.innerWidth - 420)}px`;
        tooltipEl.style.top  = `${Math.min(pointer.y + 14, window.innerHeight - 160)}px`;
        return;
      }
      const hit = this.buildings.find(b => wx >= b.x && wx < b.x + b.w && wy >= b.y && wy < b.y + b.h);
      if (!hit) { tooltipEl.style.display = 'none'; return; }
      tooltipEl.textContent = hit.name;
      tooltipEl.style.display = 'block';
      tooltipEl.style.left = `${Math.min(pointer.x + 14, window.innerWidth - 200)}px`;
      tooltipEl.style.top  = `${Math.min(pointer.y + 14, window.innerHeight - 40)}px`;
    });

    this.input.on('pointerdown', (pointer: Phaser.Input.Pointer) => {
      if (pointer.rightButtonDown()) {
        const wx = pointer.worldX, wy = pointer.worldY;
        const tx = (wx / map.tileWidth) | 0, ty = (wy / map.tileHeight) | 0;
        const lines: string[] = [`Tile (${tx}, ${ty})  world (${Math.round(wx)}, ${Math.round(wy)})`];
        const layerEntries: Array<[string, Phaser.Tilemaps.TilemapLayer | null]> = [
          ['Background', backgroundLayer], ['Ground Objects', groundObjectsLayer],
          ['Buildings', buildingsLayer], ['Trees', treesLayer],
        ];
        for (const [name, layer] of layerEntries) {
          if (!layer) continue;
          const t = layer.getTileAt(tx, ty);
          if (!t || t.index < 0) { lines.push(`  ${name}: (empty)`); continue; }
          const tsName = t.tileset?.name ?? '?';
          const local = t.index - (t.tileset?.firstgid ?? 0);
          const propStr = t.properties && Object.keys(t.properties).length
            ? ' props={' + Object.entries(t.properties).map(([k, v]) => `${k}=${v}`).join(', ') + '}'
            : '';
          lines.push(`  ${name}: ${tsName} #${local} (gid=${t.index}) collides=${t.collides}${propStr}`);
        }
        const blocked = this.grid?.cells[ty * this.grid.cols + tx] === 1;
        const onPath  = this.grid?.onPath[ty * this.grid.cols + tx] === 1;
        lines.push(`  Pathfind: blocked=${blocked} onPath=${onPath}`);
        const msg = lines.join('\n');
        console.log(msg);
        this.showInspect(msg, pointer.x, pointer.y);
      } else if (pointer.leftButtonDown()) {
        this.closeInspect();
        const wx = pointer.worldX, wy = pointer.worldY;
        // NPC hit-test first — sprites are smaller than building rects,
        // so checking them first means clicking an NPC inside a
        // building doesn't open the building popup.
        // We use a CENTER-DISTANCE check (with a generous radius)
        // rather than strict sprite-bounds containment so moving NPCs
        // stay clickable — by the time the click event fires the
        // sprite may have moved a few pixels past where the cursor
        // landed. The closest NPC within the radius wins.
        const HIT_RADIUS = 28;          // ~half the 48-tile sprite
        let hitNpc: NPC | undefined;
        let hitDist = HIT_RADIUS;
        for (const n of this.npcs) {
          const dx = n.sprite.x - wx;
          const dy = n.sprite.y - wy;
          const d = Math.hypot(dx, dy);
          if (d <= hitDist) { hitDist = d; hitNpc = n; }
        }
        const hitNpcData = (hitNpc?.data || {}) as any;
        const hitNpcHasThread =
          (Array.isArray(hitNpcData.threadIds) && hitNpcData.threadIds.length > 0) ||
          typeof hitNpcData.threadId === 'string';
        if (hitNpc && hitNpcHasThread) {
          this.openNpcActionMenu(hitNpc, pointer.x, pointer.y);
          return;
        }
        // Otherwise: building popup if click landed in a building rect.
        const hit = this.buildings.find(b => wx >= b.x && wx < b.x + b.w && wy >= b.y && wy < b.y + b.h);
        if (hit) this.openBuildingPopup(hit, pointer.x, pointer.y);
      }
    });

    // Path debug overlay — drawn once per frame in update() when
    // showPaths is on. Depth 9 puts it above tile layers but below the
    // Trees layer (depth 10) so trees still occlude when crossed.
    this.pathGfx = this.add.graphics().setDepth(9);

    // Press T to open a map popup; click anywhere on the popup to
    // teleport. Snapshots all 3 tile layers to a small canvas — uses
    // the already-loaded tileset images directly so it costs nothing
    // beyond a single draw at open time.
    this.input.keyboard!.on('keydown-T', () => { if (!this.isTyping) this.openMinimap(map); });
    this.input.keyboard!.on('keydown-P', () => {
      if (this.isTyping) return;
      this.showPaths = !this.showPaths;
      if (!this.showPaths) this.pathGfx.clear();
    });
    this.input.keyboard!.on('keydown-B', () => { if (!this.isTyping) this.openBuildingGrid(); });
    this.input.keyboard!.on('keydown-U', () => { if (!this.isTyping) this.openPeopleGridPopup(); });
    this.input.keyboard!.on('keydown-R', () => { if (!this.isTyping) this.refreshAllEmails(); });
    this.input.keyboard!.on('keydown-F', () => {
      if (this.isTyping) return;
      openRulesPane({
        accounts: this.currentAccounts,
        labels: this.labelCache,
        reauthUrl: (email: string) => api.reauthUrl(email),
        findStaleMatches: () => this.findStaleRuleMatches(),
        applyRule: (m) => this.applyStaleRuleMatch(m),
      });
    });
    // C — call the nearest NPC over and open their click-action popup.
    // Blocked while any popup is open so it doesn't summon an NPC out
    // from under whatever the user is interacting with.
    this.input.keyboard!.on('keydown-C', () => {
      if (this.isTyping || this.isAnyPopupOpen()) return;
      this.callNearestNpc();
    });
    // H — jump back to the initial spawn position next to the Post Office.
    this.input.keyboard!.on('keydown-H', () => {
      if (!this.isTyping) this.snapPlayerToPostOfficeDoor(map);
    });

    // Suppress all game keyboard shortcuts while the user is editing a
    // DOM input/textarea/contenteditable. Also release Phaser's global
    // arrow/space capture so arrows can navigate text inside textareas
    // instead of being swallowed.
    const isEditable = (el: Element | null): boolean => {
      if (!el) return false;
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      return (el as HTMLElement).isContentEditable === true;
    };
    // Two-layer defense:
    //  (a) Capture-phase keydown listener on document. Fires before any
    //      Phaser listener regardless of where Phaser registered. If an
    //      editable element is the target, we stop propagation so Phaser
    //      never sees the event at all — and crucially we DON'T
    //      preventDefault, so the input still receives the keystroke.
    //  (b) Phaser keyboard.enabled toggle as backup (kills Key.isDown
    //      polling too, so update()'s WASD scan stays silent).
    document.addEventListener('keydown', (e) => {
      if (isEditable(e.target as Element)) e.stopPropagation();
    }, true);
    document.addEventListener('focusin', (e) => {
      if (isEditable(e.target as Element)) {
        this.isTyping = true;
        if (this.input.keyboard) this.input.keyboard.enabled = false;
      }
    });
    document.addEventListener('focusout', () => {
      setTimeout(() => {
        if (!isEditable(document.activeElement)) {
          this.isTyping = false;
          if (this.input.keyboard) this.input.keyboard.enabled = true;
        }
      }, 0);
    });

    // Gmail auth gate (Town Inbox feature). Async — runs in the background;
    // game remains playable while we check. If not authed, a modal blocks
    // any email-related action. If authed, render a small badge with the
    // user's email in the top-right corner.
    this.bootstrapAuth();
  }

  // Auth flow: poll /auth/status, react. Re-runs cheaply on `?auth_success=true`
  // landing (the redirect target after OAuth). Stays silent on transport
  // failure (i.e. backend not running) but logs once so the dev sees it.
  private authBadgeEl: HTMLDivElement | null = null;
  // Last-known account list from /auth/status — kept so the Rules pane
  // (and other future popups) can render per-account UI without needing
  // an extra fetch.
  private currentAccounts: Array<{ email: string }> = [];
  private async bootstrapAuth(): Promise<void> {
    setAuthExpiredHandler(() => this.openSignInModal());
    try {
      const status = await api.authStatus();
      if (status.authenticated && status.accounts.length) {
        this.currentAccounts = status.accounts;
        this.dismissConnectionWarning();
        if (new URLSearchParams(location.search).has('auth_success')) {
          history.replaceState({}, '', location.pathname);
        }
        // Multi-account: clear caches before respawn so the new account's
        // threads merge in. Background poll picks up subsequent changes.
        this.emailCache.clear();
        this.respawnEmailNPCs()
          .then(() => this.startBackgroundPolling())
          // Fire-and-forget: prime every remaining label so the
          // suggestion engine + People grid have data immediately,
          // without making the user click Refresh or "Scan all".
          .then(() => this.precacheAllLabels())
          .catch(err => console.warn('[npc-spawn] failed', err));
        // Independent kick-off: load the user's Gmail filters so the
        // Move-to suggestion engine can surface "this rule would
        // catch this email" picks at the top of the destinations list.
        this.loadRulesCache().catch(() => { /* logged inside */ });
      } else {
        this.openSignInModal();
      }
    } catch (err) {
      console.warn('[auth] backend unreachable — is the Town Inbox backend running on :3091?', err);
      this.showConnectionWarning('Backend offline — start the TownInbox-Backend window and reload.');
    }
  }

  // Bottom-edge warning bar. Only mounted when something's wrong; no
  // permanent UI for "everything is fine". Account management lives in
  // the Settings popup now.
  private showConnectionWarning(message: string): void {
    if (this.authBadgeEl) this.authBadgeEl.remove();
    const bar = document.createElement('div');
    bar.style.cssText = `
      position:fixed; left:50%; bottom:12px; transform:translateX(-50%);
      z-index:55;
      background:#3b1f1f; color:#fcc; border:1px solid #5a2a2a; border-radius:6px;
      padding:8px 14px; font:600 12px ui-sans-serif,system-ui,sans-serif;
      box-shadow:0 4px 16px rgba(0,0,0,0.6);
      display:flex; gap:10px; align-items:center;
    `;
    bar.innerHTML = `<span>⚠</span><span>${escapeHtml(message)}</span>`;
    const retry = document.createElement('button');
    retry.textContent = 'Retry';
    retry.style.cssText = 'background:#5a2a2a; color:#fff; border:1px solid #7a3a3a; border-radius:4px; padding:3px 10px; cursor:pointer; font:600 11px ui-sans-serif,system-ui,sans-serif;';
    retry.addEventListener('click', () => { this.bootstrapAuth(); });
    bar.appendChild(retry);
    document.body.appendChild(bar);
    this.authBadgeEl = bar;
  }

  private dismissConnectionWarning(): void {
    if (this.authBadgeEl) { this.authBadgeEl.remove(); this.authBadgeEl = null; }
  }

  private openSignInModal(): void {
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position:fixed; inset:0; z-index:1500;
      background:rgba(0,0,0,0.88);
      display:flex; align-items:center; justify-content:center;
      font:15px ui-sans-serif,system-ui,sans-serif;
    `;
    const card = document.createElement('div');
    card.style.cssText = `
      width:min(480px, 92vw); background:#111; color:#eee;
      border:1px solid #333; border-radius:10px; padding:36px 40px;
      box-shadow:0 24px 64px rgba(0,0,0,0.85);
      display:flex; flex-direction:column; align-items:center; gap:18px;
    `;
    const title = document.createElement('h1');
    title.textContent = '📬 Town Inbox';
    title.style.cssText = 'margin:0; font:600 28px ui-sans-serif,system-ui,sans-serif;';
    const subtitle = document.createElement('p');
    subtitle.textContent = 'Sign in with Google to load your inbox into the town.';
    subtitle.style.cssText = 'margin:0; color:#aaa; text-align:center; line-height:1.5;';
    const btn = document.createElement('button');
    btn.textContent = 'Sign in with Google';
    btn.style.cssText = `
      background:#1f3a5f; color:#fff; border:1px solid #2c5688; border-radius:8px;
      padding:12px 24px; font:600 15px ui-sans-serif,system-ui,sans-serif;
      cursor:pointer; margin-top:8px;
    `;
    btn.addEventListener('click', () => { window.location.href = api.signInUrl(); });
    const note = document.createElement('div');
    note.textContent = 'Backend must be running at http://localhost:3091 (start.bat handles this).';
    note.style.cssText = 'color:#666; font-size:12px; text-align:center;';
    card.appendChild(title);
    card.appendChild(subtitle);
    card.appendChild(btn);
    card.appendChild(note);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  private drawNpcPaths(): void {
    this.pathGfx.clear();
    const TILE = 48;
    // Static path network from Tiled — drawn first so NPC routes overlay it.
    this.pathGfx.lineStyle(3, 0xffffff, 0.45);
    for (const line of this.polylines) {
      for (let k = 0; k + 1 < line.length; k++) this.dashLine(line[k].x, line[k].y, line[k + 1].x, line[k + 1].y, 6, 4);
    }
    // Door dots so you can see endpoints of the network.
    this.pathGfx.fillStyle(0xffe066, 0.85);
    for (const d of this.doors) this.pathGfx.fillCircle(d.x, d.y, 3);
    // Distinct hue per NPC so two NPCs near each other are tellable.
    for (let i = 0; i < this.npcs.length; i++) {
      const npc = this.npcs[i];
      if (!npc.path.length || npc.pathIdx >= npc.path.length) continue;
      const colour = Phaser.Display.Color.HSLToColor(i / Math.max(1, this.npcs.length), 0.85, 0.55).color;
      // Build the running waypoint list: current sprite position then every
      // remaining tile centre, so the line tracks the NPC live.
      const pts: Array<{ x: number; y: number }> = [{ x: npc.sprite.x, y: npc.sprite.y }];
      for (let k = npc.pathIdx; k < npc.path.length; k++) {
        const w = npc.path[k];
        pts.push({ x: w.x * TILE + TILE / 2, y: w.y * TILE + TILE / 2 });
      }
      // Draw as dashes: 8px on, 6px off, traversing each segment.
      this.pathGfx.lineStyle(2, colour, 0.9);
      for (let k = 0; k + 1 < pts.length; k++) this.dashLine(pts[k].x, pts[k].y, pts[k + 1].x, pts[k + 1].y, 8, 6);
      // Goal marker.
      const goal = pts[pts.length - 1];
      this.pathGfx.fillStyle(colour, 1.0);
      this.pathGfx.fillCircle(goal.x, goal.y, 5);
    }
  }

  private dashLine(x0: number, y0: number, x1: number, y1: number, on: number, off: number): void {
    const dx = x1 - x0, dy = y1 - y0;
    const len = Math.hypot(dx, dy);
    if (len < 1) return;
    const ux = dx / len, uy = dy / len;
    let t = 0;
    while (t < len) {
      const t2 = Math.min(t + on, len);
      this.pathGfx.beginPath();
      this.pathGfx.moveTo(x0 + ux * t, y0 + uy * t);
      this.pathGfx.lineTo(x0 + ux * t2, y0 + uy * t2);
      this.pathGfx.strokePath();
      t = t2 + off;
    }
  }

  private minimapEl: HTMLDivElement | null = null;
  private inspectEl: HTMLDivElement | null = null;

  // DOM overlay for the right-click tile inspector. Using a DOM node
  // (rather than a Phaser Text object) so the text is selectable and
  // copyable. The overlay is also auto-copied to the clipboard for the
  // common case of "paste this back to me".
  private showInspect(msg: string, screenX: number, screenY: number): void {
    this.closeInspect();
    const box = document.createElement('div');
    box.style.cssText = `
      position:fixed; left:${Math.min(screenX + 14, window.innerWidth - 500)}px;
      top:${Math.min(screenY + 14, window.innerHeight - 200)}px;
      z-index:1000; background:rgba(0,0,0,0.88); color:#fff;
      font:13px/1.4 ui-monospace,Consolas,monospace; padding:10px 12px;
      border:1px solid #555; border-radius:4px; max-width:480px;
      white-space:pre-wrap; user-select:text; cursor:text;
      box-shadow:0 4px 16px rgba(0,0,0,0.6);
    `;
    box.textContent = msg;
    const hint = document.createElement('div');
    hint.style.cssText = 'margin-top:8px; padding-top:6px; border-top:1px solid #444; color:#9c9; font-size:11px; user-select:none;';
    hint.textContent = 'Auto-copied to clipboard. Click outside to close.';
    box.appendChild(hint);
    // Stop clicks inside the box from closing it (they'd be received
    // by the document-level handler we add below).
    box.addEventListener('mousedown', (e) => e.stopPropagation());
    document.body.appendChild(box);
    clampPopupToViewport(box);
    this.inspectEl = box;
    navigator.clipboard?.writeText(msg).catch(() => { /* clipboard blocked, ignore */ });
    // Close on next outside click — register after this tick so the
    // current pointerdown doesn't immediately dismiss it.
    setTimeout(() => {
      const onAway = () => { this.closeInspect(); document.removeEventListener('mousedown', onAway); };
      document.addEventListener('mousedown', onAway);
    }, 0);
  }
  private closeInspect(): void {
    if (!this.inspectEl) return;
    this.inspectEl.remove();
    this.inspectEl = null;
  }

  private buildingPopupEl: HTMLDivElement | null = null;
  private buildingPopupEsc: ((e: KeyboardEvent) => void) | null = null;

  // Modal popup: full-screen dim overlay + centered dark card filling
  // ~92% of the viewport. Editable name (renames live), editable
  // description, and a key/value state editor. Click the overlay,
  // press ESC, or hit × to close. All popups must stay dark-themed.
  private openBuildingPopup(b: Building, _sx: number, _sy: number): void {
    this.closeBuildingPopup();
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position:fixed; inset:0; z-index:1000;
      background:rgba(0,0,0,0.82);
      display:flex; align-items:center; justify-content:center;
      font:15px ui-sans-serif,system-ui,sans-serif;
    `;
    const card = document.createElement('div');
    card.style.cssText = `
      width:92vw; height:92vh;
      display:flex; flex-direction:column;
      background:#111; color:#eee; border:1px solid #333; border-radius:10px;
      box-shadow:0 24px 64px rgba(0,0,0,0.85);
      overflow:hidden; user-select:text;
    `;
    // ---- title bar ----
    const title = document.createElement('div');
    title.style.cssText = `
      background:#1f2937; color:#fff; padding:14px 20px;
      display:flex; align-items:center; gap:16px;
      flex:0 0 auto; border-bottom:1px solid #2c2c2c;
    `;
    const nameInput = document.createElement('input');
    nameInput.value = b.name;
    nameInput.spellcheck = false;
    nameInput.style.cssText = `
      flex:1 1 auto; background:#0b0b0b; color:#fff;
      border:1px solid #333; border-radius:6px;
      padding:8px 12px; font:600 22px ui-sans-serif,system-ui,sans-serif;
    `;
    nameInput.addEventListener('input', () => {
      const v = nameInput.value.trim() || '(unnamed)';
      this.setBuildingName(b.id, v);
    });
    const closeBtn = document.createElement('span');
    closeBtn.textContent = '×';
    closeBtn.style.cssText = 'cursor:pointer; font-size:32px; line-height:1; padding:0 8px; color:#ddd;';
    closeBtn.addEventListener('click', () => this.closeBuildingPopup());
    title.appendChild(nameInput);
    title.appendChild(closeBtn);
    // ---- body (scrollable) ----
    const body = document.createElement('div');
    body.style.cssText = 'padding:24px 28px; overflow:auto; flex:1 1 auto; display:flex; flex-direction:column; gap:24px;';
    // ---- Gmail label binding (multi-label) ----
    // A building can bind to MANY label names. Each becomes a chip; an
    // "+ Add label" picker appends. The list is persisted to localStorage
    // as `building.state.labelNames` (array of names). The backend
    // resolves each name per-account when querying / counting / moving.
    // Post_Office is hard-bound to system INBOX, dropdown disabled.
    const labelGroup = document.createElement('div');
    labelGroup.style.cssText = 'display:flex; flex-direction:column; gap:8px;';
    const labelHeading = document.createElement('label');
    labelHeading.textContent = 'Gmail labels';
    labelHeading.style.cssText = 'color:#aaa; font-size:13px; text-transform:uppercase; letter-spacing:0.06em;';
    const chipsRow = document.createElement('div');
    chipsRow.style.cssText = 'display:flex; flex-wrap:wrap; gap:6px; align-items:center; min-height:32px;';
    const labelHint = document.createElement('div');
    labelHint.style.cssText = 'color:#666; font-size:12px;';
    labelGroup.appendChild(labelHeading);
    labelGroup.appendChild(chipsRow);
    labelGroup.appendChild(labelHint);
    body.appendChild(labelGroup);

    const isPostOffice = b.name === 'Post_Office';
    const renderChips = () => {
      chipsRow.innerHTML = '';
      const current = getBuildingLabels(b);
      if (current.length === 0) {
        const empty = document.createElement('span');
        empty.textContent = '(no labels)';
        empty.style.cssText = 'color:#777; font-style:italic; font-size:13px;';
        chipsRow.appendChild(empty);
      }
      for (const name of current) {
        const chip = document.createElement('span');
        chip.style.cssText = `
          background:#1f2937; color:#cfe; border:1px solid #2c4664; border-radius:14px;
          padding:4px 10px 4px 12px; font:600 13px ui-monospace,Consolas,monospace;
          display:inline-flex; align-items:center; gap:6px;
        `;
        const text = document.createElement('span');
        text.textContent = name;
        chip.appendChild(text);
        if (!isPostOffice || current.length > 1) {
          const rm = document.createElement('span');
          rm.textContent = '×';
          rm.title = 'Remove this label';
          rm.style.cssText = 'cursor:pointer; color:#9cf; padding:0 4px; font-size:16px;';
          rm.addEventListener('click', () => {
            const next = current.filter(n => n !== name);
            setBuildingLabels(b, next);
            this.persistBuildingLabelMap();
            renderChips();
          });
          chip.appendChild(rm);
        }
        chipsRow.appendChild(chip);
      }
      if (!isPostOffice) chipsRow.appendChild(buildAddButton());
    };

    const buildAddButton = (): HTMLButtonElement => {
      const btn = document.createElement('button');
      btn.textContent = '+ Add label';
      btn.style.cssText = `
        background:#1f3a1f; color:#dfe9df; border:1px solid #2c562c;
        border-radius:14px; padding:4px 12px; cursor:pointer;
        font:600 13px ui-sans-serif,system-ui,sans-serif;
      `;
      btn.addEventListener('click', () => openLabelPicker(btn));
      return btn;
    };

    const openLabelPicker = (anchor: HTMLElement) => {
      document.querySelectorAll('[data-label-picker]').forEach(el => el.remove());
      const rect = anchor.getBoundingClientRect();
      const popover = document.createElement('div');
      popover.setAttribute('data-label-picker', '1');
      popover.style.cssText = `
        position:fixed; left:${Math.min(rect.left, window.innerWidth - 380)}px; top:${rect.bottom + 6}px;
        z-index:1300; width:360px; max-height:60vh; overflow:auto;
        background:#181818; color:#eee; border:1px solid #333; border-radius:8px;
        box-shadow:0 16px 40px rgba(0,0,0,0.7); padding:8px;
        display:flex; flex-direction:column; gap:6px;
      `;
      const search = document.createElement('input');
      search.placeholder = 'Search labels…';
      search.style.cssText = 'background:#0b0b0b; color:#eee; border:1px solid #333; border-radius:4px; padding:6px 10px; font:13px ui-sans-serif,system-ui,sans-serif;';
      const list = document.createElement('div');
      list.style.cssText = 'display:flex; flex-direction:column; gap:2px;';
      const hint = document.createElement('div');
      hint.style.cssText = 'color:#666; font-size:11px; padding:2px 4px;';
      popover.appendChild(search);
      popover.appendChild(hint);
      popover.appendChild(list);
      document.body.appendChild(popover);
      clampPopupToViewport(popover, { flipAboveAnchor: rect });
      setTimeout(() => {
        const away = (e: MouseEvent) => {
          if (popover.contains(e.target as Node)) return;
          popover.remove();
          document.removeEventListener('mousedown', away, true);
        };
        document.addEventListener('mousedown', away, true);
        search.focus();
      }, 0);

      this.ensureLabels().then(labels => {
        const region = this.regions.find(r => r.name === b.region);
        const prefix = region?.labelPrefix || null;
        const byName = new Map<string, { name: string; accounts: string[] }>();
        for (const l of labels) {
          if (!byName.has(l.name)) byName.set(l.name, { name: l.name, accounts: [] });
          byName.get(l.name)!.accounts.push(l.account);
        }
        const all = [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
        const render = () => {
          list.innerHTML = '';
          const current = new Set(getBuildingLabels(b));
          // Labels assigned to ANY OTHER building — hidden from the
          // picker so the same label can't be bound to two places.
          // We rebuild this on every render so brand-new bindings on
          // other open popups would also reflect (unlikely but cheap).
          const usedElsewhere = new Set<string>();
          for (const other of this.buildings) {
            if (other.id === b.id) continue;
            for (const n of getBuildingLabels(other)) usedElsewhere.add(n);
          }
          const query = search.value.trim().toLowerCase();
          let pool = all;
          if (prefix && !query) {
            pool = pool.filter(e => e.name === prefix || e.name.startsWith(`${prefix}/`));
          }
          if (query) pool = pool.filter(e => e.name.toLowerCase().includes(query));
          // Drop labels already bound to OTHER buildings.
          const filtered = pool.filter(e => !usedElsewhere.has(e.name));
          const hiddenCount = pool.length - filtered.length;
          const baseLine = prefix && !query
            ? `${filtered.length} of ${all.length} (filtered to ${prefix}/*; type to override)`
            : `${filtered.length} of ${all.length} labels`;
          hint.textContent = hiddenCount > 0
            ? `${baseLine} · ${hiddenCount} hidden (assigned to other buildings)`
            : baseLine;
          for (const entry of filtered.slice(0, 200)) {
            const row = document.createElement('div');
            const already = current.has(entry.name);
            row.style.cssText = `
              padding:6px 10px; cursor:${already ? 'default' : 'pointer'}; border-radius:4px;
              display:flex; justify-content:space-between; align-items:center;
              font:13px ui-monospace,Consolas,monospace;
              color:${already ? '#666' : '#cfe'};
              background:${already ? '#0b0b0b' : 'transparent'};
            `;
            row.textContent = entry.name + (entry.accounts.length > 1 ? `  (${entry.accounts.length}×)` : '');
            if (already) {
              const check = document.createElement('span'); check.textContent = '✓ added'; check.style.cssText = 'color:#9c9; font-size:11px;'; row.appendChild(check);
            } else {
              row.addEventListener('mouseenter', () => row.style.background = '#22272e');
              row.addEventListener('mouseleave', () => row.style.background = 'transparent');
              row.addEventListener('click', () => {
                setBuildingLabels(b, [...getBuildingLabels(b), entry.name]);
                this.persistBuildingLabelMap();
                renderChips();
                render();
              });
            }
            list.appendChild(row);
          }
        };
        search.addEventListener('input', render);
        render();
      }).catch(err => {
        hint.textContent = `Failed to load labels: ${err}`;
        hint.style.color = '#c66';
      });
    };

    renderChips();
    if (isPostOffice) {
      labelHint.textContent = 'Post_Office is locked to INBOX (system).';
    } else {
      const region = this.regions.find(r => r.name === b.region);
      if (region?.labelPrefix) {
        labelHint.textContent = `Region "${region.name}" suggests prefix ${region.labelPrefix}/* — picker filters by default; type to override.`;
      } else {
        labelHint.textContent = 'Click "+ Add label" to bind one or more Gmail labels. Multiple labels merge their threads into this building.';
      }
    }

    // Email list — primary content when this building has a labelId.
    // Wrapped in a section block so it never bleeds into the details
    // below. Internal scroll keeps a tall list from pushing everything
    // off-screen.
    const emailsSection = document.createElement('div');
    emailsSection.style.cssText = 'display:block; width:100%; border-top:1px solid #222; padding-top:18px;';
    const emailsHeading = document.createElement('div');
    emailsHeading.textContent = 'Emails';
    emailsHeading.style.cssText = 'color:#aaa; font-size:13px; text-transform:uppercase; letter-spacing:0.06em; margin-bottom:10px;';
    const emailsBox = document.createElement('div');
    emailsBox.style.cssText = 'display:flex; flex-direction:column; gap:8px; max-height:60vh; overflow:auto; padding-right:4px;';
    emailsSection.appendChild(emailsHeading);
    emailsSection.appendChild(emailsBox);
    body.appendChild(emailsSection);
    // Heading row: heading text, filter input, refresh button.
    // The filter input does fuzzy substring match across subject,
    // sender name/email, snippet, and sender domain — applied locally
    // to the threads array before rendering. Empty filter = show all.
    const emailsHeaderRow = document.createElement('div');
    emailsHeaderRow.style.cssText = 'display:flex; align-items:center; gap:10px; margin-bottom:10px;';
    emailsHeading.style.margin = '0';
    emailsHeading.style.flex = '0 0 auto';
    const filterInput = document.createElement('input');
    filterInput.placeholder = 'Filter… (subject, sender, domain)';
    filterInput.spellcheck = false;
    filterInput.style.cssText = `
      flex:1 1 auto; min-width:0;
      background:#0b0b0b; color:#eee; border:1px solid #333; border-radius:4px;
      padding:5px 10px; font:13px ui-sans-serif,system-ui,sans-serif;
    `;
    const refreshBtn = document.createElement('button');
    refreshBtn.textContent = '↻';
    refreshBtn.title = 'Refresh (re-fetch from Gmail)';
    refreshBtn.style.cssText = 'flex:0 0 auto; background:#1f2937; color:#9cf; border:1px solid #2c4664; border-radius:4px; padding:2px 10px; cursor:pointer; font-size:14px;';
    emailsSection.removeChild(emailsHeading);
    emailsHeaderRow.appendChild(emailsHeading);
    emailsHeaderRow.appendChild(filterInput);
    emailsHeaderRow.appendChild(refreshBtn);
    emailsSection.insertBefore(emailsHeaderRow, emailsBox);

    let currentFilter = '';
    let lastThreads: EmailThread[] = [];
    const filterThreads = (threads: EmailThread[], q: string): EmailThread[] => {
      const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
      if (!terms.length) return threads;
      return threads.filter(t => {
        const subj = (t.subject || '').toLowerCase();
        const snip = (t.snippet || '').toLowerCase();
        const fromName = (t.from?.name || '').toLowerCase();
        const fromEmail = (t.from?.email || '').toLowerCase();
        const allTexts = `${subj} ${snip} ${fromName} ${fromEmail}`;
        // AND-match every term so multi-word queries narrow the list.
        return terms.every(term => allTexts.includes(term));
      });
    };
    filterInput.addEventListener('input', () => {
      currentFilter = filterInput.value;
      // Re-render against the last loaded thread set (no re-fetch).
      if (lastThreads.length) renderEmails(lastThreads);
    });

    const renderEmails = (threads: EmailThread[]) => {
      const parents = getBuildingLabels(b).filter(n => n !== 'INBOX');
      const filtered = currentFilter ? filterThreads(threads, currentFilter) : threads;
      renderEmailListInto(emailsBox, {
        threads: filtered,
        onSelect: (t: EmailThread) => this.openEmailFor(t),
        parentLabels: parents.length ? parents : undefined,
        labels: this.labelCache || undefined,
        // Per-row: filter destinations by the row's thread account so
        // we never offer a building whose labels don't exist in that
        // account (which would orphan the thread). Also skip self.
        destinationsFor: (t) =>
          this.destinationsForMove(t.account, t).filter(d => d.labelId !== `building:${b.id}`),
        onMove: (threadId, destLabelId, destBuildingName) =>
          this.moveThread(threadId, destLabelId, destBuildingName),
        floorsFor: (t) => this.floorsForBuilding(b, t),
        onMoveToFloor: async (t, opt) => {
          await this.moveThreadToFloor(t, opt);
          // Re-fetch so the thread shows up under its new floor. We can't
          // re-render lastThreads because its labels list is stale until
          // Gmail returns the updated thread.
          await reloadEmails(true);
        },
        onMakeRule: (t) => {
          openRuleEditor({
            accounts: this.currentAccounts,
            labels: this.labelCache,
            onSaved: () => { /* nothing to refresh here */ },
            prefill: { criteria: { from: t.from?.email || '' }, account: t.account },
          });
        },
      });
    };
    const reloadEmails = async (force = false) => {
      const names = getBuildingLabels(b);
      if (!names.length) {
        emailsBox.innerHTML = '<div style="color:#666; font-style:italic; padding:8px 0;">Add one or more Gmail labels above to see emails.</div>';
        return;
      }
      // Quick render from cache if all labels are cached.
      if (!force && names.every(n => this.emailCache.has(n))) {
        const cached = await this.loadThreadsForBuilding(b);   // hits cache only
        lastThreads = cached;
        renderEmails(cached);
      } else if (!lastThreads.length) {
        // Only show a Loading… placeholder when we have NOTHING to
        // display. If a list is already on screen (e.g. floor-move
        // refetch, refresh button), keep showing the stale list until
        // the new data arrives, then swap in place — avoids the empty
        // flash that made it look like everything disappeared.
        emailsBox.innerHTML = '<div style="color:#777; padding:8px 0;">Loading…</div>';
      }
      try {
        const threads = await this.loadThreadsForBuilding(b, force);
        lastThreads = threads;
        renderEmails(threads);
      } catch (err) {
        emailsBox.innerHTML = `<div style="color:#c66; padding:8px 0;">${String(err)}</div>`;
      }
    };
    refreshBtn.addEventListener('click', () => reloadEmails(true));
    reloadEmails();
    // Re-render when the chip set changes — observe by polling the
    // chipsRow's child count. (Cheap; runs only while popup is open.)
    let lastChipCount = chipsRow.childElementCount;
    const watcher = setInterval(() => {
      if (!document.body.contains(chipsRow)) { clearInterval(watcher); return; }
      const n = chipsRow.childElementCount;
      if (n !== lastChipCount) { lastChipCount = n; reloadEmails(true); }
    }, 400);

    // ---- collapsible "Building details" section ----
    // Description + state editor are secondary metadata. Hidden by
    // default to keep the email list as the focus; click "▸ Details"
    // to expand. Auto-expanded when no labelId is set (so a freshly
    // placed building still shows the metadata you might want to edit).
    const detailsSection = document.createElement('details');
    detailsSection.open = getBuildingLabels(b).length === 0;
    detailsSection.style.cssText = 'border-top:1px solid #222; padding-top:14px;';
    const detailsSummary = document.createElement('summary');
    detailsSummary.textContent = 'Building details';
    detailsSummary.style.cssText = 'color:#aaa; font-size:13px; text-transform:uppercase; letter-spacing:0.06em; cursor:pointer; user-select:none; padding:4px 0;';
    detailsSection.appendChild(detailsSummary);
    const detailsBody = document.createElement('div');
    detailsBody.style.cssText = 'display:flex; flex-direction:column; gap:18px; padding-top:14px;';
    detailsSection.appendChild(detailsBody);
    body.appendChild(detailsSection);

    // description block (moved inside detailsBody)
    const descLabel = document.createElement('label');
    descLabel.textContent = 'Description';
    descLabel.style.cssText = 'color:#aaa; font-size:13px; text-transform:uppercase; letter-spacing:0.06em;';
    const descArea = document.createElement('textarea');
    descArea.value = b.description || '';
    descArea.placeholder = 'Describe this building…';
    descArea.style.cssText = `
      width:100%; min-height:120px; resize:vertical;
      background:#0b0b0b; color:#eee; border:1px solid #333; border-radius:6px;
      padding:12px; font:15px/1.5 ui-sans-serif,system-ui,sans-serif;
    `;
    descArea.addEventListener('input', () => this.setBuildingDescription(b.id, descArea.value));
    detailsBody.appendChild(descLabel);
    detailsBody.appendChild(descArea);
    // state editor
    const stateLabel = document.createElement('label');
    stateLabel.textContent = 'State';
    stateLabel.style.cssText = 'color:#aaa; font-size:13px; text-transform:uppercase; letter-spacing:0.06em;';
    const stateBox = document.createElement('div');
    stateBox.style.cssText = 'display:flex; flex-direction:column; gap:6px;';
    const renderStateRows = () => {
      stateBox.innerHTML = '';
      const entries = Object.entries(b.state);
      if (!entries.length) {
        const empty = document.createElement('div');
        empty.textContent = 'No state entries yet.';
        empty.style.cssText = 'color:#777; font-style:italic; padding:8px 0;';
        stateBox.appendChild(empty);
      }
      for (const [k, v] of entries) {
        stateBox.appendChild(makeStateRow(k, v));
      }
    };
    const makeStateRow = (key: string, value: unknown): HTMLDivElement => {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; gap:8px; align-items:center;';
      const keyInput = document.createElement('input');
      keyInput.value = key; keyInput.spellcheck = false;
      keyInput.style.cssText = 'flex:0 0 200px; background:#0b0b0b; color:#eee; border:1px solid #333; border-radius:4px; padding:6px 10px; font:14px ui-monospace,Consolas,monospace;';
      const valInput = document.createElement('input');
      valInput.value = typeof value === 'string' ? value : JSON.stringify(value);
      valInput.spellcheck = false;
      valInput.style.cssText = 'flex:1 1 auto; background:#0b0b0b; color:#eee; border:1px solid #333; border-radius:4px; padding:6px 10px; font:14px ui-monospace,Consolas,monospace;';
      const commit = () => {
        const newKey = keyInput.value.trim();
        const newValRaw = valInput.value;
        let parsed: unknown = newValRaw;
        try { parsed = JSON.parse(newValRaw); } catch { /* keep as string */ }
        // Remove old key if renamed, then write the new key.
        if (newKey !== key && Object.prototype.hasOwnProperty.call(b.state, key)) delete b.state[key];
        if (newKey) b.state[newKey] = parsed;
        key = newKey; value = parsed;
      };
      keyInput.addEventListener('change', commit);
      valInput.addEventListener('change', commit);
      const delBtn = document.createElement('button');
      delBtn.textContent = '×';
      delBtn.title = 'Delete entry';
      delBtn.style.cssText = 'background:#3b1f1f; color:#ddd; border:1px solid #5a2a2a; border-radius:4px; padding:4px 10px; cursor:pointer; font-size:16px;';
      delBtn.addEventListener('click', () => { delete b.state[key]; renderStateRows(); });
      row.appendChild(keyInput);
      row.appendChild(valInput);
      row.appendChild(delBtn);
      return row;
    };
    const addBtn = document.createElement('button');
    addBtn.textContent = '+ Add state entry';
    addBtn.style.cssText = 'align-self:flex-start; background:#1f3a1f; color:#dfe9df; border:1px solid #2c562c; border-radius:6px; padding:8px 14px; cursor:pointer; font-size:13px;';
    addBtn.addEventListener('click', () => {
      let i = 1;
      while (Object.prototype.hasOwnProperty.call(b.state, `key${i}`)) i++;
      b.state[`key${i}`] = '';
      renderStateRows();
    });
    detailsBody.appendChild(stateLabel);
    detailsBody.appendChild(stateBox);
    detailsBody.appendChild(addBtn);
    // metadata footer
    const meta = document.createElement('div');
    meta.textContent = `id=${b.id} · rect=${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.w)}×${Math.round(b.h)}`;
    meta.style.cssText = 'color:#666; font:12px ui-monospace,Consolas,monospace; padding-top:8px; border-top:1px solid #222;';
    detailsBody.appendChild(meta);
    renderStateRows();
    card.appendChild(title);
    card.appendChild(body);
    overlay.appendChild(card);
    card.addEventListener('mousedown', (e) => e.stopPropagation());
    overlay.addEventListener('mousedown', () => this.closeBuildingPopup());
    document.body.appendChild(overlay);
    this.buildingPopupEl = overlay;
    this.buildingPopupEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') this.closeBuildingPopup(); };
    document.addEventListener('keydown', this.buildingPopupEsc);
  }
  private closeBuildingPopup(): void {
    if (!this.buildingPopupEl) return;
    this.buildingPopupEl.remove();
    this.buildingPopupEl = null;
    if (this.buildingPopupEsc) {
      document.removeEventListener('keydown', this.buildingPopupEsc);
      this.buildingPopupEsc = null;
    }
  }

  // Return the Region whose rect or polygon contains the given world
  // point, or null. Polygon test uses standard ray-cast (odd-crossings
  // means inside). Rectangle test is straight bounds. If multiple
  // regions overlap a point we return the first match — Tiled order.
  private regionContaining(x: number, y: number): Region | null {
    for (const r of this.regions) {
      // Bounding box reject first (cheap).
      if (x < r.x || x > r.x + r.w || y < r.y || y > r.y + r.h) continue;
      if (r.kind === 'rect') return r;
      if (r.kind === 'polygon' && r.vertices && pointInPolygon(x, y, r.vertices)) return r;
    }
    return null;
  }

  // Find the door point most likely to belong to a given building rect.
  // Preference order:
  //   1. Door whose pixel coords sit inside the rect (best case)
  //   2. Door within (1 building-diagonal) of the rect's center
  //   3. Synthesised door at the nearest walkable tile to the rect's
  //      centre — keeps NPCs near their actual building instead of
  //      "borrowing" some far-away building's door.
  // Logs a console warning whenever a fallback fires so the user
  // knows to add a door inside that building in Tiled.
  // Per-building door cache. The synth path runs searchWalkableSouthFirst
  // which scans a tile ring — fine once, wasteful when called inside a
  // bulk move loop (formerly: N threads × one call each = N redundant
  // scans + N "[door] synth…" log lines). Result is invariant for the
  // session because doors / building rects don't change at runtime.
  private doorCache = new Map<number, Door | null>();

  private findDoorForBuilding(b: Building): Door | null {
    const cached = this.doorCache.get(b.id);
    if (cached !== undefined) return cached;
    const result = this.computeDoorForBuilding(b);
    this.doorCache.set(b.id, result);
    return result;
  }

  private computeDoorForBuilding(b: Building): Door | null {
    const TILE = 48;
    if (!this.grid) return null;
    // 1. Walkable door INSIDE the rect — best case.
    const inside = this.doors.find(d =>
      d.x >= b.x && d.x <= b.x + b.w && d.y >= b.y && d.y <= b.y + b.h
    );
    if (inside) {
      // Anchor on the tile DIRECTLY SOUTH of the door if that tile is
      // walkable too — keeps NPCs in front of the building instead of
      // straddling the door tile, which can clip into the threshold.
      const south = { tx: inside.tx, ty: inside.ty + 1 };
      if (south.ty < this.grid.rows && !this.grid.cells[south.ty * this.grid.cols + south.tx]) {
        return { x: south.tx * TILE + TILE / 2, y: south.ty * TILE + TILE / 2, tx: south.tx, ty: south.ty };
      }
      return inside;
    }
    // 2. User-placed pin inside the rect, even if its tile is solid
    //    (e.g. they pinned the door art on the building). Use the pin
    //    as a hint and search outward — south first — for a walkable
    //    tile. This is what they intuitively want.
    const hint = this.allDoorPins.find(d =>
      d.x >= b.x && d.x <= b.x + b.w && d.y >= b.y && d.y <= b.y + b.h
    );
    const hintTx = hint ? hint.tx : ((b.x + b.w / 2) / TILE | 0);
    const hintTy = hint ? hint.ty : ((b.y + b.h / 2) / TILE | 0);
    const found = this.searchWalkableSouthFirst(hintTx, hintTy);
    if (found) {
      // Synth-from-pin / synth-from-rect-centre is the normal fallback
      // when no explicit Door object is in the Doors layer. Logging at
      // info level (debug-style) so bulk moves don't spam.
      const reason = hint ? `pin at (${hint.tx},${hint.ty})` : `rect centre`;
      console.debug(`[door] "${b.name}" — synth from ${reason} → walkable (${found.tx},${found.ty})`);
      return { x: found.tx * TILE + TILE / 2, y: found.ty * TILE + TILE / 2, tx: found.tx, ty: found.ty };
    }
    // 3. Fall back to the building's bottom edge center, searching
    //    further south. This handles wide rects where the centre is
    //    deep inside the building.
    const bottomTx = ((b.x + b.w / 2) / TILE) | 0;
    const bottomTy = ((b.y + b.h) / TILE) | 0;
    const belowBottom = this.searchWalkableSouthFirst(bottomTx, bottomTy);
    if (belowBottom) {
      console.warn(`[door] "${b.name}" — synth below bottom edge → walkable (${belowBottom.tx},${belowBottom.ty})`);
      return { x: belowBottom.tx * TILE + TILE / 2, y: belowBottom.ty * TILE + TILE / 2, tx: belowBottom.tx, ty: belowBottom.ty };
    }
    console.warn(`[door] "${b.name}" — no walkable tile found near building; NPCs will skip this building.`);
    return null;
  }

  // Search outward from (tx,ty) for a walkable tile, with a strong
  // preference for tiles SOUTH (positive Y in screen-space). Used by
  // findDoorForBuilding to pick "the front yard" instead of "behind
  // the building". Returns null if none found within 8 tiles.
  private searchWalkableSouthFirst(tx: number, ty: number): { tx: number; ty: number } | null {
    if (!this.grid) return null;
    const isWalk = (x: number, y: number) =>
      x >= 0 && y >= 0 && x < this.grid.cols && y < this.grid.rows &&
      !this.grid.cells[y * this.grid.cols + x];
    // Phase 1: straight south.
    for (let dy = 1; dy <= 8; dy++) {
      if (isWalk(tx, ty + dy)) return { tx, ty: ty + dy };
    }
    // Phase 2: south + slight horizontal sway (front-yard arc).
    for (let dy = 1; dy <= 6; dy++) {
      for (const dx of [-1, 1, -2, 2]) {
        if (isWalk(tx + dx, ty + dy)) return { tx: tx + dx, ty: ty + dy };
      }
    }
    // Phase 3: east/west.
    for (let dx = 1; dx <= 4; dx++) {
      if (isWalk(tx + dx, ty)) return { tx: tx + dx, ty };
      if (isWalk(tx - dx, ty)) return { tx: tx - dx, ty };
    }
    // Phase 4: anywhere within range (last resort — includes north).
    for (let r = 1; r <= 8; r++) {
      for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
        if (isWalk(tx + dx, ty + dy)) return { tx: tx + dx, ty: ty + dy };
      }
    }
    return null;
  }

  // ---- B-key building grid ----
  // Dark modal listing every building with a labelId, as cards in a
  // CSS grid. Each card shows the building name and that label's unread
  // thread count (fetched in parallel). Clicking a card teleports the
  // player to the door closest to that building. Toggle with B / ESC.
  private buildingGridEl: HTMLDivElement | null = null;
  private buildingGridEsc: ((e: KeyboardEvent) => void) | null = null;

  private openBuildingGrid(): void {
    if (this.buildingGridEl) { this.closeBuildingGrid(); return; }   // B toggles
    // Per-building unread count: prefer the email cache (most accurate)
    // and dedupe threads tagged with multiple labels, fall back to the
    // NPC carry count when the cache is cold. Sort descending so the
    // most-unread buildings float to the top.
    const unreadByBuilding = new Map<number, number>();
    for (const b of this.buildings) {
      const names = getBuildingLabels(b);
      if (!names.length) continue;
      let count = 0;
      if (names.every(n => this.emailCache.has(n))) {
        const seen = new Set<string>();
        for (const n of names) for (const t of this.emailCache.get(n)!) {
          if (seen.has(t.threadId)) continue;
          seen.add(t.threadId);
          if (!t.isRead) count++;
        }
      } else {
        for (const npc of this.npcs) {
          const data = (npc.data || {}) as any;
          if (data.homeBuildingId !== b.id) continue;
          count += Array.isArray(data.threadIds) ? data.threadIds.length : 0;
        }
      }
      unreadByBuilding.set(b.id, count);
    }
    const labeled = this.buildings
      .filter(b => getBuildingLabels(b).length > 0)
      .sort((a, b) => {
        const ua = unreadByBuilding.get(a.id) || 0;
        const ub = unreadByBuilding.get(b.id) || 0;
        if (ua !== ub) return ub - ua;          // more unread first
        return a.name.localeCompare(b.name);    // alpha as tiebreaker
      });
    const overlay = document.createElement('div');
    overlay.style.cssText = `
      position:fixed; inset:0; z-index:1000;
      background:rgba(0,0,0,0.82);
      display:flex; align-items:center; justify-content:center;
      font:15px ui-sans-serif,system-ui,sans-serif;
    `;
    const card = document.createElement('div');
    card.style.cssText = `
      width:min(92vw, 1100px); max-height:90vh;
      display:flex; flex-direction:column;
      background:#111; color:#eee; border:1px solid #333; border-radius:10px;
      box-shadow:0 24px 64px rgba(0,0,0,0.85); overflow:hidden;
    `;
    const title = document.createElement('div');
    title.style.cssText = 'background:#1f2937; padding:14px 20px; font:600 20px ui-sans-serif,system-ui,sans-serif; display:flex; align-items:center; justify-content:space-between; flex:0 0 auto;';
    const titleText = document.createElement('span');
    titleText.textContent = `🏘️ Buildings (${labeled.length})`;
    const closeBtn = document.createElement('span');
    closeBtn.textContent = '×';
    closeBtn.style.cssText = 'cursor:pointer; font-size:28px; line-height:1; padding:0 8px;';
    closeBtn.addEventListener('click', () => this.closeBuildingGrid());
    title.appendChild(titleText);
    title.appendChild(closeBtn);
    card.appendChild(title);

    const body = document.createElement('div');
    body.style.cssText = 'padding:20px; overflow:auto; flex:1 1 auto;';
    if (!labeled.length) {
      const empty = document.createElement('div');
      empty.textContent = 'No buildings have a Gmail label assigned. Click a building and pick one in its popup.';
      empty.style.cssText = 'color:#888; font-style:italic; padding:32px; text-align:center;';
      body.appendChild(empty);
    } else {
      const grid = document.createElement('div');
      grid.style.cssText = 'display:grid; grid-template-columns:repeat(auto-fill, minmax(220px, 1fr)); gap:14px;';
      for (const b of labeled) grid.appendChild(this.makeBuildingCard(b));
      body.appendChild(grid);
    }
    card.appendChild(body);
    overlay.appendChild(card);
    card.addEventListener('mousedown', (e) => e.stopPropagation());
    overlay.addEventListener('mousedown', () => this.closeBuildingGrid());
    document.body.appendChild(overlay);
    this.buildingGridEl = overlay;
    this.buildingGridEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') this.closeBuildingGrid(); };
    document.addEventListener('keydown', this.buildingGridEsc);
  }

  private makeBuildingCard(b: Building): HTMLDivElement {
    const names = getBuildingLabels(b);
    const labelName = names.length === 1 ? names[0] : `${names.length} labels`;
    const card = document.createElement('div');
    card.style.cssText = `
      background:#1a1a1a; border:1px solid #2a2a2a; border-radius:8px;
      overflow:hidden; cursor:pointer; user-select:none;
      display:flex; flex-direction:column;
      transition:background 0.1s, border-color 0.1s;
    `;
    card.addEventListener('mouseenter', () => { card.style.background = '#22272e'; card.style.borderColor = '#3a4660'; });
    card.addEventListener('mouseleave', () => { card.style.background = '#1a1a1a'; card.style.borderColor = '#2a2a2a'; });
    card.addEventListener('click', () => { this.teleportToBuilding(b); this.closeBuildingGrid(); });

    // Preview: render the tiles inside the building's rect (all 4 tile
    // layers, in depth order) onto a small canvas at the top of the card.
    const preview = this.renderBuildingPreview(b, 240, 140);
    if (preview) {
      preview.style.cssText = 'display:block; width:100%; height:140px; object-fit:contain; background:#0a0a0a; border-bottom:1px solid #2a2a2a; image-rendering:pixelated;';
      card.appendChild(preview);
    }

    const meta = document.createElement('div');
    meta.style.cssText = 'padding:10px 14px; display:flex; flex-direction:column; gap:4px;';
    const name = document.createElement('div');
    name.textContent = b.name;
    name.style.cssText = 'font:600 15px ui-sans-serif,system-ui,sans-serif; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
    const label = document.createElement('div');
    label.textContent = labelName;
    label.title = names.join('\n');     // hover shows the full list when count > 1
    label.style.cssText = 'font:11px ui-monospace,Consolas,monospace; color:#7a8b9f; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
    const badgeRow = document.createElement('div');
    badgeRow.style.cssText = 'display:flex; gap:8px; align-items:center; margin-top:4px;';
    const unreadBadge = document.createElement('span');
    unreadBadge.textContent = '…';
    unreadBadge.style.cssText = 'background:#2a2a2a; color:#888; padding:3px 10px; border-radius:10px; font:600 12px ui-monospace,Consolas,monospace;';
    badgeRow.appendChild(unreadBadge);
    const unreadLbl = document.createElement('span');
    unreadLbl.textContent = 'unread';
    unreadLbl.style.cssText = 'color:#666; font-size:12px;';
    badgeRow.appendChild(unreadLbl);

    meta.appendChild(name);
    meta.appendChild(label);
    meta.appendChild(badgeRow);
    card.appendChild(meta);

    // Fetch the unread count in the background. If the cache already
    // has every bound label, compute the count locally (deduping by
    // threadId so threads tagged with multiple labels don't double-count);
    // otherwise fall back to per-label API calls and sum.
    // If every label is cached, compute unread locally; else fetch each.
    if (names.length && names.every(n => this.emailCache.has(n))) {
      const seen = new Set<string>();
      let unread = 0;
      for (const n of names) for (const t of this.emailCache.get(n)!) {
        if (seen.has(t.threadId)) continue;
        seen.add(t.threadId);
        if (!t.isRead) unread++;
      }
      unreadBadge.textContent = String(unread);
      this.styleUnreadBadge(unreadBadge, unread);
    } else if (names.length) {
      Promise.all(names.map(n => {
        const args = n === 'INBOX' ? { labelIds: 'INBOX' } : { labelName: n };
        return api.unreadCount(args).then(r => r.count).catch(() => 0);
      })).then(counts => {
        // Note: this sums per-label counts; if the same thread is on
        // multiple labels we may double-count. The cached path above
        // dedupes properly. Good enough for at-a-glance badges.
        const total = counts.reduce((a, b) => a + b, 0);
        unreadBadge.textContent = String(total);
        this.styleUnreadBadge(unreadBadge, total);
      }).catch((err) => {
        console.warn(`[building-grid] unread counts failed for "${b.name}":`, err);
        unreadBadge.textContent = '?';
        unreadBadge.style.color = '#c66';
        unreadBadge.title = String(err);
      });
    }

    return card;
  }

  private styleUnreadBadge(badge: HTMLElement, count: number): void {
    if (count > 0) {
      badge.style.background = '#3a2050';
      badge.style.color = '#d8b8ff';
    } else {
      badge.style.background = '#1a3a1a';
      badge.style.color = '#a8d8a8';
    }
  }

  // Render a small preview of the building's footprint: crops every tile
  // layer down to the building's rect and draws them in depth order
  // (Background → Ground Objects → Trees → Buildings — note: Buildings
  // last so rooflines aren't covered by trees, matching world order
  // since both are above the player anyway).
  private renderBuildingPreview(b: Building, targetW: number, targetH: number): HTMLCanvasElement | null {
    if (!this.map) return null;
    const tw = this.map.tileWidth, th = this.map.tileHeight;
    // Expand the rect outward by one tile so canopies / overhanging
    // rooftops aren't clipped.
    const PAD = 1;
    const x0 = Math.max(0, Math.floor(b.x / tw) - PAD);
    const y0 = Math.max(0, Math.floor(b.y / th) - PAD);
    const x1 = Math.min(this.map.width,  Math.ceil((b.x + b.w) / tw) + PAD);
    const y1 = Math.min(this.map.height, Math.ceil((b.y + b.h) / th) + PAD);
    const tilesW = x1 - x0, tilesH = y1 - y0;
    if (tilesW <= 0 || tilesH <= 0) return null;
    const scale = Math.min(targetW / (tilesW * tw), targetH / (tilesH * th));
    const cw = Math.max(1, Math.round(tilesW * tw * scale));
    const ch = Math.max(1, Math.round(tilesH * th * scale));
    const cv = document.createElement('canvas');
    cv.width = cw; cv.height = ch;
    const ctx = cv.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    const dw = tw * scale, dh = th * scale;
    const layers = [this.backgroundLayer, this.groundObjectsLayer, this.treesLayer, this.buildingsLayer];
    for (const layer of layers) {
      if (!layer) continue;
      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const tile = layer.getTileAt(x, y);
          if (!tile || tile.index < 0 || !tile.tileset) continue;
          const ts = tile.tileset;
          const img = this.textures.get(ts.image!.key).getSourceImage() as HTMLImageElement;
          const local = tile.index - ts.firstgid;
          const cols = ts.columns;
          const sx = ts.tileMargin + (local % cols) * (tw + ts.tileSpacing);
          const sy = ts.tileMargin + Math.floor(local / cols) * (th + ts.tileSpacing);
          const dx = Math.floor((x - x0) * dw);
          const dy = Math.floor((y - y0) * dh);
          const dWidth  = Math.ceil(dw) + 1;
          const dHeight = Math.ceil(dh) + 1;
          ctx.drawImage(img, sx, sy, tw, th, dx, dy, dWidth, dHeight);
        }
      }
    }
    return cv;
  }

  private closeBuildingGrid(): void {
    if (!this.buildingGridEl) return;
    this.buildingGridEl.remove();
    this.buildingGridEl = null;
    if (this.buildingGridEsc) {
      document.removeEventListener('keydown', this.buildingGridEsc);
      this.buildingGridEsc = null;
    }
  }

  // Flatten every cached thread across every label into one array,
  // deduplicating by threadId (a thread can live in INBOX *and* a
  // user label simultaneously). Used by the People feature for sender
  // aggregation and per-person thread filtering.
  private getAllCachedThreads(): EmailThread[] {
    const seen = new Set<string>();
    const out: EmailThread[] = [];
    for (const threads of this.emailCache.values()) {
      for (const t of threads) {
        if (seen.has(t.threadId)) continue;
        seen.add(t.threadId); out.push(t);
      }
    }
    return out;
  }

  // U-key: aggregate every sender across cached threads and show the
  // People grid. Click a person → individual popup (character picker,
  // notes, conversation history). "Scan all" forces every labeled
  // building's threads to be fetched, populating the cache so more
  // people appear.
  // Open the full profile popup for a sender by email — the same popup
  // the People grid opens, but reachable from anywhere that has an
  // email handle (e.g. the NPC click-action card's avatar). Builds the
  // Person from aggregated cache when possible; falls back to a minimal
  // Person so the popup still opens even if the sender isn't in cache.
  private async openProfileForEmail(email: string, fallbackName?: string): Promise<void> {
    const key = email.toLowerCase();
    // Seed from the email cache when we have it.
    const cached = this.getAllCachedThreads();
    const fromCache = threadsForPerson(cached, key);
    // The cache for this person's label may have been wiped (move,
    // refresh, auth swap) without the NPC respawning, so also collect
    // threadIds from any in-world NPC matching this sender and fetch
    // any that aren't in the cache. Without this fallback the profile
    // popup shows "Conversations (0)" even when we KNOW the NPC is
    // carrying threads from that person.
    const npcThreadIds = new Set<string>();
    for (const npc of this.npcs) {
      const e = (npc.data as any)?.fromEmail;
      if (typeof e === 'string' && e.toLowerCase() === key) {
        const tids = (npc.data as any)?.threadIds as string[] | undefined;
        if (Array.isArray(tids)) for (const id of tids) npcThreadIds.add(id);
      }
    }
    const haveIds = new Set(fromCache.map(t => t.threadId));
    const missing = [...npcThreadIds].filter(id => !haveIds.has(id));
    const fetched = (await Promise.all(
      missing.map(id => api.thread(id).catch((err: unknown) => {
        console.warn(`[profile] failed to fetch thread ${id}:`, err);
        return null;
      })),
    )).filter((t): t is EmailThread => !!t);
    const allThreads = [...fromCache, ...fetched];
    const person =
      aggregatePeople(allThreads).find(p => p.email === key) ||
      ({
        email: key,
        name: fallbackName || email,
        charKey: characterForEmail(email).key,
        threadIds: new Set<string>(allThreads.map(t => t.threadId)),
        unread: allThreads.filter(t => !t.isRead).length,
        override: null,
      });
    openPersonPopup({
      person,
      allThreads,
      onSave: (e, ov) => saveOverride(e, ov),
      onOpenEmail: (t) => this.openEmailFor(t),
      accounts: this.currentAccounts,
      labels: this.labelCache,
      buildingsForThread: (t) => this.buildingsContainingThread(t),
      destinationsForPerson: (threads) => {
        const accounts = [...new Set(threads.map(tt => tt.account))];
        return this.destinationsForMove(accounts, threads[0]);
      },
      onMoveAll: async (threads, destLabelId, destBuilding, overrideLabel) => {
        // Fire moves in parallel — each one is mostly waiting on its
        // own Gmail API round trip, and they don't depend on each
        // other. Was serial-await before, which scaled linearly with
        // thread count and felt sluggish for 20+ at a time.
        await Promise.all(threads.map(t =>
          this.moveThread(t.threadId, destLabelId, destBuilding, overrideLabel)
            .catch(err => console.warn(`[moveAll-person] ${t.threadId}:`, err))
        ));
      },
      onMarkAllRead: async (threads) => {
        for (const t of threads) {
          try { this.markThreadRead(t); }
          catch (err) { console.warn(`[markAllRead-person] ${t.threadId}:`, err); }
        }
      },
    });
  }

  private openPeopleGridPopup(): void {
    const allThreads = this.getAllCachedThreads();
    const people = aggregatePeople(allThreads);
    openPeopleGrid({
      people,
      // Re-snapshot from the live cache whenever a thread changes
      // read state or labels — the grid uses this to refresh its
      // per-person unread counts without forcing the user to close
      // and re-open the grid.
      refreshPeople: () => aggregatePeople(this.getAllCachedThreads()),
      onPick: (p) => {
        const involves = threadsForPerson(this.getAllCachedThreads(), p.email);
        openPersonPopup({
          person: p,
          allThreads: involves,
          onSave: (email, ov) => saveOverride(email, ov),
          onOpenEmail: (t) => this.openEmailFor(t),
          accounts: this.currentAccounts,
          labels: this.labelCache,
          buildingsForThread: (t) => this.buildingsContainingThread(t),
          destinationsForPerson: (threads) => {
            const accounts = [...new Set(threads.map(tt => tt.account))];
            return this.destinationsForMove(accounts, threads[0]);
          },
          onMoveAll: async (threads, destLabelId, destBuilding, overrideLabel) => {
            for (const t of threads) {
              try { await this.moveThread(t.threadId, destLabelId, destBuilding, overrideLabel); }
              catch (err) { console.warn(`[moveAll-person] ${t.threadId}:`, err); }
            }
          },
          onMarkAllRead: async (threads) => {
            for (const t of threads) {
              try { this.markThreadRead(t); }
              catch (err) { console.warn(`[markAllRead-person] ${t.threadId}:`, err); }
            }
          },
        });
      },
      onScanAll: async () => {
        // Fetch every labeled building's threads (each of its labels)
        // in parallel; re-open the grid with the larger dataset.
        const labelled = this.buildings.filter(b => getBuildingLabels(b).length > 0);
        await Promise.allSettled(labelled.map(b => this.loadThreadsForBuilding(b, true)));
        this.openPeopleGridPopup();
      },
    });
  }

  // Action popover for clicked NPCs. Each NPC represents ONE sender at
  // ONE building and carries one or more unread thread ids. Layout:
  //   header: "📬 N unread from <sender>"
  //   per-thread row: subject + [Read] [Move to…]
  //   footer (multi only): [Move all to …]
  private async openNpcActionMenu(npc: NPC, screenX: number, screenY: number): Promise<void> {
    // Make sure the rules cache is ready BEFORE we build any DOM so
    // the Rules section can render its full content on first paint —
    // no "Loading rules…" placeholder, no post-mount mutation. After
    // the first session-bootstrap load this is a no-op (cache hit).
    if (!this.rulesCache) {
      try { await this.loadRulesCache(); } catch { /* fall through; section will just show empty */ }
    }
    document.querySelectorAll('[data-npc-action]').forEach(el => el.remove());
    const data = (npc.data || {}) as any;
    const threadIds: string[] = Array.isArray(data.threadIds) ? [...data.threadIds]
      : (typeof data.threadId === 'string' ? [data.threadId] : []);
    if (!threadIds.length) return;

    const pop = document.createElement('div');
    pop.setAttribute('data-npc-action', '1');
    pop.style.cssText = `
      position:fixed; left:${Math.min(screenX + 14, window.innerWidth - 420)}px;
      top:${Math.min(screenY + 14, window.innerHeight - 260)}px;
      z-index:1300; width:400px; max-height:80vh; overflow:auto;
      background:#181818; color:#eee; border:1px solid #333; border-radius:8px;
      box-shadow:0 16px 40px rgba(0,0,0,0.75); padding:10px;
      display:flex; flex-direction:column; gap:8px;
    `;
    pop.addEventListener('mousedown', (e) => e.stopPropagation());
    document.body.appendChild(pop);
    clampPopupToViewport(pop);
    setTimeout(() => {
      const away = (e: MouseEvent) => {
        if (pop.contains(e.target as Node)) return;
        pop.remove();
        document.removeEventListener('mousedown', away, true);
      };
      document.addEventListener('mousedown', away, true);
    }, 0);

    // Profile header: large avatar + name + email + unread count, styled
    // to match the people-grid card so clicking an NPC feels like the
    // same surface as the People popup.
    const fromName = data.fromName || '';
    const fromEmail = data.fromEmail || '';
    const sender = fromName || fromEmail || '(unknown)';
    const profile = document.createElement('div');
    profile.style.cssText = 'display:flex; gap:12px; align-items:center; padding:8px; border:1px solid #222; border-radius:8px; background:#141414;';
    // Layered LimeZu portrait — composites the per-sender saved
    // AvatarConfig (or generates+saves a random one on first sight).
    const avatarEl = avatarPortraitForEmail(fromEmail || sender, 72);
    // Click the avatar to jump to the sender's full profile popup (the
    // same one People grid opens). Faster than: close NPC popup → press
    // U → search for them → click their tile.
    if (fromEmail) {
      avatarEl.style.cursor = 'pointer';
      avatarEl.title = `Open profile for ${sender}`;
      avatarEl.addEventListener('mouseenter', () => { avatarEl.style.outline = '2px solid #9cf'; });
      avatarEl.addEventListener('mouseleave', () => { avatarEl.style.outline = ''; });
      avatarEl.title = `${sender}\n• click — open profile\n• shift+click — randomize avatar`;
      avatarEl.addEventListener('click', (e) => {
        e.stopPropagation();
        // Shift+click is a quick avatar re-roll — useful when an NPC
        // ended up with a weird-looking combo and you don't want to
        // open the customizer just to randomize.
        if (e.shiftKey) {
          if (!confirm(`Randomize avatar for ${sender}?`)) return;
          randomAvatar().then(cfg => {
            saveAvatar(fromEmail, cfg);
            // saveAvatar dispatches `avatar:updated`; the scene
            // listener composes the new texture and swaps it on the
            // NPC sprite + repaints any open portraits.
          }).catch(err => { console.warn('[avatar-reroll] failed', err); });
          return;
        }
        pop.remove();
        this.openProfileForEmail(fromEmail, sender);
      });
    }
    profile.appendChild(avatarEl);
    const profileText = document.createElement('div');
    profileText.style.cssText = 'flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:2px;';
    const nameEl = document.createElement('div');
    nameEl.textContent = sender;
    nameEl.style.cssText = 'font:600 16px ui-sans-serif,system-ui,sans-serif; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
    profileText.appendChild(nameEl);
    if (fromEmail && fromEmail !== sender) {
      const emailEl = document.createElement('div');
      emailEl.textContent = fromEmail;
      emailEl.style.cssText = 'font:12px ui-monospace,Consolas,monospace; color:#9cf; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
      profileText.appendChild(emailEl);
    }
    const stats = document.createElement('div');
    stats.innerHTML = `<span style="color:#d8b8ff;">📬 ${escapeHtml(String(threadIds.length))} unread</span>`;
    stats.style.cssText = 'font:11px ui-monospace,Consolas,monospace; margin-top:2px;';
    profileText.appendChild(stats);
    // "Going to" / "Then" — shows the NPC's path destinations so the
    // user can see where it's heading (and what comes after). Idlers
    // get no line. The active destination is first; queued ones follow.
    const dests = npc.upcomingDestinations();
    if (dests.length) {
      const route = document.createElement('div');
      const head = dests[0];
      const tail = dests.slice(1);
      const tailMarkup = tail.length
        ? ` <span style="color:#666;">→</span> <span style="color:#aaa;">${escapeHtml(tail.join(' → '))}</span>`
        : '';
      route.innerHTML = `<span style="color:#999;">→ Going to:</span> <span style="color:#ffd29c; font-weight:600;">${escapeHtml(head)}</span>${tailMarkup}`;
      route.style.cssText = 'font:11px ui-monospace,Consolas,monospace; margin-top:2px;';
      profileText.appendChild(route);
    }
    profile.appendChild(profileText);
    pop.appendChild(profile);

    // Rule section — lists any existing filters that match this sender,
    // plus a "Create rule" button that opens the editor pre-filled with
    // from:<sender email> so the user can refine and save.
    if (fromEmail) {
      pop.appendChild(this.makeNpcRulesSection(fromEmail, threadIds));
    }

    const carry: Array<{ threadId: string; subject: string; snippet: string; date?: string }> = Array.isArray(data.threads) ? data.threads : [];
    const findCarry = (tid: string) => carry.find(c => c.threadId === tid);
    const makeThreadRow = (threadId: string) => {
      const meta = findCarry(threadId) || this.findCachedThread(threadId) || undefined;
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; flex-direction:column; gap:4px; padding:8px; border:1px solid #222; border-radius:6px; background:#161616;';
      // Subject row: compact date pill on the left, subject takes the rest.
      const subjRow = document.createElement('div');
      subjRow.style.cssText = 'display:flex; gap:8px; align-items:baseline;';
      const dateChip = document.createElement('span');
      const isoDate = (meta as any)?.date || '';
      dateChip.textContent = formatCompactDate(isoDate);
      dateChip.style.cssText = 'flex:0 0 auto; color:#7a8b9f; font:600 11px ui-monospace,Consolas,monospace; min-width:40px;';
      if (isoDate) {
        const d = new Date(isoDate);
        if (!isNaN(d.getTime())) dateChip.title = d.toLocaleString();
      }
      const subj = document.createElement('span');
      subj.textContent = (meta as any)?.subject || '(no subject)';
      subj.style.cssText = 'flex:1 1 auto; min-width:0; font:600 13px ui-sans-serif,system-ui,sans-serif; color:#fff; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
      subjRow.appendChild(dateChip);
      subjRow.appendChild(subj);
      const snip = document.createElement('div');
      snip.textContent = (meta as any)?.snippet || '';
      snip.style.cssText = 'color:#888; font:12px ui-sans-serif,system-ui,sans-serif; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
      // Last-ditch: if neither carry nor cache had it, fetch from API
      // and patch the row in place. Keeps the popup functional even
      // when the NPC was spawned a long time ago and metadata is stale.
      if (!meta) {
        api.thread(threadId).then(t => {
          subj.textContent = t?.subject || '(no subject)';
          snip.textContent = t?.snippet || '';
          dateChip.textContent = formatCompactDate(t?.date);
          if (t?.date) {
            const d = new Date(t.date);
            if (!isNaN(d.getTime())) dateChip.title = d.toLocaleString();
          }
          if (snip.textContent && !snip.isConnected) row.appendChild(snip);
        }).catch(() => { /* leave as (no subject) */ });
      }
      row.appendChild(subjRow);
      if (snip.textContent) row.appendChild(snip);
      const actions = document.createElement('div');
      actions.style.cssText = 'display:flex; gap:6px; margin-top:4px;';
      const readBtn = document.createElement('button');
      readBtn.textContent = 'Read';
      readBtn.style.cssText = 'flex:1; background:#1f3a5f; color:#fff; border:1px solid #2c5688; border-radius:5px; padding:5px 10px; cursor:pointer; font:600 12px ui-sans-serif,system-ui,sans-serif;';
      readBtn.addEventListener('click', () => {
        pop.remove();
        const t = this.findCachedThread(threadId);
        if (t) this.openEmailFor(t);
        else openEmailContentPopup({
          threadId,
          destinations: this.destinationsForMove(threadId.split(':')[0], this.findCachedThread(threadId) || undefined),
          onMove: (id, lid, name) => this.moveThread(id, lid, name),
          onOpenProfile: (email) => this.openProfileForEmail(email),
        });
      });
      const moveBtn = document.createElement('button');
      moveBtn.textContent = 'Move to…';
      moveBtn.style.cssText = 'flex:1; background:#3a2050; color:#d8b8ff; border:1px solid #5a3580; border-radius:5px; padding:5px 10px; cursor:pointer; font:600 12px ui-sans-serif,system-ui,sans-serif;';
      moveBtn.addEventListener('click', () => this.openNpcMoveMenu(threadId, moveBtn));
      actions.appendChild(readBtn);
      actions.appendChild(moveBtn);
      row.appendChild(actions);
      return row;
    };
    for (const tid of threadIds) pop.appendChild(makeThreadRow(tid));

    // "Move ALL" button — appears only when the NPC carries more than
    // one thread. One walk, one destination, all threads relabeled.
    if (threadIds.length > 1) {
      const moveAllBtn = document.createElement('button');
      moveAllBtn.textContent = `Move all ${threadIds.length} to…`;
      moveAllBtn.style.cssText = `
        background:#3a2050; color:#d8b8ff; border:1px solid #5a3580; border-radius:6px;
        padding:8px 12px; cursor:pointer;
        font:600 13px ui-sans-serif,system-ui,sans-serif; margin-top:4px;
      `;
      moveAllBtn.addEventListener('click', () => this.openNpcMoveAllMenu(npc, moveAllBtn));
      pop.appendChild(moveAllBtn);
    }
  }

  // Build the "Rules" panel shown inside the NPC popup. Lists any
  // existing Gmail filters whose `from` criterion mentions this sender
  // (email or domain), and exposes a button that opens the rule editor
  // pre-filled with `from:<email>` and the right account selected.
  private makeNpcRulesSection(fromEmail: string, threadIds: string[]): HTMLDivElement {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'border:1px solid #222; border-radius:8px; padding:8px 10px; background:#141414; display:flex; flex-direction:column; gap:6px;';
    // Header row: section label + "create rule" CTA.
    const header = document.createElement('div');
    header.style.cssText = 'display:flex; justify-content:space-between; align-items:center;';
    const hLabel = document.createElement('div');
    hLabel.textContent = 'RULES';
    hLabel.style.cssText = 'color:#aaa; font:11px ui-monospace,Consolas,monospace; letter-spacing:0.08em;';
    const createBtn = document.createElement('button');
    createBtn.textContent = '+ Create rule';
    createBtn.title = `Open the rule editor pre-filled with from:${fromEmail}`;
    createBtn.style.cssText = 'background:#1f3a5f; color:#fff; border:1px solid #2c5688; border-radius:5px; padding:4px 10px; cursor:pointer; font:600 11px ui-sans-serif,system-ui,sans-serif;';
    // Pick the account this NPC's threads live in (most-common one) so
    // the editor opens with that account selected. Falls back to first.
    const accountCounts = new Map<string, number>();
    for (const id of threadIds) {
      const acct = id.split(':')[0];
      accountCounts.set(acct, (accountCounts.get(acct) || 0) + 1);
    }
    const preferredAccount = [...accountCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
      || this.currentAccounts[0]?.email;
    createBtn.addEventListener('click', () => {
      openRuleEditor({
        accounts: this.currentAccounts,
        labels: this.labelCache,
        onSaved: () => {
          // Force-refresh the scene rules cache, THEN re-render so the
          // new rule shows. Without the explicit wait we'd read the
          // stale cache before the dispatched 'rules:updated' listener
          // finished its background fetch.
          this.loadRulesCache(true).then(() => renderRules()).catch(() => renderRules());
        },
        prefill: {
          criteria: { from: fromEmail },
          account: preferredAccount,
        },
      });
    });
    header.appendChild(hLabel);
    header.appendChild(createBtn);
    wrap.appendChild(header);

    const list = document.createElement('div');
    list.style.cssText = 'display:flex; flex-direction:column; gap:4px; max-height:240px; overflow-y:auto;';
    wrap.appendChild(list);

    const renderRules = () => {
      list.innerHTML = '';
      // Synchronous read from the scene-wide rules cache — caller
      // (openNpcActionMenu) awaits loadRulesCache() before mounting
      // this section so the cache is guaranteed to be ready here.
      // No spinner, no post-mount mutation.
      const rules = this.rulesCache || [];
      const senderEmail = fromEmail.toLowerCase();
      const matches = rules.filter(r => {
        if (r.error) return false;
        const from = (r.criteria?.from || '').toLowerCase().trim();
        if (!from) return false;
        const tokens = from.split(/[\s,]+|\bor\b/i).map((s: string) => s.trim()).filter(Boolean);
        return tokens.some((tok: string) => {
          if (tok === senderEmail) return true;
          if (tok.startsWith('@')) return senderEmail.endsWith(tok);
          if (!tok.includes('@') && tok.includes('.')) {
            return senderEmail.endsWith('@' + tok) || senderEmail.endsWith('.' + tok);
          }
          return false;
        });
      });
      if (!matches.length) {
        const empty = document.createElement('div');
        empty.textContent = 'No matching rules.';
        empty.style.cssText = 'color:#666; font-style:italic; font-size:12px; padding:2px 0;';
        list.appendChild(empty);
        return;
      }
      for (const r of matches) {
        const row = document.createElement('div');
        row.style.cssText = 'padding:6px 8px; background:#1a1a1a; border:1px solid #262626; border-radius:5px; display:flex; flex-direction:column; gap:2px;';
        const acctLine = document.createElement('div');
        acctLine.textContent = r.account;
        acctLine.style.cssText = 'color:#888; font:10px ui-monospace,Consolas,monospace;';
        const summary = document.createElement('div');
        summary.textContent = `${summarizeRuleCriteria(r.criteria || {})} → ${summarizeRuleAction(r.action || {}, this.labelCache || [], r.account)}`;
        summary.style.cssText = 'color:#ddd; font:12px ui-sans-serif,system-ui,sans-serif;';
        row.appendChild(acctLine);
        row.appendChild(summary);
        list.appendChild(row);
      }
    };
    renderRules();
    return wrap;
  }

  // Companion picker for the "Move all" button — calls moveAllForNpc
  // with the selected destination instead of per-thread moveThread.
  private async openNpcMoveAllMenu(npc: NPC, anchor: HTMLElement): Promise<void> {
    document.querySelectorAll('[data-npc-move]').forEach(el => el.remove());
    if (!this.rulesCache) {
      try { await this.loadRulesCache(); } catch { /* logged inside */ }
    }
    const rect = anchor.getBoundingClientRect();
    // Move-all needs destinations whose labels cover EVERY account
    // represented by this NPC's threads (otherwise some threads would
    // get orphaned). Derive unique accounts from the thread ids.
    const tids: string[] = (npc.data as any)?.threadIds || [];
    const accounts = [...new Set(tids.map(id => id.split(':')[0]))];
    // ALL threads on a single NPC come from the same sender (spawn
    // groups by sender per building), so any cached thread is a valid
    // representative for suggestion lookup. Fall back to constructing
    // a stub from NPC data if the persistent cache evicted the real
    // thread (suggestions only need from.email + threadId).
    let repThread: EmailThread | undefined;
    for (const tid of tids) {
      const t = this.findCachedThread(tid);
      if (t) { repThread = t; break; }
    }
    if (!repThread && tids.length) {
      const data = (npc.data || {}) as any;
      if (data.fromEmail) {
        repThread = {
          threadId: tids[0],
          account: tids[0].split(':')[0],
          from: { email: data.fromEmail, name: data.fromName || '', avatar: null },
          labels: [],
          messages: [],
        } as unknown as EmailThread;
      }
    }
    const destinations = this.destinationsForMove(accounts, repThread);
    const pop = document.createElement('div');
    pop.setAttribute('data-npc-move', '1');
    pop.style.cssText = `
      position:fixed; top:${rect.bottom + 6}px;
      left:${Math.max(8, Math.min(rect.right - 320, window.innerWidth - 340))}px;
      z-index:1400; width:320px; max-height:60vh; overflow:hidden;
      background:#181818; color:#eee; border:1px solid #333; border-radius:8px;
      box-shadow:0 16px 40px rgba(0,0,0,0.75); padding:8px;
      display:flex; flex-direction:column; gap:6px;
    `;
    const search = document.createElement('input');
    search.placeholder = 'Search…';
    search.style.cssText = 'background:#0b0b0b; color:#eee; border:1px solid #333; border-radius:4px; padding:6px 10px; font:13px ui-sans-serif,system-ui,sans-serif;';
    const list = document.createElement('div');
    list.style.cssText = 'display:flex; flex-direction:column; gap:2px; overflow:auto;';
    pop.appendChild(search); pop.appendChild(list);
    pop.addEventListener('mousedown', (e) => e.stopPropagation());
    document.body.appendChild(pop);
    clampPopupToViewport(pop, { flipAboveAnchor: rect });
    const render = () => {
      list.innerHTML = '';
      const q = search.value.trim().toLowerCase();
      const filtered = destinations.filter(d => destinationMatches(d, q));
      for (const d of filtered.slice(0, 200)) {
        const r = document.createElement('div');
        r.style.cssText = 'padding:8px 10px; cursor:pointer; border-radius:4px;';
        const viaFloor = q ? matchedFloor(d, q) : null;
        const sugg = applySuggestionStyle(r, d);
        // When a rule suggestion targets a sub-label (e.g. Hobbies/Patreon
        // on a building bound to Hobbies), surface that path in the
        // sub-line so the user can see which floor the click will file to.
        const suggFloor = (!viaFloor && sugg && sugg.label && sugg.label !== d.label) ? sugg.label : null;
        const subText = viaFloor ? `via ${viaFloor}` : (suggFloor || d.label);
        const subColor = viaFloor ? '#a8e6c0' : (suggFloor ? '#a8e6c0' : '#7a8b9f');
        const suggLine = sugg
          ? `<div style="color:#6ad26a; font:600 10px ui-monospace,Consolas,monospace;">✨ Suggested · ${escapeHtml(sugg.reason)}</div>`
          : '';
        r.innerHTML = `<div style="font:600 13px ui-sans-serif,system-ui,sans-serif; color:#fff;">${escapeHtml(d.buildingName)}</div>
                       <div style="color:${subColor}; font:11px ui-monospace,Consolas,monospace;">${escapeHtml(subText)}</div>${suggLine}`;
        r.addEventListener('mouseenter', () => r.style.background = sugg ? 'rgba(106, 210, 106, 0.15)' : '#22272e');
        r.addEventListener('mouseleave', () => r.style.background = sugg ? 'rgba(106, 210, 106, 0.07)' : 'transparent');
        r.addEventListener('click', async () => {
          pop.remove();
          document.querySelectorAll('[data-npc-action]').forEach(el => el.remove());
          // Override label priority: explicit floor-search match wins
          // over the suggestion's matched label. Both end up calling
          // moveThread/moveAllForNpc with overrideLabel so the right
          // sub-label gets applied (rule → Hobbies/Patreon, not just
          // the parent Hobbies).
          try { await this.moveAllForNpc(npc, d.labelId, d.buildingName, viaFloor || sugg?.label || undefined); }
          catch (err) { alert(`Move all failed: ${err}`); }
        });
        list.appendChild(r);
      }
    };
    search.addEventListener('input', render);
    render();
    setTimeout(() => {
      search.focus();
      const away = (e: MouseEvent) => {
        if (pop.contains(e.target as Node)) return;
        pop.remove();
        document.removeEventListener('mousedown', away, true);
      };
      document.addEventListener('mousedown', away, true);
    }, 0);
  }

  // Companion to openNpcActionMenu: pops a searchable destinations
  // picker right next to the "Move to…" button.
  private async openNpcMoveMenu(threadId: string, anchor: HTMLElement): Promise<void> {
    document.querySelectorAll('[data-npc-move]').forEach(el => el.remove());
    // Ensure rules cache is hydrated BEFORE we compute suggestions so
    // the rule-match signal can promote its destination to the top.
    // Cache hit on every call after bootstrap → no perceptible delay.
    if (!this.rulesCache) {
      try { await this.loadRulesCache(); } catch { /* logged inside */ }
    }
    const rect = anchor.getBoundingClientRect();
    // Per-thread filter: only show buildings whose labels exist in
    // this thread's account.
    // Suggestions need a thread object to know the sender — fall back
    // to constructing a minimal stub from the owning NPC's data when
    // the persistent cache evicted the real thread. computeMoveSuggestions
    // only reads from.email + threadId, so the stub is sufficient.
    let forThread: EmailThread | undefined = this.findCachedThread(threadId) || undefined;
    if (!forThread) {
      const npc = this.npcs.find(n => {
        const tids = (n.data as any)?.threadIds as string[] | undefined;
        return Array.isArray(tids) && tids.includes(threadId);
      });
      const data = (npc?.data || {}) as any;
      if (data.fromEmail) {
        forThread = {
          threadId,
          account: threadId.split(':')[0],
          from: { email: data.fromEmail, name: data.fromName || '', avatar: null },
          labels: [],
          messages: [],
        } as unknown as EmailThread;
      }
    }
    const destinations = this.destinationsForMove(threadId.split(':')[0], forThread);
    const pop = document.createElement('div');
    pop.setAttribute('data-npc-move', '1');
    pop.style.cssText = `
      position:fixed; top:${rect.bottom + 6}px;
      left:${Math.max(8, Math.min(rect.right - 320, window.innerWidth - 340))}px;
      z-index:1400; width:320px; max-height:60vh; overflow:hidden;
      background:#181818; color:#eee; border:1px solid #333; border-radius:8px;
      box-shadow:0 16px 40px rgba(0,0,0,0.75); padding:8px;
      display:flex; flex-direction:column; gap:6px;
    `;
    const search = document.createElement('input');
    search.placeholder = 'Search buildings / labels…';
    search.style.cssText = 'background:#0b0b0b; color:#eee; border:1px solid #333; border-radius:4px; padding:6px 10px; font:13px ui-sans-serif,system-ui,sans-serif;';
    const list = document.createElement('div');
    list.style.cssText = 'display:flex; flex-direction:column; gap:2px; overflow:auto;';
    pop.appendChild(search); pop.appendChild(list);
    pop.addEventListener('mousedown', (e) => e.stopPropagation());
    document.body.appendChild(pop);
    clampPopupToViewport(pop, { flipAboveAnchor: rect });
    const render = () => {
      list.innerHTML = '';
      const q = search.value.trim().toLowerCase();
      const filtered = destinations.filter(d => destinationMatches(d, q));
      for (const d of filtered.slice(0, 200)) {
        const r = document.createElement('div');
        r.style.cssText = 'padding:8px 10px; cursor:pointer; border-radius:4px;';
        const viaFloor = q ? matchedFloor(d, q) : null;
        const sugg = applySuggestionStyle(r, d);
        // When a rule suggestion targets a sub-label (e.g. Hobbies/Patreon
        // on a building bound to Hobbies), surface that path in the
        // sub-line so the user can see which floor the click will file to.
        const suggFloor = (!viaFloor && sugg && sugg.label && sugg.label !== d.label) ? sugg.label : null;
        const subText = viaFloor ? `via ${viaFloor}` : (suggFloor || d.label);
        const subColor = viaFloor ? '#a8e6c0' : (suggFloor ? '#a8e6c0' : '#7a8b9f');
        const suggLine = sugg
          ? `<div style="color:#6ad26a; font:600 10px ui-monospace,Consolas,monospace;">✨ Suggested · ${escapeHtml(sugg.reason)}</div>`
          : '';
        r.innerHTML = `<div style="font:600 13px ui-sans-serif,system-ui,sans-serif; color:#fff;">${escapeHtml(d.buildingName)}</div>
                       <div style="color:${subColor}; font:11px ui-monospace,Consolas,monospace;">${escapeHtml(subText)}</div>${suggLine}`;
        r.addEventListener('mouseenter', () => r.style.background = sugg ? 'rgba(106, 210, 106, 0.15)' : '#22272e');
        r.addEventListener('mouseleave', () => r.style.background = sugg ? 'rgba(106, 210, 106, 0.07)' : 'transparent');
        r.addEventListener('click', async () => {
          pop.remove();
          document.querySelectorAll('[data-npc-action]').forEach(el => el.remove());
          // Override label priority: explicit floor-search match wins
          // over the rule-suggestion's matched label. Either way the
          // specific sub-label flows through to moveThread so the
          // email files under the right floor (e.g. Hobbies/Patreon,
          // not just Hobbies).
          try { await this.moveThread(threadId, d.labelId, d.buildingName, viaFloor || sugg?.label || undefined); }
          catch (err) { alert(`Move failed: ${err}`); }
        });
        list.appendChild(r);
      }
    };
    search.addEventListener('input', render);
    render();
    setTimeout(() => {
      search.focus();
      const away = (e: MouseEvent) => {
        if (pop.contains(e.target as Node)) return;
        pop.remove();
        document.removeEventListener('mousedown', away, true);
      };
      document.addEventListener('mousedown', away, true);
    }, 0);
  }

  // Look up a thread by id across every cached label. Used by NPC
  // click — we usually have it from the spawn-time fetch.
  private findCachedThread(threadId: string): EmailThread | null {
    for (const list of this.emailCache.values()) {
      const t = list.find(x => x.threadId === threadId);
      if (t) return t;
    }
    return null;
  }

  // Build the destination list for the "Move to…" picker. Pass
  // `threadAccount(s)` to filter out buildings whose labels don't
  // exist in those accounts (otherwise the move would strip INBOX
  // without filing the thread anywhere — orphaned).
  //
  // - threadAccounts = string         → single thread; building must
  //   have at least one label that exists in that account.
  // - threadAccounts = string[]       → multi-thread (Move all); building
  //   must have at least one label in EVERY listed account so every
  //   thread can be filed somewhere.
  // - omitted                         → no filter (legacy callers).
  // Computes "suggested move" hints for a single thread. Three
  // strategies layered on top of each other; the highest-confidence
  // suggestion per label wins. Caller (destinationsForMove) uses these
  // to flag destinations whose bound labels match — those float to the
  // top of every Move-to picker with a green highlight + a caption.
  // Session-scoped cache of Gmail filters used by suggestion-engine
  // and the Rules pane. Loaded once on auth bootstrap and refreshed
  // whenever a rule is created/deleted via the in-app editor so the
  // suggestion engine reflects new rules immediately.
  private rulesCache: any[] | null = null;
  private rulesCacheInFlight: Promise<any[]> | null = null;
  loadRulesCache(force = false): Promise<any[]> {
    if (!force && this.rulesCache) return Promise.resolve(this.rulesCache);
    if (this.rulesCacheInFlight) return this.rulesCacheInFlight;
    this.rulesCacheInFlight = api.filters().then(rules => {
      this.rulesCache = rules as any[];
      this.rulesCacheInFlight = null;
      return this.rulesCache;
    }).catch(err => {
      this.rulesCacheInFlight = null;
      console.warn('[rules-cache] fetch failed:', err);
      return [];
    });
    return this.rulesCacheInFlight;
  }

  // Walk cached rules and return any whose `from` criterion matches
  // the given sender. Each match is mapped to the label name it would
  // apply (first non-system add label). Returns label names only —
  // caller wraps them as suggestions with the right confidence.
  private rulesMatchingSender(senderEmail: string): Array<{ labelName: string; account: string }> {
    const rules = this.rulesCache;
    if (!rules) return [];
    const labels = this.labelCache || [];
    const senderLower = senderEmail.toLowerCase();
    const SYSTEM = new Set(['INBOX', 'SENT', 'DRAFT', 'SPAM', 'TRASH', 'UNREAD', 'STARRED', 'IMPORTANT']);
    const out: Array<{ labelName: string; account: string }> = [];
    for (const r of rules) {
      if (r.error) continue;
      const from = (r.criteria?.from || '').toLowerCase().trim();
      if (!from) continue;
      const tokens = from.split(/[\s,]+|\bor\b/i).map((s: string) => s.trim()).filter(Boolean);
      const senderMatches = tokens.some((tok: string) => {
        if (tok === senderLower) return true;
        if (tok.startsWith('@')) return senderLower.endsWith(tok);
        if (!tok.includes('@') && tok.includes('.')) {
          return senderLower.endsWith('@' + tok) || senderLower.endsWith('.' + tok);
        }
        return false;
      });
      if (!senderMatches) continue;
      // Resolve the rule's add-label id → label name in the rule's account.
      const adds: string[] = r.action?.addLabelIds || [];
      for (const rawId of adds) {
        if (SYSTEM.has(rawId)) continue;     // skip STARRED/IMPORTANT etc.
        const found = labels.find(l => l.account === r.account && l.rawId === rawId);
        if (found) out.push({ labelName: found.name, account: r.account });
      }
    }
    return out;
  }

  // Scan every cached inbox thread for senders whose existing rules
  // WOULD have filed them but never did (typically: the rule was made
  // after the email arrived). Used by the "Suggested moves" tab on
  // the rules pane for quick batch cleanup.
  //
  // Returns per-thread/per-rule matches sorted with newest threads
  // first. Bounded by what's actually in the cache — if the user's
  // inbox is bigger than THREAD_LIMIT they'll need to refresh / scan
  // to see deeper matches.
  async findStaleRuleMatches(): Promise<StaleRuleMatch[]> {
    if (!this.rulesCache) await this.loadRulesCache();
    const rules = this.rulesCache || [];
    const labels = this.labelCache || [];
    const SYSTEM = new Set(['INBOX', 'SENT', 'DRAFT', 'SPAM', 'TRASH', 'UNREAD', 'STARRED', 'IMPORTANT']);
    const inbox = this.emailCache.get('INBOX') || [];
    const out: StaleRuleMatch[] = [];
    // Pre-build building-by-label map so we resolve the destination
    // building once per (account, labelName) instead of per match.
    const buildingForLabel = (labelName: string): string | null => {
      for (const b of this.buildings) {
        const bound = getBuildingLabels(b);
        if (bound.includes(labelName)) return b.name;
        if (bound.some(n => labelName.startsWith(`${n}/`))) return b.name;
      }
      return null;
    };
    for (const t of inbox) {
      const senderLower = (t.from?.email || '').toLowerCase();
      if (!senderLower) continue;
      for (const r of rules) {
        if (r.error) continue;
        if (r.account !== t.account) continue;
        const from = (r.criteria?.from || '').toLowerCase().trim();
        if (!from) continue;
        const tokens = from.split(/[\s,]+|\bor\b/i).map((s: string) => s.trim()).filter(Boolean);
        const senderMatches = tokens.some((tok: string) => {
          if (tok === senderLower) return true;
          if (tok.startsWith('@')) return senderLower.endsWith(tok);
          if (!tok.includes('@') && tok.includes('.')) {
            return senderLower.endsWith('@' + tok) || senderLower.endsWith('.' + tok);
          }
          return false;
        });
        if (!senderMatches) continue;
        // First non-system add label is the rule's destination.
        const adds: string[] = r.action?.addLabelIds || [];
        const targetRawId = adds.find(id => !SYSTEM.has(id));
        if (!targetRawId) continue;
        // Already applied? Then it's not stale.
        if (t.labels.includes(targetRawId)) continue;
        const targetLabel = labels.find(l => l.account === r.account && l.rawId === targetRawId)?.name;
        if (!targetLabel) continue;
        out.push({
          thread: t,
          rule: r as any,
          targetLabel,
          buildingName: buildingForLabel(targetLabel),
        });
      }
    }
    // Newest threads first so the most urgent cleanup floats to the top.
    out.sort((a, b) => new Date(b.thread.date).getTime() - new Date(a.thread.date).getTime());
    return out;
  }

  // Apply one stale-rule match: file the inbox thread under the rule's
  // add-label and remove INBOX. Same moveThread path the NPC popup
  // uses, so all the badge / cache / popup-refresh side-effects are
  // taken care of for free.
  async applyStaleRuleMatch(m: StaleRuleMatch): Promise<void> {
    // Find a building bound to the target label (preferred) so the
    // user's world animation runs. If none, fall back to the label
    // name itself — moveThread will look up a building bound to that
    // exact name and abort cleanly if none exists.
    const targetBuilding = this.buildings.find(b => {
      const bound = getBuildingLabels(b);
      return bound.includes(m.targetLabel) || bound.some(n => m.targetLabel.startsWith(`${n}/`));
    });
    const destLabelId = targetBuilding ? `building:${targetBuilding.id}` : m.targetLabel;
    const destName = targetBuilding?.name || m.targetLabel;
    // Override-label = the rule's target (so a rule that fires
    // Hobbies/Patreon files to the floor, not the parent Hobbies).
    return this.moveThread(m.thread.threadId, destLabelId, destName, m.targetLabel);
  }

  private computeMoveSuggestions(thread: EmailThread): Array<{ labelName: string; confidence: number; reason: string }> {
    const senderEmail = thread.from?.email?.toLowerCase();
    if (!senderEmail) return [];
    const senderDomain = senderEmail.split('@')[1] || '';
    const all = this.getAllCachedThreads();
    const labelByIdKey = new Map<string, string>();
    for (const l of (this.labelCache || [])) labelByIdKey.set(`${l.account}:${l.rawId}`, l.name);

    // (1) + (2): count per-label co-filings for the same sender (and
    // separately for the same domain).
    const senderLabelCounts = new Map<string, number>();
    const domainLabelCounts = new Map<string, number>();
    for (const t of all) {
      if (t.threadId === thread.threadId) continue;
      const fromE = t.from?.email?.toLowerCase();
      if (!fromE) continue;
      const labelNames = t.labels
        .map(rawId => labelByIdKey.get(`${t.account}:${rawId}`))
        .filter((n): n is string => !!n && n !== 'INBOX');
      if (fromE === senderEmail) {
        for (const n of labelNames) senderLabelCounts.set(n, (senderLabelCounts.get(n) || 0) + 1);
      } else if (senderDomain && fromE.endsWith(`@${senderDomain}`)) {
        for (const n of labelNames) domainLabelCounts.set(n, (domainLabelCounts.get(n) || 0) + 1);
      }
    }

    const out: Array<{ labelName: string; confidence: number; reason: string }> = [];
    // (0) Existing Gmail filter match — top priority. If the user
    // already created a rule that would label this email, suggest
    // its destination first. Rules made AFTER an email arrived don't
    // back-apply to that email; this surface lets the user finish
    // the job with one click. Confidence 1.0 so rule matches always
    // sort above any history-based signal.
    if (this.rulesCache) {
      const ruleMatches = this.rulesMatchingSender(senderEmail);
      const seenLabels = new Set<string>();
      for (const m of ruleMatches) {
        if (seenLabels.has(m.labelName)) continue;
        seenLabels.add(m.labelName);
        out.push({
          labelName: m.labelName,
          confidence: 1.0,
          // Spell out the destination label in the reason. When the
          // rule targets a floor (e.g. Hobbies/Patreon) the popup row
          // shows only the building label ("Hobbies") in its sub-line,
          // so without this text the user has no signal that clicking
          // will file to the specific floor.
          reason: `Rule on ${m.account} → ${m.labelName}`,
        });
      }
    } else {
      // First time a suggestion is requested — kick off a background
      // fetch so the NEXT picker (this session) gets rule matches.
      this.loadRulesCache();
    }
    // Unsubscribe-link signal — if any message in this thread exposes
    // the List-Unsubscribe header (or a body-link fallback), it's almost
    // certainly a newsletter/promo. Boost every label bound to a
    // Newsletters/* path or JUNK MAIL so the matching building floats
    // toward the top. Confidence 0.92 sits below explicit rules (1.0)
    // but above any sender-history signal. Stub threads from the NPC
    // popup don't carry messages, so this only fires when we have the
    // full thread cached — which is the common case.
    const hasUnsubscribe = Array.isArray(thread.messages) && thread.messages.some(m => !!m?.unsubscribe);
    if (hasUnsubscribe) {
      const seenLabels = new Set(out.map(s => s.labelName));
      for (const l of (this.labelCache || [])) {
        if (seenLabels.has(l.name)) continue;
        const lower = l.name.toLowerCase();
        const isNewsletter = lower === 'newsletters' || lower.startsWith('newsletters/');
        const isJunk = lower === 'junk mail' || lower === 'junk' || lower.startsWith('junk/');
        if (!isNewsletter && !isJunk) continue;
        out.push({
          labelName: l.name,
          confidence: 0.92,
          reason: isJunk
            ? 'Has unsubscribe link — likely junk'
            : 'Has unsubscribe link — likely a newsletter',
        });
        seenLabels.add(l.name);
      }
    }
    // Same-sender history dominates among non-rule signals.
    for (const [labelName, count] of senderLabelCounts) {
      if (count < 2) continue;
      // Skip if a rule already covers this label — keep the higher-
      // confidence rule suggestion and don't duplicate.
      if (out.find(s => s.labelName === labelName)) continue;
      out.push({
        labelName,
        confidence: Math.min(0.95, 0.7 + count * 0.04),
        reason: `${count} email${count === 1 ? '' : 's'} from this sender already here`,
      });
    }
    // Domain history fills gaps the sender history didn't cover.
    for (const [labelName, count] of domainLabelCounts) {
      if (count < 2) continue;
      if (senderLabelCounts.has(labelName)) continue;
      if (out.find(s => s.labelName === labelName)) continue;
      out.push({
        labelName,
        confidence: Math.min(0.85, 0.55 + count * 0.03),
        reason: `${count} email${count === 1 ? '' : 's'} from @${senderDomain} already here`,
      });
    }
    // (3) Label-name vs sender-domain stem match. "tellart.com" → look
    // for any label segment containing "tellart". Only fires when no
    // co-filing signal covered the label already.
    if (senderDomain) {
      const stem = senderDomain.split('.')[0].toLowerCase();
      if (stem.length >= 4) {
        const seenLabels = new Set(out.map(s => s.labelName));
        for (const l of (this.labelCache || [])) {
          if (seenLabels.has(l.name)) continue;
          const segments = l.name.toLowerCase().split('/');
          if (segments.some(seg => seg === stem || seg.includes(stem))) {
            out.push({ labelName: l.name, confidence: 0.6, reason: `Label name matches "${senderDomain}"` });
            seenLabels.add(l.name);
          }
        }
      }
    }
    out.sort((a, b) => b.confidence - a.confidence);
    return out;
  }

  // Walk every in-memory thread cache and patch the labels array on
  // any thread whose threadId matches. Adds the new label's rawId
  // (resolved from name + account via the label cache), removes any
  // names in `removeNames` (also rawId-resolved). Same object refs as
  // open popups hold, so their next render sees the new state.
  private patchLocalThreadLabels(threadId: string, addName: string, removeNames: string[]): void {
    const labels = this.labelCache || [];
    const account = threadId.split(':')[0];
    const addRaw = addName === 'INBOX'
      ? 'INBOX'
      : labels.find(l => l.account === account && l.name === addName)?.rawId;
    const removeRawSet = new Set<string>(
      removeNames.map(n => n === 'INBOX'
        ? 'INBOX'
        : labels.find(l => l.account === account && l.name === n)?.rawId)
        .filter((v): v is string => !!v),
    );
    let patched = 0;
    const apply = (t: EmailThread) => {
      if (t.threadId !== threadId) return;
      const before = t.labels.length;
      t.labels = t.labels.filter(rid => !removeRawSet.has(rid));
      if (addRaw && !t.labels.includes(addRaw)) t.labels.push(addRaw);
      if (t.labels.length !== before || t.labels.includes(addRaw || '')) patched++;
    };
    for (const arr of this.emailCache.values()) for (const t of arr) apply(t);
    if (patched > 0) console.log(`[move] patched labels on ${patched} cached thread copies`);
    // Notify any open UI that holds its own thread references (e.g. the
    // person profile popup includes threads it fetched fresh from
    // /api/threads/:id — those never lived in emailCache so the loop
    // above doesn't reach them). Listeners patch their own copies and
    // schedule a re-render.
    try {
      document.dispatchEvent(new CustomEvent('thread:labels-updated', {
        detail: { threadId, addedRawId: addRaw || null, removedRawIds: [...removeRawSet] },
      }));
    } catch { }
  }

  // Find any in-memory copy of a thread by id. Returns the first hit
  // from emailCache — multiple labels may hold the same thread; they
  // should all share the same object reference by now (set during the
  // original fetch), so any one is fine for read-only inspection.
  private findThreadInCache(threadId: string): EmailThread | null {
    for (const arr of this.emailCache.values()) {
      for (const t of arr) if (t.threadId === threadId) return t;
    }
    return null;
  }

  // Drop a thread from one label's cached list (and persist the
  // change). Used after a move so the source label's cache no longer
  // claims a thread that has been re-filed elsewhere. Other threads
  // in the cache are untouched — important so unrelated senders stay
  // visible to the People grid.
  private removeThreadFromLabelCache(labelName: string, threadId: string): void {
    const arr = this.emailCache.get(labelName);
    if (!arr) return;
    const idx = arr.findIndex(t => t.threadId === threadId);
    if (idx < 0) return;
    arr.splice(idx, 1);
    // Persistent cache layer is gone — SQLite is the source of truth.
    // In-memory emailCache is the only thing left to mutate.
  }

  // Insert a thread into a label's cached list if it isn't already
  // there. Skipped when the label has no cache entry yet (next fetch
  // will pick it up).
  private addThreadToLabelCache(labelName: string, thread: EmailThread): void {
    const arr = this.emailCache.get(labelName);
    if (!arr) return;
    if (arr.some(t => t.threadId === thread.threadId)) return;
    arr.unshift(thread);     // newest-first matches the API's default order
  }

  // For a single thread, list the building NAMES it is currently filed
  // under. A thread "lives in" a building when any of that building's
  // bound labels appears on the thread — OR when any of the thread's
  // labels is a sub-label of a bound label (so a building bound to
  // "Hobbies" still claims a thread carrying "Hobbies/Patreon", and
  // a building bound to "Archive" still claims "Archive/NTT" etc.).
  // Without that prefix match, moves where the chosen label is a
  // floor sub-label would silently drop the building chip.
  // INBOX maps to whichever building is bound to "INBOX" (Post Office
  // by convention).
  private buildingsContainingThread(t: EmailThread): string[] {
    const labels = this.labelCache || [];
    const account = t.account;
    const nameOnThread = new Set<string>();
    for (const rawId of t.labels) {
      if (rawId === 'INBOX') { nameOnThread.add('INBOX'); continue; }
      const l = labels.find(ll => ll.account === account && ll.rawId === rawId);
      if (l) nameOnThread.add(l.name);
    }
    const out: string[] = [];
    for (const b of this.buildings) {
      const bound = getBuildingLabels(b);
      const match = bound.some(n =>
        nameOnThread.has(n) ||                     // exact bound label is on the thread
        [...nameOnThread].some(threadLabel =>      // OR thread has a sub-label of bound
          threadLabel.startsWith(`${n}/`)
        ),
      );
      if (match) out.push(b.name);
    }
    return out;
  }

  private destinationsForMove(threadAccounts?: string | string[], forThread?: EmailThread): Array<{ labelId: string; label: string; buildingName: string; floors: string[]; searchText: string; suggestion?: { confidence: number; reason: string; label: string } }> {
    const accounts = typeof threadAccounts === 'string' ? [threadAccounts]
      : Array.isArray(threadAccounts) ? threadAccounts : null;
    const allLabels = this.labelCache || [];
    const labelsByAccount: Map<string, Set<string>> = new Map();
    if (accounts) {
      for (const acct of accounts) {
        const names = allLabels.filter(l => l.account === acct).map(l => l.name);
        labelsByAccount.set(acct, new Set(names));
      }
    }
    // Account scope for floor lookup. If no account filter was given,
    // include floors from every account so the search can find them.
    const floorAccountScope = accounts ?? [...new Set(allLabels.map(l => l.account))];
    // Per-label suggestions for the optional `forThread`. Look up by
    // label name when decorating each destination.
    const suggestions = forThread ? this.computeMoveSuggestions(forThread) : [];
    const suggestionByLabel = new Map(suggestions.map(s => [s.labelName, s]));
    return this.buildings
      .filter(b => {
        const names = getBuildingLabels(b).filter(n => n !== 'INBOX');
        if (!names.length) return false;
        if (!accounts) return true;
        // Building must have at least one label in EVERY listed account.
        return accounts.every(acct => {
          const inAcct = labelsByAccount.get(acct)!;
          return names.some(n => inAcct.has(n));
        });
      })
      .map(b => {
        const names = getBuildingLabels(b).filter(n => n !== 'INBOX');
        const summary = names.length === 1 ? names[0] : `${names[0]}  +${names.length - 1}`;
        // Floors — also checked against suggestions so a floor-only
        // suggestion still bubbles its building to the top.
        const floors: string[] = [];
        for (const parent of names) {
          const prefix = parent + '/';
          for (const l of allLabels) {
            if (!floorAccountScope.includes(l.account)) continue;
            if (l.name.startsWith(prefix)) floors.push(l.name);
          }
        }
        const searchText = [b.name, ...names, ...floors].join(' ').toLowerCase();
        // Find the highest-confidence suggestion that mentions any of
        // this building's bound labels or any of its floor sub-labels.
        // Remember the matched label so click handlers can pass it as
        // overrideLabel — letting a "rule says Hobbies/Patreon" hint
        // actually file the email under Hobbies/Patreon (not just the
        // parent Hobbies building label).
        let suggestion: { confidence: number; reason: string; label: string } | undefined;
        for (const n of [...names, ...floors]) {
          const s = suggestionByLabel.get(n);
          if (s && (!suggestion || s.confidence > suggestion.confidence)) {
            suggestion = { confidence: s.confidence, reason: s.reason, label: n };
          }
        }
        return { labelId: `building:${b.id}`, label: summary, buildingName: b.name, floors, searchText, suggestion };
      })
      .sort((a, b) => {
        // Suggested destinations float to the top, by descending
        // confidence. Alphabetical fallback below that.
        const sa = a.suggestion?.confidence ?? 0;
        const sb = b.suggestion?.confidence ?? 0;
        if (sa !== sb) return sb - sa;
        return a.buildingName.localeCompare(b.buildingName);
      });
  }

  // Open the full-thread content popup for a given email/thread. Pre-
  // populated from the cached thread so reading is instant; if for some
  // reason we don't have it cached (clicking an NPC, say), the popup
  // itself will fetch it from /api/threads/:id.
  // Side-effect: opening counts as "I've seen this" — if the thread
  // was unread we fire mark-read in the background and patch the cached
  // copy so subsequent renders reflect it without a re-fetch.
  private openEmailFor(t: EmailThread): void {
    if (!t.isRead) this.markThreadRead(t);
    openEmailContentPopup({
      thread: t,
      // Filter to destinations whose labels exist in THIS thread's
      // account — prevents proposing buildings that can't actually
      // receive this email.
      destinations: this.destinationsForMove(t.account, t),
      onMove: (threadId, destLabelId, destBuilding) => this.moveThread(threadId, destLabelId, destBuilding),
      onOpenProfile: (email) => this.openProfileForEmail(email),
    });
  }

  // ---- Manual refresh + background poll ----
  // R key bulk-invalidates the cache and respawns all NPCs from fresh
  // Gmail data. Shows a quick toast so the user knows it's working.
  // Also kicks off a lightweight 60s INBOX poll once at startup — if the
  // unread INBOX count changes between polls, we trigger the same refresh
  // automatically. Skipped while any modal is open or the user is typing.
  private refreshToastEl: HTMLDivElement | null = null;
  private lastInboxCount: number | null = null;
  private pollIntervalId: number | null = null;
  private isRefreshing = false;

  private showRefreshToast(message: string, kind: 'info' | 'ok' | 'err' = 'info'): void {
    if (this.refreshToastEl) this.refreshToastEl.remove();
    const bg = kind === 'err' ? '#3b1f1f' : kind === 'ok' ? '#1f3a1f' : '#1f2937';
    const fg = kind === 'err' ? '#fcc' : kind === 'ok' ? '#cfc' : '#9cf';
    const toast = document.createElement('div');
    toast.style.cssText = `
      position:fixed; top:60px; right:12px; z-index:55;
      background:${bg}; color:${fg}; border:1px solid #333; border-radius:6px;
      padding:8px 14px; font:600 13px ui-monospace,Consolas,monospace;
      box-shadow:0 4px 16px rgba(0,0,0,0.6); pointer-events:none;
      transition:opacity 0.3s; opacity:1;
    `;
    toast.textContent = message;
    document.body.appendChild(toast);
    this.refreshToastEl = toast;
    setTimeout(() => { toast.style.opacity = '0'; }, 2200);
    setTimeout(() => { if (toast === this.refreshToastEl) { toast.remove(); this.refreshToastEl = null; } }, 2600);
  }

  async refreshAllEmails(silent = false): Promise<void> {
    if (this.isRefreshing) return;
    this.isRefreshing = true;
    if (!silent) this.showRefreshToast('Refreshing inbox…');
    setStatus('Refreshing inbox…', { tone: 'info', ttlMs: 0 });
    this.emailCache.clear();
    this.emailFetchPromises.clear();
    try {
      await this.respawnEmailNPCs();
      this.lastInboxCount = await this.fetchInboxUnreadCount();
      if (!silent) this.showRefreshToast(`Refreshed. ${this.npcs.length} NPCs from ${this.lastInboxCount ?? '?'} inbox unread.`, 'ok');
      setStatus(`Refreshed. ${this.npcs.length} NPCs, ${this.lastInboxCount ?? '?'} unread.`, { tone: 'ok' });
    } catch (err) {
      console.warn('[refresh] failed', err);
      if (!silent) this.showRefreshToast(`Refresh failed: ${err}`, 'err');
      setStatus(`Refresh failed: ${err}`, { tone: 'err', ttlMs: 6000 });
    } finally {
      this.isRefreshing = false;
    }
  }

  private async fetchInboxUnreadCount(): Promise<number | null> {
    try {
      const { count } = await api.unreadCount({ labelIds: 'INBOX' });
      return count;
    } catch { return null; }
  }

  // Quietly poll INBOX every 60s; only act if the count changed AND nothing
  // is in the user's way (no open modal, not typing, not mid-move). Modals
  // are detected by any element with style.position:fixed and high z-index
  // — we approximate by looking for our known modal classes / data attrs.
  private startBackgroundPolling(): void {
    if (this.pollIntervalId !== null) return;
    this.pollIntervalId = window.setInterval(async () => {
      if (this.isTyping || this.isRefreshing) return;
      if (this.buildingPopupEl || this.buildingGridEl || this.inspectEl || this.minimapEl) return;
      // Also bail if any of our DOM popups exist (email content, person popup)
      if (document.querySelector('[data-move-menu]')) return;
      const c = await this.fetchInboxUnreadCount();
      if (c === null) return;
      if (this.lastInboxCount === null) { this.lastInboxCount = c; return; }
      if (c !== this.lastInboxCount) {
        console.log(`[poll] inbox unread changed: ${this.lastInboxCount} → ${c} — refreshing`);
        this.lastInboxCount = c;
        await this.refreshAllEmails(true);
      }
    }, 60_000);
  }

  // --- Email-driven NPC spawning ----
  // ONE NPC per (building, sender email). A person sending you 5 unread
  // emails in the same label = ONE NPC carrying all 5 thread ids. Click
  // → list of threads to read or move individually, or "Move all".
  //
  // Sender identity is t.from (latest sender). For inbox threads where
  // the user hasn't replied, this is the other person — exactly who we
  // want the NPC to represent.

  // Destroy every NPC and rebuild the world from the current cache +
  // a fresh fetch of unread threads per labeled building. Idempotent —
  // safe to call after every move or refresh.
  async respawnEmailNPCs(): Promise<void> {
    for (const npc of this.npcs) npc.destroy();
    this.npcs = [];
    const labelled = this.buildings.filter(b => getBuildingLabels(b).length > 0);
    await Promise.allSettled(labelled.map(async (b) => {
      const threads = await this.loadThreadsForBuilding(b);
      const door = this.findDoorForBuilding(b);
      if (!door) {
        console.warn(`[npc-spawn] no door for "${b.name}" — skipping`);
        return;
      }
      // Group unread threads by sender email.
      const bySender = new Map<string, { name: string; threads: EmailThread[] }>();
      for (const t of threads) {
        if (t.isRead) continue;
        const email = t.from?.email?.toLowerCase();
        if (!email) continue;
        if (!bySender.has(email)) {
          bySender.set(email, { name: t.from?.name || email, threads: [] });
        }
        bySender.get(email)!.threads.push(t);
      }
      // Spawn in parallel — composeAndRegisterAvatar caches by config
      // hash so duplicate work across NPCs is shared.
      await Promise.all(
        [...bySender.entries()].map(([email, group]) =>
          this.spawnPersonNPC(b, door, email, group.name, group.threads)
        )
      );
      // Per-building diagnostic: which senders ended up here, with
      // their unread thread counts. Helps debug "why is this NPC over
      // there" when there are multiple unread threads from one sender.
      if (bySender.size > 0) {
        const summary = [...bySender.entries()]
          .map(([email, g]) => `${email}=${g.threads.length}`)
          .join(', ');
        console.log(`[npc-spawn] "${b.name}" → ${bySender.size} sender(s): ${summary}`);
      }
    }));
    console.log(`[npc-spawn] spawned ${this.npcs.length} person-NPCs across ${labelled.length} buildings`);
    this.updateBuildingBadges();
    // Kick off authoritative unread counts in the background so badges
    // settle to Gmail truth — important when the user's inbox is bigger
    // than THREAD_LIMIT and the NPC-derived count under-reports.
    this.refreshBuildingUnreadCounts().catch(err =>
      console.warn('[badges] unread refresh failed:', err));
  }

  // Spawn a single NPC for one sender at this building, carrying all
  // their unread thread ids. Wander is constrained to the building's
  // rect + a small padding so each NPC stays close to home.
  private async spawnPersonNPC(building: Building, door: Door, fromEmail: string, fromName: string, threads: EmailThread[]): Promise<void> {
    // Spawn EXACTLY at the door tile's center — not a random scatter
    // around the door's pixel position. The pixel position can sit
    // close to (or just inside) a solid building tile, causing the
    // physics body to wedge there and the NPC to appear "stuck" inside
    // or behind the building. The door TILE is always walkable (doors
    // are filtered out if blocked). NPC-NPC collisions will spread
    // overlapping spawns apart on the first few frames.
    const TILE = 48;
    const spawnX = door.tx * TILE + TILE / 2;
    const spawnY = door.ty * TILE + TILE / 2;
    // Resolve (or randomly generate + persist) this sender's layered
    // AvatarConfig, then compose all layer sheets into a single Phaser
    // texture with idle/walk/stand animations registered on it.
    // Cached by config hash so 50 NPCs sharing a body variant share
    // one texture + one animation set.
    const cfg = await ensureAvatar(fromEmail);
    const textureKey = await composeAndRegisterAvatar(this, cfg);
    // Capture thread metadata (subject/snippet/date) at spawn time so
    // the NPC's tooltip and click menu can render them without needing
    // a live cache lookup. Cache invalidations from polling / moves
    // would otherwise make the menu show "(no subject)" for everyone.
    // `threadIds` is kept as a derived array for back-compat with code
    // paths that just need the id list.
    const carry = threads.map(t => ({
      threadId: t.threadId,
      subject: t.subject || '(no subject)',
      snippet: t.snippet || '',
      date: t.date || '',
    }));
    const npc = new NPC(this, this.grid, this.doors, { x: spawnX, y: spawnY }, textureKey, {
      data: {
        fromName, fromEmail,
        threads: carry,
        threadIds: carry.map(t => t.threadId),
        homeBuildingId: building.id,
      },
      homeDoor: door,
      homeBounds: { x: building.x, y: building.y, w: building.w, h: building.h },
      homeRadius: 3,
    });
    if (this.backgroundLayer)    this.physics.add.collider(npc.sprite, this.backgroundLayer);
    if (this.groundObjectsLayer) this.physics.add.collider(npc.sprite, this.groundObjectsLayer);
    if (this.buildingsLayer)     this.physics.add.collider(npc.sprite, this.buildingsLayer);
    if (this.treesLayer)         this.physics.add.collider(npc.sprite, this.treesLayer);
    if (!this.npcGroup) {
      this.npcGroup = this.physics.add.group();
      // Collide callback: each bump triggers a "step right" shimmy on
      // both NPCs, so two NPCs walking head-on pass each other on the
      // right instead of grinding. See NPC.notifyBump.
      this.physics.add.collider(this.npcGroup, this.npcGroup, (a, b) => {
        const npcA = (a as any).npc as NPC | undefined;
        const npcB = (b as any).npc as NPC | undefined;
        if (npcA) npcA.notifyBump(npcB);
        if (npcB) npcB.notifyBump(npcA);
      });
    }
    this.npcGroup.add(npc.sprite);
    this.npcs.push(npc);
  }

  // Mark a thread as read on the server, then patch every cached copy
  // of it (it may appear in INBOX cache AND a label cache) so the next
  // email-list render shows it as read. Also live-restyles any row
  // currently visible in the building popup behind the content modal
  // so the user sees the unread highlight drop immediately, AND
  // despawns any NPCs representing that thread (they've "gone inside"
  // since read emails don't get an outside-the-building NPC).
  private markThreadRead(t: EmailThread): void {
    if (t.isRead) return;       // already done — keep call idempotent
    // Find which buildings this thread is currently filed under BEFORE
    // we strip the UNREAD label. Each one's unread badge needs to drop
    // by 1 since the thread will no longer count toward its labels'
    // threadsUnread tallies.
    const beforeBuildings = this.buildingsContainingThread(t);
    t.isRead = true;
    t.labels = t.labels.filter(l => l !== 'UNREAD');
    for (const m of t.messages) {
      m.isRead = true;
      m.labels = m.labels.filter(l => l !== 'UNREAD');
    }
    applyReadStateToRow(t.threadId, true);
    // Apply the per-building decrement. Lookup by NAME since
    // buildingsContainingThread returns names; safe because building
    // names are user-settable but unique within the world.
    for (const name of beforeBuildings) {
      const b = this.buildings.find(bb => bb.name === name);
      if (b) this.bumpBuildingUnread(b.id, -1);
    }
    this.updateBuildingBadges();
    // Notify any open UI that aggregates read-state across threads
    // (e.g. the People grid's per-person unread count). Listeners
    // re-aggregate from emailCache on the next animation frame.
    try {
      document.dispatchEvent(new CustomEvent('thread:read-state-changed', {
        detail: { threadId: t.threadId, isRead: true },
      }));
    } catch { }
    // Each NPC carries an array of threadIds for ONE sender. Remove
    // this thread from every matching NPC; despawn the NPC only when
    // ALL its threads have been read.
    for (let i = this.npcs.length - 1; i >= 0; i--) {
      const npc = this.npcs[i];
      const data = npc.data as any;
      if (!Array.isArray(data?.threadIds)) continue;
      const before = data.threadIds.length;
      data.threadIds = data.threadIds.filter((id: string) => id !== t.threadId);
      // Keep the carry-metadata list in sync so menus/tooltips reflect
      // the removal too.
      if (Array.isArray(data.threads)) {
        data.threads = data.threads.filter((c: any) => c.threadId !== t.threadId);
      }
      if (data.threadIds.length === before) continue;     // wasn't on this NPC
      if (data.threadIds.length === 0) {
        npc.destroy();
        this.npcs.splice(i, 1);
      }
    }
    api.markRead(t.threadId, true).catch(err => console.warn('[markRead] failed', err));
    setStatus(`Marked read: ${t.subject?.slice(0, 60) || '(no subject)'}`, { tone: 'ok' });
  }

  // Apply the destination label to the thread + archive it (remove
  // INBOX). Does NOT mark as read — that's the user's prerogative,
  // and openEmailFor handles it when they actually look at the thread.
  // Side-effect: every NPC carrying this thread walks from wherever
  // it is to the destination building's door, then despawns ("enters"
  // the building, off-screen). Future Phase 8 will respawn it as a
  // read-state-less indoor occupant.
  async moveThread(threadId: string, destLabelId: string, destBuildingName: string, overrideLabel?: string): Promise<void> {
    console.log(`[move] thread=${threadId} → ${destBuildingName} (${destLabelId})${overrideLabel ? ` floor=${overrideLabel}` : ''}`);
    setStatus(`Moving to ${destBuildingName}…`, { tone: 'info', ttlMs: 8000 });
    // Resolve destination: either a `building:<id>` token (new multi-label
    // shape from destinationsForMove), or a plain label name (legacy).
    let destBuilding: Building | undefined;
    let candidateLabels: string[] = [];
    if (destLabelId.startsWith('building:')) {
      const id = Number(destLabelId.slice('building:'.length));
      destBuilding = this.buildings.find(b => b.id === id);
      candidateLabels = destBuilding ? getBuildingLabels(destBuilding).filter(n => n !== 'INBOX') : [];
    } else {
      destBuilding = this.buildings.find(b => getBuildingLabels(b).includes(destLabelId));
      candidateLabels = [destLabelId];
    }
    if (!candidateLabels.length || !destBuilding) {
      console.warn(`[move] couldn't resolve destination for ${destLabelId}`);
      return;
    }

    // Pick a label from the building's list that exists in THIS thread's
    // account. Backend resolves names → ids per account; we just need to
    // pick a name that account actually has.
    const threadAccount = threadId.split(':')[0];
    const labelsInAccount = (this.labelCache || []).filter(l => l.account === threadAccount);
    const namesInAccount = new Set(labelsInAccount.map(l => l.name));
    // If the caller hinted a specific floor (e.g. user searched
    // "amazon" and picked the Shopping building via the Shopping/Amazon
    // floor), apply that sub-label instead of the building's generic
    // parent — but only when it exists in the thread's account.
    let chosen = overrideLabel && namesInAccount.has(overrideLabel)
      ? overrideLabel
      : candidateLabels.find(n => namesInAccount.has(n));
    if (overrideLabel && chosen !== overrideLabel) {
      console.warn(`[move] override label "${overrideLabel}" not in account ${threadAccount}; falling back to building parent`);
    }
    if (!chosen) {
      // None of the building's labels exist in this account. Refuse to
      // proceed — applying a non-existent label would just strip INBOX
      // without filing the thread anywhere, leaving it orphaned.
      console.warn(`[move] ABORT: none of [${candidateLabels.join(', ')}] exist in account ${threadAccount}. Add an account-${threadAccount.split('@')[0]} label to "${destBuildingName}" first.`);
      alert(`Can't move to ${destBuildingName}: none of its labels exist in ${threadAccount}.\n\nAdd a label that exists in this account to that building first.`);
      return;
    }
    console.log(`[move] thread ${threadId} → "${chosen}" (from ${candidateLabels.length} candidates) on ${threadAccount}`);

    const modifyResult = await api.modify(threadId, [chosen], ['INBOX']);
    console.log(`[move] backend confirmed`, modifyResult);
    setStatus(`Moved to ${destBuildingName}${overrideLabel && overrideLabel !== chosen ? ` / ${overrideLabel}` : ''}`, { tone: 'ok' });
    // Patch any in-memory copies of this thread BEFORE blowing the
    // cache away — open popups (e.g. the person profile) hold direct
    // references to those thread objects and the next render needs to
    // see the updated labels so its building chips refresh. Without
    // this patch the chips stay frozen on the old building until the
    // user closes & reopens the popup.
    this.patchLocalThreadLabels(threadId, chosen, ['INBOX']);
    // Optimistic badge bookkeeping: the thread just left INBOX (Post
    // Office) and arrived at the destination. Apply both deltas locally
    // so the badge ticks down instantly — refreshBuildingUnreadCounts
    // (run on next spawn/refresh) re-syncs with Gmail truth.
    const postOffice = this.buildings.find(b => getBuildingLabels(b).includes('INBOX'));
    if (postOffice) this.bumpBuildingUnread(postOffice.id, -1);
    if (destBuilding) this.bumpBuildingUnread(destBuilding.id, +1);
    this.updateBuildingBadges();
    // Surgical cache update: drop the moved thread from INBOX's cached
    // list, add it to the destination label's cached list. Used to be
    // a full .delete() of every affected label, which nuked the entire
    // INBOX cache and made every OTHER thread of every OTHER sender in
    // the inbox invisible to aggregatePeople / the People grid until
    // the next full refresh. Surgical update preserves all unrelated
    // threads + senders in those caches.
    this.removeThreadFromLabelCache('INBOX', threadId);
    const movedThread = this.findThreadInCache(threadId);
    if (movedThread) this.addThreadToLabelCache(chosen, movedThread);

    const destDoor = this.findDoorForBuilding(destBuilding);
    if (!destDoor) {
      console.warn(`[move] no door found for "${destBuilding.name}" — NPCs cannot walk there`);
      return;
    }
    // Find NPCs carrying THIS thread. Each NPC may carry multiple
    // threads for the same sender; we remove just this one from each
    // and queue a walk to the destination.
    const matched = this.npcs.filter(n => {
      const tids = (n.data as any)?.threadIds as string[] | undefined;
      return Array.isArray(tids) && tids.includes(threadId);
    });
    for (const npc of matched) {
      const data = npc.data as any;
      data.threadIds = (data.threadIds as string[]).filter(id => id !== threadId);
      if (Array.isArray(data.threads)) {
        data.threads = data.threads.filter((c: any) => c.threadId !== threadId);
      }
      // Queue the walk. On arrival, the NPC either despawns (no threads
      // left) or returns home (if no more queued walks remain).
      const homeBuilding = this.buildings.find(bb => bb.id === (data as any).homeBuildingId);
      const homeLabel = homeBuilding?.name || 'home';
      npc.queueWalk(destDoor, () => {
        const remainingThreads = (data.threadIds as string[]).length;
        if (remainingThreads === 0) {
          npc.destroy();
          const idx = this.npcs.indexOf(npc);
          if (idx >= 0) this.npcs.splice(idx, 1);
        } else if (npc.walkQueue.length === 0 && npc.homeDoor) {
          // More threads waiting but no more destinations queued — go
          // back home and idle. (If another move comes in before we
          // arrive home, queueWalk will append after this home walk.)
          npc.queueWalk(npc.homeDoor, undefined, homeLabel);
        }
        this.updateBuildingBadges();
      }, destBuildingName);
    }
    // Source building's count drops as soon as we strip the thread
    // (the walk hasn't started, but the NPC no longer "carries" it).
    this.updateBuildingBadges();
  }

  // List floor options (immediate-child sub-labels under any of the
  // building's bound parent labels) this thread could be moved TO from
  // its current floor. Only includes labels that exist in the thread's
  // account. Excludes any floor the thread already sits on so we don't
  // offer "move to where you already are".
  floorsForBuilding(b: Building, t: EmailThread): FloorOption[] {
    const parents = getBuildingLabels(b).filter(n => n !== 'INBOX');
    if (!parents.length) return [];
    const labels = this.labelCache || [];
    const account = t.account;
    // Names of labels currently on the thread (resolved from raw ids).
    const threadLabelNames = new Set<string>();
    const labelByIdKey = new Map<string, string>();
    for (const l of labels) labelByIdKey.set(`${l.account}:${l.rawId}`, l.name);
    for (const rawId of t.labels) {
      const name = labelByIdKey.get(`${account}:${rawId}`);
      if (name) threadLabelNames.add(name);
    }
    const seen = new Set<string>();
    const out: FloorOption[] = [];
    for (const parent of parents) {
      // Find labels in this account whose name is "parent/<leaf>" — the
      // leaf can itself contain '/' for deeper nesting; we treat each
      // distinct full path as a floor candidate.
      const prefix = `${parent}/`;
      const candidates = labels
        .filter(l => l.account === account && l.name.startsWith(prefix))
        .map(l => l.name);
      for (const fullName of candidates) {
        if (threadLabelNames.has(fullName)) continue;          // already there
        if (seen.has(fullName)) continue;
        seen.add(fullName);
        const rest = fullName.slice(prefix.length);
        // Use the FIRST segment as the leaf label, matching how floors
        // are grouped in the email list. Display "parent/leaf" when
        // multiple parents are bound to avoid ambiguity.
        const idx = rest.indexOf('/');
        const leaf = idx >= 0 ? rest.slice(0, idx) : rest;
        const display = parents.length > 1 ? `${parent}/${leaf}` : leaf;
        out.push({ key: `${parent}::${fullName}`, label: display, fullName, parent });
      }
    }
    out.sort((a, b) => a.label.localeCompare(b.label));
    return out;
  }

  // Re-file a thread under a different sub-label inside the same
  // building. Adds the target sub-label and removes any OTHER sub-label
  // the thread already carries under the same parent (so it doesn't
  // double-file). Does NOT touch INBOX — the thread isn't archiving,
  // just reclassifying within its current parent.
  async moveThreadToFloor(t: EmailThread, opt: FloorOption): Promise<void> {
    const account = t.account;
    const labelByIdKey = new Map<string, string>();
    for (const l of (this.labelCache || [])) labelByIdKey.set(`${l.account}:${l.rawId}`, l.name);
    const currentLabelNames = t.labels
      .map(rawId => labelByIdKey.get(`${account}:${rawId}`))
      .filter((n): n is string => !!n);
    // Strip every other sub-label under the same parent so the thread
    // ends up on exactly one floor. Leave the parent label itself alone.
    const prefix = `${opt.parent}/`;
    const toRemove = currentLabelNames.filter(n => n !== opt.fullName && n.startsWith(prefix));
    console.log(`[floor-move] thread=${t.threadId} +"${opt.fullName}" -[${toRemove.join(', ')}]`);
    await api.modify(t.threadId, [opt.fullName], toRemove);
    // Surgical: patch this thread's labels in memory and update the
    // caches for the floors involved. Other threads in the parent
    // label's cache stay put — used to be a blanket .delete() that
    // dropped the parent's entire cached list.
    this.patchLocalThreadLabels(t.threadId, opt.fullName, toRemove);
    for (const n of toRemove) this.removeThreadFromLabelCache(n, t.threadId);
    const patched = this.findThreadInCache(t.threadId);
    if (patched) this.addThreadToLabelCache(opt.fullName, patched);
  }

  // Move EVERY thread carried by a specific NPC to one destination in
  // a single batch. The NPC walks once (not per thread) and despawns
  // on arrival. Used by the "Move all" button in the NPC popup.
  async moveAllForNpc(npc: NPC, destLabelId: string, destBuildingName: string, overrideLabel?: string): Promise<void> {
    const data = npc.data as any;
    const threadIds = [...((data?.threadIds as string[]) || [])];
    if (!threadIds.length) return;
    // Resolve destination + per-account labels.
    let destBuilding: Building | undefined;
    let candidateLabels: string[] = [];
    if (destLabelId.startsWith('building:')) {
      const id = Number(destLabelId.slice('building:'.length));
      destBuilding = this.buildings.find(b => b.id === id);
      candidateLabels = destBuilding ? getBuildingLabels(destBuilding).filter(n => n !== 'INBOX') : [];
    } else {
      destBuilding = this.buildings.find(b => getBuildingLabels(b).includes(destLabelId));
      candidateLabels = [destLabelId];
    }
    if (!candidateLabels.length || !destBuilding) return;

    // Resolve the destination door FIRST. If the building has no
    // walkable door, abort cleanly — modifying labels + clearing the
    // NPC's threads before this point would leave a zombie NPC
    // standing around with 0 unread and no way to walk anywhere.
    const destDoor = this.findDoorForBuilding(destBuilding);
    if (!destDoor) {
      console.warn(`[moveAll] no door for "${destBuilding.name}" — aborting`);
      alert(`Can't move to ${destBuildingName}: no walkable door.`);
      return;
    }

    // Apply per-thread (each may need a different per-account label).
    // If an overrideLabel (floor match) was supplied, use it whenever
    // that exact label exists in the thread's account; otherwise fall
    // back to the building's bound labels. Each successful move ALSO
    // patches the cache surgically — removing the thread from INBOX
    // and adding it to its new label's cache — so other threads /
    // senders in those caches stay visible (the previous .delete()
    // was wiping inbox entirely, hiding every other inbox sender from
    // the People grid after a single move).
    await Promise.all(threadIds.map(async (tid) => {
      const acct = tid.split(':')[0];
      const inAcct = (this.labelCache || []).filter(l => l.account === acct).map(l => l.name);
      const chosen = (overrideLabel && inAcct.includes(overrideLabel))
        ? overrideLabel
        : (candidateLabels.find(n => inAcct.includes(n)) || candidateLabels[0]);
      try {
        await api.modify(tid, [chosen], ['INBOX']);
        this.patchLocalThreadLabels(tid, chosen, ['INBOX']);
        this.removeThreadFromLabelCache('INBOX', tid);
        const t = this.findThreadInCache(tid);
        if (t) this.addThreadToLabelCache(chosen, t);
      } catch (err) {
        console.warn(`[moveAll] failed for ${tid}:`, err);
      }
    }));

    // Drain the NPC's thread list and walk once.
    data.threadIds = [];
    if (Array.isArray(data.threads)) data.threads = [];
    npc.queueWalk(destDoor, () => {
      npc.destroy();
      const idx = this.npcs.indexOf(npc);
      if (idx >= 0) this.npcs.splice(idx, 1);
      this.updateBuildingBadges();
    }, destBuildingName);
    // Source building's count drops immediately — its NPC just stopped
    // carrying any threads even though the walk is still in flight.
    this.updateBuildingBadges();
  }

  // Teleport the player to the door associated with a building.
  // Falls back to the building's center if no door is registered.
  private teleportToBuilding(b: Building): void {
    const door = this.findDoorForBuilding(b);
    const x = door ? door.x : b.x + b.w / 2;
    const y = door ? door.y : b.y + b.h / 2;
    player.setPosition(x, y);
    player.body.setVelocity(0);
  }

  // Public building-state API. Look up by Tiled object id (number) or
  // by current display name (case-sensitive). Mutating name updates the
  // floating label automatically. Description is read live by the popup
  // each time it opens, so no extra render call needed.
  findBuilding(idOrName: number | string): Building | undefined {
    if (typeof idOrName === 'number') return this.buildings.find(b => b.id === idOrName);
    return this.buildings.find(b => b.name === idOrName);
  }
  setBuildingName(idOrName: number | string, newName: string): Building | undefined {
    const b = this.findBuilding(idOrName);
    if (!b) return undefined;
    b.name = newName;
    this.renderBuildingLabel(b);
    this.persistBuildingNameMap();
    return b;
  }

  // Render a building's floating world-label: the name itself stays
  // clean ("Newsletters"), and the unread count rides on a separate
  // red-circle badge anchored to the right edge of the name pill so
  // the eye reads "count" not "name with arithmetic in it". Badge is
  // lazily created the first time a building has an unread, then just
  // shown/hidden + re-textured on subsequent calls.
  //
  // Counts come from the live NPC list (homeBuildingId + threadIds)
  // — drops the moment an NPC walks off, climbs when they spawn.
  private renderBuildingLabel(b: Building): void {
    b.label.setText(b.name);
    const c = this.unreadCountForBuilding(b);
    if (!b.badge) {
      b.badge = this.add.text(0, 0, '', {
        fontFamily: 'sans-serif',
        fontSize: '28px',
        fontStyle: 'bold',
        color: '#fff',
        backgroundColor: '#c8323c',
        padding: { x: 10, y: 4 },
        stroke: '#5a0d12',
        strokeThickness: 3,
      }).setOrigin(0.5, 0).setDepth(17).setVisible(false);
    }
    if (c <= 0) {
      b.badge.setVisible(false);
      return;
    }
    b.badge.setText(c > 99 ? '99+' : String(c));
    b.badge.setVisible(true);
    // Position the badge just to the right of the name pill, vertically
    // centered against its top edge. label.width is recomputed after
    // setText so this stays accurate as the name changes.
    const rightEdge = b.label.x + b.label.displayWidth / 2;
    b.badge.setPosition(rightEdge + 6 + b.badge.displayWidth / 2, b.label.y - 4);
  }

  // Per-building TRUE unread counts from the Gmail API. Survives the
  // THREAD_LIMIT cap on spawn (only 250 NPCs render but the badge
  // reflects the full inbox). Decremented locally on each successful
  // move and re-fetched on respawn/refresh so the user sees a number
  // that monotonically drops as they file mail away — instead of the
  // old behaviour where moving 50 out and reloading silently surfaced
  // the next 50 in the backlog and the badge "popped back up."
  private apiUnreadByBuilding = new Map<number, number>();

  private unreadCountForBuilding(b: Building): number {
    const fromApi = this.apiUnreadByBuilding.get(b.id);
    if (typeof fromApi === 'number') return fromApi;
    // Fallback to NPC threadIds while the API call is in flight.
    let n = 0;
    for (const npc of this.npcs) {
      const data = npc.data as any;
      if (data?.homeBuildingId !== b.id) continue;
      const tids = (data.threadIds as string[] | undefined) || [];
      n += tids.length;
    }
    return n;
  }

  // Re-fetch the authoritative unread count for every labeled building
  // and refresh the badges. Cheap (one Gmail messages.list per label,
  // capped at q=1 — Gmail returns resultSizeEstimate without paginating).
  // Called once after spawn and after every full refresh.
  async refreshBuildingUnreadCounts(): Promise<void> {
    const targets = this.buildings.filter(b => getBuildingLabels(b).length > 0);
    await Promise.all(targets.map(async (b) => {
      const names = getBuildingLabels(b);
      try {
        const counts = await Promise.all(names.map(n => {
          const args = n === 'INBOX' ? { labelIds: 'INBOX' } : { labelName: n };
          return api.unreadCount(args).then(r => r.count).catch(() => 0);
        }));
        const total = counts.reduce((a, c) => a + c, 0);
        this.apiUnreadByBuilding.set(b.id, total);
      } catch {
        // Leave the previous cached value alone on transient failure.
      }
    }));
    this.updateBuildingBadges();
  }

  // Optimistic local decrement. moveThread calls this once per moved
  // thread so badges drop instantly without a round trip. Re-converges
  // with Gmail truth on the next refreshBuildingUnreadCounts.
  private bumpBuildingUnread(buildingId: number, delta: number): void {
    const cur = this.apiUnreadByBuilding.get(buildingId);
    if (typeof cur === 'number') {
      this.apiUnreadByBuilding.set(buildingId, Math.max(0, cur + delta));
    }
  }

  // Recompute every building's label. Cheap (one O(npcs) scan + one
  // setText per building) and idempotent — safe to call from any code
  // path that changes NPC threads or spawns/destroys NPCs.
  private updateBuildingBadges(): void {
    for (const b of this.buildings) this.renderBuildingLabel(b);
  }
  setBuildingDescription(idOrName: number | string, newDesc: string): Building | undefined {
    const b = this.findBuilding(idOrName);
    if (!b) return undefined;
    b.description = newDesc;
    return b;
  }
  setBuildingState(idOrName: number | string, key: string, value: unknown): Building | undefined {
    const b = this.findBuilding(idOrName);
    if (!b) return undefined;
    b.state[key] = value;
    return b;
  }

  private openMinimap(map: Phaser.Tilemaps.Tilemap): void {
    if (this.minimapEl) { this.closeMinimap(); return; }   // T toggles
    // Size to viewport — preserve aspect ratio, leave a small margin for
    // the dimmed border and so the canvas doesn't run flush with edges.
    const margin = 48;
    const maxW = window.innerWidth - margin;
    const maxH = window.innerHeight - margin;
    const scale = Math.min(maxW / map.widthInPixels, maxH / map.heightInPixels);
    const w = Math.round(map.widthInPixels * scale);
    const h = Math.round(map.heightInPixels * scale);

    const overlay = document.createElement('div');
    overlay.style.cssText = `position:fixed;inset:0;background:rgba(0,0,0,0.75);display:flex;align-items:center;justify-content:center;z-index:1000;cursor:crosshair`;
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    cv.style.cssText = `image-rendering:pixelated;border:1px solid #333;box-shadow:0 16px 48px rgba(0,0,0,0.85);background:#000;border-radius:6px`;
    overlay.appendChild(cv);

    const ctx = cv.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    // Draw each tilemap layer at scale by walking the tile grid and
    // copying from the source tileset image atlas. Seam-prevention: snap
    // dest position to integer pixels via floor, expand size to ceil + 1
    // so adjacent tiles overlap by ~1px and never expose the canvas
    // background between them. (Pure +1 overdraw breaks when scale
    // produces sub-pixel widths > 1 below an integer.)
    const tw = map.tileWidth, th = map.tileHeight;
    const dw = tw * scale, dh = th * scale;
    for (const layerName of ['Background', 'Ground Objects', 'Buildings', 'Trees']) {
      const layer = map.getLayer(layerName);
      if (!layer) continue;
      const data = layer.data;
      for (let y = 0; y < layer.height; y++) {
        for (let x = 0; x < layer.width; x++) {
          const tile = data[y][x];
          if (!tile || tile.index < 0) continue;
          const ts = tile.tileset;
          if (!ts) continue;
          const img = (this.textures.get(ts.image!.key).getSourceImage()) as HTMLImageElement;
          const local = tile.index - ts.firstgid;
          const cols = ts.columns;
          const sx = ts.tileMargin + (local % cols) * (tw + ts.tileSpacing);
          const sy = ts.tileMargin + Math.floor(local / cols) * (th + ts.tileSpacing);
          const dx = Math.floor(x * dw);
          const dy = Math.floor(y * dh);
          const dWidth  = Math.ceil(dw) + 1;
          const dHeight = Math.ceil(dh) + 1;
          ctx.drawImage(img, sx, sy, tw, th, dx, dy, dWidth, dHeight);
        }
      }
    }
    // Building name labels — drawn on top of the tile render so the
    // user can navigate by name. Centered on each building's rect; size
    // scales with the minimap so they're legible without overlapping.
    const fontSize = Math.max(11, Math.round(14 * Math.min(1.4, scale * 4)));
    ctx.font = `bold ${fontSize}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.lineJoin = 'round';
    for (const b of this.buildings) {
      // Skip unnamed rects — they're usually placeholders the user
      // hasn't filled in yet, and clutter the map.
      if (!b.name || b.name === '(unnamed building)') continue;
      const cx = (b.x + b.w / 2) * scale;
      const cy = (b.y + b.h / 2) * scale;
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 4;
      ctx.strokeText(b.name, cx, cy);
      ctx.fillStyle = '#fff';
      ctx.fillText(b.name, cx, cy);
    }

    // NPC dots — small yellow dots so the user can see where every
    // unread email currently lives on the map. Drawn before the
    // player marker so the player stays on top if they overlap.
    ctx.fillStyle = '#ffe066';
    ctx.strokeStyle = '#000';
    ctx.lineWidth = 1;
    for (const npc of this.npcs) {
      const tids = (npc.data as any)?.threadIds as string[] | undefined;
      if (!Array.isArray(tids) || tids.length === 0) continue;
      const x = npc.sprite.x * scale;
      const y = npc.sprite.y * scale;
      ctx.beginPath();
      ctx.arc(x, y, 3, 0, Math.PI * 2);
      ctx.fill();
      ctx.stroke();
    }

    // Player marker.
    ctx.fillStyle = '#ff3030';
    ctx.fillRect(player.x * scale - 4, player.y * scale - 4, 8, 8);
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 1;
    ctx.strokeRect(player.x * scale - 4, player.y * scale - 4, 8, 8);

    // Click to teleport. ESC or click outside also closes.
    const onClick = (e: MouseEvent) => {
      const rect = cv.getBoundingClientRect();
      const cx = e.clientX - rect.left, cy = e.clientY - rect.top;
      if (cx < 0 || cy < 0 || cx > w || cy > h) { this.closeMinimap(); return; }
      const wx = cx / scale, wy = cy / scale;
      player.setPosition(wx, wy);
      player.body.setVelocity(0);
      this.closeMinimap();
    };
    overlay.addEventListener('click', onClick);
    document.body.appendChild(overlay);
    this.minimapEl = overlay;
  }

  // ---- Top toolbar (replaces the legacy text hint bar) ----
  // DOM buttons overlay the canvas top-left. Each button fires the same
  // action a keyboard shortcut already does, plus Settings opens a new
  // popup. Built once in create(); kept in a single root div so it can
  // be torn down with one remove() if needed.
  private topBarEl: HTMLDivElement | null = null;
  // Empty until the layered avatar texture composes; once set, the
  // player update loop switches to playing `<key>-walk-<dir>` anims
  // and standing on `AVATAR_FRAMES.stand<Dir>` instead of misa-*.
  private playerTextureKey: string = '';
  // Cardinal facing — updated whenever the player has a non-zero
  // velocity, so calls/dialogue know which way to deliver an NPC.
  private playerFacingDir: 'down' | 'up' | 'left' | 'right' = 'down';
  private buildTopBar(): void {
    if (this.topBarEl) { this.topBarEl.remove(); this.topBarEl = null; }
    // Collapsed state persists across sessions.
    const COLLAPSE_KEY = 'little_town.sidebar_collapsed';
    let collapsed = false;
    try { collapsed = localStorage.getItem(COLLAPSE_KEY) === '1'; } catch {}
    const persist = () => { try { localStorage.setItem(COLLAPSE_KEY, collapsed ? '1' : '0'); } catch {} };

    // Left-edge vertical sidebar — hugs the left, full-height of viewport.
    const bar = document.createElement('div');
    bar.style.cssText = `
      position:fixed; top:0; left:0; bottom:0; z-index:55;
      display:flex; flex-direction:column; gap:6px;
      background:rgba(15,15,15,0.94); border-right:1px solid #2a2a2a;
      padding:10px 8px;
      font:600 12px ui-sans-serif,system-ui,sans-serif;
      transition:width 0.18s ease;
    `;

    // Collapse toggle at the top — caret swaps to ◀/▶ based on state.
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.style.cssText = 'background:#222; color:#9cf; border:1px solid #444; border-radius:5px; padding:6px 0; cursor:pointer; font:600 13px ui-sans-serif,system-ui,sans-serif; width:100%;';
    toggle.addEventListener('mouseenter', () => { toggle.style.background = '#2c3a5a'; });
    toggle.addEventListener('mouseleave', () => { toggle.style.background = '#222'; });
    bar.appendChild(toggle);

    // shortcut : icon : label : action
    const buttons: Array<[string, string, string, () => void]> = [
      ['T', '🗺',  'Map',       () => this.openMinimapFromBar()],
      ['B', '🏘',  'Buildings', () => this.openBuildingGrid()],
      ['U', '👥', 'People',    () => this.openPeopleGridPopup()],
      ['F', '⚙', 'Rules',     () => openRulesPane({ accounts: this.currentAccounts, labels: this.labelCache, reauthUrl: (email) => api.reauthUrl(email) })],
      ['R', '↻', 'Refresh',   () => this.refreshAllEmails()],
      ['P', '··', 'Paths',     () => this.togglePaths()],
      ['G', '⊞', 'Grid',      () => this.toggleGridOverlay()],
      ['C', '📣', 'Call',      () => this.callNearestNpc()],
      ['H', '⌂', 'Home',      () => this.snapPlayerToPostOfficeDoor(this.mapForMinimap!)],
      ['⚙', '⚙', 'Settings',  () => this.openSettings()],
    ];
    const btnElements: HTMLButtonElement[] = [];
    for (const [shortcut, icon, label, action] of buttons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.dataset.icon = icon;
      btn.dataset.label = label;
      btn.dataset.shortcut = shortcut;
      btn.title = `${label} (${shortcut})`;
      btn.style.cssText = 'background:#1f2937; color:#eee; border:1px solid #2c5688; border-radius:5px; cursor:pointer; font:inherit; text-align:left; padding:7px 10px; display:flex; align-items:center; gap:8px;';
      btn.addEventListener('mouseenter', () => { btn.style.background = '#2c5688'; });
      btn.addEventListener('mouseleave', () => { btn.style.background = '#1f2937'; });
      btn.addEventListener('click', (e) => { e.stopPropagation(); action(); });
      bar.appendChild(btn);
      btnElements.push(btn);
    }

    // Apply expanded/collapsed state — adjusts bar width + button content.
    const applyState = () => {
      if (collapsed) {
        bar.style.width = '44px';
        toggle.textContent = '▶';
        toggle.title = 'Expand sidebar';
        for (const btn of btnElements) {
          btn.innerHTML = `<span style="width:100%; text-align:center; font-size:14px;">${btn.dataset.icon}</span>`;
          btn.style.justifyContent = 'center';
          btn.style.padding = '8px 0';
        }
      } else {
        bar.style.width = '160px';
        toggle.textContent = '◀ Collapse';
        toggle.title = 'Collapse sidebar';
        for (const btn of btnElements) {
          btn.innerHTML =
            `<span style="font-size:14px; width:18px; text-align:center;">${btn.dataset.icon}</span>` +
            `<span style="flex:1;">${btn.dataset.label}</span>` +
            `<span style="opacity:0.55; font-weight:400;">${btn.dataset.shortcut}</span>`;
          btn.style.justifyContent = 'flex-start';
          btn.style.padding = '7px 10px';
        }
      }
    };
    toggle.addEventListener('click', () => { collapsed = !collapsed; persist(); applyState(); });
    applyState();

    document.body.appendChild(bar);
    this.topBarEl = bar;
  }

  // Stash references so the top bar's Map/Paths/Grid buttons can drive
  // the same toggles the keyboard shortcuts do (kept simple by exposing
  // small private helpers rather than capturing closures from create()).
  private mapForMinimap: Phaser.Tilemaps.Tilemap | null = null;
  private gridGfx: Phaser.GameObjects.Graphics | null = null;
  private togglePaths(): void { this.showPaths = !this.showPaths; if (!this.showPaths) this.pathGfx.clear(); }
  private toggleGridOverlay(): void { if (this.gridGfx) this.gridGfx.setVisible(!this.gridGfx.visible); }
  private openMinimapFromBar(): void { if (this.mapForMinimap) this.openMinimap(this.mapForMinimap); }

  // ---- Settings popup ----
  // Currently houses: the connected email accounts (each row has a
  // re-auth ↻ and a disconnect × that mirror the legacy chip badge),
  // and a "Customize my avatar" button that opens the layered character
  // builder for the player. Designed as the home for future per-user
  // config (volume, day-night cycle, debug toggles, etc.).
  private openSettings(): void {
    document.querySelectorAll('[data-settings-popup]').forEach(el => el.remove());
    const overlay = document.createElement('div');
    overlay.setAttribute('data-settings-popup', '1');
    overlay.style.cssText = 'position:fixed; inset:0; z-index:1500; background:rgba(0,0,0,0.85); display:flex; align-items:center; justify-content:center; font:14px ui-sans-serif,system-ui,sans-serif;';
    const card = document.createElement('div');
    card.style.cssText = 'width:min(640px, 92vw); max-height:90vh; overflow:auto; background:#111; color:#eee; border:1px solid #333; border-radius:10px; box-shadow:0 24px 64px rgba(0,0,0,0.85); display:flex; flex-direction:column;';
    card.addEventListener('mousedown', (e) => e.stopPropagation());
    overlay.addEventListener('mousedown', () => overlay.remove());
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); } };
    document.addEventListener('keydown', esc);

    const bar = document.createElement('div');
    bar.style.cssText = 'background:#1f2937; padding:12px 18px; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #2a2a2a;';
    bar.innerHTML = '<span style="font:600 16px ui-sans-serif,system-ui,sans-serif;">⚙ Settings</span>';
    const closeBtn = document.createElement('span');
    closeBtn.textContent = '×'; closeBtn.style.cssText = 'cursor:pointer; font-size:24px; line-height:1; padding:0 6px;';
    closeBtn.addEventListener('click', () => { overlay.remove(); document.removeEventListener('keydown', esc); });
    bar.appendChild(closeBtn);
    card.appendChild(bar);

    const body = document.createElement('div');
    body.style.cssText = 'padding:20px 24px; display:flex; flex-direction:column; gap:22px;';
    card.appendChild(body);

    // ---- Email accounts ----
    body.appendChild(this.sectionLabel('Email accounts'));
    const accList = document.createElement('div');
    accList.style.cssText = 'display:flex; flex-direction:column; gap:6px;';
    if (!this.currentAccounts.length) {
      accList.innerHTML = '<div style="color:#888; font-style:italic;">No accounts connected.</div>';
    }
    for (const a of this.currentAccounts) {
      const row = document.createElement('div');
      row.style.cssText = 'display:flex; align-items:center; gap:10px; padding:8px 12px; background:#1a1a1a; border:1px solid #262626; border-radius:6px;';
      row.innerHTML = `<span style="flex:1; font:13px ui-monospace,Consolas,monospace; color:#fff;">${escapeHtml(a.email)}</span>`;
      const reauth = document.createElement('button');
      reauth.textContent = '↻ Re-auth';
      reauth.style.cssText = 'background:#1f3a5f; color:#fff; border:1px solid #2c5688; border-radius:5px; padding:4px 10px; cursor:pointer; font:11px ui-sans-serif,system-ui,sans-serif;';
      reauth.addEventListener('click', () => { window.location.href = api.reauthUrl(a.email); });
      const disconnect = document.createElement('button');
      disconnect.textContent = '× Disconnect';
      disconnect.style.cssText = 'background:#3b1f1f; color:#ddd; border:1px solid #5a2a2a; border-radius:5px; padding:4px 10px; cursor:pointer; font:11px ui-sans-serif,system-ui,sans-serif;';
      disconnect.addEventListener('click', async () => {
        if (!confirm(`Disconnect ${a.email}?`)) return;
        try {
          await api.disconnect(a.email);
          this.currentAccounts = this.currentAccounts.filter(x => x.email !== a.email);
          overlay.remove(); document.removeEventListener('keydown', esc);
          this.openSettings();   // re-render
        } catch (err) { alert(`Disconnect failed: ${err}`); }
      });
      row.appendChild(reauth);
      row.appendChild(disconnect);
      accList.appendChild(row);
    }
    const addBtn = document.createElement('button');
    addBtn.textContent = '+ Add another account';
    addBtn.style.cssText = 'background:#222; color:#9cf; border:1px solid #444; border-radius:5px; padding:6px 12px; cursor:pointer; font:12px ui-sans-serif,system-ui,sans-serif; align-self:flex-start;';
    addBtn.addEventListener('click', () => { window.location.href = api.signInUrl(true); });
    accList.appendChild(addBtn);
    body.appendChild(accList);

    // NPC Display Limit, Cache TTL, and Clear-cache rows are gone —
    // the local-first migration moved threads to SQLite, so per-label
    // caches with TTLs are no longer a thing. The bottom status bar
    // (see status_bar.ts) shows live sync progress instead.

    // ---- Player avatar ----
    body.appendChild(this.sectionLabel('Player avatar'));
    const avatarRow = document.createElement('div');
    avatarRow.style.cssText = 'display:flex; align-items:center; gap:14px;';
    const PLAYER_KEY = '__player__@local';
    let preview = avatarPortraitForEmail(PLAYER_KEY, 80);
    avatarRow.appendChild(preview);
    const customize = document.createElement('button');
    customize.textContent = '🎨 Customize my avatar…';
    customize.style.cssText = 'background:#1f3a5f; color:#fff; border:1px solid #2c5688; border-radius:6px; padding:8px 16px; cursor:pointer; font:600 13px ui-sans-serif,system-ui,sans-serif;';
    customize.addEventListener('click', () => {
      openAvatarCustomizer(PLAYER_KEY, () => {
        const fresh = avatarPortraitForEmail(PLAYER_KEY, 80);
        preview.replaceWith(fresh);
        preview = fresh;
        // Re-compose + swap the in-world player sprite so the new
        // look is reflected immediately, not just in the portrait.
        this.migratePlayerToLayeredAvatar();
      });
    });
    avatarRow.appendChild(customize);
    body.appendChild(avatarRow);
    overlay.appendChild(card);
    document.body.appendChild(overlay);
  }

  private sectionLabel(text: string): HTMLDivElement {
    const d = document.createElement('div');
    d.textContent = text;
    d.style.cssText = 'color:#aaa; font:600 11px ui-monospace,Consolas,monospace; letter-spacing:0.08em; text-transform:uppercase; padding-bottom:4px; border-bottom:1px solid #222; margin-bottom:8px;';
    return d;
  }

  // Find the first walkable tile at the bottom edge of Post_Office,
  // closest in column to its door. Done AFTER the pathfind grid is
  // built so we can use it to test walkability. Snaps the player there
  // — the door tile itself often sits on building art and is blocked.
  // Swap the player sprite from the legacy 'atlas' / misa-* texture
  // to a composited LimeZu 48×96 avatar. Uses the special storage key
  // `__player__@local` so the player's look persists separately from
  // any email sender. Body collision is resized to a small box at the
  // feet of the new sprite to match the in-world NPCs.
  private async migratePlayerToLayeredAvatar(): Promise<void> {
    try {
      const cfg = await ensureAvatar('__player__@local');
      const key = await composeAndRegisterAvatar(this, cfg);
      this.playerTextureKey = key;
      player.setTexture(key, AVATAR_FRAMES.standDown);
      // 48×96 sprite: small feet-aligned collision box, scale 1 so the
      // sprite occupies a single tile horizontally. Match the NPC body
      // for visual consistency in collisions.
      player.setScale(1);
      player.body.setSize(14, 12);
      player.body.setOffset(17, 50);
      player.setDepth(20);
      console.log('[player] migrated to layered avatar', key);
    } catch (err) {
      console.warn('[player] avatar migration failed; staying on legacy misa atlas', err);
    }
  }

  // Returns true if ANY popup or modal is currently open. Used to
  // suppress single-key shortcuts (C, H) that shouldn't run while
  // the user is interacting with a DOM popup. Covers the known
  // popups by class/attribute selector — broad on purpose since any
  // future popup that follows the dark-overlay pattern auto-blocks.
  private isAnyPopupOpen(): boolean {
    // Scene-tracked overlays first (cheapest check).
    if (this.buildingPopupEl || this.buildingGridEl || this.inspectEl || this.minimapEl) return true;
    // DOM popups by stable data-attribute or class. Covers NPC action
    // menu, move popovers, rule editor, settings, character builder.
    const tagged = [
      '[data-npc-action]', '[data-move-menu]', '[data-floor-move]',
      '[data-quick-move]', '[data-npc-move]', '[data-rule-editor]',
      '[data-settings-popup]', '[data-character-builder]',
    ];
    for (const sel of tagged) if (document.querySelector(sel)) return true;
    // Person popup, people grid, email content popup, sign-in modal
    // all use fullscreen fixed overlays with z-index ≥ 1000. Sniff for
    // those so we catch anything that doesn't carry a data attribute.
    const overlays = document.querySelectorAll<HTMLDivElement>('div[style*="z-index"]');
    for (const el of overlays) {
      const z = parseInt(el.style.zIndex || '0', 10);
      if (z >= 1000 && el.style.position === 'fixed' &&
          (el.style.inset === '0px' || el.style.inset === '0')) {
        return true;
      }
    }
    return false;
  }

  // Expanding-ring "shout" effect centered on the player. One-shot
  // visual that plays alongside calling the nearest NPC so the user
  // knows the C press registered.
  private emitCallShockwave(): void {
    const TILE = 48;
    const startR = 4;
    const endR = TILE * 5;        // ~5 tiles outward
    const ring = this.add.graphics().setDepth(25);
    const draw = (r: number, alpha: number) => {
      ring.clear();
      ring.lineStyle(3, 0xffe066, alpha);
      ring.strokeCircle(player.x, player.y, r);
    };
    draw(startR, 1);
    this.tweens.addCounter({
      from: 0, to: 1,
      duration: 600,
      ease: 'Quad.easeOut',
      onUpdate: (tw) => {
        const v = tw.getValue() ?? 0;
        const r = startR + (endR - startR) * v;
        draw(r, 1 - v);
      },
      onComplete: () => ring.destroy(),
    });
  }

  // Pick the closest NPC carrying unread email and walk them to a
  // tile next to the player. When they arrive, open their click-
  // action popup (same as if the user clicked the sprite directly).
  // Press C to invoke from anywhere on the map.
  private callNearestNpc(): void {
    // Visual feedback fires whether or not anyone answers — confirms
    // the key press registered even when there's no nearby NPC.
    this.emitCallShockwave();
    if (!this.npcs.length) return;
    let best: NPC | null = null;
    let bestDist = Infinity;
    for (const npc of this.npcs) {
      const tids = (npc.data as any)?.threadIds as string[] | undefined;
      if (!Array.isArray(tids) || tids.length === 0) continue;
      const dx = npc.sprite.x - player.x;
      const dy = npc.sprite.y - player.y;
      const d = Math.hypot(dx, dy);
      if (d < bestDist) { bestDist = d; best = npc; }
    }
    if (!best) return;
    const TILE = 48;
    const playerTx = (player.x / TILE) | 0;
    const playerTy = (player.y / TILE) | 0;
    const cols = this.grid.cols;
    const rows = this.grid.rows;
    // Try the tile directly in front of the player first (their
    // current facing). If that's blocked, rotate them through the
    // other 3 cardinal directions until one is walkable — keeps the
    // delivery slot "in front" even when the player is facing a wall.
    // Fall back to a ring-search if all four cardinals are blocked
    // (player wedged into a corner).
    const offsets: Record<'down' | 'up' | 'left' | 'right', [number, number]> = {
      down:  [0,  1],
      up:    [0, -1],
      left:  [-1, 0],
      right: [1,  0],
    };
    const isWalkable = (tx: number, ty: number) =>
      tx >= 0 && ty >= 0 && tx < cols && ty < rows && !this.grid.cells[ty * cols + tx];
    const tryOrder: Array<'down' | 'up' | 'left' | 'right'> = [this.playerFacingDir];
    for (const d of ['down', 'up', 'left', 'right'] as const) if (d !== this.playerFacingDir) tryOrder.push(d);
    let meetX = playerTx, meetY = playerTy;
    let usedDir: 'down' | 'up' | 'left' | 'right' = this.playerFacingDir;
    let found = false;
    for (const d of tryOrder) {
      const [ox, oy] = offsets[d];
      const tx = playerTx + ox, ty = playerTy + oy;
      if (isWalkable(tx, ty)) {
        meetX = tx; meetY = ty; usedDir = d; found = true; break;
      }
    }
    if (!found) {
      // Player is fully boxed in. Ring outward as a last resort.
      outer: for (let r = 2; r <= 4; r++) {
        for (let dy = -r; dy <= r; dy++) {
          for (let dx = -r; dx <= r; dx++) {
            if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;
            const tx = playerTx + dx, ty = playerTy + dy;
            if (isWalkable(tx, ty)) { meetX = tx; meetY = ty; break outer; }
          }
        }
      }
      // usedDir stays as facing — won't matter since arrival is far away.
    }
    // Rotate the player to look toward the meet tile if the call had
    // to use a non-facing direction (or even confirm the original).
    this.playerFacingDir = usedDir;
    this.setPlayerStandFrame(usedDir);

    const meetDoor: Door = {
      x: meetX * TILE + TILE / 2,
      y: meetY * TILE + TILE / 2,
      tx: meetX, ty: meetY,
    };
    const npcRef = best;
    // Opposite of player's facing — the NPC should turn around to look
    // back at the player on arrival.
    const opposite: Record<'down' | 'up' | 'left' | 'right', 'down' | 'up' | 'left' | 'right'> = {
      down: 'up', up: 'down', left: 'right', right: 'left',
    };
    const npcFaceDir = opposite[usedDir];
    npcRef.queueWalk(meetDoor, () => {
      // Stop the walk anim and snap the NPC to a stand-frame pointing
      // back at the player so the popup feels like a face-to-face chat.
      npcRef.sprite.anims.stop();
      const standFrame = AVATAR_FRAMES[
        `stand${npcFaceDir.charAt(0).toUpperCase()}${npcFaceDir.slice(1)}` as
          keyof typeof AVATAR_FRAMES
      ];
      if (typeof standFrame === 'number') npcRef.sprite.setFrame(standFrame);
      // Anchor the popup at the NPC's CURRENT screen position.
      const cam = this.cameras.main;
      const sx = npcRef.sprite.x - cam.scrollX;
      const sy = npcRef.sprite.y - cam.scrollY;
      this.openNpcActionMenu(npcRef, sx, sy);
    }, 'you');
    console.log(`[call] summoned NPC (${(best.data as any)?.fromEmail || '?'}) to ${usedDir} of player at (${meetX}, ${meetY})`);
  }

  // Snap the player sprite to a static stand frame in the given
  // direction. Works with both the legacy 'atlas' misa-* texture and
  // the new layered avatar (`playerTextureKey`).
  private setPlayerStandFrame(dir: 'down' | 'up' | 'left' | 'right'): void {
    player.anims.stop();
    if (this.playerTextureKey) {
      const fr = AVATAR_FRAMES[
        `stand${dir.charAt(0).toUpperCase()}${dir.slice(1)}` as keyof typeof AVATAR_FRAMES
      ];
      if (typeof fr === 'number') player.setTexture(this.playerTextureKey, fr);
    } else {
      const misa = dir === 'down' ? 'misa-front'
                 : dir === 'up'   ? 'misa-back'
                 : dir === 'left' ? 'misa-left'
                                  : 'misa-right';
      player.setTexture('atlas', misa);
    }
  }

  // ---- Off-screen unread arrow ----
  // When the closest NPC is more than 15 tiles from the player we
  // float a small yellow arrow ~2 tiles in front of the player in
  // world space, pointing toward the nearest unread email so the
  // user knows which way to walk. Hides as soon as any NPC is in
  // range so the player isn't permanently followed by an arrow.
  private nearestArrow: Phaser.GameObjects.Text | null = null;
  private static NEAREST_THRESHOLD_TILES = 15;
  private static ARROW_DISTANCE_TILES = 2;     // how far in front of player
  private updateNearestNpcArrow(): void {
    if (!this.npcs.length) { this.hideNearestArrow(); return; }
    const TILE = 48;
    // Closest NPC by Euclidean distance from the player.
    let best: NPC | null = null;
    let bestDist = Infinity;
    for (const npc of this.npcs) {
      const dx = npc.sprite.x - player.x;
      const dy = npc.sprite.y - player.y;
      const d = Math.hypot(dx, dy);
      if (d < bestDist) { bestDist = d; best = npc; }
    }
    if (!best || bestDist <= VillageScene.NEAREST_THRESHOLD_TILES * TILE) {
      this.hideNearestArrow();
      return;
    }
    // Direction from player → NPC (world coords).
    const wdx = best.sprite.x - player.x;
    const wdy = best.sprite.y - player.y;
    const angle = Math.atan2(wdy, wdx);
    // Place the arrow 2 tiles ahead of the player along that vector.
    // World-space coordinates → the arrow rides above the player as
    // the camera follows, no setScrollFactor needed.
    const distance = TILE * VillageScene.ARROW_DISTANCE_TILES;
    const ax = player.x + Math.cos(angle) * distance;
    const ay = player.y + Math.sin(angle) * distance;
    if (!this.nearestArrow) {
      this.nearestArrow = this.add.text(0, 0, '➤', {
        font: 'bold 24px ui-sans-serif',
        color: '#ffe066',
      }).setDepth(60).setOrigin(0.5, 0.5);
      this.nearestArrow.setShadow(0, 0, '#000', 4, true, true);
    }
    this.nearestArrow.setVisible(true)
      .setPosition(ax, ay)
      .setRotation(angle);
  }
  private hideNearestArrow(): void {
    if (this.nearestArrow) this.nearestArrow.setVisible(false);
  }

  // ---- Region banner ----
  // When the player walks into a Tiled `Regions` polygon/rect, show
  // its name as a banner at the top of the viewport. Hides smoothly
  // when they leave. Reads from the existing regionContaining(x, y)
  // helper; only re-renders when the active region changes so this is
  // cheap to call every frame.
  private regionBannerEl: HTMLDivElement | null = null;
  private currentRegionName: string | null = null;
  private updateRegionBanner(): void {
    const region = this.regionContaining(player.x, player.y);
    const name = region?.name ?? null;
    if (name === this.currentRegionName) return;
    this.currentRegionName = name;
    if (!name) {
      if (this.regionBannerEl) {
        this.regionBannerEl.style.opacity = '0';
        const el = this.regionBannerEl;
        setTimeout(() => { if (el.parentNode && el.style.opacity === '0') el.remove(); }, 350);
        this.regionBannerEl = null;
      }
      return;
    }
    if (!this.regionBannerEl) {
      const bar = document.createElement('div');
      bar.style.cssText = `
        position:fixed; top:60px; left:50%; transform:translateX(-50%);
        z-index:50;
        background:rgba(15,15,15,0.88); color:#ffe066;
        border:1px solid #4a4520; border-radius:6px;
        padding:8px 22px;
        font:600 16px ui-sans-serif,system-ui,sans-serif;
        letter-spacing:0.05em; text-transform:uppercase;
        box-shadow:0 6px 24px rgba(0,0,0,0.7);
        opacity:0; transition:opacity 0.35s ease;
        pointer-events:none;
      `;
      document.body.appendChild(bar);
      this.regionBannerEl = bar;
      // Force a frame before fading in so the transition runs.
      requestAnimationFrame(() => { if (this.regionBannerEl) this.regionBannerEl.style.opacity = '1'; });
    }
    this.regionBannerEl.textContent = name;
    this.regionBannerEl.style.opacity = '1';
  }

  // Re-compose the avatar texture for a given sender email and swap
  // the texture on every NPC whose data.fromEmail matches. Called from
  // the `avatar:updated` listener so edits in any open customizer
  // appear on the in-world sprite immediately. No-ops if there's no
  // matching NPC right now.
  private async refreshNpcsForEmail(email: string): Promise<void> {
    const lower = email.toLowerCase();
    const matching = this.npcs.filter(n => {
      const e = (n.data as any)?.fromEmail;
      return typeof e === 'string' && e.toLowerCase() === lower;
    });
    if (!matching.length) return;
    const cfg = await ensureAvatar(email);
    const textureKey = await composeAndRegisterAvatar(this, cfg);
    for (const npc of matching) {
      npc.sprite.setTexture(textureKey, AVATAR_FRAMES.idleDown);
      // charKey drives anim key lookups (`${charKey}-walk-down` etc.),
      // so it has to swap too or the NPC will play stale animations.
      (npc as any).charKey = textureKey;
    }
    console.log(`[avatar:updated] swapped ${matching.length} NPC texture(s) for ${email} → ${textureKey}`);
  }

  private snapPlayerToPostOfficeDoor(map: Phaser.Tilemaps.Tilemap): void {
    const TILE = map.tileWidth;
    const buildingObjs = map.getObjectLayer('Building_Def')?.objects || [];
    const po = buildingObjs.find((o: any) => o.name === 'Post_Office') as any;
    if (!po || po.x == null || po.y == null || !po.width || !po.height) return;
    // Door inside the post office rect, if any.
    const doorObjsRaw = (map.getObjectLayer('doors')?.objects || []).filter(
      (o: any) => o.point && o.x != null && o.y != null,
    );
    const doorIn = doorObjsRaw.find((d: any) =>
      d.x >= po.x && d.x <= po.x + po.width && d.y >= po.y && d.y <= po.y + po.height,
    );
    const doorCol = doorIn ? Math.floor(doorIn.x / TILE) : Math.floor((po.x + po.width / 2) / TILE);
    // Bottom edge of building, in tile rows. The row immediately BELOW
    // the building is row `bottomRow`. Step down a few rows until we
    // find walkable; for each row, expand outward from doorCol.
    const bottomRow = Math.floor((po.y + po.height) / TILE);
    const cols = this.grid.cols;
    const rows = this.grid.rows;
    for (let rowOffset = 0; rowOffset < 5; rowOffset++) {
      const row = bottomRow + rowOffset;
      if (row < 0 || row >= rows) continue;
      for (let dist = 0; dist <= 20; dist++) {
        for (const sign of (dist === 0 ? [0] : [-1, 1])) {
          const col = doorCol + sign * dist;
          if (col < 0 || col >= cols) continue;
          if (!this.grid.cells[row * cols + col]) {
            player.setPosition(col * TILE + TILE / 2, row * TILE + TILE / 2);
            console.log(`[player-spawn] snapped to (${col}, ${row}) below Post_Office door (col ${doorCol})`);
            return;
          }
        }
      }
    }
    console.warn('[player-spawn] no walkable tile found below Post_Office door — keeping initial position');
  }

  private closeMinimap(): void {
    if (!this.minimapEl) return;
    this.minimapEl.remove();
    this.minimapEl = null;
  }

  update(): void {
    // Sweep zombie NPCs — any with empty threadIds AND no active path,
    // queue, or target. These should have despawned but didn't (usually
    // because some move flow cleared threads before bailing on a
    // missing destination door). Walk in reverse so splice is safe.
    for (let i = this.npcs.length - 1; i >= 0; i--) {
      const npc = this.npcs[i];
      const data = npc.data as any;
      const tids = Array.isArray(data?.threadIds) ? data.threadIds as string[] : null;
      if (tids && tids.length === 0 && !npc.targetDoor && !npc.path.length && npc.walkQueue.length === 0) {
        npc.destroy();
        this.npcs.splice(i, 1);
      }
    }
    for (const npc of this.npcs) npc.update();
    // Y-sort the character sprites so the one closer to the camera
    // (lower on screen = higher y) draws on top. Buildings layer
    // (depth 15) and trees (depth 10) stay below — every character's
    // depth ends up ≥ ~30, far above both. Using sprite.y directly
    // sorts by sprite center; with same-height LimeZu 48x96 sprites
    // that's indistinguishable from sorting by feet position.
    if (player) player.setDepth(player.y);
    for (const npc of this.npcs) npc.sprite.setDepth(npc.sprite.y);
    if (this.showPaths) this.drawNpcPaths();
    this.updateNearestNpcArrow();
    this.updateRegionBanner();

    const speed = 175;
    const prev = player.body.velocity.clone();
    player.body.setVelocity(0);

    // While the user is editing a DOM input, freeze the player and skip
    // movement input entirely — arrow keys go to text-editing instead.
    if (this.isTyping) {
      player.anims.stop();
      return;
    }

    const left  = cursors.left.isDown  || wasd.A.isDown;
    const right = cursors.right.isDown || wasd.D.isDown;
    const up    = cursors.up.isDown    || wasd.W.isDown;
    const down  = cursors.down.isDown  || wasd.S.isDown;

    if (left)       player.body.setVelocityX(-speed);
    else if (right) player.body.setVelocityX(speed);
    if (up)         player.body.setVelocityY(-speed);
    else if (down)  player.body.setVelocityY(speed);

    player.body.velocity.normalize().scale(speed);

    // Track cardinal facing — used by callNearestNpc to deliver the
    // NPC in front of the player and to spin them to face each other.
    if (left)       this.playerFacingDir = 'left';
    else if (right) this.playerFacingDir = 'right';
    else if (up)    this.playerFacingDir = 'up';
    else if (down)  this.playerFacingDir = 'down';

    // Player anim key namespace switches at runtime: until the layered
    // avatar texture composes (async), we play the legacy `misa-*`
    // atlas anims; once composed, we play `<avatar_key>-walk-<dir>`.
    const ak = this.playerTextureKey;
    if (ak) {
      if (left)       player.anims.play(`${ak}-walk-left`, true);
      else if (right) player.anims.play(`${ak}-walk-right`, true);
      else if (up)    player.anims.play(`${ak}-walk-up`, true);
      else if (down)  player.anims.play(`${ak}-walk-down`, true);
      else {
        player.anims.stop();
        if (prev.x < 0)      player.setTexture(ak, AVATAR_FRAMES.standLeft);
        else if (prev.x > 0) player.setTexture(ak, AVATAR_FRAMES.standRight);
        else if (prev.y < 0) player.setTexture(ak, AVATAR_FRAMES.standUp);
        else if (prev.y > 0) player.setTexture(ak, AVATAR_FRAMES.standDown);
      }
    } else if (left)       player.anims.play('misa-left-walk', true);
    else if (right) player.anims.play('misa-right-walk', true);
    else if (up)    player.anims.play('misa-back-walk', true);
    else if (down)  player.anims.play('misa-front-walk', true);
    else {
      player.anims.stop();
      if (prev.x < 0)      player.setTexture('atlas', 'misa-left');
      else if (prev.x > 0) player.setTexture('atlas', 'misa-right');
      else if (prev.y < 0) player.setTexture('atlas', 'misa-back');
      else if (prev.y > 0) player.setTexture('atlas', 'misa-front');
    }
  }
}

// Wait for the SQLite-backed persisted state to land before booting
// the Phaser game. The bootstrap promise resolves quickly (sub-second
// when the backend is responsive), and waiting here keeps create()
// synchronous — Phaser 4 doesn't reliably await async create() and
// can run update() against a half-initialised scene, which presented
// as a black screen with no DevTools accessible.
bootstrapPersistedState.then(() => {
  new Phaser.Game({
    type: Phaser.AUTO,
    parent: 'game-container',
    pixelArt: true,
    scale: {
      mode: Phaser.Scale.RESIZE,
      width: window.innerWidth,
      height: window.innerHeight,
    },
    physics: { default: 'arcade', arcade: { gravity: { x: 0, y: 0 } } },
    scene: [VillageScene],
  });
});

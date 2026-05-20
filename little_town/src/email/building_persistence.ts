// Town Inbox — building binding persistence.
//
// Owns the renderer's view of /api/buildings: a Record<buildingId,
// { customName, labels[] }> that backs the scene's getBuildingLabels()
// + custom-name overrides + label-resolution-on-rehydrate. Migrated
// from localStorage to SQLite during Phase F.1.
//
// Three responsibilities, each a tiny exported function:
//   1. `loadBuildingBindings()` — one-shot fetch on bundle load.
//      Falls through to legacy localStorage keys if the API returns
//      empty (first launch after the SQLite migration shipped). Posts
//      those legacy entries back to the API + clears the localStorage
//      keys.
//   2. `getBuildingLabelMap()` / `getBuildingNameMap()` — synchronous
//      readers backed by an in-memory copy of the fetched/migrated map.
//      Used by the scene's create() loop.
//   3. `persistBuilding(buildingId, name, labels)` — PUT one building's
//      binding. Fire-and-forget; failures surface on the bottom status
//      bar via the global townStatus shim.

import { api } from '../api';

type BindingMap = Record<string, { customName: string | null; labels: string[] }>;

// In-memory cache populated by loadBuildingBindings(). Synchronous
// readers below take from this; the scene's create() reads it after
// the bundle-level bootstrap promise resolves.
let bindings: BindingMap = {};

// Concurrent-fetch guard. loadBuildingBindings() is called once at
// bundle bootstrap AND every account switch — if both fire close
// together (e.g. account switch happens during the bootstrap fetch),
// the second caller waits on the first instead of starting a parallel
// request that would race to write the same `bindings` map.
let loadingPromise: Promise<BindingMap> | null = null;

const LEGACY_LABELS_V2_KEY = 'little_town.building_labels_v2';
const LEGACY_LABELS_V1_KEY = 'little_town.building_labels';     // v1 stored a single name, not array
const LEGACY_NAMES_KEY     = 'little_town.building_names';

/** Read legacy localStorage keys if the user hasn't been migrated yet. */
function readLegacyFromLocalStorage(): BindingMap {
  const out: BindingMap = {};
  try {
    const rawV2 = localStorage.getItem(LEGACY_LABELS_V2_KEY);
    const rawV1 = localStorage.getItem(LEGACY_LABELS_V1_KEY);
    const rawNames = localStorage.getItem(LEGACY_NAMES_KEY);
    if (!rawV2 && !rawV1 && !rawNames) return out;
    const labels: Record<string, string[]> = rawV2
      ? JSON.parse(rawV2)
      : rawV1
        ? Object.fromEntries(
            Object.entries(JSON.parse(rawV1) as Record<string, string>)
              .filter(([, n]) => !!n)
              .map(([id, n]) => [id, [n]]),
          )
        : {};
    const names: Record<string, string> = rawNames ? JSON.parse(rawNames) : {};
    for (const id of new Set([...Object.keys(labels), ...Object.keys(names)])) {
      out[id] = { customName: names[id] || null, labels: labels[id] || [] };
    }
  } catch (err) {
    console.warn('[buildings] localStorage migration read failed:', err);
  }
  return out;
}

function clearLegacyLocalStorageKeys(): void {
  try {
    localStorage.removeItem(LEGACY_LABELS_V2_KEY);
    localStorage.removeItem(LEGACY_LABELS_V1_KEY);
    localStorage.removeItem(LEGACY_NAMES_KEY);
  } catch { /* fine */ }
}

/**
 * Bundle-bootstrap hook. Fetches /api/buildings; if empty, migrates
 * legacy localStorage keys (one-shot, with cleanup). Resolves to the
 * in-memory bindings map. Concurrent calls share one in-flight fetch.
 */
export async function loadBuildingBindings(): Promise<BindingMap> {
  if (loadingPromise) return loadingPromise;
  loadingPromise = (async () => {
    try {
      const fromApi = await api.buildings.list();
      if (Object.keys(fromApi).length > 0) {
        bindings = fromApi as BindingMap;
        return bindings;
      }
      // SQLite empty — try legacy localStorage migration.
      const legacy = readLegacyFromLocalStorage();
      if (Object.keys(legacy).length === 0) {
        bindings = {};
        return bindings;
      }
      bindings = legacy;
      await Promise.all(Object.entries(legacy).map(([id, b]) =>
        api.buildings.put(id, b).catch(err => console.warn(`[buildings] migrate ${id} failed:`, err))));
      console.log(`[bootstrap] migrated ${Object.keys(legacy).length} building bindings from localStorage to SQLite`);
      clearLegacyLocalStorageKeys();
      return bindings;
    } catch (err) {
      console.warn('[buildings] API hydrate failed, falling back to legacy localStorage:', err);
      bindings = readLegacyFromLocalStorage();
      return bindings;
    } finally {
      // Clear the flag so a future account change can re-load.
      loadingPromise = null;
    }
  })();
  return loadingPromise;
}

/** Synchronous reader — building ids → bound label name arrays. Skips entries with empty labels. */
export function getBuildingLabelMap(): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [id, b] of Object.entries(bindings)) {
    if (b.labels?.length) out[id] = b.labels;
  }
  return out;
}

/** Synchronous reader — building ids → user-renamed names. Skips defaults. */
export function getBuildingNameMap(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [id, b] of Object.entries(bindings)) {
    if (b.customName) out[id] = b.customName;
  }
  return out;
}

/**
 * Persist ONE building's binding. Fire-and-forget — caller doesn't
 * await; failures surface on the bottom status bar so the user sees
 * a clear error instead of a silent drop.
 */
export function persistBuilding(buildingId: number, customName: string | null, labels: string[]): void {
  bindings[String(buildingId)] = { customName: customName || null, labels: [...labels] };
  api.buildings.put(buildingId, { customName: customName || null, labels })
    .catch(err => {
      console.warn(`[buildings] save failed for ${buildingId}:`, err);
      try { (window as any).townStatus?.set?.(`Building save failed: ${err}`, { tone: 'err', ttlMs: 4000 }); } catch {}
    });
}

/** Wipe in-memory cache. Used on account switch so cross-account state can't leak. */
export function resetBuildingBindingsForAccountChange(): void {
  bindings = {};
  loadingPromise = null;     // allow loadBuildingBindings() to re-run for the new account
}

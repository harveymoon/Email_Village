// People = unique email senders aggregated from every cached thread.
// Persistent overrides (chosen character sprite, display-name override,
// notes) live in localStorage keyed by lowercased email address.
//
// The aggregation rebuilds on demand from whatever's currently in the
// scene's `emailCache`. Users only see people from labels they've
// opened — which is fine for a first pass and saves a lot of API
// calls. A "scan all" button on the popup forces every labeled
// building to be fetched, populating the cache fully.

import type { EmailThread } from './api';
import { CHARACTERS, characterForKey, type CharacterDef } from './characters';

// Contact-card overrides. Field names mirror the Google People API
// (developers.google.com/people/api/rest/v1/people#Person) so we can
// later sync with Google Contacts without remapping our schema:
//   - names.{givenName, familyName, displayName} → givenName / familyName / name
//   - organizations.{name, title}                → organization / jobTitle
//   - phoneNumbers[].{value, type}               → phoneNumbers[]
//   - emailAddresses[].{value, type}             → emails[] (additional)
//   - addresses[].{formattedValue, type}         → addresses[]
//   - urls[].{value, type}                       → urls[]
//   - birthdays[].text                           → birthday
//   - biographies[].value                        → notes
// `googleContactId` reserves a slot for a `resourceName` like
// "people/c12345" once contacts sync is wired up.
export interface ContactField { value: string; type?: string }

export interface PersonOverride {
  // Game-specific
  name?: string;                       // user-chosen display name (vs. From header)
  charKey?: string;                    // chosen character sprite key
  // Contact card (Google People API shape)
  givenName?: string;
  familyName?: string;
  organization?: string;
  jobTitle?: string;
  phoneNumbers?: ContactField[];
  emails?: ContactField[];             // additional emails (beyond the primary key)
  addresses?: ContactField[];
  urls?: ContactField[];
  birthday?: string;                   // free-form text (Google stores text + structured)
  notes?: string;                      // biographies[0].value
  // Sync hook for later
  googleContactId?: string;
}

export interface Person {
  email: string;                  // canonical key (lowercased)
  name: string;                   // best-known display name (override or From)
  charKey: string;                // chosen sprite or hashed default
  threadIds: Set<string>;
  unread: number;
  override: PersonOverride | null;
}

const STORAGE_KEY = 'little_town.people';

// In-memory cache hydrated lazily from /api/people-overrides. Writes
// flow through /api/people-overrides/:email. Synchronous read API
// preserved (the rest of the codebase calls loadOverrides() inline) —
// callers must await hydratePeopleOverrides() once at bootstrap before
// the first sync read. Falls back to {} until then.

import { api } from './api';

const cache = new Map<string, PersonOverride>();
let hydrating: Promise<void> | null = null;

async function hydrateOnce(): Promise<void> {
  if (hydrating) return hydrating;
  hydrating = (async () => {
    try {
      const fromApi = await api.peopleOverrides.list();
      for (const [k, v] of Object.entries(fromApi)) {
        if (v && typeof v === 'object') cache.set(k.toLowerCase(), v as PersonOverride);
      }
      // One-shot migration of legacy localStorage blob if the API is
      // empty (first launch after the SQLite migration ships).
      try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw && cache.size === 0) {
          const legacy = JSON.parse(raw) as Record<string, PersonOverride>;
          let n = 0;
          for (const [k, v] of Object.entries(legacy)) {
            if (!v || typeof v !== 'object') continue;
            const key = k.toLowerCase();
            cache.set(key, v);
            api.peopleOverrides.put(key, v).catch(err => console.warn('[people] migrate failed', key, err));
            n++;
          }
          if (n > 0) console.log(`[people] migrated ${n} overrides from localStorage to SQLite`);
          localStorage.removeItem(STORAGE_KEY);
        }
      } catch (err) {
        console.warn('[people] localStorage migration skipped:', err);
      }
    } catch (err) {
      console.warn('[people] API hydrate failed, running in offline mode:', err);
    }
  })();
  return hydrating;
}

export async function hydratePeopleOverrides(): Promise<void> {
  await hydrateOnce();
}

/**
 * Wipe the in-memory people-overrides cache + force re-fetch on next
 * use. Called on account switch so Account A's display-name / notes
 * overrides don't bleed into Account B's UI.
 */
export function resetPeopleOverridesForAccountChange(): void {
  cache.clear();
  hydrating = null;
}

export function loadOverrides(): Record<string, PersonOverride> {
  // Object.fromEntries on the cache gives every caller a fresh-looking
  // map without leaking the Map reference.
  return Object.fromEntries(cache);
}

export function saveOverride(email: string, override: PersonOverride): void {
  const key = email.toLowerCase();
  // Drop empty fields to keep storage tidy.
  const cleaned: PersonOverride = {};
  if (override.name?.trim()) cleaned.name = override.name.trim();
  if (override.charKey) cleaned.charKey = override.charKey;
  if (override.notes?.trim()) cleaned.notes = override.notes.trim();
  if (Object.keys(cleaned).length === 0) {
    cache.delete(key);
    // Sending an empty PUT just resets the row to all-NULL columns;
    // ok for our purposes. We don't bother with a separate DELETE
    // endpoint since the row is effectively no-op.
    api.peopleOverrides.put(key, {}).catch(err => console.warn('[people] clear failed', key, err));
  } else {
    cache.set(key, cleaned);
    api.peopleOverrides.put(key, cleaned).catch(err => {
      console.warn(`[people] save failed for ${key}:`, err);
      try { (window as any).townStatus?.set?.(`Person save failed: ${err}`, { tone: 'err', ttlMs: 4000 }); } catch {}
    });
  }
}

// Canonical lookup: a person's sprite, name, etc., wherever they're
// rendered (email-list avatars, future NPC spawns). Uses the override
// if present, otherwise falls back to the hashed default + From name.
export function characterForEmail(email: string): CharacterDef {
  const overrides = loadOverrides();
  const o = overrides[email.toLowerCase()];
  if (o?.charKey) {
    const found = CHARACTERS.find(c => c.key === o.charKey);
    if (found) return found;
  }
  return characterForKey(email);
}

export function displayNameFor(email: string, fallbackName?: string): string {
  const o = loadOverrides()[email.toLowerCase()];
  if (o?.name) return o.name;
  return fallbackName || email;
}

// Walk every cached thread and produce a Person per unique sender.
// `threads` is typically scene.emailCache.values() flattened.
export function aggregatePeople(threads: EmailThread[]): Person[] {
  const overrides = loadOverrides();
  const map = new Map<string, Person>();
  for (const t of threads) {
    for (const m of t.messages) {
      const email = m.from?.email?.toLowerCase();
      if (!email) continue;
      let p = map.get(email);
      if (!p) {
        const ov = overrides[email] || null;
        p = {
          email,
          name: ov?.name || m.from?.name || email,
          charKey: ov?.charKey || characterForKey(email).key,
          threadIds: new Set(),
          unread: 0,
          override: ov,
        };
        map.set(email, p);
      }
      if (!p.threadIds.has(t.threadId)) {
        p.threadIds.add(t.threadId);
        if (!t.isRead) p.unread++;
      }
    }
  }
  return [...map.values()].sort((a, b) => {
    if (a.unread !== b.unread) return b.unread - a.unread;     // unread first
    return b.threadIds.size - a.threadIds.size;                // then volume
  });
}

// Filter threads that include a given person as a sender. Used in
// the individual popup to show their conversation history.
export function threadsForPerson(threads: EmailThread[], email: string): EmailThread[] {
  const e = email.toLowerCase();
  return threads.filter(t => t.messages.some(m => m.from?.email?.toLowerCase() === e));
}

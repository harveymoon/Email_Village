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

export function loadOverrides(): Record<string, PersonOverride> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch { return {}; }
}

export function saveOverride(email: string, override: PersonOverride): void {
  const key = email.toLowerCase();
  const all = loadOverrides();
  // Drop empty overrides to keep storage tidy.
  const cleaned: PersonOverride = {};
  if (override.name?.trim()) cleaned.name = override.name.trim();
  if (override.charKey) cleaned.charKey = override.charKey;
  if (override.notes?.trim()) cleaned.notes = override.notes.trim();
  if (Object.keys(cleaned).length === 0) {
    delete all[key];
  } else {
    all[key] = cleaned;
  }
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(all)); } catch {}
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

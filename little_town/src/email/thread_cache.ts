// Town Inbox — in-memory thread cache.
//
// Owns the `Map<labelName, EmailThread[]>` that the renderer renders
// against. Three responsibilities:
//
//   1. **Fetching** — `loadForLabel(name, force?)` returns the cached
//      array if present, else hits /api/emails to populate. Dedupes
//      concurrent fetches via an in-flight promise map.
//
//   2. **Surgical mutation** — when a thread moves between labels, the
//      cache layer must be patched in place so open UIs (which hold
//      references to the cached EmailThread objects) see the change
//      without a re-fetch. `patchThreadLabels` / `addThreadToLabel` /
//      `removeThreadFromLabel` handle this.
//
//   3. **Cross-cutting reads** — `getAll()` flattens every cached
//      label list into a deduped EmailThread[] for the People grid +
//      suggestion engine + sender-history co-filing counts.
//
// Extracted from main.ts during Phase I.3 of the codebase split.
// Scene-level move/mark orchestration stays in main.ts (it has Phaser
// side-effects like NPC walks and badge updates); this module owns
// the pure-data side and dispatches the cross-module
// `thread:labels-updated` event when patches land.

import { api, type EmailThread, type GmailLabel } from '../api';

export interface ThreadCacheDeps {
  /** Returns the current label catalogue (used by patchThreadLabels to resolve names → rawIds). */
  getLabelCache: () => GmailLabel[];
}

export class ThreadCache {
  private cache = new Map<string, EmailThread[]>();
  private inFlight = new Map<string, Promise<EmailThread[]>>();

  constructor(private deps: ThreadCacheDeps) {}

  /**
   * Fetch threads for one label name (e.g. "INBOX", "Hobbies/Patreon")
   * via /api/emails. Returns the cached array if present. Concurrent
   * calls for the same label share one in-flight promise.
   *
   * The backend (after Phase F.1) reads from SQLite so the cap is
   * irrelevant in practice; we pass 1000 as a defensive ceiling.
   */
  async loadForLabel(labelName: string, force = false): Promise<EmailThread[]> {
    if (!force && this.cache.has(labelName)) return this.cache.get(labelName)!;
    if (!force && this.inFlight.has(labelName)) return this.inFlight.get(labelName)!;
    const p = api.threads(`label:"${labelName}"`, 1000).then(resp => {
      this.cache.set(labelName, resp.emails);
      this.inFlight.delete(labelName);
      return resp.emails;
    }).catch(err => {
      this.inFlight.delete(labelName);
      throw err;
    });
    this.inFlight.set(labelName, p);
    return p;
  }

  /** True iff loadForLabel has populated `labelName` at least once. */
  has(labelName: string): boolean {
    return this.cache.has(labelName);
  }

  /** Read-only access to one label's threads. Empty array if not yet fetched. */
  get(labelName: string): EmailThread[] {
    return this.cache.get(labelName) || [];
  }

  /** Wipe everything — used on account switch or "Refresh inbox" before respawn. */
  clear(): void {
    this.cache.clear();
    this.inFlight.clear();
  }

  /** Iterate cached (labelName, threads) pairs. Used by getAll + writeBack walks. */
  entries(): IterableIterator<[string, EmailThread[]]> {
    return this.cache.entries();
  }

  /** Flatten every cached label list into a deduped EmailThread[]. */
  getAll(): EmailThread[] {
    const seen = new Set<string>();
    const out: EmailThread[] = [];
    for (const arr of this.cache.values()) {
      for (const t of arr) {
        if (seen.has(t.threadId)) continue;
        seen.add(t.threadId);
        out.push(t);
      }
    }
    return out;
  }

  /** Find a thread by id across every cached label list. */
  findById(threadId: string): EmailThread | null {
    for (const arr of this.cache.values()) {
      for (const t of arr) if (t.threadId === threadId) return t;
    }
    return null;
  }

  /**
   * Patch the labels on every cached copy of `threadId`. Add the rawId
   * resolved from `addName` + account; remove any rawIds matching
   * `removeNames`. Dispatches `thread:labels-updated` on success so
   * open popups (person profile, etc.) can refresh their views.
   */
  patchThreadLabels(threadId: string, addName: string, removeNames: string[]): void {
    const labels = this.deps.getLabelCache();
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
    for (const arr of this.cache.values()) for (const t of arr) apply(t);
    if (patched > 0) console.log(`[move] patched labels on ${patched} cached thread copies`);
    // Notify any open UI that holds its own thread references (e.g.
    // the person profile popup includes threads it fetched fresh from
    // /api/threads/:id — those never lived in the cache so the loop
    // above doesn't reach them). Listeners patch their own copies and
    // schedule a re-render.
    try {
      document.dispatchEvent(new CustomEvent('thread:labels-updated', {
        detail: { threadId, addedRawId: addRaw || null, removedRawIds: [...removeRawSet] },
      }));
    } catch { /* non-DOM env */ }
  }

  /** Splice `threadId` out of one label's cached list. No-op if not present. */
  removeThreadFromLabel(labelName: string, threadId: string): void {
    const arr = this.cache.get(labelName);
    if (!arr) return;
    const idx = arr.findIndex(t => t.threadId === threadId);
    if (idx < 0) return;
    arr.splice(idx, 1);
  }

  /** Prepend a thread to one label's cached list (skip if cache slot empty or dup). */
  addThreadToLabel(labelName: string, thread: EmailThread): void {
    const arr = this.cache.get(labelName);
    if (!arr) return;
    if (arr.some(t => t.threadId === thread.threadId)) return;
    arr.unshift(thread);
  }
}

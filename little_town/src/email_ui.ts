// Dark-themed email list renderer. Used inside the building popup body
// when the building is bound to a Gmail label. Rows display:
//   - a horizontal stack of N small character avatars (N = unique
//     participants, capped at 6) picked deterministically from the
//     character spritesheets so the same sender always looks the same
//   - subject line (brighter / bolder if any message in the thread is
//     unread)
//   - chips: sender domain(s) ("google.com", "apple.com"…) and a
//     message-count badge if the thread has > 1 message
//   - click → callback (Phase 4 wires this to the content popup)

import type { EmailThread, GmailLabel } from './api';
import { avatarPortraitForEmail } from './avatar';
import { clampPopupToViewport } from './ui_helpers';

export interface RenderEmailListOptions {
  threads: EmailThread[];
  onSelect: (thread: EmailThread) => void;
  // When set, group threads by their immediate sub-label under any of
  // the given parent labels. Each sub-label becomes a collapsible
  // `<details>` floor. Floors with unread default-open. Threads with no
  // sub-label under any parent live in a "(direct)" floor at the top.
  parentLabels?: string[];
  // All known labels (any account). Needed to resolve thread.labels
  // (which are raw account-specific Gmail label IDs) into human names.
  labels?: GmailLabel[];
  // Optional quick-move support. When `destinationsFor` is provided,
  // each row gets a small "Move →" button that opens a destination
  // dropdown without first opening the email content popup. The
  // function is called PER ROW so the caller can filter destinations
  // by the thread's account (only show buildings whose labels exist
  // in the thread's account).
  destinationsFor?: (t: EmailThread) => Array<{ labelId: string; label: string; buildingName: string }>;
  onMove?: (threadId: string, destLabelId: string, destBuildingName: string, overrideLabel?: string) => Promise<void>;
  // Optional floor-move support. `floorsFor` lists floors (sub-labels
  // under any of the building's bound parent labels) this thread could
  // be moved to — already filtered for the thread's account and with
  // the thread's current floor(s) excluded. `onMoveToFloor` actually
  // applies the new sub-label and strips any other sub-label the
  // thread carries under the same parent.
  floorsFor?: (t: EmailThread) => FloorOption[];
  onMoveToFloor?: (t: EmailThread, opt: FloorOption) => Promise<void>;
  // Optional "Add rule" button. When provided, each row renders a small
  // button that opens the rule editor pre-filled for this thread's
  // sender (and account). Same UX path as the +Create rule button on
  // the NPC popup, just exposed inline in the inbox / building list.
  onMakeRule?: (t: EmailThread) => void;
  // Optional per-thread building tag(s). Used in the person profile so
  // each conversation row shows which building it's currently filed
  // under (e.g. "Newsletters", "Post Office"). Resolution lives in the
  // caller because it depends on the user's building→label bindings.
  buildingsForThread?: (t: EmailThread) => string[];
}

export interface FloorOption {
  // Stable key for grouping/deduping in the popup. Includes parent so
  // floors with the same leaf name across different parents don't collide.
  key: string;
  // Display name shown in the floor picker (leaf only when there's just
  // one bound parent, otherwise "parent/leaf" to disambiguate).
  label: string;
  // Full Gmail label name to apply (e.g. "Projects/Archive/NTT").
  fullName: string;
  // The bound parent this floor lives under (e.g. "Projects/Archive").
  parent: string;
}

// Find every email-row currently in the DOM that represents `threadId`
// and re-skin it to show the read state. Called from main.ts after
// `markThreadRead` runs so the user sees the unread highlight drop
// immediately, even while the content popup is still open in front.
export function applyReadStateToRow(threadId: string, isRead: boolean): void {
  const rows = document.querySelectorAll<HTMLDivElement>(`[data-thread-row="${cssEscape(threadId)}"]`);
  rows.forEach(row => {
    row.dataset.readState = isRead ? 'read' : 'unread';
    const unread = !isRead;
    const work = row.dataset.work === '1';
    const c = rowColors(work);
    row.style.background = unread ? c.bgUnread : c.bgRead;
    row.style.borderColor = unread ? c.borderUnread : c.borderRead;
    // Restyle the subject row (first <div> child of the middle column).
    const subj = row.querySelector<HTMLDivElement>('[data-subject]');
    if (subj) {
      subj.style.fontWeight = unread ? '600' : '400';
      subj.style.color = unread ? '#fff' : '#bbb';
    }
  });
}

// Shared filter for any Move-to picker. Honors `searchText` (which now
// includes the building's bound labels + every sub-label / floor under
// them) when present; falls back to the legacy buildingName+label check
// for callers that haven't been updated.
export function destinationMatches(
  d: { buildingName: string; label: string; searchText?: string },
  q: string,
): boolean {
  if (!q) return true;
  if (d.searchText) return d.searchText.includes(q);
  return d.buildingName.toLowerCase().includes(q) || d.label.toLowerCase().includes(q);
}

// If the search query matched ONLY because of a sub-label / floor (and
// not the building name itself), return that floor name so the UI can
// show "via Shopping/AliExpress" instead of repeating the bound label.
export function matchedFloor(
  d: { buildingName: string; floors?: string[] },
  q: string,
): string | null {
  if (!q || !d.floors?.length) return null;
  if (d.buildingName.toLowerCase().includes(q)) return null;
  return d.floors.find(f => f.toLowerCase().includes(q)) || null;
}

// Apply the suggested-destination visual treatment to a popover row.
// Returns the suggestion (so callers can also build a caption) or null
// if the destination wasn't suggested.
export function applySuggestionStyle(
  row: HTMLElement,
  d: { suggestion?: { confidence: number; reason: string; label?: string } },
): { confidence: number; reason: string; label?: string } | null {
  if (!d.suggestion) return null;
  row.style.borderLeft = '3px solid #6ad26a';
  row.style.background = 'rgba(106, 210, 106, 0.07)';
  return d.suggestion;
}

function cssEscape(s: string): string {
  // CSS attribute selector doesn't tolerate ':' or other special chars
  // without escaping. (CSS.escape is widely supported but defensive.)
  return (typeof CSS !== 'undefined' && (CSS as any).escape)
    ? (CSS as any).escape(s)
    : s.replace(/[^a-zA-Z0-9_-]/g, c => `\\${c}`);
}

export function renderEmailListInto(container: HTMLElement, opts: RenderEmailListOptions): void {
  container.innerHTML = '';
  if (!opts.threads.length) {
    container.appendChild(emptyState());
    return;
  }
  const sorted = [...opts.threads].sort((a, b) => {
    if (a.isRead !== b.isRead) return a.isRead ? 1 : -1;
    return new Date(b.date).getTime() - new Date(a.date).getTime();
  });
  if (opts.parentLabels && opts.parentLabels.length && opts.labels && opts.labels.length) {
    renderWithFloors(container, sorted, opts.parentLabels, opts.labels, opts.onSelect, opts.destinationsFor, opts.onMove, opts.floorsFor, opts.onMoveToFloor, opts.onMakeRule, opts.buildingsForThread);
    return;
  }
  for (const t of sorted) container.appendChild(makeRow(t, opts.onSelect, opts.destinationsFor, opts.onMove, opts.floorsFor, opts.onMoveToFloor, opts.onMakeRule, opts.buildingsForThread));
}

// Build (account, rawId) → name lookup, then for each thread find what
// sub-labels under any of the given `parents` it carries. Group by the
// IMMEDIATE child of the matching parent. Multiple parents share the
// (direct) bucket; sub-label floors include the parent in their key so
// floors from different parents stay distinct even if leaf names collide.
function renderWithFloors(
  container: HTMLElement,
  threads: EmailThread[],
  parents: string[],
  labels: GmailLabel[],
  onSelect: (t: EmailThread) => void,
  destinationsFor?: (t: EmailThread) => Array<{ labelId: string; label: string; buildingName: string; floors?: string[]; suggestion?: { confidence: number; reason: string; label?: string } }>,
  onMove?: (threadId: string, destLabelId: string, destBuildingName: string, overrideLabel?: string) => Promise<void>,
  floorsFor?: (t: EmailThread) => FloorOption[],
  onMoveToFloor?: (t: EmailThread, opt: FloorOption) => Promise<void>,
  onMakeRule?: (t: EmailThread) => void,
  buildingsForThread?: (t: EmailThread) => string[],
): void {
  const nameByIdKey = new Map<string, string>();
  for (const l of labels) nameByIdKey.set(`${l.account}:${l.rawId}`, l.name);

  // Returns { floorKey, floorLabel } for the thread.
  const floorOf = (t: EmailThread): { key: string; label: string } => {
    let bestParent: string | null = null;
    let bestSubPath: string | null = null;
    for (const rawId of t.labels) {
      const name = nameByIdKey.get(`${t.account}:${rawId}`);
      if (!name) continue;
      for (const parent of parents) {
        if (name === parent) {
          if (!bestParent) bestParent = parent;     // direct under this parent
        } else if (name.startsWith(`${parent}/`)) {
          if (!bestSubPath || name.length > bestSubPath.length) {
            bestSubPath = name; bestParent = parent;
          }
        }
      }
    }
    if (bestSubPath && bestParent) {
      const rest = bestSubPath.slice(bestParent.length + 1);
      const idx = rest.indexOf('/');
      const leaf = idx >= 0 ? rest.slice(0, idx) : rest;
      // Include parent in the floor label only when there's more than
      // one bound parent (avoid noise when there's just one).
      const display = parents.length > 1 ? `${bestParent}/${leaf}` : leaf;
      return { key: `${bestParent}::${leaf}`, label: display };
    }
    return { key: '(direct)', label: '(direct)' };
  };

  // Group threads by floor key.
  const groups = new Map<string, { label: string; threads: EmailThread[] }>();
  for (const t of threads) {
    const f = floorOf(t);
    if (!groups.has(f.key)) groups.set(f.key, { label: f.label, threads: [] });
    groups.get(f.key)!.threads.push(t);
  }
  const entries = [...groups.entries()].map(([key, g]) => ({
    key, label: g.label, threads: g.threads, unread: g.threads.filter(t => !t.isRead).length,
  }));
  entries.sort((a, b) => {
    if (a.key === '(direct)') return -1;
    if (b.key === '(direct)') return 1;
    if (a.unread !== b.unread) return b.unread - a.unread;
    return a.label.localeCompare(b.label);
  });
  for (const g of entries) {
    container.appendChild(makeFloor(g.label, g.threads, g.unread, onSelect, destinationsFor, onMove, floorsFor, onMoveToFloor, onMakeRule, buildingsForThread));
  }
}

function makeFloor(
  name: string,
  threads: EmailThread[],
  unread: number,
  onSelect: (t: EmailThread) => void,
  destinationsFor?: (t: EmailThread) => Array<{ labelId: string; label: string; buildingName: string; floors?: string[]; suggestion?: { confidence: number; reason: string; label?: string } }>,
  onMove?: (threadId: string, destLabelId: string, destBuildingName: string, overrideLabel?: string) => Promise<void>,
  floorsFor?: (t: EmailThread) => FloorOption[],
  onMoveToFloor?: (t: EmailThread, opt: FloorOption) => Promise<void>,
  onMakeRule?: (t: EmailThread) => void,
  buildingsForThread?: (t: EmailThread) => string[],
): HTMLDetailsElement {
  const det = document.createElement('details');
  det.open = unread > 0;     // floors with unread default-open
  // No overflow:hidden — the inner list manages its own scroll, and
  // hiding overflow here was clipping the last row on tall floors.
  det.style.cssText = 'border:1px solid #262626; border-radius:6px; overflow:visible;';
  const sum = document.createElement('summary');
  sum.style.cssText = `
    display:flex; align-items:center; gap:10px;
    padding:10px 14px; cursor:pointer; user-select:none;
    background:${unread > 0 ? '#1c2230' : '#181818'};
    font:600 14px ui-sans-serif,system-ui,sans-serif; color:#fff;
  `;
  const title = document.createElement('span');
  title.textContent = name;
  title.style.cssText = 'flex:1 1 auto; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
  const total = document.createElement('span');
  total.textContent = `${threads.length} thread${threads.length === 1 ? '' : 's'}`;
  total.style.cssText = 'background:#222; color:#aaa; padding:2px 8px; border-radius:10px; font:11px ui-monospace,Consolas,monospace;';
  sum.appendChild(title);
  sum.appendChild(total);
  if (unread > 0) {
    const u = document.createElement('span');
    u.textContent = `${unread} unread`;
    u.style.cssText = 'background:#3a2050; color:#d8b8ff; padding:2px 8px; border-radius:10px; font:600 11px ui-monospace,Consolas,monospace;';
    sum.appendChild(u);
  }
  det.appendChild(sum);
  const list = document.createElement('div');
  // Per-floor scroll: cap each expanded floor at ~half the viewport so
  // a single fat floor (e.g. Archive with 100 threads) doesn't push
  // everything else off-screen. Vertical scroll inside the floor when
  // the row count exceeds the cap.
  list.style.cssText = 'display:flex; flex-direction:column; gap:6px; padding:8px; max-height:50vh; overflow-y:auto;';
  for (const t of threads) list.appendChild(makeRow(t, onSelect, destinationsFor, onMove, floorsFor, onMoveToFloor, onMakeRule, buildingsForThread));
  det.appendChild(list);
  return det;
}

function emptyState(): HTMLDivElement {
  const d = document.createElement('div');
  d.textContent = 'No emails in this label.';
  d.style.cssText = 'color:#777; font-style:italic; padding:24px; text-align:center;';
  return d;
}

// Heuristic split between "work" and "personal" accounts: anything on
// a known consumer mail provider domain is personal; anything on a
// custom domain (e.g. spectra.studio, mblabs.org) is work. Used to give
// work email rows a subtle red tint so the user can see at a glance
// whether a thread came from their work or personal inbox.
const CONSUMER_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com',
  'yahoo.com', 'yahoo.co.uk', 'ymail.com',
  'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com',
  'aol.com', 'protonmail.com', 'proton.me',
  'fastmail.com',
]);
function isWorkAccount(account?: string): boolean {
  if (!account) return false;
  const domain = account.split('@')[1]?.toLowerCase();
  if (!domain) return false;
  return !CONSUMER_MAIL_DOMAINS.has(domain);
}

// Row background palette per (work?, unread?, hover?) combination so all
// state transitions stay consistent. Work rows pick up a subtle red so
// they're distinguishable from personal-inbox rows at a glance.
function rowColors(work: boolean) {
  if (work) {
    return {
      bgUnread: '#2a1c20', bgRead: '#1f1414',
      hoverUnread: '#3a232a', hoverRead: '#291818',
      borderUnread: '#5a2a30', borderRead: '#3a2222',
    };
  }
  return {
    bgUnread: '#1c2230', bgRead: '#161616',
    hoverUnread: '#243153', hoverRead: '#1e1e1e',
    borderUnread: '#2a3550', borderRead: '#262626',
  };
}

// Compact relative date for the left-side date column. Recent threads
// read as "2h" / "3d"; older ones fall back to a short calendar form.
export function formatCompactDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  const t = d.getTime();
  if (isNaN(t)) return '';
  const now = Date.now();
  const sec = Math.max(0, Math.floor((now - t) / 1000));
  if (sec < 60) return 'now';
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d`;
  if (day < 30) return `${Math.floor(day / 7)}w`;
  if (day < 365) {
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  return `${Math.floor(day / 365)}y`;
}

function dateColumn(t: EmailThread): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'flex:0 0 52px; text-align:right; color:#7a8b9f; font:600 11px ui-monospace,Consolas,monospace; white-space:nowrap;';
  wrap.textContent = formatCompactDate(t.date);
  // Title shows the full date on hover so users can verify the relative form.
  if (t.date) {
    const d = new Date(t.date);
    if (!isNaN(d.getTime())) wrap.title = d.toLocaleString();
  }
  return wrap;
}

function makeRow(
  t: EmailThread,
  onSelect: (t: EmailThread) => void,
  destinationsFor?: (t: EmailThread) => Array<{ labelId: string; label: string; buildingName: string; floors?: string[]; suggestion?: { confidence: number; reason: string; label?: string } }>,
  onMove?: (threadId: string, destLabelId: string, destBuildingName: string, overrideLabel?: string) => Promise<void>,
  floorsFor?: (t: EmailThread) => FloorOption[],
  onMoveToFloor?: (t: EmailThread, opt: FloorOption) => Promise<void>,
  onMakeRule?: (t: EmailThread) => void,
  buildingsForThread?: (t: EmailThread) => string[],
): HTMLDivElement {
  // Evaluate destinations lazily for THIS thread so the per-thread
  // account filter takes effect.
  const destinations = destinationsFor ? destinationsFor(t) : undefined;
  const floors = floorsFor ? floorsFor(t) : undefined;
  const row = document.createElement('div');
  const unread = !t.isRead;
  const work = isWorkAccount(t.account);
  const cols = rowColors(work);
  row.dataset.threadRow = t.threadId;
  row.dataset.readState = unread ? 'unread' : 'read';
  // dataset.account flag is also used by applyReadStateToRow so a row
  // can recompute its (read/unread × work/personal) background after
  // its read state flips mid-display.
  row.dataset.work = work ? '1' : '0';
  row.style.cssText = `
    display:flex; gap:14px; align-items:center;
    padding:10px 14px;
    background:${unread ? cols.bgUnread : cols.bgRead};
    border:1px solid ${unread ? cols.borderUnread : cols.borderRead};
    border-radius:6px;
    cursor:pointer; user-select:none; transition:background 0.1s;
  `;
  // Hover state respects the CURRENT read state (could have flipped to
  // "read" mid-display via applyReadStateToRow) AND the work flag.
  row.addEventListener('mouseenter', () => {
    const isUnread = row.dataset.readState === 'unread';
    const isWork = row.dataset.work === '1';
    const c = rowColors(isWork);
    row.style.background = isUnread ? c.hoverUnread : c.hoverRead;
  });
  row.addEventListener('mouseleave', () => {
    const isUnread = row.dataset.readState === 'unread';
    const isWork = row.dataset.work === '1';
    const c = rowColors(isWork);
    row.style.background = isUnread ? c.bgUnread : c.bgRead;
  });
  row.addEventListener('click', () => onSelect(t));

  row.appendChild(dateColumn(t));
  row.appendChild(avatarStack(t));
  row.appendChild(subjectAndSnippet(t));
  row.appendChild(chipColumn(t, buildingsForThread ? buildingsForThread(t) : undefined));
  if (onMakeRule) {
    row.appendChild(makeRuleButton(t, onMakeRule));
  }
  if (onMoveToFloor && floors && floors.length) {
    row.appendChild(floorMoveButton(t, floors, onMoveToFloor, row));
  }
  if (onMove && destinations && destinations.length) {
    row.appendChild(quickMoveButton(t, destinations, onMove, row));
  }
  return row;
}

// Inline "+ Rule" pill next to Move. Click opens the rule editor
// pre-filled with from:<sender email> and the thread's account. Does
// not mark or move the thread — just opens the editor modal.
function makeRuleButton(t: EmailThread, onMakeRule: (t: EmailThread) => void): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'flex:0 0 auto; display:flex; align-items:center;';
  const btn = document.createElement('button');
  btn.textContent = '+ Rule';
  btn.title = `Create a Gmail filter for ${t.from?.email || 'this sender'}`;
  btn.style.cssText = `
    background:#203030; color:#a8e6c0; border:1px solid #2c5e4a; border-radius:14px;
    padding:4px 12px; cursor:pointer;
    font:600 12px ui-sans-serif,system-ui,sans-serif;
  `;
  btn.addEventListener('mousedown', (e) => e.stopPropagation());
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    onMakeRule(t);
  });
  wrap.appendChild(btn);
  return wrap;
}

// Small "Floor →" button next to "Move →". Opens a searchable picker
// of sub-labels under this building's bound parent(s) that the thread
// could be re-filed under (within the same building). Selecting one
// removes the thread from the current floor and re-renders the list.
function floorMoveButton(
  t: EmailThread,
  floors: FloorOption[],
  onMoveToFloor: (t: EmailThread, opt: FloorOption) => Promise<void>,
  row: HTMLDivElement,
): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'flex:0 0 auto; display:flex; align-items:center;';
  const btn = document.createElement('button');
  btn.textContent = 'Floor →';
  btn.title = 'Re-file this thread under a different sub-label in this building';
  btn.style.cssText = `
    background:#1f2f50; color:#a8c8ff; border:1px solid #2c5688; border-radius:14px;
    padding:4px 12px; cursor:pointer;
    font:600 12px ui-sans-serif,system-ui,sans-serif;
  `;
  btn.addEventListener('mousedown', (e) => e.stopPropagation());
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openFloorMovePopover(btn, t, floors, onMoveToFloor, row);
  });
  wrap.appendChild(btn);
  return wrap;
}

function openFloorMovePopover(
  anchor: HTMLElement,
  t: EmailThread,
  floors: FloorOption[],
  onMoveToFloor: (t: EmailThread, opt: FloorOption) => Promise<void>,
  row: HTMLDivElement,
): void {
  document.querySelectorAll('[data-floor-move]').forEach(el => el.remove());
  const rect = anchor.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.setAttribute('data-floor-move', '1');
  pop.style.cssText = `
    position:fixed; top:${rect.bottom + 6}px;
    left:${Math.max(8, Math.min(rect.right - 320, window.innerWidth - 340))}px;
    z-index:1300; width:320px; max-height:60vh; overflow:hidden;
    background:#181818; color:#eee; border:1px solid #333; border-radius:8px;
    box-shadow:0 16px 40px rgba(0,0,0,0.7); padding:8px;
    display:flex; flex-direction:column; gap:6px;
  `;
  const search = document.createElement('input');
  search.placeholder = 'Search floors…';
  search.style.cssText = 'background:#0b0b0b; color:#eee; border:1px solid #333; border-radius:4px; padding:6px 10px; font:13px ui-sans-serif,system-ui,sans-serif;';
  const hint = document.createElement('div');
  hint.style.cssText = 'color:#666; font-size:11px; padding:2px 4px;';
  const list = document.createElement('div');
  list.style.cssText = 'display:flex; flex-direction:column; gap:2px; overflow:auto;';
  pop.appendChild(search); pop.appendChild(hint); pop.appendChild(list);
  document.body.appendChild(pop);
  clampPopupToViewport(pop, { flipAboveAnchor: rect });

  const render = () => {
    list.innerHTML = '';
    const q = search.value.trim().toLowerCase();
    const filtered = floors.filter(f =>
      !q || f.label.toLowerCase().includes(q) || f.fullName.toLowerCase().includes(q)
    );
    hint.textContent = `${filtered.length} of ${floors.length} floors`;
    for (const f of filtered.slice(0, 300)) {
      const r = document.createElement('div');
      r.style.cssText = 'padding:6px 10px; cursor:pointer; border-radius:4px; display:flex; flex-direction:column; gap:2px;';
      const top = document.createElement('div');
      top.textContent = f.label;
      top.style.cssText = 'font:600 13px ui-sans-serif,system-ui,sans-serif; color:#fff;';
      const sub = document.createElement('div');
      sub.textContent = f.fullName;
      sub.style.cssText = 'color:#7a8b9f; font:11px ui-monospace,Consolas,monospace; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
      r.appendChild(top); r.appendChild(sub);
      r.addEventListener('mouseenter', () => r.style.background = '#22272e');
      r.addEventListener('mouseleave', () => r.style.background = 'transparent');
      r.addEventListener('mousedown', (e) => e.stopPropagation());
      r.addEventListener('click', async (e) => {
        e.stopPropagation();
        pop.remove();
        try {
          row.style.opacity = '0.5'; row.style.pointerEvents = 'none';
          await onMoveToFloor(t, f);
          // Caller is expected to re-render the list (floor grouping
          // shifts); just drop our row optimistically.
          row.remove();
        } catch (err) {
          row.style.opacity = '1'; row.style.pointerEvents = 'auto';
          alert(`Floor move failed: ${err}`);
        }
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

// Small "→" button at the end of each row. Click opens a searchable
// dropdown of destinations; selecting one calls onMove and removes the
// row from the list immediately (the thread leaves this label/INBOX on
// archive). Click bubbles are stopped so the row's main onSelect doesn't
// also fire and open the email content popup.
function quickMoveButton(
  t: EmailThread,
  destinations: Array<{
    labelId: string;
    label: string;
    buildingName: string;
    floors?: string[];
    suggestion?: { confidence: number; reason: string; label?: string };
  }>,
  onMove: (threadId: string, destLabelId: string, destBuildingName: string, overrideLabel?: string) => Promise<void>,
  row: HTMLDivElement,
): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'flex:0 0 auto; display:flex; align-items:center;';
  const btn = document.createElement('button');
  btn.textContent = 'Move →';
  btn.title = 'Send this thread to another building';
  btn.style.cssText = `
    background:#3a2050; color:#d8b8ff; border:1px solid #5a3580; border-radius:14px;
    padding:4px 12px; cursor:pointer;
    font:600 12px ui-sans-serif,system-ui,sans-serif;
  `;
  btn.addEventListener('mousedown', (e) => e.stopPropagation());
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    openQuickMovePopover(btn, t, destinations, onMove, row);
  });
  wrap.appendChild(btn);
  return wrap;
}

function openQuickMovePopover(
  anchor: HTMLElement,
  t: EmailThread,
  destinations: Array<{
    labelId: string;
    label: string;
    buildingName: string;
    floors?: string[];
    suggestion?: { confidence: number; reason: string; label?: string };
  }>,
  onMove: (threadId: string, destLabelId: string, destBuildingName: string, overrideLabel?: string) => Promise<void>,
  row: HTMLDivElement,
): void {
  document.querySelectorAll('[data-quick-move]').forEach(el => el.remove());
  const rect = anchor.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.setAttribute('data-quick-move', '1');
  pop.style.cssText = `
    position:fixed; top:${rect.bottom + 6}px;
    left:${Math.max(8, Math.min(rect.right - 320, window.innerWidth - 340))}px;
    z-index:1300; width:320px; max-height:60vh; overflow:hidden;
    background:#181818; color:#eee; border:1px solid #333; border-radius:8px;
    box-shadow:0 16px 40px rgba(0,0,0,0.7); padding:8px;
    display:flex; flex-direction:column; gap:6px;
  `;
  const search = document.createElement('input');
  search.placeholder = 'Search buildings / labels…';
  search.style.cssText = 'background:#0b0b0b; color:#eee; border:1px solid #333; border-radius:4px; padding:6px 10px; font:13px ui-sans-serif,system-ui,sans-serif;';
  const hint = document.createElement('div');
  hint.style.cssText = 'color:#666; font-size:11px; padding:2px 4px;';
  const list = document.createElement('div');
  list.style.cssText = 'display:flex; flex-direction:column; gap:2px; overflow:auto;';
  pop.appendChild(search); pop.appendChild(hint); pop.appendChild(list);
  document.body.appendChild(pop);
  clampPopupToViewport(pop, { flipAboveAnchor: rect });

  const render = () => {
    list.innerHTML = '';
    const q = search.value.trim().toLowerCase();
    const filtered = destinations.filter(d => destinationMatches(d, q));
    hint.textContent = `${filtered.length} of ${destinations.length} destinations`;
    for (const d of filtered.slice(0, 200)) {
      const r = document.createElement('div');
      r.style.cssText = 'padding:6px 10px; cursor:pointer; border-radius:4px; display:flex; flex-direction:column; gap:2px;';
      const top = document.createElement('div');
      top.textContent = d.buildingName;
      top.style.cssText = 'font:600 13px ui-sans-serif,system-ui,sans-serif; color:#fff;';
      const sub = document.createElement('div');
      const viaFloor = q ? matchedFloor(d, q) : null;
      const sugg = applySuggestionStyle(r, d);
      // When the rule suggestion targets a sub-label, show that path
      // here so the user sees which floor will receive the email.
      const suggFloor = (!viaFloor && sugg && sugg.label && sugg.label !== d.label) ? sugg.label : null;
      sub.textContent = viaFloor ? `via ${viaFloor}` : (suggFloor || d.label);
      sub.style.cssText = `color:${viaFloor || suggFloor ? '#a8e6c0' : '#7a8b9f'}; font:11px ui-monospace,Consolas,monospace; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`;
      r.appendChild(top); r.appendChild(sub);
      if (sugg) {
        const tag = document.createElement('div');
        tag.textContent = `✨ Suggested · ${sugg.reason}`;
        tag.style.cssText = 'color:#6ad26a; font:600 10px ui-monospace,Consolas,monospace;';
        r.appendChild(tag);
      }
      r.addEventListener('mouseenter', () => r.style.background = sugg ? 'rgba(106, 210, 106, 0.15)' : '#22272e');
      r.addEventListener('mouseleave', () => r.style.background = sugg ? 'rgba(106, 210, 106, 0.07)' : 'transparent');
      r.addEventListener('mousedown', (e) => e.stopPropagation());
      r.addEventListener('click', async (e) => {
        e.stopPropagation();
        pop.remove();
        try {
          // Optimistically fade the row to indicate the move is in flight.
          row.style.opacity = '0.5'; row.style.pointerEvents = 'none';
          // Override label priority: floor-search match wins over
          // rule-suggestion's matched label. Either applies the
          // specific sub-label instead of the generic parent.
          await onMove(t.threadId, d.labelId, d.buildingName, viaFloor || sugg?.label || undefined);
          row.remove();
        } catch (err) {
          row.style.opacity = '1'; row.style.pointerEvents = 'auto';
          alert(`Move failed: ${err}`);
        }
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

// ---------- avatar stack ----------
function avatarStack(t: EmailThread): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex; align-items:center; flex:0 0 auto;';
  const emails = uniqueParticipants(t).slice(0, 6);
  emails.forEach((email, i) => {
    const av = avatarDiv(email);
    if (i > 0) av.style.marginLeft = '-12px';   // overlap stack
    av.style.zIndex = String(emails.length - i);
    wrap.appendChild(av);
  });
  return wrap;
}

function avatarDiv(email: string): HTMLDivElement {
  // Layered LimeZu avatar — composites body+eyes+outfit+hair+accessory
  // from a per-sender saved config. If no config exists yet, a random
  // one is generated and persisted on first sight so the same sender
  // always looks the same across reloads.
  const d = avatarPortraitForEmail(email, 40);
  d.title = email;
  d.style.boxShadow = '0 1px 3px rgba(0,0,0,0.5)';
  return d;
}

// ---------- middle column: subject + snippet ----------
function subjectAndSnippet(t: EmailThread): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:3px;';
  const subj = document.createElement('div');
  subj.textContent = t.subject;
  subj.dataset.subject = '1';
  subj.style.cssText = `
    font:${t.isRead ? '400' : '600'} 15px ui-sans-serif,system-ui,sans-serif;
    color:${t.isRead ? '#bbb' : '#fff'};
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  `;
  const meta = document.createElement('div');
  const fromName = t.from?.name || t.from?.email || 'unknown';
  meta.textContent = `${fromName} — ${t.snippet}`;
  meta.style.cssText = `
    font:13px ui-sans-serif,system-ui,sans-serif; color:#888;
    white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
  `;
  wrap.appendChild(subj);
  wrap.appendChild(meta);
  return wrap;
}

// ---------- right column: account, domain chips, message count ----------
// Stable color per account email so the user can tell at a glance which
// inbox a thread came from. Hashes the account string into one of a
// curated palette of muted, dark-theme-friendly hues.
const ACCOUNT_PALETTE = [
  { bg: '#3a2050', fg: '#d8b8ff', border: '#5a3580' },   // violet
  { bg: '#1a3a3e', fg: '#9efff0', border: '#2c5664' },   // teal
  { bg: '#3e2a1a', fg: '#ffd29c', border: '#64432a' },   // amber
  { bg: '#1a3a1a', fg: '#a8d8a8', border: '#2c5c2c' },   // green
  { bg: '#3a1a1a', fg: '#ffacac', border: '#5a2a2a' },   // red
  { bg: '#1a2a3e', fg: '#9cf',    border: '#2c4664' },   // blue
];
function accountPalette(account?: string) {
  if (!account) return ACCOUNT_PALETTE[ACCOUNT_PALETTE.length - 1];
  let h = 0;
  for (let i = 0; i < account.length; i++) h = ((h << 5) - h + account.charCodeAt(i)) | 0;
  return ACCOUNT_PALETTE[Math.abs(h) % ACCOUNT_PALETTE.length];
}

function chipColumn(t: EmailThread, buildings?: string[]): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex; flex-wrap:wrap; gap:6px; align-items:center; flex:0 0 auto; max-width:280px; justify-content:flex-end;';

  // Building chips first — most useful signal in the person profile
  // ("which buildings does this thread live in?"). Amber palette so
  // they stand apart from the blue domain chips and purple account
  // chip. Hidden when caller didn't supply the lookup.
  if (buildings && buildings.length) {
    for (const name of buildings.slice(0, 3)) {
      const chip = document.createElement('span');
      chip.textContent = `🏠 ${name}`;
      chip.title = `Currently filed in building: ${name}`;
      chip.style.cssText = `
        background:#3a2e15; color:#e0c080; border:1px solid #6a5020;
        border-radius:10px; padding:2px 8px; font:600 11px ui-sans-serif,system-ui,sans-serif;
      `;
      wrap.appendChild(chip);
    }
    if (buildings.length > 3) {
      const more = document.createElement('span');
      more.textContent = `+${buildings.length - 3}`;
      more.title = buildings.slice(3).join(', ');
      more.style.cssText = 'background:#222; color:#aaa; border:1px solid #333; padding:2px 8px; border-radius:10px; font:11px ui-monospace,Consolas,monospace;';
      wrap.appendChild(more);
    }
  }

  // Account badge — short-form: the localpart before the @, so
  // harvey@spectra.studio reads as "harvey". Full address in the tooltip.
  if (t.account) {
    const acctChip = document.createElement('span');
    const short = t.account.includes('@') ? t.account.split('@')[0] : t.account;
    acctChip.textContent = short;
    acctChip.title = t.account;
    const pal = accountPalette(t.account);
    acctChip.style.cssText = `
      background:${pal.bg}; color:${pal.fg}; border:1px solid ${pal.border};
      border-radius:10px; padding:2px 8px; font:600 11px ui-monospace,Consolas,monospace;
    `;
    wrap.appendChild(acctChip);
  }

  const domains = new Set<string>();
  for (const m of t.messages) {
    const d = extractDomain(m.from?.email);
    if (d) domains.add(d);
  }
  for (const d of [...domains].slice(0, 3)) {
    const chip = document.createElement('span');
    chip.textContent = d;
    chip.style.cssText = `
      background:#1a2a3e; color:#9cf; border:1px solid #2c4664;
      border-radius:10px; padding:2px 8px; font:600 11px ui-monospace,Consolas,monospace;
    `;
    wrap.appendChild(chip);
  }
  if (t.messageCount > 1) {
    const cnt = document.createElement('span');
    cnt.textContent = `${t.messageCount} msgs`;
    cnt.style.cssText = 'background:#222; color:#aaa; border:1px solid #333; padding:2px 8px; border-radius:10px; font:11px ui-monospace,Consolas,monospace;';
    wrap.appendChild(cnt);
  }
  if (t.hasAttachment) {
    const att = document.createElement('span');
    att.textContent = '📎';
    att.title = 'has attachment';
    wrap.appendChild(att);
  }
  return wrap;
}

// ---------- helpers ----------
function uniqueParticipants(t: EmailThread): string[] {
  const set = new Set<string>();
  for (const m of t.messages) {
    if (m.from?.email) set.add(m.from.email.toLowerCase());
  }
  return [...set];
}

function extractDomain(email?: string): string | null {
  if (!email) return null;
  const at = email.lastIndexOf('@');
  if (at < 0) return null;
  return email.slice(at + 1).toLowerCase().replace(/[>"']/g, '');
}

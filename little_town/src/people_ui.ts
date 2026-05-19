// People grid + individual person modal — both dark-themed, viewport-
// filling, contact-card-shaped. The individual popup is structured to
// match the Google People API (see people.ts) so we can sync to Google
// Contacts later without rebuilding the UI.

import { CHARACTERS } from './characters';
import type { Person, PersonOverride, ContactField } from './people';
import type { EmailThread } from './api';
import { renderEmailListInto, destinationMatches, matchedFloor, applySuggestionStyle } from './email_ui';
import { clampPopupToViewport } from './ui_helpers';
import { avatarPortraitForEmail, loadAvatar, saveAvatar, type AvatarConfig } from './avatar';
import { mountCharacterBuilder } from './character_builder_app.js';
import { renderSenderRulesPanel } from './rules_ui';
import type { AccountSummary, GmailLabel } from './api';

const SPRITE_PNG_PREFIX = 'assets/characters/';
const FRAME_INDEX = 16;   // row 4, col 0 — facing-down idle frame
const COLS = 4;
const FRAME = 32;

// ---------- People grid ----------
let gridEl: HTMLDivElement | null = null;
let gridEsc: ((e: KeyboardEvent) => void) | null = null;

export interface OpenPeopleGridOptions {
  people: Person[];
  onPick: (p: Person) => void;
  onScanAll?: () => Promise<void>;
}

export function openPeopleGrid(opts: OpenPeopleGridOptions): void {
  closePeopleGrid();
  const overlay = darkOverlay();
  const card = document.createElement('div');
  card.style.cssText = `
    width:96vw; height:94vh;
    display:flex; flex-direction:column;
    background:#111; color:#eee; border:1px solid #333; border-radius:10px;
    box-shadow:0 24px 64px rgba(0,0,0,0.85); overflow:hidden;
  `;
  // Title bar
  const bar = document.createElement('div');
  bar.style.cssText = 'background:#1f2937; padding:14px 22px; display:flex; align-items:center; justify-content:space-between; flex:0 0 auto;';
  const title = document.createElement('span');
  title.textContent = `👥 People (${opts.people.length})`;
  title.style.cssText = 'font:600 22px ui-sans-serif,system-ui,sans-serif;';
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex; gap:8px; align-items:center;';
  // (Pre-cache runs automatically on game start now; no manual scan button.)
  const closeBtn = closeX(() => closePeopleGrid());
  actions.appendChild(closeBtn);
  bar.appendChild(title);
  bar.appendChild(actions);
  card.appendChild(bar);

  // ---- Filter / sort controls ----
  const controls = document.createElement('div');
  controls.style.cssText = 'background:#161616; padding:10px 20px; display:flex; gap:12px; align-items:center; border-bottom:1px solid #2a2a2a; flex:0 0 auto; flex-wrap:wrap;';
  const search = document.createElement('input');
  search.type = 'text';
  search.placeholder = 'Search name, email, or @domain…';
  search.spellcheck = false;
  search.style.cssText = 'flex:1 1 220px; min-width:200px; background:#0b0b0b; color:#eee; border:1px solid #333; border-radius:5px; padding:7px 12px; font:13px ui-sans-serif,system-ui,sans-serif;';
  const sortSel = document.createElement('select');
  sortSel.style.cssText = 'background:#0b0b0b; color:#eee; border:1px solid #333; border-radius:5px; padding:7px 10px; font:13px ui-sans-serif,system-ui,sans-serif;';
  for (const [v, label] of [
    ['unread', 'Sort: Most unread'],
    ['name',   'Sort: Name (A-Z)'],
    ['email',  'Sort: Email (A-Z)'],
    ['domain', 'Sort: Email domain'],
    ['threads','Sort: Most threads'],
  ] as const) {
    const o = document.createElement('option'); o.value = v; o.textContent = label; sortSel.appendChild(o);
  }
  const unreadOnly = document.createElement('label');
  unreadOnly.style.cssText = 'display:flex; gap:6px; align-items:center; color:#ccc; font:13px ui-sans-serif,system-ui,sans-serif; cursor:pointer; user-select:none;';
  const unreadOnlyCb = document.createElement('input'); unreadOnlyCb.type = 'checkbox';
  unreadOnly.appendChild(unreadOnlyCb);
  unreadOnly.appendChild(document.createTextNode('Unread only'));
  const groupByDomain = document.createElement('label');
  groupByDomain.style.cssText = unreadOnly.style.cssText;
  const groupByDomainCb = document.createElement('input'); groupByDomainCb.type = 'checkbox';
  groupByDomain.appendChild(groupByDomainCb);
  groupByDomain.appendChild(document.createTextNode('Group by domain'));
  const countLabel = document.createElement('span');
  countLabel.style.cssText = 'color:#888; font:12px ui-monospace,Consolas,monospace; margin-left:auto;';
  controls.appendChild(search);
  controls.appendChild(sortSel);
  controls.appendChild(unreadOnly);
  controls.appendChild(groupByDomain);
  controls.appendChild(countLabel);
  card.appendChild(controls);

  // ---- Body — searchable grid (or grouped sections) ----
  const body = document.createElement('div');
  body.style.cssText = 'padding:20px 22px; overflow:auto; flex:1 1 auto;';
  card.appendChild(body);

  const fuzzyHit = (p: Person, q: string): boolean => {
    if (!q) return true;
    const haystack = `${p.name.toLowerCase()} ${p.email.toLowerCase()}`;
    // Multi-term AND: every space-separated token must match somewhere.
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    return terms.every(t => haystack.includes(t));
  };
  const sortFns: Record<string, (a: Person, b: Person) => number> = {
    unread:  (a, b) => (b.unread - a.unread) || a.name.localeCompare(b.name),
    name:    (a, b) => a.name.localeCompare(b.name),
    email:   (a, b) => a.email.localeCompare(b.email),
    domain:  (a, b) => {
      const da = a.email.split('@')[1] || ''; const db = b.email.split('@')[1] || '';
      return da.localeCompare(db) || a.email.localeCompare(b.email);
    },
    threads: (a, b) => (b.threadIds.size - a.threadIds.size) || a.name.localeCompare(b.name),
  };
  const render = () => {
    body.innerHTML = '';
    if (!opts.people.length) {
      const empty = document.createElement('div');
      empty.textContent = 'No people yet. Open a building\'s emails (or click "Scan all labels") to populate.';
      empty.style.cssText = 'color:#888; font-style:italic; padding:32px; text-align:center;';
      body.appendChild(empty);
      countLabel.textContent = '';
      return;
    }
    const q = search.value.trim();
    let list = opts.people.filter(p => fuzzyHit(p, q));
    if (unreadOnlyCb.checked) list = list.filter(p => p.unread > 0);
    const sortKey = sortSel.value;
    list = [...list].sort(sortFns[sortKey] || sortFns.unread);
    countLabel.textContent = `${list.length} of ${opts.people.length}`;
    if (!list.length) {
      const empty = document.createElement('div');
      empty.textContent = 'No people match those filters.';
      empty.style.cssText = 'color:#888; font-style:italic; padding:32px; text-align:center;';
      body.appendChild(empty);
      return;
    }
    if (groupByDomainCb.checked) {
      const byDomain = new Map<string, Person[]>();
      for (const p of list) {
        const d = p.email.split('@')[1] || '(no domain)';
        if (!byDomain.has(d)) byDomain.set(d, []);
        byDomain.get(d)!.push(p);
      }
      const domains = [...byDomain.entries()].sort((a, b) => b[1].length - a[1].length);
      for (const [domain, people] of domains) {
        const section = document.createElement('div');
        section.style.cssText = 'margin-bottom:18px;';
        const heading = document.createElement('div');
        heading.textContent = `@${domain}  ·  ${people.length}`;
        heading.style.cssText = 'color:#9cf; font:600 13px ui-monospace,Consolas,monospace; padding:6px 4px; border-bottom:1px solid #2a3550; margin-bottom:10px; letter-spacing:0.04em;';
        section.appendChild(heading);
        const grid = document.createElement('div');
        grid.style.cssText = 'display:grid; grid-template-columns:repeat(auto-fill, minmax(260px, 1fr)); gap:14px;';
        for (const p of people) grid.appendChild(personCard(p, opts.onPick));
        section.appendChild(grid);
        body.appendChild(section);
      }
    } else {
      const grid = document.createElement('div');
      grid.style.cssText = 'display:grid; grid-template-columns:repeat(auto-fill, minmax(260px, 1fr)); gap:14px;';
      for (const p of list) grid.appendChild(personCard(p, opts.onPick));
      body.appendChild(grid);
    }
  };
  search.addEventListener('input', render);
  sortSel.addEventListener('change', render);
  unreadOnlyCb.addEventListener('change', render);
  groupByDomainCb.addEventListener('change', render);
  render();
  setTimeout(() => search.focus(), 0);
  overlay.appendChild(card);
  card.addEventListener('mousedown', (e) => e.stopPropagation());
  overlay.addEventListener('mousedown', () => closePeopleGrid());
  document.body.appendChild(overlay);
  gridEl = overlay;
  gridEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') closePeopleGrid(); };
  document.addEventListener('keydown', gridEsc);
}

export function closePeopleGrid(): void {
  if (!gridEl) return;
  gridEl.remove(); gridEl = null;
  if (gridEsc) { document.removeEventListener('keydown', gridEsc); gridEsc = null; }
}

function personCard(p: Person, onPick: (p: Person) => void): HTMLDivElement {
  const card = document.createElement('div');
  card.style.cssText = `
    background:#1a1a1a; border:1px solid #2a2a2a; border-radius:8px;
    padding:16px; cursor:pointer; user-select:none;
    display:flex; gap:16px; align-items:center;
    transition:background 0.1s, border-color 0.1s;
  `;
  card.addEventListener('mouseenter', () => { card.style.background = '#22272e'; card.style.borderColor = '#3a4660'; });
  card.addEventListener('mouseleave', () => { card.style.background = '#1a1a1a'; card.style.borderColor = '#2a2a2a'; });
  card.addEventListener('click', () => onPick(p));

  card.appendChild(avatarPortraitForEmail(p.email, 80));

  const right = document.createElement('div');
  right.style.cssText = 'flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:4px;';
  const name = document.createElement('div');
  name.textContent = p.name;
  name.style.cssText = `font:${p.unread > 0 ? '700' : '500'} 17px ui-sans-serif,system-ui,sans-serif; color:${p.unread > 0 ? '#fff' : '#bbb'}; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;`;
  const email = document.createElement('div');
  email.textContent = p.email;
  email.style.cssText = 'font:12px ui-monospace,Consolas,monospace; color:#666; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
  const stats = document.createElement('div');
  stats.style.cssText = 'display:flex; gap:6px; margin-top:6px; flex-wrap:wrap;';
  const total = document.createElement('span');
  total.textContent = `${p.threadIds.size} thread${p.threadIds.size === 1 ? '' : 's'}`;
  total.style.cssText = 'background:#222; color:#aaa; padding:3px 9px; border-radius:10px; font:600 11px ui-monospace,Consolas,monospace;';
  stats.appendChild(total);
  if (p.unread > 0) {
    const u = document.createElement('span');
    u.textContent = `${p.unread} unread`;
    u.style.cssText = 'background:#3a2050; color:#d8b8ff; padding:3px 9px; border-radius:10px; font:600 11px ui-monospace,Consolas,monospace;';
    stats.appendChild(u);
  }
  right.appendChild(name);
  right.appendChild(email);
  right.appendChild(stats);
  card.appendChild(right);
  return card;
}

// ---------- Individual person popup ----------
let personEl: HTMLDivElement | null = null;
let personEsc: ((e: KeyboardEvent) => void) | null = null;

export interface OpenPersonPopupOptions {
  person: Person;
  allThreads: EmailThread[];
  onSave: (email: string, ov: PersonOverride) => void;
  onOpenEmail: (t: EmailThread) => void;
  // Optional — when provided, the popup renders the same "Rules" panel
  // the NPC popup uses (matching filters + a "+ Create rule" button
  // pre-filled with from:<this person's email>).
  accounts?: AccountSummary[];
  labels?: GmailLabel[] | null;
  // Per-thread building lookup. When provided, each Conversations row
  // shows which building(s) the thread currently lives in.
  buildingsForThread?: (t: EmailThread) => string[];
  // Destination set + "Move all" handler. When BOTH are provided, the
  // Conversations section header gets a "Move all →" button that picks
  // ONE destination and applies it to every thread on this profile.
  destinationsForPerson?: (threads: EmailThread[]) => Array<{ labelId: string; label: string; buildingName: string; floors?: string[]; suggestion?: { confidence: number; reason: string; label?: string } }>;
  onMoveAll?: (threads: EmailThread[], destLabelId: string, destBuildingName: string, overrideLabel?: string) => Promise<void>;
}

export function openPersonPopup(opts: OpenPersonPopupOptions): void {
  closePersonPopup();
  const overlay = darkOverlay();
  const card = document.createElement('div');
  card.style.cssText = `
    width:96vw; height:94vh;
    display:flex; flex-direction:column;
    background:#111; color:#eee; border:1px solid #333; border-radius:10px;
    box-shadow:0 24px 64px rgba(0,0,0,0.85); overflow:hidden;
  `;
  // Working copy of the override. Every input wires `commit()` which
  // strips empties + saves via opts.onSave (writes to localStorage).
  const working: PersonOverride = { ...(opts.person.override || {}) };
  const commit = () => opts.onSave(opts.person.email, working);

  // Title bar — avatar + editable display name + email + close
  const bar = document.createElement('div');
  bar.style.cssText = 'background:#1f2937; padding:14px 22px; display:flex; align-items:center; gap:18px; flex:0 0 auto; border-bottom:1px solid #2a2a2a;';
  let titleAvatar = avatarPortraitForEmail(opts.person.email, 72);
  const titleCol = document.createElement('div');
  titleCol.style.cssText = 'flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:4px;';
  const titleName = document.createElement('input');
  titleName.value = working.name || opts.person.name;
  titleName.spellcheck = false;
  titleName.placeholder = 'Display name';
  titleName.style.cssText = 'background:transparent; color:#fff; border:none; font:600 24px ui-sans-serif,system-ui,sans-serif; padding:2px 0; outline:none; min-width:0;';
  titleName.addEventListener('input', () => { working.name = titleName.value; commit(); });
  const titleEmail = document.createElement('div');
  titleEmail.textContent = opts.person.email;
  titleEmail.style.cssText = 'font:13px ui-monospace,Consolas,monospace; color:#7a8b9f;';
  titleCol.appendChild(titleName);
  titleCol.appendChild(titleEmail);
  bar.appendChild(titleAvatar);
  bar.appendChild(titleCol);
  bar.appendChild(closeX(() => closePersonPopup()));
  card.appendChild(bar);

  // ---- two-column body ----
  // Left: character picker + identity + contact fields
  // Right: notes + conversations
  // Stacks to single column when narrow.
  const body = document.createElement('div');
  body.style.cssText = `
    flex:1 1 auto; overflow:auto; display:grid;
    grid-template-columns:minmax(0, 1.4fr) minmax(0, 1fr);
    gap:24px; padding:24px;
  `;

  const leftCol = document.createElement('div');
  leftCol.style.cssText = 'display:flex; flex-direction:column; gap:22px; min-width:0;';
  const rightCol = document.createElement('div');
  rightCol.style.cssText = 'display:flex; flex-direction:column; gap:22px; min-width:0;';

  // Avatar — large preview + Customize button. Customizing opens the
  // layered builder in a sub-popup; on save we persist the new
  // AvatarConfig and refresh the title + section previews in place.
  leftCol.appendChild(sectionHeading('Avatar'));
  const avatarRow = document.createElement('div');
  avatarRow.style.cssText = 'display:flex; gap:18px; align-items:center;';
  let preview = avatarPortraitForEmail(opts.person.email, 96);
  avatarRow.appendChild(preview);
  const customizeBtn = document.createElement('button');
  customizeBtn.type = 'button';
  customizeBtn.textContent = '🎨 Customize avatar…';
  customizeBtn.style.cssText = 'background:#1f3a5f; color:#fff; border:1px solid #2c5688; border-radius:6px; padding:8px 16px; cursor:pointer; font:600 13px ui-sans-serif,system-ui,sans-serif;';
  customizeBtn.addEventListener('click', () => {
    openAvatarCustomizer(opts.person.email, () => {
      // Re-render both preview and title avatar from the freshly-saved config.
      const newPreview = avatarPortraitForEmail(opts.person.email, 96);
      preview.replaceWith(newPreview);
      preview = newPreview;
      const newTitle = avatarPortraitForEmail(opts.person.email, 72);
      titleAvatar.replaceWith(newTitle);
      titleAvatar = newTitle;
    });
  });
  avatarRow.appendChild(customizeBtn);
  leftCol.appendChild(avatarRow);

  // ---- Name section ----
  leftCol.appendChild(sectionHeading('Name'));
  const nameRow = document.createElement('div');
  nameRow.style.cssText = 'display:grid; grid-template-columns:1fr 1fr; gap:10px;';
  nameRow.appendChild(field('Given name', working.givenName || '', v => { working.givenName = v; commit(); }));
  nameRow.appendChild(field('Family name', working.familyName || '', v => { working.familyName = v; commit(); }));
  leftCol.appendChild(nameRow);

  // ---- Organization ----
  leftCol.appendChild(sectionHeading('Organization'));
  const orgRow = document.createElement('div');
  orgRow.style.cssText = 'display:grid; grid-template-columns:1fr 1fr; gap:10px;';
  orgRow.appendChild(field('Company / organization', working.organization || '', v => { working.organization = v; commit(); }));
  orgRow.appendChild(field('Job title', working.jobTitle || '', v => { working.jobTitle = v; commit(); }));
  leftCol.appendChild(orgRow);

  // ---- Phone numbers ----
  leftCol.appendChild(sectionHeading('Phone numbers'));
  leftCol.appendChild(contactListEditor(working.phoneNumbers || [], ['mobile', 'work', 'home', 'other'], 'mobile', list => { working.phoneNumbers = list; commit(); }, 'tel'));

  // ---- Additional emails ----
  leftCol.appendChild(sectionHeading('Other email addresses'));
  leftCol.appendChild(contactListEditor(working.emails || [], ['personal', 'work', 'other'], 'personal', list => { working.emails = list; commit(); }, 'email'));

  // ---- Addresses ----
  leftCol.appendChild(sectionHeading('Addresses'));
  leftCol.appendChild(contactListEditor(working.addresses || [], ['home', 'work', 'other'], 'home', list => { working.addresses = list; commit(); }, 'text', true));

  // ---- URLs ----
  leftCol.appendChild(sectionHeading('Links'));
  leftCol.appendChild(contactListEditor(working.urls || [], ['website', 'linkedin', 'twitter', 'other'], 'website', list => { working.urls = list; commit(); }, 'url'));

  // ---- Birthday ----
  leftCol.appendChild(sectionHeading('Birthday'));
  leftCol.appendChild(field('Birthday', working.birthday || '', v => { working.birthday = v; commit(); }, 'text', 'YYYY-MM-DD or free text'));

  body.appendChild(leftCol);

  // ---- Right column: Rules + Notes + Conversations ----
  if (opts.accounts && opts.accounts.length) {
    rightCol.appendChild(sectionHeading('Rules'));
    // threadIds drawn from the conversations we know about so the rule
    // editor's account auto-picks the most-common one for this sender.
    const threadIds = opts.allThreads.map(t => t.threadId);
    rightCol.appendChild(renderSenderRulesPanel({
      email: opts.person.email,
      accounts: opts.accounts,
      labels: opts.labels || null,
      threadIds,
    }));
  }
  rightCol.appendChild(sectionHeading('Notes'));
  const notes = document.createElement('textarea');
  notes.value = working.notes || '';
  notes.placeholder = 'Context, reminders, anything you want to remember…';
  notes.style.cssText = `
    width:100%; min-height:140px; resize:vertical;
    background:#0b0b0b; color:#eee; border:1px solid #333; border-radius:6px;
    padding:12px; font:14px/1.55 ui-sans-serif,system-ui,sans-serif;
    box-sizing:border-box;
  `;
  notes.addEventListener('input', () => { working.notes = notes.value; commit(); });
  rightCol.appendChild(notes);

  // Conversations heading + (optional) "Move all →" button. Button is
  // only shown when the caller wired both the destination lookup and
  // the bulk-move handler — without them we don't know what choices to
  // offer or how to apply them.
  const convHeader = document.createElement('div');
  convHeader.style.cssText = 'display:flex; align-items:center; gap:10px; border-bottom:1px solid #222; padding-bottom:6px;';
  const convTitle = document.createElement('div');
  convTitle.textContent = `Conversations (${opts.allThreads.length})`;
  convTitle.style.cssText = 'color:#aaa; font-size:13px; text-transform:uppercase; letter-spacing:0.06em; flex:1 1 auto;';
  convHeader.appendChild(convTitle);
  if (opts.allThreads.length && opts.destinationsForPerson && opts.onMoveAll) {
    const moveAllBtn = document.createElement('button');
    moveAllBtn.type = 'button';
    moveAllBtn.textContent = `Move all ${opts.allThreads.length} →`;
    moveAllBtn.title = `File every conversation from ${opts.person.name || opts.person.email} into one building`;
    moveAllBtn.style.cssText = `
      background:#3a2050; color:#d8b8ff; border:1px solid #5a3580; border-radius:14px;
      padding:4px 12px; cursor:pointer; flex:0 0 auto;
      font:600 12px ui-sans-serif,system-ui,sans-serif;
    `;
    moveAllBtn.addEventListener('mouseenter', () => { moveAllBtn.style.background = '#4a2a64'; });
    moveAllBtn.addEventListener('mouseleave', () => { moveAllBtn.style.background = '#3a2050'; });
    moveAllBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      openPersonMoveAllPicker(moveAllBtn, opts);
    });
    convHeader.appendChild(moveAllBtn);
  }
  rightCol.appendChild(convHeader);
  const threadsBox = document.createElement('div');
  threadsBox.style.cssText = 'display:flex; flex-direction:column; gap:8px;';
  // Render the threads list. Pulled into a closure so the Move-all
  // picker can re-render it after a bulk move — at that point each
  // thread's labels have been patched in place by patchLocalThreadLabels,
  // so the building chips render their new homes.
  const renderConversations = () => {
    threadsBox.innerHTML = '';
    if (!opts.allThreads.length) {
      const empty = document.createElement('div');
      empty.textContent = 'No cached threads involve this person yet.';
      empty.style.cssText = 'color:#888; font-style:italic; padding:8px 0;';
      threadsBox.appendChild(empty);
      return;
    }
    renderEmailListInto(threadsBox, {
      threads: opts.allThreads,
      onSelect: (t) => { closePersonPopup(); opts.onOpenEmail(t); },
      buildingsForThread: opts.buildingsForThread,
    });
  };
  renderConversations();
  rightCol.appendChild(threadsBox);
  // Stash the re-render handle so the Move-all picker can call it.
  (opts as any).__refreshConversations = renderConversations;

  body.appendChild(rightCol);
  card.appendChild(body);
  overlay.appendChild(card);
  card.addEventListener('mousedown', (e) => e.stopPropagation());
  overlay.addEventListener('mousedown', () => closePersonPopup());
  document.body.appendChild(overlay);
  personEl = overlay;
  personEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') closePersonPopup(); };
  document.addEventListener('keydown', personEsc);
}

export function closePersonPopup(): void {
  if (!personEl) return;
  personEl.remove(); personEl = null;
  if (personEsc) { document.removeEventListener('keydown', personEsc); personEsc = null; }
}

// Move-all picker for a person profile. Same UX as the per-row Move-to
// dropdown but the chosen destination is applied to EVERY thread on
// the profile. Useful when a newsletter sender has threads scattered
// across multiple buildings and you want to consolidate them all.
function openPersonMoveAllPicker(anchor: HTMLElement, opts: OpenPersonPopupOptions): void {
  if (!opts.destinationsForPerson || !opts.onMoveAll) return;
  document.querySelectorAll('[data-person-moveall]').forEach(el => el.remove());
  const destinations = opts.destinationsForPerson(opts.allThreads);
  const rect = anchor.getBoundingClientRect();
  const pop = document.createElement('div');
  pop.setAttribute('data-person-moveall', '1');
  pop.style.cssText = `
    position:fixed; top:${rect.bottom + 6}px;
    left:${Math.max(8, Math.min(rect.right - 360, window.innerWidth - 380))}px;
    z-index:1300; width:360px; max-height:60vh; overflow:hidden;
    background:#181818; color:#eee; border:1px solid #333; border-radius:8px;
    box-shadow:0 16px 40px rgba(0,0,0,0.7); padding:8px;
    display:flex; flex-direction:column; gap:6px;
  `;
  const header = document.createElement('div');
  header.textContent = `Move ${opts.allThreads.length} thread${opts.allThreads.length === 1 ? '' : 's'} to…`;
  header.style.cssText = 'color:#d8b8ff; font:600 12px ui-sans-serif,system-ui,sans-serif; padding:4px 6px;';
  const search = document.createElement('input');
  search.placeholder = 'Search buildings / labels…';
  search.style.cssText = 'background:#0b0b0b; color:#eee; border:1px solid #333; border-radius:4px; padding:6px 10px; font:13px ui-sans-serif,system-ui,sans-serif;';
  const list = document.createElement('div');
  list.style.cssText = 'display:flex; flex-direction:column; gap:2px; overflow:auto;';
  pop.appendChild(header); pop.appendChild(search); pop.appendChild(list);
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
      const suggFloor = (!viaFloor && sugg && sugg.label && sugg.label !== d.label) ? sugg.label : null;
      const subText = viaFloor ? `via ${viaFloor}` : (suggFloor || d.label);
      const subColor = viaFloor || suggFloor ? '#a8e6c0' : '#7a8b9f';
      const suggLine = sugg
        ? `<div style="color:#6ad26a; font:600 10px ui-monospace,Consolas,monospace;">✨ Suggested · ${escapeHtmlLocal(sugg.reason)}</div>`
        : '';
      r.innerHTML = `<div style="font:600 13px ui-sans-serif,system-ui,sans-serif; color:#fff;">${escapeHtmlLocal(d.buildingName)}</div>
                     <div style="color:${subColor}; font:11px ui-monospace,Consolas,monospace;">${escapeHtmlLocal(subText)}</div>${suggLine}`;
      r.addEventListener('mouseenter', () => r.style.background = sugg ? 'rgba(106, 210, 106, 0.15)' : '#22272e');
      r.addEventListener('mouseleave', () => r.style.background = sugg ? 'rgba(106, 210, 106, 0.07)' : 'transparent');
      r.addEventListener('click', async () => {
        pop.remove();
        try {
          await opts.onMoveAll!(opts.allThreads, d.labelId, d.buildingName, viaFloor || sugg?.label || undefined);
          // After the bulk move, the in-memory thread objects have
          // been patched with their new labels — re-render the list
          // so the building chips reflect the destination.
          const refresh = (opts as any).__refreshConversations as (() => void) | undefined;
          if (refresh) refresh();
        }
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

function escapeHtmlLocal(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

// ---------- shared helpers ----------
function darkOverlay(): HTMLDivElement {
  const o = document.createElement('div');
  o.style.cssText = `
    position:fixed; inset:0; z-index:1100;
    background:rgba(0,0,0,0.82);
    display:flex; align-items:center; justify-content:center;
    font:15px ui-sans-serif,system-ui,sans-serif;
  `;
  return o;
}

function sectionHeading(text: string): HTMLDivElement {
  const d = document.createElement('div');
  d.textContent = text;
  d.style.cssText = 'color:#aaa; font-size:13px; text-transform:uppercase; letter-spacing:0.06em; border-bottom:1px solid #222; padding-bottom:6px;';
  return d;
}

function chipBtn(bg: string, fg: string, border: string): string {
  return `background:${bg}; color:${fg}; border:1px solid ${border}; border-radius:6px; padding:6px 12px; cursor:pointer; font:600 13px ui-sans-serif,system-ui,sans-serif;`;
}

function closeX(onClick: () => void): HTMLSpanElement {
  const s = document.createElement('span');
  s.textContent = '×';
  s.style.cssText = 'cursor:pointer; font-size:30px; line-height:1; padding:0 8px;';
  s.addEventListener('click', onClick);
  return s;
}

// A simple labeled input row. Used for single-value contact fields.
function field(label: string, value: string, onChange: (v: string) => void, type: string = 'text', placeholder?: string): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex; flex-direction:column; gap:4px; min-width:0;';
  const lab = document.createElement('label');
  lab.textContent = label;
  lab.style.cssText = 'color:#888; font-size:12px;';
  const inp = document.createElement('input');
  inp.type = type;
  inp.value = value;
  inp.spellcheck = false;
  if (placeholder) inp.placeholder = placeholder;
  inp.style.cssText = 'background:#0b0b0b; color:#eee; border:1px solid #333; border-radius:6px; padding:8px 10px; font:14px ui-sans-serif,system-ui,sans-serif; outline:none;';
  inp.addEventListener('input', () => onChange(inp.value));
  wrap.appendChild(lab);
  wrap.appendChild(inp);
  return wrap;
}

// A multi-row editor for ContactField lists (phones, emails, urls,
// addresses). Each row is [type-dropdown] [value-input] [delete]. Empty
// rows are pruned on commit.
function contactListEditor(
  initial: ContactField[],
  types: string[],
  defaultType: string,
  onChange: (list: ContactField[]) => void,
  inputType: string = 'text',
  multiline: boolean = false,
): HTMLDivElement {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex; flex-direction:column; gap:8px;';
  const list: ContactField[] = initial.length ? [...initial] : [];
  const container = document.createElement('div');
  container.style.cssText = 'display:flex; flex-direction:column; gap:8px;';
  wrap.appendChild(container);

  const commit = () => {
    const cleaned = list.filter(f => f.value.trim());
    onChange(cleaned);
  };

  const render = () => {
    container.innerHTML = '';
    if (list.length === 0) {
      const empty = document.createElement('div');
      empty.textContent = '(none — click + below to add)';
      empty.style.cssText = 'color:#666; font-style:italic; font-size:13px; padding:4px 0;';
      container.appendChild(empty);
    }
    for (let i = 0; i < list.length; i++) {
      container.appendChild(rowFor(i));
    }
  };

  const rowFor = (idx: number): HTMLDivElement => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; gap:8px; align-items:flex-start;';
    const sel = document.createElement('select');
    sel.style.cssText = 'flex:0 0 110px; background:#0b0b0b; color:#eee; border:1px solid #333; border-radius:6px; padding:8px 10px; font:13px ui-sans-serif,system-ui,sans-serif;';
    for (const t of types) {
      const opt = document.createElement('option');
      opt.value = t; opt.textContent = t;
      if ((list[idx].type || defaultType) === t) opt.selected = true;
      sel.appendChild(opt);
    }
    sel.addEventListener('change', () => { list[idx].type = sel.value; commit(); });

    let inp: HTMLInputElement | HTMLTextAreaElement;
    if (multiline) {
      inp = document.createElement('textarea');
      (inp as HTMLTextAreaElement).rows = 2;
      inp.style.cssText = 'flex:1 1 auto; min-width:0; background:#0b0b0b; color:#eee; border:1px solid #333; border-radius:6px; padding:8px 10px; font:14px ui-sans-serif,system-ui,sans-serif; resize:vertical;';
    } else {
      inp = document.createElement('input');
      (inp as HTMLInputElement).type = inputType;
      inp.style.cssText = 'flex:1 1 auto; min-width:0; background:#0b0b0b; color:#eee; border:1px solid #333; border-radius:6px; padding:8px 10px; font:14px ui-sans-serif,system-ui,sans-serif;';
    }
    inp.value = list[idx].value;
    inp.spellcheck = false;
    inp.addEventListener('input', () => { list[idx].value = inp.value; commit(); });

    const del = document.createElement('button');
    del.textContent = '×';
    del.title = 'Remove';
    del.style.cssText = 'flex:0 0 auto; background:#3b1f1f; color:#ddd; border:1px solid #5a2a2a; border-radius:6px; padding:6px 12px; cursor:pointer; font-size:16px;';
    del.addEventListener('click', () => { list.splice(idx, 1); commit(); render(); });

    row.appendChild(sel);
    row.appendChild(inp);
    row.appendChild(del);
    return row;
  };

  const addBtn = document.createElement('button');
  addBtn.textContent = '+ Add';
  addBtn.style.cssText = 'align-self:flex-start; background:#1f3a1f; color:#dfe9df; border:1px solid #2c562c; border-radius:6px; padding:6px 14px; cursor:pointer; font-size:13px;';
  addBtn.addEventListener('click', () => {
    list.push({ value: '', type: defaultType });
    render();
  });
  wrap.appendChild(addBtn);

  render();
  return wrap;
}

// Single LimeZu sprite frame as a DOM div. Reused across grid + picker
// and also exported so the NPC click-action popup can show a matching
// large avatar. Zooms ZOOM× the natural frame so the head fills the
// circle instead of being a tiny dot at the top.
//
// HEAD_X/HEAD_Y are the focal point inside the 32×32 frame — they pick
// where the rendered avatar centers. The in-world NPC body collision is
// (11,18) sized (10,10), which means the body's top sits around y=18 —
// so the head center is roughly (16, 10).
const HEAD_X = 16;
const HEAD_Y = 10;
const ZOOM = 2.2;
export function spriteAvatar(charKey: string, size: number): HTMLDivElement {
  const char = CHARACTERS.find(c => c.key === charKey) || CHARACTERS[0];
  const scale = (size / FRAME) * ZOOM;
  const sheetCol = FRAME_INDEX % COLS;
  const sheetRow = Math.floor(FRAME_INDEX / COLS);
  const focalX = (sheetCol * FRAME + HEAD_X) * scale;
  const focalY = (sheetRow * FRAME + HEAD_Y) * scale;
  const bgX = (size / 2) - focalX;
  const bgY = (size / 2) - focalY;
  const d = document.createElement('div');
  d.style.cssText = `
    width:${size}px; height:${size}px; flex:0 0 ${size}px;
    background-image:url('${SPRITE_PNG_PREFIX}${char.file.replace(/'/g, "%27")}');
    background-position:${bgX}px ${bgY}px;
    background-size:${128 * scale}px ${256 * scale}px;
    background-repeat:no-repeat;
    image-rendering:pixelated;
    border:2px solid #2a2a2a; border-radius:50%;
    background-color:#0b0b0b;
    overflow:hidden;
  `;
  return d;
}

function humanizeCharKey(k: string): string {
  return k.replace(/^char_/, '').replace(/_/g, ' ');
}

// ---------- Avatar customizer (sub-popup) ----------
// Opens the layered character builder pre-filled with the email's
// saved AvatarConfig (if any). Every change is persisted immediately
// via saveAvatar, so the OK / × close button is just a dismissal.
// `onClose` fires after the modal is torn down so callers can refresh
// any portraits they're showing.
export function openAvatarCustomizer(email: string, onClose?: () => void): void {
  const overlay = darkOverlay();
  const card = document.createElement('div');
  card.style.cssText = `
    width:min(1000px, 96vw); height:min(820px, 92vh);
    background:#111; color:#eee; border:1px solid #333; border-radius:10px;
    box-shadow:0 24px 64px rgba(0,0,0,0.85); overflow:hidden;
    display:flex; flex-direction:column;
  `;
  card.addEventListener('mousedown', (e) => e.stopPropagation());
  const bar = document.createElement('div');
  bar.style.cssText = 'background:#1f2937; padding:10px 16px; flex:0 0 auto; display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid #2a2a2a;';
  const title = document.createElement('div');
  title.innerHTML = `🎨 Avatar for <span style="color:#9cf; font-family:ui-monospace,Consolas,monospace;">${email.replace(/</g, '&lt;')}</span>`;
  title.style.cssText = 'font:600 14px ui-sans-serif,system-ui,sans-serif;';
  const close = closeX(() => {
    handle.destroy();
    overlay.remove();
    document.removeEventListener('keydown', esc);
    if (onClose) onClose();
  });
  bar.appendChild(title);
  bar.appendChild(close);
  card.appendChild(bar);

  const builderArea = document.createElement('div');
  builderArea.style.cssText = 'flex:1 1 auto; min-height:0;';
  card.appendChild(builderArea);

  overlay.appendChild(card);
  document.body.appendChild(overlay);
  overlay.addEventListener('mousedown', () => {
    handle.destroy();
    overlay.remove();
    document.removeEventListener('keydown', esc);
    if (onClose) onClose();
  });
  const esc = (e: KeyboardEvent) => {
    if (e.key === 'Escape') { handle.destroy(); overlay.remove(); document.removeEventListener('keydown', esc); if (onClose) onClose(); }
  };
  document.addEventListener('keydown', esc);

  // Pre-fill the builder with the email's saved config (file paths;
  // the builder accepts either id or file path). Each onChange persists
  // immediately — no separate save button.
  const existing = loadAvatar(email);
  const initial = existing ? {
    layers: {
      body: existing.body,
      eyes: existing.eyes || null,
      outfit: existing.outfit || null,
      hairstyle: existing.hairstyle || null,
      accessory: existing.accessory || null,
    },
  } : undefined;
  const handle = mountCharacterBuilder(builderArea, {
    initial,
    onChange: (cfg: any) => {
      if (!cfg.layers?.body?.file) return;       // body is required
      const next: AvatarConfig = { body: cfg.layers.body.file };
      for (const k of ['eyes', 'outfit', 'hairstyle', 'accessory'] as const) {
        if (cfg.layers[k]?.file) (next as any)[k] = cfg.layers[k].file;
      }
      saveAvatar(email, next);
    },
  });
}

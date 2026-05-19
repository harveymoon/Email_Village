// Full-thread email modal. Opened from email-list row clicks (Phase 3)
// and — later — from clicking an NPC in the world (Phase 7).
//
// Dark theme throughout. Layout: title bar with subject + "Move to…"
// button, scrollable thread body (one card per message), reply textarea
// + send button at the bottom. HTML bodies are sanitised via DOMPurify
// with remote images blocked by default to neutralise tracking pixels.
//
// Movement to a destination label is delegated to a `moveThread`
// callback the scene provides — that callback hits the backend modify
// endpoint and animates NPCs walking over.

import DOMPurify from 'dompurify';
import { api, type EmailThread, type EmailMessage } from './api';
import { clampPopupToViewport } from './ui_helpers';
import { destinationMatches, matchedFloor, applySuggestionStyle } from './email_ui';
import { avatarPortraitForEmail } from './avatar';

export interface OpenEmailPopupOptions {
  // Either a threadId (we fetch from /api/threads/:id) or a pre-fetched
  // thread (skips the round trip — used when the row already had it).
  threadId?: string;
  thread?: EmailThread;
  // Destination picker. Each entry becomes a button in the Move menu.
  // floors + suggestion are optional and only consumed by the floor
  // search / rule-suggestion decoration logic.
  destinations: Array<{
    labelId: string;
    label: string;
    buildingName: string;
    floors?: string[];
    suggestion?: { confidence: number; reason: string; label?: string };
  }>;
  // Called when user picks a destination. Implementer is the scene —
  // it should call the backend modify endpoint and animate NPCs.
  onMove: (threadId: string, destLabelId: string, destBuilding: string, overrideLabel?: string) => Promise<void>;
  // Click the avatar next to a message header → open that sender's
  // full profile popup (the same one the People grid opens). When
  // supplied, the email popup closes itself before the callback runs.
  onOpenProfile?: (email: string) => void;
}

let currentPopupEl: HTMLDivElement | null = null;
let currentEsc: ((e: KeyboardEvent) => void) | null = null;

export function openEmailContentPopup(opts: OpenEmailPopupOptions): void {
  closeEmailContentPopup();
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position:fixed; inset:0; z-index:1100;
    background:rgba(0,0,0,0.85);
    display:flex; align-items:center; justify-content:center;
    font:15px ui-sans-serif,system-ui,sans-serif;
  `;
  const card = document.createElement('div');
  card.style.cssText = `
    width:min(92vw, 980px); height:min(92vh, 820px);
    display:flex; flex-direction:column;
    background:#111; color:#eee; border:1px solid #333; border-radius:10px;
    box-shadow:0 24px 64px rgba(0,0,0,0.9);
    overflow:hidden;
  `;
  // Loading placeholder until thread arrives.
  card.appendChild(spinnerCard());
  overlay.appendChild(card);
  card.addEventListener('mousedown', (e) => e.stopPropagation());
  overlay.addEventListener('mousedown', () => closeEmailContentPopup());
  document.body.appendChild(overlay);
  currentPopupEl = overlay;
  currentEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') closeEmailContentPopup(); };
  document.addEventListener('keydown', currentEsc);

  const populate = (thread: EmailThread) => {
    card.innerHTML = '';
    card.appendChild(buildTitleBar(thread, opts));
    card.appendChild(buildThreadBody(thread, opts.onOpenProfile));
    card.appendChild(buildReplyFooter(thread));
  };

  if (opts.thread) {
    populate(opts.thread);
  } else if (opts.threadId) {
    api.thread(opts.threadId).then(populate).catch((err) => {
      card.innerHTML = '';
      const e = document.createElement('div');
      e.textContent = `Failed to load thread: ${err}`;
      e.style.cssText = 'padding:32px; color:#c66;';
      card.appendChild(e);
    });
  }
}

export function closeEmailContentPopup(): void {
  if (!currentPopupEl) return;
  currentPopupEl.remove();
  currentPopupEl = null;
  if (currentEsc) {
    document.removeEventListener('keydown', currentEsc);
    currentEsc = null;
  }
}

// ---------- pieces ----------
function spinnerCard(): HTMLDivElement {
  const d = document.createElement('div');
  d.textContent = 'Loading thread…';
  d.style.cssText = 'padding:60px; text-align:center; color:#888;';
  return d;
}

function buildTitleBar(t: EmailThread, opts: OpenEmailPopupOptions): HTMLDivElement {
  const bar = document.createElement('div');
  bar.style.cssText = `
    background:#1f2937; padding:14px 20px; border-bottom:1px solid #2a2a2a;
    display:flex; align-items:flex-start; gap:14px; flex:0 0 auto;
  `;
  const titleCol = document.createElement('div');
  titleCol.style.cssText = 'flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:6px;';
  const subject = document.createElement('div');
  subject.textContent = t.subject;
  subject.style.cssText = 'font:600 20px ui-sans-serif,system-ui,sans-serif; color:#fff; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
  const participants = document.createElement('div');
  participants.style.cssText = 'display:flex; gap:6px; flex-wrap:wrap;';
  for (const email of uniqueParticipants(t).slice(0, 8)) {
    const chip = document.createElement('span');
    chip.textContent = email;
    chip.style.cssText = 'background:#0b0b0b; color:#9cf; border:1px solid #333; border-radius:10px; padding:2px 8px; font:11px ui-monospace,Consolas,monospace;';
    participants.appendChild(chip);
  }
  titleCol.appendChild(subject);
  titleCol.appendChild(participants);

  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex; gap:8px; align-items:center;';
  const moveBtn = document.createElement('button');
  moveBtn.textContent = 'Move to…';
  moveBtn.style.cssText = `
    background:#3a2050; color:#d8b8ff; border:1px solid #5a3580;
    border-radius:6px; padding:8px 14px; cursor:pointer;
    font:600 14px ui-sans-serif,system-ui,sans-serif;
  `;
  moveBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    openMoveMenu(moveBtn, t, opts);
  });
  const closeBtn = document.createElement('span');
  closeBtn.textContent = '×';
  closeBtn.style.cssText = 'cursor:pointer; font-size:30px; line-height:1; padding:0 8px; color:#ddd;';
  closeBtn.addEventListener('click', () => closeEmailContentPopup());
  actions.appendChild(moveBtn);
  actions.appendChild(closeBtn);

  bar.appendChild(titleCol);
  bar.appendChild(actions);
  return bar;
}

function buildThreadBody(t: EmailThread, onOpenProfile?: (email: string) => void): HTMLDivElement {
  const body = document.createElement('div');
  body.style.cssText = 'padding:20px 24px; overflow:auto; flex:1 1 auto; display:flex; flex-direction:column; gap:14px;';
  for (const m of t.messages) body.appendChild(messageCard(m, onOpenProfile));
  return body;
}

function messageCard(m: EmailMessage, onOpenProfile?: (email: string) => void): HTMLDivElement {
  const card = document.createElement('div');
  card.style.cssText = `
    background:#181818; border:1px solid #262626; border-radius:8px;
    padding:14px 18px; display:flex; gap:12px;
  `;
  // Avatar — click to jump to this sender's profile popup.
  const senderEmail = m.from?.email || '';
  const avatar = avatarPortraitForEmail(senderEmail || 'unknown@unknown', 56);
  avatar.style.flex = '0 0 auto';
  if (senderEmail && onOpenProfile) {
    avatar.style.cursor = 'pointer';
    avatar.title = `Open profile for ${m.from?.name || senderEmail}`;
    avatar.addEventListener('mouseenter', () => { avatar.style.outline = '2px solid #9cf'; });
    avatar.addEventListener('mouseleave', () => { avatar.style.outline = ''; });
    avatar.addEventListener('click', (e) => {
      e.stopPropagation();
      closeEmailContentPopup();
      onOpenProfile(senderEmail);
    });
  }
  // Content column (header + body) takes the remaining width.
  const main = document.createElement('div');
  main.style.cssText = 'flex:1 1 auto; min-width:0; display:flex; flex-direction:column; gap:10px;';
  // Header — from / date
  const hdr = document.createElement('div');
  hdr.style.cssText = 'display:flex; justify-content:space-between; gap:14px; align-items:baseline; color:#bbb; font-size:13px;';
  const from = document.createElement('div');
  from.innerHTML = `<span style="font-weight:600;color:#fff;">${escapeHtml(m.from?.name || m.from?.email || 'unknown')}</span>
                    <span style="color:#777;"> &lt;${escapeHtml(m.from?.email || '')}&gt;</span>`;
  from.style.cssText = 'overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; flex:1 1 auto;';
  const date = document.createElement('div');
  date.textContent = m.date;
  date.style.cssText = 'color:#777; font:12px ui-monospace,Consolas,monospace; flex:0 0 auto;';
  hdr.appendChild(from);
  hdr.appendChild(date);

  // Body — sanitised HTML if present, else plain text. Remote images
  // blocked: we strip <img> entirely (the most common tracking-pixel
  // attack surface). Links are kept but forced to open in new tab.
  const bodyEl = document.createElement('div');
  bodyEl.style.cssText = 'color:#ddd; font:14px/1.55 ui-sans-serif,system-ui,sans-serif; white-space:normal; word-break:break-word; overflow-wrap:break-word;';
  if (m.bodyHtml) {
    const clean = DOMPurify.sanitize(m.bodyHtml, {
      FORBID_TAGS: ['img', 'script', 'style', 'iframe', 'object', 'embed'],
      FORBID_ATTR: ['style', 'onerror', 'onload', 'onclick'],
    });
    bodyEl.innerHTML = clean;
    // Open all links in new tab, no referrer.
    bodyEl.querySelectorAll('a[href]').forEach(a => {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      (a as HTMLAnchorElement).style.color = '#9cf';
    });
  } else {
    bodyEl.textContent = m.body || m.snippet || '(empty message)';
    bodyEl.style.whiteSpace = 'pre-wrap';
  }

  main.appendChild(hdr);
  main.appendChild(bodyEl);
  card.appendChild(avatar);
  card.appendChild(main);
  return card;
}

function buildReplyFooter(t: EmailThread): HTMLDivElement {
  const footer = document.createElement('div');
  footer.style.cssText = `
    border-top:1px solid #2a2a2a; padding:14px 20px; flex:0 0 auto;
    display:flex; flex-direction:column; gap:8px; background:#0e0e0e;
  `;
  const replyHeader = document.createElement('div');
  const replyTo = t.messages[t.messages.length - 1]?.from?.email || '';
  replyHeader.innerHTML = `Replying to <span style="color:#9cf;font-family:ui-monospace,Consolas,monospace;">${escapeHtml(replyTo)}</span>`;
  replyHeader.style.cssText = 'color:#888; font-size:13px;';
  const textarea = document.createElement('textarea');
  textarea.placeholder = 'Type your reply…';
  textarea.style.cssText = `
    width:100%; min-height:80px; resize:vertical;
    background:#0b0b0b; color:#eee; border:1px solid #333; border-radius:6px;
    padding:10px 12px; font:14px/1.5 ui-sans-serif,system-ui,sans-serif;
  `;
  const actionRow = document.createElement('div');
  actionRow.style.cssText = 'display:flex; justify-content:space-between; align-items:center; gap:10px;';
  const status = document.createElement('div');
  status.style.cssText = 'color:#777; font-size:12px;';
  const sendBtn = document.createElement('button');
  sendBtn.textContent = 'Send Reply';
  sendBtn.style.cssText = `
    background:#1f3a5f; color:#fff; border:1px solid #2c5688;
    border-radius:6px; padding:8px 18px; cursor:pointer;
    font:600 14px ui-sans-serif,system-ui,sans-serif;
  `;
  sendBtn.addEventListener('click', async () => {
    const body = textarea.value.trim();
    if (!body) { status.textContent = 'Empty — type something first.'; status.style.color = '#c66'; return; }
    sendBtn.disabled = true;
    status.textContent = 'Sending…'; status.style.color = '#888';
    try {
      await api.reply(t.threadId, body);
      status.textContent = '✓ Sent.'; status.style.color = '#8c8';
      textarea.value = '';
    } catch (err) {
      status.textContent = `Failed: ${err}`; status.style.color = '#c66';
    } finally {
      sendBtn.disabled = false;
    }
  });
  actionRow.appendChild(status);
  actionRow.appendChild(sendBtn);

  footer.appendChild(replyHeader);
  footer.appendChild(textarea);
  footer.appendChild(actionRow);
  return footer;
}

// ---------- Move-to menu ----------
function openMoveMenu(anchor: HTMLElement, t: EmailThread, opts: OpenEmailPopupOptions): void {
  // If a menu is already open, treat this as a toggle/dismiss.
  const existing = document.querySelector('[data-move-menu]');
  if (existing) { existing.remove(); return; }
  const rect = anchor.getBoundingClientRect();
  const menu = document.createElement('div');
  menu.setAttribute('data-move-menu', '1');
  menu.style.cssText = `
    position:fixed; top:${rect.bottom + 6}px; left:${Math.max(8, rect.right - 280)}px;
    z-index:1200; min-width:260px; max-height:60vh; overflow:auto;
    background:#181818; color:#eee; border:1px solid #333; border-radius:8px;
    box-shadow:0 16px 40px rgba(0,0,0,0.7);
    padding:6px;
  `;
  if (!opts.destinations.length) {
    const empty = document.createElement('div');
    empty.textContent = 'No buildings have labels assigned.';
    empty.style.cssText = 'padding:14px; color:#888; font-style:italic;';
    menu.appendChild(empty);
  } else {
    // Search input — substring match across building name + label so a
    // user with 50+ destinations can type to narrow.
    const search = document.createElement('input');
    search.placeholder = 'Search…';
    search.spellcheck = false;
    search.style.cssText = 'background:#0b0b0b; color:#eee; border:1px solid #333; border-radius:4px; padding:6px 10px; font:13px ui-sans-serif,system-ui,sans-serif; margin-bottom:4px;';
    const list = document.createElement('div');
    list.style.cssText = 'display:flex; flex-direction:column; gap:2px; overflow:auto; max-height:50vh;';
    const render = () => {
      list.innerHTML = '';
      const q = search.value.trim().toLowerCase();
      const filtered = opts.destinations.filter(d => destinationMatches(d, q));
      for (const d of filtered) {
        const item = document.createElement('div');
        item.style.cssText = 'padding:10px 14px; cursor:pointer; border-radius:4px; display:flex; justify-content:space-between; align-items:center; gap:12px;';
        const left = document.createElement('div');
        const viaFloor = q ? matchedFloor(d, q) : null;
        const sugg = applySuggestionStyle(item, d);
        // Show the rule's specific floor in the sub-line when it
        // differs from the building's bound label (rule says
        // Hobbies/Patreon → row shows Hobbies/Patreon, not Hobbies).
        const suggFloor = (!viaFloor && sugg && sugg.label && sugg.label !== d.label) ? sugg.label : null;
        const subText = viaFloor ? `via ${viaFloor}` : (suggFloor || d.label);
        const subColor = viaFloor || suggFloor ? '#a8e6c0' : '#7a8b9f';
        const suggLine = sugg
          ? `<div style="color:#6ad26a; font:600 10px ui-monospace,Consolas,monospace;">✨ Suggested · ${escapeHtml(sugg.reason)}</div>`
          : '';
        left.innerHTML = `<div style="font-weight:600;color:#fff;">${escapeHtml(d.buildingName)}</div>
                          <div style="color:${subColor}; font:11px ui-monospace,Consolas,monospace;">${escapeHtml(subText)}</div>
                          ${suggLine}`;
        item.appendChild(left);
        item.addEventListener('mouseenter', () => item.style.background = '#22272e');
        item.addEventListener('mouseleave', () => item.style.background = 'transparent');
        item.addEventListener('click', async () => {
          menu.remove();
          try {
            // Override label priority: explicit floor-search match wins
            // over the rule-suggestion's matched label. Either flows
            // through onMove so the right sub-label is applied.
            await opts.onMove(t.threadId, d.labelId, d.buildingName, viaFloor || sugg?.label || undefined);
            closeEmailContentPopup();
          } catch (err) {
            alert(`Move failed: ${err}`);
          }
        });
        list.appendChild(item);
      }
      if (!filtered.length) {
        const none = document.createElement('div');
        none.textContent = 'No destinations match.';
        none.style.cssText = 'padding:10px 14px; color:#888; font-style:italic;';
        list.appendChild(none);
      }
    };
    search.addEventListener('input', render);
    menu.appendChild(search);
    menu.appendChild(list);
    render();
    setTimeout(() => search.focus(), 0);
  }
  document.body.appendChild(menu);
  clampPopupToViewport(menu, { flipAboveAnchor: rect });
  // Dismiss on outside-click. Capture phase: the email card's own
  // mousedown listener stopPropagations bubbling to keep the modal from
  // closing, which would otherwise prevent this handler from firing
  // when the user clicks anywhere inside the modal body. Capture runs
  // before bubble, so we see all clicks regardless.
  setTimeout(() => {
    const away = (e: MouseEvent) => {
      if (menu.contains(e.target as Node)) return;
      if (e.target === anchor) return;        // anchor click is handled by openMoveMenu's toggle path
      menu.remove();
      document.removeEventListener('mousedown', away, true);
    };
    document.addEventListener('mousedown', away, true);
  }, 0);
}

// ---------- helpers ----------
function uniqueParticipants(t: EmailThread): string[] {
  const set = new Set<string>();
  for (const m of t.messages) if (m.from?.email) set.add(m.from.email.toLowerCase());
  return [...set];
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

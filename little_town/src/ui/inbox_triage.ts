// Town Inbox — Inbox Triage view.
//
// Press T to open. Modal lists every sender who currently has unread
// mail in INBOX, ranked by unread count, with per-row inline actions:
//   - Move all → [building] (uses the per-sender suggestion engine)
//   - Mark all read
//   - Open profile
//
// Header bar shows a session progress counter so the user can see the
// inbox draining as they work: "started 2317 unread · now 412 ·
// cleaned 1905 this session". Reloads after every action so the list
// re-ranks immediately.
//
// Data path: /api/inbox-senders runs a single GROUP BY against the
// local SQLite store — sub-100ms even on 10k threads — so the modal
// opens instantly with the full inbox (not just what the renderer
// cache has seen).
//
// Side-effects are delegated to scene callbacks so this module stays
// pure UI; main.ts wires moveAllForSender, markAllReadForSender, etc.

import { api } from '../api';
import { avatarPortraitForEmail } from '../avatar';
import { openDestinationPicker, type Destination } from './destination_picker';

export interface TriageDeps {
  /** Build the per-row destination list (account-filtered + suggestion-annotated). */
  destinationsForSender: (email: string, account: string) => Destination[];
  /** Move all this sender's INBOX threads. Resolves the moved count. */
  moveAllForSender: (email: string, account: string, destLabelId: string, destBuildingName: string, overrideLabel?: string) => Promise<number>;
  /** Mark all this sender's INBOX threads read. Resolves the count read. */
  markAllReadForSender: (email: string, account: string) => Promise<number>;
  /** Open the sender's profile popup. */
  openProfile: (email: string) => void;
}

let modalEl: HTMLDivElement | null = null;
let modalEsc: ((e: KeyboardEvent) => void) | null = null;
let sessionStartUnread: number | null = null;
let labelsHydrated = false;     // gates "no destinations yet" rendering

export function openInboxTriage(deps: TriageDeps): void {
  closeInboxTriage();
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position:fixed; inset:0; z-index:1100;
    background:rgba(0,0,0,0.85);
    display:flex; align-items:center; justify-content:center;
    font:15px ui-sans-serif,system-ui,sans-serif;
  `;
  const card = document.createElement('div');
  card.style.cssText = `
    width:96vw; max-width:1100px; height:92vh;
    display:grid; grid-template-rows:auto auto 1fr;
    background:#111; color:#eee; border:1px solid #333; border-radius:10px;
    box-shadow:0 24px 64px rgba(0,0,0,0.85); overflow:hidden;
  `;
  card.addEventListener('mousedown', (e) => e.stopPropagation());

  // --- header ---
  const bar = document.createElement('div');
  bar.style.cssText = 'background:#1f2937; padding:14px 22px; display:flex; align-items:center; justify-content:space-between; flex:0 0 auto; border-bottom:1px solid #2a2a2a;';
  const title = document.createElement('span');
  title.textContent = '📬 Inbox Triage';
  title.style.cssText = 'font:600 22px ui-sans-serif,system-ui,sans-serif;';
  const closeBtn = document.createElement('span');
  closeBtn.textContent = '×';
  closeBtn.style.cssText = 'cursor:pointer; font-size:30px; line-height:1; padding:0 8px; color:#aaa;';
  closeBtn.addEventListener('click', closeInboxTriage);
  bar.appendChild(title);
  bar.appendChild(closeBtn);
  card.appendChild(bar);

  // --- progress strip ---
  const progress = document.createElement('div');
  progress.style.cssText = 'padding:10px 22px; display:flex; gap:18px; align-items:center; background:#0e1218; border-bottom:1px solid #2a2a2a; color:#cfd8e4; font:13px ui-sans-serif,system-ui,sans-serif;';
  const progressText = document.createElement('div');
  progressText.style.cssText = 'flex:1 1 auto;';
  const refreshBtn = document.createElement('button');
  refreshBtn.textContent = '↻ Refresh';
  refreshBtn.style.cssText = 'background:#1a2030; color:#9cf; border:1px solid #2c4664; border-radius:5px; padding:5px 12px; cursor:pointer; font:600 12px ui-sans-serif,system-ui,sans-serif;';
  refreshBtn.addEventListener('click', () => loadAndRender(true));
  progress.appendChild(progressText);
  progress.appendChild(refreshBtn);
  card.appendChild(progress);

  // --- list body ---
  const body = document.createElement('div');
  body.style.cssText = 'overflow-y:auto; padding:14px 18px; display:flex; flex-direction:column; gap:10px;';
  card.appendChild(body);

  overlay.appendChild(card);
  overlay.addEventListener('mousedown', closeInboxTriage);
  document.body.appendChild(overlay);
  modalEl = overlay;
  modalEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') closeInboxTriage(); };
  document.addEventListener('keydown', modalEsc);

  async function loadAndRender(_forceFresh = false): Promise<void> {
    body.innerHTML = '';
    const loading = document.createElement('div');
    loading.textContent = 'Scanning inbox…';
    loading.style.cssText = 'color:#7a8b9f; padding:32px; text-align:center; font-style:italic;';
    body.appendChild(loading);
    try {
      const resp = await api.inboxSenders(200);
      if (sessionStartUnread === null) sessionStartUnread = resp.totalUnread;
      renderProgress(resp.totalUnread);
      body.innerHTML = '';
      if (!resp.senders.length) {
        const done = document.createElement('div');
        done.innerHTML = '<div style="font:600 24px ui-sans-serif,system-ui,sans-serif; color:#6ad26a;">📭 Inbox zero!</div><div style="color:#aaa; margin-top:8px;">No unread mail in INBOX. Nothing left to triage.</div>';
        done.style.cssText = 'padding:48px; text-align:center;';
        body.appendChild(done);
        return;
      }
      for (const s of resp.senders) body.appendChild(renderRow(s));
    } catch (err) {
      body.innerHTML = '';
      const failed = document.createElement('div');
      failed.textContent = `Failed to load: ${err}`;
      failed.style.cssText = 'color:#f08080; padding:32px; text-align:center;';
      body.appendChild(failed);
    }
  }

  function renderProgress(currentUnread: number): void {
    const start = sessionStartUnread ?? currentUnread;
    const cleaned = Math.max(0, start - currentUnread);
    const pct = start > 0 ? Math.min(100, (cleaned / start) * 100) : 0;
    progressText.innerHTML = `
      <b>Inbox:</b> ${start.toLocaleString()} unread when this session started · now ${currentUnread.toLocaleString()}
      <span style="color:#6ad26a; margin-left:8px;">· cleaned ${cleaned.toLocaleString()} (${pct.toFixed(0)}%)</span>
    `;
  }

  function renderRow(s: { email: string; name: string | null; account: string; unread: number; latest_date: number; latest_subject: string | null }): HTMLDivElement {
    const row = document.createElement('div');
    row.style.cssText = `
      display:grid; grid-template-columns:48px 1fr auto; gap:14px; align-items:center;
      padding:12px 14px; background:#181818; border:1px solid #262626; border-radius:8px;
    `;
    // Avatar
    const avatar = avatarPortraitForEmail(s.email, 48);
    avatar.style.flex = '0 0 auto';
    avatar.style.cursor = 'pointer';
    avatar.addEventListener('click', () => deps.openProfile(s.email));
    row.appendChild(avatar);

    // Middle: name + email + subject + suggested destination
    const main = document.createElement('div');
    main.style.cssText = 'min-width:0;';
    const top = document.createElement('div');
    top.style.cssText = 'display:flex; align-items:baseline; gap:8px; min-width:0;';
    top.innerHTML = `
      <span style="font:600 14px ui-sans-serif,system-ui,sans-serif; color:#fff; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:0 1 auto;">${escapeHtml(s.name || s.email)}</span>
      <span style="font:11px ui-monospace,Consolas,monospace; color:#7a8b9f; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:0 1 auto;">&lt;${escapeHtml(s.email)}&gt;</span>
      <span style="font:600 12px ui-monospace,Consolas,monospace; color:#c8323c; background:#2a0d0f; border:1px solid #5a1a1f; border-radius:10px; padding:1px 8px; flex:0 0 auto;">${s.unread.toLocaleString()} unread</span>
    `;
    main.appendChild(top);
    if (s.latest_subject) {
      const subj = document.createElement('div');
      subj.textContent = s.latest_subject;
      subj.style.cssText = 'color:#ccc; font:13px ui-sans-serif,system-ui,sans-serif; margin-top:4px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
      main.appendChild(subj);
    }
    const meta = document.createElement('div');
    meta.style.cssText = 'color:#7a8b9f; font:11px ui-monospace,Consolas,monospace; margin-top:4px;';
    meta.textContent = `${s.account} · latest ${new Date(s.latest_date).toLocaleDateString()}`;
    main.appendChild(meta);

    // Suggested destination — the destination with the highest
    // confidence in the per-row destination list (rule match >
    // sender-history > etc).
    const destinations = deps.destinationsForSender(s.email, s.account);
    const suggested = destinations
      .filter(d => d.suggestion)
      .sort((a, b) => (b.suggestion?.confidence ?? 0) - (a.suggestion?.confidence ?? 0))[0];
    if (suggested) {
      const sug = document.createElement('div');
      sug.innerHTML = `
        <span style="color:#6ad26a; font:600 11px ui-monospace,Consolas,monospace;">✨ Suggested:</span>
        <span style="color:#e0c080; font:600 12px ui-sans-serif,system-ui,sans-serif; margin-left:4px;">🏠 ${escapeHtml(suggested.buildingName)}</span>
        <span style="color:#7a8b9f; font:11px ui-monospace,Consolas,monospace; margin-left:6px;">${escapeHtml(suggested.suggestion!.reason)}</span>
      `;
      sug.style.cssText = 'margin-top:6px;';
      main.appendChild(sug);
    } else if (labelsHydrated && destinations.length === 0) {
      const note = document.createElement('div');
      note.textContent = 'No bound buildings — bind a label to a building first.';
      note.style.cssText = 'color:#888; font:11px ui-monospace,Consolas,monospace; margin-top:6px; font-style:italic;';
      main.appendChild(note);
    }
    row.appendChild(main);

    // Right column: action buttons
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex; flex-direction:column; gap:6px; align-items:flex-end;';

    // Move all — opens destination picker
    const moveBtn = pillButton(
      suggested ? `Move all → ${suggested.buildingName}` : `Move all →`,
      '#3a2050', '#d8b8ff', '#5a3580',
    );
    moveBtn.addEventListener('click', async () => {
      if (suggested && destinations.length > 0) {
        // Skip the picker — go straight to the top suggestion. User
        // can still click the second button below for picker-with-search.
        await runMove(suggested);
        return;
      }
      // Fall through to picker.
      openPickerFor(moveBtn);
    });
    const pickerBtn = pillButton('Pick…', '#1a2030', '#9cf', '#2c4664');
    pickerBtn.style.padding = '3px 10px';
    pickerBtn.style.fontSize = '11px';
    pickerBtn.addEventListener('click', () => openPickerFor(pickerBtn));

    function openPickerFor(anchor: HTMLElement) {
      if (!destinations.length) return;
      openDestinationPicker({
        anchor,
        destinations,
        header: `Move all ${s.unread} from ${s.name || s.email} to…`,
        width: 380,
        dataAttr: 'triage-move',
        onPick: async (d, overrideLabel) => {
          await runMove(d, overrideLabel);
        },
      });
    }
    async function runMove(d: Destination, overrideLabel?: string) {
      moveBtn.disabled = true; pickerBtn.disabled = true;
      moveBtn.style.opacity = '0.5'; pickerBtn.style.opacity = '0.5';
      moveBtn.textContent = 'Moving…';
      try {
        const n = await deps.moveAllForSender(s.email, s.account, d.labelId, d.buildingName, overrideLabel ?? d.suggestion?.label);
        row.style.opacity = '0.4';
        moveBtn.textContent = `✓ moved ${n}`;
        setTimeout(() => loadAndRender(), 600);
      } catch (err) {
        moveBtn.textContent = 'Move all →'; moveBtn.disabled = false; pickerBtn.disabled = false;
        moveBtn.style.opacity = '1'; pickerBtn.style.opacity = '1';
        alert(`Move failed: ${err}`);
      }
    }
    actions.appendChild(moveBtn);
    actions.appendChild(pickerBtn);

    // Mark all read
    const readBtn = pillButton(`✓ Mark ${s.unread} read`, '#203030', '#a8e6c0', '#2c5e4a');
    readBtn.addEventListener('click', async () => {
      readBtn.disabled = true; readBtn.style.opacity = '0.5';
      readBtn.textContent = 'Marking…';
      try {
        const n = await deps.markAllReadForSender(s.email, s.account);
        row.style.opacity = '0.4';
        readBtn.textContent = `✓ ${n} read`;
        setTimeout(() => loadAndRender(), 600);
      } catch (err) {
        readBtn.textContent = `✓ Mark ${s.unread} read`; readBtn.disabled = false; readBtn.style.opacity = '1';
        alert(`Mark read failed: ${err}`);
      }
    });
    actions.appendChild(readBtn);

    // Open profile
    const profBtn = pillButton('Open profile', 'transparent', '#9cf', '#2c4664');
    profBtn.style.padding = '3px 10px';
    profBtn.style.fontSize = '11px';
    profBtn.addEventListener('click', () => deps.openProfile(s.email));
    actions.appendChild(profBtn);

    row.appendChild(actions);
    return row;
  }

  labelsHydrated = true;
  loadAndRender();
}

export function closeInboxTriage(): void {
  if (modalEl) { modalEl.remove(); modalEl = null; }
  if (modalEsc) { document.removeEventListener('keydown', modalEsc); modalEsc = null; }
  // Don't reset sessionStartUnread — the progress counter should
  // persist across open/close cycles so the user can come back and
  // see how much they've cleaned this session.
}

/** Reset the session progress counter — call after a sign-out. */
export function resetInboxTriageSession(): void {
  sessionStartUnread = null;
}

// --- small helpers ---
function pillButton(text: string, bg: string, fg: string, border: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.textContent = text;
  b.style.cssText = `background:${bg}; color:${fg}; border:1px solid ${border}; border-radius:14px; padding:5px 14px; cursor:pointer; font:600 12px ui-sans-serif,system-ui,sans-serif; flex:0 0 auto;`;
  b.addEventListener('mouseenter', () => { if (!b.disabled) b.style.filter = 'brightness(1.2)'; });
  b.addEventListener('mouseleave', () => { b.style.filter = 'none'; });
  return b;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

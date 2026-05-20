// Town Inbox — bottom status bar.
//
// Two zones:
//   LEFT  — backfill progress: "Syncing sami6877: 12,304 / 69,252 (18%)"
//           plus a thin progress strip the width of the bar. Hides when
//           all known accounts have last_full_sync_at set AND the queue
//           is empty.
//   RIGHT — transient status message: "Moving to Hobbies…", "Marking 12
//           threads read…", etc. Auto-fades after a few seconds.
//
// Pulled from /api/sync-status every 2s. Any module can push a
// transient message via the exported `setStatus(msg, opts?)`.
//
// Dark themed (per project convention) — sits as a fixed bar at the
// bottom of the viewport at z-index above the Phaser canvas but below
// modals.

const API_BASE = (import.meta.env.VITE_API_BASE as string | undefined) || '';

interface AccountStatus {
  email: string;
  backfillDone: number | null;
  backfillTotal: number | null;
  lastFullSyncAt: number | null;
  historyId: string | null;
  complete: boolean;
}
interface SyncStatus {
  accounts: AccountStatus[];
  queuePending: number;
  queueFailed: number;
  now: number;
}

let barEl: HTMLDivElement | null = null;
let leftEl: HTMLDivElement | null = null;
let rightEl: HTMLDivElement | null = null;
let progressFillEl: HTMLDivElement | null = null;
let pollHandle: number | null = null;
let transientTimeout: number | null = null;

const POLL_MS = 2000;

function ensureMounted(): void {
  if (barEl) return;
  barEl = document.createElement('div');
  barEl.id = '__town-status-bar';
  barEl.style.cssText = `
    position:fixed; left:0; right:0; bottom:0;
    z-index:1050;
    background:#0e1218; color:#cfd8e4;
    border-top:1px solid #2a3340;
    font:12px ui-sans-serif,system-ui,-apple-system,sans-serif;
    display:flex; align-items:stretch;
    user-select:none;
    height:28px;
  `;
  // Inner progress strip — sits BEHIND the text, fills left-to-right
  // proportional to backfill completion across all accounts.
  progressFillEl = document.createElement('div');
  progressFillEl.style.cssText = `
    position:absolute; left:0; bottom:0;
    height:2px; width:0%;
    background:linear-gradient(90deg, #2c6e8a, #4da4cd);
    transition:width 0.5s ease;
    pointer-events:none;
  `;
  barEl.appendChild(progressFillEl);
  leftEl = document.createElement('div');
  leftEl.style.cssText = 'flex:1 1 auto; padding:6px 14px; display:flex; align-items:center; gap:10px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
  rightEl = document.createElement('div');
  rightEl.style.cssText = 'flex:0 1 auto; padding:6px 14px; color:#a3b1c2; display:flex; align-items:center; gap:6px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; max-width:50%;';
  barEl.appendChild(leftEl);
  barEl.appendChild(rightEl);
  document.body.appendChild(barEl);
  // Reserve space at bottom of the page so absolutely-positioned game
  // canvas doesn't sit under the bar. The Phaser canvas itself fills
  // the body, so we add bottom padding via margin on body.
  document.body.style.marginBottom = '28px';
}

function fmtInt(n: number): string {
  return n.toLocaleString();
}

function shortEmail(e: string): string {
  return e.includes('@') ? e.split('@')[0] : e;
}

function renderBackfillState(status: SyncStatus): void {
  if (!leftEl || !progressFillEl) return;
  const inProgress = status.accounts.filter(a => !a.complete && (a.backfillTotal || 0) > 0);
  const totalDone = status.accounts.reduce((sum, a) => sum + (a.backfillDone || 0), 0);
  const totalTotal = status.accounts.reduce((sum, a) => sum + (a.backfillTotal || 0), 0);
  const pct = totalTotal > 0 ? Math.min(100, (totalDone / totalTotal) * 100) : 0;

  if (inProgress.length > 0) {
    // Pick the account farthest from done to display by name.
    const worst = [...inProgress].sort((a, b) =>
      ((a.backfillDone || 0) / Math.max(1, a.backfillTotal || 1)) -
      ((b.backfillDone || 0) / Math.max(1, b.backfillTotal || 1)),
    )[0];
    leftEl.innerHTML = `
      <span style="color:#9eccf6;">⟳</span>
      <span><b>${escapeHtml(shortEmail(worst.email))}</b></span>
      <span style="color:#7a8b9f;">${fmtInt(worst.backfillDone || 0)} / ${fmtInt(worst.backfillTotal || 0)} threads</span>
      <span style="color:#cfd8e4;">(${pct.toFixed(0)}%)</span>
    `;
    progressFillEl.style.width = pct.toFixed(1) + '%';
    progressFillEl.style.opacity = '1';
  } else if (status.queuePending > 0) {
    leftEl.innerHTML = `
      <span style="color:#d8b8ff;">↗</span>
      <span>Syncing ${fmtInt(status.queuePending)} pending change${status.queuePending === 1 ? '' : 's'} to Gmail…</span>
    `;
    progressFillEl.style.width = '100%';
    progressFillEl.style.opacity = '0.4';
  } else {
    // Idle — show a quiet "all caught up" with the per-account totals.
    const accts = status.accounts.length;
    leftEl.innerHTML = `
      <span style="color:#6ad26a;">✓</span>
      <span style="color:#a3b1c2;">All ${accts} account${accts === 1 ? '' : 's'} synced</span>
    `;
    progressFillEl.style.width = '0%';
    progressFillEl.style.opacity = '0';
  }
  if (status.queueFailed > 0) {
    leftEl.innerHTML += ` <span style="color:#f08080;">· ${status.queueFailed} failed</span>`;
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}

/**
 * Push a transient status message to the right side of the bar. Auto-
 * fades after `ttlMs` (default 3500ms). Pass `ttlMs: 0` to keep it
 * until the next setStatus() call.
 */
export function setStatus(msg: string, opts: { ttlMs?: number; tone?: 'info' | 'ok' | 'warn' | 'err' } = {}): void {
  ensureMounted();
  if (!rightEl) return;
  const colors = { info: '#a3b1c2', ok: '#6ad26a', warn: '#e6c46a', err: '#f08080' };
  const color = colors[opts.tone || 'info'];
  rightEl.innerHTML = `<span style="color:${color};">${escapeHtml(msg)}</span>`;
  if (transientTimeout) { clearTimeout(transientTimeout); transientTimeout = null; }
  const ttl = opts.ttlMs ?? 3500;
  if (ttl > 0) {
    transientTimeout = window.setTimeout(() => {
      if (rightEl) rightEl.innerHTML = '';
      transientTimeout = null;
    }, ttl);
  }
}

async function pollOnce(): Promise<void> {
  try {
    const r = await fetch(`${API_BASE}/api/sync-status`);
    if (!r.ok) return;
    const status = (await r.json()) as SyncStatus;
    renderBackfillState(status);
  } catch {
    // Backend probably down — show that on the LEFT so it's obvious.
    if (leftEl) leftEl.innerHTML = `<span style="color:#f08080;">⚠ Backend not reachable</span>`;
    if (progressFillEl) { progressFillEl.style.width = '0%'; progressFillEl.style.opacity = '0'; }
  }
}

export function mountStatusBar(): void {
  ensureMounted();
  pollOnce();
  if (pollHandle === null) pollHandle = window.setInterval(pollOnce, POLL_MS);
}

// Expose to window so any module (including this conversation's
// existing scene code) can push transient messages without importing
// the module directly: `window.townStatus.set('Moving to Hobbies…')`.
(window as any).townStatus = { set: setStatus };

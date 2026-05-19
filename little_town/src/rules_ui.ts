// Gmail filters / rules pane. Dark themed, multi-account. Lets the
// user review existing filters and author new ones with the standard
// Gmail criteria + action vocabulary.
//
// Backend endpoints: GET/POST /api/filters, DELETE /api/filters/:id
// Requires the gmail.settings.basic scope — accounts that haven't
// re-authenticated since the scope was added will surface as
// `error: 'missing_scope'` entries in the list response.

import { api, type AccountSummary, type GmailLabel, type EmailThread } from './api';
import { clampPopupToViewport } from './ui_helpers';

// Stale-match entry surfaced by the "Suggested moves" tab — an inbox
// thread whose sender matches an existing rule but which hasn't had
// the rule's target label applied yet (so the email predates the rule
// or arrived while the user was offline). Computed by the host scene
// via `findStaleMatches` because it requires access to the inbox
// thread cache and the building↔label bindings.
export interface StaleRuleMatch {
  thread: EmailThread;
  rule: { id?: string; rawId?: string; account: string; criteria?: any; action?: any };
  targetLabel: string;          // resolved name of the rule's add-label
  buildingName: string | null;  // building bound to that label (or a parent), if any
}

interface Criteria {
  from?: string;
  to?: string;
  subject?: string;
  query?: string;        // Gmail "Has the words"
  negatedQuery?: string; // "Doesn't have"
  hasAttachment?: boolean;
  size?: number;         // bytes
  sizeComparison?: 'smaller' | 'larger';
}
interface Action {
  addLabelIds?: string[];
  removeLabelIds?: string[];
  forward?: string;
}
interface RuleRow {
  id?: string;
  rawId?: string;
  account: string;
  criteria?: Criteria;
  action?: Action;
  error?: string;
  message?: string;
}

let modalEl: HTMLDivElement | null = null;
let escHandler: ((e: KeyboardEvent) => void) | null = null;

export function openRulesPane(opts: {
  accounts: AccountSummary[];
  labels: GmailLabel[] | null;
  reauthUrl: (email: string) => string;
  // Optional — when both are provided, the pane shows a "Suggested
  // moves" tab that lists inbox threads whose sender matches an
  // existing rule but the rule hasn't been applied to them yet.
  // Useful for cleaning up email that arrived BEFORE a rule was made.
  findStaleMatches?: () => Promise<StaleRuleMatch[]>;
  applyRule?: (m: StaleRuleMatch) => Promise<void>;
}): void {
  closeRulesPane();
  const overlay = document.createElement('div');
  overlay.style.cssText = `
    position:fixed; inset:0; z-index:1100;
    background:rgba(0,0,0,0.85);
    display:flex; align-items:center; justify-content:center;
    font:15px ui-sans-serif,system-ui,sans-serif;
  `;
  const card = document.createElement('div');
  // Grid with `auto 1fr` rows guarantees the body row gets exactly the
  // remaining height (everything above the title), letting overflow:auto
  // actually scroll. Flex + min-height:0 was unreliable when the body
  // had many account sections.
  card.style.cssText = `
    width:96vw; height:94vh;
    display:grid; grid-template-rows: auto 1fr;
    background:#111; color:#eee; border:1px solid #333; border-radius:10px;
    box-shadow:0 24px 64px rgba(0,0,0,0.85); overflow:hidden;
  `;
  // Title bar
  const title = document.createElement('div');
  title.style.cssText = 'background:#1f2937; padding:14px 22px; display:flex; align-items:center; justify-content:space-between; flex:0 0 auto;';
  const titleText = document.createElement('span');
  titleText.textContent = '⚙ Rules';
  titleText.style.cssText = 'font:600 22px ui-sans-serif,system-ui,sans-serif;';
  const actions = document.createElement('div');
  actions.style.cssText = 'display:flex; gap:8px; align-items:center;';
  const searchInput = document.createElement('input');
  searchInput.type = 'text';
  searchInput.placeholder = 'Search rules…';
  searchInput.spellcheck = false;
  searchInput.style.cssText = 'background:#0b0b0b; color:#eee; border:1px solid #333; border-radius:5px; padding:6px 10px; font:13px ui-sans-serif,system-ui,sans-serif; width:240px;';
  const newBtn = document.createElement('button');
  newBtn.textContent = '+ New rule';
  newBtn.style.cssText = chipBtn('#1f3a5f', '#9cf', '#2c5688');
  newBtn.addEventListener('click', () => openRuleEditor({ accounts: opts.accounts, labels: opts.labels, onSaved: () => loadList() }));
  const closeBtn = closeX(() => closeRulesPane());
  actions.appendChild(searchInput);
  actions.appendChild(newBtn);
  actions.appendChild(closeBtn);
  title.appendChild(titleText);
  title.appendChild(actions);
  card.appendChild(title);

  // Two-view tab bar. "Rules" is the existing list of Gmail filters;
  // "Suggested moves" surfaces inbox threads where a rule WOULD match
  // but hasn't been applied yet (rule was created after the email
  // arrived). Both views share the search input + new-rule button.
  type View = 'rules' | 'suggested';
  let currentView: View = 'rules';
  const tabbar = document.createElement('div');
  tabbar.style.cssText = 'background:#0e1218; padding:0 22px; display:flex; gap:0; flex:0 0 auto; border-bottom:1px solid #2a2a2a;';
  const mkTab = (view: View, label: string): HTMLButtonElement => {
    const t = document.createElement('button');
    t.type = 'button';
    t.textContent = label;
    t.style.cssText = `
      background:transparent; border:none; border-bottom:3px solid transparent;
      color:#7a8b9f; padding:12px 18px; cursor:pointer;
      font:600 13px ui-sans-serif,system-ui,sans-serif;
    `;
    t.addEventListener('click', () => {
      if (currentView === view) return;
      currentView = view;
      restyleTabs();
      render();
    });
    return t;
  };
  const tabRules = mkTab('rules', 'Rules');
  const tabSuggested = opts.findStaleMatches && opts.applyRule
    ? mkTab('suggested', '✨ Suggested moves')
    : null;
  const restyleTabs = () => {
    for (const [el, view] of [[tabRules, 'rules'], [tabSuggested, 'suggested']] as Array<[HTMLButtonElement | null, View]>) {
      if (!el) continue;
      const active = currentView === view;
      el.style.color = active ? '#d8b8ff' : '#7a8b9f';
      el.style.borderBottomColor = active ? '#9c6cd6' : 'transparent';
    }
  };
  tabbar.appendChild(tabRules);
  if (tabSuggested) tabbar.appendChild(tabSuggested);
  restyleTabs();
  // The card's grid is `auto 1fr` (title + body). Adding the tab bar
  // means we need three auto rows + one 1fr — rebuild the grid.
  card.style.gridTemplateRows = 'auto auto 1fr';
  card.appendChild(tabbar);

  // Body — list of rules grouped by account, OR list of stale matches
  // when the Suggested view is active. The card's `1fr` track bounds
  // this height, and `min-height:0` + `overflow-y:auto` lets it scroll
  // when sections overflow.
  const body = document.createElement('div');
  body.style.cssText = 'min-height:0; overflow-y:auto; padding:20px 24px; display:flex; flex-direction:column; gap:18px;';
  card.appendChild(body);

  overlay.appendChild(card);
  card.addEventListener('mousedown', (e) => e.stopPropagation());
  overlay.addEventListener('mousedown', () => closeRulesPane());
  document.body.appendChild(overlay);
  modalEl = overlay;
  escHandler = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRulesPane(); };
  document.addEventListener('keydown', escHandler);

  // Per-account collapse state — persisted to localStorage so toggling
  // a section closed sticks across pane opens. Set of email addresses.
  const COLLAPSE_KEY = 'little_town.rules_collapsed_accounts';
  const collapsed: Set<string> = (() => {
    try {
      const raw = localStorage.getItem(COLLAPSE_KEY);
      return new Set<string>(raw ? JSON.parse(raw) : []);
    } catch { return new Set<string>(); }
  })();
  const persistCollapsed = () => {
    try { localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...collapsed])); } catch {}
  };

  // Fetched once, re-filtered on every search keystroke.
  let allRules: RuleRow[] | null = null;
  const ruleMatchesQuery = (r: RuleRow, q: string): boolean => {
    if (!q) return true;
    if (r.error) return false;
    const c = r.criteria || {};
    const a = r.action || {};
    const labelNames = (a.addLabelIds || []).concat(a.removeLabelIds || []);
    const haystack = [
      r.account,
      c.from, c.to, c.subject, c.query, c.negatedQuery,
      summarizeRuleCriteria(c),
      summarizeRuleAction(a, opts.labels || [], r.account),
      ...labelNames,
    ].filter(Boolean).join(' ').toLowerCase();
    return haystack.includes(q);
  };

  // Suggested-view state. Loaded on demand (first time the user opens
  // that tab) and cached for the lifetime of the pane so toggling back
  // doesn't re-scan; the "Refresh" link inside the view reloads.
  let staleMatches: StaleRuleMatch[] | null = null;
  let staleLoading = false;
  const loadSuggested = () => {
    if (!opts.findStaleMatches) return;
    staleLoading = true;
    render();
    opts.findStaleMatches().then(list => {
      staleMatches = list;
      staleLoading = false;
      render();
    }).catch(err => {
      staleLoading = false;
      staleMatches = [];
      body.innerHTML = `<div style="color:#c66; padding:8px 0;">Failed to scan inbox: ${escapeHtml(String(err))}</div>`;
    });
  };

  const renderRulesView = () => {
    if (!allRules) {
      body.innerHTML = '<div style="color:#777; padding:8px 0;">Loading rules…</div>';
      return;
    }
    body.innerHTML = '';
    const q = searchInput.value.trim().toLowerCase();
    const filtered = allRules.filter(r => ruleMatchesQuery(r, q));
    const byAccount = new Map<string, RuleRow[]>();
    for (const r of filtered) {
      if (!byAccount.has(r.account)) byAccount.set(r.account, []);
      byAccount.get(r.account)!.push(r);
    }
    const sectOpts: SectionOpts = {
      ...opts, reload: loadList, collapsed, persistCollapsed,
    };
    const seen = new Set<string>();
    let anyRendered = false;
    for (const a of opts.accounts) {
      seen.add(a.email);
      const acctRules = byAccount.get(a.email) || [];
      // When searching, hide accounts with no matches AND no errors.
      if (q && !acctRules.length) continue;
      body.appendChild(renderAccountSection(a.email, acctRules, sectOpts));
      anyRendered = true;
    }
    for (const [acct, list] of byAccount) {
      if (!seen.has(acct)) { body.appendChild(renderAccountSection(acct, list, sectOpts)); anyRendered = true; }
    }
    if (!anyRendered) {
      const none = document.createElement('div');
      none.textContent = q ? `No rules match "${searchInput.value}".` : 'No rules.';
      none.style.cssText = 'color:#888; font-style:italic; padding:18px; text-align:center;';
      body.appendChild(none);
    }
  };

  const renderSuggestedView = () => {
    body.innerHTML = '';
    if (staleLoading) {
      body.innerHTML = '<div style="color:#777; padding:8px 0;">Scanning inbox for stale rule matches…</div>';
      return;
    }
    if (!staleMatches) {
      // First time opening this view this session — kick off the scan.
      loadSuggested();
      return;
    }
    const q = searchInput.value.trim().toLowerCase();
    const filtered = staleMatches.filter(m => {
      if (!q) return true;
      const hay = [
        m.thread.from?.email, m.thread.from?.name, m.thread.subject, m.thread.snippet,
        m.targetLabel, m.buildingName, m.rule.account,
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
    // Header bar: total + "Apply all" + "Refresh".
    const header = document.createElement('div');
    header.style.cssText = 'display:flex; align-items:center; gap:12px; padding:4px 0;';
    const count = document.createElement('div');
    count.textContent = filtered.length === staleMatches.length
      ? `${filtered.length} stale match${filtered.length === 1 ? '' : 'es'}`
      : `${filtered.length} of ${staleMatches.length}`;
    count.style.cssText = 'color:#aaa; font:13px ui-sans-serif,system-ui,sans-serif; flex:1 1 auto;';
    header.appendChild(count);
    if (filtered.length) {
      const applyAll = document.createElement('button');
      applyAll.type = 'button';
      applyAll.textContent = `Apply all ${filtered.length} →`;
      applyAll.title = 'Run every visible rule against its matching thread';
      applyAll.style.cssText = chipBtn('#3a2050', '#d8b8ff', '#5a3580');
      applyAll.addEventListener('click', async () => {
        if (applyAll.disabled) return;
        applyAll.disabled = true; applyAll.style.opacity = '0.6';
        applyAll.textContent = 'Applying…';
        await Promise.all(filtered.map(m => opts.applyRule!(m).catch(err =>
          console.warn(`[applyRule] failed for ${m.thread.threadId}:`, err))));
        // Re-scan so the now-handled matches drop off the list.
        loadSuggested();
      });
      header.appendChild(applyAll);
    }
    const refresh = document.createElement('button');
    refresh.type = 'button';
    refresh.textContent = '↻ Rescan';
    refresh.title = 'Re-scan the inbox for stale rule matches';
    refresh.style.cssText = chipBtn('#1a2030', '#9cf', '#2c4664');
    refresh.addEventListener('click', () => loadSuggested());
    header.appendChild(refresh);
    body.appendChild(header);
    if (!filtered.length) {
      const none = document.createElement('div');
      none.textContent = staleMatches.length
        ? `No matches for "${searchInput.value}".`
        : 'Nothing to clean up — every inbox thread that matches a rule already has the rule\'s label.';
      none.style.cssText = 'color:#888; font-style:italic; padding:24px; text-align:center;';
      body.appendChild(none);
      return;
    }
    for (const m of filtered) body.appendChild(renderStaleMatchRow(m, opts, loadSuggested));
  };

  const render = () => {
    if (currentView === 'suggested') renderSuggestedView();
    else renderRulesView();
  };
  const loadList = () => {
    allRules = null;
    render();
    api.filters().then(rules => {
      allRules = rules as RuleRow[];
      render();
    }).catch(err => {
      body.innerHTML = `<div style="color:#c66; padding:8px 0;">Failed to load rules: ${escapeHtml(String(err))}</div>`;
    });
  };
  searchInput.addEventListener('input', () => render());
  loadList();
}

export function closeRulesPane(): void {
  if (!modalEl) return;
  modalEl.remove();
  modalEl = null;
  if (escHandler) {
    document.removeEventListener('keydown', escHandler);
    escHandler = null;
  }
}

// ---- per-account section: list of rules + add / reauth buttons ----
type SectionOpts = {
  labels: GmailLabel[] | null;
  accounts: AccountSummary[];
  reauthUrl: (email: string) => string;
  reload: () => void;
  collapsed: Set<string>;
  persistCollapsed: () => void;
};

function renderAccountSection(
  email: string,
  rules: RuleRow[],
  opts: SectionOpts
): HTMLDivElement {
  const section = document.createElement('div');
  // flex-shrink:0 stops the body's flex layout from squishing tall
  // sections into a fraction of their content; combined with body
  // overflow-y:auto this means the body scrolls instead of cropping.
  section.style.cssText = 'border:1px solid #2a2a2a; border-radius:8px; overflow:hidden; flex:0 0 auto;';
  const isCollapsed = opts.collapsed.has(email);
  // Clickable header — toggles collapse state and persists.
  const hdr = document.createElement('div');
  hdr.style.cssText = 'background:#1a1a1a; padding:10px 14px; display:flex; justify-content:space-between; align-items:center; cursor:pointer; user-select:none;';
  hdr.title = 'Click to collapse / expand this account';
  const ruleCount = rules.filter(r => !r.error).length;
  const acctLabel = document.createElement('span');
  const caret = isCollapsed ? '▶' : '▼';
  acctLabel.innerHTML = `<span style="color:#888; margin-right:6px;">${caret}</span>📧 <span style="color:#fff; font-weight:600;">${escapeHtml(email)}</span> <span style="color:#888;">·</span> <span style="color:#aaa;">${ruleCount} rule${ruleCount === 1 ? '' : 's'}</span>`;
  acctLabel.style.cssText = 'font:600 13px ui-monospace,Consolas,monospace;';
  hdr.appendChild(acctLabel);
  hdr.addEventListener('click', () => {
    if (opts.collapsed.has(email)) opts.collapsed.delete(email);
    else opts.collapsed.add(email);
    opts.persistCollapsed();
    // Toggle just the inner list visibility + caret — cheaper than a
    // full re-render and keeps scroll position in the body.
    const collapsedNow = opts.collapsed.has(email);
    list.style.display = collapsedNow ? 'none' : '';
    const car = acctLabel.querySelector('span');
    if (car) car.textContent = collapsedNow ? '▶' : '▼';
  });
  section.appendChild(hdr);
  const list = document.createElement('div');
  list.style.cssText = `display:${isCollapsed ? 'none' : 'flex'}; flex-direction:column;`;
  // Surface missing-scope errors with a Re-authenticate prompt.
  const scopeErr = rules.find(r => r.error === 'missing_scope');
  if (scopeErr) {
    const banner = document.createElement('div');
    banner.style.cssText = 'background:#3b1f1f; color:#fcc; padding:10px 14px; display:flex; justify-content:space-between; align-items:center; gap:12px;';
    const txt = document.createElement('span');
    txt.textContent = 'This account needs to be re-authenticated — the new "gmail.settings.basic" permission was added after you signed in.';
    txt.style.cssText = 'font-size:13px;';
    const reBtn = document.createElement('button');
    reBtn.textContent = 'Re-authenticate';
    reBtn.style.cssText = chipBtn('#1f3a5f', '#fff', '#2c5688');
    reBtn.addEventListener('click', () => { window.location.href = opts.reauthUrl(email); });
    banner.appendChild(txt);
    banner.appendChild(reBtn);
    list.appendChild(banner);
  } else if (!rules.length) {
    const empty = document.createElement('div');
    empty.textContent = 'No rules yet for this account.';
    empty.style.cssText = 'color:#777; font-style:italic; padding:14px;';
    list.appendChild(empty);
  } else {
    for (const r of rules.filter(r => !r.error)) list.appendChild(renderRuleRow(r, opts));
  }
  section.appendChild(list);
  return section;
}

function renderRuleRow(r: RuleRow, opts: SectionOpts): HTMLDivElement {
  const row = document.createElement('div');
  // CSS grid keeps WHEN / → / DO / actions aligned across every row
  // instead of letting flex basis:auto shift columns based on content.
  row.style.cssText = 'padding:12px 14px; border-top:1px solid #222; display:grid; grid-template-columns:1fr 28px 1fr 80px; gap:16px; align-items:center;';
  // Left: criteria summary
  const left = document.createElement('div');
  left.style.cssText = 'min-width:0; word-break:break-word;';
  left.innerHTML = `
    <div style="color:#aaa; font:11px ui-monospace,Consolas,monospace; text-transform:uppercase; letter-spacing:0.06em; margin-bottom:4px;">WHEN</div>
    <div style="color:#fff;">${escapeHtml(summarizeCriteria(r.criteria || {}))}</div>
  `;
  // Middle: arrow
  const arrow = document.createElement('div');
  arrow.textContent = '→';
  arrow.style.cssText = 'color:#666; font-size:20px; text-align:center;';
  // Right: action summary
  const right = document.createElement('div');
  right.style.cssText = 'min-width:0; word-break:break-word;';
  right.innerHTML = `
    <div style="color:#aaa; font:11px ui-monospace,Consolas,monospace; text-transform:uppercase; letter-spacing:0.06em; margin-bottom:4px;">DO</div>
    <div style="color:#fff;">${escapeHtml(summarizeAction(r.action || {}, opts.labels || [], r.account))}</div>
  `;
  // Edit + Delete grouped
  const btns = document.createElement('div');
  btns.style.cssText = 'display:flex; gap:6px; justify-self:end;';
  const edit = document.createElement('button');
  edit.textContent = '✎';
  edit.title = 'Edit rule';
  edit.style.cssText = 'background:#1f2937; color:#ddd; border:1px solid #2c5688; border-radius:5px; padding:4px 10px; cursor:pointer; font-size:14px;';
  edit.addEventListener('click', () => {
    openRuleEditor({
      accounts: opts.accounts,
      labels: opts.labels,
      onSaved: opts.reload,
      existing: r,
    });
  });
  const del = document.createElement('button');
  del.textContent = '×';
  del.title = 'Delete rule';
  del.style.cssText = 'background:#3b1f1f; color:#ddd; border:1px solid #5a2a2a; border-radius:5px; padding:4px 10px; cursor:pointer; font-size:16px;';
  del.addEventListener('click', async () => {
    if (!confirm(`Delete this rule from ${r.account}?\nID: ${r.rawId}`)) return;
    try {
      await api.deleteFilter(r.id!);
      row.style.opacity = '0.4';
      row.style.pointerEvents = 'none';
      setTimeout(() => row.remove(), 300);
      try { document.dispatchEvent(new CustomEvent('rules:updated')); } catch {}
    } catch (err) {
      console.error('[rules] delete failed:', { ruleId: r.id, rawId: r.rawId, account: r.account, error: err });
      const msg = err instanceof Error ? err.message : String(err);
      alert(`Delete failed for ${r.account}:\n\n${msg}\n\nCheck the browser DevTools console + backend terminal for full details.`);
    }
  });
  btns.appendChild(edit);
  btns.appendChild(del);
  row.appendChild(left);
  row.appendChild(arrow);
  row.appendChild(right);
  row.appendChild(btns);
  return row;
}

// ---- Rule editor (new rule form, or edit by replace) ----
// `existing` triggers edit mode: the editor pre-fills fields, locks the
// account dropdown (Gmail filters can't move between accounts), and on
// Save creates a new filter then deletes the old one. The order matters:
// if create fails, the old rule survives untouched. If create succeeds
// but delete fails, the user ends up with a duplicate they can clean up
// — we warn but treat it as a success since the new rule is live.
// Reusable "Rules" panel — used by the NPC click-action popup and the
// People profile popup. Lists every Gmail filter whose `from` clause
// mentions this sender (full-email or @domain or bare domain match),
// plus a `+ Create rule` button that opens the editor pre-filled with
// from:<email> and the most-relevant account selected.
//
// Returns a self-contained div the caller mounts wherever it likes.
// Refreshes its own inner list when a new rule is created (via the
// editor's onSaved callback).
export function renderSenderRulesPanel(opts: {
  email: string;
  accounts: AccountSummary[];
  labels: GmailLabel[] | null;
  // Optional: thread ids of this sender. Used to choose which account
  // the "+ Create rule" form should open against (the most-common one).
  threadIds?: string[];
}): HTMLDivElement {
  const { email, accounts, labels } = opts;
  const wrap = document.createElement('div');
  wrap.style.cssText = 'border:1px solid #222; border-radius:8px; padding:8px 10px; background:#141414; display:flex; flex-direction:column; gap:6px;';
  const header = document.createElement('div');
  header.style.cssText = 'display:flex; justify-content:space-between; align-items:center;';
  const hLabel = document.createElement('div');
  hLabel.textContent = 'RULES';
  hLabel.style.cssText = 'color:#aaa; font:11px ui-monospace,Consolas,monospace; letter-spacing:0.08em;';
  const createBtn = document.createElement('button');
  createBtn.textContent = '+ Create rule';
  createBtn.title = `Open the rule editor pre-filled with from:${email}`;
  createBtn.style.cssText = 'background:#1f3a5f; color:#fff; border:1px solid #2c5688; border-radius:5px; padding:4px 10px; cursor:pointer; font:600 11px ui-sans-serif,system-ui,sans-serif;';
  // Pick the most-common account from the supplied thread ids; fall
  // back to the first connected account.
  const accountCounts = new Map<string, number>();
  for (const id of (opts.threadIds || [])) {
    const acct = id.split(':')[0];
    accountCounts.set(acct, (accountCounts.get(acct) || 0) + 1);
  }
  const preferredAccount = [...accountCounts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
    || accounts[0]?.email;
  createBtn.addEventListener('click', () => {
    openRuleEditor({
      accounts, labels,
      onSaved: () => render(),
      prefill: { criteria: { from: email }, account: preferredAccount },
    });
  });
  header.appendChild(hLabel);
  header.appendChild(createBtn);
  wrap.appendChild(header);

  const list = document.createElement('div');
  list.style.cssText = 'display:flex; flex-direction:column; gap:4px; max-height:240px; overflow-y:auto;';
  wrap.appendChild(list);

  const render = () => {
    list.innerHTML = '<div style="color:#666; font-style:italic; font-size:12px;">Loading rules…</div>';
    const senderEmail = email.toLowerCase();
    api.filters().then(rules => {
      list.innerHTML = '';
      const matches = rules.filter(r => {
        if (r.error) return false;
        const from = (r.criteria?.from || '').toLowerCase().trim();
        if (!from) return false;
        const tokens = from.split(/[\s,]+|\bor\b/i).map(s => s.trim()).filter(Boolean);
        return tokens.some(tok => {
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
        summary.textContent = `${summarizeRuleCriteria(r.criteria || {})} → ${summarizeRuleAction(r.action || {}, labels || [], r.account)}`;
        summary.style.cssText = 'color:#ddd; font:12px ui-sans-serif,system-ui,sans-serif;';
        row.appendChild(acctLine);
        row.appendChild(summary);
        list.appendChild(row);
      }
    }).catch(err => {
      list.innerHTML = `<div style="color:#c66; font-size:12px;">Failed to load rules: ${err}</div>`;
    });
  };
  render();
  return wrap;
}

export function openRuleEditor(opts: {
  accounts: AccountSummary[];
  labels: GmailLabel[] | null;
  onSaved: () => void;
  existing?: RuleRow;
  // Pre-fill mode (no replace-on-save, just opens a fresh new-rule form
  // with the given fields populated). Used by the "Create rule for this
  // sender" button on the NPC popup.
  prefill?: { criteria?: Partial<Criteria>; account?: string };
}): void {
  document.querySelectorAll('[data-rule-editor]').forEach(el => el.remove());
  const editing = !!opts.existing;
  const ex = opts.existing;
  // Prefilled values are merged with existing (existing wins) so the
  // same code path handles both edit and new-with-defaults.
  const baseCrit: Criteria = (ex?.criteria || (opts.prefill?.criteria as Criteria) || {}) as Criteria;
  const exCrit: Criteria = baseCrit;
  const exAct: Action = (ex?.action || {}) as Action;
  const preferredAccount = ex?.account || opts.prefill?.account;
  // Split addLabelIds into the system "star" and the user-label pick.
  const exAdds = exAct.addLabelIds || [];
  const exRemoves = exAct.removeLabelIds || [];
  const exLabelId = exAdds.find(id => id !== 'STARRED' && id !== 'IMPORTANT') || '';
  const overlay = document.createElement('div');
  overlay.setAttribute('data-rule-editor', '1');
  overlay.style.cssText = `
    position:fixed; inset:0; z-index:1300;
    background:rgba(0,0,0,0.85);
    display:flex; align-items:center; justify-content:center;
    font:15px ui-sans-serif,system-ui,sans-serif;
  `;
  const card = document.createElement('div');
  card.style.cssText = `
    width:min(720px, 92vw); max-height:90vh; overflow:auto;
    background:#111; color:#eee; border:1px solid #333; border-radius:10px;
    box-shadow:0 24px 64px rgba(0,0,0,0.85);
    display:flex; flex-direction:column;
  `;
  const title = document.createElement('div');
  title.style.cssText = 'background:#1f2937; padding:14px 22px; display:flex; justify-content:space-between; align-items:center;';
  title.innerHTML = `<span style="font:600 18px ui-sans-serif,system-ui,sans-serif;">${editing ? 'Edit rule' : 'New rule'}</span>`;
  const close = closeX(() => overlay.remove());
  title.appendChild(close);
  card.appendChild(title);

  const body = document.createElement('div');
  body.style.cssText = 'padding:20px 24px; display:flex; flex-direction:column; gap:18px;';
  card.appendChild(body);

  // Account select — locked in edit mode (Gmail can't move a filter
  // between accounts; you'd have to delete-then-create-elsewhere).
  body.appendChild(sectionLabel('Account'));
  const acctSelect = document.createElement('select');
  acctSelect.style.cssText = inputStyle();
  for (const a of opts.accounts) {
    const opt = document.createElement('option');
    opt.value = a.email; opt.textContent = a.email;
    if (preferredAccount && a.email === preferredAccount) opt.selected = true;
    acctSelect.appendChild(opt);
  }
  if (editing) {
    acctSelect.disabled = true;
    acctSelect.title = "Can't move a filter between accounts — delete and re-create instead.";
    acctSelect.style.opacity = '0.6';
    acctSelect.value = ex!.account;
  }
  body.appendChild(acctSelect);

  // Criteria — pre-fill from existing.
  body.appendChild(sectionLabel('Criteria — when an email matches…'));
  const crit = {
    from: textInput('From', 'sender@example.com', exCrit.from || ''),
    to: textInput('To', 'recipient@example.com', exCrit.to || ''),
    subject: textInput('Subject contains', '', exCrit.subject || ''),
    query: textInput('Has the words', 'e.g. unsubscribe OR newsletter', exCrit.query || ''),
    negatedQuery: textInput("Doesn't have", '', exCrit.negatedQuery || ''),
  };
  const critGrid = document.createElement('div');
  critGrid.style.cssText = 'display:grid; grid-template-columns:1fr 1fr; gap:10px;';
  for (const f of Object.values(crit)) critGrid.appendChild(f.wrap);
  body.appendChild(critGrid);
  // Attachment checkbox
  const attRow = document.createElement('div');
  attRow.style.cssText = 'display:flex; gap:14px; align-items:center; flex-wrap:wrap;';
  const hasAtt = document.createElement('input'); hasAtt.type = 'checkbox'; hasAtt.id = `rule-att-${Math.random().toString(36).slice(2,7)}`;
  if (exCrit.hasAttachment) hasAtt.checked = true;
  const hasAttLab = document.createElement('label'); hasAttLab.htmlFor = hasAtt.id; hasAttLab.textContent = 'Has attachment'; hasAttLab.style.cssText = 'color:#ccc; cursor:pointer;';
  attRow.appendChild(hasAtt); attRow.appendChild(hasAttLab);
  body.appendChild(attRow);

  // Action
  body.appendChild(sectionLabel('Action — then…'));
  const labelPicker = document.createElement('div');
  labelPicker.style.cssText = inputStyle() + ' display:flex; flex-direction:column; gap:6px;';
  const labelHint = document.createElement('div'); labelHint.style.cssText = 'color:#666; font-size:11px;';
  labelHint.textContent = 'Pick the label to apply (only labels in the selected account are shown).';
  // Searchable label picker — replaces the native <select> so the user
  // can type-to-filter through hundreds of labels. State lives in
  // `pickerState`; save handler reads `pickerState.value` (raw label id
  // or '' for no label).
  const pickerState: { value: string; valueName: string } = { value: '', valueName: '(no label)' };
  const selectedChip = document.createElement('div');
  selectedChip.style.cssText = 'background:#0b0b0b; color:#eee; border:1px solid #333; border-radius:4px; padding:6px 10px; font:13px ui-sans-serif,system-ui,sans-serif; display:flex; justify-content:space-between; align-items:center; gap:8px;';
  const selectedName = document.createElement('span');
  selectedName.textContent = pickerState.valueName;
  selectedName.style.cssText = 'color:#fff; flex:1 1 auto; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
  const clearBtn = document.createElement('button');
  clearBtn.type = 'button';
  clearBtn.textContent = '×';
  clearBtn.title = 'Clear selected label';
  clearBtn.style.cssText = 'background:transparent; color:#888; border:none; cursor:pointer; font-size:16px; padding:0 4px;';
  clearBtn.addEventListener('click', () => setSelected('', '(no label)'));
  selectedChip.appendChild(selectedName);
  selectedChip.appendChild(clearBtn);
  const labelSearch = document.createElement('input');
  labelSearch.type = 'text';
  labelSearch.placeholder = 'Search labels…';
  labelSearch.spellcheck = false;
  labelSearch.style.cssText = 'background:#0b0b0b; color:#eee; border:1px solid #333; border-radius:4px; padding:6px 10px; font:13px ui-sans-serif,system-ui,sans-serif;';
  const labelList = document.createElement('div');
  labelList.style.cssText = 'display:flex; flex-direction:column; gap:2px; max-height:200px; overflow-y:auto; background:#0b0b0b; border:1px solid #222; border-radius:4px; padding:4px;';
  labelPicker.appendChild(labelHint);
  labelPicker.appendChild(selectedChip);
  labelPicker.appendChild(labelSearch);
  labelPicker.appendChild(labelList);
  body.appendChild(labelPicker);

  const setSelected = (rawId: string, name: string) => {
    pickerState.value = rawId;
    pickerState.valueName = name;
    selectedName.textContent = name;
    selectedName.style.color = rawId ? '#fff' : '#888';
    clearBtn.style.display = rawId ? 'block' : 'none';
    renderLabelList();
  };
  const renderLabelList = () => {
    labelList.innerHTML = '';
    const acct = acctSelect.value;
    const q = labelSearch.value.trim().toLowerCase();
    let candidates = (opts.labels || [])
      .filter(l => l.account === acct)
      .sort((a, b) => a.name.localeCompare(b.name));
    // Preserve a stranded existing label that isn't in the cache.
    if (editing && exLabelId && !candidates.some(l => l.rawId === exLabelId)) {
      candidates = [
        { id: `${acct}:${exLabelId}`, rawId: exLabelId, account: acct, name: `(unknown: ${exLabelId})` } as GmailLabel,
        ...candidates,
      ];
    }
    const filtered = q ? candidates.filter(l => l.name.toLowerCase().includes(q)) : candidates;
    if (!filtered.length) {
      const empty = document.createElement('div');
      empty.textContent = q ? 'No matching labels.' : 'No labels in this account.';
      empty.style.cssText = 'color:#666; font-style:italic; padding:6px 8px; font-size:12px;';
      labelList.appendChild(empty);
      return;
    }
    for (const l of filtered.slice(0, 300)) {
      const row = document.createElement('div');
      const isSel = l.rawId === pickerState.value;
      row.style.cssText = `padding:5px 8px; cursor:pointer; border-radius:3px; font:13px ui-sans-serif,system-ui,sans-serif; ${isSel ? 'background:#1f3a5f; color:#fff;' : 'color:#ccc;'}`;
      row.textContent = l.name;
      row.addEventListener('mouseenter', () => { if (!isSel) row.style.background = '#22272e'; });
      row.addEventListener('mouseleave', () => { if (!isSel) row.style.background = 'transparent'; });
      row.addEventListener('click', () => setSelected(l.rawId, l.name));
      labelList.appendChild(row);
    }
  };
  labelSearch.addEventListener('input', renderLabelList);
  acctSelect.addEventListener('change', () => {
    // Account changed — clear selection and rerender (the chosen label
    // wouldn't exist in the new account anyway).
    setSelected('', '(no label)');
  });
  // Pre-select the existing rule's label, if any.
  if (editing && exLabelId) {
    const found = (opts.labels || []).find(l => l.account === (preferredAccount || acctSelect.value) && l.rawId === exLabelId);
    setSelected(exLabelId, found?.name || `(unknown: ${exLabelId})`);
  } else {
    setSelected('', '(no label)');
  }

  // Action checkboxes — defaults derived from existing rule when editing.
  const actBox = document.createElement('div');
  actBox.style.cssText = 'display:flex; flex-direction:column; gap:6px;';
  const skipInbox = checkbox('Skip the inbox (archive)', editing ? exRemoves.includes('INBOX') : true);
  const markRead  = checkbox('Mark as read', editing ? exRemoves.includes('UNREAD') : false);
  const star      = checkbox('Star it', editing ? exAdds.includes('STARRED') : false);
  const never     = checkbox('Never send to spam', editing ? exRemoves.includes('SPAM') : false);
  actBox.appendChild(skipInbox.wrap);
  actBox.appendChild(markRead.wrap);
  actBox.appendChild(star.wrap);
  actBox.appendChild(never.wrap);
  body.appendChild(actBox);

  // Buttons
  const footer = document.createElement('div');
  footer.style.cssText = 'display:flex; justify-content:space-between; gap:10px; padding-top:8px;';
  const cancel = document.createElement('button');
  cancel.textContent = 'Cancel';
  cancel.style.cssText = chipBtn('#222', '#ccc', '#444');
  cancel.addEventListener('click', () => overlay.remove());
  const save = document.createElement('button');
  save.textContent = editing ? 'Save changes' : 'Create rule';
  save.style.cssText = chipBtn('#1f3a5f', '#fff', '#2c5688');
  save.addEventListener('click', async () => {
    const criteria: Criteria = {};
    if (crit.from.value()) criteria.from = crit.from.value();
    if (crit.to.value()) criteria.to = crit.to.value();
    if (crit.subject.value()) criteria.subject = crit.subject.value();
    if (crit.query.value()) criteria.query = crit.query.value();
    if (crit.negatedQuery.value()) criteria.negatedQuery = crit.negatedQuery.value();
    if (hasAtt.checked) criteria.hasAttachment = true;
    if (Object.keys(criteria).length === 0) { alert('Add at least one criterion.'); return; }
    const action: Action = {};
    const adds: string[] = [], removes: string[] = [];
    if (pickerState.value) adds.push(pickerState.value);
    if (skipInbox.input.checked) removes.push('INBOX');
    if (markRead.input.checked) removes.push('UNREAD');
    if (star.input.checked) adds.push('STARRED');
    if (never.input.checked) removes.push('SPAM');
    if (adds.length) action.addLabelIds = adds;
    if (removes.length) action.removeLabelIds = removes;
    if (!action.addLabelIds && !action.removeLabelIds) { alert('Choose at least one action.'); return; }
    save.disabled = true;
    try {
      await api.createFilter(acctSelect.value, criteria, action);
      if (editing && ex?.id) {
        // Replace the old rule. If delete fails, surface a warning but
        // don't roll back — the new rule is already live, and rolling
        // back means leaving the user with neither.
        try {
          await api.deleteFilter(ex.id);
        } catch (delErr) {
          console.warn('[rules] edit replace: created new but old delete failed:', delErr);
          alert(`New rule created, but the old one could not be deleted (you have a duplicate). Delete it manually from the list.\n\n${delErr instanceof Error ? delErr.message : String(delErr)}`);
        }
      }
      overlay.remove();
      opts.onSaved();
      // Notify scene-wide listeners (e.g. the Move-to suggestion
      // engine's rules cache) so a freshly-created rule is reflected
      // in the next picker the user opens.
      try { document.dispatchEvent(new CustomEvent('rules:updated')); } catch {}
    } catch (err) {
      console.error('[rules] save failed:', err);
      const msg = err instanceof Error ? err.message : String(err);
      alert(`${editing ? 'Save' : 'Create'} failed:\n\n${msg}`);
      save.disabled = false;
    }
  });
  footer.appendChild(cancel);
  footer.appendChild(save);
  body.appendChild(footer);

  overlay.appendChild(card);
  card.addEventListener('mousedown', (e) => e.stopPropagation());
  overlay.addEventListener('mousedown', () => overlay.remove());
  document.body.appendChild(overlay);
  clampPopupToViewport(card);
}

// One row in the "Suggested moves" view. Shows sender + subject and
// where the rule would file the email, with a one-click Apply button.
// The apply is delegated to the host scene via opts.applyRule because
// the move logic + NPC bookkeeping all live in main.ts.
function renderStaleMatchRow(
  m: StaleRuleMatch,
  opts: { applyRule?: (m: StaleRuleMatch) => Promise<void> },
  reload: () => void,
): HTMLDivElement {
  const row = document.createElement('div');
  row.style.cssText = `
    display:grid; grid-template-columns: 1fr auto; gap:10px;
    align-items:center; padding:10px 14px;
    background:#181818; border:1px solid #262626; border-radius:6px;
  `;
  const main = document.createElement('div');
  main.style.cssText = 'min-width:0;';
  const top = document.createElement('div');
  top.style.cssText = 'display:flex; align-items:baseline; gap:8px; color:#fff; font:600 13px ui-sans-serif,system-ui,sans-serif;';
  const sender = document.createElement('span');
  sender.textContent = m.thread.from?.name || m.thread.from?.email || 'unknown';
  sender.style.cssText = 'flex:0 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
  const senderEmail = document.createElement('span');
  senderEmail.textContent = `<${m.thread.from?.email || ''}>`;
  senderEmail.style.cssText = 'color:#7a8b9f; font:400 11px ui-monospace,Consolas,monospace; flex:0 1 auto; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
  top.appendChild(sender); top.appendChild(senderEmail);
  const subject = document.createElement('div');
  subject.textContent = m.thread.subject || '(no subject)';
  subject.style.cssText = 'color:#ddd; font:14px ui-sans-serif,system-ui,sans-serif; margin-top:2px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';
  const meta = document.createElement('div');
  const buildingChip = m.buildingName
    ? `<span style="background:#3a2e15; color:#e0c080; border:1px solid #6a5020; border-radius:10px; padding:1px 7px; font:600 11px ui-sans-serif,system-ui,sans-serif;">🏠 ${escapeHtml(m.buildingName)}</span>`
    : `<span style="color:#888; font-style:italic;">(no building bound to ${escapeHtml(m.targetLabel)})</span>`;
  meta.innerHTML = `<span style="color:#7a8b9f; font:12px ui-sans-serif,system-ui,sans-serif;">→ Apply <code style="color:#9cf;">${escapeHtml(m.targetLabel)}</code></span> ${buildingChip}
                    <span style="color:#666; font:11px ui-monospace,Consolas,monospace; margin-left:8px;">${escapeHtml(m.rule.account)}</span>`;
  meta.style.cssText = 'margin-top:4px; display:flex; align-items:center; gap:8px; flex-wrap:wrap;';
  main.appendChild(top); main.appendChild(subject); main.appendChild(meta);
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.textContent = 'Apply →';
  apply.style.cssText = chipBtn('#3a2050', '#d8b8ff', '#5a3580');
  apply.addEventListener('click', async () => {
    if (apply.disabled || !opts.applyRule) return;
    apply.disabled = true;
    apply.style.opacity = '0.6';
    apply.textContent = 'Applying…';
    try {
      await opts.applyRule(m);
      // Optimistically remove this row; reload will re-sync.
      row.style.opacity = '0.4';
      row.style.pointerEvents = 'none';
      setTimeout(() => { row.remove(); reload(); }, 250);
    } catch (err) {
      apply.disabled = false; apply.style.opacity = '1';
      apply.textContent = 'Apply →';
      alert(`Apply failed: ${err}`);
    }
  });
  row.appendChild(main);
  row.appendChild(apply);
  return row;
}

// ---- helpers ----
export function summarizeRuleCriteria(c: any): string {
  return summarizeCriteria(c as Criteria);
}

export function summarizeRuleAction(a: any, labels: GmailLabel[], account: string): string {
  return summarizeAction(a as Action, labels, account);
}

function summarizeCriteria(c: Criteria): string {
  const parts: string[] = [];
  if (c.from) parts.push(`from: ${c.from}`);
  if (c.to) parts.push(`to: ${c.to}`);
  if (c.subject) parts.push(`subject contains "${c.subject}"`);
  if (c.query) parts.push(`has: ${c.query}`);
  if (c.negatedQuery) parts.push(`not: ${c.negatedQuery}`);
  if (c.hasAttachment) parts.push('has attachment');
  if (c.size && c.sizeComparison) parts.push(`${c.sizeComparison} than ${c.size}`);
  return parts.join(' · ') || '(no criteria)';
}
function summarizeAction(a: Action, labels: GmailLabel[], account: string): string {
  const parts: string[] = [];
  const labelById = new Map(labels.filter(l => l.account === account).map(l => [l.rawId, l.name]));
  if (a.addLabelIds?.length) {
    const named = a.addLabelIds.map(id => labelById.get(id) || id);
    parts.push(`apply: ${named.join(', ')}`);
  }
  if (a.removeLabelIds?.length) {
    const SYS: Record<string, string> = { INBOX: 'archive', UNREAD: 'mark read', SPAM: 'never spam' };
    const named = a.removeLabelIds.map(id => SYS[id] || `remove ${labelById.get(id) || id}`);
    parts.push(named.join(', '));
  }
  if (a.forward) parts.push(`forward to ${a.forward}`);
  return parts.join(' · ') || '(no action)';
}
function sectionLabel(text: string): HTMLDivElement {
  const d = document.createElement('div');
  d.textContent = text;
  d.style.cssText = 'color:#aaa; font-size:13px; text-transform:uppercase; letter-spacing:0.06em; border-bottom:1px solid #222; padding-bottom:6px;';
  return d;
}
function textInput(label: string, placeholder: string, initial = '') {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex; flex-direction:column; gap:4px;';
  const lab = document.createElement('label');
  lab.textContent = label;
  lab.style.cssText = 'color:#888; font-size:12px;';
  const inp = document.createElement('input');
  inp.type = 'text'; inp.placeholder = placeholder; inp.spellcheck = false;
  if (initial) inp.value = initial;
  inp.style.cssText = 'background:#0b0b0b; color:#eee; border:1px solid #333; border-radius:4px; padding:6px 10px; font:13px ui-sans-serif,system-ui,sans-serif;';
  wrap.appendChild(lab); wrap.appendChild(inp);
  return { wrap, input: inp, value: () => inp.value.trim() };
}
function checkbox(text: string, defaultOn: boolean) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex; gap:8px; align-items:center;';
  const inp = document.createElement('input');
  inp.type = 'checkbox';
  inp.id = `rule-cb-${Math.random().toString(36).slice(2,8)}`;
  inp.checked = defaultOn;
  const lab = document.createElement('label');
  lab.htmlFor = inp.id;
  lab.textContent = text;
  lab.style.cssText = 'color:#ccc; cursor:pointer;';
  wrap.appendChild(inp); wrap.appendChild(lab);
  return { wrap, input: inp };
}
function chipBtn(bg: string, fg: string, border: string): string {
  return `background:${bg}; color:${fg}; border:1px solid ${border}; border-radius:6px; padding:6px 14px; cursor:pointer; font:600 13px ui-sans-serif,system-ui,sans-serif;`;
}
function closeX(onClick: () => void): HTMLSpanElement {
  const s = document.createElement('span');
  s.textContent = '×';
  s.style.cssText = 'cursor:pointer; font-size:28px; line-height:1; padding:0 8px;';
  s.addEventListener('click', onClick);
  return s;
}
function inputStyle(): string {
  return 'background:#0b0b0b; color:#eee; border:1px solid #333; border-radius:6px; padding:10px 12px; font:13px ui-sans-serif,system-ui,sans-serif;';
}
function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

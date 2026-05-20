// Gmail proxy — multi-account aware.
//
// Each endpoint accepts an optional `?account=<email>` query (or for write
// endpoints, infers the account from a prefixed id like `<email>:<gmailId>`).
// When no account is specified on read endpoints, we fan out across every
// active account in parallel and merge the results.
//
// Thread / message IDs in responses are always prefixed `<email>:<gmailId>`
// so the frontend can disambiguate which account a thread belongs to.

import express from 'express';
import { google } from 'googleapis';
import { requireAuth, dropAccountForInvalidGrant } from './auth.js';
import { parseMessage, extractUnsubscribe } from '../gmail/parseMessage.js';
import { labelsRepo, threadsRepo, messagesRepo, queryRepo, statusRepo } from '../db/repositories.js';
import { applyAndEnqueueModify, applyAndEnqueueMarkRead } from '../services/mutationQueue.js';
import { gmailLimiter } from '../services/rateLimiter.js';

const router = express.Router();

function getGmailClient(oauth2Client) {
  return google.gmail({ version: 'v1', auth: oauth2Client });
}

// Strip `account:` prefix from a possibly-prefixed id.
// Returns { account: string | null, id: string }.
function parseId(prefixedOrPlain) {
  if (typeof prefixedOrPlain !== 'string') return { account: null, id: '' };
  const idx = prefixedOrPlain.indexOf(':');
  if (idx <= 0) return { account: null, id: prefixedOrPlain };
  return { account: prefixedOrPlain.slice(0, idx).toLowerCase(), id: prefixedOrPlain.slice(idx + 1) };
}

// Pick which clients to use for a given request. `?account=email` narrows to
// one; otherwise we use every active account.
function clientsFor(req) {
  const wanted = typeof req.query.account === 'string' ? req.query.account.toLowerCase() : null;
  if (wanted) {
    const c = req.oauth2Clients[wanted];
    if (!c) return {};
    return { [wanted]: c };
  }
  return req.oauth2Clients;
}

// Centralised error handler. invalid_grant drops just the offending account.
function handleGmailError(err, res, action, account) {
  const isInvalidGrant = err.message?.includes('invalid_grant')
    || err.response?.data?.error === 'invalid_grant';
  if (isInvalidGrant && account) {
    dropAccountForInvalidGrant(account);
    return res.status(401).json({
      error: 'auth_expired',
      message: `Refresh token expired for ${account}. Sign that account back in.`,
      account,
    });
  }
  console.error(`Error ${action}:`, {
    account,
    message: err.message,
    code: err.code,
    response: err.response?.data,
    stack: err.stack?.split('\n').slice(0, 3).join('\n'),
  });
  res.status(500).json({
    error: `Failed to ${action}`,
    message: err.message,
    account,
    details: err.response?.data?.error || err.errors,
  });
}

// parseMessage + extractUnsubscribe live in backend/gmail/parseMessage.js
// so the sync engine and these legacy routes share one implementation.
// See the import at the top.

// ---------------- sync status (cheap, poll-friendly) ----------------
// Renderer polls this every couple seconds to drive the bottom status
// bar (backfill progress + mutation-queue depth). Pure SQL reads, no
// auth check — anyone with localhost access already has the data.
router.get('/sync-status', (_req, res) => {
  res.json(statusRepo.snapshot());
});

// ---------------- profile (multi) ----------------
router.get('/profile', requireAuth, async (req, res) => {
  const targets = clientsFor(req);
  const profiles = await Promise.all(Object.entries(targets).map(async ([account, client]) => {
    try {
      const r = await getGmailClient(client).users.getProfile({ userId: 'me' });
      return {
        account,
        email: r.data.emailAddress,
        messagesTotal: r.data.messagesTotal,
        threadsTotal: r.data.threadsTotal,
        historyId: r.data.historyId,
      };
    } catch (err) {
      console.warn(`[profile] ${account}:`, err.message);
      return { account, error: err.message };
    }
  }));
  res.json({ accounts: profiles });
});

// ---------------- labels (per-account) ----------------
// Returns one flat array with each label tagged by account so the frontend
// can group / dedupe by name as it sees fit. Same-name labels from different
// accounts stay separate (different ids).
router.get('/labels', requireAuth, async (req, res) => {
  // SQLite-backed: labels table is kept fresh by the sync engine
  // (backfill seeds it, history poll updates threadsTotal/Unread).
  // No Gmail round-trip per call — instant, no quota cost.
  const targets = clientsFor(req);
  const wanted = new Set(Object.keys(targets));
  const all = labelsRepo.all()
    .filter(l => wanted.has(l.account))
    .filter(l => l.type === 'user' || ['INBOX', 'STARRED', 'IMPORTANT'].includes(l.raw_id))
    .map(l => ({
      id: `${l.account}:${l.raw_id}`,
      rawId: l.raw_id,
      account: l.account,
      name: l.name,
      type: l.type,
      color: null,
    }));
  res.json(all);
});

// ---------------- thread list (SQLite-backed) ----------------
//
// Reads from local SQLite — no Gmail round-trip, no THREAD_LIMIT cap.
// Parses the small Gmail-search-query vocabulary the renderer actually
// emits today (`label:"..."`, `from:...`, `is:unread`, free text on
// subject/snippet). Anything outside that vocabulary falls through to
// "most recent threads across all accounts".
//
// `maxResults` is honoured as a defensive cap (default 1000) but is no
// longer the user-visible "how many emails exist" — DB returns
// everything matching, capped only to avoid pathological response sizes
// for unfiltered queries.
router.get('/emails', requireAuth, async (req, res) => {
  const wanted = new Set(Object.keys(clientsFor(req)));
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  const maxResults = Math.max(1, parseInt(req.query.maxResults) || 1000);

  // ----- parse q -----
  // Supported:
  //   label:"Newsletters/Patreon"   exact or quoted name; nested matches via prefix
  //   from:email@x.com              exact sender match
  //   is:unread                     adds isRead=0 filter
  let labelName = null;
  let fromEmail = null;
  let unreadOnly = false;
  if (q) {
    const labelMatch = q.match(/label:"([^"]+)"|label:(\S+)/i);
    if (labelMatch) labelName = labelMatch[1] || labelMatch[2];
    const fromMatch = q.match(/from:([^\s]+)/i);
    if (fromMatch) fromEmail = fromMatch[1];
    if (/\bis:unread\b/i.test(q)) unreadOnly = true;
  }

  let rows;
  if (fromEmail) {
    rows = queryRepo.threadsBySender(fromEmail, { limit: maxResults });
  } else if (labelName) {
    rows = queryRepo.threadsByLabelName(labelName, { limit: maxResults });
  } else {
    rows = queryRepo.recentThreads({ limit: maxResults });
  }
  // Account filter applies regardless of query — render only threads
  // from accounts the user has active in this session.
  rows = rows.filter(r => wanted.has(r.account));
  if (unreadOnly) rows = rows.filter(r => !r.isRead);

  res.json({ emails: rows, nextPageToken: null, resultSizeEstimate: rows.length });
});

// ---------------- unread count (sum across accounts) ----------------
// Accepts EITHER:
//   ?labelIds=INBOX                             — system label (all accts)
//   ?labelIds=harvey@spectra.studio:Label_xxx   — single prefixed id
//   ?labelIds=...,...                            — comma-separated list
//   ?labelName=Personal                         — resolves to that label
//                                                  on every account that
//                                                  has a label with that
//                                                  exact name
router.get('/unread-count', requireAuth, async (req, res) => {
  // SQLite-backed: one COUNT(*) per call, no Gmail round-trip + no
  // unreliable resultSizeEstimate. Honours the same parameter shape
  // the renderer already uses:
  //   ?labelName=Newsletters       count threads with that label or any sub-label, unread only
  //   ?labelIds=INBOX              count threads with that system label, unread only
  //   ?labelIds=...,...            comma-separated; sums per-id (rare)
  //   (no filter)                  total unread across all accounts
  const labelName = typeof req.query.labelName === 'string' ? req.query.labelName : '';
  const labelIdsRaw = typeof req.query.labelIds === 'string' ? req.query.labelIds : '';

  let count = 0;
  if (labelName) {
    count = queryRepo.unreadCountByLabelName(labelName);
  } else if (labelIdsRaw) {
    const ids = labelIdsRaw.split(',').map(s => s.trim()).filter(Boolean);
    for (const id of ids) {
      const { id: rawId } = parseId(id);
      count += queryRepo.unreadCountBySystemRawId(rawId);
    }
  } else {
    count = queryRepo.unreadCountAll();
  }
  res.json({ count, breakdown: {} });
});

// ---------------- single thread (DB metadata + lazy body fetch) ----------------
//
// Reads from the local DB. If any message in the thread has a NULL body,
// fetches the full thread from Gmail ONCE, parses bodies via the legacy
// parseMessage, writes them through to messages.body / messages.body_html,
// and returns the hydrated thread.
//
// After the first open, subsequent calls are pure DB reads — bodies live
// in SQLite forever (invalidated only when history sync removes the
// thread).
router.get('/threads/:id', requireAuth, async (req, res) => {
  const prefixedId = req.params.id;
  const { account, id: gmailThreadId } = parseId(prefixedId);
  if (!account) return res.status(400).json({ error: 'thread id must be prefixed with account:' });
  const client = req.oauth2Clients[account];
  if (!client) return res.status(401).json({ error: `account not active: ${account}` });

  let thread = queryRepo.fullThread(prefixedId);
  if (!thread) {
    // Not yet synced — fall back to live Gmail fetch and upsert so
    // subsequent calls hit the cache. Rare path: only when a history
    // poll surfaces a thread the renderer asks for before the next
    // tick has indexed it.
    try {
      await gmailLimiter.take(5);
      const response = await getGmailClient(client).users.threads.get({ userId: 'me', id: gmailThreadId, format: 'full' });
      const messages = response.data.messages || [];
      if (messages.length === 0) return res.json(null);
      const parsedMessages = messages.map(m => parseMessage(account, m));
      const allLabels = new Set();
      messages.forEach(m => (m.labelIds || []).forEach(l => allLabels.add(l)));
      const latest = parsedMessages[parsedMessages.length - 1];
      const payload = {
        id: prefixedId, threadId: prefixedId, account,
        messageCount: messages.length,
        from: latest.from, to: latest.to,
        subject: latest.subject, snippet: latest.snippet, date: latest.date,
        labels: Array.from(allLabels),
        isRead: !allLabels.has('UNREAD'),
        isStarred: allLabels.has('STARRED'),
        hasAttachment: parsedMessages.some(m => m.hasAttachment),
        messages: parsedMessages,
        originalFrom: parsedMessages[0].from,
      };
      // Best-effort write-through. We don't await this on failure
      // because the response is what matters.
      try {
        for (const m of parsedMessages) {
          messagesRepo.upsertMeta({
            id: m.id, thread_id: m.threadId, account,
            from_email: m.from.email?.toLowerCase(), from_name: m.from.name,
            to_header: m.to, date: new Date(m.date).getTime() || 0,
            snippet: m.snippet, is_read: m.isRead, has_attachment: m.hasAttachment,
            unsubscribe_json: m.unsubscribe ? JSON.stringify(m.unsubscribe) : null,
          });
          messagesRepo.saveBody(m.id, m.body, m.bodyHtml);
        }
      } catch (e) { console.warn('[threads/:id] write-through failed:', e.message); }
      return res.json(payload);
    } catch (err) {
      return handleGmailError(err, res, 'fetch thread', account);
    }
  }

  // Hydrate bodies if any message is still body-less.
  const needBodies = thread.messages.some(m => !m.body && !m.bodyHtml);
  if (needBodies) {
    try {
      await gmailLimiter.take(5);
      const response = await getGmailClient(client).users.threads.get({ userId: 'me', id: gmailThreadId, format: 'full' });
      const fullMessages = response.data.messages || [];
      const parsedById = new Map(fullMessages.map(m => [m.id, parseMessage(account, m)]));
      // Write bodies through to the DB, then re-fetch the hydrated row.
      for (const [gid, parsed] of parsedById) {
        messagesRepo.saveBody(`${account}:${gid}`, parsed.body, parsed.bodyHtml);
      }
      thread = queryRepo.fullThread(prefixedId);
    } catch (err) {
      // Couldn't fetch bodies — surface metadata anyway so the popup
      // can at least render the header. Renderer treats empty body as
      // "(empty)".
      console.warn(`[threads/:id] body fetch failed for ${prefixedId}:`, err.message);
    }
  }

  res.json(thread);
});

// ---------------- modify labels (optimistic, write-through to queue) ----------------
//
// Goes through the mutation queue: local DB updates instantly, Gmail
// call drains in the background. Renderer gets a sub-millisecond
// response and the badge / chip changes are visible immediately.
//
// Resolves label NAMES → rawIds via the local labels table (no
// gmail.labels.list round-trip).
router.patch('/emails/:id/labels', requireAuth, (req, res) => {
  const prefixedId = req.params.id;
  const { account } = parseId(prefixedId);
  if (!account) return res.status(400).json({ error: 'email id must be prefixed with account:' });
  if (!req.oauth2Clients[account]) return res.status(401).json({ error: `account not active: ${account}` });

  const { addLabels = [], removeLabels = [] } = req.body;
  const SYSTEM = new Set(['INBOX', 'SENT', 'DRAFT', 'SPAM', 'TRASH', 'UNREAD', 'STARRED', 'IMPORTANT']);
  const accountLabels = labelsRepo.forAccount(account);
  const resolve = (arr) => {
    const out = [];
    for (const label of arr) {
      if (typeof label !== 'string') continue;
      const { id: maybeId } = parseId(label);
      if (SYSTEM.has(maybeId)) { out.push(maybeId); continue; }
      const found = accountLabels.find(l => l.raw_id === maybeId || l.name === maybeId || l.name === label);
      if (found) out.push(found.raw_id);
    }
    return out;
  };
  const addRawIds = resolve(addLabels);
  const removeRawIds = resolve(removeLabels);
  applyAndEnqueueModify(prefixedId, addRawIds, removeRawIds);
  // Return the threads' current labels (post-local-apply) so the
  // renderer can keep its existing optimistic-UI logic happy.
  const labelsNow = threadsRepo.labelsOf(prefixedId);
  res.json({ success: true, account, labels: labelsNow });
});

// ---------------- mark read / unread (optimistic, write-through to queue) ----------------
router.patch('/emails/:id/read', requireAuth, (req, res) => {
  const prefixedId = req.params.id;
  const { account } = parseId(prefixedId);
  if (!account) return res.status(400).json({ error: 'email id must be prefixed with account:' });
  if (!req.oauth2Clients[account]) return res.status(401).json({ error: `account not active: ${account}` });
  const { isRead } = req.body;
  applyAndEnqueueMarkRead(prefixedId, !!isRead);
  res.json({ success: true, account, isRead: !!isRead });
});

// ---------------- reply (account from id) ----------------
router.post('/threads/:id/reply', requireAuth, async (req, res) => {
  const { account, id } = parseId(req.params.id);
  if (!account) return res.status(400).json({ error: 'thread id must be prefixed with account:' });
  const client = req.oauth2Clients[account];
  if (!client) return res.status(401).json({ error: `account not active: ${account}` });
  try {
    const gmail = getGmailClient(client);
    const { body, to: overrideTo } = req.body || {};
    if (!body || typeof body !== 'string') {
      return res.status(400).json({ error: 'body required (plain text string)' });
    }
    const threadResp = await gmail.users.threads.get({
      userId: 'me', id, format: 'metadata',
      metadataHeaders: ['From', 'To', 'Cc', 'Subject', 'Message-ID', 'References'],
    });
    const messages = threadResp.data.messages || [];
    if (!messages.length) return res.status(404).json({ error: 'thread empty' });
    const latest = messages[messages.length - 1];
    const headers = latest.payload?.headers || [];
    const getHeader = (n) => headers.find(x => x.name.toLowerCase() === n.toLowerCase())?.value || '';

    const messageId = getHeader('Message-ID');
    const refs = getHeader('References');
    const subj = getHeader('Subject') || '';
    const replySubject = /^re:/i.test(subj.trim()) ? subj : `Re: ${subj}`;
    const to = overrideTo || getHeader('From');

    const profile = await gmail.users.getProfile({ userId: 'me' });
    const fromAddr = profile.data.emailAddress;
    const newReferences = [refs, messageId].filter(Boolean).join(' ').trim();

    const rfcLines = [
      `To: ${to}`,
      `From: ${fromAddr}`,
      `Subject: ${replySubject}`,
      messageId ? `In-Reply-To: ${messageId}` : null,
      newReferences ? `References: ${newReferences}` : null,
      `Content-Type: text/plain; charset="UTF-8"`,
      `MIME-Version: 1.0`,
      '',
      body,
    ].filter(l => l !== null);
    const raw = Buffer.from(rfcLines.join('\r\n'), 'utf-8').toString('base64')
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

    const sendResp = await gmail.users.messages.send({
      userId: 'me',
      requestBody: { raw, threadId: id },
    });
    res.json({
      success: true,
      account,
      id: `${account}:${sendResp.data.id}`,
      threadId: `${account}:${sendResp.data.threadId}`,
    });
  } catch (err) {
    handleGmailError(err, res, 'send reply', account);
  }
});

// ---------------- unsubscribe ----------------
// POST /threads/:threadId/messages/:msgId/unsubscribe
//
// Reads the message's List-Unsubscribe / List-Unsubscribe-Post headers
// (re-fetching server-side so the client doesn't need to send anything
// sensitive) and performs the best available action:
//
//   1. RFC 8058 one-click (List-Unsubscribe-Post: List-Unsubscribe=One-Click)
//      → backend POSTs the form body to the http URL. No user interaction.
//   2. mailto: → backend sends an empty Gmail message to that address.
//   3. http(s) only → backend returns the URL and `{ method: 'open' }`
//      so the frontend can open it in a new tab.
//
// Response shape: { method, ok, url?, status?, body? }
//   - method: 'oneclick' | 'mailto' | 'open' | 'none'
//   - ok: true if action completed (or open URL returned)
//   - status/body: HTTP details when method=='oneclick' for debugging
router.post('/threads/:threadId/messages/:msgId/unsubscribe', requireAuth, async (req, res) => {
  const { account, id: threadId } = parseId(req.params.threadId);
  const { id: msgId } = parseId(req.params.msgId);
  if (!account) return res.status(400).json({ error: 'threadId must be prefixed with account:' });
  const client = req.oauth2Clients[account];
  if (!client) return res.status(401).json({ error: `account not active: ${account}` });
  try {
    const gmail = getGmailClient(client);
    // Pull just the relevant headers — full body is fetched again
    // below only if we need the html-body fallback.
    const headResp = await gmail.users.messages.get({
      userId: 'me', id: msgId, format: 'metadata',
      metadataHeaders: ['List-Unsubscribe', 'List-Unsubscribe-Post'],
    });
    const headers = headResp.data.payload?.headers || [];
    const h = (n) => headers.find(x => x.name.toLowerCase() === n.toLowerCase())?.value || '';
    let info = extractUnsubscribe(h('List-Unsubscribe'), h('List-Unsubscribe-Post'), null);
    if (!info) {
      // Fall back to full-body scrape — slower but salvages many
      // newsletters that don't bother with the proper header.
      const full = await gmail.users.messages.get({ userId: 'me', id: msgId, format: 'full' });
      const parsed = parseMessage(account, full.data);
      info = parsed.unsubscribe;
    }
    if (!info) return res.status(404).json({ method: 'none', ok: false, error: 'no unsubscribe info found' });

    // 1. RFC 8058 one-click
    if (info.oneClick && info.http) {
      const r = await fetch(info.http, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: 'List-Unsubscribe=One-Click',
      });
      const text = await r.text().catch(() => '');
      return res.json({
        method: 'oneclick', ok: r.ok,
        status: r.status,
        body: text.slice(0, 500),
        url: info.http,
      });
    }

    // 2. mailto:
    if (info.mailto) {
      const profile = await gmail.users.getProfile({ userId: 'me' });
      const fromAddr = profile.data.emailAddress;
      // Per RFC 2369: subject + body are sender-defined. "unsubscribe"
      // is the de facto convention and many list managers parse it.
      const rfc = [
        `To: ${info.mailto}`,
        `From: ${fromAddr}`,
        `Subject: unsubscribe`,
        `Content-Type: text/plain; charset="UTF-8"`,
        `MIME-Version: 1.0`,
        '',
        'unsubscribe',
      ].join('\r\n');
      const raw = Buffer.from(rfc, 'utf-8').toString('base64')
        .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const sendResp = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
      return res.json({
        method: 'mailto', ok: true,
        url: `mailto:${info.mailto}`,
        sentId: `${account}:${sendResp.data.id}`,
      });
    }

    // 3. open-in-browser only
    if (info.http) {
      return res.json({ method: 'open', ok: true, url: info.http });
    }
    return res.status(404).json({ method: 'none', ok: false, error: 'unsubscribe info had no actionable url' });
  } catch (err) {
    handleGmailError(err, res, 'unsubscribe', account);
  }
});

// ---------------- filters / rules ----------------
// List, create, delete Gmail filters (a.k.a. rules). Multi-account
// aware: list fans out and tags each rule with `.account`; create
// requires ?account=email; delete requires the prefixed id
// `<account>:<gmailFilterId>`.

router.get('/filters', requireAuth, async (req, res) => {
  const targets = clientsFor(req);
  const all = [];
  await Promise.all(Object.entries(targets).map(async ([account, client]) => {
    try {
      const r = await getGmailClient(client).users.settings.filters.list({ userId: 'me' });
      for (const f of r.data.filter || []) {
        all.push({
          id: `${account}:${f.id}`,
          rawId: f.id,
          account,
          criteria: f.criteria || {},
          action: f.action || {},
        });
      }
    } catch (err) {
      if (err.message?.includes('invalid_grant')) dropAccountForInvalidGrant(account);
      // Most likely missing scope — surface that to the frontend.
      const code = err?.response?.status ?? err?.code;
      if (code === 403) {
        all.push({ account, error: 'missing_scope', message: 'gmail.settings.basic scope not granted. Re-auth this account from the chip.' });
      } else {
        console.warn(`[filters list] ${account}:`, err.message);
        all.push({ account, error: 'list_failed', message: err.message });
      }
    }
  }));
  res.json(all);
});

router.post('/filters', requireAuth, async (req, res) => {
  const account = typeof req.query.account === 'string' ? req.query.account.toLowerCase() : '';
  const client = req.oauth2Clients[account];
  if (!client) return res.status(400).json({ error: 'specify ?account=email' });
  const { criteria, action } = req.body || {};
  if (!criteria || typeof criteria !== 'object') return res.status(400).json({ error: 'criteria object required' });
  if (!action || typeof action !== 'object') return res.status(400).json({ error: 'action object required' });
  try {
    const r = await getGmailClient(client).users.settings.filters.create({
      userId: 'me',
      requestBody: { criteria, action },
    });
    res.json({ success: true, id: `${account}:${r.data.id}`, rawId: r.data.id, account });
  } catch (err) {
    handleGmailError(err, res, 'create filter', account);
  }
});

router.delete('/filters/:id', requireAuth, async (req, res) => {
  const { account, id } = parseId(req.params.id);
  if (!account) return res.status(400).json({ error: 'filter id must be prefixed with account:' });
  const client = req.oauth2Clients[account];
  if (!client) return res.status(401).json({ error: `account not active: ${account}` });
  try {
    await getGmailClient(client).users.settings.filters.delete({ userId: 'me', id });
    res.json({ success: true, account, id });
  } catch (err) {
    handleGmailError(err, res, 'delete filter', account);
  }
});

export default router;

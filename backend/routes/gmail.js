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

// Parse a Gmail message into the same flat shape we used in single-account
// mode, with id/threadId prefixed by `account:`.
function parseMessage(account, message) {
  const headers = message.payload?.headers || [];
  const getHeader = (name) => headers.find(h => h.name.toLowerCase() === name.toLowerCase())?.value || '';

  let body = '', bodyHtml = '';
  const snippet = message.snippet || '';

  const findParts = (payload) => {
    const out = { text: null, html: null };
    if (payload.mimeType === 'text/plain' && payload.body?.data) {
      out.text = Buffer.from(payload.body.data, 'base64').toString('utf-8');
    } else if (payload.mimeType === 'text/html' && payload.body?.data) {
      out.html = Buffer.from(payload.body.data, 'base64').toString('utf-8');
    } else if (payload.parts) {
      for (const part of payload.parts) {
        const r = findParts(part);
        if (r.text) out.text = r.text;
        if (r.html) out.html = r.html;
      }
    }
    return out;
  };

  if (message.payload) {
    if (message.payload.body?.data) {
      const content = Buffer.from(message.payload.body.data, 'base64').toString('utf-8');
      if (message.payload.mimeType === 'text/html') bodyHtml = content;
      else body = content;
    } else if (message.payload.parts) {
      const p = findParts(message.payload);
      body = p.text || ''; bodyHtml = p.html || '';
    }
  }

  const fromHeader = getHeader('From');
  const fromMatch = fromHeader.match(/^(.+?)\s*<(.+?)>$/) || [null, fromHeader, fromHeader];
  const hasAttachment = message.payload?.parts?.some(p => p.filename && p.filename.length > 0) || false;

  return {
    id: `${account}:${message.id}`,
    threadId: `${account}:${message.threadId}`,
    account,
    from: {
      name: fromMatch[1]?.replace(/"/g, '').trim() || fromMatch[2],
      email: fromMatch[2] || fromHeader,
      avatar: null,
    },
    to: getHeader('To'),
    subject: getHeader('Subject') || '(no subject)',
    snippet,
    body,
    bodyHtml,
    date: getHeader('Date'),
    labels: message.labelIds || [],
    isRead: !message.labelIds?.includes('UNREAD'),
    isStarred: message.labelIds?.includes('STARRED'),
    hasAttachment,
    unsubscribe: extractUnsubscribe(getHeader('List-Unsubscribe'), getHeader('List-Unsubscribe-Post'), bodyHtml),
  };
}

// Pull unsubscribe metadata out of the RFC 2369 List-Unsubscribe +
// RFC 8058 List-Unsubscribe-Post headers, with a body-scan fallback
// for senders that only embed an unsubscribe link in the HTML footer.
//
// Returns null when nothing is found. Otherwise:
//   { http?: string,    // first https/http URL we saw
//     mailto?: string,  // first mailto: address we saw
//     oneClick: boolean,// RFC 8058 — server may POST to http with no UI
//     source: 'header' | 'body' }
//
// The frontend renders an "Unsubscribe" button whenever this is non-
// null; the backend /unsubscribe endpoint decides what to actually do
// (POST for one-click, send mailto, or hand the URL back so the
// browser can open it in a new tab).
function extractUnsubscribe(listHeader, postHeader, html) {
  const out = { oneClick: false, source: 'header' };
  if (listHeader) {
    // Header looks like `<mailto:foo@bar>, <https://baz/quux>` —
    // multiple `<...>` values separated by commas. Pick the first
    // mailto and the first http(s) we see.
    const matches = listHeader.match(/<([^>]+)>/g) || [];
    for (const raw of matches) {
      const v = raw.slice(1, -1).trim();
      if (!out.mailto && v.toLowerCase().startsWith('mailto:')) out.mailto = v.slice(7);
      else if (!out.http && /^https?:/i.test(v)) out.http = v;
    }
    if (postHeader && /one-click/i.test(postHeader)) out.oneClick = true;
    if (out.mailto || out.http) return out;
  }
  // Fallback: scrape the HTML body for an unsubscribe-looking link.
  // Cheap regex — we accept some false positives because the worst case
  // is a button that opens a wrong page in a new tab.
  if (html) {
    const m = html.match(/href\s*=\s*["']([^"']*unsubscrib[^"']*)["']/i);
    if (m && /^https?:/i.test(m[1])) {
      return { http: m[1], oneClick: false, source: 'body' };
    }
  }
  return null;
}

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
  const targets = clientsFor(req);
  const all = [];
  await Promise.all(Object.entries(targets).map(async ([account, client]) => {
    try {
      const r = await getGmailClient(client).users.labels.list({ userId: 'me' });
      const labels = (r.data.labels || [])
        .filter(l => l.type === 'user' || ['INBOX', 'STARRED', 'IMPORTANT'].includes(l.id))
        .map(l => ({
          id: `${account}:${l.id}`,
          rawId: l.id,
          account,
          name: l.name,
          type: l.type,
          color: l.color?.backgroundColor || null,
        }));
      all.push(...labels);
    } catch (err) {
      if (err.message?.includes('invalid_grant')) dropAccountForInvalidGrant(account);
      console.warn(`[labels] ${account}:`, err.message);
    }
  }));
  res.json(all);
});

// ---------------- thread list (fan out + merge) ----------------
router.get('/emails', requireAuth, async (req, res) => {
  const targets = clientsFor(req);
  const { maxResults = 100, q = '' } = req.query;
  const perAcct = Math.max(1, Math.floor(parseInt(maxResults) / Math.max(1, Object.keys(targets).length)));

  const merged = [];
  await Promise.all(Object.entries(targets).map(async ([account, client]) => {
    try {
      const gmail = getGmailClient(client);
      const listResp = await gmail.users.threads.list({ userId: 'me', maxResults: perAcct, q });
      const threads = listResp.data.threads || [];
      const batchSize = 10;
      for (let i = 0; i < threads.length; i += batchSize) {
        const batch = threads.slice(i, i + batchSize);
        const fulls = await Promise.all(batch.map(t => gmail.users.threads.get({ userId: 'me', id: t.id, format: 'full' })));
        for (const result of fulls) {
          const thread = result.data;
          const messages = thread.messages || [];
          if (!messages.length) continue;
          const parsedMessages = messages.map(m => parseMessage(account, m));
          const allLabels = new Set();
          messages.forEach(m => (m.labelIds || []).forEach(l => allLabels.add(l)));
          const latest = parsedMessages[parsedMessages.length - 1];
          merged.push({
            id: `${account}:${thread.id}`,
            threadId: `${account}:${thread.id}`,
            account,
            messageCount: messages.length,
            from: latest.from,
            to: latest.to,
            subject: latest.subject,
            snippet: latest.snippet,
            date: latest.date,
            labels: Array.from(allLabels),
            isRead: !allLabels.has('UNREAD'),
            isStarred: allLabels.has('STARRED'),
            hasAttachment: parsedMessages.some(m => m.hasAttachment),
            messages: parsedMessages,
            originalFrom: parseMessage(account, messages[0]).from,
          });
        }
      }
    } catch (err) {
      if (err.message?.includes('invalid_grant')) dropAccountForInvalidGrant(account);
      console.warn(`[emails] ${account}:`, err.message);
    }
  }));

  // Sort by date desc so the frontend gets a sensible merge order.
  merged.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  res.json({ emails: merged, nextPageToken: null, resultSizeEstimate: merged.length });
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
  const targets = clientsFor(req);
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const labelIdsRaw = typeof req.query.labelIds === 'string' ? req.query.labelIds : '';
  const labelName = typeof req.query.labelName === 'string' ? req.query.labelName : '';

  // perAccount[email] = array of rawLabelIds to require (PLUS UNREAD).
  const perAccount = {};

  if (labelName) {
    // Resolve the name to a label id on every account that has it.
    await Promise.all(Object.entries(targets).map(async ([account, client]) => {
      try {
        const r = await getGmailClient(client).users.labels.list({ userId: 'me' });
        const found = (r.data.labels || []).find(l => l.name === labelName);
        if (found) (perAccount[account] ||= []).push(found.id);
      } catch (err) {
        if (err.message?.includes('invalid_grant')) dropAccountForInvalidGrant(account);
        console.warn(`[unread-count] label resolve ${account}:`, err.message);
      }
    }));
  } else if (labelIdsRaw) {
    const ids = labelIdsRaw.split(',').map(s => s.trim()).filter(Boolean);
    for (const id of ids) {
      const { account, id: rawId } = parseId(id);
      if (account) {
        (perAccount[account] ||= []).push(rawId);
      } else {
        // System label (INBOX, STARRED, etc.) — applies to every account.
        for (const acct of Object.keys(targets)) (perAccount[acct] ||= []).push(rawId);
      }
    }
  } else {
    // No label filter — q-only across all accounts.
    for (const acct of Object.keys(targets)) perAccount[acct] = [];
  }

  let total = 0;
  const breakdown = {};
  await Promise.all(Object.entries(perAccount).map(async ([account, rawIds]) => {
    const client = targets[account];
    if (!client) return;
    try {
      // Prefer users.labels.get(labelId).threadsUnread — Gmail's own
      // sidebar number, exact. Avoid users.threads.list's
      // resultSizeEstimate, which is wildly inflated for label+UNREAD
      // queries (often returns the total threads in the label, not
      // just unread). When a q parameter is supplied OR the caller
      // asked for multiple labels (intersection), fall back to
      // threads.list because labels.get only knows one label at a time.
      if (!q && rawIds.length === 1) {
        const lbl = await getGmailClient(client).users.labels.get({ userId: 'me', id: rawIds[0] });
        const c = lbl.data.threadsUnread || 0;
        breakdown[account] = c;
        total += c;
      } else if (!q && rawIds.length === 0) {
        // No label filter AND no q — count ALL unread.
        const lbl = await getGmailClient(client).users.labels.get({ userId: 'me', id: 'UNREAD' });
        const c = lbl.data.threadsUnread || 0;
        breakdown[account] = c;
        total += c;
      } else {
        // Multi-label intersection or text query: fall back to list
        // pagination — count IDs to avoid the inflated estimate. Capped
        // at 500 to keep this from being a quota nightmare.
        let c = 0;
        let pageToken;
        for (let pages = 0; pages < 5; pages++) {
          const r = await getGmailClient(client).users.threads.list({
            userId: 'me', maxResults: 100, q,
            labelIds: [...rawIds, 'UNREAD'],
            pageToken,
          });
          c += (r.data.threads?.length || 0);
          pageToken = r.data.nextPageToken;
          if (!pageToken) break;
        }
        breakdown[account] = c;
        total += c;
      }
    } catch (err) {
      if (err.message?.includes('invalid_grant')) dropAccountForInvalidGrant(account);
      breakdown[account] = 0;
      console.warn(`[unread-count] ${account}:`, err.message);
    }
  }));
  res.json({ count: total, breakdown });
});

// ---------------- single thread (account inferred from prefixed id) ----------------
router.get('/threads/:id', requireAuth, async (req, res) => {
  const { account, id } = parseId(req.params.id);
  if (!account) return res.status(400).json({ error: 'thread id must be prefixed with account:' });
  const client = req.oauth2Clients[account];
  if (!client) return res.status(401).json({ error: `account not active: ${account}` });
  try {
    const response = await getGmailClient(client).users.threads.get({ userId: 'me', id, format: 'full' });
    const messages = response.data.messages || [];
    if (messages.length === 0) return res.json(null);
    const parsedMessages = messages.map(m => parseMessage(account, m));
    const allLabels = new Set();
    messages.forEach(m => (m.labelIds || []).forEach(l => allLabels.add(l)));
    const latest = parsedMessages[parsedMessages.length - 1];
    res.json({
      id: `${account}:${response.data.id}`,
      threadId: `${account}:${response.data.id}`,
      account,
      messageCount: messages.length,
      from: latest.from,
      to: latest.to,
      subject: latest.subject,
      snippet: latest.snippet,
      date: latest.date,
      labels: Array.from(allLabels),
      isRead: !allLabels.has('UNREAD'),
      isStarred: allLabels.has('STARRED'),
      hasAttachment: parsedMessages.some(m => m.hasAttachment),
      messages: parsedMessages,
      originalFrom: parseMessage(account, messages[0]).from,
    });
  } catch (err) {
    handleGmailError(err, res, 'fetch thread', account);
  }
});

// ---------------- modify labels (account from id) ----------------
router.patch('/emails/:id/labels', requireAuth, async (req, res) => {
  const { account, id } = parseId(req.params.id);
  if (!account) return res.status(400).json({ error: 'email id must be prefixed with account:' });
  const client = req.oauth2Clients[account];
  if (!client) return res.status(401).json({ error: `account not active: ${account}` });

  try {
    const gmail = getGmailClient(client);
    const { addLabels = [], removeLabels = [] } = req.body;

    // Resolve label names to ids on THIS account.
    const labelsResponse = await gmail.users.labels.list({ userId: 'me' });
    const allLabels = labelsResponse.data.labels || [];
    const SYSTEM = new Set(['INBOX', 'SENT', 'DRAFT', 'SPAM', 'TRASH', 'UNREAD', 'STARRED', 'IMPORTANT']);
    const resolve = (arr) => arr.map(label => {
      if (typeof label !== 'string') return null;
      // Accept account:id, plain id, or plain name.
      const { id: maybeId } = parseId(label);
      if (SYSTEM.has(maybeId)) return maybeId;
      const found = allLabels.find(l => l.id === maybeId || l.name === maybeId || l.name === label);
      return found ? found.id : null;
    }).filter(Boolean);

    const addLabelIds = resolve(addLabels);
    const removeLabelIds = resolve(removeLabels);

    try {
      const r = await gmail.users.threads.modify({
        userId: 'me', id, requestBody: { addLabelIds, removeLabelIds },
      });
      res.json({ success: true, account, labels: r.data.messages?.[0]?.labelIds || [] });
    } catch {
      const r = await gmail.users.messages.modify({
        userId: 'me', id, requestBody: { addLabelIds, removeLabelIds },
      });
      res.json({ success: true, account, labels: r.data.labelIds });
    }
  } catch (err) {
    handleGmailError(err, res, 'update labels', account);
  }
});

// ---------------- mark read / unread (account from id) ----------------
router.patch('/emails/:id/read', requireAuth, async (req, res) => {
  const { account, id } = parseId(req.params.id);
  if (!account) return res.status(400).json({ error: 'email id must be prefixed with account:' });
  const client = req.oauth2Clients[account];
  if (!client) return res.status(401).json({ error: `account not active: ${account}` });
  try {
    const gmail = getGmailClient(client);
    const { isRead } = req.body;
    const body = isRead ? { removeLabelIds: ['UNREAD'] } : { addLabelIds: ['UNREAD'] };
    try { await gmail.users.threads.modify({ userId: 'me', id, requestBody: body }); }
    catch { await gmail.users.messages.modify({ userId: 'me', id, requestBody: body }); }
    res.json({ success: true, account, isRead });
  } catch (err) {
    handleGmailError(err, res, 'update read status', account);
  }
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

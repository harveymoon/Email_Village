// Town Inbox — Gmail message parsing helpers.
//
// Extracted from routes/gmail.js so the legacy on-demand routes AND the
// new sync engine (backend/services/syncEngine.js) can share one
// implementation. The two existing exports preserve the exact shape the
// frontend already relies on; new code should prefer parseMessageMeta /
// parseThreadMeta which return DB-row-shaped objects.

// Decode a base64url Gmail body part into UTF-8.
function decodeBody(b64) {
  return Buffer.from(b64, 'base64').toString('utf-8');
}

// Walk a Gmail payload tree, returning the FIRST text/plain + text/html
// bodies we find. Multipart messages typically nest these inside
// multipart/alternative branches; the parts walker pulls them out
// regardless of depth.
function findBodyParts(payload) {
  const out = { text: null, html: null };
  function visit(p) {
    if (!p) return;
    if (p.mimeType === 'text/plain' && p.body?.data && out.text == null) {
      out.text = decodeBody(p.body.data);
    } else if (p.mimeType === 'text/html' && p.body?.data && out.html == null) {
      out.html = decodeBody(p.body.data);
    } else if (Array.isArray(p.parts)) {
      for (const child of p.parts) visit(child);
    }
  }
  visit(payload);
  return out;
}

function getHeader(headers, name) {
  return headers?.find(h => h.name?.toLowerCase() === name.toLowerCase())?.value || '';
}

function parseFrom(rawFrom) {
  const m = rawFrom.match(/^(.+?)\s*<(.+?)>$/);
  if (m) return { name: m[1].replace(/"/g, '').trim() || m[2], email: m[2] };
  return { name: rawFrom, email: rawFrom };
}

// Pull unsubscribe metadata out of RFC 2369 List-Unsubscribe +
// RFC 8058 List-Unsubscribe-Post headers, falling back to a regex
// scrape of the HTML body for the (still-common) senders who omit the
// headers. Returns null when there's nothing actionable.
export function extractUnsubscribe(listHeader, postHeader, html) {
  const out = { oneClick: false, source: 'header' };
  if (listHeader) {
    const matches = listHeader.match(/<([^>]+)>/g) || [];
    for (const raw of matches) {
      const v = raw.slice(1, -1).trim();
      if (!out.mailto && v.toLowerCase().startsWith('mailto:')) out.mailto = v.slice(7);
      else if (!out.http && /^https?:/i.test(v)) out.http = v;
    }
    if (postHeader && /one-click/i.test(postHeader)) out.oneClick = true;
    if (out.mailto || out.http) return out;
  }
  if (html) {
    const m = html.match(/href\s*=\s*["']([^"']*unsubscrib[^"']*)["']/i);
    if (m && /^https?:/i.test(m[1])) {
      return { http: m[1], oneClick: false, source: 'body' };
    }
  }
  return null;
}

// Common header walk + body extraction for one Gmail message. Both
// parseMessage (legacy frontend shape) and parseMessageMeta (DB-row
// shape used by the sync engine) call this and reshape the result.
// Centralising the From/Date/Unsubscribe logic prevents the slow drift
// that started to creep in between the two earlier variants.
function parseMessageBase(account, message, opts = {}) {
  const headers = message.payload?.headers || [];
  const labelIds = message.labelIds || [];
  const fromHeader = getHeader(headers, 'From');
  const from = parseFrom(fromHeader);
  const dateStr = getHeader(headers, 'Date');
  const dateMs = dateStr ? Date.parse(dateStr) || 0 : 0;
  const hasAttachment = !!message.payload?.parts?.some(p => p.filename && p.filename.length > 0);
  let body = '', bodyHtml = '';
  if (opts.withBody && message.payload) {
    if (message.payload.body?.data) {
      const content = decodeBody(message.payload.body.data);
      if (message.payload.mimeType === 'text/html') bodyHtml = content;
      else body = content;
    } else if (message.payload.parts) {
      const p = findBodyParts(message.payload);
      body = p.text || ''; bodyHtml = p.html || '';
    }
  }
  const unsubscribe = extractUnsubscribe(
    getHeader(headers, 'List-Unsubscribe'),
    getHeader(headers, 'List-Unsubscribe-Post'),
    opts.withBody ? bodyHtml : null,
  );
  return {
    headers, labelIds, from, dateStr, dateMs, hasAttachment, body, bodyHtml, unsubscribe,
  };
}

// LEGACY: existing shape consumed by routes/gmail.js single-thread
// fetch route. Kept until the renderer stops calling /api/threads/:id
// in favour of an IPC-backed DB read (deferred F.2 work).
export function parseMessage(account, message) {
  const base = parseMessageBase(account, message, { withBody: true });
  return {
    id: `${account}:${message.id}`,
    threadId: `${account}:${message.threadId}`,
    account,
    from: { name: base.from.name, email: base.from.email, avatar: null },
    to: getHeader(base.headers, 'To'),
    subject: getHeader(base.headers, 'Subject') || '(no subject)',
    snippet: message.snippet || '',
    body: base.body,
    bodyHtml: base.bodyHtml,
    date: base.dateStr,
    labels: base.labelIds,
    isRead: !base.labelIds.includes('UNREAD'),
    isStarred: base.labelIds.includes('STARRED'),
    hasAttachment: base.hasAttachment,
    unsubscribe: base.unsubscribe,
  };
}

// DB-row-shaped per-message metadata. Used by the sync engine when
// batching threads.get(format='metadata'). Body fields stay null.
export function parseMessageMeta(account, message) {
  const base = parseMessageBase(account, message, { withBody: false });
  return {
    id: `${account}:${message.id}`,
    thread_id: `${account}:${message.threadId}`,
    account,
    from_email: base.from.email?.toLowerCase() || null,
    from_name: base.from.name || null,
    to_header: getHeader(base.headers, 'To') || null,
    date: base.dateMs,
    snippet: message.snippet || null,
    is_read: !base.labelIds.includes('UNREAD'),
    has_attachment: base.hasAttachment,
    unsubscribe_json: base.unsubscribe ? JSON.stringify(base.unsubscribe) : null,
  };
}

// NEW: aggregate a Gmail thread response into the thread + messages
// rows we want in the DB. `thread` is the response from
// users.threads.get with at least format='metadata'. Returns:
//   { thread: <threadsRepo row>, messages: <messagesRepo rows>, labelRawIds: string[] }
export function parseThreadMeta(account, thread) {
  const messages = (thread.messages || []).map(m => parseMessageMeta(account, m));
  // Roll labels up: a thread "has" any label that any of its messages
  // has. Mirrors Gmail's own behaviour — threads inherit the union of
  // their messages' labels.
  const labelSet = new Set();
  for (const m of thread.messages || []) {
    for (const lid of (m.labelIds || [])) labelSet.add(lid);
  }
  const allLabels = [...labelSet];
  const latest = thread.messages?.[thread.messages.length - 1];
  const latestHeaders = latest?.payload?.headers || [];
  const fromHeader = getHeader(latestHeaders, 'From');
  const fromMatch = parseFrom(fromHeader);
  const dateMs = (() => {
    const d = getHeader(latestHeaders, 'Date');
    return d ? Date.parse(d) || 0 : 0;
  })();
  // Thread-level unsubscribe = take the first message that has one (most
  // newsletters include it on every message; we just need any one).
  let unsub = null;
  for (const m of thread.messages || []) {
    const hdrs = m.payload?.headers || [];
    const u = extractUnsubscribe(getHeader(hdrs, 'List-Unsubscribe'), getHeader(hdrs, 'List-Unsubscribe-Post'), null);
    if (u) { unsub = u; break; }
  }
  return {
    thread: {
      id: `${account}:${thread.id}`,
      account,
      gmail_id: thread.id,
      subject: getHeader(latestHeaders, 'Subject') || null,
      from_email: fromMatch.email?.toLowerCase() || null,
      from_name: fromMatch.name || null,
      snippet: latest?.snippet || thread.snippet || null,
      date: dateMs,
      is_read: !allLabels.includes('UNREAD'),
      is_starred: allLabels.includes('STARRED'),
      message_count: messages.length,
      has_attachment: messages.some(m => m.has_attachment),
      unsubscribe_json: unsub ? JSON.stringify(unsub) : null,
    },
    messages,
    labelRawIds: allLabels,
  };
}

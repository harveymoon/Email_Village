// Town Inbox — repository functions over the SQLite store.
//
// Thin wrappers around prepared statements. ONE place per query so
// callers (sync engine, IPC handlers, mutation queue) don't sprinkle
// SQL across the codebase.
//
// Naming convention: <noun>Repo = a namespaced object of related queries.
//
// Statements are prepared once at module load (better-sqlite3 caches the
// compiled SQL) so per-call cost is just bind + step.

import db from './index.js';

const now = () => Date.now();

// ---------- accounts ----------
const accountsStmts = {
  upsert: db.prepare(`
    INSERT INTO accounts(email, history_id, last_full_sync_at, backfill_total, backfill_done, created_at, updated_at)
    VALUES (@email, @history_id, @last_full_sync_at, @backfill_total, @backfill_done, @ts, @ts)
    ON CONFLICT(email) DO UPDATE SET
      history_id        = COALESCE(excluded.history_id, accounts.history_id),
      last_full_sync_at = COALESCE(excluded.last_full_sync_at, accounts.last_full_sync_at),
      backfill_total    = COALESCE(excluded.backfill_total, accounts.backfill_total),
      backfill_done     = COALESCE(excluded.backfill_done, accounts.backfill_done),
      updated_at        = excluded.updated_at
  `),
  get: db.prepare(`SELECT * FROM accounts WHERE email = ?`),
  all: db.prepare(`SELECT * FROM accounts`),
  remove: db.prepare(`DELETE FROM accounts WHERE email = ?`),
  setHistoryId: db.prepare(`UPDATE accounts SET history_id = ?, updated_at = ? WHERE email = ?`),
  incBackfillDone: db.prepare(`UPDATE accounts SET backfill_done = backfill_done + ?, updated_at = ? WHERE email = ?`),
};

export const accountsRepo = {
  ensure(email) {
    accountsStmts.upsert.run({
      email,
      history_id: null,
      last_full_sync_at: null,
      backfill_total: null,
      backfill_done: 0,
      ts: now(),
    });
  },
  get: (email) => accountsStmts.get.get(email),
  all: () => accountsStmts.all.all(),
  remove: (email) => accountsStmts.remove.run(email),
  setHistoryId: (email, historyId) => accountsStmts.setHistoryId.run(historyId, now(), email),
  markBackfillStart(email, total) {
    accountsStmts.upsert.run({
      email,
      history_id: null,
      last_full_sync_at: null,
      backfill_total: total,
      backfill_done: 0,
      ts: now(),
    });
  },
  bumpBackfillDone: (email, delta) => accountsStmts.incBackfillDone.run(delta, now(), email),
  markBackfillComplete(email, historyId) {
    accountsStmts.upsert.run({
      email,
      history_id: historyId,
      last_full_sync_at: now(),
      backfill_total: null,    // COALESCE so existing total stays if present
      backfill_done: null,
      ts: now(),
    });
  },
};

// ---------- labels ----------
const labelsStmts = {
  upsert: db.prepare(`
    INSERT INTO labels(account, raw_id, name, type, threads_total, threads_unread, updated_at)
    VALUES (@account, @raw_id, @name, @type, @threads_total, @threads_unread, @ts)
    ON CONFLICT(account, raw_id) DO UPDATE SET
      name           = excluded.name,
      type           = excluded.type,
      threads_total  = excluded.threads_total,
      threads_unread = excluded.threads_unread,
      updated_at     = excluded.updated_at
  `),
  forAccount: db.prepare(`SELECT * FROM labels WHERE account = ?`),
  all: db.prepare(`SELECT * FROM labels`),
  byName: db.prepare(`SELECT * FROM labels WHERE account = ? AND name = ?`),
  remove: db.prepare(`DELETE FROM labels WHERE account = ? AND raw_id = ?`),
};

export const labelsRepo = {
  upsert(account, label) {
    labelsStmts.upsert.run({
      account,
      raw_id: label.id || label.raw_id,
      name: label.name,
      type: label.type || null,
      threads_total: label.threadsTotal ?? null,
      threads_unread: label.threadsUnread ?? null,
      ts: now(),
    });
  },
  upsertMany: db.transaction((account, list) => {
    for (const l of list) labelsRepo.upsert(account, l);
  }),
  forAccount: (account) => labelsStmts.forAccount.all(account),
  all: () => labelsStmts.all.all(),
  byName: (account, name) => labelsStmts.byName.get(account, name),
  remove: (account, rawId) => labelsStmts.remove.run(account, rawId),
};

// ---------- threads + thread_labels ----------
const threadsStmts = {
  upsert: db.prepare(`
    INSERT INTO threads(
      id, account, gmail_id, subject, from_email, from_name, snippet, date,
      is_read, is_starred, message_count, has_attachment, unsubscribe_json, updated_at
    ) VALUES (
      @id, @account, @gmail_id, @subject, @from_email, @from_name, @snippet, @date,
      @is_read, @is_starred, @message_count, @has_attachment, @unsubscribe_json, @ts
    )
    ON CONFLICT(id) DO UPDATE SET
      subject          = excluded.subject,
      from_email       = excluded.from_email,
      from_name        = excluded.from_name,
      snippet          = excluded.snippet,
      date             = excluded.date,
      is_read          = excluded.is_read,
      is_starred       = excluded.is_starred,
      message_count    = excluded.message_count,
      has_attachment   = excluded.has_attachment,
      unsubscribe_json = excluded.unsubscribe_json,
      updated_at       = excluded.updated_at
  `),
  setReadFlag: db.prepare(`UPDATE threads SET is_read = ?, updated_at = ? WHERE id = ?`),
  remove: db.prepare(`DELETE FROM threads WHERE id = ?`),
  removeLabelsForThread: db.prepare(`DELETE FROM thread_labels WHERE thread_id = ?`),
  removeOneLabel: db.prepare(`DELETE FROM thread_labels WHERE thread_id = ? AND raw_id = ?`),
  insertLabel: db.prepare(`INSERT OR IGNORE INTO thread_labels(thread_id, raw_id) VALUES (?, ?)`),
  getById: db.prepare(`SELECT * FROM threads WHERE id = ?`),
  count: db.prepare(`SELECT COUNT(*) AS n FROM threads`),
  countForAccount: db.prepare(`SELECT COUNT(*) AS n FROM threads WHERE account = ?`),
  labelsOf: db.prepare(`SELECT raw_id FROM thread_labels WHERE thread_id = ?`),
};

export const threadsRepo = {
  /**
   * Insert/update a thread row with the given metadata + replace its
   * thread_labels with `rawLabelIds`. Single transaction so a partial
   * write can't leave label rows referencing a half-baked thread.
   */
  upsertWithLabels: db.transaction((thread, rawLabelIds) => {
    const ts = now();
    threadsStmts.upsert.run({
      id: thread.id,
      account: thread.account,
      gmail_id: thread.gmail_id,
      subject: thread.subject ?? null,
      from_email: thread.from_email ?? null,
      from_name: thread.from_name ?? null,
      snippet: thread.snippet ?? null,
      date: thread.date ?? 0,
      is_read: thread.is_read ? 1 : 0,
      is_starred: thread.is_starred ? 1 : 0,
      message_count: thread.message_count ?? 1,
      has_attachment: thread.has_attachment ? 1 : 0,
      unsubscribe_json: thread.unsubscribe_json ?? null,
      ts,
    });
    threadsStmts.removeLabelsForThread.run(thread.id);
    for (const rid of rawLabelIds) threadsStmts.insertLabel.run(thread.id, rid);
  }),
  /**
   * Apply a label delta to an existing thread (history-list driven).
   * Cheaper than a full re-upsert when we only know labels changed.
   */
  applyLabelDelta: db.transaction((threadId, addedRawIds, removedRawIds) => {
    for (const rid of removedRawIds || []) threadsStmts.removeOneLabel.run(threadId, rid);
    for (const rid of addedRawIds || []) threadsStmts.insertLabel.run(threadId, rid);
    // Touch updated_at so listeners can detect the change cheaply later.
    db.prepare(`UPDATE threads SET updated_at = ? WHERE id = ?`).run(now(), threadId);
  }),
  setReadFlag: (threadId, isRead) => threadsStmts.setReadFlag.run(isRead ? 1 : 0, now(), threadId),
  remove: db.transaction((threadId) => {
    threadsStmts.removeLabelsForThread.run(threadId);
    db.prepare(`DELETE FROM messages WHERE thread_id = ?`).run(threadId);
    threadsStmts.remove.run(threadId);
  }),
  getById: (id) => threadsStmts.getById.get(id),
  labelsOf: (id) => threadsStmts.labelsOf.all(id).map(r => r.raw_id),
  count: () => threadsStmts.count.get().n,
  countForAccount: (account) => threadsStmts.countForAccount.get(account).n,
};

// ---------- messages ----------
const messagesStmts = {
  upsertMeta: db.prepare(`
    INSERT INTO messages(
      id, thread_id, account, from_email, from_name, to_header, date, snippet,
      body, body_html, is_read, has_attachment, unsubscribe_json, fetched_at, updated_at
    ) VALUES (
      @id, @thread_id, @account, @from_email, @from_name, @to_header, @date, @snippet,
      NULL, NULL, @is_read, @has_attachment, @unsubscribe_json, NULL, @ts
    )
    ON CONFLICT(id) DO UPDATE SET
      from_email       = excluded.from_email,
      from_name        = excluded.from_name,
      to_header        = excluded.to_header,
      date             = excluded.date,
      snippet          = excluded.snippet,
      is_read          = excluded.is_read,
      has_attachment   = excluded.has_attachment,
      unsubscribe_json = excluded.unsubscribe_json,
      updated_at       = excluded.updated_at
      -- Note: body / body_html / fetched_at intentionally NOT touched
      -- here. Metadata refresh shouldn't blow away a cached body.
  `),
  saveBody: db.prepare(`
    UPDATE messages
       SET body = ?, body_html = ?, fetched_at = ?, updated_at = ?
     WHERE id = ?
  `),
  getById: db.prepare(`SELECT * FROM messages WHERE id = ?`),
  forThread: db.prepare(`SELECT * FROM messages WHERE thread_id = ? ORDER BY date ASC`),
};

export const messagesRepo = {
  upsertMeta(meta) {
    const ts = now();
    messagesStmts.upsertMeta.run({
      id: meta.id,
      thread_id: meta.thread_id,
      account: meta.account,
      from_email: meta.from_email ?? null,
      from_name: meta.from_name ?? null,
      to_header: meta.to_header ?? null,
      date: meta.date ?? 0,
      snippet: meta.snippet ?? null,
      is_read: meta.is_read ? 1 : 0,
      has_attachment: meta.has_attachment ? 1 : 0,
      unsubscribe_json: meta.unsubscribe_json ?? null,
      ts,
    });
  },
  upsertManyMeta: db.transaction((list) => {
    for (const m of list) messagesRepo.upsertMeta(m);
  }),
  saveBody(id, body, bodyHtml) {
    messagesStmts.saveBody.run(body ?? null, bodyHtml ?? null, now(), now(), id);
  },
  getById: (id) => messagesStmts.getById.get(id),
  forThread: (threadId) => messagesStmts.forThread.all(threadId),
};

// ---------- list/aggregate queries (read-side) ----------
//
// All return rows shaped as close as possible to what the legacy
// /api/emails endpoint returned, so the renderer keeps working without
// changes. Body fields stay empty in list views — the renderer fetches
// bodies via /api/threads/:id only when the user actually opens a
// thread, which triggers the lazy body fetch in routes/gmail.js.

const listStmts = {
  // Threads carrying ANY label whose name matches (exact or "<name>/..."
  // prefix). Returns one row per thread; aggregates labels via GROUP_CONCAT.
  // ORDER BY date DESC matches Gmail's default newest-first.
  byLabelName: db.prepare(`
    SELECT DISTINCT t.*,
                    (SELECT GROUP_CONCAT(raw_id) FROM thread_labels WHERE thread_id = t.id) AS labels_concat
      FROM threads t
      JOIN thread_labels tl ON tl.thread_id = t.id
      JOIN labels l         ON l.account = t.account AND l.raw_id = tl.raw_id
     WHERE l.name = ? OR l.name LIKE ? || '/%'
     ORDER BY t.date DESC
     LIMIT ? OFFSET ?
  `),
  bySender: db.prepare(`
    SELECT t.*,
           (SELECT GROUP_CONCAT(raw_id) FROM thread_labels WHERE thread_id = t.id) AS labels_concat
      FROM threads t
     WHERE t.from_email = LOWER(?)
     ORDER BY t.date DESC
     LIMIT ? OFFSET ?
  `),
  allRecent: db.prepare(`
    SELECT t.*,
           (SELECT GROUP_CONCAT(raw_id) FROM thread_labels WHERE thread_id = t.id) AS labels_concat
      FROM threads t
     ORDER BY t.date DESC
     LIMIT ? OFFSET ?
  `),
  unreadCountByLabel: db.prepare(`
    SELECT COUNT(DISTINCT t.id) AS n
      FROM threads t
      JOIN thread_labels tl ON tl.thread_id = t.id
      JOIN labels l         ON l.account = t.account AND l.raw_id = tl.raw_id
     WHERE (l.name = @name OR l.name LIKE @name || '/%')
       AND t.is_read = 0
  `),
  unreadCountBySystemLabel: db.prepare(`
    SELECT COUNT(*) AS n
      FROM threads t
      JOIN thread_labels tl ON tl.thread_id = t.id
     WHERE tl.raw_id = ?
       AND t.is_read = 0
  `),
  unreadCountAll: db.prepare(`SELECT COUNT(*) AS n FROM threads WHERE is_read = 0`),
  // Per-sender aggregate for the People grid. Counts only consider
  // visible threads (anything in our DB), grouped by lowercased sender.
  peopleAggregate: db.prepare(`
    SELECT from_email AS email,
           MAX(from_name) AS name,
           COUNT(*) AS total,
           SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread,
           MAX(date) AS latest_date
      FROM threads
     WHERE from_email IS NOT NULL AND from_email <> ''
     GROUP BY from_email
     ORDER BY unread DESC, total DESC
  `),
};

// Helper: hydrate `labels_concat` into a real array, and attach a
// messages array (metadata-only) so the response shape matches the
// legacy parseMessage output. Body fields stay empty in list mode.
function hydrateThread(row) {
  if (!row) return null;
  const messages = messagesStmts.forThread.all(row.id).map(m => ({
    id: m.id,
    threadId: m.thread_id,
    account: m.account,
    from: { name: m.from_name, email: m.from_email, avatar: null },
    to: m.to_header || '',
    subject: row.subject || '',
    snippet: m.snippet || '',
    body: m.body || '',
    bodyHtml: m.body_html || '',
    date: m.date ? new Date(m.date).toISOString() : '',
    labels: [],                  // per-message labels not tracked separately — see thread.labels
    isRead: !!m.is_read,
    isStarred: !!row.is_starred,
    hasAttachment: !!m.has_attachment,
    unsubscribe: m.unsubscribe_json ? JSON.parse(m.unsubscribe_json) : null,
  }));
  return {
    id: row.id,
    threadId: row.id,
    account: row.account,
    messageCount: row.message_count,
    from: { name: row.from_name, email: row.from_email, avatar: null },
    to: messages[messages.length - 1]?.to || '',
    subject: row.subject || '(no subject)',
    snippet: row.snippet || '',
    date: row.date ? new Date(row.date).toISOString() : '',
    labels: (row.labels_concat || '').split(',').filter(Boolean),
    isRead: !!row.is_read,
    isStarred: !!row.is_starred,
    hasAttachment: !!row.has_attachment,
    messages,
    originalFrom: messages[0]?.from || { name: row.from_name, email: row.from_email, avatar: null },
    unsubscribe: row.unsubscribe_json ? JSON.parse(row.unsubscribe_json) : null,
  };
}

export const queryRepo = {
  threadsByLabelName(name, { limit = 1000, offset = 0 } = {}) {
    return listStmts.byLabelName.all(name, name, limit, offset).map(hydrateThread);
  },
  threadsBySender(email, { limit = 5000, offset = 0 } = {}) {
    return listStmts.bySender.all(email, limit, offset).map(hydrateThread);
  },
  recentThreads({ limit = 200, offset = 0 } = {}) {
    return listStmts.allRecent.all(limit, offset).map(hydrateThread);
  },
  fullThread(id) {
    const row = threadsStmts.getById.get(id);
    if (!row) return null;
    row.labels_concat = threadsRepo.labelsOf(id).join(',');
    return hydrateThread(row);
  },
  unreadCountByLabelName(name) {
    return listStmts.unreadCountByLabel.get({ name })?.n ?? 0;
  },
  unreadCountBySystemRawId(rawId) {
    return listStmts.unreadCountBySystemLabel.get(rawId)?.n ?? 0;
  },
  unreadCountAll() {
    return listStmts.unreadCountAll.get()?.n ?? 0;
  },
  peopleAggregate() {
    return listStmts.peopleAggregate.all();
  },
};

// ---------- mutation_queue ----------
const queueStmts = {
  enqueueModify: db.prepare(`
    INSERT INTO mutation_queue(thread_id, op, add_labels_json, remove_labels_json, status, created_at)
    VALUES (?, 'modify', ?, ?, 'pending', ?)
  `),
  enqueueMarkRead: db.prepare(`
    INSERT INTO mutation_queue(thread_id, op, is_read, status, created_at)
    VALUES (?, 'markRead', ?, 'pending', ?)
  `),
  pickPending: db.prepare(`
    SELECT * FROM mutation_queue
     WHERE status = 'pending'
     ORDER BY created_at ASC
     LIMIT ?
  `),
  markInflight: db.prepare(`UPDATE mutation_queue SET status = 'inflight', last_attempt_at = ? WHERE id = ?`),
  markFailed: db.prepare(`UPDATE mutation_queue SET status = 'failed', attempts = attempts + 1, last_error = ?, last_attempt_at = ? WHERE id = ?`),
  bumpRetry: db.prepare(`UPDATE mutation_queue SET status = 'pending', attempts = attempts + 1, last_error = ?, last_attempt_at = ? WHERE id = ?`),
  remove: db.prepare(`DELETE FROM mutation_queue WHERE id = ?`),
  countPending: db.prepare(`SELECT COUNT(*) AS n FROM mutation_queue WHERE status = 'pending'`),
};

export const mutationQueueRepo = {
  enqueueModify(threadId, addRawIds, removeRawIds) {
    queueStmts.enqueueModify.run(
      threadId,
      JSON.stringify(addRawIds || []),
      JSON.stringify(removeRawIds || []),
      now(),
    );
  },
  enqueueMarkRead(threadId, isRead) {
    queueStmts.enqueueMarkRead.run(threadId, isRead ? 1 : 0, now());
  },
  pickPending: (n = 10) => queueStmts.pickPending.all(n),
  markInflight: (id) => queueStmts.markInflight.run(now(), id),
  markFailed: (id, err) => queueStmts.markFailed.run(String(err).slice(0, 500), now(), id),
  bumpRetry: (id, err) => queueStmts.bumpRetry.run(String(err).slice(0, 500), now(), id),
  remove: (id) => queueStmts.remove.run(id),
  countPending: () => queueStmts.countPending.get().n,
};

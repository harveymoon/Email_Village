-- Town Inbox — initial schema (v1).
--
-- Local store for every Gmail thread metadata across every authenticated
-- account. Bodies are LAZY: the messages table holds NULL body/body_html
-- until a thread is opened for the first time, at which point the main
-- process fetches via the Gmail API and writes through. Cached forever
-- after, invalidated only when the row is deleted via history sync.
--
-- All ids are PREFIXED with "<account-email>:" to disambiguate across
-- accounts that may share Gmail rawIds.

CREATE TABLE IF NOT EXISTS accounts (
  email                TEXT PRIMARY KEY,                  -- lowercase, e.g. "harvey@spectra.studio"
  history_id           TEXT,                              -- last historyId we synced past
  last_full_sync_at    INTEGER,                           -- unix ms; NULL means backfill still pending
  backfill_total       INTEGER,                           -- Gmail's threadsTotal at backfill start, for progress reporting
  backfill_done        INTEGER NOT NULL DEFAULT 0,        -- threads upserted so far
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
);

-- Per-account label catalogue. Mirrors Gmail's users.labels.list. We
-- store both the rawId (e.g. "Label_3851234") and the human name. The
-- pair (account, raw_id) is unique. Frontend resolves rawIds on thread
-- rows to names via this table.
CREATE TABLE IF NOT EXISTS labels (
  account              TEXT NOT NULL,
  raw_id               TEXT NOT NULL,                     -- "Label_xxx" or system label like "INBOX"
  name                 TEXT NOT NULL,                     -- "Newsletters/Patreon", "INBOX", etc.
  type                 TEXT,                              -- "system" | "user"
  threads_total        INTEGER,                           -- Gmail's reported total (informational)
  threads_unread       INTEGER,                           -- Gmail's reported unread count
  updated_at           INTEGER NOT NULL,
  PRIMARY KEY(account, raw_id)
);
CREATE INDEX IF NOT EXISTS labels_name ON labels(name);

-- Thread metadata. One row per Gmail thread per account. messages stores
-- per-message bodies separately so the index stays compact.
CREATE TABLE IF NOT EXISTS threads (
  id                   TEXT PRIMARY KEY,                  -- "<account>:<gmailThreadId>"
  account              TEXT NOT NULL,
  gmail_id             TEXT NOT NULL,                     -- bare gmail thread id
  subject              TEXT,
  from_email           TEXT,
  from_name            TEXT,
  snippet              TEXT,
  date                 INTEGER,                           -- unix ms; falls back to 0 when header missing
  is_read              INTEGER NOT NULL DEFAULT 1,        -- 1 if UNREAD label is NOT present
  is_starred           INTEGER NOT NULL DEFAULT 0,
  message_count        INTEGER NOT NULL DEFAULT 1,
  has_attachment       INTEGER NOT NULL DEFAULT 0,
  unsubscribe_json     TEXT,                              -- serialised { http?, mailto?, oneClick, source } or NULL
  updated_at           INTEGER NOT NULL                   -- last time we touched this row
);
CREATE INDEX IF NOT EXISTS threads_account_date ON threads(account, date DESC);
CREATE INDEX IF NOT EXISTS threads_from_email ON threads(from_email);
-- Partial index — only unread rows participate. Massively faster for
-- "show me all unread of label X" queries when most mail is read.
CREATE INDEX IF NOT EXISTS threads_unread ON threads(account, is_read) WHERE is_read = 0;

-- Many-to-many: thread → its labels (raw Gmail ids). Updated on every
-- modify/sync. Cascade-delete when the thread is removed.
CREATE TABLE IF NOT EXISTS thread_labels (
  thread_id            TEXT NOT NULL,
  raw_id               TEXT NOT NULL,                     -- references labels.raw_id but no FK so history events that arrive before label refresh don't fail
  PRIMARY KEY(thread_id, raw_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS thread_labels_raw_id ON thread_labels(raw_id);

-- Per-message rows. id = "<account>:<gmailMessageId>". body + body_html
-- start NULL and get backfilled on first thread open.
CREATE TABLE IF NOT EXISTS messages (
  id                   TEXT PRIMARY KEY,
  thread_id            TEXT NOT NULL,
  account              TEXT NOT NULL,
  from_email           TEXT,
  from_name            TEXT,
  to_header            TEXT,
  date                 INTEGER,
  snippet              TEXT,
  body                 TEXT,                              -- NULL until lazy fetch
  body_html            TEXT,                              -- NULL until lazy fetch
  is_read              INTEGER NOT NULL DEFAULT 1,
  has_attachment       INTEGER NOT NULL DEFAULT 0,
  unsubscribe_json     TEXT,
  fetched_at           INTEGER,                           -- NULL until first full body fetch
  updated_at           INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_thread_id ON messages(thread_id);

-- Optimistic mutation queue. Renderer writes to the local DB FIRST, then
-- inserts a row here so a background drain worker can push the change
-- to Gmail. Persisted in the same DB so an unclean shutdown doesn't
-- lose pending operations. Row is deleted on successful sync.
CREATE TABLE IF NOT EXISTS mutation_queue (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  thread_id            TEXT NOT NULL,                     -- prefixed id; account inferred
  op                   TEXT NOT NULL,                     -- 'modify' | 'markRead'
  add_labels_json      TEXT,                              -- JSON array of rawIds to add (modify only)
  remove_labels_json   TEXT,                              -- JSON array of rawIds to remove (modify only)
  is_read              INTEGER,                           -- 0|1 for markRead op
  attempts             INTEGER NOT NULL DEFAULT 0,
  status               TEXT NOT NULL DEFAULT 'pending',   -- 'pending' | 'inflight' | 'failed'
  last_error           TEXT,
  created_at           INTEGER NOT NULL,
  last_attempt_at      INTEGER
);
CREATE INDEX IF NOT EXISTS mutation_queue_status_created
  ON mutation_queue(status, created_at);

-- Schema version. Every migration bumps this so future runs know what to
-- apply. 1 = this file.
CREATE TABLE IF NOT EXISTS schema_meta (
  key                  TEXT PRIMARY KEY,
  value                TEXT
);
INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('version', '1');

-- Town Inbox — settings + gameplay state migration to SQLite (v2).
--
-- The renderer was persisting building bindings, avatar configs, and
-- person overrides in localStorage. These survive page reload but get
-- wiped on every origin change (Vite dev → packaged Electron, two
-- different machines, browser cleanup, etc.). They belong with the
-- threads + labels they refer to, in the same SQLite store.
--
-- Migration is one-way: the renderer copies legacy localStorage keys
-- here on first launch after this schema lands, then deletes them.
-- All subsequent reads/writes go through the new HTTP routes.

CREATE TABLE IF NOT EXISTS building_bindings (
  building_id   INTEGER PRIMARY KEY,           -- Tiled object id, stable across reloads
  custom_name   TEXT,                          -- NULL = keep the default Tiled name
  labels_json   TEXT NOT NULL DEFAULT '[]',    -- JSON array of Gmail label NAMES (not raw ids)
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS avatars (
  email         TEXT PRIMARY KEY,              -- lowercased; "__player__@local" for the player
  body          TEXT,
  eyes          TEXT,
  outfit        TEXT,
  hairstyle     TEXT,
  accessory     TEXT,
  updated_at    INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS people_overrides (
  email         TEXT PRIMARY KEY,              -- lowercased
  name          TEXT,                          -- display-name override
  char_key      TEXT,                          -- character-builder key
  notes         TEXT,                          -- freeform notes
  emails_json   TEXT,                          -- additional contact emails (JSON array)
  phones_json   TEXT,                          -- phone numbers (JSON array)
  urls_json     TEXT,                          -- links (JSON array)
  birthday      TEXT,
  extra_json    TEXT,                          -- future-proof catch-all
  updated_at    INTEGER NOT NULL
);

INSERT OR REPLACE INTO schema_meta(key, value) VALUES ('version', '2');

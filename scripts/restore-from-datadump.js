// Town Inbox — one-shot recovery: read dataDump.json (the user's
// pre-migration localStorage export) and upsert every relevant entry
// straight into the SQLite store. Bypasses the renderer + API entirely.
//
// Run with: node scripts/restore-from-datadump.js
//
// Idempotent — re-runs just refresh the rows. Will refuse to run if
// the DB is locked (TownInbox.exe still open); kill it first.

const fs = require('node:fs');
const path = require('node:path');

const DATA_DUMP = path.resolve(__dirname, '..', 'dataDump.json');
// The packaged Electron app puts its DB under %APPDATA%/town-inbox/town.db
// (Electron's app.getPath('userData') with product name "town-inbox"
// from package.json). Override via TOWN_INBOX_DATA_DIR if needed.
const dataDir = process.env.TOWN_INBOX_DATA_DIR
  || path.join(process.env.APPDATA || path.join(require('os').homedir(), 'AppData', 'Roaming'), 'town-inbox');
const DB_PATH = path.join(dataDir, 'town.db');

if (!fs.existsSync(DATA_DUMP)) {
  console.error(`dataDump.json not found at ${DATA_DUMP}`);
  process.exit(1);
}
if (!fs.existsSync(DB_PATH)) {
  console.error(`town.db not found at ${DB_PATH} — launch TownInbox.exe once to create the DB, then quit and re-run this script.`);
  process.exit(1);
}

// Use the backend's better-sqlite3 (same binding the .exe uses) so we
// don't need a separate install.
const Database = require(path.resolve(__dirname, '..', 'backend', 'node_modules', 'better-sqlite3'));
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

const dump = JSON.parse(fs.readFileSync(DATA_DUMP, 'utf8'));
const parse = (k) => { try { return JSON.parse(dump[k] || 'null') ?? null; } catch { return null; } };

const now = Date.now();

// ---- Building bindings ----
// dataDump has separate name + label maps; merge into the new schema's
// one-row-per-building shape.
const names = parse('little_town.building_names') || {};
const labelsV2 = parse('little_town.building_labels_v2') || {};
const labelsV1 = parse('little_town.building_labels') || {};
// v1 stored a single name; convert to the array shape v2 uses.
const v1Asv2 = Object.fromEntries(
  Object.entries(labelsV1).filter(([, n]) => !!n).map(([id, n]) => [id, [n]]),
);
const mergedLabels = { ...v1Asv2, ...labelsV2 };
const allIds = new Set([...Object.keys(names), ...Object.keys(mergedLabels)]);
const upsertBuilding = db.prepare(`
  INSERT INTO building_bindings(building_id, custom_name, labels_json, updated_at)
  VALUES (?, ?, ?, ?)
  ON CONFLICT(building_id) DO UPDATE SET
    custom_name = excluded.custom_name,
    labels_json = excluded.labels_json,
    updated_at = excluded.updated_at
`);
let bn = 0;
for (const id of allIds) {
  const cn = names[id] || null;
  const ls = mergedLabels[id] || [];
  upsertBuilding.run(Number(id), cn, JSON.stringify(ls), now);
  bn++;
}
console.log(`✓ buildings: restored ${bn} bindings`);

// ---- Avatars ----
const avatars = parse('little_town.avatars') || {};
const upsertAvatar = db.prepare(`
  INSERT INTO avatars(email, body, eyes, outfit, hairstyle, accessory, updated_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(email) DO UPDATE SET
    body = excluded.body, eyes = excluded.eyes, outfit = excluded.outfit,
    hairstyle = excluded.hairstyle, accessory = excluded.accessory,
    updated_at = excluded.updated_at
`);
let an = 0;
for (const [email, cfg] of Object.entries(avatars)) {
  if (!cfg || typeof cfg !== 'object') continue;
  upsertAvatar.run(
    email.toLowerCase(),
    cfg.body || null, cfg.eyes || null, cfg.outfit || null,
    cfg.hairstyle || null, cfg.accessory || null,
    now,
  );
  an++;
}
console.log(`✓ avatars: restored ${an} entries`);

// ---- People overrides ----
const people = parse('little_town.people') || {};
const upsertPerson = db.prepare(`
  INSERT INTO people_overrides(
    email, name, char_key, notes, emails_json, phones_json, urls_json,
    birthday, extra_json, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(email) DO UPDATE SET
    name = excluded.name, char_key = excluded.char_key, notes = excluded.notes,
    emails_json = excluded.emails_json, phones_json = excluded.phones_json,
    urls_json = excluded.urls_json, birthday = excluded.birthday,
    extra_json = excluded.extra_json, updated_at = excluded.updated_at
`);
let pn = 0;
for (const [email, ov] of Object.entries(people)) {
  if (!ov || typeof ov !== 'object') continue;
  upsertPerson.run(
    email.toLowerCase(),
    ov.name || null, ov.charKey || null, ov.notes || null,
    ov.emails ? JSON.stringify(ov.emails) : null,
    ov.phones ? JSON.stringify(ov.phones) : null,
    ov.urls ? JSON.stringify(ov.urls) : null,
    ov.birthday || null,
    null,    // extra_json — nothing legacy used this
    now,
  );
  pn++;
}
console.log(`✓ people-overrides: restored ${pn} entries`);

db.close();
console.log(`\nDone. Re-launch TownInbox.exe and the buildings + avatars + people overrides should be back.`);

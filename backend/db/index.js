// Town Inbox — SQLite connection + migration runner.
//
// One shared better-sqlite3 instance, WAL mode for concurrent reader
// safety (Electron main process + backend Express child can both open
// the same DB file safely in WAL).
//
// DB location resolution:
//   1. TOWN_INBOX_DATA_DIR env (set by electron/main.cjs when packaged)
//   2. ~/.town-inbox (dev fallback; cheap to wipe by deleting the dir)
// The Electron main process sets TOWN_INBOX_DATA_DIR to app.getPath('userData')
// before spawning the backend, so packaged installs land under
// %APPDATA%\\EmailVillage on Windows, ~/Library/Application Support/Town Inbox
// on macOS, and ~/.config/Town Inbox on Linux.

import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

function resolveDataDir() {
  const envDir = process.env.TOWN_INBOX_DATA_DIR;
  if (envDir && envDir.trim()) return envDir;
  // Dev / standalone fallback. Per-user but outside the repo so checkouts
  // don't clobber each other's local state.
  return path.join(os.homedir(), '.town-inbox');
}

const DATA_DIR = resolveDataDir();
fs.mkdirSync(DATA_DIR, { recursive: true });
const DB_PATH = path.join(DATA_DIR, 'town.db');

console.log(`[db] opening ${DB_PATH}`);
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');     // WAL + NORMAL gives durability up to the last fsync interval, with much faster writes
db.pragma('foreign_keys = ON');
db.pragma('temp_store = MEMORY');

// Run every migration .sql file in order, skipping ones already applied.
// Schema version lives in schema_meta. First-run installs apply 001
// which itself bootstraps schema_meta.
function migrate() {
  const migrationsDir = path.join(__dirname, 'migrations');
  const files = fs.readdirSync(migrationsDir).filter(f => /^\d+_.*\.sql$/.test(f)).sort();
  const currentVersion = (() => {
    try {
      const row = db.prepare("SELECT value FROM schema_meta WHERE key = 'version'").get();
      return row ? parseInt(row.value, 10) : 0;
    } catch {
      // schema_meta doesn't exist yet — pristine DB.
      return 0;
    }
  })();
  for (const file of files) {
    const version = parseInt(file.split('_')[0], 10);
    if (version <= currentVersion) continue;
    const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    console.log(`[db] applying migration ${file}`);
    db.exec(sql);
  }
}

migrate();

// Graceful close — Express doesn't exit cleanly on Ctrl-C without help,
// and an open WAL handle can leave a -wal file behind. Best effort.
process.on('exit', () => { try { db.close(); } catch {} });

export default db;
export { DATA_DIR, DB_PATH };

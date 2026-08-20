/**
 * SQLite persistence layer - better-sqlite3
 * 
 * CRITICAL: Database file persists across restarts.
 * - File lives at CONFIG.DB_PATH (./data/trades.db)
 * - WAL mode for durability + concurrency
 * - Created ONLY if it does not already exist
 * - Migrations use schema_version table
 * - initDb() is safe to run on every server start without destroying data
 */
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const CONFIG = require("./config");

let db = null;

function ensureDataDir() {
  const dir = path.dirname(path.resolve(CONFIG.DB_PATH));
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
    console.log(`[DB] Created data directory: ${dir}`);
  }
}

function getDb() {
  if (db) return db;

  ensureDataDir();

  const dbPath = path.resolve(CONFIG.DB_PATH);
  const isNewFile = !fs.existsSync(dbPath);

  db = new Database(dbPath);

  // WAL mode for durability and better concurrent reads
  // This is a persistent setting stored in the DB file.
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  // Synchronous NORMAL is safe with WAL and faster
  db.pragma("synchronous = NORMAL");

  if (isNewFile) {
    console.log(`[DB] Created new database file at ${dbPath}`);
  } else {
    console.log(`[DB] Opened existing database at ${dbPath}`);
  }

  // Ensure schema_version table exists first (before any other tables)
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  runMigrations(db);

  return db;
}

// --- Migrations ---
// Each migration runs once. Add new ones to the end of the array.
// Never modify an already-applied migration.

const MIGRATIONS = [
  {
    version: 1,
    description: "Create trades table",
    sql: `
      CREATE TABLE IF NOT EXISTS trades (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        asset TEXT NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('long', 'short')),
        outcome TEXT NOT NULL CHECK(outcome IN ('win', 'loss', 'breakeven')),
        pnl_cents INTEGER NOT NULL,
        mode TEXT NOT NULL CHECK(mode IN ('real', 'demo')),
        notes TEXT,
        timestamp_utc TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE INDEX IF NOT EXISTS idx_trades_timestamp ON trades(timestamp_utc);
      CREATE INDEX IF NOT EXISTS idx_trades_mode ON trades(mode);
      CREATE INDEX IF NOT EXISTS idx_trades_asset ON trades(asset);
    `,
  },
];

function runMigrations(database) {
  // Get current version (max applied)
  let currentVersion = 0;
  try {
    const row = database.prepare("SELECT MAX(version) as v FROM schema_version").get();
    currentVersion = row && row.v ? row.v : 0;
  } catch (e) {
    currentVersion = 0;
  }

  console.log(`[DB] Current schema version: ${currentVersion}`);

  const pending = MIGRATIONS.filter((m) => m.version > currentVersion).sort(
    (a, b) => a.version - b.version
  );

  if (pending.length === 0) {
    console.log("[DB] No pending migrations. Database is up to date.");
    return;
  }

  const insertVersion = database.prepare(
    "INSERT INTO schema_version (version, applied_at) VALUES (?, ?)"
  );

  // Run each migration in a transaction
  const migrate = database.transaction((migrations) => {
    for (const m of migrations) {
      console.log(`[DB] Applying migration v${m.version}: ${m.description}`);
      database.exec(m.sql);
      insertVersion.run(m.version, new Date().toISOString());
      console.log(`[DB] Migration v${m.version} applied.`);
    }
  });

  migrate(pending);
  console.log(`[DB] Migrations complete. New version: ${pending[pending.length - 1].version}`);
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
    console.log("[DB] Connection closed.");
  }
}

module.exports = { getDb, closeDb, ensureDataDir };

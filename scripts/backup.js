#!/usr/bin/env node
/**
 * Backup script for Trade Timing Journal
 *
 * Usage:
 *   npm run backup
 *   node scripts/backup.js
 *   node scripts/backup.js --path ./my-backup.db
 *
 * Uses SQLite's ONLINE BACKUP API (better-sqlite3 `db.backup()`), which is
 * WAL-aware: the copy is taken from a consistent snapshot of the database,
 * so it can never miss recent writes that are still sitting in the WAL file.
 * The backup is then opened read-only and verified (integrity check + row
 * count) before the script reports success.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const CONFIG = require("../config");

async function backup() {
  const dbPath = path.resolve(CONFIG.DB_PATH);
  const backupsDir = path.resolve("./backups");

  // Parse custom path arg
  const customArgIndex = process.argv.findIndex((a) => a === "--path");
  const customPath = customArgIndex !== -1 ? process.argv[customArgIndex + 1] : null;

  if (!fs.existsSync(dbPath)) {
    console.error(`[Backup] No database found at ${dbPath}`);
    console.error("         Start the app and create a trade first, then try again.");
    process.exit(1);
  }

  if (!fs.existsSync(backupsDir)) {
    fs.mkdirSync(backupsDir, { recursive: true });
    console.log(`[Backup] Created backups directory: ${backupsDir}`);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const defaultDest = path.join(backupsDir, `trades-backup-${timestamp}.db`);
  const dest = customPath ? path.resolve(customPath) : defaultDest;

  // Ensure dest dir exists
  const destDir = path.dirname(dest);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  const Database = require("better-sqlite3");

  // Use the SQLite backup API: consistent snapshot even while the app runs.
  const source = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    if (fs.existsSync(dest)) fs.rmSync(dest); // backup API refuses an existing file
    await source.backup(dest);
  } catch (e) {
    source.close();
    console.error(`[Backup] Backup API failed: ${e.message}`);
    console.error("         Make sure the destination is writable and not locked.");
    process.exit(1);
  }
  source.close();
  console.log("[Backup] Online backup API completed (WAL-safe, consistent snapshot).");

  // Verify the backup: integrity check + row count.
  try {
    const check = new Database(dest, { readonly: true });
    const integrity = check.pragma("integrity_check", { simple: true });
    let count = null;
    try {
      count = check.prepare("SELECT COUNT(*) AS c FROM trades").get().c;
    } catch (e) {
      count = "n/a (no trades table)";
    }
    check.close();
    if (integrity !== "ok") {
      console.error(`[Backup] VERIFICATION FAILED: integrity_check returned ${integrity}`);
      process.exit(1);
    }
    console.log(`[Backup] Verified: integrity_check = ok, ${count} trade(s) in backup.`);
  } catch (e) {
    console.error(`[Backup] VERIFICATION FAILED: could not open the backup: ${e.message}`);
    process.exit(1);
  }

  const srcSize = fs.statSync(dbPath).size;
  const destSize = fs.statSync(dest).size;

  console.log(`\n✓ Backup complete!`);
  console.log(`  Source: ${dbPath} (${(srcSize / 1024).toFixed(1)} KB)`);
  console.log(`  Backup: ${dest} (${(destSize / 1024).toFixed(1)} KB)`);
  console.log(`\n  To restore: copy the backup file back to ${dbPath} while the server is stopped.`);
  console.log(`  Example: cp "${dest}" "${dbPath}"\n`);
}

backup().catch((err) => {
  console.error("[Backup] Unexpected error:", err);
  process.exit(1);
});

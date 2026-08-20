#!/usr/bin/env node
/**
 * Tiny backup script for Trade Timing Journal
 * 
 * Usage:
 *   npm run backup
 *   node scripts/backup.js
 *   node scripts/backup.js --path ./my-backup.db
 * 
 * Copies the live SQLite database file to backups/ with a timestamp.
 * WAL files are checkpointed first so the backup is consistent.
 */
const fs = require("fs");
const path = require("path");
const CONFIG = require("../config");

function backup() {
  const dbPath = path.resolve(CONFIG.DB_PATH);
  const backupsDir = path.resolve("./backups");

  // Parse custom path arg
  const customArgIndex = process.argv.findIndex(a => a === "--path");
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

  // Try to checkpoint WAL via better-sqlite3 if available
  try {
    const Database = require("better-sqlite3");
    const db = new Database(dbPath, { readonly: false });
    // Checkpoint WAL to main DB file so backup is complete
    db.pragma("wal_checkpoint(TRUNCATE)");
    db.close();
    console.log("[Backup] WAL checkpoint completed.");
  } catch (e) {
    console.warn("[Backup] Could not checkpoint WAL (DB may be in use). Copying anyway...");
    console.warn("         For a perfect backup, stop the server first. Warning:", e.message);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const defaultDest = path.join(backupsDir, `trades-backup-${timestamp}.db`);
  const dest = customPath ? path.resolve(customPath) : defaultDest;

  // Ensure dest dir exists
  const destDir = path.dirname(dest);
  if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

  fs.copyFileSync(dbPath, dest);

  const srcSize = fs.statSync(dbPath).size;
  const destSize = fs.statSync(dest).size;

  console.log(`\n✓ Backup complete!`);
  console.log(`  Source: ${dbPath} (${(srcSize/1024).toFixed(1)} KB)`);
  console.log(`  Backup: ${dest} (${(destSize/1024).toFixed(1)} KB)`);
  console.log(`\n  To restore: copy the backup file back to ${dbPath} while the server is stopped.`);
  console.log(`  Example: cp "${dest}" "${dbPath}"\n`);
}

backup();

/**
 * Trade Timing Journal - Express Server + CRUD API
 * 
 * Persistence guarantee:
 * - Every trade is written to SQLite (better-sqlite3) immediately.
 * - On server restart, data is loaded from the same file (data/trades.db).
 * - initDb() never deletes existing data.
 */
const express = require("express");
const cors = require("cors");
const path = require("path");
const CONFIG = require("./config");
const { getDb } = require("./db");
const { validateTrade, formatCents } = require("./validation");
const { computeAnalytics } = require("./analytics");

const app = express();

// Middleware
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

// Helper: format DB row for API response (convert cents -> display, keep cents too)
function formatTradeRow(row) {
  if (!row) return null;
  return {
    id: row.id,
    asset: row.asset,
    direction: row.direction,
    outcome: row.outcome,
    pnl_cents: row.pnl_cents,
    // Human-readable formatted money for display
    pnl_formatted: formatCents(row.pnl_cents),
    // Also expose numeric amount for convenience (dollars)
    amount: row.pnl_cents / 100,
    mode: row.mode,
    notes: row.notes,
    timestamp_utc: row.timestamp_utc,
    timestamp_local: row.timestamp_utc, // frontend will convert to configured timezone for display
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// --- API Routes ---

// Health check + config info
app.get("/api/health", (req, res) => {
  const db = getDb();
  const count = db.prepare("SELECT COUNT(*) as c FROM trades").get().c;
  const versionRow = db.prepare("SELECT MAX(version) as v FROM schema_version").get();
  res.json({
    status: "ok",
    timezone: CONFIG.TIMEZONE,
    db_path: path.resolve(CONFIG.DB_PATH),
    trade_count: count,
    schema_version: versionRow ? versionRow.v : 0,
  });
});

// Get timezone config (so frontend knows the fixed bucket timezone)
app.get("/api/config", (req, res) => {
  res.json({ timezone: CONFIG.TIMEZONE });
});

// List trades with optional mode filter
app.get("/api/trades", (req, res) => {
  const db = getDb();
  const mode = req.query.mode ? String(req.query.mode).toLowerCase() : "all";

  let rows;
  if (mode === "real" || mode === "demo") {
    rows = db
      .prepare("SELECT * FROM trades WHERE mode = ? ORDER BY timestamp_utc DESC, id DESC")
      .all(mode);
  } else if (mode === "all" || !mode) {
    rows = db.prepare("SELECT * FROM trades ORDER BY timestamp_utc DESC, id DESC").all();
  } else {
    return res.status(400).json({ error: "Invalid mode filter. Use real, demo, or all." });
  }

  res.json(rows.map(formatTradeRow));
});

// Get single trade
app.get("/api/trades/:id", (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid trade ID." });
  }
  const row = db.prepare("SELECT * FROM trades WHERE id = ?").get(id);
  if (!row) return res.status(404).json({ error: "Trade not found." });
  res.json(formatTradeRow(row));
});

// Create trade
app.post("/api/trades", (req, res) => {
  const { valid, errors, sanitized } = validateTrade(req.body, { partial: false });

  if (!valid) {
    return res.status(400).json({ error: "Validation failed.", details: errors });
  }

  const db = getDb();
  try {
    const stmt = db.prepare(`
      INSERT INTO trades (asset, direction, outcome, pnl_cents, mode, notes, timestamp_utc)
      VALUES (@asset, @direction, @outcome, @pnl_cents, @mode, @notes, @timestamp_utc)
    `);

    const info = stmt.run({
      asset: sanitized.asset,
      direction: sanitized.direction,
      outcome: sanitized.outcome,
      pnl_cents: sanitized.pnl_cents,
      mode: sanitized.mode,
      notes: sanitized.notes,
      timestamp_utc: sanitized.timestamp_utc,
    });

    const row = db.prepare("SELECT * FROM trades WHERE id = ?").get(info.lastInsertRowid);
    res.status(201).json(formatTradeRow(row));
  } catch (err) {
    console.error("[POST /api/trades] DB error:", err);
    res.status(500).json({ error: "Database error while creating trade." });
  }
});

// Update trade (full or partial)
app.put("/api/trades/:id", (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid trade ID." });
  }

  const existing = db.prepare("SELECT * FROM trades WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "Trade not found." });

  const { valid, errors, sanitized } = validateTrade(req.body, { partial: false });

  if (!valid) {
    return res.status(400).json({ error: "Validation failed.", details: errors });
  }

  try {
    const stmt = db.prepare(`
      UPDATE trades
      SET asset = @asset,
          direction = @direction,
          outcome = @outcome,
          pnl_cents = @pnl_cents,
          mode = @mode,
          notes = @notes,
          timestamp_utc = @timestamp_utc,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = @id
    `);

    stmt.run({
      id,
      asset: sanitized.asset,
      direction: sanitized.direction,
      outcome: sanitized.outcome,
      pnl_cents: sanitized.pnl_cents,
      mode: sanitized.mode,
      notes: sanitized.notes,
      timestamp_utc: sanitized.timestamp_utc,
    });

    const row = db.prepare("SELECT * FROM trades WHERE id = ?").get(id);
    res.json(formatTradeRow(row));
  } catch (err) {
    console.error("[PUT /api/trades/:id] DB error:", err);
    res.status(500).json({ error: "Database error while updating trade." });
  }
});

// Patch trade (partial update - for frontend edit convenience)
app.patch("/api/trades/:id", (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid trade ID." });
  }

  const existing = db.prepare("SELECT * FROM trades WHERE id = ?").get(id);
  if (!existing) return res.status(404).json({ error: "Trade not found." });

  // Merge existing with payload for validation, but allow partial
  // Simpler: validate only provided fields as partial
  const { valid, errors, sanitized } = validateTrade(req.body, { partial: true });
  if (!valid) {
    return res.status(400).json({ error: "Validation failed.", details: errors });
  }

  // Build dynamic update
  const fields = [];
  const params = { id };

  if (sanitized.asset !== undefined) { fields.push("asset = @asset"); params.asset = sanitized.asset; }
  if (sanitized.direction !== undefined) { fields.push("direction = @direction"); params.direction = sanitized.direction; }
  if (sanitized.outcome !== undefined) { fields.push("outcome = @outcome"); params.outcome = sanitized.outcome; }
  if (sanitized.pnl_cents !== undefined) { fields.push("pnl_cents = @pnl_cents"); params.pnl_cents = sanitized.pnl_cents; }
  if (sanitized.mode !== undefined) { fields.push("mode = @mode"); params.mode = sanitized.mode; }
  if (sanitized.notes !== undefined) { fields.push("notes = @notes"); params.notes = sanitized.notes; }
  if (sanitized.timestamp_utc !== undefined) { fields.push("timestamp_utc = @timestamp_utc"); params.timestamp_utc = sanitized.timestamp_utc; }

  if (fields.length === 0) {
    return res.status(400).json({ error: "No valid fields to update." });
  }

  fields.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')");

  try {
    const sql = `UPDATE trades SET ${fields.join(", ")} WHERE id = @id`;
    db.prepare(sql).run(params);
    const row = db.prepare("SELECT * FROM trades WHERE id = ?").get(id);
    res.json(formatTradeRow(row));
  } catch (err) {
    console.error("[PATCH /api/trades/:id] DB error:", err);
    res.status(500).json({ error: "Database error while patching trade." });
  }
});

// Delete trade
app.delete("/api/trades/:id", (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid trade ID." });
  }

  const info = db.prepare("DELETE FROM trades WHERE id = ?").run(id);
  if (info.changes === 0) {
    return res.status(404).json({ error: "Trade not found." });
  }
  res.json({ success: true, deleted_id: id });
});

// Analytics: computed server-side from SQLite on every request.
// Real and demo are separate blocks and are NEVER blended.
app.get("/api/analytics", (req, res) => {
  try {
    const db = getDb();
    const rows = db.prepare("SELECT * FROM trades").all();
    const result = computeAnalytics(rows);
    res.json({
      timezone: CONFIG.TIMEZONE,
      generated_at: new Date().toISOString(),
      thresholds: {
        minN: CONFIG.ANALYTICS.MIN_N,
        bestMinN: CONFIG.ANALYTICS.BEST_MIN_N,
        bestMarginPct: CONFIG.ANALYTICS.BEST_MARGIN * 100,
        bestSmallSampleN: CONFIG.ANALYTICS.BEST_SMALL_SAMPLE_N,
        wilsonZ: CONFIG.ANALYTICS.WILSON_Z,
      },
      real: result.real,
      demo: result.demo,
    });
  } catch (err) {
    console.error("[GET /api/analytics] Error:", err);
    res.status(500).json({ error: "Could not compute analytics." });
  }
});

// Fallback to index.html for SPA routes (if any)
app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Start the server only when this file is run directly (node server.js).
// When required by tests, the app is exported without listening.
if (require.main === module) {
  // Initialize DB before starting server (safe to run every time)
  getDb();

  const server = app.listen(CONFIG.PORT, "0.0.0.0", () => {
    console.log(`\n✓ Trade Timing Journal running at http://localhost:${CONFIG.PORT}`);
    console.log(`  Timezone (fixed): ${CONFIG.TIMEZONE}`);
    console.log(`  Database: ${path.resolve(CONFIG.DB_PATH)} (WAL mode, persistent)`);
    console.log(`  Health: http://localhost:${CONFIG.PORT}/api/health`);
    console.log(`  Analytics: http://localhost:${CONFIG.PORT}/api/analytics\n`);
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log("\n[Server] Shutting down...");
    server.close(() => {
      const { closeDb } = require("./db");
      closeDb();
      process.exit(0);
    });
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

module.exports = app;

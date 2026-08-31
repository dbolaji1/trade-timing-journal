/**
 * Trade Timing Journal - Express Server + CRUD API
 *
 * Persistence guarantee:
 * - Every trade is written to SQLite (better-sqlite3) immediately.
 * - On server restart, data is loaded from the same file (data/trades.db).
 * - initDb() never deletes existing data.
 * - Trade IDs are stable: they are never renumbered (see db.js).
 *
 * Security default:
 * - Listens on 127.0.0.1 only (this machine). Set TT_HOST=0.0.0.0 if you
 *   deliberately want other devices on your network to reach it.
 * - No open CORS policy: the UI is served from this same origin, so cross-
 *   origin requests are not needed. Remove the open CORS middleware.
 */
const express = require("express");
const path = require("path");
const multer = require("multer");
const CONFIG = require("./config");
const { getDb } = require("./db");
const { validateTrade, formatCents, derivePnlSign } = require("./validation");
const { computeAnalytics } = require("./analytics");
const { startOfDayUtc } = require("./time");
const {
  parseWorkbook,
  mapColumns,
  mappingCaveats,
  classifyRows,
  existingIdentitySet,
  dedupeKeys,
  MAX_FILE_BYTES,
} = require("./import");

const app = express();

// Middleware — same-origin UI, so no CORS middleware is needed.
app.use(express.json({ limit: "12mb" }));
app.use(express.static(path.join(__dirname, "public")));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_FILE_BYTES, files: 1 },
});

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
    // Also expose numeric amount for convenience (currency units)
    amount: row.pnl_cents / 100,
    stake_cents: row.stake_cents,
    stake_formatted: formatCents(row.stake_cents),
    stake: row.stake_cents === null || row.stake_cents === undefined ? null : row.stake_cents / 100,
    broker: row.broker,
    broker_trade_id: row.broker_trade_id,
    mode: row.mode,
    notes: row.notes,
    timestamp_utc: row.timestamp_utc,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

// Fields needed to restore a deleted trade with its original ID.
function restorePayload(row) {
  return {
    id: row.id,
    asset: row.asset,
    direction: row.direction,
    outcome: row.outcome,
    pnl_cents: row.pnl_cents,
    stake_cents: row.stake_cents,
    mode: row.mode,
    notes: row.notes,
    timestamp_utc: row.timestamp_utc,
    broker: row.broker,
    broker_trade_id: row.broker_trade_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

/* ---------- shared query builder (list + CSV export) ---------- */

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (m) => "\\" + m);
}

function buildTradeQuery(query) {
  const where = [];
  const params = [];
  const mode = query.mode ? String(query.mode).toLowerCase() : "all";
  if (mode === "real" || mode === "demo") {
    where.push("mode = ?");
    params.push(mode);
  } else if (mode !== "all") {
    return { error: "Invalid mode filter. Use real, demo, or all." };
  }

  if (query.outcome) {
    const outcome = String(query.outcome).toLowerCase();
    if (!["win", "loss", "breakeven"].includes(outcome)) {
      return { error: "Invalid outcome filter. Use win, loss, or breakeven." };
    }
    where.push("outcome = ?");
    params.push(outcome);
  }

  if (query.asset) {
    where.push("asset LIKE ? ESCAPE '\\'");
    params.push("%" + escapeLike(query.asset).toUpperCase() + "%");
  }

  if (query.q) {
    where.push("(asset LIKE ? ESCAPE '\\' OR COALESCE(notes, '') LIKE ? ESCAPE '\\')");
    const like = "%" + escapeLike(query.q).toUpperCase() + "%";
    params.push(like, like);
  }

  if (query.from) {
    const fromIso = startOfDayUtc(String(query.from), CONFIG.TIMEZONE);
    if (!fromIso) return { error: "Invalid 'from' date. Use YYYY-MM-DD." };
    where.push("timestamp_utc >= ?");
    params.push(fromIso);
  }
  if (query.to) {
    const toIso = startOfDayUtc(String(query.to), CONFIG.TIMEZONE, 1);
    if (!toIso) return { error: "Invalid 'to' date. Use YYYY-MM-DD." };
    where.push("timestamp_utc < ?");
    params.push(toIso);
  }

  return {
    where: where.length ? "WHERE " + where.join(" AND ") : "",
    params,
  };
}

function csvCell(value) {
  const s = value === null || value === undefined ? "" : String(value);
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
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
    currency: CONFIG.CURRENCY,
    currency_symbol: CONFIG.CURRENCY_SYMBOL,
    db_path: path.resolve(CONFIG.DB_PATH),
    trade_count: count,
    schema_version: versionRow ? versionRow.v : 0,
  });
});

// Get timezone + currency config (so frontend knows display conventions)
app.get("/api/config", (req, res) => {
  res.json({
    timezone: CONFIG.TIMEZONE,
    currency: CONFIG.CURRENCY,
    currency_symbol: CONFIG.CURRENCY_SYMBOL,
  });
});

// CSV export — must be registered before /api/trades/:id so "export.csv"
// is not captured as an id.
app.get("/api/trades/export.csv", (req, res) => {
  const q = buildTradeQuery(req.query);
  if (q.error) return res.status(400).json({ error: q.error });
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM trades ${q.where} ORDER BY id ASC`)
    .all(...q.params);

  const headers = [
    "id", "asset", "direction", "outcome", "pnl_cents", "stake_cents",
    "mode", "timestamp_utc", "notes", "broker", "broker_trade_id",
    "created_at", "updated_at",
  ];
  const lines = [headers.join(",")];
  for (const r of rows) {
    lines.push(headers.map((h) => csvCell(r[h])).join(","));
  }
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader(
    "Content-Disposition",
    `attachment; filename="trade-journal-${stamp}.csv"`
  );
  res.send("\uFEFF" + lines.join("\r\n"));
});

// List trades with optional filters
app.get("/api/trades", (req, res) => {
  const q = buildTradeQuery(req.query);
  if (q.error) return res.status(400).json({ error: q.error });
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM trades ${q.where} ORDER BY id DESC`)
    .all(...q.params);
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
      INSERT INTO trades (asset, direction, outcome, pnl_cents, stake_cents, mode, notes, timestamp_utc, broker, broker_trade_id)
      VALUES (@asset, @direction, @outcome, @pnl_cents, @stake_cents, @mode, @notes, @timestamp_utc, @broker, @broker_trade_id)
    `);

    const info = stmt.run({
      asset: sanitized.asset,
      direction: sanitized.direction,
      outcome: sanitized.outcome,
      pnl_cents: sanitized.pnl_cents,
      stake_cents: sanitized.stake_cents === undefined ? null : sanitized.stake_cents,
      mode: sanitized.mode,
      notes: sanitized.notes,
      timestamp_utc: sanitized.timestamp_utc,
      broker: sanitized.broker === undefined ? null : sanitized.broker,
      broker_trade_id: sanitized.broker_trade_id === undefined ? null : sanitized.broker_trade_id,
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
          stake_cents = @stake_cents,
          mode = @mode,
          notes = @notes,
          timestamp_utc = @timestamp_utc,
          broker = @broker,
          broker_trade_id = @broker_trade_id,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = @id
    `);

    stmt.run({
      id,
      asset: sanitized.asset,
      direction: sanitized.direction,
      outcome: sanitized.outcome,
      pnl_cents: sanitized.pnl_cents,
      stake_cents: sanitized.stake_cents === undefined ? null : sanitized.stake_cents,
      mode: sanitized.mode,
      notes: sanitized.notes,
      timestamp_utc: sanitized.timestamp_utc,
      broker: sanitized.broker === undefined ? null : sanitized.broker,
      broker_trade_id: sanitized.broker_trade_id === undefined ? null : sanitized.broker_trade_id,
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

  // If the outcome or the amount is being changed, re-derive the P&L sign from
  // the FINAL outcome so a partial edit can never leave a win/loss with the
  // wrong sign (which would corrupt win-rate / expectancy analytics).
  if (sanitized.outcome !== undefined || sanitized.pnl_cents !== undefined) {
    const finalOutcome = sanitized.outcome !== undefined ? sanitized.outcome : existing.outcome;
    const finalPnlCents = sanitized.pnl_cents !== undefined ? sanitized.pnl_cents : existing.pnl_cents;
    sanitized.pnl_cents = derivePnlSign(finalOutcome, finalPnlCents);
  }

  // Build dynamic update
  const fields = [];
  const params = { id };

  if (sanitized.asset !== undefined) { fields.push("asset = @asset"); params.asset = sanitized.asset; }
  if (sanitized.direction !== undefined) { fields.push("direction = @direction"); params.direction = sanitized.direction; }
  if (sanitized.outcome !== undefined) { fields.push("outcome = @outcome"); params.outcome = sanitized.outcome; }
  if (sanitized.pnl_cents !== undefined) { fields.push("pnl_cents = @pnl_cents"); params.pnl_cents = sanitized.pnl_cents; }
  if (sanitized.stake_cents !== undefined) { fields.push("stake_cents = @stake_cents"); params.stake_cents = sanitized.stake_cents; }
  if (sanitized.mode !== undefined) { fields.push("mode = @mode"); params.mode = sanitized.mode; }
  if (sanitized.notes !== undefined) { fields.push("notes = @notes"); params.notes = sanitized.notes; }
  if (sanitized.timestamp_utc !== undefined) { fields.push("timestamp_utc = @timestamp_utc"); params.timestamp_utc = sanitized.timestamp_utc; }
  if (sanitized.broker !== undefined) { fields.push("broker = @broker"); params.broker = sanitized.broker; }
  if (sanitized.broker_trade_id !== undefined) { fields.push("broker_trade_id = @broker_trade_id"); params.broker_trade_id = sanitized.broker_trade_id; }

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

// Restore previously deleted trades (undo). Rows are re-inserted with their
// ORIGINAL ids so references stay valid. Ids of already-existing trades are
// skipped, never overwritten.
app.post("/api/trades/restore", (req, res) => {
  const trades = req.body && Array.isArray(req.body.trades) ? req.body.trades : null;
  if (!trades || trades.length === 0) {
    return res.status(400).json({ error: "Send { trades: [...] } with the deleted trade rows." });
  }
  if (trades.length > 20000) {
    return res.status(400).json({ error: "Too many trades in one request." });
  }

  const db = getDb();
  const insert = db.prepare(`
    INSERT INTO trades (id, asset, direction, outcome, pnl_cents, stake_cents, mode, notes, timestamp_utc, broker, broker_trade_id, created_at, updated_at)
    VALUES (@id, @asset, @direction, @outcome, @pnl_cents, @stake_cents, @mode, @notes, @timestamp_utc, @broker, @broker_trade_id, @created_at, @updated_at)
  `);
  const exists = db.prepare("SELECT 1 FROM trades WHERE id = ?");

  const restored = [];
  const skipped = [];
  const failed = [];

  const validDate = (v) => {
    const d = new Date(v);
    return isNaN(d.getTime()) ? new Date().toISOString() : d.toISOString();
  };

  const run = db.transaction((list) => {
    for (const raw of list) {
      const id = Number(raw && raw.id);
      if (!Number.isInteger(id) || id <= 0) {
        failed.push({ reason: "Invalid id." });
        continue;
      }
      if (exists.get(id)) {
        skipped.push({ id, reason: "id already in use" });
        continue;
      }
      const { valid, errors, sanitized } = validateTrade(raw, { partial: false });
      if (!valid) {
        failed.push({ id, errors });
        continue;
      }
      const info = insert.run({
        id,
        asset: sanitized.asset,
        direction: sanitized.direction,
        outcome: sanitized.outcome,
        pnl_cents: sanitized.pnl_cents,
        stake_cents: sanitized.stake_cents === undefined ? null : sanitized.stake_cents,
        mode: sanitized.mode,
        notes: sanitized.notes,
        timestamp_utc: sanitized.timestamp_utc,
        broker: sanitized.broker === undefined ? null : sanitized.broker,
        broker_trade_id: sanitized.broker_trade_id === undefined ? null : sanitized.broker_trade_id,
        created_at: validDate(raw.created_at),
        updated_at: validDate(raw.updated_at),
      });
      restored.push(info.lastInsertRowid);
    }
  });

  try {
    run(trades);
    res.json({ success: true, restored: restored.length, skipped: skipped.length, failed: failed.length, restored_ids: restored });
  } catch (err) {
    console.error("[POST /api/trades/restore] DB error:", err);
    res.status(500).json({ error: "Database error while restoring trades." });
  }
});

// Bulk delete — hard delete, but returns the full rows so the UI can offer
// an immediate undo (restore keeps the original IDs). No ID renumbering.
app.post("/api/trades/bulk-delete", (req, res) => {
  const ids = req.body && Array.isArray(req.body.ids) ? req.body.ids : null;
  if (!ids || ids.length === 0) {
    return res.status(400).json({ error: "Send { ids: [1, 2, ...] }." });
  }
  const clean = [];
  for (const raw of ids) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ error: "Each id must be a positive integer." });
    }
    clean.push(id);
  }
  const unique = [...new Set(clean)];
  if (unique.length > 20000) {
    return res.status(400).json({ error: "Too many ids in one request." });
  }
  const db = getDb();
  const del = db.prepare("DELETE FROM trades WHERE id = ?");
  const rows = unique
    .map((id) => db.prepare("SELECT * FROM trades WHERE id = ?").get(id))
    .filter(Boolean);
  const run = db.transaction((list) => {
    let n = 0;
    for (const id of list) n += del.run(id).changes;
    return n;
  });
  try {
    const deleted = run(unique);
    res.json({
      success: true,
      deleted,
      requested: unique.length,
      deleted_rows: rows.map(restorePayload),
    });
  } catch (err) {
    console.error("[POST /api/trades/bulk-delete] DB error:", err);
    res.status(500).json({ error: "Database error while deleting trades." });
  }
});

// Delete trade — returns the removed row so the UI can offer undo.
app.delete("/api/trades/:id", (req, res) => {
  const db = getDb();
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: "Invalid trade ID." });
  }

  const row = db.prepare("SELECT * FROM trades WHERE id = ?").get(id);
  if (!row) return res.status(404).json({ error: "Trade not found." });

  const info = db.prepare("DELETE FROM trades WHERE id = ?").run(id);
  if (info.changes === 0) {
    return res.status(404).json({ error: "Trade not found." });
  }
  res.json({ success: true, deleted_id: id, deleted_row: restorePayload(row) });
});

// --- Import (CSV / Excel) ---
app.post("/api/import/preview", (req, res) => {
  upload.single("file")(req, res, async (err) => {
    if (err && err.code === "LIMIT_FILE_SIZE") {
      return res.status(400).json({ error: "File is too large (max 8 MB)." });
    }
    if (err) {
      return res.status(400).json({ error: err.message || "Could not upload the file." });
    }
    if (!req.file) {
      return res.status(400).json({ error: "Choose a CSV or Excel file to upload." });
    }
    try {
      const { kind, headers, rows } = await parseWorkbook(req.file.buffer, req.file.originalname, req.file.mimetype);
      const mapping = mapColumns(headers);
      const caveats = mappingCaveats(mapping);
      const db = getDb();
      const existing = existingIdentitySet(db);
      const classified = classifyRows(rows, mapping, existing, { filename: req.file.originalname });

      const previewRows = classified.rows.slice(0, 200).map((r) => ({
        rowNumber: r.rowNumber,
        status: r.status,
        reason: r.reason,
        preview: r.preview || null,
        payload: r.status === "invalid" ? r.payload : undefined,
      }));

      res.json({
        filename: req.file.originalname,
        kind,
        headers,
        mapping,
        caveats,
        missingRequired: classified.missingRequired,
        counts: classified.counts,
        rows: previewRows,
        truncated: classified.rows.length > 200,
        readyTrades: classified.rows.filter((r) => r.status === "ready").map((r) => r.sanitized),
      });
    } catch (e) {
      const status = e.code === "UNSUPPORTED" ? 415 : 400;
      res.status(status).json({ error: e.message });
    }
  });
});

app.post("/api/import/confirm", (req, res) => {
  const trades = req.body && Array.isArray(req.body.trades) ? req.body.trades : null;
  if (!trades) {
    return res.status(400).json({ error: "Send { trades: [...] } with the previewed ready rows." });
  }
  if (trades.length > 10000) {
    return res.status(400).json({ error: "Too many trades in one import." });
  }

  const db = getDb();
  const existing = existingIdentitySet(db);
  const seen = new Set();
  const imported = [];
  const skipped = [];
  const failed = [];

  const insert = db.prepare(`
    INSERT INTO trades (asset, direction, outcome, pnl_cents, stake_cents, mode, notes, timestamp_utc, broker, broker_trade_id)
    VALUES (@asset, @direction, @outcome, @pnl_cents, @stake_cents, @mode, @notes, @timestamp_utc, @broker, @broker_trade_id)
  `);

  const ordered = trades.slice().sort((a, b) => {
    const ta = String(a.timestamp_utc || a.timestamp || "");
    const tb = String(b.timestamp_utc || b.timestamp || "");
    if (ta < tb) return -1;
    if (ta > tb) return 1;
    return 0;
  });

  const run = db.transaction((list) => {
    list.forEach((raw, i) => {
      const { valid, errors, sanitized } = validateTrade(raw, { partial: false });
      if (!valid) {
        failed.push({ index: i, errors });
        return;
      }
      const keys = dedupeKeys(sanitized);
      if (keys.some((k) => existing.has(k)) || keys.some((k) => seen.has(k))) {
        skipped.push({ index: i, reason: "duplicate" });
        return;
      }
      keys.forEach((k) => seen.add(k));
      const info = insert.run({
        asset: sanitized.asset,
        direction: sanitized.direction,
        outcome: sanitized.outcome,
        pnl_cents: sanitized.pnl_cents,
        stake_cents: sanitized.stake_cents === undefined ? null : sanitized.stake_cents,
        mode: sanitized.mode,
        notes: sanitized.notes,
        timestamp_utc: sanitized.timestamp_utc,
        broker: sanitized.broker === undefined ? null : sanitized.broker,
        broker_trade_id: sanitized.broker_trade_id === undefined ? null : sanitized.broker_trade_id,
      });
      imported.push(info.lastInsertRowid);
      keys.forEach((k) => existing.add(k));
    });
  });

  try {
    run(ordered);
    res.json({
      imported: imported.length,
      skipped_duplicates: skipped.length,
      failed: failed.length,
      failed_details: failed.slice(0, 50),
      imported_ids: imported,
    });
  } catch (err) {
    console.error("[POST /api/import/confirm] DB error:", err);
    res.status(500).json({ error: "Database error while importing trades." });
  }
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
      currency: CONFIG.CURRENCY,
      currency_symbol: CONFIG.CURRENCY_SYMBOL,
      generated_at: new Date().toISOString(),
      thresholds: {
        minN: CONFIG.ANALYTICS.MIN_N,
        bestMinN: CONFIG.ANALYTICS.BEST_MIN_N,
        bestMarginPct: CONFIG.ANALYTICS.BEST_MARGIN * 100,
        bestRequireCiOverBaseline: CONFIG.ANALYTICS.BEST_REQUIRE_CI_OVER_BASELINE,
        bestSmallSampleN: CONFIG.ANALYTICS.BEST_SMALL_SAMPLE_N,
        wilsonZ: CONFIG.ANALYTICS.WILSON_Z,
        todayMinN: CONFIG.TODAY.BEST_MIN_N,
        todayMarginPct: CONFIG.TODAY.BEST_MARGIN * 100,
        todayRequireCiOverBaseline: CONFIG.TODAY.BEST_REQUIRE_CI_OVER_BASELINE,
        todaySmallSampleN: CONFIG.TODAY.BEST_SMALL_SAMPLE_N,
      },
      real: result.real,
      demo: result.demo,
    });
  } catch (err) {
    console.error("[GET /api/analytics] Error:", err);
    res.status(500).json({ error: "Could not compute analytics." });
  }
});

// Unknown API paths -> JSON 404 (never the HTML shell).
app.use("/api", (req, res) => {
  res.status(404).json({ error: "Not found." });
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

  const server = app.listen(CONFIG.PORT, CONFIG.HOST, () => {
    console.log(`\n✓ Trade Timing Journal running at http://${CONFIG.HOST}:${CONFIG.PORT}`);
    console.log(`  Timezone (fixed): ${CONFIG.TIMEZONE}`);
    console.log(`  Currency: ${CONFIG.CURRENCY} (${CONFIG.CURRENCY_SYMBOL})`);
    console.log(`  Database: ${path.resolve(CONFIG.DB_PATH)} (WAL mode, persistent)`);
    console.log(`  Bound to: ${CONFIG.HOST} (localhost-only default; set TT_HOST=0.0.0.0 for LAN access)`);
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

/**
 * CSV / Excel trade import — mapping, row parsing, duplicate detection.
 * Validation is delegated to validation.js so imported trades follow the
 * same rules as the manual form.
 */
"use strict";

const XLSX = require("xlsx");
const { validateTrade, formatCents } = require("./validation");

const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8 MB
const MAX_ROWS = 10000;

const REQUIRED_FIELDS = ["asset", "direction", "outcome", "amount", "mode", "timestamp"];

const COLUMN_ALIASES = {
  asset: [
    "asset", "symbol", "pair", "ticker", "instrument", "market", "currency pair",
    "currencypair", "underlying",
  ],
  direction: [
    "direction", "side", "type", "trade type", "tradetype", "callput", "call/put",
    "call put", "action", "position", "buy/sell", "buysell",
  ],
  outcome: [
    "outcome", "result", "winloss", "win/loss", "status", "trade result",
    "traderesult", "wonlost",
  ],
  amount: [
    "amount", "pnl", "p&l", "pl", "profit", "profitloss", "profit/loss",
    "payout", "netpnl", "net p&l", "net pl", "pnl amount", "usd", "profit usd",
  ],
  mode: [
    "mode", "account", "account type", "accounttype", "real/demo", "realdemo",
    "environment", "live",
  ],
  timestamp: [
    "timestamp", "timestamp_utc", "time", "datetime", "date", "date/time",
    "date time", "opentime", "open time", "closed time", "closetime",
    "entry time", "entrytime", "trade time", "tradetime", "executed at",
  ],
  notes: ["notes", "note", "comment", "comments", "remark", "remarks", "description"],
};

function normalizeHeader(h) {
  return String(h || "")
    .trim()
    .toLowerCase()
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function mapColumns(headers) {
  const mapping = {};
  const used = new Set();
  const normalized = headers.map((h, i) => ({ raw: h, key: normalizeHeader(h), index: i }));

  for (const field of Object.keys(COLUMN_ALIASES)) {
    for (const alias of COLUMN_ALIASES[field]) {
      const hit = normalized.find((h) => h.key === alias && !used.has(h.index));
      if (hit) {
        mapping[field] = hit.raw;
        used.add(hit.index);
        break;
      }
    }
  }
  return mapping;
}

function excelSerialToDate(n) {
  // Excel serial: days since 1899-12-30 (with the 1900 leap-year bug ignored
  // for values after 1900-03-01, which all our trades are).
  const ms = Math.round((Number(n) - 25569) * 86400 * 1000);
  return new Date(ms);
}

function coerceTimestamp(value) {
  if (value === null || value === undefined || value === "") return value;
  if (value instanceof Date) return isNaN(value.getTime()) ? String(value) : value.toISOString();
  if (typeof value === "number" && Number.isFinite(value)) {
    // Excel serial dates are typically between ~20000 and ~60000 for 1954–2064.
    if (value > 20000 && value < 80000) {
      const d = excelSerialToDate(value);
      if (!isNaN(d.getTime())) return d.toISOString();
    }
    // Unix seconds / ms
    const d = value > 1e12 ? new Date(value) : new Date(value * 1000);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  const s = String(value).trim();
  if (!s) return s;
  // "YYYY-MM-DD HH:MM[:SS]" → treat as UTC if no timezone
  const spaceDate = s.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/);
  if (spaceDate) {
    const iso = spaceDate[1] + "T" + spaceDate[2] + (spaceDate[2].length === 5 ? ":00" : "") + "Z";
    const d = new Date(iso);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  return s;
}

function normalizeDirection(raw) {
  if (raw === null || raw === undefined) return raw;
  const v = String(raw).trim().toLowerCase();
  if (["long", "buy", "call", "up", "rise", "bull", "bullish"].includes(v)) return "long";
  if (["short", "sell", "put", "down", "fall", "bear", "bearish"].includes(v)) return "short";
  return v;
}

function normalizeOutcome(raw) {
  if (raw === null || raw === undefined) return raw;
  const v = String(raw).trim().toLowerCase();
  if (["win", "won", "profit", "success", "successful", "w", "+"].includes(v)) return "win";
  if (["loss", "lose", "lost", "fail", "failed", "l", "-"].includes(v)) return "loss";
  if (["breakeven", "break even", "be", "even", "scratch", "tie", "0"].includes(v)) return "breakeven";
  return v;
}

function normalizeMode(raw) {
  if (raw === null || raw === undefined) return raw;
  const v = String(raw).trim().toLowerCase();
  if (["real", "live", "funded", "live account"].includes(v)) return "real";
  if (["demo", "paper", "practice", "virtual", "demo account"].includes(v)) return "demo";
  return v;
}

function identityKey(s) {
  return [s.asset, s.direction, s.outcome, s.pnl_cents, s.mode, s.timestamp_utc].join("|");
}

function detectFileKind(filename, mime) {
  const name = String(filename || "").toLowerCase();
  const m = String(mime || "").toLowerCase();
  if (name.endsWith(".csv") || m.includes("csv")) return "csv";
  if (name.endsWith(".xlsx") || name.endsWith(".xls") || m.includes("spreadsheet") || m.includes("excel")) {
    return "excel";
  }
  return null;
}

function parseWorkbook(buffer, filename, mime) {
  const kind = detectFileKind(filename, mime);
  if (!kind) {
    throw Object.assign(new Error("Unsupported file type. Upload a .csv, .xlsx, or .xls file."), { code: "UNSUPPORTED" });
  }
  if (!buffer || buffer.length === 0) {
    throw Object.assign(new Error("The file is empty."), { code: "EMPTY" });
  }
  if (buffer.length > MAX_FILE_BYTES) {
    throw Object.assign(new Error("File is too large (max 8 MB)."), { code: "TOO_LARGE" });
  }

  let workbook;
  try {
    workbook = XLSX.read(buffer, { type: "buffer", cellDates: true, raw: false });
  } catch (err) {
    throw Object.assign(new Error("Could not read the spreadsheet. The file may be corrupted."), { code: "CORRUPT" });
  }

  const sheetName = workbook.SheetNames && workbook.SheetNames[0];
  if (!sheetName) {
    throw Object.assign(new Error("The spreadsheet has no sheets."), { code: "EMPTY" });
  }
  const sheet = workbook.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(sheet, { defval: "", raw: true });
  if (!rows.length) {
    throw Object.assign(new Error("The file has no data rows."), { code: "EMPTY" });
  }
  if (rows.length > MAX_ROWS) {
    throw Object.assign(new Error(`Too many rows (max ${MAX_ROWS}). Split the file and import in batches.`), { code: "TOO_LARGE" });
  }

  const headers = Object.keys(rows[0] || {});
  return { kind, headers, rows };
}

function rowToPayload(row, mapping) {
  const get = (field) => {
    const col = mapping[field];
    if (!col) return undefined;
    return row[col];
  };
  const payload = {
    asset: get("asset"),
    direction: normalizeDirection(get("direction")),
    outcome: normalizeOutcome(get("outcome")),
    amount: get("amount"),
    mode: normalizeMode(get("mode")),
    timestamp: coerceTimestamp(get("timestamp")),
  };
  if (mapping.notes) {
    const n = get("notes");
    payload.notes = n === undefined || n === null ? "" : String(n);
  }
  return payload;
}

/**
 * Classify every row against existing DB trades.
 * existingKeys: Set of identityKey strings already in SQLite.
 */
function classifyRows(rows, mapping, existingKeys) {
  const missingRequired = REQUIRED_FIELDS.filter((f) => !mapping[f]);
  const seenInFile = new Set();
  const classified = [];
  let ready = 0;
  let duplicatesDb = 0;
  let duplicatesFile = 0;
  let invalid = 0;

  rows.forEach((row, i) => {
    const rowNumber = i + 2; // header is row 1
    const payload = rowToPayload(row, mapping);

    if (missingRequired.length) {
      classified.push({
        rowNumber,
        status: "invalid",
        reason: "Missing required columns: " + missingRequired.join(", ") + ".",
        payload,
        sanitized: null,
      });
      invalid += 1;
      return;
    }

    const { valid, errors, sanitized } = validateTrade(payload, { partial: false });
    if (!valid) {
      classified.push({
        rowNumber,
        status: "invalid",
        reason: errors.join(" "),
        payload,
        sanitized: null,
      });
      invalid += 1;
      return;
    }

    const key = identityKey(sanitized);
    if (existingKeys.has(key)) {
      classified.push({
        rowNumber,
        status: "duplicate",
        reason: "Matches an existing trade in the journal (same asset, direction, outcome, P&L, mode, and timestamp).",
        payload,
        sanitized,
      });
      duplicatesDb += 1;
      return;
    }
    if (seenInFile.has(key)) {
      classified.push({
        rowNumber,
        status: "duplicate",
        reason: "Duplicate of an earlier row in this file (same asset, direction, outcome, P&L, mode, and timestamp).",
        payload,
        sanitized,
      });
      duplicatesFile += 1;
      return;
    }

    seenInFile.add(key);
    classified.push({
      rowNumber,
      status: "ready",
      reason: null,
      payload,
      sanitized,
      preview: {
        asset: sanitized.asset,
        direction: sanitized.direction,
        outcome: sanitized.outcome,
        pnl_formatted: formatCents(sanitized.pnl_cents),
        mode: sanitized.mode,
        timestamp_utc: sanitized.timestamp_utc,
        notes: sanitized.notes,
      },
    });
    ready += 1;
  });

  return {
    missingRequired,
    counts: {
      total: rows.length,
      ready,
      duplicates: duplicatesDb + duplicatesFile,
      duplicates_in_journal: duplicatesDb,
      duplicates_in_file: duplicatesFile,
      invalid,
    },
    rows: classified,
  };
}

function existingIdentitySet(db) {
  const rows = db.prepare("SELECT asset, direction, outcome, pnl_cents, mode, timestamp_utc FROM trades").all();
  const set = new Set();
  for (const r of rows) set.add(identityKey(r));
  return set;
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_ROWS,
  REQUIRED_FIELDS,
  COLUMN_ALIASES,
  mapColumns,
  normalizeHeader,
  normalizeDirection,
  normalizeOutcome,
  normalizeMode,
  coerceTimestamp,
  identityKey,
  detectFileKind,
  parseWorkbook,
  rowToPayload,
  classifyRows,
  existingIdentitySet,
};

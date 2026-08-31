/**
 * CSV / Excel trade import — mapping, row parsing, duplicate detection.
 * Validation is delegated to validation.js so imported trades follow the
 * same rules as the manual form.
 *
 * Files:
 *  - .csv is parsed with a small RFC-4180-ish parser (quotes, commas,
 *    semicolons, tabs, CRLF). No third-party parser needed for CSV.
 *  - .xlsx is parsed with exceljs (a maintained pure-JS library). The
 *    abandoned npm `xlsx` package is intentionally NOT used: it has
 *    unresolved prototype-pollution and ReDoS advisories.
 *  - Legacy .xls files are not supported; save as .xlsx or .csv.
 *
 * Duplicates:
 *  - If the file has a broker trade ID (order/deal/ref id), we store it and
 *    use broker + broker_trade_id as the primary key — so a corrected,
 *    re-exported trade is still recognised as a duplicate.
 *  - Otherwise we fall back to a fingerprint of the normalized fields
 *    (asset, direction, outcome, pnl_cents, mode, timestamp_utc). P&L is
 *    rounded to integer cents and timestamps are normalized to UTC ISO
 *    before hashing, so formatting differences don't create false news.
 */
"use strict";

const ExcelJS = require("exceljs");
const CONFIG = require("./config");
const { validateTrade, formatCents } = require("./validation");
const { parseTimestampToUtc, wallClockToUtcIso } = require("./time");

const MAX_FILE_BYTES = 8 * 1024 * 1024; // 8 MB
const MAX_ROWS = 10000;

// Columns that must exist in the file. Outcome and mode can be inferred
// (P&L sign, and demo/real in the filename) so they are not required headers.
const REQUIRED_FIELDS = ["asset", "direction", "amount", "timestamp"];

// Field order matters: `amount` (net P&L) is tried before `stake`, so a
// file that only has a bare "Amount" column keeps working as P&L, while a
// file with real P&L + "Amount" (e.g. Pocket Option) maps Amount -> stake.
const COLUMN_ALIASES = {
  asset: [
    "asset", "symbol", "pair", "ticker", "instrument", "market", "currency pair",
    "currencypair", "underlying", "currency", "deal",
  ],
  direction: [
    "direction", "side", "action", "option", "callput", "call/put", "call put",
    "position", "buy/sell", "buysell", "trade type", "tradetype", "type",
  ],
  outcome: [
    "outcome", "result", "winloss", "win/loss", "status", "trade result",
    "traderesult", "wonlost",
  ],
  // Net P&L column names first (preferred), generic fallbacks last.
  amount: [
    "profit", "p&l", "pnl", "pl", "profitloss", "profit/loss", "net profit",
    "netpnl", "net p&l", "net pl", "pnl amount", "profit usd", "income",
    "payout", "usd", "amount",
  ],
  mode: [
    "mode", "account", "account type", "accounttype", "real/demo", "realdemo",
    "environment", "live",
  ],
  timestamp: [
    "timestamp", "timestamp_utc", "open time", "opentime", "opened", "opened at",
    "close time", "closetime", "closed", "closed at", "entry time", "entrytime",
    "trade time", "tradetime", "executed at", "datetime", "date/time", "date time",
    "time", "date",
  ],
  stake: [
    "stake", "stake amount", "stakeamount", "investment", "bet", "bet amount",
    "betamount", "position size", "positionsize", "risk", "debit", "amount",
  ],
  broker: [
    "broker", "platform", "company", "exchange", "dealer",
  ],
  broker_trade_id: [
    "trade id", "tradeid", "order id", "orderid", "deal id", "dealid", "deal",
    "ticket", "ticket number", "ticketnumber", "position id", "positionid",
    "ref", "reference", "id", "trade no",
  ],
  notes: ["notes", "note", "comment", "comments", "remark", "remarks", "description"],
};

// Columns whose meaning is ambiguous from the name alone (net profit vs
// gross payout vs stake). The user must confirm the mapping before import.
const AMBIGUOUS_AMOUNT_COLUMNS = ["payout", "amount", "usd", "income"];

function normalizeHeader(h) {
  return String(h || "")
    .replace(/^\uFEFF/, "")
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

/**
 * Human-readable caveats about a detected mapping — e.g. "Payout" could be a
 * gross payout rather than net profit, so the user should verify before
 * confirming the import.
 */
function mappingCaveats(mapping) {
  const caveats = [];
  const amountHeader = mapping.amount ? normalizeHeader(mapping.amount) : "";
  if (amountHeader && AMBIGUOUS_AMOUNT_COLUMNS.includes(amountHeader)) {
    caveats.push(
      `Column "${mapping.amount}" was mapped to P&L, but "${mapping.amount}" is also used for gross ` +
      "payouts or stakes by some brokers. Make sure this column is your NET profit before importing."
    );
  }
  if (mapping.stake && mapping.amount) {
    caveats.push(`Stake will be read from "${mapping.stake}"; P&L from "${mapping.amount}".`);
  }
  if (mapping.broker_trade_id && mapping.broker) {
    caveats.push(
      `Duplicates will be detected using the broker trade ID (${mapping.broker_trade_id}).`
    );
  }
  return caveats;
}

function excelSerialToDate(n) {
  const ms = Math.round((Number(n) - 25569) * 86400 * 1000);
  return new Date(ms);
}

function partsToUtcIso(y, mo, d, h, mi, s) {
  // Naive wall-clock components are interpreted in the configured trading TZ.
  return wallClockToUtcIso(Number(y), Number(mo), Number(d), Number(h) || 0, Number(mi) || 0, Number(s) || 0);
}

function coerceTimestamp(value) {
  if (value === null || value === undefined || value === "") return value;
  if (value instanceof Date) {
    if (isNaN(value.getTime())) return String(value);
    // ExcelJS builds Excel serial dates as absolute Dates on the UTC epoch,
    // so the UTC components are the spreadsheet's wall clock. Interpret those
    // components in the configured trading timezone.
    return partsToUtcIso(
      value.getUTCFullYear(), value.getUTCMonth() + 1, value.getUTCDate(),
      value.getUTCHours(), value.getUTCMinutes(), value.getUTCSeconds()
    );
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value > 20000 && value < 80000) {
      const d = excelSerialToDate(value);
      if (!isNaN(d.getTime())) {
        return partsToUtcIso(
          d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(),
          d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()
        );
      }
    }
    const d = value > 1e12 ? new Date(value) : new Date(value * 1000);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  const s = String(value).trim();
  if (!s) return s;
  // Already has an explicit timezone — keep as an absolute instant.
  if (/[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  const spaceDate = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/);
  if (spaceDate) {
    return partsToUtcIso(spaceDate[1], spaceDate[2], spaceDate[3], spaceDate[4], spaceDate[5], spaceDate[6] || 0);
  }
  const dmy = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/);
  if (dmy) {
    return partsToUtcIso(dmy[3], dmy[2], dmy[1], dmy[4] || 0, dmy[5] || 0, dmy[6] || 0);
  }
  const parsed = parseTimestampToUtc(s);
  return parsed || s;
}

function parseAmount(raw) {
  if (raw === null || raw === undefined || raw === "") return raw;
  if (typeof raw === "number") return raw;
  let s = String(raw).trim().replace(/\s/g, "").replace(/[$€£]/g, "");
  if (!s) return raw;
  if (s.includes(",") && s.includes(".")) {
    if (s.lastIndexOf(",") > s.lastIndexOf(".")) s = s.replace(/\./g, "").replace(",", ".");
    else s = s.replace(/,/g, "");
  } else if ((s.match(/,/g) || []).length === 1 && !s.includes(".")) {
    s = s.replace(",", ".");
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : raw;
}

function inferOutcomeFromAmount(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return undefined;
  if (n > 0) return "win";
  if (n < 0) return "loss";
  return "breakeven";
}

function inferModeFromFilename(filename) {
  const n = String(filename || "").toLowerCase();
  if (n.includes("demo") || n.includes("practice") || n.includes("paper")) return "demo";
  if (n.includes("real") || n.includes("live") || n.includes("funded")) return "real";
  return null;
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

/**
 * Duplicate keys:
 *  - fingerprintKey: exact match on normalized fields (rounded cents,
 *    normalized UTC ISO timestamp).
 *  - brokerKey: broker + broker_trade_id when both are present (primary key
 *    for re-exports with corrections).
 * `dedupeKeys` returns the prefixed list of keys for one sanitized trade.
 */
function identityKey(s) {
  return [s.asset, s.direction, s.outcome, s.pnl_cents, s.mode, s.timestamp_utc].join("|");
}

function brokerKey(s) {
  if (!s.broker || !s.broker_trade_id) return null;
  return String(s.broker).toLowerCase() + "|" + String(s.broker_trade_id).toLowerCase();
}

function dedupeKeys(s) {
  const keys = [];
  const bk = brokerKey(s);
  if (bk) {
    // Broker + trade id is the strongest key: corrected re-exports still match.
    keys.push("b:" + bk);
  } else if (s.broker_trade_id) {
    // No broker column in the file — the trade id alone is still a useful key.
    keys.push("t:" + String(s.broker_trade_id).toLowerCase());
  }
  keys.push("f:" + identityKey(s));
  return keys;
}

function detectFileKind(filename, mime) {
  const name = String(filename || "").toLowerCase();
  const m = String(mime || "").toLowerCase();
  if (name.endsWith(".csv") || m.includes("csv")) return "csv";
  if (name.endsWith(".xlsx") || m.includes("spreadsheet") || m.includes("excel")) {
    // .xls (legacy binary) is NOT supported by exceljs — say so clearly.
    if (name.endsWith(".xls") && !name.endsWith(".xlsx")) return null;
    return "excel";
  }
  return null;
}

/* ---------------- CSV parsing (RFC-4180-ish) ---------------- */

function parseCsvText(text, delimiter) {
  const records = [];
  let record = [];
  let field = "";
  let inQuotes = false;
  let i = 0;
  const pushField = () => {
    record.push(field);
    field = "";
  };
  const pushRecord = () => {
    pushField();
    // Skip completely blank lines.
    if (record.some((v) => String(v).trim() !== "")) records.push(record);
    record = [];
  };
  while (i < text.length) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 2;
          continue;
        }
        inQuotes = false;
        i += 1;
        continue;
      }
      field += ch;
      i += 1;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      i += 1;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      pushRecord();
      i += 1;
      continue;
    }
    field += ch;
    i += 1;
  }
  if (field !== "" || record.length > 0) pushRecord();
  return records;
}

function detectDelimiter(firstLine) {
  const candidates = [",", ";", "\t"];
  let best = ",";
  let bestCount = -1;
  for (const d of candidates) {
    const count = firstLine.split(d).length - 1;
    if (count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

function csvRowsToObjects(text) {
  let body = text;
  if (body.charCodeAt(0) === 0xfeff) body = body.slice(1);
  const firstLine = body.split(/\r?\n/)[0] || "";
  const delimiter = detectDelimiter(firstLine);
  const records = parseCsvText(body, delimiter);
  if (records.length === 0) return [];
  const headers = records[0].map((h) => String(h).trim());
  const rows = [];
  for (let i = 1; i < records.length; i += 1) {
    const values = records[i];
    const row = {};
    let hasValue = false;
    headers.forEach((h, idx) => {
      const v = values[idx] !== undefined ? values[idx] : "";
      row[h] = v;
      if (String(v).trim() !== "") hasValue = true;
    });
    if (hasValue) rows.push(row);
  }
  return rows;
}

/* ---------------- Workbook parsing ---------------- */

function cellToPrimitive(v) {
  if (v === null || v === undefined) return "";
  if (v instanceof Date) return v;
  if (typeof v === "object") {
    if (v.text !== undefined) return v.text; // rich text
    if (v.result !== undefined) return v.result; // formula result
    if (v.hyperlink !== undefined) return v.text || "";
    return String(v);
  }
  return v;
}

async function parseXlsx(buffer) {
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer);
  } catch (err) {
    throw Object.assign(
      new Error("Could not read the spreadsheet. The file may be corrupted."),
      { code: "CORRUPT" }
    );
  }
  const sheet = workbook.worksheets[0];
  if (!sheet || sheet.rowCount === 0) {
    throw Object.assign(new Error("The spreadsheet has no sheets."), { code: "EMPTY" });
  }
  const headerValues = sheet.getRow(1).values || [];
  const headers = [];
  for (let i = 1; i < headerValues.length; i += 1) {
    headers.push(String(cellToPrimitive(headerValues[i])).trim());
  }
  const rows = [];
  for (let r = 2; r <= sheet.rowCount; r += 1) {
    const values = sheet.getRow(r).values || [];
    const row = {};
    let hasValue = false;
    headers.forEach((h, idx) => {
      const v = cellToPrimitive(values[idx + 1]);
      row[h] = v === undefined || v === null ? "" : v;
      if (String(v).trim() !== "") hasValue = true;
    });
    if (hasValue) rows.push(row);
  }
  return { headers, rows };
}

async function parseWorkbook(buffer, filename, mime) {
  const kind = detectFileKind(filename, mime);
  if (!kind) {
    throw Object.assign(
      new Error(
        "Unsupported file type. Upload a .csv or .xlsx file " +
        "(legacy .xls files are not supported — save them as .xlsx or .csv)."
      ),
      { code: "UNSUPPORTED" }
    );
  }
  if (!buffer || buffer.length === 0) {
    throw Object.assign(new Error("The file is empty."), { code: "EMPTY" });
  }
  if (buffer.length > MAX_FILE_BYTES) {
    throw Object.assign(new Error("File is too large (max 8 MB)."), { code: "TOO_LARGE" });
  }

  let headers;
  let rows;
  if (kind === "csv") {
    headers = [];
    rows = [];
    try {
      const parsed = csvRowsToObjects(buffer.toString("utf8"));
      if (parsed.length > 0) {
        headers = Object.keys(parsed[0]);
        rows = parsed;
      }
    } catch (err) {
      throw Object.assign(new Error("Could not read the CSV file."), { code: "CORRUPT" });
    }
  } else {
    const parsed = await parseXlsx(buffer);
    headers = parsed.headers;
    rows = parsed.rows;
  }

  if (!rows.length) {
    throw Object.assign(new Error("The file has no data rows."), { code: "EMPTY" });
  }
  if (rows.length > MAX_ROWS) {
    throw Object.assign(
      new Error(`Too many rows (max ${MAX_ROWS}). Split the file and import in batches.`),
      { code: "TOO_LARGE" }
    );
  }

  return { kind, headers, rows };
}

function rowToPayload(row, mapping, options = {}) {
  const get = (field) => {
    const col = mapping[field];
    if (!col) return undefined;
    return row[col];
  };
  const amount = parseAmount(get("amount"));
  let outcome = normalizeOutcome(get("outcome"));
  if (!outcome || !["win", "loss", "breakeven"].includes(String(outcome).toLowerCase())) {
    const inferred = inferOutcomeFromAmount(amount);
    if (inferred) outcome = inferred;
  }
  let mode = normalizeMode(get("mode"));
  if (!mode || !["real", "demo"].includes(String(mode).toLowerCase())) {
    if (options.defaultMode) mode = options.defaultMode;
  }
  const payload = {
    asset: get("asset"),
    direction: normalizeDirection(get("direction")),
    outcome,
    amount,
    mode,
    timestamp: coerceTimestamp(get("timestamp")),
  };
  if (mapping.stake) payload.stake = parseAmount(get("stake"));
  if (mapping.broker) payload.broker = String(get("broker"));
  if (mapping.broker_trade_id) payload.broker_trade_id = String(get("broker_trade_id"));
  if (mapping.notes) {
    const n = get("notes");
    payload.notes = n === undefined || n === null ? "" : String(n);
  }
  return payload;
}

/**
 * Classify every row against existing DB trades.
 * `existingKeys`: Set of dedupeKeys strings already in SQLite
 * (see existingIdentitySet below).
 */
function classifyRows(rows, mapping, existingKeys, options = {}) {
  const defaultMode = options.defaultMode || inferModeFromFilename(options.filename);
  const missingRequired = REQUIRED_FIELDS.filter((f) => !mapping[f]);
  if (!mapping.outcome && !mapping.amount) missingRequired.push("outcome");
  if (!mapping.mode && !defaultMode) missingRequired.push("mode");
  const seenInFile = new Set();
  const classified = [];
  let ready = 0;
  let duplicatesDb = 0;
  let duplicatesFile = 0;
  let invalid = 0;

  rows.forEach((row, i) => {
    const rowNumber = i + 2; // header is row 1
    const payload = rowToPayload(row, mapping, { defaultMode });

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

    const keys = dedupeKeys(sanitized);
    const inDb = keys.some((k) => existingKeys.has(k));
    const inFile = keys.some((k) => seenInFile.has(k));
    // In-file duplicates take precedence so a repeated row is reported as a
    // duplicate of the earlier row in the same file, not of the journal.
    if (inFile) {
      // The first occurrence was already classified (as ready or as a journal
      // duplicate); count subsequent identical rows as in-file duplicates.
      classified.push({
        rowNumber,
        status: "duplicate",
        reason: "Duplicate of an earlier row in this file (same broker trade ID or same asset, direction, outcome, P&L, mode, and timestamp).",
        payload,
        sanitized,
      });
      duplicatesFile += 1;
      return;
    }
    if (inDb) {
      // Remember the keys so a repeated row later in this file is reported as
      // an in-file duplicate rather than a second journal duplicate.
      keys.forEach((k) => seenInFile.add(k));
      classified.push({
        rowNumber,
        status: "duplicate",
        reason: "Matches an existing trade in the journal (same broker trade ID or same asset, direction, outcome, P&L, mode, and timestamp).",
        payload,
        sanitized,
      });
      duplicatesDb += 1;
      return;
    }

    keys.forEach((k) => seenInFile.add(k));
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
        stake: sanitized.stake_cents === null || sanitized.stake_cents === undefined
          ? null
          : formatCents(sanitized.stake_cents),
        mode: sanitized.mode,
        timestamp_utc: sanitized.timestamp_utc,
        broker: sanitized.broker,
        broker_trade_id: sanitized.broker_trade_id,
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
  const rows = db
    .prepare("SELECT asset, direction, outcome, pnl_cents, mode, timestamp_utc, broker, broker_trade_id FROM trades")
    .all();
  const set = new Set();
  for (const r of rows) dedupeKeys(r).forEach((k) => set.add(k));
  return set;
}

module.exports = {
  MAX_FILE_BYTES,
  MAX_ROWS,
  REQUIRED_FIELDS,
  COLUMN_ALIASES,
  mapColumns,
  mappingCaveats,
  normalizeHeader,
  normalizeDirection,
  normalizeOutcome,
  normalizeMode,
  coerceTimestamp,
  parseAmount,
  inferOutcomeFromAmount,
  inferModeFromFilename,
  identityKey,
  brokerKey,
  dedupeKeys,
  detectFileKind,
  parseWorkbook,
  parseCsvText,
  csvRowsToObjects,
  rowToPayload,
  classifyRows,
  existingIdentitySet,
};

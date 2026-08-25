/**
 * Unit tests for CSV/Excel mapping, call/put aliases, and duplicate keys.
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const XLSX = require("xlsx");
const {
  mapColumns,
  normalizeDirection,
  normalizeOutcome,
  normalizeMode,
  identityKey,
  classifyRows,
  parseWorkbook,
} = require("../import");

test("maps common header aliases including call/put", () => {
  const mapping = mapColumns(["Symbol", "Call/Put", "Result", "P&L", "Account", "Open Time", "Notes"]);
  assert.equal(mapping.asset, "Symbol");
  assert.equal(mapping.direction, "Call/Put");
  assert.equal(mapping.outcome, "Result");
  assert.equal(mapping.amount, "P&L");
  assert.equal(mapping.mode, "Account");
  assert.equal(mapping.timestamp, "Open Time");
  assert.equal(mapping.notes, "Notes");
});

test("call/put and buy/sell normalize to long/short", () => {
  assert.equal(normalizeDirection("CALL"), "long");
  assert.equal(normalizeDirection("put"), "short");
  assert.equal(normalizeDirection("Buy"), "long");
  assert.equal(normalizeDirection("SELL"), "short");
});

test("outcome and mode aliases", () => {
  assert.equal(normalizeOutcome("Won"), "win");
  assert.equal(normalizeOutcome("lost"), "loss");
  assert.equal(normalizeOutcome("BE"), "breakeven");
  assert.equal(normalizeMode("live"), "real");
  assert.equal(normalizeMode("paper"), "demo");
});

test("classifyRows flags invalid, file duplicates, and journal duplicates", () => {
  const mapping = mapColumns(["asset", "direction", "outcome", "amount", "mode", "timestamp"]);
  const good = {
    asset: "EURUSD",
    direction: "call",
    outcome: "win",
    amount: 12.5,
    mode: "live",
    timestamp: "2026-08-10T07:12:00Z",
  };
  const rows = [
    good,
    { ...good }, // duplicate in file
    { ...good, asset: "GBPUSD" }, // new
    { asset: "", direction: "call", outcome: "win", amount: 1, mode: "real", timestamp: "2026-08-10T07:12:00Z" },
  ];
  const existingKey = identityKey({
    asset: "GBPUSD",
    direction: "long",
    outcome: "win",
    pnl_cents: 1250,
    mode: "real",
    timestamp_utc: "2026-08-10T07:12:00.000Z",
  });
  const result = classifyRows(rows, mapping, new Set([existingKey]));
  assert.equal(result.counts.ready, 1);
  assert.equal(result.counts.duplicates_in_file, 1);
  assert.equal(result.counts.duplicates_in_journal, 1);
  assert.equal(result.counts.invalid, 1);
});

test("parseWorkbook reads CSV and xlsx", () => {
  const csv = Buffer.from(
    "asset,direction,outcome,amount,mode,timestamp\nBTCUSDT,long,win,10,real,2026-08-10T07:12:00Z\n",
    "utf8"
  );
  const csvParsed = parseWorkbook(csv, "trades.csv", "text/csv");
  assert.equal(csvParsed.kind, "csv");
  assert.equal(csvParsed.rows.length, 1);

  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([
    ["asset", "direction", "outcome", "amount", "mode", "timestamp"],
    ["ETHUSD", "put", "loss", 8, "demo", "2026-08-10T09:00:00Z"],
  ]);
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  const xbuf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
  const xl = parseWorkbook(xbuf, "trades.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(xl.kind, "excel");
  assert.equal(xl.rows.length, 1);
});

test("rejects unsupported and empty files", () => {
  assert.throws(() => parseWorkbook(Buffer.from("hi"), "notes.txt", "text/plain"), /Unsupported|empty/i);
  assert.throws(() => parseWorkbook(Buffer.from([]), "a.csv", "text/csv"), /empty/i);
});

test("Pocket Option-style export infers outcome from Profit and mode from filename", () => {
  const csv = Buffer.from(
    [
      "ID,Opened,Asset,Action,Amount,Income,Profit",
      "1,2026-08-10 07:12:00,EURUSD,call,10,18.5,8.5",
      "2,2026-08-10 07:15:00,GBPUSD,put,10,0,-10",
      "3,10.08.2026 08:00:00,BTCUSDT,call,5,5,0",
    ].join("\n"),
    "utf8"
  );
  const parsed = parseWorkbook(csv, "export_demo_history_107352634.csv", "text/csv");
  const mapping = mapColumns(parsed.headers);
  assert.equal(mapping.asset, "Asset");
  assert.equal(mapping.direction, "Action");
  assert.equal(mapping.amount, "Profit");
  assert.equal(mapping.timestamp, "Opened");

  const result = classifyRows(parsed.rows, mapping, new Set(), {
    filename: "export_demo_history_107352634.csv",
  });
  assert.equal(result.counts.invalid, 0);
  assert.equal(result.counts.ready, 3);
  assert.equal(result.rows[0].sanitized.direction, "long");
  assert.equal(result.rows[0].sanitized.outcome, "win");
  assert.equal(result.rows[0].sanitized.mode, "demo");
  assert.equal(result.rows[1].sanitized.direction, "short");
  assert.equal(result.rows[1].sanitized.outcome, "loss");
  assert.equal(result.rows[2].sanitized.outcome, "breakeven");
});

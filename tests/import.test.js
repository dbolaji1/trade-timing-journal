/**
 * Unit tests for CSV/Excel mapping, call/put aliases, duplicate keys,
 * mapping caveats, and the xlsx-file parser (exceljs).
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const ExcelJS = require("exceljs");
const {
  mapColumns,
  mappingCaveats,
  normalizeDirection,
  normalizeOutcome,
  normalizeMode,
  identityKey,
  brokerKey,
  dedupeKeys,
  classifyRows,
  parseWorkbook,
  parseCsvText,
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

test("mapping prefers net P&L over bare 'amount'", () => {
  // A Pocket Option-style export: Income/Payout/Amount/Profit.
  const mapping = mapColumns(["ID", "Opened", "Asset", "Action", "Amount", "Income", "Profit"]);
  assert.equal(mapping.amount, "Profit");
  assert.equal(mapping.stake, "Amount");
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
  // Existing keys are the prefixed dedupe keys (as produced by
  // existingIdentitySet in import.js / server.js).
  const existingKeys = new Set(dedupeKeys({
    asset: "GBPUSD",
    direction: "long",
    outcome: "win",
    pnl_cents: 1250,
    mode: "real",
    timestamp_utc: "2026-08-10T07:12:00.000Z",
  }));
  const result = classifyRows(rows, mapping, existingKeys);
  assert.equal(result.counts.ready, 1);
  assert.equal(result.counts.duplicates_in_file, 1);
  assert.equal(result.counts.duplicates_in_journal, 1);
  assert.equal(result.counts.invalid, 1);
});

test("duplicate keys: broker + broker_trade_id takes priority over fingerprint", () => {
  const withBroker = {
    asset: "EURUSD", direction: "long", outcome: "win", pnl_cents: 1250,
    mode: "real", timestamp_utc: "2026-08-10T07:12:00.000Z",
    broker: "Pocket Option", broker_trade_id: "107352634",
  };
  const corrected = {
    ...withBroker,
    pnl_cents: 1251, // corrected P&L — same broker trade
    timestamp_utc: "2026-08-10T07:12:01.000Z", // reformatted timestamp
  };
  const b1 = brokerKey(withBroker);
  const b2 = brokerKey(corrected);
  assert.ok(b1 && b2);
  assert.equal(b1, b2, "broker key must ignore corrected fields");
  assert.notEqual(dedupeKeys(withBroker).join(), dedupeKeys(corrected).join(), "fingerprint differs");

  // A row WITHOUT broker/trade id falls back to the fingerprint only.
  const plain = { ...withBroker, broker: null, broker_trade_id: null };
  assert.deepEqual(dedupeKeys(plain), ["f:" + identityKey(plain)]);
});

test("classifyRows: broker-ID duplicate is detected even when P&L changed", () => {
  const headers = ["asset", "direction", "outcome", "amount", "mode", "timestamp", "ID"];
  const mapping = mapColumns(headers);
  assert.equal(mapping.broker_trade_id, "ID");
  const rows = [
    { asset: "BTCUSDT", direction: "call", outcome: "win", amount: 10, mode: "real", timestamp: "2026-08-10T07:12:00Z", ID: "999" },
    { asset: "BTCUSDT", direction: "call", outcome: "win", amount: 12.75, mode: "real", timestamp: "2026-08-10T07:13:00Z", ID: "999" },
  ];
  // existing DB contains the same broker trade id but with yet another P&L value.
  const dbKey = dedupeKeys({
    asset: "BTCUSDT", direction: "long", outcome: "win", pnl_cents: 100,
    mode: "real", timestamp_utc: "2026-08-10T07:12:00.000Z",
    broker: null, broker_trade_id: "999",
  });
  const result = classifyRows(rows, mapping, new Set(dbKey));
  assert.equal(result.counts.ready, 0);
  assert.equal(result.counts.duplicates_in_journal, 1);
  assert.equal(result.counts.duplicates_in_file, 1);
});

test("mapping caveats warn about ambiguous amount columns", () => {
  const mapping = mapColumns(["Symbol", "Action", "Result", "Payout", "Account", "Open Time"]);
  assert.equal(mapping.amount, "Payout");
  const caveats = mappingCaveats(mapping);
  assert.ok(caveats.length > 0);
  assert.ok(caveats[0].includes("Payout"));
});
test("mapping caveats are empty for unambiguous headers", () => {
  const mapping = mapColumns(["symbol", "direction", "outcome", "profit", "mode", "timestamp"]);
  assert.deepEqual(mappingCaveats(mapping), []);
});

test("parseWorkbook reads CSV (with quotes, semicolons, CRLF) and xlsx", async () => {
  const csv = Buffer.from(
    'asset,direction,outcome,amount,mode,timestamp\r\n"BTC,USDT",long,win,10,real,2026-08-10T07:12:00Z\r\n',
    "utf8"
  );
  const csvParsed = await parseWorkbook(csv, "trades.csv", "text/csv");
  assert.equal(csvParsed.kind, "csv");
  assert.equal(csvParsed.rows.length, 1);
  assert.equal(csvParsed.rows[0].asset, "BTC,USDT");

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet1");
  ws.addRow(["asset", "direction", "outcome", "amount", "mode", "timestamp"]);
  ws.addRow(["ETHUSD", "put", "loss", 8, "demo", "2026-08-10T09:00:00Z"]);
  const xbuf = Buffer.from(await wb.xlsx.writeBuffer());
  const xl = await parseWorkbook(xbuf, "trades.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
  assert.equal(xl.kind, "excel");
  assert.equal(xl.rows.length, 1);
  assert.equal(xl.rows[0].asset, "ETHUSD");
});

test("parseWorkbook treats legacy .xls as unsupported", async () => {
  await assert.rejects(
    () => parseWorkbook(Buffer.from("not really xls"), "trades.xls", "application/vnd.ms-excel"),
    /Unsupported/
  );
});

test("rejects unsupported and empty files", async () => {
  await assert.rejects(() => parseWorkbook(Buffer.from("hi"), "notes.txt", "text/plain"), /Unsupported|empty/i);
  await assert.rejects(() => parseWorkbook(Buffer.from([]), "a.csv", "text/csv"), /empty/i);
});

test("parseCsvText handles quoted commas and escaped quotes", () => {
  const rows = parseCsvText('a,"b,c",d\n"x ""y""",z,w\n', ",");
  assert.deepEqual(rows, [["a", "b,c", "d"], ['x "y"', "z", "w"]]);
});

test("Pocket Option-style export infers outcome, mode, stake and naive TZ", async () => {
  const csv = Buffer.from(
    [
      "ID,Opened,Asset,Action,Amount,Income,Profit",
      "1,2026-08-10 07:12:00,EURUSD,call,10,18.5,8.5",
      "2,2026-08-10 07:15:00,GBPUSD,put,10,0,-10",
      "3,10.08.2026 08:00:00,BTCUSDT,call,5,5,0",
    ].join("\n"),
    "utf8"
  );
  const parsed = await parseWorkbook(csv, "export_demo_history_107352634.csv", "text/csv");
  const mapping = mapColumns(parsed.headers);
  assert.equal(mapping.asset, "Asset");
  assert.equal(mapping.direction, "Action");
  assert.equal(mapping.amount, "Profit");
  assert.equal(mapping.stake, "Amount");
  assert.equal(mapping.timestamp, "Opened");
  assert.equal(mapping.broker_trade_id, "ID");

  const result = classifyRows(parsed.rows, mapping, new Set(), {
    filename: "export_demo_history_107352634.csv",
  });
  assert.equal(result.counts.invalid, 0);
  assert.equal(result.counts.ready, 3);
  assert.equal(result.rows[0].sanitized.direction, "long");
  assert.equal(result.rows[0].sanitized.outcome, "win");
  assert.equal(result.rows[0].sanitized.mode, "demo");
  assert.equal(result.rows[0].sanitized.stake_cents, 1000);
  assert.equal(result.rows[0].sanitized.broker_trade_id, "1");
  assert.equal(result.rows[1].sanitized.direction, "short");
  assert.equal(result.rows[1].sanitized.outcome, "loss");
  assert.equal(result.rows[2].sanitized.outcome, "breakeven");
  // Naive file times are Africa/Lagos (UTC+1), so 07:12 Lagos → 06:12 UTC.
  assert.equal(result.rows[0].sanitized.timestamp_utc, "2026-08-10T06:12:00.000Z");
});

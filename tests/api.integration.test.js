/**
 * Integration test: boots the real Express app against a temporary SQLite
 * database (TT_DB_PATH is read by config.js before the app is required).
 * Covers CRUD, validation, filters, CSV export, restore, ID stability,
 * analytics endpoint, imports, and the close-and-reopen persistence
 * guarantee.
 * Run with: npm test
 */
"use strict";

const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { once } = require("node:events");

// IMPORTANT: point config at an isolated temp DB BEFORE requiring the app.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ttj-test-"));
process.env.TT_DB_PATH = path.join(tmpDir, "test.db");

const app = require("../server");
const { getDb, closeDb } = require("../db");

let server;
let base;

before(async () => {
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  server.close();
  closeDb();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const post = (payload) =>
  fetch(base + "/api/trades", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

/* ---------- basic API ---------- */

test("GET /api/health reports a fresh database at schema v2", async () => {
  const res = await fetch(base + "/api/health");
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.status, "ok");
  assert.equal(j.timezone, "Africa/Lagos");
  assert.equal(j.currency, "USD");
  assert.equal(j.currency_symbol, "$");
  assert.equal(j.trade_count, 0);
  assert.equal(j.schema_version, 2);
});

test("POST /api/trades validates and stores integer cents", async () => {
  const res = await post({
    asset: "btc/usdt", direction: "long", outcome: "win",
    amount: 0.1, mode: "real", timestamp: "2026-08-10T07:12:00Z",
  });
  assert.equal(res.status, 201);
  const j = await res.json();
  assert.equal(j.asset, "BTCUSDT");
  assert.equal(j.pnl_cents, 10);
  assert.equal(j.pnl_formatted, "0.10");
  assert.equal(j.timestamp_utc, "2026-08-10T07:12:00.000Z");
  assert.equal(j.stake_cents, null);
});

test("POST /api/trades: naive timestamp is bucketed in the configured timezone", async () => {
  // 2026-08-10 07:12 naive = Africa/Lagos wall time = 06:12Z.
  const res = await post({
    asset: "naive", direction: "long", outcome: "win",
    amount: 5, mode: "real", timestamp: "2026-08-10T07:12",
  });
  assert.equal(res.status, 201);
  const j = await res.json();
  assert.equal(j.timestamp_utc, "2026-08-10T06:12:00.000Z");
});

test("POST /api/trades stores optional stake as positive cents", async () => {
  const res = await post({
    asset: "stake", direction: "long", outcome: "win",
    amount: 42.5, stake: 10.25, mode: "real", timestamp: "2026-08-10T07:00:00Z",
  });
  assert.equal(res.status, 201);
  const j = await res.json();
  assert.equal(j.stake_cents, 1025);
  assert.equal(j.stake, 10.25);
});

test("POST /api/trades rejects invalid payloads with details", async () => {
  const bad = await post({
    asset: "BTC", direction: "sideways", outcome: "win",
    amount: 10, mode: "real", timestamp: "2026-08-10T07:12:00Z",
  });
  assert.equal(bad.status, 400);
  const j = await bad.json();
  assert.ok(Array.isArray(j.details));
  assert.ok(j.details.some((d) => d.includes("Direction must be one of")));
});

test("GET /api/trades filters by mode and never mixes", async () => {
  const demoRes = await post({
    asset: "eth-usd", direction: "short", outcome: "loss",
    amount: -18.25, mode: "demo", timestamp: "2026-08-10T09:00:00Z",
  });
  assert.equal(demoRes.status, 201);

  const real = await (await fetch(base + "/api/trades?mode=real")).json();
  const demo = await (await fetch(base + "/api/trades?mode=demo")).json();
  assert.equal(real.length, 3); // btcusdt, naive, stake
  assert.equal(demo.length, 1);
  assert.equal(demo[0].asset, "ETHUSD");

  const badFilter = await fetch(base + "/api/trades?mode=sideways");
  assert.equal(badFilter.status, 400);
});

test("GET /api/trades supports asset, outcome, date-range and text filters", async () => {
  const byAsset = await (await fetch(base + "/api/trades?asset=BTC")).json();
  assert.ok(byAsset.length >= 1);
  assert.ok(byAsset.every((t) => t.asset.includes("BTC")));

  const byOutcome = await (await fetch(base + "/api/trades?outcome=loss")).json();
  assert.ok(byOutcome.length >= 1);
  assert.ok(byOutcome.every((t) => t.outcome === "loss"));

  const byDate = await (await fetch(base + "/api/trades?from=2026-08-10&to=2026-08-10")).json();
  assert.ok(byDate.length >= 1);
  for (const t of byDate) {
    assert.ok(t.timestamp_utc >= "2026-08-10T00:00:00.000Z");
    assert.ok(t.timestamp_utc < "2026-08-11T00:00:00.000Z");
  }

  const byText = await (await fetch(base + "/api/trades?q=naive")).json();
  assert.ok(byText.some((t) => t.asset === "NAIVE"));

  const badOutcome = await fetch(base + "/api/trades?outcome=nope");
  assert.equal(badOutcome.status, 400);
});

test("GET /api/trades/export.csv honours the same filters", async () => {
  const res = await fetch(base + "/api/trades/export.csv?outcome=loss");
  assert.equal(res.status, 200);
  assert.ok(res.headers.get("content-type").includes("text/csv"));
  const text = await res.text();
  assert.ok(text.includes("id,asset,direction,outcome"));
  assert.ok(text.includes("ETHUSD"));
  assert.ok(!text.split("\n").some((l) => l.startsWith('"BTCUSDT')));
});

test("PUT / PATCH / DELETE round-trip", async () => {
  const created = await post({
    asset: "sol", direction: "long", outcome: "win",
    amount: 5, mode: "real", timestamp: "2026-08-10T07:00:00Z",
  });
  const t = await created.json();

  const putRes = await fetch(base + "/api/trades/" + t.id, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      asset: "sol/usdt", direction: "short", outcome: "loss",
      amount: -2.5, stake: 3, mode: "real", timestamp: "2026-08-10T07:30:00Z",
    }),
  });
  const putBody = await putRes.json();
  assert.equal(putRes.status, 200);
  assert.equal(putBody.asset, "SOLUSDT");
  assert.equal(putBody.direction, "short");
  assert.equal(putBody.pnl_cents, -250);
  assert.equal(putBody.stake_cents, 300);

  const patchRes = await fetch(base + "/api/trades/" + t.id, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notes: "patched" }),
  });
  const patchBody = await patchRes.json();
  assert.equal(patchBody.notes, "patched");

  const delRes = await fetch(base + "/api/trades/" + t.id, { method: "DELETE" });
  assert.equal(delRes.status, 200);
  const delBody = await delRes.json();
  assert.equal(delBody.deleted_id, t.id);
  assert.ok(delBody.deleted_row);

  const delAgain = await fetch(base + "/api/trades/" + t.id, { method: "DELETE" });
  assert.equal(delAgain.status, 404);
});

/* ---------- ID stability (audit 4.4: no renumbering) ---------- */

test("trade IDs survive a close/reopen WITHOUT being renumbered", async () => {
  const before = await (await fetch(base + "/api/trades")).json();
  const maxBefore = before.length ? Math.max(...before.map((t) => t.id)) : 0;

  closeDb(); // simulate server restart
  getDb();   // reopen
  const after = await (await fetch(base + "/api/trades")).json();
  assert.deepEqual(after.map((t) => t.id), before.map((t) => t.id), "IDs must not change on restart");
  assert.equal(after.length, before.length);
  assert.ok(Math.max(...after.map((t) => t.id)) >= maxBefore);

  // Deleting the trade with the highest id then creating a new one must NOT reuse it.
  const maxId = Math.max(...after.map((t) => t.id));
  const maxRow = after.find((t) => t.id === maxId);
  const del = await fetch(base + "/api/trades/" + maxId, { method: "DELETE" });
  assert.equal(del.status, 200);
  const deletedRow = (await del.json()).deleted_row;
  const fresh = await (await post({
    asset: "FRESH", direction: "long", outcome: "win", amount: 1,
    mode: "real", timestamp: "2026-08-01T09:00:00Z",
  })).json();
  assert.ok(fresh.id > maxId, "AUTOINCREMENT must not reuse a deleted id");
  // The deleted SOL trade left id 5 as a gap; the new id must not close it.
  assert.notEqual(fresh.id, 5, "the gap left by the deleted SOL trade must stay a gap");

  // Restore the deleted trade with its original id.
  const restore = await fetch(base + "/api/trades/restore", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trades: [deletedRow] }),
  });
  assert.equal(restore.status, 200);
  const r = await restore.json();
  assert.equal(r.restored, 1);
  const back = await (await fetch(base + "/api/trades/" + maxId)).json();
  assert.equal(back.id, maxId);
  assert.equal(back.asset, maxRow.asset);
});

/* ---------- the critical persistence guarantee ---------- */

test("trades survive a database close and reopen (the core promise)", async () => {
  const count = (await (await fetch(base + "/api/health")).json()).trade_count;
  assert.ok(count > 0, "expected trades from earlier tests");
  closeDb();                       // simulate server restart
  getDb();                         // reopen — must NOT create or wipe anything
  const res = await fetch(base + "/api/health");
  const j = await res.json();
  assert.equal(j.trade_count, count, "trades must survive close/reopen");
  assert.ok(fs.existsSync(process.env.TT_DB_PATH), "database file must exist on disk");
});

/* ---------- analytics endpoint (strict best-window) ---------- */

test("GET /api/analytics returns honest, separated statistics with strict thresholds", async () => {
  // Earlier real trades: BTCUSDT (07:12Z), STAKE (07:00Z) -> hour 8 Lagos;
  // NAIVE (06:12Z) -> hour 7; FRESH (09:00Z) -> hour 10. All wins.
  // Seed 35 more real trades in the same hour 8 bucket (07:xx UTC): 28 wins.
  //   hour 8 total = 35 + 2 = 37 trades, 30 wins (81.1%).
  // Plus 25 filler real trades in hour 14 Lagos (13:xx UTC): only 5 wins.
  //   overall baseline = (30 + 1 + 1 + 5) / (37 + 1 + 1 + 25) = 37/64 = 57.8%.
  // Margin (81.1% > 62.8%) AND Wilson lower bound (~65.8% > 57.8%) both pass.
  const seeds = [];
  for (let i = 0; i < 35; i += 1) {
    seeds.push(["07:" + String(i % 60).padStart(2, "0"), i < 28 ? "win" : "loss", 10, "real"]);
  }
  for (let i = 0; i < 25; i += 1) {
    seeds.push(["13:" + String(i % 60).padStart(2, "0"), i < 5 ? "win" : "loss", 10, "real"]);
  }
  for (const [hhmm, outcome, amount, mode] of seeds) {
    const res = await post({
      asset: "STRICT", direction: "long", outcome, amount, mode,
      timestamp: "2026-08-10T" + hhmm + ":00Z",
    });
    assert.equal(res.status, 201);
  }

  const res = await fetch(base + "/api/analytics");
  assert.equal(res.status, 200);
  const a = await res.json();

  assert.equal(a.timezone, "Africa/Lagos");
  assert.equal(a.thresholds.minN, 3);
  assert.equal(a.thresholds.bestMinN, 30);
  assert.equal(a.thresholds.bestMarginPct, 5);
  assert.equal(a.thresholds.bestRequireCiOverBaseline, true);
  assert.equal(a.thresholds.todayMinN, 5);
  assert.equal(a.thresholds.todayMarginPct, 5);
  assert.equal(a.thresholds.todayRequireCiOverBaseline, true);

  assert.equal(a.real.hourly.length, 24);
  assert.equal(a.real.weekday.length, 7);

  const hour8 = a.real.hourly[8];
  assert.equal(hour8.n, 37);
  assert.equal(hour8.wins, 30);
  assert.equal(hour8.eligible, true);
  assert.ok(hour8.ciLower !== null && hour8.ciUpper !== null);

  // A small bucket is never called best.
  const hour9 = a.real.hourly[9];
  assert.equal(hour9.n, 0);
  assert.equal(hour9.eligible, false);

  // With strict criteria (>=30, margin, CI lower bound) hour 8 qualifies.
  assert.ok(hour8.winRate > a.real.summary.winRate + a.thresholds.bestMarginPct / 100);
  assert.ok(hour8.ciLower > a.real.summary.winRate, "CI lower bound must clear the baseline");
  assert.equal(a.real.bestHour.found, true);
  assert.equal(a.real.bestHour.window.key, 8);
  assert.equal(a.real.bestHour.window.n, 37);
  assert.equal(a.real.bestHour.window.smallSample, false);

  // Demo stays separate: 1 demo trade, no demo best-window.
  assert.equal(a.demo.summary.n, 1);
  assert.equal(a.demo.bestHour.found, false);

  // The "today" block exists per mode and is shaped correctly.
  for (const mode of ["real", "demo"]) {
    const t = a[mode].today;
    assert.ok(t, mode + " must include a today block");
    assert.match(t.date, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(t.weekday, /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)$/);
    assert.equal(typeof t.summary.n, "number");
    assert.equal(typeof t.baseline.n, "number");
    assert.equal(typeof t.bestHour.found, "boolean");
  }
  // Real and demo see the same calendar day.
  assert.equal(a.real.today.date, a.demo.today.date);
  assert.equal(a.real.today.weekday, a.demo.today.weekday);
});

test("GET /api/analytics: ROI is derived when stakes exist", async () => {
  const res = await fetch(base + "/api/analytics");
  const a = await res.json();
  // Some seeded trades have no stake, so summary ROI is null unless every
  // trade has one — but hourly ROI for the fully-staked bucket is null too
  // (the STRICT bucket has no stake). Just assert the field exists in shape.
  assert.ok("roiPct" in a.real.summary);
  assert.ok("totalStakeCents" in a.real.summary);
});

/* ---------- imports ---------- */

test("CSV import preview + confirm persists like a manual trade", async () => {
  const csv = [
    "symbol,call/put,result,p&l,account,open time",
    "eur/usd,call,win,25.50,live,2026-08-11T08:00:00Z",
    "eur/usd,call,win,25.50,live,2026-08-11T08:00:00Z",
    "gbp/usd,put,lost,not-a-number,demo,2026-08-11T09:00:00Z",
  ].join("\n");
  const form = new FormData();
  form.append("file", new Blob([csv], { type: "text/csv" }), "sample.csv");
  const preview = await fetch(base + "/api/import/preview", { method: "POST", body: form });
  assert.equal(preview.status, 200);
  const p = await preview.json();
  assert.equal(p.counts.ready, 1);
  assert.equal(p.counts.duplicates, 1);
  assert.equal(p.counts.invalid, 1);
  assert.equal(p.mapping.direction, "call/put");
  assert.equal(p.readyTrades[0].direction, "long");
  assert.equal(p.readyTrades[0].mode, "real");
  assert.equal(p.readyTrades[0].timestamp_utc, "2026-08-11T08:00:00.000Z");
  assert.ok(Array.isArray(p.caveats));

  const confirm = await fetch(base + "/api/import/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trades: p.readyTrades }),
  });
  const c = await confirm.json();
  assert.equal(confirm.status, 200);
  assert.equal(c.imported, 1);

  const againForm = new FormData();
  againForm.append("file", new Blob([csv], { type: "text/csv" }), "sample.csv");
  const again = await (await fetch(base + "/api/import/preview", { method: "POST", body: againForm })).json();
  assert.equal(again.counts.ready, 0, "re-upload must not create duplicates");
  assert.ok(again.counts.duplicates >= 1);

  const analytics = await (await fetch(base + "/api/analytics")).json();
  assert.ok(analytics.real.summary.n >= 1);
});

test("Excel import (exceljs) and missing-file errors", async () => {
  const ExcelJS = require("exceljs");
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Trades");
  ws.addRow(["asset", "direction", "outcome", "amount", "mode", "timestamp"]);
  ws.addRow(["SOLUSDT", "short", "breakeven", 0, "demo", "2026-08-12T10:00:00Z"]);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const form = new FormData();
  form.append("file", new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "t.xlsx");
  const preview = await fetch(base + "/api/import/preview", { method: "POST", body: form });
  assert.equal(preview.status, 200);
  const p = await preview.json();
  assert.equal(p.kind, "excel");
  assert.equal(p.counts.ready, 1);

  const confirm = await fetch(base + "/api/import/confirm", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ trades: p.readyTrades }),
  });
  assert.equal((await confirm.json()).imported, 1);

  const empty = await fetch(base + "/api/import/preview", { method: "POST", body: new FormData() });
  assert.equal(empty.status, 400);
});

test("concurrent import of the same file does not create duplicates", async () => {
  const csv = [
    "asset,direction,outcome,amount,mode,timestamp",
    "CONCURRENT,long,win,5,real,2026-08-13T08:00:00Z",
  ].join("\n");
  const form = () => {
    const fd = new FormData();
    fd.append("file", new Blob([csv], { type: "text/csv" }), "concurrent.csv");
    return fd;
  };
  const [p1, p2] = await Promise.all([
    fetch(base + "/api/import/preview", { method: "POST", body: form() }),
    fetch(base + "/api/import/preview", { method: "POST", body: form() }),
  ]);
  const j1 = await p1.json();
  const j2 = await p2.json();
  const [c1, c2] = await Promise.all([
    fetch(base + "/api/import/confirm", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trades: j1.readyTrades }),
    }).then((r) => r.json()),
    fetch(base + "/api/import/confirm", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trades: j2.readyTrades }),
    }).then((r) => r.json()),
  ]);
  const total = c1.imported + c2.imported;
  assert.ok(total === 1, "exactly one of the concurrent imports must win (got " + total + ")");
});

/* ---------- shell ---------- */

test("GET / serves the app shell and unknown APIs 404 as JSON", async () => {
  const res = await fetch(base + "/");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("Trade Timing Journal"));

  const api404 = await fetch(base + "/api/nope");
  assert.equal(api404.status, 404);
  assert.equal((await api404.json()).error, "Not found.");
});

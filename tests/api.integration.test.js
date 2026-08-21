/**
 * Integration test: boots the real Express app against a temporary SQLite
 * database (TT_DB_PATH is read by config.js before the app is required).
 * Covers CRUD, validation, filters, analytics endpoint, and the
 * close-and-reopen persistence guarantee.
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

test("GET /api/health reports a fresh database", async () => {
  const res = await fetch(base + "/api/health");
  assert.equal(res.status, 200);
  const j = await res.json();
  assert.equal(j.status, "ok");
  assert.equal(j.timezone, "Africa/Lagos");
  assert.equal(j.trade_count, 0);
  assert.equal(j.schema_version, 1);
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
  assert.equal(real.length, 1);
  assert.equal(demo.length, 1);
  assert.equal(real[0].asset, "BTCUSDT");
  assert.equal(demo[0].asset, "ETHUSD");

  const badFilter = await fetch(base + "/api/trades?mode=sideways");
  assert.equal(badFilter.status, 400);
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
      amount: -2.5, mode: "real", timestamp: "2026-08-10T07:30:00Z",
    }),
  });
  const putBody = await putRes.json();
  assert.equal(putRes.status, 200);
  assert.equal(putBody.asset, "SOLUSDT");
  assert.equal(putBody.direction, "short");
  assert.equal(putBody.pnl_cents, -250);

  const patchRes = await fetch(base + "/api/trades/" + t.id, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ notes: "patched" }),
  });
  const patchBody = await patchRes.json();
  assert.equal(patchBody.notes, "patched");

  const delRes = await fetch(base + "/api/trades/" + t.id, { method: "DELETE" });
  assert.equal(delRes.status, 200);
  const delAgain = await fetch(base + "/api/trades/" + t.id, { method: "DELETE" });
  assert.equal(delAgain.status, 404);
});

/* ---------- the critical persistence guarantee ---------- */

test("trades survive a database close and reopen (the core promise)", async () => {
  // Current state: BTCUSDT (real) + ETHUSD (demo) = 2 trades.
  closeDb();                       // simulate server restart
  getDb();                         // reopen — must NOT create or wipe anything
  const res = await fetch(base + "/api/health");
  const j = await res.json();
  assert.equal(j.trade_count, 2, "trades must survive close/reopen");
  assert.ok(fs.existsSync(process.env.TT_DB_PATH), "database file must exist on disk");
});

/* ---------- analytics endpoint ---------- */

test("GET /api/analytics returns honest, separated statistics", async () => {
  // Seed enough real trades so a best hour can qualify (hour 8 Lagos = 07:xx UTC):
  // 5 real trades in hour 8 (4 wins), plus fillers in hour 10.
  const seeds = [
    ["07:10", "win", 100, "real"],
    ["07:20", "win", 80, "real"],
    ["07:30", "win", 60, "real"],
    ["07:40", "loss", -40, "real"],
    ["07:50", "win", 90, "real"],
    ["09:10", "loss", -20, "real"],
    ["09:20", "loss", -30, "real"],
    ["09:30", "win", 40, "real"],
    ["09:40", "loss", -25, "real"],
    ["09:50", "win", 55, "real"],
  ];
  for (const [hhmm, outcome, amount, mode] of seeds) {
    const res = await post({
      asset: "BTC", direction: "long", outcome, amount, mode,
      timestamp: "2026-08-10T" + hhmm + ":00Z",
    });
    assert.equal(res.status, 201);
  }

  const res = await fetch(base + "/api/analytics");
  assert.equal(res.status, 200);
  const a = await res.json();

  assert.equal(a.timezone, "Africa/Lagos");
  assert.equal(a.thresholds.minN, 3);
  assert.equal(a.thresholds.bestMinN, 5);
  assert.equal(a.thresholds.bestMarginPct, 5);

  // Real: 10 seeds + 1 earlier BTCUSDT = 11 trades.
  assert.equal(a.real.summary.n, 11);
  assert.equal(a.real.hourly.length, 24);
  assert.equal(a.real.weekday.length, 7);

  // Hour 8 Lagos: 5 seeds (07:xx UTC) + the earlier BTCUSDT (07:12 UTC) = 6 trades.
  const hour8 = a.real.hourly[8];
  assert.equal(hour8.n, 6);
  assert.equal(hour8.wins, 5);
  assert.equal(hour8.eligible, true);
  assert.ok(hour8.ciLower !== null && hour8.ciUpper !== null);

  // Hour 9 Lagos (08:xx UTC) has no trades -> below MIN_N.
  const hour9 = a.real.hourly[9];
  assert.equal(hour9.n, 0);
  assert.equal(hour9.eligible, false);
  assert.equal(hour9.winRate, null);

  // Best hour must exist and must be hour 8 (5 wins / 6, above baseline + margin).
  assert.equal(a.real.bestHour.found, true);
  assert.equal(a.real.bestHour.window.key, 8);
  assert.equal(a.real.bestHour.window.n, 6);
  assert.equal(a.real.bestHour.window.smallSample, true);

  // Demo stays separate: 1 demo trade, no demo best-window.
  assert.equal(a.demo.summary.n, 1);
  assert.equal(a.demo.bestHour.found, false);
});

test("GET / serves the app shell", async () => {
  const res = await fetch(base + "/");
  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("Trade Timing Journal"));
});

/**
 * Tests for server-side validation and money handling.
 * Run with: npm test
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  normalizeAsset,
  toCents,
  formatCents,
  derivePnlSign,
  validateTrade,
} = require("../validation");

test("normalizeAsset: uppercase + separators stripped", () => {
  assert.equal(normalizeAsset("btc/usdt"), "BTCUSDT");
  assert.equal(normalizeAsset(" btc-usdt "), "BTCUSDT");
  assert.equal(normalizeAsset("eur_usd"), "EURUSD");
  assert.equal(normalizeAsset("  xrp.usdt  "), "XRPUSDT");
  assert.equal(normalizeAsset("gold"), "GOLD");
  assert.equal(normalizeAsset("   "), "");
  assert.equal(normalizeAsset(123), "");
});

test("toCents: money -> integer cents, no floating-point drift", () => {
  assert.equal(toCents(0.1), 10);
  assert.equal(toCents(123.45), 12345);
  assert.equal(toCents(-0.05), -5);
  assert.equal(toCents("25.5"), 2550);
  // 1.005 is 100.4999... in binary floating point, so it rounds to 100 cents.
  // This is expected round-to-nearest-cent behavior on the decimal value 1.005.
  assert.equal(toCents(1.005), 100);
  assert.equal(toCents(2.675), 268);
  assert.equal(toCents(0), 0);
});

test("formatCents: integer cents -> display string", () => {
  assert.equal(formatCents(10), "0.10");
  assert.equal(formatCents(-5), "-0.05");
  assert.equal(formatCents(12345), "123.45");
  assert.equal(formatCents(0), "0.00");
  assert.equal(formatCents(-1825), "-18.25");
});

test("validateTrade: valid payload is sanitized for the DB", () => {
  const { valid, errors, sanitized } = validateTrade({
    asset: "btc/usdt",
    direction: "LONG",
    outcome: "Win",
    amount: 42.5,
    mode: "REAL",
    notes: "  hello  ",
    timestamp: "2026-08-10T08:12:00Z",
  });
  assert.equal(valid, true, JSON.stringify(errors));
  assert.equal(sanitized.asset, "BTCUSDT");
  assert.equal(sanitized.direction, "long");
  assert.equal(sanitized.outcome, "win");
  assert.equal(sanitized.mode, "real");
  assert.equal(sanitized.pnl_cents, 4250);
  assert.equal(sanitized.notes, "hello");
  assert.equal(sanitized.timestamp_utc, "2026-08-10T08:12:00.000Z");
});

test("validateTrade: invalid enums are rejected with useful messages", () => {
  const base = { asset: "BTC", outcome: "win", amount: 10, mode: "real", timestamp: "2026-08-10T08:12:00Z" };
  const bad = validateTrade({ ...base, direction: "sideways" });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some((e) => e.includes("Direction must be one of: long, short.")));

  const bad2 = validateTrade({ ...base, direction: "long", outcome: "nope" });
  assert.equal(bad2.valid, false);
  assert.ok(bad2.errors.some((e) => e.includes("Outcome must be one of: win, loss, breakeven.")));

  const bad3 = validateTrade({ ...base, direction: "long", mode: "paper" });
  assert.equal(bad3.valid, false);
  assert.ok(bad3.errors.some((e) => e.includes("Mode must be one of: real, demo.")));
});

test("validateTrade: amount must be finite", () => {
  const base = { asset: "BTC", direction: "long", outcome: "win", mode: "real", timestamp: "2026-08-10T08:12:00Z" };
  for (const badAmount of ["abc", "", null, undefined, Infinity, NaN]) {
    const r = validateTrade({ ...base, amount: badAmount });
    assert.equal(r.valid, false, "amount " + badAmount + " should fail");
  }
});

test("validateTrade: timestamp must parse and be plausible", () => {
  const base = { asset: "BTC", direction: "long", outcome: "win", amount: 10, mode: "real" };
  const bad = validateTrade({ ...base, timestamp: "not-a-date" });
  assert.equal(bad.valid, false);
  assert.ok(bad.errors.some((e) => e.includes("Timestamp must be a valid date/time")));

  const ancient = validateTrade({ ...base, timestamp: "1999-01-01T00:00:00Z" });
  assert.equal(ancient.valid, false);
  assert.ok(ancient.errors.some((e) => e.includes("year 2000")));

  const future = validateTrade({ ...base, timestamp: "2030-01-01T00:00:00Z" });
  assert.equal(future.valid, false);
  assert.ok(future.errors.some((e) => e.includes("24 hours in the future")));
});

test("validateTrade: required fields are enforced", () => {
  const r = validateTrade({});
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes("Asset is required")));
  assert.ok(r.errors.some((e) => e.includes("Direction is required")));
  assert.ok(r.errors.some((e) => e.includes("Outcome is required")));
  assert.ok(r.errors.some((e) => e.includes("Mode is required")));
  assert.ok(r.errors.some((e) => e.includes("Timestamp is required")));
});

test("validateTrade: notes limited to 2000 characters", () => {
  const r = validateTrade({
    asset: "BTC", direction: "long", outcome: "win", amount: 10, mode: "real",
    timestamp: "2026-08-10T08:12:00Z", notes: "x".repeat(2001),
  });
  assert.equal(r.valid, false);
  assert.ok(r.errors.some((e) => e.includes("2000 characters")));
});

test("validateTrade: partial mode accepts a subset of fields", () => {
  const r = validateTrade({ asset: "xbt" }, { partial: true });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.equal(r.sanitized.asset, "XBT");
  assert.equal(r.sanitized.pnl_cents, undefined);
  assert.equal(r.sanitized.timestamp_utc, undefined);
});

test("validateTrade: pnl_cents integer input is accepted directly", () => {
  const r = validateTrade({
    asset: "BTC", direction: "long", outcome: "win", pnl_cents: 12345,
    mode: "real", timestamp: "2026-08-10T08:12:00Z",
  });
  assert.equal(r.valid, true, JSON.stringify(r.errors));
  assert.equal(r.sanitized.pnl_cents, 12345);
});

test("validateTrade: P&L sign is derived from the outcome", () => {
  const base = { asset: "BTC", direction: "long", mode: "real", timestamp: "2026-08-10T08:12:00Z" };

  // win is always positive, even if a negative sign was typed
  const win = validateTrade({ ...base, outcome: "win", amount: -42.5 });
  assert.equal(win.valid, true, JSON.stringify(win.errors));
  assert.equal(win.sanitized.outcome, "win");
  assert.equal(win.sanitized.pnl_cents, 4250);

  // loss is always negative, even if a positive sign was typed
  const loss = validateTrade({ ...base, outcome: "loss", amount: 18.25 });
  assert.equal(loss.valid, true, JSON.stringify(loss.errors));
  assert.equal(loss.sanitized.outcome, "loss");
  assert.equal(loss.sanitized.pnl_cents, -1825);

  // breakeven is exactly zero, regardless of the value typed
  const be = validateTrade({ ...base, outcome: "breakeven", amount: 12.5 });
  assert.equal(be.valid, true, JSON.stringify(be.errors));
  assert.equal(be.sanitized.pnl_cents, 0);
});

test("derivePnlSign: sign applied to a direct pnl_cents input too", () => {
  assert.equal(derivePnlSign("win", -12345), 12345);
  assert.equal(derivePnlSign("loss", 12345), -12345);
  assert.equal(derivePnlSign("breakeven", 9876), 0);
  assert.equal(derivePnlSign("win", 100), 100);
  assert.equal(derivePnlSign("loss", -100), -100);
});

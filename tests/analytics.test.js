/**
 * Tests for the analytics engine.
 * Fixed timestamp fixtures make timezone/bucketing tests deterministic.
 * Run with: npm test
 */
"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const CONFIG = require("../config");
const {
  bucketTimestamp,
  wilsonInterval,
  buildBucketStats,
  summarizeTrades,
  pickBestWindow,
  computeAnalytics,
} = require("../analytics");

// A small-N configuration for testing the SELECTION/ranking logic without
// seeding hundreds of trades. The production config (CONFIG.ANALYTICS) keeps
// the strict 30-trade + CI-over-baseline guard.
const TEST_CFG = {
  MIN_N: 3,
  BEST_MIN_N: 5,
  BEST_MARGIN: 0.05,
  BEST_SMALL_SAMPLE_N: 30,
  BEST_REQUIRE_CI_OVER_BASELINE: false,
  WILSON_Z: 1.96,
};

/* ---------- helpers ---------- */

// Timestamp helper: Lagos is UTC+1 with no DST, so hour h in Lagos = h-1 in UTC
// (for h >= 8 we stay safely away from midnight in this fixture).
function lagosHour(h, day = 15, minute = 30) {
  const utcHour = String(h - 1).padStart(2, "0");
  return `2024-01-${String(day).padStart(2, "0")}T${utcHour}:${String(minute).padStart(2, "0")}:00Z`;
}

function trade(ts, outcome, cents, mode = "real", stake) {
  return {
    timestamp_utc: ts, outcome, pnl_cents: cents, mode,
    stake_cents: stake === undefined ? null : stake,
  };
}

/* ============================================================
 * Timezone-aware bucketing (fixed fixtures)
 * ============================================================ */

test("bucketTimestamp: UTC -> Africa/Lagos (UTC+1, no DST)", () => {
  // 12:00Z Monday -> 13:00 Monday in Lagos
  assert.deepEqual(
    { hour: bucketTimestamp("2024-01-15T12:00:00Z", "Africa/Lagos").hour,
      weekday: bucketTimestamp("2024-01-15T12:00:00Z", "Africa/Lagos").weekday },
    { hour: 13, weekday: "Mon" }
  );

  // 23:30Z Monday -> 00:30 Tuesday in Lagos (crosses midnight AND weekday)
  assert.deepEqual(
    { hour: bucketTimestamp("2024-01-15T23:30:00Z", "Africa/Lagos").hour,
      weekday: bucketTimestamp("2024-01-15T23:30:00Z", "Africa/Lagos").weekday },
    { hour: 0, weekday: "Tue" }
  );
});

test("bucketTimestamp: handles a DST timezone correctly (America/New_York)", () => {
  // 2024-03-10 is the US spring-forward day (Sunday).
  // 06:30Z is still EST (UTC-5) -> 01:30 local
  assert.deepEqual(
    { hour: bucketTimestamp("2024-03-10T06:30:00Z", "America/New_York").hour,
      weekday: bucketTimestamp("2024-03-10T06:30:00Z", "America/New_York").weekday },
    { hour: 1, weekday: "Sun" }
  );
  // 08:30Z is after the 07:00Z switch to EDT (UTC-4) -> 04:30 local
  assert.deepEqual(
    { hour: bucketTimestamp("2024-03-10T08:30:00Z", "America/New_York").hour,
      weekday: bucketTimestamp("2024-03-10T08:30:00Z", "America/New_York").weekday },
    { hour: 4, weekday: "Sun" }
  );
});

test("bucketTimestamp: rejects bad inputs", () => {
  assert.throws(() => bucketTimestamp("not-a-date", "Africa/Lagos"));
  assert.throws(() => bucketTimestamp("2024-01-15T12:00:00Z", "Mars/Olympus"));
});

/* ============================================================
 * Wilson score interval
 * ============================================================ */

test("wilsonInterval: matches known reference values", () => {
  const approx = (a, b) => assert.ok(Math.abs(a - b) < 0.001, `${a} vs ${b}`);

  let ci = wilsonInterval(1, 2);
  approx(ci.lower, 0.0945);
  approx(ci.upper, 0.9055);

  ci = wilsonInterval(0, 1);
  approx(ci.lower, 0.0);
  approx(ci.upper, 0.7935);

  ci = wilsonInterval(1, 1);
  approx(ci.lower, 0.2065);
  approx(ci.upper, 1.0);

  ci = wilsonInterval(3, 5);
  approx(ci.lower, 0.2307);
  approx(ci.upper, 0.8824);

  ci = wilsonInterval(5, 5);
  approx(ci.lower, 0.5655);
  approx(ci.upper, 1.0);
});

test("wilsonInterval: symmetry and sanity properties", () => {
  const sym = wilsonInterval(2, 8);
  const rev = wilsonInterval(6, 8);
  assert.ok(Math.abs(sym.lower - (1 - rev.upper)) < 1e-9);

  // More wins -> higher lower bound (same n)
  assert.ok(wilsonInterval(4, 5).lower > wilsonInterval(3, 5).lower);
  // More data at same rate -> tighter interval
  const small = wilsonInterval(2, 4);
  const big = wilsonInterval(5, 10);
  assert.ok(big.upper - big.lower < small.upper - small.lower);
  // Always within [0, 1]
  for (const [w, n] of [[0, 3], [3, 3], [1, 10]]) {
    const c = wilsonInterval(w, n);
    assert.ok(c.lower >= 0 && c.upper <= 1 && c.lower <= c.upper);
  }
});

test("wilsonInterval: rejects nonsense inputs", () => {
  assert.throws(() => wilsonInterval(2, 1));
  assert.throws(() => wilsonInterval(-1, 5));
  assert.throws(() => wilsonInterval(0, 0));
  assert.throws(() => wilsonInterval(1.5, 3));
});

/* ============================================================
 * Bucket stats + minimum sample size
 * ============================================================ */

test("buildBucketStats: buckets below MIN_N are marked ineligible", () => {
  const trades = [
    trade(lagosHour(8, 15, 10), "win", 100),
    trade(lagosHour(8, 15, 20), "loss", -50),
  ];
  const hourly = buildBucketStats(trades, "hour", "Africa/Lagos", TEST_CFG);
  assert.equal(hourly.length, 24);
  const b8 = hourly[8];
  assert.equal(b8.n, 2);
  assert.equal(b8.eligible, false);
  assert.equal(b8.winRate, null);
  assert.equal(b8.ciLower, null);
  assert.equal(b8.expectancyCents, null);
  // Every other bucket is empty
  assert.equal(hourly.filter((b) => b.n > 0).length, 1);
});

test("buildBucketStats: eligible bucket gets win rate, expectancy, CI", () => {
  const trades = [
    trade(lagosHour(8, 15, 10), "win", 100),
    trade(lagosHour(8, 15, 20), "loss", -50),
    trade(lagosHour(8, 15, 40), "breakeven", 0),
  ];
  const b8 = buildBucketStats(trades, "hour", "Africa/Lagos", TEST_CFG)[8];
  assert.equal(b8.eligible, true);
  assert.equal(b8.wins, 1);
  assert.ok(Math.abs(b8.winRate - 1 / 3) < 1e-9);
  assert.equal(b8.expectancyCents, Math.round(50 / 3)); // integer-cent math
  assert.ok(b8.ciLower > 0 && b8.ciUpper < 1);
  assert.equal(b8.totalStakeCents, 0);
  assert.equal(b8.roiPct, null);
});

test("buildBucketStats: ROI is derived from stake when present", () => {
  const trades = [
    trade(lagosHour(8, 15, 10), "win", 500, "real", 1000),
    trade(lagosHour(8, 15, 20), "loss", -300, "real", 1000),
    trade(lagosHour(8, 15, 30), "breakeven", 0, "real", 0),
  ];
  const b8 = buildBucketStats(trades, "hour", "Africa/Lagos", TEST_CFG)[8];
  assert.equal(b8.totalStakeCents, 2000);
  assert.equal(b8.roiPct, 10); // 200/2000 = 10%
});

test("buildBucketStats: weekday dimension buckets by configured weekday", () => {
  const trades = [
    trade("2024-01-15T12:00:00Z", "win", 100), // Monday in Lagos
    trade("2024-01-15T13:00:00Z", "win", 100), // Monday
    trade("2024-01-15T14:00:00Z", "loss", -100), // Monday
    trade("2024-01-16T12:00:00Z", "win", 100), // Tuesday
  ];
  const weekly = buildBucketStats(trades, "weekday", "Africa/Lagos", TEST_CFG);
  assert.equal(weekly.length, 7);
  assert.equal(weekly[0].label, "Mon");
  assert.equal(weekly[0].n, 3);
  assert.equal(weekly[0].eligible, true);
  assert.equal(weekly[1].n, 1);
  assert.equal(weekly[1].eligible, false);
});

test("summarizeTrades: win rate, expectancy, total, small-sample flag", () => {
  const trades = [
    trade("2024-01-15T12:00:00Z", "win", 300),
    trade("2024-01-15T13:00:00Z", "loss", -100),
    trade("2024-01-15T14:00:00Z", "breakeven", 0),
  ];
  const s = summarizeTrades(trades, TEST_CFG);
  assert.equal(s.n, 3);
  assert.equal(s.wins, 1);
  assert.ok(Math.abs(s.winRate - 1 / 3) < 1e-9);
  assert.equal(s.totalPnlCents, 200);
  assert.equal(s.expectancyCents, Math.round(200 / 3));
  assert.equal(s.smallSample, true);
});

test("summarizeTrades: empty list is handled honestly", () => {
  const s = summarizeTrades([], TEST_CFG);
  assert.equal(s.n, 0);
  assert.equal(s.winRate, null);
  assert.equal(s.ciLower, null);
  assert.equal(s.expectancyCents, null);
  assert.equal(s.smallSample, false);
  assert.equal(s.roiPct, null);
});

/* ============================================================
 * Best-window selection (with small-N test config to exercise
 * ranking; the DEFAULT config is separately tested below)
 * ============================================================ */

test("pickBestWindow: minimum-N filter (4 winning trades is not enough)", () => {
  const trades = [
    // hour 8: 4 trades, all wins — highest raw win rate, but N < 5
    trade(lagosHour(8, 15, 10), "win", 100),
    trade(lagosHour(8, 15, 20), "win", 100),
    trade(lagosHour(8, 15, 30), "win", 100),
    trade(lagosHour(8, 15, 40), "win", 100),
    // hour 9: 5 trades, 3 wins (60%)
    ...["10", "20", "30", "40", "50"].map((m) =>
      trade(lagosHour(9, 15, m), ["win", "win", "win", "loss", "loss"][["10", "20", "30", "40", "50"].indexOf(m)], 10)
    ),
    // hour 10: 10 trades, 3 wins (30%)
    ...Array.from({ length: 10 }, (_, i) =>
      trade(lagosHour(10, 15, (i % 12) * 5), i < 3 ? "win" : "loss", 10)
    ),
  ];
  const summary = summarizeTrades(trades, TEST_CFG);
  const hourly = buildBucketStats(trades, "hour", "Africa/Lagos", TEST_CFG);
  const best = pickBestWindow(hourly, summary, TEST_CFG);

  assert.equal(best.found, true);
  assert.equal(best.window.key, 9); // hour 9, NOT the 100% hour 8
  assert.equal(best.window.n, 5);
  assert.equal(best.window.wins, 3);
});

test("pickBestWindow: required margin over baseline (boundary is not enough)", () => {
  const trades = [
    // hour 9: 5 trades, 3 wins = 60%
    ...["10", "20", "30", "40", "50"].map((m) =>
      trade(lagosHour(9, 15, m), ["win", "win", "win", "loss", "loss"][["10", "20", "30", "40", "50"].indexOf(m)], 10)
    ),
    // hour 10: 15 trades, 8 wins = 53.3%
    ...Array.from({ length: 15 }, (_, i) =>
      trade(lagosHour(10, 15, (i % 12) * 5), i < 8 ? "win" : "loss", 10)
    ),
  ];
  const summary = summarizeTrades(trades, TEST_CFG);
  const hourly = buildBucketStats(trades, "hour", "Africa/Lagos", TEST_CFG);
  const best = pickBestWindow(hourly, summary, TEST_CFG);

  // baseline = 11/20 = 55%. 60% is not > 55% + 5% = 60% (strict).
  assert.equal(best.found, false);
  assert.ok(Math.abs(best.baselineWinRate - 0.55) < 1e-9);
  assert.equal(best.marginPct, 5);
});

test("pickBestWindow: margin exceeded -> selected", () => {
  const trades = [
    // hour 9: 5 trades, 4 wins = 80%
    ...["10", "20", "30", "40", "50"].map((m) =>
      trade(lagosHour(9, 15, m), ["win", "win", "win", "win", "loss"][["10", "20", "30", "40", "50"].indexOf(m)], 10)
    ),
    // hour 10: 15 trades, 8 wins = 53.3%
    ...Array.from({ length: 15 }, (_, i) =>
      trade(lagosHour(10, 15, (i % 12) * 5), i < 8 ? "win" : "loss", 10)
    ),
  ];
  const summary = summarizeTrades(trades, TEST_CFG);
  const hourly = buildBucketStats(trades, "hour", "Africa/Lagos", TEST_CFG);
  const best = pickBestWindow(hourly, summary, TEST_CFG);
  assert.equal(best.found, true); // 80% > 55% + 5%
  assert.equal(best.window.key, 9);
  assert.equal(best.window.n, 5);
  assert.equal(best.window.smallSample, true);
});

test("pickBestWindow: ranked by Wilson lower bound, NOT raw win rate", () => {
  const trades = [
    // hour 8: 5 trades, 4 wins = 80% (raw winner, but wide CI)
    ...["10", "20", "30", "40", "50"].map((m) =>
      trade(lagosHour(8, 15, m), ["win", "win", "win", "win", "loss"][["10", "20", "30", "40", "50"].indexOf(m)], 10)
    ),
    // hour 9: 20 trades, 14 wins = 70% (higher Wilson lower bound)
    ...Array.from({ length: 20 }, (_, i) =>
      trade(lagosHour(9, 15, (i % 12) * 5), i < 14 ? "win" : "loss", 10)
    ),
    // hour 10: 10 trades, 2 wins = 20% (lowers the baseline)
    ...Array.from({ length: 10 }, (_, i) =>
      trade(lagosHour(10, 15, (i % 12) * 5), i < 2 ? "win" : "loss", 10)
    ),
  ];
  const summary = summarizeTrades(trades, TEST_CFG);
  const hourly = buildBucketStats(trades, "hour", "Africa/Lagos", TEST_CFG);
  const best = pickBestWindow(hourly, summary, TEST_CFG);

  // Baseline = 20/35 = 57.1%; both hours qualify.
  // Hour 8: raw 80%, Wilson LB ~0.376. Hour 9: raw 70%, Wilson LB ~0.481.
  // The honest choice is hour 9.
  assert.equal(best.found, true);
  assert.equal(best.window.key, 9);
  assert.equal(best.window.n, 20);
  assert.ok(best.window.winRate < hourly[8].winRate, "raw win rate is NOT the ranking key");
});

test("pickBestWindow: empty data -> no window, honestly", () => {
  const summary = summarizeTrades([], TEST_CFG);
  const hourly = buildBucketStats([], "hour", "Africa/Lagos", TEST_CFG);
  const best = pickBestWindow(hourly, summary, TEST_CFG);
  assert.equal(best.found, false);
});

/* ============================================================
 * DEFAULT config: the strict multiple-comparisons guard
 * ============================================================ */

test("DEFAULT config requires at least BEST_MIN_N (30) trades", () => {
  // 29 trades in hour 8, all qualified otherwise-eligible, plus fillers.
  const trades = Array.from({ length: 29 }, (_, i) =>
    trade(lagosHour(8, 15, (i % 12) * 5), "win", 10)
  );
  const summary = summarizeTrades(trades); // default cfg
  const hourly = buildBucketStats(trades, "hour"); // default cfg
  const best = pickBestWindow(hourly, summary); // default cfg
  assert.equal(hourly[8].n, 29);
  assert.equal(best.found, false, "29 trades cannot clear a 30-trade bar");
});

test("DEFAULT config: 30+ trades with raw margin but CI lower bound below baseline does NOT qualify", () => {
  // 31 trades in hour 8 with 19 wins = 61.3%; baseline across all 45 = 24/45 = 53.3%.
  // Margin is met (61.3 > 58.3), but the Wilson lower bound for 19/31 (~0.437) is
  // below the baseline, so the multiple-comparisons guard rejects it.
  const hour8 = Array.from({ length: 31 }, (_, i) =>
    trade(lagosHour(8, 15, (i % 12) * 5), i < 19 ? "win" : "loss", 10)
  );
  const fillers = Array.from({ length: 14 }, (_, i) =>
    trade(lagosHour(14, 15, (i % 12) * 5), i < 5 ? "win" : "loss", 10)
  );
  const trades = [...hour8, ...fillers];
  const summary = summarizeTrades(trades);
  const hourly = buildBucketStats(trades, "hour");
  const best = pickBestWindow(hourly, summary);

  assert.equal(hourly[8].n, 31);
  assert.ok(hourly[8].winRate > summary.winRate + CONFIG.ANALYTICS.BEST_MARGIN);
  assert.ok(hourly[8].ciLower <= summary.winRate);
  assert.equal(best.found, false, "confidence lower bound must ALSO clear the baseline");
});

test("DEFAULT config: big sample, margin AND CI lower bound clear baseline -> qualifies", () => {
  // Hour 8: 35 trades, 28 wins (80%). Fillers: 25 trades, 10 wins (40%).
  // Baseline = 38/60 = 63.3%. Margin: 80% > 68.3%. CI lower bound 28/35 ~ 0.6015... wait,
  // compute precisely via wilsonInterval; it must clear 63.3% (it does for 28/35).
  const hour8 = Array.from({ length: 35 }, (_, i) =>
    trade(lagosHour(8, 15, (i % 12) * 5), i < 28 ? "win" : "loss", 10)
  );
  const fillers = Array.from({ length: 25 }, (_, i) =>
    trade(lagosHour(14, 15, (i % 12) * 5), i < 10 ? "win" : "loss", 10)
  );
  const trades = [...hour8, ...fillers];
  const summary = summarizeTrades(trades);
  const hourly = buildBucketStats(trades, "hour");
  const best = pickBestWindow(hourly, summary);

  const b8 = hourly[8];
  assert.equal(b8.n, 35);
  assert.equal(b8.wins, 28);
  const ci = wilsonInterval(28, 35);
  assert.ok(b8.winRate > summary.winRate + CONFIG.ANALYTICS.BEST_MARGIN);
  assert.ok(b8.ciLower > summary.winRate, "CI lower bound clears baseline");
  assert.ok(Math.abs(b8.ciLower - ci.lower) < 1e-12);
  assert.equal(best.found, true);
  assert.equal(best.window.key, 8);
  assert.equal(best.window.n, 35);
  assert.equal(best.window.smallSample, false);
});

/* ============================================================
 * Real/demo separation + demo best-window
 * ============================================================ */

test("computeAnalytics: real and demo are computed completely separately", () => {
  const real = [
    trade(lagosHour(8, 15, 10), "win", 100),
    trade(lagosHour(8, 15, 20), "win", 100),
    trade(lagosHour(8, 15, 30), "loss", -50),
    trade(lagosHour(9, 15, 10), "win", 40),
    trade(lagosHour(9, 15, 20), "loss", -30),
  ];
  const demo = [
    trade(lagosHour(12, 15, 10), "win", 999, "demo"),
    trade(lagosHour(12, 15, 20), "win", 999, "demo"),
    trade(lagosHour(12, 15, 30), "win", 999, "demo"),
  ];

  const realOnly = computeAnalytics(real);
  const mixed = computeAnalytics([...real, ...demo]);

  // The real block must be IDENTICAL whether or not demo trades exist.
  assert.deepEqual(mixed.real, realOnly.real);
  assert.equal(mixed.real.summary.n, 5);
  assert.equal(mixed.demo.summary.n, 3);
});

test("computeAnalytics: best-window is available for demo trades too", () => {
  const demo = [
    // hour 12: 5 trades, 4 wins (80%)
    ...["10", "20", "30", "40", "50"].map((m) =>
      trade(lagosHour(12, 15, m), ["win", "win", "win", "win", "loss"][["10", "20", "30", "40", "50"].indexOf(m)], 10, "demo")
    ),
    // hour 13: 10 trades, 3 wins (30%)
    ...Array.from({ length: 10 }, (_, i) =>
      trade(lagosHour(13, 15, (i % 12) * 5), i < 3 ? "win" : "loss", 10, "demo")
    ),
  ];
  const a = computeAnalytics(demo);
  assert.equal(a.real.summary.n, 0);
  assert.equal(a.demo.summary.n, 15);
  assert.equal(a.demo.bestHour.found, false, "demo has only 15 trades; default bar is 30");
  assert.equal(a.real.bestHour.found, false); // no real trades -> no real window
});

test("computeAnalytics: no mode can beat a perfect baseline (honest null)", () => {
  // If every trade wins, baseline = 100%; nothing can exceed it by the margin.
  const real = Array.from({ length: 10 }, (_, i) =>
    trade(lagosHour(8, 15, (i % 12) * 5), "win", 100)
  );
  const a = computeAnalytics(real);
  assert.equal(a.real.summary.winRate, 1);
  assert.equal(a.real.bestHour.found, false);
});

/**
 * Trade Timing Journal - Analytics engine (Session 3)
 *
 * Pure functions, no external statistics libraries.
 * Everything is computed from real trades stored in SQLite.
 *
 * Core rules (statistical honesty):
 *  - Real and demo trades are NEVER blended. Every computation happens
 *    per mode, with its own baseline and its own best-window callout.
 *  - Buckets with fewer than MIN_N trades show "Not enough data yet".
 *  - Win rates are always shown with Wilson 95% confidence intervals.
 *  - The best window is chosen by the LOWER BOUND of the Wilson interval,
 *    never by raw win rate.
 *  - Money math happens in integer cents; rounding happens only at display.
 */
"use strict";

const CONFIG = require("./config");

const WEEKDAY_ORDER = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const WEEKDAY_INDEX = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
const HOUR_COUNT = 24;

/* ============================================================
 * Timezone-aware bucketing (pure function)
 * UTC timestamp + configured fixed timezone -> { hour, weekday, weekdayIndex }
 * ============================================================ */

function isValidTimezone(timezone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch (err) {
    return false;
  }
}

function bucketTimestamp(utcIso, timezone = CONFIG.TIMEZONE) {
  const date = new Date(utcIso);
  if (isNaN(date.getTime())) {
    throw new Error("Invalid timestamp: " + utcIso);
  }
  if (!isValidTimezone(timezone)) {
    throw new Error("Invalid timezone: " + timezone);
  }

  // hourCycle "h23" is important: it guarantees midnight is "00" (not "24").
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const get = (type) => parts.find((p) => p.type === type)?.value;
  const hour = Number(get("hour"));
  const weekday = get("weekday");

  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !(weekday in WEEKDAY_INDEX)) {
    throw new Error("Could not bucket timestamp " + utcIso + " in timezone " + timezone);
  }

  return { hour, weekday, weekdayIndex: WEEKDAY_INDEX[weekday] };
}

/* ============================================================
 * Wilson score interval (95%), implemented directly.
 * For k wins out of n trades:
 *   center = (p̂ + z²/2n) / (1 + z²/n)
 *   half   = z·sqrt(p̂(1−p̂)/n + z²/4n²) / (1 + z²/n)
 * where p̂ = k/n and z = 1.96 for 95% confidence.
 * ============================================================ */

function wilsonInterval(wins, n, z = CONFIG.ANALYTICS.WILSON_Z) {
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error("n must be a positive integer");
  }
  if (!Number.isInteger(wins) || wins < 0 || wins > n) {
    throw new Error("wins must be an integer between 0 and n");
  }
  const p = wins / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    lower: Math.max(0, center - half),
    upper: Math.min(1, center + half),
    center,
  };
}

/* ============================================================
 * Bucket statistics (hourly or weekday) for one mode's trades
 * ============================================================ */

function hourLabel(hour) {
  return String(hour).padStart(2, "0") + ":00";
}

function buildBucketStats(trades, dimension, timezone = CONFIG.TIMEZONE) {
  const size = dimension === "hour" ? HOUR_COUNT : WEEKDAY_ORDER.length;
  const buckets = Array.from({ length: size }, (_, i) => ({
    key: i,
    label: dimension === "hour" ? hourLabel(i) : WEEKDAY_ORDER[i],
    n: 0,
    wins: 0,
    pnlCentsTotal: 0,
  }));

  for (const trade of trades) {
    const b = bucketTimestamp(trade.timestamp_utc, timezone);
    const bucket = buckets[dimension === "hour" ? b.hour : b.weekdayIndex];
    bucket.n += 1;
    if (trade.outcome === "win") bucket.wins += 1;
    bucket.pnlCentsTotal += trade.pnl_cents;
  }

  return buckets.map((bucket) => {
    const eligible = bucket.n >= CONFIG.ANALYTICS.MIN_N;
    const ci = eligible ? wilsonInterval(bucket.wins, bucket.n) : null;
    return {
      key: bucket.key,
      label: bucket.label,
      n: bucket.n,
      wins: bucket.wins,
      winRate: eligible ? bucket.wins / bucket.n : null,
      expectancyCents: eligible ? Math.round(bucket.pnlCentsTotal / bucket.n) : null,
      ciLower: ci ? ci.lower : null,
      ciUpper: ci ? ci.upper : null,
      eligible,
    };
  });
}

/* ============================================================
 * Overall summary for one mode
 * ============================================================ */

function summarizeTrades(trades) {
  const n = trades.length;
  const wins = trades.filter((t) => t.outcome === "win").length;
  const totalPnlCents = trades.reduce((acc, t) => acc + t.pnl_cents, 0);
  const ci = n > 0 ? wilsonInterval(wins, n) : null;
  return {
    n,
    wins,
    winRate: n > 0 ? wins / n : null,
    ciLower: ci ? ci.lower : null,
    ciUpper: ci ? ci.upper : null,
    totalPnlCents,
    expectancyCents: n > 0 ? Math.round(totalPnlCents / n) : null,
    smallSample: n > 0 && n < CONFIG.ANALYTICS.BEST_SMALL_SAMPLE_N,
  };
}

/* ============================================================
 * Best-window selection
 *
 * A bucket qualifies only if:
 *   1. It has at least BEST_MIN_N trades (default 5).
 *   2. Its win rate EXCEEDS the mode's overall baseline by BEST_MARGIN
 *      (default 5 percentage points) — strict >, not >=.
 *   3. Among qualifying buckets, the winner is the one with the highest
 *      Wilson LOWER bound (tie-break: more trades, then higher win rate).
 *      Raw win rate alone is never used to pick the winner.
 * ============================================================ */

function pickBestWindow(buckets, summary) {
  const cfg = CONFIG.ANALYTICS;
  const baseline = summary.winRate === null ? 0 : summary.winRate;

  const candidates = buckets.filter(
    (b) => b.eligible && b.n >= cfg.BEST_MIN_N && b.winRate > baseline + cfg.BEST_MARGIN
  );

  candidates.sort(
    (a, b) =>
      b.ciLower - a.ciLower || // 1st: Wilson lower bound (trust, not raw rate)
      b.n - a.n ||             // 2nd: more data
      b.winRate - a.winRate    // 3rd: higher win rate
  );

  if (candidates.length === 0) {
    return {
      found: false,
      baselineWinRate: baseline,
      marginPct: cfg.BEST_MARGIN * 100,
    };
  }

  const w = candidates[0];
  return {
    found: true,
    window: {
      key: w.key,
      label: w.label,
      n: w.n,
      wins: w.wins,
      winRate: w.winRate,
      ciLower: w.ciLower,
      ciUpper: w.ciUpper,
      expectancyCents: w.expectancyCents,
      baselineWinRate: baseline,
      marginPct: cfg.BEST_MARGIN * 100,
      smallSample: w.n < cfg.BEST_SMALL_SAMPLE_N,
    },
  };
}

/* ============================================================
 * Full analytics for all trades, real and demo kept separate.
 * ============================================================ */

function computeAnalytics(trades, timezone = CONFIG.TIMEZONE) {
  const analyzeMode = (modeTrades) => {
    const summary = summarizeTrades(modeTrades);
    const hourly = buildBucketStats(modeTrades, "hour", timezone);
    const weekday = buildBucketStats(modeTrades, "weekday", timezone);
    return {
      summary,
      hourly,
      weekday,
      bestHour: pickBestWindow(hourly, summary),
      bestWeekday: pickBestWindow(weekday, summary),
    };
  };

  return {
    real: analyzeMode(trades.filter((t) => t.mode === "real")),
    demo: analyzeMode(trades.filter((t) => t.mode === "demo")),
  };
}

module.exports = {
  WEEKDAY_ORDER,
  isValidTimezone,
  bucketTimestamp,
  wilsonInterval,
  buildBucketStats,
  summarizeTrades,
  pickBestWindow,
  computeAnalytics,
};

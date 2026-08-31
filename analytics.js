/**
 * Trade Timing Journal - Analytics engine
 *
 * Pure functions, no external statistics libraries.
 * Everything is computed from real trades stored in SQLite.
 *
 * Core rules (statistical honesty):
 *  - Real and demo trades are NEVER blended. Every computation happens
 *    per mode, with its own baseline and its own "strongest observed
 *    window" callout.
 *  - Buckets with fewer than MIN_N trades show "Not enough data yet".
 *  - Win rates are always shown with Wilson 95% confidence intervals.
 *  - Win rate = wins / ALL trades of that mode (breakevens count in the
 *    denominator).
 *  - The "strongest observed window" requires a LOT of evidence, because
 *    the dashboard tests ~31 buckets at once (24 hours + 7 weekdays) and
 *    some of them will look good by chance alone (multiple comparisons):
 *      a) at least BEST_MIN_N trades in the bucket (default 30),
 *      b) win rate more than BEST_MARGIN above that mode's baseline,
 *      c) the Wilson 95% LOWER bound clears the baseline too,
 *    and the winner is ranked by the Wilson lower bound, never raw win rate.
 *  - Money math happens in integer cents; rounding happens only at display.
 *  - ROI = total P&L / total stake (when stake data exists); comparing ROI
 *    instead of raw P&L removes position-sizing history from the comparison.
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

function buildBucketStats(trades, dimension, timezone = CONFIG.TIMEZONE, cfg = CONFIG.ANALYTICS) {
  const size = dimension === "hour" ? HOUR_COUNT : WEEKDAY_ORDER.length;
  const buckets = Array.from({ length: size }, (_, i) => ({
    key: i,
    label: dimension === "hour" ? hourLabel(i) : WEEKDAY_ORDER[i],
    n: 0,
    wins: 0,
    pnlCentsTotal: 0,
    stakeCentsTotal: 0,
  }));

  for (const trade of trades) {
    const b = bucketTimestamp(trade.timestamp_utc, timezone);
    const bucket = buckets[dimension === "hour" ? b.hour : b.weekdayIndex];
    bucket.n += 1;
    if (trade.outcome === "win") bucket.wins += 1;
    bucket.pnlCentsTotal += trade.pnl_cents;
    if (trade.stake_cents) bucket.stakeCentsTotal += trade.stake_cents;
  }

  return buckets.map((bucket) => {
    const eligible = bucket.n >= cfg.MIN_N;
    const ci = eligible ? wilsonInterval(bucket.wins, bucket.n, cfg.WILSON_Z) : null;
    const roiPct =
      eligible && bucket.stakeCentsTotal > 0
        ? Math.round((10000 * bucket.pnlCentsTotal) / bucket.stakeCentsTotal) / 100
        : null;
    return {
      key: bucket.key,
      label: bucket.label,
      n: bucket.n,
      wins: bucket.wins,
      winRate: eligible ? bucket.wins / bucket.n : null,
      expectancyCents: eligible ? Math.round(bucket.pnlCentsTotal / bucket.n) : null,
      totalStakeCents: bucket.stakeCentsTotal,
      roiPct,
      ciLower: ci ? ci.lower : null,
      ciUpper: ci ? ci.upper : null,
      eligible,
    };
  });
}

/* ============================================================
 * Overall summary for one mode
 * ============================================================ */

function summarizeTrades(trades, cfg = CONFIG.ANALYTICS) {
  const n = trades.length;
  const wins = trades.filter((t) => t.outcome === "win").length;
  const totalPnlCents = trades.reduce((acc, t) => acc + t.pnl_cents, 0);
  const totalStakeCents = trades.reduce((acc, t) => acc + (t.stake_cents || 0), 0);
  const ci = n > 0 ? wilsonInterval(wins, n, cfg.WILSON_Z) : null;
  const roiPct =
    n > 0 && totalStakeCents > 0
      ? Math.round((10000 * totalPnlCents) / totalStakeCents) / 100
      : null;
  return {
    n,
    wins,
    winRate: n > 0 ? wins / n : null,
    ciLower: ci ? ci.lower : null,
    ciUpper: ci ? ci.upper : null,
    totalPnlCents,
    expectancyCents: n > 0 ? Math.round(totalPnlCents / n) : null,
    totalStakeCents,
    roiPct,
    smallSample: n > 0 && n < cfg.BEST_SMALL_SAMPLE_N,
  };
}

/* ============================================================
 * "Strongest observed window" selection
 *
 * A bucket qualifies ONLY if ALL of these hold:
 *   1. It has at least BEST_MIN_N trades (default 30). This guards against
 *      the multiple-comparisons problem: with 24 hours + 7 weekdays tested,
 *      a small bucket can look great by chance alone.
 *   2. Its win rate EXCEEDS the mode's overall baseline by BEST_MARGIN
 *      (default 5 percentage points) — strict >, not >=.
 *   3. Its Wilson 95% LOWER bound also clears the baseline (configurable
 *      with BEST_REQUIRE_CI_OVER_BASELINE), so the pattern is unlikely to be
 *      noise even though the raw rate looks good.
 * Among qualifying buckets, the winner has the highest Wilson LOWER bound
 * (tie-break: more trades, then higher win rate).
 * ============================================================ */

function pickBestWindow(buckets, summary, cfg = CONFIG.ANALYTICS) {
  const baseline = summary.winRate === null ? 0 : summary.winRate;

  const candidates = buckets.filter((b) => {
    if (!b.eligible || b.n < cfg.BEST_MIN_N) return false;
    if (!(b.winRate > baseline + cfg.BEST_MARGIN)) return false;
    if (cfg.BEST_REQUIRE_CI_OVER_BASELINE && !(b.ciLower > baseline)) return false;
    return true;
  });

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
      roiPct: w.roiPct,
      baselineWinRate: baseline,
      marginPct: cfg.BEST_MARGIN * 100,
      smallSample: w.n < cfg.BEST_SMALL_SAMPLE_N,
    },
  };
}

/* ============================================================
 * Full analytics for all trades, real and demo kept separate.
 * ============================================================ */

function computeAnalytics(trades, timezone = CONFIG.TIMEZONE, cfg = CONFIG.ANALYTICS) {
  const analyzeMode = (modeTrades) => {
    const summary = summarizeTrades(modeTrades, cfg);
    const hourly = buildBucketStats(modeTrades, "hour", timezone, cfg);
    const weekday = buildBucketStats(modeTrades, "weekday", timezone, cfg);
    return {
      summary,
      hourly,
      weekday,
      bestHour: pickBestWindow(hourly, summary, cfg),
      bestWeekday: pickBestWindow(weekday, summary, cfg),
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

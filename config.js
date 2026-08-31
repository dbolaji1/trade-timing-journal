/**
 * Trade Timing Journal - Configuration
 *
 * The timezone here is EXPLICIT and FIXED.
 * It is NOT inferred from the server or browser.
 * All analytics bucket timestamps using this timezone.
 * Timestamps are stored in UTC, but displayed/bucketed in this timezone.
 *
 * Change this to your primary trading timezone if needed.
 * Use an IANA timezone name: https://en.wikipedia.org/wiki/List_of_tz_database_time_zones
 */
const CONFIG = {
  // User is in Lagos, Nigeria - Africa/Lagos (WAT, UTC+1, no DST)
  TIMEZONE: "Africa/Lagos",

  // Display currency. Money is always stored as integer cents; this only
  // controls the currency label/symbol shown in the UI. If you change it,
  // keep all existing trades in that currency too (the app does not convert).
  CURRENCY: "USD",
  CURRENCY_SYMBOL: "$",

  // Database file lives inside the project so data survives restarts
  // unless you explicitly delete it.
  // TT_DB_PATH is only for automated tests (points at a temp file);
  // in normal use leave it unset so the real data/trades.db is used.
  DB_PATH: process.env.TT_DB_PATH || "./data/trades.db",

  // Server port and bind address.
  // Default binds to 127.0.0.1 (this machine only) so nobody else on your
  // network can read or change your journal. If you deliberately want LAN
  // access, set TT_HOST=0.0.0.0 (and then add access control yourself).
  PORT: process.env.PORT || 3000,
  HOST: process.env.TT_HOST || "127.0.0.1",

  // Validation: plausible timestamp range
  MIN_TIMESTAMP: new Date("2000-01-01T00:00:00.000Z"),
  // Allow up to 1 day in the future to account for clock skew, but not years ahead
  MAX_FUTURE_MS: 24 * 60 * 60 * 1000,

  // Analytics thresholds
  ANALYTICS: {
    // A bucket must have at least this many trades before we show statistics.
    MIN_N: 3,
    // Best-window eligibility: minimum trades in the bucket. This is the
    // "multiple comparisons" guard: the dashboard scans 24 hours + 7 weekdays,
    // so a small number of trades is not evidence of a real edge.
    BEST_MIN_N: 30,
    // Best-window eligibility: bucket win rate must EXCEED the mode's overall
    // baseline win rate by this margin (5 percentage points).
    BEST_MARGIN: 0.05,
    // Best-window eligibility: the bucket's Wilson 95% lower bound must also
    // clear the baseline, otherwise the pattern could be noise even when the
    // raw win rate looks good.
    BEST_REQUIRE_CI_OVER_BASELINE: true,
    // Below this many trades, the best-window callout shows a small-sample caveat.
    BEST_SMALL_SAMPLE_N: 30,
    // z-score for 95% Wilson confidence intervals.
    WILSON_Z: 1.96,
  },

  // "Today" focus (the dashboard's headline): stats for the current day and the
  // strongest time of day ON THIS WEEKDAY (e.g. Mondays), so the answer always
  // revolves around today instead of listing a different best day every week.
  // The bar is deliberately lower than BEST_MIN_N (the app has much less data
  // per weekday than overall), but the same honesty rules still apply: margin
  // over the weekday baseline AND confidence lower bound above baseline. The
  // UI always states how many trades the hint is based on.
  TODAY: {
    BEST_MIN_N: 5,
    BEST_MARGIN: 0.05,
    BEST_REQUIRE_CI_OVER_BASELINE: true,
    BEST_SMALL_SAMPLE_N: 30,
    WILSON_Z: 1.96,
  },
};

module.exports = CONFIG;

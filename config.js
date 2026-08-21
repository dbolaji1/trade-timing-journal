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

  // Database file lives inside the project so data survives restarts
  // unless you explicitly delete it.
  // TT_DB_PATH is only for automated tests (points at a temp file);
  // in normal use leave it unset so the real data/trades.db is used.
  DB_PATH: process.env.TT_DB_PATH || "./data/trades.db",

  // Server port
  PORT: process.env.PORT || 3000,

  // Validation: plausible timestamp range
  MIN_TIMESTAMP: new Date("2000-01-01T00:00:00.000Z"),
  // Allow up to 1 day in the future to account for clock skew, but not years ahead
  MAX_FUTURE_MS: 24 * 60 * 60 * 1000,

  // Analytics thresholds (Session 3)
  ANALYTICS: {
    // A bucket must have at least this many trades before we show statistics.
    MIN_N: 3,
    // Best-window eligibility: minimum trades in the bucket.
    BEST_MIN_N: 5,
    // Best-window eligibility: bucket win rate must EXCEED the mode's overall
    // baseline win rate by this margin (5 percentage points).
    BEST_MARGIN: 0.05,
    // Below this many trades, the best-window callout shows a small-sample caveat.
    BEST_SMALL_SAMPLE_N: 30,
    // z-score for 95% Wilson confidence intervals.
    WILSON_Z: 1.96,
  },
};

module.exports = CONFIG;

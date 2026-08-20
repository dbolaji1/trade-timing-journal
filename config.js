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
  DB_PATH: "./data/trades.db",

  // Server port
  PORT: process.env.PORT || 3000,

  // Validation: plausible timestamp range
  MIN_TIMESTAMP: new Date("2000-01-01T00:00:00.000Z"),
  // Allow up to 1 day in the future to account for clock skew, but not years ahead
  MAX_FUTURE_MS: 24 * 60 * 60 * 1000,
};

module.exports = CONFIG;

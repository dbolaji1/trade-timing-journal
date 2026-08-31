/**
 * Shared timezone-aware time helpers.
 *
 * The app stores everything in UTC but interprets user input as wall-clock
 * time in the CONFIGURED trading timezone (config.js TIMEZONE) — never in
 * the browser's or server's local timezone. These helpers make that
 * conversion deterministic on every machine.
 */
"use strict";

const CONFIG = require("./config");

function isValidTimezone(timezone) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Interpret naive wall-clock components (year, month, day, hour, ...) as
 * time in `tz` and return the matching UTC ISO string.
 * Handles DST correctly via Intl round-tripping.
 */
function wallClockToUtcIso(year, month, day, hour, minute, second, tz = CONFIG.TIMEZONE) {
  const zone = tz || CONFIG.TIMEZONE;
  const utcGuess = Date.UTC(year, month - 1, day, hour, minute, second);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(utcGuess));
  const get = (type) => Number(parts.find((p) => p.type === type).value);
  const asWall = Date.UTC(get("year"), get("month") - 1, get("day"), get("hour"), get("minute"), get("second"));
  return new Date(utcGuess - (asWall - utcGuess)).toISOString();
}

/**
 * Parse a user-supplied timestamp into a UTC ISO string.
 *
 * Rules:
 *  - A value with an explicit timezone (Z or ±hh:mm) is an absolute instant.
 *  - A naive value (no timezone) is interpreted as wall-clock time in
 *    `tz` (the configured trading timezone), NOT the server/browser locale.
 *  - Date objects (from spreadsheet parsers) are treated as wall-clock
 *    values whose components come from their UTC getters (Excel serial
 *    dates are absolute-UTC-based in ExcelJS).
 *  - Returns null when the value cannot be parsed.
 */
function parseTimestampToUtc(raw, tz = CONFIG.TIMEZONE) {
  if (raw === null || raw === undefined) return null;
  if (raw instanceof Date) {
    if (isNaN(raw.getTime())) return null;
    return wallClockToUtcIso(
      raw.getUTCFullYear(), raw.getUTCMonth() + 1, raw.getUTCDate(),
      raw.getUTCHours(), raw.getUTCMinutes(), raw.getUTCSeconds(), tz
    );
  }
  const s = String(raw).trim();
  if (!s) return null;
  // Explicit timezone -> absolute instant.
  if (/[zZ]$/.test(s) || /[+-]\d{2}:?\d{2}$/.test(s)) {
    const d = new Date(s);
    return isNaN(d.getTime()) ? null : d.toISOString();
  }
  // Naive "YYYY-MM-DD" or "YYYY-MM-DD HH:mm[:ss]" -> wall clock in tz.
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/);
  if (m) {
    return wallClockToUtcIso(+m[1], +m[2], +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0), tz);
  }
  // Last resort: let the JS parser try (other ISO-ish formats).
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * Start (or end) of a calendar day "YYYY-MM-DD" in `tz`, as a UTC ISO string.
 * offsetDays of 1 gives the exclusive end (start of the next day), which is
 * the safe upper bound for "on this day" filters.
 * Returns null for an unparseable date string.
 */
function startOfDayUtc(dateStr, tz = CONFIG.TIMEZONE, offsetDays = 0) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || "").trim());
  if (!m) return null;
  const base = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3] + offsetDays));
  return wallClockToUtcIso(
    base.getUTCFullYear(), base.getUTCMonth() + 1, base.getUTCDate(),
    0, 0, 0, tz
  );
}

module.exports = { isValidTimezone, wallClockToUtcIso, parseTimestampToUtc, startOfDayUtc };

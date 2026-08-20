/**
 * Server-side validation - pure functions
 * All trade data is validated here before touching the database.
 */
const CONFIG = require("./config");

const ALLOWED_DIRECTIONS = ["long", "short"];
const ALLOWED_OUTCOMES = ["win", "loss", "breakeven"];
const ALLOWED_MODES = ["real", "demo"];

/**
 * Normalize asset name: uppercase, strip separators ( - / _ . space )
 * Example: "btc/usdt" -> "BTCUSDT", "eur-usd" -> "EURUSD"
 */
function normalizeAsset(asset) {
  if (typeof asset !== "string") return "";
  return asset.trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}

/**
 * Convert money to integer cents for safe storage.
 * Avoids floating-point errors.
 * "123.45" -> 12345, 0.1 -> 10
 */
function toCents(amount) {
  // amount should already be validated as finite number
  return Math.round(Number(amount) * 100);
}

/**
 * Format integer cents back to display string: 12345 -> "123.45"
 */
function formatCents(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remainder = abs % 100;
  return `${sign}${dollars}.${String(remainder).padStart(2, "0")}`;
}

/**
 * Validate and sanitize a trade payload.
 * Returns { valid: boolean, errors: string[], sanitized: object }
 * sanitized contains DB-ready values (asset normalized, pnl_cents, timestamp_utc)
 */
function validateTrade(payload, options = { partial: false }) {
  const errors = [];
  const sanitized = {};

  const isPartial = options.partial === true;

  // --- asset ---
  if (!isPartial || payload.asset !== undefined) {
    if (payload.asset === undefined || payload.asset === null || String(payload.asset).trim() === "") {
      errors.push("Asset is required.");
    } else if (typeof payload.asset !== "string") {
      errors.push("Asset must be a string.");
    } else {
      const normalized = normalizeAsset(payload.asset);
      if (normalized.length === 0) {
        errors.push("Asset must contain at least one letter or number after normalization.");
      } else if (normalized.length > 20) {
        errors.push("Asset must be 20 characters or fewer after normalization.");
      } else {
        sanitized.asset = normalized;
      }
    }
  }

  // --- direction ---
  if (!isPartial || payload.direction !== undefined) {
    if (!payload.direction) {
      errors.push("Direction is required. Allowed: long, short.");
    } else if (!ALLOWED_DIRECTIONS.includes(String(payload.direction).toLowerCase())) {
      errors.push(`Direction must be one of: ${ALLOWED_DIRECTIONS.join(", ")}.`);
    } else {
      sanitized.direction = String(payload.direction).toLowerCase();
    }
  }

  // --- outcome ---
  if (!isPartial || payload.outcome !== undefined) {
    if (!payload.outcome) {
      errors.push("Outcome is required. Allowed: win, loss, breakeven.");
    } else if (!ALLOWED_OUTCOMES.includes(String(payload.outcome).toLowerCase())) {
      errors.push(`Outcome must be one of: ${ALLOWED_OUTCOMES.join(", ")}.`);
    } else {
      sanitized.outcome = String(payload.outcome).toLowerCase();
    }
  }

  // --- mode ---
  if (!isPartial || payload.mode !== undefined) {
    if (!payload.mode) {
      errors.push("Mode is required. Allowed: real, demo.");
    } else if (!ALLOWED_MODES.includes(String(payload.mode).toLowerCase())) {
      errors.push(`Mode must be one of: ${ALLOWED_MODES.join(", ")}.`);
    } else {
      sanitized.mode = String(payload.mode).toLowerCase();
    }
  }

  // --- amount / pnl ---
  // Accept either 'amount' or 'pnl' or 'pnl_cents' from frontend
  let rawAmount = undefined;
  if (payload.amount !== undefined) rawAmount = payload.amount;
  else if (payload.pnl !== undefined) rawAmount = payload.pnl;
  else if (payload.pnl_cents !== undefined) {
    // If pnl_cents is directly provided, validate it as integer
    const cents = payload.pnl_cents;
    if (!Number.isInteger(cents)) {
      errors.push("pnl_cents must be an integer (cents).");
    } else if (!Number.isFinite(cents)) {
      errors.push("pnl_cents must be a finite number.");
    } else if (Math.abs(cents) > 100000000000) {
      // 1 billion dollars in cents ~ 100B cents, limit to 1B
      errors.push("pnl_cents is too large.");
    } else {
      sanitized.pnl_cents = cents;
    }
    rawAmount = null; // skip amount check
  }

  if (rawAmount !== undefined && rawAmount !== null) {
    // Must be present if not partial, or if partial but amount was sent
    if (!isPartial || payload.amount !== undefined || payload.pnl !== undefined) {
      if (rawAmount === "" || rawAmount === null || rawAmount === undefined) {
        errors.push("Amount (P&L) is required.");
      } else {
        const num = Number(rawAmount);
        if (!Number.isFinite(num)) {
          errors.push("Amount must be a finite number (e.g., 123.45 or -50.25).");
        } else if (Math.abs(num) > 1000000000) {
          errors.push("Amount is too large (max 1,000,000,000).");
        } else {
          sanitized.pnl_cents = toCents(num);
        }
      }
    }
  } else if (!isPartial && sanitized.pnl_cents === undefined) {
    // No amount at all and not partial -> error
    if (payload.pnl_cents === undefined) {
      errors.push("Amount (P&L) is required. Send 'amount' as a number like 25.50 or -10.00.");
    }
  }

  // --- timestamp ---
  if (!isPartial || payload.timestamp !== undefined || payload.timestamp_utc !== undefined) {
    let rawTs = payload.timestamp_utc || payload.timestamp;
    if (!rawTs) {
      errors.push("Timestamp is required.");
    } else {
      const d = new Date(rawTs);
      if (isNaN(d.getTime())) {
        errors.push("Timestamp must be a valid date/time (e.g., 2024-03-15T14:30 or ISO string).");
      } else {
        // Plausible check
        if (d < CONFIG.MIN_TIMESTAMP) {
          errors.push(`Timestamp must be after ${CONFIG.MIN_TIMESTAMP.toISOString()} (year 2000).`);
        }
        const maxDate = new Date(Date.now() + CONFIG.MAX_FUTURE_MS);
        if (d > maxDate) {
          errors.push("Timestamp cannot be more than 24 hours in the future.");
        }
        // Store as UTC ISO string
        sanitized.timestamp_utc = d.toISOString();
      }
    }
  }

  // --- notes (optional) ---
  if (payload.notes !== undefined) {
    if (payload.notes === null) {
      sanitized.notes = null;
    } else if (typeof payload.notes !== "string") {
      errors.push("Notes must be a string.");
    } else if (payload.notes.length > 2000) {
      errors.push("Notes must be 2000 characters or fewer.");
    } else {
      sanitized.notes = payload.notes.trim() === "" ? null : payload.notes.trim();
    }
  } else if (!isPartial) {
    sanitized.notes = null;
  }

  return {
    valid: errors.length === 0,
    errors,
    sanitized,
  };
}

module.exports = {
  normalizeAsset,
  toCents,
  formatCents,
  validateTrade,
  ALLOWED_DIRECTIONS,
  ALLOWED_OUTCOMES,
  ALLOWED_MODES,
};

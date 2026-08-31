/* ============================================================
   Trade Timing Journal — shared money/percent formatting (client)
   Loaded before app.js and dashboard.js. One place to change how
   integer cents are displayed; the server has the matching
   formatCents() in validation.js.
   ============================================================ */
"use strict";

window.TT_FORMAT = (function () {
  // 12345 -> "123.45"; -1825 -> "-18.25"
  function formatCents(cents) {
    if (cents === null || cents === undefined) return null;
    const sign = cents < 0 ? "-" : "";
    const abs = Math.abs(cents);
    const dollars = Math.floor(abs / 100);
    const remainder = abs % 100;
    return sign + dollars + "." + String(remainder).padStart(2, "0");
  }

  // 12345 -> "$123.45"; uses the configured currency symbol.
  function usd(cents, symbol) {
    if (cents === null || cents === undefined) return "—";
    const sign = cents < 0 ? "-" : "";
    return sign + (symbol || "$") + Math.floor(Math.abs(cents) / 100).toLocaleString("en-US") +
      "." + String(Math.abs(cents) % 100).padStart(2, "0");
  }

  // 0.654 -> "65.4%" ; null -> "—". `digits` defaults to 1.
  function pct(x, digits) {
    if (x === null || x === undefined) return "—";
    return (x * 100).toFixed(digits === undefined ? 1 : digits) + "%";
  }

  // A value that is ALREADY a percentage number (e.g. 12.34 -> "12.3%").
  function pctPoints(x, digits) {
    if (x === null || x === undefined) return "—";
    return x.toFixed(digits === undefined ? 1 : digits) + "%";
  }

  return { formatCents: formatCents, usd: usd, pct: pct, pctPoints: pctPoints };
})();

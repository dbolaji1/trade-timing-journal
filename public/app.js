/* ============================================================
   Trade Timing Journal — frontend logic (Session 2)
   Plain vanilla JavaScript, no frameworks.

   How data flows:
     form ──> POST/PUT /api/trades ──> validation.js ──> SQLite
     log  <── GET /api/trades?mode=…  <── SQLite (never browser state)

   Timestamps:
     - The datetime-local input shows YOUR wall-clock time.
     - Before sending, we convert it to the exact same instant in UTC.
     - The log displays times in the fixed, configured timezone
       (from /api/health) plus the raw UTC value.
   ============================================================ */

"use strict";

/* ---------- App state (UI-only; the database is the real store) ---------- */
const state = {
  trades: [],          // rows currently shown (fetched from SQLite)
  filter: "all",       // "all" | "real" | "demo"
  editingId: null,     // trade id being edited, or null for new trade
  timezone: "Africa/Lagos", // filled from /api/health (fixed in config.js)
  pendingDeleteId: null,    // id waiting in the delete confirmation modal
};

/* ---------- Small DOM helpers ---------- */
const $ = (id) => document.getElementById(id);

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ---------- Money ---------- */
function usd(cents) {
  const sign = cents < 0 ? "-" : "";
  const abs = Math.abs(cents);
  return sign + "$" + Math.floor(abs / 100).toLocaleString("en-US") + "." + String(abs % 100).padStart(2, "0");
}

// Client-side mirror of the server's derivePnlSign: the SIGN of the P&L comes
// from the Outcome, never from the number the user typed.
function deriveCentsFromOutcome(outcome, cents) {
  if (outcome === "win") return Math.abs(cents);
  if (outcome === "loss") return -Math.abs(cents);
  if (outcome === "breakeven") return 0;
  return cents;
}

/* ---------- Time helpers ---------- */

// Format a UTC ISO string in the configured fixed timezone.
function fmtTz(utcIso) {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      timeZone: state.timezone,
      year: "numeric",
      month: "short",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).format(new Date(utcIso));
  } catch (err) {
    return utcIso;
  }
}

// Compact UTC display: "2026-08-21 11:34:00 UTC"
function fmtUtc(utcIso) {
  return String(utcIso).replace("T", " ").replace(/\.\d{3}Z$/, "") + " UTC";
}

// Date -> value for a datetime-local input (browser-local wall time).
function toLocalInputValue(date) {
  const pad = (n) => String(n).padStart(2, "0");
  return (
    date.getFullYear() + "-" + pad(date.getMonth() + 1) + "-" + pad(date.getDate()) +
    "T" + pad(date.getHours()) + ":" + pad(date.getMinutes())
  );
}

function setNow() {
  $("timestamp").value = toLocalInputValue(new Date());
  updatePreviews();
}

/* ---------- Toasts & form errors ---------- */
function toast(message, type) {
  const box = $("toasts");
  const el = document.createElement("div");
  el.className = "toast toast-" + (type || "info");
  el.textContent = message;
  box.appendChild(el);
  setTimeout(() => {
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 350);
  }, 4200);
}

function showErrors(list) {
  const box = $("formErrors");
  box.hidden = false;
  box.innerHTML = "<ul>" + list.map((m) => "<li>" + escapeHtml(m) + "</li>").join("") + "</ul>";
}

function hideErrors() {
  const box = $("formErrors");
  box.hidden = true;
  box.innerHTML = "";
}

/* ---------- Server health (online status, trade count, timezone) ---------- */
async function loadHealth() {
  try {
    const res = await fetch("/api/health");
    const data = await res.json();
    state.timezone = data.timezone || "Africa/Lagos";
    $("statusText").textContent =
      "online · " + data.trade_count + " trade" + (data.trade_count === 1 ? "" : "s") +
      " · schema v" + data.schema_version;
    $("statusDot").classList.add("online");
    $("tzBadge").textContent = "Timezone: " + state.timezone;
    $("tzTh").textContent = state.timezone;
    updatePreviews();
  } catch (err) {
    $("statusText").textContent = "offline — cannot reach the server";
    $("statusDot").classList.remove("online");
  }
}

/* ---------- Trade log ---------- */
async function loadTrades() {
  const tbody = $("tradesBody");
  tbody.innerHTML = '<tr><td colspan="10" class="empty">Loading trades from SQLite…</td></tr>';
  try {
    const res = await fetch("/api/trades?mode=" + state.filter);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      tbody.innerHTML = '<tr><td colspan="10" class="empty">' +
        "Could not load trades: " + escapeHtml(data.error || "HTTP " + res.status) + "</td></tr>";
      return;
    }
    state.trades = Array.isArray(data) ? data : [];
    renderTrades();
    renderSummary();
  } catch (err) {
    tbody.innerHTML = '<tr><td colspan="10" class="empty">' +
      "Network error — is the server running? (" + escapeHtml(err.message) + ")</td></tr>";
  }
}

function rowHtml(t) {
  const pnlClass = t.pnl_cents > 0 ? "pnl-pos" : t.pnl_cents < 0 ? "pnl-neg" : "pnl-zero";
  const pnlText = (t.pnl_cents > 0 ? "+" : "") + "$" + escapeHtml(t.pnl_formatted);
  const dirLabel = t.direction === "long" ? "▲ long" : "▼ short";
  const notesCell = t.notes
    ? escapeHtml(t.notes)
    : '<span class="faint">—</span>';
  return (
    '<tr data-id="' + t.id + '">' +
      '<td class="mono">#' + t.id + "</td>" +
      '<td class="nowrap">' + escapeHtml(fmtTz(t.timestamp_utc)) + "</td>" +
      '<td class="mono faint nowrap">' + escapeHtml(fmtUtc(t.timestamp_utc)) + "</td>" +
      "<td><strong>" + escapeHtml(t.asset) + "</strong></td>" +
      '<td><span class="dir dir-' + t.direction + '">' + dirLabel + "</span></td>" +
      '<td><span class="chip chip-' + t.outcome + '">' + escapeHtml(t.outcome) + "</span></td>" +
      '<td class="nowrap ' + pnlClass + '">' + pnlText + "</td>" +
      '<td><span class="chip chip-' + t.mode + '">' + escapeHtml(t.mode) + "</span></td>" +
      '<td class="notes" title="' + escapeHtml(t.notes || "") + '">' + notesCell + "</td>" +
      '<td class="nowrap actions">' +
        '<button class="btn ghost small" data-edit="' + t.id + '">Edit</button> ' +
        '<button class="btn danger small" data-del="' + t.id + '">Delete</button>' +
      "</td>" +
    "</tr>"
  );
}

function renderTrades() {
  const tbody = $("tradesBody");
  if (state.trades.length === 0) {
    const messages = {
      all: "No trades yet. Add your first trade with the form — it will be saved permanently to SQLite.",
      real: "No real trades here. Real and demo are always kept separate — try the Both or Demo filter.",
      demo: "No demo trades here. Real and demo are always kept separate — try the Both or Real filter.",
    };
    tbody.innerHTML = '<tr><td colspan="10" class="empty">' + messages[state.filter] + "</td></tr>";
    $("logSummary").textContent = "";
    return;
  }
  tbody.innerHTML = state.trades.map(rowHtml).join("");
}

// Summary of the currently shown trades. Real and demo P&L are NEVER mixed.
function renderSummary() {
  const real = state.trades.filter((t) => t.mode === "real");
  const demo = state.trades.filter((t) => t.mode === "demo");
  const sum = (arr) => arr.reduce((acc, t) => acc + t.pnl_cents, 0);

  let text = state.trades.length + " trade" + (state.trades.length === 1 ? "" : "s") + " shown";
  if (state.filter !== "demo") {
    text += " · " + real.length + " real (P&L " + usd(sum(real)) + ")";
  }
  if (state.filter !== "real") {
    text += " · " + demo.length + " demo (P&L " + usd(sum(demo)) + ")";
  }
  $("logSummary").textContent = text;
}

function setFilter(mode) {
  state.filter = mode;
  document.querySelectorAll("#logCard .pill").forEach((btn) => {
    const active = btn.dataset.mode === mode;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-pressed", String(active));
  });
  loadTrades();
}

/* ---------- Live previews (client-side mirrors of server rules) ---------- */
function updatePreviews() {
  // Asset: show how the server will normalize it (uppercase, separators stripped).
  const typed = $("asset").value.trim();
  const normalized = typed.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const assetPreview = $("assetPreview");
  if (normalized && normalized !== typed.toUpperCase()) {
    assetPreview.textContent = "Will be saved as: " + normalized;
  } else if (normalized) {
    assetPreview.textContent = "Ready.";
  } else {
    assetPreview.textContent = "";
  }

  // Amount: show integer-cent conversion. The sign is derived from Outcome,
  // so a win is always positive, a loss always negative, breakeven = 0.
  const rawAmount = $("amount").value;
  const outcome = $("outcome").value;
  const amountPreview = $("amountPreview");
  if (rawAmount !== "" && Number.isFinite(Number(rawAmount))) {
    const cents = Math.round(Math.abs(Number(rawAmount)) * 100); // magnitude
    const signed = deriveCentsFromOutcome(outcome, cents);
    const signLabel = signed > 0 ? "+" : signed < 0 ? "−" : "±0";
    amountPreview.textContent =
      "Outcome " + outcome + " → " + signLabel + "$" + (signed / 100).toFixed(2) +
      " (" + signed + " integer cents).";
  } else {
    amountPreview.textContent = "The sign is derived from Outcome: win = +, loss = −, breakeven = 0.";
  }

  // Timestamp: show exactly what gets stored in UTC and how it displays.
  const localValue = $("timestamp").value;
  const tsPreview = $("tsPreview");
  if (localValue) {
    const d = new Date(localValue);
    if (!isNaN(d.getTime())) {
      tsPreview.textContent =
        "Stored in UTC as: " + d.toISOString() +
        " · shown in " + state.timezone + " as: " + fmtTz(d.toISOString());
      return;
    }
  }
  tsPreview.textContent = "Pick a date and time — it is stored in UTC and displayed in " + state.timezone + ".";
}

/* ---------- Create / update ---------- */
async function submitTrade(event) {
  event.preventDefault();
  hideErrors();

  // Quick client-side checks (the server re-validates everything anyway).
  const asset = $("asset").value.trim();
  const rawAmount = $("amount").value;
  const localValue = $("timestamp").value;
  const clientErrors = [];

  if (!asset) clientErrors.push("Asset is required.");
  if (rawAmount === "") clientErrors.push("P&L amount is required.");
  else if (!Number.isFinite(Number(rawAmount))) clientErrors.push("P&L amount must be a number like 42.50 or -18.25.");
  if (!localValue) clientErrors.push("Timestamp is required.");
  else if (isNaN(new Date(localValue).getTime())) clientErrors.push("Timestamp is not a valid date/time.");

  if (clientErrors.length) {
    showErrors(clientErrors);
    return;
  }

  // datetime-local holds browser-local wall time; convert to the exact
  // instant in UTC before sending, so the server stores true UTC.
  const payload = {
    asset: asset,
    direction: $("direction").value,
    outcome: $("outcome").value,
    amount: rawAmount,
    mode: document.querySelector('input[name="mode"]:checked').value,
    notes: $("notes").value,
    timestamp: new Date(localValue).toISOString(),
  };

  const isEdit = state.editingId !== null;
  const url = isEdit ? "/api/trades/" + state.editingId : "/api/trades";

  try {
    const res = await fetch(url, {
      method: isEdit ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const details = data.details && data.details.length ? data.details : [data.error || "Server error (HTTP " + res.status + ")"];
      showErrors(details);
      toast("Could not save the trade — see the errors in the form.", "error");
      return;
    }
    toast(isEdit ? "Updated trade #" + data.id + " in SQLite" : "Saved trade #" + data.id + " to SQLite", "ok");
    resetForm();
    await refreshAll();
  } catch (err) {
    toast("Network error — is the server running? (" + err.message + ")", "error");
  }
}

/* ---------- Edit ---------- */
function startEdit(id) {
  const t = state.trades.find((x) => x.id === id);
  if (!t) return;
  state.editingId = id;
  $("asset").value = t.asset;
  $("direction").value = t.direction;
  $("outcome").value = t.outcome;
  $("amount").value = t.amount;
  document.querySelector('input[name="mode"][value="' + t.mode + '"]').checked = true;
  $("notes").value = t.notes || "";
  $("timestamp").value = toLocalInputValue(new Date(t.timestamp_utc));
  $("formTitle").textContent = "Edit Trade #" + id;
  $("saveBtn").textContent = "Update Trade";
  $("cancelEditBtn").hidden = false;
  $("entryCard").classList.add("editing");
  highlightRow(id);
  hideErrors();
  updatePreviews();
  $("entryCard").scrollIntoView({ behavior: "smooth", block: "start" });
  toast("Editing trade #" + id + " — change anything and press Update Trade.", "info");
}

function highlightRow(id) {
  document.querySelectorAll("#tradesBody tr").forEach((tr) => {
    tr.classList.toggle("row-editing", tr.dataset.id === String(id));
  });
}

// Back to "New Trade" state (also used after a successful save).
function resetForm() {
  state.editingId = null;
  $("tradeForm").reset();
  document.querySelector('input[name="mode"][value="real"]').checked = true;
  $("formTitle").textContent = "New Trade";
  $("saveBtn").textContent = "Save Trade";
  $("cancelEditBtn").hidden = true;
  $("entryCard").classList.remove("editing");
  document.querySelectorAll("#tradesBody tr.row-editing").forEach((tr) => tr.classList.remove("row-editing"));
  hideErrors();
  setNow();
}

/* ---------- Delete ---------- */
function askDelete(id) {
  const t = state.trades.find((x) => x.id === id);
  if (!t) return;
  state.pendingDeleteId = id;
  const msg = $("deleteMessage");
  msg.textContent = "";
  msg.appendChild(document.createTextNode("Trade #" + id + " — " + t.asset + " " + t.direction + " " + t.outcome + " (" + t.mode + "), P&L "));
  const strong = document.createElement("strong");
  strong.textContent = "$" + t.pnl_formatted;
  msg.appendChild(strong);
  msg.appendChild(document.createTextNode("."));
  $("deleteModal").hidden = false;
  $("deleteConfirm").focus();
}

function closeDeleteModal() {
  $("deleteModal").hidden = true;
  state.pendingDeleteId = null;
}

async function confirmDelete() {
  const id = state.pendingDeleteId;
  if (id === null) return;
  $("deleteConfirm").disabled = true;
  try {
    const res = await fetch("/api/trades/" + id, { method: "DELETE" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      toast("Delete failed: " + (data.error || "HTTP " + res.status), "error");
    } else {
      toast("Deleted trade #" + id + " from SQLite", "ok");
      if (state.editingId === id) resetForm();
      await refreshAll();
    }
  } catch (err) {
    toast("Network error — is the server running? (" + err.message + ")", "error");
  } finally {
    $("deleteConfirm").disabled = false;
    closeDeleteModal();
  }
}

/* ---------- Misc ---------- */
function fillExample() {
  $("asset").value = "btc/usdt";
  $("direction").value = "long";
  $("outcome").value = "win";
  $("amount").value = "42.50";
  document.querySelector('input[name="mode"][value="real"]').checked = true;
  $("notes").value = "Example entry — breakout with volume.";
  setNow();
  updatePreviews();
  $("asset").focus();
}

async function refreshAll() {
  await Promise.all([loadTrades(), loadHealth()]);
  // Tell the analytics dashboard (if open) that the database changed.
  if (typeof window.__ttDataChanged === "function") window.__ttDataChanged();
}

/* ---------- CSV / Excel import ---------- */
let pendingReadyTrades = [];

function showImportErrors(list) {
  const box = $("importErrors");
  box.hidden = false;
  box.innerHTML = "<ul>" + list.map((m) => "<li>" + escapeHtml(m) + "</li>").join("") + "</ul>";
}

function hideImportErrors() {
  $("importErrors").hidden = true;
  $("importErrors").innerHTML = "";
}

function closeImportModal() {
  $("importModal").hidden = true;
}

function resetImport() {
  pendingReadyTrades = [];
  $("importFile").value = "";
  $("importFileName").textContent = "";
  $("importBody").innerHTML = "";
  $("importCounts").innerHTML = "";
  $("importMapping").textContent = "";
  $("importTruncated").hidden = true;
  hideImportErrors();
  closeImportModal();
  $("importConfirmBtn").disabled = false;
}

async function previewImport(event) {
  if (event) event.preventDefault();
  hideImportErrors();
  const file = $("importFile").files[0];
  if (!file) {
    showImportErrors(["Choose a CSV or Excel file first."]);
    toast("Choose a CSV or Excel file first.", "error");
    return;
  }
  toast("Reading " + file.name + "…", "info");
  const fd = new FormData();
  fd.append("file", file);
  $("importPreviewBtn").disabled = true;
  try {
    const res = await fetch("/api/import/preview", { method: "POST", body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data.error || "Could not read the file (HTTP " + res.status + ").";
      showImportErrors([msg]);
      toast(msg, "error");
      return;
    }
    pendingReadyTrades = Array.isArray(data.readyTrades) ? data.readyTrades : [];
    const c = data.counts || {};
    $("importCounts").innerHTML =
      '<span class="import-stat">' + (c.total || 0) + " rows</span>" +
      '<span class="import-stat ready">' + (c.ready || 0) + " new</span>" +
      '<span class="import-stat dup">' + (c.duplicates || 0) + " duplicates (skipped)</span>" +
      '<span class="import-stat bad">' + (c.invalid || 0) + " invalid</span>";

    const mapBits = Object.keys(data.mapping || {}).map((k) => k + " ← " + data.mapping[k]);
    let mapText = data.filename + " · columns: " + (mapBits.join("; ") || "none mapped");
    if (data.missingRequired && data.missingRequired.length) {
      mapText += " · missing required: " + data.missingRequired.join(", ");
    }
    $("importMapping").textContent = mapText;

    const body = $("importBody");
    if (!data.rows || !data.rows.length) {
      body.innerHTML = '<tr><td colspan="9" class="empty">No rows to show.</td></tr>';
    } else {
      body.innerHTML = data.rows.map((r) => {
        const p = r.preview || {};
        const reason = r.reason || p.notes || "—";
        return (
          "<tr>" +
            '<td class="mono">' + r.rowNumber + "</td>" +
            '<td><span class="chip chip-' + escapeHtml(r.status) + '">' + escapeHtml(r.status) + "</span></td>" +
            "<td>" + escapeHtml(p.asset || (r.payload && r.payload.asset) || "—") + "</td>" +
            "<td>" + escapeHtml(p.direction || "—") + "</td>" +
            "<td>" + escapeHtml(p.outcome || "—") + "</td>" +
            "<td>" + escapeHtml(p.pnl_formatted || "—") + "</td>" +
            "<td>" + escapeHtml(p.mode || "—") + "</td>" +
            '<td class="mono faint">' + escapeHtml(p.timestamp_utc || "—") + "</td>" +
            '<td class="notes" title="' + escapeHtml(reason) + '">' + escapeHtml(reason) + "</td>" +
          "</tr>"
        );
      }).join("");
    }
    $("importTruncated").hidden = !data.truncated;
    $("importConfirmBtn").disabled = pendingReadyTrades.length === 0;
    $("importModal").hidden = false;
    toast("Preview ready — review the rows, then click Import new trades.", "ok");
    if (data.missingRequired && data.missingRequired.length) {
      showImportErrors(["Required columns could not be mapped: " + data.missingRequired.join(", ") + ". Rename the headers or add those columns."]);
    }
  } catch (err) {
    showImportErrors(["Network error — is the server running? (" + err.message + ")"]);
  } finally {
    $("importPreviewBtn").disabled = false;
  }
}

async function confirmImport() {
  if (!pendingReadyTrades.length) {
    toast("Nothing new to import — duplicates and invalid rows are skipped.", "info");
    return;
  }
  $("importConfirmBtn").disabled = true;
  try {
    const res = await fetch("/api/import/confirm", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ trades: pendingReadyTrades }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      showImportErrors([data.error || "Import failed (HTTP " + res.status + ")."]);
      $("importConfirmBtn").disabled = false;
      return;
    }
    toast(
      "Imported " + data.imported + " trade" + (data.imported === 1 ? "" : "s") +
      (data.skipped_duplicates ? " · skipped " + data.skipped_duplicates + " duplicate" + (data.skipped_duplicates === 1 ? "" : "s") : "") +
      (data.failed ? " · " + data.failed + " failed" : "") +
      " · saved to SQLite",
      data.failed ? "error" : "ok"
    );
    pendingReadyTrades = [];
    $("importConfirmBtn").disabled = true;
    closeImportModal();
    await refreshAll();
  } catch (err) {
    toast("Network error — is the server running? (" + err.message + ")", "error");
    $("importConfirmBtn").disabled = false;
  }
}

/* ---------- Wiring ---------- */
document.addEventListener("DOMContentLoaded", () => {
  $("tradeForm").addEventListener("submit", submitTrade);
  $("nowBtn").addEventListener("click", setNow);
  $("exampleBtn").addEventListener("click", fillExample);
  $("cancelEditBtn").addEventListener("click", resetForm);
  $("reloadBtn").addEventListener("click", refreshAll);

  const previewBtn = $("importPreviewBtn");
  if (previewBtn) previewBtn.addEventListener("click", previewImport);
  const confirmBtn = $("importConfirmBtn");
  if (confirmBtn) confirmBtn.addEventListener("click", confirmImport);
  const cancelBtn = $("importCancelBtn");
  if (cancelBtn) cancelBtn.addEventListener("click", closeImportModal);
  const fileInput = $("importFile");
  if (fileInput) {
    fileInput.addEventListener("change", () => {
      const f = fileInput.files[0];
      const nameEl = $("importFileName");
      if (nameEl) nameEl.textContent = f ? f.name : "";
      hideImportErrors();
    });
  }
  const importModal = $("importModal");
  if (importModal) {
    importModal.addEventListener("click", (event) => {
      if (event.target === importModal) closeImportModal();
    });
  }

  document.querySelectorAll("#logCard .pill").forEach((btn) => {
    btn.addEventListener("click", () => setFilter(btn.dataset.mode));
  });

  $("asset").addEventListener("input", updatePreviews);
  $("amount").addEventListener("input", updatePreviews);
  $("outcome").addEventListener("change", updatePreviews);
  $("timestamp").addEventListener("input", updatePreviews);

  // Table buttons (event delegation: one listener for all rows).
  $("tradesBody").addEventListener("click", (event) => {
    const editBtn = event.target.closest("[data-edit]");
    if (editBtn) { startEdit(Number(editBtn.dataset.edit)); return; }
    const delBtn = event.target.closest("[data-del]");
    if (delBtn) askDelete(Number(delBtn.dataset.del));
  });

  // Delete modal.
  $("deleteCancel").addEventListener("click", closeDeleteModal);
  $("deleteConfirm").addEventListener("click", confirmDelete);
  $("deleteModal").addEventListener("click", (event) => {
    if (event.target === $("deleteModal")) closeDeleteModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeDeleteModal();
      closeImportModal();
    }
  });

  // Initial load.
  setNow();
  refreshAll();
});

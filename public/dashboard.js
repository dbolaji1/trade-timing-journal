/* ============================================================
   Trade Timing Journal — Analytics Dashboard (Session 3)
   Vanilla JavaScript + Chart.js (vendored locally, no CDN).

   Data source: GET /api/analytics — computed server-side from
   SQLite on every load. Real and demo are separate everywhere.
   ============================================================ */

"use strict";

(function () {
  const $ = (id) => document.getElementById(id);

  const COLORS = { real: "#38bdf8", demo: "#fcd34d" };
  const BAND = { real: "rgba(56,189,248,0.25)", demo: "rgba(252,211,77,0.28)" };
  const FULL_DAYS = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };

  const state = {
    data: null,
    mode: "both", // both | real | demo (which series/CI bands the charts show)
    visible: false,
    charts: [],
  };

  /* ---------- formatting ---------- */
  const pct = (x, digits) =>
    x === null || x === undefined ? "—" : (x * 100).toFixed(digits === undefined ? 1 : digits) + "%";

  function usdCents(cents) {
    if (cents === null || cents === undefined) return "—";
    const sign = cents < 0 ? "-" : "";
    const abs = Math.abs(cents);
    return sign + "$" + Math.floor(abs / 100).toLocaleString("en-US") + "." + String(abs % 100).padStart(2, "0");
  }

  const esc = (s) =>
    String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

  function hourRange(label) {
    const h = Number(label.slice(0, 2));
    return label + "–" + String((h + 1) % 24).padStart(2, "0") + ":00";
  }

  function windowTitle(dimension, label) {
    return dimension === "hour" ? hourRange(label) : FULL_DAYS[label] || label;
  }

  /* ---------- data loading ---------- */
  async function loadDashboard() {
    const errBox = $("dashError");
    errBox.hidden = true;
    try {
      const res = await fetch("/api/analytics");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        showError(data.error || "Could not load analytics (HTTP " + res.status + ").");
        return;
      }
      state.data = data;
      $("dashHint").textContent =
        "Computed from SQLite on " + new Date(data.generated_at).toLocaleString() +
        " · bucketed in " + data.timezone +
        " · buckets need ≥" + data.thresholds.minN + " trades · 95% Wilson confidence intervals.";
      renderAll();
    } catch (err) {
      showError("Network error — is the server running? (" + err.message + ")");
    }
  }

  function showError(message) {
    const errBox = $("dashError");
    errBox.textContent = message;
    errBox.hidden = false;
  }

  /* ---------- rendering ---------- */
  function renderAll() {
    $("tzHour").textContent = state.data.timezone;
    $("tzDay").textContent = state.data.timezone;
    renderKpis();
    renderBestCards();
    renderTables();
    renderCharts();
  }

  /* ---------- KPI cards ---------- */
  function kpiCard(mode) {
    const s = state.data[mode].summary;
    const chip = mode === "real" ? "chip-real" : "chip-demo";
    const label = mode === "real" ? "Real trades" : "Demo trades";
    const caveat = s.smallSample
      ? '<p class="caveat">Small sample (fewer than ' + state.data.thresholds.bestSmallSampleN +
        " trades) — treat these numbers as provisional.</p>"
      : "";
    return (
      '<div class="kpi ' + mode + '">' +
        "<h3>" + label + ' <span class="chip ' + chip + '">' + mode + "</span></h3>" +
        '<div class="kpi-n">' + s.n + " trade" + (s.n === 1 ? "" : "s") + "</div>" +
        '<div class="kpi-rows">' +
          '<div><span>Win rate</span><b>' + pct(s.winRate) + "</b></div>" +
          '<div><span>95% CI</span><small>' + pct(s.ciLower) + " – " + pct(s.ciUpper) + "</small></div>" +
          '<div><span>Expectancy</span><b>' + usdCents(s.expectancyCents) + "</b></div>" +
          '<div><span>Total P&amp;L</span><b>' + usdCents(s.totalPnlCents) + "</b></div>" +
        "</div>" + caveat +
      "</div>"
    );
  }

  function renderKpis() {
    $("kpiCards").innerHTML = kpiCard("real") + kpiCard("demo");
  }

  /* ---------- Best-window cards ---------- */
  function bestBlock(mode, dimension, best) {
    const thresholds = state.data.thresholds;
    if (!best.found) {
      const baselineText = best.baselineWinRate === 0
        ? "no baseline yet (no " + mode + " trades)"
        : "the " + mode + " baseline is " + pct(best.baselineWinRate) + ".";
      return (
        '<div class="best-none">' +
          "<strong>No qualifying " + dimension + " yet.</strong><br>" +
          "A " + dimension + " qualifies when it has at least " + thresholds.bestMinN + " " + mode +
          " trades and a win rate more than " + thresholds.bestMarginPct +
          " percentage points above the " + mode + " baseline — currently " + baselineText +
          "<br><span class='faint'>Candidates are ranked by the Wilson lower bound, never by raw win rate.</span>" +
        "</div>"
      );
    }
    const w = best.window;
    const caveat = w.smallSample
      ? '<p class="caveat">Small sample (N=' + w.n + " < " + thresholds.bestSmallSampleN +
        ") — treat as a hypothesis, not proof.</p>"
      : "";
    return (
      '<div class="best-title">' + esc(windowTitle(dimension, w.label)) + "</div>" +
      '<div class="best-line"><span>Win rate</span><b>' + pct(w.winRate) + "</b></div>" +
      '<div class="best-line"><span>Sample size</span><b>' + w.n + " trades (" + w.wins + " wins)</b></div>" +
      '<div class="best-line"><span>95% CI (Wilson)</span><b>' + pct(w.ciLower) + " – " + pct(w.ciUpper) + "</b></div>" +
      '<div class="best-line"><span>Expectancy</span><b>' + usdCents(w.expectancyCents) + "</b></div>" +
      '<div class="best-line"><span>vs ' + mode + " baseline</span><b>" +
        pct(w.winRate - w.baselineWinRate, 1) + " above " + pct(w.baselineWinRate) + "</b></div>" +
      '<p class="best-note faint">Selected by Wilson lower bound, requiring ≥' + thresholds.bestMinN +
        " trades and >" + thresholds.bestMarginPct + " pts over the " + mode + " baseline.</p>" +
      caveat
    );
  }

  function bestCard(mode) {
    const a = state.data[mode];
    const chip = mode === "real" ? "chip-real" : "chip-demo";
    const demoNote = mode === "demo"
      ? '<p class="best-note" style="color:var(--amber)">Demo = practice data. It is analysed with its own baseline and never mixed into real statistics.</p>'
      : "";
    return (
      '<div class="best-card ' + mode + '">' +
        '<h3>Best window — ' + mode + ' trades <span class="chip ' + chip + '">' + mode + "</span></h3>" +
        demoNote +
        '<div class="best-block"><h4>Hour of day</h4>' + bestBlock(mode, "hour", a.bestHour) + "</div>" +
        '<div class="best-block"><h4>Day of week</h4>' + bestBlock(mode, "weekday", a.bestWeekday) + "</div>" +
      "</div>"
    );
  }

  function renderBestCards() {
    $("bestCards").innerHTML = bestCard("real") + bestCard("demo");
  }

  /* ---------- Tables (real and demo side by side, never blended) ---------- */
  function modeCells(bucket) {
    if (!bucket.eligible) {
      return (
        '<td class="mono">' + bucket.n + "</td>" +
        '<td class="empty-cell">Not enough data yet</td>' +
        '<td class="faint">—</td>' +
        '<td class="faint">—</td>'
      );
    }
    return (
      '<td class="mono">' + bucket.n + "</td>" +
      "<td><b>" + pct(bucket.winRate) + "</b></td>" +
      '<td class="mono">' + pct(bucket.ciLower) + " – " + pct(bucket.ciUpper) + "</td>" +
      "<td>" + usdCents(bucket.expectancyCents) + "</td>"
    );
  }

  function renderDimensionTable(bodyId, bucketsByMode, labels) {
    const rows = labels.map((label) => {
      const r = bucketsByMode.real.find((b) => b.key === label.key);
      const d = bucketsByMode.demo.find((b) => b.key === label.key);
      return (
        "<tr>" +
        '<td class="nowrap"><b>' + esc(label.display) + "</b></td>" +
        modeCells(r) +
        modeCells(d) +
        "</tr>"
      );
    });
    $(bodyId).innerHTML = rows.join("");
  }

  function renderTables() {
    const data = state.data;
    const hourLabels = data.real.hourly.map((b) => ({ key: b.key, display: hourRange(b.label) }));
    const dayLabels = data.real.weekday.map((b) => ({ key: b.key, display: b.label }));
    renderDimensionTable("hourlyBody", { real: data.real.hourly, demo: data.demo.hourly }, hourLabels);
    renderDimensionTable("weekdayBody", { real: data.real.weekday, demo: data.demo.weekday }, dayLabels);
  }

  /* ---------- Charts ---------- */
  function destroyCharts() {
    state.charts.forEach((c) => c.destroy());
    state.charts = [];
  }

  function baseBarOptions(yMax, yLabel) {
    const opts = {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: { labels: { color: "#94a3b8", boxWidth: 12, boxHeight: 12 } },
        tooltip: {
          backgroundColor: "#0b1120",
          borderColor: "#334155",
          borderWidth: 1,
          titleColor: "#e2e8f0",
          bodyColor: "#cbd5e1",
          callbacks: {},
        },
      },
      scales: {
        x: { ticks: { color: "#94a3b8", maxRotation: 0, autoSkip: true }, grid: { color: "rgba(51,65,85,0.35)" } },
        y: {
          ticks: { color: "#94a3b8", callback: (v) => v + yLabel },
          grid: { color: "rgba(51,65,85,0.35)" },
        },
      },
    };
    if (yMax !== null) {
      opts.scales.y.min = 0;
      opts.scales.y.max = yMax;
    }
    return opts;
  }

  function winRateChart(canvasId, labels, realBuckets, demoBuckets) {
    const cfg = {
      type: "bar",
      data: { labels, datasets: [] },
      options: baseBarOptions(100, "%"),
    };

    const addBand = (mode, buckets) => {
      cfg.data.datasets.push({
        label: mode + " 95% CI (Wilson)",
        data: buckets.map((b) => (b.eligible ? [b.ciLower * 100, b.ciUpper * 100] : null)),
        backgroundColor: BAND[mode],
        borderWidth: 0,
        barPercentage: 0.5,
        categoryPercentage: 0.8,
        order: 1,
      });
    };

    const addBars = (mode, buckets) => {
      cfg.data.datasets.push({
        label: mode + " win rate",
        data: buckets.map((b) => (b.eligible ? +(b.winRate * 100).toFixed(1) : null)),
        backgroundColor: COLORS[mode],
        borderColor: "rgba(0,0,0,0)",
        borderRadius: 3,
        barPercentage: 0.5,
        categoryPercentage: 0.8,
        order: 2,
      });
    };

    if (state.mode === "both") {
      addBars("real", realBuckets);
      addBars("demo", demoBuckets);
    } else if (state.mode === "real") {
      addBand("real", realBuckets);
      addBars("real", realBuckets);
    } else {
      addBand("demo", demoBuckets);
      addBars("demo", demoBuckets);
    }

    cfg.options.plugins.tooltip.callbacks.label = (ctx) => {
      const buckets = ctx.dataset.label.indexOf("real") === 0 ? realBuckets : demoBuckets;
      const bucket = buckets[ctx.dataIndex];
      if (!bucket || !bucket.eligible) return "Not enough data yet (N=" + (bucket ? bucket.n : 0) + ")";
      if (Array.isArray(ctx.raw)) {
        return "95% CI: " + pct(ctx.raw[0] / 100) + " – " + pct(ctx.raw[1] / 100);
      }
      return (
        "Win rate " + pct(bucket.winRate) +
        " (95% CI " + pct(bucket.ciLower) + "–" + pct(bucket.ciUpper) + ") · N=" + bucket.n
      );
    };

    return new Chart($(canvasId), cfg);
  }

  function expectancyChart(canvasId, labels, realBuckets, demoBuckets) {
    const cfg = {
      type: "bar",
      data: { labels, datasets: [] },
      options: baseBarOptions(null, "$"),
    };

    const addBars = (mode, buckets) => {
      cfg.data.datasets.push({
        label: mode + " avg P&L",
        data: buckets.map((b) => (b.eligible ? +(b.expectancyCents / 100).toFixed(2) : null)),
        backgroundColor: COLORS[mode],
        borderRadius: 3,
        barPercentage: 0.5,
        categoryPercentage: 0.8,
      });
    };

    if (state.mode !== "demo") addBars("real", realBuckets);
    if (state.mode !== "real") addBars("demo", demoBuckets);

    cfg.options.plugins.tooltip.callbacks.label = (ctx) => {
      const buckets = ctx.dataset.label.indexOf("real") === 0 ? realBuckets : demoBuckets;
      const bucket = buckets[ctx.dataIndex];
      if (!bucket || !bucket.eligible) return "Not enough data yet (N=" + (bucket ? bucket.n : 0) + ")";
      return "Avg P&L " + usdCents(bucket.expectancyCents) + " · N=" + bucket.n;
    };

    return new Chart($(canvasId), cfg);
  }

  function renderCharts() {
    destroyCharts();
    const data = state.data;
    const hourLabels = data.real.hourly.map((b) => b.label);
    const dayLabels = data.real.weekday.map((b) => b.label);

    state.charts.push(winRateChart("chartHourlyWin", hourLabels, data.real.hourly, data.demo.hourly));
    state.charts.push(expectancyChart("chartHourlyExp", hourLabels, data.real.hourly, data.demo.hourly));
    state.charts.push(winRateChart("chartWeekdayWin", dayLabels, data.real.weekday, data.demo.weekday));
    state.charts.push(expectancyChart("chartWeekdayExp", dayLabels, data.real.weekday, data.demo.weekday));
  }

  /* ---------- mode pills ---------- */
  function setMode(mode) {
    state.mode = mode;
    document.querySelectorAll(".pill[data-amode]").forEach((btn) => {
      const active = btn.dataset.amode === mode;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-pressed", String(active));
    });
    if (state.data) renderCharts(); // tables/KPIs always show both modes
  }

  /* ---------- tab switching ---------- */
  function setView(view) {
    state.visible = view === "dashboard";
    document.querySelectorAll(".tab").forEach((btn) => {
      const active = btn.dataset.view === view;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", String(active));
    });
    $("journalView").hidden = view !== "journal";
    $("dashboardView").hidden = view !== "dashboard";
    if (state.visible) loadDashboard();
  }

  /* ---------- wiring ---------- */
  function init() {
    if (typeof Chart === "undefined") {
      showError("Chart.js failed to load (public/vendor/chart.umd.js missing). Run npm install and retry.");
      return;
    }
    document.querySelectorAll(".tab").forEach((btn) => {
      btn.addEventListener("click", () => setView(btn.dataset.view));
    });
    document.querySelectorAll(".pill[data-amode]").forEach((btn) => {
      btn.addEventListener("click", () => setMode(btn.dataset.amode));
    });
    $("dashReloadBtn").addEventListener("click", loadDashboard);

    // Called by app.js after any create/update/delete, so the dashboard
    // is never stale while it is visible.
    window.__ttDataChanged = () => {
      if (state.visible) loadDashboard();
    };
  }

  init();
})();

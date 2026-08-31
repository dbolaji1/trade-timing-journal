/* ============================================================
   Trade Timing Journal — Analytics Dashboard
   Vanilla JavaScript + Chart.js (vendored locally, no CDN).

   Data source: GET /api/analytics — computed server-side from
   SQLite on every load. Real and demo are separate everywhere.

   Honesty rules the UI follows:
   - The headline callout is "Strongest observed window", not "Best
     window": ~31 buckets are tested and some look good by chance.
     A window only qualifies at >=30 trades, >5pts over baseline,
     AND Wilson 95% lower bound above baseline.
   - Every callout carries a one-line plain-English CI explainer.
   - Win rate = wins / all trades (breakevens in the denominator).
   ============================================================ */

"use strict";

(function () {
  const $ = (id) => document.getElementById(id);
  const F = window.TT_FORMAT || { usd: (c) => c, pct: (x) => x, pctPoints: (x) => x };

  const COLORS = { real: "#38bdf8", demo: "#fcd34d" };
  const BAND = { real: "rgba(56,189,248,0.25)", demo: "rgba(252,211,77,0.28)" };
  const FULL_DAYS = { Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" };

  const state = {
    data: null,
    mode: "both", // both | real | demo (which series/CI bands the charts show)
    visible: false,
    charts: [],
    currencySymbol: "$",
  };

  /* ---------- formatting (single implementation: format.js) ---------- */
  const pct = (x, digits) => F.pct(x, digits);
  const pctPoints = (x, digits) => F.pctPoints(x, digits);
  const usdCents = (cents) => F.usd(cents, state.currencySymbol);

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
      state.currencySymbol = data.currency_symbol || "$";
      const today = data.real && data.real.today ? data.real.today : null;
      $("dashHint").textContent =
        "Computed from SQLite on " + new Date(data.generated_at).toLocaleString() +
        " · bucketed in " + data.timezone +
        " · focused on today" + (today ? " (" + today.weekdayFull + ")" : "") +
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
    const t = state.data[mode].today;
    const chip = mode === "real" ? "chip-real" : "chip-demo";
    const label = mode === "real" ? "Real trades" : "Demo trades";
    const caveat = s.smallSample
      ? '<p class="caveat">Small sample (fewer than ' + state.data.thresholds.bestSmallSampleN +
        " trades) — treat these numbers as provisional.</p>"
      : "";
    const roiRow = s.roiPct === null || s.roiPct === undefined
      ? ""
      : '<div><span>ROI (of stake)</span><b>' + pctPoints(s.roiPct) + "</b></div>";
    const todayRow = t && t.summary
      ? '<div><span>Today (' + esc(t.weekday) + ")</span><b>" + t.summary.n +
        " trade" + (t.summary.n === 1 ? "" : "s") + "</b></div>"
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
          roiRow +
          todayRow +
        "</div>" + caveat +
      "</div>"
    );
  }

  function renderKpis() {
    $("kpiCards").innerHTML = kpiCard("real") + kpiCard("demo");
  }

  /* ---------- Today cards (the headline) ---------- */

  // Monday's FULL historical stats (all weeks), plus a small "today so far" line.
  function todaySummaryRows(mode) {
    const t = state.data[mode].today;
    const s = t.weekdayStats || t.baseline || { n: 0, winRate: null };
    const todayS = t.summary || { n: 0 };
    const roiRow = s.roiPct === null || s.roiPct === undefined
      ? ""
      : '<div class="best-line"><span>ROI (of stake)</span><b>' + pctPoints(s.roiPct) + "</b></div>";
    const caveat = s.n > 0 && s.smallSample
      ? '<p class="caveat">Small sample (' + s.n + " < " +
        state.data.thresholds.todaySmallSampleN + " " + esc(t.weekdayFull) +
        " trades) — treat as provisional.</p>"
      : "";
    return (
      "<div>" +
        '<div class="best-line"><span>' + esc(t.weekdayFull) + " trades</span><b>" + s.n + " (" + s.wins + " wins)</b></div>" +
        '<div class="best-line"><span>Win rate</span><b>' + pct(s.winRate) + "</b></div>" +
        '<div class="best-line"><span>95% CI</span><b>' + pct(s.ciLower) + " – " + pct(s.ciUpper) + "</b></div>" +
        '<div class="best-line"><span>Expectancy</span><b>' + usdCents(s.expectancyCents) + "</b></div>" +
        '<div class="best-line"><span>Total P&amp;L</span><b>' + usdCents(s.totalPnlCents) + "</b></div>" +
        roiRow +
        '<p class="best-note faint">Today so far: ' + todayS.n + " trade" + (todayS.n === 1 ? "" : "s") +
          " (" + pct(todayS.winRate) + " win rate).</p>" +
        caveat +
      "</div>"
    );
  }

  // The best time of day on today's weekday (e.g. best MONDAY hour).
  function todayBestHourBlock(mode, t) {
    const th = state.data.thresholds;
    const best = t.bestHour;
    const weekdayName = t.weekdayFull;
    if (!best.found) {
      const baselineText = best.baselineWinRate === 0
        ? "no baseline yet (no " + weekdayName + " trades)"
        : "the " + weekdayName + " baseline is " + pct(best.baselineWinRate) + ".";
      return (
        '<div class="best-none">' +
          "<strong>No qualifying hour on " + weekdayName + "s yet.</strong><br>" +
          "An hour qualifies with at least " + th.todayMinN + " " + weekdayName + " trades, a win rate more than " +
          th.todayMarginPct + " points above the " + weekdayName + " baseline, and a confidence lower bound above it — currently " +
          baselineText +
          "<br><span class='faint'>Based on " + (t.baseline ? t.baseline.n : 0) + " " + weekdayName + " trades so far.</span>" +
        "</div>"
      );
    }
    const w = best.window;
    const caveat = w.smallSample
      ? '<p class="caveat">Small sample (N=' + w.n + " < " + th.todaySmallSampleN +
        ") — treat as a hint about " + weekdayName + "s, not proof.</p>"
      : "";
    const roiRow = w.roiPct === null || w.roiPct === undefined
      ? ""
      : '<div class="best-line"><span>ROI (of stake)</span><b>' + pctPoints(w.roiPct) + "</b></div>";
    const explainer =
      '<p class="best-note">What the interval means: if you repeated this sample many times, the true win rate ' +
      'would usually fall between <b>' + pct(w.ciLower) + "</b> and <b>" + pct(w.ciUpper) +
      "</b>. Narrow intervals = more trustworthy; wide intervals = treat with caution.</p>";
    return (
      '<div class="best-title">' + esc(windowTitle("hour", w.label)) + "</div>" +
      '<div class="best-line"><span>Win rate</span><b>' + pct(w.winRate) + "</b></div>" +
      '<div class="best-line"><span>Sample size</span><b>' + w.n + " " + weekdayName + " trades (" + w.wins + " wins)</b></div>" +
      '<div class="best-line"><span>95% CI (Wilson)</span><b>' + pct(w.ciLower) + " – " + pct(w.ciUpper) + "</b></div>" +
      '<div class="best-line"><span>Expectancy</span><b>' + usdCents(w.expectancyCents) + "</b></div>" +
      roiRow +
      '<div class="best-line"><span>vs ' + weekdayName + " baseline</span><b>" +
        pct(w.winRate - w.baselineWinRate, 1) + " above " + pct(w.baselineWinRate) + "</b></div>" +
      '<p class="best-note faint">Qualifies with ≥' + th.todayMinN + " " + weekdayName + " trades, >" +
        th.todayMarginPct + " pts over the " + weekdayName + " baseline, and the Wilson lower bound above it.</p>" +
      explainer +
      caveat
    );
  }

  function todayCard(mode) {
    const a = state.data[mode];
    const t = a.today;
    const chip = mode === "real" ? "chip-real" : "chip-demo";
    const demoNote = mode === "demo"
      ? '<p class="best-note" style="color:var(--amber)">Demo = practice data. It is analysed with its own baseline and never mixed into real statistics.</p>'
      : "";
    if (!t) return "";
    const wStats = t.weekdayStats || {};
    const noTrades = (!wStats.n || wStats.n === 0);
    return (
      '<div class="best-card ' + mode + ' today-card">' +
        "<h3>" + esc(t.weekdayFull) + ' — today (' + esc(t.date) + ') <span class="chip ' + chip + '">' + mode + "</span></h3>" +
        '<p class="best-note faint">Every number below is your ' + esc(t.weekdayFull) +
          " performance across ALL weeks — so it shows the trades you have on " + esc(t.weekdayFull) +
          "s and the best time historically, even before you trade today.</p>" +
        (noTrades
          ? '<div class="best-none">No ' + esc(t.weekdayFull) + " trades logged yet — log a trade on a " +
            esc(t.weekdayFull) + " and this card will fill in automatically.</div>"
          : "") +
        demoNote +
        '<div class="best-block"><h4>' + esc(t.weekdayFull) + " — all time</h4>" + todaySummaryRows(mode) + "</div>" +
        '<div class="best-block"><h4>Best time to trade on ' + esc(t.weekdayFull) + "s</h4>" +
          todayBestHourBlock(mode, t) + "</div>" +
      "</div>"
    );
  }

  function renderBestCards() {
    $("bestCards").innerHTML = todayCard("real") + todayCard("demo");
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

  function renderDimensionTable(bodyId, bucketsByMode, labels, todayKey) {
    const rows = labels.map((label) => {
      const r = bucketsByMode.real.find((b) => b.key === label.key);
      const d = bucketsByMode.demo.find((b) => b.key === label.key);
      const isToday = todayKey !== undefined && todayKey !== null && label.key === todayKey;
      const display = isToday ? label.display + ' <span class="chip chip-today">today</span>' : label.display;
      return (
        "<tr" + (isToday ? ' class="today-row"' : "") + ">" +
        '<td class="nowrap"><b>' + display + "</b></td>" +
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
    const todayKey = data.real.today ? data.real.today.weekdayKey : null;
    renderDimensionTable("hourlyBody", { real: data.real.hourly, demo: data.demo.hourly }, hourLabels);
    renderDimensionTable("weekdayBody", { real: data.real.weekday, demo: data.demo.weekday }, dayLabels, todayKey);
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
      options: baseBarOptions(null, state.currencySymbol),
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

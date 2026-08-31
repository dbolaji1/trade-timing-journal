# Trade Timing Journal

A personal trading journal designed to determine — from **your actual historical trade data** — which **hours of the day** and **days of the week** produce the best results, without being misled by small samples, demo trades, raw win rates, or statistical uncertainty.

> **Core principle:** Every trade you save is written to a local **SQLite** file (`data/trades.db`) and **persists across restarts, weeks, and months**. Analytics are calculated from that accumulated history, with statistical honesty built in.

---

## What the application does

1. **Journal** — enter trades (asset, direction, outcome, P&L, stake, real/demo, notes, timestamp), edit them, delete them (with undo), and filter the log by mode, asset, outcome, date range, and free text. Everything reads from and writes to SQLite. The **sign of the P&L is derived from the outcome** (win = +, loss = −, breakeven = 0), so the money can never contradict the result label.
2. **Analytics Dashboard** — hourly and weekday statistics per mode:
   - trade count, win rate, **expectancy (average P&L)**, **ROI % of stake** (when stakes are logged), and a **95% Wilson confidence interval** for every bucket with enough data,
   - "Not enough data yet" for buckets with fewer than 3 trades — never a misleading blank,
   - **"Strongest observed window" callouts for BOTH real and demo trades** (demo is analysed against its own baseline and is never mixed into real statistics).
3. **Honest strongest-window selection** — because the dashboard tests roughly 31 buckets (24 hours + 7 weekdays) and some will look good by chance alone (the multiple-comparisons problem), a window qualifies only when **all** of these hold:
   - at least **30 trades** of that mode,
   - win rate **more than 5 percentage points above that mode's baseline**,
   - the **95% Wilson lower bound also clears the baseline**,
   and the winner is ranked by the **lower bound of its Wilson interval**, never by raw win rate.
4. **Import / Export** — CSV and `.xlsx` import (with column auto-mapping that you must confirm), duplicate detection that uses your broker's trade ID when available, and CSV export of any filtered view.

## Tech stack (as required)

- **Node.js + Express** — server & API (binds to `127.0.0.1` by default)
- **better-sqlite3 + SQLite** — persistent database (local file, WAL mode, migrations)
- **Plain HTML / Plain CSS / Vanilla JavaScript** — frontend (no frameworks)
- **Chart.js** — vendored locally (`public/vendor/chart.umd.js`), used only for the dashboard charts
- **exceljs** — `.xlsx` parsing (the abandoned npm `xlsx` package is deliberately not used: it has unresolved prototype-pollution and ReDoS advisories); CSV is parsed with a small built-in parser

No React, TypeScript, MongoDB, PostgreSQL, Tailwind, auth, or cloud services. No external statistics library — the Wilson intervals are implemented directly in `analytics.js`.

---

## How to install and run

### Prerequisites

- **Node.js 18 or newer** ([nodejs.org](https://nodejs.org))
- **VS Code** (or any editor with a terminal)

### 1. Open the project

1. Open VS Code → `File → Open Folder…` → select the `trade-timing-journal` folder.
2. Open the terminal: `View → Terminal` (or `` Ctrl+` ``).

### 2. Install dependencies

```bash
npm install
```

### 3. Start the server

```bash
npm start
```

Expected output the first time:

```
[DB] Created new database file at .../data/trades.db
[DB] Applying migration v1: Create trades table
[DB] Applying migration v2: Add stake, broker and broker trade id columns
[DB] Migrations complete. New version: 2

✓ Trade Timing Journal running at http://127.0.0.1:3000
  Timezone (fixed): Africa/Lagos
  Currency: USD ($)
  Database: .../data/trades.db (WAL mode, persistent)
  Bound to: 127.0.0.1 (128.0.0.1-only default; set TT_HOST=0.0.0.0 for LAN access)
```

On every later run you must see:

```
[DB] Opened existing database at .../data/trades.db
[DB] Current schema version: 2
[DB] No pending migrations. Database is up to date.
```

That proves the database was **not recreated or wiped**. Leave the terminal running.

### 4. Open the app

Go to `http://localhost:3000`. Two tabs:

- **Journal** — the trade form, filters, and trade log (with CSV export).
- **Analytics Dashboard** — KPIs, strongest-window callouts, hourly/weekday charts and tables.

---

## Database setup and persistence behavior

- The database is a single file: **`data/trades.db`**, created **only if it does not exist**.
- `db.js` opens it with **WAL mode** (`journal_mode=WAL`) and applies migrations recorded in a `schema_version` table. Running the server again is always safe — existing data is never touched.
- **Trade IDs are stable identifiers.** SQLite's `AUTOINCREMENT` assigns each new trade a number it has never used before, and IDs are **never renumbered** (deletions leave gaps on purpose). If you refer to a trade ID anywhere else, it will always mean the same trade.
- Trades are stored as:
  - `asset` — normalized uppercase with separators stripped (`btc/usdt` → `BTCUSDT`),
  - `pnl_cents` — **integer cents** (no floating-point money in the database),
  - `stake_cents` — optional integer cents (used for ROI),
  - `broker` / `broker_trade_id` — optional, used for import duplicate detection,
  - `timestamp_utc` — ISO string in UTC,
  - `mode` — `real` or `demo` (always separate).
- Restarting the server, closing the browser, rebooting the machine — none of it deletes data.
- To **explicitly reset** (destroys your history!): stop the server, delete `data/trades.db`, `data/trades.db-wal`, `data/trades.db-shm`, then `npm start`.
- `data/trades.db` and `backups/*.db` are **ignored by Git** — your private trading history is never pushed to GitHub.

### Schema (v2)

```sql
CREATE TABLE trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset TEXT NOT NULL,                          -- normalized: uppercase, separators stripped
  direction TEXT NOT NULL CHECK(direction IN ('long','short')),
  outcome TEXT NOT NULL CHECK(outcome IN ('win','loss','breakeven')),
  pnl_cents INTEGER NOT NULL,                   -- integer cents, e.g. 12345 = 123.45
  stake_cents INTEGER,                          -- optional, integer cents
  mode TEXT NOT NULL CHECK(mode IN ('real','demo')),
  notes TEXT,
  timestamp_utc TEXT NOT NULL,                  -- ISO string in UTC
  broker TEXT,
  broker_trade_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
```

`v1` databases are upgraded in place by migration `v2` — existing trades keep their IDs and gains `stake_cents`/`broker`/`broker_trade_id` columns (as `NULL`).

---

## API reference

| Method & path | Purpose |
|---|---|
| `GET /api/health` | Status: online, trade count, schema version, timezone, currency, DB path |
| `GET /api/config` | Timezone + currency for the frontend |
| `GET /api/trades` | Trade log from SQLite, newest first. Filters: `mode=real\|demo\|all`, `asset=`, `outcome=win\|loss\|breakeven`, `from=YYYY-MM-DD`, `to=YYYY-MM-DD`, `q=` (asset/notes) |
| `GET /api/trades/export.csv` | Downloads the same filtered view as CSV |
| `POST /api/trades` | Create (validated server-side) |
| `GET /api/trades/:id` | One trade |
| `PUT /api/trades/:id` | Full update |
| `PATCH /api/trades/:id` | Partial update |
| `DELETE /api/trades/:id` | Delete (returns the row so the UI can undo) |
| `POST /api/trades/restore` | `{ trades: [...] }` re-inserts deleted rows with their **original IDs** (undo) |
| `POST /api/trades/bulk-delete` | `{ ids: [...] }`; returns full rows for undo |
| `GET /api/analytics` | Full dashboard analytics (see below) |
| `POST /api/import/preview` | Upload CSV/Excel (`multipart` field `file`); returns mapping (you must confirm), caveats, counts, preview |
| `POST /api/import/confirm` | `{ trades: [...] }` — inserts only validated new trades; skips duplicates |

Validation rules (server-side, returns `400` with a `details` array):

- asset required → normalized, ≤20 chars
- direction ∈ {long, short}; outcome ∈ {win, loss, breakeven}; mode ∈ {real, demo}
- amount must be a **finite number**, stored as integer cents; the **sign is derived from the outcome** (`win` → `+`, `loss` → `−`, `breakeven` → `0`)
- **timestamps**: a value with an explicit timezone (`Z`/`+02:00`) is stored as that exact instant; a **naive** value (e.g. `2026-08-10T14:30`) is interpreted as wall-clock time in the **configured trading timezone** — never in the browser's or server's timezone. This is what guarantees a 2pm Lagos trade is bucketed as 2pm Lagos even if your browser is set to another timezone.
- stake optional, positive magnitude; notes ≤2000 chars; broker ≤50 chars; broker_trade_id ≤100 chars

### `GET /api/analytics`

Computed from SQLite on every request. Returns `{ timezone, currency, currency_symbol, generated_at, thresholds, real, demo }`.
The `real` and `demo` blocks each contain:

- `summary` — n, wins, win rate, Wilson 95% CI, total P&L, expectancy (cents), total stake, ROI %, small-sample flag
- `hourly` — 24 buckets; `weekday` — 7 buckets. Each bucket: `n`, `wins`, `winRate`, `ciLower`, `ciUpper`, `expectancyCents`, `totalStakeCents`, `roiPct`, `eligible` (n ≥ 3)
- `bestHour` / `bestWeekday` — `{ found, window | baselineWinRate, marginPct }`; `found` requires ≥30 trades, >5pts over baseline, and CI lower bound above baseline

---

## Analytics at a high level

All statistics live in `analytics.js` as pure, tested functions:

1. **Bucketing** — `bucketTimestamp(utcIso, timezone)`: UTC timestamp + the configured fixed timezone → `{ hour, weekday }`. The timezone comes from `config.js` (default `Africa/Lagos`), never from the server or browser clock.
2. **Wilson 95% confidence interval** — implemented directly (no statistics library). Every win rate is reported with its interval.
3. **Win rate definition** — **wins ÷ ALL trades of that mode**; breakevens count in the denominator.
4. **Expectancy & ROI** — expectancy = average P&L in integer cents; ROI % = total P&L ÷ total stake (when stakes exist). Rounding happens only for display.
5. **Minimum sample size** — a bucket needs ≥3 trades to show statistics; below that the UI says **"Not enough data yet"**.
6. **Strongest observed window** — for **each mode separately**, a bucket qualifies only with **≥30 trades**, win rate **>5 points above that mode's baseline**, **and** the Wilson lower bound above the baseline. The winner has the highest Wilson lower bound (tie-break: more trades, then higher win rate). If nothing qualifies, the dashboard says so explicitly.
7. **Small samples** — anything under 30 trades is labelled as provisional.

Thresholds are configurable in `config.js` (`ANALYTICS` block).

---

## Configuration

Edit `config.js`:

```js
const CONFIG = {
  TIMEZONE: "Africa/Lagos",   // ← fixed IANA timezone for input/bucketing/display
  CURRENCY: "USD",            // display only — money is always integer cents
  CURRENCY_SYMBOL: "$",
  DB_PATH: process.env.TT_DB_PATH || "./data/trades.db", // ← persistent local file
  PORT: process.env.PORT || 3000,
  HOST: process.env.TT_HOST || "127.0.0.1", // ← local-only by default
  ANALYTICS: {
    MIN_N: 3,                  // min trades before a bucket shows statistics
    BEST_MIN_N: 30,            // min trades for strongest-window eligibility (multiple comparisons guard)
    BEST_MARGIN: 0.05,         // must exceed mode baseline by 5 percentage points
    BEST_REQUIRE_CI_OVER_BASELINE: true, // Wilson lower bound must also clear baseline
    BEST_SMALL_SAMPLE_N: 30,
    WILSON_Z: 1.96,            // 95% confidence
  },
};
```

`TT_DB_PATH` is only used by the automated tests (to point at a temporary file). In normal use leave it unset.

**Security default:** the server listens on `127.0.0.1` (this machine only) and there is no CORS middleware, so the API cannot be reached from other devices on your network or from other websites. If you deliberately want LAN access, set `TT_HOST=0.0.0.0` — but understand that anyone on your network can then read and edit your journal (there is intentionally no authentication layer, since this is a single-user local app).

---

## How to back up the database

Your history lives in `data/trades.db`. Back it up regularly:

```bash
npm run backup
```

This uses **SQLite's online backup API** (`db.backup()`), which takes a consistent, WAL-aware snapshot, **verifies it** (integrity check + row count), and writes it to `backups/trades-backup-<timestamp>.db`.
(You can also run it with a custom path: `node scripts/backup.js --path ./my-backup.db`.)

To restore (stop the server first):

```bash
cp backups/trades-backup-<timestamp>.db data/trades.db
npm start
```

Keep copies of your backups somewhere else too (USB stick, cloud drive) — they are your insurance.

---

## Running the tests

```bash
npm test
```

71 tests, no extra dependencies beyond what the app already uses (Node's built-in test runner):

- **validation** — asset normalization, integer-cent conversion, formatting, all validation rules, **configured-timezone interpretation of naive timestamps**, stake/broker fields
- **analytics** — fixed-timestamp fixtures for bucketing (incl. a DST transition), Wilson reference values, minimum sample size, ROI, **strict strongest-window gating (30 trades + CI-over-baseline) vs. the old small-N behavior**, real/demo separation
- **import** — header alias mapping, call/put normalization, CSV parser (quotes/semicolons/CRLF), Excel files via exceljs, **broker-trade-ID duplicate detection**, ambiguous-column caveats
- **integration** — boots the real Express app on a temporary SQLite file: CRUD, filters, CSV export, **stable IDs across close/reopen (gaps never renumbered)**, restore-with-original-ID, strict analytics, concurrent-import dedupe, the **close-and-reopen persistence guarantee**

---

## Project structure

```
trade-timing-journal/
├── config.js            # Fixed timezone + currency + bind host + thresholds
├── time.js              # TZ-aware wall-clock <-> UTC helpers (shared by validation/import)
├── db.js                # SQLite init, WAL mode, schema_version migrations (v1 -> v2)
├── validation.js        # Server-side validation + cents/asset/timestamp handling
├── analytics.js         # Bucketing, Wilson intervals, expectancy/ROI, strongest-window logic
├── import.js            # CSV/XLSX parsing, column mapping, duplicate keys
├── server.js            # Express server + CRUD + filters/export/restore + analytics + static files
├── scripts/
│   └── backup.js        # Backup script (SQLite backup API + verification)
├── tests/
│   ├── validation.test.js
│   ├── analytics.test.js
│   ├── import.test.js
│   └── api.integration.test.js
├── data/
│   ├── trades.db        # ← YOUR persistent database (ignored by Git, never auto-deleted)
│   └── .gitkeep
├── backups/             # npm run backup writes timestamped copies here (ignored by Git)
├── public/
│   ├── index.html       # Page structure (tabs, journal, filters, dashboard, modals)
│   ├── styles.css       # All styling — plain CSS, responsive, no framework
│   ├── format.js        # Shared client-side money/percent formatting
│   ├── app.js           # Journal logic (form, filters, log, import, undo, export)
│   ├── dashboard.js     # Dashboard logic (KPIs, strongest windows, Chart.js)
│   └── vendor/chart.umd.js  # Chart.js vendored for offline use
├── package.json
├── .gitignore
└── README.md
```

---

## Statistical honesty checklist

- Real and demo data are **never silently combined** — separate series, separate baselines, separate strongest-window callouts.
- Win rates are always shown with **95% Wilson confidence intervals**.
- **Win rate = wins ÷ all trades** (breakevens in the denominator) — stated explicitly in the UI.
- **Expectancy stays visible**, and **ROI %** is shown when stakes exist, so position-sizing history doesn't masquerade as timing skill.
- Buckets below 3 trades show **"Not enough data yet"**, never an empty space.
- The strongest window is **never chosen by raw win rate** — only by **Wilson lower bound** after an explicit multiple-comparisons guard (≥30 trades, margin, CI-over-baseline).
- The UI says **"Strongest observed window"**, not "Best", and every callout carries a plain-English explanation of what the confidence interval means.
- Samples under 30 trades always carry an explicit small-sample caveat.
- No example results are hard-coded anywhere — every number on the dashboard is computed from your SQLite data.

---

## Security notes

- Default bind address is `127.0.0.1`; no CORS middleware. Set `TT_HOST=0.0.0.0` only if you accept that anyone on your network can access the API (there is no auth).
- Dependencies: `npm audit` reports **0 known vulnerabilities** (`xlsx` was replaced by `exceljs` + a built-in CSV parser).
- SQL is parameterized everywhere; every write path funnels through `validation.js`.

---

## Roadmap

- **Session 1 (DONE)** — Foundation + Persistent Backend: SQLite, migrations, WAL, CRUD API, validation, backup script.
- **Session 2 (DONE)** — Frontend + Trade Management: entry form, trade log, filters, edit/delete, timezone-correct timestamps.
- **Session 3 (DONE)** — Analytics + Dashboard: timezone-aware bucketing, Wilson intervals, expectancy, best-window logic for real AND demo, Chart.js dashboard, tests, documentation.
- **Audit round (DONE)** — configured-timezone manual entry, stable trade IDs (no renumbering), local-only bind + no open CORS, strict "strongest observed window" (≥30 + CI over baseline), `xlsx`→`exceljs`/CSV parser, SQLite backup API + verification, stake & ROI, broker-ID duplicate detection, mapping confirmation, journal filters + CSV export, bulk-delete preview + undo, win-rate definition + CI explainer, configurable currency, shared money formatting, README sync.

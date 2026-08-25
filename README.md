# Trade Timing Journal

A personal trading journal designed to determine — from **your actual historical trade data** — which **hours of the day** and **days of the week** produce the best results, without being misled by small samples, demo trades, raw win rates, or statistical uncertainty.

> **Core principle:** Every trade you save is written to a local **SQLite** file (`data/trades.db`) and **persists across restarts, weeks, and months**. Analytics are calculated from that accumulated history, with statistical honesty built in.

---

## What the application does

1. **Journal** — enter trades (asset, direction, outcome, P&L, real/demo, notes, timestamp), edit them, delete them, and filter the log by Real / Demo / Both. Everything reads from and writes to SQLite. The **sign of the P&L is derived from the outcome** (win = +, loss = −, breakeven = 0), so the money can never contradict the result label.
2. **Analytics Dashboard** — hourly and weekday statistics per mode:
   - trade count, win rate, **expectancy (average P&L)**, and a **95% Wilson confidence interval** for every bucket with enough data,
   - "Not enough data yet" for buckets with fewer than 3 trades — never a misleading blank,
   - **best-window callouts for BOTH real and demo trades** (demo is analysed against its own baseline and is never mixed into real statistics).
3. **Honest best-window selection** — a window qualifies only with **≥5 trades of that mode** and a win rate **more than 5 percentage points above that mode's baseline**, and the winner is ranked by the **lower bound of its Wilson interval**, never by raw win rate. Small samples are always flagged.

## Tech stack (as required)

- **Node.js + Express** — server & API
- **better-sqlite3 + SQLite** — persistent database (local file, WAL mode, migrations)
- **Plain HTML / Plain CSS / Vanilla JavaScript** — frontend (no frameworks)
- **Chart.js** — vendored locally (`public/vendor/chart.umd.js`), used only for the dashboard charts

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

You should see `added … packages` and `found 0 vulnerabilities`.
`better-sqlite3` v12 ships prebuilt binaries for Node 18/20/22/24, so no C++ build tools are needed.

### 3. Start the server

```bash
npm start
```

Expected output the first time:

```
[DB] Created new database file at .../data/trades.db
[DB] Applying migration v1: Create trades table
[DB] Migrations complete. New version: 1

✓ Trade Timing Journal running at http://localhost:3000
  Timezone (fixed): Africa/Lagos
  Database: .../data/trades.db (WAL mode, persistent)
```

On every later run you must see:

```
[DB] Opened existing database at .../data/trades.db
[DB] Current schema version: 1
[DB] No pending migrations. Database is up to date.
```

That proves the database was **not recreated or wiped**. Leave the terminal running.

### 4. Open the app

Go to `http://localhost:3000`. Two tabs:

- **Journal** — the trade form and trade log.
- **Analytics Dashboard** — KPIs, best-window callouts, hourly/weekday charts and tables.

---

## Database setup and persistence behavior

- The database is a single file: **`data/trades.db`**, created **only if it does not exist**.
- `db.js` opens it with **WAL mode** (`journal_mode=WAL`) and applies migrations recorded in a `schema_version` table. Running the server again is always safe — existing data is never touched.
- Trades are stored as:
  - `asset` — normalized uppercase with separators stripped (`btc/usdt` → `BTCUSDT`),
  - `pnl_cents` — **integer cents** (no floating-point money in the database),
  - `timestamp_utc` — ISO string in UTC,
  - `mode` — `real` or `demo` (always separate).
- Restarting the server, closing the browser, rebooting the machine — none of it deletes data.
- To **explicitly reset** (destroys your history!): stop the server, delete `data/trades.db`, `data/trades.db-wal`, `data/trades.db-shm`, then `npm start`.
- `data/trades.db` and `backups/*.db` are **ignored by Git** — your private trading history is never pushed to GitHub.

### Schema (v1)

```sql
CREATE TABLE trades (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset TEXT NOT NULL,                          -- normalized: uppercase, separators stripped
  direction TEXT NOT NULL CHECK(direction IN ('long','short')),
  outcome TEXT NOT NULL CHECK(outcome IN ('win','loss','breakeven')),
  pnl_cents INTEGER NOT NULL,                   -- integer cents, e.g. 12345 = 123.45
  mode TEXT NOT NULL CHECK(mode IN ('real','demo')),
  notes TEXT,
  timestamp_utc TEXT NOT NULL,                  -- ISO string in UTC
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
```

---

## API reference

| Method & path | Purpose |
|---|---|
| `GET /api/health` | Status: online, trade count, schema version, DB path, timezone |
| `GET /api/trades?mode=real\|demo\|all` | Trade log from SQLite, newest first |
| `POST /api/trades` | Create (validated server-side) |
| `GET /api/trades/:id` | One trade |
| `PUT /api/trades/:id` | Full update |
| `PATCH /api/trades/:id` | Partial update |
| `DELETE /api/trades/:id` | Delete |
| `GET /api/analytics` | Full dashboard analytics (see below) |
| `POST /api/import/preview` | Upload CSV/Excel (`multipart` field `file`); returns mapping, new/duplicate/invalid counts, and a preview |
| `POST /api/import/confirm` | `{ trades: [...] }` — inserts only validated new trades; skips duplicates |

Validation rules (server-side, returns `400` with a `details` array):

- asset required → normalized, ≤20 chars
- direction ∈ {long, short}; outcome ∈ {win, loss, breakeven}; mode ∈ {real, demo}
- amount must be a **finite number**, stored as integer cents; the **sign is derived from the outcome** (`win` → `+`, `loss` → `−`, `breakeven` → `0`), so entering a magnitude is enough and a conflicting sign is corrected
- timestamp must parse and be plausible (≥2000, ≤24h in the future)
- notes ≤2000 chars

### `GET /api/analytics`

Computed from SQLite on every request. Returns `{ timezone, generated_at, thresholds, real, demo }`.
The `real` and `demo` blocks each contain:

- `summary` — n, wins, win rate, Wilson 95% CI, total P&L, expectancy (cents), small-sample flag
- `hourly` — 24 buckets; `weekday` — 7 buckets. Each bucket: `n`, `wins`, `winRate`, `ciLower`, `ciUpper`, `expectancyCents`, `eligible` (n ≥ 3)
- `bestHour` / `bestWeekday` — `{ found, window | baselineWinRate, marginPct }`

---

## Analytics at a high level

All statistics live in `analytics.js` as pure, tested functions:

1. **Bucketing** — `bucketTimestamp(utcIso, timezone)`: UTC timestamp + the configured fixed timezone → `{ hour, weekday }`. The timezone comes from `config.js` (default `Africa/Lagos`), never from the server or browser clock.
2. **Wilson 95% confidence interval** — implemented directly (no statistics library). Every win rate is reported with its interval.
3. **Expectancy** — average P&L in integer cents, rounded only for display. Always shown next to win rate.
4. **Minimum sample size** — a bucket needs ≥3 trades to show statistics; below that the UI says **"Not enough data yet"**.
5. **Best window** — for **each mode separately** (real and demo), a bucket qualifies only if it has **≥5 trades of that mode** and its win rate **exceeds that mode's baseline by more than 5 percentage points**. The winner is the qualifying bucket with the **highest Wilson lower bound** (tie-break: more trades, then higher win rate). If nothing qualifies, the dashboard says so explicitly instead of pretending.
6. **Small samples** — anything under 30 trades is labelled as provisional.

Thresholds are configurable in `config.js` (`ANALYTICS` block).

---

## Configuration

Edit `config.js`:

```js
const CONFIG = {
  TIMEZONE: "Africa/Lagos",   // ← fixed IANA timezone used for all bucketing
  DB_PATH: process.env.TT_DB_PATH || "./data/trades.db", // ← persistent local file
  PORT: process.env.PORT || 3000,
  ANALYTICS: {
    MIN_N: 3,                  // min trades before a bucket shows statistics
    BEST_MIN_N: 5,             // min trades for best-window eligibility
    BEST_MARGIN: 0.05,         // must exceed mode baseline by 5 percentage points
    BEST_SMALL_SAMPLE_N: 30,   // below this N -> small-sample caveat
    WILSON_Z: 1.96,            // 95% confidence
  },
};
```

`TT_DB_PATH` is only used by the automated tests (to point at a temporary file). In normal use leave it unset.

---

## How to back up the database

Your history lives in `data/trades.db`. Back it up regularly:

```bash
npm run backup
```

This checkpoints the WAL and copies the database to `backups/trades-backup-<timestamp>.db`.
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

38 tests, no extra dependencies (Node's built-in test runner):

- **validation** — asset normalization, integer-cent conversion, formatting, all validation rules
- **analytics** — fixed-timestamp fixtures for bucketing (incl. a DST transition), Wilson reference values, minimum sample size, best-window logic (min-N, margin, Wilson-lower-bound ranking), real/demo separation, demo best-window
- **integration** — boots the real Express app on a temporary SQLite file: CRUD, filters, validation errors, the `/api/analytics` endpoint, and the **close-and-reopen persistence guarantee**

---

## Project structure

```
trade-timing-journal/
├── config.js            # Fixed timezone + DB path + validation/analytics thresholds
├── db.js                # SQLite init, WAL mode, schema_version migrations
├── validation.js        # Server-side validation + cents/asset/timestamp handling
├── analytics.js         # Bucketing, Wilson intervals, expectancy, best-window logic
├── server.js            # Express server + CRUD + /api/analytics + static files
├── scripts/
│   └── backup.js        # Backup script (WAL checkpoint + file copy)
├── tests/
│   ├── validation.test.js
│   ├── analytics.test.js
│   └── api.integration.test.js
├── data/
│   ├── trades.db        # ← YOUR persistent database (ignored by Git, never auto-deleted)
│   └── .gitkeep
├── backups/             # npm run backup writes timestamped copies here (ignored by Git)
├── public/
│   ├── index.html       # Page structure (tabs, journal, dashboard)
│   ├── styles.css       # All styling — plain CSS, responsive, no framework
│   ├── app.js           # Journal logic (form, log, filters, edit/delete)
│   ├── dashboard.js     # Dashboard logic (KPIs, best windows, Chart.js)
│   └── vendor/chart.umd.js  # Chart.js vendored for offline use
├── package.json
├── .gitignore
└── README.md
```

---

## Statistical honesty checklist

- Real and demo data are **never silently combined** — separate series, separate baselines, separate best windows.
- Win rates are always shown with **95% Wilson confidence intervals**.
- **Expectancy stays visible** — a high win rate does not mean profitable.
- Buckets below 3 trades show **"Not enough data yet"**, never an empty space.
- The best window is never chosen by raw win rate — only by **Wilson lower bound** after minimum-N and baseline-margin filters.
- Samples under 30 trades always carry an explicit small-sample caveat.
- No example results are hard-coded anywhere — every number on the dashboard is computed from your SQLite data.

---

## Final delivery — pushing to GitHub (VS Code)

1. **Get the latest code** (if you have a local copy from an earlier session):

   ```bash
   git fetch origin
   git pull origin arena/01a0240f-trade-timing-journal
   ```

2. Or **download the ZIP**: on GitHub, switch the branch dropdown to `arena/01a0240f-trade-timing-journal` → `Code → Download ZIP`.

3. **Install & verify locally:**

   ```bash
   npm install
   npm test
   npm start
   ```

4. **Merge into `main` on GitHub** (recommended — no command line needed):
   - On your repo page, open the **Pull requests** tab → **New pull request**.
   - Base: `main` ← Compare: `arena/01a0240f-trade-timing-journal` → **Create pull request** → **Merge pull request** → **Confirm merge**.
   - Your `main` branch now has the complete app.

5. **Or commit your own local changes from VS Code**: `View → Source Control` → stage all → message like `Session 3 – analytics dashboard` → **✓ Commit** → `… → Push`.

6. **Check the repo does NOT contain**: `data/trades.db`, any `backups/*.db` file, `node_modules/`. (`.gitignore` handles all of them.)

---

## Roadmap

- **Session 1 (DONE)** — Foundation + Persistent Backend: SQLite, migrations, WAL, CRUD API, validation, backup script.
- **Session 2 (DONE)** — Frontend + Trade Management: entry form, trade log, filters, edit/delete, timezone-correct timestamps.
- **Session 3 (DONE)** — Analytics + Dashboard: timezone-aware bucketing, Wilson intervals, expectancy, best-window logic for real AND demo, Chart.js dashboard, tests, documentation.

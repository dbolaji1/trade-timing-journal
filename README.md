# Trade Timing Journal

A personal trading journal designed to determine — from **your actual historical trade data** — which **hours of the day** and **days of the week** produce the best results, without being misled by small samples, demo trades, or raw win rates.

> **Core principle:** Every trade you save is written to a local **SQLite** file (`data/trades.db`) and **persists across restarts, weeks, and months**. Analytics are calculated from the accumulated history, with statistical honesty built in.

---

## Tech Stack (as required)

- **Node.js + Express** — server & API
- **better-sqlite3 + SQLite** — persistent database (local file, WAL mode)
- **Plain HTML / Plain CSS / Vanilla JavaScript** — frontend (no frameworks)
- **Chart.js** — charts only where they genuinely help (Sessions 2–3)

No React, TypeScript, MongoDB, PostgreSQL, Tailwind, auth, or cloud services.

---

## Current Status — Session 1 Complete ✅

**Session 1 — Foundation + Persistent Backend** is finished.

What works right now:

- ✅ Node.js project + `package.json`
- ✅ SQLite file at `data/trades.db` (created only if it doesn't exist)
- ✅ WAL mode (`journal_mode=WAL`) for durability
- ✅ `schema_version` table + simple migrations (safe to re-run on every start)
- ✅ `trades` table with proper constraints
- ✅ Express server on `http://localhost:3000`
- ✅ Full CRUD API (`GET / POST / PUT / PATCH / DELETE /api/trades`)
- ✅ Server-side validation (finite numbers, allowed enums, timestamps, plausible dates)
- ✅ Money stored as **integer cents** (`pnl_cents`) — never floating point in DB
- ✅ Asset normalization (`btc/usdt` → `BTCUSDT`)
- ✅ Timestamps stored as **UTC** (`timestamp_utc` ISO string), bucketed later in **fixed timezone `Africa/Lagos`** (from `config.js`)
- ✅ Backup script (`npm run backup`)
- ✅ Minimal frontend at `public/index.html` to verify persistence

### Project Structure

```
trade-timing-journal/
├── config.js           # Fixed timezone (Africa/Lagos) + DB_PATH + port
├── db.js               # SQLite init, WAL, migrations, schema_version
├── validation.js       # Pure validation + normalizeAsset + toCents/formatCents
├── server.js           # Express server + CRUD API + static serving
├── scripts/
│   └── backup.js       # Tiny backup script (WAL checkpoint + copy)
├── data/
│   ├── trades.db       # ← YOUR persistent database (never deleted on restart)
│   ├── trades.db-wal   # WAL file (SQLite internal)
│   ├── trades.db-shm   # shared memory file
│   └── .gitkeep        # keeps folder in git when DB is ignored
├── backups/
│   └── .gitkeep
├── public/
│   └── index.html      # Session 1 verification UI (form + log + filters)
├── package.json
├── .gitignore
└── README.md
```

### Database Schema (v1)

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
CREATE TABLE schema_version (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
```

---

## How to Run — Session 1

### Prerequisites

- **Node.js** 18+ installed ([nodejs.org](https://nodejs.org))
- **VS Code** (with integrated Terminal)

### 1. Open the project in VS Code

1. Open VS Code
2. `File → Open Folder…` → select the `trade-timing-journal` folder
3. Open the Terminal: `View → Terminal` (or `` Ctrl+` ``)

### 2. Install dependencies

In the VS Code Terminal (ensure you're in the project root where `package.json` lives):

```bash
npm install
```

You should see `added 106 packages` and `found 0 vulnerabilities`.

### 3. Start the server

```bash
npm start
```

Expected output:

```
[DB] Created new database file at /home/user/data/trades.db   # first run only
[DB] Current schema version: 0
[DB] Applying migration v1: Create trades table
[DB] Migrations complete. New version: 1

✓ Trade Timing Journal running at http://localhost:3000
  Timezone (fixed): Africa/Lagos
  Database: /home/user/data/trades.db (WAL mode, persistent)
  Health: http://localhost:3000/api/health
```

On later runs you’ll see:

```
[DB] Opened existing database at /home/user/data/trades.db
[DB] Current schema version: 1
[DB] No pending migrations. Database is up to date.
```

That proves the DB **was not recreated or wiped**.

### 4. Open the app

Open your browser to:

```
http://localhost:3000
```

You’ll see the Session 1 verification UI with:
- Trade entry form
- Trade log
- Real/Demo/Both filter
- Edit/Delete
- Health check

### 5. Verify Persistence (the critical test)

1. In the browser, fill the form: `Asset: BTC/USDT`, `Direction: long`, `Outcome: win`, `Amount: 42.50`, `Mode: real`, leave timestamp auto-filled, click **Save Trade → SQLite**
2. See “✓ Saved trade #X” and the new row in the log below
3. **Stop the server** in VS Code Terminal: press `Ctrl+C`
4. **Restart**: `npm start`
5. **Reload** `http://localhost:3000` in the browser
6. ✅ The trade you just created is **still there**. Check via API too:

```bash
curl http://localhost:3000/api/trades | head
# or
curl http://localhost:3000/api/health
```

If you see `trade_count: 1` (or more) after restart, persistence works.

---

## API Reference (Session 1)

All trades are JSON. Money is stored as `pnl_cents` (integer) and returned as both `pnl_cents` and formatted `pnl_formatted`/`amount`.

### `GET /api/health`

```json
{
  "status": "ok",
  "timezone": "Africa/Lagos",
  "db_path": "/home/user/data/trades.db",
  "trade_count": 3,
  "schema_version": 1
}
```

### `GET /api/config`

```json
{ "timezone": "Africa/Lagos" }
```

### `GET /api/trades?mode=real|demo|all`

Returns array of trades, newest first. Example:

```json
{
  "id": 1,
  "asset": "BTCUSDT",
  "direction": "long",
  "outcome": "win",
  "pnl_cents": 9999,
  "pnl_formatted": "99.99",
  "amount": 99.99,
  "mode": "real",
  "notes": "patched note",
  "timestamp_utc": "2024-03-15T10:30:00.000Z",
  "created_at": "2026-08-19T11:14:14.647Z",
  "updated_at": "2026-08-19T11:14:43.425Z"
}
```

### `POST /api/trades`

Required fields: `asset`, `direction` (`long`|`short`), `outcome` (`win`|`loss`|`breakeven`), `amount` (finite number), `mode` (`real`|`demo`), `timestamp` (parseable date).

Optional: `notes` (≤2000 chars), `timestamp_utc` alternative to `timestamp`.

Normalization & conversion happens server-side:
- `asset`: `"btc/usdt"` → `"BTCUSDT"`
- `amount`: `123.45` → `pnl_cents: 12345`
- `timestamp`: any parseable date → `timestamp_utc` ISO in UTC

Validation errors return `400` with `details`:

```json
{ "error": "Validation failed.", "details": ["Direction must be one of: long, short."] }
```

### `GET /api/trades/:id` · `PUT /api/trades/:id` · `PATCH /api/trades/:id` · `DELETE /api/trades/:id`

Full update (`PUT`) requires all fields; partial (`PATCH`) allows subset.

---

## Backup

The DB file **is your history**. It survives restarts unless you delete it.

To back up (while server is running is okay, but stopping first is perfect):

```bash
npm run backup
# or
node scripts/backup.js
# custom path:
node scripts/backup.js --path ./my-backup.db
```

Output:

```
[Backup] WAL checkpoint completed.
✓ Backup complete!
  Source: /home/user/data/trades.db (28.0 KB)
  Backup: /home/user/backups/trades-backup-2026-08-19T11-14-43-382Z.db (28.0 KB)
```

To restore (stop the server first!):

```bash
cp backups/trades-backup-2026-08-19T11-14-43-382Z.db data/trades.db
npm start
```

---

## Configuration

Edit `config.js`:

```js
const CONFIG = {
  TIMEZONE: "Africa/Lagos",   // ← change to your IANA timezone if needed
  DB_PATH: "./data/trades.db",// ← local persistent file
  PORT: process.env.PORT || 3000,
};
```

- **Timezone** is explicit and fixed. Every future analytics bucket (Session 3) will use `UTC timestamp + TIMEZONE → bucket` as a pure, testable function. It is **not** inferred from the browser or server.
- **Timestamps** are stored as UTC (`toISOString()`), displayed/bucketed in `TIMEZONE`.

---

## Data Persistence Guarantee

- `data/trades.db` is created **only if it doesn't exist**.
- `db.js` checks `fs.existsSync` before opening, then runs migrations incrementally via `schema_version`.
- WAL mode is set via `db.pragma("journal_mode = WAL")` and persisted in the file.
- Restarting `node server.js` **never** deletes or clears the DB.
- To explicitly reset (dangerous - deletes history): `rm data/trades.db data/trades.db-wal data/trades.db-shm` then `npm start`.

This satisfies: *"Create trade → save → close browser/server → reopen days later → trade still exists."*

---

## How to Commit to GitHub (via VS Code)

1. In VS Code, open **Source Control** (left sidebar icon or `Ctrl+Shift+G`)
2. If not yet initialized: `Initialize Repository` → then add remote:
   - Open Terminal: `git remote add origin https://github.com/YOUR_USERNAME/trade-timing-journal.git`
   - (Create empty repo on github.com first, no README)
3. Stage: click `+` next to files, or `… → Commit`
4. Message: `Session 1 – persistent backend with SQLite`
5. `Commit` → `Push` (or `Publish Branch`)
6. **Note:** `.gitignore` ignores `data/*.db` so your personal trades won't be pushed publicly. The folder structure (`data/.gitkeep`) is pushed. For private backups, keep your `backups/` folder local or in a private repo.

---

## Roadmap

- **Session 1 (DONE)** — Foundation + Persistent Backend (you are here)
- **Session 2 (NEXT)** — Complete frontend: entry experience, log with filters, edit/delete, API integration, styling, persistent retrieval
- **Session 3** — Analytics + Dashboard: timezone-aware bucketing, Wilson intervals, expectancy, best-window logic (real-only, N≥5, baseline+margin, Wilson lower-bound ranking), Charts, caveats, README finalization

---

## Testing Checklist — Session 1

Run through these before marking Session 1 done:

- [ ] `npm install` succeeds
- [ ] `npm start` creates `data/trades.db` only on first run
- [ ] `curl http://localhost:3000/api/health` returns `status: ok`, `timezone: Africa/Lagos`
- [ ] `POST /api/trades` with `btc/usdt` stores as `BTCUSDT`
- [ ] `POST /api/trades` with `amount: 0.1` stores `pnl_cents: 10`
- [ ] `POST /api/trades` with invalid `direction` returns `400` with useful `details`
- [ ] `GET /api/trades?mode=real` vs `?mode=demo` are separate (never mixed)
- [ ] `PUT` / `PATCH` / `DELETE` work and persist
- [ ] **Persistence test:** create → `Ctrl+C` → `npm start` → `GET /api/trades` still shows the trade
- [ ] `npm run backup` creates timestamped file in `backups/`
- [ ] Restarting server logs `Opened existing database` and `No pending migrations`
- [ ] `data/trades.db` survives across restarts (check `ls -lh data/`)

---

*Built for honest statistics: integer cents, UTC storage, fixed timezone, server validation, real/demo separation, and persistence by design.*

# Cracked Oura — Codebase Index & Audit

Audit date: 2026-09-11. Audited commit: `db254b2` (upstream `EIrno/Cracked-Oura`, 9 commits, v0.1.0 released 2026-02-07, 405 stars, 52 forks, no license file).

Every source file was read in full. Static checks run: `pyflakes`/`flake8` on the backend, `tsc -b`, `eslint`, `vite build` on the frontend, plus two repro scripts (logging config, route shadowing). Upstream issues #1–#19 and PRs #2, #10, #14, #17, #18 and the downstream fork `pipiche38/Cracked-Oura#1` were reviewed.

---

## 1. What it is

An Electron desktop app that lets Oura Ring owners see their historical ring data without paying for the Oura membership. Data comes from Oura's GDPR data export (a ZIP of CSVs downloaded from `membership.ouraring.com/data-export`), either uploaded manually or fetched by a Playwright robot that logs into the membership site with the user's email + one-time code. The CSVs are ingested into a local SQLite database, served by a FastAPI backend on `localhost:8000`, and displayed in a React dashboard with user-configurable drag-and-drop widgets. An experimental "AI Health Analyst" runs a LangChain SQL agent against the database using a local Ollama model.

```
Oura membership site ──(Playwright robot or manual upload)──► ZIP of CSVs
        │
        ▼
backend/src/ingestion  (pandas, hand-rolled CSV splitter) ──► SQLite (SQLAlchemy models)
        │
        ▼
backend/src/api  (FastAPI: /api/days/{date}, /api/query, /api/schema, /api/dashboard, /api/automation/*, /api/advisor/chat)
        │
        ▼
frontend/src  (React 19 + Vite + Tailwind + shadcn/ui + Chart.js + react-grid-layout)
        │
        ▼
frontend/electron/main.ts  (spawns the PyInstaller-bundled backend, tray icon, single window)
```

## 2. File index

### Root
| File | Purpose |
|---|---|
| `README.md` | Marketing + install + build instructions. Build instructions are incomplete (see §4). |
| `.gitignore` | Ignores `dist/`, `build/`, `*.db`, `oura_session.json`, `oura_dashboard.json` — yet `oura_dashboard.json` and `frontend/dist-electron/` are committed. |
| `oura_dashboard.json` | The author's personal dashboard config (2 dashboards, 13 widgets, with leftover "New Widget" entries). Not read by any code; usable via Settings → Import Layout. Undocumented. |

### backend/
| File | Lines | Purpose |
|---|---|---|
| `requirements.txt` | 17 | Unpinned deps. Includes dev tools and unused packages (`httpx`, `requests`, `faiss-cpu`, `langchain-experimental`). Missing `pyinstaller`, which the build script needs. |
| `pyproject.toml` | 7 | black + pytest config pointing at a `tests/` dir that doesn't exist. |
| `build.spec` | 62 | PyInstaller spec: bundles `src/api/main.py` as `backend` (onedir), maps `src` → `backend/src`. |
| `src/paths.py` | 39 | Platform user-data dir (`~/Library/Application Support/CrackedOura` etc.). |
| `src/config.py` | 126 | `ConfigManager`: two JSON files (`oura_config.json` for email/schedule/status/LLM host, `oura_dashboard.json` for layouts) with atomic writes and a lock. |
| `src/database.py` | 72 | SQLAlchemy engine on `<userdata>/oura_database.db`, `get_db` dependency, write-permission self-test. |
| `src/models.py` | 200 | 14 tables: `sleep`, `activity`, `readiness`, `resilience`, `sleep_session`, `workout`, `meditation`, `heart_rate`, `temperature`, `ring_battery`, `ring_configuration`, `tag`, `cardiovascular_age`. JSON columns hold contributors and time series. |
| `src/ingestion/base.py` | 286 | `IngestionBase`: hand-rolled `;`-split CSV reader, SQLite upsert, parsers for dates/JSON/sequences. |
| `src/ingestion/manager.py` | 148 | `OuraParser`: extracts ZIP, finds the CSV folder, merges related CSVs (dailysleep+sleeptime+dailyspo2; dailyreadiness+dailystress), dispatches to processors. |
| `src/ingestion/processors/{sleep,activity,readiness,common}.py` | 120/158/71/114 | Row → ORM mapping per domain. |
| `src/automation.py` | 507 | `OuraAutomator`: Playwright login (email → OTP), storage-state persistence, request export, poll, download. Installs Chromium at runtime into the user data dir. |
| `src/llm.py` | 111 | `DataAnalyst`: LangChain `create_sql_agent` over Ollama. |
| `src/api/main.py` | 413 | FastAPI app, CORS, lifespan, a second set of automation endpoints, a 60-second scheduler loop, static mount, uvicorn entry. |
| `src/api/routes.py` | 546 | Router: chat, automation (start-login/submit-otp/request-export/check-status/download/clear-session), settings, dashboard config, `/api/days/{date}`, `/api/query`, `/api/schema`, `/api/ingest/zip`. |
| `src/api/schemas.py` | 225 | Pydantic response models (`DayDataResponse` etc.). |

### frontend/
| File | Lines | Purpose |
|---|---|---|
| `package.json` | 92 | Scripts (`dev`, `build`, `build:backend`), electron-builder config, deps. |
| `electron/main.ts` | 264 | Main process: spawn backend (venv python in dev, bundled exe in prod), window, tray, log to `~/Documents`. `nodeIntegration: true`, `contextIsolation: false`. |
| `dist-electron/main.js` | 243 | Committed compiled output of `main.ts` (verified in sync). |
| `vite.config.ts` | 23 | `base: './'`, `@` alias, `/api` proxy (unused because the app hardcodes `localhost:8000`). |
| `src/main.tsx`, `src/App.tsx` | 14/161 | Entry; wires context, layout, grid, panels, chat. |
| `src/contexts/DashboardContext.tsx` | 280 | All UI state: dashboards, active dashboard, layout, widget editing, selected date, day data. |
| `src/hooks/useDashboardPersistence.ts` | 58 | Load/save dashboards via `/api/dashboard`, 10 retries on startup. |
| `src/hooks/useOuraData.ts` | 108 | Fetch `/api/days/{date}` (+ a 365-day score history that nothing consumes). |
| `src/hooks/useMultiOuraQuery.ts` / `useOuraQuery.ts` | 70/36 | Fetch `/api/query` for one or many paths, merge by date. |
| `src/hooks/useChat.ts` | 68 | Chat state in `localStorage`. |
| `src/lib/api.ts` | 146 | Fetch wrapper. `BASE_URL` hardcoded. |
| `src/lib/data-processing.ts` | 347 | Daily gap-filling, intraday resampling (max 2000 points), week/month/year aggregation. |
| `src/lib/utils.ts` | 23 | `cn()` and `isIntradayKey()` (substring heuristic). |
| `src/lib/layoutUtils.ts` | 52 | Legacy row-layout → grid converter (unused). |
| `src/components/WidgetRegistry.tsx` | 142 | Maps widget `type` → component; resolves dotted data paths against the day payload. |
| `src/components/dashboard/DashboardGrid.tsx` | 151 | react-grid-layout in edit mode, plain CSS grid in view mode. |
| `src/components/dashboard/WidgetEditorPanel.tsx` | 349 | Right panel to edit title/type/data keys/color. |
| `src/components/dashboard/DataFieldSelector.tsx` | 284 | Tree of `/api/schema` fields with JSON hints for contributors. |
| `src/components/dashboard/DateRangeSelector.tsx` | 337 | Per-widget range popover (`30d`, `today`, `selection`, calendar). |
| `src/components/dashboard/SettingsPanel.tsx` | 453 | Automation/login/OTP/export/upload + layout import/export. |
| `src/components/dashboard/ChatPage.tsx`, `ChatPanel.tsx`, `ThoughtsDisplay.tsx` | 179/135/109 | AI chat UI. |
| `src/components/widgets/*` | 20–236 each | ScoreGauge (doughnut), TrendChart (line, multi-series), Bar, Radar, Table, Metric, JSON viewer, SmartTrend (range → query → normalize → chart). |
| `src/components/ui/*` | 1039 total | Stock shadcn/ui primitives. |
| `src/components/layout/MainLayout.tsx`, `AppSidebar.tsx` | 159/208 | Shell: sidebar with dashboards + AI Chat link, header with date nav, theme toggle, Ask AI. |

## 3. Overall quality assessment

**Idea and architecture: good.** Local-first SQLite, a generic `/api/query` path syntax (`domain.field` or `domain.jsoncol.key`) that powers arbitrary widgets, a schema endpoint that drives the field picker, an ORM upsert layer, and a tidy shadcn UI. The widget grid, per-widget date ranges, and auto-aggregation for long ranges are genuinely nice.

**Execution: alpha, and currently broken end-to-end for new users.** The three things the app exists to do all fail on a fresh install today:

1. `npm install` fails on a clean clone (peer-dependency conflict), so it cannot even be built without `--legacy-peer-deps`.
2. Automated login no longer works against Oura's current login page (three open issues, two open PRs).
3. Ingestion of a current Oura export imports nothing because the file names and delimiter changed (issue #9: "ingestion successful… database is still empty").
4. The AI analyst points at the wrong database file, so it can never see the user's data.

Code hygiene is weak: no tests, no CI, no lint gate (100 ESLint errors, 40+ flake8 findings), duplicated endpoints, two incompatible status models, dead code, unpinned dependencies, and a compiled build artifact committed. Security posture is poor for a "privacy first" app (any website can read the health data from `localhost:8000` via CORS `*`, and the Electron renderer runs with Node integration).

## 4. Bugs and issues

Severity: **P0** = blocks core use for everyone; **P1** = wrong behaviour or data users will hit; **P2** = robustness/security/maintainability; **P3** = cosmetic/hygiene.

### Build & install
| # | Sev | Where | Problem |
|---|---|---|---|
| B1 | P0 | `frontend/package.json` | `react-day-picker@^8.10.1` caps peer `react` at 18; project uses React 19 → `npm install` ERESOLVE on a clean clone (verified). Upstream PR #17 fixes by upgrading to v9. |
| B2 | P0 | `backend/requirements.txt`, `package.json` `build:backend` | `pyinstaller` is not in requirements, so `npm run build` fails at `python -m PyInstaller`. |
| B3 | P1 | `requirements.txt` | Nothing is pinned. Fresh installs pull `langchain` 1.x and `pandas` 3.x; the legacy `zero-shot-react-description` SQL agent path used in `llm.py` is not guaranteed to exist on LangChain ≥1.0. |
| B4 | P1 | `package.json` scripts | `./venv/bin/python` and `echo '{...}' > file` are POSIX-only; Windows build broken (issue #5). |
| B5 | P2 | repo | `frontend/dist-electron/main.js` (compiled) and `oura_dashboard.json` are committed despite `.gitignore`. No `LICENSE` file, so the "open-source" claim is legally "all rights reserved". |
| B6 | P2 | `README.md` | Build docs omit PyInstaller, Playwright browser install, Ollama requirement, and the fact that the Chromium download (~150 MB) happens at first automation run. |
| B7 | P3 | `package.json` | Unused deps: `recharts`, `react-is`, `@radix-ui/react-separator`. Backend: `httpx`, `requests`, `faiss-cpu`, `langchain-experimental` unused. |

### Ingestion (backend/src/ingestion)
| # | Sev | Where | Problem |
|---|---|---|---|
| I1 | P0 | `manager.py` | Looks for exact file names (`dailysleep.csv`, `sleepmodel.csv`, `enhancedtag.csv` …). Current Oura exports use date-suffixed names (e.g. `dailysleep_2024-01-01_2024-12-31.csv`) and renamed files (`sleep.csv`, `tag.csv`, new `vo2max.csv`). Result: nothing imports, status still says "Ingestion successful" (issue #9, fixed downstream in pipiche38#1). |
| I2 | P0 | `base.py::_read_csv_robust` | Hardcodes `;` as delimiter; current exports are reported comma-delimited. Splits with `str.split(';')`, so any quoted field containing the delimiter (tag comments, `day_summary`, JSON) shifts every column after it. Multi-line quoted fields break `readlines()`. |
| I3 | P1 | `manager.py::parse_zip` | Walk stops at the first directory containing `dailysleep.csv`/`dailyactivity.csv`; with suffixed names it never matches and parses the temp root, finding nothing. |
| I4 | P1 | `activity.py::process_activity` | `average_met` is populated from `average_met_minutes` (different metric). |
| I5 | P1 | `activity.py::process_stress` | Assumes columns `timestamp`, `stress_value`, `recovery_value` without checking; a missing column raises `KeyError` outside the try and aborts the whole import. One SELECT per day. |
| I6 | P1 | `common.py` | `process_ring_battery`, `process_tag`, `process_ring_configuration` swallow all exceptions with bare `except: pass`, so a schema change silently imports zero rows. `HeartRate` upsert on `timestamp` alone drops samples when two sources share a timestamp. |
| I7 | P2 | `base.py::_parse_sequence_to_timestamped_list` | Falls back to `ast.literal_eval` on untrusted CSV content (safe-ish but slow) and to "every digit is a phase" for any non-JSON string, which turns e.g. `"2024"` into four fake samples. |
| I8 | P2 | `base.py::_upsert` | `ON CONFLICT(day) DO UPDATE` also overwrites `id`; if the incoming `id` collides with another row's primary key the batch fails with IntegrityError and the exception is re-raised, aborting the import. |
| I9 | P2 | `sleep.py` | `low_battery_alert` parsing uses `row.get(...)` truthiness so the string `"0"`/`"false"` becomes `True`. Time zones: `bedtime_start` is stored without offset while derived `hr_data` timestamps keep the offset, so the two disagree by the user's UTC offset. |
| I10 | P2 | `routes.py::ingest_zip` | Blocking pandas work inside an `async def` handler freezes the whole API (and the scheduler) for the duration of an import. Temp file is not removed on failure. |

### Automation (backend/src/automation.py, main.py, routes.py)
| # | Sev | Where | Problem |
|---|---|---|---|
| A1 | P0 | `_check_otp_screen` | Oura's login now shows "Use passkey" and "Email me a code", both `button[name='selectedId']`; the locator hits Playwright strict mode and throws (issues #12/#15, PRs #10/#18). |
| A2 | P0 | `_wait_for_processing` | Treats "Request button enabled" as "export ready". The button stays enabled after clicking, so it returns immediately, then `_download_file` finds no download button and the sync fails (PR #18 log excerpt). |
| A3 | P0 | `routes.py::download_export` | `download_existing_export` returns `{"status": "otp_required"}` when not logged in; the handler only checks `status == "error"`, passes the dict to `zipfile` → `'dict' object has no attribute 'seek'` (issue #15 verbatim). |
| A4 | P1 | `login()` | Returns `None` when already logged in; `SettingsPanel` reads `data.message` → renderer error, and then unconditionally sets status `otp_needed`, so a logged-in user is asked for an OTP. |
| A5 | P1 | `_is_logged_in` | Only accepts the exact origin URL; any post-login landing path (`/home`, locale prefixes) reads as "not logged in" → "Login failed (Unknown state)" (issue #15). |
| A6 | P1 | `submit_otp` | Invalid-code detection hardcodes the Finnish string "Virheellinen koodi" and English "Invalid code" only. |
| A7 | P1 | `main.py` vs `routes.py` | `/api/automation/submit-otp` and `/api/automation/clear-session` are defined twice. The router is included first, so the `main.py` versions (with the `action` field that resumes a run/download after OTP) are unreachable dead code (verified with a TestClient repro). The frontend calls the router version, so after OTP nothing resumes. |
| A8 | P1 | `main.py::background_worker` | Scheduler fires only when `now.hour == sh and now.minute == sm` on a loop that sleeps 60 s **after** awaiting the (hours-long) ingestion task; a drift past the minute skips the day. It also rewrites the config file (two fsyncs) every minute forever. |
| A9 | P1 | `background_worker` "Waiting" branch | While status contains "Waiting", every 5 minutes it re-runs the full login, which re-submits the email form and either errors ("Could not find email input") or triggers a fresh OTP email, invalidating the code the user is about to type. |
| A10 | P1 | `__init__` | Session cookies are saved to `os.getcwd()/oura_session.json`. In production the cwd is inside the app bundle (`Cracked Oura.app/Contents/Resources/backend`), which is read-only or breaks signing; in dev it lands in the repo. Should be the user data dir. |
| A11 | P2 | `main.py::run_automation`, `test_login` | Browser launch (and possibly the 150 MB Chromium download) happens inside the HTTP request; `headless` default differs (`False` here, `True` elsewhere). |
| A12 | P2 | global `automator` | One shared Playwright page is used concurrently by the scheduler, the router endpoints and the `main.py` endpoints with no lock; overlapping runs corrupt each other. |
| A13 | P2 | logging | Email and the OTP code are logged in plain text (`Received OTP: …`, `Submitting OTP: …`). |
| A14 | P2 | `_ensure_browser_installed` | Uses Playwright private API `playwright._impl._driver`; "installed" is inferred from "directory is non-empty", so a partial download is never repaired unless launch fails. |

### API & backend runtime
| # | Sev | Where | Problem |
|---|---|---|---|
| S1 | P0 | `llm.py` | `db_path` is `backend/oura_database.db` (relative to the source tree), not the real DB in the user data dir. `SQLDatabase.from_uri` creates an empty file, so the AI analyst always sees zero tables/rows. |
| S2 | P1 | `routes.py::chat` | Runs the synchronous LangChain agent inside `async def` → the event loop is blocked for the entire LLM run (minutes); every other request and the scheduler stall. |
| S3 | P1 | `llm.py` | Conversation history is received but ignored (only the last message is sent), so follow-up questions have no context. A new agent + DB connection is built per request. Streaming callback prints to stdout only. |
| S4 | P1 | `main.py` logging | `logging.basicConfig(handlers=[FileHandler…])` runs after `config.py` already called `basicConfig`, so it is a no-op (verified: file created, 0 bytes). `backend_debug.log` is never written; the "Logging to …" line is false. |
| S5 | P1 | `config.py` | `get_config()` merges the dashboard file into every status response, so `/api/automation/check-status` (polled every 5 s) returns the entire dashboard config + email each time. `update_config` skips `None`, so a value can never be cleared. |
| S6 | P2 | `main.py` CORS | `allow_origins=["*"]` with no auth: any web page open in any browser on the machine can read `http://localhost:8000/api/days/...` (all health data), trigger logins, or upload data. Dev entrypoint binds `0.0.0.0` (LAN-exposed). |
| S7 | P2 | `routes.py::query_data` | `hasattr(model, field)` accepts any attribute (`metadata`, `registry`, `__table__`) → 500 with a stack trace; `field` is lower-cased but JSON keys are not. |
| S8 | P2 | `schemas.py` | `SleepResponse.timestamp` has no ORM counterpart; `breathing_disturbance_index` typed float vs int. `/api/days` fetches HR/temperature with `include_details` but the UI JSON widget is the only consumer. |
| S9 | P2 | `paths.py` | On Windows, `Path(os.getenv("APPDATA"))` raises if unset; `database.py` crash handler writes to `~/Documents`, which may not exist on Linux. |
| S10 | P3 | multiple | 5 modules call `logging.basicConfig`; many unused imports; bare `except:` in 15 places (flake8 output). |

### Frontend
| # | Sev | Where | Problem |
|---|---|---|---|
| F1 | P0 | `SettingsPanel.tsx::pollStatus` | Expects `status` values `completed`/`ready_to_download`/`error`; the backend emits `Idle`/`Processing`/`Error`/`Waiting for OTP...`. The poll never resolves, `loading` stays `true`, all buttons stay disabled, the interval leaks after unmount. |
| F2 | P1 | `SettingsPanel.tsx` | Local status machine ignores backend state: reopening the panel resets to `idle` (shows login even when logged in); `handleSubmitOtp` sets `logged_in` even when the backend returned `{status:"error"}` with HTTP 200. |
| F3 | P1 | `lib/utils.ts::isIntradayKey` | `includes('met')` matches `high_activity_met_minutes`, `sedentary_met_minutes`, `meters_to_target`, `target_meters` → those daily fields are locked to a single day and cannot be trended. `includes('stress')` also catches `readiness.stress_high`. |
| F4 | P1 | `SmartTrendWidgetCanvas.tsx` | `new Date('yyyy-MM-dd')` parses as UTC midnight, then `format()` renders in local time → for users west of UTC every "relative to selection" range ends one day early. `today` is computed in UTC. |
| F5 | P1 | `useDashboardPersistence.ts` + `DashboardContext.tsx` | If the backend is not up within 10 s, the app proceeds with an empty default dashboard; the first edit then `POST`s that empty state and overwrites the user's saved layouts. |
| F6 | P1 | `WidgetRegistry.tsx` metric | `sleep.total_sleep_duration` (offered in the editor) does not exist on the day payload → always "0h 0m". Duration math assumes minutes, but `sleep_session.*_duration` are seconds. |
| F7 | P1 | `TableWidget.tsx` | `restless_periods` (a count) and anything containing `awake` is formatted as a duration; `k === 'total'` guesses. |
| F8 | P1 | `ThoughtsDisplay.tsx` | Looks for tools named `run_sql`/`run_python`; the SQL agent's tools are `sql_db_query` etc., so the "SQL Query Executed" preview never appears. |
| F9 | P2 | `DashboardContext.tsx::saveEditingWidget` | Ignores the widget payload passed by `WidgetEditorPanel.handleSave`; only incremental `onChange` updates survive. If it were honoured it would clobber `relative` date ranges (drops `value/unit/anchor`). |
| F10 | P2 | `DateRangeSelector.tsx` / `SmartTrend` | Units `weeks`, `months`, `hours`, `minutes` exist in the type and the parser but `SmartTrend` only handles `days`/`years` → empty chart. `a` is accepted as "years". |
| F11 | P2 | `api.ts`, `JSONWidget.tsx` | `BASE_URL` hardcoded to `http://localhost:8000` (and duplicated raw in JSONWidget); the Vite proxy is dead; no timeout/abort on any fetch. |
| F12 | P2 | `useOuraData.ts` | Fetches a full year of three score series on every date change and stores it as `history`, which no component reads. |
| F13 | P2 | `DashboardGrid.tsx` | Widgets without a matching layout entry render nothing (silent). New widgets are inserted with `y: Infinity`. Duplicate JSX for edit/view modes. |
| F14 | P2 | `useChat.ts` | History is sent but the backend ignores it; assistant error message is generic. |
| F15 | P3 | ESLint | 100 errors (`no-explicit-any` ×90, `set-state-in-effect`, `no-empty`, missing deps). |

### Electron
| # | Sev | Where | Problem |
|---|---|---|---|
| E1 | P1 | `main.ts::app.on('activate')` | `mainWindow` is declared without an initial value; `activate` can fire before `createWindow` → `undefined.show()` crash on macOS (PR #10). |
| E2 | P1 | `main.ts` | No readiness check for the backend and no port-conflict handling on 8000; the renderer just retries 10× and then shows an empty app. |
| E3 | P2 | `main.ts` | `nodeIntegration: true` + `contextIsolation: false` with no preload: any renderer XSS becomes arbitrary code execution. |
| E4 | P2 | `main.ts` | `pythonProcess.kill()` in dev kills the uvicorn reloader but can orphan its worker; prod backend keeps running if Electron crashes. `logToDesktop` appends every backend stdout line to `~/Documents/cracked_oura_electron_debug.log` forever. |
| E5 | P2 | packaging | App is unsigned/un-notarized (issues #1, #8, #11); README workaround is `xattr -cr`. No Windows release. |

## 5. Verification log
- `npm install` (clean): **fails** ERESOLVE (B1). With `--legacy-peer-deps`: 705 packages OK.
- `tsc -b`: **clean**. `tsc -p electron/tsconfig.json`: **clean**. `vite build`: OK (768 kB JS bundle, single chunk).
- `eslint .`: 100 errors, 4 warnings.
- `pyflakes`/`flake8 --select=E9,F,E722`: 45 findings (unused imports, unused vars, bare excepts, f-string without placeholders).
- Repro `logtest.py`: second `basicConfig` is a no-op, log file stays 0 bytes (S4).
- Repro `routetest.py`: duplicate route resolves to the router version (A7).
- `dist-electron/main.js` vs fresh `tsc` output: identical (not stale).

---

## 6. Status after the rebuild (2026-09-11, branch `rebuild`)

The fork was rebuilt as a **strictly local** application. Every Oura-facing path
was removed: no website automation, no login/OTP, no export requests, no cloud API.
Data enters only from the ring over Bluetooth or from an export ZIP already on disk.

| Area | Before | After |
|---|---|---|
| Build | `npm install` failed (B1), `pyinstaller` missing (B2) | Clean install; pinned `requirements.txt`; PyInstaller spec collects bleak/cryptography/langchain; frozen backend boots and serves |
| Data source | Playwright robot against membership.ouraring.com (A1–A14, all broken) | `backend/src/ble/` direct-BLE client: framing, AES app-auth, event decoders, incremental history drain with cursor checkpoints, derivation into dashboard tables, supervised worker process; ring CLI |
| Import | Hand-rolled `;` splitter, wrong file names, silent zero-row imports (I1–I10) | csv-module reader, delimiter sniffing, both naming schemes, per-file/row error isolation, summary dict, vo2max, synthetic-export fixture, 39 tests |
| API | Duplicate routes, blocking handlers, CORS `*`, wrong DB path for the analyst (S1–S10) | Single router, worker-thread analyst and import, restricted CORS, health/inventory/sync/BLE/SSE endpoints, hardened query validation, rotating file log |
| AI analyst | Pointed at an empty DB, no history, event-loop blocking | Correct DB opened read-only, tool-calling agent, conversation history, Ollama or OpenAI-compatible, connection test |
| Frontend | Login/OTP UI wired to a status model that never matched (F1–F15) | Ring page, Data & Sync, Settings, onboarding, default Overview, hypnogram + contributors widgets, score bands, shortcuts, toasts, skeletons; timezone/duration/intraday bugs fixed; 0 ESLint errors |
| Electron | `nodeIntegration`, no readiness wait, activate crash (E1–E5) | contextIsolation + sandbox, backend health wait, port-conflict logging, process-group kill, Bluetooth usage descriptions in the bundle |
| Tests | none | 57 backend tests (protocol vectors, client, store/derivation, manager with simulated ring, supervisor, ingestion) |

Known limits: the ring does not emit Oura's 0–100 scores (computed in the phone
app), so ring-synced days show measured values but no score; SpO2 raw events are
stored but not yet summarised; pairing requires a factory-reset ring
(see `docs/BLE.md`); a backend started from a terminal without Bluetooth
permission reports "unavailable" instead of scanning.

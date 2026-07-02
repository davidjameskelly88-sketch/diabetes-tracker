# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A personal insulin/glucose/activity tracker for type 1 diabetes management. It polls live glucose data from LibreLinkUp (Freestyle Libre follower API), accepts Apple Health activity data via Apple Shortcuts webhooks, and does pattern analysis on insulin corrections. Not medical software — single-user. Deployed to Render (see `README.md` "Deploy to Render"); the original design target was Glitch and that path still works.

## Commands

- `npm start` — runs `server.js` (only script defined; no build step)
- No test suite, no linter/formatter configured (no jest/vitest, no eslint/prettier)
- Requires Node >= 18 (uses global `fetch`)

## Running locally

Create a `.env` file in the project root (loaded manually by `server.js`, not via dotenv package):
```
LLU_EMAIL=...
LLU_PASSWORD=...
LLU_REGION=EU          # optional, default EU
APP_PASSWORD=...
PORT=3000               # optional, default 3000
# UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  # optional, see Data persistence below
```
The server calls `process.exit(1)` at startup if `LLU_EMAIL`/`LLU_PASSWORD`/`APP_PASSWORD` are missing or still set to placeholder values. Note `.env` is gitignored — a separate deploy host (Render, Glitch) needs these set in its own env var UI; they don't travel with the repo.

## Architecture

Two files hold essentially all the logic:

- **`server.js`** — Express backend, LibreLinkUp client, pattern-analysis engine, JSON-file persistence.
- **`public/index.html`** — entire frontend: markup, CSS, and vanilla JS in one file (no framework, no bundler). Rendered as a single-page app with 4 tabs (Track / Activity / Insights / Today).

### Data persistence

No real database — a single JSON blob read/written wholesale via `loadData()`/`saveData()` in `server.js` (both `async`, all call sites use `await`). Shape:
```js
{ boluses: [], basalDoses: [], corrections: [], activities: [], glucoseHistory: [] }
```
Retention is pruned inline: `glucoseHistory` kept 7 days, `activities` kept 30 days, `corrections` kept indefinitely (needed for long-term pattern analysis).

Storage backend depends on environment:
- If `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` are set, the blob is stored as a single key in Upstash Redis via plain `fetch()` against its REST API (no client library, same style as the LibreLinkUp calls). This is what Render (no persistent disk on the free tier) uses in production.
- Otherwise, falls back to a local `data.json` file: `.data/data.json` if a `.data` dir exists (Glitch convention), else project root. This is what local dev and Glitch use.

When adding new data fields or call sites, remember `loadData()`/`saveData()` are async now — a missed `await` will silently race against the Upstash HTTP round-trip.

### Auth

Single shared `APP_PASSWORD` (no user accounts). `requireAuth` middleware in `server.js` accepts either an httpOnly cookie (`auth`, sha256 of the password, set via `POST /api/login`) or a `Bearer <APP_PASSWORD>` header — the latter path exists specifically so Apple Shortcuts can POST to `/api/health` without cookie support.

### LibreLinkUp integration

`server.js` maintains its own auth session against the LibreLinkUp API (`REGIONS` map of per-region base URLs, spoofed iOS `User-Agent`/`product` headers to match the official app). Key pieces:
- `login()` — authenticates, handles the "Terms of Use" re-acceptance redirect flow, caches `authToken`/`tokenExpiry` (50 min).
- `fetchGlucose()` — cached per `POLL_MS` (5 min, intentionally matched to the official app's poll rate to avoid account restrictions — do not lower this); on a genuinely new reading (>3 min since last stored point) appends to `glucoseHistory` and triggers `resolveCorrections()`. Uses `FactoryTimestamp` (UTC) rather than `Timestamp` (unmarked local time — drifts during BST) for the reading's timestamp.
- `computeTrend()` derives the rising/falling arrow from the delta between the last two stored `glucoseHistory` points (mmol/L per minute, bucketed), overriding LibreLinkUp's own `TrendArrow` — this is more responsive than the API's arrow without polling more often. Falls back to the API's arrow when there's no usable prior point (cold start or a >20min gap).
- Server polls glucose automatically via `setInterval` at startup — this happens independent of any HTTP request.

### Correction-resolution flow (the core domain logic)

When a user logs an insulin "correction" dose (`POST /api/entries/correction`), the entry is stored unresolved (`actualGlucose: null`). On every subsequent glucose fetch, `resolveCorrections()` checks each pending correction:
- Waits at least 2.5h, gives up (marks unresolved) after 4h.
- Finds the glucose reading closest to the 3h mark and records it as `actualGlucose`, deriving `dropPerUnit` and `accuracy` vs. the user's `predictedGlucose`.
- If carbs were logged between the correction and its resolution, the drop is confounded — the correction is flagged `carbInterference` and excluded from the "clean" `resolved` set used everywhere else (correction-factor average, `suggestedDrop`, `analysePatterns()`, `suggestMealDose()`).
- The rolling average `dropPerUnit` across clean resolved corrections becomes the user's personal correction factor, surfaced via `GET /api/correction-factor` and used to auto-suggest `suggestedDrop` on future correction entries. That endpoint also returns `recentCarbs` (carbs logged in the last 2h) as a heads-up that the correction may be less predictable.

`analysePatterns()` (backing `GET /api/insights`) builds on this history: correction-factor accuracy, exercise-day vs. rest-day insulin sensitivity, post-workout glucose deltas, time-of-day highs/lows, and time-in-range (4.0–10.0 mmol/L target).

### Meal dose suggestion

`suggestMealDose(carbs)` (backing `GET /api/meal-suggestion?carbs=`) is a heuristic, not ML: it weights past insulin-dosed meals (`boluses` with `units>0 && carbs>0`) by carb-amount similarity, recency (~30-day half-life), time-of-day-bucket match, and exercise-proximity match, to get a base insulin:carb ratio. It then nudges that ratio using how similar meals actually turned out — post-meal glucose nadir (using `correctionFactor` to translate an excessive drop into a unit reduction) or whether a correction was needed afterward (nudges up).

### Meals without insulin

`boluses` entries don't require `units` — `POST /api/entries/bolus` accepts carbs-only entries (`units: 0`) for logging food eaten without dosing (e.g. treating/preventing a hypo). Frontend and history rendering treat `units === 0` as "carbs only" rather than a 0-unit dose. Anywhere historical meals feed an algorithm (`suggestMealDose`), carbs-only entries are excluded via the `units > 0` filter, but they still count as "recent carbs" for correction-interference/context checks.

### Frontend

`public/index.html` polls the backend directly (no client-side router/state library). Insulin-on-board is computed client-side in `calcIOB()` using a simple linear decay over `BD = 240` minutes (4h, tuned for Novorapid). The glucose trend chart is drawn to a `<canvas>` by hand in `drawChart()`, including bolus/correction/exercise event markers pulled from `GET /api/glucose-history`.

### External integration: Apple Shortcuts

`POST /api/health` accepts JSON with `workouts[]` and/or a daily `summary` object; this is the target of an Apple Shortcuts automation described in `README.md` that reads Health data and posts it hourly. Workout dedup is by matching `startTime`; the daily summary upserts (one record per calendar day).

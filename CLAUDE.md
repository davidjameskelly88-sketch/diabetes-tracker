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
- **`public/index.html`** — entire frontend: markup, CSS, and vanilla JS in one file (no framework, no bundler). Rendered as a single-page app with 5 tabs (Track / Activity / Insights / Today / Settings).

### Data persistence

No real database — a single JSON blob read/written wholesale via `loadData()`/`saveData()` in `server.js` (both `async`, all call sites use `await`). Shape:
```js
{ boluses: [], basalDoses: [], corrections: [], activities: [], glucoseHistory: [], settings: { targetLow, targetHigh, carbRatio } }
```
`backfill()` merges in `DEFAULT_SETTINGS` (and an empty `corrections` array) for blobs saved before a field existed, so old data doesn't need a migration.
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
- `fetchGlucose()` also exposes the raw (non-bucketed) `delta`/`deltaMinutes` between those same two points on the `/api/glucose` response — shown as a small corner note on the frontend's glucose card (e.g. "+0.3 (5m)"). `null` if there's no prior point or the gap exceeds 20min, same guard as `computeTrend()`.
- Server polls glucose automatically via `setInterval` at startup — this happens independent of any HTTP request.

### Correction-resolution flow (the core domain logic)

When a user logs an insulin "correction" dose (`POST /api/entries/correction`), the entry is stored unresolved (`actualGlucose: null`). On every subsequent glucose fetch, `resolveCorrections()` checks each pending correction:
- Waits at least 2.5h, gives up (marks unresolved) after 4h.
- Finds the glucose reading closest to the 3h mark and records it as `actualGlucose`, deriving `dropPerUnit` and `accuracy` vs. the user's `predictedGlucose`.
- If carbs were logged between the correction and its resolution, the drop is confounded — the correction is flagged `carbInterference` and excluded from the "clean" `resolved` set used everywhere else (correction-factor average, `suggestedDrop`, `analysePatterns()`, `suggestMealDose()`).
- The rolling average `dropPerUnit` across clean resolved corrections becomes the user's personal correction factor, surfaced via `GET /api/correction-factor` and used to auto-suggest `suggestedDrop` on future correction entries. That endpoint also returns `recentCarbs` (carbs logged in the last 2h) as a heads-up that the correction may be less predictable.
- `GET /api/correction-factor` also proactively suggests a correction dose: `suggestedUnits = (currentGlucose - settings.idealTarget) / factor`, rounded to the nearest 0.5u, `0` if already at/below target. This is distinct from `suggestedDrop` above - one predicts the outcome of a chosen unit amount, the other suggests the unit amount in the first place. Needs both a personal correction factor (≥3 clean resolved corrections) and `settings.idealTarget` set.

`analysePatterns()` (backing `GET /api/insights`) builds on this history: correction-factor accuracy, exercise-day vs. rest-day insulin sensitivity, post-workout glucose deltas, time-of-day highs/lows, and time-in-range (against `settings.targetLow`/`targetHigh`, not a hardcoded range).

The post-exercise insight segments each workout into three phases - before (30min pre-*start*), during (start-to-end), and after (30-180min post-end) - and describes the actual trajectory (e.g. "dropped 4.0 during, then rose 2.7 after") rather than a single before/after delta, which misses what happens mid-activity (a workout can swing sharply one way during and recover the other way after, netting out looking like nothing happened). "Before" is anchored to the workout's *start*, not its end - anchoring to end-minus-30min was actually sampling the tail of the workout itself for anything longer than 30min. The "during" direction (drop vs rise) is whichever swung further from baseline; type is `warning` only for an in-activity drop or a delayed drop afterward (real hypo-risk signals), not for a rise during exercise (a normal adrenaline/glycogen response).

### Meal dose suggestion

`suggestMealDose(carbs)` (backing `GET /api/meal-suggestion?carbs=`) is a heuristic, not ML: it weights past insulin-dosed meals (`boluses` with `units>0 && carbs>0`) by carb-amount similarity, recency (~30-day half-life), time-of-day-bucket match, and exercise-proximity match, to get a base insulin:carb ratio. It then nudges that ratio using how similar meals actually turned out — post-meal glucose nadir (using `correctionFactor` to translate an excessive drop into a unit reduction) or whether a correction was needed afterward (nudges up). If there isn't enough history yet (< 3 meals, or nothing similar enough), it falls back to `settings.carbRatio` (a manually-set "1 unit per Xg" ratio) when the user has set one.

On top of that, a correction add-on gets folded into whichever base suggestion was used (history-based or `carbRatio` fallback) — the same `(currentGlucose - idealTarget) / correctionFactor` calculation as the standalone correction suggestion, added via a shared `combine()` closure so all three return paths apply it uniformly. This mirrors how a real bolus calculator combines a "carb bolus" with a "correction bolus" into one number rather than treating them as two separate decisions.

### Meals without insulin

`boluses` entries don't require `units` — `POST /api/entries/bolus` accepts carbs-only entries (`units: 0`) for logging food eaten without dosing (e.g. treating/preventing a hypo). Frontend and history rendering treat `units === 0` as "carbs only" rather than a 0-unit dose. Anywhere historical meals feed an algorithm (`suggestMealDose`), carbs-only entries are excluded via the `units > 0` filter, but they still count as "recent carbs" for correction-interference/context checks.

### Backdated logging and editing

All three logging endpoints (`bolus`, `basal`, `correction`) accept an optional `time` (epoch ms or parseable date string) so a meal/dose can be logged after the fact instead of always defaulting to "now" — `resolveEntryTime()` clamps it to not-future. For a backdated correction, `startGlucose` is looked up via `glucoseAt()` (closest `glucoseHistory` point within 15min of that time, or the live cache if the time is within 6min of now) instead of always using the current cached reading.

Each entry type also has a `PATCH /api/entries/<kind>/:id` for in-place edits. Editing a correction's `units` or `time` invalidates its prior resolution (`resolved`/`actualGlucose`/etc. reset to null/false so `resolveCorrections()` re-derives them next glucose poll) — but time comparisons use a **60s tolerance**, not exact equality, because the frontend's `datetime-local` input only has minute precision; without the tolerance, saving an edit that didn't touch the time field would still spuriously "change" it by a few rounded seconds and wipe `startGlucose` every time. If you touch this code, keep that tolerance.

### Carbs on board (COB) and insulin on board (IOB)

Both are computed client-side in `public/index.html`, decaying independently per entry (`iobFraction()` / `cobFraction()`). `calcIOB()` sums over both `boluses` *and* `corrections` (a correction is still an insulin injection); `calcCOB()` only sums `boluses`, since corrections don't carry carbs. IOB uses the exponential insulin-action model (`iobFraction()`, same formula used by Loop/OpenAPS) with `IOB_PEAK = 75` / `IOB_DIA = 240` minutes, tuned for Novorapid — this replaced an earlier naive linear-decay model that wrongly treated a dose as 100% active immediately after injection. COB uses a simpler linear absorption model over `COB_DURATION = 180` minutes (carb absorption varies far more by food type than insulin action does, so a tuned curve isn't worth it here — linear is the standard pragmatic default).

The glucose chart's insulin-activity overlay (`iobActivityFraction()` in `drawChart()`) is a different curve from IOB's remaining-on-board fraction: it's the bell-shaped *rate of use*, peaking around `IOB_PEAK` minutes, derived as the per-minute finite difference of `iobFraction()` rather than a separately-derived formula, so it can't drift out of sync with the IOB model actually in use. `_iobActivityPeak` (a 1-unit dose's peak rate, sampled once at load) and `IOB_CHART_SCALE_UNITS = 10` calibrate the overlay's height so a typical dose fills a sensible fraction of the chart rather than being auto-scaled per-view (which would make the same dose look a different size depending on what else is visible). Doses are summed at each sample point, so overlapping boluses/corrections render as one merged curve rather than stacking separately.

### Settings (target range, insulin:carb ratio, body profile)

`GET`/`POST /api/settings` read/write `data.settings`. `targetLow`/`targetHigh` drive glucose color-coding and time-in-range everywhere (both backend insights/summary and the frontend chart band/dot colors) — there's no hardcoded 4–10 range left. `idealTarget` is a separate single-value target (distinct from the low/high range) that correction and meal-dose suggestions aim for. `carbRatio` is the manual meal-suggestion fallback described above. The frontend fetches settings once in `init()` before the first render so colors are correct on load, and again whenever the Settings tab is opened.

`heightCm`/`weightKg`/`sex`/`bodyFatPct` (Settings tab "Body Profile" card) are stored purely as context for the Insulin Health Check below (BMI, dose-per-kg) — **never read by any suggestion or calculation elsewhere** (`suggestMealDose`, correction factor, etc.). This is a deliberate boundary: self-estimated body fat % in particular isn't precise enough to weight into anything without giving false confidence. If you're tempted to use these fields for more than display, reconsider.

### Insulin Health Check

`checkInsulinHealth()` (backing `GET /api/insulin-health`, shown on the Insights tab) reports standard clinical-style dose metrics over the trailing 7 days: Total Daily Dose (TDD = bolus + correction + basal), TDD/kg (needs `weightKg`), bolus:basal split, time-in-range, and BMI (needs `heightCm`+`weightKg`). `periodStats()` computes these for an arbitrary window; the function calls it twice (this week vs. the prior week) and emits a plain-language note for each metric that moved meaningfully (TDD ±2u/day, TIR ±5pp, bolus share ±8pp) — silence on a metric means it didn't move enough to be worth mentioning, not that it's broken. Requires ≥20 glucose readings in the trailing week before returning anything (`available: false` otherwise), matching `analysePatterns()`'s data-sufficiency bar.

### CSV export

`GET /api/export.csv` flattens all five record arrays into one wide sheet with a `type` discriminator column (`bolus`/`carbs_only`/`basal`/`correction`/`workout`/`daily_summary`/`glucose`), sorted by time. Triggered from the frontend via a plain `<a href download>` — auth works because the browser sends the existing session cookie on that same-origin navigation, no token wiring needed.

### Frontend

`public/index.html` polls the backend directly (no client-side router/state library). The glucose trend chart is drawn to a `<canvas>` by hand in `drawChart()`, including bolus/correction/exercise event markers pulled from `GET /api/glucose-history`. Hour labels on the x-axis are anchored to actual clock-hour boundaries (`x(hourBoundaryTime)`), not to wherever a data point happens to fall — the latter breaks down when readings are gapped (sensor/network lag), since two adjacent hours can each have their only representative point land right next to the boundary and render almost on top of each other.

### External integration: Apple Health

`POST /api/health` accepts two different payload shapes and auto-detects which one it got:
- **Health Auto Export** (recommended, see `README.md`) sends `{ data: { metrics: [{name, units, data:[{date, qty|Avg/Min/Max, ...}]}], workouts: [...] } }`. Energy values are in **kJ** and get converted to kcal (`kJtoKcal()`). Daily metrics (`active_energy`, `apple_exercise_time`, `apple_stand_hour`, `step_count`, `resting_heart_rate`) are iterated per-day and upserted via `upsertDailySummary()`, which merges into whichever `daily_summary` activity matches that calendar day rather than assuming everything is "today" — a single export/automation run can carry multiple days. Workouts carry `avgHeartRate`/`maxHeartRate` (stored, surfaced in the Activity tab and in the post-exercise insight text), but per-minute time series (`heartRateData`, `heartRateRecovery`, etc.) are deliberately *not* stored — a single export can be hundreds of KB and only the summary stats are useful here.
- **Legacy Apple Shortcuts** format `{ summary: {...}, workouts: [{startTime, endTime, ...}] }` is still supported for anyone not using Health Auto Export.

Workout dedup in both paths is by matching the stored `startTime` field (`w.start` for Health Auto Export, `w.startTime` for Shortcuts) against existing `activities`.

**Apple's free Shortcuts actions cannot query Workout objects at all** — "Find Health Samples" only exposes quantity/category samples (heart rate, steps, etc.), not workouts. This is a real platform limitation (confirmed via research, not a bug in this app), not something the original Shortcuts-based README instructions could have ever actually accomplished. Getting workouts into Shortcuts requires a paid third-party action (e.g. Toolbox Pro's "Get Workouts"). Because of this, `POST /api/activities/workout` (+ matching `PATCH`/`DELETE .../:id`) exists as a manual-entry fallback, surfaced as a "Log a workout" form on the Activity tab. Manually-logged workouts are flagged `manual: true` and are the only ones with a delete button in the UI (synced entries aren't locally deletable since they'd just reappear on the next sync).

Without an explicit backdated time, `POST /api/activities/workout` assumes the workout *just ended* (`start = now - duration`), not that it's starting now — someone logging a completed workout is almost always doing so shortly after finishing it, and stamping it as starting now would plot it as happening in the future relative to when it actually occurred, throwing off its position on the glucose chart relative to the glucose reading at the time. Editing `duration` via `PATCH` recomputes `endTime` from the *existing* `time` (start), so it doesn't go stale relative to the new duration.

### Known LibreLinkUp data lag (not a bug in this app)

Follower-account data (what this app polls) can genuinely lag the primary sharer's own LibreLink app by up to 15–20 minutes, and real new readings can arrive well over 5 minutes apart even though `fetchGlucose()` polls every `POLL_MS` — this is a documented characteristic of LibreLinkUp's sync, not something fixable by polling more often (and `POLL_MS` shouldn't be lowered regardless, see above). If glucose values look "wrong" compared to the primary app, check whether the underlying reading timestamps genuinely differ before assuming a bug here.

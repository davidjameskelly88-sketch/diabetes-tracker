// ─── Entry point ──────────────────────────────────────────────────────
// Personal insulin/glucose/activity tracker. All real logic lives in lib/:
//   lib/config.js   env loading + constants (validates required vars, exits if missing)
//   lib/store.js    single-blob persistence (Upstash Redis or local data.json)
//   lib/libre.js    LibreLinkUp client + glucose polling/cache
//   lib/analysis.js correction resolution, pattern insights, dose suggestions
//   lib/routes.js   Express routes
const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');

const { PORT } = require('./lib/config');
const { login, fetchGlucose, setOnGlucoseFetched, POLL_MS } = require('./lib/libre');
const { resolveCorrections, scoreForecasts } = require('./lib/analysis');
const { registerRoutes } = require('./lib/routes');

// Wired here (not required inside libre.js) to avoid a libre<->analysis require cycle: every
// uncached glucose fetch re-checks pending corrections, then grades any forecast whose horizon
// has now elapsed against the reading that just arrived. Sequential (not parallel) - both do a
// read-modify-write of the same blob, so they must not interleave.
setOnGlucoseFetched(async () => {
  await resolveCorrections();
  await scoreForecasts();
});

const app = express();
// Render/Glitch terminate TLS at a proxy, so the real client IP arrives via X-Forwarded-For
// and HTTPS via X-Forwarded-Proto. Trusting the first proxy hop makes req.ip (the login
// rate-limiter's key) and req.secure (the auth cookie's Secure flag) reflect the real client.
app.set('trust proxy', 1);
// 5mb (up from 1mb): Health Auto Export payloads embed per-minute heart-rate arrays we discard
// server-side, but Express still has to parse the whole body first - a multi-workout export can
// clear 1mb and would otherwise 413 and silently break the Apple Health sync.
app.use(express.json({ limit: '5mb' }));
app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
registerRoutes(app);

app.listen(PORT, '0.0.0.0', async () => {
  console.log(`\n━━━ 💉 Diabetes Tracker v2 ━━━\n  Port ${PORT}\n`);
  const ok = await login();
  if (ok) await fetchGlucose();
  // Poll glucose continuously, independent of any HTTP request. POLL_MS matches the official
  // app's rate to avoid LibreLinkUp account restrictions - do not lower it.
  setInterval(() => fetchGlucose(), POLL_MS);
});

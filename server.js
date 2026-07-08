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
const { resolveCorrections } = require('./lib/analysis');
const { registerRoutes } = require('./lib/routes');

// Wired here (not required inside libre.js) to avoid a libre<->analysis require cycle:
// every uncached glucose fetch re-checks pending corrections against the new reading.
setOnGlucoseFetched(resolveCorrections);

const app = express();
app.use(express.json({ limit: '1mb' }));
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

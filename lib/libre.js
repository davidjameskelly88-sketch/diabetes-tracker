// ─── LibreLinkUp client ───────────────────────────────────────────────
// Maintains its own auth session against the LibreLinkUp follower API, with spoofed iOS
// headers matching the official app. Polls at POLL_MS - intentionally the same rate as the
// official app to avoid account restrictions; do not lower it. Follower data can genuinely
// lag the sharer's own app by 15-20min (documented LibreLinkUp behaviour, not a bug here).
const crypto = require('crypto');
const { LLU_EMAIL, LLU_PASSWORD, LLU_REGION } = require('./config');
const { loadData, saveData } = require('./store');

const REGIONS = {
  EU: 'https://api-eu.libreview.io', EU2: 'https://api-eu2.libreview.io',
  US: 'https://api-us.libreview.io', AE: 'https://api-ae.libreview.io',
  AP: 'https://api-ap.libreview.io', AU: 'https://api-au.libreview.io',
  CA: 'https://api-ca.libreview.io', DE: 'https://api-de.libreview.io',
  FR: 'https://api-fr.libreview.io', JP: 'https://api-jp.libreview.io',
  LA: 'https://api-la.libreview.io',
};
let apiBase = REGIONS[LLU_REGION] || REGIONS.EU;

const LLU_HEADERS = {
  'Content-Type': 'application/json', 'product': 'llu.ios', 'version': '4.16.0',
  'Accept-Encoding': 'gzip',
  'User-Agent': 'Mozilla/5.0 (iPhone; CPU OS 17_4.1 like Mac OS X) AppleWebKit/536.26 (KHTML, like Gecko) Version/17.4.1 Mobile/10A5355d Safari/8536.25',
};

let authToken = null, tokenExpiry = 0, accountId = null;
let glucoseCache = null, glucoseCacheTime = 0;
const POLL_MS = 5 * 60 * 1000;

// Called after every uncached fetch (post-save when the reading was new) - server.js wires
// this to resolveCorrections(). Injected rather than required to avoid a libre<->analysis
// require cycle (analysis needs getGlucoseCache from here).
let onGlucoseFetched = async () => {};
function setOnGlucoseFetched(fn) { onGlucoseFetched = fn; }

function getGlucoseCache() { return glucoseCache; }

async function lluFetch(ep, opts = {}) {
  const headers = { ...LLU_HEADERS, ...opts.headers };
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (accountId) headers['Account-Id'] = crypto.createHash('sha256').update(accountId).digest('hex');
  const res = await fetch(apiBase + ep, { method: opts.method || 'GET', headers, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const data = await res.json();
  if (data.data && data.data.redirect) {
    const nr = data.data.region.toUpperCase();
    if (REGIONS[nr]) { apiBase = REGIONS[nr]; console.log(`  Redirected to ${nr}`); return lluFetch(ep, opts); }
  }
  return data;
}

async function login() {
  console.log('🔑 Logging in to LibreLinkUp...');
  try {
    const r = await lluFetch('/llu/auth/login', { method: 'POST', body: { email: LLU_EMAIL, password: LLU_PASSWORD } });
    // status 2/4 = Terms of Use re-acceptance required; accept and continue.
    if (r.status === 2 || r.status === 4) {
      if (r.data && r.data.authTicket) {
        authToken = r.data.authTicket.token;
        const t = await lluFetch('/auth/continue/tou', { method: 'POST', body: {} });
        if (t.status === 0 && t.data && t.data.authTicket) {
          authToken = t.data.authTicket.token;
          if (t.data.user) accountId = t.data.user.id;
          tokenExpiry = Date.now() + 50 * 60000;
          console.log('✅ Logged in (TOU)');
          return true;
        }
      }
      return false;
    }
    if (r.status !== 0 || !r.data || !r.data.authTicket) {
      console.error('❌ Login failed:', r.message || JSON.stringify(r).substring(0, 200));
      return false;
    }
    authToken = r.data.authTicket.token;
    tokenExpiry = Date.now() + 50 * 60000;
    if (r.data.user) accountId = r.data.user.id;
    console.log('✅ Logged in successfully');
    return true;
  } catch (e) { console.error('❌ Login error:', e.message); return false; }
}

async function ensureAuth() {
  if (!authToken || Date.now() > tokenExpiry) return await login();
  return true;
}

const TREND_MAP = {
  1: { arrow: '↓↓', label: 'Falling quickly' }, 2: { arrow: '↓', label: 'Falling' },
  3: { arrow: '↘', label: 'Falling slowly' }, 4: { arrow: '→', label: 'Stable' },
  5: { arrow: '↗', label: 'Rising slowly' }, 6: { arrow: '↑', label: 'Rising' },
  7: { arrow: '↑↑', label: 'Rising quickly' },
};

// Derive our own trend arrow from the last two stored readings (~5min apart) instead of
// trusting LibreLinkUp's TrendArrow, which can disagree with the official app. No extra
// polling involved - this just reasons over history we already have.
function computeTrend(value, time, history) {
  if (!history.length) return null;
  const prev = history[history.length - 1];
  const minutes = (time - prev.time) / 60000;
  if (minutes <= 1 || minutes > 20) return null; // gap too small/large to trust
  const rate = (value - prev.value) / minutes; // mmol/L per minute
  if (rate >= 0.17) return { arrow: '↑↑', label: 'Rising quickly' };
  if (rate >= 0.10) return { arrow: '↑', label: 'Rising' };
  if (rate >= 0.05) return { arrow: '↗', label: 'Rising slowly' };
  if (rate > -0.05) return { arrow: '→', label: 'Stable' };
  if (rate > -0.10) return { arrow: '↘', label: 'Falling slowly' };
  if (rate > -0.17) return { arrow: '↓', label: 'Falling' };
  return { arrow: '↓↓', label: 'Falling quickly' };
}

async function fetchGlucose() {
  if (glucoseCache && (Date.now() - glucoseCacheTime) < POLL_MS) return glucoseCache;
  if (!await ensureAuth()) return glucoseCache || { error: 'Not authenticated' };
  try {
    const cr = await lluFetch('/llu/connections');
    if (cr.status !== 0 || !cr.data || !Array.isArray(cr.data) || cr.data.length === 0) return { error: 'No connections' };
    const m = cr.data[0].glucoseMeasurement;
    if (!m) return { error: 'No glucose data' };
    const apiTrend = TREND_MAP[m.TrendArrow] || { arrow: '?', label: 'Unknown' };
    const mgdl = m.ValueInMgPerDl || m.Value;
    const mmol = parseFloat((mgdl / 18.0182).toFixed(1));
    // FactoryTimestamp is UTC and DST-safe; Timestamp is the account's local time with no
    // offset marker, which gets misparsed as UTC and drifts an hour off during BST.
    const timestamp = m.FactoryTimestamp || m.Timestamp;
    const ts = new Date(timestamp).getTime() || Date.now();

    const data = await loadData();
    const last = data.glucoseHistory[data.glucoseHistory.length - 1];
    const trend = computeTrend(mmol, ts, data.glucoseHistory) || apiTrend;
    // Raw change since the last stored reading (~5min at our poll cadence), for the small
    // "+0.3 (5m)" corner note on the glucose card - independent of the bucketed trend arrow.
    const deltaMinutes = last ? Math.round((ts - last.time) / 60000) : null;
    const delta = (last && deltaMinutes > 0 && deltaMinutes <= 20) ? parseFloat((mmol - last.value).toFixed(1)) : null;

    glucoseCache = { value: mmol, valueMgDl: mgdl, unit: 'mmol/L', trend: trend.arrow, trendLabel: trend.label, delta, deltaMinutes: delta != null ? deltaMinutes : null, timestamp, fetchedAt: Date.now() };
    glucoseCacheTime = Date.now();

    // Store history on a genuinely new reading (>3min since the last stored point).
    if (!last || Math.abs(ts - last.time) > 3 * 60000) {
      data.glucoseHistory.push({ time: ts, value: mmol, trend: trend.arrow });
      // 14 days, not 7 - checkInsulinHealth()'s periodStats() compares two rolling 7-day
      // windows (this week vs. the prior week), so the prior window needs its own 7 days of
      // glucose behind the current one. Retaining only 7 days made that "prior week" comparison
      // silently always-empty (readingCount was always 0, so the note never fired). Pattern
      // analysis in analysePatterns() still explicitly scopes itself to the trailing 7 days
      // regardless, so its "over the last 7 days" language stays accurate.
      const cutoff = Date.now() - 14 * 24 * 60 * 60 * 1000;
      data.glucoseHistory = data.glucoseHistory.filter(g => g.time > cutoff);
      await saveData(data);
    }
    await onGlucoseFetched(); // resolve pending corrections
    console.log(`📊 ${mmol} mmol/L ${trend.arrow}`);
    return glucoseCache;
  } catch (e) { console.error('❌ Glucose error:', e.message); return glucoseCache || { error: e.message }; }
}

module.exports = { login, fetchGlucose, getGlucoseCache, setOnGlucoseFetched, POLL_MS };

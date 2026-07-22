// ─── State ──────────────────────────────────────────────────────────────
let boluses = [], basalDoses = [], corrections = [], chartHours = 6;
let settings = { targetLow: 4, targetHigh: 10, carbRatio: null };
let editingEntry = null;

// ─── Theme ──────────────────────────────────────────────────────────────
// 'auto' follows prefers-color-scheme; explicit choices persist in localStorage. The canvas
// chart doesn't inherit CSS vars, so applyTheme() redraws it from cached state - cssVar()
// is how all canvas colors stay theme-correct.
function cssVar(name) { return getComputedStyle(document.documentElement).getPropertyValue(name).trim(); }
function themePref() { try { return localStorage.getItem('theme') || 'auto'; } catch (e) { return 'auto'; } }
function applyTheme() {
  const pref = themePref();
  const dark = pref === 'dark' || (pref === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = dark ? '#0b1220' : '#f1f5f9';
  if (window._chart) drawChart(_chart.data, _chart.events);
  requestAnimationFrame(moveGlider);
}
function setTheme(pref) {
  try { localStorage.setItem('theme', pref); } catch (e) {}
  applyTheme(); renderThemeSeg();
}
function renderThemeSeg() {
  const el = document.getElementById('themeSeg');
  if (!el) return;
  el.innerHTML = '';
  [['auto', 'Auto'], ['light', '☀️ Light'], ['dark', '🌙 Dark']].forEach(([v, label]) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (themePref() === v) b.classList.add('on');
    b.onclick = () => setTheme(v);
    el.appendChild(b);
  });
}
window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (themePref() === 'auto') applyTheme(); });

function hexToRgba(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map(c => c + c).join('') : h, 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}
function statusColorVar(v) { return v < settings.targetLow ? '--red' : v > settings.targetHigh ? '--orange' : '--green'; }
function buzz(pattern) { if (navigator.vibrate) navigator.vibrate(pattern || 10); }

// ─── One-thumb helpers ──────────────────────────────────────────────────
// ± steppers on dose/carb inputs: adjust without the keyboard. The dispatched input event
// runs the same listeners typing would (suggestions, button states); _stepping tells the
// carbIn listener not to treat a step as "manual typing" (which would untag the preset meal
// - nudging the portion of a preset meal is still that meal).
let _stepping = false;
function stepInput(id, delta) {
  const el = document.getElementById(id);
  const cur = parseFloat(el.value);
  const next = Math.max(0, Math.round(((isNaN(cur) ? 0 : cur) + delta) * 10) / 10);
  el.value = next === 0 ? '' : next;
  _stepping = true;
  el.dispatchEvent(new Event('input'));
  _stepping = false;
}
// Quick-log bar: scroll to the card and focus its first input once the scroll settles.
function jumpTo(cardId, inputId, isBasal) {
  if (isBasal) {
    const f = document.getElementById('basalForm');
    if (!f.classList.contains('vis')) { f.classList.add('vis'); document.getElementById('basalToggle').textContent = 'Cancel'; }
  }
  document.getElementById(cardId).scrollIntoView({ behavior: 'smooth', block: 'start' });
  setTimeout(() => { try { document.getElementById(inputId).focus({ preventScroll: true }); } catch (e) {} }, 400);
}
// Manual refresh - essential once installed to the home screen, where there's no browser
// reload button and "is this current?" needs a one-tap answer.
async function refreshAll() {
  const btn = document.getElementById('gRefresh');
  btn.classList.add('spin');
  try {
    await Promise.all([fetchGlucose(), loadChart(), fetchEntries(), loadAlerts(), loadForecast()]);
    toast('Updated');
  } catch (e) { toast('Could not refresh', true); }
  finally { btn.classList.remove('spin'); }
}

// ─── Insulin / carb models ──────────────────────────────────────────────
// Exponential insulin-action model (Loop/OpenAPS style) for Novorapid: peak activity at
// IOB_PEAK minutes, fully absorbed by IOB_DIA minutes. Replaces a naive linear decay, which
// wrongly treats insulin as 100% "active" the instant it's injected instead of ramping up.
const IOB_PEAK = 75, IOB_DIA = 240;
const _iobTau = IOB_PEAK * (1 - IOB_PEAK / IOB_DIA) / (1 - 2 * IOB_PEAK / IOB_DIA);
const _iobA = 2 * _iobTau / IOB_DIA;
const _iobS = 1 / (1 - _iobA + (1 + _iobA) * Math.exp(-IOB_DIA / _iobTau));
function iobFraction(t) { // t = minutes since bolus; returns fraction of the dose still on board
  if (t <= 0) return 1;
  if (t >= IOB_DIA) return 0;
  return 1 - _iobS * (1 - _iobA) * ((t * t / (_iobTau * IOB_DIA * (1 - _iobA)) - t / _iobTau - 1) * Math.exp(-t / _iobTau) + 1);
}

// Insulin *activity* (how hard the dose is working right now) is the bell-shaped curve that
// peaks around IOB_PEAK minutes in, as opposed to iobFraction() above which is the remaining
// (monotonically decreasing) on-board amount. Derived as the per-minute rate of iobFraction's
// decline rather than a separately-derived formula, so it's guaranteed consistent with the
// IOB model actually in use. _iobActivityPeak (a 1-unit dose's peak rate) calibrates the
// glucose-chart overlay's height so a typical dose fills a sensible fraction of it.
function iobActivityFraction(t) { if (t < 0 || t >= IOB_DIA) return 0; return iobFraction(t) - iobFraction(t + 1); }
let _iobActivityPeak = 0;
for (let t = 1; t < IOB_DIA; t++) { const a = iobActivityFraction(t); if (a > _iobActivityPeak) _iobActivityPeak = a; }
const IOB_CHART_SCALE_UNITS = 10; // a dose this size at its peak fills ~35% of the overlay height

// Carbs on board: simple linear absorption over COB_DURATION minutes. Carb absorption
// varies far more by food type than insulin action does, so a linear model is the standard
// pragmatic default (used by most bolus calculators) rather than a tuned curve like IOB's.
const COB_DURATION = 180;
function cobFraction(t) { if (t <= 0) return 1; if (t >= COB_DURATION) return 0; return 1 - t / COB_DURATION; }
function calcCOB() { const now = Date.now(); let t = 0; for (const b of boluses) { if (!b.carbs) continue; const e = (now - b.time) / 60000; t += b.carbs * cobFraction(e); } return t; }
// IOB sums over corrections too - a correction is still an insulin injection; COB doesn't,
// since corrections carry no carbs.
function calcIOB() { const now = Date.now(); let t = 0; for (const b of boluses) { const e = (now - b.time) / 60000; t += b.units * iobFraction(e); } for (const c of corrections) { const e = (now - c.time) / 60000; t += c.units * iobFraction(e); } return t; }

// ─── Small helpers ──────────────────────────────────────────────────────
function timeAgo(ts) { const d = Math.floor((Date.now() - ts) / 60000); if (d < 1) return 'just now'; if (d < 60) return d + 'm ago'; const h = Math.floor(d / 60), m = d % 60; if (h < 24) return h + 'h ' + m + 'm ago'; return Math.floor(h / 24) + 'd ago'; }
function fmtTime(ts) { return new Date(ts).toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit', month: 'short', day: 'numeric' }); }
function fmtClock(ts) { return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); }
function dayLabel(ts) {
  const d = new Date(ts), today = new Date(), yest = new Date();
  yest.setDate(yest.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Today';
  if (d.toDateString() === yest.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
}

// The history lists cap at a handful of rows with a "Show more" expander - they'd otherwise
// grow into ever-longer scrolls (entries alone can be 20+ within a couple of days).
let expandedLists = { log: false, workouts: false, corr: false };
function toggleLog() { expandedLists.log = !expandedLists.log; render(); }
function toggleWorkouts() { expandedLists.workouts = !expandedLists.workouts; loadActivities(); }
function toggleCorr() { expandedLists.corr = !expandedLists.corr; loadCorrHistory(); }
function showMoreBtn(total, limit, expanded, minVisible, toggleFn) {
  if (total > limit) return `<button class="show-more" onclick="${toggleFn}()">Show ${total - limit} more</button>`;
  if (expanded && total > minVisible) return `<button class="show-more" onclick="${toggleFn}()">Show less</button>`;
  return '';
}
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function tweenNumber(el, from, to, ms) {
  const t0 = performance.now();
  const ease = x => 1 - Math.pow(1 - x, 3);
  (function step(t) {
    const p = Math.min(1, (t - t0) / ms);
    el.textContent = (from + (to - from) * ease(p)).toFixed(1);
    if (p < 1 && el.isConnected) requestAnimationFrame(step);
  })(t0);
}
// Shimmer placeholders for first-open loads (dataset.loaded guards against re-flashing on
// the 60s background refreshes).
function skeleton(el, rows, tall) {
  el.innerHTML = Array.from({ length: rows || 3 }, () => `<div class="skel${tall ? ' tall' : ''}"></div>`).join('');
}

// Transient feedback for saves and errors, visible regardless of which card triggered it.
let toastTimer = null;
function toast(msg, isError) {
  let el = document.getElementById('toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.className = isError ? 'err' : '';
  // Force a reflow so back-to-back toasts restart the fade
  void el.offsetWidth;
  el.classList.add('vis');
  buzz(isError ? [20, 40, 20] : 10);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('vis'), 2200);
}

// ─── Auth ───────────────────────────────────────────────────────────────
async function checkAuth() { try { const r = await fetch('/api/auth-check'); if (r.ok) { showApp(); return; } } catch (e) {} document.getElementById('loginPage').style.display = 'flex'; }
async function doLogin() {
  const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: document.getElementById('pwInput').value }) });
  if (r.ok) { showApp(); return; }
  // Surface the server's actual message (e.g. the rate-limit lockout) rather than a fixed
  // "Wrong password", so a locked-out user knows to wait rather than keep hammering.
  const errEl = document.getElementById('loginErr');
  try { const d = await r.json(); errEl.textContent = d.error || 'Wrong password'; } catch (e) { errEl.textContent = 'Wrong password'; }
  errEl.style.display = 'block';
}
function showApp() { document.getElementById('loginPage').style.display = 'none'; document.getElementById('appPage').style.display = 'block'; init(); }

async function api(u, o) { const r = await fetch(u, o); if (r.status === 401) location.reload(); return r.json(); }

// ─── Tabs ───────────────────────────────────────────────────────────────
// The glider is the sliding pill behind the active tab; panels get a staggered card
// entrance on open (remove+reflow+add so it re-triggers every switch).
function moveGlider() {
  const g = document.getElementById('tabGlider'), on = document.querySelector('.tab.on');
  if (!g || !on || !on.offsetWidth) return;
  g.style.left = on.offsetLeft + 'px';
  g.style.width = on.offsetWidth + 'px';
}
window.addEventListener('resize', moveGlider);

function showTab(t) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('vis'));
  const panel = document.getElementById('panel-' + t);
  panel.classList.add('vis');
  panel.classList.remove('enter'); void panel.offsetWidth; panel.classList.add('enter');
  window.scrollTo(0, 0); // fresh tab starts at its top, not wherever the last tab was scrolled
  moveGlider();
  // Repaint the chart from cache when Track becomes visible - a theme change while another
  // tab was open skipped its redraw (hidden canvas measures 0x0, see drawChart).
  if (t === 'track') requestAnimationFrame(() => { if (window._chart) drawChart(_chart.data, _chart.events); });
  if (t === 'activity') { loadActivities(); renderSimPresets(); }
  if (t === 'insights') { loadInsights(); loadCorrHistory(); loadInsulinHealth(); loadSensitivityMap(); }
  if (t === 'summary') loadDailySummary();
  if (t === 'settings') { fetchSettings(); loadPresetManager(); loadWorkoutPresetManager(); renderThemeSeg(); renderAlertSeg(); }
}

// Swipe left/right anywhere outside the chart (which owns horizontal drags for scrubbing)
// to move between tabs - thresholds tuned so vertical scrolling never misfires.
(function wireSwipe() {
  const order = ['track', 'activity', 'insights', 'summary', 'settings'];
  let sx = 0, sy = 0, ok = false;
  document.addEventListener('touchstart', e => {
    ok = !e.target.closest('.chart-wrap,input,select,textarea');
    sx = e.touches[0].clientX; sy = e.touches[0].clientY;
  }, { passive: true });
  document.addEventListener('touchend', e => {
    if (!ok) return;
    const dx = e.changedTouches[0].clientX - sx, dy = e.changedTouches[0].clientY - sy;
    if (Math.abs(dx) < 70 || Math.abs(dx) < 2.2 * Math.abs(dy)) return;
    const cur = order.indexOf((document.querySelector('.tab.on') || {}).dataset && document.querySelector('.tab.on').dataset.tab);
    const next = cur + (dx < 0 ? 1 : -1);
    if (cur >= 0 && next >= 0 && next < order.length) showTab(order[next]);
  }, { passive: true });
})();

// ─── Data fetching ──────────────────────────────────────────────────────
async function fetchEntries() { const d = await api('/api/entries'); boluses = d.boluses || []; basalDoses = d.basalDoses || []; corrections = d.corrections || []; render(); }

let _gShown = null; // last value displayed, so a fresh reading tweens instead of snapping
let _lastGlucose = null, _lastAlerts = [];
async function fetchGlucose() {
  const card = document.getElementById('gCard'), disp = document.getElementById('gDisplay');
  try {
    const d = await api('/api/glucose');
    if (d.error) { card.className = 'glucose'; disp.innerHTML = `<div style="color:var(--dim);font-size:13px;padding:10px 0">${d.error}</div>`; return; }
    let cls = 'ok';
    if (d.value < settings.targetLow) cls = 'low'; else if (d.value > settings.targetHigh) cls = 'high';
    card.className = `glucose ${cls}`;
    const deltaHtml = d.delta != null ? `<div class="g-delta">${d.delta > 0 ? '+' : ''}${d.delta} (${d.deltaMinutes}m)</div>` : '';
    // No trend-label/"Xm ago" meta line - the arrow and delta chip already say it, and the
    // reading age mostly reflected LibreLinkUp's documented follower lag, not anything useful.
    // The ONE exception: a genuinely old reading (>30min, beyond normal follower lag) shows
    // an age warning - trusting a big number that's an hour stale is worse than noise.
    const ageMin = Math.max(0, Math.round((Date.now() - (new Date(d.timestamp).getTime() || d.fetchedAt)) / 60000));
    // Escalates with age: past normal follower lag it's just "old"; past ~40min with nothing
    // new it's more likely a sensor gap (warmup/change/out-of-range) than lag, so say so and
    // point at the primary app. (Local BST dev reads ~1h high per the FactoryTimestamp quirk;
    // correct on Render/UTC.)
    const staleHtml = ageMin > 40
      ? `<div class="g-stale">⚠️ No new readings for ~${ageMin}min — sensor may be warming up or changing. Check your Libre app.</div>`
      : ageMin > 30 ? `<div class="g-stale">⚠️ Reading is ~${ageMin}min old</div>` : '';
    disp.innerHTML = `${deltaHtml}<div class="g-val" style="color:var(${statusColorVar(d.value)})"><span id="gNum">${(_gShown != null ? _gShown : d.value).toFixed(1)}</span><span class="g-trend">${d.trend || ''}</span><span class="u">mmol/L</span></div>${staleHtml}`;
    if (_gShown != null && _gShown !== d.value) {
      tweenNumber(document.getElementById('gNum'), _gShown, d.value, 500);
      disp.querySelector('.g-val').classList.add('pop');
    }
    _gShown = d.value;
    _lastGlucose = d;
    renderSimple();
    checkUrgentAlert(); // an actual low right now should reach you, not just sit on the card
    updateCorrSuggestion(); // keep the correction suggestion current as glucose changes, not just on typing
  } catch (e) { card.className = 'glucose'; disp.innerHTML = '<div style="color:var(--dim);font-size:13px">Could not connect</div>'; }
}

async function loadChart(animate) {
  try {
    const data = await api(`/api/glucose-history?hours=${chartHours}`);
    drawChart(data.glucose || data, data.events || []);
    if (animate) {
      // Left-to-right wipe reveal - only on explicit range switches / first load, never on
      // the 60s background refresh (a chart that flickers every minute reads as broken).
      const c = document.getElementById('glucoseChart');
      c.classList.remove('reveal'); void c.offsetWidth; c.classList.add('reveal');
    }
  } catch (e) {}
}

// Live heads-ups (post-workout drop windows, stacked corrections) - shown right under the
// glucose card where logging decisions get made, not buried in the Insights tab.
async function loadAlerts() {
  try {
    const alerts = await api('/api/alerts');
    _lastAlerts = alerts;
    document.getElementById('alertsBox').innerHTML = alerts.map(a => `<div class="insight ${a.type}" style="margin-bottom:12px">${a.text}</div>`).join('');
    renderSimple();
  } catch (e) {}
}

// ─── Simple ("tired") mode ──────────────────────────────────────────────
// Three things in huge type - Now / Risk / Action - for the moments when the full dashboard
// is cognitive overload: tired, at work, wrangling kids. The action line is synthesized from
// what the app already knows, in priority order: live alert > forecast-driven carb/recheck
// advice > overdue basal > "no action needed". Persists across loads.
function simpleAction() {
  if (_lastAlerts && _lastAlerts.length) return _lastAlerts[0].text;
  const f = window._lastForecast;
  if (f && f.available) {
    if (f.risk === 'high') return (f.carbs ? '🍬 ' + f.carbs + ' ' : 'Have fast carbs nearby. ') + 'Re-check in 15min. Avoid starting exercise.';
    if (f.risk === 'moderate') return (f.carbs ? '🍬 ' + f.carbs + ' ' : '') + 'Re-check in 15–20min.';
  }
  const lba = basalDoses[0];
  if (lba && (Date.now() - lba.time) / 3600000 > 24) return 'Lantus is overdue — take your basal.';
  return 'No action needed.';
}
function renderSimple() {
  const view = document.getElementById('simpleView');
  if (!view || view.style.display === 'none') return;
  const d = _lastGlucose;
  document.getElementById('simpleNow').textContent = d ? d.value.toFixed(1) : '—';
  document.getElementById('simpleNow').style.color = d ? `var(${statusColorVar(d.value)})` : '';
  document.getElementById('simpleTrend').textContent = d ? `${d.trend || ''} ${d.trendLabel || ''}`.trim() : 'No reading';
  const f = window._lastForecast;
  const riskEl = document.getElementById('simpleRisk');
  riskEl.textContent = f && f.available ? f.risk.charAt(0).toUpperCase() + f.risk.slice(1) : '—';
  riskEl.className = 'simple-risk ' + (f && f.available ? f.risk : '');
  document.getElementById('simpleAction').textContent = simpleAction();
}
function enterSimple() {
  try { localStorage.setItem('simpleMode', '1'); } catch (e) {}
  document.getElementById('simpleView').style.display = 'block';
  renderSimple();
}
function exitSimple() {
  try { localStorage.removeItem('simpleMode'); } catch (e) {}
  document.getElementById('simpleView').style.display = 'none';
}

// Hypo risk forecast: the "what happens next" card, permanently under the glucose display.
// Always rendered - a quiet "minimal" is what builds enough trust in the tiers that a
// "high" actually changes behaviour. Factors expand on tap.
let _riskExpanded = false;
function toggleRiskFactors() { _riskExpanded = !_riskExpanded; if (window._lastForecast) renderForecast(window._lastForecast); }
function renderForecast(f) {
  const card = document.getElementById('hypoCard');
  if (!f || !f.available) { card.style.display = 'none'; return; }
  window._lastForecast = f;
  card.style.display = 'block';
  card.className = 'card' + (f.risk === 'high' ? ' risk-high' : f.risk === 'moderate' ? ' risk-moderate' : '');
  const factorsHtml = f.factors.length && _riskExpanded
    ? `<ul class="risk-factors">${f.factors.map(x => `<li>${x}</li>`).join('')}</ul>`
    : f.factors.length ? `<div class="risk-factors">${f.factors[0]}${f.factors.length > 1 ? ` <span style="color:var(--blue);font-weight:600">+${f.factors.length - 1} more</span>` : ''}</div>` : '';
  card.innerHTML = `<div class="risk-row" onclick="toggleRiskFactors()" style="cursor:pointer">
      <div class="risk-title">Hypo risk · next ${f.horizonHours}h <span style="color:var(--dim);font-weight:400">→ ~${f.projectedLow < 3 ? 'below 3' : f.projectedLow}</span></div>
      <div class="risk-badge ${f.risk}">${f.risk}</div>
    </div>${factorsHtml}${f.carbs ? `<div class="risk-carbs">🍬 ${f.carbs}</div>` : ''}`;
}
async function loadForecast() {
  try {
    renderForecast(await api('/api/hypo-forecast'));
    renderSimple();
    checkUrgentAlert(); // a fresh "high" forecast should reach you actively
    // The chart draws the projection from _lastForecast - repaint so it tracks the new one.
    if (window._chart) drawChart(_chart.data, _chart.events);
  } catch (e) {}
}

// ─── Urgent hypo nudge ───────────────────────────────────────────────────
// The forecast card and glucose number are passive - you have to be looking. This makes an
// ACTUAL low (a reading below your target) or a "high" 2h hypo forecast reach you actively: a
// short two-tone beep + vibration, re-fired at most every 10min while the condition holds (and
// again immediately if the condition changes). Sound is opt-out (Settings › Alert Sound), since
// a medical app that beeps at you unbidden is its own kind of stress; vibration still fires.
function alertsEnabled() { try { return localStorage.getItem('alertSound') !== '0'; } catch (e) { return true; } }
let _audioCtx = null;
function playAlertTone() {
  try {
    _audioCtx = _audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (_audioCtx.state === 'suspended') _audioCtx.resume();
    const now = _audioCtx.currentTime;
    [880, 660].forEach((freq, i) => {
      const osc = _audioCtx.createOscillator(), gain = _audioCtx.createGain();
      osc.type = 'sine'; osc.frequency.value = freq;
      const t0 = now + i * 0.22;
      gain.gain.setValueAtTime(0, t0);
      gain.gain.linearRampToValueAtTime(0.15, t0 + 0.02);
      gain.gain.linearRampToValueAtTime(0, t0 + 0.2);
      osc.connect(gain).connect(_audioCtx.destination);
      osc.start(t0); osc.stop(t0 + 0.22);
    });
  } catch (e) {}
}
let _lastNudgeKey = null, _lastNudgeAt = 0;
function checkUrgentAlert() {
  const g = _lastGlucose, f = window._lastForecast;
  let key = null, msg = null;
  // An actual low outranks a forecast - it's happening, not projected.
  if (g && g.value != null && g.value < settings.targetLow) {
    key = 'low'; msg = `⚠️ Low now: ${g.value.toFixed(1)} mmol/L`;
  } else if (f && f.available && f.risk === 'high') {
    key = 'forecast-high'; msg = `⚠️ High hypo risk — projected ~${f.projectedLow < 3 ? 'below 3' : f.projectedLow} within ${f.horizonHours}h`;
  }
  if (!key) { _lastNudgeKey = null; return; }
  const now = Date.now();
  if (key === _lastNudgeKey && now - _lastNudgeAt < 10 * 60000) return; // don't nag more than every 10min
  _lastNudgeKey = key; _lastNudgeAt = now;
  buzz([200, 100, 200, 100, 200]);
  if (alertsEnabled()) playAlertTone();
  toast(msg, true);
}
// Settings toggle for the alert tone. Tapping "On" also plays the tone once - immediate
// confirmation, and it doubles as the user gesture that unlocks the AudioContext on mobile.
function renderAlertSeg() {
  const el = document.getElementById('alertSeg');
  if (!el) return;
  el.innerHTML = '';
  const cur = alertsEnabled() ? '1' : '0';
  [['1', '🔔 On'], ['0', '🔕 Off']].forEach(([v, label]) => {
    const b = document.createElement('button');
    b.textContent = label;
    if (cur === v) b.classList.add('on');
    b.onclick = () => { try { localStorage.setItem('alertSound', v); } catch (e) {} renderAlertSeg(); if (v === '1') playAlertTone(); };
    el.appendChild(b);
  });
}

async function loadActivities() {
  const wl = document.getElementById('workoutList');
  if (!wl.dataset.loaded) skeleton(wl, 3, true);
  try {
    const acts = await api('/api/activities');
    wl.dataset.loaded = '1';
    const today = new Date().toDateString();
    const s = acts.find(a => a.type === 'daily_summary' && new Date(a.time).toDateString() === today);
    document.getElementById('aKcal').textContent = s ? Math.round(s.activeCalories) : '—';
    document.getElementById('aExMin').textContent = s ? Math.round(s.exerciseMinutes) : '—';
    document.getElementById('aStand').textContent = s ? Math.round(s.standHours) : '—';
    document.getElementById('aSteps').textContent = (s && s.steps != null) ? Number(s.steps).toLocaleString() : '—';
    document.getElementById('aRHR').textContent = s && s.restingHeartRate ? s.restingHeartRate : '—';
    const wkAll = acts.filter(a => a.type === 'workout');
    if (!wkAll.length) { wl.innerHTML = '<div class="empty">No workouts synced yet</div>'; return; }
    const wLimit = expandedLists.workouts ? 30 : 5;
    wl.innerHTML = wkAll.slice(0, wLimit).map(w => {
      const hr = w.avgHeartRate ? ` · ❤️ ${w.avgHeartRate}bpm${w.maxHeartRate ? ' (max ' + w.maxHeartRate + ')' : ''}` : '';
      const manual = w.manual ? ' <span class="sub">· manual</span>' : '';
      const del = w.manual ? `<button class="log-del" aria-label="Delete workout" onclick="delWorkout('${w.id}')">✕</button>` : '';
      return `<div class="workout"><div class="w-icon">🏋️</div><div class="w-info"><div class="w-name">${w.workoutType || 'Exercise'}${manual}</div><div class="w-detail">${w.duration ? Math.round(w.duration) + 'min ' : ''} ${w.calories ? '· ' + Math.round(w.calories) + ' kcal ' : ''}${hr}<br>${fmtTime(new Date(w.startTime).getTime())}</div></div>${del}</div>`;
    }).join('') + showMoreBtn(wkAll.length, wLimit, expandedLists.workouts, 5, 'toggleWorkouts');
  } catch (e) { wl.innerHTML = '<div class="empty">Could not load workouts.</div>'; }
}

// ─── Insights tab ───────────────────────────────────────────────────────
async function loadInsights() {
  const el = document.getElementById('insightsList');
  if (!el.dataset.loaded) skeleton(el, 4, true);
  try {
    const ins = await api('/api/insights');
    el.dataset.loaded = '1';
    // Grouped by severity so the list reads as sections, not one long undifferentiated
    // scroll - warnings surface first regardless of the order the server derived them in.
    const sections = [['warning', '⚠️ Needs attention'], ['positive', '✅ Going well'], ['info', '💡 Worth knowing']];
    el.innerHTML = sections.map(([t, label]) => {
      const items = ins.filter(i => i.type === t);
      if (!items.length) return '';
      return `<div class="insight-group-title">${label}</div>` + items.map(i => `<div class="insight ${i.type}">${i.text}</div>`).join('');
    }).join('') || '<div class="empty">No insights yet — keep logging.</div>';
  }
  catch (e) { el.innerHTML = '<div class="empty">Could not load insights.</div>'; }
}

async function loadInsulinHealth() {
  const el = document.getElementById('insulinHealth');
  if (!el.dataset.loaded) skeleton(el, 2, true);
  try {
    const h = await api('/api/insulin-health');
    el.dataset.loaded = '1';
    if (!h.available) { el.innerHTML = `<div class="empty">${h.message}</div>`; return; }
    // Weekly time-in-range meter: tbr/tar are the fixed clinical thresholds, tir the personal
    // range - normalized so the segments always fill the bar (the 3.9-to-targetLow sliver is
    // visually negligible). Identity is position + legend label, never color alone.
    let html = '';
    if (h.tir != null) {
      const tot = (h.tbr || 0) + (h.tir || 0) + (h.tar || 0) || 100;
      const lp = (h.tbr || 0) / tot * 100, ip = (h.tir || 0) / tot * 100, ap = (h.tar || 0) / tot * 100;
      html += `<div class="tir-bar">${tirSeg('low', lp)}${tirSeg('in', ip)}${tirSeg('high', ap)}</div>
      <div class="tir-legend"><span><i class="chip" style="background:var(--red)"></i>Below 3.9 <b>${(h.tbr || 0).toFixed(0)}%</b></span><span><i class="chip" style="background:var(--green)"></i>In range <b>${h.tir}%</b></span><span><i class="chip" style="background:var(--orange)"></i>Above 10 <b>${(h.tar || 0).toFixed(0)}%</b></span></div>`;
    }
    html += `<div class="daily-grid">
      <div class="daily-stat"><div class="dv">${h.tdd}u</div><div class="dl">Avg daily dose</div></div>
      <div class="daily-stat"><div class="dv">${h.tddPerKg != null ? h.tddPerKg + 'u/kg' : '—'}</div><div class="dl">Dose per kg</div></div>
      <div class="daily-stat"><div class="dv">${h.tir != null ? h.tir + '%' : '—'}</div><div class="dl">Time in range</div></div>
    </div>
    <div class="daily-grid">
      <div class="daily-stat"><div class="dv">${h.bolusPct != null ? h.bolusPct + '%' : '—'}</div><div class="dl">Bolus share</div></div>
      <div class="daily-stat"><div class="dv">${h.basalPct != null ? h.basalPct + '%' : '—'}</div><div class="dl">Basal share</div></div>
      <div class="daily-stat"><div class="dv">${h.bmi != null ? h.bmi : '—'}</div><div class="dl">BMI</div></div>
    </div>
    <div class="daily-grid">
      <div class="daily-stat"><div class="dv" style="color:${h.tbr != null && h.tbr > 4 ? 'var(--red)' : 'inherit'}">${h.tbr != null ? h.tbr + '%' : '—'}</div><div class="dl">Below 3.9</div></div>
      <div class="daily-stat"><div class="dv" style="color:${h.tar != null && h.tar > 25 ? 'var(--orange)' : 'inherit'}">${h.tar != null ? h.tar + '%' : '—'}</div><div class="dl">Above 10.0</div></div>
      <div class="daily-stat"><div class="dv" style="color:${h.cv != null && h.cv > 36 ? 'var(--orange)' : 'inherit'}">${h.cv != null ? h.cv + '%' : '—'}</div><div class="dl">CV</div></div>
    </div>`;
    if (h.notes && h.notes.length) html += h.notes.map(n => `<div class="insight info">${n}</div>`).join('');
    else html += `<div class="insight info">No notable week-over-week changes yet.</div>`;
    el.innerHTML = html;
    animateTirBars(el);
  } catch (e) { el.innerHTML = '<div class="empty">Could not load.</div>'; }
}

// TIR meter helpers: segments render at width 0 (data-w holds the real value) and animate
// to size on the next frame via the CSS width transition. Zero segments are omitted.
function tirSeg(cls, pct) { return pct > 0.5 ? `<i class="${cls}" data-w="${pct.toFixed(1)}" style="width:0"></i>` : ''; }
function animateTirBars(scope) {
  requestAnimationFrame(() => requestAnimationFrame(() =>
    scope.querySelectorAll('.tir-bar i').forEach(i => { i.style.width = i.dataset.w + '%'; })));
}

// Sensitivity map: correction strength by time-of-day bucket (+ post-exercise vs rest),
// bars scaled to the strongest bucket, counts always visible.
async function loadSensitivityMap() {
  const el = document.getElementById('sensMap');
  if (!el.dataset.loaded) skeleton(el, 3);
  try {
    const s = await api('/api/sensitivity-map');
    el.dataset.loaded = '1';
    if (!s.available) { el.innerHTML = `<div class="empty">${s.message}</div>`; return; }
    const withData = s.buckets.filter(b => b.factor != null);
    const maxF = Math.max(...withData.map(b => b.factor), 0.1);
    let html = s.buckets.map(b => `<div class="sens-row">
      <div class="sens-name">${b.label}<span class="sub">${b.range}</span></div>
      <div class="sens-track"><i data-w="${b.factor != null ? (b.factor / maxF * 100).toFixed(0) : 0}" style="width:0"></i></div>
      <div class="sens-val">${b.factor != null ? b.factor + '/u' : '—'} <span class="n">n=${b.count}</span></div>
    </div>`).join('');
    if (s.postExercise.factor != null && s.rest.factor != null && s.postExercise.count >= 2) {
      const pct = Math.round((s.postExercise.factor / s.rest.factor - 1) * 100);
      html += `<div class="sens-note">Post-exercise (within 6h of a workout): <b>${s.postExercise.factor}/u</b> (n=${s.postExercise.count}) vs <b>${s.rest.factor}/u</b> at rest — ${pct >= 0 ? pct + '% stronger' : Math.abs(pct) + '% weaker'} when you've trained.</div>`;
    }
    html += `<div class="sens-note">mmol/L drop per unit, from ${s.total} clean resolved corrections. Low-n rows firm up as you log more. Slices the app can't see (sleep, alcohol, stress, meal fat) aren't shown rather than guessed.</div>`;
    el.innerHTML = html;
    requestAnimationFrame(() => requestAnimationFrame(() => el.querySelectorAll('.sens-track i').forEach(i => { i.style.width = i.dataset.w + '%'; })));
  } catch (e) { el.innerHTML = '<div class="empty">Could not load.</div>'; }
}

async function loadCorrHistory() {
  const el = document.getElementById('corrHistory');
  if (!el.dataset.loaded) skeleton(el, 3, true);
  try {
    const d = await api('/api/entries');
    el.dataset.loaded = '1';
    const corrsAll = d.corrections || [];
    if (!corrsAll.length) { el.innerHTML = '<div class="empty">No corrections yet</div>'; return; }
    const cLimit = expandedLists.corr ? 30 : 5;
    const corrs = corrsAll.slice(0, cLimit);
    el.innerHTML = corrs.map(c => {
      const interference = c.carbInterference ? ` · 🍬 ${c.interferingCarbs}g carbs during window (excluded from factor)` : '';
      const status = c.resolved
        ? `<span class="corr-result done">Landed at ${c.actualGlucose} (${c.dropPerUnit > 0 ? '↓' : '↑'}${Math.abs(c.dropPerUnit).toFixed(1)}/u)${c.accuracy != null ? ' · off by ' + c.accuracy.toFixed(1) : ''}${interference}</span>`
        : `<span class="corr-result pending">Waiting (~${Math.max(0, Math.round((c.time + 180*60000 - Date.now()) / 60000))}min)</span>`;
      const context = c.recentCarbs ? `<div class="log-secondary">🍬 ${c.recentCarbs}g carbs in the 2h before this correction</div>` : '';
      return `<div class="log-entry"><div class="log-left"><div class="log-dot correction"></div><div><div class="log-primary">${c.units}u correction <span class="sub">${c.startGlucose || '?'} → target ${c.predictedGlucose || '?'}</span></div><div class="log-secondary">${fmtTime(c.time)}</div>${context}${status}</div></div></div>`;
    }).join('') + showMoreBtn(corrsAll.length, cLimit, expandedLists.corr, 5, 'toggleCorr');
  } catch (e) { el.innerHTML = '<div class="empty">Could not load.</div>'; }
}

// ─── Today tab ──────────────────────────────────────────────────────────
async function loadDailySummary() {
  const el = document.getElementById('dailySummary');
  if (!el.dataset.loaded) skeleton(el, 3, true);
  try {
    const s = await api('/api/daily-summary');
    el.dataset.loaded = '1';
    // Today's time-in-range meter against the personal target range (low/high counts sum
    // exactly with readings, unlike the fixed clinical thresholds).
    let tirBar = '';
    if (s.glucose.readings > 0) {
      const lp = s.glucose.low / s.glucose.readings * 100;
      const hp = s.glucose.high / s.glucose.readings * 100;
      const ip = Math.max(0, 100 - lp - hp);
      tirBar = `<div class="tir-bar">${tirSeg('low', lp)}${tirSeg('in', ip)}${tirSeg('high', hp)}</div>
      <div class="tir-legend"><span><i class="chip" style="background:var(--red)"></i>Below ${settings.targetLow} <b>${lp.toFixed(0)}%</b></span><span><i class="chip" style="background:var(--green)"></i>In range <b>${ip.toFixed(0)}%</b></span><span><i class="chip" style="background:var(--orange)"></i>Above ${settings.targetHigh} <b>${hp.toFixed(0)}%</b></span></div>`;
    }
    el.innerHTML = `${tirBar}
    <div class="daily-grid">
      <div class="daily-stat"><div class="dv">${s.glucose.avg || '—'}</div><div class="dl">Avg glucose</div></div>
      <div class="daily-stat"><div class="dv">${s.glucose.tir || '—'}%</div><div class="dl">Time in range</div></div>
      <div class="daily-stat"><div class="dv">${s.glucose.readings}</div><div class="dl">Readings</div></div>
    </div>
    <div class="daily-grid">
      <div class="daily-stat"><div class="dv">${s.glucose.min || '—'}</div><div class="dl">Lowest</div></div>
      <div class="daily-stat"><div class="dv">${s.glucose.max || '—'}</div><div class="dl">Highest</div></div>
      <div class="daily-stat"><div class="dv" style="color:${s.glucose.low > 0 ? 'var(--red)' : 'inherit'}">${s.glucose.low}</div><div class="dl">Low events</div></div>
    </div>
    <div class="daily-grid">
      <div class="daily-stat"><div class="dv" style="color:${s.glucose.tbr != null && s.glucose.tbr > 4 ? 'var(--red)' : 'inherit'}">${s.glucose.tbr != null ? s.glucose.tbr + '%' : '—'}</div><div class="dl">Below 3.9</div></div>
      <div class="daily-stat"><div class="dv" style="color:${s.glucose.tar != null && s.glucose.tar > 25 ? 'var(--orange)' : 'inherit'}">${s.glucose.tar != null ? s.glucose.tar + '%' : '—'}</div><div class="dl">Above 10.0</div></div>
      <div class="daily-stat"><div class="dv" style="color:${s.glucose.cv != null && s.glucose.cv > 36 ? 'var(--orange)' : 'inherit'}">${s.glucose.cv != null ? s.glucose.cv + '%' : '—'}</div><div class="dl">CV</div></div>
    </div>
    <div style="border-top:1px solid var(--border);margin:12px 0;padding-top:12px">
      <div class="daily-grid">
        <div class="daily-stat"><div class="dv">${s.insulin.totalBolus}u</div><div class="dl">Total bolus</div></div>
        <div class="daily-stat"><div class="dv">${s.insulin.totalCarbs}g</div><div class="dl">Total carbs</div></div>
        <div class="daily-stat"><div class="dv">${s.insulin.totalCorrection}u</div><div class="dl">Corrections</div></div>
      </div>
      <div class="daily-grid">
        <div class="daily-stat"><div class="dv">${s.insulin.basal != null ? s.insulin.basal + 'u' : '—'}</div><div class="dl">Lantus</div></div>
        <div class="daily-stat"><div class="dv">${s.activity ? s.activity.calories : '—'}</div><div class="dl">Active kcal</div></div>
        <div class="daily-stat"><div class="dv">${s.activity ? s.activity.exerciseMins + 'm' : '—'}</div><div class="dl">Exercise</div></div>
      </div>
    </div>`;
    animateTirBars(el);
  } catch (e) { el.innerHTML = '<div class="empty">Could not load.</div>'; }
}

// ─── Settings ───────────────────────────────────────────────────────────
async function fetchSettings() {
  try {
    settings = await api('/api/settings');
    document.getElementById('settLow').value = settings.targetLow;
    document.getElementById('settHigh').value = settings.targetHigh;
    document.getElementById('settIdeal').value = settings.idealTarget || '';
    document.getElementById('settRatio').value = settings.carbRatio || '';
    document.getElementById('settHeight').value = settings.heightCm || '';
    document.getElementById('settWeight').value = settings.weightKg || '';
    document.getElementById('settSex').value = settings.sex || '';
    document.getElementById('settBodyFat').value = settings.bodyFatPct || '';
  } catch (e) {}
}

async function saveSettings() {
  const lo = parseFloat(document.getElementById('settLow').value), hi = parseFloat(document.getElementById('settHigh').value);
  const ideal = document.getElementById('settIdeal').value;
  const ratio = document.getElementById('settRatio').value;
  const height = document.getElementById('settHeight').value, weight = document.getElementById('settWeight').value;
  const sex = document.getElementById('settSex').value, bodyFat = document.getElementById('settBodyFat').value;
  const r = await api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    targetLow: lo, targetHigh: hi, idealTarget: ideal === '' ? null : ideal, carbRatio: ratio === '' ? null : ratio,
    heightCm: height === '' ? null : height, weightKg: weight === '' ? null : weight, sex: sex === '' ? null : sex, bodyFatPct: bodyFat === '' ? null : bodyFat,
  }) });
  if (r.error) { toast(r.error, true); return; }
  settings = r;
  toast('Settings saved');
}

// ─── Preset management (Settings tab) ───────────────────────────────────
async function loadPresetManager() {
  const el = document.getElementById('presetList');
  try {
    const presets = await api('/api/meal-presets');
    if (!presets.length) { el.innerHTML = '<div class="empty">No presets yet</div>'; return; }
    el.innerHTML = presets.map(p => `<div class="log-entry"><div class="log-left"><div><div class="log-primary">${p.name}</div><div class="log-secondary">${p.carbs}g</div></div></div><button class="log-del" aria-label="Remove preset" onclick="delPreset('${p.id}')">✕</button></div>`).join('');
  } catch (e) { el.innerHTML = ''; }
}
async function addPreset() {
  const name = document.getElementById('presetNameIn').value.trim();
  const carbs = parseFloat(document.getElementById('presetCarbsIn').value);
  if (!name || !carbs || carbs <= 0) return;
  const r = await api('/api/meal-presets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, carbs }) });
  if (r.error) { toast(r.error, true); return; }
  document.getElementById('presetNameIn').value = ''; document.getElementById('presetCarbsIn').value = '';
  loadPresetManager(); loadMealPresets();
}
async function delPreset(id) {
  if (!confirm('Remove this meal preset?')) return;
  await api(`/api/meal-presets/${id}`, { method: 'DELETE' });
  loadPresetManager(); loadMealPresets();
}

async function loadWorkoutPresetManager() {
  const el = document.getElementById('workoutPresetList');
  try {
    const presets = await api('/api/workout-presets');
    if (!presets.length) { el.innerHTML = '<div class="empty">No presets yet</div>'; return; }
    el.innerHTML = presets.map(p => `<div class="log-entry"><div class="log-left"><div class="log-primary">${p.name}</div></div><button class="log-del" aria-label="Remove preset" onclick="delWorkoutPreset('${p.id}')">✕</button></div>`).join('');
  } catch (e) { el.innerHTML = ''; }
}
async function addWorkoutPreset() {
  const name = document.getElementById('workoutPresetNameIn').value.trim();
  if (!name) return;
  const r = await api('/api/workout-presets', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
  if (r.error) { toast(r.error, true); return; }
  document.getElementById('workoutPresetNameIn').value = '';
  loadWorkoutPresetManager(); loadWorkoutPresets();
}
async function delWorkoutPreset(id) {
  if (!confirm('Remove this workout preset?')) return;
  await api(`/api/workout-presets/${id}`, { method: 'DELETE' });
  loadWorkoutPresetManager(); loadWorkoutPresets();
}

// ─── Quick-select preset rows (Track / Activity tabs) ───────────────────
// Meal presets: the user's own regular meals (e.g. "Coffee" = 10g) instead of generic
// round-number carb amounts. Re-fetched/re-rendered whenever Settings adds or removes one.
let mealPresets = [];
async function loadMealPresets() {
  try { mealPresets = await api('/api/meal-presets'); } catch (e) { mealPresets = []; }
  const qcEl = document.getElementById('qc');
  qcEl.innerHTML = '';
  if (!mealPresets.length) { qcEl.innerHTML = '<div class="empty" style="padding:8px 0">No meal presets yet — add your regulars in Settings</div>'; return; }
  mealPresets.forEach(p => {
    const b = document.createElement('button');
    b.textContent = `${p.name} (${p.carbs}g)`;
    b.onclick = () => {
      document.getElementById('carbIn').value = p.carbs;
      qcEl.querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      _selectedMeal = p.name; // tags the log for meal memory + boosts same-meal suggestion weighting
      updateBolusBtn(); updateMealSuggestion(); loadMealMemory(p.name);
    };
    qcEl.appendChild(b);
  });
}

// Meal memory: what this exact meal has done before - peak, timing, return to range, low
// risk after, and whether it behaves like a delayed-rise (high fat/protein) meal. Renders
// when a preset is tapped; "the usual lunch" instead of "28g".
let _selectedMeal = null;
async function loadMealMemory(name) {
  const el = document.getElementById('mealMemory');
  try {
    const m = await api('/api/meal-memory?name=' + encodeURIComponent(name));
    if (!m.available) { el.innerHTML = `<div class="suggest-box" style="opacity:.85">📒 ${m.message}</div>`; return; }
    const lowStyle = m.lowRiskAfter === 'high' ? 'color:var(--red);font-weight:700' : m.lowRiskAfter === 'moderate' ? 'color:#c2410c;font-weight:700' : '';
    el.innerHTML = `<div class="suggest-box">📒 <b>${name}</b> — logged ${m.count}x (${m.analyzed} with glucose data):<br>
      Avg peak <b>${m.avgPeak}</b> mmol/L ~${m.timeToPeak} after · back in range ~<b>${m.returnToRange}</b> · low risk after: <span style="${lowStyle}">${m.lowRiskAfter}</span>
      ${m.delayedRise.flag ? `<br>⚠️ <b>Delayed-rise meal:</b> similar logs climbed again ~${m.delayedRise.atHours}h later — the high-fat/protein pattern. Worth a glance around then.` : ''}</div>`;
  } catch (e) { el.innerHTML = ''; }
}

// Workout presets: same pattern, but just a name (no fixed "amount"). Keeps workout-type
// naming consistent instead of retyping slightly different names each time (which would
// otherwise fragment the exercise-pattern insights, which group by exact name).
let workoutPresets = [];
async function loadWorkoutPresets() {
  try { workoutPresets = await api('/api/workout-presets'); } catch (e) { workoutPresets = []; }
  const qcEl = document.getElementById('workoutQc');
  qcEl.innerHTML = '';
  if (!workoutPresets.length) { qcEl.innerHTML = '<div class="empty" style="padding:8px 0">No workout presets yet — add your regulars in Settings</div>'; return; }
  workoutPresets.forEach(p => {
    const b = document.createElement('button');
    b.textContent = p.name;
    b.onclick = () => { document.getElementById('workoutTypeIn').value = p.name; qcEl.querySelectorAll('button').forEach(x => x.classList.remove('on')); b.classList.add('on'); document.getElementById('addWorkoutBtn').disabled = false; updateWorkoutAdvice(); };
    qcEl.appendChild(b);
  });
}

// ─── Backdated logging ──────────────────────────────────────────────────
// Each form has a hidden datetime-local input revealed by a "Backdate" toggle. Left closed,
// no time is sent and the server defaults to now.
function toLocalDatetimeValue(ts) { const d = new Date(ts), pad = n => String(n).padStart(2, '0'); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function nowLocalDatetimeValue() { return toLocalDatetimeValue(Date.now()); }
function getEntryTime(inputId) { const el = document.getElementById(inputId); if (el && el.classList.contains('vis') && el.value) return new Date(el.value).getTime(); return undefined; }
function resetBackdate(toggleId, inputId) { const t = document.getElementById(toggleId), i = document.getElementById(inputId); i.classList.remove('vis'); i.value = ''; t.textContent = '🕐 Backdate'; }
function setupBackdate(toggleId, inputId) {
  const toggle = document.getElementById(toggleId), input = document.getElementById(inputId);
  toggle.addEventListener('click', () => {
    const v = input.classList.toggle('vis');
    toggle.textContent = v ? '🕐 Logging for now (tap to reset)' : '🕐 Backdate';
    if (v && !input.value) input.value = nowLocalDatetimeValue(); else if (!v) input.value = '';
  });
}

// ─── Logging actions ────────────────────────────────────────────────────
async function addBolus() {
  const u = parseFloat(document.getElementById('bolusIn').value), c = parseFloat(document.getElementById('carbIn').value);
  if (!(u > 0) && !(c > 0)) return;
  const r = await api('/api/entries/bolus', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ units: u > 0 ? u : 0, carbs: c > 0 ? c : null, time: getEntryTime('bolusTimeIn'), mealName: _selectedMeal }) });
  if (r && r.error) { toast(r.error, true); return; }
  buzz();
  _selectedMeal = null;
  document.getElementById('bolusIn').value = ''; document.getElementById('carbIn').value = '';
  document.getElementById('mealSuggestion').innerHTML = '';
  document.getElementById('mealMemory').innerHTML = '';
  // Scoped to #qc - clearing every .qc button would also wipe the workout preset row's
  // selected state on the Activity tab (they're deliberately independent).
  document.querySelectorAll('#qc button').forEach(b => b.classList.remove('on'));
  resetBackdate('bolusTimeToggle', 'bolusTimeIn');
  updateBolusBtn();
  fetchEntries(); loadChart(); loadForecast(); // fresh insulin/carbs change the 2h forecast
}

async function addBasal() {
  const u = parseFloat(document.getElementById('basalIn').value);
  if (!u || u <= 0) return;
  const r = await api('/api/entries/basal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ units: u, time: getEntryTime('basalTimeIn') }) });
  if (r && r.error) { toast(r.error, true); return; }
  buzz();
  document.getElementById('basalIn').value = '';
  document.getElementById('basalForm').classList.remove('vis');
  document.getElementById('basalToggle').textContent = 'Add';
  resetBackdate('basalTimeToggle', 'basalTimeIn');
  fetchEntries();
}

async function addCorrection() {
  const u = parseFloat(document.getElementById('corrUnitsIn').value), t = parseFloat(document.getElementById('corrTargetIn').value);
  if (!u || u <= 0) return;
  const r = await api('/api/entries/correction', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ units: u, predictedGlucose: isNaN(t) ? null : t, time: getEntryTime('corrTimeIn') }) });
  if (r && r.error) { toast(r.error, true); return; }
  buzz();
  document.getElementById('corrUnitsIn').value = ''; document.getElementById('corrTargetIn').value = '';
  document.getElementById('addCorrBtn').disabled = true;
  document.getElementById('corrSuggestion').innerHTML = '';
  resetBackdate('corrTimeToggle', 'corrTimeIn');
  fetchEntries(); loadChart(); loadForecast();
}

async function delEntry(t, id) {
  if (!confirm('Delete this entry?')) return;
  await api(`/api/entries/${t}/${id}`, { method: 'DELETE' });
  fetchEntries(); loadChart(); loadForecast();
}

async function addWorkout() {
  const type = document.getElementById('workoutTypeIn').value.trim();
  if (!type) return;
  const dur = parseFloat(document.getElementById('workoutDurIn').value);
  const cal = parseFloat(document.getElementById('workoutCalIn').value);
  const r = await api('/api/activities/workout', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({
    workoutType: type, duration: isNaN(dur) ? null : dur, calories: isNaN(cal) ? null : cal, time: getEntryTime('workoutTimeIn'),
  }) });
  if (r && r.error) { toast(r.error, true); return; }
  buzz();
  document.getElementById('workoutTypeIn').value = ''; document.getElementById('workoutDurIn').value = ''; document.getElementById('workoutCalIn').value = '';
  document.getElementById('addWorkoutBtn').disabled = true;
  document.getElementById('workoutAdvice').innerHTML = '';
  document.querySelectorAll('#workoutQc button').forEach(b => b.classList.remove('on'));
  resetBackdate('workoutTimeToggle', 'workoutTimeIn');
  loadActivities();
  loadAlerts(); // a just-logged workout may open a drop-window alert immediately
}

async function delWorkout(id) {
  if (!confirm('Delete this workout?')) return;
  await api(`/api/activities/workout/${id}`, { method: 'DELETE' });
  loadActivities();
}

// ─── In-place entry editing ─────────────────────────────────────────────
function startEdit(kind, id) { editingEntry = { kind, id: String(id) }; render(); }
function cancelEdit() { editingEntry = null; render(); }
async function saveEdit(kind, id) {
  const body = {};
  if (kind === 'bolus') {
    const c = parseFloat(document.getElementById('editCarbs').value), u = parseFloat(document.getElementById('editUnits').value);
    body.carbs = isNaN(c) ? null : c; body.units = isNaN(u) ? 0 : u;
    if ((!body.units || body.units <= 0) && (!body.carbs || body.carbs <= 0)) return;
  } else if (kind === 'basal') {
    const u = parseFloat(document.getElementById('editUnits').value);
    if (!u || u <= 0) return;
    body.units = u;
  } else {
    const u = parseFloat(document.getElementById('editUnits').value);
    if (!u || u <= 0) return;
    body.units = u;
    const t = parseFloat(document.getElementById('editTarget').value);
    body.predictedGlucose = isNaN(t) ? null : t;
  }
  const timeEl = document.getElementById('editTime');
  if (timeEl && timeEl.value) body.time = new Date(timeEl.value).getTime();
  const r = await api(`/api/entries/${kind}/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (r && r.error) { toast(r.error, true); return; }
  editingEntry = null;
  fetchEntries(); loadChart();
}

function editFormHTML(e) {
  if (e.kind === 'bolus') {
    return `<div class="log-entry edit-entry">
      <div class="edit-grid">
        <div class="ig"><label>Carbs (g)</label><input type="number" inputmode="decimal" id="editCarbs" value="${e.carbs ?? ''}"></div>
        <div class="ig"><label>Novorapid (u)</label><input type="number" inputmode="decimal" id="editUnits" value="${e.units || ''}"></div>
      </div>
      <div class="ig" style="margin-bottom:10px"><label>Logged at</label><input type="datetime-local" id="editTime" value="${toLocalDatetimeValue(e.time)}"></div>
      <div class="edit-actions"><button class="btn btn-blue btn-sm" onclick="saveEdit('bolus','${e.id}')">Save</button><button class="btn btn-sm" style="background:var(--bg);color:var(--dim)" onclick="cancelEdit()">Cancel</button></div>
    </div>`;
  }
  if (e.kind === 'basal') {
    return `<div class="log-entry edit-entry">
      <div class="ig"><label>Units</label><input type="number" inputmode="decimal" id="editUnits" value="${e.units}"></div>
      <div class="ig" style="margin-bottom:10px"><label>Logged at</label><input type="datetime-local" id="editTime" value="${toLocalDatetimeValue(e.time)}"></div>
      <div class="edit-actions"><button class="btn btn-blue btn-sm" onclick="saveEdit('basal','${e.id}')">Save</button><button class="btn btn-sm" style="background:var(--bg);color:var(--dim)" onclick="cancelEdit()">Cancel</button></div>
    </div>`;
  }
  return `<div class="log-entry edit-entry">
    <div class="edit-grid">
      <div class="ig"><label>Novorapid (u)</label><input type="number" inputmode="decimal" id="editUnits" value="${e.units}"></div>
      <div class="ig"><label>Target (mmol/L)</label><input type="number" inputmode="decimal" id="editTarget" value="${e.predictedGlucose ?? ''}"></div>
    </div>
    <div class="ig" style="margin-bottom:6px"><label>Logged at</label><input type="datetime-local" id="editTime" value="${toLocalDatetimeValue(e.time)}"></div>
    <div class="edit-hint">Editing units or time resets its resolution status (it'll re-resolve automatically).</div>
    <div class="edit-actions"><button class="btn btn-orange btn-sm" onclick="saveEdit('correction','${e.id}')">Save</button><button class="btn btn-sm" style="background:var(--bg);color:var(--dim)" onclick="cancelEdit()">Cancel</button></div>
  </div>`;
}

// ─── Dose suggestions ───────────────────────────────────────────────────
async function updateCorrSuggestion() {
  const uRaw = document.getElementById('corrUnitsIn').value;
  const u = parseFloat(uRaw);
  const el = document.getElementById('corrSuggestion');
  try {
    const r = await api('/api/correction-factor');
    let html = '';
    // Proactive suggestion from how far above the ideal target you are right now - shown even
    // before typing anything, with a one-tap "Use" to fill the units field.
    if (r.stale) {
      html += `<div class="suggest-box" style="background:var(--orange-l);color:#c2410c">⚠️ Last reading is ~${r.readingAgeMinutes}min old — check your Libre app before dosing off this.</div>`;
    }
    // The do-not-stack caution outranks everything else here - it targets exactly the
    // tired/frustrated moment where a second correction feels right but isn't.
    if (r.stackingCaution) {
      html += `<div class="suggest-box" style="background:var(--red-l);color:var(--red)">🛑 ${r.stackingCaution}</div>`;
    }
    if (r.factorTooLow) {
      html += `<div class="suggest-box" style="background:var(--orange-l);color:#c2410c">Your correction factor (${r.factor}/unit) looks too low to be reliable — not confident enough to suggest a dose yet. Log a few more corrections without carbs nearby to firm this up.</div>`;
    } else if (r.suggestedUnits != null) {
      if (r.suggestedUnits > 0) {
        // Show what the number already accounts for - insulin still active and the trend
        // projection - so the smaller-than-naive suggestion reads as deliberate, not broken.
        const bits = [];
        if (r.projectedGlucose != null) bits.push(`trending toward ~${r.projectedGlucose}`);
        if (r.iob > 0.1) bits.push(`${r.iob}u on board subtracted`);
        const detail = bits.length ? `; ${bits.join(', ')}` : '';
        html += `<div class="suggest-box">Suggested: ${r.suggestedUnits}u (currently ${r.currentGlucose} mmol/L vs your ${r.idealTarget} target${detail})${uRaw === '' ? ` <button type="button" onclick="useCorrSuggestion(${r.suggestedUnits})" style="width:auto;padding:3px 10px;margin-left:4px;border-radius:6px;border:none;background:var(--blue);color:#fff;font-size:11px;font-weight:600;cursor:pointer">Use</button>` : ''}</div>`;
      } else if (r.coveredByIOB) {
        html += `<div class="suggest-box">You're above target, but the ${r.iob}u still active should cover it — re-check in 30–45min before adding more.</div>`;
      } else {
        html += `<div class="suggest-box">You're at ${r.currentGlucose} mmol/L, at or below your ${r.idealTarget} target — no correction needed.</div>`;
      }
    }
    if (u && u > 0) {
      if (r.factor) { const drop = (r.factor * u).toFixed(1); html += `<div class="suggest-box">Based on ${r.count} previous corrections, ${u}u typically drops glucose by ~${drop} mmol/L (${r.factor.toFixed(1)}/unit)</div>`; }
      else { html += `<div class="suggest-box">Log ${3 - r.count} more corrections to get a personalised prediction</div>`; }
    }
    if (r.recentCarbs) html += `<div class="suggest-box" style="background:var(--orange-l);color:#c2410c">⚠️ ${r.recentCarbs}g carbs logged in the last 2h — this correction's effect may be less predictable</div>`;
    el.innerHTML = html;
  } catch (e) { el.innerHTML = ''; }
}
function useCorrSuggestion(u) { const el = document.getElementById('corrUnitsIn'); el.value = u; el.dispatchEvent(new Event('input')); }
function useMealSuggestion(u) { const el = document.getElementById('bolusIn'); el.value = u; el.dispatchEvent(new Event('input')); }

async function updateMealSuggestion() {
  const c = parseFloat(document.getElementById('carbIn').value);
  const el = document.getElementById('mealSuggestion');
  if (!c || c <= 0) { el.innerHTML = ''; return; }
  try {
    const r = await api('/api/meal-suggestion?carbs=' + c + (_selectedMeal ? '&meal=' + encodeURIComponent(_selectedMeal) : ''));
    if (r.suggestion != null) {
      // One-tap "Use" mirrors the correction card - the app shouldn't tell you a number and
      // then make you type it.
      const useBtn = (r.suggestion > 0 && !document.getElementById('bolusIn').value)
        ? ` <button type="button" onclick="useMealSuggestion(${r.suggestion})" style="width:auto;padding:3px 10px;margin-left:4px;border-radius:6px;border:none;background:var(--blue);color:#fff;font-size:11px;font-weight:600;cursor:pointer">Use</button>` : '';
      el.innerHTML = `<div class="suggest-box">Suggested dose: ~${r.suggestion}u for ${c}g (based on ${r.basedOn} similar past meals)${useBtn}${r.note ? '<br>' + r.note : ''}</div>`;
    }
    else { el.innerHTML = `<div class="suggest-box">${r.message || 'Log a few more meals to get personalised suggestions.'}</div>`; }
  } catch (e) { el.innerHTML = ''; }
}

function updateBolusBtn() {
  const u = parseFloat(document.getElementById('bolusIn').value), c = parseFloat(document.getElementById('carbIn').value);
  const btn = document.getElementById('addBolusBtn');
  btn.disabled = !((u > 0) || (c > 0));
  btn.textContent = (u > 0) ? '＋ Log bolus' : '＋ Log carbs (no insulin)';
}

// ─── "What if I..." simulator ───────────────────────────────────────────
// Canned presets span the real spread of activity - golf, a walk and heavy lifting are not
// the same body. Typing a type name you've logged 2+ times uses YOUR profile instead.
const SIM_PRESETS = [
  { label: '15min walk', type: 'Walk', minutes: 15, intensity: 'light' },
  { label: '30min walk', type: 'Walk', minutes: 30, intensity: 'light' },
  { label: 'Gym session', type: 'Gym', minutes: 45, intensity: 'moderate' },
  { label: 'Heavy weights', type: 'Heavy weights', minutes: 45, intensity: 'vigorous' },
  { label: 'Golf', type: 'Golf', minutes: 120, intensity: 'light' },
  { label: 'Driving range', type: 'Driving range', minutes: 45, intensity: 'light' },
  { label: 'Housework/garden', type: 'Housework', minutes: 60, intensity: 'light' },
  { label: 'Play with kids', type: 'Play', minutes: 30, intensity: 'moderate' },
];
let _simSelected = null;
function renderSimPresets() {
  const el = document.getElementById('simPresets');
  if (!el || el.childElementCount) return;
  SIM_PRESETS.forEach(p => {
    const b = document.createElement('button');
    b.textContent = p.label;
    b.onclick = () => {
      _simSelected = p;
      el.querySelectorAll('button').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      document.getElementById('simDur').value = p.minutes;
      document.getElementById('simInt').value = p.intensity;
      runSimulation();
    };
    el.appendChild(b);
  });
}
async function runSimulation() {
  const el = document.getElementById('simResult');
  const minutes = parseFloat(document.getElementById('simDur').value) || (_simSelected ? _simSelected.minutes : 30);
  const intensity = document.getElementById('simInt').value;
  const type = _simSelected ? _simSelected.type : '';
  skeleton(el, 2, true);
  try {
    const s = await api(`/api/simulate?type=${encodeURIComponent(type)}&minutes=${minutes}&intensity=${intensity}`);
    if (!s.available) { el.innerHTML = `<div class="suggest-box">${s.message}</div>`; return; }
    if (s.rises) { el.innerHTML = `<div class="suggest-box">${s.advice}<br><span style="opacity:.75">Based on ${s.basis}.</span></div>`; return; }
    const rangeTxt = s.range[0] < 3 ? `below 3–${s.range[1]}` : `${s.range[0]}–${s.range[1]}`;
    const riskStyle = s.delayedRisk === 'high' ? 'background:var(--red-l);color:var(--red)' : s.delayedRisk === 'moderate' ? 'background:var(--orange-l);color:#c2410c' : '';
    el.innerHTML = `<div class="suggest-box" style="${riskStyle}">
      <b>Likely range after:</b> ${rangeTxt} mmol/L (from ${s.current}${s.iob > 0.1 ? `, ${s.iob}u on board` : ''})<br>
      <b>Delayed low risk:</b> ${s.delayedRisk} · <b>watch period:</b> ${s.watchPeriod}
      ${s.carbs ? `<br>🍬 ${s.carbs}` : ''}
      <br><span style="opacity:.75">Based on ${s.basis}.${s.calibrated ? '' : ' Estimates are rough until a few corrections calibrate your ratios.'}${s.stale ? ' ⚠️ Reading may be stale — check your Libre app.' : ''}</span>
    </div>`;
  } catch (e) { el.innerHTML = ''; }
}

// Pre-workout advisor: as soon as a workout type is picked/typed, project what that workout
// historically does against current glucose/trend/IOB - the answer to "I'm about to do X,
// what should I do about it" before the session starts, not after.
async function updateWorkoutAdvice() {
  const type = document.getElementById('workoutTypeIn').value.trim();
  const el = document.getElementById('workoutAdvice');
  if (!type) { el.innerHTML = ''; return; }
  try {
    const a = await api('/api/workout-advice?type=' + encodeURIComponent(type));
    const style = a.risk === 'high' ? 'background:var(--red-l);color:var(--red)'
      : a.risk === 'caution' ? 'background:var(--orange-l);color:#c2410c' : '';
    el.innerHTML = `<div class="suggest-box" style="${style}">${a.advice}</div>`;
  } catch (e) { el.innerHTML = ''; }
}

// Suggestion lookups hit the API; debounce the keystroke-driven ones so typing "45" doesn't
// fire a request for "4" first. Preset taps and glucose refreshes still call directly.
const debouncedMealSuggestion = debounce(updateMealSuggestion, 300);
const debouncedCorrSuggestion = debounce(updateCorrSuggestion, 300);
const debouncedWorkoutAdvice = debounce(updateWorkoutAdvice, 400);

// ─── Basal status ───────────────────────────────────────────────────────
// Basal (Lantus) is once every 24h - surface a countdown, and make the card impossible to
// miss once overdue (red pulsing border/background) rather than a plain "last dose" readout.
function updateBasalStatus() {
  const card = document.getElementById('basalCard'), statusEl = document.getElementById('basalStatus');
  card.classList.remove('basal-due-soon', 'basal-overdue');
  const lba = basalDoses[0];
  if (!lba) { statusEl.textContent = 'No basal logged yet'; return; }
  const hoursLeft = 24 - (Date.now() - lba.time) / 3600000;
  if (hoursLeft > 0) {
    const h = Math.floor(hoursLeft), m = Math.round((hoursLeft - h) * 60);
    statusEl.textContent = `Next dose due in ${h}h ${m}m`;
    if (hoursLeft <= 2) card.classList.add('basal-due-soon');
  } else {
    const overdue = -hoursLeft, h = Math.floor(overdue), m = Math.round((overdue - h) * 60);
    statusEl.textContent = `⚠️ Overdue by ${h}h ${m}m`;
    card.classList.add('basal-overdue');
  }
}

// ─── Main render ────────────────────────────────────────────────────────
// The IOB/COB tiles carry a drain bar (fraction of the contributing doses/carbs still
// active) plus a "peaks in Xm" / "gone by HH:MM" microtext, so a glance says not just how
// much is on board but where in its curve it is.
function renderDecayTile(barId, subId, remaining, doses, peakMin, durMin, noun) {
  const now = Date.now();
  const bar = document.getElementById(barId), sub = document.getElementById(subId);
  if (!doses.length || remaining <= 0.05) { bar.style.width = '0%'; sub.textContent = `no ${noun} active`; return; }
  const total = doses.reduce((s, x) => s + x.amt, 0);
  bar.style.width = Math.min(100, remaining / total * 100) + '%';
  const youngestAge = Math.min(...doses.map(x => now - x.time)) / 60000;
  if (peakMin && youngestAge < peakMin) sub.textContent = `peaks in ~${Math.round(peakMin - youngestAge)}m`;
  else sub.textContent = `gone by ${fmtClock(Math.max(...doses.map(x => x.time)) + durMin * 60000)}`;
}

function render() {
  document.getElementById('iob').innerHTML = calcIOB().toFixed(1) + '<span class="u">u</span>';
  document.getElementById('cob').innerHTML = calcCOB().toFixed(0) + '<span class="u">g</span>';
  const now = Date.now();
  renderDecayTile('iobBar', 'iobSub', calcIOB(),
    [...boluses, ...corrections].filter(x => x.units > 0 && now - x.time < IOB_DIA * 60000).map(x => ({ time: x.time, amt: x.units })),
    IOB_PEAK, IOB_DIA, 'insulin');
  renderDecayTile('cobBar', 'cobSub', calcCOB(),
    boluses.filter(x => x.carbs > 0 && now - x.time < COB_DURATION * 60000).map(x => ({ time: x.time, amt: x.carbs })),
    null, COB_DURATION, 'carbs');
  const lb = boluses[0];
  document.getElementById('lastCarbs').innerHTML = (lb && lb.carbs != null ? lb.carbs : '—') + '<span class="u">g</span>';
  document.getElementById('lastCarbsSub').textContent = lb && lb.carbs != null ? timeAgo(lb.time) : '';
  document.getElementById('lastBolus').textContent = lb ? (lb.units > 0 ? lb.units + 'u · ' + timeAgo(lb.time) : 'Carbs only · ' + timeAgo(lb.time)) : 'None';
  const lba = basalDoses[0];
  document.getElementById('lastBasal').textContent = lba ? lba.units + 'u · ' + timeAgo(lba.time) : 'None';
  updateBasalStatus();
  // Day-grouped, capped log: headers carry the date so each row only needs a clock time,
  // and the list stays a screenful with a "Show more" expander instead of an endless scroll.
  const all = [...boluses.map(b => ({ ...b, kind: 'bolus' })), ...basalDoses.map(b => ({ ...b, kind: 'basal' })), ...corrections.map(c => ({ ...c, kind: 'correction' }))].sort((a, b) => b.time - a.time);
  const log = document.getElementById('logList');
  if (!all.length) { log.innerHTML = '<div class="empty">No entries yet</div>'; return; }
  const limit = expandedLists.log ? 60 : 10;
  let html = '', lastDay = null;
  all.slice(0, limit).forEach(e => {
    const day = dayLabel(e.time);
    if (day !== lastDay) { html += `<div class="day-head">${day}</div>`; lastDay = day; }
    if (editingEntry && editingEntry.kind === e.kind && editingEntry.id === String(e.id)) { html += editFormHTML(e); return; }
    let label, detail = '';
    if (e.kind === 'bolus') { label = e.units > 0 ? `Novorapid · ${e.units}u` : '🍬 Carbs only'; if (e.carbs != null) label += ` <span class="sub">· ${e.carbs}g</span>`; }
    else if (e.kind === 'basal') { label = `Lantus · ${e.units}u`; }
    else { label = `⚡ Correction · ${e.units}u`; detail = e.resolved ? ` <span class="sub">→ ${e.actualGlucose}</span>` : (e.startGlucose ? ` <span class="sub">from ${e.startGlucose}</span>` : ''); }
    html += `<div class="log-entry"><div class="log-left"><div class="log-dot ${e.kind}"></div><div><div class="log-primary">${label}${detail}</div><div class="log-secondary">${fmtClock(e.time)}</div></div></div><div class="log-actions"><button class="log-edit" aria-label="Edit entry" onclick="startEdit('${e.kind}','${e.id}')">✎</button><button class="log-del" aria-label="Delete entry" onclick="delEntry('${e.kind}','${e.id}')">✕</button></div></div>`;
  });
  html += showMoreBtn(all.length, limit, expandedLists.log, 10, 'toggleLog');
  log.innerHTML = html;
}

// ─── Glucose chart ──────────────────────────────────────────────────────
// All colors come from CSS vars (cssVar) so the canvas follows the active theme; the last
// draw's data + scales are cached on window._chart so scrubbing and theme switches can
// redraw without refetching. opts.scrubIdx draws the crosshair + enlarged marker for that
// data point (the scrub overlay handles the HTML tooltip).
function ensureChartOverlays() {
  const wrap = document.querySelector('.chart-wrap');
  if (!wrap || document.getElementById('liveDot')) return;
  const dot = document.createElement('div'); dot.id = 'liveDot'; dot.className = 'live-dot'; dot.style.display = 'none';
  const tip = document.createElement('div'); tip.id = 'chartTip'; tip.className = 'chart-tip';
  wrap.appendChild(dot); wrap.appendChild(tip);
}

function drawChart(data, events = [], opts = {}) {
  const canvas = document.getElementById('glucoseChart');
  ensureChartOverlays();
  const liveDot = document.getElementById('liveDot');
  if (!canvas || !data || data.length < 2) { window._chart = null; if (liveDot) liveDot.style.display = 'none'; return; }
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  // Hidden panel (e.g. a theme change while another tab is open) measures 0x0 - drawing
  // into that wipes the canvas and corrupts the cached scales. Keep the previous state and
  // let showTab('track') repaint from it when the panel is visible again.
  if (!rect.width || !rect.height) { if (liveDot) liveDot.style.display = 'none'; return; }
  canvas.width = rect.width * dpr; canvas.height = rect.height * dpr;
  canvas.style.width = rect.width + 'px'; canvas.style.height = rect.height + 'px';
  ctx.scale(dpr, dpr);
  const W = rect.width, H = rect.height, pad = { t: 14, b: 20, l: 35, r: 10 };
  const cW = W - pad.l - pad.r, cH = H - pad.t - pad.b;
  // Forecast projection: when the reading is fresh enough, the x-domain extends 2h past the
  // last point so the hypo forecast draws ON the chart, not just as text. Constant across
  // scrub redraws so the crosshair geometry never shifts mid-drag.
  const fc = window._lastForecast;
  const lastPt = data[data.length - 1];
  const showFc = !!(fc && fc.available && (Date.now() - lastPt.time) < 45 * 60000);
  const fcTime = showFc ? lastPt.time + fc.horizonHours * 3600000 : null;
  const vals = data.map(d => d.value);
  let mn = Math.min(...vals, 3.5, showFc ? fc.projectedLow : 3.5), mx = Math.max(...vals, 12);
  // Floor the axis at 2: the sensor bottoms out around 2.2, and a forecast projectedLow can go
  // arithmetically negative (stacked insulin), which would otherwise drag the y-axis below zero.
  mn = Math.max(2, Math.floor(mn)); mx = Math.ceil(mx);
  const tMin = data[0].time, tMax = showFc ? fcTime : data[data.length - 1].time, tRange = tMax - tMin || 1;
  const x = t => (pad.l + ((t - tMin) / tRange) * cW);
  const y = v => (pad.t + cH - (((v - mn) / (mx - mn)) * cH));
  window._chart = { data, events, x, y, pad, W, H, cW, cH, tMin, tMax, tRange };

  const lineColor = cssVar('--blue');
  const dotColor = v => cssVar(statusColorVar(v));

  // Target-range band
  ctx.fillStyle = cssVar('--c-band');
  ctx.fillRect(pad.l, y(settings.targetHigh), cW, y(settings.targetLow) - y(settings.targetHigh));

  // Grid
  ctx.strokeStyle = cssVar('--c-grid'); ctx.lineWidth = 0.5; ctx.fillStyle = cssVar('--c-label'); ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
  for (let v = mn; v <= mx; v += 2) { ctx.beginPath(); ctx.moveTo(pad.l, y(v)); ctx.lineTo(W - pad.r, y(v)); ctx.stroke(); ctx.fillText(v, pad.l - 4, y(v) + 3); }

  // Time labels - anchored to actual clock-hour boundaries within the visible range (not
  // wherever a data point happens to fall). Placing a label at "the first data point seen
  // in each hour" breaks down when readings are gapped (e.g. sensor/network lag): two
  // adjacent hours can each have their only representative point land right next to the
  // hour boundary, so their labels render almost on top of each other. Hour boundaries are
  // evenly spaced by construction, so this can't happen here.
  ctx.textAlign = 'center';
  const pxPerHour = cW / (tRange / 3600000);
  const hourStep = Math.max(1, Math.ceil(40 / pxPerHour));
  const firstHourMs = Math.ceil(tMin / 3600000) * 3600000;
  for (let t = firstHourMs; t <= tMax; t += 3600000 * hourStep) {
    ctx.fillText(new Date(t).getHours() + ':00', x(t), H - 2);
  }

  // Insulin activity overlay - filled area showing summed Novorapid activity (bell-shaped,
  // peaking ~75min after each dose, per the same exponential model as the IOB tile), so you
  // can see when injected insulin was actually working hardest, not just that a dose happened.
  // Doses are summed at each sample point, so overlapping boluses/corrections render as one
  // merged curve rather than stacking separately.
  const doseEvents = events.filter(e => (e.type === 'bolus' && e.units > 0) || e.type === 'correction');
  if (doseEvents.length) {
    const maxHeight = cH * 0.35;
    const peakScale = _iobActivityPeak * IOB_CHART_SCALE_UNITS;
    ctx.beginPath();
    ctx.moveTo(x(data[0].time), pad.t + cH);
    data.forEach(d => {
      let total = 0;
      doseEvents.forEach(e => { const mins = (d.time - e.time) / 60000; total += e.units * iobActivityFraction(mins); });
      const hFrac = Math.min(1, total / peakScale);
      ctx.lineTo(x(d.time), pad.t + cH - hFrac * maxHeight);
    });
    ctx.lineTo(x(data[data.length - 1].time), pad.t + cH);
    ctx.closePath();
    ctx.fillStyle = cssVar('--c-iob');
    ctx.fill();
  }

  // Gradient wash under the glucose line - fades to transparent at the baseline.
  const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + cH);
  grad.addColorStop(0, hexToRgba(lineColor, 0.16));
  grad.addColorStop(1, hexToRgba(lineColor, 0));
  ctx.beginPath();
  data.forEach((d, i) => { i === 0 ? ctx.moveTo(x(d.time), y(d.value)) : ctx.lineTo(x(d.time), y(d.value)); });
  ctx.lineTo(x(data[data.length - 1].time), pad.t + cH);
  ctx.lineTo(x(data[0].time), pad.t + cH);
  ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  // Glucose line
  ctx.beginPath(); ctx.strokeStyle = lineColor; ctx.lineWidth = 2; ctx.lineJoin = 'round';
  data.forEach((d, i) => { i === 0 ? ctx.moveTo(x(d.time), y(d.value)) : ctx.lineTo(x(d.time), y(d.value)); });
  ctx.stroke();

  // Glucose dots, coloured against the user's own target range
  data.forEach(d => { ctx.fillStyle = dotColor(d.value); ctx.beginPath(); ctx.arc(x(d.time), y(d.value), 2, 0, Math.PI * 2); ctx.fill(); });

  // Forecast projection: dotted risk-colored line from the last reading to the 2h forecast
  // point, hollow end marker + value label - the risk card's number, made visible in place.
  if (showFc) {
    // Clamp the drawn endpoint to the axis floor so a sub-2 (or negative) projection sits on the
    // bottom edge rather than painting off-canvas into the x-axis labels; the label text still
    // conveys the true severity ("<3") instead of an impossible number.
    const fcDrawVal = Math.max(mn, fc.projectedLow);
    const fcLabel = fc.projectedLow < 3 ? '<3' : '~' + fc.projectedLow;
    const riskColor = cssVar(fc.risk === 'high' ? '--red' : fc.risk === 'moderate' ? '--orange' : fc.risk === 'low' ? '--blue' : '--green');
    ctx.strokeStyle = riskColor; ctx.lineWidth = 2; ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(x(lastPt.time), y(lastPt.value)); ctx.lineTo(x(fcTime), y(fcDrawVal)); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(x(fcTime), y(fcDrawVal), 4, 0, Math.PI * 2);
    ctx.fillStyle = cssVar('--card'); ctx.fill();
    ctx.strokeStyle = riskColor; ctx.lineWidth = 2; ctx.stroke();
    ctx.fillStyle = riskColor; ctx.font = 'bold 10px sans-serif'; ctx.textAlign = 'right';
    ctx.fillText(fcLabel, x(fcTime) - 3, Math.max(pad.t + 10, y(fcDrawVal) - 8));
  }

  // Event markers
  events.forEach(e => {
    const ex = x(e.time);
    if (ex < pad.l || ex > W - pad.r) return;
    if (e.type === 'bolus') {
      ctx.strokeStyle = cssVar('--blue'); ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(ex, pad.t); ctx.lineTo(ex, H - pad.b); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = cssVar('--blue'); ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'center';
      let label = e.units > 0 ? e.units + 'u' : '';
      if (e.carbs) label += (label ? '+' : '') + e.carbs + 'g';
      ctx.fillText(label, ex, pad.t - 2);
    } else if (e.type === 'correction') {
      ctx.strokeStyle = cssVar('--orange'); ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(ex, pad.t); ctx.lineTo(ex, H - pad.b); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = cssVar('--orange'); ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('⚡' + e.units + 'u', ex, pad.t - 2);
    } else if (e.type === 'exercise') {
      // Duration (minutes) -> pixels using the chart's actual time span, not the nominal
      // range-button value - those don't necessarily match, and the mismatch previously
      // produced a width so small it always hit the 20px floor. Clamped to the plot area so
      // a recent workout's band doesn't paint into the right padding.
      ctx.fillStyle = hexToRgba(cssVar('--green'), 0.15);
      const ew = Math.min(Math.max(20, (e.duration || 30) * 60000 / tRange * cW), W - pad.r - ex);
      ctx.fillRect(ex, pad.t, ew, cH);
      ctx.fillStyle = cssVar('--green'); ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'left';
      ctx.fillText('🏋️' + (e.label || ''), ex + 2, H - pad.b - 4);
    }
  });

  if (opts.scrubIdx != null && data[opts.scrubIdx]) {
    // Crosshair + enlarged marker with a 2px surface ring for the scrubbed point.
    const d = data[opts.scrubIdx];
    ctx.strokeStyle = cssVar('--c-label'); ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
    ctx.beginPath(); ctx.moveTo(x(d.time), pad.t); ctx.lineTo(x(d.time), H - pad.b); ctx.stroke(); ctx.setLineDash([]);
    ctx.beginPath(); ctx.arc(x(d.time), y(d.value), 5, 0, Math.PI * 2);
    ctx.fillStyle = dotColor(d.value); ctx.fill();
    ctx.lineWidth = 2; ctx.strokeStyle = cssVar('--card'); ctx.stroke();
    liveDot.style.display = 'none';
  } else {
    // Pulsing "live" marker on the most recent reading.
    const last = data[data.length - 1];
    liveDot.style.left = x(last.time) + 'px';
    liveDot.style.top = y(last.value) + 'px';
    liveDot.style.background = dotColor(last.value);
    liveDot.style.display = 'block';
  }
}

// Scrub-to-inspect: touch-drag or mouse-hover shows a crosshair, the reading at that moment,
// and any event (dose/meal/workout) within ~14px. touch-action:pan-y on the canvas keeps
// vertical page scrolling alive while the chart owns horizontal drags.
(function wireChartScrub() {
  const canvas = document.getElementById('glucoseChart');
  if (!canvas) return;
  let scrubbing = false;
  function showScrub(e) {
    if (!window._chart) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const t = _chart.tMin + ((px - _chart.pad.l) / _chart.cW) * _chart.tRange;
    let idx = 0, bd = Infinity;
    _chart.data.forEach((d, i) => { const dd = Math.abs(d.time - t); if (dd < bd) { bd = dd; idx = i; } });
    drawChart(_chart.data, _chart.events, { scrubIdx: idx });
    const d = _chart.data[idx];
    const lx = _chart.x(d.time);
    let evHtml = '';
    for (const ev of _chart.events) {
      if (Math.abs(_chart.x(ev.time) - lx) < 14) {
        evHtml += `<div class="tip-ev">${ev.type === 'bolus'
          ? `💉 ${ev.units > 0 ? ev.units + 'u' : ''}${ev.carbs ? (ev.units > 0 ? ' + ' : '') + ev.carbs + 'g' : ''}`
          : ev.type === 'correction' ? `⚡ ${ev.units}u correction` : `🏋️ ${ev.label || 'workout'}`}</div>`;
      }
    }
    const tip = document.getElementById('chartTip');
    tip.innerHTML = `${d.value.toFixed(1)} mmol/L · ${fmtClock(d.time)}${evHtml}`;
    tip.style.display = 'block';
    tip.style.left = Math.max(56, Math.min(_chart.W - 56, lx)) + 'px';
    tip.style.top = Math.max(30, _chart.y(d.value)) + 'px';
  }
  function endScrub() {
    scrubbing = false;
    const tip = document.getElementById('chartTip');
    if (tip) tip.style.display = 'none';
    if (window._chart) drawChart(_chart.data, _chart.events);
  }
  canvas.addEventListener('pointerdown', e => { scrubbing = true; try { canvas.setPointerCapture(e.pointerId); } catch (err) {} showScrub(e); });
  canvas.addEventListener('pointermove', e => { if (scrubbing || e.pointerType === 'mouse') showScrub(e); });
  canvas.addEventListener('pointerup', endScrub);
  canvas.addEventListener('pointercancel', endScrub);
  canvas.addEventListener('pointerleave', () => { if (!scrubbing) endScrub(); });
})();

// ─── Wiring ─────────────────────────────────────────────────────────────
document.getElementById('pwInput').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

// Chart range buttons
const rangeEl = document.getElementById('chartRange');
[3, 6, 12, 24].forEach(h => {
  const b = document.createElement('button');
  b.textContent = h + 'h';
  if (h === chartHours) b.classList.add('on');
  b.onclick = () => { chartHours = h; document.querySelectorAll('.chart-range button').forEach(x => x.classList.remove('on')); b.classList.add('on'); loadChart(true); };
  rangeEl.appendChild(b);
});

setupBackdate('bolusTimeToggle', 'bolusTimeIn');
setupBackdate('basalTimeToggle', 'basalTimeIn');
setupBackdate('corrTimeToggle', 'corrTimeIn');
setupBackdate('workoutTimeToggle', 'workoutTimeIn');

document.getElementById('bolusIn').addEventListener('input', updateBolusBtn);
document.getElementById('bolusIn').addEventListener('keydown', e => { if (e.key === 'Enter') addBolus(); });
document.getElementById('carbIn').addEventListener('input', function () {
  // Manual typing means this is no longer "the preset meal" - drop the tag so meal memory
  // only aggregates logs that genuinely came from the named preset. Stepper nudges are
  // exempt (_stepping): adjusting the portion of a preset meal is still that meal.
  if (_selectedMeal && !_stepping) { _selectedMeal = null; document.querySelectorAll('#qc button').forEach(b => b.classList.remove('on')); document.getElementById('mealMemory').innerHTML = ''; }
  updateBolusBtn(); debouncedMealSuggestion();
});
document.getElementById('carbIn').addEventListener('keydown', e => { if (e.key === 'Enter') addBolus(); });

document.getElementById('corrUnitsIn').addEventListener('input', function () { document.getElementById('addCorrBtn').disabled = !this.value || parseFloat(this.value) <= 0; debouncedCorrSuggestion(); });
document.getElementById('corrUnitsIn').addEventListener('keydown', e => { if (e.key === 'Enter') addCorrection(); });
document.getElementById('corrTargetIn').addEventListener('keydown', e => { if (e.key === 'Enter') addCorrection(); });

document.getElementById('basalToggle').addEventListener('click', function () { const f = document.getElementById('basalForm'), v = f.classList.toggle('vis'); this.textContent = v ? 'Cancel' : 'Add'; });
document.getElementById('basalIn').addEventListener('keydown', e => { if (e.key === 'Enter') addBasal(); });

document.getElementById('workoutTypeIn').addEventListener('input', function () { document.getElementById('addWorkoutBtn').disabled = !this.value.trim(); debouncedWorkoutAdvice(); });
document.getElementById('workoutDurIn').addEventListener('keydown', e => { if (e.key === 'Enter') addWorkout(); });
document.getElementById('workoutCalIn').addEventListener('keydown', e => { if (e.key === 'Enter') addWorkout(); });

document.getElementById('presetNameIn').addEventListener('keydown', e => { if (e.key === 'Enter') addPreset(); });
document.getElementById('presetCarbsIn').addEventListener('keydown', e => { if (e.key === 'Enter') addPreset(); });
document.getElementById('workoutPresetNameIn').addEventListener('keydown', e => { if (e.key === 'Enter') addWorkoutPreset(); });

// ─── Init ───────────────────────────────────────────────────────────────
async function init() {
  // Settings first so target-range colours are correct on the very first render.
  await fetchSettings();
  fetchEntries(); fetchGlucose(); loadChart(true); loadAlerts(); loadForecast(); loadMealPresets(); loadWorkoutPresets();
  requestAnimationFrame(moveGlider); // appPage just became visible; tab widths are now real
  try { if (localStorage.getItem('simpleMode')) enterSimple(); } catch (e) {}
  setInterval(render, 30000); // ticks IOB/COB/basal countdown between fetches
  // fetchEntries included so server-side changes (a correction resolving on a glucose poll)
  // show up without requiring a manual log action or reload.
  setInterval(() => { fetchGlucose(); loadChart(); fetchEntries(); loadAlerts(); loadForecast(); }, 60000);
}
applyTheme();
checkAuth();

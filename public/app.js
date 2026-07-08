// ─── State ──────────────────────────────────────────────────────────────
let boluses = [], basalDoses = [], corrections = [], chartHours = 6;
let settings = { targetLow: 4, targetHigh: 10, carbRatio: null };
let editingEntry = null;

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
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

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
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('vis'), 2200);
}

// ─── Auth ───────────────────────────────────────────────────────────────
async function checkAuth() { try { const r = await fetch('/api/auth-check'); if (r.ok) { showApp(); return; } } catch (e) {} document.getElementById('loginPage').style.display = 'flex'; }
async function doLogin() { const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: document.getElementById('pwInput').value }) }); if (r.ok) showApp(); else document.getElementById('loginErr').style.display = 'block'; }
function showApp() { document.getElementById('loginPage').style.display = 'none'; document.getElementById('appPage').style.display = 'block'; init(); }

async function api(u, o) { const r = await fetch(u, o); if (r.status === 401) location.reload(); return r.json(); }

// ─── Tabs ───────────────────────────────────────────────────────────────
function showTab(t) {
  document.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === t));
  document.querySelectorAll('.panel').forEach(p => p.classList.remove('vis'));
  document.getElementById('panel-' + t).classList.add('vis');
  if (t === 'activity') loadActivities();
  if (t === 'insights') { loadInsights(); loadCorrHistory(); loadInsulinHealth(); }
  if (t === 'summary') loadDailySummary();
  if (t === 'settings') { fetchSettings(); loadPresetManager(); loadWorkoutPresetManager(); }
}

// ─── Data fetching ──────────────────────────────────────────────────────
async function fetchEntries() { const d = await api('/api/entries'); boluses = d.boluses || []; basalDoses = d.basalDoses || []; corrections = d.corrections || []; render(); }

async function fetchGlucose() {
  const card = document.getElementById('gCard'), disp = document.getElementById('gDisplay');
  try {
    const d = await api('/api/glucose');
    if (d.error) { card.className = 'glucose'; disp.innerHTML = `<div style="color:var(--dim);font-size:13px;padding:10px 0">${d.error}</div>`; return; }
    let cls = 'ok', col = '#16a34a';
    if (d.value < settings.targetLow) { cls = 'low'; col = '#dc2626'; } else if (d.value > settings.targetHigh) { cls = 'high'; col = '#ea580c'; }
    card.className = `glucose ${cls}`;
    const deltaHtml = d.delta != null ? `<div class="g-delta">${d.delta > 0 ? '+' : ''}${d.delta} (${d.deltaMinutes}m)</div>` : '';
    disp.innerHTML = `${deltaHtml}<div class="g-val" style="color:${col}">${d.value}<span class="g-trend">${d.trend || ''}</span><span class="u">mmol/L</span></div><div class="g-meta">${d.trendLabel || ''} · ${timeAgo(new Date(d.timestamp || d.fetchedAt).getTime())}</div>`;
    updateCorrSuggestion(); // keep the correction suggestion current as glucose changes, not just on typing
  } catch (e) { card.className = 'glucose'; disp.innerHTML = '<div style="color:var(--dim);font-size:13px">Could not connect</div>'; }
}

async function loadChart() {
  try { const data = await api(`/api/glucose-history?hours=${chartHours}`); drawChart(data.glucose || data, data.events || []); } catch (e) {}
}

async function loadActivities() {
  const wl = document.getElementById('workoutList');
  try {
    const acts = await api('/api/activities');
    const today = new Date().toDateString();
    const s = acts.find(a => a.type === 'daily_summary' && new Date(a.time).toDateString() === today);
    document.getElementById('aKcal').textContent = s ? Math.round(s.activeCalories) : '—';
    document.getElementById('aExMin').textContent = s ? Math.round(s.exerciseMinutes) : '—';
    document.getElementById('aStand').textContent = s ? Math.round(s.standHours) : '—';
    document.getElementById('aSteps').textContent = (s && s.steps != null) ? Number(s.steps).toLocaleString() : '—';
    document.getElementById('aRHR').textContent = s && s.restingHeartRate ? s.restingHeartRate : '—';
    const wk = acts.filter(a => a.type === 'workout').slice(0, 10);
    if (!wk.length) { wl.innerHTML = '<div class="empty">No workouts synced yet</div>'; return; }
    wl.innerHTML = wk.map(w => {
      const hr = w.avgHeartRate ? ` · ❤️ ${w.avgHeartRate}bpm${w.maxHeartRate ? ' (max ' + w.maxHeartRate + ')' : ''}` : '';
      const manual = w.manual ? ' <span class="sub">· manual</span>' : '';
      const del = w.manual ? `<button class="log-del" onclick="delWorkout('${w.id}')">✕</button>` : '';
      return `<div class="workout"><div class="w-icon">🏋️</div><div class="w-info"><div class="w-name">${w.workoutType || 'Exercise'}${manual}</div><div class="w-detail">${w.duration ? Math.round(w.duration) + 'min ' : ''} ${w.calories ? '· ' + Math.round(w.calories) + ' kcal ' : ''}${hr}<br>${fmtTime(new Date(w.startTime).getTime())}</div></div>${del}</div>`;
    }).join('');
  } catch (e) { wl.innerHTML = '<div class="empty">Could not load workouts.</div>'; }
}

// ─── Insights tab ───────────────────────────────────────────────────────
async function loadInsights() {
  const el = document.getElementById('insightsList');
  try { const ins = await api('/api/insights'); el.innerHTML = ins.map(i => `<div class="insight ${i.type}">${i.text}</div>`).join(''); }
  catch (e) { el.innerHTML = '<div class="empty">Could not load insights.</div>'; }
}

async function loadInsulinHealth() {
  const el = document.getElementById('insulinHealth');
  try {
    const h = await api('/api/insulin-health');
    if (!h.available) { el.innerHTML = `<div class="empty">${h.message}</div>`; return; }
    let html = `<div class="daily-grid">
      <div class="daily-stat"><div class="dv">${h.tdd}u</div><div class="dl">Avg daily dose</div></div>
      <div class="daily-stat"><div class="dv">${h.tddPerKg != null ? h.tddPerKg + 'u/kg' : '—'}</div><div class="dl">Dose per kg</div></div>
      <div class="daily-stat"><div class="dv">${h.tir != null ? h.tir + '%' : '—'}</div><div class="dl">Time in range</div></div>
    </div>
    <div class="daily-grid">
      <div class="daily-stat"><div class="dv">${h.bolusPct != null ? h.bolusPct + '%' : '—'}</div><div class="dl">Bolus share</div></div>
      <div class="daily-stat"><div class="dv">${h.basalPct != null ? h.basalPct + '%' : '—'}</div><div class="dl">Basal share</div></div>
      <div class="daily-stat"><div class="dv">${h.bmi != null ? h.bmi : '—'}</div><div class="dl">BMI</div></div>
    </div>`;
    if (h.notes && h.notes.length) html += h.notes.map(n => `<div class="insight info">${n}</div>`).join('');
    else html += `<div class="insight info">No notable week-over-week changes yet.</div>`;
    el.innerHTML = html;
  } catch (e) { el.innerHTML = '<div class="empty">Could not load.</div>'; }
}

async function loadCorrHistory() {
  const el = document.getElementById('corrHistory');
  try {
    const d = await api('/api/entries');
    const corrs = (d.corrections || []).slice(0, 10);
    if (!corrs.length) { el.innerHTML = '<div class="empty">No corrections yet</div>'; return; }
    el.innerHTML = corrs.map(c => {
      const interference = c.carbInterference ? ` · 🍬 ${c.interferingCarbs}g carbs during window (excluded from factor)` : '';
      const status = c.resolved
        ? `<span class="corr-result done">Landed at ${c.actualGlucose} (${c.dropPerUnit > 0 ? '↓' : '↑'}${Math.abs(c.dropPerUnit).toFixed(1)}/u)${c.accuracy != null ? ' · off by ' + c.accuracy.toFixed(1) : ''}${interference}</span>`
        : `<span class="corr-result pending">Waiting (~${Math.max(0, Math.round((c.time + 180*60000 - Date.now()) / 60000))}min)</span>`;
      const context = c.recentCarbs ? `<div class="log-secondary">🍬 ${c.recentCarbs}g carbs in the 2h before this correction</div>` : '';
      return `<div class="log-entry"><div class="log-left"><div class="log-dot correction"></div><div><div class="log-primary">${c.units}u correction <span class="sub">${c.startGlucose || '?'} → target ${c.predictedGlucose || '?'}</span></div><div class="log-secondary">${fmtTime(c.time)}</div>${context}${status}</div></div></div>`;
    }).join('');
  } catch (e) { el.innerHTML = '<div class="empty">Could not load.</div>'; }
}

// ─── Today tab ──────────────────────────────────────────────────────────
async function loadDailySummary() {
  const el = document.getElementById('dailySummary');
  try {
    const s = await api('/api/daily-summary');
    el.innerHTML = `
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
    el.innerHTML = presets.map(p => `<div class="log-entry"><div class="log-left"><div><div class="log-primary">${p.name}</div><div class="log-secondary">${p.carbs}g</div></div></div><button class="log-del" onclick="delPreset('${p.id}')">✕</button></div>`).join('');
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
    el.innerHTML = presets.map(p => `<div class="log-entry"><div class="log-left"><div class="log-primary">${p.name}</div></div><button class="log-del" onclick="delWorkoutPreset('${p.id}')">✕</button></div>`).join('');
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
    b.onclick = () => { document.getElementById('carbIn').value = p.carbs; qcEl.querySelectorAll('button').forEach(x => x.classList.remove('on')); b.classList.add('on'); updateBolusBtn(); updateMealSuggestion(); };
    qcEl.appendChild(b);
  });
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
    b.onclick = () => { document.getElementById('workoutTypeIn').value = p.name; qcEl.querySelectorAll('button').forEach(x => x.classList.remove('on')); b.classList.add('on'); document.getElementById('addWorkoutBtn').disabled = false; };
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
  const r = await api('/api/entries/bolus', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ units: u > 0 ? u : 0, carbs: c > 0 ? c : null, time: getEntryTime('bolusTimeIn') }) });
  if (r && r.error) { toast(r.error, true); return; }
  document.getElementById('bolusIn').value = ''; document.getElementById('carbIn').value = '';
  document.getElementById('mealSuggestion').innerHTML = '';
  // Scoped to #qc - clearing every .qc button would also wipe the workout preset row's
  // selected state on the Activity tab (they're deliberately independent).
  document.querySelectorAll('#qc button').forEach(b => b.classList.remove('on'));
  resetBackdate('bolusTimeToggle', 'bolusTimeIn');
  updateBolusBtn();
  fetchEntries(); loadChart();
}

async function addBasal() {
  const u = parseFloat(document.getElementById('basalIn').value);
  if (!u || u <= 0) return;
  const r = await api('/api/entries/basal', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ units: u, time: getEntryTime('basalTimeIn') }) });
  if (r && r.error) { toast(r.error, true); return; }
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
  document.getElementById('corrUnitsIn').value = ''; document.getElementById('corrTargetIn').value = '';
  document.getElementById('addCorrBtn').disabled = true;
  document.getElementById('corrSuggestion').innerHTML = '';
  resetBackdate('corrTimeToggle', 'corrTimeIn');
  fetchEntries(); loadChart();
}

async function delEntry(t, id) {
  if (!confirm('Delete this entry?')) return;
  await api(`/api/entries/${t}/${id}`, { method: 'DELETE' });
  fetchEntries(); loadChart();
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
  document.getElementById('workoutTypeIn').value = ''; document.getElementById('workoutDurIn').value = ''; document.getElementById('workoutCalIn').value = '';
  document.getElementById('addWorkoutBtn').disabled = true;
  document.querySelectorAll('#workoutQc button').forEach(b => b.classList.remove('on'));
  resetBackdate('workoutTimeToggle', 'workoutTimeIn');
  loadActivities();
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
    if (r.factorTooLow) {
      html += `<div class="suggest-box" style="background:var(--orange-l);color:#c2410c">Your correction factor (${r.factor}/unit) looks too low to be reliable — not confident enough to suggest a dose yet. Log a few more corrections without carbs nearby to firm this up.</div>`;
    } else if (r.suggestedUnits != null) {
      if (r.suggestedUnits > 0) {
        html += `<div class="suggest-box">Suggested: ${r.suggestedUnits}u (currently ${r.currentGlucose} mmol/L, ${(r.currentGlucose - r.idealTarget).toFixed(1)} above your ${r.idealTarget} target)${uRaw === '' ? ` <button type="button" onclick="useCorrSuggestion(${r.suggestedUnits})" style="width:auto;padding:3px 10px;margin-left:4px;border-radius:6px;border:none;background:var(--blue);color:#fff;font-size:11px;font-weight:600;cursor:pointer">Use</button>` : ''}</div>`;
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

async function updateMealSuggestion() {
  const c = parseFloat(document.getElementById('carbIn').value);
  const el = document.getElementById('mealSuggestion');
  if (!c || c <= 0) { el.innerHTML = ''; return; }
  try {
    const r = await api('/api/meal-suggestion?carbs=' + c);
    if (r.suggestion != null) { el.innerHTML = `<div class="suggest-box">Suggested dose: ~${r.suggestion}u for ${c}g (based on ${r.basedOn} similar past meals)${r.note ? '<br>' + r.note : ''}</div>`; }
    else { el.innerHTML = `<div class="suggest-box">${r.message || 'Log a few more meals to get personalised suggestions.'}</div>`; }
  } catch (e) { el.innerHTML = ''; }
}

function updateBolusBtn() {
  const u = parseFloat(document.getElementById('bolusIn').value), c = parseFloat(document.getElementById('carbIn').value);
  const btn = document.getElementById('addBolusBtn');
  btn.disabled = !((u > 0) || (c > 0));
  btn.textContent = (u > 0) ? '＋ Log bolus' : '＋ Log carbs (no insulin)';
}

// Suggestion lookups hit the API; debounce the keystroke-driven ones so typing "45" doesn't
// fire a request for "4" first. Preset taps and glucose refreshes still call directly.
const debouncedMealSuggestion = debounce(updateMealSuggestion, 300);
const debouncedCorrSuggestion = debounce(updateCorrSuggestion, 300);

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
function render() {
  document.getElementById('iob').innerHTML = calcIOB().toFixed(1) + '<span class="u">u</span>';
  document.getElementById('cob').innerHTML = calcCOB().toFixed(0) + '<span class="u">g</span>';
  const lb = boluses[0];
  document.getElementById('lastCarbs').innerHTML = (lb && lb.carbs != null ? lb.carbs : '—') + '<span class="u">g</span>';
  document.getElementById('lastBolus').textContent = lb ? (lb.units > 0 ? lb.units + 'u · ' + timeAgo(lb.time) : 'Carbs only · ' + timeAgo(lb.time)) : 'None';
  const lba = basalDoses[0];
  document.getElementById('lastBasal').textContent = lba ? lba.units + 'u · ' + timeAgo(lba.time) : 'None';
  updateBasalStatus();
  const all = [...boluses.map(b => ({ ...b, kind: 'bolus' })), ...basalDoses.map(b => ({ ...b, kind: 'basal' })), ...corrections.map(c => ({ ...c, kind: 'correction' }))].sort((a, b) => b.time - a.time).slice(0, 20);
  const log = document.getElementById('logList');
  if (!all.length) { log.innerHTML = '<div class="empty">No entries yet</div>'; return; }
  log.innerHTML = all.map(e => {
    if (editingEntry && editingEntry.kind === e.kind && editingEntry.id === String(e.id)) return editFormHTML(e);
    let label, detail = '';
    if (e.kind === 'bolus') { label = e.units > 0 ? `Novorapid · ${e.units}u` : '🍬 Carbs only'; if (e.carbs != null) label += ` <span class="sub">· ${e.carbs}g</span>`; }
    else if (e.kind === 'basal') { label = `Lantus · ${e.units}u`; }
    else { label = `⚡ Correction · ${e.units}u`; detail = e.resolved ? ` <span class="sub">→ ${e.actualGlucose}</span>` : (e.startGlucose ? ` <span class="sub">from ${e.startGlucose}</span>` : ''); }
    return `<div class="log-entry"><div class="log-left"><div class="log-dot ${e.kind}"></div><div><div class="log-primary">${label}${detail}</div><div class="log-secondary">${fmtTime(e.time)}</div></div></div><div class="log-actions"><button class="log-edit" onclick="startEdit('${e.kind}','${e.id}')">✎</button><button class="log-del" onclick="delEntry('${e.kind}','${e.id}')">✕</button></div></div>`;
  }).join('');
}

// ─── Glucose chart ──────────────────────────────────────────────────────
function drawChart(data, events = []) {
  const canvas = document.getElementById('glucoseChart');
  if (!canvas || !data || data.length < 2) return;
  const ctx = canvas.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.parentElement.getBoundingClientRect();
  canvas.width = rect.width * dpr; canvas.height = rect.height * dpr;
  canvas.style.width = rect.width + 'px'; canvas.style.height = rect.height + 'px';
  ctx.scale(dpr, dpr);
  const W = rect.width, H = rect.height, pad = { t: 14, b: 20, l: 35, r: 10 };
  const cW = W - pad.l - pad.r, cH = H - pad.t - pad.b;
  const vals = data.map(d => d.value);
  let mn = Math.min(...vals, 3.5), mx = Math.max(...vals, 12);
  mn = Math.floor(mn); mx = Math.ceil(mx);
  const tMin = data[0].time, tMax = data[data.length - 1].time, tRange = tMax - tMin || 1;
  const x = t => (pad.l + ((t - tMin) / tRange) * cW);
  const y = v => (pad.t + cH - (((v - mn) / (mx - mn)) * cH));

  // Target-range band
  ctx.fillStyle = 'rgba(34,197,94,0.08)';
  ctx.fillRect(pad.l, y(settings.targetHigh), cW, y(settings.targetLow) - y(settings.targetHigh));

  // Grid
  ctx.strokeStyle = '#e2e8f0'; ctx.lineWidth = 0.5; ctx.fillStyle = '#94a3b8'; ctx.font = '10px sans-serif'; ctx.textAlign = 'right';
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
    ctx.fillStyle = 'rgba(37,99,235,0.15)';
    ctx.fill();
  }

  // Glucose line
  ctx.beginPath(); ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 2; ctx.lineJoin = 'round';
  data.forEach((d, i) => { i === 0 ? ctx.moveTo(x(d.time), y(d.value)) : ctx.lineTo(x(d.time), y(d.value)); });
  ctx.stroke();

  // Glucose dots, coloured against the user's own target range
  data.forEach(d => { let c = '#16a34a'; if (d.value < settings.targetLow) c = '#dc2626'; else if (d.value > settings.targetHigh) c = '#ea580c'; ctx.fillStyle = c; ctx.beginPath(); ctx.arc(x(d.time), y(d.value), 2, 0, Math.PI * 2); ctx.fill(); });

  // Event markers
  events.forEach(e => {
    const ex = x(e.time);
    if (ex < pad.l || ex > W - pad.r) return;
    if (e.type === 'bolus') {
      ctx.strokeStyle = '#2563eb'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(ex, pad.t); ctx.lineTo(ex, H - pad.b); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#2563eb'; ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'center';
      let label = e.units > 0 ? e.units + 'u' : '';
      if (e.carbs) label += (label ? '+' : '') + e.carbs + 'g';
      ctx.fillText(label, ex, pad.t - 2);
    } else if (e.type === 'correction') {
      ctx.strokeStyle = '#ea580c'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
      ctx.beginPath(); ctx.moveTo(ex, pad.t); ctx.lineTo(ex, H - pad.b); ctx.stroke(); ctx.setLineDash([]);
      ctx.fillStyle = '#ea580c'; ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('⚡' + e.units + 'u', ex, pad.t - 2);
    } else if (e.type === 'exercise') {
      // Duration (minutes) -> pixels using the chart's actual time span, not the nominal
      // range-button value - those don't necessarily match, and the mismatch previously
      // produced a width so small it always hit the 20px floor. Clamped to the plot area so
      // a recent workout's band doesn't paint into the right padding.
      ctx.fillStyle = 'rgba(22,163,74,0.15)';
      const ew = Math.min(Math.max(20, (e.duration || 30) * 60000 / tRange * cW), W - pad.r - ex);
      ctx.fillRect(ex, pad.t, ew, cH);
      ctx.fillStyle = '#16a34a'; ctx.font = 'bold 9px sans-serif'; ctx.textAlign = 'left';
      ctx.fillText('🏋️' + (e.label || ''), ex + 2, H - pad.b - 4);
    }
  });
}

// ─── Wiring ─────────────────────────────────────────────────────────────
document.getElementById('pwInput').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

// Chart range buttons
const rangeEl = document.getElementById('chartRange');
[3, 6, 12, 24].forEach(h => {
  const b = document.createElement('button');
  b.textContent = h + 'h';
  if (h === chartHours) b.classList.add('on');
  b.onclick = () => { chartHours = h; document.querySelectorAll('.chart-range button').forEach(x => x.classList.remove('on')); b.classList.add('on'); loadChart(); };
  rangeEl.appendChild(b);
});

setupBackdate('bolusTimeToggle', 'bolusTimeIn');
setupBackdate('basalTimeToggle', 'basalTimeIn');
setupBackdate('corrTimeToggle', 'corrTimeIn');
setupBackdate('workoutTimeToggle', 'workoutTimeIn');

document.getElementById('bolusIn').addEventListener('input', updateBolusBtn);
document.getElementById('bolusIn').addEventListener('keydown', e => { if (e.key === 'Enter') addBolus(); });
document.getElementById('carbIn').addEventListener('input', function () { updateBolusBtn(); debouncedMealSuggestion(); });
document.getElementById('carbIn').addEventListener('keydown', e => { if (e.key === 'Enter') addBolus(); });

document.getElementById('corrUnitsIn').addEventListener('input', function () { document.getElementById('addCorrBtn').disabled = !this.value || parseFloat(this.value) <= 0; debouncedCorrSuggestion(); });
document.getElementById('corrUnitsIn').addEventListener('keydown', e => { if (e.key === 'Enter') addCorrection(); });
document.getElementById('corrTargetIn').addEventListener('keydown', e => { if (e.key === 'Enter') addCorrection(); });

document.getElementById('basalToggle').addEventListener('click', function () { const f = document.getElementById('basalForm'), v = f.classList.toggle('vis'); this.textContent = v ? 'Cancel' : 'Add'; });
document.getElementById('basalIn').addEventListener('keydown', e => { if (e.key === 'Enter') addBasal(); });

document.getElementById('workoutTypeIn').addEventListener('input', function () { document.getElementById('addWorkoutBtn').disabled = !this.value.trim(); });
document.getElementById('workoutDurIn').addEventListener('keydown', e => { if (e.key === 'Enter') addWorkout(); });
document.getElementById('workoutCalIn').addEventListener('keydown', e => { if (e.key === 'Enter') addWorkout(); });

document.getElementById('presetNameIn').addEventListener('keydown', e => { if (e.key === 'Enter') addPreset(); });
document.getElementById('presetCarbsIn').addEventListener('keydown', e => { if (e.key === 'Enter') addPreset(); });
document.getElementById('workoutPresetNameIn').addEventListener('keydown', e => { if (e.key === 'Enter') addWorkoutPreset(); });

// ─── Init ───────────────────────────────────────────────────────────────
async function init() {
  // Settings first so target-range colours are correct on the very first render.
  await fetchSettings();
  fetchEntries(); fetchGlucose(); loadChart(); loadMealPresets(); loadWorkoutPresets();
  setInterval(render, 30000); // ticks IOB/COB/basal countdown between fetches
  // fetchEntries included so server-side changes (a correction resolving on a glucose poll)
  // show up without requiring a manual log action or reload.
  setInterval(() => { fetchGlucose(); loadChart(); fetchEntries(); }, 60000);
}
checkAuth();

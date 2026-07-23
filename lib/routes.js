// ─── HTTP routes ──────────────────────────────────────────────────────
const crypto = require('crypto');
const { APP_PASSWORD, MIN_PLAUSIBLE_FACTOR, MAX_SUGGESTED_UNITS } = require('./config');
const { loadData, saveData } = require('./store');
const { fetchGlucose } = require('./libre');
const {
  analysePatterns, suggestMealDose, resolveEntryTime, glucoseAt,
  getDailySummary, checkInsulinHealth, getActiveAlerts, getWorkoutAdvice, dosingContext,
  forecastHypoRisk, simulateActivity, stackingCaution, sensitivityMap, getMealMemory,
  forecastAccuracy,
} = require('./analysis');

// Single shared password, no user accounts. The cookie path serves the browser; the Bearer
// path exists specifically so Apple Shortcuts can POST to /api/health without cookie support.
const AUTH_TOKEN = crypto.createHash('sha256').update(APP_PASSWORD).digest('hex');
function requireAuth(req, res, next) {
  if (req.cookies && req.cookies.auth === AUTH_TOKEN) return next();
  if (req.headers.authorization === `Bearer ${APP_PASSWORD}`) return next();
  return res.status(401).json({ error: 'Unauthorized' });
}

// Entry ids are matched as strings throughout - some ids are integers (Date.now()) and some
// are floats (Date.now()+Math.random() for activities), so parseInt comparison would silently
// truncate the latter. String comparison handles both.
const idMatches = (entryId, paramId) => String(entryId) === String(paramId);

// Brute-force guard on the single shared password: a public URL otherwise allows unlimited
// guesses. In-memory, per-IP, resets on restart - plenty for a single-user app. After
// MAX_LOGIN_ATTEMPTS wrong tries the IP is locked for LOGIN_LOCK_MS; a correct password clears
// the counter immediately so a legitimate fat-finger doesn't compound.
const loginAttempts = new Map(); // ip -> { count, lockedUntil }
const MAX_LOGIN_ATTEMPTS = 5, LOGIN_LOCK_MS = 60 * 1000;

function registerRoutes(app) {
  // ── Auth ──────────────────────────────────────────────────────────
  app.post('/api/login', (req, res) => {
    const ip = req.ip || 'unknown';
    const now = Date.now();
    const rec = loginAttempts.get(ip);
    if (rec && rec.lockedUntil > now) {
      return res.status(429).json({ error: `Too many attempts — wait ${Math.ceil((rec.lockedUntil - now) / 1000)}s and try again.` });
    }
    if (req.body.password === APP_PASSWORD) {
      loginAttempts.delete(ip);
      // Secure flag mirrors the actual connection (req.secure via trust proxy) so the cookie is
      // Secure on Render/HTTPS but still works over plain HTTP in local dev.
      res.cookie('auth', AUTH_TOKEN, { maxAge: 365*24*60*60*1000, httpOnly: true, sameSite: 'lax', secure: req.secure });
      return res.json({ ok: true });
    }
    // Any surviving rec here has already had its lock expire (locked recs return above), so its
    // count carries straight over.
    const count = (rec ? rec.count : 0) + 1;
    if (count >= MAX_LOGIN_ATTEMPTS) loginAttempts.set(ip, { count: 0, lockedUntil: now + LOGIN_LOCK_MS });
    else loginAttempts.set(ip, { count, lockedUntil: 0 });
    res.status(401).json({ error: 'Wrong password' });
  });
  app.get('/api/auth-check', (req, res) => {
    if (req.cookies && req.cookies.auth === AUTH_TOKEN) return res.json({ ok: true });
    res.status(401).json({ error: 'Not logged in' });
  });

  // ── Glucose ───────────────────────────────────────────────────────
  app.get('/api/glucose', requireAuth, async (req, res) => { res.json(await fetchGlucose()); });

  app.get('/api/glucose-history', requireAuth, async (req, res) => {
    const data = await loadData();
    const hours = parseInt(req.query.hours) || 24;
    const since = Date.now() - hours*60*60*1000;
    const glucose = (data.glucoseHistory || []).filter(g => g.time > since);
    // Event markers for the chart overlay
    const events = [];
    data.boluses.filter(b => b.time > since).forEach(b => events.push({ type: 'bolus', time: b.time, units: b.units, carbs: b.carbs }));
    data.corrections.filter(c => c.time > since).forEach(c => events.push({ type: 'correction', time: c.time, units: c.units }));
    (data.activities || []).filter(a => a.type === 'workout' && a.time > since).forEach(a => events.push({ type: 'exercise', time: new Date(a.startTime).getTime(), label: a.workoutType, duration: a.duration }));
    res.json({ glucose, events });
  });

  // ── Entries: bolus / basal / correction ───────────────────────────
  app.get('/api/entries', requireAuth, async (req, res) => {
    const d = await loadData();
    res.json({ boluses: d.boluses, basalDoses: d.basalDoses, corrections: d.corrections || [] });
  });

  app.post('/api/entries/bolus', requireAuth, async (req, res) => {
    const { units, carbs, time, mealName } = req.body;
    const u = units ? parseFloat(units) : 0, c = carbs ? parseFloat(carbs) : null;
    // Carbs-only entries (units 0) are valid - logging food eaten without dosing.
    if ((!u || u <= 0) && (!c || c <= 0)) return res.status(400).json({ error: 'Enter carbs or units' });
    const data = await loadData();
    // mealName tags the entry as a named, reusable meal (set when logged via a preset) -
    // it's what meal memory aggregates on.
    const entry = { id: Date.now(), time: resolveEntryTime(time), units: u, carbs: c, mealName: (mealName && String(mealName).trim()) || null };
    data.boluses.unshift(entry);
    data.boluses.sort((a, b) => b.time - a.time);
    await saveData(data);
    res.json(entry);
  });

  // Combined meal + correction in one action. A single injection at a high reading is really two
  // decisions (cover the carbs, fix the high); logging it as one bolus teaches the meal model a
  // wildly wrong insulin:carb ratio AND teaches the correction model nothing. This splits the
  // total using the manual carbRatio, writes both entries linked to each other, and lets
  // resolveCorrections() net the carbs back out when deriving the factor. Total units logged
  // always equals the total injected - the split only changes attribution, never the IOB sum.
  app.post('/api/entries/combined', requireAuth, async (req, res) => {
    const { units, carbs, time, mealName } = req.body;
    const u = parseFloat(units), c = parseFloat(carbs);
    if (isNaN(u) || u <= 0) return res.status(400).json({ error: 'Invalid units' });
    if (isNaN(c) || c <= 0) return res.status(400).json({ error: 'Combined logging needs carbs' });
    const data = await loadData();
    const { carbRatio } = data.settings;
    if (!carbRatio) return res.status(400).json({ error: 'Set your carb ratio in Settings to split a combined dose' });

    const entryTime = resolveEntryTime(time);
    const carbPortion = c / carbRatio;
    const correctionUnits = parseFloat((u - carbPortion).toFixed(1));
    // Nothing meaningful left over - it was just a meal dose, so log it as one.
    if (correctionUnits < 0.5) {
      const entry = { id: Date.now(), time: entryTime, units: u, carbs: c, mealName: (mealName && String(mealName).trim()) || null };
      data.boluses.unshift(entry);
      data.boluses.sort((a, b) => b.time - a.time);
      await saveData(data);
      return res.json({ split: false, bolus: entry, correction: null });
    }

    const bolusUnits = parseFloat((u - correctionUnits).toFixed(2));
    const bolus = { id: Date.now(), time: entryTime, units: bolusUnits, carbs: c, mealName: (mealName && String(mealName).trim()) || null };
    const correction = {
      id: Date.now() + 1, time: entryTime, units: correctionUnits,
      startGlucose: glucoseAt(data, entryTime),
      predictedGlucose: null, suggestedDrop: null,
      recentCarbs: null,
      // The carbs this dose was knowingly taken alongside - resolveCorrections() nets these out
      // rather than discarding the correction as carb-confounded.
      mealCarbs: c, linkedBolusId: bolus.id,
      actualGlucose: null, resolved: false, resolvedAt: null, dropPerUnit: null, accuracy: null,
      carbInterference: false, interferingCarbs: null, concurrentCarbs: c,
      carbAdjusted: false, effectiveUnits: null, giveUp: false,
    };
    data.boluses.unshift(bolus);
    data.boluses.sort((a, b) => b.time - a.time);
    data.corrections.unshift(correction);
    data.corrections.sort((a, b) => b.time - a.time);
    await saveData(data);
    res.json({ split: true, bolus, correction, carbPortion: parseFloat(carbPortion.toFixed(2)) });
  });

  app.post('/api/entries/basal', requireAuth, async (req, res) => {
    const { units, time } = req.body;
    if (!units || units <= 0) return res.status(400).json({ error: 'Invalid' });
    const data = await loadData();
    const entry = { id: Date.now(), time: resolveEntryTime(time), units: parseFloat(units) };
    data.basalDoses.unshift(entry);
    data.basalDoses.sort((a, b) => b.time - a.time);
    await saveData(data);
    res.json(entry);
  });

  app.post('/api/entries/correction', requireAuth, async (req, res) => {
    const { units, predictedGlucose, time } = req.body;
    if (!units || units <= 0) return res.status(400).json({ error: 'Invalid units' });
    const data = await loadData();
    const entryTime = resolveEntryTime(time);
    const currentGlucose = glucoseAt(data, entryTime);

    // Suggested prediction from the historical correction factor (excluding corrections
    // confounded by carbs eaten during their resolution window).
    const resolved = data.corrections.filter(c => c.resolved && c.dropPerUnit != null && !c.carbInterference);
    let suggestedDrop = null;
    if (resolved.length >= 3) {
      const avgFactor = resolved.reduce((s, c) => s + c.dropPerUnit, 0) / resolved.length;
      suggestedDrop = parseFloat((avgFactor * units).toFixed(1));
    }

    // Carbs eaten shortly before this correction may still be digesting and will make its
    // effect less predictable - captured here for context in the correction history.
    const recentCarbs = data.boluses
      .filter(b => b.carbs > 0 && b.time > entryTime - 120*60000 && b.time <= entryTime)
      .reduce((s, b) => s + b.carbs, 0);

    const entry = {
      id: Date.now(), time: entryTime, units: parseFloat(units),
      startGlucose: currentGlucose,
      predictedGlucose: predictedGlucose ? parseFloat(predictedGlucose) : null,
      suggestedDrop,
      recentCarbs: recentCarbs || null,
      actualGlucose: null, resolved: false, resolvedAt: null, dropPerUnit: null, accuracy: null,
      carbInterference: false, interferingCarbs: null, giveUp: false,
    };
    data.corrections.unshift(entry);
    data.corrections.sort((a, b) => b.time - a.time);
    await saveData(data);
    res.json(entry);
  });

  app.delete('/api/entries/bolus/:id', requireAuth, async (req, res) => {
    const data = await loadData();
    data.boluses = data.boluses.filter(b => !idMatches(b.id, req.params.id));
    await saveData(data);
    res.json({ ok: true });
  });
  app.delete('/api/entries/basal/:id', requireAuth, async (req, res) => {
    const data = await loadData();
    data.basalDoses = data.basalDoses.filter(b => !idMatches(b.id, req.params.id));
    await saveData(data);
    res.json({ ok: true });
  });
  app.delete('/api/entries/correction/:id', requireAuth, async (req, res) => {
    const data = await loadData();
    data.corrections = data.corrections.filter(c => !idMatches(c.id, req.params.id));
    await saveData(data);
    res.json({ ok: true });
  });

  app.patch('/api/entries/bolus/:id', requireAuth, async (req, res) => {
    const { units, carbs, time } = req.body;
    const data = await loadData();
    const entry = data.boluses.find(b => idMatches(b.id, req.params.id));
    if (!entry) return res.status(404).json({ error: 'Not found' });
    if (units != null) {
      const u = parseFloat(units);
      if (isNaN(u) || u < 0) return res.status(400).json({ error: 'Invalid units' });
      entry.units = u;
    }
    if (carbs !== undefined) {
      const c = (carbs === null || carbs === '') ? null : parseFloat(carbs);
      entry.carbs = (c != null && !isNaN(c)) ? c : null;
    }
    // datetime-local inputs only have minute precision - ignore rounding noise under a minute
    if (time) {
      const newTime = resolveEntryTime(time);
      if (Math.abs(newTime - entry.time) >= 60000) entry.time = newTime;
    }
    if ((!entry.units || entry.units <= 0) && (!entry.carbs || entry.carbs <= 0)) return res.status(400).json({ error: 'Enter carbs or units' });
    data.boluses.sort((a, b) => b.time - a.time);
    await saveData(data);
    res.json(entry);
  });

  app.patch('/api/entries/basal/:id', requireAuth, async (req, res) => {
    const { units, time } = req.body;
    const data = await loadData();
    const entry = data.basalDoses.find(b => idMatches(b.id, req.params.id));
    if (!entry) return res.status(404).json({ error: 'Not found' });
    if (units != null) {
      const u = parseFloat(units);
      if (isNaN(u) || u <= 0) return res.status(400).json({ error: 'Invalid units' });
      entry.units = u;
    }
    if (time) {
      const newTime = resolveEntryTime(time);
      if (Math.abs(newTime - entry.time) >= 60000) entry.time = newTime;
    }
    data.basalDoses.sort((a, b) => b.time - a.time);
    await saveData(data);
    res.json(entry);
  });

  app.patch('/api/entries/correction/:id', requireAuth, async (req, res) => {
    const { units, predictedGlucose, time } = req.body;
    const data = await loadData();
    const entry = data.corrections.find(c => idMatches(c.id, req.params.id));
    if (!entry) return res.status(404).json({ error: 'Not found' });
    let resetResolution = false;
    if (units != null) {
      const u = parseFloat(units);
      if (isNaN(u) || u <= 0) return res.status(400).json({ error: 'Invalid units' });
      if (u !== entry.units) resetResolution = true;
      entry.units = u;
    }
    if (predictedGlucose !== undefined) {
      entry.predictedGlucose = (predictedGlucose === null || predictedGlucose === '') ? null : parseFloat(predictedGlucose);
    }
    if (time) {
      const newTime = resolveEntryTime(time);
      // datetime-local inputs only have minute precision, so compare with a tolerance rather
      // than exact equality - otherwise every edit "changes" the time by a few rounded seconds
      // and needlessly wipes startGlucose/resolution even when the user didn't touch it.
      if (Math.abs(newTime - entry.time) >= 60000) {
        entry.time = newTime;
        entry.startGlucose = glucoseAt(data, newTime);
        resetResolution = true;
      }
    }
    // Editing units or time invalidates any prior resolution - let resolveCorrections() re-derive it.
    if (resetResolution) {
      entry.actualGlucose = null; entry.resolved = false; entry.resolvedAt = null;
      entry.dropPerUnit = null; entry.accuracy = null;
      entry.carbInterference = false; entry.interferingCarbs = null; entry.giveUp = false;
    }
    data.corrections.sort((a, b) => b.time - a.time);
    await saveData(data);
    res.json(entry);
  });

  // ── Correction factor + proactive dose suggestion ─────────────────
  app.get('/api/correction-factor', requireAuth, async (req, res) => {
    const data = await loadData();
    const resolved = data.corrections.filter(c => c.resolved && c.dropPerUnit != null && !c.carbInterference);
    const recentCarbs = data.boluses.filter(b => b.carbs > 0 && b.time > Date.now() - 120*60000).reduce((s, b) => s + b.carbs, 0) || null;
    const ctx = dosingContext(data);
    const currentGlucose = ctx.current;
    const { idealTarget } = data.settings;
    if (resolved.length < 3) return res.json({ factor: null, count: resolved.length, message: 'Need at least 3 resolved corrections', recentCarbs, currentGlucose, idealTarget, suggestedUnits: null });
    const factor = resolved.reduce((s, c) => s + c.dropPerUnit, 0) / resolved.length;
    // Proactively suggest a correction dose from how far above the ideal target you are right
    // now, rather than only predicting the outcome of a unit amount you've already typed in.
    // IOB- and trend-aware (see dosingContext): active insulin is subtracted and the 30-min
    // projection stands in for the raw reading, so an in-flight dose or a drop already
    // underway shrinks the suggestion instead of stacking a fresh full dose on top.
    // Skipped entirely if the factor itself is implausibly low (see MIN_PLAUSIBLE_FACTOR) -
    // dividing by a near-zero factor turns a modest elevation into an absurd suggestion.
    let suggestedUnits = null, factorTooLow = false, coveredByIOB = false;
    if (factor < MIN_PLAUSIBLE_FACTOR) {
      factorTooLow = true;
    } else if (currentGlucose != null && idealTarget != null) {
      if (ctx.effective > idealTarget) {
        const raw = (ctx.effective - idealTarget) / factor - ctx.iob;
        suggestedUnits = Math.min(MAX_SUGGESTED_UNITS, Math.max(0, Math.round(raw * 2) / 2));
        if (suggestedUnits === 0 && ctx.iob > 0.1) coveredByIOB = true;
      } else {
        suggestedUnits = 0;
      }
    }
    res.json({
      factor: parseFloat(factor.toFixed(2)), count: resolved.length, recentCarbs,
      currentGlucose, idealTarget, suggestedUnits, factorTooLow, coveredByIOB,
      iob: ctx.iob, projectedGlucose: ctx.projected, readingAgeMinutes: ctx.ageMin, stale: ctx.stale,
      stackingCaution: stackingCaution(data),
    });
  });

  // ── Pre-workout advisor ───────────────────────────────────────────
  // "I'm about to do X" - projects a post-workout trough from that type's historical
  // profile plus live glucose/trend/IOB, and suggests carbs or caution accordingly.
  app.get('/api/workout-advice', requireAuth, async (req, res) => {
    const type = (req.query.type || '').trim();
    if (!type) return res.status(400).json({ error: 'Workout type required' });
    try { res.json(await getWorkoutAdvice(type)); }
    catch (e) { res.json({ known: false, risk: 'unknown', advice: 'Could not compute workout advice.' }); }
  });

  // ── Settings ──────────────────────────────────────────────────────
  app.get('/api/settings', requireAuth, async (req, res) => {
    const data = await loadData();
    res.json(data.settings);
  });

  app.post('/api/settings', requireAuth, async (req, res) => {
    const { targetLow, targetHigh, idealTarget, carbRatio, heightCm, weightKg, sex, bodyFatPct } = req.body;
    const data = await loadData();
    if (targetLow != null && targetHigh != null) {
      const lo = parseFloat(targetLow), hi = parseFloat(targetHigh);
      if (isNaN(lo) || isNaN(hi) || lo <= 0 || hi <= lo) return res.status(400).json({ error: 'Invalid target range' });
      data.settings.targetLow = lo;
      data.settings.targetHigh = hi;
    }
    if (idealTarget !== undefined) {
      if (idealTarget === null || idealTarget === '') { data.settings.idealTarget = null; }
      else {
        const n = parseFloat(idealTarget);
        if (isNaN(n) || n <= 0 || n > 20) return res.status(400).json({ error: 'Invalid ideal target' });
        data.settings.idealTarget = n;
      }
    }
    if (carbRatio !== undefined) {
      if (carbRatio === null || carbRatio === '') { data.settings.carbRatio = null; }
      else {
        const cr = parseFloat(carbRatio);
        if (isNaN(cr) || cr <= 0) return res.status(400).json({ error: 'Invalid carb ratio' });
        data.settings.carbRatio = cr;
      }
    }
    // Body profile - context only (BMI, dose-per-kg); never weighted into any suggestion.
    if (heightCm !== undefined) {
      if (heightCm === null || heightCm === '') { data.settings.heightCm = null; }
      else {
        const n = parseFloat(heightCm);
        if (isNaN(n) || n <= 0 || n > 300) return res.status(400).json({ error: 'Invalid height' });
        data.settings.heightCm = n;
      }
    }
    if (weightKg !== undefined) {
      if (weightKg === null || weightKg === '') { data.settings.weightKg = null; }
      else {
        const n = parseFloat(weightKg);
        if (isNaN(n) || n <= 0 || n > 500) return res.status(400).json({ error: 'Invalid weight' });
        data.settings.weightKg = n;
      }
    }
    if (bodyFatPct !== undefined) {
      if (bodyFatPct === null || bodyFatPct === '') { data.settings.bodyFatPct = null; }
      else {
        const n = parseFloat(bodyFatPct);
        if (isNaN(n) || n <= 0 || n > 100) return res.status(400).json({ error: 'Invalid body fat %' });
        data.settings.bodyFatPct = n;
      }
    }
    if (sex !== undefined) data.settings.sex = sex || null;
    await saveData(data);
    res.json(data.settings);
  });

  // ── Presets ───────────────────────────────────────────────────────
  // Meal presets: the user's own regular meals (e.g. "Coffee" = 10g), shown as quick-select
  // buttons on the Log a meal card instead of generic round-number carb amounts.
  app.get('/api/meal-presets', requireAuth, async (req, res) => { res.json((await loadData()).mealPresets || []); });
  app.post('/api/meal-presets', requireAuth, async (req, res) => {
    const { name, carbs } = req.body;
    const c = parseFloat(carbs);
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
    if (isNaN(c) || c <= 0) return res.status(400).json({ error: 'Invalid carbs' });
    const data = await loadData();
    const entry = { id: Date.now(), name: name.trim(), carbs: c };
    data.mealPresets.push(entry);
    await saveData(data);
    res.json(entry);
  });
  app.delete('/api/meal-presets/:id', requireAuth, async (req, res) => {
    const data = await loadData();
    data.mealPresets = data.mealPresets.filter(p => !idMatches(p.id, req.params.id));
    await saveData(data);
    res.json({ ok: true });
  });

  // Workout presets: just a name, to keep workout-type naming consistent (exercise insights
  // group activities by exact workoutType string, so free-text drift fragments patterns).
  app.get('/api/workout-presets', requireAuth, async (req, res) => { res.json((await loadData()).workoutPresets || []); });
  app.post('/api/workout-presets', requireAuth, async (req, res) => {
    const { name } = req.body;
    if (!name || !name.trim()) return res.status(400).json({ error: 'Name required' });
    const data = await loadData();
    const entry = { id: Date.now(), name: name.trim() };
    data.workoutPresets.push(entry);
    await saveData(data);
    res.json(entry);
  });
  app.delete('/api/workout-presets/:id', requireAuth, async (req, res) => {
    const data = await loadData();
    data.workoutPresets = data.workoutPresets.filter(p => !idMatches(p.id, req.params.id));
    await saveData(data);
    res.json({ ok: true });
  });

  // ── Apple Health / activity ───────────────────────────────────────
  // Upserts a daily_summary activity for the given calendar day (identified by any timestamp
  // that falls on it), merging in whichever fields are provided and keeping existing ones -
  // a single export/automation run can carry multiple days.
  function upsertDailySummary(data, dayTs, patch) {
    const dayKey = new Date(dayTs).toDateString();
    const idx = data.activities.findIndex(a => a.type === 'daily_summary' && new Date(a.time).toDateString() === dayKey);
    const existing = idx >= 0 ? data.activities[idx] : null;
    const s = {
      id: existing ? existing.id : Date.now() + Math.random(),
      type: 'daily_summary',
      time: existing ? existing.time : dayTs,
      activeCalories: patch.activeCalories ?? existing?.activeCalories ?? 0,
      exerciseMinutes: patch.exerciseMinutes ?? existing?.exerciseMinutes ?? 0,
      standHours: patch.standHours ?? existing?.standHours ?? 0,
      steps: patch.steps ?? existing?.steps ?? 0,
      restingHeartRate: patch.restingHeartRate ?? existing?.restingHeartRate ?? null,
    };
    if (idx >= 0) data.activities[idx] = s; else data.activities.unshift(s);
  }

  app.post('/api/health', requireAuth, async (req, res) => {
    const data = await loadData();
    const kJtoKcal = kj => kj / 4.184; // Health Auto Export sends energy in kJ

    if (req.body.data && (req.body.data.metrics || req.body.data.workouts)) {
      // Health Auto Export REST API format: { data: { metrics: [{name, units, data:[{date,qty|Avg/Min/Max}]}], workouts: [...] } }
      const metrics = req.body.data.metrics || [];
      const byName = n => metrics.find(m => m.name === n);
      const forEachDay = (name, fn) => { const m = byName(name); if (m) m.data.forEach(d => { const t = new Date(d.date).getTime(); if (!isNaN(t)) fn(t, d); }); };

      forEachDay('active_energy', (t, d) => upsertDailySummary(data, t, { activeCalories: kJtoKcal(d.qty) }));
      forEachDay('apple_exercise_time', (t, d) => upsertDailySummary(data, t, { exerciseMinutes: d.qty }));
      forEachDay('apple_stand_hour', (t, d) => upsertDailySummary(data, t, { standHours: d.qty }));
      forEachDay('step_count', (t, d) => upsertDailySummary(data, t, { steps: d.qty }));
      forEachDay('resting_heart_rate', (t, d) => upsertDailySummary(data, t, { restingHeartRate: Math.round(d.qty) }));

      // Per-minute time series (heartRateData etc.) are deliberately not stored - a single
      // export can be hundreds of KB and only the summary stats are useful here.
      for (const w of (req.body.data.workouts || [])) {
        if (!w.start || data.activities.some(a => a.type === 'workout' && a.startTime === w.start)) continue;
        data.activities.unshift({
          id: Date.now() + Math.random(), type: 'workout', time: Date.now(),
          workoutType: w.name || 'Exercise',
          duration: w.duration ? w.duration / 60 : null, // seconds -> minutes
          calories: w.activeEnergyBurned ? kJtoKcal(w.activeEnergyBurned.qty) : null,
          startTime: w.start, endTime: w.end, distance: null,
          avgHeartRate: w.avgHeartRate ? Math.round(w.avgHeartRate.qty) : null,
          maxHeartRate: w.maxHeartRate ? Math.round(w.maxHeartRate.qty) : null,
        });
      }
    } else {
      // Legacy Apple Shortcuts format: { summary: {...}, workouts: [{startTime,endTime,...}] }
      const { workouts, summary } = req.body;
      if (workouts && Array.isArray(workouts)) {
        for (const w of workouts) {
          if (!data.activities.some(a => a.type === 'workout' && a.startTime === w.startTime)) {
            data.activities.unshift({
              id: Date.now() + Math.random(), type: 'workout', time: Date.now(),
              workoutType: w.workoutType || 'Exercise', duration: w.duration || null, calories: w.calories || null,
              startTime: w.startTime, endTime: w.endTime, distance: w.distance || null,
              avgHeartRate: w.avgHeartRate || null, maxHeartRate: w.maxHeartRate || null,
            });
          }
        }
      }
      if (summary) {
        upsertDailySummary(data, Date.now(), {
          activeCalories: summary.activeCalories || 0, exerciseMinutes: summary.exerciseMinutes || 0,
          standHours: summary.standHours || 0, steps: summary.steps || 0,
          restingHeartRate: summary.restingHeartRate || null,
        });
      }
    }

    const cutoff = Date.now() - 30*24*60*60*1000;
    data.activities = data.activities.filter(a => a.time > cutoff);
    await saveData(data);
    res.json({ ok: true });
  });

  app.get('/api/activities', requireAuth, async (req, res) => { res.json((await loadData()).activities || []); });

  // Manual workout logging - a fallback since Apple's free Shortcuts actions can't actually
  // query Workout objects from HealthKit (only quantity samples like heart rate/steps), so
  // automated workout sync requires a paid third-party Shortcuts action.
  app.post('/api/activities/workout', requireAuth, async (req, res) => {
    const { workoutType, duration, calories, time } = req.body;
    if (!workoutType) return res.status(400).json({ error: 'Workout type required' });
    const data = await loadData();
    const durMin = duration ? parseFloat(duration) : null;
    // With no explicit backdated time, assume the workout just ended (the common case: logging
    // it shortly after finishing) rather than starting now - otherwise it plots as happening
    // in the future relative to when it actually occurred, throwing off its position on the
    // glucose chart relative to the reading at the time.
    const startTs = time ? resolveEntryTime(time) : Date.now() - (durMin || 0)*60000;
    const entry = {
      id: Date.now() + Math.random(), type: 'workout', time: startTs,
      workoutType, duration: durMin, calories: calories ? parseFloat(calories) : null,
      startTime: new Date(startTs).toISOString(),
      endTime: new Date(startTs + (durMin || 0)*60000).toISOString(),
      distance: null, avgHeartRate: null, maxHeartRate: null, manual: true,
    };
    data.activities.unshift(entry);
    const cutoff = Date.now() - 30*24*60*60*1000;
    data.activities = data.activities.filter(a => a.time > cutoff);
    await saveData(data);
    res.json(entry);
  });

  app.patch('/api/activities/workout/:id', requireAuth, async (req, res) => {
    const { workoutType, duration, calories, time } = req.body;
    const data = await loadData();
    const entry = data.activities.find(a => a.type === 'workout' && idMatches(a.id, req.params.id));
    if (!entry) return res.status(404).json({ error: 'Not found' });
    if (workoutType) entry.workoutType = workoutType;
    if (duration !== undefined) {
      entry.duration = (duration === '' || duration == null) ? null : parseFloat(duration);
      // Recompute endTime from the existing start so it doesn't go stale vs. the new duration.
      entry.endTime = new Date(entry.time + (entry.duration || 0)*60000).toISOString();
    }
    if (calories !== undefined) entry.calories = (calories === '' || calories == null) ? null : parseFloat(calories);
    if (time) {
      const newTs = resolveEntryTime(time);
      entry.time = newTs;
      entry.startTime = new Date(newTs).toISOString();
      entry.endTime = new Date(newTs + (entry.duration || 0)*60000).toISOString();
    }
    await saveData(data);
    res.json(entry);
  });

  app.delete('/api/activities/workout/:id', requireAuth, async (req, res) => {
    const data = await loadData();
    data.activities = data.activities.filter(a => !(a.type === 'workout' && idMatches(a.id, req.params.id)));
    await saveData(data);
    res.json({ ok: true });
  });

  // ── Insights / summaries / suggestions ────────────────────────────
  app.get('/api/daily-summary', requireAuth, async (req, res) => { res.json(await getDailySummary()); });
  app.get('/api/insulin-health', requireAuth, async (req, res) => {
    try { res.json(await checkInsulinHealth()); }
    catch (e) { res.json({ available: false, message: 'Could not compute insulin health check.' }); }
  });
  app.get('/api/insights', requireAuth, async (req, res) => {
    try { res.json(await analysePatterns()); }
    catch (e) { res.json([{ type: 'info', text: 'Could not generate insights.' }]); }
  });
  // Time-sensitive heads-ups (e.g. "you're inside this workout type's historical drop
  // window") - polled by the Track tab alongside glucose, unlike insights which only load
  // when the Insights tab opens.
  app.get('/api/alerts', requireAuth, async (req, res) => {
    try { res.json(await getActiveAlerts()); }
    catch (e) { res.json([]); }
  });
  // 2h-horizon hypo risk forecast - polled by the Track tab with glucose.
  app.get('/api/hypo-forecast', requireAuth, async (req, res) => {
    try { res.json(await forecastHypoRisk()); }
    catch (e) { res.json({ available: false, message: 'Could not compute forecast.' }); }
  });
  // How the hypo forecast has actually performed against reality - bias/MAE plus whether its
  // warnings were useful (precision/recall). The measuring stick for any model change.
  app.get('/api/forecast-accuracy', requireAuth, async (req, res) => {
    try { res.json(await forecastAccuracy()); }
    catch (e) { res.json({ available: false, message: 'Could not compute forecast accuracy.' }); }
  });
  // "What if I do X for N minutes" simulator.
  app.get('/api/simulate', requireAuth, async (req, res) => {
    try { res.json(await simulateActivity(req.query.type || '', req.query.minutes, req.query.intensity)); }
    catch (e) { res.json({ available: false, message: 'Could not run simulation.' }); }
  });
  // Time-of-day / post-exercise insulin sensitivity map.
  app.get('/api/sensitivity-map', requireAuth, async (req, res) => {
    try { res.json(await sensitivityMap()); }
    catch (e) { res.json({ available: false, message: 'Could not compute sensitivity map.' }); }
  });
  // Remembered outcomes for a named (preset) meal.
  app.get('/api/meal-memory', requireAuth, async (req, res) => {
    if (!req.query.name) return res.status(400).json({ error: 'Meal name required' });
    try { res.json(await getMealMemory(req.query.name)); }
    catch (e) { res.json({ available: false, message: 'Could not load meal memory.' }); }
  });
  app.get('/api/meal-suggestion', requireAuth, async (req, res) => {
    const carbs = parseFloat(req.query.carbs);
    if (!carbs || carbs <= 0) return res.status(400).json({ error: 'Invalid carbs' });
    try { res.json(await suggestMealDose(carbs, req.query.meal || null)); }
    catch (e) { res.json({ suggestion: null, message: 'Could not compute suggestion.' }); }
  });

  // ── CSV export ────────────────────────────────────────────────────
  // Unified sheet across all record types, one `type` discriminator column. Triggered from
  // the frontend via a plain <a href download> - the session cookie rides along, no token
  // wiring needed.
  app.get('/api/export.csv', requireAuth, async (req, res) => {
    const data = await loadData();
    const cols = ['type','time','units','carbs','startGlucose','predictedGlucose','actualGlucose','dropPerUnit','accuracy','workoutType','duration','calories','steps','activeCalories','exerciseMinutes','standHours','glucoseValue','trend'];
    const rows = [];
    data.boluses.forEach(b => rows.push({ type: b.units > 0 ? 'bolus' : 'carbs_only', time: b.time, units: b.units || null, carbs: b.carbs }));
    data.basalDoses.forEach(b => rows.push({ type: 'basal', time: b.time, units: b.units }));
    data.corrections.forEach(c => rows.push({ type: 'correction', time: c.time, units: c.units, startGlucose: c.startGlucose, predictedGlucose: c.predictedGlucose, actualGlucose: c.actualGlucose, dropPerUnit: c.dropPerUnit, accuracy: c.accuracy }));
    data.activities.forEach(a => {
      if (a.type === 'workout') rows.push({ type: 'workout', time: a.time, workoutType: a.workoutType, duration: a.duration, calories: a.calories });
      else rows.push({ type: 'daily_summary', time: a.time, activeCalories: a.activeCalories, exerciseMinutes: a.exerciseMinutes, standHours: a.standHours, steps: a.steps });
    });
    data.glucoseHistory.forEach(g => rows.push({ type: 'glucose', time: g.time, glucoseValue: g.value, trend: g.trend }));
    rows.sort((a, b) => a.time - b.time);
    const csvEscape = v => { if (v == null) return ''; const s = String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const lines = [cols.join(',')];
    rows.forEach(r => lines.push(cols.map(c => c === 'time' ? new Date(r.time).toISOString() : csvEscape(r[c])).join(',')));
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="diabetes-tracker-export.csv"');
    res.send(lines.join('\n'));
  });
}

module.exports = { registerRoutes };

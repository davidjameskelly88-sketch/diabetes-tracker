// ─── Pattern analysis / domain logic ──────────────────────────────────
// Correction resolution, pattern insights, dose suggestions, daily summary, and the
// insulin health check. Everything here reads the whole data blob via loadData().
const { loadData, saveData } = require('./store');
const { MIN_PLAUSIBLE_FACTOR, MAX_SUGGESTED_UNITS, MIN_EFFECTIVE_CORRECTION_UNITS } = require('./config');
const { getGlucoseCache } = require('./libre');

// Ids are mixed ints (Date.now()) and floats (Date.now()+Math.random()), so compare as strings.
const idEq = (a, b) => a != null && b != null && String(a) === String(b);

// ─── Correction resolution ────────────────────────────────────────────
// A logged correction is stored unresolved (actualGlucose: null); on every glucose fetch
// this checks each pending one: wait at least 2.5h, give up after 4h, otherwise record the
// reading closest to the 3h mark and derive dropPerUnit/accuracy from it.
async function resolveCorrections() {
  const data = await loadData();
  let changed = false;
  for (const c of data.corrections) {
    if (c.actualGlucose !== null || c.giveUp) continue; // already resolved, or already gave up
    const elapsed = Date.now() - c.time;
    if (elapsed < 150 * 60000) continue; // wait at least 2.5 hours
    if (elapsed > 240 * 60000) { // give up after 4 hours
      // giveUp is a distinct flag from actualGlucose/resolved (which stay null/false) so this
      // correction stops being re-processed on every future poll - without it, a timed-out
      // correction gets re-evaluated and re-saved every ~5min forever, since actualGlucose
      // never becomes non-null to satisfy the skip-check above.
      c.actualGlucose = null; c.resolved = false; c.giveUp = true; changed = true; continue;
    }
    // Find glucose reading closest to 3 hours after correction
    const targetTime = c.time + 180 * 60000;
    const candidates = data.glucoseHistory.filter(g =>
      Math.abs(g.time - targetTime) < 30 * 60000
    );
    if (candidates.length > 0) {
      candidates.sort((a, b) => Math.abs(a.time - targetTime) - Math.abs(b.time - targetTime));
      c.actualGlucose = candidates[0].value;
      c.resolvedAt = candidates[0].time;
      c.resolved = true;
      c.accuracy = c.predictedGlucose ? parseFloat(Math.abs(c.actualGlucose - c.predictedGlucose).toFixed(1)) : null;

      // Two kinds of carbs confound a correction, and they deserve different treatment:
      //
      // 1. LATER carbs - an unplanned snack partway through the window. Timing and absorption
      //    are unknown when the dose was decided, so the drop can't be attributed. Excluded,
      //    as before.
      // 2. CONCURRENT carbs - a meal dosed together with the correction (the paired entry from
      //    a combined log, or carbs logged in the 30min before). These are known at dose time
      //    and fully inside the window, so they can be netted out algebraically:
      //      drop = units*factor - carbs*(factor/carbRatio)
      //      => factor = drop / (units - carbs/carbRatio)
      //    i.e. divide the drop by "effective correction units" left after carb coverage.
      //    Carbs eaten >30min before are deliberately NOT netted out - they've already begun
      //    absorbing and are therefore reflected in startGlucose itself.
      const drop = c.startGlucose - c.actualGlucose;
      const laterCarbs = data.boluses
        .filter(b => b.carbs > 0 && b.time > c.time && b.time <= c.resolvedAt && !idEq(b.id, c.linkedBolusId))
        .reduce((s, b) => s + b.carbs, 0);
      const concurrentCarbs = c.mealCarbs > 0 ? c.mealCarbs : data.boluses
        .filter(b => b.carbs > 0 && b.time >= c.time - 30 * 60000 && b.time <= c.time)
        .reduce((s, b) => s + b.carbs, 0);
      const carbRatio = data.settings.carbRatio;

      c.interferingCarbs = laterCarbs || null;
      c.concurrentCarbs = concurrentCarbs || null;
      c.carbAdjusted = false;
      c.effectiveUnits = null;

      if (laterCarbs > 0 || !(c.units > 0)) {
        // Unattributable - keep it out of the factor average entirely.
        c.carbInterference = true;
        c.dropPerUnit = c.units > 0 ? parseFloat((drop / c.units).toFixed(2)) : 0;
      } else if (concurrentCarbs > 0) {
        const effective = carbRatio ? c.units - concurrentCarbs / carbRatio : null;
        if (effective != null && effective >= MIN_EFFECTIVE_CORRECTION_UNITS) {
          c.effectiveUnits = parseFloat(effective.toFixed(2));
          c.dropPerUnit = parseFloat((drop / effective).toFixed(2));
          c.carbAdjusted = true;   // usable, but derived via the manual carbRatio - lower confidence
          c.carbInterference = false;
        } else {
          // No carbRatio to net with, or the dose was essentially all carb coverage - either way
          // there's no trustworthy correction signal left in it.
          c.carbInterference = true;
          c.dropPerUnit = parseFloat((drop / c.units).toFixed(2));
        }
      } else {
        c.carbInterference = false;
        c.dropPerUnit = parseFloat((drop / c.units).toFixed(2));
      }
      changed = true;
      console.log(`✅ Correction resolved: ${c.startGlucose} → ${c.actualGlucose} (predicted ${c.predictedGlucose})`);
    }
  }
  if (changed) await saveData(data);
}

function median(arr) {
  const s = arr.slice().sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

// ─── Insulin on board (server-side) ───────────────────────────────────
// Same exponential Loop/OpenAPS-style model as public/app.js - deliberately duplicated
// because the two runtimes share no bundle. If you tune IOB_PEAK/IOB_DIA, change BOTH files
// together or the chart overlay and the dose suggestions will disagree about what's active.
const IOB_PEAK = 75, IOB_DIA = 240;
const _iobTau = IOB_PEAK * (1 - IOB_PEAK / IOB_DIA) / (1 - 2 * IOB_PEAK / IOB_DIA);
const _iobA = 2 * _iobTau / IOB_DIA;
const _iobS = 1 / (1 - _iobA + (1 + _iobA) * Math.exp(-IOB_DIA / _iobTau));
function iobFraction(t) {
  if (t <= 0) return 1;
  if (t >= IOB_DIA) return 0;
  return 1 - _iobS * (1 - _iobA) * ((t * t / (_iobTau * IOB_DIA * (1 - _iobA)) - t / _iobTau - 1) * Math.exp(-t / _iobTau) + 1);
}
// Total insulin still active right now - boluses AND corrections, both are Novorapid.
function activeInsulin(data, at = Date.now()) {
  let total = 0;
  for (const b of data.boluses) { const m = (at - b.time) / 60000; if (m > 0 && m < IOB_DIA) total += b.units * iobFraction(m); }
  for (const c of data.corrections) { const m = (at - c.time) / 60000; if (m > 0 && m < IOB_DIA) total += c.units * iobFraction(m); }
  return total;
}

// Insulin action expected within the next `horizonMin` minutes - the slice of each dose's
// remaining curve that will actually land inside the window, not the whole-tail IOB number.
// This is what makes a 2h forecast honest: a dose injected 3.5h ago has IOB left but almost
// none of it acts in the next 2h.
function insulinActionWithin(data, horizonMin, at = Date.now()) {
  let units = 0;
  for (const x of [...data.boluses, ...data.corrections]) {
    if (!(x.units > 0)) continue;
    const age = (at - x.time) / 60000;
    if (age < 0 || age >= IOB_DIA) continue;
    units += x.units * (iobFraction(age) - iobFraction(age + horizonMin));
  }
  return units;
}

// Carb absorption expected within the next `horizonMin` minutes (linear COB model).
function cobFraction(t) { if (t <= 0) return 1; if (t >= 180) return 0; return 1 - t / 180; }
function carbAbsorptionWithin(data, horizonMin, at = Date.now()) {
  let grams = 0;
  for (const b of data.boluses) {
    if (!(b.carbs > 0)) continue;
    const age = (at - b.time) / 60000;
    if (age < 0 || age >= 180) continue;
    grams += b.carbs * (cobFraction(age) - cobFraction(age + horizonMin));
  }
  return grams;
}
function carbsOnBoard(data, at = Date.now()) {
  return data.boluses.reduce((s, b) => s + (b.carbs > 0 ? b.carbs * cobFraction((at - b.time) / 60000) : 0), 0);
}

// ─── Shared dosing context ────────────────────────────────────────────
// Everything a dose suggestion needs to know about "right now", used by the standalone
// correction suggestion, the meal-suggestion correction add-on, and the workout advisor:
// - effective glucose: current projected ~30min ahead from the live trend rate. Deliberately
//   asymmetric - a falling trend gets full credit (less insulin suggested), a rising trend
//   only half (a lingering high is correctable later; an over-dosed low is not). Clamped to
//   ±2 mmol/L so a noisy two-point delta can't swing the number wildly.
// - iob: active insulin to subtract from any suggested units (stacked doses landing together
//   is the classic post-correction hypo). COB isn't credited back, which biases every
//   suggestion toward *less* insulin - the safe direction for this app's purpose.
// - stale/ageMin: LibreLinkUp follower data routinely lags 15-20min; beyond 30min the number
//   shouldn't be dosed against without a glance at the primary app. Age comes from readingMs
//   (a correct UTC epoch, see parseLibreTimestamp in libre.js) so it's right on any timezone.
function dosingContext(data) {
  const gc = getGlucoseCache();
  const current = (gc && !gc.error) ? gc.value : null;
  let ageMin = null;
  if (current != null) {
    // readingMs is the correct UTC epoch from libre.js; fall back to the raw string only for
    // safety. (Re-parsing the un-zoned string is what inflated the age by the UTC offset.)
    const ts = gc.readingMs || new Date(gc.timestamp).getTime() || gc.fetchedAt;
    ageMin = Math.max(0, Math.round((Date.now() - ts) / 60000));
  }
  let projected = null;
  if (current != null && gc.delta != null && gc.deltaMinutes > 0) {
    const rate = gc.delta / gc.deltaMinutes;
    let adj = Math.max(-2, Math.min(2, rate * 30));
    if (adj > 0) adj = adj / 2;
    if (Math.abs(adj) >= 0.2) projected = parseFloat((current + adj).toFixed(1));
  }
  return {
    current,
    projected,
    effective: projected != null ? projected : current,
    iob: parseFloat(activeInsulin(data).toFixed(1)),
    ageMin,
    stale: ageMin != null && ageMin > 30,
  };
}

// ─── Per-workout-type response profiles ───────────────────────────────
// The aggregated "what does THIS kind of workout do to my glucose" view: for every session
// of the same workoutType that has glucose data, measure baseline (30min pre-start) vs. the
// nadir in the 8h after finishing - delayed post-exercise drops routinely land hours later,
// well outside the during-workout window the individual insights look at. Grouped by exact
// workoutType string (the reason workout presets exist). Uses the full 14-day glucose
// retention rather than analysePatterns' 7-day scope: per-type patterns need every session
// they can get, and each session is timestamped so wider history doesn't blur the language.
function workoutTypeProfiles(data) {
  const { targetLow } = data.settings;
  const byType = {};
  data.activities
    .filter(a => a.type === 'workout' && a.startTime && a.endTime)
    .forEach(w => { const k = w.workoutType || 'Exercise'; (byType[k] = byType[k] || []).push(w); });

  const profiles = [];
  for (const [type, list] of Object.entries(byType)) {
    const sessions = [];
    for (const w of list) {
      const startTs = new Date(w.startTime).getTime();
      const endTs = new Date(w.endTime).getTime();
      const before = data.glucoseHistory.filter(g => g.time >= startTs - 30*60000 && g.time < startTs);
      const post = data.glucoseHistory.filter(g => g.time > endTs && g.time <= endTs + 8*3600000);
      if (!before.length || post.length < 4) continue; // needs a real baseline and a real post-window
      const baseline = before.reduce((s, g) => s + g.value, 0) / before.length;
      let nadir = Infinity, nadirTime = null;
      post.forEach(g => { if (g.value < nadir) { nadir = g.value; nadirTime = g.time; } });
      sessions.push({
        drop: baseline - nadir,
        hoursToNadir: (nadirTime - endTs) / 3600000,
        wentLow: nadir < targetLow,
        duration: w.duration || null,
      });
    }
    if (sessions.length >= 2) {
      const durations = sessions.map(s => s.duration).filter(d => d > 0);
      profiles.push({
        type,
        sessions: sessions.length,
        medianDrop: median(sessions.map(s => s.drop)),
        medianHoursToNadir: median(sessions.map(s => s.hoursToNadir)),
        medianDuration: durations.length ? median(durations) : null,
        lowCount: sessions.filter(s => s.wentLow).length,
        // How repeatable the drop is - share of sessions with a meaningful (>1.5) fall.
        dropShare: sessions.filter(s => s.drop > 1.5).length / sessions.length,
      });
    }
  }
  return profiles;
}

// ─── Live alerts (Track tab heads-up) ─────────────────────────────────
// Time-sensitive prompts, distinct from insights: an insight says "this pattern exists",
// an alert says "that pattern is about to apply to you RIGHT NOW". Surfaced on the Track
// tab where logging happens, not buried in the Insights tab.
async function getActiveAlerts() {
  const data = await loadData();
  const alerts = [];
  const now = Date.now();

  // Post-workout delayed-drop window: if a workout of a type with a proven repeatable drop
  // profile ended recently, warn while inside that type's historical drop window.
  const profiles = workoutTypeProfiles(data);
  for (const w of data.activities.filter(a => a.type === 'workout' && a.endTime)) {
    const hoursSince = (now - new Date(w.endTime).getTime()) / 3600000;
    if (hoursSince < 0 || hoursSince > 8) continue;
    const p = profiles.find(x => x.type === (w.workoutType || 'Exercise'));
    if (!p || p.dropShare < 0.6 || p.medianDrop < 1.5) continue;
    const windowEnd = Math.min(8, p.medianHoursToNadir + 2);
    if (hoursSince > windowEnd) continue;
    const eta = p.medianHoursToNadir - hoursSince;
    alerts.push({
      type: 'warning',
      text: eta > 0.5
        ? `Heads-up: after "${p.type}" your glucose typically hits its low ~${p.medianHoursToNadir.toFixed(1)}h post-workout (median drop ${p.medianDrop.toFixed(1)} mmol/L, ${p.sessions} sessions). That's ~${eta.toFixed(1)}h away — keeping carbs handy and easing off rapid insulin until then may prevent a dip.`
        : `You're in the window where "${p.type}" usually pulls glucose down (median drop ${p.medianDrop.toFixed(1)} mmol/L across ${p.sessions} sessions). Watch for a dip and consider carbs if trending low.`,
    });
  }

  // Stacked corrections: a second dose while the first is still mid-action overlaps both
  // curves - worth a live nudge at logging time, not just a retrospective insight.
  const recentCorr = data.corrections.filter(c => now - c.time < 2.5*3600000);
  if (recentCorr.length >= 2) {
    alerts.push({
      type: 'warning',
      text: `${recentCorr.length} corrections within ~2.5h (${recentCorr.map(c => c.units + 'u').join(', ')}) — stacked doses overlap and can overshoot. Mind the combined effect before adding more.`,
    });
  }

  // Bedtime low-risk check (21:00-02:00): heading to sleep with glucose modest-and-falling,
  // or with a meaningful amount of insulin still active, is how overnight lows start - and
  // overnight is when a low goes unnoticed longest.
  const hr = new Date().getHours();
  if (hr >= 21 || hr < 2) {
    const ctx = dosingContext(data);
    if (ctx.current != null) {
      const falling = ctx.projected != null && ctx.projected < ctx.current;
      if ((ctx.current < 6 && falling) || (ctx.current < 7 && ctx.iob > 1)) {
        const bits = [`glucose ${ctx.current}`];
        if (falling) bits.push(`falling (projected ~${ctx.projected} in 30min)`);
        if (ctx.iob > 1) bits.push(`${ctx.iob}u still active`);
        alerts.push({ type: 'warning', text: `Bedtime check: ${bits.join(', ')} — a small snack before sleep may head off an overnight low.` });
      }
    }
  }

  return alerts;
}

// ─── Pattern analysis ─────────────────────────────────────────────────
async function analysePatterns() {
  const data = await loadData();
  const { boluses, basalDoses, corrections, activities, glucoseHistory: allGlucoseHistory, settings } = data;
  const { targetLow, targetHigh } = settings;
  const insights = [];

  // glucoseHistory itself retains 14 days (see the prune cutoff in libre.js, extended for
  // checkInsulinHealth()'s week-over-week comparison) - pattern analysis deliberately keeps
  // looking at just the trailing 7 days so its "over the last 7 days" / hour-bucket language
  // below stays accurate and doesn't quietly start meaning something wider.
  const glucoseHistory = allGlucoseHistory.filter(g => g.time >= Date.now() - 7*24*60*60*1000);

  if (glucoseHistory.length < 20) {
    return [{ type:'info', text:'Keep logging — pattern analysis needs a few days of data.' }];
  }

  // 1. Correction factor analysis (exclude corrections confounded by carbs eaten during the window)
  const resolved = corrections.filter(c => c.resolved && c.dropPerUnit != null && !c.carbInterference);
  if (resolved.length >= 3) {
    const factors = resolved.map(c => c.dropPerUnit);
    const avgFactor = factors.reduce((a,b) => a+b, 0) / factors.length;
    insights.push({
      type: 'positive',
      text: `Your average correction factor is ${avgFactor.toFixed(1)} mmol/L drop per unit of Novorapid (based on ${resolved.length} corrections). For example, ${(avgFactor * 2).toFixed(1)} mmol/L drop for 2 units.`,
    });
    // Accuracy of predictions
    const withPrediction = resolved.filter(c => c.accuracy != null);
    if (withPrediction.length >= 3) {
      const avgAccuracy = withPrediction.reduce((s,c) => s + c.accuracy, 0) / withPrediction.length;
      insights.push({
        type: avgAccuracy < 1.5 ? 'positive' : 'info',
        text: `Your correction predictions are off by an average of ${avgAccuracy.toFixed(1)} mmol/L. ${avgAccuracy < 1.5 ? 'Pretty accurate!' : 'The suggested correction factor above may help improve this.'}`,
      });
    }
  }

  // 2. Exercise day vs rest day correction factors
  const exerciseDays = new Set();
  activities.filter(a => a.type === 'workout' || (a.type === 'daily_summary' && a.exerciseMinutes > 15)).forEach(a => {
    exerciseDays.add(new Date(a.time).toDateString());
  });
  const exCorr = resolved.filter(c => exerciseDays.has(new Date(c.time).toDateString()));
  const restCorr = resolved.filter(c => !exerciseDays.has(new Date(c.time).toDateString()));
  if (exCorr.length >= 2 && restCorr.length >= 2) {
    const exFactor = exCorr.reduce((s,c) => s + c.dropPerUnit, 0) / exCorr.length;
    const restFactor = restCorr.reduce((s,c) => s + c.dropPerUnit, 0) / restCorr.length;
    if (Math.abs(exFactor - restFactor) > 0.3) {
      insights.push({
        type: 'positive',
        text: `Correction sensitivity on exercise days: ${exFactor.toFixed(1)} mmol/L/unit vs rest days: ${restFactor.toFixed(1)} mmol/L/unit. ${exFactor > restFactor ? 'You\'re more sensitive to insulin on days you train.' : 'Interestingly, you seem less sensitive on exercise days.'}`,
      });
    }
  }

  // 3. Post-exercise glucose impact - segmented into before/during/after. A single
  // before-vs-after delta misses what actually happens *during* the activity (e.g. glucose
  // plummeting mid-walk then recovering afterward would net out looking like barely any
  // change at all). "Before" is anchored to the workout's start, not its end - the previous
  // version's 30min-before-*end* window was actually sampling the tail of the workout itself
  // for anything longer than 30min, not a true pre-exercise baseline.
  // Only sessions from the last 48h show individually - the per-type profiles below carry
  // the longer history, so older one-off session reports would just pad the list.
  const workouts = activities.filter(a => a.type === 'workout' && a.startTime && a.endTime);
  const recentWorkouts = workouts.filter(w => Date.now() - new Date(w.endTime).getTime() < 48*3600000);
  for (const w of recentWorkouts) {
    const startTs = new Date(w.startTime).getTime();
    const endTs = new Date(w.endTime).getTime();
    const before = glucoseHistory.filter(g => g.time >= startTs - 30*60000 && g.time < startTs);
    const during = glucoseHistory.filter(g => g.time >= startTs && g.time <= endTs);
    const after = glucoseHistory.filter(g => g.time > endTs + 30*60000 && g.time <= endTs + 180*60000);
    if (before.length === 0 || during.length === 0) continue;

    const beforeAvg = before.reduce((s,r) => s+r.value, 0) / before.length;
    const duringMin = Math.min(...during.map(g => g.value));
    const duringMax = Math.max(...during.map(g => g.value));
    const duringLast = during[during.length - 1].value;
    // The more pronounced swing during the activity itself, relative to baseline - a
    // workout can swing either way, and the bigger deviation is the more relevant one.
    const dropDuring = beforeAvg - duringMin;
    const riseDuring = duringMax - beforeAvg;
    const duringIsDrop = dropDuring >= riseDuring;
    const duringDelta = duringIsDrop ? dropDuring : riseDuring;

    let afterDelta = null;
    if (after.length > 0) {
      const afterAvg = after.reduce((s,r) => s+r.value, 0) / after.length;
      afterDelta = afterAvg - duringLast;
    }

    if (duringDelta > 0.5 || (afterDelta != null && Math.abs(afterDelta) > 0.5)) {
      const hr = w.avgHeartRate ? ` (avg HR ${w.avgHeartRate}bpm${w.maxHeartRate?', max '+w.maxHeartRate:''})` : '';
      let text = `During "${w.workoutType||'exercise'}" (${w.duration?Math.round(w.duration):'?'}min)${hr}, glucose ${duringIsDrop?'dropped':'rose'} ${duringDelta.toFixed(1)} mmol/L`;
      if (afterDelta != null && Math.abs(afterDelta) > 0.5) {
        text += `, then ${afterDelta<0?'dropped':'rose'} a further ${Math.abs(afterDelta).toFixed(1)} mmol/L over the following ~2.5h`;
      } else if (afterDelta != null) {
        text += `, staying fairly steady afterward`;
      }
      text += '.';
      // A drop during exercise, or a delayed drop afterward, is the actual hypo-risk signal -
      // a rise during exercise (adrenaline/glycogen response) isn't itself concerning.
      let type;
      if (afterDelta != null && afterDelta < -0.8) type = 'warning';
      else if (duringIsDrop && duringDelta > 0.8) type = 'warning';
      else if (duringIsDrop) type = 'positive';
      else type = 'info';
      insights.push({ type, text, time: w.endTime });
    }
  }

  // 3b. Per-workout-type response profiles - the repeatable version of #3. Pools every
  // session of the same workoutType with glucose data (full 14-day retention) and reports
  // the *pattern*, with a concrete suggestion when a delayed drop is consistent. This is
  // also what feeds the live post-workout alert on the Track tab (getActiveAlerts).
  const typeProfiles = workoutTypeProfiles(data);
  for (const p of typeProfiles) {
    if (p.dropShare >= 0.6 && p.medianDrop >= 1.5) {
      const lows = p.lowCount ? ` ${p.lowCount} of ${p.sessions} sessions dipped below ${targetLow}.` : '';
      insights.push({
        type: 'warning',
        text: `Pattern: after "${p.type}", glucose reliably falls — median drop ${p.medianDrop.toFixed(1)} mmol/L, lowest ~${p.medianHoursToNadir.toFixed(1)}h after finishing (${p.sessions} sessions).${lows} Having 10–15g of carbs after finishing, or easing off rapid insulin through that window, may prevent the dip.`,
      });
    } else if (p.medianDrop <= -1.0) {
      insights.push({
        type: 'info',
        text: `Pattern: "${p.type}" tends to push glucose up rather than down (median rise ${Math.abs(p.medianDrop).toFixed(1)} mmol/L across ${p.sessions} sessions) — a normal adrenaline/glycogen response to intense exercise, worth factoring into meal timing around it.`,
      });
    }
  }

  // 4. Time-of-day patterns
  const hourBuckets = {};
  glucoseHistory.forEach(g => { const h=new Date(g.time).getHours(); if(!hourBuckets[h])hourBuckets[h]=[]; hourBuckets[h].push(g.value); });
  let highH=null,lowH=null,highV=0,lowV=99;
  Object.entries(hourBuckets).forEach(([h,vals]) => {
    if(vals.length<3)return; const avg=vals.reduce((a,b)=>a+b,0)/vals.length;
    if(avg>highV){highV=avg;highH=parseInt(h)} if(avg<lowV){lowV=avg;lowH=parseInt(h)}
  });
  if(highH!==null&&highV>8) insights.push({type:'warning',text:`Glucose tends highest around ${highH}:00 (avg ${highV.toFixed(1)} mmol/L).`});
  if(lowH!==null&&lowV<4.5) insights.push({type:'warning',text:`Glucose tends lowest around ${lowH}:00 (avg ${lowV.toFixed(1)} mmol/L). Watch for hypos.`});

  // 5. Exercise vs rest day glucose
  const exDayR=[],restDayR=[];
  glucoseHistory.forEach(g=>{const d=new Date(g.time).toDateString();if(exerciseDays.has(d))exDayR.push(g.value);else restDayR.push(g.value)});
  if(exDayR.length>10&&restDayR.length>10){
    const exA=exDayR.reduce((a,b)=>a+b,0)/exDayR.length;
    const rA=restDayR.reduce((a,b)=>a+b,0)/restDayR.length;
    const diff=rA-exA;
    if(Math.abs(diff)>0.3) insights.push({type:diff>0?'positive':'info',text:`Average glucose on exercise days: ${exA.toFixed(1)} vs rest days: ${rA.toFixed(1)} mmol/L (${diff>0 ? diff.toFixed(1)+' lower' : Math.abs(diff).toFixed(1)+' higher'} with exercise).`});
  }

  // 6. Time in range
  const inRange=glucoseHistory.filter(g=>g.value>=targetLow&&g.value<=targetHigh).length;
  const tir=((inRange/glucoseHistory.length)*100).toFixed(0);
  insights.push({type:parseInt(tir)>=70?'positive':'info',text:`Time in range (${targetLow}–${targetHigh}): ${tir}% across ${glucoseHistory.length} readings.`});

  // 7. Dawn phenomenon - overnight glucose rise while fasting. Reuses hourBuckets from #4
  // (each hour's readings pooled across the trailing 7 days) rather than a day-of-week or
  // weekend-vs-weekday comparison - analysePatterns() deliberately only looks at the trailing
  // 7 days (see glucoseHistory filter above), so there's ever only one Monday/Saturday etc. in
  // scope at a time, too thin a sample to call a "pattern" rather than noise.
  const overnightAvgs=[1,2,3,4,5].map(h=>hourBuckets[h]).filter(a=>a&&a.length>=3).map(a=>a.reduce((s,v)=>s+v,0)/a.length);
  const morningAvgs=[6,7,8,9].map(h=>hourBuckets[h]).filter(a=>a&&a.length>=3).map(a=>a.reduce((s,v)=>s+v,0)/a.length);
  if(overnightAvgs.length&&morningAvgs.length){
    const overnightMin=Math.min(...overnightAvgs), morningMax=Math.max(...morningAvgs);
    const rise=morningMax-overnightMin;
    if(rise>1.2) insights.push({type:'warning',text:`Possible dawn phenomenon: glucose tends to climb from ~${overnightMin.toFixed(1)} overnight to ~${morningMax.toFixed(1)} mmol/L by morning (a ${rise.toFixed(1)} mmol/L rise), consistent with the liver's early-morning hormone release.`});
  }

  // 8. Hypo/hyper clustering by time-of-day window - distinct from #4's single highest/lowest
  // *average* hour: this looks at where actual out-of-range readings concentrate, grouped into
  // 4h windows to smooth single-hour noise. A hypo cluster is the more actionable of the two,
  // since it points at a specific window worth watching rather than just an average.
  const windowLabel=h=>h<4?'midnight–4am':h<8?'4–8am':h<12?'8am–noon':h<16?'noon–4pm':h<20?'4–8pm':'8pm–midnight';
  function dominantWindow(readings){
    if(readings.length<6)return null;
    const counts={};
    readings.forEach(g=>{const w=windowLabel(new Date(g.time).getHours());counts[w]=(counts[w]||0)+1});
    const [label,count]=Object.entries(counts).sort((a,b)=>b[1]-a[1])[0];
    const share=count/readings.length;
    return share>=0.35?{label,share}:null;
  }
  const lowWindow=dominantWindow(glucoseHistory.filter(g=>g.value<targetLow));
  if(lowWindow) insights.push({type:'warning',text:`${Math.round(lowWindow.share*100)}% of your low readings (below ${targetLow}) fall between ${lowWindow.label}.`});
  const highWindow=dominantWindow(glucoseHistory.filter(g=>g.value>targetHigh));
  if(highWindow) insights.push({type:'info',text:`${Math.round(highWindow.share*100)}% of your high readings (above ${targetHigh}) fall between ${highWindow.label}.`});

  // 9. Meal-size outcome patterns - bucket dosed meals into small/medium/large by carbs using
  // tertiles (this user's own meal-size distribution) rather than fixed gram cutoffs, since
  // typical portion sizes vary a lot person to person. Mirrors suggestMealDose()'s nadir/
  // correction-needed signals but surfaces them per size bucket instead of folding into one
  // suggestion number.
  const sizedMeals=boluses.filter(b=>b.units>0&&b.carbs>0).slice().sort((a,b)=>a.carbs-b.carbs);
  if(sizedMeals.length>=6){
    const third=Math.ceil(sizedMeals.length/3);
    const sizeBuckets=[
      {label:'Small',meals:sizedMeals.slice(0,third)},
      {label:'Medium',meals:sizedMeals.slice(third,third*2)},
      {label:'Large',meals:sizedMeals.slice(third*2)},
    ];
    sizeBuckets.forEach(({label,meals})=>{
      if(meals.length<2)return;
      const carbsRange=`${Math.round(meals[0].carbs)}–${Math.round(meals[meals.length-1].carbs)}g`;
      const outcomes=meals.map(m=>{
        const post=glucoseHistory.filter(g=>g.time>m.time+30*60000&&g.time<=m.time+240*60000);
        return {
          nadir: post.length?Math.min(...post.map(g=>g.value)):null,
          peak: post.length?Math.max(...post.map(g=>g.value)):null,
          neededCorrection: corrections.some(c=>c.time>m.time&&c.time<m.time+180*60000),
        };
      });
      const withReadings=outcomes.filter(o=>o.nadir!=null);
      if(!withReadings.length)return;
      const avgNadir=withReadings.reduce((s,o)=>s+o.nadir,0)/withReadings.length;
      const avgPeak=withReadings.reduce((s,o)=>s+o.peak,0)/withReadings.length;
      const correctionShare=outcomes.filter(o=>o.neededCorrection).length/outcomes.length;
      if(avgNadir<targetLow){
        insights.push({type:'warning',text:`${label} meals (${carbsRange}, ${meals.length} logged) tend to run low afterward — avg low ${avgNadir.toFixed(1)} mmol/L.`});
      } else if(correctionShare>0.4){
        insights.push({type:'warning',text:`${label} meals (${carbsRange}, ${meals.length} logged) needed a correction afterward ${Math.round(correctionShare*100)}% of the time — avg peak ${avgPeak.toFixed(1)} mmol/L.`});
      } else if(avgPeak<=targetHigh&&avgNadir>=targetLow){
        insights.push({type:'positive',text:`${label} meals (${carbsRange}, ${meals.length} logged) usually stay in range afterward (avg peak ${avgPeak.toFixed(1)}, avg low ${avgNadir.toFixed(1)} mmol/L).`});
      }
    });
  }

  // 10. Glucose variability (coefficient of variation) - a standard complement to time-in-range;
  // ADA/ATTD consensus treats <=36% as the usual stability target. Reported as a single trailing-
  // 7-day snapshot (matching this function's own 7-day scoping above), not trended week-over-week.
  const gVals=glucoseHistory.map(g=>g.value);
  const gMean=gVals.reduce((a,b)=>a+b,0)/gVals.length;
  const gVariance=gVals.reduce((s,v)=>s+(v-gMean)**2,0)/gVals.length;
  const cv=Math.sqrt(gVariance)/gMean*100;
  insights.push({type:cv<=36?'positive':'warning',text:`Glucose variability (CV) over the last 7 days: ${cv.toFixed(0)}%. ${cv<=36?'Within the usual ≤36% stability target.':'Above the usual 36% stability target — swings are larger than ideal.'}`});

  // 11. Insulin-sensitivity trend - unlike #10, this can legitimately look further back than 7
  // days since corrections (unlike glucoseHistory) are kept indefinitely. Compares the earlier
  // vs later half of clean resolved corrections chronologically, not calendar weeks.
  if(resolved.length>=6){
    const sortedResolved=resolved.slice().sort((a,b)=>a.time-b.time);
    const mid=Math.floor(sortedResolved.length/2);
    const earlier=sortedResolved.slice(0,mid), later=sortedResolved.slice(mid);
    const earlierAvg=earlier.reduce((s,c)=>s+c.dropPerUnit,0)/earlier.length;
    const laterAvg=later.reduce((s,c)=>s+c.dropPerUnit,0)/later.length;
    const factorDiff=laterAvg-earlierAvg;
    if(Math.abs(factorDiff)>0.3){
      insights.push({type:'info',text:`Your insulin sensitivity may be ${factorDiff>0?'increasing':'decreasing'} — correction factor averaged ${earlierAvg.toFixed(1)} mmol/L/unit in your earlier logged corrections, vs ${laterAvg.toFixed(1)} more recently.`});
    }
  }

  // 12. Basal timing consistency - long-acting insulin covers ~24h, so dose-time drift
  // creates coverage gaps/overlaps at the boundaries. Spread is minutes-of-day over the
  // trailing 14 days; a >12h spread almost certainly means a deliberate schedule change or
  // a data oddity rather than drift, so it's skipped instead of misread.
  const recentBasal = basalDoses.filter(b => b.time >= Date.now() - 14*86400000);
  if (recentBasal.length >= 5) {
    const mins = recentBasal.map(b => { const d = new Date(b.time); return d.getHours()*60 + d.getMinutes(); });
    const spread = Math.max(...mins) - Math.min(...mins);
    if (spread > 90 && spread < 720) {
      insights.push({ type: 'warning', text: `Lantus timing has varied by up to ${(spread/60).toFixed(1)}h over the last 2 weeks — long-acting insulin covers steadiest when taken at a consistent time each day.` });
    }
  }

  // 13. Correction stacking - a second correction inside 2h overlaps the first dose's
  // action curve (it's still mid-peak). Only flagged once it has actually produced lows,
  // so an occasional deliberate split dose doesn't nag.
  const sortedCorr = corrections.slice().sort((a, b) => a.time - b.time);
  let stackedCount = 0, stackedLowCount = 0;
  for (let i = 1; i < sortedCorr.length; i++) {
    if (sortedCorr[i].time - sortedCorr[i-1].time < 2*3600000) {
      stackedCount++;
      const after = allGlucoseHistory.filter(g => g.time > sortedCorr[i].time && g.time <= sortedCorr[i].time + 4*3600000);
      if (after.length && Math.min(...after.map(g => g.value)) < targetLow) stackedLowCount++;
    }
  }
  if (stackedCount >= 2 && stackedLowCount >= 1) {
    insights.push({ type: 'warning', text: `Stacked corrections (a second dose within 2h of the first) happened ${stackedCount} times, and ${stackedLowCount} ended below ${targetLow} — the first dose is still working when the second goes in. Waiting out the first correction's ~3h window usually avoids this.` });
  }

  // 14. Evening exercise -> overnight lows. Delayed-onset post-exercise hypos cluster
  // overnight when training happens in the evening; compares the following night's
  // 00:00-06:00 minimum after evening (17:00+) workouts vs. nights without one. Uses the
  // full 14-day history - each "night" is a self-contained sample, so the 7-day language
  // constraint doesn't apply, and overnight comparisons need all the nights they can get.
  const eveningWorkoutNights = new Set();
  workouts.forEach(w => {
    const end = new Date(w.endTime);
    if (end.getHours() >= 17) {
      const night = new Date(end);
      night.setDate(night.getDate() + 1); // the overnight window belongs to the next calendar day
      eveningWorkoutNights.add(night.toDateString());
    }
  });
  const nightMins = {};
  allGlucoseHistory.forEach(g => {
    const d = new Date(g.time);
    if (d.getHours() < 6) {
      const key = d.toDateString();
      if (!(key in nightMins) || g.value < nightMins[key]) nightMins[key] = g.value;
    }
  });
  const afterExNights = [], otherNights = [];
  Object.entries(nightMins).forEach(([k, v]) => (eveningWorkoutNights.has(k) ? afterExNights : otherNights).push(v));
  if (afterExNights.length >= 2 && otherNights.length >= 2) {
    const diff = median(otherNights) - median(afterExNights);
    if (diff > 0.8) {
      insights.push({ type: 'warning', text: `Nights after evening exercise run lower — typical 00:00–06:00 low of ${median(afterExNights).toFixed(1)} vs ${median(otherNights).toFixed(1)} mmol/L on other nights. A bedtime snack on training days may cushion this.` });
    }
  }

  // 15. Hypo recovery - how treatments of actual lows (<3.9, the clinical threshold) play
  // out: how long back to safety, and whether treating tends to overshoot past 10 (the
  // classic over-treat -> rebound-high -> correction -> low-again cycle). Readings <30min
  // apart merge into one episode. Full 14-day history - episodes are self-contained events.
  const lowReadings = allGlucoseHistory.filter(g => g.value < 3.9).sort((a, b) => a.time - b.time);
  const episodes = [];
  lowReadings.forEach(g => {
    const last = episodes[episodes.length - 1];
    if (last && g.time - last.end <= 30*60000) { last.end = g.time; last.nadir = Math.min(last.nadir, g.value); }
    else episodes.push({ start: g.time, end: g.time, nadir: g.value });
  });
  if (episodes.length >= 3) {
    const recoveries = [], overshoots = [];
    episodes.forEach(ep => {
      const after = allGlucoseHistory.filter(g => g.time > ep.end && g.time <= ep.end + 3*3600000).sort((a, b) => a.time - b.time);
      const rec = after.find(g => g.value >= 4.5);
      if (rec) recoveries.push((rec.time - ep.end) / 60000);
      if (after.length) overshoots.push(Math.max(...after.map(g => g.value)) > 10);
    });
    if (recoveries.length >= 2) {
      const overshootShare = overshoots.filter(Boolean).length / (overshoots.length || 1);
      let text = `Hypo recovery: ${episodes.length} lows below 3.9 this fortnight, typically back above 4.5 within ~${Math.round(median(recoveries))}min of the last low reading.`;
      if (overshootShare >= 0.5) text += ` ${Math.round(overshootShare*100)}% rebounded above 10 within 3h — smaller, measured treatments (10–15g, recheck in 15min) may avoid the overshoot.`;
      insights.push({ type: overshootShare >= 0.5 ? 'warning' : 'info', text });
    }
  }

  // 16. Time-of-day sensitivity spread - the headline from the sensitivity map, surfaced as
  // an insight when two buckets each have enough corrections (n>=3) and differ by >=25%.
  {
    const inBucket = (h, b) => b.from < b.to ? (h >= b.from && h < b.to) : (h >= b.from || h < b.to);
    const bucketAvgs = SENS_BUCKETS.map(b => {
      const corr = resolved.filter(c => inBucket(new Date(c.time).getHours(), b));
      return { label: b.label.toLowerCase(), range: b.range, count: corr.length, factor: corr.length ? corr.reduce((s, c) => s + c.dropPerUnit, 0) / corr.length : null };
    }).filter(b => b.count >= 3 && b.factor > 0);
    if (bucketAvgs.length >= 2) {
      bucketAvgs.sort((a, b) => b.factor - a.factor);
      const strongest = bucketAvgs[0], weakest = bucketAvgs[bucketAvgs.length - 1];
      const pct = Math.round((strongest.factor / weakest.factor - 1) * 100);
      if (pct >= 25) {
        insights.push({ type: 'info', text: `Sensitivity map: your ${strongest.label} corrections (${strongest.range}) reduce glucose ${pct}% more than ${weakest.label} ones (${strongest.factor.toFixed(1)} vs ${weakest.factor.toFixed(1)} mmol/L per unit) — the same dose lands differently by time of day.` });
      }
    }
  }

  // 17. Delayed-rise meals - the high-fat/protein signature: glucose settles after the first
  // wave, then climbs again 2.5-6h later. Scans all dosed meals with glucose coverage; the
  // per-meal version lives in meal memory, this is the "it's happening across your meals"
  // aggregate view.
  {
    const dosedMeals = boluses.filter(b => b.units > 0 && b.carbs > 0);
    const outcomes = mealOutcomes(data, dosedMeals).filter(o => o.delayedRise !== null);
    const delayed = outcomes.filter(o => o.delayedRise);
    if (outcomes.length >= 5 && delayed.length / outcomes.length >= 0.3) {
      const typicalH = median(delayed.map(o => o.delayedRise.atHours)).toFixed(1);
      insights.push({ type: 'warning', text: `${delayed.length} of your last ${outcomes.length} analysable meals showed a second glucose rise ~${typicalH}h after eating — the classic higher-fat/protein pattern (pizza, takeaway, big evening meals). Worth a glance at glucose 3-4h after those meals, when the first wave looks finished but isn't.` });
    }
  }

  return insights.length?insights:[{type:'info',text:'No strong patterns yet. Keep logging.'}];
}

// ─── Pre-workout advisor ──────────────────────────────────────────────
// "I'm about to do X" -> combines that type's historical profile with right-now context
// (glucose, trend, IOB) into a projected post-workout trough and a concrete suggestion.
// Projected trough = effective glucose - the type's median drop - what the active insulin
// still has left to do (IOB x correction factor, only when the factor is trustworthy).
async function getWorkoutAdvice(type) {
  const data = await loadData();
  const { targetLow } = data.settings;
  const name = String(type || '').trim();
  const profile = workoutTypeProfiles(data).find(p => p.type.toLowerCase() === name.toLowerCase());
  const ctx = dosingContext(data);

  const resolved = data.corrections.filter(c => c.resolved && c.dropPerUnit != null && !c.carbInterference);
  const factor = resolved.length >= 3 ? resolved.reduce((s, c) => s + c.dropPerUnit, 0) / resolved.length : null;
  const factorUsable = factor != null && factor >= MIN_PLAUSIBLE_FACTOR;

  const staleNote = ctx.stale ? ` ⚠️ Reading is ~${ctx.ageMin}min old — check your Libre app first.` : '';

  if (!profile) {
    return {
      known: false, risk: 'unknown',
      advice: `No profile for "${name}" yet — it needs 2+ logged sessions of that exact name with glucose data. General guidance: check glucose before starting, keep fast carbs within reach, and log this session to start building its pattern.${staleNote}`,
    };
  }

  const base = { known: true, sessions: profile.sessions, medianDrop: parseFloat(profile.medianDrop.toFixed(1)), hoursToNadir: parseFloat(profile.medianHoursToNadir.toFixed(1)), currentGlucose: ctx.current, iob: ctx.iob };

  if (ctx.current == null) {
    return { ...base, risk: 'unknown', advice: `"${name}" history (${profile.sessions} sessions): median ${profile.medianDrop >= 0 ? 'drop' : 'rise'} of ${Math.abs(profile.medianDrop).toFixed(1)} mmol/L, low ~${profile.medianHoursToNadir.toFixed(1)}h after finishing. No live glucose right now, so no projection — check your level before starting.` };
  }

  // A type that reliably pushes glucose UP needs different advice entirely.
  if (profile.medianDrop <= -1.0) {
    return { ...base, risk: 'ok', advice: `"${name}" usually pushes your glucose up (median rise ${Math.abs(profile.medianDrop).toFixed(1)} mmol/L across ${profile.sessions} sessions) — an adrenaline response, not a dosing error. You're at ${ctx.current}; expect to run higher during/after, and be wary of correcting mid-session since it often settles on its own.${staleNote}` };
  }

  const iobDrop = factorUsable ? ctx.iob * factor : 0;
  const projectedNadir = parseFloat((ctx.effective - profile.medianDrop - iobDrop).toFixed(1));
  const iobBit = ctx.iob > 0.1 ? ` with ${ctx.iob}u still active` : '';
  const historyBit = `"${name}" historically drops you ~${profile.medianDrop.toFixed(1)} mmol/L (lowest ~${profile.medianHoursToNadir.toFixed(1)}h after finishing, ${profile.sessions} sessions${profile.lowCount ? `, ${profile.lowCount} ended below ${targetLow}` : ''})`;

  let risk, advice;
  if (projectedNadir < 3.9) {
    // Concrete carb amount when both personal ratios are known: grams to lift the projected
    // trough back to ~5.0, at (carbRatio grams per unit) / (factor mmol per unit) g per mmol.
    let carbBit = 'Having carbs before starting';
    if (factorUsable && data.settings.carbRatio) {
      const grams = Math.min(30, Math.max(5, Math.round(((5.0 - projectedNadir) * data.settings.carbRatio / factor) / 5) * 5));
      carbBit = `~${grams}g of carbs first`;
    }
    risk = 'high';
    // A projected trough can go arithmetically negative when IOB + the type's drop exceed
    // current glucose - don't print an impossible number, just say how far it undershoots.
    const troughBit = projectedNadir < 3 ? 'well below 3.9' : `around ${projectedNadir}`;
    advice = `Careful: you're at ${ctx.current}${iobBit}, and ${historyBit} — projected trough ${troughBit}. ${carbBit} would put you in a much safer starting spot.${staleNote}`;
  } else if (projectedNadir < 5.0) {
    risk = 'caution';
    advice = `You're at ${ctx.current}${iobBit}; ${historyBit} — projected trough ~${projectedNadir}. Starting is fine, but keep fast carbs within reach, especially through the post-workout window.${staleNote}`;
  } else {
    risk = 'ok';
    advice = `Good spot to start: ${ctx.current}${iobBit} against ${historyBit} — projected trough ~${projectedNadir}, comfortably clear of a low. Delayed dips can still land hours later, so recheck after.${staleNote}`;
  }
  return { ...base, risk, projectedNadir, advice };
}

// ─── Smart meal dose suggestion ───────────────────────────────────────
// Weighs past insulin-dosed meals by carb similarity, recency, time-of-day and
// exercise-proximity match, then nudges the suggestion using how those meals actually
// turned out (post-meal low, or a correction was needed) plus the personal correction factor.
function timeBucket(h) { return h<5?'night':h<11?'morning':h<17?'afternoon':h<22?'evening':'night'; }

async function suggestMealDose(carbs, mealName) {
  const data = await loadData();
  const { targetLow, targetHigh, idealTarget, carbRatio } = data.settings;
  const targetMid = (targetLow + targetHigh) / 2;

  const resolvedCorr = data.corrections.filter(c => c.resolved && c.dropPerUnit != null && !c.carbInterference);
  const correctionFactor = resolvedCorr.length >= 3
    ? resolvedCorr.reduce((s,c) => s + c.dropPerUnit, 0) / resolvedCorr.length : null;

  // Correction add-on: if currently above the ideal target, fold in extra units on top of
  // whatever the carb-coverage suggestion is - mirrors how a real bolus calculator combines a
  // "carb bolus" with a "correction bolus" into one recommendation, applied uniformly below
  // regardless of which suggestion path (history-based or manual-ratio fallback) is used.
  // IOB- and trend-aware via dosingContext: insulin still active is subtracted and the
  // 30-min trend projection replaces the raw reading, so a dose already working (or a drop
  // already underway) shrinks the add-on instead of stacking on top of it.
  const ctx = dosingContext(data);
  let correctionAddOn = 0, correctionNote = null;
  // Skipped if the correction factor is implausibly low (see MIN_PLAUSIBLE_FACTOR) - same
  // reasoning as the standalone correction suggestion.
  if (ctx.current != null && idealTarget != null && correctionFactor && correctionFactor >= MIN_PLAUSIBLE_FACTOR && ctx.effective > idealTarget) {
    const raw = (ctx.effective - idealTarget) / correctionFactor - ctx.iob;
    correctionAddOn = Math.min(MAX_SUGGESTED_UNITS, Math.max(0, raw));
    if (correctionAddOn > 0) {
      const bits = [`currently ${ctx.current} mmol/L`];
      if (ctx.projected != null) bits.push(`trending toward ~${ctx.projected}`);
      if (ctx.iob > 0.1) bits.push(`${ctx.iob}u on board subtracted`);
      correctionNote = `+${correctionAddOn.toFixed(1)}u correction included (${bits.join(', ')}; target ${idealTarget}).`;
    } else if (ctx.iob > 0.1) {
      correctionNote = `No correction added — you're above target but the ${ctx.iob}u still active should cover it.`;
    }
  }
  if (ctx.stale) {
    correctionNote = [correctionNote, `⚠️ Reading is ~${ctx.ageMin}min old — check your Libre app before dosing off this.`].filter(Boolean).join(' ');
  }
  const combine = (baseUnits, note) => ({
    total: baseUnits != null ? parseFloat((baseUnits + correctionAddOn).toFixed(1)) : null,
    combinedNote: [note, correctionNote].filter(Boolean).join(' ') || null,
  });

  const meals = data.boluses.filter(b => b.units > 0 && b.carbs > 0);
  if (meals.length < 3) {
    if (carbRatio) {
      const { total, combinedNote } = combine(carbs / carbRatio,
        `Using your manual ratio (1u per ${carbRatio}g) — not enough history yet for a personalised suggestion.`);
      return { suggestion: total, basedOn: 0, note: combinedNote };
    }
    return { suggestion: null, basedOn: meals.length, message: 'Log a few more meals with insulin to get personalised suggestions.' };
  }

  const nowBucket = timeBucket(new Date().getHours());
  const nearExercise = t => data.activities.some(a =>
    a.type === 'workout' && a.endTime && Math.abs(new Date(a.endTime).getTime() - t) < 180 * 60000);
  const nowNearExercise = nearExercise(Date.now());

  const scored = meals.map(m => {
    const carbDiff = Math.abs(m.carbs - carbs) / Math.max(m.carbs, carbs);
    let weight = Math.max(0, 1 - carbDiff * 2); // similarity fades to 0 by ~50% carb difference
    if (weight <= 0) return null;
    const ageDays = (Date.now() - m.time) / 86400000;
    weight *= Math.pow(0.5, ageDays / 30); // ~30 day half-life for recency
    if (timeBucket(new Date(m.time).getHours()) === nowBucket) weight *= 1.3;
    if (nearExercise(m.time) === nowNearExercise) weight *= 1.15;
    // Same named meal ("the usual lunch") is the strongest similarity signal there is.
    if (mealName && m.mealName && m.mealName.toLowerCase() === mealName.toLowerCase()) weight *= 1.5;

    const post = data.glucoseHistory.filter(g => g.time > m.time + 30*60000 && g.time <= m.time + 240*60000);
    const nadir = post.length ? Math.min(...post.map(g => g.value)) : null;
    const hadCorrection = data.corrections.some(c => c.time > m.time && c.time < m.time + 180*60000);

    return { ratio: m.units / m.carbs, weight, nadir, hadCorrection };
  }).filter(Boolean);

  // Outlier guard: a single atypical entry (a correction bundled into the same dose as a
  // meal, a data-entry slip, an illness day) can dominate a weighted average this small a
  // sample. Down-weight - don't exclude - any entry whose ratio is far from the matched
  // group's median before averaging, so one unusual day can't swing the suggestion this hard.
  if (scored.length >= 3) {
    const sortedRatios = scored.map(x => x.ratio).sort((a,b) => a-b);
    const median = sortedRatios[Math.floor(sortedRatios.length / 2)];
    if (median > 0) {
      scored.forEach(x => { if (x.ratio > median*2.5 || x.ratio < median*0.4) x.weight *= 0.15; });
    }
  }

  const totalWeight = scored.reduce((s,x) => s + x.weight, 0);
  if (!scored.length || totalWeight < 0.5) {
    if (carbRatio) {
      const { total, combinedNote } = combine(carbs / carbRatio,
        `Using your manual ratio (1u per ${carbRatio}g) — not enough similar meals logged for this carb amount.`);
      return { suggestion: total, basedOn: 0, note: combinedNote };
    }
    return { suggestion: null, basedOn: meals.length, message: 'Not enough similar meals logged yet for this carb amount.' };
  }

  const baseRatio = scored.reduce((s,x) => s + x.ratio * x.weight, 0) / totalWeight;
  let suggestedUnits = baseRatio * carbs;
  let note = null;

  const withNadir = scored.filter(x => x.nadir != null);
  if (withNadir.length) {
    const nadirWeight = withNadir.reduce((s,x) => s + x.weight, 0);
    const avgNadir = withNadir.reduce((s,x) => s + x.nadir * x.weight, 0) / nadirWeight;
    const lowShare = withNadir.filter(x => x.nadir < targetLow).reduce((s,x) => s + x.weight, 0) / nadirWeight;
    const correctionShare = scored.filter(x => x.hadCorrection).reduce((s,x) => s + x.weight, 0) / totalWeight;

    if (lowShare > 0.4 && correctionFactor) {
      const reduction = Math.max(0.5, (targetMid - avgNadir) / correctionFactor);
      suggestedUnits = Math.max(0, suggestedUnits - reduction);
      note = `Similar meals dropped below ${targetLow} mmol/L ${Math.round(lowShare*100)}% of the time (avg low ${avgNadir.toFixed(1)}) — suggestion reduced.`;
    } else if (correctionShare > 0.4) {
      suggestedUnits += 1;
      note = `A correction was needed after ${Math.round(correctionShare*100)}% of similar meals — suggestion increased slightly.`;
    } else if (avgNadir >= targetLow && avgNadir <= targetHigh) {
      note = `Similar meals landed in range (avg low ${avgNadir.toFixed(1)} mmol/L).`;
    }
  }

  const { total, combinedNote } = combine(suggestedUnits, note);
  return { suggestion: total, basedOn: scored.length, note: combinedNote };
}

// ─── Backdated logging helpers ─────────────────────────────────────────
// Entries default to "now" but can be logged for a past moment (e.g. "ate 30g twenty
// minutes ago"). Clamp to not-future so IOB/COB/resolution windows never see a dose
// that hasn't happened yet.
function resolveEntryTime(t) {
  if (!t) return Date.now();
  const parsed = new Date(t).getTime();
  if (isNaN(parsed)) return Date.now();
  return Math.min(parsed, Date.now());
}

// Best-guess glucose at an arbitrary past moment: the live cache if the moment is close
// to now, otherwise the closest stored history point within 15min.
function glucoseAt(data, time) {
  const glucoseCache = getGlucoseCache();
  if (Math.abs(Date.now() - time) < 6*60000 && glucoseCache && !glucoseCache.error) return glucoseCache.value;
  const candidates = data.glucoseHistory.filter(g => Math.abs(g.time - time) < 15*60000);
  if (!candidates.length) return null;
  candidates.sort((a,b) => Math.abs(a.time-time) - Math.abs(b.time-time));
  return candidates[0].value;
}

// ─── Daily summary ────────────────────────────────────────────────────
async function getDailySummary() {
  const data = await loadData();
  const todayStart = new Date(); todayStart.setHours(0,0,0,0);
  const ts = todayStart.getTime();

  const todayGlucose = data.glucoseHistory.filter(g => g.time >= ts);
  const todayBoluses = data.boluses.filter(b => b.time >= ts);
  const todayBasal = data.basalDoses.filter(b => b.time >= ts);
  const todayCorrections = data.corrections.filter(c => c.time >= ts);
  const todaySummary = data.activities.find(a => a.type === 'daily_summary' && a.time >= ts);

  const { targetLow, targetHigh } = data.settings;
  const avgGlucose = todayGlucose.length > 0
    ? (todayGlucose.reduce((s,g) => s + g.value, 0) / todayGlucose.length).toFixed(1) : null;
  const inRange = todayGlucose.filter(g => g.value >= targetLow && g.value <= targetHigh).length;
  const tirPct = todayGlucose.length > 0 ? ((inRange / todayGlucose.length) * 100).toFixed(0) : null;
  const low = todayGlucose.filter(g => g.value < targetLow).length;
  const high = todayGlucose.filter(g => g.value > targetHigh).length;
  // Fixed clinical thresholds (see periodStats) - independent of the personal target range.
  const below39 = todayGlucose.filter(g => g.value < 3.9).length;
  const above10 = todayGlucose.filter(g => g.value > 10.0).length;
  const gMean = todayGlucose.length ? todayGlucose.reduce((s, g) => s + g.value, 0) / todayGlucose.length : null;
  const gCv = todayGlucose.length
    ? Math.sqrt(todayGlucose.reduce((s, g) => s + (g.value - gMean)**2, 0) / todayGlucose.length) / gMean * 100
    : null;

  return {
    glucose: { avg: avgGlucose, tir: tirPct, readings: todayGlucose.length, low, high,
      tbr: todayGlucose.length ? parseFloat(((below39 / todayGlucose.length) * 100).toFixed(1)) : null,
      tar: todayGlucose.length ? Math.round((above10 / todayGlucose.length) * 100) : null,
      cv: gCv != null ? Math.round(gCv) : null,
      min: todayGlucose.length ? Math.min(...todayGlucose.map(g=>g.value)).toFixed(1) : null,
      max: todayGlucose.length ? Math.max(...todayGlucose.map(g=>g.value)).toFixed(1) : null },
    insulin: {
      // Total bolus includes correction units too - both are Novorapid injections, not
      // just meal-time doses. totalCorrection below still shows the correction-only slice.
      totalBolus: (todayBoluses.reduce((s,b) => s + b.units, 0) + todayCorrections.reduce((s,c) => s + c.units, 0)).toFixed(1),
      totalCarbs: todayBoluses.reduce((s,b) => s + (b.carbs||0), 0),
      bolusCount: todayBoluses.length,
      totalCorrection: todayCorrections.reduce((s,c) => s + c.units, 0).toFixed(1),
      correctionCount: todayCorrections.length,
      basal: todayBasal.length > 0 ? todayBasal[0].units : null,
    },
    activity: todaySummary ? {
      calories: Math.round(todaySummary.activeCalories || 0),
      exerciseMins: Math.round(todaySummary.exerciseMinutes || 0),
      steps: todaySummary.steps || 0,
    } : null,
  };
}

// ─── Insulin health check ─────────────────────────────────────────────
// Standard clinical-style dose metrics (Total Daily Dose, TDD/kg, basal:bolus split, TIR),
// trended over two rolling 7-day windows. heightCm/weightKg only normalize TDD into TDD/kg
// and compute BMI; sex/bodyFatPct are surfaced as context but never weighted into anything -
// self-estimated body fat % isn't precise enough to build calculations on.
function periodStats(data, sinceMs, untilMs) {
  const { targetLow, targetHigh } = data.settings;
  const boluses = data.boluses.filter(b => b.time >= sinceMs && b.time < untilMs);
  const corrections = data.corrections.filter(c => c.time >= sinceMs && c.time < untilMs);
  const basalDoses = data.basalDoses.filter(b => b.time >= sinceMs && b.time < untilMs);
  const glucose = data.glucoseHistory.filter(g => g.time >= sinceMs && g.time < untilMs);

  const days = (untilMs - sinceMs) / 86400000;
  const bolusUnits = boluses.reduce((s,b) => s + b.units, 0) + corrections.reduce((s,c) => s + c.units, 0);
  const basalUnits = basalDoses.reduce((s,b) => s + b.units, 0);
  const totalUnits = bolusUnits + basalUnits;

  const inRange = glucose.filter(g => g.value >= targetLow && g.value <= targetHigh).length;
  // TBR/TAR use the fixed ADA/ATTD consensus thresholds (3.9 / 10.0), deliberately NOT the
  // user's targetLow/targetHigh - these are the standardised clinical cut-points (targets:
  // TBR <4%, TAR <25%), so they stay comparable even if the personal range is adjusted.
  const below = glucose.filter(g => g.value < 3.9).length;
  const above = glucose.filter(g => g.value > 10.0).length;
  const mean = glucose.length ? glucose.reduce((s, g) => s + g.value, 0) / glucose.length : null;
  const cv = glucose.length
    ? Math.sqrt(glucose.reduce((s, g) => s + (g.value - mean)**2, 0) / glucose.length) / mean * 100
    : null;

  return {
    tdd: totalUnits / days,
    bolusShare: totalUnits > 0 ? bolusUnits / totalUnits : null,
    tir: glucose.length ? (inRange / glucose.length) * 100 : null,
    tbr: glucose.length ? (below / glucose.length) * 100 : null,
    tar: glucose.length ? (above / glucose.length) * 100 : null,
    cv,
    readingCount: glucose.length,
  };
}

async function checkInsulinHealth() {
  const data = await loadData();
  const { heightCm, weightKg, sex, bodyFatPct } = data.settings;
  const now = Date.now();
  const thisWeek = periodStats(data, now - 7*86400000, now);
  const lastWeek = periodStats(data, now - 14*86400000, now - 7*86400000);

  if (thisWeek.readingCount < 20) {
    return { available: false, message: 'Not enough recent data yet — keep logging for a few more days.' };
  }

  const notes = [];
  if (lastWeek.readingCount >= 10) {
    const tddDelta = thisWeek.tdd - lastWeek.tdd;
    if (Math.abs(tddDelta) > 2) {
      notes.push(`Total daily insulin dose ${tddDelta>0?'rose':'fell'} from ${lastWeek.tdd.toFixed(1)}u to ${thisWeek.tdd.toFixed(1)}u/day vs. the prior week.`);
    }
    if (thisWeek.tir != null && lastWeek.tir != null) {
      const tirDelta = thisWeek.tir - lastWeek.tir;
      if (Math.abs(tirDelta) >= 5) {
        notes.push(`Time in range ${tirDelta>0?'improved':'dropped'} from ${lastWeek.tir.toFixed(0)}% to ${thisWeek.tir.toFixed(0)}% vs. the prior week.`);
      }
    }
    if (thisWeek.bolusShare != null && lastWeek.bolusShare != null) {
      const shareDeltaPct = (thisWeek.bolusShare - lastWeek.bolusShare) * 100;
      if (Math.abs(shareDeltaPct) >= 8) {
        notes.push(`Bolus/basal balance shifted — bolus is now ${Math.round(thisWeek.bolusShare*100)}% of total dose vs. ${Math.round(lastWeek.bolusShare*100)}% the prior week.`);
      }
    }
  }

  return {
    available: true,
    tdd: parseFloat(thisWeek.tdd.toFixed(1)),
    tddPerKg: weightKg ? parseFloat((thisWeek.tdd / weightKg).toFixed(2)) : null,
    bolusPct: thisWeek.bolusShare != null ? Math.round(thisWeek.bolusShare * 100) : null,
    basalPct: thisWeek.bolusShare != null ? Math.round((1 - thisWeek.bolusShare) * 100) : null,
    tir: thisWeek.tir != null ? Math.round(thisWeek.tir) : null,
    tbr: thisWeek.tbr != null ? parseFloat(thisWeek.tbr.toFixed(1)) : null,
    tar: thisWeek.tar != null ? Math.round(thisWeek.tar) : null,
    cv: thisWeek.cv != null ? Math.round(thisWeek.cv) : null,
    bmi: (heightCm && weightKg) ? parseFloat((weightKg / ((heightCm/100)**2)).toFixed(1)) : null,
    sex: sex || null,
    bodyFatPct: bodyFatPct || null,
    notes,
  };
}

// ─── Stacking caution ─────────────────────────────────────────────────
// The "rage bolus" guard: correcting while the previous rapid dose is still near its
// activity peak (~75min) is how the high-low-high rollercoaster starts - the current high
// may already be on its way down, invisibly. Distinct from coveredByIOB (which zeroes the
// suggested number): this fires even when the user types their own units, because that's
// exactly the tired-and-frustrated moment it exists for.
function stackingCaution(data) {
  if (activeInsulin(data) < 0.5) return null;
  // Any dose inside the 15-110min window qualifies, not just the newest one - a meal bolus
  // logged seconds ago must not mask an earlier correction that's sitting right at peak.
  // (<15min doses are excluded: dosing again immediately is usually one combined decision,
  // and the IOB subtraction already accounts for it.)
  const qualifying = [...data.boluses.filter(b => b.units > 0), ...data.corrections]
    .map(d => ({ units: d.units, ageMin: Math.round((Date.now() - d.time) / 60000) }))
    .filter(d => d.ageMin >= 15 && d.ageMin <= 110)
    .sort((a, b) => a.ageMin - b.ageMin);
  if (!qualifying.length) return null;
  const d = qualifying[0];
  const phase = d.ageMin < 95 ? 'near peak activity' : 'still working';
  return `You dosed ${d.units}u ${d.ageMin}min ago — that Novorapid is ${phase}, so the current level may already be coming down. This may be a wait-and-watch situation rather than a correction one: re-checking in 20–30min avoids the stacked-dose rollercoaster.`;
}

// ─── Insulin sensitivity map ──────────────────────────────────────────
// Where and when corrections hit harder: clean resolved corrections bucketed by time of day,
// plus post-exercise (within 6h of a workout end) vs rest. Counts ship with every number -
// an n=2 average is shown as an n=2 average, not passed off as truth. Slices the app can't
// see (alcohol, sleep, stress, meal composition) are deliberately absent rather than faked.
const SENS_BUCKETS = [
  { key: 'morning', label: 'Morning', range: '05–11', from: 5, to: 11 },
  { key: 'afternoon', label: 'Afternoon', range: '11–17', from: 11, to: 17 },
  { key: 'evening', label: 'Evening', range: '17–22', from: 17, to: 22 },
  { key: 'overnight', label: 'Overnight', range: '22–05', from: 22, to: 5 },
];
async function sensitivityMap() {
  const data = await loadData();
  const resolved = data.corrections.filter(c => c.resolved && c.dropPerUnit != null && !c.carbInterference);
  if (resolved.length < 4) {
    return { available: false, message: `Needs a few more resolved corrections (${resolved.length}/4) to start mapping sensitivity.` };
  }
  const inBucket = (h, b) => b.from < b.to ? (h >= b.from && h < b.to) : (h >= b.from || h < b.to);
  const buckets = SENS_BUCKETS.map(b => {
    const corr = resolved.filter(c => inBucket(new Date(c.time).getHours(), b));
    return {
      key: b.key, label: b.label, range: b.range, count: corr.length,
      factor: corr.length ? parseFloat((corr.reduce((s, c) => s + c.dropPerUnit, 0) / corr.length).toFixed(1)) : null,
    };
  });
  const workoutEnds = data.activities.filter(a => a.type === 'workout' && a.endTime).map(a => new Date(a.endTime).getTime());
  const isPostEx = c => workoutEnds.some(e => c.time > e && c.time - e < 6 * 3600000);
  const post = resolved.filter(isPostEx), rest = resolved.filter(c => !isPostEx(c));
  const avg = a => a.length ? parseFloat((a.reduce((s, c) => s + c.dropPerUnit, 0) / a.length).toFixed(1)) : null;
  return {
    available: true,
    buckets,
    postExercise: { count: post.length, factor: avg(post) },
    rest: { count: rest.length, factor: avg(rest) },
    total: resolved.length,
  };
}

// ─── Meal memory ──────────────────────────────────────────────────────
// A named meal ("the usual lunch") becomes a reusable event with remembered outcomes: how
// high it peaks, when, how long back to range, whether it drops you later - and whether it
// behaves like a high-fat/protein delayed-rise meal (a second climb hours after the first
// settles, the pizza/takeaway signature). Entries are tagged with mealName when logged via
// a preset; glucose coverage limits stats to the 14-day retention window, so numbers build
// as a meal is reused. "Best pre-bolus timing" is deliberately NOT computed - carbs and
// insulin share one timestamp here, so the data to answer it honestly doesn't exist.
function mealOutcomes(data, logs) {
  const { targetLow, targetHigh } = data.settings;
  const outcomes = [];
  for (const m of logs) {
    const post = data.glucoseHistory.filter(g => g.time > m.time + 20 * 60000 && g.time <= m.time + 6 * 3600000);
    if (post.length < 5) continue;
    const early = post.filter(g => g.time <= m.time + 4 * 3600000);
    if (!early.length) continue;
    let peak = -Infinity, peakTime = null;
    early.forEach(g => { if (g.value > peak) { peak = g.value; peakTime = g.time; } });
    const afterPeak = post.filter(g => g.time > peakTime);
    const backInRange = peak > targetHigh ? afterPeak.find(g => g.value <= targetHigh) : null;
    const nadir = Math.min(...post.map(g => g.value));
    // Delayed-rise shape: the level once the first wave settles (~2.5h) vs the late-window
    // (2.5-6h) peak - a second climb >=2 mmol/L is the fat/protein signature.
    const at25 = post.filter(g => Math.abs(g.time - (m.time + 150 * 60000)) < 25 * 60000);
    const late = post.filter(g => g.time > m.time + 150 * 60000);
    let delayedRise = null;
    if (at25.length && late.length >= 3) {
      const settle = at25.reduce((s, g) => s + g.value, 0) / at25.length;
      const latePeakPoint = late.reduce((a, g) => g.value > a.value ? g : a);
      delayedRise = (latePeakPoint.value - settle >= 2) ? { riseTo: latePeakPoint.value, atHours: (latePeakPoint.time - m.time) / 3600000 } : false;
    }
    outcomes.push({
      peak, timeToPeakMin: (peakTime - m.time) / 60000,
      returnToRangeMin: peak > targetHigh ? (backInRange ? (backInRange.time - m.time) / 60000 : null) : 0,
      wentLow: nadir < targetLow, delayedRise,
    });
  }
  return outcomes;
}

async function getMealMemory(name) {
  const data = await loadData();
  const logs = data.boluses.filter(b => b.mealName && b.mealName.toLowerCase() === String(name || '').trim().toLowerCase());
  if (!logs.length) return { available: false, count: 0, message: 'No logged history for this meal yet — stats build each time you log it from its preset.' };
  const outcomes = mealOutcomes(data, logs);
  if (outcomes.length < 2) {
    return { available: false, count: logs.length, message: `Logged ${logs.length}x — needs at least 2 with glucose coverage for outcome stats.` };
  }
  const fmtH = min => min >= 60 ? `${Math.floor(min / 60)}h ${Math.round(min % 60)}m` : `${Math.round(min)}m`;
  const avgPeak = outcomes.reduce((s, o) => s + o.peak, 0) / outcomes.length;
  const returns = outcomes.map(o => o.returnToRangeMin).filter(v => v != null && v > 0);
  const lowShare = outcomes.filter(o => o.wentLow).length / outcomes.length;
  const delayedOnes = outcomes.filter(o => o.delayedRise);
  const checked = outcomes.filter(o => o.delayedRise !== null);
  return {
    available: true, count: logs.length, analyzed: outcomes.length,
    avgPeak: parseFloat(avgPeak.toFixed(1)),
    timeToPeak: fmtH(median(outcomes.map(o => o.timeToPeakMin))),
    returnToRange: returns.length ? fmtH(median(returns)) : (outcomes.some(o => o.returnToRangeMin === null) ? 'over 6h' : 'stayed in range'),
    lowRiskAfter: lowShare === 0 ? 'low' : lowShare < 0.34 ? 'moderate' : 'high',
    delayedRise: checked.length >= 2 && delayedOnes.length / checked.length >= 0.5
      ? { flag: true, atHours: parseFloat(median(delayedOnes.map(o => o.delayedRise.atHours)).toFixed(1)) }
      : { flag: false },
  };
}

// ─── Preventative carb advice ─────────────────────────────────────────
// The inverse of a bolus calculator: grams of carbohydrate likely needed to keep a projected
// trough out of hypo territory, classified by how fast the carbs need to act. Grams-per-mmol
// comes from the user's own ratios (carbRatio g/u ÷ factor mmol/u); without both calibrated,
// amounts stay generic ("10–20g") rather than pretending precision that isn't there.
function carbAdvice(projectedLow, settingsObj, factor, opts = {}) {
  if (projectedLow == null || projectedLow >= 5.0) return null;
  const deficit = 5.0 - projectedLow;
  let grams = null;
  if (factor && factor >= MIN_PLAUSIBLE_FACTOR && settingsObj.carbRatio) {
    grams = Math.min(40, Math.max(5, Math.round((deficit * settingsObj.carbRatio / factor) / 5) * 5));
  }
  const amount = grams != null ? `~${grams}g` : '10–20g';
  let text;
  if (opts.delayed) {
    // A risk window hours out wants slower carbs now + fast carbs in the pocket.
    text = `${amount} of slower buffer carbs (mixed carb/fat/protein — cereal bar, toast with peanut butter) before or during, and carry fast rescue carbs (glucose tablets, full-sugar drink) for the delayed window.`;
  } else if (projectedLow < 3.9) {
    text = `${amount} of fast-acting carbs (glucose tablets, juice, full-sugar drink) — this projection dips into hypo territory.`;
  } else {
    text = `${amount} of short-buffer carbs (banana or a small snack) should keep you clear.`;
  }
  return { grams, text };
}

// ─── Forward glucose simulation ───────────────────────────────────────
// Replaces the old "current + trend - IOB effect" arithmetic, which double-counted insulin: the
// observed trend IS the insulin and carbs already acting, so extrapolating it and THEN
// subtracting their full effect charged the same insulin twice and biased every projection low.
//
// Here glucose is stepped forward from the CURRENT reading in 5-min increments, with each input
// contributing a rate rather than a lump sum:
//     dG = -insulinActing*factor + carbsAbsorbing*(factor/carbRatio) - exerciseDrag + residual
// The trend is now an OUTPUT of the model, not an input, so nothing is counted twice.
//
// The residual is what makes it self-correcting: we compare the model's predicted rate right now
// against the rate actually observed, and carry that unexplained difference forward - decaying to
// zero over RESIDUAL_DECAY_MIN. That absorbs everything the model can't see (a mis-estimated
// meal, illness, stress) in the near term, without degenerating back into pure trend
// extrapolation over the full horizon.
const SIM_STEP_MIN = 5;
const RESIDUAL_DECAY_MIN = 60;
// A purely linear model happily projects glucose through zero, which is both physiologically
// impossible and unreadable in a warning ("projected -1.5"). In reality the counter-regulatory
// response (glucagon/adrenaline, plus falling insulin sensitivity) increasingly opposes a fall as
// glucose drops. Modelled as a damping ramp: full effect above COUNTER_REG_START, tapering to
// zero at GLUCOSE_FLOOR. This doesn't soften the warning - a trough pinned near the floor still
// reads as deep hypo territory - it just stops the number being nonsense.
const COUNTER_REG_START = 4.5;
const GLUCOSE_FLOOR = 2.5;

// Rate of change from a least-squares fit over the recent readings, in mmol/L per minute. Far
// steadier than the two-point delta computeTrend() uses, and a couple of noisy points can't
// swing it.
function observedRatePerMin(history, windowMin = 30, at = Date.now()) {
  const pts = history.filter(g => g.time > at - windowMin * 60000 && g.time <= at);
  if (pts.length < 3) return null;
  const t0 = pts[0].time;
  const xs = pts.map(p => (p.time - t0) / 60000), ys = pts.map(p => p.value);
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, den = 0;
  for (let i = 0; i < n; i++) { num += (xs[i] - mx) * (ys[i] - my); den += (xs[i] - mx) ** 2; }
  return den === 0 ? null : num / den;
}

// The app already measures how sensitivity varies by time of day and after exercise
// (sensitivityMap) but the forecast used to ignore all of it and apply one flat average. Prefer
// the most specific bucket that has enough corrections behind it - post-exercise first, since
// that's both the largest effect and when hypos actually happen.
function contextualFactor(data, resolved, at = Date.now()) {
  const globalAvg = resolved.length >= 3
    ? resolved.reduce((s, c) => s + c.dropPerUnit, 0) / resolved.length : null;
  const usable = a => a.length >= 3 && (a.reduce((s, c) => s + c.dropPerUnit, 0) / a.length) >= MIN_PLAUSIBLE_FACTOR;
  const avg = a => a.reduce((s, c) => s + c.dropPerUnit, 0) / a.length;

  const workoutEnds = data.activities
    .filter(a => a.type === 'workout' && a.endTime).map(a => new Date(a.endTime).getTime());
  const isPostEx = t => workoutEnds.some(e => t > e && t - e < 6 * 3600000);
  if (isPostEx(at)) {
    const post = resolved.filter(c => isPostEx(c.time));
    if (usable(post)) return { factor: avg(post), basis: `your post-exercise corrections (n=${post.length})` };
  }
  const inBucket = (h, b) => b.from < b.to ? (h >= b.from && h < b.to) : (h >= b.from || h < b.to);
  const bucket = SENS_BUCKETS.find(b => inBucket(new Date(at).getHours(), b));
  if (bucket) {
    const inB = resolved.filter(c => inBucket(new Date(c.time).getHours(), bucket));
    if (usable(inB)) return { factor: avg(inB), basis: `your ${bucket.label.toLowerCase()} corrections (n=${inB.length})` };
  }
  return { factor: globalAvg, basis: globalAvg != null ? `your ${resolved.length} resolved corrections` : null };
}

// Post-workout drops spread over the remaining time to that type's usual nadir, as a rate, rather
// than being subtracted as one lump. Includes workouts still in progress (negative hoursSince),
// which the old model ignored entirely - during a session it was blind.
function exerciseDrags(data, at = Date.now()) {
  const profiles = workoutTypeProfiles(data);
  const drags = [];
  for (const w of data.activities.filter(a => a.type === 'workout' && a.endTime)) {
    const hoursSince = (at - new Date(w.endTime).getTime()) / 3600000;
    if (hoursSince > 8 || hoursSince < -3) continue;
    const p = profiles.find(x => x.type === (w.workoutType || 'Exercise'));
    if (!p || p.dropShare < 0.6 || p.medianDrop < 1.5) continue;
    const elapsed = Math.max(0, hoursSince); // in-progress sessions count as "just started"
    const remaining = p.medianDrop * Math.max(0, 1 - elapsed / Math.max(0.5, p.medianHoursToNadir));
    if (remaining <= 0.3) continue;
    const minsToNadir = Math.max(SIM_STEP_MIN, (p.medianHoursToNadir - elapsed) * 60);
    drags.push({ ratePerMin: remaining / minsToNadir, untilMin: minsToNadir, type: p.type, remaining });
  }
  return drags;
}

// Steps glucose forward and reports the whole path, so the TROUGH is available rather than just
// the value at the horizon - a dip at 45min that recovers by 2h was previously invisible, which
// matters a great deal for a hypo forecast.
function simulateForward(data, { start, factor, carbRatio, horizonMin, residualRate, drags }) {
  const now = Date.now();
  const carbToGlucose = (carbRatio && factor) ? factor / carbRatio : 0;
  let g = start, trough = start, troughAt = 0;
  const path = [{ min: 0, value: parseFloat(start.toFixed(2)) }];
  for (let off = 0; off < horizonMin; off += SIM_STEP_MIN) {
    const at = now + off * 60000;
    let dG = 0;
    if (factor) {
      dG -= insulinActionWithin(data, SIM_STEP_MIN, at) * factor;
      if (carbToGlucose) dG += carbAbsorptionWithin(data, SIM_STEP_MIN, at) * carbToGlucose;
    }
    if (residualRate) dG += residualRate * SIM_STEP_MIN * Math.max(0, 1 - off / RESIDUAL_DECAY_MIN);
    for (const d of drags) if (off < d.untilMin) dG -= d.ratePerMin * SIM_STEP_MIN;
    // Counter-regulation increasingly resists a fall as glucose approaches the floor.
    if (dG < 0 && g < COUNTER_REG_START) {
      dG *= Math.max(0, (g - GLUCOSE_FLOOR) / (COUNTER_REG_START - GLUCOSE_FLOOR));
    }
    g = Math.max(GLUCOSE_FLOOR, g + dG);
    if (g < trough) { trough = g; troughAt = off + SIM_STEP_MIN; }
    path.push({ min: off + SIM_STEP_MIN, value: parseFloat(g.toFixed(2)) });
  }
  return { end: g, trough, troughAt, path };
}

// ─── Hypo risk forecast ───────────────────────────────────────────────
// "What is likely to happen in the next 2 hours" - the difference from the raw glucose
// number is that this nets out everything already in motion: the slice of IOB that will
// actually act inside the horizon (insulinActionWithin, not the whole IOB tail), the carbs
// still absorbing against it, the trend, any post-workout drop window still open, and
// whether this time of day has produced lows before. The trend projection partially
// double-counts insulin already acting, which biases the forecast pessimistic - for a hypo
// *warning* that is the correct direction to be wrong in.
async function forecastHypoRisk() {
  const data = await loadData();
  const ctx = dosingContext(data);
  if (ctx.current == null) return { available: false, message: 'No live glucose right now.' };

  const resolved = data.corrections.filter(c => c.resolved && c.dropPerUnit != null && !c.carbInterference);
  // Time-of-day / post-exercise sensitivity where the data supports it, not one flat average.
  const { factor: ctxFactor, basis: factorBasis } = contextualFactor(data, resolved);
  const factorUsable = ctxFactor != null && ctxFactor >= MIN_PLAUSIBLE_FACTOR;
  const factor = factorUsable ? ctxFactor : null;

  const HORIZON_MIN = 120;
  const carbRatio = data.settings.carbRatio;
  const iobActing = insulinActionWithin(data, HORIZON_MIN);
  const cobAbsorbing = carbAbsorptionWithin(data, HORIZON_MIN);
  const iobNow = parseFloat(activeInsulin(data).toFixed(1));
  const cobNow = Math.round(carbsOnBoard(data));
  const factors = [];

  // How fast glucose is ACTUALLY moving (least-squares over the last 30min) versus how fast the
  // model says it should be. The difference is the residual - everything unmodelled - which the
  // simulation carries forward and decays out. This is what replaces the old trend extrapolation
  // without double-charging the insulin that caused the trend in the first place.
  const observedRate = observedRatePerMin(data.glucoseHistory, 30);
  let residualRate = null;
  if (observedRate != null) {
    let modelRateNow = 0;
    if (factor) {
      modelRateNow = (-insulinActionWithin(data, SIM_STEP_MIN) * factor
        + (carbRatio ? carbAbsorptionWithin(data, SIM_STEP_MIN) * (factor / carbRatio) : 0)) / SIM_STEP_MIN;
    }
    residualRate = observedRate - modelRateNow;
  }

  const drags = exerciseDrags(data);
  const sim = simulateForward(data, {
    start: ctx.current, factor, carbRatio, horizonMin: HORIZON_MIN, residualRate, drags,
  });
  // The forecast number is the TROUGH along the path, not the value at the 2h mark - a dip at
  // 45min that recovers by 2h is exactly what a hypo warning exists to catch.
  let projected = sim.trough;
  const projectedEnd = parseFloat(sim.end.toFixed(1));
  let calibrated = factorUsable;
  if (factorUsable && !carbRatio && cobAbsorbing > 10) calibrated = false; // carbs help but can't be quantified

  if (observedRate != null && observedRate < -0.005) {
    factors.push(`glucose is falling ~${Math.abs(observedRate * 60).toFixed(1)} mmol/L per hour right now`);
  }
  if (iobActing > 0.3) {
    factors.push(`${iobNow}u on board, ~${iobActing.toFixed(1)}u of it acting within 2h`);
    factors.push(cobNow > 0 ? `only ${cobNow}g of carbs still absorbing against it` : 'no carbs on board against it');
  }
  if (factorUsable && factorBasis) factors.push(`using ${factorBasis} (${ctxFactor.toFixed(1)} mmol/L per unit)`);
  for (const d of drags) {
    factors.push(`inside "${d.type}"'s drop window — ~${d.remaining.toFixed(1)} mmol/L of its usual fall may still be coming`);
  }

  // "Similar situations previously": hypo episodes (<3.9, merged at 30min gaps) that started
  // in the same 4h time-of-day window over the 14-day history.
  const windowStart = Math.floor(new Date().getHours() / 4) * 4;
  const episodes = [];
  data.glucoseHistory.filter(g => g.value < 3.9).sort((a, b) => a.time - b.time).forEach(g => {
    const last = episodes[episodes.length - 1];
    if (last && g.time - last.end <= 30 * 60000) last.end = g.time;
    else episodes.push({ start: g.time, end: g.time });
  });
  const sameWindowLows = episodes.filter(e => { const h = new Date(e.start).getHours(); return h >= windowStart && h < windowStart + 4; }).length;

  projected = parseFloat(projected.toFixed(1));
  const tiers = ['minimal', 'low', 'moderate', 'high'];
  let tier;
  if (ctx.current < 4.2 || projected < 3.9) tier = 3;
  else if (projected < 4.7) tier = 2;
  else if (projected < 5.5) tier = 1;
  else tier = 0;
  if (sameWindowLows >= 2 && projected < 6) {
    tier = Math.min(3, tier + 1);
    factors.push(`${sameWindowLows} previous lows around this time of day`);
  }
  // Uncalibrated but insulin-heavy and unfed: can't quantify, so escalate rather than shrug.
  if (!factorUsable && iobActing > 1 && cobNow < 10) {
    tier = Math.min(3, tier + 1);
    factors.push('active insulin can\'t be converted to a glucose effect yet — log a few corrections to calibrate');
  }
  if (ctx.stale) factors.push(`reading is ~${ctx.ageMin}min old — confirm on your Libre app`);

  const risk = tiers[tier];
  const carbs = tier >= 2 ? carbAdvice(projected, data.settings, factor, { delayed: false }) : null;
  // Uncertainty grows with how far out the trough is and shrinks as the factor firms up. A single
  // decimal implies precision the model doesn't have; the band is the honest version.
  const troughH = Math.max(0.5, sim.troughAt / 60);
  const band = parseFloat(((factorUsable ? (resolved.length >= 10 ? 0.7 : 0.9) : 1.4) * Math.sqrt(troughH)).toFixed(1));
  const result = {
    available: true, risk, projectedLow: projected, horizonHours: 2,
    factors, iob: iobNow, cob: cobNow, calibrated, stale: ctx.stale,
    current: ctx.current,
    carbs: carbs ? carbs.text : null,
    // Simulation outputs: the trough and when it lands, the value at the horizon, the band, and
    // the full path so the chart can draw the predicted curve rather than a straight line.
    projectedEnd, troughAtMin: sim.troughAt, path: sim.path,
    range: [parseFloat(Math.max(GLUCOSE_FLOOR, projected - band).toFixed(1)), parseFloat((projected + band).toFixed(1))],
    factorBasis: factorUsable ? factorBasis : null,
    // Drives the Track tab's calibration prompt: until this reaches 3, the model can't convert
    // insulin or carbs into a glucose effect - it runs on the observed rate alone.
    correctionCount: resolved.length,
  };
  // Sample it (throttled) so scoreForecasts() can grade it once the horizon elapses. Wrapped so
  // a store hiccup can never take down the forecast the user is actually looking at.
  try { await recordForecast(result); } catch (e) { console.error('❌ Forecast log error:', e.message); }
  return result;
}

// ─── Forecast scoring (the model's report card) ───────────────────────
// The forecast was previously fire-and-forget: a number appeared, the moment passed, and nobody
// ever checked whether it came true. That makes every "improvement" unfalsifiable. So we sample
// forecasts, wait out their horizon, and compare them to what actually happened.
//
// Sign convention: error = projected - actual.
//   negative => the forecast sat BELOW reality (pessimistic - it cried wolf)
//   positive => the forecast sat ABOVE reality (optimistic - the dangerous direction)
// A persistent negative bias is the expected signature of the trend/insulin double-count.
const FORECAST_LOG_INTERVAL_MS = 30 * 60000; // sample every ~30min, not every 60s client poll
const FORECAST_RETENTION_MS = 14 * 86400000;
const FORECAST_SCORE_TOLERANCE_MS = 15 * 60000; // how close a reading must be to the horizon
const FORECAST_MIN_SCORED = 5;

// Appends a forecast sample (throttled) and prunes old ones. Returns true if it saved.
// The in-memory clock check short-circuits the common case so a 60s client poll doesn't even
// hit the store; the blob is then re-read immediately before writing, keeping the
// read-modify-write window as small as possible against a concurrent log POST.
let _lastForecastLogAt = 0;
async function recordForecast(f) {
  if (!f || !f.available) return false;
  if (Date.now() - _lastForecastLogAt < FORECAST_LOG_INTERVAL_MS) return false;
  const data = await loadData();
  if (!data.forecasts) data.forecasts = [];
  const last = data.forecasts[data.forecasts.length - 1];
  // Re-check against stored data too: the in-memory clock resets on restart/redeploy.
  if (last && Date.now() - last.time < FORECAST_LOG_INTERVAL_MS) { _lastForecastLogAt = last.time; return false; }
  data.forecasts.push({
    time: Date.now(),
    horizonHours: f.horizonHours,
    projected: f.projectedLow,
    risk: f.risk,
    current: f.current != null ? f.current : null,
    iob: f.iob, cob: f.cob,
    calibrated: !!f.calibrated,
    // filled in later by scoreForecasts()
    actual: null, error: null, actualMin: null, wentLow: null, scoredAt: null, unscorable: false,
  });
  data.forecasts = data.forecasts.filter(x => x.time > Date.now() - FORECAST_RETENTION_MS);
  await saveData(data);
  _lastForecastLogAt = Date.now();
  return true;
}

// Scores every forecast whose horizon has elapsed, against the reading nearest that horizon.
// Wired into the glucose-fetch hook alongside resolveCorrections (see server.js).
async function scoreForecasts() {
  const data = await loadData();
  if (!data.forecasts || !data.forecasts.length) return;
  let changed = false;
  for (const f of data.forecasts) {
    if (f.scoredAt) continue;
    const target = f.time + f.horizonHours * 3600000;
    if (Date.now() < target) continue;
    const candidates = data.glucoseHistory.filter(g => Math.abs(g.time - target) <= FORECAST_SCORE_TOLERANCE_MS);
    if (!candidates.length) {
      // Sensor gap over the horizon - unscorable. Mark it after an hour's grace so it isn't
      // re-checked on every poll forever (same reasoning as a correction's giveUp flag).
      if (Date.now() > target + 3600000) { f.scoredAt = Date.now(); f.unscorable = true; changed = true; }
      continue;
    }
    candidates.sort((a, b) => Math.abs(a.time - target) - Math.abs(b.time - target));
    const windowPts = data.glucoseHistory.filter(g => g.time > f.time && g.time <= target);
    f.actual = candidates[0].value;
    f.error = parseFloat((f.projected - f.actual).toFixed(2));
    f.actualMin = windowPts.length ? Math.min(...windowPts.map(g => g.value)) : null;
    f.wentLow = f.actualMin != null ? f.actualMin < 3.9 : null;
    f.scoredAt = Date.now();
    changed = true;
  }
  if (changed) await saveData(data);
}

// Aggregate report card. Bias/MAE say how far off the number is; precision/recall say whether the
// WARNING was useful, which for a hypo forecast matters more than the decimal place:
//   precision = of the times it warned, how often a low actually followed (low => crying wolf)
//   recall    = of the lows that happened, how often it warned first (low => missing real risk)
async function forecastAccuracy() {
  const data = await loadData();
  const scored = (data.forecasts || []).filter(f => f.scoredAt && !f.unscorable && f.error != null);
  if (scored.length < FORECAST_MIN_SCORED) {
    return { available: false, scored: scored.length, needed: FORECAST_MIN_SCORED,
      message: `Scoring in progress — ${scored.length}/${FORECAST_MIN_SCORED} forecasts checked against what actually happened. Come back in a day or so.` };
  }
  const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
  const errs = scored.map(f => f.error);
  const withLowInfo = scored.filter(f => f.wentLow !== null);
  const warned = withLowInfo.filter(f => f.risk === 'moderate' || f.risk === 'high');
  const actualLows = withLowInfo.filter(f => f.wentLow);
  const truePos = warned.filter(f => f.wentLow).length;
  const cal = scored.filter(f => f.calibrated), uncal = scored.filter(f => !f.calibrated);

  return {
    available: true,
    scored: scored.length,
    bias: parseFloat(mean(errs).toFixed(2)),
    mae: parseFloat(mean(errs.map(Math.abs)).toFixed(2)),
    within1: Math.round(errs.filter(e => Math.abs(e) <= 1).length / errs.length * 100),
    within2: Math.round(errs.filter(e => Math.abs(e) <= 2).length / errs.length * 100),
    precision: warned.length ? Math.round(truePos / warned.length * 100) : null,
    recall: actualLows.length ? Math.round(truePos / actualLows.length * 100) : null,
    warnings: warned.length, lows: actualLows.length,
    // Split so a future model change can be compared against the uncalibrated baseline.
    calibratedBias: cal.length >= 3 ? parseFloat(mean(cal.map(f => f.error)).toFixed(2)) : null,
    calibratedCount: cal.length,
    uncalibratedBias: uncal.length >= 3 ? parseFloat(mean(uncal.map(f => f.error)).toFixed(2)) : null,
    uncalibratedCount: uncal.length,
  };
}

// ─── "What if I..." activity simulator ────────────────────────────────
// Projects the outcome of a hypothetical activity starting now. Uses the personal per-type
// profile when >=2 logged sessions of that exact name exist; otherwise falls back to broad
// intensity-class defaults (deliberately labelled as such - golf, a walk and heavy lifting
// are not the same body, and the numbers say which basis produced them). Duration scales
// sub-linearly (^0.8): minute 60 of a walk doesn't cost what minute 10 did.
const INTENSITY_CLASSES = {
  light: { dropPer30: 0.8, nadirH: 1.5, label: 'light activity' },
  moderate: { dropPer30: 1.8, nadirH: 3, label: 'moderate activity' },
  vigorous: { dropPer30: 2.6, nadirH: 5, label: 'vigorous activity' },
};
async function simulateActivity(type, minutes, intensity) {
  const data = await loadData();
  const ctx = dosingContext(data);
  if (ctx.current == null) return { available: false, message: 'No live glucose to simulate from.' };
  minutes = Math.min(240, Math.max(10, parseFloat(minutes) || 30));

  const resolved = data.corrections.filter(c => c.resolved && c.dropPerUnit != null && !c.carbInterference);
  const factor = resolved.length >= 3 ? resolved.reduce((s, c) => s + c.dropPerUnit, 0) / resolved.length : null;
  const factorUsable = factor != null && factor >= MIN_PLAUSIBLE_FACTOR;

  const profile = type ? workoutTypeProfiles(data).find(p => p.type.toLowerCase() === String(type).trim().toLowerCase()) : null;
  let drop, nadirH, basis, band;
  if (profile) {
    const scale = profile.medianDuration ? Math.min(1.6, Math.max(0.6, Math.pow(minutes / profile.medianDuration, 0.8))) : 1;
    drop = profile.medianDrop * scale;
    nadirH = profile.medianHoursToNadir;
    basis = `your ${profile.sessions} logged "${profile.type}" sessions`;
    band = 0.8;
  } else {
    const cls = INTENSITY_CLASSES[intensity] || INTENSITY_CLASSES.moderate;
    drop = cls.dropPer30 * Math.pow(minutes / 30, 0.8);
    nadirH = cls.nadirH;
    basis = `typical ${cls.label} (no logged history for this type yet)`;
    band = 1.2;
  }

  // A type that historically RISES gets its own answer - the adrenaline response.
  if (profile && profile.medianDrop <= -1.0) {
    return {
      available: true, rises: true, basis,
      advice: `"${profile.type}" usually pushes your glucose up ~${Math.abs(profile.medianDrop).toFixed(1)} mmol/L (adrenaline response) rather than down. You're at ${ctx.current} — expect to run higher during/after, avoid correcting mid-session, and watch for the come-down later.`,
    };
  }

  // Net out insulin acting and carbs absorbing across the activity plus the tail to nadir.
  const windowMin = Math.min(360, minutes + nadirH * 60);
  const iobEffect = factorUsable ? insulinActionWithin(data, windowMin) * factor : 0;
  const cobEffect = (factorUsable && data.settings.carbRatio) ? carbAbsorptionWithin(data, windowMin) * (factor / data.settings.carbRatio) : 0;
  const projected = parseFloat((ctx.effective - drop - iobEffect + cobEffect).toFixed(1));
  const rangeLow = parseFloat((projected - band).toFixed(1));
  const rangeHigh = parseFloat((projected + band).toFixed(1));
  const delayedRisk = rangeLow < 3.9 ? 'high' : rangeLow < 5.0 ? 'moderate' : 'low';
  const watchPeriod = `${Math.max(1, Math.round(nadirH - 1))}–${Math.round(nadirH + 2)}h after finishing`;
  const carbs = carbAdvice(rangeLow, data.settings, factor, { delayed: nadirH > 2 });

  return {
    available: true, rises: false, minutes, basis,
    current: ctx.current, iob: ctx.iob,
    projected, range: [rangeLow, rangeHigh], delayedRisk, watchPeriod,
    carbs: carbs ? carbs.text : null,
    calibrated: factorUsable, stale: ctx.stale,
  };
}

module.exports = {
  resolveCorrections, analysePatterns, suggestMealDose, getActiveAlerts, getWorkoutAdvice,
  resolveEntryTime, glucoseAt, getDailySummary, checkInsulinHealth, dosingContext,
  forecastHypoRisk, simulateActivity, stackingCaution, sensitivityMap, getMealMemory,
  scoreForecasts, forecastAccuracy,
};

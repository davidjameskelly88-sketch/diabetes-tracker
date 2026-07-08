// ─── Pattern analysis / domain logic ──────────────────────────────────
// Correction resolution, pattern insights, dose suggestions, daily summary, and the
// insulin health check. Everything here reads the whole data blob via loadData().
const { loadData, saveData } = require('./store');
const { MIN_PLAUSIBLE_FACTOR, MAX_SUGGESTED_UNITS } = require('./config');
const { getGlucoseCache } = require('./libre');

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
      c.dropPerUnit = c.units > 0 ? parseFloat(((c.startGlucose - c.actualGlucose) / c.units).toFixed(2)) : 0;
      c.accuracy = c.predictedGlucose ? parseFloat(Math.abs(c.actualGlucose - c.predictedGlucose).toFixed(1)) : null;
      // Carbs eaten during the resolution window mask the correction's true effect -
      // flag it so it can be excluded from the correction-factor average.
      const interferingCarbs = data.boluses
        .filter(b => b.carbs > 0 && b.time > c.time && b.time <= c.resolvedAt)
        .reduce((s, b) => s + b.carbs, 0);
      c.carbInterference = interferingCarbs > 0;
      c.interferingCarbs = interferingCarbs || null;
      changed = true;
      console.log(`✅ Correction resolved: ${c.startGlucose} → ${c.actualGlucose} (predicted ${c.predictedGlucose})`);
    }
  }
  if (changed) await saveData(data);
}

// ─── Pattern analysis ─────────────────────────────────────────────────
async function analysePatterns() {
  const data = await loadData();
  const { boluses, corrections, activities, glucoseHistory: allGlucoseHistory, settings } = data;
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
  const workouts = activities.filter(a => a.type === 'workout' && a.startTime && a.endTime);
  for (const w of workouts.slice(-10)) {
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

  return insights.length?insights:[{type:'info',text:'No strong patterns yet. Keep logging.'}];
}

// ─── Smart meal dose suggestion ───────────────────────────────────────
// Weighs past insulin-dosed meals by carb similarity, recency, time-of-day and
// exercise-proximity match, then nudges the suggestion using how those meals actually
// turned out (post-meal low, or a correction was needed) plus the personal correction factor.
function timeBucket(h) { return h<5?'night':h<11?'morning':h<17?'afternoon':h<22?'evening':'night'; }

async function suggestMealDose(carbs) {
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
  const glucoseCache = getGlucoseCache();
  const currentGlucose = (glucoseCache && !glucoseCache.error) ? glucoseCache.value : null;
  let correctionAddOn = 0, correctionNote = null;
  // Skipped if the correction factor is implausibly low (see MIN_PLAUSIBLE_FACTOR) - same
  // reasoning as the standalone correction suggestion.
  if (currentGlucose != null && idealTarget != null && correctionFactor && correctionFactor >= MIN_PLAUSIBLE_FACTOR && currentGlucose > idealTarget) {
    correctionAddOn = Math.min(MAX_SUGGESTED_UNITS, (currentGlucose - idealTarget) / correctionFactor);
    correctionNote = `+${correctionAddOn.toFixed(1)}u correction included since you're currently ${currentGlucose} mmol/L (${(currentGlucose-idealTarget).toFixed(1)} above your ${idealTarget} target).`;
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

  return {
    glucose: { avg: avgGlucose, tir: tirPct, readings: todayGlucose.length, low, high,
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

  return {
    tdd: totalUnits / days,
    bolusShare: totalUnits > 0 ? bolusUnits / totalUnits : null,
    tir: glucose.length ? (inRange / glucose.length) * 100 : null,
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
    bmi: (heightCm && weightKg) ? parseFloat((weightKg / ((heightCm/100)**2)).toFixed(1)) : null,
    sex: sex || null,
    bodyFatPct: bodyFatPct || null,
    notes,
  };
}

module.exports = {
  resolveCorrections, analysePatterns, suggestMealDose,
  resolveEntryTime, glucoseAt, getDailySummary, checkInsulinHealth,
};

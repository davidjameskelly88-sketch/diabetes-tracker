const express = require('express');
const crypto = require('crypto');
const cookieParser = require('cookie-parser');
const fs = require('fs');
const path = require('path');

// ─── Environment / Config ─────────────────────────────────────────────
try {
  const envFile = fs.readFileSync(path.join(__dirname, '.env'), 'utf8');
  envFile.split('\n').forEach(line => {
    const match = line.match(/^([^#=]+)=(.*)$/);
    if (match && !process.env[match[1].trim()]) {
      process.env[match[1].trim()] = match[2].trim();
    }
  });
} catch (e) {}

const LLU_EMAIL = process.env.LLU_EMAIL;
const LLU_PASSWORD = process.env.LLU_PASSWORD;
const LLU_REGION = (process.env.LLU_REGION || 'EU').toUpperCase();
const APP_PASSWORD = process.env.APP_PASSWORD;
const PORT = process.env.PORT || 3000;

if (!LLU_EMAIL || !LLU_PASSWORD || LLU_EMAIL.includes('example.com')) {
  console.error('\n❌  Set LLU_EMAIL and LLU_PASSWORD in your .env file\n');
  process.exit(1);
}
if (!APP_PASSWORD || APP_PASSWORD === 'choose-a-password-here') {
  console.error('\n❌  Set APP_PASSWORD in your .env file\n');
  process.exit(1);
}

// ─── Data storage ─────────────────────────────────────────────────────
// On platforms without a persistent disk (e.g. Render's free tier), the local JSON file
// gets wiped on every restart. If Upstash Redis REST credentials are set, use that instead
// (plain fetch against their REST API - no client library needed, same style as the
// LibreLinkUp calls above). Falls back to the local file otherwise (Glitch, local dev).
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const UPSTASH_KEY = 'diabetes-tracker-data';
const DEFAULT_SETTINGS = { targetLow: 4.0, targetHigh: 10.0, carbRatio: null }; // carbRatio = grams of carbs per 1 unit
const EMPTY_DATA = () => ({ boluses: [], basalDoses: [], corrections: [], activities: [], glucoseHistory: [], settings: { ...DEFAULT_SETTINGS } });

const DATA_DIR = fs.existsSync(path.join(__dirname, '.data'))
  ? path.join(__dirname, '.data') : __dirname;
const DATA_PATH = path.join(DATA_DIR, 'data.json');

function backfill(d) {
  if (!d.corrections) d.corrections = [];
  if (!d.settings) d.settings = { ...DEFAULT_SETTINGS };
  else d.settings = { ...DEFAULT_SETTINGS, ...d.settings };
  return d;
}

async function loadData() {
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      const res = await fetch(`${UPSTASH_URL}/get/${UPSTASH_KEY}`, { headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` } });
      const { result } = await res.json();
      if (!result) return EMPTY_DATA();
      return backfill(JSON.parse(result));
    } catch (e) { console.error('❌ Upstash load error:', e.message); return EMPTY_DATA(); }
  }
  try {
    return backfill(JSON.parse(fs.readFileSync(DATA_PATH, 'utf8')));
  } catch (e) {
    return EMPTY_DATA();
  }
}
async function saveData(data) {
  if (UPSTASH_URL && UPSTASH_TOKEN) {
    try {
      await fetch(`${UPSTASH_URL}/set/${UPSTASH_KEY}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${UPSTASH_TOKEN}` },
        body: JSON.stringify(data),
      });
    } catch (e) { console.error('❌ Upstash save error:', e.message); }
    return;
  }
  fs.writeFileSync(DATA_PATH, JSON.stringify(data, null, 2));
}

// ─── LibreLinkUp API ──────────────────────────────────────────────────
const REGIONS = {
  EU:'https://api-eu.libreview.io',EU2:'https://api-eu2.libreview.io',
  US:'https://api-us.libreview.io',AE:'https://api-ae.libreview.io',
  AP:'https://api-ap.libreview.io',AU:'https://api-au.libreview.io',
  CA:'https://api-ca.libreview.io',DE:'https://api-de.libreview.io',
  FR:'https://api-fr.libreview.io',JP:'https://api-jp.libreview.io',
  LA:'https://api-la.libreview.io',
};
let apiBase = REGIONS[LLU_REGION] || REGIONS.EU;
const LLU_HEADERS = {
  'Content-Type':'application/json','product':'llu.ios','version':'4.16.0',
  'Accept-Encoding':'gzip',
  'User-Agent':'Mozilla/5.0 (iPhone; CPU OS 17_4.1 like Mac OS X) AppleWebKit/536.26 (KHTML, like Gecko) Version/17.4.1 Mobile/10A5355d Safari/8536.25',
};
let authToken=null, tokenExpiry=0, accountId=null;
let glucoseCache=null, glucoseCacheTime=0;
const POLL_MS = 5*60*1000;

async function lluFetch(ep, opts={}) {
  const headers = {...LLU_HEADERS,...opts.headers};
  if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
  if (accountId) headers['Account-Id'] = crypto.createHash('sha256').update(accountId).digest('hex');
  const res = await fetch(apiBase+ep, {method:opts.method||'GET', headers, body:opts.body?JSON.stringify(opts.body):undefined});
  const data = await res.json();
  if (data.data && data.data.redirect) {
    const nr = data.data.region.toUpperCase();
    if (REGIONS[nr]) { apiBase=REGIONS[nr]; console.log(`  Redirected to ${nr}`); return lluFetch(ep,opts); }
  }
  return data;
}

async function login() {
  console.log('🔑 Logging in to LibreLinkUp...');
  try {
    const r = await lluFetch('/llu/auth/login',{method:'POST',body:{email:LLU_EMAIL,password:LLU_PASSWORD}});
    if (r.status===2||r.status===4) {
      if (r.data&&r.data.authTicket) {
        authToken=r.data.authTicket.token;
        const t=await lluFetch('/auth/continue/tou',{method:'POST',body:{}});
        if(t.status===0&&t.data&&t.data.authTicket){authToken=t.data.authTicket.token;if(t.data.user)accountId=t.data.user.id;tokenExpiry=Date.now()+50*60000;console.log('✅ Logged in (TOU)');return true;}
      }
      return false;
    }
    if(r.status!==0||!r.data||!r.data.authTicket){console.error('❌ Login failed:',r.message||JSON.stringify(r).substring(0,200));return false;}
    authToken=r.data.authTicket.token;tokenExpiry=Date.now()+50*60000;
    if(r.data.user)accountId=r.data.user.id;
    console.log('✅ Logged in successfully');return true;
  } catch(e){console.error('❌ Login error:',e.message);return false;}
}
async function ensureAuth(){if(!authToken||Date.now()>tokenExpiry)return await login();return true;}

const TREND_MAP={1:{arrow:'↓↓',label:'Falling quickly'},2:{arrow:'↓',label:'Falling'},3:{arrow:'↘',label:'Falling slowly'},4:{arrow:'→',label:'Stable'},5:{arrow:'↗',label:'Rising slowly'},6:{arrow:'↑',label:'Rising'},7:{arrow:'↑↑',label:'Rising quickly'}};

// Derive our own trend arrow from the last two stored readings (~5min apart) instead of
// trusting LibreLinkUp's TrendArrow, which can disagree with the official app. No extra
// polling involved - this just reasons over history we already have.
function computeTrend(value, time, history) {
  if (!history.length) return null;
  const prev = history[history.length - 1];
  const minutes = (time - prev.time) / 60000;
  if (minutes <= 1 || minutes > 20) return null; // gap too small/large to trust
  const rate = (value - prev.value) / minutes; // mmol/L per minute
  if (rate >= 0.17) return {arrow:'↑↑', label:'Rising quickly'};
  if (rate >= 0.10) return {arrow:'↑', label:'Rising'};
  if (rate >= 0.05) return {arrow:'↗', label:'Rising slowly'};
  if (rate > -0.05) return {arrow:'→', label:'Stable'};
  if (rate > -0.10) return {arrow:'↘', label:'Falling slowly'};
  if (rate > -0.17) return {arrow:'↓', label:'Falling'};
  return {arrow:'↓↓', label:'Falling quickly'};
}

async function fetchGlucose() {
  if(glucoseCache&&(Date.now()-glucoseCacheTime)<POLL_MS) return glucoseCache;
  if(!await ensureAuth()) return glucoseCache||{error:'Not authenticated'};
  try {
    const cr=await lluFetch('/llu/connections');
    if(cr.status!==0||!cr.data||!Array.isArray(cr.data)||cr.data.length===0) return {error:'No connections'};
    const m=cr.data[0].glucoseMeasurement;
    if(!m) return {error:'No glucose data'};
    const apiTrend=TREND_MAP[m.TrendArrow]||{arrow:'?',label:'Unknown'};
    const mgdl=m.ValueInMgPerDl||m.Value;
    const mmol=parseFloat((mgdl/18.0182).toFixed(1));
    // FactoryTimestamp is UTC and DST-safe; Timestamp is the account's local time with no
    // offset marker, which gets misparsed as UTC and drifts an hour off during BST.
    const timestamp=m.FactoryTimestamp||m.Timestamp;
    const ts=new Date(timestamp).getTime()||Date.now();

    const data=await loadData();
    const last=data.glucoseHistory[data.glucoseHistory.length-1];
    const trend=computeTrend(mmol,ts,data.glucoseHistory)||apiTrend;

    glucoseCache={value:mmol,valueMgDl:mgdl,unit:'mmol/L',trend:trend.arrow,trendLabel:trend.label,timestamp,fetchedAt:Date.now()};
    glucoseCacheTime=Date.now();
    // Store history
    if(!last||Math.abs(ts-last.time)>3*60000){
      data.glucoseHistory.push({time:ts,value:mmol,trend:trend.arrow});
      const cutoff=Date.now()-7*24*60*60*1000;
      data.glucoseHistory=data.glucoseHistory.filter(g=>g.time>cutoff);
      await saveData(data);
    }
    // Resolve pending corrections
    await resolveCorrections();
    console.log(`📊 ${mmol} mmol/L ${trend.arrow}`);
    return glucoseCache;
  } catch(e){console.error('❌ Glucose error:',e.message);return glucoseCache||{error:e.message};}
}

// ─── Correction Resolution ────────────────────────────────────────────
async function resolveCorrections() {
  const data = await loadData();
  let changed = false;
  for (const c of data.corrections) {
    if (c.actualGlucose !== null) continue; // already resolved
    const elapsed = Date.now() - c.time;
    if (elapsed < 150 * 60000) continue; // wait at least 2.5 hours
    if (elapsed > 240 * 60000) { // give up after 4 hours
      c.actualGlucose = null; c.resolved = false; changed = true; continue;
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

// ─── Pattern Analysis ─────────────────────────────────────────────────
async function analysePatterns() {
  const data = await loadData();
  const { boluses, corrections, activities, glucoseHistory, settings } = data;
  const { targetLow, targetHigh } = settings;
  const insights = [];

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

  // 3. Post-exercise glucose impact
  const workouts = activities.filter(a => a.type === 'workout' && a.endTime);
  for (const w of workouts.slice(-10)) {
    const endTs = new Date(w.endTime).getTime();
    const pre = glucoseHistory.filter(g => g.time >= endTs - 30*60000 && g.time <= endTs);
    const post = glucoseHistory.filter(g => g.time >= endTs + 30*60000 && g.time <= endTs + 180*60000);
    if (pre.length > 0 && post.length > 0) {
      const preMean = pre.reduce((s,r) => s+r.value, 0) / pre.length;
      const postMean = post.reduce((s,r) => s+r.value, 0) / post.length;
      const delta = postMean - preMean;
      if (Math.abs(delta) > 0.5) {
        const hr = w.avgHeartRate ? ` (avg HR ${w.avgHeartRate}bpm${w.maxHeartRate?', max '+w.maxHeartRate:''})` : '';
        insights.push({ type: delta < 0 ? 'positive' : 'warning',
          text: `After "${w.workoutType||'exercise'}" (${w.duration||'?'}min)${hr}, glucose ${delta<0?'dropped':'rose'} by ${Math.abs(delta).toFixed(1)} mmol/L over ~2.5h.`, time: w.endTime });
      }
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

  return insights.length?insights:[{type:'info',text:'No strong patterns yet. Keep logging.'}];
}

// ─── Smart Meal Dose Suggestion ───────────────────────────────────────
// Weighs past insulin-dosed meals by carb similarity, recency, time-of-day and
// exercise-proximity match, then nudges the suggestion using how those meals actually
// turned out (post-meal low, or a correction was needed) plus the personal correction factor.
function timeBucket(h) { return h<5?'night':h<11?'morning':h<17?'afternoon':h<22?'evening':'night'; }

async function suggestMealDose(carbs) {
  const data = await loadData();
  const { targetLow, targetHigh, carbRatio } = data.settings;
  const targetMid = (targetLow + targetHigh) / 2;
  const meals = data.boluses.filter(b => b.units > 0 && b.carbs > 0);
  if (meals.length < 3) {
    if (carbRatio) {
      return { suggestion: parseFloat((carbs / carbRatio).toFixed(1)), basedOn: 0,
        message: `Using your manual ratio (1u per ${carbRatio}g) — not enough history yet for a personalised suggestion.` };
    }
    return { suggestion: null, basedOn: meals.length, message: 'Log a few more meals with insulin to get personalised suggestions.' };
  }

  const nowBucket = timeBucket(new Date().getHours());
  const nearExercise = t => data.activities.some(a =>
    a.type === 'workout' && a.endTime && Math.abs(new Date(a.endTime).getTime() - t) < 180 * 60000);
  const nowNearExercise = nearExercise(Date.now());

  const resolvedCorr = data.corrections.filter(c => c.resolved && c.dropPerUnit != null && !c.carbInterference);
  const correctionFactor = resolvedCorr.length >= 3
    ? resolvedCorr.reduce((s,c) => s + c.dropPerUnit, 0) / resolvedCorr.length : null;

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

  const totalWeight = scored.reduce((s,x) => s + x.weight, 0);
  if (!scored.length || totalWeight < 0.5) {
    if (carbRatio) {
      return { suggestion: parseFloat((carbs / carbRatio).toFixed(1)), basedOn: 0,
        message: `Using your manual ratio (1u per ${carbRatio}g) — not enough similar meals logged for this carb amount.` };
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

  return { suggestion: parseFloat(suggestedUnits.toFixed(1)), basedOn: scored.length, note };
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
  if (Math.abs(Date.now() - time) < 6*60000 && glucoseCache && !glucoseCache.error) return glucoseCache.value;
  const candidates = data.glucoseHistory.filter(g => Math.abs(g.time - time) < 15*60000);
  if (!candidates.length) return null;
  candidates.sort((a,b) => Math.abs(a.time-time) - Math.abs(b.time-time));
  return candidates[0].value;
}

// ─── Daily Summary ────────────────────────────────────────────────────
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
      totalBolus: todayBoluses.reduce((s,b) => s + b.units, 0).toFixed(1),
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

// ─── Express app ──────────────────────────────────────────────────────
const app = express();
app.use(express.json({limit:'1mb'}));
app.use(cookieParser());

const AUTH_TOKEN = crypto.createHash('sha256').update(APP_PASSWORD).digest('hex');
function requireAuth(req,res,next){
  if(req.cookies&&req.cookies.auth===AUTH_TOKEN)return next();
  if(req.headers.authorization===`Bearer ${APP_PASSWORD}`)return next();
  return res.status(401).json({error:'Unauthorized'});
}
app.use(express.static(path.join(__dirname,'public')));

app.post('/api/login',(req,res)=>{
  if(req.body.password===APP_PASSWORD){res.cookie('auth',AUTH_TOKEN,{maxAge:365*24*60*60*1000,httpOnly:true,sameSite:'lax'});return res.json({ok:true})}
  res.status(401).json({error:'Wrong password'});
});
app.get('/api/auth-check',(req,res)=>{
  if(req.cookies&&req.cookies.auth===AUTH_TOKEN)return res.json({ok:true});
  res.status(401).json({error:'Not logged in'});
});

app.get('/api/glucose',requireAuth,async(req,res)=>{res.json(await fetchGlucose())});

app.get('/api/entries',requireAuth,async(req,res)=>{
  const d=await loadData();
  res.json({boluses:d.boluses,basalDoses:d.basalDoses,corrections:d.corrections||[]});
});

app.post('/api/entries/bolus',requireAuth,async(req,res)=>{
  const{units,carbs,time}=req.body;
  const u=units?parseFloat(units):0, c=carbs?parseFloat(carbs):null;
  if((!u||u<=0)&&(!c||c<=0))return res.status(400).json({error:'Enter carbs or units'});
  const data=await loadData();
  const entry={id:Date.now(),time:resolveEntryTime(time),units:u,carbs:c};
  data.boluses.unshift(entry);data.boluses.sort((a,b)=>b.time-a.time);await saveData(data);res.json(entry);
});

app.post('/api/entries/basal',requireAuth,async(req,res)=>{
  const{units,time}=req.body;if(!units||units<=0)return res.status(400).json({error:'Invalid'});
  const data=await loadData();
  const entry={id:Date.now(),time:resolveEntryTime(time),units:parseFloat(units)};
  data.basalDoses.unshift(entry);data.basalDoses.sort((a,b)=>b.time-a.time);await saveData(data);res.json(entry);
});

app.post('/api/entries/correction',requireAuth,async(req,res)=>{
  const{units,predictedGlucose,time}=req.body;
  if(!units||units<=0)return res.status(400).json({error:'Invalid units'});
  const data=await loadData();
  const entryTime=resolveEntryTime(time);
  const currentGlucose = glucoseAt(data, entryTime);

  // Calculate suggested prediction based on historical correction factor (excluding
  // corrections that were confounded by carbs eaten during their resolution window)
  const resolved = data.corrections.filter(c => c.resolved && c.dropPerUnit != null && !c.carbInterference);
  let suggestedDrop = null;
  if (resolved.length >= 3) {
    const avgFactor = resolved.reduce((s,c) => s + c.dropPerUnit, 0) / resolved.length;
    suggestedDrop = parseFloat((avgFactor * units).toFixed(1));
  }

  // Carbs eaten shortly before this correction may still be digesting and will make its
  // effect less predictable - captured here for context in the correction history.
  const recentCarbs = data.boluses
    .filter(b => b.carbs > 0 && b.time > entryTime - 120*60000 && b.time <= entryTime)
    .reduce((s,b) => s + b.carbs, 0);

  const entry={
    id:Date.now(), time:entryTime, units:parseFloat(units),
    startGlucose: currentGlucose,
    predictedGlucose: predictedGlucose ? parseFloat(predictedGlucose) : null,
    suggestedDrop,
    recentCarbs: recentCarbs || null,
    actualGlucose: null, resolved: false, resolvedAt: null, dropPerUnit: null, accuracy: null,
    carbInterference: false, interferingCarbs: null,
  };
  data.corrections.unshift(entry);data.corrections.sort((a,b)=>b.time-a.time);await saveData(data);res.json(entry);
});

app.delete('/api/entries/bolus/:id',requireAuth,async(req,res)=>{
  const data=await loadData();data.boluses=data.boluses.filter(b=>b.id!==parseInt(req.params.id));await saveData(data);res.json({ok:true});
});
app.delete('/api/entries/basal/:id',requireAuth,async(req,res)=>{
  const data=await loadData();data.basalDoses=data.basalDoses.filter(b=>b.id!==parseInt(req.params.id));await saveData(data);res.json({ok:true});
});
app.delete('/api/entries/correction/:id',requireAuth,async(req,res)=>{
  const data=await loadData();data.corrections=data.corrections.filter(c=>c.id!==parseInt(req.params.id));await saveData(data);res.json({ok:true});
});

app.patch('/api/entries/bolus/:id',requireAuth,async(req,res)=>{
  const{units,carbs,time}=req.body;
  const data=await loadData();
  const entry=data.boluses.find(b=>b.id===parseInt(req.params.id));
  if(!entry)return res.status(404).json({error:'Not found'});
  if(units!=null){const u=parseFloat(units);if(!isNaN(u))entry.units=u;}
  if(carbs!==undefined){const c=(carbs===null||carbs==='')?null:parseFloat(carbs);entry.carbs=(c!=null&&!isNaN(c))?c:null;}
  // datetime-local inputs only have minute precision - ignore rounding noise under a minute
  if(time){const newTime=resolveEntryTime(time);if(Math.abs(newTime-entry.time)>=60000)entry.time=newTime;}
  if((!entry.units||entry.units<=0)&&(!entry.carbs||entry.carbs<=0))return res.status(400).json({error:'Enter carbs or units'});
  data.boluses.sort((a,b)=>b.time-a.time);
  await saveData(data);res.json(entry);
});

app.patch('/api/entries/basal/:id',requireAuth,async(req,res)=>{
  const{units,time}=req.body;
  const data=await loadData();
  const entry=data.basalDoses.find(b=>b.id===parseInt(req.params.id));
  if(!entry)return res.status(404).json({error:'Not found'});
  if(units!=null){const u=parseFloat(units);if(isNaN(u)||u<=0)return res.status(400).json({error:'Invalid units'});entry.units=u;}
  if(time){const newTime=resolveEntryTime(time);if(Math.abs(newTime-entry.time)>=60000)entry.time=newTime;}
  data.basalDoses.sort((a,b)=>b.time-a.time);
  await saveData(data);res.json(entry);
});

app.patch('/api/entries/correction/:id',requireAuth,async(req,res)=>{
  const{units,predictedGlucose,time}=req.body;
  const data=await loadData();
  const entry=data.corrections.find(c=>c.id===parseInt(req.params.id));
  if(!entry)return res.status(404).json({error:'Not found'});
  let resetResolution=false;
  if(units!=null){
    const u=parseFloat(units);
    if(isNaN(u)||u<=0)return res.status(400).json({error:'Invalid units'});
    if(u!==entry.units)resetResolution=true;
    entry.units=u;
  }
  if(predictedGlucose!==undefined){
    entry.predictedGlucose=(predictedGlucose===null||predictedGlucose==='')?null:parseFloat(predictedGlucose);
  }
  if(time){
    const newTime=resolveEntryTime(time);
    // datetime-local inputs only have minute precision, so compare with a tolerance rather
    // than exact equality - otherwise every edit "changes" the time by a few rounded seconds
    // and needlessly wipes startGlucose/resolution even when the user didn't touch it.
    if(Math.abs(newTime-entry.time)>=60000){
      entry.time=newTime;
      entry.startGlucose=glucoseAt(data,newTime);
      resetResolution=true;
    }
  }
  // Editing units or time invalidates any prior resolution - let resolveCorrections() re-derive it.
  if(resetResolution){
    entry.actualGlucose=null;entry.resolved=false;entry.resolvedAt=null;entry.dropPerUnit=null;entry.accuracy=null;
    entry.carbInterference=false;entry.interferingCarbs=null;
  }
  data.corrections.sort((a,b)=>b.time-a.time);
  await saveData(data);res.json(entry);
});

// Get suggested correction factor
app.get('/api/correction-factor',requireAuth,async(req,res)=>{
  const data=await loadData();
  const resolved=data.corrections.filter(c=>c.resolved&&c.dropPerUnit!=null&&!c.carbInterference);
  const recentCarbs=data.boluses.filter(b=>b.carbs>0&&b.time>Date.now()-120*60000).reduce((s,b)=>s+b.carbs,0)||null;
  if(resolved.length<3) return res.json({factor:null,count:resolved.length,message:'Need at least 3 resolved corrections',recentCarbs});
  const factor=resolved.reduce((s,c)=>s+c.dropPerUnit,0)/resolved.length;
  res.json({factor:parseFloat(factor.toFixed(2)),count:resolved.length,recentCarbs});
});

// Settings (target range, manual insulin:carb ratio)
app.get('/api/settings',requireAuth,async(req,res)=>{
  const data=await loadData();
  res.json(data.settings);
});
app.post('/api/settings',requireAuth,async(req,res)=>{
  const{targetLow,targetHigh,carbRatio}=req.body;
  const data=await loadData();
  if(targetLow!=null&&targetHigh!=null){
    const lo=parseFloat(targetLow),hi=parseFloat(targetHigh);
    if(isNaN(lo)||isNaN(hi)||lo<=0||hi<=lo)return res.status(400).json({error:'Invalid target range'});
    data.settings.targetLow=lo;data.settings.targetHigh=hi;
  }
  if(carbRatio!==undefined){
    if(carbRatio===null||carbRatio===''){data.settings.carbRatio=null}
    else{
      const cr=parseFloat(carbRatio);
      if(isNaN(cr)||cr<=0)return res.status(400).json({error:'Invalid carb ratio'});
      data.settings.carbRatio=cr;
    }
  }
  await saveData(data);
  res.json(data.settings);
});

// Health / Activity
// Upserts a daily_summary activity for the given calendar day (identified by any timestamp
// that falls on it), merging in whichever fields are provided and keeping existing ones.
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
    walkingDistance: patch.walkingDistance ?? existing?.walkingDistance ?? null,
  };
  if (idx >= 0) data.activities[idx] = s; else data.activities.unshift(s);
}

app.post('/api/health',requireAuth,async(req,res)=>{
  const data=await loadData();
  const kJtoKcal=kj=>kj/4.184;

  if (req.body.data && (req.body.data.metrics || req.body.data.workouts)) {
    // Health Auto Export REST API format: { data: { metrics: [{name, units, data:[{date,qty|Avg/Min/Max}]}], workouts: [...] } }
    const metrics = req.body.data.metrics || [];
    const byName = n => metrics.find(m => m.name === n);
    const forEachDay = (name, fn) => { const m = byName(name); if (m) m.data.forEach(d => { const t = new Date(d.date).getTime(); if (!isNaN(t)) fn(t, d); }); };

    forEachDay('active_energy', (t,d) => upsertDailySummary(data, t, { activeCalories: kJtoKcal(d.qty) }));
    forEachDay('apple_exercise_time', (t,d) => upsertDailySummary(data, t, { exerciseMinutes: d.qty }));
    forEachDay('apple_stand_hour', (t,d) => upsertDailySummary(data, t, { standHours: d.qty }));
    forEachDay('step_count', (t,d) => upsertDailySummary(data, t, { steps: d.qty }));
    forEachDay('resting_heart_rate', (t,d) => upsertDailySummary(data, t, { restingHeartRate: Math.round(d.qty) }));

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
    const{workouts,summary}=req.body;
    if(workouts&&Array.isArray(workouts)){
      for(const w of workouts){
        if(!data.activities.some(a=>a.type==='workout'&&a.startTime===w.startTime)){
          data.activities.unshift({id:Date.now()+Math.random(),type:'workout',time:Date.now(),
            workoutType:w.workoutType||'Exercise',duration:w.duration||null,calories:w.calories||null,
            startTime:w.startTime,endTime:w.endTime,distance:w.distance||null,avgHeartRate:w.avgHeartRate||null});
        }
      }
    }
    if(summary){
      upsertDailySummary(data, Date.now(), {
        activeCalories: summary.activeCalories || 0, exerciseMinutes: summary.exerciseMinutes || 0,
        standHours: summary.standHours || 0, steps: summary.steps || 0,
        restingHeartRate: summary.restingHeartRate || null, walkingDistance: summary.walkingDistance || null,
      });
    }
  }

  const cutoff=Date.now()-30*24*60*60*1000;
  data.activities=data.activities.filter(a=>a.time>cutoff);
  await saveData(data);res.json({ok:true});
});

app.get('/api/activities',requireAuth,async(req,res)=>{res.json((await loadData()).activities||[])});

app.get('/api/glucose-history',requireAuth,async(req,res)=>{
  const data=await loadData();
  const hours=parseInt(req.query.hours)||24;
  const since=Date.now()-hours*60*60*1000;
  const glucose=(data.glucoseHistory||[]).filter(g=>g.time>since);
  // Include event markers
  const events=[];
  data.boluses.filter(b=>b.time>since).forEach(b=>events.push({type:'bolus',time:b.time,units:b.units,carbs:b.carbs}));
  data.corrections.filter(c=>c.time>since).forEach(c=>events.push({type:'correction',time:c.time,units:c.units}));
  (data.activities||[]).filter(a=>a.type==='workout'&&a.time>since).forEach(a=>events.push({type:'exercise',time:new Date(a.startTime).getTime(),label:a.workoutType,duration:a.duration}));
  res.json({glucose,events});
});

app.get('/api/daily-summary',requireAuth,async(req,res)=>{res.json(await getDailySummary())});
app.get('/api/insights',requireAuth,async(req,res)=>{
  try{res.json(await analysePatterns())}catch(e){res.json([{type:'info',text:'Could not generate insights.'}])}
});

app.get('/api/meal-suggestion',requireAuth,async(req,res)=>{
  const carbs=parseFloat(req.query.carbs);
  if(!carbs||carbs<=0)return res.status(400).json({error:'Invalid carbs'});
  try{res.json(await suggestMealDose(carbs))}catch(e){res.json({suggestion:null,message:'Could not compute suggestion.'})}
});

// CSV export - unified sheet across all record types, one `type` discriminator column
app.get('/api/export.csv',requireAuth,async(req,res)=>{
  const data=await loadData();
  const cols=['type','time','units','carbs','startGlucose','predictedGlucose','actualGlucose','dropPerUnit','accuracy','workoutType','duration','calories','steps','activeCalories','exerciseMinutes','standHours','glucoseValue','trend'];
  const rows=[];
  data.boluses.forEach(b=>rows.push({type:b.units>0?'bolus':'carbs_only',time:b.time,units:b.units||null,carbs:b.carbs}));
  data.basalDoses.forEach(b=>rows.push({type:'basal',time:b.time,units:b.units}));
  data.corrections.forEach(c=>rows.push({type:'correction',time:c.time,units:c.units,startGlucose:c.startGlucose,predictedGlucose:c.predictedGlucose,actualGlucose:c.actualGlucose,dropPerUnit:c.dropPerUnit,accuracy:c.accuracy}));
  data.activities.forEach(a=>{
    if(a.type==='workout')rows.push({type:'workout',time:a.time,workoutType:a.workoutType,duration:a.duration,calories:a.calories});
    else rows.push({type:'daily_summary',time:a.time,activeCalories:a.activeCalories,exerciseMinutes:a.exerciseMinutes,standHours:a.standHours,steps:a.steps});
  });
  data.glucoseHistory.forEach(g=>rows.push({type:'glucose',time:g.time,glucoseValue:g.value,trend:g.trend}));
  rows.sort((a,b)=>a.time-b.time);
  const csvEscape=v=>{if(v==null)return'';const s=String(v);return /[",\n]/.test(s)?'"'+s.replace(/"/g,'""')+'"':s};
  const lines=[cols.join(',')];
  rows.forEach(r=>lines.push(cols.map(c=>c==='time'?new Date(r.time).toISOString():csvEscape(r[c])).join(',')));
  res.setHeader('Content-Type','text/csv');
  res.setHeader('Content-Disposition','attachment; filename="diabetes-tracker-export.csv"');
  res.send(lines.join('\n'));
});

// ─── Start ────────────────────────────────────────────────────────────
app.listen(PORT,'0.0.0.0',async()=>{
  console.log(`\n━━━ 💉 Diabetes Tracker v2 ━━━\n  Port ${PORT}\n`);
  const ok=await login();if(ok)await fetchGlucose();
  setInterval(()=>fetchGlucose(),POLL_MS);
});

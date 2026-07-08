// ─── Data storage ─────────────────────────────────────────────────────
// No real database - a single JSON blob read/written wholesale. Upstash Redis (REST) when
// credentials are set (Render production), else a local data.json (.data/ if present, per
// the Glitch convention, otherwise the project root).
const fs = require('fs');
const path = require('path');
const {
  UPSTASH_URL, UPSTASH_TOKEN, UPSTASH_KEY,
  DEFAULT_SETTINGS, DEFAULT_MEAL_PRESETS, DEFAULT_WORKOUT_PRESETS,
} = require('./config');

const EMPTY_DATA = () => ({
  boluses: [], basalDoses: [], corrections: [], activities: [], glucoseHistory: [],
  settings: { ...DEFAULT_SETTINGS },
  mealPresets: DEFAULT_MEAL_PRESETS.map(p => ({ ...p })),
  workoutPresets: DEFAULT_WORKOUT_PRESETS.map(p => ({ ...p })),
});

const DATA_DIR = fs.existsSync(path.join(__dirname, '..', '.data'))
  ? path.join(__dirname, '..', '.data') : path.join(__dirname, '..');
const DATA_PATH = path.join(DATA_DIR, 'data.json');

// Merges in defaults for blobs saved before a field existed, so old data needs no migration.
function backfill(d) {
  if (!d.corrections) d.corrections = [];
  if (!d.settings) d.settings = { ...DEFAULT_SETTINGS };
  else d.settings = { ...DEFAULT_SETTINGS, ...d.settings };
  if (!d.mealPresets) d.mealPresets = DEFAULT_MEAL_PRESETS.map(p => ({ ...p }));
  if (!d.workoutPresets) d.workoutPresets = DEFAULT_WORKOUT_PRESETS.map(p => ({ ...p }));
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

module.exports = { loadData, saveData };

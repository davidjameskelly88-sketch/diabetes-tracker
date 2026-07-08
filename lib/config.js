// ─── Environment / Config ─────────────────────────────────────────────
// .env is loaded manually (no dotenv dependency); real env vars always win over the file.
const fs = require('fs');
const path = require('path');

try {
  const envFile = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
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

// On platforms without a persistent disk (e.g. Render's free tier), the local JSON file
// gets wiped on every restart. If Upstash Redis REST credentials are set, the store uses
// that instead (plain fetch against their REST API - no client library needed, same style
// as the LibreLinkUp calls). Falls back to the local file otherwise (Glitch, local dev).
const UPSTASH_URL = process.env.UPSTASH_REDIS_REST_URL;
const UPSTASH_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
const UPSTASH_KEY = 'diabetes-tracker-data';

// carbRatio = grams of carbs per 1 unit. heightCm/weightKg/sex/bodyFatPct are stored for
// context (BMI, dose-per-kg) only - never used to weight any suggestion or calculation,
// since self-estimated body fat % in particular isn't precise enough to build logic on.
// idealTarget is the single glucose value corrections/meal suggestions aim for (distinct from
// targetLow/targetHigh, which are the wider range used for time-in-range/color-coding).
const DEFAULT_SETTINGS = { targetLow: 4.0, targetHigh: 10.0, idealTarget: 7.0, carbRatio: null, heightCm: null, weightKg: null, sex: null, bodyFatPct: null };

// Sanity bounds for correction-factor-driven suggestions. A personal correction factor
// averaged from only a handful of resolved corrections can land implausibly low (e.g. a
// correction that coincided with unrelated glucose noise) - dividing a glucose elevation by
// a near-zero factor blows the suggestion up to something absurd (a 4mmol/L elevation over a
// 0.1 factor "suggests" 40+ units). No real person's correction factor is genuinely this low,
// so below MIN_PLAUSIBLE_FACTOR we withhold the suggestion rather than trust the arithmetic.
// MAX_SUGGESTED_UNITS is a hard backstop on top of that, since this is a heuristic tool, not
// medical software - it should never recommend an implausible one-shot dose regardless of
// what any calculation produces.
const MIN_PLAUSIBLE_FACTOR = 0.5; // mmol/L drop per unit
const MAX_SUGGESTED_UNITS = 10;

// Meal presets are the user's own regular meals (e.g. "Coffee" = 10g), replacing generic
// round-number quick-carb buttons with ones that actually match what they eat.
const DEFAULT_MEAL_PRESETS = [{ id: 1, name: 'Coffee', carbs: 10 }];
// Workout presets are just a name (unlike meal presets, no fixed "amount") - they exist to
// keep workout-type naming consistent (e.g. "Strength workout" vs "Strength training" logged
// as the same activity should actually be the same string, since analysePatterns() groups
// exercise insights by exact name match).
const DEFAULT_WORKOUT_PRESETS = [];

module.exports = {
  LLU_EMAIL, LLU_PASSWORD, LLU_REGION, APP_PASSWORD, PORT,
  UPSTASH_URL, UPSTASH_TOKEN, UPSTASH_KEY,
  DEFAULT_SETTINGS, MIN_PLAUSIBLE_FACTOR, MAX_SUGGESTED_UNITS,
  DEFAULT_MEAL_PRESETS, DEFAULT_WORKOUT_PRESETS,
};

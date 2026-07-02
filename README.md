# Diabetes Tracker v2

Insulin, glucose & activity tracker with live LibreLinkUp glucose, Apple Health
integration, and automatic pattern analysis.

## Deploy to Glitch (free, 5 minutes)

1. Go to **glitch.com** and sign up (free, no card needed).
2. Click **New Project** → **Import from GitHub** → paste this URL:
   - If importing from GitHub isn't available, click **New Project** → **hello-express**
   - Then delete all the default files and upload the ones from this zip
3. Alternatively, click **New Project** → **hello-express**, then:
   - Open the file browser on the left
   - Delete the default files (server.js, public/index.html, etc.)
   - Drag and drop `server.js`, `package.json`, and the `public` folder from this zip
   - Or click each file and paste the contents

4. Click the `.env` file in Glitch's editor (it's private, never shared):
   ```
   LLU_EMAIL=your-librelinkup-email
   LLU_PASSWORD=your-librelinkup-password
   LLU_REGION=EU
   APP_PASSWORD=pick-a-password-for-the-app
   ```

5. Glitch auto-installs dependencies and starts the app. Your URL will be
   something like `https://your-project-name.glitch.me`

6. Open the URL, enter your APP_PASSWORD to log in. You should see your
   glucose reading appear.

### Important: Glitch free tier

- Apps sleep after 5 minutes of inactivity and wake on the next request
  (takes a few seconds).
- To keep it awake, set up a free pinger at uptimerobot.com — create an
  HTTP monitor pointing at your Glitch URL, checking every 5 minutes.
  This keeps the app alive and glucose polling continuously.

---

## Deploy to Render (alternative to Glitch)

Render's free tier works fine for running the app, but it has **no persistent
disk** — the local `data.json` file gets wiped every time the service restarts,
which happens automatically after ~15 minutes of inactivity. To keep logged
data (boluses, corrections, glucose history) across restarts, point the app at
a free Upstash Redis database instead of the local file.

1. **Create a free Upstash Redis database**
   - Go to upstash.com and sign up (free, no card needed)
   - Create a new Redis database
   - On the database's page, copy the **REST URL** and **REST Token** (under
     "REST API" — not the regular Redis connection string)

2. **Deploy this repo to Render**
   - render.com → New → Web Service → connect this GitHub repo
   - Build command: `npm install` · Start command: `npm start`

3. **Set environment variables** in Render's dashboard (Environment tab):
   ```
   LLU_EMAIL=your-librelinkup-email
   LLU_PASSWORD=your-librelinkup-password
   LLU_REGION=EU
   APP_PASSWORD=pick-a-password-for-the-app
   UPSTASH_REDIS_REST_URL=https://your-db.upstash.io
   UPSTASH_REDIS_REST_TOKEN=your-rest-token
   ```
   (`PORT` is set automatically by Render — don't set it yourself.)

If `UPSTASH_REDIS_REST_URL`/`UPSTASH_REDIS_REST_TOKEN` aren't set, the app
falls back to the local `data.json` file — this is what happens automatically
on Glitch and when running locally, so local dev needs no extra setup.

Render's free tier sleeps after inactivity like Glitch does — set up the same
uptimerobot.com pinger described above, pointed at your Render URL, to keep it
warm for your hourly Apple Shortcuts sync.

---

## Apple Health Integration (Apple Shortcuts)

This syncs your Apple Watch/Health activity data to the tracker. No extra
apps needed — just the built-in Shortcuts app on your iPhone.

### Create the Shortcut

1. Open **Shortcuts** app on your iPhone
2. Tap **+** to create a new shortcut
3. Name it "Sync Health Data"

#### Add these actions in order:

**Step 1: Get today's activity data**
- Add action: "Find Health Samples"
  - Type: Active Energy
  - Starting Date: Start of Today
  - Sort by: Most Recent First
  - Limit: 1
- Add action: "Set Variable" → name it `activeCalories` → set to the value

- Add action: "Find Health Samples"
  - Type: Exercise Minutes
  - Starting Date: Start of Today
  - Sort by: Most Recent First
  - Limit: 1
- Add action: "Set Variable" → name it `exerciseMinutes`

- Add action: "Find Health Samples"
  - Type: Stand Hours
  - Starting Date: Start of Today
  - Sort by: Most Recent First
  - Limit: 1
- Add action: "Set Variable" → name it `standHours`

- Add action: "Find Health Samples"
  - Type: Step Count
  - Starting Date: Start of Today
  - Sort by: Most Recent First
  - Limit: 1
- Add action: "Set Variable" → name it `steps`

**Step 2: Get recent workouts**
- Add action: "Find Health Samples"
  - Type: Workouts
  - Starting Date: Last 24 Hours
  - Sort by: Most Recent First
  - Limit: 5

**Step 3: Build the JSON payload**
- Add action: "Text"
- Paste this template (the variables will auto-link):

```
{
  "summary": {
    "activeCalories": [activeCalories],
    "exerciseMinutes": [exerciseMinutes],
    "standHours": [standHours],
    "steps": [steps]
  },
  "workouts": [
    {
      "workoutType": "[Workout Type]",
      "duration": [Duration in Minutes],
      "calories": [Active Calories],
      "startTime": "[Start Date]",
      "endTime": "[End Date]"
    }
  ]
}
```

Note: The workout section needs a "Repeat with Each" loop around the
workouts from Step 2. This can be fiddly — see the simplified version
below if you get stuck.

**Step 4: Send to your tracker**
- Add action: "Get Contents of URL"
  - URL: `https://your-project-name.glitch.me/api/health`
  - Method: POST
  - Headers: Authorization = Bearer YOUR_APP_PASSWORD
  - Request Body: JSON (paste the text from Step 3)

### Simplified version (if the above is too fiddly)

Create a shortcut that just sends daily summary data (skip workouts):

1. "Find Health Samples" → Active Energy → Start of Today → set variable `cal`
2. "Find Health Samples" → Step Count → Start of Today → set variable `steps`
3. "Get Contents of URL":
   - URL: https://your-project-name.glitch.me/api/health
   - Method: POST
   - Headers: Authorization = Bearer YOUR_APP_PASSWORD
   - Request Body: JSON
   - Body: {"summary":{"activeCalories":[cal],"steps":[steps],"exerciseMinutes":0,"standHours":0}}

### Automate it

- Open Shortcuts → Automations tab → + New Automation
- Choose "Time of Day" → set to every hour (or whenever you want)
- Run the "Sync Health Data" shortcut
- Toggle off "Ask Before Running"

You can also add it to your home screen for one-tap manual syncing.

---

## Pattern Analysis

The app automatically detects patterns in your data:

- **Post-exercise glucose impact**: How much your glucose drops/rises after
  different types of exercise
- **Exercise vs rest day comparison**: Average glucose on days you exercise
  vs days you don't
- **Bolus sensitivity**: Whether insulin is more effective on exercise days
- **Time-of-day patterns**: Which hours tend to be highest/lowest
- **Time in range**: Percentage of readings between 4.0–10.0 mmol/L

The more data you log, the better the patterns get. Give it a few days of
consistent logging for meaningful results.

---

## Notes

- **Not medical software**: This is a personal tracking tool. Don't use it
  for dosing decisions without your own clinical judgment.
- **IOB model**: Linear decay over 4 hours for Novorapid. Simplified estimate.
- **Data privacy**: Your data lives on your Glitch project. Credentials are
  in .env which is private and never shared. The app is password-protected.
- **Account safety**: Polls LibreLinkUp every 5 minutes (same rate as the app).
  Thousands of people use similar tools without account issues.

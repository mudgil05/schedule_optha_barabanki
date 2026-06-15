# Ophthalmology PG Schedule — Vercel Deployment

## One-time setup (10 minutes)

### 1. Deploy to Vercel (free)
1. Push this folder to a GitHub repo
2. Go to vercel.com → Import project → select your repo
3. Vercel auto-detects the config and deploys

### 2. Set Environment Variables in Vercel
In Vercel dashboard → Settings → Environment Variables, add:

| Variable | Value |
|---|---|
| `GEMINI_API_KEY` | Your Gemini API key (AIzaSy... or AQ....) |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Full JSON from Google service account (see below) |
| `GOOGLE_CALENDAR_ID` | Your Google Calendar ID (e.g. your@gmail.com) |

### 3. Get Google Service Account (for Calendar invites)
1. Go to console.cloud.google.com
2. Create/select a project
3. Enable **Google Calendar API**
4. IAM & Admin → Service Accounts → Create Service Account
5. Download the JSON key file
6. Paste the ENTIRE JSON content as `GOOGLE_SERVICE_ACCOUNT_JSON`
7. Share your Google Calendar with the service account email (give it "Make changes to events" permission)

### 4. Done!
After setting env vars, Vercel auto-redeploys. Open your Vercel URL and it works — no keys in browser, no config for users.

## How it works
- `index.html` — the full app, zero secrets
- `api/gemini.js` — proxies Gemini API using server-side key
- `api/gcal.js` — creates Google Calendar events using service account
- All credentials stored encrypted in Vercel, never in code or browser

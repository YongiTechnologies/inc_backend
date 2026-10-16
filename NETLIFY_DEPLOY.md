# Deploying the API on Netlify

The API now runs as Netlify Functions instead of a server on Railway:

- `netlify/functions/api.js` runs the whole Express app, one request at a time.
- `netlify/functions/cleanup.js` is the nightly cleanup (02:00 UTC). It replaces
  the node-cron job.
- `netlify.toml` sends `/api/*` and `/health` to the function and publishes only
  `netlify/public` (a one-line page), so nothing else in the repo goes on the web.

The frontend site (clinetteshipping.com) forwards `/api/*` to this backend site.
The browser only ever talks to clinetteshipping.com.

`npm run dev` / `node server.js` still work locally, exactly as before.

Work through the parts in order. Each step says where to click and what to type.

---

## Part 1. Database: move the data off Railway

The live data is in **Railway's MongoDB**. Once Railway is gone, so is that
database. The function needs a database it can reach from the internet, and
**MongoDB Atlas free tier (M0)** is the usual choice: free forever, 512 MB.

### 1a. Create (or choose) the Atlas cluster

Your local `.env` already points at an Atlas cluster called `shipping-logistics`.
If that's yours and you're happy to use it, skip to 1b. Otherwise:

1. Go to https://cloud.mongodb.com and sign in.
2. **Create** > **M0 (Free)**.
3. Provider **AWS**, region **N. Virginia (us-east-1)** or **Ohio (us-east-2)**.
   Netlify functions run in US East, so this keeps every database call short.
4. Name it, e.g. `clinette`. Click **Create Deployment**.

### 1b. Database user and network access

1. **Database Access** > **Add New Database User**. Choose Password and click
   **Autogenerate Secure Password**. Copy it somewhere safe. Role:
   **Read and write to any database**.
2. **Network Access** > **Add IP Address** > **Allow Access from Anywhere**
   (`0.0.0.0/0`). Netlify functions have no fixed IP address, so this is
   required. The long generated password is what protects the database.
3. **Connect** > **Drivers** and copy the connection string. It looks like
   `mongodb+srv://USER:PASSWORD@clinette.xxxxx.mongodb.net/?retryWrites=true&w=majority`.
   Put your password in place of `<db_password>`. This is your **new MONGODB_URI**.

### 1c. Copy the data across

You need the **Railway MongoDB public connection string**: Railway > your
project > MongoDB service > **Connect** > **Public network**. Railway has to be
running for this. If it's paused, you'll have to start it again just for this
copy (a few minutes of use).

Run this from the `inc_backend` folder (PowerShell):

```powershell
$env:SOURCE_MONGODB_URI = "<Railway public Mongo URL>"
$env:TARGET_MONGODB_URI = "<new Atlas MONGODB_URI>"
$env:DB_NAME = "inc_logistics"
node scripts/copy-database.js
```

It prints one line per collection, and every line should end in `[ok]`. It only
reads from Railway. It won't write into an Atlas collection that already has
data, so running it twice is safe.

If you see `querySrv ECONNREFUSED`, add `$env:DNS_SERVERS = "8.8.8.8,1.1.1.1"`
and run it again.

**Don't delete anything on Railway until Part 5 is done.**

---

## Part 2. Backend: a new Netlify team and site

Use a **separate team** so the backend's usage can never pause the frontend
(on the free plan, running out of credits pauses every site in a team).

1. Sign in at https://app.netlify.com.
2. Top-left team menu > **Create new team**. Name: `Clinette API`. Plan: **Free**.
3. In that team: **Add new project** > **Import an existing project** > **GitHub**.
4. Pick `YongiTechnologies/inc_backend`. If you can't see it, click
   **Configure the Netlify app on GitHub** and give it access to the
   YongiTechnologies organisation. An org owner may have to approve this.
5. Settings screen:
   - **Project name:** `clinette-api` (gives `https://clinette-api.netlify.app`).
     If you pick another name, change the URL in the frontend's `netlify.toml`.
   - **Branch to deploy:** `main` once the PR is merged. Before then, choose
     `feat/netlify-functions` to test it.
   - **Build command:** leave empty. **Publish directory** and **Functions
     directory:** leave as shown (they come from `netlify.toml`).
6. **Don't deploy yet.** First add the variables in Part 3. If it already
   deployed, that's fine: add them and redeploy.

---

## Part 3. Backend environment variables

Backend site > **Project configuration** > **Environment variables** >
**Add a variable** > **Add a single variable**. For each one, keep the scopes
as **All scopes**, or at least make sure **Functions** is ticked.

Take the values from Railway (service > **Variables**) unless the table says
otherwise.

| Key | Value |
|---|---|
| `MONGODB_URI` | the **new Atlas** string from 1b |
| `DB_NAME` | `inc_logistics` |
| `NODE_ENV` | `production` |
| `JWT_SECRET` | same as Railway (keeps people signed in) |
| `JWT_REFRESH_SECRET` | same as Railway |
| `JWT_EXPIRES_IN` | `15m` |
| `ALLOWED_ORIGINS` | `https://clinetteshipping.com,https://www.clinetteshipping.com,https://clinetteshipping.netlify.app` |
| `FRONTEND_URL` | `https://clinetteshipping.com` |
| `GOOGLE_CLIENT_ID` | from Railway |
| `GOOGLE_CLIENT_SECRET` | from Railway |
| `GOOGLE_CALLBACK_URL` | `https://clinetteshipping.com/api/auth/google/callback` |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS` | from Railway |
| `EMAIL_FROM`, `CONTACT_EMAIL` | from Railway |
| `GPS_WEBHOOK_SECRET`, `GPS_PROVIDER`, `GOOGLE_MAPS_API_KEY` | from Railway (if set there) |
| `UPLOAD_RATE_LIMIT`, `SESSION_RATE_LIMIT`, `STAFF_IDLE_TIMEOUT_MINUTES` | only if Railway has them |

Don't add `PORT`. Functions don't use it.

Then go to **Deploys** > **Trigger deploy** > **Deploy project**. When it's
green, open https://clinette-api.netlify.app/health. You should see
`{"status":"ok", ...}`.

---

## Part 4. Frontend: point it at the new backend

The frontend PR changes `netlify.toml` to forward `/api/*` to
`https://clinette-api.netlify.app`, and makes the app call its own `/api` when
`NEXT_PUBLIC_API_URL` isn't set.

1. Merge the frontend PR.
2. In the **frontend** site (your existing team) > **Project configuration** >
   **Environment variables**: **delete `NEXT_PUBLIC_API_URL`**. If it stays
   set to the Railway URL, the browser keeps calling Railway directly and skips
   the forwarding.
3. **Deploys** > **Trigger deploy** > **Clear cache and deploy project**. The
   variable is baked in at build time, so a fresh build is required.
4. Open https://clinetteshipping.com/api/health. The `ip` shown should match
   your own public IP (search "what is my ip" to compare). If it shows some
   other address that stays the same from any device, tell Abbot: that would
   mean every user shares one rate limit.

---

## Part 5. Google sign-in, GPS, then switch Railway off

1. **Google sign-in:** https://console.cloud.google.com > APIs & Services >
   Credentials > your OAuth client > **Authorised redirect URIs** > add
   `https://clinetteshipping.com/api/auth/google/callback` > Save.
2. **GPS devices** (only if a provider sends webhooks): change their webhook
   URL to `https://clinette-api.netlify.app/api/gps/webhook/<provider>`.
3. **Test on the live site:** log in with a password, log in with Google,
   look up a tracking number, upload one spreadsheet, send the contact form.
4. When everything works for a day or two, delete the Railway project.

---

## Limits to know

- **Upload size:** Netlify caps a request at 6 MB, and files travel
  base64-encoded, so a spreadsheet must be under about **4.5 MB**. Today's
  sheets are about 20 KB.
- **Time per request:** 10 seconds on the free plan. A 241-row intake sheet took
  about 1 second against a local database. Atlas adds network time, so if a
  very large sheet ever times out, split it.
- **Rate limits** are counted in memory per function instance, so they're
  looser than on a single server. They still stop runaway loops. A stricter
  login limit would need a shared store (for example in Mongo).
- **Credits:** check **Team settings > Usage** in the `Clinette API` team now
  and then. If credits run out, only the API pauses (until the monthly reset),
  not the frontend.
- **Environment variables** for functions must total under 4 KB. The list
  above fits easily, but don't paste whole JSON files into them.

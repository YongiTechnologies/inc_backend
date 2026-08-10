# Handoff — CORS origins for Clinette Shipping

**Date:** 2026-08-10
**Repo:** `MEST_Backend/inc_backend` (branch `main`)

## What was requested
Add two frontend origins to CORS:
- `https://clinetteshipping.netlify.app`
- `clinetteshipping.com`

## What was done (committed to working tree, NOT pushed)

1. **`src/app.js:38`** — Normalized the allowed-origins parsing. The list is now
   trimmed of whitespace and stripped of trailing slashes before matching, because
   browsers never send a trailing slash in the `Origin` header:
   ```js
   const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:3000")
     .split(",")
     .map((o) => o.trim().replace(/\/+$/, ""))
     .filter(Boolean);
   ```
   This also fixed a pre-existing bug: `https://iandc.vercel.app/` (with trailing
   slash) had silently never matched.

2. **`.env`** (gitignored — local only) — Added the new origins plus the `www` variant,
   and removed the stray trailing slash from the vercel entry. Full value:
   ```
   ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5000,https://iandc.vercel.app,https://inc-backend-7nym.onrender.com,https://inclogistics.netlify.app,https://clinetteshipping.netlify.app,https://clinetteshipping.com,https://www.clinetteshipping.com
   ```

3. **`.env.example`** — Updated the placeholder to the real Clinette origins.

## Verification
Ran a node script confirming the three Clinette origins resolve to `true` and
`https://evil.com` resolves to `false` against the parsed list. ✅

## ⚠️ Still TODO (blocking for production)
- **Update `ALLOWED_ORIGINS` in the Render (and/or Railway) environment variables.**
  `.env` is gitignored, so the code change alone does NOT update production. The
  hosting env var must be edited manually to include the Clinette origins.
- Decide whether both apex (`clinetteshipping.com`) and `www.clinetteshipping.com`
  are needed — depends on which host the live site redirects to. Both are currently
  included, which is harmless.
- Commit and push `src/app.js` + `.env.example` (not `.env`).

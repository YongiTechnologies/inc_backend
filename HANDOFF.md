# Clinette Shipping — Parcel Tracking · Session Handoff

_Last updated: 15 Sep 2026._ Living reference for continuing work on the two-layer
parcel-tracking system. Read this first in a new session.

---

## 1. What this is

A shipping company moves goods **China warehouse → container → arrival in Ghana**.
Each stage arrives as an Excel sheet. The sheets never line up by date (one
container draws from many receiving days; one day's goods split across
containers), so the **only** reliable cross-stage key is the **tracking number**.

The system uses a **two-layer model**:

```
uploaded sheets ──parse──► OBSERVATIONS (immutable) ──fold──► PARCELS (derived)
```

- **Observation** = one parcel-row of one uploaded sheet, stored verbatim, never
  mutated. Uploading a file is a pure insert.
- **Parcel** = a pure fold of every observation sharing its `(waybill, customerKey)`
  identity. Order-independent and idempotent: re-derive anytime, any upload order.
- **ManualAdjustment** = staff-entered facts (status, phone fix, hold) overlaid on
  the derived parcel, so re-deriving from sheets never wipes them.

This replaced an older mutate-in-place `ShipmentItem` pipeline that broke on
out-of-order uploads. The old path still exists but is no longer the source of
truth for the v2 UI.

## 2. Repos, deploy, data

| | |
|---|---|
| Backend | `github.com/YongiTechnologies/inc_backend` — Node/Express + Mongoose, on **Railway** |
| Backend URL | `https://incbackend-production.up.railway.app` |
| Frontend | `github.com/kofimuad/inc_frontend` — Next.js 16 / React 19 / TS, at **clinetteshipping.com** |
| Database | **Railway MongoDB**, db name `inc_logistics`. Get the public connection string from Railway → MongoDB service → Connect. Backend talks to it over the internal URL. |

**Deploy freshness has masked several "bugs"** — merging a PR is not enough, the
host must rebuild. If something looks unfixed, confirm the deploy ran after the
merge and hard-refresh. Backend + frontend must both be current for v2 features.

## 3. Architecture — key files (backend `src/`)

- `models/`: `SourceFile.js`, `Observation.js`, `Parcel.js`, `ManualAdjustment.js`
- `services/observations.js` — emitter: spreadsheet → observations (reuses the
  existing `parseUnifiedSheet` in `batch.service.js`)
- `services/parcelDerivation.js` — **pure core**: identity resolution
  (global alias map + per-waybill partition + cross-stage singleton merge), fold,
  reconciliation flags, status lifecycle
- `services/ingest.service.js` — persist observations, re-derive per waybill,
  revert, rebuild, bulk status, `applyAdjustment` (furthest-wins status overlay)
- `controllers/parcel.controller.js` + `routes/parcel.routes.js` — the `/api/v2` API
- `scripts/migrate-to-parcels.js`, `scripts/seed-admins.js`

Frontend v2 lives in `src/components/parcels/*`, `src/services/parcels.ts`,
`src/hooks/useParcels.ts`, page at `src/app/parcels/page.tsx`. Customer/public
tracking data is adapted from parcels in `src/services/shipments.ts`
(`parcelToShipment`).

## 4. The v2 API (`/api/v2`)

Staff (bearer auth):
- `POST /uploads/validate`, `POST /uploads`, `GET /uploads` (paginated), `DELETE /uploads/:fileHash` (revert)
- `GET /reconciliation`, `GET /parcels` (cap 2000), `GET /parcels/:waybill`
- `PATCH /parcels/:waybill/:customerKey` (single manual adjust), `POST /parcels/bulk-status`
- `GET /containers`, `GET /containers/:containerNo` (full manifest)

Public (rate-limited, sanitized): `GET /track/phone/:phone`, `/track/mark/:mark`,
`/track/waybill/:waybill` (masked disambiguation for shared waybills).
Customer (auth): `GET /parcels/mine`.

## 5. Status lifecycle

Ordered: **received → loaded → shipped → at_port → ready_for_pickup → delivered**.
- Derived base per stage: intake=`received`, loading=`shipped`, arrival=`at_port`.
- Manual overrides are **"furthest wins"**: a staff advance is never regressed by a
  later sheet, and a sheet never regresses a manual advance. Staff can't drop a
  status below what the sheets prove.
- Set from the UI: single (parcel slide-over dropdown) or bulk (a "Set status"
  control on each pipeline **group** header — group by date/container first).

Reconciliation ribbon/columns are **stage/flag based** (In Warehouse / On the
Water / Arrived; needs-phone; no-intake-record); status is a per-parcel attribute
shown as a badge, not a column.

## 6. Common operations

```bash
# From inc_backend, with MONGODB_URI set to the Railway Mongo public URL
# (and DB_NAME=inc_logistics, which is the default):

# Seed / reset admin users (no secrets in the script — pass on CLI):
npm run seed-admins -- "email@x.com:SomePassword:Full Name"

# Ingest a folder of sheets (idempotent; --dry-run to preview):
npm run migrate-to-parcels -- --ingest "C:/path/to/sheets"

# Rebuild all parcels from existing observations (e.g. after derivation changes,
# to refresh statuses to the new lifecycle names):
npm run migrate-to-parcels -- --rebuild

# Compare derived parcels vs old ShipmentItem (read-only):
npm run migrate-to-parcels -- --diff

npm test   # jest, 128 tests
```
In the UI, wrong uploads are undone from the **Uploads** tab → Revert (re-derives,
no data loss). Uploading in any order is safe.

## 7. Credentials (not stored here)

- Admin logins: `bediako@clinette.shipping.com`, `hydra@clinette.shipping.com`.
  Passwords were set via `seed-admins` — keep them in the team password manager
  and rotate. Re-run `seed-admins` to reset.
- Mongo URL and JWT secrets live in Railway env vars, not in git.

## 8. Open / outstanding

- **Open PR:** frontend `fix/uploads-pagination` (Uploads-tab Prev/Next paging).
  Merge + redeploy. Everything else across both repos is merged.
- **Pipeline board caps at 1000 parcels** (`useParcels` requests limit 1000; API
  cap 2000). With many containers ingested, the board/date-grouping won't reflect
  *everything*. Next step: paginate or stream the board, or scope it by
  batch/stage. (The Containers tab is complete — it fetches per-container.)
- **Auth / third-party cookie:** refresh works via a body-token fallback because
  the API is on a different site to the app (cross-site cookie gets dropped). The
  cleaner fix is to serve the API from a subdomain (e.g. `api.clinetteshipping.com`)
  so the refresh cookie is first-party; then the body token can be removed.
- **Old `ShipmentItem` path** can be retired once the team is confident on v2.
- **Backend test fixtures** (`tests/fixtures/*.xlsx`) are anonymized in the working
  tree, but the original real sheets remain in git history — scrub with
  `git filter-repo` if that matters.
- **Arrival stage** validated with a synthesized N201-arrived sheet; a genuine
  arrival file from the client would confirm the real column layout.

## 9. Gotchas

- After changing derivation, existing parcels keep old values until re-derived —
  run `--rebuild` or re-upload/revert the affected waybills.
- The frontend falls back to bundled **sample data** (`src/data/parcels.demo.json`,
  anonymized) when the API is unreachable — a "Sample data" badge shows when it's
  in that mode. Don't mistake it for live data.
- Commit attribution: end commits with the `Co-Authored-By` line, PR bodies with
  the Claude Code line (per the session reminder).

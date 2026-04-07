# Fix Patch 2 — Public Tracking Auth Bug + New Packing List Format

## Files to replace

```
src/controllers/batch.controller.js   ← replace
src/routes/batch.routes.js            ← replace
src/services/batch.service.js         ← replace
src/models/Batch.js                   ← replace
src/models/ShipmentItem.js            ← replace
```

No changes to app.js, dashboard, or any other file.

---

## Fix 1 — Public tracking "No token provided" error

**Root cause:** `tracking.routes.js` uses `router.use(authenticate)` mid-file,
which affects all routes registered on that router below that line. Even though
the batch public routes live in a different file (`batch.routes.js`), Express
was hitting `/api/tracking/:trackingNumber` in `tracking.routes.js` before it
reached the batch routes, because `tracking.routes.js` is registered first in
`app.js` with `app.use("/api", trackingRoutes)`.

Since both routers share the `/api` prefix and both handle `/tracking/...`
paths, Express hit the tracking router first. The `router.use(authenticate)`
in that file blocks unauthenticated requests to any `/tracking/...` path on
that router — but there was no matching route for `/phone/:phone` there, so
Express continued to the next router... except the authenticate middleware had
already fired and rejected it.

**Fix:** In `batch.routes.js`, the public tracking routes are now registered
FIRST (before any auth middleware), and the route file makes no use of
`router.use(authenticate)` — auth is applied per-route only. This eliminates
any ordering conflict.

Additionally, `normalisePhone()` now correctly strips `+` before processing,
so `+233551283848` → `233551283848` → matches normally.

---

## Fix 2 — New CTR_INVOICE / Packing List format for "shipped" stage

The second document is no longer the N005-N006 container list format. It is
now a **CTR_INVOICE / Packing List** with this structure:

| Row | Content |
|-----|---------|
| 1   | BL NUMBER |
| 2   | CTR NUMBER — container number e.g. MSBU7337022 |
| 3   | VOLUME — e.g. 40 HQ |
| 4   | SEAL NUMBER |
| 5   | PACKING LIST NUMBER — e.g. 2026-001 |
| 6   | LOADING DATE — e.g. 3/01/2026 |
| 7   | ETD |
| 8   | ETA |
| 9   | **HEADER ROW** — JOB NUMBER, CNEE NAME, PHONE NUMBER, LOCATION, GOODS TYPE, QUANTITY, DESCRIPTION, CBM, COLLECT O/F AMOUNT, PAYMENT TERM $, LOAN, INTEREST, OTHER FEE, INVOICE AMOUNT, REMARKS |
| 10+ | Data rows |

**`parseShippedSheet()`** has been completely rewritten to handle this format.
Key mappings:

| Sheet column       | ShipmentItem field  |
|--------------------|---------------------|
| JOB NUMBER         | waybillNo           |
| CNEE NAME          | customerName        |
| PHONE NUMBER       | customerPhone       |
| LOCATION           | destinationCity     |
| GOODS TYPE         | goodsType           |
| QUANTITY           | quantity            |
| DESCRIPTION        | productDescription  |
| CBM                | cbm                 |
| COLLECT O/F AMOUNT | freightTerm         |
| PAYMENT TERM $     | freightAmount       |
| LOAN               | loan                |
| INTEREST           | interest            |
| OTHER FEE          | otherFee            |
| INVOICE AMOUNT     | invoiceAmount       |
| REMARKS            | remarks             |

Container/shipment metadata (BL, CTR, seal, ETD, ETA) is stored on the
`Batch` record in `containerRefs` and `notes`.

Batch code is derived as `PKL-{packingListNumber}` (e.g. `PKL-2026-001`).

---

## Fix 3 — Two stages only (no arrived)

The workflow is now:
1. **Intake** → status: `in_warehouse`
2. **Shipped** (packing list upload) → status: `shipped`
3. Items in intake but not in packing list → status: `held`

The `arrived` status, `arrivedBatch` field, and `uploadArrived` endpoint have
been removed from the model, service, controller, and routes. The Batch model
`stage` enum is now `["intake", "shipped"]` only.

---

## New financial fields on ShipmentItem

These fields are now stored and returnable from the packing list:
- `freightTerm` — e.g. "COLLECT"
- `freightAmount` — dollar amount from PAYMENT TERM $
- `loan`, `interest`, `otherFee`, `invoiceAmount`
- `remarks` — e.g. "FORK FEE 100"
- `goodsType` — e.g. "CARTON", "CARTONS"

All are also editable via `PATCH /api/batches/items/:itemId`.

---

## Phone number format note

Your account has phone `+233551283848`. The `normalisePhone()` function now
correctly handles the `+` prefix — it strips all non-digits first, so
`+233551283848` → `233551283848` → matched as-is (starts with 233).

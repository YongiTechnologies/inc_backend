# AI Coding Prompt — Ghana Logistics Batch Shipment System

## Context

You are extending an existing Node.js/Express/MongoDB logistics backend (Ghana Logistics Co.)
built by Yongi Technologies. The existing system handles individual shipment tracking with JWT
auth, role-based access (customer / employee / admin), audit logging, and GPS tracking.

You are NOT replacing the existing system. You are adding a new **batch shipment domain**
alongside it. The two domains can coexist. A batch item can optionally be escalated to a
full individual Shipment record by staff, but that is not required.

The existing codebase uses:
- Node.js + Express
- MongoDB + Mongoose
- JWT access tokens (Bearer) + httpOnly cookie refresh tokens
- Role middleware: `authenticate`, `authorize(...roles)` from `src/middleware/auth.middleware.js`
- Standard response helper: `respond(res, statusCode, success, message, data)` from `src/utils/response.js`
- Joi for validation
- Audit logging via `src/services/audit.service.js`

---

## Business Domain

The company ships goods from China to Ghana in containers. There are three stages in a shipment's life:

1. **Intake** — Goods arrive at the warehouse in China. An Excel sheet is uploaded.
2. **Shipped** — Goods are loaded into a container and depart China. A second Excel sheet is uploaded. Not all goods from intake may be shipped — leftover items are flagged as `held`.
3. **Arrived** — The container arrives in Ghana. A third Excel sheet is uploaded. Again, not all shipped items may arrive in one go — leftovers are flagged as `held`.

Each Excel upload represents a **Batch**. One Excel file = one Batch.

Customers can look up their items by phone number or waybill number without needing to log in.
Staff (employee/admin) manage batches, view held items, and can manually reassign held items to a new batch.

---

## Excel Sheet Formats

### Stage 1 — Intake Sheet
No header row. 5 columns (0-indexed):

| Index | Field              | Notes                                              |
|-------|--------------------|----------------------------------------------------|
| 0     | Invoice/Bag No.    | Groups multiple waybills. Sparse — many rows null. |
| 1     | Waybill No.        | Primary item identifier. Can contain spaces (multiple waybills in one cell — split on space). |
| 2     | Customer Phone     | Ghanaian phone number (stored as string, strip leading zeros for matching). |
| 3     | Quantity           | Integer or string like "13pallet", "1pallet". Extract numeric part. |
| 4     | Date               | Intake date (Excel date or parseable string).      |

Example rows:
```
8872354 | 301977756976 301977756989 | 0200485487 | 4          | 2026-04-02
NaN     | 78992390754171            | 0202735240 | 1          | 2026-04-02
8870021 | 18680185099               | 0203213308 | 22         | 2026-04-02
NaN     | 435108299863350           | 0203424850 | 13pallet   | 2026-04-02
```

**Important:** A single row where column 1 contains spaces should be split into multiple
`ShipmentItem` records — one per waybill — all sharing the same invoice/bag, phone, quantity, date.

### Stage 2 — Shipped Sheet
Has metadata rows at the top before the actual header. Structure:

- Row 1 (index 0): empty
- Row 2 (index 1): Container reference string, e.g. `"28th/Sep 2025--N006=MSBU8308501"`
- Row 3 (index 2): Container reference string, e.g. `"28th/Sep 2025--N005=MSDU5985548"`
- Row 4 (index 3): **Header row** — `INVOICE N0., TRACKING N0., CONTACT, CUSTOMER NAME, LOCATION, QTY PER TRACKING, CBM PER TRACKING, PRODUCT DESCRIPTION, KG, OTHER, RECEIVING DATE, [unnamed cols]`
- Row 5+ (index 4+): Data rows

Parse the container reference strings from rows 1–2 (0-indexed) before reading the header.
Container ref format: `"DDth/Mon YYYY--CONTAINERCODE=CONTAINERID"` — extract `CONTAINERCODE` (e.g. N006) and `CONTAINERID` (e.g. MSBU8308501).

**Column mapping (after header row):**

| Column            | Field              | Notes                                             |
|-------------------|--------------------|---------------------------------------------------|
| INVOICE N0.       | invoiceNo          | Bag number. Sparse.                               |
| TRACKING N0.      | waybillNo          | Primary match key. Can contain spaces — split.    |
| CONTACT           | customerPhone      | May be numeric — convert to string, strip spaces. |
| CUSTOMER NAME     | customerName       | Partial/sparse.                                   |
| LOCATION          | destinationCity    | e.g. ACCRA, KUMASI, TAMALE. Sparse.               |
| QTY PER TRACKING  | quantity           | Integer or "1pallet" string — extract numeric.    |
| CBM PER TRACKING  | cbm                | Decimal. Cubic metres.                            |
| PRODUCT DESCRIPTION | productDescription | Sparse.                                         |
| RECEIVING DATE    | receivingDate      | Date the item was received at China port.         |
| Unnamed: 11       | fees               | Misc fees/notes string. Optional.                 |
| Unnamed: 12       | containerRef       | e.g. "N005+N006". The batch container label.      |

Skip the last row if it appears to be a totals/summary row (numeric value in CUSTOMER NAME col,
or all key fields null except one).

### Stage 3 — Arrived Sheet
Same structure as the Shipped sheet (header row + metadata rows at top with container refs).
Parse and process identically.

---

## Data Models

### Batch (new model: `src/models/Batch.js`)

```js
{
  batchCode:      String, // e.g. "N005+N006" or auto-generated "INTAKE-2026-04-02"
  stage:          String, // enum: ["intake", "shipped", "arrived"]
  uploadedBy:     ObjectId → User,
  uploadedAt:     Date,
  containerRefs: [{       // only present for shipped/arrived
    code:   String,       // e.g. "N006"
    id:     String,       // e.g. "MSBU8308501"
    date:   Date,
  }],
  totalItems:     Number, // count of ShipmentItems in this batch
  matchedItems:   Number, // items matched to existing records (for shipped/arrived)
  newItems:       Number, // items newly created in this batch
  heldItems:      Number, // items not in upload, auto-flagged as held
  notes:          String,
  timestamps: true
}
```

### ShipmentItem (new model: `src/models/ShipmentItem.js`)

```js
{
  // Core identifiers
  waybillNo:          String, required, index  // primary match key, uppercase trimmed
  invoiceNo:          String,                  // bag/bundle number

  // Customer
  customerPhone:      String, index            // normalised (digits only, no leading 0 → 233...)
  customerPhoneRaw:   String,                  // original from sheet
  customerId:         ObjectId → User,         // linked if phone matches existing user
  customerName:       String,

  // Logistics
  destinationCity:    String,
  quantity:           Number,
  quantityRaw:        String,                  // original string e.g. "13pallet"
  cbm:                Number,
  productDescription: String,
  containerRef:       String,                  // e.g. "N005+N006"
  fees:               String,

  // Status
  status: String, enum: [
    "in_warehouse",  // after Stage 1 intake
    "shipped",       // after Stage 2 shipped upload
    "arrived",       // after Stage 3 arrived upload
    "held",          // not included in a stage upload — held for next batch
  ],

  // Batch tracking
  intakeBatch:    ObjectId → Batch,  // set at Stage 1
  shippedBatch:   ObjectId → Batch,  // set at Stage 2
  arrivedBatch:   ObjectId → Batch,  // set at Stage 3

  // Dates from sheets
  intakeDate:     Date,
  receivingDate:  Date,   // China port receiving date (from shipped sheet)

  // History
  stageHistory: [{
    stage:     String,
    status:    String,
    batchId:   ObjectId,
    updatedAt: Date,
    note:      String,
  }],

  // Manual staff fields
  heldReason:     String,   // why it was held
  reassignedTo:   ObjectId → Batch,  // if manually reassigned to another batch
  staffNotes:     String,

  timestamps: true
}
```

---

## Service Layer

Create `src/services/batch.service.js` with these functions:

### `parseIntakeSheet(buffer)`
- Parse Excel buffer using `xlsx` or `exceljs` library
- No header row — read raw rows
- For each row: extract invoiceNo, waybillNo(s), customerPhone, quantity, date
- Split waybillNo on whitespace → one item per waybill
- Extract numeric part from quantity strings ("13pallet" → 13, quantity type stored in quantityRaw)
- Skip completely empty rows
- Return array of parsed item objects

### `parseShippedSheet(buffer)` / `parseArrivedSheet(buffer)`
- Read raw rows first to extract container refs from rows at index 1 and 2
- Re-read with header at row index 3
- Parse all columns per mapping above
- Split TRACKING N0. on whitespace → one item per waybill
- Skip totals/summary rows (detect: TRACKING N0. is null AND CONTACT is null)
- Return `{ containerRefs: [...], items: [...] }`

### `normalisePhone(raw)`
- Strip all non-digit characters
- If starts with "0" → replace with "233" (Ghana country code)
- If starts with "233" → keep as-is
- Return normalised string

### `processIntakeBatch(parsedItems, uploadedBy)`
1. Create `Batch` record (stage: "intake", batchCode auto-generated as `INTAKE-{date}`)
2. For each parsed item:
   - Normalise phone, look up User by phone field
   - Check if waybillNo already exists in ShipmentItem:
     - If yes: skip (do not duplicate), count as already existing
     - If no: create new ShipmentItem (status: "in_warehouse", intakeBatch: batch._id)
3. Update batch counts (totalItems, newItems, matchedItems)
4. Return batch with summary stats

### `processShippedBatch(parsedData, uploadedBy)`
1. Create `Batch` record (stage: "shipped", batchCode from containerRefs or "SHIPPED-{date}", containerRefs array)
2. Collect all waybillNos from the uploaded sheet into a Set
3. For each parsed item:
   - Look up existing ShipmentItem by waybillNo:
     - Found + status "in_warehouse" or "held": update → status "shipped", fill in new fields, set shippedBatch, append stageHistory
     - Found + status already "shipped"/"arrived": skip/log
     - Not found: create new ShipmentItem (status: "shipped") — some items may not have had an intake sheet
4. After processing all uploaded items: find all ShipmentItems where `intakeBatch` is set, status is "in_warehouse", and waybillNo NOT in the uploaded set → update those to status "held", heldReason "Not included in shipped batch {batchCode}"
   - **Important:** Only hold items from recent intake batches, not all historical items. Strategy: hold items whose `intakeBatch` was created within the last 90 days and are still "in_warehouse".
5. Update batch counts
6. Return batch with summary

### `processArrivedBatch(parsedData, uploadedBy)`
- Same pattern as processShippedBatch but:
  - Stage: "arrived", status update: "shipped" → "arrived"
  - Items in status "shipped" not in the upload → "held"
  - heldReason: "Not included in arrived batch {batchCode}"

---

## Controller

Create `src/controllers/batch.controller.js`:

### `uploadIntake(req, res, next)`
- Accepts multipart form upload, field name: `file`
- Validate: file must be .xlsx or .xls
- Parse buffer → call `parseIntakeSheet`
- Call `processIntakeBatch(items, req.user._id)`
- Audit log: action "BATCH_INTAKE_UPLOAD"
- Return batch summary

### `uploadShipped(req, res, next)`
- Same pattern, calls `parseShippedSheet` + `processShippedBatch`
- Audit log: action "BATCH_SHIPPED_UPLOAD"

### `uploadArrived(req, res, next)`
- Same pattern, calls `parseArrivedSheet` + `processArrivedBatch`
- Audit log: action "BATCH_ARRIVED_UPLOAD"

### `listBatches(req, res, next)`
- Query params: `page`, `limit`, `stage`
- Sort by uploadedAt desc
- Populate uploadedBy (name, email)

### `getBatch(req, res, next)`
- By batch ID
- Return batch document + item counts by status

### `getBatchItems(req, res, next)`
- Query params: `page`, `limit`, `status` (filter)
- Returns paginated ShipmentItems for a batch (checks intakeBatch OR shippedBatch OR arrivedBatch)

### `getHeldItems(req, res, next)`
- Returns all items with status "held", paginated
- Query params: `page`, `limit`, `phone`, `waybill`

### `reassignHeldItem(req, res, next)`
- PATCH `/api/batches/items/:itemId/reassign`
- Body: `{ targetBatchId, note }`
- Validate: item must be status "held", targetBatch must exist
- Update: set reassignedTo, update status back to the appropriate previous status based on targetBatch.stage, append stageHistory entry
- Admin/employee only

### `lookupByPhone(req, res, next)`
- GET `/api/tracking/phone/:phone` — PUBLIC
- Normalise phone, find all ShipmentItems for that phone
- Return items sorted by updatedAt desc, grouped by status
- Strip staffNotes, fees from public response

### `lookupByWaybill(req, res, next)`
- GET `/api/tracking/waybill/:waybill` — PUBLIC
- Case-insensitive match on waybillNo
- Return single item with status and stage history (public fields only)

### `updateItem(req, res, next)`
- PATCH `/api/batches/items/:itemId`
- Employee/admin only
- Allowed fields: customerName, destinationCity, productDescription, staffNotes, customerPhone (re-runs phone normalisation + user lookup)
- Audit log: action "BATCH_ITEM_UPDATE"

---

## Routes

Create `src/routes/batch.routes.js`:

```
POST   /api/batches/intake                     authenticate + authorize("admin","employee") + multer
POST   /api/batches/shipped                    authenticate + authorize("admin","employee") + multer
POST   /api/batches/arrived                    authenticate + authorize("admin","employee") + multer
GET    /api/batches                            authenticate + authorize("admin","employee")
GET    /api/batches/:id                        authenticate + authorize("admin","employee")
GET    /api/batches/:id/items                  authenticate + authorize("admin","employee")
GET    /api/batches/held                       authenticate + authorize("admin","employee")
PATCH  /api/batches/items/:itemId/reassign     authenticate + authorize("admin","employee")
PATCH  /api/batches/items/:itemId              authenticate + authorize("admin","employee")
GET    /api/tracking/phone/:phone              PUBLIC
GET    /api/tracking/waybill/:waybill          PUBLIC
```

Register the batch routes in `src/app.js`:
```js
const batchRoutes = require("./routes/batch.routes");
app.use("/api", batchRoutes);
```

---

## File Upload Setup

Use `multer` with memory storage (do NOT write to disk):
```js
const multer = require("multer");
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB
  fileFilter: (req, file, cb) => {
    const allowed = [".xlsx", ".xls"];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});
```

Apply as middleware: `upload.single("file")` before each upload controller.

---

## Excel Parsing Library

Use the `xlsx` package (already common in Node ecosystems, no extra install friction):
```js
const XLSX = require("xlsx");
const workbook = XLSX.read(req.file.buffer, { type: "buffer", cellDates: true });
const sheet = workbook.Sheets[workbook.SheetNames[0]];
const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: null });
```

For the shipped/arrived sheet, read `rows[1]` and `rows[2]` for container refs before
calling `XLSX.utils.sheet_to_json` with `{ header: rows[3] }` equivalent logic.

---

## Phone Normalisation Logic

```js
function normalisePhone(raw) {
  if (!raw) return null;
  const digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;
  if (digits.startsWith("233")) return digits;
  if (digits.startsWith("0")) return "233" + digits.slice(1);
  if (digits.length === 9) return "233" + digits; // e.g. 200485487
  return digits;
}
```

User lookup: `User.findOne({ phone: { $regex: normalised, $options: "i" } })` or store
normalised phone on User at registration. Match on last 9 digits as fallback if exact match fails.

---

## Quantity Parsing

```js
function parseQuantity(raw) {
  if (!raw) return null;
  const str = String(raw).trim();
  const match = str.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}
```

---

## Error Handling

- If a row has no waybillNo → skip it, log to a `skippedRows` array returned in the response
- If phone normalisation fails → create item with customerPhone: null, customerId: null
- If Excel parse fails entirely → return 400 with clear message
- Wrap entire batch processing in a try/catch — if it fails midway, the batch record should be deleted (rollback) and a 500 returned

---

## Response Shape for Upload Endpoints

```json
{
  "success": true,
  "message": "Intake batch processed successfully",
  "data": {
    "batch": {
      "_id": "...",
      "batchCode": "INTAKE-2026-04-02",
      "stage": "intake",
      "totalItems": 235,
      "newItems": 220,
      "matchedItems": 15,
      "heldItems": 0,
      "uploadedAt": "2026-04-06T10:00:00Z"
    },
    "skippedRows": [3, 17, 42],
    "summary": "235 items processed. 220 new, 15 already existed, 0 held."
  }
}
```

---

## Dependencies to Add

```json
"multer": "^1.4.5-lts.1",
"xlsx": "^0.18.5"
```

Run: `npm install multer xlsx`

---

## File Structure to Create

```
src/
  models/
    Batch.js           ← new
    ShipmentItem.js    ← new
  services/
    batch.service.js   ← new
  controllers/
    batch.controller.js ← new
  routes/
    batch.routes.js    ← new
```

Edit `src/app.js` to register the new routes.

---

## Constraints & Notes

- All waybill numbers must be stored uppercase and trimmed
- Phone numbers stored in both raw and normalised form
- Never delete ShipmentItems — only update status
- Batch records are immutable after creation (no editing batch metadata)
- The `stageHistory` array is append-only
- Public endpoints (`/api/tracking/phone/:phone` and `/api/tracking/waybill/:waybill`) must NOT return: `staffNotes`, `fees`, `stageHistory.note`, `customerId`, internal batch IDs
- Rate-limit public tracking endpoints: 30 requests per minute per IP
- All upload endpoints require authentication (employee or admin role minimum)

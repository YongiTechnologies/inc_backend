const express   = require("express");
const path      = require("path");
const multer    = require("multer");
const router    = express.Router();
const ctrl      = require("../controllers/batch.controller");
const { authenticate, authorize } = require("../middleware/auth.middleware");
const rateLimit = require("express-rate-limit");

// ─── Multer (memory storage — no disk writes) ─────────────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if ([".xlsx", ".xls"].includes(ext)) return cb(null, true);
    cb(new Error("Only .xlsx and .xls files are accepted"), false);
  },
});

// ─── Rate limiter for public endpoints ───────────────────────────────────────
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      30,
  message:  { success: false, message: "Too many requests. Please wait a moment." },
});

// ─── Middleware stacks ────────────────────────────────────────────────────────
const staffOnly    = [authenticate, authorize("admin", "employee")];
const customerOnly = [authenticate, authorize("customer")];

// =============================================================================
// UPLOAD ENDPOINTS (staff only)
// =============================================================================

/**
 * @swagger
 * /batches/intake:
 *   post:
 *     tags: [Batches]
 *     summary: Upload Stage 1 — Goods received at China warehouse (intake list)
 *     description: >
 *       Upload the intake Excel sheet (no header row, 5 columns: invoice no,
 *       waybill/job no, customer phone, quantity, date). Creates ShipmentItems
 *       with status `in_warehouse`. Duplicate waybills are skipped.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *                 description: Excel file (.xlsx or .xls)
 *     responses:
 *       201:
 *         description: Batch processed successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     batch:
 *                       type: object
 *                       properties:
 *                         batchCode:    { type: string, example: "INTAKE-2026-04-02" }
 *                         stage:        { type: string, example: "intake" }
 *                         totalItems:   { type: integer }
 *                         newItems:     { type: integer }
 *                         matchedItems: { type: integer }
 *                         heldItems:    { type: integer, example: 0 }
 *                     skippedRows: { type: array, items: { type: integer } }
 *                     summary:     { type: string }
 *       400: { description: No file or wrong type }
 *       401: { description: Unauthorized }
 */
/**
 * @swagger
 * /batches/validate:
 *   post:
 *     tags: [Batches]
 *     summary: Preview an upload without writing to the database
 *     description: >
 *       Parses the spreadsheet and returns stage detection, metadata, header
 *       warnings, missing required columns, 5 sample rows, and counts of
 *       items that would be created, updated, or held. No data is persisted.
 *       Use this to power a "Preview" step before the final upload.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       200:
 *         description: Parse preview
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 stage:           { type: string, enum: [intake, shipped, arrived] }
 *                 headerWarnings:  { type: array, items: { type: string } }
 *                 missingRequired: { type: array, items: { type: string } }
 *                 sampleRows:      { type: array }
 *                 willCreate:      { type: integer }
 *                 willUpdate:      { type: integer }
 *                 willHold:        { type: integer }
 *       400: { description: No file or wrong type }
 *       401: { description: Unauthorized }
 */
router.post("/batches/validate", ...staffOnly, upload.single("file"), ctrl.validateUpload);

router.post("/batches/intake",  ...staffOnly, upload.single("file"), ctrl.uploadIntake);

/**
 * @swagger
 * /batches/shipped:
 *   post:
 *     tags: [Batches]
 *     summary: Upload Stage 2 — Container packing list / shipped goods
 *     description: >
 *       Upload the CTR_INVOICE / packing list Excel sheet. Metadata (container
 *       number, loading date, etc.) is in rows 1–8. Header is at row 9. Data
 *       starts at row 10. Columns: JOB NUMBER (waybill), CNEE NAME,
 *       PHONE NUMBER, LOCATION, GOODS TYPE, QUANTITY, DESCRIPTION, CBM,
 *       COLLECT O/F AMOUNT, PAYMENT TERM $, LOAN, INTEREST, OTHER FEE,
 *       INVOICE AMOUNT, REMARKS. Matches existing intake items by job number
 *       and updates them to `shipped`. Items not in this upload are held.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       201: { description: Batch processed }
 *       400: { description: Invalid file }
 *       401: { description: Unauthorized }
 */
router.post("/batches/shipped",  ...staffOnly, upload.single("file"), ctrl.uploadShipped);

/**
 * @swagger
 * /batches/arrived:
 *   post:
 *     tags: [Batches]
 *     summary: Upload Stage 3 — Goods arrived list (Ghana port)
 *     description: >
 *       Upload the goods arrived list. Supports two layouts.
 *       Layout A (packing-list style): metadata rows 1–8 contain CONTAINER NUMBER and
 *       ARRIVAL DATE; row 9 is the header; data from row 10.
 *       Layout B (flat list): row 1 is the header starting with JOB NUMBER; data from row 2.
 *       Matched items are updated from `shipped` → `customs`. The ContainerLoading record
 *       is updated to status `arrived` with the actual arrival date.
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       201: { description: Arrived batch processed }
 *       400: { description: Invalid file }
 *       401: { description: Unauthorized }
 *       409: { description: Already uploaded }
 */
router.post("/batches/arrived",  ...staffOnly, upload.single("file"), ctrl.uploadArrived);

/**
 * @swagger
 * /batches/{id}:
 *   delete:
 *     tags: [Batches]
 *     summary: Retract (delete) a wrong upload — reverses everything the batch did
 *     description: >
 *       Deletes the batch and undoes its effects, so a wrong Excel file can be
 *       retracted the instant it is uploaded, at any stage.
 *       Intake — items created by the upload are deleted.
 *       Shipped — matched items return to in_warehouse (container ref, ETA and
 *       invoice figures cleared), items created by the list are deleted,
 *       auto-held items are un-held, and the auto-created ContainerLoading is removed.
 *       Arrived — items return to shipped and the container rolls back from arrived.
 *       Blocked (409) when items have since moved to a later stage — retract the
 *       later batch first.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Upload retracted }
 *       404: { description: Batch not found }
 *       409: { description: Items have progressed — retract the later batch first }
 */
router.delete("/batches/:id", ...staffOnly, ctrl.deleteBatch);

/**
 * @swagger
 * /batches/{id}:
 *   patch:
 *     tags: [Batches]
 *     summary: Rename an upload, edit its notes, or move all its shipments at once
 *     description: >
 *       `label` and `notes` are cosmetic. `status` is the upload-level
 *       equivalent of advancing a container — it applies one status to every
 *       shipment in the batch. Items that are held, delivered, returned or
 *       failed are skipped; the response message reports how many moved and how
 *       many were left alone.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             minProperties: 1
 *             properties:
 *               label:  { type: string, example: "April 20th intake" }
 *               notes:  { type: string }
 *               status:
 *                 type: string
 *                 enum: [in_warehouse, shipped, at_port, customs, ready_for_pickup, out_for_delivery, delivered, held, returned, failed]
 *     responses:
 *       200: { description: Batch updated }
 *       400: { description: No valid fields, or invalid status }
 *       404: { description: Batch not found }
 */
router.patch("/batches/:id",  ...staffOnly, ctrl.updateBatch);

// =============================================================================
// BATCH LIST & DETAIL (staff)
// =============================================================================

/**
 * @swagger
 * /batches:
 *   get:
 *     tags: [Batches]
 *     summary: List all batches
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: stage
 *         schema: { type: string, enum: [intake, shipped, arrived] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200: { description: Batches retrieved }
 *       401: { description: Unauthorized }
 */
router.get("/batches",           ...staffOnly, ctrl.listBatches);

/**
 * @swagger
 * /batches/held:
 *   get:
 *     tags: [Batches]
 *     summary: List all held items across all batches
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: phone
 *         schema: { type: string }
 *       - in: query
 *         name: waybill
 *         schema: { type: string }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *     responses:
 *       200: { description: Held items retrieved }
 */
router.get("/batches/held",      ...staffOnly, ctrl.getHeldItems);

/**
 * @swagger
 * /batches/{id}:
 *   get:
 *     tags: [Batches]
 *     summary: Get a batch by ID with item status counts
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Batch retrieved }
 *       404: { description: Batch not found }
 */
router.get("/batches/:id",       ...staffOnly, ctrl.getBatch);

/**
 * @swagger
 * /batches/{id}/items:
 *   get:
 *     tags: [Batches]
 *     summary: Get all items in a specific batch
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [in_warehouse, shipped, at_port, customs, ready_for_pickup, out_for_delivery, delivered, held] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *     responses:
 *       200: { description: Items retrieved }
 *       404: { description: Batch not found }
 */
router.get("/batches/:id/items", ...staffOnly, ctrl.getBatchItems);

// =============================================================================
// STAFF: Global list of all batch shipment items
// =============================================================================

/**
 * @swagger
 * /batch-shipments:
 *   get:
 *     tags: [Batches]
 *     summary: List all batch shipment items (staff)
 *     description: Filterable and searchable across all ShipmentItems.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [in_warehouse, shipped, at_port, customs, ready_for_pickup, out_for_delivery, delivered, held] }
 *       - in: query
 *         name: phone
 *         schema: { type: string }
 *         description: Customer phone (any format, auto-normalised)
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Search waybill/job no, invoice no, customer name, destination, container ref
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 100 }
 *     responses:
 *       200: { description: Items retrieved }
 *       401: { description: Unauthorized }
 */
router.get("/batch-shipments",      ...staffOnly, ctrl.listAllItems);

// =============================================================================
// CUSTOMER: Their own batch shipment items
// =============================================================================

/**
 * @swagger
 * /batch-shipments/mine:
 *   get:
 *     tags: [Batches]
 *     summary: Customer — their own batch shipment items
 *     description: >
 *       Matched by User account ID or phone number on their profile.
 *       Results grouped by status for dashboard rendering.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema: { type: string, enum: [in_warehouse, shipped, at_port, customs, ready_for_pickup, out_for_delivery, delivered, held] }
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 50 }
 *     responses:
 *       200:
 *         description: Customer's items grouped by status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     total:   { type: integer }
 *                     grouped: { type: object }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden — customer role required }
 */
router.get("/batch-shipments/mine", ...customerOnly, ctrl.getMyBatchItems);

// =============================================================================
// ITEM MANAGEMENT (staff)
// =============================================================================

/**
 * @swagger
 * /batches/items/{itemId}/reassign:
 *   patch:
 *     tags: [Batches]
 *     summary: Reassign a held item to a different batch
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: itemId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [targetBatchId]
 *             properties:
 *               targetBatchId:
 *                 type: string
 *                 example: "664f1b2c3d4e5f6a7b8c9d01"
 *               note:
 *                 type: string
 *                 example: "Moving to next container batch"
 *     responses:
 *       200: { description: Item reassigned }
 *       400: { description: Missing targetBatchId or item not held }
 *       404: { description: Item or batch not found }
 */
router.patch("/batches/items/:itemId/reassign", ...staffOnly, ctrl.reassignHeldItem);

/**
 * @swagger
 * /batches/items/{itemId}:
 *   patch:
 *     tags: [Batches]
 *     summary: Manually update a shipment item's details (staff correction)
 *     description: At least one field must be provided.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: itemId
 *         required: true
 *         schema: { type: string }
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             minProperties: 1
 *             properties:
 *               customerName:
 *                 type: string
 *                 example: "Kwame Asante"
 *               customerPhone:
 *                 type: string
 *                 description: Any Ghanaian format — will be normalised and re-linked to a User account
 *                 example: "0244123456"
 *               destinationCity:
 *                 type: string
 *                 example: "KUMASI"
 *               productDescription:
 *                 type: string
 *                 example: "Electronics and phone accessories"
 *               invoiceNo:
 *                 type: string
 *                 example: "8872354"
 *               quantity:
 *                 type: integer
 *                 example: 3
 *               cbm:
 *                 type: number
 *                 example: 0.15
 *               containerRef:
 *                 type: string
 *                 description: >
 *                   Attaches the shipment to that container. It inherits the
 *                   container's ETA and — unless `status` is sent in the same
 *                   request — the status the container implies, so it appears
 *                   under the container on the Container Loadings tab.
 *                 example: "MSBU7337022"
 *               status:
 *                 type: string
 *                 enum: [in_warehouse, shipped, at_port, customs, ready_for_pickup, out_for_delivery, delivered, held, returned, failed]
 *                 description: Manual status override. Recorded in the item's timeline.
 *                 example: "at_port"
 *               freightAmount:
 *                 type: number
 *                 description: Collect O/F amount from the packing list
 *                 example: 68.0
 *               paymentTerm:
 *                 type: string
 *                 example: "COLLECT"
 *               invoiceAmount:
 *                 type: number
 *                 example: 68.0
 *               remarks:
 *                 type: string
 *                 example: "FORK FEE 100"
 *               staffNotes:
 *                 type: string
 *                 description: Internal notes — not visible to customers
 *                 example: "Confirmed by customer — awaiting next batch"
 *     responses:
 *       200: { description: Item updated }
 *       400: { description: No valid fields provided }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       404: { description: Item not found }
 */
router.patch("/batches/items/:itemId", ...staffOnly, ctrl.updateItem);

/**
 * @swagger
 * /batches/items/{itemId}:
 *   delete:
 *     tags: [Batches]
 *     summary: Delete a single shipment item (staff correction)
 *     description: >
 *       Permanently removes one shipment record — e.g. a row that was uploaded
 *       or entered by mistake. Use DELETE /batches/{id} instead to retract an
 *       entire wrong upload. The deletion is written to the audit log.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: itemId
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200: { description: Shipment deleted }
 *       401: { description: Unauthorized }
 *       403: { description: Forbidden }
 *       404: { description: Shipment not found }
 */
router.delete("/batches/items/:itemId", ...staffOnly, ctrl.deleteItem);

// ─── Public tracking endpoints removed ───────────────────────────────────────
// These have been consolidated into tracking.routes.js:
// - GET /api/tracking/phone/:phone
// - GET /api/tracking/waybill/:waybill
// Use those endpoints instead for public tracking lookups.

module.exports = router;

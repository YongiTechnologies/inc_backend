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
// UPLOAD ENDPOINTS
// =============================================================================

/**
 * @swagger
 * /batches/intake:
 *   post:
 *     tags: [Batches]
 *     summary: Upload Stage 1 — Goods received at China warehouse
 *     description: >
 *       Upload the intake Excel sheet (no header row, 5 columns: invoice no,
 *       waybill no, customer phone, quantity, date). Creates ShipmentItems with
 *       status `in_warehouse`. Duplicate waybills are skipped.
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
 *                 message: { type: string, example: "Intake batch processed successfully" }
 *                 data:
 *                   type: object
 *                   properties:
 *                     batch:
 *                       type: object
 *                       properties:
 *                         _id:         { type: string }
 *                         batchCode:   { type: string, example: "INTAKE-2026-04-02" }
 *                         stage:       { type: string, example: "intake" }
 *                         totalItems:  { type: integer, example: 235 }
 *                         newItems:    { type: integer, example: 220 }
 *                         matchedItems: { type: integer, example: 15 }
 *                         heldItems:   { type: integer, example: 0 }
 *                     skippedRows:  { type: array, items: { type: integer } }
 *                     summary:      { type: string }
 *       400:
 *         description: No file uploaded or wrong file type
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden — employee or admin required
 */
router.post("/batches/intake",  ...staffOnly, upload.single("file"), ctrl.uploadIntake);

/**
 * @swagger
 * /batches/shipped:
 *   post:
 *     tags: [Batches]
 *     summary: Upload Stage 2 — Container departed China
 *     description: >
 *       Upload the shipped Excel sheet (header row at row 4, container refs in
 *       rows 2–3). Matches existing items by waybill number and updates them to
 *       `shipped`. Items not in this upload that are still `in_warehouse` are
 *       flagged as `held`.
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
 *       201:
 *         description: Batch processed
 *       400:
 *         description: Invalid file
 *       401:
 *         description: Unauthorized
 */
router.post("/batches/shipped", ...staffOnly, upload.single("file"), ctrl.uploadShipped);

/**
 * @swagger
 * /batches/arrived:
 *   post:
 *     tags: [Batches]
 *     summary: Upload Stage 3 — Container arrived in Ghana
 *     description: >
 *       Upload the arrived Excel sheet (same format as shipped sheet). Matches
 *       existing items and updates them to `arrived`. Items still in `shipped`
 *       that are not in this upload are flagged as `held`.
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
 *       201:
 *         description: Batch processed
 *       400:
 *         description: Invalid file
 *       401:
 *         description: Unauthorized
 */
router.post("/batches/arrived", ...staffOnly, upload.single("file"), ctrl.uploadArrived);

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
 *         schema:
 *           type: string
 *           enum: [intake, shipped, arrived]
 *         description: Filter by batch stage
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20 }
 *     responses:
 *       200:
 *         description: Batches retrieved
 *       401:
 *         description: Unauthorized
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
 *         description: Filter by customer phone number
 *       - in: query
 *         name: waybill
 *         schema: { type: string }
 *         description: Filter by waybill number (partial match)
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *     responses:
 *       200:
 *         description: Held items retrieved
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
 *       200:
 *         description: Batch retrieved
 *       404:
 *         description: Batch not found
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
 *         schema:
 *           type: string
 *           enum: [in_warehouse, shipped, arrived, held]
 *         description: Filter items by status
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 50 }
 *     responses:
 *       200:
 *         description: Items retrieved
 *       404:
 *         description: Batch not found
 */
router.get("/batches/:id/items", ...staffOnly, ctrl.getBatchItems);

// =============================================================================
// STAFF: Global shipment items list (batch-domain equivalent of /api/shipments)
// =============================================================================

/**
 * @swagger
 * /batch-shipments:
 *   get:
 *     tags: [Batches]
 *     summary: List all batch shipment items (staff)
 *     description: >
 *       Returns all ShipmentItems across all batches with filtering, search,
 *       and pagination. This is the batch-domain equivalent of `GET /api/shipments`
 *       for employees and admins.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [in_warehouse, shipped, arrived, held]
 *         description: Filter by item status
 *       - in: query
 *         name: phone
 *         schema: { type: string }
 *         description: Filter by customer phone (any format — normalised automatically)
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Search waybill no, invoice no, customer name, destination, container ref
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 100 }
 *     responses:
 *       200:
 *         description: Items retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     items:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/ShipmentItem'
 *                     pagination:
 *                       $ref: '#/components/schemas/Pagination'
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 */
router.get("/batch-shipments", ...staffOnly, ctrl.listAllItems);

// =============================================================================
// CUSTOMER: Their own batch shipment items
// =============================================================================

/**
 * @swagger
 * /batch-shipments/mine:
 *   get:
 *     tags: [Batches]
 *     summary: Customer — view their own batch shipment items
 *     description: >
 *       Returns all ShipmentItems linked to the authenticated customer, matched
 *       by their User account ID or by phone number on their profile. Results are
 *       grouped by status for easy dashboard rendering. Use this alongside
 *       `GET /api/shipments/mine` to show the customer the full picture of their
 *       shipments (both individually-tracked and batch-uploaded).
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [in_warehouse, shipped, arrived, held]
 *         description: Filter by item status (optional — omit to get all)
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 50 }
 *     responses:
 *       200:
 *         description: Customer's shipment items retrieved and grouped by status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 data:
 *                   type: object
 *                   properties:
 *                     total: { type: integer }
 *                     grouped:
 *                       type: object
 *                       properties:
 *                         in_warehouse:
 *                           type: array
 *                           items: { $ref: '#/components/schemas/ShipmentItem' }
 *                         shipped:
 *                           type: array
 *                           items: { $ref: '#/components/schemas/ShipmentItem' }
 *                         arrived:
 *                           type: array
 *                           items: { $ref: '#/components/schemas/ShipmentItem' }
 *                         held:
 *                           type: array
 *                           items: { $ref: '#/components/schemas/ShipmentItem' }
 *                     pagination:
 *                       $ref: '#/components/schemas/Pagination'
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden — customer role required
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
 *     description: >
 *       Moves a held item into a target batch, updating its status to match the
 *       target batch's stage (intake → in_warehouse, shipped → shipped,
 *       arrived → arrived). Appends a stageHistory entry.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: itemId
 *         required: true
 *         schema: { type: string }
 *         description: MongoDB ID of the ShipmentItem
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
 *                 description: MongoDB ID of the batch to move the item into
 *                 example: "664f1b2c3d4e5f6a7b8c9d01"
 *               note:
 *                 type: string
 *                 description: Optional reason/note for the reassignment
 *                 example: "Held due to manifest error — moving to N007 batch"
 *     responses:
 *       200:
 *         description: Item reassigned successfully
 *       400:
 *         description: Missing targetBatchId or item is not held
 *       404:
 *         description: Item or target batch not found
 */
router.patch("/batches/items/:itemId/reassign", ...staffOnly, ctrl.reassignHeldItem);

/**
 * @swagger
 * /batches/items/{itemId}:
 *   patch:
 *     tags: [Batches]
 *     summary: Manually update a shipment item's details (staff correction)
 *     description: >
 *       Allows staff to correct or fill in details on any ShipmentItem.
 *       At least one field must be provided. If `customerPhone` is updated,
 *       the system re-normalises the number and attempts to re-link the item
 *       to a matching User account.
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: itemId
 *         required: true
 *         schema: { type: string }
 *         description: MongoDB ID of the ShipmentItem to update
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
 *                 description: Customer's full name
 *                 example: "Kwame Asante"
 *               customerPhone:
 *                 type: string
 *                 description: >
 *                   Customer phone number (any Ghanaian format accepted —
 *                   0XXXXXXXXX, 233XXXXXXXXX, or 9-digit). Will be normalised
 *                   and linked to a User account if one exists.
 *                 example: "0244123456"
 *               destinationCity:
 *                 type: string
 *                 description: Delivery city in Ghana
 *                 example: "KUMASI"
 *               productDescription:
 *                 type: string
 *                 description: Description of the goods
 *                 example: "Electronics and phone accessories"
 *               invoiceNo:
 *                 type: string
 *                 description: Bag/invoice number correction
 *                 example: "8872354"
 *               quantity:
 *                 type: integer
 *                 description: Number of pieces/units
 *                 example: 3
 *               cbm:
 *                 type: number
 *                 description: Volume in cubic metres
 *                 example: 0.15
 *               containerRef:
 *                 type: string
 *                 description: Container reference code
 *                 example: "N005+N006"
 *               staffNotes:
 *                 type: string
 *                 description: Internal staff notes (not visible to customers)
 *                 example: "Customer confirmed item was left at port — holding for next batch"
 *     responses:
 *       200:
 *         description: Item updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: "Item updated" }
 *                 data:
 *                   $ref: '#/components/schemas/ShipmentItem'
 *       400:
 *         description: No valid fields provided in request body
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: false }
 *                 message:
 *                   type: string
 *                   example: "No valid fields provided. Updatable fields: customerName, destinationCity, ..."
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden — employee or admin required
 *       404:
 *         description: Item not found
 */
router.patch("/batches/items/:itemId", ...staffOnly, ctrl.updateItem);

// =============================================================================
// PUBLIC TRACKING
// =============================================================================

/**
 * @swagger
 * /tracking/phone/{phone}:
 *   get:
 *     tags: [Public Tracking]
 *     summary: Look up all batch shipment items for a phone number (public)
 *     description: >
 *       No authentication required. Returns all items linked to this phone number,
 *       grouped by status. Accepts any Ghanaian phone format (0XXXXXXXXX,
 *       233XXXXXXXXX, or 9-digit). Rate-limited to 30 requests/minute.
 *     parameters:
 *       - in: path
 *         name: phone
 *         required: true
 *         schema: { type: string }
 *         example: "0200485487"
 *     responses:
 *       200:
 *         description: Items found and grouped by status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean }
 *                 data:
 *                   type: object
 *                   properties:
 *                     total: { type: integer }
 *                     grouped:
 *                       type: object
 *                       properties:
 *                         in_warehouse: { type: array, items: { type: object } }
 *                         shipped:      { type: array, items: { type: object } }
 *                         arrived:      { type: array, items: { type: object } }
 *                         held:         { type: array, items: { type: object } }
 *       400:
 *         description: Invalid phone number format
 *       404:
 *         description: No shipments found for this phone number
 *       429:
 *         description: Rate limit exceeded
 */
router.get("/tracking/phone/:phone",     publicLimiter, ctrl.lookupByPhone);

/**
 * @swagger
 * /tracking/waybill/{waybill}:
 *   get:
 *     tags: [Public Tracking]
 *     summary: Look up a single item by waybill/tracking number (public)
 *     description: >
 *       No authentication required. Case-insensitive exact match on waybill number.
 *       Rate-limited to 30 requests/minute.
 *     parameters:
 *       - in: path
 *         name: waybill
 *         required: true
 *         schema: { type: string }
 *         example: "78992390754171"
 *     responses:
 *       200:
 *         description: Item found
 *       404:
 *         description: Waybill not found
 *       429:
 *         description: Rate limit exceeded
 */
router.get("/tracking/waybill/:waybill", publicLimiter, ctrl.lookupByWaybill);

module.exports = router;

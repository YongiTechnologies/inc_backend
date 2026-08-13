const express = require("express");
const router  = express.Router();
const ctrl    = require("../controllers/tracking.controller");
const { authenticate, authorize } = require("../middleware/auth.middleware");
const { validate, validators }    = require("../utils/validators");
const rateLimit = require("express-rate-limit");

// Rate limiter for public tracking endpoints
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      30,
  message:  { success: false, message: "Too many requests. Please wait a moment." },
});

/**
 * @swagger
 * /tracking/{trackingNumber}:
 *   get:
 *     tags:
 *       - Tracking
 *     summary: Get public tracking information
 *     description: Retrieve shipment tracking timeline without authentication (no internal notes)
 *     parameters:
 *       - in: path
 *         name: trackingNumber
 *         required: true
 *         schema:
 *           type: string
 *         example: GLC-ABCD1234EF
 *         description: Shipment tracking number (waybill)
 *       - in: query
 *         name: phone
 *         schema: { type: string }
 *         description: >
 *           Narrows a shared tracking number to one customer. Any Ghanaian
 *           format — 0XXXXXXXXX, +233XXXXXXXXX, 233XXXXXXXXX or bare 9-digit.
 *       - in: query
 *         name: mark
 *         schema: { type: string }
 *         example: "ACC-28672"
 *         description: >
 *           Alternative to `phone` for customers recorded by shipping mark
 *           only. Case and separators are ignored.
 *     responses:
 *       200:
 *         description: >
 *           Tracking information retrieved. When several customers share the
 *           number and neither `phone` nor `mark` was supplied, responds with
 *           `ambiguous: true` and a list of masked `choices` instead of items.
 *       404:
 *         description: Tracking number not found, or identifier matched nothing on it
 */
router.get("/tracking/:trackingNumber", ctrl.publicTrack);

/**
 * @swagger
 * /tracking/mark/{mark}:
 *   get:
 *     tags: [Public Tracking]
 *     summary: Look up all shipments for a shipping mark (public, no login required)
 *     description: >
 *       For customers whose sheets carry a shipping mark instead of a phone
 *       number (e.g. "ACC-28672", "ANGIE"). Case and separators are ignored.
 *       Rate-limited to 30 req/min.
 *     parameters:
 *       - in: path
 *         name: mark
 *         required: true
 *         schema: { type: string }
 *         example: "ACC-28672"
 *     responses:
 *       200:
 *         description: Items found
 *       404:
 *         description: No shipments for this shipping mark
 */
router.get("/tracking/mark/:mark", publicLimiter, ctrl.publicTrackByMark);

/**
 * @swagger
 * /tracking/phone/{phone}:
 *   get:
 *     tags: [Public Tracking]
 *     summary: Look up all shipment items for a phone number (public, no login required)
 *     description: >
 *       No authentication required. Accepts any Ghanaian phone format —
 *       0XXXXXXXXX, +233XXXXXXXXX, 233XXXXXXXXX, or bare 9-digit.
 *       Returns items grouped by status. Rate-limited to 30 req/min.
 *     parameters:
 *       - in: path
 *         name: phone
 *         required: true
 *         schema: { type: string }
 *         example: "0200485487"
 *     responses:
 *       200:
 *         description: Items found grouped by status
 */
router.get("/tracking/phone/:phone", publicLimiter, ctrl.publicTrackByPhone);

/**
 * @swagger
 * /tracking/waybill/{waybill}:
 *   get:
 *     tags: [Public Tracking]
 *     summary: Look up items by waybill/job number (public, no login required)
 *     description: >
 *       Case-insensitive exact match. Returns every shipment on the waybill —
 *       a consolidated number legitimately carries several customers' goods.
 *       Supply `phone` or `mark` to narrow to one customer; without either, a
 *       shared waybill responds with `ambiguous: true` and masked `choices`.
 *       Rate-limited to 30 req/min.
 *     parameters:
 *       - in: path
 *         name: waybill
 *         required: true
 *         schema: { type: string }
 *         example: "1C202668306141"
 *       - in: query
 *         name: phone
 *         schema: { type: string }
 *         description: Narrows a shared waybill to one customer. Any Ghanaian format.
 *       - in: query
 *         name: mark
 *         schema: { type: string }
 *         example: "ACC-28672"
 *         description: Alternative to `phone` for mark-only customers.
 *     responses:
 *       200:
 *         description: Item(s) found, or a masked disambiguation list
 *       404:
 *         description: Waybill not found, or identifier matched nothing on it
 */
router.get("/tracking/waybill/:waybill", publicLimiter, ctrl.publicTrackByWaybill);

// ─── Authenticated routes ──────────────────────────────────────────────────────
// Scope authenticate to /items and /stats only — a bare router.use(authenticate)
// with no path would intercept unrelated public routes (e.g. /container-loadings)
// that fall through this router without matching any tracking-specific path.

router.use(["/items", "/stats"], authenticate);

/**
 * @swagger
 * /items/mine:
 *   get:
 *     tags:
 *       - Items
 *     summary: Get customer's own shipment items
 *     description: Retrieve paginated list of items belonging to the authenticated customer
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 50 }
 *     responses:
 *       200:
 *         description: Items retrieved
 */
router.get("/items/mine", authorize("customer"), ctrl.myItems);

/**
 * @swagger
 * /items:
 *   get:
 *     tags:
 *       - Items
 *     summary: List all shipment items (admin/employee only)
 *     description: Retrieve paginated list of all items with optional filters
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema: { type: integer, default: 1 }
 *       - in: query
 *         name: limit
 *         schema: { type: integer, default: 20, maximum: 100 }
 *       - in: query
 *         name: status
 *         schema: { type: string }
 *       - in: query
 *         name: search
 *         schema: { type: string }
 *         description: Matches waybill, invoice, description, destination, customer name, shipping mark or phone
 *       - in: query
 *         name: needsPhone
 *         schema: { type: boolean }
 *         description: >
 *           `true` lists only items whose upload carried no phone number —
 *           the worklist for filling those gaps in manually.
 *     responses:
 *       200:
 *         description: Items retrieved
 */
router.get("/items", authorize("admin", "employee"), ctrl.listItems);

/**
 * @swagger
 * /items:
 *   post:
 *     tags:
 *       - Items
 *     summary: Create a new shipment item manually
 *     description: Create a new item record (admin/employee only)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - waybillNo
 *               - customerPhone
 *             properties:
 *               waybillNo:
 *                 type: string
 *               customerPhone:
 *                 type: string
 *               origin:
 *                 $ref: '#/components/schemas/Location'
 *               destination:
 *                 $ref: '#/components/schemas/Location'
 *               productDescription:
 *                 type: string
 *               packageType:
 *                 type: string
 *               weight:
 *                 type: number
 *               quantity:
 *                 type: integer
 *               declaredValue:
 *                 type: number
 *               estimatedDelivery:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       201:
 *         description: Item created
 */
router.post("/items", authorize("admin", "employee"), ctrl.createItem);

/**
 * @swagger
 * /items/{id}:
 *   patch:
 *     tags:
 *       - Items
 *     summary: Update item details
 *     description: Update details for an existing item (admin/employee only)
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
 *             properties:
 *               assignedTo:
 *                 type: string
 *               origin:
 *                 $ref: '#/components/schemas/Location'
 *               destination:
 *                 $ref: '#/components/schemas/Location'
 *               productDescription:
 *                 type: string
 *               packageType:
 *                 type: string
 *               weight:
 *                 type: number
 *               declaredValue:
 *                 type: number
 *               estimatedDelivery:
 *                 type: string
 *                 format: date-time
 *     responses:
 *       200:
 *         description: Item updated
 */
router.patch("/items/:id", authorize("admin", "employee"), ctrl.updateItem);

/**
 * @swagger
 * /items/{id}/tracking:
 *   get:
 *     tags:
 *       - Items
 *     summary: Get full tracking detail (internal)
 *     description: Retrieve complete tracking information including internal notes
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema: { type: string }
 *     responses:
 *       200:
 *         description: Tracking detail retrieved
 */
router.get("/items/:id/tracking", authorize("admin", "employee"), ctrl.internalTrack);

/**
 * @swagger
 * /items/{id}/status:
 *   post:
 *     tags:
 *       - Items
 *     summary: Update item status (log checkpoint)
 *     description: Add a new status update to the item's timeline
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
 *             required:
 *               - status
 *             properties:
 *               status:
 *                 type: string
 *                 enum:
 *                   - pending
 *                   - picked_up
 *                   - in_transit
 *                   - customs
 *                   - out_for_delivery
 *                   - delivered
 *                   - failed
 *                   - returned
 *                   - in_warehouse
 *                   - shipped
 *                   - held
 *               location:
 *                 $ref: '#/components/schemas/Location'
 *               note:
 *                 type: string
 *               internalNote:
 *                 type: string
 *               carrier:
 *                 type: string
 *               carrierReference:
 *                 type: string
 *     responses:
 *       200:
 *         description: Status updated
 *       422:
 *         description: Invalid status transition
 */
router.post("/items/:id/status", authorize("admin", "employee"), ctrl.updateItemStatus);

/**
 * @swagger
 * /stats:
 *   get:
 *     tags:
 *       - Items
 *     summary: Get dashboard statistics
 *     description: Retrieve shipment statistics with optional date range filtering (admin only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: from
 *         schema: { type: string, format: date-time }
 *       - in: query
 *         name: to
 *         schema: { type: string, format: date-time }
 *     responses:
 *       200:
 *         description: Statistics retrieved
 */
router.get("/stats", authorize("admin"), ctrl.getStats);

module.exports = router;

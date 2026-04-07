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
 *         example: GHA-2024-001234
 *         description: Shipment tracking number
 *     responses:
 *       200:
 *         description: Tracking information retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Tracking info retrieved
 *                 data:
 *                   type: object
 *                   properties:
 *                     shipment:
 *                       $ref: '#/components/schemas/Shipment'
 *                     events:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/TrackingEvent'
 *       404:
 *         description: Tracking number not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error404'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error500'
 */
router.get("/tracking/:trackingNumber", ctrl.publicTrack);

/**
 * @swagger
 * /tracking/phone/{phone}:
 *   get:
 *     tags: [Public Tracking]
 *     summary: Look up all batch shipment items for a phone number (public, no login required)
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
 *         description: "Phone number in any format: 0244123456 / +233244123456 / 233244123456"
 *     responses:
 *       200:
 *         description: Items found grouped by status
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: "Shipments retrieved" }
 *                 data:
 *                   type: object
 *                   properties:
 *                     total: { type: integer }
 *                     grouped:
 *                       type: object
 *                       properties:
 *                         in_warehouse: { type: array, items: { type: object } }
 *                         shipped:      { type: array, items: { type: object } }
 *                         held:         { type: array, items: { type: object } }
 *       400:
 *         description: Invalid phone number
 *       404:
 *         description: No shipments found for this phone number
 *       429:
 *         description: Rate limit exceeded
 */
router.get("/tracking/phone/:phone", publicLimiter, ctrl.publicTrackByPhone);

/**
 * @swagger
 * /tracking/waybill/{waybill}:
 *   get:
 *     tags: [Public Tracking]
 *     summary: Look up a single item by waybill/job number (public, no login required)
 *     description: Case-insensitive exact match. Rate-limited to 30 req/min.
 *     parameters:
 *       - in: path
 *         name: waybill
 *         required: true
 *         schema: { type: string }
 *         example: "1C202668306141"
 *     responses:
 *       200:
 *         description: Item found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success: { type: boolean, example: true }
 *                 message: { type: string, example: "Item retrieved" }
 *                 data: { type: object }
 *       404:
 *         description: Waybill not found
 *       429:
 *         description: Rate limit exceeded
 */
router.get("/tracking/waybill/:waybill", publicLimiter, ctrl.publicTrackByWaybill);

/**
 * @swagger
 * /shipments/mine:
 *   get:
 *     tags:
 *       - Tracking
 *     summary: Get customer's own shipments
 *     description: Retrieve paginated list of shipments belonging to the authenticated customer
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *         description: Page number for pagination
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 50
 *           default: 20
 *         description: Number of items per page
 *     responses:
 *       200:
 *         description: Shipments retrieved
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PaginatedResponse'
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error401'
 *       403:
 *         description: Forbidden - customer role required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error403'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error500'
 */
router.use(authenticate);

router.get("/shipments/mine", authorize("customer"), ctrl.myShipments);

/**
 * @swagger
 * /shipments:
 *   get:
 *     tags:
 *       - Tracking
 *     summary: List all shipments (admin/employee only)
 *     description: Retrieve paginated list of all shipments with optional filters
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *           minimum: 1
 *           default: 1
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *           minimum: 1
 *           maximum: 100
 *           default: 20
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum:
 *             - pending
 *             - picked_up
 *             - in_transit
 *             - customs
 *             - out_for_delivery
 *             - delivered
 *             - failed
 *             - returned
 *         description: Filter by shipment status
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 *         description: Search by tracking number, description, or destination city
 *     responses:
 *       200:
 *         description: Shipments retrieved
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/PaginatedResponse'
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error401'
 *       403:
 *         description: Forbidden - admin/employee role required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error403'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error500'
 */
router.get("/shipments", authorize("admin", "employee"), ctrl.listShipments);

/**
 * @swagger
 * /shipments:
 *   post:
 *     tags:
 *       - Tracking
 *     summary: Create a new shipment
 *     description: Create a new shipment record (admin/employee only)
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - trackingNumber
 *               - customerId
 *               - origin
 *               - destination
 *               - description
 *             properties:
 *               trackingNumber:
 *                 type: string
 *                 minLength: 3
 *                 maxLength: 50
 *                 example: "GH-INC-001"
 *               customerId:
 *                 type: string
 *                 example: 507f1f77bcf86cd799439011
 *               origin:
 *                 $ref: '#/components/schemas/Location'
 *               destination:
 *                 $ref: '#/components/schemas/Location'
 *               description:
 *                 type: string
 *                 example: Mixed Clothing & Accessories
 *               packageType:
 *                 type: string
 *                 enum: [document, parcel, pallet, container]
 *                 example: container
 *               weight:
 *                 type: number
 *                 example: 420
 *               quantity:
 *                 type: integer
 *                 example: 8
 *               declaredValue:
 *                 type: number
 *                 example: 5000.00
 *               estimatedDelivery:
 *                 type: string
 *                 format: date-time
 *               requiresCustoms:
 *                 type: boolean
 *                 example: true
 *               isFragile:
 *                 type: boolean
 *                 example: false
 *     responses:
 *       201:
 *         description: Shipment created successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Shipment created
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                     trackingNumber:
 *                       type: string
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error400'
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error401'
 *       403:
 *         description: Forbidden - admin/employee role required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error403'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error500'
 */
router.post("/shipments", authorize("admin", "employee"), validate(validators.createShipment), ctrl.createShipment);

/**
 * @swagger
 * /shipments/{id}:
 *   patch:
 *     tags:
 *       - Tracking
 *     summary: Update shipment details
 *     description: Update shipment details for an existing shipment (admin/employee only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         example: 507f1f77bcf86cd799439012
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               assignedTo:
 *                 type: string
 *                 example: 507f1f77bcf86cd799439013
 *               origin:
 *                 $ref: '#/components/schemas/Location'
 *               destination:
 *                 $ref: '#/components/schemas/Location'
 *               description:
 *                 type: string
 *                 example: Updated description for the shipment
 *               packageType:
 *                 type: string
 *                 enum: [document, parcel, pallet, container]
 *               weight:
 *                 type: number
 *                 example: 456
 *               dimensions:
 *                 type: object
 *                 properties:
 *                   length:
 *                     type: number
 *                   width:
 *                     type: number
 *                   height:
 *                     type: number
 *               quantity:
 *                 type: integer
 *                 example: 10
 *               declaredValue:
 *                 type: number
 *                 example: 5200
 *               estimatedDelivery:
 *                 type: string
 *                 format: date-time
 *               requiresCustoms:
 *                 type: boolean
 *                 example: true
 *               isFragile:
 *                 type: boolean
 *                 example: false
 *               specialInstructions:
 *                 type: string
 *                 example: Leave at reception if not available
 *     responses:
 *       200:
 *         description: Shipment updated successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Shipment updated
 *                 data:
 *                   $ref: '#/components/schemas/Shipment'
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error400'
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error401'
 *       403:
 *         description: Forbidden - admin/employee role required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error403'
 *       404:
 *         description: Shipment not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error404'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error500'
 */
router.patch("/shipments/:id", authorize("admin", "employee"), validate(validators.updateShipment), ctrl.updateShipment);

/**
 * @swagger
 * /shipments/{id}/tracking:
 *   get:
 *     tags:
 *       - Tracking
 *     summary: Get full tracking detail (internal)
 *     description: Retrieve complete tracking information including internal notes (admin/employee only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         example: 507f1f77bcf86cd799439012
 *     responses:
 *       200:
 *         description: Tracking detail retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                 message:
 *                   type: string
 *                 data:
 *                   type: object
 *                   properties:
 *                     shipment:
 *                       $ref: '#/components/schemas/Shipment'
 *                     events:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/TrackingEvent'
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error401'
 *       403:
 *         description: Forbidden - admin/employee role required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error403'
 *       404:
 *         description: Shipment not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error404'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error500'
 */
router.get("/shipments/:id/tracking", authorize("admin", "employee"), ctrl.internalTrack);

/**
 * @swagger
 * /shipments/{id}/tracking:
 *   post:
 *     tags:
 *       - Tracking
 *     summary: Log a tracking checkpoint
 *     description: Add a new status update to a shipment's tracking timeline
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: id
 *         required: true
 *         schema:
 *           type: string
 *         example: 507f1f77bcf86cd799439012
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - status
 *               - location
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
 *               location:
 *                 $ref: '#/components/schemas/Location'
 *               note:
 *                 type: string
 *                 example: Cargo loaded and departed
 *               internalNote:
 *                 type: string
 *                 example: GPS auto-logged
 *               carrier:
 *                 type: string
 *                 example: Ethiopian Airlines Cargo
 *               carrierReference:
 *                 type: string
 *                 example: ET-CARGO-88821
 *     responses:
 *       201:
 *         description: Tracking event logged
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Tracking event logged
 *                 data:
 *                   $ref: '#/components/schemas/TrackingEvent'
 *       400:
 *         description: Validation error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error400'
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error401'
 *       403:
 *         description: Forbidden - admin/employee role required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error403'
 *       404:
 *         description: Shipment not found
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error404'
 *       422:
 *         description: Invalid status transition
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error422'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error500'
 */
router.post("/shipments/:id/tracking", authorize("admin", "employee"), validate(validators.logEvent), ctrl.logEvent);

/**
 * @swagger
 * /stats:
 *   get:
 *     tags:
 *       - Tracking
 *     summary: Get dashboard statistics
 *     description: Retrieve shipment statistics with optional date range filtering (admin only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: from
 *         schema:
 *           type: string
 *           format: date-time
 *         description: Start date for statistics (ISO 8601 format)
 *       - in: query
 *         name: to
 *         schema:
 *           type: string
 *           format: date-time
 *         description: End date for statistics (ISO 8601 format)
 *     responses:
 *       200:
 *         description: Statistics retrieved
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: Stats retrieved
 *                 data:
 *                   type: object
 *                   properties:
 *                     total:
 *                       type: integer
 *                       example: 150
 *                     byStatus:
 *                       type: object
 *                       properties:
 *                         pending:
 *                           type: integer
 *                         picked_up:
 *                           type: integer
 *                         in_transit:
 *                           type: integer
 *                         customs:
 *                           type: integer
 *                         out_for_delivery:
 *                           type: integer
 *                         delivered:
 *                           type: integer
 *                         failed:
 *                           type: integer
 *                         returned:
 *                           type: integer
 *                       example:
 *                         delivered: 45
 *                         in_transit: 30
 *                         pending: 25
 *                     recentDeliveries:
 *                       type: integer
 *                       description: Shipments delivered in last 30 days
 *                       example: 15
 *       401:
 *         description: Unauthorized
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error401'
 *       403:
 *         description: Forbidden - admin role required
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error403'
 *       500:
 *         description: Internal server error
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error500'
 */
router.get("/stats", authorize("admin"), ctrl.getStats);

module.exports = router;

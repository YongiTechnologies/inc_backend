const express = require("express");
const router  = express.Router();
const ctrl    = require("../controllers/gps.controller");
const { authenticate, authorize } = require("../middleware/auth.middleware");

/**
 * @swagger
 * /gps/webhook/{provider}:
 *   post:
 *     tags:
 *       - GPS
 *     summary: GPS provider webhook
 *     description: Receive GPS pings from provider (Traccar, Google Fleet Engine, HERE, or raw device). Secured with webhook secret in x-webhook-secret header.
 *     security:
 *       - webhookSecret: []
 *     parameters:
 *       - in: path
 *         name: provider
 *         required: true
 *         schema:
 *           type: string
 *           enum: [traccar, google, here, raw]
 *         example: traccar
 *         description: GPS provider name
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             description: Provider-specific payload. Structure varies by provider.
 *             example:
 *               deviceId: "IMEI-123456789"
 *               position:
 *                 latitude: 5.5494
 *                 longitude: -0.1876
 *                 accuracy: 15.5
 *                 speed: 45.2
 *                 course: 180
 *                 altitude: 125
 *                 attributes:
 *                   batteryLevel: 85
 *     responses:
 *       200:
 *         description: Ping received (always 200 to prevent provider retries)
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
 *                   example: Ping received
 *                 data:
 *                   type: object
 *                   properties:
 *                     id:
 *                       type: string
 *                       description: Stored GPS ping ID
 *       401:
 *         description: Invalid webhook secret
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error401'
 */
router.post("/gps/webhook/:provider", ctrl.webhook);

/**
 * @swagger
 * /tracking/{trackingNumber}/live:
 *   get:
 *     tags:
 *       - GPS
 *     summary: Get live GPS trail
 *     description: Retrieve GPS trail and current position for a shipment (public endpoint, polled every 30s by map frontend)
 *     parameters:
 *       - in: path
 *         name: trackingNumber
 *         required: true
 *         schema:
 *           type: string
 *         example: GHA-2024-001234
 *     responses:
 *       200:
 *         description: GPS trail and current position retrieved
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
 *                   example: Live trail retrieved
 *                 data:
 *                   type: object
 *                   properties:
 *                     trail:
 *                       type: array
 *                       items:
 *                         $ref: '#/components/schemas/GpsPing'
 *                       description: Array of GPS pings in chronological order (oldest first)
 *                     current:
 *                       $ref: '#/components/schemas/GpsPing'
 *                       description: Most recent position
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
router.get("/tracking/:trackingNumber/live", ctrl.liveTrail);

/**
 * @swagger
 * /admin/devices:
 *   get:
 *     tags:
 *       - GPS
 *     summary: List all GPS devices
 *     description: Admin endpoint to view all GPS devices and their assignments (admin only)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Devices retrieved
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
 *                   example: Devices retrieved
 *                 data:
 *                   type: array
 *                   items:
 *                     $ref: '#/components/schemas/GpsDevice'
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
router.get("/admin/devices", authenticate, authorize("admin"), ctrl.listDevices);

/**
 * @swagger
 * /admin/devices/{deviceId}/assign:
 *   post:
 *     tags:
 *       - GPS
 *     summary: Assign GPS device to shipment
 *     description: Assign a GPS tracking device to a shipment for Real-time tracking (admin only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: deviceId
 *         required: true
 *         schema:
 *           type: string
 *         example: IMEI-123456789
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required:
 *               - shipmentId
 *             properties:
 *               shipmentId:
 *                 type: string
 *                 example: 507f1f77bcf86cd799439012
 *     responses:
 *       200:
 *         description: Device assigned
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
 *                   example: Device assigned
 *                 data:
 *                   $ref: '#/components/schemas/GpsDevice'
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
 *         description: Forbidden - admin role required
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
router.post("/admin/devices/:deviceId/assign", authenticate, authorize("admin"), ctrl.assignDevice);

/**
 * @swagger
 * /admin/devices/{deviceId}/unassign:
 *   post:
 *     tags:
 *       - GPS
 *     summary: Unassign GPS device from shipment
 *     description: Remove a GPS device from its current shipment assignment (admin only)
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: deviceId
 *         required: true
 *         schema:
 *           type: string
 *         example: IMEI-123456789
 *     responses:
 *       200:
 *         description: Device unassigned
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
 *                   example: Device unassigned
 *                 data:
 *                   $ref: '#/components/schemas/GpsDevice'
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
 *       404:
 *         description: Device not found
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
router.post("/admin/devices/:deviceId/unassign", authenticate, authorize("admin"), ctrl.unassignDevice);

module.exports = router;

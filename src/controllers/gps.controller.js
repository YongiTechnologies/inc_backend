const gpsService = require("../services/gps.service");
const { respond } = require("../utils/response");

/**
 * POST /api/gps/webhook/:provider
 *
 * Called by the GPS provider (Traccar, Google Fleet Engine, HERE, or raw device).
 * Protected by a shared secret in the Authorization header, NOT by JWT —
 * because GPS devices don't carry user sessions.
 */
async function webhook(req, res, next) {
  try {
    // Validate webhook secret
    const secret = req.headers["x-webhook-secret"] || req.query.secret;
    if (secret !== process.env.GPS_WEBHOOK_SECRET) {
      return respond(res, 401, false, "Invalid webhook secret");
    }

    const provider = req.params.provider; // traccar | google | here | raw
    const result   = await gpsService.handleWebhook(provider, req.body);

    // Always respond 200 fast — GPS providers retry on non-2xx
    return respond(res, 200, true, "Ping received", result ? { id: result._id } : null);
  } catch (err) {
    console.error("GPS webhook error:", err.message);
    // Still return 200 so the provider doesn't spam retries
    return respond(res, 200, true, "Ping received (with errors)");
  }
}

/**
 * GET /api/tracking/:trackingNumber/live
 *
 * Public endpoint — returns the GPS trail + current position for the map.
 * Designed to be polled every 30s by the frontend.
 */
async function liveTrail(req, res, next) {
  try {
    const Shipment = require("../models/Shipment");
    const shipment = await Shipment.findOne({
      trackingNumber: req.params.trackingNumber.toUpperCase(),
    }).select("_id status");

    if (!shipment) return respond(res, 404, false, "Tracking number not found");

    const [trail, current] = await Promise.all([
      gpsService.getLiveTrail(shipment._id, { limit: 300 }),
      gpsService.getCurrentPosition(shipment._id),
    ]);

    return respond(res, 200, true, "Live trail retrieved", {
      shipmentId: shipment._id,
      status:     shipment.status,
      hasGps:     !!current,
      current,         // { coordinates, speed, bearing, batteryPct, timestamp }
      trail,           // array of pings, oldest-first — draw as polyline
    });
  } catch (err) { next(err); }
}

/**
 * POST /api/admin/devices/:deviceId/assign
 * Assign a GPS device to a shipment.
 */
async function assignDevice(req, res, next) {
  try {
    const { shipmentId } = req.body;
    if (!shipmentId) return respond(res, 400, false, "shipmentId is required");

    const device = await gpsService.assignDevice(req.params.deviceId, shipmentId, req.user._id);
    return respond(res, 200, true, "Device assigned", device);
  } catch (err) { next(err); }
}

/**
 * POST /api/admin/devices/:deviceId/unassign
 */
async function unassignDevice(req, res, next) {
  try {
    await gpsService.unassignDevice(req.params.deviceId);
    return respond(res, 200, true, "Device unassigned");
  } catch (err) { next(err); }
}

/**
 * GET /api/admin/devices
 */
async function listDevices(req, res, next) {
  try {
    const devices = await gpsService.listDevices();
    return respond(res, 200, true, "Devices retrieved", devices);
  } catch (err) { next(err); }
}

module.exports = { webhook, liveTrail, assignDevice, unassignDevice, listDevices };

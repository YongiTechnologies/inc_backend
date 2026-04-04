const trackingService = require("../services/tracking.service");
const audit = require("../services/audit.service");
const { respond } = require("../utils/response");

// PUBLIC — no auth
async function publicTrack(req, res, next) {
  try {
    const data = await trackingService.getTrackingByNumber(req.params.trackingNumber.toUpperCase());
    if (!data) return respond(res, 404, false, "Tracking number not found. Please check and try again.");
    return respond(res, 200, true, "Tracking info retrieved", data);
  } catch (err) { next(err); }
}

// EMPLOYEE/ADMIN — full detail
async function internalTrack(req, res, next) {
  try {
    const data = await trackingService.getTrackingInternal(req.params.id);
    if (!data) return respond(res, 404, false, "Shipment not found");
    return respond(res, 200, true, "Tracking detail retrieved", data);
  } catch (err) { next(err); }
}

// EMPLOYEE/ADMIN — log a checkpoint
async function logEvent(req, res, next) {
  try {
    const event = await trackingService.addTrackingEvent({
      shipmentId:       req.params.id,
      updatedBy:        req.user._id,
      ...req.body,
    });

    await audit.log({
      performedBy: req.user._id,
      action:      "LOG_TRACKING_EVENT",
      targetModel: "Shipment",
      targetId:    req.params.id,
      details:     { status: req.body.status, location: req.body.location },
      ip:          req.ip,
    });

    return respond(res, 201, true, "Tracking event logged", event);
  } catch (err) {
    if (err.message.includes("Invalid transition") || err.message === "Shipment not found") {
      return respond(res, 422, false, err.message);
    }
    next(err);
  }
}

// EMPLOYEE/ADMIN — list shipments
async function listShipments(req, res, next) {
  try {
    const { page = 1, limit = 20, status, search } = req.query;
    const result = await trackingService.listShipments({
      page:   parseInt(page),
      limit:  Math.min(parseInt(limit), 100),
      status,
      search,
    });
    return respond(res, 200, true, "Shipments retrieved", result);
  } catch (err) { next(err); }
}

// CUSTOMER — own shipments
async function myShipments(req, res, next) {
  try {
    const { page = 1, limit = 20 } = req.query;
    const result = await trackingService.listShipments({
      page:       parseInt(page),
      limit:      Math.min(parseInt(limit), 50),
      customerId: req.user._id,
    });
    return respond(res, 200, true, "Your shipments", result);
  } catch (err) { next(err); }
}

// EMPLOYEE/ADMIN — create shipment
async function createShipment(req, res, next) {
  try {
    const shipment = await trackingService.createShipment(req.body, req.user._id);

    await audit.log({
      performedBy: req.user._id,
      action:      "CREATE_SHIPMENT",
      targetModel: "Shipment",
      targetId:    shipment._id,
      details:     { trackingNumber: shipment.trackingNumber },
      ip:          req.ip,
    });

    return respond(res, 201, true, "Shipment created", {
      id:             shipment._id,
      trackingNumber: shipment.trackingNumber,
    });
  } catch (err) { next(err); }
}

// ADMIN — dashboard stats
async function getStats(req, res, next) {
  try {
    const { from, to } = req.query;
    const stats = await trackingService.getStats({ from, to });
    return respond(res, 200, true, "Stats retrieved", stats);
  } catch (err) { next(err); }
}

module.exports = { publicTrack, internalTrack, logEvent, listShipments, myShipments, createShipment, getStats };

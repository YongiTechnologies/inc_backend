const trackingService = require("../services/tracking.service");
const batchService = require("../services/batch.service");
const audit = require("../services/audit.service");
const { respond } = require("../utils/response");

// PUBLIC — no auth
//
// A tracking number shared by several customers cannot be resolved from the
// number alone, so `phone` / `mark` narrow it to one of them. Without either,
// a shared number returns masked choices (ambiguous: true) rather than
// whichever record the database happened to return first.
async function publicTrack(req, res, next) {
  try {
    const { phone, mark } = req.query;
    const result = await trackingService.getTrackingByNumber(
      req.params.trackingNumber.toUpperCase(),
      { phone, mark },
    );

    if (result.total === 0) {
      return respond(res, 404, false, "Tracking number not found. Please check and try again.");
    }

    // 200, not 3xx — axios rejects anything outside 2xx by default, so a status
    // code here would surface a normal disambiguation prompt as a request error.
    if (result.ambiguous) {
      return respond(res, 200, true,
        `This tracking number covers ${result.total} shipments. Enter your phone number or shipping mark to see yours.`,
        { ambiguous: true, total: result.total, choices: result.choices, items: [] },
      );
    }

    if (!result.items.length) {
      return respond(res, 404, false,
        "That phone number or shipping mark does not match any shipment on this tracking number.");
    }

    // Single-customer numbers keep the original flat shape so existing callers
    // are unaffected; `items` carries the full set for shared numbers.
    return respond(res, 200, true, "Tracking info retrieved", {
      ...result.items[0],
      items: result.items,
      total: result.total,
      ambiguous: false,
    });
  } catch (err) { next(err); }
}

async function publicTrackByPhone(req, res, next) {
  try {
    const normalised = batchService.normalisePhone(req.params.phone);
    if (!normalised) return respond(res, 400, false, "Invalid phone number");

    const items = await batchService.lookupByPhone(normalised);

    if (!items.length) {
      return respond(res, 404, false, "No shipments found for this phone number");
    }

    // Every status gets a bucket — an item whose status has no key here would
    // silently vanish from the customer's phone lookup.
    const grouped = {
      in_warehouse: [], shipped: [], at_port: [], customs: [],
      ready_for_pickup: [], out_for_delivery: [], delivered: [], held: [],
    };
    items.forEach((item) => {
      if (grouped[item.status]) grouped[item.status].push(item);
      else (grouped[item.status] = []).push(item);
    });

    return respond(res, 200, true, "Shipments retrieved", { total: items.length, grouped });
  } catch (err) { next(err); }
}

async function publicTrackByWaybill(req, res, next) {
  try {
    const waybill = req.params.waybill.trim().toUpperCase();
    const { phone, mark } = req.query;
    const result = await batchService.lookupByWaybill(waybill, { phone, mark });

    if (result.total === 0) return respond(res, 404, false, "Waybill not found");

    if (result.ambiguous) {
      return respond(res, 200, true,
        `This waybill covers ${result.total} shipments. Enter your phone number or shipping mark to see yours.`,
        { ambiguous: true, total: result.total, choices: result.choices, items: [] },
      );
    }

    if (!result.items.length) {
      return respond(res, 404, false,
        "That phone number or shipping mark does not match any shipment on this waybill.");
    }

    // Flat shape preserved for the single-customer case that callers expect.
    return respond(res, 200, true, "Item retrieved", {
      ...result.items[0],
      items: result.items,
      total: result.total,
      ambiguous: false,
    });
  } catch (err) { next(err); }
}

/**
 * Public lookup by shipping mark. Customers whose sheets carried no phone are
 * identified only by their mark, so without this they have no way in.
 */
async function publicTrackByMark(req, res, next) {
  try {
    const items = await batchService.lookupByMark(req.params.mark);
    if (!items.length) return respond(res, 404, false, "No shipments found for this shipping mark");
    return respond(res, 200, true, "Shipments retrieved", { total: items.length, items });
  } catch (err) { next(err); }
}

// EMPLOYEE/ADMIN — full detail
async function internalTrack(req, res, next) {
  try {
    const data = await trackingService.getTrackingInternal(req.params.id);
    if (!data) return respond(res, 404, false, "Shipment item not found");
    return respond(res, 200, true, "Tracking detail retrieved", data);
  } catch (err) { next(err); }
}

// EMPLOYEE/ADMIN — update item status (replaces logEvent)
async function updateItemStatus(req, res, next) {
  try {
    const item = await trackingService.updateItemStatus({
      itemId:         req.params.id,
      updatedBy:      req.user._id,
      status:         req.body.status,
      location:       req.body.location,
      note:           req.body.note,
      internalNote:   req.body.internalNote,
      carrier:        req.body.carrier,
      carrierReference: req.body.carrierReference,
    });

    await audit.log({
      performedBy: req.user._id,
      action:      "UPDATE_ITEM_STATUS",
      targetModel: "ShipmentItem",
      targetId:    req.params.id,
      details:     { status: req.body.status, location: req.body.location },
      ip:          req.ip,
    });

    return respond(res, 200, true, "Item status updated", item);
  } catch (err) {
    if (err.message.includes("Invalid transition") || err.message === "ShipmentItem not found") {
      return respond(res, 422, false, err.message);
    }
    next(err);
  }
}

// EMPLOYEE/ADMIN — list items
async function listItems(req, res, next) {
  try {
    const { page = 1, limit = 20, status, search, needsPhone } = req.query;
    const result = await trackingService.listShipmentItems({
      page:   parseInt(page),
      limit:  Math.min(parseInt(limit), 100),
      status,
      search,
      needsPhone: needsPhone === undefined ? undefined : needsPhone === "true",
    });
    return respond(res, 200, true, "Shipment items retrieved", result);
  } catch (err) { next(err); }
}

// CUSTOMER — own items
async function myItems(req, res, next) {
  try {
    const { page = 1, limit = 20 } = req.query;
    const result = await trackingService.listShipmentItems({
      page:       parseInt(page),
      limit:      Math.min(parseInt(limit), 50),
      customerId: req.user._id,
      publicView: true,
    });
    return respond(res, 200, true, "Your shipment items", result);
  } catch (err) { next(err); }
}

// EMPLOYEE/ADMIN — create item manually
async function createItem(req, res, next) {
  try {
    const item = await trackingService.createShipmentItem(req.body, req.user._id);

    await audit.log({
      performedBy: req.user._id,
      action:      "CREATE_SHIPMENT_ITEM",
      targetModel: "ShipmentItem",
      targetId:    item._id,
      details:     { waybillNo: item.waybillNo },
      ip:          req.ip,
    });

    return respond(res, 201, true, "Shipment item created", {
      id:       item._id,
      waybillNo: item.waybillNo,
    });
  } catch (err) { next(err); }
}

// EMPLOYEE/ADMIN — update item details
async function updateItem(req, res, next) {
  try {
    const item = await trackingService.updateShipmentItem(req.params.id, req.body);
    if (!item) return respond(res, 404, false, "Shipment item not found");

    await audit.log({
      performedBy: req.user._id,
      action:      "UPDATE_SHIPMENT_ITEM",
      targetModel: "ShipmentItem",
      targetId:    req.params.id,
      details:     req.body,
      ip:          req.ip,
    });

    return respond(res, 200, true, "Shipment item updated", item);
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

module.exports = {
  publicTrack,
  publicTrackByPhone,
  publicTrackByWaybill,
  publicTrackByMark,
  internalTrack,
  updateItemStatus,
  listItems,
  myItems,
  createItem,
  updateItem,
  getStats
};

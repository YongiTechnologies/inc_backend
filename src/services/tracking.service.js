const Shipment = require("../models/Shipment");
const TrackingEvent = require("../models/TrackingEvent");
const User = require("../models/User");
const emailService = require("./email.service");
const { escapeRegex } = require("../utils/validators");

/**
 * Valid status transitions. Prevents nonsensical moves
 * e.g. delivered → pending is not allowed.
 */
const STATUS_TRANSITIONS = {
  pending:          ["picked_up", "failed"],
  picked_up:        ["in_transit", "failed"],
  in_transit:       ["in_transit", "customs", "out_for_delivery", "failed"],
  customs:          ["in_transit", "out_for_delivery", "failed", "returned"],
  out_for_delivery: ["delivered", "failed"],
  delivered:        [],           // terminal
  failed:           ["in_transit", "returned"],
  returned:         [],           // terminal
};

const STATUS_LABELS = {
  pending:          "Order Received",
  picked_up:        "Picked Up",
  in_transit:       "In Transit",
  customs:          "Customs Clearance",
  out_for_delivery: "Out for Delivery",
  delivered:        "Delivered",
  failed:           "Delivery Attempted",
  returned:         "Returned to Sender",
};

/**
 * Public tracker — no auth required.
 * Strips internal notes before returning.
 */
async function getTrackingByNumber(trackingNumber) {
  const shipment = await Shipment.findOne({ trackingNumber })
    .populate("customerId", "name")
    .lean();

  if (!shipment) return null;

  const events = await TrackingEvent.find({ shipmentId: shipment._id })
    .sort({ timestamp: -1 })
    .populate("updatedBy", "name")
    .select("-internalNote")
    .lean();

  return buildResponse(shipment, events);
}

/**
 * Internal tracker — full detail including internal notes.
 */
async function getTrackingInternal(shipmentId) {
  const shipment = await Shipment.findById(shipmentId)
    .populate("customerId", "name email phone")
    .populate("assignedTo", "name email")
    .lean();

  if (!shipment) return null;

  const events = await TrackingEvent.find({ shipmentId: shipment._id })
    .sort({ timestamp: -1 })
    .populate("updatedBy", "name role")
    .lean();

  return buildResponse(shipment, events, { includeInternal: true });
}

/**
 * Log a new tracking checkpoint.
 * Validates the transition, updates the parent shipment, and fires email.
 */
async function addTrackingEvent({ shipmentId, updatedBy, status, location, note, internalNote, carrier, carrierReference }) {
  const shipment = await Shipment.findById(shipmentId).populate("customerId", "name email");
  if (!shipment) throw new Error("Shipment not found");

  const allowed = STATUS_TRANSITIONS[shipment.status] || [];
  if (!allowed.includes(status)) {
    throw new Error(
      `Invalid transition: "${shipment.status}" → "${status}". Allowed: [${allowed.join(", ") || "none — terminal status"}]`
    );
  }

  const event = await TrackingEvent.create({
    shipmentId,
    updatedBy,
    status,
    location,
    note,
    internalNote,
    carrier,
    carrierReference,
    timestamp: new Date(),
  });

  // Update parent
  const update = { status };
  if (status === "delivered") update.deliveredAt = new Date();
  await Shipment.findByIdAndUpdate(shipmentId, update);

  // Fire email notification (non-blocking)
  if (shipment.customerId?.email) {
    emailService
      .sendTrackingUpdate({
        to:             shipment.customerId.email,
        name:           shipment.customerId.name,
        trackingNumber: shipment.trackingNumber,
        statusLabel:    STATUS_LABELS[status],
        location,
        note,
      })
      .catch((err) => console.error("Email notification failed:", err.message));
  }

  return event;
}

/**
 * Create a new shipment and auto-log the first "pending" event.
 */
async function createShipment(data, createdBy) {
  const shipment = await Shipment.create(data);

  await TrackingEvent.create({
    shipmentId: shipment._id,
    updatedBy:  createdBy,
    status:     "pending",
    location:   data.origin,
    note:       "Shipment registered. Awaiting pickup.",
    timestamp:  new Date(),
  });

  return shipment;
}

async function updateShipment(id, data) {
  const allowedFields = [
    "assignedTo",
    "origin",
    "destination",
    "description",
    "packageType",
    "weight",
    "dimensions",
    "quantity",
    "declaredValue",
    "estimatedDelivery",
    "requiresCustoms",
    "isFragile",
    "specialInstructions",
  ];

  const updateData = {};
  allowedFields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      updateData[field] = data[field];
    }
  });

  if (Object.keys(updateData).length === 0) return null;

  return Shipment.findByIdAndUpdate(id, updateData, {
    new: true,
    runValidators: true,
  }).populate("customerId", "name email phone").populate("assignedTo", "name email").lean();
}

/**
 * Paginated list with optional filters.
 */
async function listShipments({ page = 1, limit = 20, status, search, customerId } = {}) {
  const filter = {};
  if (status)     filter.status = status;
  if (customerId) filter.customerId = customerId;
  if (search) {
    const escaped = escapeRegex(search);
    filter.$or = [
      { trackingNumber: new RegExp(escaped, "i") },
      { description:    new RegExp(escaped, "i") },
      { "destination.city": new RegExp(escaped, "i") },
    ];
  }

  const [shipments, total] = await Promise.all([
    Shipment.find(filter)
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("customerId", "name email phone")
      .populate("assignedTo", "name")
      .lean(),
    Shipment.countDocuments(filter),
  ]);

  return { shipments, pagination: { total, page, limit, pages: Math.ceil(total / limit) } };
}

/**
 * Admin dashboard stats.
 */
async function getStats({ from, to } = {}) {
  const matchFilter = {};
  if (from || to) {
    matchFilter.createdAt = {};
    if (from) matchFilter.createdAt.$gte = new Date(from);
    if (to) matchFilter.createdAt.$lte = new Date(to);
  }

  const [total, byStatus, recentDeliveries] = await Promise.all([
    Shipment.countDocuments(matchFilter),
    Shipment.aggregate([
      { $match: matchFilter },
      { $group: { _id: "$status", count: { $sum: 1 } } }
    ]),
    Shipment.countDocuments({
      status: "delivered",
      deliveredAt: { $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000) },
      ...matchFilter,
    }),
  ]);

  const statusMap = {};
  byStatus.forEach(({ _id, count }) => { statusMap[_id] = count; });

  return { total, byStatus: statusMap, recentDeliveries };
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

function buildResponse(shipment, events, options = {}) {
  const latest = events[0] || null;

  // Calculate progress percentage based on status
  const progressMap = {
    pending: 0,
    picked_up: 15,
    in_transit: 40,
    customs: 55,
    out_for_delivery: 80,
    delivered: 100,
    failed: 40,
    returned: 0,
  };

  return {
    trackingNumber: shipment.trackingNumber,
    status: {
      code:      shipment.status,
      label:     STATUS_LABELS[shipment.status],
      updatedAt: latest?.timestamp || shipment.updatedAt,
    },
    route: {
      origin:          shipment.origin,
      destination:     shipment.destination,
      currentLocation: latest?.location || shipment.origin,
    },
    cargo: {
      description:     shipment.description,
      packageType:     shipment.packageType,
      weight:          shipment.weight,
      quantity:        shipment.quantity,
      isFragile:       shipment.isFragile,
      requiresCustoms: shipment.requiresCustoms,
    },
    dates: {
      created:           shipment.createdAt,
      estimatedDelivery: shipment.estimatedDelivery,
      delivered:         shipment.deliveredAt || null,
    },
    progressPercent: progressMap[shipment.status] || 0,
    timeline: events.map((e) => ({
      id:       e._id,
      status:   e.status,
      label:    STATUS_LABELS[e.status],
      location: e.location,
      note:     e.note,
      ...(options.includeInternal && { internalNote: e.internalNote }),
      carrier:          e.carrier,
      carrierReference: e.carrierReference,
      updatedBy:        e.updatedBy ? { name: e.updatedBy.name } : null,
      timestamp:        e.timestamp,
    })),
    ...(options.includeInternal && {
      customer:            shipment.customerId,
      assignedTo:          shipment.assignedTo,
      specialInstructions: shipment.specialInstructions,
    }),
  };
}

module.exports = {
  getTrackingByNumber,
  getTrackingInternal,
  addTrackingEvent,
  createShipment,
  updateShipment,
  listShipments,
  getStats,
  STATUS_TRANSITIONS,
  STATUS_LABELS,
};

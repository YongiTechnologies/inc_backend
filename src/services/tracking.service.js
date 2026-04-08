const ShipmentItem = require("../models/ShipmentItem");
const User = require("../models/User");
const emailService = require("./email.service");
const { escapeRegex } = require("../utils/validators");

/**
 * Valid status transitions. Prevents nonsensical moves
 * e.g. delivered → pending is not allowed.
 * Supports both traditional workflow and batch workflow statuses.
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
  // Batch workflow statuses
  in_warehouse:     ["shipped", "held", "pending"],
  shipped:          ["pending", "in_transit", "held"],
  held:             ["in_warehouse", "shipped", "pending"],
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
  in_warehouse:     "In Warehouse",
  shipped:          "Shipped",
  held:             "On Hold",
};

/**
 * Public tracker — no auth required.
 * Returns ShipmentItem by waybill number.
 * Strips internal notes before returning.
 */
async function getTrackingByNumber(waybillNo) {
  const item = await ShipmentItem.findOne({ waybillNo: waybillNo.toUpperCase() })
    .populate("customerId", "name")
    .lean();

  if (!item) return null;

  return buildItemResponse(item, { includeInternal: false });
}

/**
 * Internal tracker — full detail including internal notes.
 */
async function getTrackingInternal(itemId) {
  const item = await ShipmentItem.findById(itemId)
    .populate("customerId", "name email phone")
    .populate("assignedTo", "name email")
    .lean();

  if (!item) return null;

  return buildItemResponse(item, { includeInternal: true });
}

/**
 * Update status on a ShipmentItem (replaces addTrackingEvent).
 * Appends to stageHistory and updates the item status.
 */
async function updateItemStatus({ itemId, updatedBy, status, location, note, internalNote, carrier, carrierReference }) {
  const item = await ShipmentItem.findById(itemId).populate("customerId", "name email");
  if (!item) throw new Error("ShipmentItem not found");

  const allowed = STATUS_TRANSITIONS[item.status] || [];
  if (!allowed.includes(status)) {
    throw new Error(
      `Invalid transition: "${item.status}" → "${status}". Allowed: [${allowed.join(", ") || "none — terminal status"}]`
    );
  }

  // Build stage history entry
  const stageEntry = {
    stage: mapStatusToStage(status),
    status,
    updatedAt: new Date(),
    note: note || null,
    location: location || null,
    internalNote: internalNote || null,
    carrier: carrier || null,
    carrierReference: carrierReference || null,
    updatedBy,
  };

  // Update item
  const updateData = {
    status,
    $push: { stageHistory: stageEntry },
  };

  if (status === "delivered") {
    updateData.deliveredAt = new Date();
  }

  const updatedItem = await ShipmentItem.findByIdAndUpdate(itemId, updateData, { new: true });

  // Fire email notification (non-blocking)
  if (item.customerId?.email) {
    emailService
      .sendTrackingUpdate({
        to:             item.customerId.email,
        name:           item.customerId.name,
        trackingNumber: item.waybillNo,
        statusLabel:    STATUS_LABELS[status],
        location:      location,
        note,
      })
      .catch((err) => console.error("Email notification failed:", err.message));
  }

  return updatedItem;
}

/**
 * Create a new shipment item manually (staff entry).
 */
async function createShipmentItem(data, createdBy) {
  const item = await ShipmentItem.create({
    ...data,
    migratedFrom: "manual",
    stageHistory: [{
      stage:     mapStatusToStage(data.status || "pending"),
      status:    data.status || "pending",
      updatedAt: new Date(),
      note:      "Shipment item registered manually by staff",
      updatedBy: createdBy,
    }],
  });

  return item;
}

async function updateShipmentItem(id, data) {
  const allowedFields = [
    "assignedTo",
    "origin",
    "destination",
    "destinationCity",
    "description",
    "productDescription",
    "packageType",
    "weight",
    "dimensions",
    "quantity",
    "declaredValue",
    "estimatedDelivery",
    "requiresCustoms",
    "isFragile",
    "specialInstructions",
    "deliveryPhoto",
    "deliverySignature",
  ];

  const updateData = {};
  allowedFields.forEach((field) => {
    if (Object.prototype.hasOwnProperty.call(data, field)) {
      updateData[field] = data[field];
    }
  });

  if (Object.keys(updateData).length === 0) return null;

  return ShipmentItem.findByIdAndUpdate(id, updateData, {
    new: true,
    runValidators: true,
  }).populate("customerId", "name email phone").populate("assignedTo", "name email").lean();
}

/**
 * Paginated list with optional filters.
 */
async function listShipmentItems({ page = 1, limit = 20, status, search, customerId } = {}) {
  const filter = {};
  if (status)     filter.status = status;
  if (customerId) filter.customerId = customerId;
  if (search) {
    const escaped = escapeRegex(search);
    filter.$or = [
      { waybillNo:           new RegExp(escaped, "i") },
      { invoiceNo:           new RegExp(escaped, "i") },
      { productDescription:  new RegExp(escaped, "i") },
      { destinationCity:     new RegExp(escaped, "i") },
      { customerName:        new RegExp(escaped, "i") },
    ];
  }

  const [items, total] = await Promise.all([
    ShipmentItem.find(filter)
      .sort({ updatedAt: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate("customerId", "name email phone")
      .populate("assignedTo", "name")
      .lean(),
    ShipmentItem.countDocuments(filter),
  ]);

  return { items, pagination: { total, page, limit, pages: Math.ceil(total / limit) } };
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
    ShipmentItem.countDocuments(matchFilter),
    ShipmentItem.aggregate([
      { $match: matchFilter },
      { $group: { _id: "$status", count: { $sum: 1 } } }
    ]),
    ShipmentItem.countDocuments({
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

function mapStatusToStage(status) {
  const stageMap = {
    pending: 'pending',
    picked_up: 'in_transit',
    in_transit: 'in_transit',
    customs: 'customs',
    out_for_delivery: 'out_for_delivery',
    delivered: 'delivered',
    failed: 'failed',
    returned: 'returned',
    in_warehouse: 'in_warehouse',
    shipped: 'shipped',
    held: 'held',
  };
  return stageMap[status] || status;
}

function buildItemResponse(item, options = {}) {
  const latestStage = item.stageHistory?.[item.stageHistory.length - 1] || null;

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
    in_warehouse: 10,
    shipped: 30,
    held: 20,
  };

  // Build timeline from stageHistory
  const timeline = (item.stageHistory || []).map((stage, idx) => ({
    id:       `${item._id}-stage-${idx}`,
    status:   stage.status,
    label:    STATUS_LABELS[stage.status] || stage.status,
    location: stage.location,
    note:     stage.note,
    ...(options.includeInternal && { internalNote: stage.internalNote }),
    carrier:          stage.carrier,
    carrierReference: stage.carrierReference,
    updatedBy:        stage.updatedBy ? { name: stage.updatedBy.name || "Unknown" } : null,
    timestamp:        stage.updatedAt,
  }));

  const response = {
    waybillNo:        item.waybillNo,
    invoiceNo:        item.invoiceNo,
    status: {
      code:      item.status,
      label:     STATUS_LABELS[item.status],
      updatedAt: latestStage?.updatedAt || item.updatedAt,
    },
    route: {
      origin:          item.origin,
      destination:     item.destination,
      destinationCity: item.destinationCity,
      currentLocation: latestStage?.location || item.origin,
    },
    cargo: {
      description:       item.description || item.productDescription,
      productDescription: item.productDescription,
      packageType:       item.packageType,
      weight:            item.weight,
      quantity:          item.quantity,
      isFragile:         item.isFragile,
      requiresCustoms:   item.requiresCustoms,
    },
    dates: {
      created:           item.createdAt,
      intakeDate:        item.intakeDate,
      receivingDate:     item.receivingDate,
      estimatedDelivery: item.estimatedDelivery,
      delivered:         item.deliveredAt || null,
    },
    progressPercent: progressMap[item.status] || 0,
    timeline,
    batch: {
      intakeBatch:  item.intakeBatch,
      shippedBatch: item.shippedBatch,
    },
  };

  if (options.includeInternal) {
    response.customer = item.customerId;
    response.assignedTo = item.assignedTo;
    response.specialInstructions = item.specialInstructions;
    response.staffNotes = item.staffNotes;
    response.heldReason = item.heldReason;
    response.reassignedTo = item.reassignedTo;
  }

  return response;
}

module.exports = {
  getTrackingByNumber,
  getTrackingInternal,
  updateItemStatus,
  createShipmentItem,
  updateShipmentItem,
  listShipmentItems,
  getStats,
  STATUS_TRANSITIONS,
  STATUS_LABELS,
};

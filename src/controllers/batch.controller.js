const path     = require("path");
const Batch    = require("../models/Batch");
const ShipmentItem = require("../models/ShipmentItem");
const audit    = require("../services/audit.service");
const {
  parseIntakeSheet,
  parseShippedSheet,
  parseArrivedSheet,
  processIntakeBatch,
  processShippedBatch,
  processArrivedBatch,
  normalisePhone,
} = require("../services/batch.service");
const { respond } = require("../utils/response");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function validateFile(req, res) {
  if (!req.file) {
    respond(res, 400, false, "No file uploaded. Use field name 'file'.");
    return false;
  }
  const ext = path.extname(req.file.originalname).toLowerCase();
  if (![".xlsx", ".xls"].includes(ext)) {
    respond(res, 400, false, "Invalid file type. Only .xlsx and .xls are accepted.");
    return false;
  }
  return true;
}

/** Strip internal fields before returning public item data */
function publicItem(item) {
  const obj = item.toObject ? item.toObject() : { ...item };
  delete obj.staffNotes;
  delete obj.fees;
  delete obj.customerId;
  delete obj.stageHistory;
  delete obj.heldReason;
  delete obj.reassignedTo;
  return obj;
}

// ─── Upload handlers ───────────────────────────────────────────────────────────

async function uploadIntake(req, res, next) {
  if (!validateFile(req, res)) return;
  let batch;
  try {
    const parsed = parseIntakeSheet(req.file.buffer);
    const result = await processIntakeBatch(parsed, req.user._id);
    batch = result.batch;

    await audit.log({
      performedBy: req.user._id,
      action:      "BATCH_INTAKE_UPLOAD",
      targetModel: "Batch",
      targetId:    batch._id,
      details:     { batchCode: batch.batchCode, totalItems: batch.totalItems },
      ip:          req.ip,
    });

    return respond(res, 201, true, "Intake batch processed successfully", result);
  } catch (err) {
    // Rollback batch if created
    if (batch?._id) await Batch.findByIdAndDelete(batch._id).catch(() => {});
    next(err);
  }
}

async function uploadShipped(req, res, next) {
  if (!validateFile(req, res)) return;
  let batch;
  try {
    const parsed = parseShippedSheet(req.file.buffer);
    const result = await processShippedBatch(parsed, req.user._id);
    batch = result.batch;

    await audit.log({
      performedBy: req.user._id,
      action:      "BATCH_SHIPPED_UPLOAD",
      targetModel: "Batch",
      targetId:    batch._id,
      details:     { batchCode: batch.batchCode, totalItems: batch.totalItems, heldItems: batch.heldItems },
      ip:          req.ip,
    });

    return respond(res, 201, true, "Shipped batch processed successfully", result);
  } catch (err) {
    if (batch?._id) await Batch.findByIdAndDelete(batch._id).catch(() => {});
    next(err);
  }
}

async function uploadArrived(req, res, next) {
  if (!validateFile(req, res)) return;
  let batch;
  try {
    const parsed = parseArrivedSheet(req.file.buffer);
    const result = await processArrivedBatch(parsed, req.user._id);
    batch = result.batch;

    await audit.log({
      performedBy: req.user._id,
      action:      "BATCH_ARRIVED_UPLOAD",
      targetModel: "Batch",
      targetId:    batch._id,
      details:     { batchCode: batch.batchCode, totalItems: batch.totalItems, heldItems: batch.heldItems },
      ip:          req.ip,
    });

    return respond(res, 201, true, "Arrived batch processed successfully", result);
  } catch (err) {
    if (batch?._id) await Batch.findByIdAndDelete(batch._id).catch(() => {});
    next(err);
  }
}

// ─── Batch queries ─────────────────────────────────────────────────────────────

async function listBatches(req, res, next) {
  try {
    const { page = 1, limit = 20, stage } = req.query;
    const filter = {};
    if (stage) filter.stage = stage;

    const [batches, total] = await Promise.all([
      Batch.find(filter)
        .sort({ createdAt: -1 })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit))
        .populate("uploadedBy", "name email"),
      Batch.countDocuments(filter),
    ]);

    return respond(res, 200, true, "Batches retrieved", {
      batches,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (err) { next(err); }
}

async function getBatch(req, res, next) {
  try {
    const batch = await Batch.findById(req.params.id).populate("uploadedBy", "name email");
    if (!batch) return respond(res, 404, false, "Batch not found");

    // Get item counts by status for this batch
    const batchId = batch._id;
    const stageField = `${batch.stage}Batch`;
    const statusCounts = await ShipmentItem.aggregate([
      { $match: { [stageField]: batchId } },
      { $group: { _id: "$status", count: { $sum: 1 } } },
    ]);
    const byStatus = {};
    statusCounts.forEach(({ _id, count }) => { byStatus[_id] = count; });

    return respond(res, 200, true, "Batch retrieved", { batch, byStatus });
  } catch (err) { next(err); }
}

async function getBatchItems(req, res, next) {
  try {
    const { page = 1, limit = 50, status } = req.query;
    const batch = await Batch.findById(req.params.id);
    if (!batch) return respond(res, 404, false, "Batch not found");

    const stageField = `${batch.stage}Batch`;
    const filter = { [stageField]: batch._id };
    if (status) filter.status = status;

    const [items, total] = await Promise.all([
      ShipmentItem.find(filter)
        .sort({ createdAt: -1 })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit))
        .populate("customerId", "name email phone"),
      ShipmentItem.countDocuments(filter),
    ]);

    return respond(res, 200, true, "Batch items retrieved", {
      items,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (err) { next(err); }
}

// ─── Held items ────────────────────────────────────────────────────────────────

async function getHeldItems(req, res, next) {
  try {
    const { page = 1, limit = 50, phone, waybill } = req.query;
    const filter = { status: "held" };

    if (phone) {
      const normalised = normalisePhone(phone);
      if (normalised) filter.customerPhone = normalised;
    }
    if (waybill) {
      filter.waybillNo = { $regex: waybill.trim().toUpperCase(), $options: "i" };
    }

    const [items, total] = await Promise.all([
      ShipmentItem.find(filter)
        .sort({ updatedAt: -1 })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit))
        .populate("intakeBatch", "batchCode stage createdAt")
        .populate("shippedBatch", "batchCode stage createdAt"),
      ShipmentItem.countDocuments(filter),
    ]);

    return respond(res, 200, true, "Held items retrieved", {
      items,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (err) { next(err); }
}

async function reassignHeldItem(req, res, next) {
  try {
    const { itemId } = req.params;
    const { targetBatchId, note } = req.body;

    if (!targetBatchId) return respond(res, 400, false, "targetBatchId is required");

    const [item, targetBatch] = await Promise.all([
      ShipmentItem.findById(itemId),
      Batch.findById(targetBatchId),
    ]);

    if (!item)        return respond(res, 404, false, "Item not found");
    if (!targetBatch) return respond(res, 404, false, "Target batch not found");
    if (item.status !== "held") return respond(res, 400, false, "Item is not in held status");

    // Map batch stage to appropriate status
    const stageStatusMap = { intake: "in_warehouse", shipped: "shipped", arrived: "arrived" };
    const newStatus      = stageStatusMap[targetBatch.stage] || "in_warehouse";
    const batchField     = `${targetBatch.stage}Batch`;

    item.status       = newStatus;
    item.reassignedTo = targetBatch._id;
    item.heldReason   = null;
    item[batchField]  = targetBatch._id;
    item.stageHistory.push({
      stage:     targetBatch.stage,
      status:    newStatus,
      batchId:   targetBatch._id,
      updatedAt: new Date(),
      note:      note || `Manually reassigned to batch ${targetBatch.batchCode} by staff`,
    });

    await item.save();

    await audit.log({
      performedBy: req.user._id,
      action:      "BATCH_ITEM_REASSIGN",
      targetModel: "ShipmentItem",
      targetId:    item._id,
      details:     { targetBatchId, newStatus, batchCode: targetBatch.batchCode },
      ip:          req.ip,
    });

    return respond(res, 200, true, "Item reassigned successfully", item);
  } catch (err) { next(err); }
}

// ─── Item update ───────────────────────────────────────────────────────────────

async function updateItem(req, res, next) {
  try {
    const item = await ShipmentItem.findById(req.params.itemId);
    if (!item) return respond(res, 404, false, "Item not found");

    const allowed = ["customerName", "destinationCity", "productDescription", "staffNotes", "customerPhone"];
    const updates = {};

    for (const field of allowed) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }

    // Re-run phone normalisation if phone is being updated
    if (updates.customerPhone) {
      const User = require("../models/User");
      const normalised = normalisePhone(updates.customerPhone);
      updates.customerPhone    = normalised;
      updates.customerPhoneRaw = req.body.customerPhone;
      if (normalised) {
        const last9 = normalised.slice(-9);
        const user  = await User.findOne({ phone: { $regex: last9 + "$" } }).select("_id");
        if (user) updates.customerId = user._id;
      }
    }

    Object.assign(item, updates);
    await item.save();

    await audit.log({
      performedBy: req.user._id,
      action:      "BATCH_ITEM_UPDATE",
      targetModel: "ShipmentItem",
      targetId:    item._id,
      details:     updates,
      ip:          req.ip,
    });

    return respond(res, 200, true, "Item updated", item);
  } catch (err) { next(err); }
}

// ─── Public tracking ───────────────────────────────────────────────────────────

async function lookupByPhone(req, res, next) {
  try {
    const normalised = normalisePhone(req.params.phone);
    if (!normalised) return respond(res, 400, false, "Invalid phone number");

    const items = await ShipmentItem.find({ customerPhone: normalised })
      .sort({ updatedAt: -1 })
      .select("-staffNotes -fees -customerId -stageHistory -heldReason -reassignedTo");

    if (!items.length) return respond(res, 404, false, "No shipments found for this phone number");

    // Group by status
    const grouped = { in_warehouse: [], shipped: [], arrived: [], held: [] };
    items.forEach((item) => {
      const group = grouped[item.status] || [];
      group.push(item);
      grouped[item.status] = group;
    });

    return respond(res, 200, true, "Shipments retrieved", { total: items.length, grouped });
  } catch (err) { next(err); }
}

async function lookupByWaybill(req, res, next) {
  try {
    const waybill = req.params.waybill.trim().toUpperCase();
    const item    = await ShipmentItem.findOne({ waybillNo: waybill })
      .select("-staffNotes -fees -customerId -stageHistory -heldReason -reassignedTo");

    if (!item) return respond(res, 404, false, "Waybill not found");

    return respond(res, 200, true, "Item retrieved", item);
  } catch (err) { next(err); }
}

// ─── Unified shipments list (Shipment + ShipmentItem) ─────────────────────────

/**
 * GET /api/shipments/all
 * Returns both Shipment documents and ShipmentItem documents in a unified format.
 * For employee/admin dashboard use.
 */
async function getAllShipments(req, res, next) {
  try {
    const { page = 1, limit = 50, status, search } = req.query;
    const pageNum = parseInt(page);
    const limitNum = Math.min(parseInt(limit), 100);

    // Fetch ShipmentItem records (from batch system)
    const itemFilter = {};
    if (status) itemFilter.status = status;
    if (search) {
      itemFilter.$or = [
        { waybillNo: { $regex: search, $options: "i" } },
        { invoiceNo: { $regex: search, $options: "i" } },
        { customerPhone: { $regex: search, $options: "i" } },
      ];
    }

    const [shipmentItems, itemTotal] = await Promise.all([
      ShipmentItem.find(itemFilter)
        .sort({ createdAt: -1 })
        .skip((pageNum - 1) * limitNum)
        .limit(limitNum)
        .populate("customerId", "name email phone"),
      ShipmentItem.countDocuments(itemFilter),
    ]);

    // Transform ShipmentItem to match Shipment response format
    const unifiedItems = shipmentItems.map((item) => ({
      _id: item._id,
      trackingNumber: item.waybillNo,
      description: item.productDescription || "Batch shipment item",
      origin: { address: "China", city: "", country: "China" },
      destination: {
        address: "",
        city: item.destinationCity || "",
        country: "Ghana",
      },
      status: item.status,
      customerId: item.customerId,
      customerName: item.customerName,
      customerPhone: item.customerPhoneRaw || item.customerPhone,
      estimatedDelivery: item.arrivedBatch ? new Date() : null,
      createdAt: item.createdAt,
      updatedAt: item.updatedAt,
      source: "batch", // indicate this is from batch system
    }));

    return respond(res, 200, true, "All shipments retrieved", {
      items: unifiedItems,
      pagination: {
        total: itemTotal,
        page: pageNum,
        limit: limitNum,
        pages: Math.ceil(itemTotal / limitNum),
      },
    });
  } catch (err) {
    next(err);
  }
}

module.exports = {
  uploadIntake,
  uploadShipped,
  uploadArrived,
  listBatches,
  getBatch,
  getBatchItems,
  getHeldItems,
  reassignHeldItem,
  updateItem,
  lookupByPhone,
  lookupByWaybill,
};

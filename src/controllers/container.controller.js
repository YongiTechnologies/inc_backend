const ContainerLoading = require("../models/ContainerLoading");
const ShipmentItem     = require("../models/ShipmentItem");
const audit            = require("../services/audit.service");
const { respond }      = require("../utils/response");

// Fields never returned to public callers
const PUBLIC_SELECT = "-staffNotes";

// ─── Public ───────────────────────────────────────────────────────────────────

/**
 * GET /api/container-loadings
 * List all containers, newest first. No auth required.
 */
async function listContainerLoadings(req, res, next) {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const filter = {};
    if (status) filter.status = status;

    const [containers, total] = await Promise.all([
      ContainerLoading.find(filter)
        .select(PUBLIC_SELECT)
        .sort({ createdAt: -1 })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(Math.min(parseInt(limit), 50)),
      ContainerLoading.countDocuments(filter),
    ]);

    return respond(res, 200, true, "Container loadings retrieved", {
      containers,
      pagination: {
        total,
        page:  parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) { next(err); }
}

/**
 * GET /api/container-loadings/search?q=<container_number_or_waybill>
 * Public search — matches container number prefix OR waybill inside container.
 */
async function searchContainerLoadings(req, res, next) {
  try {
    const q = (req.query.q || "").trim().toUpperCase();
    if (!q || q.length < 2) {
      return respond(res, 400, false, "Query must be at least 2 characters");
    }

    const esc = q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    // 1. Try to match containers by container number or BL directly
    const containers = await ContainerLoading.find({
      $or: [
        { containerNumber: { $regex: esc, $options: "i" } },
        { blNumber:        { $regex: esc, $options: "i" } },
        { vesselName:      { $regex: esc, $options: "i" } },
      ],
    })
      .select(PUBLIC_SELECT)
      .sort({ createdAt: -1 })
      .limit(10);

    // 2. If query looks like a waybill (not matching a container directly),
    //    find the ShipmentItem and resolve its container
    let waybillMatch = null;
    if (containers.length === 0 || !q.match(/^[A-Z]{4}\d/)) {
      const item = await ShipmentItem.findOne({ waybillNo: q })
        .select("waybillNo containerRef status customerName destinationCity -_id")
        .lean();

      if (item?.containerRef) {
        const container = await ContainerLoading.findOne({
          containerNumber: item.containerRef.toUpperCase(),
        })
          .select(PUBLIC_SELECT)
          .lean();

        if (container) {
          waybillMatch = { item, container };
        }
      }
    }

    return respond(res, 200, true, "Search results", {
      containers,
      waybillMatch,
    });
  } catch (err) { next(err); }
}

/**
 * GET /api/container-loadings/:id
 * Single container detail + its items (containerRef stripped). No auth required.
 */
async function getContainerLoading(req, res, next) {
  try {
    const container = await ContainerLoading.findById(req.params.id)
      .select(PUBLIC_SELECT)
      .lean();

    if (!container) return respond(res, 404, false, "Container not found");

    // Fetch items that belong to this container (public-safe fields only)
    const items = await ShipmentItem.find({ containerRef: container.containerNumber })
      .select("waybillNo customerName destinationCity productDescription quantity status updatedAt -_id")
      .sort({ updatedAt: -1 })
      .lean();

    return respond(res, 200, true, "Container retrieved", { container, items });
  } catch (err) { next(err); }
}

// ─── Staff ────────────────────────────────────────────────────────────────────

/**
 * POST /api/container-loadings
 * Create a container loading manually (staff only).
 */
async function createContainerLoading(req, res, next) {
  try {
    const {
      containerNumber, vesselName, blNumber, sealNumber, volume,
      portOfLoading, portOfDischarge,
      loadingDate, etd, eta,
      status, notes, staffNotes,
    } = req.body;

    if (!containerNumber) {
      return respond(res, 400, false, "containerNumber is required");
    }

    const existing = await ContainerLoading.findOne({
      containerNumber: containerNumber.toUpperCase().trim(),
    });
    if (existing) {
      return respond(res, 409, false, `Container ${containerNumber} already exists`, { id: existing._id });
    }

    const container = await ContainerLoading.create({
      containerNumber,
      vesselName, blNumber, sealNumber, volume,
      portOfLoading, portOfDischarge,
      loadingDate, etd, eta,
      status: status || "loading",
      notes, staffNotes,
      createdBy: req.user._id,
      updatedBy: req.user._id,
    });

    await audit.log({
      performedBy: req.user._id,
      action:      "CONTAINER_CREATED",
      targetModel: "ContainerLoading",
      targetId:    container._id,
      details:     { containerNumber: container.containerNumber },
      ip:          req.ip,
    });

    return respond(res, 201, true, "Container loading created", container);
  } catch (err) { next(err); }
}

/**
 * PATCH /api/container-loadings/:id
 * Update container loading (staff only).
 */
async function updateContainerLoading(req, res, next) {
  try {
    const container = await ContainerLoading.findById(req.params.id);
    if (!container) return respond(res, 404, false, "Container not found");

    const ALLOWED = [
      "vesselName", "blNumber", "sealNumber", "volume",
      "portOfLoading", "portOfDischarge",
      "loadingDate", "etd", "eta", "actualArrivalDate",
      "status", "notes", "staffNotes",
    ];

    const updates = {};
    for (const field of ALLOWED) {
      if (req.body[field] !== undefined) updates[field] = req.body[field];
    }

    if (Object.keys(updates).length === 0) {
      return respond(res, 400, false, "No valid fields provided");
    }

    updates.updatedBy = req.user._id;
    Object.assign(container, updates);
    await container.save();

    await audit.log({
      performedBy: req.user._id,
      action:      "CONTAINER_UPDATED",
      targetModel: "ContainerLoading",
      targetId:    container._id,
      details:     updates,
      ip:          req.ip,
    });

    return respond(res, 200, true, "Container loading updated", container);
  } catch (err) { next(err); }
}

/**
 * GET /api/container-loadings/staff
 * Staff-only full list including staffNotes, batchRef populated.
 */
async function listContainerLoadingsStaff(req, res, next) {
  try {
    const { page = 1, limit = 20, status } = req.query;
    const filter = {};
    if (status) filter.status = status;

    const [containers, total] = await Promise.all([
      ContainerLoading.find(filter)
        .populate("batchRef", "batchCode stage createdAt")
        .populate("createdBy", "name email")
        .sort({ createdAt: -1 })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(Math.min(parseInt(limit), 50)),
      ContainerLoading.countDocuments(filter),
    ]);

    return respond(res, 200, true, "Container loadings retrieved (staff)", {
      containers,
      pagination: {
        total,
        page:  parseInt(page),
        limit: parseInt(limit),
        pages: Math.ceil(total / parseInt(limit)),
      },
    });
  } catch (err) { next(err); }
}

module.exports = {
  listContainerLoadings,
  searchContainerLoadings,
  getContainerLoading,
  createContainerLoading,
  updateContainerLoading,
  listContainerLoadingsStaff,
};

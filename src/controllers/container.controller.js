const ContainerLoading = require("../models/ContainerLoading");
const ShipmentItem     = require("../models/ShipmentItem");
const audit            = require("../services/audit.service");
const {
  CONTAINER_TO_ITEM_STATUS,
  containerRefMatcher,
  containerItemFilter,
  applyBulkStatus,
  describeBulkResult,
} = require("../services/logistics.service");
const { narrowToCustomer } = require("../services/batch.service");
const { respond }      = require("../utils/response");

// Fields never returned to public callers
const PUBLIC_SELECT = "-staffNotes";

// The contact fields are read to match a caller against a shared waybill, never
// to be echoed back — a bare tracking number must not reveal anyone's number.
function stripIdentifiers(item) {
  const { customerPhone, shippingMark, ...rest } = item;
  return rest;
}

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
 * GET /api/container-loadings/search?q=<container_number_or_waybill>&phone=&mark=
 * Public search — matches container number prefix OR waybill inside container.
 *
 * A waybill shared by several customers resolves to no single shipment, so
 * `phone` / `mark` narrow it to one of them exactly as the tracker does.
 * Without an identifier a shared waybill returns the container only, and
 * `item: null` — the customer-specific fields (name, goods, CBM, quantity)
 * belong to whoever asks, and handing back an arbitrary row put one customer's
 * details against another customer's shipment.
 */
async function searchContainerLoadings(req, res, next) {
  try {
    const q = (req.query.q || "").trim().toUpperCase();
    if (!q || q.length < 2) {
      return respond(res, 400, false, "Query must be at least 2 characters");
    }
    const { phone, mark } = req.query;

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
    //    find the ShipmentItem(s) on it and resolve their container
    let waybillMatch = null;
    if (containers.length === 0 || !q.match(/^[A-Z]{4}\d/)) {
      const rows = await ShipmentItem.find({ waybillNo: q })
        .select(
          "waybillNo containerRef status customerName destinationCity cbm " +
          "productDescription quantity customerPhone shippingMark -_id"
        )
        .sort({ updatedAt: -1 })
        .lean();

      if (rows.length) {
        // null = caller named nobody; [] = the identifier matched nobody here.
        const narrowed = narrowToCustomer(rows, { phone, mark });
        const mine     = narrowed || (rows.length === 1 ? rows : []);
        // Only one shipment can fill a card. Several parcels for the same
        // customer on one number is not a failure, but it is not a single
        // match either — the tracker lists them all.
        const item     = mine.length === 1 ? stripIdentifiers(mine[0]) : null;

        // The container is common to everyone on the waybill, so it is safe to
        // resolve even unidentified — but only when the records agree on it.
        const refs = [...new Set(
          (mine.length ? mine : rows).map((r) => r.containerRef).filter(Boolean)
            .map((r) => String(r).toUpperCase())
        )];

        const container = refs.length === 1
          ? await ContainerLoading.findOne({ containerNumber: refs[0] })
              .select(PUBLIC_SELECT)
              .lean()
          : null;

        if (container) {
          // Distinct customers, not rows — one customer with two parcels on a
          // number is not a shared number, and must not be described as one.
          const sharedBy = new Set(
            rows.map((r) => r.customerPhone || r.shippingMark || r.customerName || "?")
          ).size;

          waybillMatch = { item, container, sharedBy, ambiguous: item === null };
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

    // Items belonging to this container, from either direction — see
    // containerItemFilter (public-safe fields only).
    const filter = containerItemFilter(container);
    const items  = filter
      ? await ShipmentItem.find(filter)
          .select("waybillNo customerName destinationCity productDescription quantity status updatedAt -_id")
          .sort({ updatedAt: -1 })
          .lean()
      : [];

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

    const previousStatus = container.status;
    updates.updatedBy = req.user._id;
    Object.assign(container, updates);
    await container.save();

    // Everything loaded on this container, whichever tab put it there.
    const itemFilter = containerItemFilter(container);

    // When staff revise the ETA (e.g. arrival delayed), push it down to every
    // shipment on this container so customers see the updated estimate too.
    let itemsRetimed = 0;
    if (updates.eta !== undefined && itemFilter) {
      const etaDate = updates.eta ? new Date(updates.eta) : null;
      if (etaDate === null || !isNaN(etaDate.getTime())) {
        const r = await ShipmentItem.updateMany(itemFilter, { $set: { estimatedDelivery: etaDate } });
        itemsRetimed = r.modifiedCount;
      }
    }

    // Moving the container moves its cargo. Held/delivered/returned/failed
    // items are left alone — see PROTECTED_ITEM_STATUSES.
    let statusSync = null;
    if (updates.status !== undefined && container.status !== previousStatus) {
      const itemStatus = CONTAINER_TO_ITEM_STATUS[container.status];
      if (itemStatus && itemFilter) {
        statusSync = await applyBulkStatus(itemFilter, itemStatus, {
          performedBy: req.user._id,
          note:        `Container ${container.containerNumber} moved to ${container.status.replace(/_/g, " ")}`,
        });
      }
    }

    await audit.log({
      performedBy: req.user._id,
      action:      "CONTAINER_UPDATED",
      targetModel: "ContainerLoading",
      targetId:    container._id,
      details:     { ...updates, previousStatus, itemsRetimed, statusSync },
      ip:          req.ip,
    });

    const notes = [
      itemsRetimed ? `${itemsRetimed} shipment ETA(s) synced` : null,
      describeBulkResult(statusSync) || null,
    ].filter(Boolean);

    return respond(
      res, 200, true,
      notes.length ? `Container loading updated — ${notes.join("; ")}` : "Container loading updated",
      container
    );
  } catch (err) { next(err); }
}

/**
 * DELETE /api/container-loadings/:id
 * Delete a container loading (staff only) — e.g. created from a wrong upload.
 * Also clears the container number off any items still referencing it so
 * customers never see a container that no longer exists.
 */
async function deleteContainerLoading(req, res, next) {
  try {
    const container = await ContainerLoading.findById(req.params.id);
    if (!container) return respond(res, 404, false, "Container not found");

    const cleared = await ShipmentItem.updateMany(
      { containerRef: containerRefMatcher(container.containerNumber) },
      { $set: { containerRef: null } }
    );

    await container.deleteOne();

    await audit.log({
      performedBy: req.user._id,
      action:      "CONTAINER_DELETED",
      targetModel: "ContainerLoading",
      targetId:    req.params.id,
      details:     { containerNumber: container.containerNumber, clearedItems: cleared.modifiedCount },
      ip:          req.ip,
    });

    return respond(res, 200, true, "Container loading deleted", {
      containerNumber: container.containerNumber,
      clearedItems:    cleared.modifiedCount,
    });
  } catch (err) { next(err); }
}

/**
 * GET /api/container-loadings/staff
 * Staff-only full list including staffNotes, batchRef populated.
 */
async function listContainerLoadingsStaff(req, res, next) {
  try {
    const { page = 1, limit = 20, status, search } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (search) {
      const esc = String(search).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      filter.$or = [
        { containerNumber: { $regex: esc, $options: "i" } },
        { blNumber:        { $regex: esc, $options: "i" } },
        { vesselName:      { $regex: esc, $options: "i" } },
        { sealNumber:      { $regex: esc, $options: "i" } },
      ];
    }

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

/**
 * GET /api/container-loadings/:id/items
 * Staff-only full item list for a container — the union of items assigned by
 * containerRef and items that arrived on the packing list that created it.
 * This is what the Container Loadings tab expands to, so a shipment attached to
 * a container from the Goods Received tab shows up here immediately.
 */
async function getContainerItemsStaff(req, res, next) {
  try {
    const container = await ContainerLoading.findById(req.params.id).lean();
    if (!container) return respond(res, 404, false, "Container not found");

    const { status } = req.query;
    const filter = containerItemFilter(container);
    if (!filter) return respond(res, 200, true, "Container items retrieved", { items: [], total: 0 });

    if (status) filter.status = status;

    const items = await ShipmentItem.find(filter)
      .sort({ updatedAt: -1 })
      .populate("customerId",   "name email phone")
      .populate("intakeBatch",  "batchCode stage createdAt")
      .populate("shippedBatch", "batchCode stage createdAt")
      .populate("arrivedBatch", "batchCode stage createdAt")
      .lean();

    return respond(res, 200, true, "Container items retrieved", { items, total: items.length });
  } catch (err) { next(err); }
}

module.exports = {
  listContainerLoadings,
  searchContainerLoadings,
  getContainerLoading,
  createContainerLoading,
  updateContainerLoading,
  deleteContainerLoading,
  listContainerLoadingsStaff,
  getContainerItemsStaff,
};

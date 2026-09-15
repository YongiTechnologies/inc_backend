"use strict";

/**
 * Parcel controller — HTTP layer for the two-layer tracking model (v2).
 *
 * Uploads insert immutable observations and re-derive the affected parcels;
 * everything else is a read over the derived Parcel collection. Reconciliation
 * ("in warehouse", "loaded but never received", "needs phone") is expressed as
 * queries over parcel flags rather than maintained counters.
 */

const path             = require("path");
const SourceFile       = require("../models/SourceFile");
const Observation      = require("../models/Observation");
const Parcel           = require("../models/Parcel");
const { respond }      = require("../utils/response");
const { buildObservations } = require("../services/observations");
const ingest           = require("../services/ingest.service");
const audit            = require("../services/audit.service");
const { normalisePhone, normaliseMark, maskName, maskPhone, maskMark } = require("../services/batch.service");
const { STATUS_ORDER } = require("../services/parcelDerivation");

// Public-safe projection of a parcel — the journey and cargo, none of the
// internal/staff or cross-customer fields (phone, mark, notes, financials).
function sanitizePublicParcel(p) {
  return {
    waybill:      p.waybill,
    currentStage: p.currentStage,
    status:       p.status,
    customerName: p.customerName || null,
    receivedDate: p.receivedDate || null,
    intake:  p.intake  ? {
      date: p.intake.date, warehouse: p.intake.warehouse, qty: p.intake.qty ?? null,
      // Each physical receipt (date + qty) — none of it is cross-customer PII.
      lines: (p.intake.lines || []).map((l) => ({ date: l.date, qty: l.qty ?? null, qtyRaw: l.qtyRaw ?? null })),
    } : null,
    loading: p.loading ? {
      containerNo: p.loading.containerNo, loadingDate: p.loading.loadingDate, etd: p.loading.etd, eta: p.loading.eta,
      location: p.loading.location, cbm: p.loading.cbm ?? null,
      // Each container leg, with its own arrival state, so a split shipment
      // shows every container instead of just one.
      legs: (p.loading.legs || []).map((l) => ({ containerNo: l.containerNo, loadingDate: l.loadingDate, etd: l.etd, eta: l.eta, qty: l.qty ?? null, arrived: !!l.arrived })),
    } : null,
    arrival: p.arrival ? { date: p.arrival.date, containerNo: p.arrival.containerNo } : null,
    qty:       p.qty ?? null,
    qtyByUnit: p.qtyByUnit ?? null,
    cbm:      (p.loading && p.loading.cbm != null) ? p.loading.cbm : null,
    productDescription: p.productDescription || null,
    partiallyArrived: !!(p.flags && p.flags.partiallyArrived),
  };
}

function validateFile(req, res) {
  if (!req.file) { respond(res, 400, false, "No file uploaded. Use multipart field name 'file'."); return false; }
  const ext = path.extname(req.file.originalname).toLowerCase();
  if (![".xlsx", ".xls"].includes(ext)) { respond(res, 400, false, "Invalid file type. Only .xlsx and .xls are accepted."); return false; }
  return true;
}

// ─── Uploads ──────────────────────────────────────────────────────────────────

/** Preview an upload without persisting anything. */
async function validateUpload(req, res, next) {
  if (!validateFile(req, res)) return;
  try {
    const built = buildObservations(req.file.buffer, { filename: req.file.originalname });
    const waybills = [...new Set(built.observations.map((o) => o.waybill).filter(Boolean))];
    const existing = waybills.length
      ? await Parcel.find({ waybill: { $in: waybills } }).distinct("waybill")
      : [];
    const existingSet = new Set(existing);
    return respond(res, 200, true, "Parsed preview", {
      stage:          built.stage,
      headerWarnings: built.headerWarnings,
      missingColumns: built.missingColumns,
      totalRows:      built.observations.length,
      skippedRows:    built.skippedRows.length,
      willLinkExisting: waybills.filter((w) => existingSet.has(w)).length,
      willCreateNew:    waybills.filter((w) => !existingSet.has(w)).length,
      sampleRows:     built.observations.slice(0, 5).map((o) => ({
        waybill: o.waybill, customerPhone: o.customerPhone, shippingMark: o.shippingMark,
        customerName: o.customerName, qty: o.qty, receivedDate: o.receivedDate,
      })),
    });
  } catch (err) { next(err); }
}

/** Ingest a spreadsheet (stage auto-detected). `?stage=` may pin the expected stage. */
async function upload(req, res, next) {
  if (!validateFile(req, res)) return;
  try {
    const result = await ingest.ingestFile(req.file.buffer, {
      filename:    req.file.originalname,
      uploadedBy:  req.user._id,
      expectStage: req.query.stage || null,
    });
    await audit.log({
      performedBy: req.user._id,
      action:      "PARCEL_UPLOAD",
      targetModel: "SourceFile",
      targetId:    result.sourceFile._id,
      details:     { stage: result.stage, filename: req.file.originalname, observations: result.observationsInserted },
      ip:          req.ip,
    }).catch(() => {});
    return respond(res, 201, true, `${result.stage} sheet ingested — ${result.parcelsWritten} parcels updated`, result);
  } catch (err) {
    if (err instanceof ingest.DuplicateFileError) {
      return respond(res, 409, false, "This exact file has already been uploaded.", {
        fileHash: err.fileHash, uploadedAt: err.uploadedAt,
      });
    }
    if (/missing required column|could not detect|was uploaded to the/i.test(err.message)) {
      return respond(res, 400, false, err.message);
    }
    next(err);
  }
}

/** Revert a wrongly uploaded file — deactivates its rows and re-derives. */
async function revertUpload(req, res, next) {
  try {
    const result = await ingest.revertFile(req.params.fileHash);
    await audit.log({
      performedBy: req.user._id, action: "PARCEL_UPLOAD_REVERT",
      targetModel: "SourceFile", details: { fileHash: req.params.fileHash }, ip: req.ip,
    }).catch(() => {});
    return respond(res, 200, true, "Upload reverted", result);
  } catch (err) {
    if (/no such file/i.test(err.message)) return respond(res, 404, false, err.message);
    next(err);
  }
}

async function listUploads(req, res, next) {
  try {
    const { stage, status = "active", page = 1, limit = 20 } = req.query;
    const filter = {};
    if (stage) filter.stage = stage;
    if (status) filter.status = status;
    const skip = (Number(page) - 1) * Number(limit);
    const [files, total] = await Promise.all([
      SourceFile.find(filter).sort({ uploadedAt: -1 }).skip(skip).limit(Number(limit)).lean(),
      SourceFile.countDocuments(filter),
    ]);
    return respond(res, 200, true, "Uploads retrieved", { total, page: Number(page), files });
  } catch (err) { next(err); }
}

// ─── Parcels ────────────────────────────────────────────────────────────────

const BUCKET_FILTER = {
  in_warehouse:         { "flags.receivedNotLoaded": true },
  loaded:               { currentStage: "loading" },
  arrived:              { currentStage: "arrival" },
  loaded_never_received:{ "flags.loadedNeverReceived": true },
  needs_phone:          { "flags.needsPhone": true },
  qty_mismatch:         { "flags.qtyMismatch": true },
};

/** Staff list of parcels with reconciliation buckets, container filter, search. */
async function listParcels(req, res, next) {
  try {
    const { bucket, container, stage, search, phone, page = 1, limit = 25 } = req.query;
    const filter = {};
    if (bucket && BUCKET_FILTER[bucket]) Object.assign(filter, BUCKET_FILTER[bucket]);
    if (container) filter.containerNos = container;
    if (stage) filter.currentStage = stage;
    if (phone) filter.customerPhone = normalisePhone(phone);
    if (search) {
      const rx = new RegExp(String(search).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ waybill: rx }, { customerName: rx }, { shippingMark: rx }, { customerPhone: rx }];
    }
    const skip = (Number(page) - 1) * Number(limit);
    const [parcels, total] = await Promise.all([
      Parcel.find(filter).sort({ updatedAt: -1 }).skip(skip).limit(Math.min(Number(limit), 2000)).lean(),
      Parcel.countDocuments(filter),
    ]);
    return respond(res, 200, true, "Parcels retrieved", { total, page: Number(page), parcels });
  } catch (err) { next(err); }
}

/** All parcels sharing a tracking number (a consolidated waybill has several). */
async function getByWaybill(req, res, next) {
  try {
    const parcels = await Parcel.find({ waybill: String(req.params.waybill).toUpperCase() }).lean();
    if (!parcels.length) return respond(res, 404, false, "No parcel found for that tracking number.");
    // Attach the raw observation trail for the timeline view.
    const observations = await Observation.find({
      waybill: String(req.params.waybill).toUpperCase(), active: true,
    }).sort({ uploadedAt: 1 }).lean();
    return respond(res, 200, true, "Parcel(s) retrieved", { parcels, observations });
  } catch (err) { next(err); }
}

/** The dashboard numbers, all as live counts. */
async function reconciliation(req, res, next) {
  try {
    const [total, received, loaded, arrived, notLoaded, loadedNeverReceived, needsPhone, qtyMismatch] =
      await Promise.all([
        Parcel.countDocuments({}),
        Parcel.countDocuments({ intake: { $ne: null } }),
        Parcel.countDocuments({ currentStage: "loading" }),
        Parcel.countDocuments({ currentStage: "arrival" }),
        Parcel.countDocuments({ "flags.receivedNotLoaded": true }),
        Parcel.countDocuments({ "flags.loadedNeverReceived": true }),
        Parcel.countDocuments({ "flags.needsPhone": true }),
        Parcel.countDocuments({ "flags.qtyMismatch": true }),
      ]);
    return respond(res, 200, true, "Reconciliation summary", {
      total, received, loaded, arrived,
      receivedNotLoaded: notLoaded, loadedNeverReceived, needsPhone, qtyMismatch,
    });
  } catch (err) { next(err); }
}

// ─── Containers ───────────────────────────────────────────────────────────────

/** One row per container, with counts and its loading metadata. */
async function listContainers(req, res, next) {
  try {
    // Unwind container legs so a parcel split across several containers is
    // counted under each one it is actually in (with that leg's own arrival
    // state), not just its primary container.
    const rows = await Parcel.aggregate([
      { $match: { "loading.legs.0": { $exists: true } } },
      { $unwind: "$loading.legs" },
      { $group: {
          _id: "$loading.legs.containerNo",
          parcels:     { $sum: 1 },
          loadingDate: { $max: "$loading.legs.loadingDate" },
          etd:         { $first: "$loading.legs.etd" },
          eta:         { $first: "$loading.legs.eta" },
          arrived:     { $sum: { $cond: ["$loading.legs.arrived", 1, 0] } },
          // Distinct receiving days the container drew from (the fan-in).
          receivingDays: { $addToSet: {
            $cond: [
              { $ne: ["$receivedDate", null] },
              { $dateToString: { format: "%Y-%m-%d", date: "$receivedDate" } },
              "$$REMOVE",
            ],
          } },
      } },
      { $match: { _id: { $ne: null } } },
      { $sort: { loadingDate: -1 } },
    ]);
    return respond(res, 200, true, "Containers retrieved", {
      containers: rows.map((r) => ({
        containerNo: r._id,
        parcels: r.parcels,
        loadingDate: r.loadingDate,
        etd: r.etd,
        eta: r.eta,
        arrived: r.arrived,
        spansReceivingDays: (r.receivingDays || []).sort(),
      })),
    });
  } catch (err) { next(err); }
}

/** A container's full manifest. */
async function getContainer(req, res, next) {
  try {
    const containerNo = String(req.params.containerNo);
    const parcels = await Parcel.find({ containerNos: containerNo }).lean();
    if (!parcels.length) return respond(res, 404, false, "No such container.");
    const receivedDays = [...new Set(parcels.filter((p) => p.receivedDate)
      .map((p) => new Date(p.receivedDate).toISOString().slice(0, 10)))].sort();
    // A parcel may be split across containers, so attach the leg for THIS
    // container (its qty/dates here) rather than the parcel-wide totals.
    const legOf = (p) => ((p.loading && p.loading.legs) || []).find((l) => l.containerNo === containerNo) || null;
    const firstLeg = legOf(parcels[0]);
    return respond(res, 200, true, "Container manifest", {
      containerNo,
      parcels: parcels.length,
      meta: firstLeg
        ? { containerNo, loadingDate: firstLeg.loadingDate, etd: firstLeg.etd, eta: firstLeg.eta }
        : parcels[0].loading,
      spansReceivingDays: receivedDays,          // proof it draws from many intake days
      list: parcels.map((p) => ({ ...p, containerLeg: legOf(p) })),
    });
  } catch (err) { next(err); }
}

// ─── Manual adjustments ───────────────────────────────────────────────────────

async function adjustParcel(req, res, next) {
  try {
    const { waybill, customerKey } = req.params;
    const adj = await ingest.applyManualAdjustment({
      waybill: String(waybill).toUpperCase(),
      customerKey,
      ...req.body,
      createdBy: req.user._id,
    });
    await audit.log({
      performedBy: req.user._id, action: "PARCEL_MANUAL_ADJUST",
      targetModel: "ManualAdjustment", targetId: adj._id,
      details: { waybill, customerKey, fields: Object.keys(req.body) }, ip: req.ip,
    }).catch(() => {});
    const parcel = await Parcel.findOne({ waybill: String(waybill).toUpperCase(), customerKey }).lean();
    return respond(res, 200, true, "Adjustment applied", { parcel });
  } catch (err) {
    if (/are required/i.test(err.message)) return respond(res, 400, false, err.message);
    next(err);
  }
}

/** Set one status on many parcels at once (bulk — e.g. a whole date group). */
async function bulkAdjustStatus(req, res, next) {
  try {
    const { items, status } = req.body;
    if (!Array.isArray(items) || !items.length) return respond(res, 400, false, "items is required (a non-empty array).");
    if (!status || !STATUS_ORDER.includes(status)) {
      return respond(res, 400, false, `status must be one of: ${STATUS_ORDER.join(", ")}`);
    }
    const result = await ingest.applyBulkStatus(items, status, req.user._id);
    await audit.log({
      performedBy: req.user._id, action: "PARCEL_BULK_STATUS",
      targetModel: "ManualAdjustment",
      details: { status, count: result.updated }, ip: req.ip,
    }).catch(() => {});
    return respond(res, 200, true, `${result.updated} parcels set to ${status}`, result);
  } catch (err) { next(err); }
}

// ─── Customer self-service ────────────────────────────────────────────────────

async function myParcels(req, res, next) {
  try {
    const or = [];
    if (req.user._id) or.push({ customerId: req.user._id });
    if (req.user.phone) or.push({ customerPhone: normalisePhone(req.user.phone) });
    if (!or.length) return respond(res, 200, true, "No parcels", { total: 0, parcels: [] });
    const parcels = await Parcel.find({ $or: or }).sort({ updatedAt: -1 }).lean();
    return respond(res, 200, true, "Your parcels", { total: parcels.length, parcels: parcels.map(sanitizePublicParcel) });
  } catch (err) { next(err); }
}

// ─── Public tracking (no auth) ────────────────────────────────────────────────

/** All parcels for a phone number, grouped by stage. */
async function publicTrackByPhone(req, res, next) {
  try {
    const normalised = normalisePhone(req.params.phone);
    if (!normalised) return respond(res, 400, false, "Invalid phone number.");
    const parcels = await Parcel.find({ customerPhone: normalised }).sort({ updatedAt: -1 }).lean();
    if (!parcels.length) return respond(res, 404, false, "No parcels found for this phone number.");
    const grouped = {};
    for (const p of parcels) (grouped[p.currentStage] = grouped[p.currentStage] || []).push(sanitizePublicParcel(p));
    return respond(res, 200, true, "Parcels retrieved", { total: parcels.length, grouped, parcels: parcels.map(sanitizePublicParcel) });
  } catch (err) { next(err); }
}

/** All parcels for a shipping mark. */
async function publicTrackByMark(req, res, next) {
  try {
    const mark = normaliseMark(req.params.mark);
    if (!mark) return respond(res, 400, false, "Invalid shipping mark.");
    const parcels = await Parcel.find({ shippingMark: mark }).sort({ updatedAt: -1 }).lean();
    if (!parcels.length) return respond(res, 404, false, "No parcels found for this shipping mark.");
    return respond(res, 200, true, "Parcels retrieved", { total: parcels.length, parcels: parcels.map(sanitizePublicParcel) });
  } catch (err) { next(err); }
}

/**
 * A tracking number's parcel(s). A consolidated number carries several
 * customers, so without a phone/mark to narrow it we return masked choices
 * rather than expose one customer's shipment to whoever has the number.
 */
async function publicTrackByWaybill(req, res, next) {
  try {
    const waybill = String(req.params.waybill).trim().toUpperCase();
    let parcels = await Parcel.find({ waybill }).lean();
    if (!parcels.length) return respond(res, 404, false, "Tracking number not found.");

    const np = req.query.phone ? normalisePhone(req.query.phone) : null;
    const nm = req.query.mark ? normaliseMark(req.query.mark) : null;

    if (np || nm) {
      const narrowed = parcels.filter((p) => (np && p.customerPhone === np) || (nm && p.shippingMark === nm));
      if (!narrowed.length) return respond(res, 404, false, "That phone number or shipping mark does not match any shipment on this tracking number.");
      parcels = narrowed;
    } else if (parcels.length > 1) {
      const choices = parcels.map((p) => ({ name: maskName(p.customerName), phone: maskPhone(p.customerPhone), mark: maskMark(p.shippingMark) }));
      return respond(res, 200, true,
        `This tracking number covers ${parcels.length} shipments. Enter your phone number or shipping mark to see yours.`,
        { ambiguous: true, total: parcels.length, choices, parcels: [] });
    }

    return respond(res, 200, true, "Tracking info retrieved", {
      ambiguous: false, total: parcels.length, parcels: parcels.map(sanitizePublicParcel),
    });
  } catch (err) { next(err); }
}

module.exports = {
  validateUpload, upload, revertUpload, listUploads,
  listParcels, getByWaybill, reconciliation,
  listContainers, getContainer,
  adjustParcel, bulkAdjustStatus, myParcels,
  publicTrackByPhone, publicTrackByMark, publicTrackByWaybill,
};

"use strict";

/**
 * Ingestion service — wires the two-layer model to the database.
 *
 *   upload → buildObservations → insert SourceFile + Observations (pure insert)
 *          → re-derive every affected waybill → upsert Parcels
 *
 * The whole thing is order-independent and idempotent:
 *  - a file is identified by the sha256 of its bytes, so re-uploading the same
 *    file is a detected no-op;
 *  - a Parcel is always the full fold of its waybill's active observations, so
 *    it does not matter whether intake or loading was uploaded first, nor how
 *    many times a waybill is touched.
 */

const SourceFile       = require("../models/SourceFile");
const Observation      = require("../models/Observation");
const Parcel           = require("../models/Parcel");
const ManualAdjustment = require("../models/ManualAdjustment");
const User             = require("../models/User");
const { buildObservations } = require("./observations");
const { deriveParcels }     = require("./parcelDerivation");

class DuplicateFileError extends Error {
  constructor(sourceFile) {
    super("This exact file has already been uploaded.");
    this.name = "DuplicateFileError";
    this.fileHash = sourceFile.fileHash;
    this.sourceFileId = sourceFile._id;
    this.uploadedAt = sourceFile.uploadedAt;
  }
}

/** Resolve a registered customer by the last 9 digits of their phone. */
async function resolveCustomerId(phone) {
  if (!phone) return null;
  const last9 = String(phone).slice(-9);
  const user = await User.findOne({ phone: { $regex: last9 + "$" } }).select("_id");
  return user ? user._id : null;
}

/** Overlay staff-entered facts onto a freshly derived parcel (in place). */
function applyAdjustment(parcel, adj) {
  if (!adj) return;
  if (adj.customerPhone) { parcel.customerPhone = adj.customerPhone; parcel.flags.needsPhone = false; }
  if (adj.statusOverride) parcel.status = adj.statusOverride;
  for (const f of ["heldReason", "assignedTo", "staffNotes", "specialInstructions",
                   "deliveryPhoto", "deliverySignature", "deliveredAt"]) {
    if (adj[f] != null) parcel[f] = adj[f];
  }
}

/**
 * Recompute and persist every Parcel on the given waybills from their current
 * active observations. Parcels no longer supported by any observation are
 * removed. Safe to call repeatedly.
 */
async function rederiveWaybills(waybills) {
  const uniq = [...new Set((waybills || []).filter(Boolean))];
  if (!uniq.length) return { waybillsRederived: 0, parcelsWritten: 0, parcelsRemoved: 0 };

  const obs = await Observation.find({ waybill: { $in: uniq }, active: true }).lean();
  const derived = deriveParcels(obs);

  const adjustments = await ManualAdjustment.find({ waybill: { $in: uniq } }).lean();
  const adjByKey = new Map();
  for (const a of adjustments) adjByKey.set(`${a.waybill}|${a.customerKey}`, a); // latest wins (sorted by _id asc)

  const derivedByWaybill = new Map();
  for (const p of derived) {
    if (!derivedByWaybill.has(p.waybill)) derivedByWaybill.set(p.waybill, []);
    derivedByWaybill.get(p.waybill).push(p);
  }

  let written = 0, removed = 0;
  for (const w of uniq) {
    const ps = derivedByWaybill.get(w) || [];
    const keepKeys = ps.map((p) => p.customerKey);

    const del = await Parcel.deleteMany({ waybill: w, customerKey: { $nin: keepKeys } });
    removed += del.deletedCount || 0;

    for (const p of ps) {
      applyAdjustment(p, adjByKey.get(`${p.waybill}|${p.customerKey}`));
      p.customerId = await resolveCustomerId(p.customerPhone);
      p.derivedAt = new Date();
      await Parcel.updateOne(
        { waybill: p.waybill, customerKey: p.customerKey },
        { $set: p },
        { upsert: true }
      );
      written++;
    }
  }
  return { waybillsRederived: uniq.length, parcelsWritten: written, parcelsRemoved: removed };
}

/**
 * Ingest one uploaded spreadsheet.
 * @param {Buffer} buffer
 * @param {{filename?:string, uploadedBy?:any, expectStage?:string}} opts
 */
async function ingestFile(buffer, opts = {}) {
  const { filename = null, uploadedBy = null, expectStage = null } = opts;

  const built = buildObservations(buffer, { filename, uploadedBy });
  const { sourceFile, observations, stage, skippedRows, missingColumns, headerWarnings } = built;

  if (!stage) throw new Error("Could not detect the sheet's stage (INTAKE / LOADING / ARRIVAL).");
  if (expectStage && stage !== expectStage) {
    throw new Error(`Sheet stage is "${stage}" but was uploaded to the ${expectStage} endpoint.`);
  }
  if (missingColumns && missingColumns.length) {
    throw new Error(`Spreadsheet is missing required column(s): ${missingColumns.join(", ")}`);
  }

  const existing = await SourceFile.findOne({ fileHash: sourceFile.fileHash });
  if (existing && existing.status === "active") throw new DuplicateFileError(existing);

  let sf;
  if (existing) {
    // Previously reverted, now re-uploaded: reactivate rather than duplicate.
    existing.status = "active";
    existing.revertedAt = undefined;
    await existing.save();
    await Observation.updateMany({ fileHash: sourceFile.fileHash }, { $set: { active: true } });
    sf = existing;
  } else {
    sf = await SourceFile.create({ ...sourceFile, uploadedBy });
    await Observation.insertMany(observations.map((o) => ({ ...o, sourceFile: sf._id, active: true })));
  }

  const waybills = [...new Set(observations.map((o) => o.waybill).filter(Boolean))];
  const recon = await rederiveWaybills(waybills);

  return {
    sourceFile: sf,
    stage,
    observationsInserted: observations.length,
    skippedRows,
    headerWarnings,
    ...recon,
  };
}

/** Mark a file reverted (deactivate its observations) and re-derive. */
async function revertFile(fileHash) {
  const sf = await SourceFile.findOne({ fileHash });
  if (!sf) throw new Error("No such file.");
  const affected = await Observation.find({ fileHash, active: true }).distinct("waybill");
  sf.status = "reverted";
  sf.revertedAt = new Date();
  await sf.save();
  await Observation.updateMany({ fileHash }, { $set: { active: false } });
  const recon = await rederiveWaybills(affected.filter(Boolean));
  return { reverted: fileHash, ...recon };
}

/** Record a staff adjustment and re-derive the one affected waybill. */
async function applyManualAdjustment(data) {
  const { waybill, customerKey } = data;
  if (!waybill || !customerKey) throw new Error("waybill and customerKey are required.");
  const adj = await ManualAdjustment.create(data);
  await rederiveWaybills([waybill]);
  return adj;
}

/**
 * Rebuild the ENTIRE Parcel collection from all active observations. Used by the
 * migration and after any change to the derivation logic. Rebuilds in waybill
 * batches to keep memory bounded.
 */
async function rebuildAll({ batchSize = 2000 } = {}) {
  await Parcel.deleteMany({});
  const allWaybills = await Observation.find({ active: true }).distinct("waybill");
  const waybills = allWaybills.filter(Boolean);
  let written = 0;
  for (let i = 0; i < waybills.length; i += batchSize) {
    const slice = waybills.slice(i, i + batchSize);
    const r = await rederiveWaybills(slice);
    written += r.parcelsWritten;
  }
  return { waybills: waybills.length, parcelsWritten: written };
}

module.exports = {
  ingestFile,
  rederiveWaybills,
  revertFile,
  applyManualAdjustment,
  rebuildAll,
  resolveCustomerId,
  applyAdjustment,
  DuplicateFileError,
};

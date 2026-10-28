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
const { deriveParcels, statusRank } = require("./parcelDerivation");

class DuplicateFileError extends Error {
  constructor(sourceFile) {
    super("This exact file has already been uploaded.");
    this.name = "DuplicateFileError";
    this.fileHash = sourceFile.fileHash;
    this.sourceFileId = sourceFile._id;
    this.uploadedAt = sourceFile.uploadedAt;
  }
}

/**
 * Raised when a file's BYTES are new but its CONTENTS match an already-active
 * upload — a re-saved or renamed copy of the same sheet. Left unchecked this is
 * what makes "revert doesn't delete": the goods stay live via the twin copy.
 * The caller may override with allowContentDuplicate, or replaceFileHash to
 * revert the existing copy and take this one in its place.
 */
class ContentDuplicateError extends Error {
  constructor(sourceFile) {
    super("A sheet with the same contents has already been uploaded.");
    this.name = "ContentDuplicateError";
    this.fileHash = sourceFile.fileHash;
    this.contentHash = sourceFile.contentHash;
    this.originalFilename = sourceFile.originalFilename;
    this.uploadedAt = sourceFile.uploadedAt;
    this.sourceFileId = sourceFile._id;
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
  // Furthest-wins: a manual status only moves a parcel FORWARD in the lifecycle,
  // so a staff advance is never regressed by a later sheet, and a sheet that
  // implies a further stage is never regressed by an older manual status.
  if (adj.statusOverride) {
    const cur = statusRank(parcel.status);
    const next = statusRank(adj.statusOverride);
    if (next >= 0 && (cur < 0 || next > cur)) parcel.status = adj.statusOverride;
  }
  for (const f of ["heldReason", "assignedTo", "staffNotes", "specialInstructions",
                   "deliveryPhoto", "deliverySignature", "deliveredAt"]) {
    if (adj[f] != null) parcel[f] = adj[f];
  }
}

/**
 * Registered customers by the last 9 digits of their phone, loaded once per
 * re-derive. The first match wins, as resolveCustomerId's findOne did.
 */
async function loadCustomerIndex() {
  const users = await User.find({ phone: { $ne: null } }, { phone: 1 }).lean();
  const byLast9 = new Map();
  for (const u of users) {
    const key = String(u.phone || "").slice(-9);
    if (key && !byLast9.has(key)) byLast9.set(key, u._id);
  }
  return byLast9;
}

/**
 * Recompute and persist every Parcel on the given waybills from their current
 * active observations. Parcels no longer supported by any observation are
 * removed. Safe to call repeatedly.
 *
 * Reads are three queries and writes are one bulkWrite, however many parcels
 * there are. It used to be a query per waybill plus two per parcel, run one at
 * a time: under the old hosting's 10-second request limit a large sheet was cut
 * off part-way, leaving the sheet active but many parcels never written.
 */
async function rederiveWaybills(waybills) {
  const uniq = [...new Set((waybills || []).filter(Boolean))];
  if (!uniq.length) return { waybillsRederived: 0, parcelsWritten: 0, parcelsRemoved: 0 };

  const [obs, adjustments, customers] = await Promise.all([
    Observation.find({ waybill: { $in: uniq }, active: true }).lean(),
    ManualAdjustment.find({ waybill: { $in: uniq } }).lean(),
    loadCustomerIndex(),
  ]);
  const derived = deriveParcels(obs);

  const adjByKey = new Map();
  for (const a of adjustments) adjByKey.set(`${a.waybill}|${a.customerKey}`, a); // latest wins (sorted by _id asc)

  const derivedByWaybill = new Map();
  for (const p of derived) {
    if (!derivedByWaybill.has(p.waybill)) derivedByWaybill.set(p.waybill, []);
    derivedByWaybill.get(p.waybill).push(p);
  }

  // All deletes, then all upserts, so the driver sends two batched commands.
  const deletes = [];
  const upserts = [];
  const derivedAt = new Date();
  for (const w of uniq) {
    const ps = derivedByWaybill.get(w) || [];
    deletes.push({ deleteMany: { filter: { waybill: w, customerKey: { $nin: ps.map((p) => p.customerKey) } } } });
    for (const p of ps) {
      applyAdjustment(p, adjByKey.get(`${p.waybill}|${p.customerKey}`));
      p.customerId = (p.customerPhone && customers.get(String(p.customerPhone).slice(-9))) || null;
      p.derivedAt = derivedAt;
      upserts.push({ updateOne: { filter: { waybill: p.waybill, customerKey: p.customerKey }, update: { $set: p }, upsert: true } });
    }
  }
  const result = await Parcel.bulkWrite([...deletes, ...upserts], { ordered: true });
  return { waybillsRederived: uniq.length, parcelsWritten: upserts.length, parcelsRemoved: result.deletedCount || 0 };
}

/**
 * Ingest one uploaded spreadsheet.
 * @param {Buffer} buffer
 * @param {{filename?:string, uploadedBy?:any, expectStage?:string}} opts
 */
async function ingestFile(buffer, opts = {}) {
  const {
    filename = null, uploadedBy = null, expectStage = null,
    allowContentDuplicate = false, // ingest even if an active twin exists
    replaceFileHash = null,        // revert this file first, then ingest (a correction)
  } = opts;

  const built = buildObservations(buffer, { filename, uploadedBy });
  const { sourceFile, observations, stage, skippedRows, skippedRowsTotal, missingColumns, headerWarnings } = built;

  if (!stage) throw new Error("Could not detect the sheet's stage (INTAKE / LOADING / ARRIVAL).");
  if (expectStage && stage !== expectStage) {
    throw new Error(`Sheet stage is "${stage}" but was uploaded to the ${expectStage} endpoint.`);
  }
  if (missingColumns && missingColumns.length) {
    throw new Error(`Spreadsheet is missing required column(s): ${missingColumns.join(", ")}`);
  }

  const existing = await SourceFile.findOne({ fileHash: sourceFile.fileHash });
  if (existing && existing.status === "active") throw new DuplicateFileError(existing);

  // Content-duplicate guard: new bytes, but the same rows as an active upload.
  // Skipped when reactivating a byte-known file, when the caller overrides, or
  // when the twin is exactly the file being replaced.
  if (!existing && !allowContentDuplicate && sourceFile.contentHash) {
    const twin = await SourceFile.findOne({ contentHash: sourceFile.contentHash, status: "active" });
    if (twin && twin.fileHash !== replaceFileHash) throw new ContentDuplicateError(twin);
  }

  // A correction: roll back the file being replaced before ingesting the new one.
  let replaced = null;
  if (replaceFileHash) {
    try { replaced = await revertFile(replaceFileHash); } catch { /* already gone — ignore */ }
  }

  let sf;
  if (existing) {
    // Previously reverted, now re-uploaded: reactivate rather than duplicate.
    existing.status = "active";
    existing.revertedAt = undefined;
    if (!existing.contentHash) existing.contentHash = sourceFile.contentHash; // backfill
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
    skippedRowsTotal,
    headerWarnings,
    replaced,
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

/**
 * Set one status on many parcels at once (e.g. a whole receiving-day group).
 * Records a manual adjustment per parcel, then re-derives each affected waybill.
 */
async function applyBulkStatus(items, status, createdBy) {
  const docs = (items || [])
    .filter((it) => it && it.waybill && it.customerKey)
    .map((it) => ({ waybill: String(it.waybill).toUpperCase(), customerKey: it.customerKey, statusOverride: status, createdBy }));
  if (!docs.length) return { updated: 0, waybills: 0 };
  await ManualAdjustment.insertMany(docs);
  const waybills = [...new Set(docs.map((d) => d.waybill))];
  await rederiveWaybills(waybills);
  return { updated: docs.length, waybills: waybills.length };
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
  applyBulkStatus,
  rebuildAll,
  resolveCustomerId,
  applyAdjustment,
  DuplicateFileError,
  ContentDuplicateError,
};

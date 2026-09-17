"use strict";
// READ-ONLY diagnosis of the "revert doesn't delete" report.
const mongoose = require("mongoose");
const SourceFile = require("../src/models/SourceFile");
const Observation = require("../src/models/Observation");
const Parcel = require("../src/models/Parcel");

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.DB_NAME || "inc_logistics", serverSelectionTimeoutMS: 30000 });

  const revertedFiles = await SourceFile.find({ status: "reverted" }).lean();
  const revertedHashes = new Set(revertedFiles.map((f) => f.fileHash));
  console.log("SourceFiles total:            ", await SourceFile.countDocuments({}));
  console.log("  status=active:              ", await SourceFile.countDocuments({ status: "active" }));
  console.log("  status=reverted:           ", revertedFiles.length);

  // BUG 1: observations still active under a reverted file (revert should deactivate them)
  let activeUnderReverted = 0;
  if (revertedHashes.size) {
    activeUnderReverted = await Observation.countDocuments({ fileHash: { $in: [...revertedHashes] }, active: true });
  }
  console.log("\nBUG 1 — active observations under a REVERTED file:", activeUnderReverted, activeUnderReverted ? "  <-- revert didn't deactivate" : "(ok)");

  // BUG 2: orphan parcels — a parcel whose observationRefs point at NO active observation.
  const activeHashes = new Set(await Observation.distinct("fileHash", { active: true }));
  // Build set of active (fileHash|srcRow|tokenIndex) for precise check.
  const activeKeys = new Set();
  const cursor = Observation.find({ active: true }, { fileHash: 1, srcRow: 1, tokenIndex: 1 }).lean().cursor();
  for (let o = await cursor.next(); o; o = await cursor.next()) activeKeys.add(`${o.fileHash}#${o.srcRow}#${o.tokenIndex}`);

  let orphanByFile = 0, orphanByRow = 0, checked = 0;
  const examples = [];
  const pc = Parcel.find({}, { waybill: 1, customerKey: 1, observationRefs: 1, status: 1 }).lean().cursor();
  for (let p = await pc.next(); p; p = await pc.next()) {
    checked++;
    const refs = p.observationRefs || [];
    const anyActiveFile = refs.some((r) => activeHashes.has(r.fileHash));
    const anyActiveRow = refs.some((r) => activeKeys.has(`${r.fileHash}#${r.srcRow}#${r.tokenIndex}`));
    if (!anyActiveFile) orphanByFile++;
    if (!anyActiveRow) {
      orphanByRow++;
      if (examples.length < 12) examples.push({ waybill: p.waybill, customerKey: p.customerKey, status: p.status, refs: refs.length });
    }
  }
  console.log("\nParcels checked:               ", checked);
  console.log("BUG 2 — orphan parcels (no ref to any ACTIVE observation file):", orphanByFile);
  console.log("       orphan parcels (no ref to any ACTIVE observation row): ", orphanByRow, orphanByRow ? "  <-- should have been deleted on revert" : "(ok)");
  for (const e of examples) console.log("   orphan:", e.waybill, e.customerKey, "status=" + e.status, "refs=" + e.refs);

  await mongoose.disconnect();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });

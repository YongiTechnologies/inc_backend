"use strict";
// READ-ONLY: for each reverted file, do its waybills still have parcels, and are
// those parcels supported by OTHER active files? Also check for duplicate parcels.
const mongoose = require("mongoose");
const SourceFile = require("../src/models/SourceFile");
const Observation = require("../src/models/Observation");
const Parcel = require("../src/models/Parcel");

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.DB_NAME || "inc_logistics", serverSelectionTimeoutMS: 30000 });

  // Duplicate parcel check (same waybill+customerKey more than once).
  const dupes = await Parcel.aggregate([
    { $group: { _id: { w: "$waybill", c: "$customerKey" }, n: { $sum: 1 } } },
    { $match: { n: { $gt: 1 } } },
    { $count: "dupeGroups" },
  ]);
  const totalParcels = await Parcel.countDocuments({});
  const distinctPairs = (await Parcel.aggregate([{ $group: { _id: { w: "$waybill", c: "$customerKey" } } }, { $count: "n" }]))[0]?.n || 0;
  console.log(`Total parcels: ${totalParcels}   distinct (waybill,customerKey): ${distinctPairs}   duplicate groups: ${dupes[0]?.dupeGroups || 0}`);

  const reverted = await SourceFile.find({ status: "reverted" }).lean();
  console.log(`\nReverted files: ${reverted.length}`);
  for (const f of reverted) {
    // Waybills that were on this file (from its observations, active or not).
    const wbs = (await Observation.distinct("waybill", { fileHash: f.fileHash })).filter(Boolean);
    // How many still have a parcel?
    const stillParcel = wbs.length ? await Parcel.countDocuments({ waybill: { $in: wbs } }) : 0;
    // Of this file's waybills, how many still have ANY active observation (from other files)?
    const stillActive = wbs.length ? (await Observation.distinct("waybill", { waybill: { $in: wbs }, active: true })).length : 0;
    console.log(`\n  "${f.originalFilename}" [${f.stage}] reverted ${f.revertedAt ? new Date(f.revertedAt).toISOString().slice(0,10) : "?"}`);
    console.log(`     waybills on file: ${wbs.length}   still have a parcel: ${stillParcel}   still have active obs (other files): ${stillActive}`);
    // Which other active files cover those waybills?
    if (wbs.length) {
      const others = await Observation.aggregate([
        { $match: { waybill: { $in: wbs }, active: true } },
        { $group: { _id: "$sourceFilename", n: { $sum: 1 } } },
        { $sort: { n: -1 } }, { $limit: 5 },
      ]);
      console.log(`     goods still live via: ${others.map((o) => `${o._id} (${o.n})`).join(", ") || "none"}`);
    }
  }
  await mongoose.disconnect();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });

"use strict";
// READ-ONLY: compute what a full re-derive WOULD produce and diff it against the
// current live Parcel collection. Writes nothing.
const mongoose = require("mongoose");
const Observation = require("../src/models/Observation");
const Parcel = require("../src/models/Parcel");
const { deriveParcels } = require("../src/services/parcelDerivation");

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.DB_NAME || "inc_logistics" });
  const obs = await Observation.find({ active: true }).lean();
  const derived = deriveParcels(obs);

  const tally = (arr, fn) => arr.reduce((m, x) => { const k = fn(x); m[k] = (m[k] || 0) + 1; return m; }, {});
  const now = {
    total: await Parcel.countDocuments({}),
    intake: await Parcel.countDocuments({ currentStage: "intake" }),
    loading: await Parcel.countDocuments({ currentStage: "loading" }),
    arrival: await Parcel.countDocuments({ currentStage: "arrival" }),
    qtyMismatch: await Parcel.countDocuments({ "flags.qtyMismatch": true }),
  };
  const stage = tally(derived, (p) => p.currentStage);
  const flag = (f) => derived.filter((p) => p.flags[f]).length;

  console.log(`Active observations:            ${obs.length}`);
  console.log(`\n                     CURRENT  ->  AFTER REBUILD`);
  console.log(`Total parcels:        ${now.total}    ->  ${derived.length}`);
  console.log(`  currentStage intake:${String(now.intake).padStart(6)}  ->  ${stage.intake || 0}`);
  console.log(`  currentStage loading:${String(now.loading).padStart(5)}  ->  ${stage.loading || 0}`);
  console.log(`  currentStage arrival:${String(now.arrival).padStart(5)}  ->  ${stage.arrival || 0}`);
  console.log(`  qtyMismatch flag:    ${String(now.qtyMismatch).padStart(6)}  ->  ${flag("qtyMismatch")}`);
  console.log(`\nNEW flags after rebuild:`);
  console.log(`  multiIntake:      ${flag("multiIntake")}`);
  console.log(`  multiContainer:   ${flag("multiContainer")}`);
  console.log(`  partiallyArrived: ${flag("partiallyArrived")}`);
  console.log(`  mixedUnits:       ${flag("mixedUnits")}`);
  await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

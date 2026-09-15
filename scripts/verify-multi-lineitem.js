"use strict";
// READ-ONLY: derive specific waybills from live observations with the NEW fold
// and print the result. Does not write anything.
const mongoose = require("mongoose");
const Observation = require("../src/models/Observation");
const { deriveParcels } = require("../src/services/parcelDerivation");

const WAYBILLS = process.argv.slice(2).length ? process.argv.slice(2)
  : ["19897625171", "18530856012", "13711197875", "13662360519"];

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.DB_NAME || "inc_logistics" });
  for (const w of WAYBILLS) {
    const obs = await Observation.find({ waybill: w, active: true }).lean();
    const parcels = deriveParcels(obs);
    console.log(`\n===== ${w}  (${obs.length} obs → ${parcels.length} parcel(s)) =====`);
    for (const p of parcels) {
      console.log(`  customer ${p.customerKey}  stage=${p.currentStage} status=${p.status}  qty=${p.qty} ${p.qtyByUnit ? JSON.stringify(p.qtyByUnit) : ""}`);
      console.log(`    flags: ${Object.entries(p.flags).filter(([, v]) => v).map(([k]) => k).join(", ") || "none"}`);
      if (p.intake) console.log(`    intake: qty=${p.intake.qty}  lines=${(p.intake.lines || []).map((l) => `${l.qtyRaw || l.qty}@${l.date ? new Date(l.date).toISOString().slice(0, 10) : "?"}`).join(", ")}`);
      if (p.loading) console.log(`    loading: qty=${p.loading.qty}  legs=${(p.loading.legs || []).map((l) => `${l.containerNo}:${l.qtyRaw || l.qty}${l.arrived ? "✓" : ""}`).join(", ")}`);
      console.log(`    containerNos: ${JSON.stringify(p.containerNos)}`);
    }
  }
  await mongoose.disconnect();
}
main().catch((e) => { console.error(e); process.exit(1); });

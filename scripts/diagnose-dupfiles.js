"use strict";
// READ-ONLY: find ACTIVE source files that are content-duplicates of each other
// (same stage, near-identical set of waybills) — the root of "revert doesn't
// delete". Byte-exact dedup misses these because a re-saved sheet has new bytes.
const mongoose = require("mongoose");
const SourceFile = require("../src/models/SourceFile");
const Observation = require("../src/models/Observation");

const jaccard = (a, b) => { let inter = 0; for (const x of a) if (b.has(x)) inter++; return inter / (a.size + b.size - inter); };

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.DB_NAME || "inc_logistics", serverSelectionTimeoutMS: 30000 });
  const files = await SourceFile.find({ status: "active" }).lean();
  // Waybill set per active file.
  const info = [];
  for (const f of files) {
    const wbs = new Set((await Observation.distinct("waybill", { fileHash: f.fileHash, active: true })).filter(Boolean));
    if (wbs.size) info.push({ name: f.originalFilename, stage: f.stage, hash: f.fileHash, wbs });
  }
  // Pairwise within the same stage; report pairs with high overlap.
  const pairs = [];
  for (let i = 0; i < info.length; i++) for (let j = i + 1; j < info.length; j++) {
    if (info[i].stage !== info[j].stage) continue;
    const jac = jaccard(info[i].wbs, info[j].wbs);
    if (jac >= 0.6) pairs.push({ a: info[i], b: info[j], jac });
  }
  pairs.sort((x, y) => y.jac - x.jac);
  console.log(`Active files with rows: ${info.length}`);
  console.log(`Suspected duplicate PAIRS (same stage, >=60% waybill overlap): ${pairs.length}\n`);
  const filesInDupes = new Set();
  for (const p of pairs) { filesInDupes.add(p.a.hash); filesInDupes.add(p.b.hash); }
  console.log(`Distinct active files involved in a duplicate pair: ${filesInDupes.size}\n`);
  for (const p of pairs.slice(0, 25)) {
    console.log(`  ${(p.jac * 100).toFixed(0)}%  "${p.a.name}" (${p.a.wbs.size})  ==  "${p.b.name}" (${p.b.wbs.size})  [${p.a.stage}]`);
  }
  await mongoose.disconnect();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });

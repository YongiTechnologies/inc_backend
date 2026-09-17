"use strict";
/**
 * Clean up EXISTING duplicate uploads (same contents, different bytes) that were
 * ingested before the content-duplicate guard existed. For each group of active
 * files with the same content signature it keeps the earliest-uploaded copy and
 * reverts the rest (re-deriving affected parcels — no data loss, the goods stay
 * live via the kept copy). Also backfills SourceFile.contentHash so the guard
 * and future dedup work on old files too.
 *
 *   DRY RUN (default):  node scripts/cleanup-dup-files.js
 *   APPLY:              node scripts/cleanup-dup-files.js --apply
 */
const mongoose = require("mongoose");
const SourceFile = require("../src/models/SourceFile");
const Observation = require("../src/models/Observation");
const ingest = require("../src/services/ingest.service");
const { contentSignature } = require("../src/services/observations");

const APPLY = process.argv.includes("--apply");

(async () => {
  await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.DB_NAME || "inc_logistics", serverSelectionTimeoutMS: 30000 });
  const files = await SourceFile.find({ status: "active" }).lean();

  // Recompute each active file's content signature from its stored observations.
  const sigByFile = new Map();
  for (const f of files) {
    const obs = await Observation.find({ fileHash: f.fileHash, active: true }).lean();
    if (!obs.length) continue;
    sigByFile.set(f.fileHash, contentSignature(obs, f.stage));
  }

  // Backfill contentHash on active files (so the guard works on old files too).
  let backfilled = 0;
  if (APPLY) {
    for (const f of files) {
      const sig = sigByFile.get(f.fileHash);
      if (sig && f.contentHash !== sig) { await SourceFile.updateOne({ _id: f._id }, { $set: { contentHash: sig } }); backfilled++; }
    }
  }

  // Group active files by signature.
  const groups = new Map();
  for (const f of files) {
    const sig = sigByFile.get(f.fileHash);
    if (!sig) continue;
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(f);
  }

  const plan = [];
  for (const [, grp] of groups) {
    if (grp.length < 2) continue;
    grp.sort((a, b) => new Date(a.uploadedAt || a.createdAt || 0) - new Date(b.uploadedAt || b.createdAt || 0));
    const keep = grp[0];
    const revert = grp.slice(1);
    plan.push({ keep, revert });
  }

  console.log(`Active files: ${files.length}   duplicate groups: ${plan.length}   files to revert: ${plan.reduce((n, p) => n + p.revert.length, 0)}`);
  if (APPLY) console.log(`contentHash backfilled on ${backfilled} files.`);
  console.log(`\n${APPLY ? "APPLYING" : "DRY RUN — nothing written. Re-run with --apply to execute."}\n`);

  for (const p of plan) {
    console.log(`KEEP    "${p.keep.originalFilename}"  [${p.keep.stage}]  uploaded ${new Date(p.keep.uploadedAt).toISOString().slice(0, 10)}`);
    for (const r of p.revert) {
      console.log(`REVERT  "${r.originalFilename}"  [${r.stage}]  uploaded ${new Date(r.uploadedAt).toISOString().slice(0, 10)}  (${r.fileHash.slice(0, 12)}…)`);
      if (APPLY) { const res = await ingest.revertFile(r.fileHash); console.log(`        → reverted; parcelsWritten ${res.parcelsWritten}, parcelsRemoved ${res.parcelsRemoved}`); }
    }
    console.log("");
  }
  await mongoose.disconnect();
})().catch((e) => { console.error("ERR", e.message); process.exit(1); });

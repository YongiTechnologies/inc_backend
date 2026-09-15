"use strict";

/**
 * Blast-radius analysis for the "one waybill, one customer, several goods"
 * modelling gap. READ-ONLY. Uses the real derivation grouping (buildAliasMap +
 * partitionByCustomer) so the customer partition matches production exactly,
 * then inspects each customer group for MULTIPLE distinct observations at the
 * SAME stage — the case foldParcel currently collapses to one value.
 *
 * Run from inc_backend with MONGODB_URI (and DB_NAME=inc_logistics) set:
 *   node scripts/analyze-multi-lineitem.js
 *   node scripts/analyze-multi-lineitem.js --stage intake --examples 20
 */

const mongoose = require("mongoose");
const Observation = require("../src/models/Observation");
const { buildAliasMap, partitionByCustomer } = require("../src/services/parcelDerivation");

const arg = (name, def) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : def;
};
const STAGE = arg("stage", "intake");          // which stage to inspect for multiplicity
const EXAMPLES = parseInt(arg("examples", "15"), 10);

// A "line" by FILE identity = one distinct source row across files. Identical
// byte-for-byte re-uploads share a fileHash (deduped upstream), but re-saved /
// overlapping sheets do NOT, so this over-counts cross-sheet duplicates.
const fileLineKey = (o) => `${o.fileHash}#${o.srcRow}#${o.tokenIndex}`;

// A "line" by CONTENT identity = one physical receipt regardless of which sheet
// listed it. The same receipt re-listed on an overlapping sheet has the same
// event date + qty + goods, so this folds cross-sheet duplicates together and
// leaves only genuinely-distinct receipts. Conservative: two real receipts on
// the same day with the same qty and goods would merge (rare; under-counts
// rather than double-counts).
const dstr = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "∅");
const contentLineKey = (o) =>
  `${dstr(o.eventDate)}|${o.qty == null ? "∅" : o.qty}|${(o.qtyRaw || "").toUpperCase()}|${(o.productDescription || "").trim().toUpperCase()}`;

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("Set MONGODB_URI (Railway Mongo public URL).");
  await mongoose.connect(uri, { dbName: process.env.DB_NAME || "inc_logistics" });

  const obs = await Observation.find({ active: true }).lean();
  console.log(`Loaded ${obs.length} active observations.`);

  const aliasMap = buildAliasMap(obs);
  const byWaybill = new Map();
  for (const o of obs) {
    if (!o.waybill) continue;
    if (!byWaybill.has(o.waybill)) byWaybill.set(o.waybill, []);
    byWaybill.get(o.waybill).push(o);
  }

  let customerGroups = 0;
  let multiFile = 0;          // groups with >=2 distinct FILE-lines at STAGE
  let crossSheetDupGroups = 0;// groups where file-lines collapse under content dedup
  let multiContent = 0;       // groups with >=2 distinct CONTENT-lines (TRUE multi-receipt)
  let multiContentDiffQty = 0;
  let unitsMixed = 0;         // true multi-receipt groups spanning >1 unit (unsafe to sum)
  let multiContainer = 0;     // (loading) true multi-receipt groups spanning >1 container
  let hiddenQtyFile = 0;      // qty dropped today, counting each file-line (over-counts dups)
  let hiddenQtyContent = 0;   // qty dropped today, after content dedup (the honest number)
  const examples = [];

  for (const [waybill, group] of byWaybill) {
    for (const cg of partitionByCustomer(group, aliasMap)) {
      customerGroups++;
      const stageObs = cg.filter((o) => o.stage === STAGE);

      const fileLines = new Map();
      for (const o of stageObs) if (!fileLines.has(fileLineKey(o))) fileLines.set(fileLineKey(o), o);
      const contentLines = new Map();
      for (const o of stageObs) if (!contentLines.has(contentLineKey(o))) contentLines.set(contentLineKey(o), o);

      if (fileLines.size >= 2) multiFile++;
      if (fileLines.size >= 2 && contentLines.size < fileLines.size) crossSheetDupGroups++;
      if (contentLines.size < 2) continue;

      multiContent++;
      if (STAGE === "loading") {
        const ctrs = new Set(stageObs.map((o) => o.container && o.container.containerNo).filter(Boolean));
        if (ctrs.size > 1) multiContainer++;
      }
      const arr = [...contentLines.values()];
      const qtys = arr.map((o) => o.qty);
      const distinctQty = new Set(qtys.map((q) => (q == null ? "∅" : q)));
      const units = new Set(arr.map((o) => o.qtyUnit || "∅"));
      const summed = qtys.reduce((s, q) => s + (q || 0), 0);
      const keptFile = ([...fileLines.values()].map((o)=>o.qty).pop()) || 0;
      hiddenQtyContent += summed - ((qtys[qtys.length - 1]) || 0);
      hiddenQtyFile += ([...fileLines.values()].reduce((s,o)=>s+(o.qty||0),0)) - keptFile;

      if (units.size > 1) unitsMixed++;
      if (distinctQty.size > 1) multiContentDiffQty++;

      if (examples.length < EXAMPLES) {
        examples.push({
          waybill, customerKey: cg[0].customerKey,
          phone: arr.find((o) => o.customerPhone)?.customerPhone || null,
          fileLines: fileLines.size, contentLines: contentLines.size,
          lines: arr.map((o) => ({ file: o.sourceFilename, srcRow: o.srcRow, qty: o.qty, qtyRaw: o.qtyRaw, qtyUnit: o.qtyUnit, eventDate: o.eventDate })),
        });
      }
    }
  }

  console.log("\n===== BLAST RADIUS (stage: " + STAGE + ") =====");
  console.log(`Customer groups (≈ current parcels):            ${customerGroups}`);
  console.log(`  with ≥2 FILE-lines (raw, incl. cross-sheet dups): ${multiFile}`);
  console.log(`    of which shrink under content dedup:        ${crossSheetDupGroups}  <- cross-sheet duplicates`);
  console.log(`  with ≥2 CONTENT-lines (TRUE multi-receipt):   ${multiContent}`);
  console.log(`    – of those, differing qty:                  ${multiContentDiffQty}`);
  console.log(`    – of those, MIXED units (unsafe to sum):    ${unitsMixed}`);
  if (STAGE === "loading") console.log(`    – of those, spanning >1 CONTAINER:          ${multiContainer}`);
  console.log(`  qty hidden today, per-file (over-counts dups):${hiddenQtyFile}`);
  console.log(`  qty hidden today, content-deduped (honest):   ${hiddenQtyContent}`);

  console.log(`\n===== EXAMPLES of TRUE multi-receipt (up to ${EXAMPLES}) =====`);
  for (const e of examples) {
    console.log(`\nwaybill ${e.waybill}  customer ${e.customerKey}  phone ${e.phone}  (fileLines ${e.fileLines} -> contentLines ${e.contentLines})`);
    for (const l of e.lines) {
      console.log(`   row ${l.srcRow}  qty=${l.qty}  raw=${JSON.stringify(l.qtyRaw)}  unit=${l.qtyUnit}  date=${dstr(l.eventDate)}  [${l.file}]`);
    }
  }

  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });

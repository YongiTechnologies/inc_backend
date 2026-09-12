/**
 * Migration: build the two-layer Parcel model from the original spreadsheets.
 *
 * Because every source file was kept, the cleanest migration is to re-ingest
 * the files — this reconstructs full-fidelity observations and derives parcels,
 * with no lossy backfill from the old ShipmentItem records. It writes ONLY the
 * new collections (SourceFile / Observation / Parcel); ShipmentItem is left
 * untouched so the current app keeps working until reads are cut over.
 *
 * Usage:
 *   node src/scripts/migrate-to-parcels.js --ingest <dir>   # ingest every .xlsx/.xls in <dir> (recursive)
 *   node src/scripts/migrate-to-parcels.js --rebuild        # re-derive all parcels from existing observations
 *   node src/scripts/migrate-to-parcels.js --diff           # read-only: compare Parcel coverage vs ShipmentItem
 *
 * Options: --dry-run (ingest: parse & report only, write nothing)
 *
 * Safe to re-run: files are de-duplicated by content hash; derivation is
 * idempotent. Run against a staging database first and take a backup.
 */

require("dotenv").config();
const mongoose = require("mongoose");
const dns      = require("dns");
const fs       = require("fs");
const path     = require("path");

if (process.env.DNS_SERVERS) {
  dns.setServers(process.env.DNS_SERVERS.split(",").map((s) => s.trim()).filter(Boolean));
}

const { connectDB } = require("../config/db");
const ingest        = require("../services/ingest.service");
const { buildObservations } = require("../services/observations");
const Parcel        = require("../models/Parcel");
const ShipmentItem  = require("../models/ShipmentItem");

const args    = process.argv.slice(2);
const has     = (f) => args.includes(f);
const valueOf = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : null; };
const dryRun  = has("--dry-run");

function walk(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(p));
    else if (/\.(xlsx|xls)$/i.test(entry.name)) out.push(p);
  }
  return out;
}

async function doIngest(dir) {
  const files = walk(dir);
  console.log(`Found ${files.length} spreadsheet(s) under ${dir}\n`);
  let ok = 0, dupes = 0, failed = 0, obs = 0;
  for (const file of files) {
    const name = path.basename(file);
    try {
      if (dryRun) {
        const built = buildObservations(fs.readFileSync(file), { filename: name });
        console.log(`  [dry] ${name.padEnd(40)} stage=${built.stage} rows=${built.observations.length} skipped=${built.skippedRows.length}`);
        obs += built.observations.length;
        continue;
      }
      const r = await ingest.ingestFile(fs.readFileSync(file), { filename: name });
      obs += r.observationsInserted;
      ok++;
      console.log(`  ✓ ${name.padEnd(40)} stage=${r.stage} +${r.observationsInserted} obs → ${r.parcelsWritten} parcels`);
    } catch (err) {
      if (err instanceof ingest.DuplicateFileError) { dupes++; console.log(`  = ${name.padEnd(40)} already ingested`); }
      else { failed++; console.log(`  ✗ ${name.padEnd(40)} ${err.message}`); }
    }
  }
  console.log(`\nDone. ${ok} ingested, ${dupes} duplicates, ${failed} failed, ${obs} observations.`);
}

async function doDiff() {
  const parcels = await Parcel.countDocuments({});
  const items   = await ShipmentItem.countDocuments({});
  const parcelWaybills = new Set(await Parcel.distinct("waybill"));
  const itemWaybills   = new Set((await ShipmentItem.distinct("waybillNo")).filter(Boolean));

  const inItemsNotParcels = [...itemWaybills].filter((w) => !parcelWaybills.has(w));
  const inParcelsNotItems = [...parcelWaybills].filter((w) => !itemWaybills.has(w));

  console.log("─────────── PARCEL vs SHIPMENTITEM ───────────");
  console.log("Parcels:                    ", parcels);
  console.log("ShipmentItems:              ", items);
  console.log("Distinct waybills (parcels):", parcelWaybills.size);
  console.log("Distinct waybills (items):  ", itemWaybills.size);
  console.log("In items but NOT parcels:   ", inItemsNotParcels.length, "(files for these may not have been ingested)");
  console.log("In parcels but NOT items:   ", inParcelsNotItems.length, "(new model recovered these)");
  console.log("\nReconciliation (parcels):");
  for (const [label, filter] of [
    ["received, not loaded",   { "flags.receivedNotLoaded": true }],
    ["loaded, intake missing", { "flags.loadedNeverReceived": true }],
    ["needs phone",            { "flags.needsPhone": true }],
    ["qty mismatch",           { "flags.qtyMismatch": true }],
  ]) console.log(`  ${label.padEnd(24)} ${await Parcel.countDocuments(filter)}`);
}

(async () => {
  await connectDB();
  try {
    if (has("--ingest")) {
      const dir = valueOf("--ingest");
      if (!dir || !fs.existsSync(dir)) throw new Error("--ingest requires an existing directory path");
      await doIngest(dir);
      if (!dryRun) { console.log("\nRe-deriving all parcels…"); console.log(await ingest.rebuildAll()); }
    } else if (has("--rebuild")) {
      console.log("Rebuilding all parcels from existing observations…");
      console.log(await ingest.rebuildAll());
    } else if (has("--diff")) {
      await doDiff();
    } else {
      console.log("Nothing to do. Pass --ingest <dir>, --rebuild, or --diff.");
    }
  } catch (err) {
    console.error("Migration error:", err.message);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();

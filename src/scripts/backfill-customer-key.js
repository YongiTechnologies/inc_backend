/**
 * Backfill: customerKey / shippingMark / needsPhone on existing ShipmentItems
 *
 * Records created before composite identity existed have no customerKey, so
 * every upload matcher and every public lookup would treat them as unidentified.
 * This derives the key from what each record already holds.
 *
 * It also recovers shipping marks: the sheet parser used to run the CONTACT
 * column through normalisePhone alone, which returns null for a value like
 * "ACC-28672", so the mark was dropped and the row left with no identifier at
 * all. Those values survive in customerPhoneRaw and are promoted here.
 *
 * Usage:
 *   node src/scripts/backfill-customer-key.js            # apply
 *   node src/scripts/backfill-customer-key.js --dry-run  # report only
 *
 * IMPORTANT:
 * - Run on a staging database first
 * - Back up your database before running
 * - Safe to re-run: records already carrying a customerKey are skipped unless
 *   --force is passed
 */

require("dotenv").config();
const mongoose = require("mongoose");
const dns      = require("dns");
const fs       = require("fs");

// A mongodb+srv:// URI needs an SRV lookup, which Node performs through c-ares
// using dns.getServers() — not the OS resolver that ping and nslookup use. On a
// machine whose resolver list is a loopback address with nothing listening on
// it, that fails with "querySrv ECONNREFUSED" while every other name on the
// system resolves normally. Setting DNS_SERVERS routes the lookup elsewhere
// without touching the machine's network configuration:
//
//   DNS_SERVERS=8.8.8.8,1.1.1.1 npm run backfill-customer-key -- --dry-run
if (process.env.DNS_SERVERS) {
  const servers = process.env.DNS_SERVERS.split(",").map((s) => s.trim()).filter(Boolean);
  dns.setServers(servers);
  console.log(`DNS servers overridden: ${servers.join(", ")}`);
}

const ShipmentItem = require("../models/ShipmentItem");
const { resolveContact, buildCustomerKey } = require("../services/batch.service");
// Reuse the app's own connector rather than repeating the URI/dbName defaults.
// A script that defaulted to a different database name would connect to an
// empty one and report "0 records" — a silent no-op that looks like success.
const { connectDB } = require("../config/db");

const DRY_RUN = process.argv.includes("--dry-run");
const FORCE   = process.argv.includes("--force");
const NO_BACKUP = process.argv.includes("--no-backup");

// Fields this script can write. Only these are captured for the revert file,
// which keeps it small enough to be practical on a 15k-record collection.
const TOUCHED_FIELDS = [
  "customerPhone", "customerPhoneRaw", "customerKey",
  "shippingMark", "shippingMarkRaw", "needsPhone",
];

/**
 * Write the current value of every field this script may overwrite, so the run
 * can be undone. Atlas shared tiers have no snapshots, so without this a real
 * run would be irreversible.
 */
async function writeBackup(filter) {
  const file = `backfill-backup-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const rows = await ShipmentItem.find(filter)
    .select(["_id", ...TOUCHED_FIELDS].join(" "))
    .lean();

  fs.writeFileSync(file, JSON.stringify({
    takenAt:   new Date().toISOString(),
    database:  mongoose.connection.name,
    fields:    TOUCHED_FIELDS,
    count:     rows.length,
    records:   rows,
  }));

  const kb = Math.round(fs.statSync(file).size / 1024);
  console.log(`backup written: ${file}  (${rows.length} records, ${kb} KB)`);
  console.log(`  to undo:  npm run backfill-customer-key -- --revert ${file}\n`);
  return file;
}

/** Restore the captured fields exactly as they were before the run. */
async function revert(file) {
  const snapshot = JSON.parse(fs.readFileSync(file, "utf8"));
  console.log(`reverting ${snapshot.count} record(s) captured ${snapshot.takenAt}`);

  const ops = snapshot.records.map((r) => {
    const set = {};
    const unset = {};
    for (const f of snapshot.fields) {
      if (r[f] === undefined) unset[f] = "";
      else set[f] = r[f];
    }
    const update = {};
    if (Object.keys(set).length)   update.$set   = set;
    if (Object.keys(unset).length) update.$unset = unset;
    return { updateOne: { filter: { _id: r._id }, update } };
  });

  for (let i = 0; i < ops.length; i += 1000) {
    await ShipmentItem.bulkWrite(ops.slice(i, i + 1000), { ordered: false });
  }
  console.log(`reverted ${ops.length} record(s).`);
}

async function main() {
  await connectDB();
  // Print exactly which database is about to be rewritten. This is normally
  // run against production, so the target should never be a guess.
  console.log(`host: ${mongoose.connection.host}`);
  console.log(`database: ${mongoose.connection.name}`);
  const revertArg = process.argv.indexOf("--revert");
  if (revertArg !== -1) {
    const file = process.argv[revertArg + 1];
    if (!file) throw new Error("--revert needs a backup file path");
    await revert(file);
    await mongoose.disconnect();
    return;
  }

  console.log(DRY_RUN ? "DRY RUN — nothing will be written\n" : "APPLYING CHANGES\n");

  const filter = FORCE ? {} : { $or: [{ customerKey: null }, { customerKey: { $exists: false } }] };
  const total  = await ShipmentItem.countDocuments(filter);
  console.log(`${total} record(s) to process\n`);

  // Captured before anything is written, so a real run is always undoable.
  if (!DRY_RUN && !NO_BACKUP && total > 0) await writeBackup(filter);

  const stats = { phone: 0, mark: 0, name: 0, row: 0, markRecovered: 0, unchanged: 0, written: 0 };
  const ops = [];
  let scanned = 0;
  // Shared tracking numbers are counted from the keys derived during this scan,
  // not from a query afterwards. On a dry run nothing has been written yet, so
  // grouping by the stored customerKey would lump every record into one null
  // group and report zero shared numbers however many there really are.
  const keysByWaybill = new Map();

  const cursor = ShipmentItem.find(filter)
    .select("_id waybillNo customerPhone customerPhoneRaw customerName shippingMark customerKey needsPhone")
    .lean()
    .cursor();

  for await (const doc of cursor) {
    scanned++;

    // Re-resolve from the original cell so a mark that normalisePhone discarded
    // is recovered. Fall back to the stored phone when no raw value was kept.
    const contact = doc.customerPhoneRaw
      ? resolveContact(doc.customerPhoneRaw)
      : {
          customerPhone: doc.customerPhone || null,
          shippingMark:  doc.shippingMark  || null,
          needsPhone:    !doc.customerPhone,
        };

    // Never drop a phone already on the record.
    if (!contact.customerPhone && doc.customerPhone) {
      contact.customerPhone = doc.customerPhone;
      contact.needsPhone    = false;
    }
    if (!contact.shippingMark && doc.shippingMark) contact.shippingMark = doc.shippingMark;

    const customerKey = buildCustomerKey(
      { ...contact, customerName: doc.customerName },
      // Stable per record, so a re-run produces the same key.
      String(doc._id).slice(-6),
    );

    const set = {
      customerKey,
      needsPhone: !contact.customerPhone,
    };
    if (contact.shippingMark && contact.shippingMark !== doc.shippingMark) {
      set.shippingMark    = contact.shippingMark;
      set.shippingMarkRaw = doc.customerPhoneRaw || null;
      stats.markRecovered++;
    }
    if (contact.customerPhone && contact.customerPhone !== doc.customerPhone) {
      set.customerPhone = contact.customerPhone;
    }

    stats[customerKey[0] === "p" ? "phone" : customerKey[0] === "m" ? "mark" : customerKey[0] === "n" ? "name" : "row"]++;

    if (!keysByWaybill.has(doc.waybillNo)) keysByWaybill.set(doc.waybillNo, new Set());
    keysByWaybill.get(doc.waybillNo).add(customerKey);

    if (doc.customerKey === customerKey && doc.needsPhone === set.needsPhone && Object.keys(set).length === 2) {
      stats.unchanged++;
    } else {
      ops.push({ updateOne: { filter: { _id: doc._id }, update: { $set: set } } });
    }

    if (ops.length >= 1000) {
      if (!DRY_RUN) await ShipmentItem.bulkWrite(ops, { ordered: false });
      stats.written += ops.length;
      ops.length = 0;
      process.stdout.write(`  ...${scanned}/${total}\r`);
    }
  }

  if (ops.length) {
    if (!DRY_RUN) await ShipmentItem.bulkWrite(ops, { ordered: false });
    stats.written += ops.length;
  }

  console.log(`\nscanned .................. ${scanned}`);
  console.log(`keyed by phone ........... ${stats.phone}`);
  console.log(`keyed by shipping mark ... ${stats.mark}`);
  console.log(`keyed by name ............ ${stats.name}`);
  console.log(`keyed by record id ....... ${stats.row}   <- no identifier at all`);
  console.log(`shipping marks recovered . ${stats.markRecovered}`);
  console.log(`already correct .......... ${stats.unchanged}`);
  console.log(`${DRY_RUN ? "would write" : "written"} .............. ${stats.written}`);

  // The shared tracking numbers that motivated all this — the ones that were
  // silently collapsing into a single record before.
  const shared = [...keysByWaybill.entries()].filter(([, keys]) => keys.size > 1);
  console.log(`\ntracking numbers shared by >1 customer: ${shared.length}`);
  if (shared.length) {
    const worst = shared.sort((a, b) => b[1].size - a[1].size).slice(0, 10);
    console.log("  largest:");
    for (const [waybill, keys] of worst) {
      console.log(`    ${waybill.padEnd(20)} ${keys.size} customers`);
    }
    const recovered = shared.reduce((sum, [, keys]) => sum + keys.size - 1, 0);
    console.log(`  ${recovered} record(s) that the old code would have dropped or overwritten`);
  }

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("Backfill failed:", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});

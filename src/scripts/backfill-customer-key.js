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

const ShipmentItem = require("../models/ShipmentItem");
const { resolveContact, buildCustomerKey } = require("../services/batch.service");

const DB_URI  = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || "ghana_logistics";

const DRY_RUN = process.argv.includes("--dry-run");
const FORCE   = process.argv.includes("--force");

async function main() {
  if (!DB_URI) {
    console.error("MONGODB_URI is not set. Aborting.");
    process.exit(1);
  }

  await mongoose.connect(DB_URI, { dbName: DB_NAME });
  console.log(`Connected to ${DB_NAME}${DRY_RUN ? "  (DRY RUN — nothing will be written)" : ""}`);

  const filter = FORCE ? {} : { $or: [{ customerKey: null }, { customerKey: { $exists: false } }] };
  const total  = await ShipmentItem.countDocuments(filter);
  console.log(`${total} record(s) to process\n`);

  const stats = { phone: 0, mark: 0, name: 0, row: 0, markRecovered: 0, unchanged: 0, written: 0 };
  const ops = [];
  let scanned = 0;

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

  // Report the shared tracking numbers that motivated all this, so staff can
  // see which ones now hold more than one customer.
  const shared = await ShipmentItem.aggregate([
    { $group: { _id: "$waybillNo", keys: { $addToSet: "$customerKey" } } },
    { $project: { n: { $size: "$keys" } } },
    { $match: { n: { $gt: 1 } } },
    { $count: "total" },
  ]);
  console.log(`\ntracking numbers shared by >1 customer: ${shared[0]?.total || 0}`);

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error("Backfill failed:", err);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});

/**
 * One-time migration: backfill customerName for ShipmentItems where the name
 * is null but another item with the same customerPhone has a name.
 *
 * This fixes records that were imported from Excel sheets where the customer
 * name was only written on the first row for a given phone number.
 *
 * Run once:
 *   node scripts/backfill-customer-names.js
 */

require("dotenv").config();
const mongoose = require("mongoose");
const ShipmentItem = require("../src/models/ShipmentItem");

async function run() {
  await mongoose.connect(process.env.MONGODB_URI, {
    dbName: process.env.DB_NAME || "inc_logistics",
  });
  console.log("Connected to MongoDB");

  // 1. Build a phone → name map from all items that have a name
  const named = await ShipmentItem.find(
    { customerPhone: { $ne: null }, customerName: { $ne: null, $ne: "" } },
    { customerPhone: 1, customerName: 1 }
  ).lean();

  const nameByPhone = {};
  for (const item of named) {
    if (item.customerPhone && item.customerName && !nameByPhone[item.customerPhone]) {
      nameByPhone[item.customerPhone] = item.customerName;
    }
  }

  console.log(`Found names for ${Object.keys(nameByPhone).length} distinct phone numbers`);

  // 2. Find all items missing a name but with a known phone
  const missing = await ShipmentItem.find(
    {
      customerPhone: { $in: Object.keys(nameByPhone) },
      $or: [{ customerName: null }, { customerName: "" }, { customerName: { $exists: false } }],
    },
    { _id: 1, customerPhone: 1, waybillNo: 1 }
  ).lean();

  if (missing.length === 0) {
    console.log("No records to update. All done.");
    await mongoose.disconnect();
    return;
  }

  console.log(`Updating ${missing.length} records...`);

  // 3. Bulk update
  const ops = missing.map((item) => ({
    updateOne: {
      filter: { _id: item._id },
      update: { $set: { customerName: nameByPhone[item.customerPhone] } },
    },
  }));

  const result = await ShipmentItem.bulkWrite(ops, { ordered: false });
  console.log(`Done. Modified: ${result.modifiedCount} records.`);

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});

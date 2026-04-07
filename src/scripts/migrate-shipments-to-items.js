/**
 * Migration Script: Shipment → ShipmentItem
 *
 * This script migrates all existing Shipment records (with their TrackingEvents)
 * to the unified ShipmentItem model.
 *
 * Usage:
 *   npm run migrate-shipments
 *
 * Or directly:
 *   node src/scripts/migrate-shipments-to-items.js
 *
 * IMPORTANT:
 * - Run on a staging database first
 * - Backup your database before running
 * - This script does NOT delete old Shipment/TrackingEvent records (safe migration)
 */

require("dotenv").config();
const mongoose = require("mongoose");
const Shipment = require("../models/Shipment");
const TrackingEvent = require("../models/TrackingEvent");
const ShipmentItem = require("../models/ShipmentItem");
const User = require("../models/User");

// Connect to database
const DB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || "ghana_logistics";

async function connect() {
  await mongoose.connect(DB_URI, { dbName: DB_NAME });
  console.log(`Connected to MongoDB: ${DB_URI}`);
}

async function disconnect() {
  await mongoose.connection.close();
  console.log("Disconnected from MongoDB");
}

/**
 * Map Shipment status to stage name for stageHistory
 */
function mapStatusToStage(status) {
  const stageMap = {
    pending: 'pending',
    picked_up: 'in_transit',
    in_transit: 'in_transit',
    customs: 'customs',
    out_for_delivery: 'out_for_delivery',
    delivered: 'delivered',
    failed: 'failed',
    returned: 'returned',
  };
  return stageMap[status] || 'pending';
}

/**
 * Migrate a single Shipment + its TrackingEvents to ShipmentItem
 */
async function migrateShipment(shipment, events) {
  // Build stageHistory from TrackingEvents
  const stageHistory = events.map(event => ({
    stage: mapStatusToStage(event.status),
    status: event.status,
    updatedAt: event.timestamp,
    note: event.note || null,
    location: event.location || null,
    internalNote: event.internalNote || null,
    carrier: event.carrier || null,
    carrierReference: event.carrierReference || null,
    updatedBy: event.updatedBy || null,
  }));

  // Get customer phone if available
  let customerPhone = null;
  if (shipment.customerId) {
    const user = await User.findById(shipment.customerId).select('phone').lean();
    if (user && user.phone) {
      // Normalize phone number
      const digits = String(user.phone).replace(/\D/g, "").trim();
      if (digits.startsWith('233')) {
        customerPhone = digits;
      } else if (digits.startsWith('0')) {
        customerPhone = '233' + digits.slice(1);
      } else if (digits.length === 9) {
        customerPhone = '233' + digits;
      } else {
        customerPhone = digits;
      }
    }
  }

  // Create ShipmentItem
  const itemData = {
    // Core identifiers
    waybillNo: shipment.trackingNumber,
    migratedFrom: 'Shipment',

    // Customer
    customerId: shipment.customerId,
    customerPhone,

    // Route / Logistics
    origin: shipment.origin,
    destination: shipment.destination,
    destinationCity: shipment.destination?.city,

    // Cargo details
    description: shipment.description,
    productDescription: shipment.description,
    packageType: shipment.packageType,
    weight: shipment.weight,
    dimensions: shipment.dimensions,
    quantity: shipment.quantity,
    declaredValue: shipment.declaredValue,

    // Status
    status: shipment.status,

    // Dates
    estimatedDelivery: shipment.estimatedDelivery,
    deliveredAt: shipment.deliveredAt,

    // Proof of delivery
    deliveryPhoto: shipment.deliveryPhoto,
    deliverySignature: shipment.deliverySignature,

    // Staff fields
    assignedTo: shipment.assignedTo,
    specialInstructions: shipment.specialInstructions,

    // Flags
    requiresCustoms: shipment.requiresCustoms,
    isFragile: shipment.isFragile,

    // History
    stageHistory,
  };

  const item = await ShipmentItem.create(itemData);
  return item;
}

/**
 * Main migration function
 */
async function migrate() {
  console.log("Starting migration: Shipment → ShipmentItem\n");

  // Get counts before migration
  const shipmentCount = await Shipment.countDocuments();
  const eventCount = await TrackingEvent.countDocuments();
  const existingItemCount = await ShipmentItem.countDocuments();

  console.log(`Before migration:`);
  console.log(`  - Shipments: ${shipmentCount}`);
  console.log(`  - TrackingEvents: ${eventCount}`);
  console.log(`  - Existing ShipmentItems: ${existingItemCount}`);
  console.log();

  if (shipmentCount === 0) {
    console.log("No Shipments to migrate. Exiting.");
    return;
  }

  // Fetch all shipments with their customer data
  const shipments = await Shipment.find().populate('customerId').lean();

  let migrated = 0;
  let failed = 0;
  const errors = [];

  for (const shipment of shipments) {
    try {
      // Check if already migrated (waybillNo matches trackingNumber)
      const existing = await ShipmentItem.findOne({ waybillNo: shipment.trackingNumber });
      if (existing) {
        console.log(`SKIP: ${shipment.trackingNumber} (already exists)`);
        continue;
      }

      // Get all tracking events for this shipment
      const events = await TrackingEvent.find({
        shipmentId: shipment._id
      }).sort({ timestamp: 1 }).lean();

      // Migrate
      await migrateShipment(shipment, events);

      migrated++;
      console.log(`OK: ${shipment.trackingNumber} (${events.length} events)`);
    } catch (err) {
      failed++;
      errors.push({ trackingNumber: shipment.trackingNumber, error: err.message });
      console.error(`FAIL: ${shipment.trackingNumber} - ${err.message}`);
    }
  }

  console.log();
  console.log("Migration Summary:");
  console.log(`  - Migrated: ${migrated}`);
  console.log(`  - Failed: ${failed}`);
  console.log(`  - Skipped: ${shipments.length - migrated - failed}`);

  if (errors.length > 0) {
    console.log();
    console.log("Errors:");
    errors.forEach(e => console.log(`  - ${e.trackingNumber}: ${e.error}`));
  }

  // Verify counts
  const newItemCount = await ShipmentItem.countDocuments();
  const expectedItemCount = existingItemCount + migrated;

  console.log();
  console.log("Verification:");
  console.log(`  - Expected ShipmentItems: ${expectedItemCount}`);
  console.log(`  - Actual ShipmentItems: ${newItemCount}`);
  console.log(`  - Match: ${newItemCount === expectedItemCount ? 'YES' : 'NO'}`);

  console.log();
  console.log("Migration complete!");
  console.log();
  console.log("NEXT STEPS:");
  console.log("1. Verify data in MongoDB Compass or shell");
  console.log("2. Test public tracking with migrated waybill numbers");
  console.log("3. Test customer phone lookup");
  console.log("4. Once verified, you can optionally delete old Shipment/TrackingEvent records");
}

// Run migration
connect()
  .then(() => migrate())
  .catch(err => {
    console.error("Migration failed:", err);
    process.exit(1);
  })
  .finally(() => {
    disconnect();
    process.exit(0);
  });

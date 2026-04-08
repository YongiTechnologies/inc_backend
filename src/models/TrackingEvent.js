const mongoose = require("mongoose");

// ─── DEPRECATED ──────────────────────────────────────────────────────────────
// This model is deprecated. All new development should use ShipmentItem.stageHistory.
// Existing data should be migrated using: scripts/migrate-shipments-to-items.js
// TODO: Remove this model after migration is complete and verified.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * TrackingEvent — immutable append-only log of every checkpoint.
 * Never delete, only append. Source of truth for the shipment timeline.
 * DEPRECATED: Use ShipmentItem.stageHistory instead.
 */
const trackingEventSchema = new mongoose.Schema({
  shipmentId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "Shipment",
    required: true,
    index: true,
  },
  updatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: "User",
    required: true,
  },

  status: {
    type: String,
    enum: [
      "pending",
      "picked_up",
      "in_transit",
      "customs",
      "out_for_delivery",
      "delivered",
      "failed",
      "returned",
    ],
    required: true,
  },

  location: {
    address: { type: String, required: true },
    city:    { type: String, required: true },
    country: { type: String, required: true },
    coordinates: [Number], // [lng, lat]
  },

  note:         { type: String }, // customer-visible
  internalNote: { type: String }, // staff-only

  // For multi-carrier international routes
  carrier:          { type: String }, // e.g. "China Post", "Ethiopian Airlines Cargo"
  carrierReference: { type: String }, // external tracking number for this leg

  timestamp: { type: Date, default: Date.now, index: true },
});

// Compound index for fast timeline queries
trackingEventSchema.index({ shipmentId: 1, timestamp: -1 });

module.exports = mongoose.model("TrackingEvent", trackingEventSchema);

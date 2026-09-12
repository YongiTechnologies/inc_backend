const mongoose = require("mongoose");

/**
 * ManualAdjustment — staff-entered facts that live nowhere in a spreadsheet.
 *
 * Treated as just another observation type so the "everything is an
 * observation" model holds: keyed by (waybill, customerKey) and overlaid on top
 * of the file-derived Parcel after each re-derivation, so re-ingesting sheets
 * never clobbers a human correction (a fixed phone, a hold, proof of delivery).
 * Only the fields a staff member actually set are applied.
 */
const manualAdjustmentSchema = new mongoose.Schema(
  {
    waybill:     { type: String, required: true, index: true },
    customerKey: { type: String, required: true },

    // Any subset of these may be set; nulls/undefined are ignored on overlay.
    customerPhone:       { type: String },   // staff supplies a missing phone
    statusOverride:      { type: String },   // e.g. "held", "ready_for_pickup", "delivered"
    heldReason:          { type: String },
    assignedTo:          { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    staffNotes:          { type: String },
    specialInstructions: { type: String },
    deliveryPhoto:       { type: String },
    deliverySignature:   { type: String },
    deliveredAt:         { type: Date },

    createdBy:   { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

manualAdjustmentSchema.index({ waybill: 1, customerKey: 1 });

module.exports = mongoose.model("ManualAdjustment", manualAdjustmentSchema);

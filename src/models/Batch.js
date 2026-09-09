const mongoose = require("mongoose");

const containerRefSchema = new mongoose.Schema(
  {
    code: { type: String }, // packing list number or container code
    id:   { type: String }, // container number e.g. "MSBU7337022"
    date: { type: Date },   // loading date
  },
  { _id: false }
);

const batchSchema = new mongoose.Schema(
  {
    batchCode:      { type: String, required: true, index: true },
    label:          { type: String }, // optional friendly name shown instead of batchCode
    stage:          { type: String, enum: ["intake", "shipped", "arrived"], required: true },
    uploadedBy:     { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    containerRefs:  [containerRefSchema], // container details for shipped batches
    totalItems:     { type: Number, default: 0 },
    newItems:       { type: Number, default: 0 },
    matchedItems:   { type: Number, default: 0 },
    heldItems:      { type: Number, default: 0 },
    // Intake parcels still in_warehouse this packing list did not claim
    // (shipped batches only) — a read-only count for staff review.
    unclaimedIntake: { type: Number, default: 0 },
    skippedRows:    [Number],
    notes:          { type: String }, // BL, seal, ETD, ETA stored here
    // Original uploaded filename — batchCode is a derived code, not something
    // staff typed, so this is what "search for the file I uploaded" needs.
    sourceFilename: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Batch", batchSchema);

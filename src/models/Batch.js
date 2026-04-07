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
    batchCode:     { type: String, required: true, index: true },
    stage:         { type: String, enum: ["intake", "shipped"], required: true },
    uploadedBy:    { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    containerRefs: [containerRefSchema], // container details for shipped batches
    totalItems:    { type: Number, default: 0 },
    newItems:      { type: Number, default: 0 },
    matchedItems:  { type: Number, default: 0 },
    heldItems:     { type: Number, default: 0 },
    skippedRows:   [Number],
    notes:         { type: String }, // BL, seal, ETD, ETA stored here
  },
  { timestamps: true }
);

module.exports = mongoose.model("Batch", batchSchema);

const mongoose = require("mongoose");

const containerRefSchema = new mongoose.Schema(
  {
    code: { type: String }, // e.g. "N006"
    id:   { type: String }, // e.g. "MSBU8308501"
    date: { type: Date },
  },
  { _id: false }
);

const batchSchema = new mongoose.Schema(
  {
    batchCode:     { type: String, required: true, index: true },
    stage:         { type: String, enum: ["intake", "shipped", "arrived"], required: true },
    uploadedBy:    { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
    containerRefs: [containerRefSchema],
    totalItems:    { type: Number, default: 0 },
    newItems:      { type: Number, default: 0 },
    matchedItems:  { type: Number, default: 0 },
    heldItems:     { type: Number, default: 0 },
    skippedRows:   [Number],
    notes:         { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Batch", batchSchema);

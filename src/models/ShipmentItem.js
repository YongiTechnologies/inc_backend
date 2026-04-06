const mongoose = require("mongoose");

const stageHistorySchema = new mongoose.Schema(
  {
    stage:     { type: String },
    status:    { type: String },
    batchId:   { type: mongoose.Schema.Types.ObjectId, ref: "Batch" },
    updatedAt: { type: Date, default: Date.now },
    note:      { type: String },
  },
  { _id: false }
);

const shipmentItemSchema = new mongoose.Schema(
  {
    // Core identifiers
    waybillNo:          { type: String, required: true, index: true, uppercase: true, trim: true },
    invoiceNo:          { type: String },

    // Customer
    customerPhone:      { type: String, index: true },   // normalised (233XXXXXXXXX)
    customerPhoneRaw:   { type: String },
    customerId:         { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    customerName:       { type: String },

    // Logistics
    destinationCity:    { type: String },
    quantity:           { type: Number },
    quantityRaw:        { type: String },
    cbm:                { type: Number },
    productDescription: { type: String },
    containerRef:       { type: String },
    fees:               { type: String },

    // Status
    status: {
      type: String,
      enum: ["in_warehouse", "shipped", "arrived", "held"],
      default: "in_warehouse",
    },

    // Batch references
    intakeBatch:   { type: mongoose.Schema.Types.ObjectId, ref: "Batch", default: null },
    shippedBatch:  { type: mongoose.Schema.Types.ObjectId, ref: "Batch", default: null },
    arrivedBatch:  { type: mongoose.Schema.Types.ObjectId, ref: "Batch", default: null },

    // Dates from sheets
    intakeDate:    { type: Date },
    receivingDate: { type: Date },

    // History
    stageHistory:  [stageHistorySchema],

    // Staff fields
    heldReason:    { type: String },
    reassignedTo:  { type: mongoose.Schema.Types.ObjectId, ref: "Batch", default: null },
    staffNotes:    { type: String },
  },
  { timestamps: true }
);

// Compound indexes for common queries
shipmentItemSchema.index({ customerPhone: 1, status: 1 });
shipmentItemSchema.index({ intakeBatch: 1, status: 1 });
shipmentItemSchema.index({ shippedBatch: 1, status: 1 });
shipmentItemSchema.index({ arrivedBatch: 1, status: 1 });
shipmentItemSchema.index({ status: 1, updatedAt: -1 });

module.exports = mongoose.model("ShipmentItem", shipmentItemSchema);

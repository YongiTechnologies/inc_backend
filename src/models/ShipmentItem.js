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
    // ── Core identifiers ──────────────────────────────────────────────────────
    waybillNo:  { type: String, required: true, index: true, uppercase: true, trim: true },
    invoiceNo:  { type: String }, // bag/bundle number from intake sheet

    // ── Customer ──────────────────────────────────────────────────────────────
    customerPhone:    { type: String, index: true }, // normalised: 233XXXXXXXXX
    customerPhoneRaw: { type: String },              // original from sheet
    customerId:       { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    customerName:     { type: String },              // CNEE NAME from packing list

    // ── Logistics ─────────────────────────────────────────────────────────────
    destinationCity:    { type: String },
    goodsType:          { type: String },            // CARTON, CARTONS, etc.
    quantity:           { type: Number },
    quantityRaw:        { type: String },            // original string e.g. "13pallet"
    cbm:                { type: Number },            // cubic metres
    productDescription: { type: String },            // DESCRIPTION from packing list
    containerRef:       { type: String },            // container number e.g. "MSBU7337022"
    remarks:            { type: String },            // e.g. "FORK FEE 100"

    // ── Financial fields (from CTR_INVOICE / packing list) ────────────────────
    freightTerm:   { type: String  }, // COLLECT O/F AMOUNT label e.g. "COLLECT"
    freightAmount: { type: Number  }, // PAYMENT TERM $ value
    loan:          { type: Number  },
    interest:      { type: Number  },
    otherFee:      { type: Number  },
    invoiceAmount: { type: Number  }, // total invoice amount

    // ── Status ────────────────────────────────────────────────────────────────
    // Two stages only: in_warehouse (intake) → shipped (packing list)
    // Items missing from packing list → held
    status: {
      type:    String,
      enum:    ["in_warehouse", "shipped", "held"],
      default: "in_warehouse",
    },

    // ── Batch references ──────────────────────────────────────────────────────
    intakeBatch:  { type: mongoose.Schema.Types.ObjectId, ref: "Batch", default: null },
    shippedBatch: { type: mongoose.Schema.Types.ObjectId, ref: "Batch", default: null },

    // ── Dates ─────────────────────────────────────────────────────────────────
    intakeDate:    { type: Date }, // date from intake sheet
    receivingDate: { type: Date }, // LOADING DATE from packing list

    // ── History ───────────────────────────────────────────────────────────────
    stageHistory: [stageHistorySchema],

    // ── Staff-managed fields ──────────────────────────────────────────────────
    heldReason:   { type: String },
    reassignedTo: { type: mongoose.Schema.Types.ObjectId, ref: "Batch", default: null },
    staffNotes:   { type: String }, // internal only — never returned to customers
  },
  { timestamps: true }
);

// Compound indexes for common queries
shipmentItemSchema.index({ customerPhone: 1, status: 1 });
shipmentItemSchema.index({ intakeBatch:  1, status: 1 });
shipmentItemSchema.index({ shippedBatch: 1, status: 1 });
shipmentItemSchema.index({ status: 1, updatedAt: -1 });

module.exports = mongoose.model("ShipmentItem", shipmentItemSchema);

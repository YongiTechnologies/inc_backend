const mongoose = require("mongoose");

const locationSchema = new mongoose.Schema(
  {
    address: { type: String, required: true },
    city:    { type: String, required: true },
    country: { type: String, required: true },
    coordinates: { type: [Number] }, // [lng, lat] — optional, for map display
  },
  { _id: false }
);

const stageHistorySchema = new mongoose.Schema(
  {
    stage:     { type: String },
    status:    { type: String },
    batchId:   { type: mongoose.Schema.Types.ObjectId, ref: "Batch" },
    updatedAt: { type: Date, default: Date.now },
    note:      { type: String },
    // Extended fields for full tracking timeline (migrated from TrackingEvent)
    location:        { type: locationSchema },
    internalNote:    { type: String },
    carrier:         { type: String },
    carrierReference:{ type: String },
    updatedBy:       { type: mongoose.Schema.Types.ObjectId, ref: "User" },
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

    // ── Route / Logistics ─────────────────────────────────────────────────────
    // Full origin/destination (for traditional shipments)
    origin:           { type: locationSchema },
    destination:      { type: locationSchema },
    destinationCity:  { type: String },            // From batch workflow (packing list)

    // Cargo details
    goodsType:        { type: String },            // CARTON, CARTONS, etc. (batch)
    quantity:         { type: Number },
    quantityRaw:      { type: String },            // original string e.g. "13pallet"
    cbm:              { type: Number },            // cubic metres (batch)
    productDescription: { type: String },          // DESCRIPTION from packing list
    containerRef:     { type: String },            // container number e.g. "MSBU7337022"
    remarks:          { type: String },            // e.g. "FORK FEE 100"

    // Traditional shipment fields (from Shipment model)
    description:      { type: String },            // General description
    packageType:      { type: String, enum: ["document", "parcel", "pallet", "container"], default: "parcel" },
    weight:           { type: Number },            // kg
    dimensions:       { length: Number, width: Number, height: Number }, // cm
    declaredValue:    { type: Number },            // USD

    // ── Financial fields (from CTR_INVOICE / packing list) ────────────────────
    freightTerm:   { type: String  }, // COLLECT O/F AMOUNT label e.g. "COLLECT"
    freightAmount: { type: Number  }, // PAYMENT TERM $ value
    loan:          { type: Number  },
    interest:      { type: Number  },
    otherFee:      { type: Number  },
    invoiceAmount: { type: Number  }, // total invoice amount

    // ── Status ────────────────────────────────────────────────────────────────
    // Full shipment lifecycle — supports both batch workflow and traditional flow
    // Batch workflow: in_warehouse → shipped → (optional: pending → ... → delivered)
    // Traditional: pending → picked_up → in_transit → customs → out_for_delivery → delivered
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
        "in_warehouse",
        "shipped",
        "held",
      ],
      default: "in_warehouse",
    },

    // ── Dates ─────────────────────────────────────────────────────────────────
    intakeDate:         { type: Date }, // date from intake sheet (batch)
    receivingDate:      { type: Date }, // LOADING DATE from packing list (batch)
    estimatedDelivery:  { type: Date }, // Traditional shipment ETA
    deliveredAt:        { type: Date }, // When actually delivered

    // ── Proof of delivery ─────────────────────────────────────────────────────
    deliveryPhoto:      { type: String }, // URL to photo
    deliverySignature:  { type: String }, // URL to signature

    // ── Batch references ──────────────────────────────────────────────────────
    intakeBatch:  { type: mongoose.Schema.Types.ObjectId, ref: "Batch", default: null },
    shippedBatch: { type: mongoose.Schema.Types.ObjectId, ref: "Batch", default: null },

    // ── Staff-managed fields ──────────────────────────────────────────────────
    heldReason:         { type: String },
    reassignedTo:       { type: mongoose.Schema.Types.ObjectId, ref: "Batch", default: null },
    assignedTo:         { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null }, // Staff assigned to handle
    staffNotes:         { type: String }, // internal only — never returned to customers
    specialInstructions:{ type: String }, // Special delivery instructions

    // ── Flags ─────────────────────────────────────────────────────────────────
    requiresCustoms:    { type: Boolean, default: false },
    isFragile:          { type: Boolean, default: false },

    // ── History ───────────────────────────────────────────────────────────────
    stageHistory: [stageHistorySchema],

    // ── Migration tracking ────────────────────────────────────────────────────
    migratedFrom:       { type: String, enum: ["Shipment", "manual", "excel"], default: "excel" },
  },
  { timestamps: true }
);

// Indexes for common queries
shipmentItemSchema.index({ customerPhone: 1, status: 1 });
shipmentItemSchema.index({ intakeBatch:  1, status: 1 });
shipmentItemSchema.index({ shippedBatch: 1, status: 1 });
shipmentItemSchema.index({ status: 1, updatedAt: -1 });
shipmentItemSchema.index({ waybillNo: 1 }); // Fast lookup by tracking number
shipmentItemSchema.index({ customerId: 1, createdAt: -1 }); // Customer's items
shipmentItemSchema.index({ "destination.city": 1 });

module.exports = mongoose.model("ShipmentItem", shipmentItemSchema);

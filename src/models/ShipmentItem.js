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

    // Shipping mark — the customer's identifier on sheets that carry no phone
    // (e.g. "ACC-28672", "ANGIE"). Staff write it in the same CONTACT column as
    // the phone, so one cell yields either a phone or a mark, never both.
    shippingMark:     { type: String, index: true }, // normalised: A-Z0-9 only
    shippingMarkRaw:  { type: String },              // original from sheet

    // Identity of the customer *within* a waybill. A single tracking number is
    // routinely shared by several customers on a consolidated shipment, so
    // waybillNo alone does not identify a parcel — (waybillNo, customerKey)
    // does. Resolved from phone → mark → name → row; see buildCustomerKey in
    // services/batch.service.js.
    customerKey:      { type: String, index: true },

    // Set when no phone could be resolved from the sheet. Drives the staff
    // "needs a phone number" worklist so the gap can be filled in manually.
    needsPhone:       { type: Boolean, default: false },

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
    // Batch workflow: in_warehouse → shipped → at_port → customs → ready_for_pickup
    // Traditional: pending → picked_up → in_transit → customs → out_for_delivery → delivered
    //
    // at_port and ready_for_pickup mirror the ContainerLoading lifecycle so a
    // container status change maps 1:1 onto the shipments loaded in it — see
    // CONTAINER_TO_ITEM_STATUS in services/logistics.service.js.
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
        "at_port",
        "ready_for_pickup",
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
    intakeBatch:   { type: mongoose.Schema.Types.ObjectId, ref: "Batch", default: null },
    shippedBatch:  { type: mongoose.Schema.Types.ObjectId, ref: "Batch", default: null },
    arrivedBatch:  { type: mongoose.Schema.Types.ObjectId, ref: "Batch", default: null },

    // ── Arrival ───────────────────────────────────────────────────────────────
    arrivalDate:   { type: Date }, // actual arrival date at Ghana port

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
shipmentItemSchema.index({ shippedBatch:  1, status: 1 });
shipmentItemSchema.index({ arrivedBatch:  1, status: 1 });
shipmentItemSchema.index({ status: 1, updatedAt: -1 });
shipmentItemSchema.index({ waybillNo: 1 }); // Fast lookup by tracking number
// A waybill shared across customers is identified by this pair, not by
// waybillNo alone — every upload matcher looks the item up on both fields.
shipmentItemSchema.index({ waybillNo: 1, customerKey: 1 });
shipmentItemSchema.index({ needsPhone: 1, updatedAt: -1 }); // staff worklist
shipmentItemSchema.index({ customerId: 1, createdAt: -1 }); // Customer's items
shipmentItemSchema.index({ "destination.city": 1 });

module.exports = mongoose.model("ShipmentItem", shipmentItemSchema);

const mongoose = require("mongoose");

/**
 * Parcel — Layer 2, the derived + materialised view the app reads.
 *
 * A Parcel is recomputed (never hand-edited) from its Observations whenever
 * that waybill's observations change; see services/ingest.service.js. It is
 * keyed by (waybill, customerKey) because one tracking number is regularly
 * shared by several customers on a consolidated shipment. Human-entered facts
 * that are not in any spreadsheet (a fixed phone, a hold, a delivery photo)
 * live in ManualAdjustment and are overlaid after derivation, so re-deriving
 * from files never wipes them.
 */
// One physical receipt on an intake sheet. A tracking number for one customer
// can carry several (goods received over multiple days), so intake keeps the
// full list and reports the summed quantity.
const intakeLineSchema = new mongoose.Schema(
  { date: Date, qty: Number, qtyRaw: String, qtyUnit: String, warehouse: String, srcRow: Number, fileHash: String },
  { _id: false }
);
// One container leg on a loading sheet. The same waybill/customer is regularly
// split across several containers loaded on different days.
const loadingLegSchema = new mongoose.Schema(
  { containerNo: String, batchRef: String, loadingDate: Date, etd: String, eta: String,
    cbm: Number, qty: Number, qtyRaw: String, qtyUnit: String, srcRow: Number, fileHash: String,
    arrived: { type: Boolean, default: false } },
  { _id: false }
);
const stageIntakeSchema = new mongoose.Schema(
  { date: Date, warehouse: String, qty: Number, qtyRaw: String, kg: Number, srcRow: Number, fileHash: String,
    lines: { type: [intakeLineSchema], default: undefined } },
  { _id: false }
);
const stageLoadingSchema = new mongoose.Schema(
  { containerNo: String, batchRef: String, loadingDate: Date, etd: String, eta: String,
    cbm: Number, location: String, qty: Number, srcRow: Number, fileHash: String,
    legs: { type: [loadingLegSchema], default: undefined } },
  { _id: false }
);
const stageArrivalSchema = new mongoose.Schema(
  { date: Date, containerNo: String, srcRow: Number, fileHash: String },
  { _id: false }
);

const parcelSchema = new mongoose.Schema(
  {
    waybill:      { type: String, required: true, index: true },
    customerKey:  { type: String, required: true },

    customerPhone: { type: String, index: true },
    shippingMark:  { type: String, index: true },
    customerName:  { type: String },
    customerId:    { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },

    currentStage: { type: String, enum: ["intake", "loading", "arrival"], default: "intake", index: true },
    // Kept compatible with the existing ShipmentItem status vocabulary so the
    // frontend and container lifecycle keep working during/after cutover.
    status:       { type: String, default: "received", index: true },

    receivedDate: { type: Date },

    intake:  { type: stageIntakeSchema,  default: null },
    loading: { type: stageLoadingSchema, default: null },
    arrival: { type: stageArrivalSchema, default: null },

    qty:                { type: Number },
    // Present only when a parcel's lines span more than one unit (e.g. some
    // pallets, some loose pieces), so the UI can show "3 pallet + 4 pieces"
    // instead of a misleading single total.
    qtyByUnit:          { type: mongoose.Schema.Types.Mixed, default: undefined },
    // Every container this parcel is loaded into (a split shipment has several).
    // Manifest queries match on this rather than the scalar loading.containerNo.
    containerNos:       { type: [String], default: undefined, index: true },
    productDescription: { type: String },
    financials: {
      freightTerm:   { type: String },
      freightAmount: { type: Number },
      loan:          { type: Number },
      interest:      { type: Number },
      otherFee:      { type: Number },
      invoiceAmount: { type: Number },
    },

    flags: {
      needsPhone:          { type: Boolean, default: false, index: true },
      receivedNotLoaded:   { type: Boolean, default: false, index: true },
      loadedNeverReceived: { type: Boolean, default: false, index: true },
      qtyMismatch:         { type: Boolean, default: false },
      needsWaybill:        { type: Boolean, default: false },
      multiIntake:         { type: Boolean, default: false },
      multiContainer:      { type: Boolean, default: false },
      mixedUnits:          { type: Boolean, default: false },
      partiallyArrived:    { type: Boolean, default: false, index: true },
      partiallyLoaded:     { type: Boolean, default: false, index: true },
    },

    // ── overlaid manual facts (from ManualAdjustment) ─────────────────────────
    heldReason:          { type: String },
    assignedTo:          { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    staffNotes:          { type: String },
    specialInstructions: { type: String },
    deliveryPhoto:       { type: String },
    deliverySignature:   { type: String },
    deliveredAt:         { type: Date },

    observationRefs: [{ fileHash: String, srcRow: Number, tokenIndex: Number, stage: String, _id: false }],
    derivedAt:       { type: Date, default: Date.now },
  },
  { timestamps: true }
);

parcelSchema.index({ waybill: 1, customerKey: 1 }, { unique: true });
parcelSchema.index({ "loading.containerNo": 1 });
parcelSchema.index({ currentStage: 1, updatedAt: -1 });
parcelSchema.index({ customerPhone: 1, currentStage: 1 });

module.exports = mongoose.model("Parcel", parcelSchema);

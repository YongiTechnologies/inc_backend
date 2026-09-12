const mongoose = require("mongoose");

/**
 * Observation — the immutable, append-only fact layer.
 *
 * One document per parcel-token of an uploaded sheet (a cell holding several
 * tracking numbers yields several observations, one per token). Observations
 * are never updated after insert; they are only deactivated when their
 * SourceFile is reverted. Every Parcel is a pure fold of the observations that
 * share its (waybill, customer) identity — see services/parcelDerivation.js.
 */
const observationSchema = new mongoose.Schema(
  {
    // ── provenance ──────────────────────────────────────────────────────────
    sourceFile:     { type: mongoose.Schema.Types.ObjectId, ref: "SourceFile", index: true },
    fileHash:       { type: String, required: true, index: true },
    stage:          { type: String, enum: ["intake", "loading", "arrival"], required: true },
    srcRow:         { type: Number },   // 1-based row in the sheet
    tokenIndex:     { type: Number, default: 0 }, // which tracking token within a multi-track cell
    sourceFilename: { type: String },
    uploadedAt:     { type: Date },     // stamped so derivation has a stable recency order
    active:         { type: Boolean, default: true, index: true }, // false once the file is reverted

    // ── identity ────────────────────────────────────────────────────────────
    waybill:        { type: String, index: true },
    contactRaw:     { type: String },   // the CONTACT cell exactly as written
    customerPhone:  { type: String },
    shippingMark:   { type: String },
    customerName:   { type: String },
    customerKey:    { type: String, index: true },
    needsPhone:     { type: Boolean, default: false },

    // ── dates ───────────────────────────────────────────────────────────────
    receivedDate:   { type: Date },  // entered the warehouse (present on intake AND loading rows)
    eventDate:      { type: Date },  // this stage's own event date

    // ── cargo ─────────────────────────────────────────────────────────────────
    qty:            { type: Number },
    qtyRaw:         { type: String },
    qtyUnit:        { type: String },  // "pallet", "carton", "pieces" …
    kg:             { type: Number },  // gross weight (intake sheets)
    cbm:            { type: Number },
    invoiceNo:      { type: String },
    location:       { type: String },
    productDescription: { type: String },
    goodsType:      { type: String },
    remarks:        { type: String },

    // ── financials (loading / arrival) ────────────────────────────────────────
    financials: {
      freightTerm:   { type: String },
      freightAmount: { type: Number },
      loan:          { type: Number },
      interest:      { type: Number },
      otherFee:      { type: Number },
      invoiceAmount: { type: Number },
    },

    // ── container context (loading / arrival) ─────────────────────────────────
    container: {
      containerNo: { type: String },
      batchRef:    { type: String },
      blNumber:    { type: String },
      sealNumber:  { type: String },
      volume:      { type: String },
      loadingDate: { type: Date },
      etd:         { type: String },
      eta:         { type: String },
    },

    // full parsed row — lets the model be re-derived after any schema change
    raw:            { type: mongoose.Schema.Types.Mixed },
  },
  { timestamps: true }
);

observationSchema.index({ waybill: 1, active: 1 });
observationSchema.index({ fileHash: 1, srcRow: 1, tokenIndex: 1 });

module.exports = mongoose.model("Observation", observationSchema);

const mongoose = require("mongoose");

/**
 * SourceFile — Layer 1 of the two-layer tracking model.
 *
 * One document per uploaded spreadsheet. Uploading a file is a pure insert of a
 * SourceFile plus its Observations; nothing is ever mutated in place. A file is
 * identified by the sha256 of its bytes, so re-uploading identical bytes is a
 * detectable no-op. Correcting a file = mark the old one `reverted` and ingest
 * the corrected version; derivation only ever reads observations of `active`
 * files.
 */
const sourceFileSchema = new mongoose.Schema(
  {
    fileHash:         { type: String, required: true, unique: true, index: true },
    stage:            { type: String, enum: ["intake", "loading", "arrival"], required: true },
    originalFilename: { type: String },
    uploadedBy:       { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    uploadedAt:       { type: Date, default: Date.now },

    // Parsed header block (container no / BL / seal / ETD / ETA / batch date …).
    metadata:         { type: mongoose.Schema.Types.Mixed, default: {} },

    rowCount:         { type: Number, default: 0 },
    skippedRows:      [Number],

    status:           { type: String, enum: ["active", "reverted"], default: "active", index: true },
    revertedAt:       { type: Date },
  },
  { timestamps: true }
);

module.exports = mongoose.model("SourceFile", sourceFileSchema);

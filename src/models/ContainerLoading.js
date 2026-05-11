const mongoose = require("mongoose");

/**
 * ContainerLoading — a first-class entity representing a single shipping container.
 *
 * Status flow: loading → shipped → arrived → ready
 *
 * Auto-created when a shipped batch is uploaded (from the CTR_INVOICE packing list).
 * Staff can edit all fields and advance the status after creation.
 * Public endpoints expose all fields except staffNotes.
 */
const containerLoadingSchema = new mongoose.Schema(
  {
    // ── Core identifiers ───────────────────────────────────────────────────────
    containerNumber: {
      type:     String,
      required: true,
      unique:   true,
      uppercase: true,
      trim:     true,
      index:    true,
    },
    vesselName:  { type: String, trim: true },   // e.g. "MSC VIVIENNE"
    blNumber:    { type: String, trim: true },   // Bill of Lading
    sealNumber:  { type: String, trim: true },
    volume:      { type: String, trim: true },   // e.g. "40 HQ", "20 FT"

    // ── Ports ──────────────────────────────────────────────────────────────────
    portOfLoading:   { type: String, default: "Guangzhou, China", trim: true },
    portOfDischarge: { type: String, default: "Tema Port, Ghana", trim: true },

    // ── Dates ──────────────────────────────────────────────────────────────────
    loadingDate:       { type: Date },  // when container was sealed at origin
    etd:               { type: Date },  // Estimated Time of Departure
    eta:               { type: Date },  // Estimated Time of Arrival
    actualArrivalDate: { type: Date },  // when it actually arrived at POD

    // ── Status ─────────────────────────────────────────────────────────────────
    status: {
      type:    String,
      enum:    ["loading", "shipped", "arrived", "ready"],
      default: "loading",
      index:   true,
    },

    // ── Notes ──────────────────────────────────────────────────────────────────
    notes:      { type: String }, // visible to the public (e.g. "Delayed at customs")
    staffNotes: { type: String }, // internal only — never returned to public callers

    // ── Back-reference to the batch that auto-created this record ──────────────
    batchRef: { type: mongoose.Schema.Types.ObjectId, ref: "Batch", default: null },

    // ── Audit ──────────────────────────────────────────────────────────────────
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    updatedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
  },
  { timestamps: true }
);

// Fast search by container number prefix (staff + public)
containerLoadingSchema.index({ containerNumber: "text", vesselName: "text", blNumber: "text" });

module.exports = mongoose.model("ContainerLoading", containerLoadingSchema);

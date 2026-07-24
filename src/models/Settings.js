const mongoose = require("mongoose");

// ─── Location → rate-group resolution ──────────────────────────────────────────
//
// The CBM ("CDM") rate charged to a customer depends on the delivery location
// read from the packing-list LOCATION column. Three fixed groups:
//   • default          → Accra (also used when the location is blank/unknown)
//   • kumasi_takoradi  → Kumasi and Takoradi share the same rate
//   • tamale           → Tamale has its own rate
//
// resolveRateGroup normalises the raw location string and maps it to a group.
const KUMASI_TAKORADI = new Set(["KUMASI", "TAKORADI"]);
const TAMALE          = new Set(["TAMALE"]);

function resolveRateGroup(location) {
    if (!location) return "default";
    const norm = String(location).trim().toUpperCase();
    if (KUMASI_TAKORADI.has(norm)) return "kumasi_takoradi";
    if (TAMALE.has(norm))          return "tamale";
    return "default";
}

const settingsSchema = new mongoose.Schema(
    {
        // Accra / default rate per CBM (USD)
        cbmRate: { type: Number, default: 230 },
        // Shared rate for Kumasi & Takoradi
        cbmRateKumasiTakoradi: { type: Number, default: 230 },
        // Tamale-specific rate
        cbmRateTamale: { type: Number, default: 230 },

        usdToGhsRate: { type: Number, default: 15.2 },
        minFeeUsd: { type: Number, default: 3 },
    },
    { timestamps: true }
);

// Enforce a singleton — only one settings document ever exists
settingsSchema.statics.getOrCreate = async function () {
    let doc = await this.findOne();
    if (!doc) doc = await this.create({});
    return doc;
};

// Given a raw location string, return the applicable CBM rate for this settings doc.
settingsSchema.methods.resolveCbmRate = function (location) {
    switch (resolveRateGroup(location)) {
        case "kumasi_takoradi": return this.cbmRateKumasiTakoradi ?? this.cbmRate;
        case "tamale":          return this.cbmRateTamale ?? this.cbmRate;
        default:                return this.cbmRate;
    }
};

const Settings = mongoose.model("Settings", settingsSchema);
Settings.resolveRateGroup = resolveRateGroup;

module.exports = Settings;

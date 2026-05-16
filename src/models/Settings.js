const mongoose = require("mongoose");

const settingsSchema = new mongoose.Schema(
    {
        cbmRate: { type: Number, default: 230 },
        usdToGhsRate: { type: Number, default: 15.2 },
    },
    { timestamps: true }
);

// Enforce a singleton — only one settings document ever exists
settingsSchema.statics.getOrCreate = async function () {
    let doc = await this.findOne();
    if (!doc) doc = await this.create({});
    return doc;
};

module.exports = mongoose.model("Settings", settingsSchema);

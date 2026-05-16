const Settings = require("../models/Settings");
const { respond } = require("../utils/response");

exports.getSettings = async (req, res) => {
    try {
        const settings = await Settings.getOrCreate();
        respond(res, 200, true, "Settings retrieved", {
            cbmRate: settings.cbmRate,
            usdToGhsRate: settings.usdToGhsRate,
        });
    } catch (err) {
        respond(res, 500, false, "Failed to retrieve settings");
    }
};

exports.updateSettings = async (req, res) => {
    try {
        const { cbmRate, usdToGhsRate } = req.body;
        const update = {};

        if (cbmRate !== undefined) {
            if (typeof cbmRate !== "number" || cbmRate <= 0)
                return respond(res, 400, false, "cbmRate must be a positive number");
            update.cbmRate = cbmRate;
        }
        if (usdToGhsRate !== undefined) {
            if (typeof usdToGhsRate !== "number" || usdToGhsRate <= 0)
                return respond(res, 400, false, "usdToGhsRate must be a positive number");
            update.usdToGhsRate = usdToGhsRate;
        }

        const settings = await Settings.findOneAndUpdate(
            {},
            { $set: update },
            { new: true, upsert: true }
        );

        respond(res, 200, true, "Settings updated", {
            cbmRate: settings.cbmRate,
            usdToGhsRate: settings.usdToGhsRate,
        });
    } catch (err) {
        respond(res, 500, false, "Failed to update settings");
    }
};

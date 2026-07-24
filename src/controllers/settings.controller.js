const Settings = require("../models/Settings");
const { respond } = require("../utils/response");

function serialize(settings) {
    return {
        cbmRate:               settings.cbmRate,
        cbmRateKumasiTakoradi: settings.cbmRateKumasiTakoradi,
        cbmRateTamale:         settings.cbmRateTamale,
        usdToGhsRate:          settings.usdToGhsRate,
        minFeeUsd:             settings.minFeeUsd,
    };
}

exports.getSettings = async (req, res) => {
    try {
        const settings = await Settings.getOrCreate();
        respond(res, 200, true, "Settings retrieved", serialize(settings));
    } catch (err) {
        respond(res, 500, false, "Failed to retrieve settings");
    }
};

exports.updateSettings = async (req, res) => {
    try {
        const { cbmRate, cbmRateKumasiTakoradi, cbmRateTamale, usdToGhsRate, minFeeUsd } = req.body;
        const update = {};

        // All CBM rates must be positive when supplied.
        for (const [key, value] of Object.entries({ cbmRate, cbmRateKumasiTakoradi, cbmRateTamale })) {
            if (value !== undefined) {
                if (typeof value !== "number" || value <= 0)
                    return respond(res, 400, false, `${key} must be a positive number`);
                update[key] = value;
            }
        }
        if (usdToGhsRate !== undefined) {
            if (typeof usdToGhsRate !== "number" || usdToGhsRate <= 0)
                return respond(res, 400, false, "usdToGhsRate must be a positive number");
            update.usdToGhsRate = usdToGhsRate;
        }
        if (minFeeUsd !== undefined) {
            if (typeof minFeeUsd !== "number" || minFeeUsd < 0)
                return respond(res, 400, false, "minFeeUsd must be a non-negative number");
            update.minFeeUsd = minFeeUsd;
        }

        const settings = await Settings.findOneAndUpdate(
            {},
            { $set: update },
            { new: true, upsert: true }
        );

        respond(res, 200, true, "Settings updated", serialize(settings));
    } catch (err) {
        respond(res, 500, false, "Failed to update settings");
    }
};

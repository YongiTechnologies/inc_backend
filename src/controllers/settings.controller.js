const Settings = require("../models/Settings");
const { respond } = require("../utils/response");

const MAX_TICKER_ITEMS = 30;
const TICKER_TYPES = ["news", "rate"];

function serialize(settings) {
    return {
        cbmRate:               settings.cbmRate,
        cbmRateKumasiTakoradi: settings.cbmRateKumasiTakoradi,
        cbmRateTamale:         settings.cbmRateTamale,
        usdToGhsRate:          settings.usdToGhsRate,
        minFeeUsd:             settings.minFeeUsd,
        tickerItems:           settings.tickerItems || [],
    };
}

// Validates and normalises a client-supplied ticker array. Returns
// { error } or { value }. Ids are generated server-side when missing so the
// client never has to invent (and possibly collide) its own.
function normaliseTickerItems(raw) {
    if (!Array.isArray(raw)) return { error: "tickerItems must be an array" };
    if (raw.length > MAX_TICKER_ITEMS)
        return { error: `tickerItems cannot exceed ${MAX_TICKER_ITEMS} items` };

    const value = [];
    for (const [i, item] of raw.entries()) {
        if (!item || typeof item !== "object")
            return { error: `tickerItems[${i}] must be an object` };

        const text = typeof item.text === "string" ? item.text.trim() : "";
        if (!text) return { error: `tickerItems[${i}].text is required` };
        if (text.length > 300) return { error: `tickerItems[${i}].text is too long` };

        const type = TICKER_TYPES.includes(item.type) ? item.type : "news";
        const id = typeof item.id === "string" && item.id.trim()
            ? item.id.trim()
            : `${Date.now()}-${i}-${Math.random().toString(36).slice(2, 8)}`;

        value.push({ id, type, text });
    }
    return { value };
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
        const { cbmRate, cbmRateKumasiTakoradi, cbmRateTamale, usdToGhsRate, minFeeUsd, tickerItems } = req.body;
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
        if (tickerItems !== undefined) {
            const { error, value } = normaliseTickerItems(tickerItems);
            if (error) return respond(res, 400, false, error);
            update.tickerItems = value;
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

const { GpsDevice, GpsPing } = require("../models/Gps");
const ShipmentItem  = require("../models/ShipmentItem");
const User          = require("../models/User");

/**
 * How far (metres) the shipment must move before we auto-log
 * a new TrackingEvent from a GPS ping. Prevents spamming the timeline
 * with micro-movements while still keeping it meaningful.
 */
const AUTO_EVENT_DISTANCE_THRESHOLD_M = 50_000; // 50 km

/**
 * ─── Provider adapters ────────────────────────────────────────────────────────
 *
 * Each adapter takes the raw HTTP payload from the GPS provider's webhook
 * and returns a normalised ping object.
 *
 * To add a new provider:
 *   1. Write an adapter function below
 *   2. Add it to ADAPTERS with a key matching GPS_PROVIDER in .env
 */

const ADAPTERS = {
  /**
   * Traccar — open-source GPS server (self-host or cloud).
   * Webhook payload: https://www.traccar.org/webhook/
   */
  traccar(payload) {
    const { deviceId, position } = payload;
    return {
      deviceId:    String(deviceId),
      coordinates: [position.longitude, position.latitude],
      accuracy:    position.accuracy,
      speed:       position.speed,
      bearing:     position.course,
      altitude:    position.altitude,
      batteryPct:  position.attributes?.batteryLevel,
      provider:    "traccar",
    };
  },

  /**
   * Google Fleet Engine (Maps Platform).
   * Webhook payload from Vehicle updates.
   */
  google(payload) {
    const loc = payload.lastLocation;
    return {
      deviceId:    payload.name.split("/").pop(), // "providers/.../vehicles/DEVICE_ID"
      coordinates: [loc.rawLocation.longitude, loc.rawLocation.latitude],
      accuracy:    loc.rawLocationAccuracy,
      speed:       loc.speed,
      bearing:     loc.heading,
      provider:    "google",
    };
  },

  /**
   * HERE Tracking.
   * https://developer.here.com/documentation/tracking
   */
  here(payload) {
    const { trackingId, position } = payload;
    return {
      deviceId:    trackingId,
      coordinates: [position.lng, position.lat],
      accuracy:    position.accuracy,
      speed:       position.speed,
      bearing:     position.bearing,
      altitude:    position.alt,
      provider:    "here",
    };
  },

  /**
   * Raw / generic — for custom hardware that POSTs directly.
   * Expected body: { deviceId, lng, lat, accuracy?, speed?, bearing?, batteryPct? }
   */
  raw(payload) {
    return {
      deviceId:    String(payload.deviceId),
      coordinates: [parseFloat(payload.lng), parseFloat(payload.lat)],
      accuracy:    payload.accuracy,
      speed:       payload.speed,
      bearing:     payload.bearing,
      altitude:    payload.altitude,
      batteryPct:  payload.batteryPct,
      provider:    "raw",
    };
  },
};

/**
 * Process an incoming GPS webhook payload.
 *
 * 1. Normalise via provider adapter
 * 2. Find which shipment this device is attached to
 * 3. Store the raw ping
 * 4. Update the device's lastPing/lastCoords
 * 5. Optionally auto-log a TrackingEvent if the shipment has moved significantly
 */
async function handleWebhook(providerName, rawPayload) {
  try {
    const adapter = ADAPTERS[providerName] || ADAPTERS.raw;
    const ping    = adapter(rawPayload);

    if (!ping.deviceId) throw new Error("Adapter returned no deviceId");
    if (!ping.coordinates || ping.coordinates.length !== 2) throw new Error("Adapter returned invalid coordinates");

    // Find the device and its current shipment assignment
    const device = await GpsDevice.findOne({ deviceId: ping.deviceId, isActive: true });
    if (!device) {
      console.warn(`GPS ping from unknown/inactive device: ${ping.deviceId}`);
      return null;
    }

    const itemId = device.shipmentId;

    // Store the raw ping
    const savedPing = await GpsPing.create({
      ...ping,
      shipmentId: itemId,
      rawPayload,
      timestamp: new Date(),
    });

    // Update device's last known position
    await GpsDevice.findByIdAndUpdate(device._id, {
      lastPing:   savedPing.timestamp,
      lastCoords: ping.coordinates,
      batteryPct: ping.batteryPct,
    });

    // Auto-log a status update if shipment item has moved significantly
    if (itemId) {
      await maybeAutoLogEvent(itemId, ping, device);
    }

    return savedPing;
  } catch (err) {
    console.error("GPS webhook processing error:", err.message);
    // Return null to indicate processing failed, but don't throw
    // The controller will still return 200 to prevent retries
    return null;
  }
}

/**
 * Returns the live trail for a shipment — last N pings in chronological order.
 * Used by the frontend map to draw the route line and current position dot.
 */
async function getLiveTrail(shipmentId, { limit = 200 } = {}) {
  const pings = await GpsPing.find({ shipmentId })
    .sort({ timestamp: -1 })
    .limit(limit)
    .select("coordinates speed bearing batteryPct timestamp")
    .lean();

  // Reverse so oldest-first (for map polyline drawing)
  return pings.reverse();
}

/**
 * Get the single most recent ping for a shipment — the "current location" dot.
 */
async function getCurrentPosition(shipmentId) {
  return GpsPing.findOne({ shipmentId })
    .sort({ timestamp: -1 })
    .select("coordinates speed bearing batteryPct timestamp deviceId")
    .lean();
}

/**
 * Assign a GPS device to a shipment.
 * Unassigns any previous shipment the device was attached to.
 */
async function assignDevice(deviceId, shipmentId, performedBy) {
  const existingDevice = await GpsDevice.findOne({ deviceId });

  // If device was previously assigned to a different shipment, log audit event
  if (existingDevice && existingDevice.shipmentId && existingDevice.shipmentId.toString() !== shipmentId.toString()) {
    const audit = require("./audit.service");
    await audit.log({
      performedBy,
      action: "DEVICE_REASSIGNED",
      targetModel: "GpsDevice",
      targetId: existingDevice._id,
      details: {
        deviceId,
        oldShipmentId: existingDevice.shipmentId,
        newShipmentId: shipmentId,
      },
    });
  }

  const device = await GpsDevice.findOneAndUpdate(
    { deviceId },
    { shipmentId, isActive: true },
    { new: true, upsert: true }
  );
  return device;
}

/**
 * Detach device from its current shipment (e.g. when delivered).
 */
async function unassignDevice(deviceId) {
  return GpsDevice.findOneAndUpdate({ deviceId }, { shipmentId: null });
}

/**
 * List all devices — for admin device management screen.
 */
async function listDevices() {
  return GpsDevice.find()
    .populate("shipmentId", "waybillNo status destination destinationCity")
    .sort({ updatedAt: -1 })
    .lean();
}

// ─── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Haversine distance between two [lng, lat] pairs, in metres.
 */
function haversineM([lng1, lat1], [lng2, lat2]) {
  const R  = 6_371_000;
  const φ1 = (lat1 * Math.PI) / 180;
  const φ2 = (lat2 * Math.PI) / 180;
  const Δφ = ((lat2 - lat1) * Math.PI) / 180;
  const Δλ = ((lng2 - lng1) * Math.PI) / 180;
  const a  = Math.sin(Δφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(Δλ / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Reverse-geocodes [lng, lat] to a human-readable location string.
 * Uses the Google Geocoding API if configured, otherwise falls back to
 * "lat, lng" — so this is always non-blocking and never throws.
 */
async function reverseGeocode([lng, lat]) {
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    return { address: `${lat.toFixed(4)}, ${lng.toFixed(4)}`, city: "Unknown", country: "Unknown" };
  }

  try {
    const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${lat},${lng}&key=${process.env.GOOGLE_MAPS_API_KEY}`;
    const res  = await fetch(url);
    const json = await res.json();

    if (json.status !== "OK" || !json.results.length) {
      return { address: `${lat.toFixed(4)}, ${lng.toFixed(4)}`, city: "Unknown", country: "Unknown" };
    }

    const result    = json.results[0];
    const components = result.address_components;

    const get = (type) =>
      components.find((c) => c.types.includes(type))?.long_name || "";

    return {
      address: result.formatted_address,
      city:    get("locality") || get("administrative_area_level_2"),
      country: get("country"),
    };
  } catch {
    return { address: `${lat.toFixed(4)}, ${lng.toFixed(4)}`, city: "Unknown", country: "Unknown" };
  }
}

async function maybeAutoLogEvent(itemId, ping, device) {
  try {
    // Find the last stageHistory entry that had GPS coordinates
    const item = await ShipmentItem.findById(itemId);
    if (!item) return;

    const historyWithLocation = item.stageHistory?.filter(h => h.location?.coordinates?.length) || [];
    const lastEntry = historyWithLocation[historyWithLocation.length - 1];
    const prevCoords = lastEntry?.location?.coordinates;

    // Skip if we haven't moved far enough yet
    if (prevCoords && haversineM(prevCoords, ping.coordinates) < AUTO_EVENT_DISTANCE_THRESHOLD_M) {
      return;
    }

    if (["delivered", "returned"].includes(item.status)) return;

    // Get system user for automated events
    const systemUser = await User.findOne({ email: "system@ghanalogistics.com" });
    if (!systemUser) {
      console.error("System user not found for GPS auto-logging");
      return;
    }

    const location = await reverseGeocode(ping.coordinates);

    // Update the item's stageHistory with the new location
    item.stageHistory.push({
      stage: mapStatusToStage(item.status),
      status: item.status,
      updatedAt: new Date(),
      location: { ...location, coordinates: ping.coordinates },
      note: `GPS update: ${location.city || "In transit"}`,
      internalNote: `Auto-logged. Speed: ${ping.speed ?? "?"}km/h. Device: ${device.deviceId}`,
      carrier: "GPS Auto",
      updatedBy: systemUser._id,
    });
    await item.save();
  } catch (err) {
    console.error("Auto GPS event logging failed:", err.message);
  }
}

function mapStatusToStage(status) {
  const stageMap = {
    pending: 'pending',
    picked_up: 'in_transit',
    in_transit: 'in_transit',
    customs: 'customs',
    out_for_delivery: 'out_for_delivery',
    delivered: 'delivered',
    failed: 'failed',
    returned: 'returned',
    in_warehouse: 'in_warehouse',
    shipped: 'shipped',
    held: 'held',
  };
  return stageMap[status] || status;
}

module.exports = {
  handleWebhook,
  getLiveTrail,
  getCurrentPosition,
  assignDevice,
  unassignDevice,
  listDevices,
  ADAPTERS,
};

const mongoose = require("mongoose");

/**
 * GpsDevice — represents a physical tracker unit.
 * One device is assigned to one active shipment at a time.
 */
const gpsDeviceSchema = new mongoose.Schema(
  {
    deviceId:   { type: String, required: true, unique: true, index: true }, // hardware serial / IMEI
    label:      { type: String }, // e.g. "Tracker-007"
    shipmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Shipment", default: null, index: true },
    isActive:   { type: Boolean, default: true },
    lastPing:   { type: Date },
    lastCoords: { type: [Number] }, // [lng, lat]
    batteryPct: { type: Number },
  },
  { timestamps: true }
);

/**
 * GpsPing — raw coordinate log from a device.
 * Append-only. This is the source of truth for the live map trail.
 */
const gpsPingSchema = new mongoose.Schema({
  deviceId:   { type: String, required: true, index: true },
  shipmentId: { type: mongoose.Schema.Types.ObjectId, ref: "Shipment", index: true },
  coordinates: {
    type: [Number], // [lng, lat]
    required: true,
  },
  accuracy:    { type: Number }, // metres
  speed:       { type: Number }, // km/h
  bearing:     { type: Number }, // degrees 0-360
  altitude:    { type: Number }, // metres
  batteryPct:  { type: Number },
  provider:    { type: String }, // e.g. "traccar", "google", "here"
  rawPayload:  { type: mongoose.Schema.Types.Mixed }, // full provider payload, for debugging
  timestamp:   { type: Date, default: Date.now, index: true },
});

// Index for fast "last N pings for shipment" queries
gpsPingSchema.index({ shipmentId: 1, timestamp: -1 });
gpsPingSchema.index({ deviceId: 1,   timestamp: -1 });

const GpsDevice = mongoose.model("GpsDevice", gpsDeviceSchema);
const GpsPing   = mongoose.model("GpsPing",   gpsPingSchema);

module.exports = { GpsDevice, GpsPing };

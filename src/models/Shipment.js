const mongoose = require("mongoose");

const locationSchema = new mongoose.Schema(
  {
    address: { type: String, required: true },
    city:    { type: String, required: true },
    country: { type: String, required: true },
    coordinates: { type: [Number] }, // [lng, lat] — optional, for map display
  },
  { _id: false }
);

const shipmentSchema = new mongoose.Schema(
  {
    trackingNumber: {
      type: String,
      required: true,
      unique: true,
      index: true,
      uppercase: true,
      trim: true,
    },
    customerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
    },
    assignedTo: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },
    origin:      { type: locationSchema, required: true },
    destination: { type: locationSchema, required: true },

    status: {
      type: String,
      enum: [
        "pending",
        "picked_up",
        "in_transit",
        "customs",
        "out_for_delivery",
        "delivered",
        "failed",
        "returned",
      ],
      default: "pending",
    },

    // Cargo
    description:  { type: String, required: true },
    packageType:  { type: String, enum: ["document", "parcel", "pallet", "container"], default: "parcel" },
    weight:       { type: Number }, // kg
    dimensions:   { length: Number, width: Number, height: Number }, // cm
    quantity:     { type: Number, default: 1 },
    declaredValue:{ type: Number }, // USD

    // Dates
    estimatedDelivery: { type: Date },
    deliveredAt:       { type: Date },

    // Proof of delivery
    deliveryPhoto:     { type: String }, // URL
    deliverySignature: { type: String }, // URL

    // Flags
    requiresCustoms:     { type: Boolean, default: false },
    isFragile:           { type: Boolean, default: false },
    specialInstructions: { type: String },
  },
  { timestamps: true }
);

module.exports = mongoose.model("Shipment", shipmentSchema);

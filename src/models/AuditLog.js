const mongoose = require("mongoose");

const auditLogSchema = new mongoose.Schema({
  performedBy: { type: mongoose.Schema.Types.ObjectId, ref: "User", required: true },
  action:      { type: String, required: true }, // e.g. "CREATE_SHIPMENT", "UPDATE_STATUS"
  targetModel: { type: String }, // e.g. "Shipment", "User"
  targetId:    { type: mongoose.Schema.Types.ObjectId },
  details:     { type: mongoose.Schema.Types.Mixed }, // any extra context
  ip:          { type: String },
  timestamp:   { type: Date, default: Date.now, index: true },
});

module.exports = mongoose.model("AuditLog", auditLogSchema);

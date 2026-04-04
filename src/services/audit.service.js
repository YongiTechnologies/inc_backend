const AuditLog = require("../models/AuditLog");

async function log({ performedBy, action, targetModel, targetId, details, ip }) {
  try {
    await AuditLog.create({ performedBy, action, targetModel, targetId, details, ip });
  } catch (err) {
    // Audit failure must never crash the main request
    console.error("Audit log failed:", err.message);
  }
}

module.exports = { log };

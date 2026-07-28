const cron = require("node-cron");
const AuditLog = require("../models/AuditLog");
const RefreshToken = require("../models/RefreshToken");
const { GpsPing } = require("../models/Gps");
const ShipmentItem = require("../models/ShipmentItem");
const Batch = require("../models/Batch");
const ContainerLoading = require("../models/ContainerLoading");

/**
 * Safe system-level cleanup — removes session garbage and raw telemetry only.
 *
 * Deliberately does NOT touch ShipmentItems or Batches. Those are business
 * records (customer history, invoicing, dispute resolution). Auto-deleting
 * them on a schedule risks permanent data loss with no recovery path.
 * If a manual purge of old terminal shipments is ever needed, it should be
 * a separate, explicitly confirmed admin operation — not a background job.
 */
async function runCleanup() {
  const results = {};
  const now = new Date();

  try {
    // Audit logs older than 90 days — security event trail, not business data
    const auditCutoff = new Date(now - 90 * 24 * 60 * 60 * 1000);
    const auditResult = await AuditLog.deleteMany({ timestamp: { $lt: auditCutoff } });
    results.auditLogs = auditResult.deletedCount;

    // Expired and revoked refresh tokens — pure session data, useless once expired
    const rtResult = await RefreshToken.deleteMany({
      $or: [
        { expiresAt: { $lt: now } },
        { isRevoked: true, revokedAt: { $lt: new Date(now - 7 * 24 * 60 * 60 * 1000) } }
      ]
    });
    results.refreshTokens = rtResult.deletedCount;

    // Raw GPS pings older than 30 days — high-volume telemetry, no value after tracking closes
    const gpsCutoff = new Date(now - 30 * 24 * 60 * 60 * 1000);
    const gpsResult = await GpsPing.deleteMany({ timestamp: { $lt: gpsCutoff } });
    results.gpsPings = gpsResult.deletedCount;

    console.log(`[Cleanup] ${new Date().toISOString()} —`, results);
    return results;
  } catch (err) {
    console.error("[Cleanup] Error:", err.message);
    throw err;
  }
}

// The exact phrase an admin must type to confirm a destructive purge.
const PURGE_CONFIRM_PHRASE = "DELETE ALL DATA";

/**
 * DESTRUCTIVE — permanently deletes all operational data: every shipment item,
 * batch, and container loading. There is NO undo.
 *
 * Deliberately KEEPS user accounts, settings/rates, audit logs, and GPS
 * telemetry. Used to reset the goods data (e.g. after test/wrong uploads).
 * Callers must pass the exact confirmation phrase.
 */
async function purgeOperationalData(confirmPhrase) {
  if (confirmPhrase !== PURGE_CONFIRM_PHRASE) {
    const err = new Error(`Confirmation phrase must be exactly "${PURGE_CONFIRM_PHRASE}".`);
    err.code = "PURGE_NOT_CONFIRMED";
    throw err;
  }

  const [items, batches, containers] = await Promise.all([
    ShipmentItem.deleteMany({}),
    Batch.deleteMany({}),
    ContainerLoading.deleteMany({}),
  ]);

  const results = {
    shipmentItems:     items.deletedCount,
    batches:           batches.deletedCount,
    containerLoadings: containers.deletedCount,
  };
  console.log(`[Purge] ${new Date().toISOString()} — operational data cleared`, results);
  return results;
}

/**
 * Schedule: runs every day at 2:00 AM server time.
 */
function startCleanupScheduler() {
  cron.schedule("0 2 * * *", () => {
    console.log("[Cleanup] Running scheduled cleanup...");
    runCleanup().catch((err) => console.error("[Cleanup] Scheduled run failed:", err.message));
  });
  console.log("✅ Cleanup scheduler started (daily at 2:00 AM)");
}

module.exports = { startCleanupScheduler, runCleanup, purgeOperationalData, PURGE_CONFIRM_PHRASE };

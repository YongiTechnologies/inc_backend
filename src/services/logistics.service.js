const ShipmentItem = require("../models/ShipmentItem");

/**
 * logistics.service — the single place that keeps the three staff tabs
 * (Goods Received / Container Loadings / Arrived Goods) in step.
 *
 * All three tabs render the same ShipmentItem documents, only grouped
 * differently (intakeBatch / container / arrivedBatch). Anything that changes a
 * shipment's status in bulk goes through here so the rules are identical no
 * matter which tab the edit was made from.
 */

// A container's lifecycle maps 1:1 onto the shipments loaded in it.
const CONTAINER_TO_ITEM_STATUS = {
  loading: "in_warehouse",
  shipped: "shipped",
  at_port: "at_port",
  arrived: "customs",
  ready:   "ready_for_pickup",
};

// A batch's stage maps onto the status its items should hold.
const BATCH_STAGE_TO_ITEM_STATUS = {
  intake:  "in_warehouse",
  shipped: "shipped",
  arrived: "customs",
};

/**
 * Exception and terminal states a bulk change must never silently overwrite.
 * A held shipment stays held; a delivered one stays delivered. Staff can still
 * move these individually from the item edit modal.
 */
const PROTECTED_ITEM_STATUSES = new Set(["held", "delivered", "returned", "failed"]);

// Statuses staff may set by hand on a single item.
const MANUAL_ITEM_STATUSES = [
  "in_warehouse", "shipped", "at_port", "customs",
  "ready_for_pickup", "out_for_delivery", "delivered",
  "held", "returned", "failed",
];

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Case-insensitive exact match for a container number. Items uploaded before
 * containerRef was normalised may hold a lower-case value, so an equality match
 * would miss them.
 */
function containerRefMatcher(containerNumber) {
  return { $regex: `^${escapeRegex(String(containerNumber).trim())}$`, $options: "i" };
}

/**
 * Every shipment that belongs to a container, from either direction:
 *   - items whose containerRef names it (incl. ones staff assigned by hand
 *     from the Goods Received tab), and
 *   - items that came in on the packing list that created it.
 *
 * Returns null when the container can have no items at all, so callers can
 * skip the query entirely.
 */
function containerItemFilter(container) {
  const or = [];
  if (container.containerNumber) {
    or.push({ containerRef: containerRefMatcher(container.containerNumber) });
  }
  const batchId = container.batchRef?._id || container.batchRef;
  if (batchId) or.push({ shippedBatch: batchId });

  return or.length ? { $or: or } : null;
}

/** Every shipment that belongs to a batch, matched on that batch's own stage. */
function batchItemFilter(batch) {
  return { [`${batch.stage}Batch`]: batch._id };
}

/**
 * Apply one status to every shipment matching `filter`, skipping protected
 * states. Each changed item gets a stageHistory entry so the move shows up on
 * the customer's tracking timeline.
 *
 * @returns {{updated:number, skipped:number, unchanged:number, skippedByStatus:Object}}
 */
async function applyBulkStatus(filter, newStatus, { performedBy, note } = {}) {
  if (!filter) return { updated: 0, skipped: 0, unchanged: 0, skippedByStatus: {} };

  const targets = await ShipmentItem.find(filter).select("_id status").lean();

  const skippedByStatus = {};
  const ids = [];
  let unchanged = 0;

  for (const item of targets) {
    if (item.status === newStatus) { unchanged++; continue; }
    if (PROTECTED_ITEM_STATUSES.has(item.status)) {
      skippedByStatus[item.status] = (skippedByStatus[item.status] || 0) + 1;
      continue;
    }
    ids.push(item._id);
  }

  if (ids.length > 0) {
    await ShipmentItem.updateMany(
      { _id: { $in: ids } },
      {
        $set:  { status: newStatus },
        $push: {
          stageHistory: {
            status:    newStatus,
            updatedAt: new Date(),
            updatedBy: performedBy,
            note:      note || "Status updated in bulk by staff",
          },
        },
      }
    );
  }

  const skipped = Object.values(skippedByStatus).reduce((a, b) => a + b, 0);
  return { updated: ids.length, skipped, unchanged, skippedByStatus };
}

/**
 * Human-readable tail for an API message, e.g.
 *   "42 shipment(s) synced, 3 skipped (1 held, 2 delivered)"
 * Returns an empty string when nothing was touched.
 */
function describeBulkResult(result) {
  if (!result || (result.updated === 0 && result.skipped === 0)) return "";

  const parts = [`${result.updated} shipment(s) synced`];
  if (result.skipped > 0) {
    const breakdown = Object.entries(result.skippedByStatus)
      .map(([status, count]) => `${count} ${status.replace(/_/g, " ")}`)
      .join(", ");
    parts.push(`${result.skipped} skipped (${breakdown})`);
  }
  return parts.join(", ");
}

module.exports = {
  CONTAINER_TO_ITEM_STATUS,
  BATCH_STAGE_TO_ITEM_STATUS,
  PROTECTED_ITEM_STATUSES,
  MANUAL_ITEM_STATUSES,
  containerRefMatcher,
  containerItemFilter,
  batchItemFilter,
  applyBulkStatus,
  describeBulkResult,
};

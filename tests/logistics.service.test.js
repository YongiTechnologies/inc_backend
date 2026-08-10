"use strict";

/**
 * Unit tests for logistics.service — the rules that keep the three staff tabs
 * (Goods Received / Container Loadings / Arrived Goods) in step.
 *
 * ShipmentItem is mocked so these run without a live MongoDB connection.
 */

const mockItemFind       = jest.fn();
const mockItemUpdateMany = jest.fn();

jest.mock("../src/models/ShipmentItem", () => ({
  find:       (...a) => mockItemFind(...a),
  updateMany: (...a) => mockItemUpdateMany(...a),
}));

const {
  CONTAINER_TO_ITEM_STATUS,
  MANUAL_ITEM_STATUSES,
  PROTECTED_ITEM_STATUSES,
  containerRefMatcher,
  containerItemFilter,
  batchItemFilter,
  applyBulkStatus,
  describeBulkResult,
} = require("../src/services/logistics.service");

/** Make ShipmentItem.find(...).select(...).lean() resolve to `items`. */
function stubFind(items) {
  mockItemFind.mockReturnValue({
    select: () => ({ lean: () => Promise.resolve(items) }),
  });
}

beforeEach(() => {
  mockItemFind.mockReset();
  mockItemUpdateMany.mockReset();
  mockItemUpdateMany.mockResolvedValue({ modifiedCount: 0 });
});

// ─── Filters ──────────────────────────────────────────────────────────────────

describe("containerItemFilter", () => {
  it("matches items by container ref AND by the packing list that created it", () => {
    const filter = containerItemFilter({
      containerNumber: "MSBU7337022",
      batchRef:        "664f1b2c3d4e5f6a7b8c9d01",
    });

    expect(filter.$or).toHaveLength(2);
    expect(filter.$or[0].containerRef).toEqual({ $regex: "^MSBU7337022$", $options: "i" });
    expect(filter.$or[1]).toEqual({ shippedBatch: "664f1b2c3d4e5f6a7b8c9d01" });
  });

  it("still matches by container ref when the container has no batch (created by hand)", () => {
    const filter = containerItemFilter({ containerNumber: "MSBU7337022" });
    expect(filter.$or).toHaveLength(1);
    expect(filter.$or[0].containerRef).toBeDefined();
  });

  it("unwraps a populated batchRef object", () => {
    const filter = containerItemFilter({
      containerNumber: "ABC1",
      batchRef:        { _id: "deadbeef", batchCode: "CTR-ABC1" },
    });
    expect(filter.$or[1]).toEqual({ shippedBatch: "deadbeef" });
  });

  it("returns null when the container can have no items at all", () => {
    expect(containerItemFilter({})).toBeNull();
  });

  it("escapes regex metacharacters in the container number", () => {
    const { $regex } = containerRefMatcher("A.B*C");
    expect($regex).toBe("^A\\.B\\*C$");
  });
});

describe("batchItemFilter", () => {
  it("matches on the batch's own stage field", () => {
    expect(batchItemFilter({ stage: "intake",  _id: "b1" })).toEqual({ intakeBatch: "b1" });
    expect(batchItemFilter({ stage: "shipped", _id: "b2" })).toEqual({ shippedBatch: "b2" });
    expect(batchItemFilter({ stage: "arrived", _id: "b3" })).toEqual({ arrivedBatch: "b3" });
  });
});

// ─── Bulk status ──────────────────────────────────────────────────────────────

describe("applyBulkStatus", () => {
  it("moves ordinary items and skips protected ones", async () => {
    stubFind([
      { _id: "1", status: "in_warehouse" },
      { _id: "2", status: "in_warehouse" },
      { _id: "3", status: "held" },
      { _id: "4", status: "delivered" },
      { _id: "5", status: "returned" },
      { _id: "6", status: "failed" },
    ]);

    const result = await applyBulkStatus({ containerRef: "X" }, "shipped", {
      performedBy: "staff-1",
      note:        "Container X moved to shipped",
    });

    expect(result.updated).toBe(2);
    expect(result.skipped).toBe(4);
    expect(result.skippedByStatus).toEqual({ held: 1, delivered: 1, returned: 1, failed: 1 });

    // Only the two movable items are written.
    const [query, update] = mockItemUpdateMany.mock.calls[0];
    expect(query).toEqual({ _id: { $in: ["1", "2"] } });
    expect(update.$set).toEqual({ status: "shipped" });
    expect(update.$push.stageHistory).toMatchObject({
      status:    "shipped",
      updatedBy: "staff-1",
      note:      "Container X moved to shipped",
    });
  });

  it("counts items already in the target status as unchanged, not updated", async () => {
    stubFind([
      { _id: "1", status: "shipped" },
      { _id: "2", status: "shipped" },
      { _id: "3", status: "in_warehouse" },
    ]);

    const result = await applyBulkStatus({}, "shipped", { performedBy: "staff-1" });

    expect(result.updated).toBe(1);
    expect(result.unchanged).toBe(2);
    expect(result.skipped).toBe(0);
  });

  it("writes nothing when every item is protected or already correct", async () => {
    stubFind([
      { _id: "1", status: "held" },
      { _id: "2", status: "shipped" },
    ]);

    const result = await applyBulkStatus({}, "shipped", { performedBy: "staff-1" });

    expect(result.updated).toBe(0);
    expect(mockItemUpdateMany).not.toHaveBeenCalled();
  });

  it("is a no-op for a container that cannot have items", async () => {
    const result = await applyBulkStatus(null, "shipped", { performedBy: "staff-1" });

    expect(result).toEqual({ updated: 0, skipped: 0, unchanged: 0, skippedByStatus: {} });
    expect(mockItemFind).not.toHaveBeenCalled();
  });
});

// ─── Messaging ────────────────────────────────────────────────────────────────

describe("describeBulkResult", () => {
  it("reports what moved and what was left alone", () => {
    expect(describeBulkResult({ updated: 42, skipped: 3, skippedByStatus: { held: 1, delivered: 2 } }))
      .toBe("42 shipment(s) synced, 3 skipped (1 held, 2 delivered)");
  });

  it("omits the skipped clause when nothing was skipped", () => {
    expect(describeBulkResult({ updated: 5, skipped: 0, skippedByStatus: {} }))
      .toBe("5 shipment(s) synced");
  });

  it("says nothing at all when nothing happened", () => {
    expect(describeBulkResult({ updated: 0, skipped: 0, skippedByStatus: {} })).toBe("");
    expect(describeBulkResult(null)).toBe("");
  });

  it("renders multi-word statuses readably", () => {
    expect(describeBulkResult({ updated: 1, skipped: 1, skippedByStatus: { ready_for_pickup: 1 } }))
      .toBe("1 shipment(s) synced, 1 skipped (1 ready for pickup)");
  });
});

// ─── Status vocabulary ────────────────────────────────────────────────────────

describe("status vocabulary", () => {
  it("maps every container status onto a status the item model accepts", () => {
    // Read the enum straight out of the model source so the test fails if the
    // two drift apart.
    const src  = require("fs").readFileSync(require.resolve("../src/models/ShipmentItem"), "utf8");
    const body = src.slice(src.indexOf("status: {"), src.indexOf("default: \"in_warehouse\""));
    const allowed = (body.match(/"[a-z_]+"/g) || []).map((s) => s.replace(/"/g, ""));

    for (const itemStatus of Object.values(CONTAINER_TO_ITEM_STATUS)) {
      expect(allowed).toContain(itemStatus);
    }
    for (const manual of MANUAL_ITEM_STATUSES) {
      expect(allowed).toContain(manual);
    }
  });

  it("covers all five container states", () => {
    expect(Object.keys(CONTAINER_TO_ITEM_STATUS).sort())
      .toEqual(["arrived", "at_port", "loading", "ready", "shipped"]);
  });

  it("never lets a bulk change overwrite an exception or terminal state", () => {
    expect([...PROTECTED_ITEM_STATUSES].sort())
      .toEqual(["delivered", "failed", "held", "returned"]);
  });

  it("keeps protected statuses out of the container mapping", () => {
    for (const mapped of Object.values(CONTAINER_TO_ITEM_STATUS)) {
      expect(PROTECTED_ITEM_STATUSES.has(mapped)).toBe(false);
    }
  });
});

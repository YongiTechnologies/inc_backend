"use strict";

/**
 * Golden tests over the REAL sample spreadsheets (two Goods-Received sheets and
 * two container loading lists). These prove the two-layer model does what the
 * date-based approach never could: link parcels across stages by tracking
 * number regardless of which day they were received or which container they
 * ended up in, in any upload order.
 */

const fs = require("fs");
const path = require("path");
const { buildObservations } = require("../src/services/observations");
const { deriveParcels } = require("../src/services/parcelDerivation");

const FX = path.join(__dirname, "fixtures");
const load = (name, at) =>
  buildObservations(fs.readFileSync(path.join(FX, name)), { filename: name, uploadedAt: at });

// Deliberately built in a "loading first, intake later" order to exercise
// out-of-order upload — the case that breaks the mutate-in-place pipeline.
const N200 = load("loading_N200_31-07-2026.xlsx", new Date("2026-08-01"));
const N201 = load("loading_N201_01-08-2026.xlsx", new Date("2026-08-02"));
const GR24 = load("goods_received_24-07-2026.xlsx", new Date("2026-08-03"));
const GR31 = load("goods_received_31-07-2026.xlsx", new Date("2026-08-04"));

const ALL_OBS = [...N200.observations, ...N201.observations, ...GR24.observations, ...GR31.observations];

describe("observation emitter", () => {
  test("stages are detected and normalised", () => {
    expect(GR24.stage).toBe("intake");
    expect(N200.stage).toBe("loading");
  });

  test("multi-tracking cells are exploded into separate observations", () => {
    const multi = ALL_OBS.filter((o) => o.tokenIndex >= 1);
    expect(multi.length).toBeGreaterThan(0);
  });

  test("loading observations carry a received-at-warehouse date spanning many days", () => {
    const days = new Set(
      N200.observations
        .filter((o) => o.receivedDate)
        .map((o) => new Date(o.receivedDate).toISOString().slice(0, 10))
    );
    // The whole point: one container draws from many intake days.
    expect(days.size).toBeGreaterThanOrEqual(4);
  });
});

describe("cross-stage derivation over all four files", () => {
  const parcels = deriveParcels(ALL_OBS);

  const intakeWaybills = new Set(ALL_OBS.filter((o) => o.stage === "intake" && o.waybill).map((o) => o.waybill));
  const loadingWaybills = new Set(ALL_OBS.filter((o) => o.stage === "loading" && o.waybill).map((o) => o.waybill));
  const shared = [...loadingWaybills].filter((w) => intakeWaybills.has(w));

  test("there IS cross-file overlap to resolve (sanity)", () => {
    expect(shared.length).toBeGreaterThan(50); // ~134 from the N201↔GR31 overlap
  });

  test("every waybill seen at both intake and loading yields a parcel with both stages populated", () => {
    const byWaybill = new Map();
    for (const p of parcels) {
      if (!byWaybill.has(p.waybill)) byWaybill.set(p.waybill, []);
      byWaybill.get(p.waybill).push(p);
    }
    const failures = shared.filter((w) => {
      const ps = byWaybill.get(w) || [];
      return !ps.some((p) => p.intake && (p.loading || p.arrival));
    });
    expect(failures).toEqual([]);
  });

  test("reconciliation buckets fall out as queries, and are non-trivial", () => {
    const receivedNotLoaded = parcels.filter((p) => p.flags.receivedNotLoaded);
    const loadedNeverReceived = parcels.filter((p) => p.flags.loadedNeverReceived);
    expect(receivedNotLoaded.length).toBeGreaterThan(0);   // in warehouse, awaiting a container
    expect(loadedNeverReceived.length).toBeGreaterThan(0); // packed but intake sheet missing (N200's days aren't all here)
  });

  test("a loaded-but-never-received parcel still knows when it was received (synthetic intake fact)", () => {
    const loadedNeverReceived = parcels.filter((p) => p.flags.loadedNeverReceived);
    const withDate = loadedNeverReceived.filter((p) => p.receivedDate);
    // The loading list's RECEIVING DATE column rescues the received-date even
    // though the intake sheet for those days was never uploaded.
    expect(withDate.length).toBeGreaterThan(loadedNeverReceived.length * 0.8);
  });

  test("derivation is order-independent on the real data", () => {
    const norm = (ps) =>
      JSON.stringify(
        [...ps]
          .map((p) => ({ w: p.waybill, k: p.customerKey, s: p.currentStage }))
          .sort((a, b) => (a.w + a.k).localeCompare(b.w + b.k))
      );
    expect(norm(deriveParcels([...ALL_OBS].reverse()))).toBe(norm(parcels));
  });
});

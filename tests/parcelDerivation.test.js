"use strict";

/**
 * Pure unit tests for the derivation core. No DB, no fixtures — synthetic
 * observations exercise the identity/partition/fold rules and the two
 * structural guarantees the whole redesign rests on: order-independence and
 * idempotency.
 */

const {
  deriveParcels,
  partitionByCustomer,
  buildAliasMap,
} = require("../src/services/parcelDerivation");

let seq = 0;
/** Build a synthetic observation with sensible defaults. */
function ob(over = {}) {
  const o = {
    fileHash: "f",
    stage: "intake",
    srcRow: ++seq,
    tokenIndex: 0,
    waybill: "WB1",
    customerPhone: null,
    shippingMark: null,
    customerName: null,
    customerKey: null,
    needsPhone: true,
    receivedDate: null,
    eventDate: null,
    qty: null,
    qtyRaw: null,
    cbm: null,
    productDescription: null,
    financials: {},
    container: null,
    uploadedAt: new Date("2026-07-31T00:00:00Z"),
    ...over,
  };
  // Mirror the parser: customerKey is phone > mark > name.
  if (!o.customerKey) {
    o.customerKey = o.customerPhone ? `p:${o.customerPhone}`
      : o.shippingMark ? `m:${o.shippingMark}`
      : o.customerName ? `n:${o.customerName.toUpperCase().replace(/[^A-Z0-9]/g, "")}`
      : `r:ROW${o.srcRow}`;
  }
  return o;
}

const sortParcels = (ps) =>
  [...ps].sort((a, b) => (a.waybill + a.customerKey).localeCompare(b.waybill + b.customerKey));

describe("partitionByCustomer", () => {
  test("a shared waybill with two phoned customers → two parcels", () => {
    const obs = [
      ob({ waybill: "WB", customerPhone: "233111" }),
      ob({ waybill: "WB", customerPhone: "233222" }),
    ];
    expect(partitionByCustomer(obs).length).toBe(2);
  });

  test("same customer as phone on one sheet and mark on another → one parcel (via alias evidence)", () => {
    const obs = [
      ob({ waybill: "WB", stage: "intake", shippingMark: "ANGIE" }),                 // mark only
      ob({ waybill: "WB", stage: "loading", customerPhone: "233999", shippingMark: "ANGIE" }), // ties mark→phone
    ];
    const alias = buildAliasMap(obs);
    expect(partitionByCustomer(obs, alias).length).toBe(1);
  });

  test("an unidentifiable row is absorbed into the sole identified customer", () => {
    const obs = [
      ob({ waybill: "WB", customerPhone: "233111" }),
      ob({ waybill: "WB", customerKey: null, customerPhone: null }), // r: row-only
    ];
    expect(partitionByCustomer(obs).length).toBe(1);
  });

  test("with several identified customers, an unidentifiable row stays separate (no guessing)", () => {
    const obs = [
      ob({ waybill: "WB", customerPhone: "233111" }),
      ob({ waybill: "WB", customerPhone: "233222" }),
      ob({ waybill: "WB", customerKey: null, customerPhone: null }),
    ];
    expect(partitionByCustomer(obs).length).toBe(3);
  });
});

describe("foldParcel via deriveParcels", () => {
  test("intake only → received, receivedNotLoaded", () => {
    const [p] = deriveParcels([ob({ stage: "intake", customerPhone: "233111", eventDate: new Date("2026-07-24") })]);
    expect(p.currentStage).toBe("intake");
    expect(p.status).toBe("received");
    expect(p.flags.receivedNotLoaded).toBe(true);
    expect(p.flags.loadedNeverReceived).toBe(false);
  });

  test("loading with a RECEIVING DATE but no intake sheet → loadedNeverReceived, yet receivedDate is still known", () => {
    const [p] = deriveParcels([
      ob({ stage: "loading", customerPhone: "233111", receivedDate: new Date("2026-07-28"), eventDate: new Date("2026-07-31") }),
    ]);
    expect(p.currentStage).toBe("loading");
    expect(p.flags.loadedNeverReceived).toBe(true);
    expect(p.receivedDate).toEqual(new Date("2026-07-28")); // synthetic intake fact
  });

  test("intake then loading for one parcel → single parcel, currentStage loading, no gap flags", () => {
    const obs = [
      ob({ stage: "intake", waybill: "WBX", customerPhone: "233111", qty: 3 }),
      ob({ stage: "loading", waybill: "WBX", customerPhone: "233111", qty: 3 }),
    ];
    const parcels = deriveParcels(obs);
    expect(parcels.length).toBe(1);
    expect(parcels[0].currentStage).toBe("loading");
    expect(parcels[0].flags.receivedNotLoaded).toBe(false);
    expect(parcels[0].flags.loadedNeverReceived).toBe(false);
  });

  test("qty mismatch between intake and loading is flagged", () => {
    const obs = [
      ob({ stage: "intake", waybill: "WBY", customerPhone: "233111", qty: 2 }),
      ob({ stage: "loading", waybill: "WBY", customerPhone: "233111", qty: 5 }),
    ];
    expect(deriveParcels(obs)[0].flags.qtyMismatch).toBe(true);
  });
});

describe("structural guarantees", () => {
  const scenario = [
    ob({ stage: "intake", waybill: "A", customerPhone: "233111", qty: 1 }),
    ob({ stage: "intake", waybill: "B", customerPhone: "233222", qty: 2 }),
    ob({ stage: "loading", waybill: "A", customerPhone: "233111", qty: 1 }),
    ob({ stage: "loading", waybill: "C", customerPhone: "233333", receivedDate: new Date("2026-07-27") }),
    ob({ stage: "intake", waybill: "B", shippingMark: "ANGIE" }),
  ];

  test("order-independent: shuffling observations yields identical parcels", () => {
    const base = sortParcels(deriveParcels(scenario));
    const shuffled = sortParcels(deriveParcels([...scenario].reverse()));
    expect(JSON.stringify(shuffled)).toBe(JSON.stringify(base));
  });

  test("idempotent: deriving the same set twice yields identical parcels", () => {
    const once = sortParcels(deriveParcels(scenario));
    const twice = sortParcels(deriveParcels(scenario));
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
  });
});

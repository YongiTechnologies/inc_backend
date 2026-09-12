"use strict";

/**
 * Service-level tests for the ingestion pipeline, run against a compact
 * in-memory fake of the four collections (no live MongoDB). They prove the
 * behaviours that the mutate-in-place pipeline could not guarantee:
 *   - idempotency (re-uploading the same file is a no-op),
 *   - order-independence (loading-first then intake gives the same parcels as
 *     intake-first then loading),
 *   - revert (removing a file re-derives cleanly).
 *
 * (Names are `mock`-prefixed so Jest allows the mock factories to reference
 * them.)
 */

const fs   = require("fs");
const path = require("path");

let mockID = 0;
function mockMatch(doc, filter) {
  return Object.entries(filter).every(([k, cond]) => {
    const v = doc[k];
    if (cond && typeof cond === "object" && !(cond instanceof Date)) {
      if ("$in"  in cond) return cond.$in.includes(v);
      if ("$nin" in cond) return !cond.$nin.includes(v);
      if ("$ne"  in cond) return v !== cond.$ne;
      if ("$regex" in cond) return new RegExp(cond.$regex).test(String(v ?? ""));
    }
    return v === cond;
  });
}
function mockMakeCollection() {
  const docs = [];
  const chain = (rows) => ({
    lean: () => Promise.resolve(rows),
    sort: () => chain(rows),
    then: (res) => Promise.resolve(rows).then(res),
    distinct: (field) => Promise.resolve([...new Set(rows.map((r) => r[field]))]),
  });
  return {
    _docs: docs,
    find: (filter = {}) => chain(docs.filter((d) => mockMatch(d, filter))),
    findOne: (filter = {}) => {
      const ret = docs.find((d) => mockMatch(d, filter)) || null;
      return Object.assign(Promise.resolve(ret), { select: () => Promise.resolve(ret) });
    },
    create: async (obj) => {
      const doc = { _id: ++mockID, ...obj, save: async function () { return this; } };
      docs.push(doc);
      return doc;
    },
    insertMany: async (arr) => { arr.forEach((o) => docs.push({ _id: ++mockID, ...o })); return arr; },
    updateOne: async (filter, update, opts = {}) => {
      const existing = docs.find((d) => mockMatch(d, filter));
      const data = update.$set || update;
      if (existing) Object.assign(existing, data);
      else if (opts.upsert) docs.push({ _id: ++mockID, ...filter, ...data });
      return { acknowledged: true };
    },
    updateMany: async (filter, update) => {
      const data = update.$set || update;
      docs.filter((d) => mockMatch(d, filter)).forEach((d) => Object.assign(d, data));
      return { acknowledged: true };
    },
    deleteMany: async (filter = {}) => {
      let n = 0;
      for (let i = docs.length - 1; i >= 0; i--) if (mockMatch(docs[i], filter)) { docs.splice(i, 1); n++; }
      return { deletedCount: n };
    },
    countDocuments: async (filter = {}) => docs.filter((d) => mockMatch(d, filter)).length,
  };
}

const mockSourceFile       = mockMakeCollection();
const mockObservation      = mockMakeCollection();
const mockParcel           = mockMakeCollection();
const mockManualAdjustment = mockMakeCollection();
const mockUser             = mockMakeCollection();

jest.mock("../src/models/SourceFile",       () => mockSourceFile);
jest.mock("../src/models/Observation",      () => mockObservation);
jest.mock("../src/models/Parcel",           () => mockParcel);
jest.mock("../src/models/ManualAdjustment", () => mockManualAdjustment);
jest.mock("../src/models/User",             () => mockUser);

const ingest = require("../src/services/ingest.service");

const FX = path.join(__dirname, "fixtures");
const buf = (name) => fs.readFileSync(path.join(FX, name));
const GR31 = "goods_received_31-07-2026.xlsx";
const N201 = "loading_N201_01-08-2026.xlsx";

function reset() {
  for (const c of [mockSourceFile, mockObservation, mockParcel, mockManualAdjustment, mockUser]) c._docs.length = 0;
}
const snapshot = () =>
  JSON.stringify(
    mockParcel._docs
      .map((p) => ({ w: p.waybill, k: p.customerKey, s: p.currentStage, rnl: p.flags.receivedNotLoaded, lnr: p.flags.loadedNeverReceived }))
      .sort((a, b) => (a.w + a.k).localeCompare(b.w + b.k))
  );

describe("ingest.service", () => {
  beforeEach(reset);

  test("re-uploading the identical file is a detected no-op (idempotent)", async () => {
    await ingest.ingestFile(buf(GR31), { filename: GR31 });
    const after1 = mockParcel._docs.length;
    await expect(ingest.ingestFile(buf(GR31), { filename: GR31 })).rejects.toThrow(/already been uploaded/i);
    expect(mockParcel._docs.length).toBe(after1);
    expect(mockSourceFile._docs.length).toBe(1);
  });

  test("order-independent: loading→intake yields the same parcels as intake→loading", async () => {
    await ingest.ingestFile(buf(N201), { filename: N201, uploadedAt: new Date("2026-08-02") });
    await ingest.ingestFile(buf(GR31), { filename: GR31, uploadedAt: new Date("2026-08-04") });
    const loadingFirst = snapshot();

    reset();
    await ingest.ingestFile(buf(GR31), { filename: GR31, uploadedAt: new Date("2026-08-04") });
    await ingest.ingestFile(buf(N201), { filename: N201, uploadedAt: new Date("2026-08-02") });
    const intakeFirst = snapshot();

    expect(loadingFirst).toBe(intakeFirst);
  });

  test("a parcel received then loaded ends at stage 'loading' with no gap flags", async () => {
    await ingest.ingestFile(buf(GR31), { filename: GR31 });
    await ingest.ingestFile(buf(N201), { filename: N201 });
    const bothStages = mockParcel._docs.filter((p) => p.intake && p.loading);
    expect(bothStages.length).toBeGreaterThan(50);
    expect(bothStages.every((p) => p.currentStage === "loading")).toBe(true);
    expect(bothStages.some((p) => p.flags.receivedNotLoaded)).toBe(false);
  });

  test("reverting the loading list rolls parcels back to in-warehouse", async () => {
    await ingest.ingestFile(buf(GR31), { filename: GR31 });
    await ingest.ingestFile(buf(N201), { filename: N201 });
    expect(mockParcel._docs.filter((p) => p.currentStage === "loading").length).toBeGreaterThan(0);

    const n201 = mockSourceFile._docs.find((f) => f.stage === "loading");
    await ingest.revertFile(n201.fileHash);

    expect(mockParcel._docs.some((p) => p.currentStage === "loading" && p.loading)).toBe(false);
    expect(mockParcel._docs.filter((p) => p.flags.receivedNotLoaded).length).toBeGreaterThan(0);
  });
});

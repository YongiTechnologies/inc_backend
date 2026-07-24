"use strict";

/**
 * Unit tests for parseUnifiedSheet and the thin wrapper parsers.
 *
 * Parser tests are pure (no DB). Processor tests mock mongoose models so
 * they run without a live MongoDB connection.
 */

const path = require("path");
const fs   = require("fs");
const XLSX = require("xlsx");

// ─── Mock mongoose models before requiring the service ────────────────────────

const mockBatchCreate         = jest.fn();
const mockBatchFindOne        = jest.fn();
const mockBatchFind           = jest.fn();
const mockBatchFindByIdUpdate = jest.fn();
const mockBatchFindById       = jest.fn();
const mockItemCreate          = jest.fn();
const mockItemFindOne         = jest.fn();
const mockItemUpdateMany      = jest.fn();
const mockUserFindOne         = jest.fn();
const mockContainerUpdate     = jest.fn();

jest.mock("../src/models/Batch", () => ({
  create:           (...a) => mockBatchCreate(...a),
  findOne:          (...a) => mockBatchFindOne(...a),
  find:             (...a) => mockBatchFind(...a),
  findByIdAndUpdate:(...a) => mockBatchFindByIdUpdate(...a),
  findById:         (...a) => mockBatchFindById(...a),
}));

jest.mock("../src/models/ShipmentItem", () => ({
  create:         (...a) => mockItemCreate(...a),
  findOne:        (...a) => mockItemFindOne(...a),
  updateMany:     (...a) => mockItemUpdateMany(...a),
  find:           () => ({ select: () => ({ lean: () => Promise.resolve([]) }) }),
  countDocuments: () => Promise.resolve(0),
}));

jest.mock("../src/models/User", () => ({
  findOne: (...a) => mockUserFindOne(...a),
}));

jest.mock("../src/models/ContainerLoading", () => ({
  findOneAndUpdate: (...a) => mockContainerUpdate(...a),
}));

const { parseUnifiedSheet, parseIntakeSheet, parseShippedSheet, parseArrivedSheet,
        processIntakeBatch, processShippedBatch } = require("../src/services/batch.service");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function loadFixture(relativePath) {
  return fs.readFileSync(path.join(__dirname, relativePath));
}

function buildXlsx(aoa) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

// ─── Template round-trip tests ────────────────────────────────────────────────

describe("docs/excel-templates — canonical templates parse cleanly", () => {
  test("intake-template.xlsx: stage=intake, zero headerWarnings, items populated", () => {
    const buf    = loadFixture("../docs/excel-templates/intake-template.xlsx");
    const result = parseUnifiedSheet(buf);

    expect(result.stage).toBe("intake");
    expect(result.headerWarnings).toHaveLength(0);
    expect(result.missingColumns).toHaveLength(0);
    expect(result.items.length).toBeGreaterThanOrEqual(3);

    const first = result.items[0];
    expect(first.waybillNo).toBe("301977756976");
    expect(first.customerPhone).toMatch(/^233/);
  });

  test("intake-template.xlsx: split waybill cell produces two items", () => {
    const buf    = loadFixture("../docs/excel-templates/intake-template.xlsx");
    const result = parseUnifiedSheet(buf);
    // Row with "301977756978 301977756979" must produce two separate items
    const waybills = result.items.map((i) => i.waybillNo);
    expect(waybills).toContain("301977756978");
    expect(waybills).toContain("301977756979");
  });

  test("loading-template.xlsx: stage=shipped, zero headerWarnings, CBM populated", () => {
    const buf    = loadFixture("../docs/excel-templates/loading-template.xlsx");
    const result = parseUnifiedSheet(buf);

    expect(result.stage).toBe("shipped");
    expect(result.headerWarnings).toHaveLength(0);
    expect(result.missingColumns).toHaveLength(0);
    expect(result.items.length).toBeGreaterThanOrEqual(4);

    // Every item that has a numeric CBM cell must have cbm populated
    result.items.forEach((item) => {
      expect(typeof item.cbm).toBe("number");
      expect(isNaN(item.cbm)).toBe(false);
    });
  });

  test("loading-template.xlsx: metadata parsed correctly", () => {
    const buf    = loadFixture("../docs/excel-templates/loading-template.xlsx");
    const result = parseUnifiedSheet(buf);

    expect(result.metadata.CONTAINER_NUMBER).toBe("MSBU8308501");
    expect(result.metadata.BL_NUMBER).toBe("MEDUGZ123456");
    expect(result.metadata.BATCH_REF).toBe("2025-004");
    expect(result.metadata.LOADING_DATE).toBeInstanceOf(Date);
  });

  test("loading-template.xlsx: OTHER column flows into remarks", () => {
    const buf    = loadFixture("../docs/excel-templates/loading-template.xlsx");
    const result = parseUnifiedSheet(buf);
    const itemWithRemarks = result.items.find((i) => i.remarks);
    expect(itemWithRemarks).toBeDefined();
    expect(itemWithRemarks.remarks).toContain("FORK FEE");
  });

  test("arrived-template.xlsx: stage=arrived, zero headerWarnings", () => {
    const buf    = loadFixture("../docs/excel-templates/arrived-template.xlsx");
    const result = parseUnifiedSheet(buf);

    expect(result.stage).toBe("arrived");
    expect(result.headerWarnings).toHaveLength(0);
    expect(result.missingColumns).toHaveLength(0);
    expect(result.items.length).toBeGreaterThanOrEqual(4);
    expect(result.metadata.CONTAINER_NUMBER).toBe("MSBU8308501");
    expect(result.metadata.ARRIVAL_DATE).toBeInstanceOf(Date);
  });
});

// ─── Legacy fixture tests ─────────────────────────────────────────────────────

describe("tests/fixtures/loading_for_20th_April.xlsx — legacy file (no STAGE field)", () => {
  let result;

  beforeAll(() => {
    const buf = loadFixture("fixtures/loading_for_20th_April.xlsx");
    result    = parseUnifiedSheet(buf);
  });

  test("falls back to 'shipped' stage via header-signature detection", () => {
    expect(result.stage).toBe("shipped");
  });

  test("CBM populated for every data row", () => {
    expect(result.items.length).toBeGreaterThanOrEqual(5);
    result.items.forEach((item) => {
      expect(typeof item.cbm).toBe("number");
      expect(isNaN(item.cbm)).toBe(false);
    });
  });

  test("TRACKING N0. aliases JOB NUMBER — waybills populated", () => {
    const waybills = result.items.map((i) => i.waybillNo);
    expect(waybills).toContain("301977756976");
    expect(waybills).toContain("301977756980");
  });

  test("totals row (numeric CNEE NAME) is skipped", () => {
    const waybills = result.items.map((i) => i.waybillNo);
    // The totals row has no waybill; skippedRows count should be > 0
    expect(result.skippedRows.length).toBeGreaterThanOrEqual(1);
    // No item should have a purely-numeric customerName
    result.items.forEach((item) => {
      if (item.customerName) {
        expect(/^\d+(\.\d+)?$/.test(item.customerName)).toBe(false);
      }
    });
  });

  test("REMARKS column from legacy file flows through to item.remarks", () => {
    const withRemarks = result.items.find((i) => i.remarks);
    expect(withRemarks).toBeDefined();
    expect(withRemarks.remarks).toContain("FORK FEE");
  });

  test("container metadata extracted from CTR NUMBER", () => {
    expect(result.metadata.CONTAINER_NUMBER).toBe("MSBU8308501");
  });
});

// ─── Stage wrapper assertion tests ───────────────────────────────────────────

describe("wrapper parsers assert stage", () => {
  const loadingBuf = () => loadFixture("../docs/excel-templates/loading-template.xlsx");
  const intakeBuf  = () => loadFixture("../docs/excel-templates/intake-template.xlsx");

  test("parseShippedSheet accepts a LOADING file", () => {
    expect(() => parseShippedSheet(loadingBuf())).not.toThrow();
  });

  test("parseShippedSheet rejects an INTAKE file", () => {
    expect(() => parseShippedSheet(intakeBuf())).toThrow(/INTAKE/i);
  });

  test("parseIntakeSheet accepts an INTAKE file", () => {
    expect(() => parseIntakeSheet(intakeBuf())).not.toThrow();
  });

  test("parseIntakeSheet rejects a LOADING file", () => {
    expect(() => parseIntakeSheet(loadingBuf())).toThrow(/SHIPPED/i);
  });
});

// ─── CBM column alias tests ───────────────────────────────────────────────────

describe("CBM alias resolution", () => {
  function makeLoadingBuf(cbmHeader) {
    return buildXlsx([
      ["STAGE",    "LOADING"],
      ["CTR NUMBER", "TESTCTR001"],
      [null, null], [null, null], [null, null],
      [null, null], [null, null], [null, null], [null, null], [null, null],
      ["TRACKING N0.", "CNEE NAME", "PHONE NUMBER", cbmHeader],
      ["TR001", "Test Customer", "0244100001", 0.15],
      ["TR002", "Test Customer", "0244100002", 0.22],
    ]);
  }

  ["CBM", "CBM PER TRACKING", "C.B.M", "CBM (M3)"].forEach((alias) => {
    test(`"${alias}" resolves to cbm field`, () => {
      const result = parseUnifiedSheet(makeLoadingBuf(alias));
      expect(result.headerWarnings).not.toContain(expect.stringContaining(alias));
      expect(result.items[0].cbm).toBe(0.15);
      expect(result.items[1].cbm).toBe(0.22);
    });
  });
});

// ─── TRACKING_NO alias tests ──────────────────────────────────────────────────

describe("TRACKING_NO alias resolution", () => {
  function makeSheetWithTrackingHeader(header) {
    return buildXlsx([
      ["STAGE", "LOADING"],
      [null, null], [null, null], [null, null], [null, null],
      [null, null], [null, null], [null, null], [null, null], [null, null],
      [header, "CNEE NAME", "PHONE NUMBER", "CBM"],
      ["WAYBILL001", "Customer A", "0244100001", 0.1],
    ]);
  }

  ["TRACKING N0.", "TRACKING NO.", "TRACKING NUMBER", "WAYBILL", "JOB NUMBER", "JOB NO."].forEach((alias) => {
    test(`"${alias}" correctly identifies the tracking column`, () => {
      const result = parseUnifiedSheet(makeSheetWithTrackingHeader(alias));
      expect(result.items).toHaveLength(1);
      expect(result.items[0].waybillNo).toBe("WAYBILL001");
    });
  });
});

// ─── processIntakeBatch + processShippedBatch integration ────────────────────

describe("Status transition: in_warehouse → shipped when TRACKING N0. matches", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockBatchFindOne.mockResolvedValue(null);     // no duplicate
    // Batch.find().select("_id") returns a thenable — mock the chained call
    mockBatchFind.mockReturnValue({ select: () => Promise.resolve([]) });
    mockBatchCreate.mockImplementation((doc) => Promise.resolve({ _id: "batch001", ...doc }));
    mockBatchFindByIdUpdate.mockResolvedValue(null);
    mockBatchFindById.mockResolvedValue({ _id: "batch001", batchCode: "INTAKE-2025-04-01" });
    mockItemCreate.mockResolvedValue({});
    mockItemUpdateMany.mockResolvedValue({ modifiedCount: 0 });
    mockUserFindOne.mockReturnValue({ select: () => Promise.resolve(null) });
  });

  test("existing in_warehouse item is updated to shipped via TRACKING N0.", async () => {
    const intakeBuf = loadFixture("../docs/excel-templates/intake-template.xlsx");
    const intakeParsed = parseIntakeSheet(intakeBuf);

    // Simulate processIntakeBatch — item "301977756976" is already in DB
    mockItemFindOne.mockResolvedValue(null); // new item for intake
    await processIntakeBatch(intakeParsed, "user001", "intake-template.xlsx");
    expect(mockItemCreate).toHaveBeenCalled();

    // Now simulate processShippedBatch with loading file that shares TRACKING N0.
    const loadingBuf    = loadFixture("../docs/excel-templates/loading-template.xlsx");
    const loadingParsed = parseShippedSheet(loadingBuf);

    // Mock: item exists with status=in_warehouse
    const fakeItem = {
      waybillNo:    "301977756976",
      status:       "in_warehouse",
      stageHistory: [],
      save:         jest.fn().mockResolvedValue(true),
    };
    mockItemFindOne.mockResolvedValue(fakeItem);

    await processShippedBatch(loadingParsed, "user001");

    // item.status should have been set to "shipped"
    expect(fakeItem.status).toBe("shipped");
    expect(fakeItem.save).toHaveBeenCalled();
    expect(fakeItem.stageHistory).toHaveLength(1);
    expect(fakeItem.stageHistory[0].status).toBe("shipped");
  });
});

// ─── Unrecognized column warning ──────────────────────────────────────────────

describe("headerWarnings for unrecognized columns", () => {
  test("unknown column produces a headerWarning", () => {
    const buf = buildXlsx([
      ["STAGE", "LOADING"],
      [null, null], [null, null], [null, null], [null, null],
      [null, null], [null, null], [null, null], [null, null], [null, null],
      ["TRACKING N0.", "CNEE NAME", "PHONE NUMBER", "CBM", "UNKNOWN_FIELD_XYZ"],
      ["TR001", "Customer", "0244100001", 0.1, "some_value"],
    ]);
    const result = parseUnifiedSheet(buf);
    expect(result.headerWarnings.some((w) => w.includes("UNKNOWN_FIELD_XYZ"))).toBe(true);
  });

  test("missing TRACKING_NO column appears in missingColumns", () => {
    const buf = buildXlsx([
      ["STAGE", "LOADING"],
      [null, null], [null, null], [null, null], [null, null],
      [null, null], [null, null], [null, null], [null, null], [null, null],
      ["CNEE NAME", "PHONE NUMBER", "CBM"],
      ["Customer", "0244100001", 0.1],
    ]);
    const result = parseUnifiedSheet(buf);
    expect(result.missingColumns).toContain("TRACKING_NO");
  });
});

// ─── Legacy positional intake (backwards compat) ──────────────────────────────

describe("legacy positional intake (no header row)", () => {
  test("parses 5-column positional format and defaults stage to intake", () => {
    const buf = buildXlsx([
      // No metadata block, no header — raw data rows
      ["INV-001", "WAYBILL100", "0244100001", "2pallet", new Date("2025-01-15")],
      ["INV-002", "WAYBILL101", "0244100002", "1pallet", new Date("2025-01-15")],
    ]);
    const result = parseUnifiedSheet(buf);
    expect(result.stage).toBe("intake");
    expect(result.items).toHaveLength(2);
    expect(result.items[0].waybillNo).toBe("WAYBILL100");
    expect(result.items[0].invoiceNo).toBe("INV-001");
    expect(result.items[0].customerPhone).toMatch(/^233/);
  });
});

// ─── Header-less container / packing list (N151-style) ────────────────────────

describe("container list (no headers, positional)", () => {
  test("title-row layout parses as shipped with container/batch and locations", () => {
    const buf = buildXlsx([
      // Title row — "-<batchRef>-<CONTAINER>"
      ["12th/Jul 2026--N999-ABCU1234567", null, null, null, null, null, null, null],
      [null,   "GH111", "0244000001", "Ama",  null,       2, 0.5, null],
      [null,   "GH222", "0244000002", "Kojo", "KUMASI",   1, 0.3, "SHOES"],
      [null,   "GH333", "0244000003", "Yaa",  "TAMALE",   3, 1.2, null],
      [8888,   "GH444", "0244000004", "Kofi", "TAKORADI", 1, 0.2, null],
      // Totals / junk row — no tracking, no phone → skipped
      [null,   null,    null,         null,   null,      null, 50.5, null],
    ]);
    const result = parseUnifiedSheet(buf);

    expect(result.stage).toBe("shipped");
    expect(result.missingColumns).toHaveLength(0);
    expect(result.metadata.CONTAINER_NUMBER).toBe("ABCU1234567");
    expect(result.metadata.BATCH_REF).toBe("N999");
    expect(result.items).toHaveLength(4);

    const byWaybill = Object.fromEntries(result.items.map((i) => [i.waybillNo, i]));
    expect(byWaybill.GH111.destinationCity).toBeNull();       // blank = Accra downstream
    expect(byWaybill.GH222.destinationCity).toBe("KUMASI");
    expect(byWaybill.GH333.destinationCity).toBe("TAMALE");
    expect(byWaybill.GH444.destinationCity).toBe("TAKORADI");
    expect(byWaybill.GH111.cbm).toBeCloseTo(0.5);
    expect(byWaybill.GH111.customerPhone).toMatch(/^233/);
  });

  test("blank name is carried forward from a prior row with the same phone", () => {
    const buf = buildXlsx([
      ["1st/Jan 2026--N001-ABCU7654321", null, null, null, null, null, null, null],
      [null, "TRK1", "0244000009", "CELESTINA", null, 1, 0.3, "CHAIR"],
      [null, "TRK2", "0244000009", null,         null, 2, 4.7, "TENTS"], // continuation
    ]);
    const result = parseUnifiedSheet(buf);
    const cont = result.items.find((i) => i.waybillNo === "TRK2");
    expect(cont.customerName).toBe("CELESTINA");
  });
});

// ─── Opt-in auto-hold on packing-list upload ──────────────────────────────────

describe("processShippedBatch auto-hold is opt-in", () => {
  const parsed = {
    metadata: { CONTAINER_NUMBER: "CTRTEST01", BATCH_REF: "N777" },
    items:    [{ waybillNo: "WBHOLD1", customerPhone: "233200000001" }],
    skippedRows: [],
  };

  beforeEach(() => {
    jest.clearAllMocks();
    mockBatchFindOne.mockResolvedValue(null);
    mockBatchFind.mockReturnValue({ select: () => Promise.resolve([]) });
    mockBatchCreate.mockImplementation((doc) => Promise.resolve({ _id: "batchHold", ...doc }));
    mockBatchFindByIdUpdate.mockResolvedValue(null);
    mockBatchFindById.mockResolvedValue({ _id: "batchHold", batchCode: "PKL-N777" });
    mockItemFindOne.mockResolvedValue(null); // new item, no match
    mockItemCreate.mockResolvedValue({});
    mockItemUpdateMany.mockResolvedValue({ modifiedCount: 5 });
    mockUserFindOne.mockReturnValue({ select: () => Promise.resolve(null) });
    mockContainerUpdate.mockResolvedValue({});
  });

  test("default (no options): does NOT hold warehouse items", async () => {
    const result = await processShippedBatch(parsed, "user001");
    expect(mockItemUpdateMany).not.toHaveBeenCalled();
    expect(result.batch).toBeDefined();
  });

  test("autoHold=true: holds warehouse items not on the list", async () => {
    await processShippedBatch(parsed, "user001", { autoHold: true });
    expect(mockItemUpdateMany).toHaveBeenCalledTimes(1);
    const [query] = mockItemUpdateMany.mock.calls[0];
    expect(query.status).toBe("in_warehouse");
    // Smarter matching: excludes items whose phone is on the list
    expect(query.$or).toEqual(
      expect.arrayContaining([{ customerPhone: expect.anything() }])
    );
  });
});

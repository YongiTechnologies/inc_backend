"use strict";

/**
 * Shared tracking numbers and shipping-mark identity.
 *
 * Real sheets routinely put several customers on one tracking number (a
 * consolidated shipment), and identify some of them by a shipping mark written
 * into the CONTACT column instead of a phone. Matching on waybillNo alone used
 * to drop every row after the first, or overwrite the first customer's record
 * with the second's details.
 */

const XLSX = require("xlsx");

// ─── Mock mongoose models before requiring the service ────────────────────────

const mockBatchCreate         = jest.fn();
const mockBatchFindOne        = jest.fn();
const mockBatchFind           = jest.fn();
const mockBatchFindByIdUpdate = jest.fn();
const mockBatchFindById       = jest.fn();
const mockItemCreate          = jest.fn();
const mockItemFindOne         = jest.fn();
const mockItemFind            = jest.fn();
const mockItemUpdateOne       = jest.fn();
const mockItemUpdateMany      = jest.fn();
const mockUserFindOne         = jest.fn();
const mockContainerUpdate     = jest.fn();

// find() is awaited directly when prefetching an upload's existing records, and
// chained as .select().lean() elsewhere, so the double supports both shapes.
function mockItemFindResult() {
  const rows = mockItemFind();
  const list = Array.isArray(rows) ? rows : [];
  return Object.assign(Promise.resolve(list), {
    select: () => ({ lean: () => Promise.resolve(list) }),
    lean:   () => Promise.resolve(list),
  });
}

jest.mock("../src/models/Batch", () => ({
  create:            (...a) => mockBatchCreate(...a),
  findOne:           (...a) => mockBatchFindOne(...a),
  find:              (...a) => mockBatchFind(...a),
  findByIdAndUpdate: (...a) => mockBatchFindByIdUpdate(...a),
  findById:          (...a) => mockBatchFindById(...a),
}));

jest.mock("../src/models/ShipmentItem", () => ({
  create:         (...a) => mockItemCreate(...a),
  findOne:        (...a) => mockItemFindOne(...a),
  updateOne:      (...a) => mockItemUpdateOne(...a),
  updateMany:     (...a) => mockItemUpdateMany(...a),
  find:           () => mockItemFindResult(),
  countDocuments: () => Promise.resolve(0),
}));

jest.mock("../src/models/User", () => ({
  findOne: (...a) => mockUserFindOne(...a),
}));

jest.mock("../src/models/ContainerLoading", () => ({
  findOneAndUpdate: (...a) => mockContainerUpdate(...a),
}));

const {
  parseUnifiedSheet, parseIntakeSheet, parseShippedSheet,
  processIntakeBatch, processShippedBatch,
  resolveContact, buildCustomerKey, normaliseMark,
  maskName, maskPhone, maskMark, narrowToCustomer,
} = require("../src/services/batch.service");

function buildXlsx(aoa) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  return XLSX.write(wb, { type: "buffer", bookType: "xlsx" });
}

// ─── Contact resolution ───────────────────────────────────────────────────────

describe("resolveContact — CONTACT holds either a phone or a shipping mark", () => {
  test("a plain phone normalises as before", () => {
    const r = resolveContact("0244100001");
    expect(r.customerPhone).toBe("233244100001");
    expect(r.shippingMark).toBeNull();
    expect(r.needsPhone).toBe(false);
  });

  test("9-digit and 233-prefixed forms both normalise", () => {
    expect(resolveContact("200779950").customerPhone).toBe("233200779950");
    expect(resolveContact("233244100001").customerPhone).toBe("233244100001");
  });

  test("a shipping mark is captured instead of discarded", () => {
    const r = resolveContact("ACC-28672");
    expect(r.customerPhone).toBeNull();
    expect(r.shippingMark).toBe("ACC28672");
    expect(r.shippingMarkRaw).toBe("ACC-28672");
    expect(r.needsPhone).toBe(true);
  });

  test("case and separators collapse so one customer is one mark", () => {
    const marks = ["TAM311333", "TAM-311333", "tam-311333"].map((s) => resolveContact(s).shippingMark);
    expect(new Set(marks).size).toBe(1);
    expect(marks[0]).toBe("TAM311333");
  });

  test("a name-style mark is captured too", () => {
    expect(resolveContact("ANGIE").shippingMark).toBe("ANGIE");
  });

  test("a phone written alongside a name still yields the phone", () => {
    // Real intake sheets contain cells like this; reading the cell as a mark
    // would throw away a perfectly good phone number.
    const r = resolveContact("0242582198 Priscilla Aboni");
    expect(r.customerPhone).toBe("233242582198");
    expect(r.shippingMark).toBeNull();
    expect(r.needsPhone).toBe(false);
  });

  test("a long mark is not mistaken for a phone on digit count alone", () => {
    const r = resolveContact("TAM3113330");
    expect(r.customerPhone).toBeNull();
    expect(r.shippingMark).toBe("TAM3113330");
  });

  test("an empty cell flags the row for staff", () => {
    expect(resolveContact(null).needsPhone).toBe(true);
    expect(resolveContact("").needsPhone).toBe(true);
    expect(resolveContact(null).shippingMark).toBeNull();
  });
});

describe("buildCustomerKey — phone, then mark, then name, then row", () => {
  test("phone wins over everything else", () => {
    expect(buildCustomerKey(
      { customerPhone: "233244100001", shippingMark: "ACC28672", customerName: "KOFI" }, 7
    )).toBe("p:233244100001");
  });

  test("mark is used when there is no phone", () => {
    expect(buildCustomerKey({ shippingMark: "ACC28672", customerName: "KOFI" }, 7)).toBe("m:ACC28672");
  });

  test("name is used only when neither identifier exists", () => {
    expect(buildCustomerKey({ customerName: "Kwame Asante" }, 7)).toBe("n:KWAMEASANTE");
  });

  test("a row with nothing at all still gets a key of its own", () => {
    expect(buildCustomerKey({}, 7)).toBe("r:ROW7");
  });
});

// ─── Parsing a shared tracking number ─────────────────────────────────────────

describe("one tracking number, several customers", () => {
  // Mirrors N151 CONTAINER LIST, where 15918654152 carries three customers.
  const sharedSheet = [
    ["STAGE", "LOADING"],
    ["CONTAINER NUMBER", "CAIU4815359"],
    ["BATCH REF", "N151"],
    [null, null],
    ["TRACKING N0.", "CNEE NAME", "CONTACT", "LOCATION", "QTY PER TRACKING", "CBM PER TRACKING"],
    ["15918654152", "SANDRA",         "0265437300", "ACCRA",  2, 0.20],
    ["15918654152", "CNEE420",        "0505970420", "ACCRA",  1, 0.10],
    ["15918654152", "KUDAMO MARIAMA", "0547911790", "TAMALE", 3, 0.30],
  ];

  test("each customer on the shared number becomes its own item", () => {
    const items = parseUnifiedSheet(buildXlsx(sharedSheet)).items;
    expect(items).toHaveLength(3);
    expect(new Set(items.map((i) => i.waybillNo)).size).toBe(1);
    expect(new Set(items.map((i) => i.customerKey)).size).toBe(3);
  });

  test("quantity and CBM are not merged between customers", () => {
    const items = parseUnifiedSheet(buildXlsx(sharedSheet)).items;
    expect(items.map((i) => i.quantity)).toEqual([2, 1, 3]);
    expect(items.map((i) => i.cbm)).toEqual([0.2, 0.1, 0.3]);
  });

  test("a mark-only customer is keyed by mark, not lost", () => {
    const withMark = sharedSheet.map((r, i) =>
      i === 6 ? ["15918654152", "", "ACC-28672", "", 1, 0.1] : r);
    const items  = parseUnifiedSheet(buildXlsx(withMark)).items;
    const marked = items.find((i) => i.shippingMark === "ACC28672");

    expect(marked).toBeDefined();
    expect(marked.customerKey).toBe("m:ACC28672");
    expect(marked.needsPhone).toBe(true);
    expect(new Set(items.map((i) => i.customerKey)).size).toBe(3);
  });
});

// ─── Intake ───────────────────────────────────────────────────────────────────

describe("processIntakeBatch keeps every customer on a shared number", () => {
  const sheet = [
    ["STAGE", "INTAKE"],
    ["BATCH DATE", "2026-04-02"],
    [null, null],
    ["INVOICE NO.", "TRACKING N0.", "CONTACT", "QUANTITY", "DATE"],
    ["INV-1", "15918654152", "0247335070", 1, "2026-04-02"],
    ["INV-2", "15918654152", "0552721323", 2, "2026-04-02"],
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    mockBatchFindOne.mockResolvedValue(null);
    mockBatchFind.mockReturnValue({ select: () => Promise.resolve([]) });
    mockBatchCreate.mockImplementation((doc) => Promise.resolve({ _id: "b1", ...doc }));
    mockBatchFindByIdUpdate.mockResolvedValue(null);
    mockBatchFindById.mockResolvedValue({ _id: "b1", batchCode: "INTAKE-2026-04-02" });
    mockItemFind.mockReturnValue([]);
    mockItemCreate.mockImplementation((doc) => Promise.resolve({ ...doc }));
    mockItemUpdateOne.mockResolvedValue({});
    mockUserFindOne.mockReturnValue({ select: () => Promise.resolve(null) });
  });

  test("both customers are created — the second is no longer discarded", async () => {
    const parsed = parseIntakeSheet(buildXlsx(sheet));
    const result = await processIntakeBatch(parsed, "user001", "intake.xlsx");

    expect(mockItemCreate).toHaveBeenCalledTimes(2);
    const created = mockItemCreate.mock.calls.map(([doc]) => doc);
    expect(created.map((d) => d.customerPhone).sort()).toEqual(["233247335070", "233552721323"]);
    expect(new Set(created.map((d) => d.customerKey)).size).toBe(2);
    expect(result.batch).toBeDefined();
  });

  test("re-uploading the same sheet creates nothing new", async () => {
    const parsed = parseIntakeSheet(buildXlsx(sheet));
    mockItemFind.mockReturnValue(parsed.items.map((i) => ({
      _id:           i.customerKey,
      waybillNo:     i.waybillNo,
      customerKey:   i.customerKey,
      customerPhone: i.customerPhone,
      needsPhone:    false,
    })));

    await processIntakeBatch(parsed, "user001", "intake.xlsx");
    expect(mockItemCreate).not.toHaveBeenCalled();
  });
});

// ─── Packing list ─────────────────────────────────────────────────────────────

describe("processShippedBatch updates the right customer on a shared number", () => {
  const header = [
    ["STAGE", "LOADING"],
    ["CONTAINER NUMBER", "CAIU4815359"],
    ["BATCH REF", "N151"],
    [null, null],
    ["TRACKING N0.", "CNEE NAME", "CONTACT", "LOCATION", "QTY PER TRACKING", "CBM PER TRACKING"],
  ];

  beforeEach(() => {
    jest.clearAllMocks();
    mockBatchFindOne.mockResolvedValue(null);
    mockBatchFind.mockReturnValue({ select: () => Promise.resolve([]) });
    mockBatchCreate.mockImplementation((doc) => Promise.resolve({ _id: "b2", ...doc }));
    mockBatchFindByIdUpdate.mockResolvedValue(null);
    mockBatchFindById.mockResolvedValue({ _id: "b2", batchCode: "PKL-N151" });
    mockItemCreate.mockImplementation((doc) => Promise.resolve({ ...doc }));
    mockItemUpdateMany.mockResolvedValue({ modifiedCount: 0 });
    mockUserFindOne.mockReturnValue({ select: () => Promise.resolve(null) });
    mockContainerUpdate.mockResolvedValue({});
  });

  test("the matching customer is updated and the other keeps its own details", async () => {
    const parsed = parseShippedSheet(buildXlsx([
      ...header,
      ["15918654152", "SANDRA",  "0265437300", "ACCRA",  2, 0.20],
      ["15918654152", "MARIAMA", "0547911790", "TAMALE", 3, 0.30],
    ]));

    const sandra = {
      waybillNo: "15918654152", customerKey: "p:233265437300",
      customerPhone: "233265437300", customerName: "SANDRA",
      destinationCity: "ACCRA", status: "in_warehouse", stageHistory: [],
      save: jest.fn().mockResolvedValue(true),
    };
    const mariama = {
      waybillNo: "15918654152", customerKey: "p:233547911790",
      customerPhone: "233547911790", customerName: "MARIAMA",
      destinationCity: "TAMALE", status: "in_warehouse", stageHistory: [],
      save: jest.fn().mockResolvedValue(true),
    };
    mockItemFind.mockReturnValue([sandra, mariama]);

    await processShippedBatch(parsed, "user001");

    // Each row updated its own record; neither inherited the other's details.
    expect(sandra.status).toBe("shipped");
    expect(mariama.status).toBe("shipped");
    expect(sandra.customerName).toBe("SANDRA");
    expect(mariama.customerName).toBe("MARIAMA");
    expect(sandra.destinationCity).toBe("ACCRA");
    expect(mariama.destinationCity).toBe("TAMALE");
    expect(mockItemCreate).not.toHaveBeenCalled();
  });

  test("an intake record keyed by mark is matched, not duplicated, once a phone arrives", async () => {
    const parsed = parseShippedSheet(buildXlsx([
      ...header,
      ["77712345", "AURELIA", "0244100009", "ACCRA", 1, 0.1],
    ]));

    // Intake recorded this parcel under a shipping mark only.
    const pending = {
      waybillNo: "77712345", customerKey: "m:AURELIA", shippingMark: "AURELIA",
      customerPhone: null, needsPhone: true, status: "in_warehouse",
      stageHistory: [], save: jest.fn().mockResolvedValue(true),
    };
    mockItemFind.mockReturnValue([pending]);

    await processShippedBatch(parsed, "user001");

    expect(mockItemCreate).not.toHaveBeenCalled();
    expect(pending.status).toBe("shipped");
    // The phone is promoted so later uploads match it exactly.
    expect(pending.customerPhone).toBe("233244100009");
    expect(pending.customerKey).toBe("p:233244100009");
    expect(pending.needsPhone).toBe(false);
  });

  test("a new customer on a shared waybill is NOT adopted by the pending-record rule", async () => {
    const parsed = parseShippedSheet(buildXlsx([
      ...header,
      ["77712345", "NEW PERSON", "0244100009", "ACCRA", 1, 0.1],
    ]));

    // Two records already on this waybill → ambiguous, so adoption must not fire,
    // otherwise we would recreate the very bug this matching prevents.
    mockItemFind.mockReturnValue([
      { waybillNo: "77712345", customerKey: "m:AURELIA", shippingMark: "AURELIA",
        customerPhone: null, needsPhone: true, status: "in_warehouse",
        stageHistory: [], save: jest.fn() },
      { waybillNo: "77712345", customerKey: "p:233111111111",
        customerPhone: "233111111111", needsPhone: false, status: "in_warehouse",
        stageHistory: [], save: jest.fn() },
    ]);

    await processShippedBatch(parsed, "user001");

    expect(mockItemCreate).toHaveBeenCalledTimes(1);
    expect(mockItemCreate.mock.calls[0][0].customerKey).toBe("p:233244100009");
  });
});

// ─── Masking ──────────────────────────────────────────────────────────────────

describe("masking withholds other customers' details", () => {
  test("names, phones and marks are partly hidden but still recognisable", () => {
    expect(maskName("KUDAMO MARIAMA")).toBe("K••••• M••••••");
    expect(maskPhone("233244123456")).toBe("0244•••456");
    expect(maskMark("ACC28672")).toBe("ACC•••72");
  });

  test("nothing is emitted for absent values", () => {
    expect(maskName(null)).toBeNull();
    expect(maskPhone(null)).toBeNull();
    expect(maskMark(null)).toBeNull();
  });

  test("a masked phone does not leak its middle digits", () => {
    expect(maskPhone("233244123456")).not.toContain("412");
  });
});

// ─── Narrowing a shared number to one customer ────────────────────────────────

describe("narrowToCustomer — every public lookup narrows the same way", () => {
  // One consolidated tracking number, two unrelated customers — the case that
  // showed one of them the other's name, goods and CBM.
  const sammy = {
    waybillNo: "13250739760", customerName: "SAMMY",
    customerPhone: "233548590187", shippingMark: null,
    productDescription: "显示屏无牌", cbm: 3.69,
  };
  const other = {
    waybillNo: "13250739760", customerName: "KOFI",
    customerPhone: "233557604169", shippingMark: null,
    productDescription: "CARTONS", cbm: 1.2,
  };
  const marked = {
    waybillNo: "13250739760", customerName: "ANGIE",
    customerPhone: null, shippingMark: "ACC28672",
    productDescription: "BAGS", cbm: 0.4,
  };
  const all = [sammy, other, marked];

  test("no identifier is not the same as no match", () => {
    // null tells the caller to ask who they are; [] would wrongly read as
    // "nothing found" and show a not-found page for a real tracking number.
    expect(narrowToCustomer(all, {})).toBeNull();
    expect(narrowToCustomer(all, { phone: "", mark: "" })).toBeNull();
    expect(narrowToCustomer(all)).toBeNull();
  });

  test("a phone returns that customer and nobody else", () => {
    expect(narrowToCustomer(all, { phone: "0548590187" })).toEqual([sammy]);
  });

  test("the same number in any written form narrows identically", () => {
    for (const form of ["0548590187", "548590187", "233548590187", "+233 548 590 187"]) {
      expect(narrowToCustomer(all, { phone: form })).toEqual([sammy]);
    }
  });

  test("a shipping mark narrows past case and separators", () => {
    expect(narrowToCustomer(all, { mark: "acc-286 72" })).toEqual([marked]);
  });

  test("an identifier matching nobody on the number returns empty, not everybody", () => {
    expect(narrowToCustomer(all, { phone: "0200000000" })).toEqual([]);
    expect(narrowToCustomer(all, { mark: "NOBODY" })).toEqual([]);
  });

  test("a customer with several parcels on the number gets all of them", () => {
    const second = { ...sammy, productDescription: "FRIDGE", cbm: 1.1 };
    expect(narrowToCustomer([sammy, other, second], { phone: "0548590187" }))
      .toEqual([sammy, second]);
  });

  test("one customer's details never come back under another's identifier", () => {
    const mine = narrowToCustomer(all, { phone: "0557604169" });
    expect(mine).toEqual([other]);
    expect(mine.map((i) => i.customerName)).not.toContain("SAMMY");
    expect(mine.map((i) => i.cbm)).not.toContain(3.69);
  });

  test("a record with no contact at all is never matched by accident", () => {
    const orphan = { waybillNo: "13250739760", customerPhone: null, shippingMark: null };
    expect(narrowToCustomer([orphan], { phone: "0548590187" })).toEqual([]);
    expect(narrowToCustomer([orphan], { mark: "ACC28672" })).toEqual([]);
  });
});

describe("normaliseMark", () => {
  test("strips separators and upper-cases", () => {
    expect(normaliseMark(" acc-286 72 ")).toBe("ACC28672");
  });

  test("returns null when nothing usable remains", () => {
    expect(normaliseMark("")).toBeNull();
    expect(normaliseMark("---")).toBeNull();
    expect(normaliseMark(null)).toBeNull();
  });
});

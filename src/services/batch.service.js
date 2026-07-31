const XLSX             = require("xlsx");
const Batch            = require("../models/Batch");
const ShipmentItem     = require("../models/ShipmentItem");
const ContainerLoading = require("../models/ContainerLoading");
const User             = require("../models/User");

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalisePhone(raw) {
  if (raw === null || raw === undefined) return null;
  const digits = String(raw).replace(/\D/g, "").trim();
  if (!digits || digits.length < 7) return null;
  if (digits.startsWith("233")) return digits;
  if (digits.startsWith("0"))   return "233" + digits.slice(1);
  if (digits.length === 9)      return "233" + digits;
  return digits;
}

function parseQuantity(raw) {
  if (raw === null || raw === undefined) return null;
  const str   = String(raw).trim();
  const match = str.match(/^(\d+(\.\d+)?)/);
  return match ? parseFloat(match[1]) : null;
}

function splitWaybills(raw) {
  if (!raw) return [];
  return String(raw)
    .trim()
    .split(/\s+/)
    .map((w) => w.trim().toUpperCase())
    .filter(Boolean);
}

async function findUserByPhone(normalised) {
  if (!normalised) return null;
  const last9 = normalised.slice(-9);
  const user  = await User.findOne({ phone: { $regex: last9 + "$" } }).select("_id");
  return user ? user._id : null;
}

function safeDate(raw) {
  if (raw === null || raw === undefined) return null;
  const d = raw instanceof Date ? raw : new Date(raw);
  return isNaN(d.getTime()) ? null : d;
}

function intakeBatchCode(date, filename) {
  const d   = date instanceof Date ? date : new Date(date);
  const iso = isNaN(d) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
  const name = filename
    ? filename.replace(/\.[^.]+$/, "").replace(/[^a-zA-Z0-9]/g, "_").replace(/_+/g, "_").toLowerCase()
    : "";
  return name ? `INTAKE-${iso}-${name}` : `INTAKE-${iso}`;
}

// ─── Column / metadata alias maps ─────────────────────────────────────────────
//
// Each entry maps a canonical key to all known column header spellings from
// real staff-produced spreadsheets. normalizeHeaderCell is applied to both
// the alias list and every header cell before lookup so spacing/case never
// matters.

const COLUMN_ALIASES = {
  TRACKING_NO:    ["TRACKING N0.", "TRACKING NO.", "TRACKING NUMBER", "WAYBILL", "WAYBILL NO", "JOB NUMBER", "JOB NO."],
  CBM:            ["CBM", "CBM PER TRACKING", "C.B.M", "CBM (M3)", "C.B.M PER TRACKING", "CBM PER TRACKING NO", "CBM PER TRACKING NO.", "CBM PER TRACKING NUMBER", "VOLUME (CBM)", "VOLUME CBM", "CBM VOLUME", "TOTAL CBM", "CBM TOTAL"],
  CONTACT:        ["CONTACT", "PHONE", "PHONE NUMBER", "CUSTOMER NO", "CUSTOMER NUMBER"],
  QTY:            ["QTY PER TRACKING", "QUANTITY", "QTY"],
  GOODS_TYPE:     ["GOODS TYPE", "GOODS"],
  PRODUCT_DESC:   ["PRODUCT DESCRIPTION", "DESCRIPTION"],
  CUSTOMER_NAME:  ["CUSTOMER NAME", "CNEE NAME", "CNEE"],
  LOCATION:       ["LOCATION", "DESTINATION", "DESTINATION CITY"],
  REMARKS:        ["OTHER", "REMARKS", "NOTE"],
  COLLECT_OF:     ["COLLECT O/F AMOUNT", "FREIGHT AMOUNT"],
  PAYMENT_TERM:   ["PAYMENT TERM $", "PAYMENT TERM"],
  LOAN:           ["LOAN"],
  INTEREST:       ["INTEREST"],
  OTHER_FEE:      ["OTHER FEE"],
  INVOICE_AMOUNT: ["INVOICE AMOUNT"],
  INVOICE_NO:     ["INVOICE NO", "INVOICE N0", "INVOICE NUMBER", "INVOICE NO.", "INVOICE N0.", "INVOICE"],
  INTAKE_DATE:    ["DATE", "INTAKE DATE"],
  // Date the parcel was RECEIVED at the origin warehouse — shown as "Date Received".
  RECEIVED_DATE:  ["RECEIVING DATE", "RECEIVE DATE", "RECEIPT DATE", "DATE RECEIVED", "RECEIVED DATE"],
  // Per-item expected delivery / ETA — kept separate from the received date so
  // the two never get conflated (they are different dates).
  EXPECTED_DELIVERY: ["EXPECTED DELIVERY", "EXPECTED DELIVERY DATE", "DELIVERY DATE", "ARRIVAL DATE PER ITEM", "ETA PER ITEM"],
};

const METADATA_ALIASES = {
  STAGE:            ["STAGE"],
  CONTAINER_NUMBER: ["CONTAINER NUMBER", "CTR NUMBER", "CONTAINER NO", "CONTAINER NO."],
  BL_NUMBER:        ["BL NUMBER", "B/L NUMBER", "BL NO", "BL NO.", "BL"],
  SEAL_NUMBER:      ["SEAL NUMBER", "SEAL NO", "SEAL NO."],
  VOLUME:           ["VOLUME"],
  LOADING_DATE:     ["LOADING DATE", "RECEIVING DATE", "RECEIVE DATE", "LOADING/RECEIVING DATE"],
  ETD:              ["ETD"],
  ETA:              ["ETA"],
  BATCH_REF:        ["BATCH REF", "PACKING LIST NUMBER", "PKL NUMBER"],
  ARRIVAL_DATE:     ["ARRIVAL DATE", "ARRIVED DATE"],
  PORT:             ["PORT", "PORT OF DISCHARGE"],
  BATCH_DATE:       ["BATCH DATE"],
  WAREHOUSE:        ["WAREHOUSE"],
};

function normalizeHeaderCell(raw) {
  if (!raw) return "";
  return String(raw).trim().replace(/\s+/g, " ").toUpperCase();
}

// Module-level compiled lookups built once at startup.
const COL_ALIAS_LOOKUP = (() => {
  const m = new Map();
  for (const [canonical, aliases] of Object.entries(COLUMN_ALIASES)) {
    for (const alias of aliases) m.set(normalizeHeaderCell(alias), canonical);
  }
  return m;
})();

const META_ALIAS_LOOKUP = (() => {
  const m = new Map();
  for (const [canonical, aliases] of Object.entries(METADATA_ALIASES)) {
    for (const alias of aliases) m.set(normalizeHeaderCell(alias), canonical);
  }
  return m;
})();

const TRACKING_ALIASES_SET = new Set(
  COLUMN_ALIASES.TRACKING_NO.map(normalizeHeaderCell)
);

// ─── Container / packing-list layout (no header row) ──────────────────────────
//
// Some warehouse "container lists" arrive with no column headers at all — just a
// title row like "9th/Jun 2026--N151-CAIU4815359" followed by positional data:
//
//   col 0: shipping mark (optional)     col 5: quantity ("2pallet+17")
//   col 1: tracking number              col 6: CBM
//   col 2: customer phone / number      col 7: goods / description
//   col 3: customer name                col 10: date
//   col 4: LOCATION (blank = Accra)     col 11 & 13: remarks / fees
//                                       col 12: batch ref (e.g. "N151")
//
// This is distinct from the legacy 5-column intake sheet, so it needs its own
// detector and parser. Detection uses two independent signals: a title row that
// embeds "-<batchRef>-<CONTAINERNO>", and/or a column where a letter-prefixed
// short code (the batch ref) repeats across most rows.

const CONTAINER_LIST_COLS = {
  MARK: 0, TRACKING: 1, PHONE: 2, NAME: 3, LOCATION: 4,
  QTY: 5, CBM: 6, GOODS: 7, DATE: 10, REMARK_A: 11, BATCH: 12, REMARK_B: 13,
};

// "-N151-CAIU4815359" → batchRef "N151", containerNumber "CAIU4815359"
const CONTAINER_TITLE_RE = /-\s*([A-Za-z]{1,3}\d+[A-Za-z]?)\s*-\s*([A-Z]{3,4}\d{6,7})\b/;
// Batch-ref shape: a letter prefix + digits (e.g. N151). Requiring a letter
// keeps the date column (bare 5-digit serials like 46181) from matching.
const BATCH_CODE_RE = /^[A-Z]{1,3}\d{2,6}[A-Z]?$/;

function detectContainerList(rows) {
  let batchRef = null;
  let containerNumber = null;

  // Signal A — title row in the first few rows.
  for (let i = 0; i < Math.min(4, rows.length); i++) {
    const cell = rows[i] && rows[i][0];
    if (typeof cell === "string") {
      const m = cell.match(CONTAINER_TITLE_RE);
      if (m) { batchRef = m[1].toUpperCase(); containerNumber = m[2].toUpperCase(); break; }
    }
  }

  // Signal B — a column where the same letter-prefixed short code repeats.
  const dataRows = rows.filter((r) => r && r.some((c) => c !== null && c !== undefined && c !== ""));
  if (dataRows.length < 3) return batchRef ? { batchRef, containerNumber } : null;

  const nCols = Math.max(...dataRows.map((r) => r.length));
  const threshold = Math.max(3, Math.floor(dataRows.length * 0.4));
  let repeatedVal = null;
  for (let col = 0; col < nCols && !repeatedVal; col++) {
    const counts = {};
    for (const r of dataRows) {
      const v = r[col];
      if (v === null || v === undefined || v === "") continue;
      const s = String(v).trim().toUpperCase();
      if (!BATCH_CODE_RE.test(s)) continue;
      counts[s] = (counts[s] || 0) + 1;
      if (counts[s] >= threshold) { repeatedVal = s; break; }
    }
  }

  if (!batchRef && !repeatedVal) return null;
  return { batchRef: batchRef || repeatedVal, containerNumber };
}

function parseContainerListRows(rows, det) {
  const C = CONTAINER_LIST_COLS;
  const items = [];
  const skippedRows = [];
  const lastNameByPhone = {};
  const containerRef = det.containerNumber || det.batchRef || null;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;

    const trackingRaw = row[C.TRACKING];
    const phoneRaw    = row[C.PHONE];
    // Title row, totals row, and blank rows have neither a tracking nor a phone.
    if (!trackingRaw && !phoneRaw) { skippedRows.push(i + 1); continue; }

    const waybills = splitWaybills(trackingRaw);
    if (!waybills.length) { skippedRows.push(i + 1); continue; }

    let cneeStr = row[C.NAME] ? String(row[C.NAME]).trim() : "";
    if (/^\d+(\.\d+)?$/.test(cneeStr)) cneeStr = ""; // numeric "name" = summary artifact

    const phone = normalisePhone(phoneRaw);
    if (!cneeStr && phone && lastNameByPhone[phone]) cneeStr = lastNameByPhone[phone];
    else if (cneeStr && phone) lastNameByPhone[phone] = cneeStr;

    const location = row[C.LOCATION] ? String(row[C.LOCATION]).trim().toUpperCase() : null;
    const qtyRaw   = row[C.QTY];
    const cbmRaw   = row[C.CBM];
    const cbm      = (cbmRaw !== null && cbmRaw !== undefined) ? parseFloat(cbmRaw) : null;
    // received at warehouse — only trust a real Date cell (cellDates conversion),
    // never a bare Excel serial number which safeDate would misread as 1970.
    const receivedAt = row[C.DATE] instanceof Date ? row[C.DATE] : null;
    const goods    = row[C.GOODS] ? String(row[C.GOODS]).trim() : null;
    const remarks  = [row[C.REMARK_A], row[C.REMARK_B]]
      .filter((v) => v !== null && v !== undefined && String(v).trim())
      .map((v) => String(v).trim())
      .join(" | ") || null;

    // When one cell holds several tracking numbers, the row's quantity and CBM
    // are the COMBINED total for that group — split them across the trackings so
    // the customer is not billed the full amount once per tracking (over-billing).
    const share       = waybills.length;
    const qtyTotal    = parseQuantity(qtyRaw);
    const cbmValid    = (cbm !== null && !isNaN(cbm)) ? cbm : null;
    const qtyPer      = qtyTotal != null ? qtyTotal / share : null;
    const cbmPer      = cbmValid != null ? cbmValid / share : null;

    for (const waybill of waybills) {
      items.push({
        waybillNo:          waybill,
        customerPhoneRaw:   phoneRaw ? String(phoneRaw).trim() : null,
        customerPhone:      phone,
        customerName:       cneeStr || null,
        destinationCity:    location,
        goodsType:          goods,
        quantity:           qtyPer,
        quantityRaw:        (qtyRaw !== null && qtyRaw !== undefined) ? String(qtyRaw).trim() : null,
        cbm:                cbmPer,
        productDescription: goods,
        containerRef,
        remarks,
        intakeDate:         receivedAt,
      });
    }
  }

  return { items, skippedRows };
}

// ─── Unified sheet parser ─────────────────────────────────────────────────────
//
// Single entry point for all three spreadsheet variants.
// Returns { stage, metadata, items, skippedRows, headerWarnings, missingColumns }.

function parseUnifiedSheet(buffer) {
  const wb   = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  if (!rows.length) {
    return { stage: null, metadata: {}, items: [], skippedRows: [], headerWarnings: [], missingColumns: ["TRACKING_NO"] };
  }

  // ── 1. Metadata block: rows 0-9, label in col A, value in col B ──────────
  const rawMeta = {};
  for (let i = 0; i < Math.min(10, rows.length); i++) {
    const row = rows[i];
    if (!row || row[0] === null || row[0] === undefined) continue;
    const label    = normalizeHeaderCell(String(row[0]));
    const canonical = META_ALIAS_LOOKUP.get(label);
    if (canonical && rawMeta[canonical] === undefined) {
      rawMeta[canonical] = (row[1] !== null && row[1] !== undefined) ? row[1] : null;
    }
  }

  // ── 2. Stage from STAGE metadata field ───────────────────────────────────
  let stage = null;
  if (rawMeta.STAGE !== null && rawMeta.STAGE !== undefined) {
    const s = String(rawMeta.STAGE).trim().toUpperCase();
    if      (s === "INTAKE")  stage = "intake";
    else if (s === "LOADING") stage = "shipped";
    else if (s === "SHIPPED") stage = "shipped";
    else if (s === "ARRIVED") stage = "arrived";
  }

  // ── 3. Header row: first row with a TRACKING_NO alias in any cell ────────
  let headerRowIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;
    for (const cell of row) {
      if (cell !== null && cell !== undefined &&
          TRACKING_ALIASES_SET.has(normalizeHeaderCell(String(cell)))) {
        headerRowIdx = i;
        break;
      }
    }
    if (headerRowIdx !== -1) break;
  }

  // ── 4. Column index from header row ──────────────────────────────────────
  const colIndex       = {};
  const headerWarnings = [];

  if (headerRowIdx !== -1) {
    const headerRow = rows[headerRowIdx] || [];
    headerRow.forEach((cell, i) => {
      if (cell === null || cell === undefined) return;
      const normalized = normalizeHeaderCell(String(cell));
      if (!normalized) return;
      const canonical = COL_ALIAS_LOOKUP.get(normalized);
      if (canonical) {
        if (colIndex[canonical] === undefined) colIndex[canonical] = i;
      } else {
        headerWarnings.push(`Unrecognized column: "${String(cell).trim()}"`);
      }
    });
  }

  // ── 4b. Header-less container / packing list detection ────────────────────
  // A header-less sheet is either a legacy 5-column intake or a positional
  // container list (packing list). Detect the latter so it parses correctly.
  const containerList = headerRowIdx === -1 ? detectContainerList(rows) : null;

  // ── 5. Stage fallback when STAGE field is absent (legacy files) ───────────
  if (!stage) {
    if (containerList) {
      // Header-less container list = a packing / loading list.
      stage = "shipped";
    } else if (headerRowIdx === -1) {
      // No header row → legacy positional intake
      stage = "intake";
    } else if (colIndex.CBM !== undefined || colIndex.COLLECT_OF !== undefined || colIndex.PAYMENT_TERM !== undefined) {
      stage = "shipped";
    } else if (rawMeta.ARRIVAL_DATE) {
      stage = "arrived";
    } else if (rawMeta.BATCH_DATE || rawMeta.WAREHOUSE) {
      stage = "intake";
    } else {
      stage = "shipped";
    }
  }

  // ── 6. Missing required columns ───────────────────────────────────────────
  // Flag TRACKING_NO missing when: (a) a header row was found but has no
  // tracking column, or (b) no header row was found at all for a non-intake stage
  // (which means the file can't be processed correctly).
  const missingColumns = [];
  if (headerRowIdx !== -1 && colIndex.TRACKING_NO === undefined) {
    missingColumns.push("TRACKING_NO");
  } else if (headerRowIdx === -1 && !containerList && stage !== "intake") {
    missingColumns.push("TRACKING_NO");
  }

  // ── 7. Structured metadata object ─────────────────────────────────────────
  const metadata = {};
  const setMeta  = (key, fn) => { if (rawMeta[key] != null) metadata[key] = fn(rawMeta[key]); };
  setMeta("CONTAINER_NUMBER", v => String(v).trim().toUpperCase());
  setMeta("BL_NUMBER",        v => String(v).trim());
  setMeta("SEAL_NUMBER",      v => String(v).trim());
  setMeta("VOLUME",           v => String(v).trim());
  setMeta("LOADING_DATE",     v => safeDate(v));
  setMeta("ETD",              v => String(v).trim());
  setMeta("ETA",              v => String(v).trim());
  setMeta("BATCH_REF",        v => String(v).trim());
  setMeta("ARRIVAL_DATE",     v => safeDate(v));
  setMeta("PORT",             v => String(v).trim());
  setMeta("BATCH_DATE",       v => safeDate(v));
  setMeta("WAREHOUSE",        v => String(v).trim());

  // Container list carries its container/batch identity in the title row.
  if (containerList) {
    if (containerList.containerNumber && !metadata.CONTAINER_NUMBER) {
      metadata.CONTAINER_NUMBER = containerList.containerNumber;
    }
    if (containerList.batchRef && !metadata.BATCH_REF) {
      metadata.BATCH_REF = containerList.batchRef;
    }
  }

  // ── 8. Parse data rows ────────────────────────────────────────────────────
  const items       = [];
  const skippedRows = [];
  const containerRef = metadata.CONTAINER_NUMBER || metadata.BATCH_REF || null;

  if (containerList) {
    const parsed = parseContainerListRows(rows, {
      containerNumber: metadata.CONTAINER_NUMBER || null,
      batchRef:        metadata.BATCH_REF || null,
    });
    items.push(...parsed.items);
    skippedRows.push(...parsed.skippedRows);
  } else if (headerRowIdx === -1) {
    // Legacy positional intake: col 0=invoiceNo, 1=waybill, 2=phone, 3=qty, 4=date
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      if (!row) continue;
      const [invoiceRaw, waybillRaw, phoneRaw, qtyRaw, dateRaw] = row;
      if (!waybillRaw && !phoneRaw) { skippedRows.push(i + 1); continue; }
      const waybills = splitWaybills(waybillRaw);
      if (!waybills.length) { skippedRows.push(i + 1); continue; }
      const phone = normalisePhone(phoneRaw);
      const qty   = parseQuantity(qtyRaw);
      const date  = safeDate(dateRaw);
      if (date && !metadata.BATCH_DATE) metadata.BATCH_DATE = date;
      for (const waybill of waybills) {
        items.push({
          waybillNo:        waybill,
          invoiceNo:        invoiceRaw ? String(invoiceRaw).trim() : null,
          customerPhoneRaw: phoneRaw ? String(phoneRaw).trim() : null,
          customerPhone:    phone,
          quantity:         qty,
          quantityRaw:      qtyRaw !== null ? String(qtyRaw).trim() : null,
          intakeDate:       date,
        });
      }
    }
  } else {
    const get = (row, key) => {
      const idx = colIndex[key];
      return idx !== undefined ? row[idx] : null;
    };

    const lastNameByPhone = {}; // carry forward name across rows sharing the same phone

    for (let i = headerRowIdx + 1; i < rows.length; i++) {
      const row = rows[i];
      if (!row) continue;

      const trackingRaw = get(row, "TRACKING_NO");
      const phoneRaw    = get(row, "CONTACT");

      if (!trackingRaw && !phoneRaw) { skippedRows.push(i + 1); continue; }

      const waybills = splitWaybills(trackingRaw);
      if (!waybills.length) { skippedRows.push(i + 1); continue; }

      const cneeRaw  = get(row, "CUSTOMER_NAME");
      let   cneeStr  = cneeRaw ? String(cneeRaw).trim() : "";
      // Skip totals / summary rows where the name column is purely numeric
      if (/^\d+(\.\d+)?$/.test(cneeStr)) { skippedRows.push(i + 1); continue; }

      // When the name cell is blank but a prior row for the same phone had a name,
      // carry that name forward (matches how staff fill in Excel sheets).
      const phone = normalisePhone(phoneRaw);
      if (!cneeStr && phone && lastNameByPhone[phone]) {
        cneeStr = lastNameByPhone[phone];
      } else if (cneeStr && phone) {
        lastNameByPhone[phone] = cneeStr;
      }

      const location   = get(row, "LOCATION")   ? String(get(row, "LOCATION")).trim().toUpperCase() : null;
      const descRaw    = get(row, "PRODUCT_DESC");
      const goodsRaw   = get(row, "GOODS_TYPE");
      const description = descRaw  ? String(descRaw).trim()  : null;
      const goodsType   = goodsRaw ? String(goodsRaw).trim() : null;
      const remarksRaw  = get(row, "REMARKS");
      const remarks     = remarksRaw ? String(remarksRaw).trim() : null;
      const qtyRaw      = get(row, "QTY");
      const qty         = parseQuantity(qtyRaw);
      const cbmRaw      = get(row, "CBM");
      const cbm         = (cbmRaw !== null && cbmRaw !== undefined) ? parseFloat(cbmRaw) : null;
      // Received-at-warehouse date (col "RECEIVING DATE") vs per-item ETA
      // ("EXPECTED DELIVERY") — kept as two distinct dates.
      const receivedRaw    = get(row, "RECEIVED_DATE");
      const receivedParsed = receivedRaw ? safeDate(receivedRaw) : null;
      const expectedRaw    = get(row, "EXPECTED_DELIVERY");
      const expectedParsed = expectedRaw ? safeDate(expectedRaw) : null;
      const invoiceRaw  = get(row, "INVOICE_NO");

      // Financial fields from packing-list columns
      const collectOF     = get(row, "COLLECT_OF");
      const paymentTerm   = parseQuantity(get(row, "PAYMENT_TERM"));
      const loan          = parseQuantity(get(row, "LOAN"));
      const interest      = parseQuantity(get(row, "INTEREST"));
      const otherFee      = parseQuantity(get(row, "OTHER_FEE"));
      const invoiceAmount = parseQuantity(get(row, "INVOICE_AMOUNT"));

      // A single cell can hold several tracking numbers whose quantity, CBM and
      // financial amounts are the COMBINED total for the group. Split those
      // additive values across the trackings so each is not billed the full
      // amount (over-billing). share === 1 for normal rows → no change.
      const share   = waybills.length;
      const per     = (v) => (v != null ? v / share : v);
      const cbmVal  = (cbm !== null && !isNaN(cbm)) ? cbm : null;

      for (const waybill of waybills) {
        const item = {
          waybillNo:          waybill,
          customerPhoneRaw:   phoneRaw ? String(phoneRaw).trim() : null,
          customerPhone:      phone,
          customerName:       cneeStr || null,
          destinationCity:    location,
          goodsType,
          quantity:           per(qty),
          quantityRaw:        qtyRaw !== null ? String(qtyRaw).trim() : null,
          cbm:                per(cbmVal),
          productDescription: description || goodsType,
          containerRef,
          remarks,
          freightTerm:    collectOF ? String(collectOF).trim() : null,
          freightAmount:  per(paymentTerm),
          loan:           per(loan),
          interest:       per(interest),
          otherFee:       per(otherFee),
          invoiceAmount:  per(invoiceAmount),
          receivingDate:      metadata.LOADING_DATE || null,
          // Received-at-warehouse date drives "Date Received" for customers.
          intakeDate:         receivedParsed || null,
          // ETA — only a per-item column value here; the container ETA is applied
          // as a fallback in processShippedBatch.
          estimatedDelivery:  expectedParsed || null,
        };
        if (stage === "intake") {
          item.invoiceNo  = invoiceRaw ? String(invoiceRaw).trim() : null;
          const dateCell  = get(row, "INTAKE_DATE");
          item.intakeDate = safeDate(dateCell) || receivedParsed || metadata.BATCH_DATE || null;
        }
        items.push(item);
      }
    }
  }

  return { stage, metadata, items, skippedRows, headerWarnings, missingColumns };
}

// ─── Thin wrapper parsers (keep exported names, assert stage) ─────────────────

function parseIntakeSheet(buffer) {
  const result = parseUnifiedSheet(buffer);
  if (result.stage && result.stage !== "intake") {
    throw new Error(
      `Spreadsheet STAGE is "${result.stage.toUpperCase()}" but was uploaded to the intake endpoint.`
    );
  }
  return result;
}

function parseShippedSheet(buffer) {
  const result = parseUnifiedSheet(buffer);
  if (result.stage && result.stage !== "shipped") {
    throw new Error(
      `Spreadsheet STAGE is "${result.stage.toUpperCase()}" but was uploaded to the shipped/loading endpoint.`
    );
  }
  return result;
}

function parseArrivedSheet(buffer) {
  const result = parseUnifiedSheet(buffer);
  if (result.stage && result.stage !== "arrived") {
    throw new Error(
      `Spreadsheet STAGE is "${result.stage.toUpperCase()}" but was uploaded to the arrived endpoint.`
    );
  }
  return result;
}

// ─── Processor: Arrived batch ─────────────────────────────────────────────────

async function processArrivedBatch(parsedData, uploadedBy) {
  const { metadata, items, skippedRows } = parsedData;
  const { containerNumber, arrivalDate, blNumber } = metadata;

  const batchCode = containerNumber
    ? `ARR-${containerNumber}`
    : arrivalDate
    ? `ARR-${arrivalDate.toISOString().slice(0, 10)}`
    : `ARR-${new Date().toISOString().slice(0, 10)}`;

  const existing = await Batch.findOne({ batchCode, stage: "arrived" });
  if (existing) throw new DuplicateBatchError(batchCode, existing);

  const batch = await Batch.create({
    batchCode,
    stage:      "arrived",
    uploadedBy,
    skippedRows,
    containerRefs: containerNumber
      ? [{ code: batchCode, id: containerNumber, date: arrivalDate }]
      : [],
    notes: [
      blNumber    ? `BL: ${blNumber}`                                    : null,
      arrivalDate ? `Arrived: ${arrivalDate.toISOString().slice(0, 10)}` : null,
    ].filter(Boolean).join(" | ") || undefined,
  });

  let matchedItems = 0;
  let newItems     = 0;

  // Match solely by TRACKING_NO from items[] — no container-based fallback
  // (fallback was removed because it fires when sheets are misaligned and
  // marks unrelated items as arrived).
  for (const item of items) {
    const found = await ShipmentItem.findOne({ waybillNo: item.waybillNo });
    if (!found) { newItems++; continue; }

    found.status       = "customs";
    found.arrivedBatch = batch._id;
    if (arrivalDate) found.arrivalDate = arrivalDate;
    found.stageHistory.push({
      stage:     "arrived",
      status:    "customs",
      batchId:   batch._id,
      updatedAt: new Date(),
      note:      `Arrived at Ghana port via ${batchCode}`,
    });
    await found.save();
    matchedItems++;
  }

  if (containerNumber) {
    await ContainerLoading.findOneAndUpdate(
      { containerNumber: containerNumber.toUpperCase() },
      {
        $set: {
          status:            "arrived",
          actualArrivalDate: arrivalDate || new Date(),
          updatedBy:         uploadedBy,
        },
      }
    );
  }

  const totalItems = matchedItems;
  await Batch.findByIdAndUpdate(batch._id, { totalItems, newItems: 0, matchedItems, heldItems: 0 });

  return {
    batch:      await Batch.findById(batch._id),
    skippedRows,
    summary:    `${totalItems} items marked as arrived (customs). Container: ${containerNumber || "N/A"}.`,
  };
}

// ─── Custom error for duplicate batch uploads ─────────────────────────────────

class DuplicateBatchError extends Error {
  constructor(batchCode, existingBatch) {
    super(`Batch already uploaded`);
    this.name       = "DuplicateBatchError";
    this.batchCode  = batchCode;
    this.uploadedAt = existingBatch.createdAt;
    this.batchId    = existingBatch._id; // lets the UI offer "delete previous & retry"
  }
}

// ─── Processor: Intake batch ──────────────────────────────────────────────────

async function processIntakeBatch(parsedData, uploadedBy, filename) {
  const { metadata, items, skippedRows } = parsedData;
  const batchDate = metadata.BATCH_DATE || null;

  const batchCode = intakeBatchCode(batchDate, filename);
  const existing  = await Batch.findOne({ batchCode, stage: "intake" });
  if (existing) throw new DuplicateBatchError(batchCode, existing);

  const batch = await Batch.create({
    batchCode,
    stage:      "intake",
    uploadedBy,
    skippedRows,
  });

  let newItems     = 0;
  let matchedItems = 0;

  for (const item of items) {
    const exists = await ShipmentItem.findOne({ waybillNo: item.waybillNo });
    if (exists) {
      // Patch missing fields that may have been blank on the original upload
      // (e.g. invoiceNo when the column alias was not yet recognised).
      const patch = {};
      if (!exists.invoiceNo    && item.invoiceNo)    patch.invoiceNo    = item.invoiceNo;
      if (!exists.customerName && item.customerName) patch.customerName = item.customerName;
      if (Object.keys(patch).length) await ShipmentItem.updateOne({ _id: exists._id }, { $set: patch });
      matchedItems++;
      continue;
    }

    const customerId = await findUserByPhone(item.customerPhone);
    await ShipmentItem.create({
      ...item,
      customerId,
      status:       "in_warehouse",
      intakeBatch:  batch._id,
      stageHistory: [{
        stage:     "intake",
        status:    "in_warehouse",
        batchId:   batch._id,
        updatedAt: new Date(),
        note:      "Created via intake upload",
      }],
    });
    newItems++;
  }

  const totalItems = newItems + matchedItems;
  await Batch.findByIdAndUpdate(batch._id, { totalItems, newItems, matchedItems, heldItems: 0 });

  return {
    batch:      await Batch.findById(batch._id),
    skippedRows,
    summary:    `${totalItems} items processed. ${newItems} new, ${matchedItems} already existed, 0 held.`,
  };
}

// ─── Processor: Shipped batch (packing list / loading list) ───────────────────

async function processShippedBatch(parsedData, uploadedBy, options = {}) {
  const { autoHold = false } = options;
  const { metadata, items, skippedRows } = parsedData;
  const {
    CONTAINER_NUMBER: containerNumber,
    BL_NUMBER:        blNumber,
    SEAL_NUMBER:      sealNumber,
    VOLUME:           volume,
    LOADING_DATE:     loadingDate,
    ETD:              etd,
    ETA:              eta,
    BATCH_REF:        batchRef,
  } = metadata;

  const batchCode = batchRef
    ? `PKL-${batchRef}`
    : containerNumber
    ? `CTR-${containerNumber}`
    : `SHIPPED-${new Date().toISOString().slice(0, 10)}`;

  const existing = await Batch.findOne({ batchCode, stage: "shipped" });
  if (existing) throw new DuplicateBatchError(batchCode, existing);

  const batch = await Batch.create({
    batchCode,
    stage:      "shipped",
    uploadedBy,
    skippedRows,
    containerRefs: containerNumber
      ? [{ code: batchRef || batchCode, id: containerNumber, date: loadingDate }]
      : [],
    notes: [
      blNumber   ? `BL: ${blNumber}`     : null,
      sealNumber ? `Seal: ${sealNumber}` : null,
      volume     ? `Volume: ${volume}`   : null,
      etd        ? `ETD: ${etd}`         : null,
      eta        ? `ETA: ${eta}`         : null,
    ].filter(Boolean).join(" | ") || undefined,
  });

  const uploadedWaybills = new Set(items.map((i) => i.waybillNo));
  let newItems     = 0;
  let matchedItems = 0;

  // The packing list carries one ETA in its metadata block. Every item on the
  // list inherits it unless the row had its own expected-delivery date.
  const etaDate = safeDate(eta);

  for (const item of items) {
    const customerId = await findUserByPhone(item.customerPhone);
    const found      = await ShipmentItem.findOne({ waybillNo: item.waybillNo });

    if (found) {
      if (found.status === "shipped") { matchedItems++; continue; }

      found.status              = "shipped";
      found.shippedBatch        = batch._id;
      found.customerName        = item.customerName        || found.customerName;
      found.destinationCity     = item.destinationCity     || found.destinationCity;
      found.cbm                 = item.cbm                 ?? found.cbm;
      found.productDescription  = item.productDescription  || found.productDescription;
      found.goodsType           = item.goodsType           || found.goodsType;
      found.containerRef        = item.containerRef        || found.containerRef;
      found.quantity            = item.quantity            ?? found.quantity;
      found.quantityRaw         = item.quantityRaw         || found.quantityRaw;
      found.receivingDate       = item.receivingDate       || found.receivingDate;
      found.estimatedDelivery   = item.estimatedDelivery   || etaDate || found.estimatedDelivery;
      found.freightTerm         = item.freightTerm         || found.freightTerm;
      found.freightAmount       = item.freightAmount       ?? found.freightAmount;
      found.loan                = item.loan                ?? found.loan;
      found.interest            = item.interest            ?? found.interest;
      found.otherFee            = item.otherFee            ?? found.otherFee;
      found.invoiceAmount       = item.invoiceAmount       ?? found.invoiceAmount;
      found.remarks             = item.remarks             || found.remarks;
      if (customerId && !found.customerId) found.customerId = customerId;
      found.stageHistory.push({
        stage:     "shipped",
        status:    "shipped",
        batchId:   batch._id,
        updatedAt: new Date(),
        note:      `Updated via packing list ${batchCode}`,
      });
      await found.save();
      matchedItems++;
    } else {
      await ShipmentItem.create({
        ...item,
        estimatedDelivery: item.estimatedDelivery || etaDate,
        customerId,
        status:       "shipped",
        shippedBatch: batch._id,
        stageHistory: [{
          stage:     "shipped",
          status:    "shipped",
          batchId:   batch._id,
          updatedAt: new Date(),
          note:      `Created directly via packing list ${batchCode}`,
        }],
      });
      newItems++;
    }
  }

  // Auto-hold items still in_warehouse from recent intake batches not in this
  // list. This is OFF by default — a mismatched or partial packing list would
  // otherwise wrongly hold every other warehouse parcel. When enabled, an item
  // is only held if BOTH its waybill AND its customer phone are absent from the
  // list, so a customer present under a different waybill is never held.
  let heldItems = 0;
  if (autoHold) {
    const cutoff         = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const recentBatches  = await Batch.find({ stage: "intake", createdAt: { $gte: cutoff } }).select("_id");
    const recentBatchIds = recentBatches.map((b) => b._id);
    const uploadedPhones = new Set(items.map((i) => i.customerPhone).filter(Boolean));

    const heldResult = await ShipmentItem.updateMany(
      {
        status:      "in_warehouse",
        intakeBatch: { $in: recentBatchIds },
        waybillNo:   { $nin: Array.from(uploadedWaybills) },
        $or: [
          { customerPhone: null },
          { customerPhone: { $nin: Array.from(uploadedPhones) } },
        ],
      },
      {
        $set:  { status: "held", heldReason: `Not included in packing list ${batchCode}` },
        $push: {
          stageHistory: {
            stage:     "shipped",
            status:    "held",
            batchId:   batch._id,
            updatedAt: new Date(),
            note:      `Auto-held — not found in packing list ${batchCode}`,
          },
        },
      }
    );
    heldItems = heldResult.modifiedCount;
  }

  const totalItems = newItems + matchedItems;
  await Batch.findByIdAndUpdate(batch._id, { totalItems, newItems, matchedItems, heldItems });

  if (containerNumber) {
    const containerData = {
      blNumber:    blNumber    || undefined,
      sealNumber:  sealNumber  || undefined,
      volume:      volume      || undefined,
      loadingDate: loadingDate || undefined,
      etd:         safeDate(etd) || undefined,
      eta:         safeDate(eta) || undefined,
      batchRef:    batch._id,
      updatedBy:   uploadedBy,
    };
    Object.keys(containerData).forEach((k) => containerData[k] === undefined && delete containerData[k]);

    await ContainerLoading.findOneAndUpdate(
      { containerNumber: containerNumber.toUpperCase().trim() },
      {
        $set:         containerData,
        $setOnInsert: { status: "shipped", createdBy: uploadedBy },
      },
      { upsert: true, new: true }
    );
  }

  return {
    batch:      await Batch.findById(batch._id),
    skippedRows,
    summary:    `${totalItems} items processed. ${newItems} new, ${matchedItems} updated, ${heldItems} held.`,
  };
}

// ─── Retraction: undo a wrong upload ──────────────────────────────────────────
//
// Deletes a batch and reverses everything it did, so staff can immediately
// retract a wrong Excel file at any stage. Retraction is blocked when items
// from the batch have since moved to a later stage — the later batch must be
// retracted first (retract in reverse order: arrived → shipped → intake).

class BatchRetractionError extends Error {
  constructor(message) {
    super(message);
    this.name = "BatchRetractionError";
  }
}

async function retractIntakeBatch(batch, { force = false } = {}) {
  if (!force) {
    const progressed = await ShipmentItem.countDocuments({
      intakeBatch: batch._id,
      $or: [
        { shippedBatch: { $ne: null } },
        { arrivedBatch: { $ne: null } },
        { status: { $nin: ["in_warehouse", "held"] } },
      ],
    });
    if (progressed > 0) {
      throw new BatchRetractionError(
        `Cannot retract: ${progressed} item(s) from this intake batch have already been shipped or changed status. Retract the later batch first.`
      );
    }
  }

  const deleted = await ShipmentItem.deleteMany({ intakeBatch: batch._id });
  await Batch.findByIdAndDelete(batch._id);

  return {
    stage:        "intake",
    batchCode:    batch.batchCode,
    deletedItems: deleted.deletedCount,
    summary:      `Intake batch ${batch.batchCode} retracted — ${deleted.deletedCount} item(s) deleted.`,
  };
}

async function retractShippedBatch(batch, { force = false } = {}) {
  if (!force) {
    const progressed = await ShipmentItem.countDocuments({
      shippedBatch: batch._id,
      $or: [{ arrivedBatch: { $ne: null } }, { status: { $nin: ["shipped"] } }],
    });
    if (progressed > 0) {
      throw new BatchRetractionError(
        `Cannot retract: ${progressed} item(s) from this packing list have already arrived or changed status. Retract the arrived batch first.`
      );
    }
  }

  // Items created directly by this packing list (their first history entry is
  // this batch) never existed at intake — delete them outright.
  const deleted = await ShipmentItem.deleteMany({
    shippedBatch: batch._id,
    "stageHistory.0.batchId": batch._id,
  });

  // Items matched from intake — send them back to the warehouse and clear the
  // loading-specific fields this upload set (container, ETA, invoice figures).
  const reverted = await ShipmentItem.updateMany(
    { shippedBatch: batch._id },
    {
      $set: {
        status:            "in_warehouse",
        shippedBatch:      null,
        containerRef:      null,
        receivingDate:     null,
        estimatedDelivery: null,
        freightTerm:       null,
        freightAmount:     null,
        loan:              null,
        interest:          null,
        otherFee:          null,
        invoiceAmount:     null,
      },
      $pull: { stageHistory: { batchId: batch._id } },
    }
  );

  // Items auto-held only because they were missing from this (wrong) list
  const unheld = await ShipmentItem.updateMany(
    {
      status:       "held",
      stageHistory: { $elemMatch: { batchId: batch._id, status: "held" } },
    },
    {
      $set:  { status: "in_warehouse", heldReason: null },
      $pull: { stageHistory: { batchId: batch._id } },
    }
  );

  // Container record auto-created from this packing list
  const containers = await ContainerLoading.deleteMany({ batchRef: batch._id });

  await Batch.findByIdAndDelete(batch._id);

  return {
    stage:             "shipped",
    batchCode:         batch.batchCode,
    deletedItems:      deleted.deletedCount,
    revertedItems:     reverted.modifiedCount,
    unheldItems:       unheld.modifiedCount,
    deletedContainers: containers.deletedCount,
    summary:
      `Packing list ${batch.batchCode} retracted — ${reverted.modifiedCount} item(s) returned to warehouse, ` +
      `${deleted.deletedCount} deleted, ${unheld.modifiedCount} un-held, ${containers.deletedCount} container(s) removed.`,
  };
}

async function retractArrivedBatch(batch, { force = false } = {}) {
  if (!force) {
    const progressed = await ShipmentItem.countDocuments({
      arrivedBatch: batch._id,
      status:       { $nin: ["customs"] },
    });
    if (progressed > 0) {
      throw new BatchRetractionError(
        `Cannot retract: ${progressed} item(s) from this arrival list have already moved past customs.`
      );
    }
  }

  const reverted = await ShipmentItem.updateMany(
    { arrivedBatch: batch._id },
    {
      $set:  { status: "shipped", arrivedBatch: null, arrivalDate: null },
      $pull: { stageHistory: { batchId: batch._id } },
    }
  );

  // Roll the container back from arrived → shipped
  const containerNumber = batch.containerRefs?.[0]?.id;
  let revertedContainers = 0;
  if (containerNumber) {
    const res = await ContainerLoading.updateOne(
      { containerNumber: containerNumber.toUpperCase(), status: "arrived" },
      { $set: { status: "shipped", actualArrivalDate: null } }
    );
    revertedContainers = res.modifiedCount;
  }

  await Batch.findByIdAndDelete(batch._id);

  return {
    stage:              "arrived",
    batchCode:          batch.batchCode,
    revertedItems:      reverted.modifiedCount,
    revertedContainers,
    summary:
      `Arrival batch ${batch.batchCode} retracted — ${reverted.modifiedCount} item(s) returned to shipped` +
      (revertedContainers ? `, container ${containerNumber} rolled back to shipped.` : "."),
  };
}

// force=true bypasses the "items have progressed" guard and reverses the batch
// anyway (admin escape hatch for undoing a wrong upload). Use with care.
async function retractBatch(batchId, { force = false } = {}) {
  const batch = await Batch.findById(batchId);
  if (!batch) return null;

  switch (batch.stage) {
    case "intake":  return retractIntakeBatch(batch, { force });
    case "shipped": return retractShippedBatch(batch, { force });
    case "arrived": return retractArrivedBatch(batch, { force });
    default:
      throw new BatchRetractionError(`Unknown batch stage "${batch.stage}"`);
  }
}

// ─── Validate (no DB writes) ──────────────────────────────────────────────────
//
// Returns a preview of what a real upload would do, suitable for the
// "Preview" button in BulkUploadModal. Never persists anything.

async function validateBatch(buffer, options = {}) {
  const { autoHold = false } = options;
  const parsed = parseUnifiedSheet(buffer);
  const { stage, metadata, items, skippedRows, headerWarnings, missingColumns } = parsed;

  const waybills = [...new Set(items.map((i) => i.waybillNo).filter(Boolean))];

  const existingItems = await ShipmentItem.find({ waybillNo: { $in: waybills } })
    .select("waybillNo status")
    .lean();
  const existingSet = new Set(existingItems.map((i) => i.waybillNo));

  const willCreate = waybills.filter((w) => !existingSet.has(w)).length;
  const willUpdate = waybills.filter((w) => existingSet.has(w)).length;

  let willHold = 0;
  if (stage === "shipped" && autoHold) {
    const cutoff         = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
    const recentBatches  = await Batch.find({ stage: "intake", createdAt: { $gte: cutoff } }).select("_id").lean();
    const uploadedPhones = [...new Set(items.map((i) => i.customerPhone).filter(Boolean))];
    willHold = await ShipmentItem.countDocuments({
      status:      "in_warehouse",
      intakeBatch: { $in: recentBatches.map((b) => b._id) },
      waybillNo:   { $nin: waybills },
      $or: [
        { customerPhone: null },
        { customerPhone: { $nin: uploadedPhones } },
      ],
    });
  }

  const sampleRows = items.slice(0, 5).map((item) => ({
    waybillNo:    item.waybillNo,
    customerName: item.customerName,
    customerPhone: item.customerPhoneRaw,
    cbm:          item.cbm,
    qty:          item.quantity,
    destination:  item.destinationCity,
  }));

  return {
    stage,
    metadata,
    headerWarnings,
    missingRequired: missingColumns,
    sampleRows,
    willCreate,
    willUpdate,
    willHold,
    totalRows:   items.length,
    skippedRows: skippedRows.length,
  };
}

// ─── Lookup helpers ───────────────────────────────────────────────────────────

// Staff-only fields stripped from all public lookups. containerRef and
// estimatedDelivery ARE returned, but only for items already loaded on a
// container — see sanitizePublicItem.
const PUBLIC_LOOKUP_SELECT = "-staffNotes -customerId -heldReason -reassignedTo -stageHistory";

// Goods still at the origin warehouse must not expose a container number or
// ETA — those only exist once the item is on a loaded packing list.
const PRE_LOADING_STATUSES = new Set(["in_warehouse", "held"]);

function sanitizePublicItem(item) {
  if (item && PRE_LOADING_STATUSES.has(item.status)) {
    delete item.containerRef;
    delete item.estimatedDelivery;
  }
  return item;
}

async function lookupByPhone(normalised) {
  const items = await ShipmentItem.find({ customerPhone: normalised })
    .sort({ updatedAt: -1 })
    .select(PUBLIC_LOOKUP_SELECT)
    .populate("intakeBatch",  "batchCode stage createdAt")
    .populate("shippedBatch", "batchCode stage createdAt")
    .lean();
  return items.map(sanitizePublicItem);
}

async function lookupByWaybill(waybill) {
  const item = await ShipmentItem.findOne({ waybillNo: waybill })
    .select(PUBLIC_LOOKUP_SELECT)
    .populate("intakeBatch",  "batchCode stage createdAt")
    .populate("shippedBatch", "batchCode stage createdAt")
    .lean();
  return sanitizePublicItem(item);
}

module.exports = {
  DuplicateBatchError,
  BatchRetractionError,
  retractBatch,
  parseUnifiedSheet,
  parseIntakeSheet,
  parseShippedSheet,
  parseArrivedSheet,
  processIntakeBatch,
  processShippedBatch,
  processArrivedBatch,
  validateBatch,
  normalisePhone,
  lookupByPhone,
  lookupByWaybill,
  sanitizePublicItem,
  PRE_LOADING_STATUSES,
};

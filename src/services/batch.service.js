const XLSX         = require("xlsx");
const Batch        = require("../models/Batch");
const ShipmentItem = require("../models/ShipmentItem");
const User         = require("../models/User");

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalise a Ghanaian phone number to 233XXXXXXXXX format.
 * Handles: 0XXXXXXXXX, +233XXXXXXXXX, 233XXXXXXXXX, 9-digit bare, and
 * numeric Excel values that lose the leading zero (e.g. 202425612 → 9 digits).
 */
function normalisePhone(raw) {
  if (raw === null || raw === undefined) return null;
  // Strip everything except digits
  const digits = String(raw).replace(/\D/g, "").trim();
  if (!digits || digits.length < 7) return null;
  if (digits.startsWith("233")) return digits;
  if (digits.startsWith("0"))   return "233" + digits.slice(1);
  // 9-digit bare number (Excel dropped the leading zero, e.g. 202425612)
  if (digits.length === 9)      return "233" + digits;
  return digits;
}

/**
 * Extract the numeric part from quantity strings like "13pallet", "1pallet", "22".
 */
function parseQuantity(raw) {
  if (raw === null || raw === undefined) return null;
  const str   = String(raw).trim();
  const match = str.match(/^(\d+(\.\d+)?)/);
  return match ? parseFloat(match[1]) : null;
}

/**
 * Split a waybill string on whitespace — handles cells like "301977756976 301977756989".
 */
function splitWaybills(raw) {
  if (!raw) return [];
  return String(raw)
    .trim()
    .split(/\s+/)
    .map((w) => w.trim().toUpperCase())
    .filter(Boolean);
}

/**
 * Look up a User by normalised phone (last-9-digits fallback for flexibility).
 */
async function findUserByPhone(normalised) {
  if (!normalised) return null;
  const last9 = normalised.slice(-9);
  const user  = await User.findOne({ phone: { $regex: last9 + "$" } }).select("_id");
  return user ? user._id : null;
}

function intakeBatchCode(date) {
  const d   = date instanceof Date ? date : new Date(date);
  const iso = isNaN(d) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
  return `INTAKE-${iso}`;
}

// ─── Parser: Intake sheet ─────────────────────────────────────────────────────
// Format: no header row, 5 columns
// [0] invoiceNo  [1] waybillNo  [2] customerPhone  [3] quantity  [4] date

function parseIntakeSheet(buffer) {
  const wb   = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  const items       = [];
  const skippedRows = [];
  let   batchDate   = null;

  rows.forEach((row, rowIdx) => {
    const [invoiceRaw, waybillRaw, phoneRaw, qtyRaw, dateRaw] = row;

    if (!waybillRaw && !phoneRaw) {
      skippedRows.push(rowIdx + 1);
      return;
    }

    const waybills = splitWaybills(waybillRaw);
    if (waybills.length === 0) {
      skippedRows.push(rowIdx + 1);
      return;
    }

    const phone     = normalisePhone(phoneRaw);
    const qty       = parseQuantity(qtyRaw);
    const invoiceNo = invoiceRaw ? String(invoiceRaw).trim() : null;
    const date      = dateRaw instanceof Date ? dateRaw : (dateRaw ? new Date(dateRaw) : null);
    if (date && !batchDate) batchDate = date;

    for (const waybill of waybills) {
      items.push({
        waybillNo:        waybill,
        invoiceNo,
        customerPhoneRaw: phoneRaw ? String(phoneRaw).trim() : null,
        customerPhone:    phone,
        quantity:         qty,
        quantityRaw:      qtyRaw !== null ? String(qtyRaw).trim() : null,
        intakeDate:       date,
      });
    }
  });

  return { items, skippedRows, batchDate };
}

// ─── Parser: Shipped sheet (CTR_INVOICE / Packing List format) ────────────────
//
// Structure:
//   Row 1:  BL NUMBER        | <value or blank>
//   Row 2:  CTR NUMBER       | MSBU7337022
//   Row 3:  VOLUME           | 40 HQ
//   Row 4:  SEAL NUMBER      | <value or blank>
//   Row 5:  PACKING LIST NUMBER | 2026-001
//   Row 6:  LOADING DATE     | 3/01/2026
//   Row 7:  ETD              | <value or blank>
//   Row 8:  ETA              | <value or blank>
//   Row 9:  HEADER ROW       | JOB NUMBER, CNEE NAME, PHONE NUMBER, LOCATION, ...
//   Row 10+: DATA ROWS

function parseShippedSheet(buffer) {
  const wb   = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  // ── Extract metadata from rows 0–7 (0-indexed) ──────────────────────────
  const meta = {};
  for (let i = 0; i < 8 && i < rows.length; i++) {
    const row = rows[i];
    if (!row || !row[0]) continue;
    const key = String(row[0]).trim().toUpperCase();
    const val = row[1] !== null && row[1] !== undefined ? String(row[1]).trim() : null;
    meta[key] = val;
  }

  const containerNumber    = meta["CTR NUMBER"]           || null; // e.g. "MSBU7337022"
  const packingListNumber  = meta["PACKING LIST NUMBER"]  || null; // e.g. "2026-001"
  const blNumber           = meta["BL NUMBER"]            || null;
  const sealNumber         = meta["SEAL NUMBER"]          || null;
  const volume             = meta["VOLUME"]               || null; // e.g. "40 HQ"
  const loadingDateRaw     = meta["LOADING DATE"]         || null;
  const etd                = meta["ETD"]                  || null;
  const eta                = meta["ETA"]                  || null;

  const loadingDate = loadingDateRaw ? new Date(loadingDateRaw) : null;

  // Use packing list number + container as the batch code
  const batchCode = packingListNumber
    ? `PKL-${packingListNumber}`
    : containerNumber
    ? `CTR-${containerNumber}`
    : `SHIPPED-${new Date().toISOString().slice(0, 10)}`;

  const containerRef = containerNumber || batchCode;

  // ── Header is at row index 8 (row 9 in spreadsheet), data from index 9 ──
  const HEADER_IDX = 8;
  const headerRow  = rows[HEADER_IDX] || [];

  const colIndex = {};
  headerRow.forEach((h, i) => {
    if (h) colIndex[String(h).trim().toUpperCase()] = i;
  });

  const get = (row, key) => {
    const i = colIndex[key];
    return i !== undefined ? row[i] : null;
  };

  const items       = [];
  const skippedRows = [];

  for (let i = HEADER_IDX + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;

    const jobNumberRaw = get(row, "JOB NUMBER");
    const phoneRaw     = get(row, "PHONE NUMBER");

    // Skip empty or summary rows
    if (!jobNumberRaw && !phoneRaw) {
      skippedRows.push(i + 1);
      continue;
    }

    const waybills = splitWaybills(jobNumberRaw);
    if (waybills.length === 0) {
      skippedRows.push(i + 1);
      continue;
    }

    const phone         = normalisePhone(phoneRaw);
    const cneeName      = get(row, "CNEE NAME")     ? String(get(row, "CNEE NAME")).trim()     : null;
    const location      = get(row, "LOCATION")      ? String(get(row, "LOCATION")).trim().toUpperCase() : null;
    const goodsType     = get(row, "GOODS TYPE")    ? String(get(row, "GOODS TYPE")).trim()    : null;
    const description   = get(row, "DESCRIPTION")   ? String(get(row, "DESCRIPTION")).trim()   : null;
    const remarks       = get(row, "REMARKS")        ? String(get(row, "REMARKS")).trim()       : null;
    const qtyRaw        = get(row, "  QUANTITY") ?? get(row, "QUANTITY");
    const qty           = parseQuantity(qtyRaw);
    const cbmRaw        = get(row, "CBM");
    const cbm           = cbmRaw !== null ? parseFloat(cbmRaw) : null;

    // Financial fields
    const collectOF     = get(row, "COLLECT O/F AMOUNT") ? String(get(row, "COLLECT O/F AMOUNT")).trim() : null;
    const paymentTerm   = parseQuantity(get(row, "PAYMENT TERM $"));
    const loan          = parseQuantity(get(row, "LOAN"));
    const interest      = parseQuantity(get(row, "INTEREST"));
    const otherFee      = parseQuantity(get(row, "OTHER FEE"));
    const invoiceAmount = parseQuantity(get(row, "INVOICE AMOUNT"));

    // Skip totals row (CNEE NAME is purely numeric)
    const cneeStr = cneeName ? String(cneeName) : "";
    if (/^\d+(\.\d+)?$/.test(cneeStr)) {
      skippedRows.push(i + 1);
      continue;
    }

    for (const waybill of waybills) {
      items.push({
        waybillNo:          waybill,
        customerPhoneRaw:   phoneRaw ? String(phoneRaw).trim() : null,
        customerPhone:      phone,
        customerName:       cneeName,
        destinationCity:    location,
        goodsType,
        quantity:           qty,
        quantityRaw:        qtyRaw !== null ? String(qtyRaw).trim() : null,
        cbm:                isNaN(cbm) ? null : cbm,
        productDescription: description || goodsType,
        containerRef,
        // Financial details from packing list
        freightTerm:   collectOF,   // e.g. "COLLECT"
        freightAmount: paymentTerm, // the dollar amount
        loan,
        interest,
        otherFee,
        invoiceAmount,
        remarks,
        // Batch metadata
        receivingDate: loadingDate,
      });
    }
  }

  return {
    batchCode,
    containerNumber,
    packingListNumber,
    blNumber,
    sealNumber,
    volume,
    loadingDate,
    etd,
    eta,
    items,
    skippedRows,
  };
}

// ─── Processor: Intake batch ──────────────────────────────────────────────────

async function processIntakeBatch(parsedData, uploadedBy) {
  const { items, skippedRows, batchDate } = parsedData;

  const batch = await Batch.create({
    batchCode:  intakeBatchCode(batchDate),
    stage:      "intake",
    uploadedBy,
    skippedRows,
  });

  let newItems     = 0;
  let matchedItems = 0;

  for (const item of items) {
    const exists = await ShipmentItem.findOne({ waybillNo: item.waybillNo });
    if (exists) {
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
    batch: await Batch.findById(batch._id),
    skippedRows,
    summary: `${totalItems} items processed. ${newItems} new, ${matchedItems} already existed, 0 held.`,
  };
}

// ─── Processor: Shipped batch (CTR_INVOICE packing list) ─────────────────────

async function processShippedBatch(parsedData, uploadedBy) {
  const {
    batchCode, containerNumber, packingListNumber,
    blNumber, sealNumber, volume, loadingDate, etd, eta,
    items, skippedRows,
  } = parsedData;

  const batch = await Batch.create({
    batchCode,
    stage:      "shipped",
    uploadedBy,
    skippedRows,
    // Store container metadata on the batch for reference
    containerRefs: containerNumber
      ? [{ code: packingListNumber || batchCode, id: containerNumber, date: loadingDate }]
      : [],
    notes: [
      blNumber     ? `BL: ${blNumber}`                   : null,
      sealNumber   ? `Seal: ${sealNumber}`                : null,
      volume       ? `Volume: ${volume}`                  : null,
      etd          ? `ETD: ${etd}`                        : null,
      eta          ? `ETA: ${eta}`                        : null,
    ].filter(Boolean).join(" | ") || undefined,
  });

  const uploadedWaybills = new Set(items.map((i) => i.waybillNo));
  let newItems     = 0;
  let matchedItems = 0;

  for (const item of items) {
    const customerId = await findUserByPhone(item.customerPhone);
    const existing   = await ShipmentItem.findOne({ waybillNo: item.waybillNo });

    if (existing) {
      if (existing.status === "shipped") {
        matchedItems++;
        continue;
      }
      // Update to shipped — merge all new fields
      existing.status           = "shipped";
      existing.shippedBatch     = batch._id;
      existing.customerName     = item.customerName     || existing.customerName;
      existing.destinationCity  = item.destinationCity  || existing.destinationCity;
      existing.cbm              = item.cbm              ?? existing.cbm;
      existing.productDescription = item.productDescription || existing.productDescription;
      existing.containerRef     = item.containerRef     || existing.containerRef;
      existing.quantity         = item.quantity         ?? existing.quantity;
      existing.quantityRaw      = item.quantityRaw      || existing.quantityRaw;
      existing.receivingDate    = item.receivingDate     || existing.receivingDate;
      // Financial fields from packing list
      existing.freightTerm      = item.freightTerm      || existing.freightTerm;
      existing.freightAmount    = item.freightAmount     ?? existing.freightAmount;
      existing.loan             = item.loan              ?? existing.loan;
      existing.interest         = item.interest          ?? existing.interest;
      existing.otherFee         = item.otherFee          ?? existing.otherFee;
      existing.invoiceAmount    = item.invoiceAmount      ?? existing.invoiceAmount;
      existing.remarks          = item.remarks           || existing.remarks;
      if (customerId && !existing.customerId) existing.customerId = customerId;
      existing.stageHistory.push({
        stage:     "shipped",
        status:    "shipped",
        batchId:   batch._id,
        updatedAt: new Date(),
        note:      `Updated via packing list ${batchCode}`,
      });
      await existing.save();
      matchedItems++;
    } else {
      // Item not in any intake — create directly as shipped
      await ShipmentItem.create({
        ...item,
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

  // Hold items still in_warehouse from recent intake batches not included here
  const cutoff          = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const recentBatches   = await Batch.find({ stage: "intake", createdAt: { $gte: cutoff } }).select("_id");
  const recentBatchIds  = recentBatches.map((b) => b._id);

  const heldResult = await ShipmentItem.updateMany(
    {
      status:      "in_warehouse",
      intakeBatch: { $in: recentBatchIds },
      waybillNo:   { $nin: Array.from(uploadedWaybills) },
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

  const heldItems  = heldResult.modifiedCount;
  const totalItems = newItems + matchedItems;
  await Batch.findByIdAndUpdate(batch._id, { totalItems, newItems, matchedItems, heldItems });

  return {
    batch: await Batch.findById(batch._id),
    skippedRows,
    summary: `${totalItems} items processed. ${newItems} new, ${matchedItems} updated, ${heldItems} held.`,
  };
}

module.exports = {
  parseIntakeSheet,
  parseShippedSheet,
  processIntakeBatch,
  processShippedBatch,
  normalisePhone,
};

const XLSX    = require("xlsx");
const Batch   = require("../models/Batch");
const ShipmentItem = require("../models/ShipmentItem");
const User    = require("../models/User");

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Normalise a Ghanaian phone number to 233XXXXXXXXX format.
 */
function normalisePhone(raw) {
  if (raw === null || raw === undefined) return null;
  const digits = String(raw).replace(/\D/g, "").trim();
  if (!digits || digits.length < 7) return null;
  if (digits.startsWith("233")) return digits;
  if (digits.startsWith("0"))   return "233" + digits.slice(1);
  if (digits.length === 9)      return "233" + digits;
  return digits;
}

/**
 * Extract the numeric part from quantity strings like "13pallet", "1pallet", "22".
 */
function parseQuantity(raw) {
  if (raw === null || raw === undefined) return null;
  const str = String(raw).trim();
  const match = str.match(/^(\d+)/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * Split a waybill string on whitespace to handle cells like "301977756976 301977756989".
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
 * Parse container ref strings like "28th/Sep 2025--N006=MSBU8308501".
 */
function parseContainerRef(str) {
  if (!str || typeof str !== "string") return null;
  // Extract date part and container info
  const match = str.match(/^(.+?)--([A-Z0-9]+)=([A-Z0-9]+)/i);
  if (!match) return null;
  const dateStr = match[1]; // e.g. "28th/Sep 2025"
  const code    = match[2]; // e.g. "N006"
  const id      = match[3]; // e.g. "MSBU8308501"
  // Try to parse the date
  const cleaned = dateStr.replace(/(\d+)(st|nd|rd|th)\//, "$1 ").replace("/", " ");
  const date    = new Date(cleaned);
  return { code, id, date: isNaN(date) ? null : date };
}

/**
 * Look up a User by normalised phone number.
 * Tries exact match first, then last-9-digits fallback.
 */
async function findUserByPhone(normalised) {
  if (!normalised) return null;
  const last9 = normalised.slice(-9);
  const user = await User.findOne({
    phone: { $regex: last9 + "$" },
  }).select("_id");
  return user ? user._id : null;
}

/**
 * Build a batch code from a date string.
 */
function intakeBatchCode(date) {
  const d = date instanceof Date ? date : new Date(date);
  const iso = isNaN(d) ? new Date().toISOString().slice(0, 10) : d.toISOString().slice(0, 10);
  return `INTAKE-${iso}`;
}

// ─── Parsers ──────────────────────────────────────────────────────────────────

/**
 * Parse the intake Excel sheet (no header row, 5 columns).
 * Returns { items: [...], skippedRows: [...] }
 */
function parseIntakeSheet(buffer) {
  const wb   = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  const items      = [];
  const skippedRows = [];
  let batchDate    = null;

  rows.forEach((row, rowIdx) => {
    const [invoiceRaw, waybillRaw, phoneRaw, qtyRaw, dateRaw] = row;

    // Skip completely empty rows
    if (!waybillRaw && !phoneRaw) {
      skippedRows.push(rowIdx + 1);
      return;
    }

    const waybills = splitWaybills(waybillRaw);
    if (waybills.length === 0) {
      skippedRows.push(rowIdx + 1);
      return;
    }

    const phone      = normalisePhone(phoneRaw);
    const qty        = parseQuantity(qtyRaw);
    const invoiceNo  = invoiceRaw ? String(invoiceRaw).trim() : null;
    const date       = dateRaw instanceof Date ? dateRaw : (dateRaw ? new Date(dateRaw) : null);

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

/**
 * Parse the shipped or arrived Excel sheet.
 * Extracts container refs from metadata rows, then reads data with header.
 * Returns { containerRefs: [...], items: [...], skippedRows: [...] }
 */
function parseShippedSheet(buffer) {
  const wb   = XLSX.read(buffer, { type: "buffer", cellDates: true });
  const ws   = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: null });

  // Extract container refs from rows at index 1 and 2
  const containerRefs = [];
  [rows[1], rows[2]].forEach((row) => {
    if (!row) return;
    const cell = row[0];
    const ref  = parseContainerRef(cell);
    if (ref) containerRefs.push(ref);
  });

  // Derive batchCode from container refs
  const batchCode = containerRefs.length > 0
    ? containerRefs.map((r) => r.code).join("+")
    : `SHIPPED-${new Date().toISOString().slice(0, 10)}`;

  // Header is at index 3 — data starts at index 4
  // Map columns by name
  const HEADER_ROW_IDX = 3;
  const headerRow = rows[HEADER_ROW_IDX] || [];

  const colIndex = {};
  headerRow.forEach((h, i) => {
    if (h) colIndex[String(h).trim().toUpperCase()] = i;
  });

  const get = (row, key) => {
    const i = colIndex[key];
    return i !== undefined ? row[i] : null;
  };

  const items      = [];
  const skippedRows = [];

  for (let i = HEADER_ROW_IDX + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row) continue;

    const waybillRaw = get(row, "TRACKING N0.");
    const phoneRaw   = get(row, "CONTACT");

    // Skip totals/summary/completely empty rows
    const allEmpty = !waybillRaw && !phoneRaw && !get(row, "INVOICE N0.");
    if (allEmpty) {
      skippedRows.push(i + 1);
      continue;
    }

    const waybills = splitWaybills(waybillRaw);
    if (waybills.length === 0) {
      skippedRows.push(i + 1);
      continue;
    }

    const phone       = normalisePhone(phoneRaw);
    const qty         = parseQuantity(get(row, "QTY PER TRACKING"));
    const cbmRaw      = get(row, "CBM PER TRACKING");
    const cbm         = cbmRaw !== null ? parseFloat(cbmRaw) : null;
    const invoiceNo   = get(row, "INVOICE N0.") ? String(get(row, "INVOICE N0.")).trim() : null;
    const custName    = get(row, "CUSTOMER NAME") ? String(get(row, "CUSTOMER NAME")).trim() : null;
    const location    = get(row, "LOCATION") ? String(get(row, "LOCATION")).trim() : null;
    const prodDesc    = get(row, "PRODUCT DESCRIPTION") ? String(get(row, "PRODUCT DESCRIPTION")).trim() : null;
    const dateRaw     = get(row, "RECEIVING DATE");
    const receivingDate = dateRaw instanceof Date ? dateRaw : (dateRaw ? new Date(dateRaw) : null);
    const feesRaw     = colIndex["UNNAMED: 11"] !== undefined ? row[colIndex["UNNAMED: 11"]] : null;
    // Container ref label (e.g. "N005+N006") — typically in unnamed col after fees
    const contRefRaw  = (() => {
      // Find unnamed cols with "N0" pattern values
      for (let ci = 10; ci < row.length; ci++) {
        const val = row[ci];
        if (val && /^N\d{3}/i.test(String(val))) return String(val).trim();
      }
      return batchCode;
    })();

    // Skip if this looks like a totals row (customerName is a number)
    if (custName && /^\d+(\.\d+)?$/.test(custName)) {
      skippedRows.push(i + 1);
      continue;
    }

    for (const waybill of waybills) {
      items.push({
        waybillNo:          waybill,
        invoiceNo,
        customerPhoneRaw:   phoneRaw ? String(phoneRaw).trim() : null,
        customerPhone:      phone,
        customerName:       custName,
        destinationCity:    location ? location.toUpperCase() : null,
        quantity:           qty,
        quantityRaw:        get(row, "QTY PER TRACKING") !== null ? String(get(row, "QTY PER TRACKING")).trim() : null,
        cbm:                isNaN(cbm) ? null : cbm,
        productDescription: prodDesc,
        receivingDate,
        containerRef:       contRefRaw,
        fees:               feesRaw ? String(feesRaw).trim() : null,
      });
    }
  }

  return { containerRefs, batchCode, items, skippedRows };
}

// Arrived sheet has same structure as shipped
const parseArrivedSheet = parseShippedSheet;

// ─── Processors ───────────────────────────────────────────────────────────────

/**
 * Process an intake batch upload.
 */
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

/**
 * Process a shipped batch upload.
 */
async function processShippedBatch(parsedData, uploadedBy) {
  const { containerRefs, batchCode, items, skippedRows } = parsedData;

  const batch = await Batch.create({
    batchCode,
    stage:         "shipped",
    uploadedBy,
    containerRefs,
    skippedRows,
  });

  const uploadedWaybills = new Set(items.map((i) => i.waybillNo));
  let newItems     = 0;
  let matchedItems = 0;

  for (const item of items) {
    const customerId = await findUserByPhone(item.customerPhone);
    const existing   = await ShipmentItem.findOne({ waybillNo: item.waybillNo });

    if (existing) {
      if (["shipped", "arrived"].includes(existing.status)) {
        matchedItems++;
        continue; // already at a later stage — skip
      }
      // Update to shipped
      existing.status        = "shipped";
      existing.shippedBatch  = batch._id;
      existing.customerName  = item.customerName  || existing.customerName;
      existing.destinationCity = item.destinationCity || existing.destinationCity;
      existing.cbm           = item.cbm           ?? existing.cbm;
      existing.productDescription = item.productDescription || existing.productDescription;
      existing.receivingDate = item.receivingDate  || existing.receivingDate;
      existing.containerRef  = item.containerRef   || existing.containerRef;
      existing.fees          = item.fees           || existing.fees;
      existing.quantity      = item.quantity       ?? existing.quantity;
      existing.quantityRaw   = item.quantityRaw    || existing.quantityRaw;
      if (customerId && !existing.customerId) existing.customerId = customerId;
      existing.stageHistory.push({
        stage:     "shipped",
        status:    "shipped",
        batchId:   batch._id,
        updatedAt: new Date(),
        note:      `Updated via shipped batch ${batchCode}`,
      });
      await existing.save();
      matchedItems++;
    } else {
      // New item — wasn't in intake, create directly as shipped
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
          note:      `Created directly via shipped batch ${batchCode}`,
        }],
      });
      newItems++;
    }
  }

  // Hold items that are still in_warehouse and weren't in this upload
  // Only target items from intake batches created in last 90 days
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000);
  const recentIntakeBatches = await Batch.find({
    stage:     "intake",
    createdAt: { $gte: cutoff },
  }).select("_id");
  const recentIntakeIds = recentIntakeBatches.map((b) => b._id);

  const heldResult = await ShipmentItem.updateMany(
    {
      status:       "in_warehouse",
      intakeBatch:  { $in: recentIntakeIds },
      waybillNo:    { $nin: Array.from(uploadedWaybills) },
    },
    {
      $set: { status: "held", heldReason: `Not included in shipped batch ${batchCode}` },
      $push: {
        stageHistory: {
          stage:     "shipped",
          status:    "held",
          batchId:   batch._id,
          updatedAt: new Date(),
          note:      `Auto-held — not found in shipped batch ${batchCode}`,
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

/**
 * Process an arrived batch upload.
 */
async function processArrivedBatch(parsedData, uploadedBy) {
  const { containerRefs, batchCode, items, skippedRows } = parsedData;

  const derivedCode = batchCode.startsWith("SHIPPED-")
    ? batchCode.replace("SHIPPED-", "ARRIVED-")
    : `ARRIVED-${batchCode}`;

  const batch = await Batch.create({
    batchCode:    derivedCode,
    stage:        "arrived",
    uploadedBy,
    containerRefs,
    skippedRows,
  });

  const uploadedWaybills = new Set(items.map((i) => i.waybillNo));
  let newItems     = 0;
  let matchedItems = 0;

  for (const item of items) {
    const customerId = await findUserByPhone(item.customerPhone);
    const existing   = await ShipmentItem.findOne({ waybillNo: item.waybillNo });

    if (existing) {
      if (existing.status === "arrived") {
        matchedItems++;
        continue;
      }
      existing.status       = "arrived";
      existing.arrivedBatch = batch._id;
      existing.customerName = item.customerName || existing.customerName;
      existing.destinationCity = item.destinationCity || existing.destinationCity;
      if (item.cbm)               existing.cbm = item.cbm;
      if (item.productDescription) existing.productDescription = item.productDescription;
      if (item.receivingDate)      existing.receivingDate = item.receivingDate;
      if (item.containerRef)       existing.containerRef = item.containerRef;
      if (item.fees)               existing.fees = item.fees;
      if (customerId && !existing.customerId) existing.customerId = customerId;
      existing.stageHistory.push({
        stage:     "arrived",
        status:    "arrived",
        batchId:   batch._id,
        updatedAt: new Date(),
        note:      `Updated via arrived batch ${derivedCode}`,
      });
      await existing.save();
      matchedItems++;
    } else {
      await ShipmentItem.create({
        ...item,
        customerId,
        status:       "arrived",
        arrivedBatch: batch._id,
        stageHistory: [{
          stage:     "arrived",
          status:    "arrived",
          batchId:   batch._id,
          updatedAt: new Date(),
          note:      `Created directly via arrived batch ${derivedCode}`,
        }],
      });
      newItems++;
    }
  }

  // Hold shipped items not in this upload
  const heldResult = await ShipmentItem.updateMany(
    {
      status:    "shipped",
      waybillNo: { $nin: Array.from(uploadedWaybills) },
    },
    {
      $set: { status: "held", heldReason: `Not included in arrived batch ${derivedCode}` },
      $push: {
        stageHistory: {
          stage:     "arrived",
          status:    "held",
          batchId:   batch._id,
          updatedAt: new Date(),
          note:      `Auto-held — not found in arrived batch ${derivedCode}`,
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
  parseArrivedSheet,
  processIntakeBatch,
  processShippedBatch,
  processArrivedBatch,
  normalisePhone,
};

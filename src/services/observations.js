"use strict";

/**
 * Observation emitter — Layer 1 of the two-layer tracking model.
 *
 * Turns an uploaded spreadsheet into a SourceFile descriptor plus a flat list
 * of immutable Observations, one per parcel-token. It is a thin adapter over
 * the existing `parseUnifiedSheet` in batch.service: that parser already splits
 * multi-tracking cells, apportions additive amounts, forward-fills names and
 * parses quantities, so this module only reshapes its output into the
 * observation schema and never touches the database.
 *
 * An Observation is a plain object (no mongoose) so the derivation layer that
 * consumes it stays a pure, DB-free function that can be unit-tested against
 * the real fixture spreadsheets.
 */

const crypto = require("crypto");
const { parseUnifiedSheet } = require("./batch.service");

// The parser labels the loading stage "shipped" and the arrival stage
// "arrived"; the observation model uses the stage names the business uses.
const STAGE_MAP = { intake: "intake", shipped: "loading", arrived: "arrival" };

function sha256(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * The date a parcel physically entered the warehouse. Present on BOTH intake
 * rows and loading rows (the loading list carries a RECEIVING DATE column), so
 * a parcel's received-date is knowable even when its intake sheet was never
 * uploaded. The parser stores it in `intakeDate` on every stage.
 */
function receivedDateOf(item) {
  return item.intakeDate || null;
}

/**
 * The date of THIS stage's own event: received-date for intake, loading date
 * for a loading row, arrival date for an arrival row.
 */
function eventDateOf(stage, item, metadata) {
  if (stage === "intake") return item.intakeDate || metadata.BATCH_DATE || null;
  if (stage === "loading") return item.receivingDate || metadata.LOADING_DATE || null;
  if (stage === "arrival") return metadata.ARRIVAL_DATE || null;
  return null;
}

/**
 * Build the SourceFile descriptor + Observations for one uploaded spreadsheet.
 *
 * @param {Buffer} buffer                 raw .xlsx bytes
 * @param {object} opts
 * @param {string} opts.filename          original upload filename
 * @param {*}      [opts.uploadedBy]      user id (opaque here)
 * @param {Date}   [opts.uploadedAt]      defaults to now; stamped on every
 *                                        observation so derivation has a
 *                                        deterministic recency order
 * @returns {{ sourceFile: object, observations: object[],
 *             stage: string, skippedRows: number[],
 *             headerWarnings: string[], missingColumns: string[] }}
 */
function buildObservations(buffer, opts = {}) {
  const { filename = null, uploadedBy = null, uploadedAt = new Date() } = opts;

  const parsed = parseUnifiedSheet(buffer);
  const stage  = STAGE_MAP[parsed.stage] || null;
  const fileHash = sha256(buffer);

  const sourceFile = {
    fileHash,
    stage,
    originalFilename: filename,
    uploadedBy,
    uploadedAt,
    metadata: parsed.metadata,
    rowCount: parsed.items.length,
    skippedRows: parsed.skippedRows,
    status: "active",
  };

  // A single sheet cell holding several tracking numbers yields several items
  // sharing one srcRow; number them so each observation is uniquely addressable
  // back to its exact origin (file, row, token).
  const tokenSeen = new Map();

  const observations = parsed.items.map((item) => {
    const srcRow = item.srcRow ?? null;
    const tokenIndex = srcRow == null ? 0 : (tokenSeen.get(srcRow) || 0);
    if (srcRow != null) tokenSeen.set(srcRow, tokenIndex + 1);

    return {
      // ── provenance ──────────────────────────────────────────────────────
      fileHash,
      stage,
      srcRow,
      tokenIndex,
      sourceFilename: filename,
      uploadedAt,

      // ── identity ────────────────────────────────────────────────────────
      waybill:       item.waybillNo || null,
      contactRaw:    item.contactRaw || item.customerPhoneRaw || item.shippingMarkRaw || null,
      customerPhone: item.customerPhone || null,
      shippingMark:  item.shippingMark || null,
      customerName:  item.customerName || null,
      customerKey:   item.customerKey || null,
      needsPhone:    !item.customerPhone,

      // ── dates ───────────────────────────────────────────────────────────
      receivedDate: receivedDateOf(item),
      eventDate:    eventDateOf(stage, item, parsed.metadata),
      warehouse:    stage === "intake" ? (parsed.metadata.WAREHOUSE || null) : null,

      // ── cargo ───────────────────────────────────────────────────────────
      qty:          item.quantity ?? null,
      qtyRaw:       item.quantityRaw || null,
      qtyUnit:      item.quantityUnit || null,
      kg:           item.kg ?? null,
      cbm:          item.cbm ?? null,
      invoiceNo:    item.invoiceNo || null,
      location:     item.destinationCity || null,
      productDescription: item.productDescription || null,
      goodsType:    item.goodsType || null,
      remarks:      item.remarks || null,

      // ── financials (loading/arrival) ────────────────────────────────────
      financials: {
        freightTerm:   item.freightTerm ?? null,
        freightAmount: item.freightAmount ?? null,
        loan:          item.loan ?? null,
        interest:      item.interest ?? null,
        otherFee:      item.otherFee ?? null,
        invoiceAmount: item.invoiceAmount ?? null,
      },

      // ── container context (from the file's metadata block) ──────────────
      container: (stage === "loading" || stage === "arrival") ? {
        containerNo: parsed.metadata.CONTAINER_NUMBER || null,
        batchRef:    parsed.metadata.BATCH_REF || null,
        blNumber:    parsed.metadata.BL_NUMBER || null,
        sealNumber:  parsed.metadata.SEAL_NUMBER || null,
        volume:      parsed.metadata.VOLUME || null,
        loadingDate: parsed.metadata.LOADING_DATE || null,
        etd:         parsed.metadata.ETD || null,
        eta:         parsed.metadata.ETA || null,
      } : null,

      // full parsed row, so the model can be re-derived after any later schema
      // change without re-reading the original spreadsheet
      raw: item,
    };
  });

  return {
    sourceFile,
    observations,
    stage,
    skippedRows: parsed.skippedRows,
    headerWarnings: parsed.headerWarnings,
    missingColumns: parsed.missingColumns,
  };
}

module.exports = { buildObservations, sha256, STAGE_MAP };

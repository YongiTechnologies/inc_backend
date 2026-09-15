"use strict";

/**
 * Parcel derivation — Layer 2 of the two-layer tracking model.
 *
 * A Parcel is a PURE FUNCTION of the immutable Observations that share its
 * (waybill, customer) identity. Nothing here touches the database, a clock, or
 * any external state, so the whole cross-stage tracking logic is unit-testable
 * against the real fixture spreadsheets, and is order-independent and
 * idempotent by construction: re-run it on the same observations in any order
 * and you get identical parcels.
 *
 *   observations ──group by waybill──► partition by customer ──fold──► parcels
 *
 * Identity resolution (the one genuinely hard part) is done with a global alias
 * map learned from evidence — a row that carries BOTH a phone and a shipping
 * mark proves those refer to one customer — never by guessing on an ambiguous
 * shared waybill.
 */

const STAGE_RANK = { intake: 1, loading: 2, arrival: 3 };

// The manual status lifecycle, in order. A parcel's derived base status comes
// from the furthest sheet it appears on; staff can advance it further by hand
// (loaded, ready for pickup, delivered). Effective status is the furthest of
// the two — see applyAdjustment in ingest.service.
const STATUS_ORDER = ["received", "loaded", "shipped", "at_port", "ready_for_pickup", "delivered"];
const STAGE_STATUS = { intake: "received", loading: "shipped", arrival: "at_port" };

/** Position of a status in the lifecycle, or -1 if unknown. */
function statusRank(s) {
  return STATUS_ORDER.indexOf(s);
}

function normalizeName(name) {
  return name ? String(name).toUpperCase().replace(/[^A-Z0-9]/g, "") : "";
}

/**
 * Learn `m:<mark>` → `p:<phone>` and `n:<name>` → `p:<phone>` links from any
 * observation that carries a phone alongside a mark/name. A mark or name that
 * points at two different phones is ambiguous and is dropped rather than
 * guessed. The result canonicalises a customer to their phone wherever the
 * data has ever tied the two together — so the same person recorded under a
 * mark on one sheet and a phone on another folds into one parcel.
 */
function buildAliasMap(observations) {
  const votes = new Map(); // alias key -> Set of p:<phone>
  const vote = (aliasKey, phoneKey) => {
    if (!votes.has(aliasKey)) votes.set(aliasKey, new Set());
    votes.get(aliasKey).add(phoneKey);
  };

  for (const o of observations) {
    if (!o.customerPhone) continue;
    const phoneKey = `p:${o.customerPhone}`;
    if (o.shippingMark) vote(`m:${o.shippingMark}`, phoneKey);
    const n = normalizeName(o.customerName);
    if (n) vote(`n:${n}`, phoneKey);
  }

  const alias = new Map();
  for (const [aliasKey, phones] of votes) {
    if (phones.size === 1) alias.set(aliasKey, [...phones][0]); // unambiguous only
  }
  return alias;
}

/** The customer key an observation resolves to once global aliases are applied. */
function canonicalKey(obs, aliasMap) {
  const k = obs.customerKey;
  if (!k) return `r:__row${obs.srcRow}_${obs.tokenIndex}`;
  if ((k.startsWith("m:") || k.startsWith("n:")) && aliasMap.has(k)) return aliasMap.get(k);
  return k;
}

/**
 * Partition one waybill's observations into one group per customer.
 *
 * Groups by canonical key. The only inference beyond that: a purely
 * unidentifiable row (`r:` — no phone, mark or name at all) is absorbed into
 * the sole identified customer when the waybill has exactly one, since it
 * cannot be a different named customer. When a waybill carries several
 * identified customers, unidentifiable rows are left on their own rather than
 * guessed onto one of them.
 *
 * @param {object[]} obs  observations that all share one waybill
 * @returns {object[][]}  groups of observations, one per customer
 */
function partitionByCustomer(obs, aliasMap) {
  const alias = aliasMap || buildAliasMap(obs);
  const groups = new Map(); // canonical key -> obs[]
  for (const o of obs) {
    const key = canonicalKey(o, alias);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }

  let result = [...groups.values()];

  // ── Cross-stage singleton merge ─────────────────────────────────────────
  // One tracking number with at most one customer AT EACH STAGE is a single
  // parcel, even when the sheets identified that customer differently — a phone
  // in one format at intake and another at loading, or a shipping mark at
  // intake and a phone at loading. A genuinely consolidated waybill instead has
  // several customers AT THE SAME STAGE (e.g. three names under one number on a
  // loading list), so this never merges those: it only fires when every stage
  // is represented by at most one group.
  if (result.length > 1) {
    const stageGroupCount = { intake: 0, loading: 0, arrival: 0 };
    for (const g of result) {
      const stages = new Set(g.map((o) => o.stage));
      for (const s of stages) if (stageGroupCount[s] !== undefined) stageGroupCount[s]++;
    }
    const noStageShared = Object.values(stageGroupCount).every((c) => c <= 1);
    if (noStageShared) result = [result.flat()];
  }

  // ── Absorb unidentifiable rows ──────────────────────────────────────────
  // When several distinct customers remain (a real shared waybill) but a purely
  // unidentifiable row (`r:` — no phone, mark or name) is also present, fold it
  // into the sole identified customer if there is exactly one; otherwise leave
  // it on its own rather than guess which customer it belongs to.
  if (result.length > 1) {
    const identified = result.filter((g) => g.some((o) => o.customerKey && !o.customerKey.startsWith("r:")));
    const rowOnly = result.filter((g) => g.every((o) => !o.customerKey || o.customerKey.startsWith("r:")));
    if (identified.length === 1 && rowOnly.length) {
      identified[0].push(...rowOnly.flat());
      result = identified;
    }
  }

  return result;
}

// Deterministic "later stage / later event wins" order, independent of the
// wall-clock moment a file happened to be uploaded — so field folding gives the
// same result no matter the upload order.
function byRecency(a, b) {
  const ra = STAGE_RANK[a.stage] || 0, rb = STAGE_RANK[b.stage] || 0;
  if (ra !== rb) return ra - rb;
  const ta = a.eventDate ? +new Date(a.eventDate) : 0;
  const tb = b.eventDate ? +new Date(b.eventDate) : 0;
  if (ta !== tb) return ta - tb;
  if (a.fileHash !== b.fileHash) return (a.fileHash || "") < (b.fileHash || "") ? -1 : 1;
  if ((a.srcRow || 0) !== (b.srcRow || 0)) return (a.srcRow || 0) - (b.srcRow || 0);
  return (a.tokenIndex || 0) - (b.tokenIndex || 0);
}

/** Latest non-null value of `field` across a stage's observations. */
function pick(list, field) {
  let v = null;
  for (const o of list) if (o[field] != null && o[field] !== "") v = o[field];
  return v;
}

const digitsOf = (s) => String(s).replace(/\D/g, "");
/** The most complete phone across observations (most digits, then lexical). */
function bestPhone(obs) {
  const ps = obs.map((o) => o.customerPhone).filter(Boolean);
  if (!ps.length) return null;
  return ps.sort((a, b) => digitsOf(b).length - digitsOf(a).length || (a < b ? -1 : a > b ? 1 : 0))[0];
}
/** The most complete value (longest, then lexical) — deterministic, order-free. */
function bestOf(vals) {
  const v = vals.filter(Boolean).map(String);
  if (!v.length) return null;
  return v.sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0))[0];
}
function pickDate(list, field) {
  const v = pick(list, field);
  return v ? new Date(v) : null;
}

/** Latest non-null value of each financial field across all observations. */
function foldFinancials(obs) {
  const out = { freightTerm: null, freightAmount: null, loan: null, interest: null, otherFee: null, invoiceAmount: null };
  for (const o of obs) {
    const f = o.financials;
    if (!f) continue;
    for (const k of Object.keys(out)) if (f[k] != null && f[k] !== "") out[k] = f[k];
  }
  return out;
}

const asDate = (v) => (v ? new Date(v) : null);
const upper  = (s) => (s == null ? "" : String(s).trim().toUpperCase());
const dstr   = (d) => (d ? new Date(d).toISOString().slice(0, 10) : "");

/**
 * Normalise a quantity unit for summing: lowercased and de-typo'd, so "PALLET",
 * "pallets" and the real-world typo "PALLTE" all bucket as `pallet`. A plain
 * number with no unit counts as `pieces`.
 */
function normUnit(u) {
  if (!u) return "pieces";
  const s = String(u).toLowerCase();
  if (s.startsWith("pall") || s.startsWith("plt") || s === "pallte") return "pallet";
  if (s.startsWith("cart")) return "carton";
  if (s.startsWith("box"))  return "box";
  if (s.startsWith("bag"))  return "bag";
  if (s.startsWith("ctn"))  return "carton";
  if (s.startsWith("pc") || s.startsWith("piece")) return "pieces";
  return s;
}

/**
 * Content identity of one physical listing at a stage. The same receipt (or
 * container leg) re-listed on an overlapping or re-saved sheet — a different
 * `fileHash`, so byte-level dedup misses it — collapses to ONE line here;
 * genuinely distinct receipts/legs stay separate. `includeContainer` keeps two
 * real containers apart at the loading stage while still merging a re-saved
 * copy of the same container's sheet. DB-free and clock-free, so the fold stays
 * order-independent and idempotent.
 */
function contentLineKey(o, includeContainer) {
  const parts = [dstr(o.eventDate), o.qty == null ? "" : o.qty, upper(o.qtyRaw), upper(o.productDescription)];
  if (includeContainer) parts.push(upper(o.container && o.container.containerNo));
  return parts.join("|");
}

/**
 * Collapse a stage's observations to content-deduped lines. Within a dedup
 * bucket the most-recent observation (byRecency) supplies the representative
 * values — the same "latest non-null wins" intuition, but per physical line
 * instead of across the whole stage, so distinct goods are no longer dropped.
 */
function dedupeLines(list, includeContainer) {
  const sorted = [...list].sort(byRecency); // oldest → newest
  const byKey = new Map();
  for (const o of sorted) byKey.set(contentLineKey(o, includeContainer), o); // newest wins
  return [...byKey.values()];
}

/**
 * Sum quantities across lines, unit-aware. Returns the numeric total plus, when
 * more than one unit is present, a per-unit breakdown so the UI never shows a
 * misleading bare number (e.g. "3 pallet + 4 pieces", not "7").
 */
function sumQty(lines) {
  const byUnit = {};
  let any = false;
  for (const l of lines) {
    if (l.qty == null) continue;
    any = true;
    const u = normUnit(l.qtyUnit);
    byUnit[u] = (byUnit[u] || 0) + l.qty;
  }
  if (!any) return { qty: null, qtyByUnit: null, mixedUnits: false };
  const units = Object.keys(byUnit);
  const total = units.reduce((s, u) => s + byUnit[u], 0);
  return { qty: total, qtyByUnit: units.length > 1 ? byUnit : null, mixedUnits: units.length > 1 };
}

/** Sum a numeric field across lines, ignoring nulls (returns null if none). */
function sumField(lines, field) {
  let total = null;
  for (const l of lines) if (l[field] != null && l[field] !== "") total = (total || 0) + Number(l[field]);
  return total;
}

// Stable ordering for the surfaced line/leg arrays (date, then row, then file).
function lineSort(a, b) {
  const ta = a.date ? +a.date : 0, tb = b.date ? +b.date : 0;
  if (ta !== tb) return ta - tb;
  if ((a.srcRow || 0) !== (b.srcRow || 0)) return (a.srcRow || 0) - (b.srcRow || 0);
  return (a.fileHash || "") < (b.fileHash || "") ? -1 : (a.fileHash || "") > (b.fileHash || "") ? 1 : 0;
}
function legSort(a, b) {
  const ta = a.loadingDate ? +a.loadingDate : 0, tb = b.loadingDate ? +b.loadingDate : 0;
  if (ta !== tb) return ta - tb;
  if ((a.containerNo || "") !== (b.containerNo || "")) return (a.containerNo || "") < (b.containerNo || "") ? -1 : 1;
  return lineSort(a, b);
}

/** Fold one customer's observations on one waybill into a Parcel. */
function foldParcel(group) {
  const obs = [...group].sort(byRecency);

  const byStage = { intake: [], loading: [], arrival: [] };
  for (const o of obs) if (byStage[o.stage]) byStage[o.stage].push(o);

  // Identity: chosen deterministically (most complete value), never by upload
  // order — so the same customer resolves to the same key regardless of which
  // sheet was uploaded first.
  const customerPhone = bestPhone(obs);
  const shippingMark  = bestOf(obs.map((o) => o.shippingMark));
  const customerName  = bestOf(obs.map((o) => o.customerName));
  const customerKey =
    customerPhone ? `p:${customerPhone}` :
    shippingMark  ? `m:${shippingMark}`  :
    normalizeName(customerName) ? `n:${normalizeName(customerName)}` :
    (obs[0].customerKey || `r:__row${obs[0].srcRow}_${obs[0].tokenIndex}`);

  const hasIntake  = byStage.intake.length  > 0;
  const hasLoading = byStage.loading.length > 0;
  const hasArrival = byStage.arrival.length > 0;

  // ── Content-deduped physical lines per stage ────────────────────────────
  // One tracking number for one customer legitimately carries several goods:
  // received on different days (multiple intake lines) and loaded into
  // different containers (multiple loading legs). Fold each into a line/leg
  // rather than letting the latest sheet's value overwrite the rest.
  const intakeLineObs = dedupeLines(byStage.intake, false);
  const loadingLegObs = dedupeLines(byStage.loading, true);

  // Containers whose arrival sheet has been uploaded. If an arrival row carries
  // no container number at all, the waybill is simply marked arrived, so every
  // leg counts as arrived.
  const arrivedContainers = new Set(
    byStage.arrival.map((o) => o.container && o.container.containerNo).filter(Boolean).map(upper)
  );
  const arrivalWithoutContainer = hasArrival && arrivedContainers.size === 0;

  const intakeLines = intakeLineObs.map((o) => ({
    date:      asDate(o.eventDate),
    qty:       o.qty ?? null,
    qtyRaw:    o.qtyRaw ?? null,
    qtyUnit:   o.qtyUnit ?? null,
    warehouse: o.warehouse ?? null,
    srcRow:    o.srcRow,
    fileHash:  o.fileHash,
  })).sort(lineSort);

  const loadingLegs = loadingLegObs.map((o) => {
    const c = o.container || {};
    const cno = c.containerNo || null;
    return {
      containerNo: cno,
      batchRef:    c.batchRef ?? null,
      loadingDate: c.loadingDate ? new Date(c.loadingDate) : asDate(o.eventDate),
      etd:         c.etd ?? null,
      eta:         c.eta ?? null,
      cbm:         o.cbm ?? null,
      qty:         o.qty ?? null,
      qtyRaw:      o.qtyRaw ?? null,
      qtyUnit:     o.qtyUnit ?? null,
      srcRow:      o.srcRow,
      fileHash:    o.fileHash,
      arrived:     cno ? (arrivedContainers.has(upper(cno)) || arrivalWithoutContainer) : arrivalWithoutContainer,
    };
  }).sort(legSort);

  const intakeAgg  = sumQty(intakeLines);
  const loadingAgg = sumQty(loadingLegs);

  // The most-recent leg supplies the scalar back-compat fields (card chip, etc.).
  const primaryLeg = loadingLegs.length ? loadingLegs[loadingLegs.length - 1] : null;

  const intake = hasIntake ? {
    date:      intakeLines.reduce((min, l) => (l.date && (!min || l.date < min) ? l.date : min), null), // earliest receipt
    warehouse: pick(byStage.intake, "warehouse"),
    qty:       intakeAgg.qty,
    qtyRaw:    pick(byStage.intake, "qtyRaw"),
    kg:        sumField(intakeLineObs, "kg"),
    lines:     intakeLines,
    srcRow:    intakeLines.length ? intakeLines[intakeLines.length - 1].srcRow : null,
    fileHash:  intakeLines.length ? intakeLines[intakeLines.length - 1].fileHash : null,
  } : null;

  const loading = hasLoading ? {
    containerNo: primaryLeg ? primaryLeg.containerNo : null,
    batchRef:    primaryLeg ? primaryLeg.batchRef : null,
    loadingDate: primaryLeg ? primaryLeg.loadingDate : pickDate(byStage.loading, "eventDate"),
    etd:         primaryLeg ? primaryLeg.etd : null,
    eta:         primaryLeg ? primaryLeg.eta : null,
    cbm:         pick(byStage.loading, "cbm"),
    location:    pick(byStage.loading, "location"),
    qty:         loadingAgg.qty,
    legs:        loadingLegs,
    srcRow:      primaryLeg ? primaryLeg.srcRow : null,
    fileHash:    primaryLeg ? primaryLeg.fileHash : null,
  } : null;

  const arrivalObs = hasArrival ? byStage.arrival[byStage.arrival.length - 1] : null;
  const arrival = hasArrival ? {
    date:        pickDate(byStage.arrival, "eventDate"),
    containerNo: arrivalObs.container ? arrivalObs.container.containerNo : null,
    srcRow:      arrivalObs.srcRow,
    fileHash:    arrivalObs.fileHash,
  } : null;

  // ── Conservative status (least-advanced leg wins) ───────────────────────
  // A parcel is only "arrival" once EVERY container leg has arrived; while some
  // legs are still on the water it stays "loading" and flags partiallyArrived,
  // so the customer is never told the whole shipment landed before it has.
  const someLegArrived = loadingLegs.some((l) => l.arrived);
  const allLegsArrived = loadingLegs.length > 0 && loadingLegs.every((l) => l.arrived);
  let currentStage = "intake";
  if (hasLoading) currentStage = "loading";
  if (hasArrival && (loadingLegs.length === 0 || allLegsArrived)) currentStage = "arrival";
  const partiallyArrived = loadingLegs.length > 0 && someLegArrived && !allLegsArrived;

  const chosenAgg = intakeAgg.qty != null ? intakeAgg : loadingAgg;

  const containerNos = [...new Set([
    ...loadingLegs.map((l) => l.containerNo),
    ...byStage.arrival.map((o) => o.container && o.container.containerNo),
  ].filter(Boolean))];

  return {
    waybill: obs[0].waybill,
    customerKey,
    customerPhone: customerPhone || null,
    shippingMark:  shippingMark || null,
    customerName:  customerName || null,

    currentStage,
    status: STAGE_STATUS[currentStage],

    // Received-at-warehouse date from ANY stage — a loading row carries it too,
    // so this is known even when the intake sheet was never uploaded.
    receivedDate: pickDate(obs, "receivedDate"),

    intake,
    loading,
    arrival,

    qty:       chosenAgg.qty ?? null,
    qtyByUnit: chosenAgg.qtyByUnit,
    containerNos,
    productDescription: pick(obs, "productDescription"),
    financials: foldFinancials(obs),

    flags: {
      needsPhone:          !customerPhone,
      receivedNotLoaded:   hasIntake && !hasLoading && !hasArrival,   // still in warehouse
      loadedNeverReceived: (hasLoading || hasArrival) && !hasIntake,  // intake sheet missing / packed unscanned
      // Loading MORE than was ever received is a genuine data error; loading
      // less is just an in-progress shipment (goods still to be packed), so
      // only the former is flagged — otherwise every mid-shipment parcel trips.
      qtyMismatch:         intakeAgg.qty != null && loadingAgg.qty != null && loadingAgg.qty > intakeAgg.qty,
      multiIntake:         intakeLines.length > 1,                    // goods received over several days
      multiContainer:      new Set(loadingLegs.map((l) => l.containerNo).filter(Boolean)).size > 1,
      mixedUnits:          intakeAgg.mixedUnits || loadingAgg.mixedUnits,
      partiallyArrived,                                               // some containers landed, some still shipping
    },

    observationRefs: obs.map((o) => ({ fileHash: o.fileHash, srcRow: o.srcRow, tokenIndex: o.tokenIndex, stage: o.stage })),
  };
}

/**
 * Derive every Parcel from a set of observations.
 *
 * @param {object[]} observations  active observations (reverted files excluded)
 * @returns {object[]} parcels
 */
function deriveParcels(observations) {
  const aliasMap = buildAliasMap(observations);

  // Group by waybill. Observations with no waybill can't be cross-stage linked;
  // each becomes its own parcel flagged needsWaybill.
  const byWaybill = new Map();
  const orphans = [];
  for (const o of observations) {
    if (!o.waybill) { orphans.push(o); continue; }
    if (!byWaybill.has(o.waybill)) byWaybill.set(o.waybill, []);
    byWaybill.get(o.waybill).push(o);
  }

  const parcels = [];
  for (const group of byWaybill.values()) {
    for (const customerGroup of partitionByCustomer(group, aliasMap)) {
      parcels.push(foldParcel(customerGroup));
    }
  }
  for (const o of orphans) {
    const p = foldParcel([o]);
    p.flags.needsWaybill = true;
    parcels.push(p);
  }

  return parcels;
}

module.exports = {
  deriveParcels,
  partitionByCustomer,
  buildAliasMap,
  foldParcel,
  canonicalKey,
  normalizeName,
  dedupeLines,
  sumQty,
  normUnit,
  STAGE_RANK,
  STAGE_STATUS,
  STATUS_ORDER,
  statusRank,
};

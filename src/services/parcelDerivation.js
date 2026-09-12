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
const STAGE_STATUS = { intake: "in_warehouse", loading: "shipped", arrival: "arrived" };

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

  let currentStage = "intake";
  for (const o of obs) if (STAGE_RANK[o.stage] > STAGE_RANK[currentStage]) currentStage = o.stage;

  const intakeQty  = pick(byStage.intake, "qty");
  const loadingQty = pick(byStage.loading, "qty");

  const intake = hasIntake ? {
    date:      pickDate(byStage.intake, "eventDate"),
    warehouse: pick(byStage.intake, "warehouse"),
    qty:       intakeQty,
    qtyRaw:    pick(byStage.intake, "qtyRaw"),
    kg:        pick(byStage.intake, "kg"),
    srcRow:    byStage.intake[byStage.intake.length - 1].srcRow,
    fileHash:  byStage.intake[byStage.intake.length - 1].fileHash,
  } : null;

  const loadingObs = hasLoading ? byStage.loading[byStage.loading.length - 1] : null;
  const loading = hasLoading ? {
    containerNo: loadingObs.container ? loadingObs.container.containerNo : null,
    batchRef:    loadingObs.container ? loadingObs.container.batchRef : null,
    loadingDate: loadingObs.container ? (loadingObs.container.loadingDate ? new Date(loadingObs.container.loadingDate) : null) : pickDate(byStage.loading, "eventDate"),
    etd:         loadingObs.container ? loadingObs.container.etd : null,
    eta:         loadingObs.container ? loadingObs.container.eta : null,
    cbm:         pick(byStage.loading, "cbm"),
    location:    pick(byStage.loading, "location"),
    qty:         loadingQty,
    srcRow:      loadingObs.srcRow,
    fileHash:    loadingObs.fileHash,
  } : null;

  const arrivalObs = hasArrival ? byStage.arrival[byStage.arrival.length - 1] : null;
  const arrival = hasArrival ? {
    date:        pickDate(byStage.arrival, "eventDate"),
    containerNo: arrivalObs.container ? arrivalObs.container.containerNo : null,
    srcRow:      arrivalObs.srcRow,
    fileHash:    arrivalObs.fileHash,
  } : null;

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

    qty: intakeQty ?? loadingQty ?? null,
    productDescription: pick(obs, "productDescription"),
    financials: foldFinancials(obs),

    flags: {
      needsPhone:          !customerPhone,
      receivedNotLoaded:   hasIntake && !hasLoading && !hasArrival,   // still in warehouse
      loadedNeverReceived: (hasLoading || hasArrival) && !hasIntake,  // intake sheet missing / packed unscanned
      qtyMismatch:         intakeQty != null && loadingQty != null && intakeQty !== loadingQty,
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
  STAGE_RANK,
  STAGE_STATUS,
};

/**
 * Generates:
 *   docs/excel-templates/intake-template.xlsx
 *   docs/excel-templates/loading-template.xlsx
 *   docs/excel-templates/arrived-template.xlsx
 *   tests/fixtures/loading_for_20th_April.xlsx  (sanitised legacy file)
 *
 * Run once:  node scripts/generate-test-fixtures.js
 */

const XLSX = require("xlsx");
const path = require("path");
const fs   = require("fs");

const TEMPLATES_DIR = path.join(__dirname, "..", "docs", "excel-templates");
const FIXTURES_DIR  = path.join(__dirname, "..", "tests", "fixtures");

[TEMPLATES_DIR, FIXTURES_DIR].forEach((d) => fs.mkdirSync(d, { recursive: true }));

function write(filePath, aoa) {
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, "Sheet1");
  XLSX.writeFile(wb, filePath);
  console.log("wrote", path.relative(process.cwd(), filePath));
}

// ─── Intake template ──────────────────────────────────────────────────────────
write(path.join(TEMPLATES_DIR, "intake-template.xlsx"), [
  // Metadata block
  ["STAGE",      "INTAKE"],
  ["BATCH DATE", new Date("2025-04-01")],
  ["WAREHOUSE",  "GUANGZHOU WH1"],
  [null, null],
  [null, null],
  [null, null],
  [null, null],
  [null, null],
  [null, null],
  [null, null],
  // Header row (row 11 / index 10)
  ["INVOICE NO.", "TRACKING N0.", "PHONE NUMBER", "QUANTITY", "DATE"],
  // Sample data rows
  ["INV-001", "301977756976", "0244100001", "2pallet", new Date("2025-04-01")],
  ["INV-001", "301977756977", "0244100002", "1pallet", new Date("2025-04-01")],
  ["INV-002", "301977756978 301977756979", "0244100003", "3pallet", new Date("2025-04-01")],
]);

// ─── Loading / Shipped template ───────────────────────────────────────────────
write(path.join(TEMPLATES_DIR, "loading-template.xlsx"), [
  // Metadata block
  ["STAGE",               "LOADING"],
  ["CONTAINER NUMBER",    "MSBU8308501"],
  ["BL NUMBER",           "MEDUGZ123456"],
  ["SEAL NUMBER",         "SL9900123"],
  ["VOLUME",              "40 HQ"],
  ["LOADING DATE",        new Date("2025-04-20")],
  ["ETD",                 "25/Apr/2025"],
  ["ETA",                 "10/May/2025"],
  ["BATCH REF",           "2025-004"],
  [null, null],
  // Header row (row 11 / index 10)
  [
    "TRACKING N0.", "CNEE NAME", "PHONE NUMBER", "LOCATION",
    "GOODS TYPE", "QUANTITY", "PRODUCT DESCRIPTION", "CBM PER TRACKING",
    "COLLECT O/F AMOUNT", "PAYMENT TERM $", "LOAN", "INTEREST",
    "OTHER FEE", "INVOICE AMOUNT", "OTHER",
  ],
  // Sample data rows
  ["301977756976", "Kwame Asante",  "0244100001", "ACCRA",  "Electronics", "2pallet", "Phone accessories",  0.12, "COLLECT", 68.00, 0, 0, 0, 68.00, "FORK FEE 50"],
  ["301977756977", "Ama Owusu",     "0244100002", "KUMASI", "Clothing",    "1pallet", "Fabric rolls",       0.08, "COLLECT", 45.00, 0, 0, 0, 45.00, null],
  ["301977756978", "Kofi Mensah",   "0244100003", "TEMA",   "Hardware",    "3pallet", "Bolts and brackets", 0.25, "COLLECT", 90.00, 0, 0, 5, 95.00, null],
  ["301977756979", "Abena Darko",   "0244100004", "ACCRA",  "Cosmetics",   "1pallet", "Skincare products",  0.05, "COLLECT", 30.00, 0, 0, 0, 30.00, null],
]);

// ─── Arrived template ─────────────────────────────────────────────────────────
write(path.join(TEMPLATES_DIR, "arrived-template.xlsx"), [
  // Metadata block
  ["STAGE",            "ARRIVED"],
  ["CONTAINER NUMBER", "MSBU8308501"],
  ["ARRIVAL DATE",     new Date("2025-05-12")],
  ["BL NUMBER",        "MEDUGZ123456"],
  ["PORT",             "Tema Port, Ghana"],
  [null, null],
  [null, null],
  [null, null],
  [null, null],
  [null, null],
  // Header row (row 11 / index 10)
  ["TRACKING N0.", "CNEE NAME", "PHONE NUMBER", "LOCATION", "REMARKS"],
  // Sample data rows
  ["301977756976", "Kwame Asante",  "0244100001", "ACCRA",  null],
  ["301977756977", "Ama Owusu",     "0244100002", "KUMASI", null],
  ["301977756978", "Kofi Mensah",   "0244100003", "TEMA",   null],
  ["301977756979", "Abena Darko",   "0244100004", "ACCRA",  null],
]);

// ─── Legacy fixture: loading_for_20th_April.xlsx ──────────────────────────────
//
// Sanitised version of a real loading list.  Key properties that make it
// a "legacy" file:
//   - No STAGE field (triggers the fallback detection path)
//   - Uses old column names: "JOB NUMBER" instead of "TRACKING N0."
//                            "CBM PER TRACKING" instead of "CBM"
//                            "CNEE NAME" for customer
//                            "PHONE NUMBER" for contact
//   - Metadata uses "CTR NUMBER" (old key)
//   - Header sits at row 9 (index 8), data from row 10 (index 9)
//   - Mixed numeric/string CBM values
write(path.join(FIXTURES_DIR, "loading_for_20th_April.xlsx"), [
  // Metadata block (rows 1-8 / indices 0-7) — NO STAGE field
  ["CTR NUMBER",          "MSBU8308501"],
  ["VOLUME",              "40 HQ"],
  ["SEAL NUMBER",         "SL0099821"],
  ["BL NUMBER",           "MEDUGZ654321"],
  ["PACKING LIST NUMBER", "2025-APR-20"],
  ["LOADING DATE",        new Date("2025-04-20")],
  ["ETD",                 "28/Apr/2025"],
  ["ETA",                 "12/May/2025"],
  // Header row (row 9 / index 8) — uses legacy "JOB NUMBER" and "CBM PER TRACKING"
  [
    "JOB NUMBER", "CNEE NAME", "PHONE NUMBER", "LOCATION",
    "GOODS TYPE", "  QUANTITY", "DESCRIPTION", "CBM PER TRACKING",
    "COLLECT O/F AMOUNT", "PAYMENT TERM $", "LOAN", "INTEREST",
    "OTHER FEE", "INVOICE AMOUNT", "REMARKS",
  ],
  // Data rows (from row 10 / index 9)
  ["301977756976", "Kwame Asante",   "0244100001", "ACCRA",    "Electronics", "2pallet", "Phones",          0.12, "COLLECT", 68.00, 0, 0, 0, 68.00, null],
  ["301977756977", "Ama Owusu",      "0244100002", "KUMASI",   "Clothing",    "1pallet", "Fabric",          0.08, "COLLECT", 45.00, 0, 0, 0, 45.00, null],
  ["301977756978", "Kofi Mensah",    "0244100003", "TEMA",     "Hardware",    "3pallet", "Bolts",           0.25, "COLLECT", 90.00, 0, 0, 5, 95.00, "FORK FEE 100"],
  ["301977756979", "Abena Darko",    "0244100004", "ACCRA",    "Cosmetics",   "1pallet", "Skincare",        0.05, "COLLECT", 30.00, 0, 0, 0, 30.00, null],
  ["301977756980", "Yaw Boateng",    "0244100005", "TAKORADI", "Food",        "4pallet", "Canned goods",    0.32, "COLLECT", 110.00, 0, 0, 0, 110.00, null],
  // Summary / totals row — should be skipped (CNEE NAME is numeric)
  [null, "5", null, null, null, "11pallet", null, 0.82, null, 341.00, 0, 0, 5, 346.00, null],
]);

console.log("\nAll fixtures generated successfully.");

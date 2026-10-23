/**
 * Read-only connectivity + inventory check.
 *
 * Reads the connection string from db.txt (or MONGODB_URI) and reports which
 * collections exist and how many documents each holds. Prints NO credential and
 * NO customer data — only collection names, counts, and index names. Safe to run
 * against the live database: it opens no write, only listCollections / count.
 *
 *   node scripts/check-db.js
 */
const fs = require("fs");
const path = require("path");
const dns = require("dns");
const { MongoClient } = require("mongodb");

// mongodb+srv:// resolves the host via a DNS SRV/TXT lookup. On networks whose
// resolver blocks or drops those (seen here as "queryTxt ETIMEOUT"), point the
// lookup at public resolvers. Default to Google/Cloudflare; override with
// DNS_SERVERS. Same workaround the other scripts use.
const dnsServers = (process.env.DNS_SERVERS || "8.8.8.8,1.1.1.1")
  .split(",").map((s) => s.trim()).filter(Boolean);
if (dnsServers.length) dns.setServers(dnsServers);

function readUri() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI.trim();
  const p = path.join(__dirname, "..", "db.txt");
  const raw = fs.readFileSync(p, "utf8").trim();
  // Take the first line that looks like a mongodb connection string.
  const line = raw.split(/\r?\n/).map((s) => s.trim()).find((s) => s.startsWith("mongodb"));
  if (!line) throw new Error("No mongodb:// or mongodb+srv:// string found in db.txt");
  return line;
}

// Turn a mongodb+srv:// URI into a plain mongodb:// seed list when SRV/TXT DNS
// lookups are being dropped by the network (as here). The shard hosts come from
// MONGODB_DIRECT_HOSTS (comma-separated host[:port]); credentials and options
// are preserved from the original URI. Nothing is printed.
function toDirectUri(srvUri, hosts) {
  const m = srvUri.match(/^mongodb\+srv:\/\/([^@]*@)?([^/?]+)(\/[^?]*)?(\?.*)?$/);
  if (!m) throw new Error("Could not parse the connection string");
  const auth = m[1] || "";
  const pathPart = m[3] || "/";
  const existing = (m[4] || "").replace(/^\?/, "");
  const seeds = hosts
    .map((h) => (h.includes(":") ? h : `${h}:27017`))
    .join(",");
  const params = new URLSearchParams(existing);
  params.set("tls", "true");
  if (!params.has("authSource")) params.set("authSource", "admin");
  return `mongodb://${auth}${seeds}${pathPart}?${params.toString()}`;
}

// Pull the db name out of the path portion, if the URI specifies one.
function dbNameFromUri(uri) {
  try {
    const afterHost = uri.split("://")[1].split("/").slice(1).join("/");
    const name = (afterHost.split("?")[0] || "").trim();
    return name || null;
  } catch {
    return null;
  }
}

async function main() {
  let uri = readUri();

  // If the caller supplied explicit shard hosts, rewrite an srv URI to a direct
  // seed list so we never depend on the (here broken) SRV/TXT DNS lookup.
  const directHosts = (process.env.MONGODB_DIRECT_HOSTS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (directHosts.length && uri.startsWith("mongodb+srv://")) {
    uri = toDirectUri(uri, directHosts);
    console.log(`(using direct seed list of ${directHosts.length} hosts; srv lookup bypassed)\n`);
  }

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 15000 });

  const started = Date.now();
  await client.connect();
  await client.db("admin").command({ ping: 1 });
  console.log(`CONNECTED ok in ${Date.now() - started} ms\n`);

  // Which database holds the data? Prefer the one named in the URI, else
  // inc_logistics (the app default), else scan.
  const preferred = dbNameFromUri(uri) || process.env.DB_NAME || "inc_logistics";

  const admin = client.db().admin();
  let dbs = [];
  try {
    dbs = (await admin.listDatabases()).databases.map((d) => d.name);
  } catch {
    dbs = [preferred];
  }
  const skip = new Set(["admin", "local", "config"]);
  const candidates = [preferred, ...dbs.filter((n) => !skip.has(n))];
  const seen = new Set();

  for (const name of candidates) {
    if (seen.has(name)) continue;
    seen.add(name);
    const db = client.db(name);
    let cols;
    try {
      cols = await db.listCollections({ type: "collection" }).toArray();
    } catch (e) {
      console.log(`db ${name}: cannot list (${e.message})`);
      continue;
    }
    if (!cols.length) continue;

    console.log(`=== database: ${name} ===`);
    const rows = [];
    for (const c of cols.filter((c) => !c.name.startsWith("system."))) {
      const col = db.collection(c.name);
      let count = "?";
      try { count = await col.countDocuments(); } catch (e) { count = `err: ${e.message}`; }
      let idx = [];
      try { idx = (await col.indexes()).map((i) => i.name); } catch {}
      rows.push({ name: c.name, count, indexes: idx.length });
    }
    rows.sort((a, b) => a.name.localeCompare(b.name));
    for (const r of rows) {
      console.log(`  ${String(r.name).padEnd(22)} ${String(r.count).padStart(8)} docs   ${r.indexes} indexes`);
    }
    console.log("");
  }

  await client.close();
}

main().catch((err) => {
  // Print only the error type/message, never the URI.
  console.error("CHECK FAILED:", err.name + ":", err.message);
  process.exit(1);
});

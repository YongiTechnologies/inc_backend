/**
 * Read-only full backup of the live database to local files.
 *
 * Writes one gzipped Extended-JSON file per collection (canonical EJSON, so
 * ObjectIds / Dates / etc. round-trip exactly), plus an _indexes.json with every
 * collection's index definitions and a _manifest.json with counts. Restorable
 * later with scripts/restore-db.js (or mongoimport/driver).
 *
 * Opens no writes against the source — only find() and listIndexes().
 *
 *   OUT_DIR=... MONGODB_DIRECT_HOSTS=h1,h2,h3 node scripts/dump-db.js
 *
 * Reads the connection string from db.txt (or MONGODB_URI). Prints NO credential.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const dns = require("dns");
const { MongoClient } = require("mongodb");
const { EJSON } = require("bson");

const dnsServers = (process.env.DNS_SERVERS || "8.8.8.8,1.1.1.1")
  .split(",").map((s) => s.trim()).filter(Boolean);
if (dnsServers.length) dns.setServers(dnsServers);

function readUri() {
  if (process.env.MONGODB_URI) return process.env.MONGODB_URI.trim();
  const raw = fs.readFileSync(path.join(__dirname, "..", "db.txt"), "utf8").trim();
  const line = raw.split(/\r?\n/).map((s) => s.trim()).find((s) => s.startsWith("mongodb"));
  if (!line) throw new Error("No connection string in db.txt");
  return line;
}

function toDirectUri(srvUri, hosts) {
  const m = srvUri.match(/^mongodb\+srv:\/\/([^@]*@)?([^/?]+)(\/[^?]*)?(\?.*)?$/);
  if (!m) throw new Error("Could not parse the connection string");
  const auth = m[1] || "";
  const pathPart = m[3] || "/";
  const params = new URLSearchParams((m[4] || "").replace(/^\?/, ""));
  params.set("tls", "true");
  if (!params.has("authSource")) params.set("authSource", "admin");
  const seeds = hosts.map((h) => (h.includes(":") ? h : `${h}:27017`)).join(",");
  return `mongodb://${auth}${seeds}${pathPart}?${params.toString()}`;
}

function dbNameFromUri(uri) {
  try {
    const name = (uri.split("://")[1].split("/").slice(1).join("/").split("?")[0] || "").trim();
    return name || null;
  } catch { return null; }
}

async function main() {
  let uri = readUri();
  const directHosts = (process.env.MONGODB_DIRECT_HOSTS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (directHosts.length && uri.startsWith("mongodb+srv://")) uri = toDirectUri(uri, directHosts);

  const dbName = process.env.DB_NAME || dbNameFromUri(uri) || "inc_logistics";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19) + "Z";
  const outDir = process.env.OUT_DIR
    || path.join("C:/Users/IntelAfriq/Desktop/STAR/_db-backups", `${dbName}-${stamp}`);
  fs.mkdirSync(outDir, { recursive: true });

  const client = new MongoClient(uri, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  console.log(`CONNECTED. Dumping "${dbName}" -> ${outDir}\n`);

  const db = client.db(dbName);
  const cols = (await db.listCollections({ type: "collection" }).toArray())
    .map((c) => c.name).filter((n) => !n.startsWith("system.")).sort();

  const indexes = {};
  const manifest = { database: dbName, takenAt: new Date().toISOString(), collections: {} };

  for (const name of cols) {
    const col = db.collection(name);
    indexes[name] = await col.indexes();

    const total = await col.countDocuments();
    const gz = zlib.createGzip();
    const out = fs.createWriteStream(path.join(outDir, `${name}.ejson.gz`));
    gz.pipe(out);

    let n = 0;
    const cursor = col.find({}, { noCursorTimeout: false });
    for await (const doc of cursor) {
      gz.write(EJSON.stringify(doc, { relaxed: false }) + "\n");
      if (++n % 5000 === 0) process.stdout.write(`  ${name}: ${n}/${total}\r`);
    }
    await new Promise((res, rej) => { gz.end(); out.on("finish", res); out.on("error", rej); });

    manifest.collections[name] = { documents: n, indexes: indexes[name].length };
    console.log(`  ${name.padEnd(22)} ${String(n).padStart(8)} docs  (${indexes[name].length} indexes)`);
  }

  fs.writeFileSync(path.join(outDir, "_indexes.json"), JSON.stringify(indexes, null, 2));
  fs.writeFileSync(path.join(outDir, "_manifest.json"), JSON.stringify(manifest, null, 2));

  await client.close();
  console.log(`\nDONE. ${cols.length} collections written to:\n${outDir}`);
}

main().catch((err) => {
  console.error("DUMP FAILED:", err.name + ":", err.message);
  process.exit(1);
});

/**
 * Restore a backup produced by scripts/dump-db.js into a TARGET MongoDB.
 *
 * Reads the gzipped canonical-EJSON files (+ _indexes.json / _manifest.json)
 * from a backup folder, inserts every document with its original _id and types,
 * and recreates each collection's indexes. Use it to stand the data up on a new
 * server (Hetzner) or a local MongoDB for a restore drill.
 *
 * The TARGET is given by TARGET_MONGODB_URI and is REQUIRED — the script never
 * reads db.txt, so it can't accidentally write back onto the live Atlas.
 *
 * Safety: refuses to touch a target collection that already has documents,
 * unless DROP=1 (drop & recreate each restored collection first). No credential
 * is ever printed.
 *
 *   TARGET_MONGODB_URI="mongodb://localhost:27017" \
 *   BACKUP_DIR="C:/.../_db-backups/inc_logistics-2026-10-18T17-26-05Z" \
 *   [DB_NAME=inc_logistics] [DROP=1] [DRY_RUN=1] \
 *   [MONGODB_DIRECT_HOSTS=h1,h2,h3] [DNS_SERVERS=8.8.8.8,1.1.1.1] \
 *   node scripts/restore-db.js
 *
 * If BACKUP_DIR is omitted, the newest folder under _db-backups is used.
 */
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");
const readline = require("readline");
const dns = require("dns");
const { MongoClient } = require("mongodb");
const { EJSON } = require("bson");

const DRY_RUN = /^(1|true|yes)$/i.test(process.env.DRY_RUN || "");
const DROP = /^(1|true|yes)$/i.test(process.env.DROP || "");
const BATCH = 1000;

const dnsServers = (process.env.DNS_SERVERS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
if (dnsServers.length) dns.setServers(dnsServers);

const DEFAULT_BACKUP_ROOT = "C:/Users/IntelAfriq/Desktop/STAR/_db-backups";

function resolveBackupDir() {
  if (process.env.BACKUP_DIR) return process.env.BACKUP_DIR;
  const root = DEFAULT_BACKUP_ROOT;
  const dirs = fs.readdirSync(root)
    .map((n) => path.join(root, n))
    .filter((p) => fs.statSync(p).isFile() === false && fs.existsSync(path.join(p, "_manifest.json")));
  if (!dirs.length) throw new Error(`No backup folders found under ${root}; set BACKUP_DIR`);
  dirs.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return dirs[0];
}

function toDirectUri(srvUri, hosts) {
  const m = srvUri.match(/^mongodb\+srv:\/\/([^@]*@)?([^/?]+)(\/[^?]*)?(\?.*)?$/);
  if (!m) throw new Error("Could not parse TARGET_MONGODB_URI");
  const auth = m[1] || "";
  const pathPart = m[3] || "/";
  const params = new URLSearchParams((m[4] || "").replace(/^\?/, ""));
  params.set("tls", "true");
  if (!params.has("authSource")) params.set("authSource", "admin");
  const seeds = hosts.map((h) => (h.includes(":") ? h : `${h}:27017`)).join(",");
  return `mongodb://${auth}${seeds}${pathPart}?${params.toString()}`;
}

// Rebuild createIndex args from a stored index definition.
function indexArgs(def) {
  const { v, key, ns, background, ...options } = def; // drop server-managed fields
  if (def.name) options.name = def.name;
  return { key, options };
}

async function* readLines(file) {
  const rl = readline.createInterface({
    input: fs.createReadStream(file).pipe(zlib.createGunzip()),
    crlfDelay: Infinity,
  });
  for await (const line of rl) {
    const t = line.trim();
    if (t) yield t;
  }
}

async function main() {
  let target = (process.env.TARGET_MONGODB_URI || "").trim();
  if (!target) throw new Error("TARGET_MONGODB_URI is required (the destination, not the live Atlas)");

  const directHosts = (process.env.MONGODB_DIRECT_HOSTS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (directHosts.length && target.startsWith("mongodb+srv://")) target = toDirectUri(target, directHosts);

  const backupDir = resolveBackupDir();
  const manifest = JSON.parse(fs.readFileSync(path.join(backupDir, "_manifest.json"), "utf8"));
  const indexes = JSON.parse(fs.readFileSync(path.join(backupDir, "_indexes.json"), "utf8"));
  const dbName = process.env.DB_NAME || manifest.database || "inc_logistics";

  console.log(`Restore source : ${backupDir}`);
  console.log(`   taken at    : ${manifest.takenAt}`);
  console.log(`Target database : ${dbName}`);
  console.log(`Mode            : ${DRY_RUN ? "DRY RUN (no writes)" : DROP ? "DROP & restore" : "restore into empty collections"}\n`);

  const client = new MongoClient(target, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  await client.db("admin").command({ ping: 1 });
  const db = client.db(dbName);

  const names = Object.keys(manifest.collections).sort();

  // Pre-flight: unless DROP, refuse any target collection that already has data.
  if (!DROP) {
    const clashes = [];
    for (const name of names) {
      const exists = await db.listCollections({ name }).hasNext();
      if (exists && (await db.collection(name).estimatedDocumentCount()) > 0) clashes.push(name);
    }
    if (clashes.length) {
      throw new Error(
        `Target already has data in: ${clashes.join(", ")}.\n` +
        `Refusing to merge. Re-run with DROP=1 to replace these collections, or restore into a fresh database (DB_NAME).`
      );
    }
  }

  let totalDocs = 0, totalIdx = 0, mismatches = [];

  for (const name of names) {
    const file = path.join(backupDir, `${name}.ejson.gz`);
    const expected = manifest.collections[name].documents;
    if (!fs.existsSync(file)) { console.log(`  ${name.padEnd(22)} SKIP (file missing)`); continue; }

    if (DROP && !DRY_RUN) {
      const exists = await db.listCollections({ name }).hasNext();
      if (exists) await db.collection(name).drop().catch(() => {});
    }
    const col = db.collection(name);

    // Insert documents.
    let inserted = 0, batch = [];
    const flush = async () => {
      if (!batch.length) return;
      if (!DRY_RUN) await col.insertMany(batch, { ordered: false });
      inserted += batch.length;
      batch = [];
    };
    for await (const line of readLines(file)) {
      batch.push(EJSON.parse(line, { relaxed: false }));
      if (batch.length === BATCH) { await flush(); process.stdout.write(`  ${name}: ${inserted}\r`); }
    }
    await flush();

    // Recreate indexes (skip the automatic _id_).
    let idxMade = 0;
    for (const def of (indexes[name] || [])) {
      if (def.name === "_id_") continue;
      const { key, options } = indexArgs(def);
      if (!DRY_RUN) {
        try { await col.createIndex(key, options); idxMade++; }
        catch (e) { console.log(`\n    ! index ${def.name} on ${name}: ${e.message}`); }
      } else { idxMade++; }
    }

    const actual = DRY_RUN ? inserted : await col.countDocuments();
    const ok = actual === expected;
    if (!ok) mismatches.push(`${name} (${actual}/${expected})`);
    totalDocs += inserted; totalIdx += idxMade;
    console.log(`  ${name.padEnd(22)} ${String(inserted).padStart(8)} docs  ${String(idxMade).padStart(2)} idx  ${ok ? "OK" : "*** COUNT MISMATCH " + actual + "/" + expected}`);
  }

  await client.close();
  console.log(`\n${DRY_RUN ? "[dry run] would restore" : "Restored"} ${totalDocs} documents and ${totalIdx} indexes across ${names.length} collections.`);
  if (mismatches.length) { console.log("MISMATCHES: " + mismatches.join(", ")); process.exitCode = 1; }
  else console.log("All collection counts match the manifest.");
}

main().catch((err) => {
  console.error("RESTORE FAILED:", err.name + ":", err.message);
  process.exit(1);
});

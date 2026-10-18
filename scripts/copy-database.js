/**
 * Copy every collection (documents + indexes) from one MongoDB to another.
 * Used to move the live data off Railway's MongoDB onto MongoDB Atlas.
 *
 *   SOURCE_MONGODB_URI="mongodb://..."  \
 *   TARGET_MONGODB_URI="mongodb+srv://..." \
 *   DB_NAME=inc_logistics node scripts/copy-database.js
 *
 * Read-only on the source. Refuses to write into a target collection that
 * already has documents, so running it twice can't duplicate data.
 *
 * If the mongodb+srv:// lookup fails with "querySrv ECONNREFUSED", add
 * DNS_SERVERS=8.8.8.8,1.1.1.1 (same workaround as the other scripts).
 */
const dns = require("dns");
const { MongoClient } = require("mongodb");

if (process.env.DNS_SERVERS) {
  dns.setServers(process.env.DNS_SERVERS.split(",").map((s) => s.trim()).filter(Boolean));
}

const BATCH = 1000;

async function main() {
  const { SOURCE_MONGODB_URI, TARGET_MONGODB_URI } = process.env;
  const dbName = process.env.DB_NAME || "inc_logistics";
  if (!SOURCE_MONGODB_URI || !TARGET_MONGODB_URI) {
    throw new Error("Set SOURCE_MONGODB_URI and TARGET_MONGODB_URI");
  }

  const source = await MongoClient.connect(SOURCE_MONGODB_URI);
  const target = await MongoClient.connect(TARGET_MONGODB_URI);
  try {
    const from = source.db(dbName);
    const to   = target.db(dbName);

    const collections = (await from.listCollections({ type: "collection" }).toArray())
      .map((c) => c.name)
      .filter((name) => !name.startsWith("system."));

    for (const name of collections) {
      if (await to.collection(name).estimatedDocumentCount() > 0) {
        throw new Error(`Target ${dbName}.${name} already has documents; not copying over it.`);
      }
    }

    for (const name of collections) {
      const src = from.collection(name);
      const dst = to.collection(name);

      let copied = 0;
      let batch  = [];
      for await (const doc of src.find()) {
        batch.push(doc);
        if (batch.length === BATCH) {
          await dst.insertMany(batch, { ordered: false });
          copied += batch.length;
          batch = [];
        }
      }
      if (batch.length) {
        await dst.insertMany(batch, { ordered: false });
        copied += batch.length;
      }

      const indexes = (await src.indexes()).filter((ix) => ix.name !== "_id_");
      for (const { key, v, ns, ...options } of indexes) {
        await dst.createIndex(key, options);
      }

      const expected = await src.countDocuments();
      const actual   = await dst.countDocuments();
      const ok = expected === actual ? "ok" : "MISMATCH";
      console.log(`${name.padEnd(24)} ${String(copied).padStart(7)} docs, ${indexes.length} indexes  [${ok}]`);
      if (expected !== actual) process.exitCode = 1;
    }
  } finally {
    await source.close();
    await target.close();
  }
}

main().catch((err) => {
  console.error("Copy failed:", err.message);
  process.exit(1);
});

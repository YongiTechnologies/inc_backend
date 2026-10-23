/**
 * Disable or delete named accounts on the NEW server and end their sessions.
 * Used at cutover for logins that should not carry over (HETZNER_DEPLOY
 * Part 8). Never run it against the old Atlas database.
 *
 * The restore brings ALL users across (so customers and the kept admins keep
 * their passwords); this prunes the handful that should not exist on the new
 * system.
 *
 * Target is TARGET_MONGODB_URI and is REQUIRED — the script never reads db.txt,
 * so it can't touch the old Atlas database. The accounts to remove come from
 * REMOVE_EMAILS (comma-separated, required). KEEP_EMAILS (comma-separated)
 * lists accounts that must never be touched, even if listed for removal by
 * mistake.
 *
 * Safe by default: prints what it WOULD do and changes nothing. Set APPLY=1 to
 * act. Default mode disables (isActive:false, reversible); DELETE=1 removes the
 * documents. Either way, the accounts' refresh tokens are revoked so any live
 * session ends.
 *
 *   TARGET_MONGODB_URI="mongodb://..." REMOVE_EMAILS="a@x.com,b@y.com" node scripts/prune-users.js              # dry run
 *   TARGET_MONGODB_URI="mongodb://..." REMOVE_EMAILS="..." APPLY=1 node scripts/prune-users.js                  # disable + revoke
 *   TARGET_MONGODB_URI="mongodb://..." REMOVE_EMAILS="..." APPLY=1 DELETE=1 node scripts/prune-users.js         # delete + revoke
 */
const dns = require("dns");
const { MongoClient } = require("mongodb");

const APPLY = /^(1|true|yes)$/i.test(process.env.APPLY || "");
const DELETE = /^(1|true|yes)$/i.test(process.env.DELETE || "");

const dnsServers = (process.env.DNS_SERVERS || "")
  .split(",").map((s) => s.trim()).filter(Boolean);
if (dnsServers.length) dns.setServers(dnsServers);

const lc = (s) => String(s).trim().toLowerCase();
const emails = (v) => (v || "").split(",").map(lc).filter(Boolean);
const REMOVE = emails(process.env.REMOVE_EMAILS);
const KEEP = emails(process.env.KEEP_EMAILS);

function dbNameFromUri(uri) {
  try { return (uri.split("://")[1].split("/").slice(1).join("/").split("?")[0] || "").trim() || null; }
  catch { return null; }
}

async function main() {
  const target = (process.env.TARGET_MONGODB_URI || "").trim();
  if (!target) throw new Error("TARGET_MONGODB_URI is required (the new server, not the live Atlas)");
  if (!REMOVE.length) throw new Error("REMOVE_EMAILS is required (comma-separated emails of the accounts to remove)");

  const overlap = REMOVE.filter((e) => KEEP.includes(e));
  if (overlap.length) throw new Error(`These emails are in both KEEP and REMOVE: ${overlap.join(", ")}`);

  const dbName = process.env.DB_NAME || dbNameFromUri(target) || "inc_logistics";
  const client = new MongoClient(target, { serverSelectionTimeoutMS: 20000 });
  await client.connect();
  const db = client.db(dbName);
  const users = db.collection("users");
  const tokens = db.collection("refreshtokens");

  const matched = await users.find({ email: { $in: REMOVE } }).project({ email: 1, name: 1, role: 1 }).toArray();
  const found = matched.map((u) => lc(u.email));
  const missing = REMOVE.filter((e) => !found.includes(e));

  console.log(`Target db      : ${dbName}`);
  console.log(`Mode           : ${APPLY ? (DELETE ? "DELETE + revoke sessions" : "DISABLE + revoke sessions") : "DRY RUN (no changes)"}`);
  console.log(`Keep (guarded) : ${KEEP.join(", ") || "(none)"}\n`);

  if (!matched.length) { console.log("No matching accounts found — nothing to do."); await client.close(); return; }

  for (const u of matched) console.log(`  will ${DELETE ? "DELETE " : "disable"}  ${u.role || "?"}  ${u.email}  (${u.name || ""})`);
  if (missing.length) console.log(`  (not present, skipped: ${missing.join(", ")})`);

  const ids = matched.map((u) => u._id);

  if (!APPLY) {
    const sessions = await tokens.countDocuments({ userId: { $in: ids } });
    console.log(`\n[dry run] would also revoke ${sessions} refresh token(s). Re-run with APPLY=1 to act.`);
    await client.close();
    return;
  }

  let changed;
  if (DELETE) changed = (await users.deleteMany({ _id: { $in: ids } })).deletedCount;
  else changed = (await users.updateMany({ _id: { $in: ids } }, { $set: { isActive: false } })).modifiedCount;
  const revoked = (await tokens.deleteMany({ userId: { $in: ids } })).deletedCount;

  console.log(`\nDone: ${DELETE ? "deleted" : "disabled"} ${changed} account(s); revoked ${revoked} session(s).`);
  await client.close();
}

main().catch((err) => { console.error("PRUNE FAILED:", err.name + ":", err.message); process.exit(1); });

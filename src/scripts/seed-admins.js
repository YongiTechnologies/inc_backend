/**
 * Seed / update admin users.
 *
 * Idempotent: an existing user (matched by email) is promoted to a verified,
 * active admin and their password reset to the one given; a new user is created.
 * Passwords are NOT stored in this file — pass them on the command line, so no
 * secret ever lands in version control.
 *
 * Usage:
 *   node src/scripts/seed-admins.js "email:password[:Full Name]" ["email:password" ...]
 *
 * Example:
 *   node src/scripts/seed-admins.js "ada@x.com:S0me-Pass:Ada Lovelace"
 *
 * Connection: uses MONGODB_URI (and optional DB_NAME, default "inc_logistics").
 * Set MONGODB_URI to the database you want to seed — e.g. the Railway Mongo
 * service's PUBLIC connection string when running from your machine.
 */

require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });
const mongoose = require("mongoose");
const { connectDB } = require("../config/db");
const User = require("../models/User");

function parseAdmin(arg) {
  const parts = String(arg).split(":");
  const email = (parts[0] || "").trim().toLowerCase();
  const password = (parts[1] || "").trim();
  const name = (parts[2] || "").trim() ||
    // Derive a name from the email local-part when none is given.
    (email.split("@")[0] || "admin").replace(/[._-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  return { email, password, name };
}

async function run() {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error('Usage: node src/scripts/seed-admins.js "email:password[:Full Name]" ...');
    process.exit(1);
  }

  const admins = args.map(parseAdmin);
  const bad = admins.filter((a) => !a.email || !a.password);
  if (bad.length) {
    console.error("Each argument must be email:password (password required).");
    process.exit(1);
  }

  await connectDB();

  const results = [];
  for (const { email, password, name } of admins) {
    let user = await User.findOne({ email }).select("+password");
    if (user) {
      user.name = user.name || name;
      user.role = "admin";
      user.isVerified = true;
      user.isActive = true;
      user.provider = "local";
      user.password = password; // re-hashed by the pre-save hook
      await user.save();
      results.push({ email, name: user.name, status: "updated → admin" });
    } else {
      await User.create({ name, email, password, role: "admin", isVerified: true, isActive: true, provider: "local" });
      results.push({ email, name, status: "created" });
    }
  }

  console.log("\n✅ Admin seed complete:\n");
  for (const r of results) console.log(`   ${r.status.padEnd(18)} ${r.email}  (${r.name})`);
  console.log("\n⚠️  These are initial credentials — ask each admin to change their password after first login.\n");

  await mongoose.disconnect();
  process.exit(0);
}

run().catch((err) => {
  console.error("Seed failed:", err.message);
  process.exit(1);
});

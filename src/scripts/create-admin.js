require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });
const mongoose = require("mongoose");
const { connectDB } = require("../config/db");
const User = require("../models/User");

async function createAdmin() {
  await connectDB();

  const email = "bediako@inclogistics.com";
  const existing = await User.findOne({ email });

  if (existing) {
    console.log(`User already exists: ${email} (role: ${existing.role})`);
    if (existing.role !== "admin") {
      existing.role = "admin";
      existing.isVerified = true;
      existing.isActive = true;
      await existing.save();
      console.log("Updated existing user to admin role.");
    }
  } else {
    await User.create({
      name: "Bediako",
      email,
      password: "Bediako2026!",
      role: "admin",
      isVerified: true,
      isActive: true,
      provider: "local",
    });
    console.log(`\n✅ Admin user created:`);
    console.log(`   Email:    ${email}`);
    console.log(`   Password: Bediako2026!`);
    console.log(`   Role:     admin`);
    console.log(`\n⚠️  Ask Bediako to change this password after first login.\n`);
  }

  await mongoose.disconnect();
  process.exit(0);
}

createAdmin().catch((err) => {
  console.error("Failed:", err);
  process.exit(1);
});

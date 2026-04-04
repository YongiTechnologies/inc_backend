require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });
const mongoose = require("mongoose");
const { connectDB } = require("../config/db");
const User = require("../models/User");
const Shipment = require("../models/Shipment");
const TrackingEvent = require("../models/TrackingEvent");
const RefreshToken = require("../models/RefreshToken");

async function seed() {
  await connectDB();
  console.log("🌱 Seeding database...");

  // Wipe existing data
  await Promise.all([
    User.deleteMany({}),
    Shipment.deleteMany({}),
    TrackingEvent.deleteMany({}),
    RefreshToken.deleteMany({}),
  ]);

  // ─── Users ────────────────────────────────────────────────────────────────
  const [admin, employee, system, customer] = await User.create([
    { name: "Admin User",    email: "admin@ghanalogistics.com",    password: "Admin1234!", role: "admin",    isVerified: true },
    { name: "Kofi Mensah",   email: "kofi@ghanalogistics.com",     password: "Employee1!", role: "employee", isVerified: true },
    { name: "System",        email: "system@ghanalogistics.com",   password: "System123!", role: "employee", isVerified: true },
    { name: "Ama Owusu",     email: "ama@example.com",             password: "Customer1!", role: "customer", isVerified: true },
  ]);
  console.log("✅ Users created");

  // ─── Shipment 1: In Transit ───────────────────────────────────────────────
  const s1 = await Shipment.create({
    customerId:    customer._id,
    assignedTo:    employee._id,
    origin:        { address: "Unit 5, Yiwu International Trade Market", city: "Yiwu",   country: "China" },
    destination:   { address: "Kantamanto Market, Ring Road Central",     city: "Accra",  country: "Ghana" },
    status:        "customs",
    description:   "Mixed Clothing & Accessories",
    packageType:   "container",
    weight:        420,
    quantity:      8,
    requiresCustoms: true,
    estimatedDelivery: new Date(Date.now() + 2 * 24 * 60 * 60 * 1000),
  });

  const events1 = [
    { status: "pending",    location: { address: "Unit 5, Yiwu Trade Market", city: "Yiwu",     country: "China" },   note: "Shipment registered. Awaiting pickup.",                         daysAgo: 12 },
    { status: "picked_up",  location: { address: "Unit 5, Yiwu Trade Market", city: "Yiwu",     country: "China" },   note: "Goods collected from supplier.",                                carrier: "China Post Logistics", daysAgo: 10 },
    { status: "in_transit", location: { address: "Guangzhou Baiyun Airport",  city: "Guangzhou", country: "China" },   note: "Cargo loaded and departed.",                                   carrier: "Ethiopian Airlines Cargo", carrierReference: "ET-CARGO-88821", daysAgo: 8 },
    { status: "in_transit", location: { address: "Bole International Airport",city: "Addis Ababa",country: "Ethiopia"},note: "Transiting through Addis Ababa hub.",                           carrier: "Ethiopian Airlines Cargo", carrierReference: "ET-CARGO-88821", daysAgo: 5 },
    { status: "in_transit", location: { address: "Kotoka Intl Airport, Cargo Terminal", city: "Accra", country: "Ghana" }, note: "Arrived in Ghana. Transferred to customs handling.",      carrier: "Ethiopian Airlines Cargo", carrierReference: "ET-CARGO-88821", daysAgo: 2 },
    { status: "customs",    location: { address: "Tema Port Inspection Bay",  city: "Tema",     country: "Ghana" },   note: "Package under customs inspection. HS code verification ongoing.", carrier: "Ghana Revenue Authority", hoursAgo: 3 },
  ];

  for (const e of events1) {
    const ts = e.hoursAgo
      ? new Date(Date.now() - e.hoursAgo * 60 * 60 * 1000)
      : new Date(Date.now() - e.daysAgo * 24 * 60 * 60 * 1000);
    await TrackingEvent.create({ shipmentId: s1._id, updatedBy: employee._id, timestamp: ts, ...e });
  }

  // ─── Shipment 2: Delivered ────────────────────────────────────────────────
  const s2 = await Shipment.create({
    customerId:  customer._id,
    assignedTo:  employee._id,
    origin:      { address: "Guangzhou Wholesale Market", city: "Guangzhou", country: "China" },
    destination: { address: "Kejetia Market",             city: "Kumasi",    country: "Ghana" },
    status:      "delivered",
    description: "Electronics & Phone Accessories",
    packageType: "parcel",
    weight:      85,
    quantity:    3,
    isFragile:   true,
    deliveredAt: new Date(Date.now() - 5 * 60 * 60 * 1000),
    estimatedDelivery: new Date(Date.now() - 6 * 60 * 60 * 1000),
  });

  const events2 = [
    { status: "pending",          location: { address: "Guangzhou Wholesale Market", city: "Guangzhou", country: "China" }, note: "Shipment registered.",               daysAgo: 9 },
    { status: "picked_up",        location: { address: "Guangzhou Wholesale Market", city: "Guangzhou", country: "China" }, note: "Collected from supplier.",            carrier: "China Post", daysAgo: 8 },
    { status: "in_transit",       location: { address: "Kotoka Intl Airport",        city: "Accra",     country: "Ghana" }, note: "Arrived in Ghana.",                   carrier: "Kenya Airways Cargo", daysAgo: 4 },
    { status: "customs",          location: { address: "Tema Port",                  city: "Tema",      country: "Ghana" }, note: "Customs cleared.",                    daysAgo: 3 },
    { status: "in_transit",       location: { address: "Accra Main Hub",             city: "Accra",     country: "Ghana" }, note: "Dispatched to Kumasi.",               carrier: "Ghana Logistics Co.", daysAgo: 1 },
    { status: "out_for_delivery", location: { address: "Kumasi Hub",                 city: "Kumasi",    country: "Ghana" }, note: "With delivery rider.",                carrier: "Ghana Logistics Co.", hoursAgo: 7 },
    { status: "delivered",        location: { address: "Kejetia Market",             city: "Kumasi",    country: "Ghana" }, note: "Package delivered. Received by Maame Ama.", hoursAgo: 5 },
  ];

  for (const e of events2) {
    const ts = e.hoursAgo
      ? new Date(Date.now() - e.hoursAgo * 60 * 60 * 1000)
      : new Date(Date.now() - e.daysAgo * 24 * 60 * 60 * 1000);
    await TrackingEvent.create({ shipmentId: s2._id, updatedBy: employee._id, timestamp: ts, ...e });
  }

  console.log("✅ Shipments + tracking events created");
  console.log("\n🔑 Login credentials:");
  console.log("   Admin:    admin@ghanalogistics.com   / Admin1234!");
  console.log("   Employee: kofi@ghanalogistics.com    / Employee1!");
  console.log("   Customer: ama@example.com            / Customer1!");
  console.log(`\n📦 Tracking numbers:`);
  console.log(`   ${s1.trackingNumber} (Customs)`);
  console.log(`   ${s2.trackingNumber} (Delivered)`);

  await mongoose.disconnect();
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});

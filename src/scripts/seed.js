require("dotenv").config({ path: require("path").resolve(__dirname, "../../.env") });
const mongoose = require("mongoose");
const { connectDB } = require("../config/db");
const User = require("../models/User");
const ShipmentItem = require("../models/ShipmentItem");
const RefreshToken = require("../models/RefreshToken");

async function seed() {
  await connectDB();
  console.log("🌱 Seeding database...");

  // Wipe existing data
  await Promise.all([
    User.deleteMany({}),
    ShipmentItem.deleteMany({}),
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

  // ─── Item 1: In Transit (Customs) ─────────────────────────────────────────
  const stageHistory1 = [];
  const now = Date.now();

  // Build stage history for item 1
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
      ? new Date(now - e.hoursAgo * 60 * 60 * 1000)
      : new Date(now - e.daysAgo * 24 * 60 * 60 * 1000);
    stageHistory1.push({
      stage: e.status,
      status: e.status,
      updatedAt: ts,
      location: e.location,
      note: e.note,
      carrier: e.carrier,
      carrierReference: e.carrierReference,
      updatedBy: employee._id,
    });
  }

  const item1 = await ShipmentItem.create({
    waybillNo:         "GLC-CUSTOMS-001",
    customerId:        customer._id,
    customerPhone:     "233244123456",
    customerName:      "Ama Owusu",
    origin:            { address: "Unit 5, Yiwu International Trade Market", city: "Yiwu",   country: "China" },
    destination:       { address: "Kantamanto Market, Ring Road Central",     city: "Accra",  country: "Ghana" },
    destinationCity:   "ACCRA",
    status:            "customs",
    productDescription:"Mixed Clothing & Accessories",
    packageType:       "container",
    weight:            420,
    quantity:          8,
    requiresCustoms:   true,
    estimatedDelivery: new Date(now + 2 * 24 * 60 * 60 * 1000),
    migratedFrom:      "manual",
    stageHistory,
  });

  // ─── Item 2: Delivered ────────────────────────────────────────────────────
  const stageHistory2 = [];
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
      ? new Date(now - e.hoursAgo * 60 * 60 * 1000)
      : new Date(now - e.daysAgo * 24 * 60 * 60 * 1000);
    stageHistory2.push({
      stage: e.status,
      status: e.status,
      updatedAt: ts,
      location: e.location,
      note: e.note,
      carrier: e.carrier,
      updatedBy: employee._id,
    });
  }

  const item2 = await ShipmentItem.create({
    waybillNo:         "GLC-DELIVERED-001",
    customerId:        customer._id,
    customerPhone:     "233244123456",
    customerName:      "Ama Owusu",
    origin:            { address: "Guangzhou Wholesale Market", city: "Guangzhou", country: "China" },
    destination:       { address: "Kejetia Market",             city: "Kumasi",    country: "Ghana" },
    destinationCity:   "KUMASI",
    status:            "delivered",
    productDescription:"Electronics & Phone Accessories",
    packageType:       "parcel",
    weight:            85,
    quantity:          3,
    isFragile:         true,
    deliveredAt:       new Date(now - 5 * 60 * 60 * 1000),
    estimatedDelivery: new Date(now - 6 * 60 * 60 * 1000),
    migratedFrom:      "manual",
    stageHistory:      stageHistory2,
  });

  // ─── Item 3: In Warehouse (batch workflow) ─────────────────────────────────
  await ShipmentItem.create({
    waybillNo:         "INTAKE-001",
    invoiceNo:         "INV-001",
    customerPhone:     "233244123456",
    customerName:      "Ama Owusu",
    destinationCity:   "ACCRA",
    status:            "in_warehouse",
    productDescription:"Cartons of goods",
    quantity:          5,
    intakeDate:        new Date(now - 1 * 24 * 60 * 60 * 1000),
    migratedFrom:      "excel",
    stageHistory: [{
      stage:     "intake",
      status:    "in_warehouse",
      updatedAt: new Date(now - 1 * 24 * 60 * 60 * 1000),
      note:      "Created via intake upload",
    }],
  });

  // ─── Item 4: Shipped (batch workflow) ─────────────────────────────────────
  await ShipmentItem.create({
    waybillNo:         "SHIPPED-001",
    customerPhone:     "233244123456",
    customerName:      "Ama Owusu",
    destinationCity:   "KUMASI",
    status:            "shipped",
    productDescription:"Electronics",
    quantity:          10,
    receivingDate:     new Date(now - 3 * 24 * 60 * 60 * 1000),
    migratedFrom:      "excel",
    stageHistory: [{
      stage:     "shipped",
      status:    "shipped",
      updatedAt: new Date(now - 2 * 24 * 60 * 60 * 1000),
      note:      "Loaded on container",
    }],
  });

  console.log("✅ ShipmentItems created");
  console.log("\n🔑 Login credentials:");
  console.log("   Admin:    admin@ghanalogistics.com   / Admin1234!");
  console.log("   Employee: kofi@ghanalogistics.com    / Employee1!");
  console.log("   Customer: ama@example.com            / Customer1!");
  console.log(`\n📦 Tracking numbers:`);
  console.log(`   ${item1.waybillNo} (Customs)`);
  console.log(`   ${item2.waybillNo} (Delivered)`);
  console.log(`   INTAKE-001 (In Warehouse)`);
  console.log(`   SHIPPED-001 (Shipped)`);

  await mongoose.disconnect();
  process.exit(0);
}

seed().catch((err) => {
  console.error("Seed failed:", err);
  process.exit(1);
});

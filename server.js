require("dotenv").config();
const app = require("./src/app");
const { connectDB } = require("./src/config/db");

const PORT = process.env.PORT || 5000;

async function start() {
  try {
    await connectDB();
    app.listen(PORT, () => {
      console.log(`🚀 I&C Logistics API running on port ${PORT}`);
      console.log(`   Env:     ${process.env.NODE_ENV || "development"}`);
      console.log(`   Health:  http://localhost:${PORT}/health`);
      console.log(`   Tracker: GET /api/tracking/:trackingNumber`);
    });
  } catch (err) {
    console.error("❌ Startup failed:", err.message);
    process.exit(1);
  }
}

start();

const mongoose = require("mongoose");

// The connection is opened once and shared. Concurrent callers all wait on the
// same promise instead of opening one pool each.
let connecting = null;

async function connectDB() {
  if (mongoose.connection.readyState === 1) return;
  if (connecting) return connecting;

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set in environment variables");

  connecting = mongoose
    .connect(uri, {
      dbName: process.env.DB_NAME || "inc_logistics",
      // Fail fast rather than hang when the database is unreachable.
      serverSelectionTimeoutMS: 5000,
    })
    .then(() => {
      console.log(`✅ MongoDB connected: ${mongoose.connection.host}`);
    })
    .catch((err) => {
      connecting = null; // let the next request retry
      throw err;
    });

  return connecting;
}

module.exports = { connectDB };

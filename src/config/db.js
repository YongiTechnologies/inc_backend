const mongoose = require("mongoose");

// A serverless function instance handles many requests in a row while it is
// warm, so the connection is opened once and shared. Concurrent cold-start
// requests all wait on the same promise instead of opening one pool each.
let connecting = null;

async function connectDB() {
  if (mongoose.connection.readyState === 1) return;
  if (connecting) return connecting;

  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set in environment variables");

  connecting = mongoose
    .connect(uri, {
      dbName: process.env.DB_NAME || "inc_logistics",
      // Fail fast: a function has seconds, not minutes, to answer.
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

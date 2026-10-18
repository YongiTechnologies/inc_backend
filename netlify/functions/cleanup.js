// Nightly housekeeping, replacing the node-cron job server.js starts.
// Netlify runs this on the schedule in netlify.toml (02:00 UTC daily).
const { connectDB } = require("../../src/config/db");
const { runCleanup } = require("../../src/services/cleanup.service");

exports.handler = async (_event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;
  await connectDB();
  const results = await runCleanup();
  return { statusCode: 200, body: JSON.stringify(results) };
};

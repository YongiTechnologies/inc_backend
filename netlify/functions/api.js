// The whole Express API as one Netlify Function. netlify.toml rewrites
// /api/* and /health here, so Express still sees the original paths.
const serverless = require("serverless-http");
const app = require("../../src/app");
const { connectDB } = require("../../src/config/db");

const handler = serverless(app, {
  // If someone calls the function by its raw URL, strip the prefix so the
  // routes still match.
  basePath: "/.netlify/functions/api",
});

// Netlify puts the caller's real address in x-nf-client-connection-ip.
// serverless-http takes the socket address from requestContext, and Express
// (trust proxy 1) reads the last X-Forwarded-For hop, so set both to it.
// Without this req.ip is undefined and every per-IP rate limiter errors out.
function withClientIp(event) {
  const headers = event.headers || {};
  const ip = headers["x-nf-client-connection-ip"]
    || (headers["x-forwarded-for"] || "").split(",")[0].trim()
    || "0.0.0.0";
  return {
    ...event,
    headers: { ...headers, "x-forwarded-for": ip },
    requestContext: {
      ...event.requestContext,
      identity: { ...(event.requestContext && event.requestContext.identity), sourceIp: ip },
    },
  };
}

exports.handler = async (event, context) => {
  // Return as soon as the response is ready; don't wait for the open
  // Mongo connection (which is kept for the next request) to close.
  context.callbackWaitsForEmptyEventLoop = false;
  await connectDB();
  return handler(withClientIp(event), context);
};

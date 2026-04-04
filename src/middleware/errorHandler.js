const { respond } = require("../utils/response");

function errorHandler(err, req, res, next) {
  console.error(`[${new Date().toISOString()}] ${req.method} ${req.path}`, err);

  // Mongoose duplicate key
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern)[0];
    return respond(res, 409, false, `${field} already exists`);
  }

  // Mongoose validation
  if (err.name === "ValidationError") {
    const messages = Object.values(err.errors).map((e) => e.message);
    return respond(res, 400, false, messages.join(", "));
  }

  // Mongoose cast (bad ObjectId)
  if (err.name === "CastError") {
    return respond(res, 400, false, `Invalid ${err.path}: ${err.value}`);
  }

  return respond(res, err.statusCode || 500, false, err.message || "Something went wrong");
}

module.exports = { errorHandler };

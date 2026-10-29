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

  // Upload rejected by multer (too large, too many files, wrong field): the
  // client's mistake, not a server failure.
  if (err.name === "MulterError") {
    if (err.code === "LIMIT_FILE_SIZE") return respond(res, 413, false, "File too large. The limit is 10 MB.");
    return respond(res, 400, false, err.message);
  }

  return respond(res, err.statusCode || 500, false, err.message || "Something went wrong");
}

module.exports = { errorHandler };

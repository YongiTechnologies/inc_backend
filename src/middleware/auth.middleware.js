const User = require("../models/User");
const { verifyAccess } = require("../utils/jwt");
const { respond } = require("../utils/response");

async function authenticate(req, res, next) {
  try {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
      return respond(res, 401, false, "No token provided");
    }

    const decoded = verifyAccess(header.split(" ")[1]);
    const user = await User.findById(decoded.id);

    if (!user || !user.isActive) {
      return respond(res, 401, false, "User not found or inactive");
    }

    req.user = user;
    next();
  } catch (err) {
    const msg = err.name === "TokenExpiredError" ? "Token expired" : "Invalid token";
    return respond(res, 401, false, msg);
  }
}

/**
 * Usage: authorize("admin") or authorize("admin", "employee")
 */
function authorize(...roles) {
  return (req, res, next) => {
    if (!req.user) return respond(res, 401, false, "Not authenticated");
    if (!roles.includes(req.user.role)) {
      return respond(res, 403, false, `Access denied. Requires: ${roles.join(" or ")}`);
    }
    next();
  };
}

module.exports = { authenticate, authorize };

const User = require("../models/User");
const RefreshToken = require("../models/RefreshToken");
const { signAccess, signRefresh, verifyRefresh } = require("../utils/jwt");
const { respond } = require("../utils/response");
const audit = require("../services/audit.service");

const COOKIE_OPTS = {
  httpOnly: true,
  secure:   process.env.NODE_ENV === "production",
  sameSite: "strict",
  maxAge:   7 * 24 * 60 * 60 * 1000, // 7 days
};

async function register(req, res, next) {
  try {
    const { name, email, phone, password } = req.body;

    if (await User.findOne({ email })) {
      return respond(res, 409, false, "Email already registered");
    }

    const user = await User.create({ name, email, phone, password });

    await audit.log({ performedBy: user._id, action: "REGISTER", ip: req.ip });

    return respond(res, 201, true, "Account created", {
      id: user._id, name: user.name, email: user.email, role: user.role,
    });
  } catch (err) { next(err); }
}

async function login(req, res, next) {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email }).select("+password");
    if (!user || !(await user.comparePassword(password))) {
      return respond(res, 401, false, "Invalid credentials");
    }
    if (!user.isActive) {
      return respond(res, 403, false, "Account disabled. Contact support.");
    }

    const accessToken  = signAccess(user._id);
    const refreshToken = signRefresh(user._id);

    // Store refresh token in database
    await RefreshToken.create({
      token: refreshToken,
      userId: user._id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    res.cookie("refreshToken", refreshToken, COOKIE_OPTS);

    await audit.log({ performedBy: user._id, action: "LOGIN", ip: req.ip });

    return respond(res, 200, true, "Login successful", {
      accessToken,
      user: { id: user._id, name: user.name, email: user.email, role: user.role },
    });
  } catch (err) { next(err); }
}

async function refresh(req, res, next) {
  try {
    const token = req.cookies?.refreshToken;
    if (!token) return respond(res, 401, false, "No refresh token");

    const decoded = verifyRefresh(token);
    const user    = await User.findById(decoded.id);
    if (!user || !user.isActive) return respond(res, 401, false, "Invalid session");

    // Check if refresh token exists and is not revoked
    const storedToken = await RefreshToken.findOne({
      token,
      userId: user._id,
      isRevoked: false,
      expiresAt: { $gt: new Date() }
    });
    if (!storedToken) return respond(res, 401, false, "Invalid or expired refresh token");

    return respond(res, 200, true, "Token refreshed", { accessToken: signAccess(user._id) });
  } catch {
    return respond(res, 401, false, "Invalid or expired refresh token");
  }
}

async function logout(req, res) {
  const token = req.cookies?.refreshToken;
  if (token) {
    // Revoke the refresh token
    await RefreshToken.findOneAndUpdate(
      { token },
      {
        isRevoked: true,
        revokedAt: new Date(),
        revokedBy: req.user?._id // May be undefined if token is invalid
      }
    );
  }
  res.clearCookie("refreshToken");
  return respond(res, 200, true, "Logged out");
}

async function me(req, res) {
  return respond(res, 200, true, "Profile retrieved", {
    id: req.user._id, name: req.user.name, email: req.user.email,
    phone: req.user.phone, role: req.user.role, createdAt: req.user.createdAt,
  });
}

module.exports = { register, login, refresh, logout, me };

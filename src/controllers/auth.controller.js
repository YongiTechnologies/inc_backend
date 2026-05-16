const crypto = require("crypto");
const User = require("../models/User");
const RefreshToken = require("../models/RefreshToken");
const emailService = require("../services/email.service");
const { signAccess, signRefresh, verifyRefresh } = require("../utils/jwt");
const { respond } = require("../utils/response");
const audit = require("../services/audit.service");
const { normalisePhone } = require("../services/batch.service");

const COOKIE_OPTS = {
  httpOnly: true,
  secure: true, // Always true for cross-origin HTTPS
  sameSite: "none", // Required for cross-origin cookies
  path: "/",
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
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

async function forgotPassword(req, res, next) {
  try {
    const { email } = req.body;
    const user = await User.findOne({ email }).select("+email +name");

    if (user) {
      const resetToken = crypto.randomBytes(32).toString("hex");
      const passwordResetToken = crypto.createHash("sha256").update(resetToken).digest("hex");
      const passwordResetExpires = new Date(Date.now() + 60 * 60 * 1000); // 1 hour

      user.passwordResetToken = passwordResetToken;
      user.passwordResetExpires = passwordResetExpires;
      await user.save({ validateBeforeSave: false });

      const frontendUrl = process.env.FRONTEND_URL || `${req.protocol}://${req.get("host")}`;
      const resetUrl = `${frontendUrl}/reset-password?token=${resetToken}&email=${encodeURIComponent(email)}`;
      await emailService.sendPasswordReset({
        to: user.email,
        name: user.name,
        resetUrl,
      });
    }

    return respond(res, 200, true, "If an account exists, a password reset email has been sent.");
  } catch (err) { next(err); }
}

async function resetPassword(req, res, next) {
  try {
    const { email, token, password } = req.body;
    const hashedToken = crypto.createHash("sha256").update(token).digest("hex");
    const user = await User.findOne({
      email,
      passwordResetToken: hashedToken,
      passwordResetExpires: { $gt: new Date() },
    }).select("+password +passwordResetToken");

    if (!user) {
      return respond(res, 400, false, "Invalid or expired password reset token.");
    }

    user.password = password;
    user.passwordResetToken = undefined;
    user.passwordResetExpires = undefined;
    await user.save();

    await emailService.sendPasswordChanged({
      to: user.email,
      name: user.name,
    });

    await audit.log({ performedBy: user._id, action: "PASSWORD_RESET", ip: req.ip });

    return respond(res, 200, true, "Password has been reset successfully.");
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

// ─── Phone-based auth ─────────────────────────────────────────────────────────

function phoneToPlaceholderEmail(normalised) {
  return `phone_${normalised}@no-email.incshipping.gh`;
}

async function findUserByPhoneNormalised(raw) {
  const normalised = normalisePhone(raw);
  if (!normalised) return { normalised: null, user: null };
  const last9 = normalised.slice(-9);
  const user = await User.findOne({ phone: { $regex: last9 + "$" } }).select("+password");
  return { normalised, user };
}

async function issueSession(user, req, res) {
  const accessToken  = signAccess(user._id);
  const refreshToken = signRefresh(user._id);
  await RefreshToken.create({
    token: refreshToken,
    userId: user._id,
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
    ipAddress: req.ip,
    userAgent: req.headers["user-agent"],
  });
  res.cookie("refreshToken", refreshToken, COOKIE_OPTS);
  return { accessToken, user: { id: user._id, name: user.name, email: user.email, phone: user.phone, role: user.role } };
}

// POST /api/auth/phone-check
// Returns whether the phone has an account and whether a password is set.
async function phoneCheck(req, res, next) {
  try {
    const { phone } = req.body;
    if (!phone) return respond(res, 400, false, "Phone number is required");
    const { normalised, user } = await findUserByPhoneNormalised(phone);
    if (!normalised) return respond(res, 400, false, "Invalid phone number");

    if (!user) {
      return respond(res, 200, true, "No account found", { exists: false, hasPassword: false });
    }
    return respond(res, 200, true, "Account found", {
      exists: true,
      hasPassword: !!user.password,
      name: user.name,
    });
  } catch (err) { next(err); }
}

// POST /api/auth/phone-login
// Login with phone + password.
async function phoneLogin(req, res, next) {
  try {
    const { phone, password } = req.body;
    if (!phone || !password) return respond(res, 400, false, "Phone and password are required");
    const { normalised, user } = await findUserByPhoneNormalised(phone);
    if (!normalised) return respond(res, 400, false, "Invalid phone number");
    if (!user || !user.password) return respond(res, 401, false, "Invalid credentials");
    if (!user.isActive) return respond(res, 403, false, "Account disabled. Contact support.");
    const match = await user.comparePassword(password);
    if (!match) return respond(res, 401, false, "Invalid credentials");

    const session = await issueSession(user, req, res);
    await audit.log({ performedBy: user._id, action: "LOGIN", ip: req.ip });
    return respond(res, 200, true, "Login successful", session);
  } catch (err) { next(err); }
}

// POST /api/auth/phone-set-password
// Called when a user exists but has no password (e.g. staff-created account or
// account created before password was required). Sets the password and logs in.
async function phoneSetPassword(req, res, next) {
  try {
    const { phone, name, password } = req.body;
    if (!phone || !password) return respond(res, 400, false, "Phone and password are required");
    if (password.length < 8) return respond(res, 400, false, "Password must be at least 8 characters");
    const { normalised, user } = await findUserByPhoneNormalised(phone);
    if (!normalised) return respond(res, 400, false, "Invalid phone number");
    if (!user) return respond(res, 404, false, "No account found for this number");
    if (user.password) return respond(res, 409, false, "Account already has a password. Please log in normally.");

    if (name && name.trim()) user.name = name.trim();
    user.password = password;
    await user.save();

    const session = await issueSession(user, req, res);
    await audit.log({ performedBy: user._id, action: "PASSWORD_RESET", ip: req.ip });
    return respond(res, 200, true, "Password set. Logged in.", session);
  } catch (err) { next(err); }
}

// POST /api/auth/phone-signup
// Creates a new customer account using phone number.
// Email is not required — a placeholder is stored internally.
async function phoneSignup(req, res, next) {
  try {
    const { phone, name, password } = req.body;
    if (!phone || !name || !password) return respond(res, 400, false, "Phone, name, and password are required");
    if (password.length < 8) return respond(res, 400, false, "Password must be at least 8 characters");

    const normalised = normalisePhone(phone);
    if (!normalised) return respond(res, 400, false, "Invalid phone number");

    const last9 = normalised.slice(-9);
    const existing = await User.findOne({ phone: { $regex: last9 + "$" } });
    if (existing) return respond(res, 409, false, "An account already exists for this number. Please log in.");

    const placeholderEmail = phoneToPlaceholderEmail(normalised);
    const user = await User.create({
      name: name.trim(),
      email: placeholderEmail,
      phone: normalised,
      password,
      role: "customer",
    });

    const session = await issueSession(user, req, res);
    await audit.log({ performedBy: user._id, action: "REGISTER", ip: req.ip });
    return respond(res, 201, true, "Account created", session);
  } catch (err) { next(err); }
}

module.exports = { register, login, forgotPassword, resetPassword, refresh, logout, me, phoneCheck, phoneLogin, phoneSetPassword, phoneSignup };

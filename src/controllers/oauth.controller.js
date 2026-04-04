const RefreshToken = require("../models/RefreshToken");
const { signAccess, signRefresh } = require("../utils/jwt");
const audit = require("../services/audit.service");

const COOKIE_OPTS = {
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "strict",
  maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
};

/**
 * Handle Google OAuth callback
 * This runs after passport.authenticate() has verified the Google token
 * and attached the user to req.user
 */
async function googleCallback(req, res, next) {
  try {
    const user = req.user;

    // Generate tokens exactly like the existing login controller
    const accessToken = signAccess(user._id);
    const refreshToken = signRefresh(user._id);

    // Store refresh token in database
    await RefreshToken.create({
      token: refreshToken,
      userId: user._id,
      expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000), // 7 days
      ipAddress: req.ip,
      userAgent: req.headers['user-agent'],
    });

    // Set the refresh token cookie
    res.cookie("refreshToken", refreshToken, COOKIE_OPTS);

    // Log to audit
    await audit.log({
      performedBy: user._id,
      action: "GOOGLE_LOGIN",
      ip: req.ip
    });

    // Redirect to frontend with access token as query param
    const frontendURL = process.env.FRONTEND_URL || "http://localhost:3000";
    res.redirect(`${frontendURL}/auth/callback?token=${accessToken}&role=${user.role}`);

  } catch (err) {
    next(err);
  }
}

module.exports = { googleCallback };
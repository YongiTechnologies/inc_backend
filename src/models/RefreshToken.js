const mongoose = require("mongoose");

/**
 * RefreshToken — stores active refresh tokens for session management.
 * Allows revoking individual sessions without affecting others.
 */
const refreshTokenSchema = new mongoose.Schema(
  {
    token: {
      type: String,
      required: true,
      unique: true,
      index: true,
    },
    userId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },
    expiresAt: {
      type: Date,
      required: true,
      index: true,
    },
    isRevoked: {
      type: Boolean,
      default: false,
      index: true,
    },
    revokedAt: Date,
    // Bumped every time this token is exchanged for a new access token. Staff
    // sessions use it as a sliding idle window: stop using the app for long
    // enough and the token stops being accepted, so the 30-minute timeout is
    // enforced by the server rather than trusted to the browser.
    lastUsedAt: {
      type: Date,
      default: Date.now,
    },
    revokedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
    },
    ipAddress: String,
    userAgent: String,
  },
  { timestamps: true }
);

// Auto-expire tokens
refreshTokenSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model("RefreshToken", refreshTokenSchema);
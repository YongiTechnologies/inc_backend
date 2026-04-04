const express = require("express");
const passport = require("../config/passport");
const ctrl = require("../controllers/oauth.controller");
const { respond } = require("../utils/response");

const router = express.Router();

// Middleware to check if Google OAuth is configured
const checkGoogleOAuth = (req, res, next) => {
  if (!process.env.GOOGLE_CLIENT_ID || !process.env.GOOGLE_CLIENT_SECRET) {
    return respond(res, 503, false, "Google OAuth is not configured on this server");
  }
  next();
};

/**
 * @swagger
 * /auth/google:
 *   get:
 *     tags:
 *       - Authentication
 *     summary: Initiate Google OAuth login
 *     description: Redirects to Google for OAuth authentication
 *     responses:
 *       302:
 *         description: Redirects to Google OAuth
 *       503:
 *         description: Google OAuth not configured
 */
router.get(
  "/google",
  checkGoogleOAuth,
  passport.authenticate("google", { scope: ["profile", "email"], session: false })
);

/**
 * @swagger
 * /auth/google/callback:
 *   get:
 *     tags:
 *       - Authentication
 *     summary: Google OAuth callback
 *     description: Handles the callback from Google OAuth and redirects to frontend
 *     parameters:
 *       - in: query
 *         name: code
 *         schema:
 *           type: string
 *         description: Authorization code from Google
 *       - in: query
 *         name: error
 *         schema:
 *           type: string
 *         description: Error from Google OAuth (if any)
 *     responses:
 *       302:
 *         description: Redirects to frontend with access token
 *       503:
 *         description: Google OAuth not configured
 */
router.get(
  "/google/callback",
  checkGoogleOAuth,
  passport.authenticate("google", {
    session: false,
    failureRedirect: `${process.env.FRONTEND_URL || "http://localhost:3000"}/auth/login?error=oauth_failed`
  }),
  ctrl.googleCallback
);

module.exports = router;
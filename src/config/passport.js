/**
 * Google OAuth 2.0 Setup Instructions:
 *
 * 1. Go to https://console.cloud.google.com/
 * 2. Create a project (or select existing)
 * 3. Go to "APIs & Services" → "OAuth consent screen"
 *    - Set User Type to "External"
 *    - Fill in app name, user support email, developer contact info
 * 4. Go to "APIs & Services" → "Credentials"
 *    - Click "Create Credentials" → "OAuth 2.0 Client ID"
 *    - Application type: "Web application"
 * 5. Add Authorized redirect URIs:
 *    - http://localhost:5000/api/auth/google/callback (development)
 *    - https://your-production-api-url/api/auth/google/callback (production)
 * 6. Copy Client ID and Client Secret to your .env file
 */

const passport = require("passport");
const GoogleStrategy = require("passport-google-oauth20").Strategy;
const User = require("../models/User");

// Only configure Google OAuth if credentials are provided
if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) {
  // Google OAuth Strategy Configuration
  passport.use(
    new GoogleStrategy(
      {
        clientID: process.env.GOOGLE_CLIENT_ID,
        clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        callbackURL: process.env.GOOGLE_CALLBACK_URL,
        scope: ["profile", "email"],
      },
      async (accessToken, refreshToken, profile, done) => {
        try {
          const { id: googleId, displayName: name, emails, photos } = profile;
          const email = emails[0].value;
          const avatar = photos[0]?.value;

          // Try to find existing user
          let user = await User.findOne({
            $or: [{ googleId }, { email }],
          });

          if (user) {
            // User exists - check if we need to link accounts
            if (user.email === email && !user.googleId) {
              // Existing local user - link Google account
              user.googleId = googleId;
              user.provider = "google";
              user.avatar = avatar;
              user.isVerified = true; // Google emails are pre-verified
              await user.save();
            }
            // If user already has googleId, just return them
          } else {
            // Create new Google user
            user = await User.create({
              name,
              email,
              googleId,
              avatar,
              provider: "google",
              role: "customer",
              isVerified: true, // Google emails are pre-verified
            });
          }

          return done(null, user);
        } catch (error) {
          return done(error);
        }
      }
    )
  );
} else {
  console.warn("⚠️  Google OAuth credentials not found. Google login will not be available.");
  console.warn("   Set GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in your .env file to enable Google OAuth.");
}

module.exports = passport;
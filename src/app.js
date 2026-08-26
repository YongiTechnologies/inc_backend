require("dotenv").config();
const express     = require("express");
const helmet      = require("helmet");
const cors        = require("cors");
const rateLimit   = require("express-rate-limit");
const cookieParser = require("cookie-parser");
const swaggerJsdoc = require("swagger-jsdoc");
const swaggerUi = require("swagger-ui-express");

const authRoutes     = require("./routes/auth.routes");
const trackingRoutes = require("./routes/tracking.routes");
const adminRoutes     = require("./routes/admin.routes");
const employeeRoutes  = require("./routes/employee.routes");
const gpsRoutes       = require("./routes/gps.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
const contactRoutes   = require("./routes/contact.routes");
const oauthRoutes     = require("./routes/oauth.routes");
const batchRoutes         = require("./routes/batch.routes");
const containerRoutes     = require("./routes/container.routes");
const settingsRoutes      = require("./routes/settings.routes");
const { errorHandler } = require("./middleware/errorHandler");
const { respond }    = require("./utils/response");
const swaggerSpec   = require("./config/swagger");

// Initialize Passport
const passport = require("passport");
require("./config/passport");

const app = express();

// Trust Render's reverse proxy so req.ip is the real client IP
app.set("trust proxy", 1);

// ─── Security ─────────────────────────────────────────────────────────────────
app.use(helmet());

// ─── CORS ─────────────────────────────────────────────────────────────────────
// Browsers never send a trailing slash in the Origin header, so normalize the
// configured list to match (and drop stray whitespace around commas).
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:3000")
  .split(",")
  .map((o) => o.trim().replace(/\/+$/, ""))
  .filter(Boolean);
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    cb(new Error(`CORS: ${origin} not allowed`));
  },
  credentials: true,
}));

// ─── Body / cookies ───────────────────────────────────────────────────────────
app.use(express.json({ limit: "1mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Initialize Passport (before routes)
app.use(passport.initialize());

// ─── Swagger Documentation ────────────────────────────────────────────────────
if (process.env.NODE_ENV !== "production" || process.env.SWAGGER_ENABLED === "true") {
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec, {
    swaggerOptions: {
      persistAuthorization: true,
    },
  }));
}

// ─── Rate limiters ────────────────────────────────────────────────────────────
// Every limiter answers with the standard { success, message } envelope. The
// default express-rate-limit reply is a bare HTML string, so every frontend
// `err.response.data.message` read came back undefined and the UI fell through
// to a generic error — or, where the caller swallowed the failure, to a silently
// empty list with nothing explaining why.
const limitMessage = (message) => ({
  message: { success: false, message },
  standardHeaders: true,
  legacyHeaders:   false,
});

const general = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, ...limitMessage("Too many requests. Please wait a moment and try again.") });
const tracker = rateLimit({ windowMs: 60 * 1000,      max: 30,  ...limitMessage("Too many tracking lookups. Please wait a moment.") });
const contact = rateLimit({ windowMs: 60 * 60 * 1000, max: 5,   ...limitMessage("Too many messages sent. Please try again later.") });

app.use("/api", general);
app.use("/api/tracking", tracker);
app.use("/api/contact", contact);

// NOTE: the brute-force limiter is no longer mounted across /api/auth either.
// At 10 requests / 15 min per IP it covered `/auth/me` and `/auth/refresh` as
// well as `/auth/login`, so eleven page loads from one office IP made every
// token refresh return 429. The client cannot tell a throttle from a rejected
// session, so it signed people out mid-work while their session was perfectly
// valid. It is now split per route — see src/routes/auth.routes.js.

// NOTE: the upload limiter deliberately does NOT live here. It used to be
// mounted as `app.use("/api/batches", upload)` with a 20/hour cap, which
// throttled the whole prefix — the batch list, the batch items, and the retract
// (DELETE) endpoint included — and counted requests before authentication, so
// even 401s from an expiring token burned the budget. Staff who uploaded a few
// files and clicked around the dashboard used up the 20 within minutes, after
// which "Manage Uploads" came back empty and "Delete previous & upload" did
// nothing for the rest of the hour. It is now applied per-route to the three
// upload endpoints only — see src/routes/batch.routes.js.

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use("/api/auth",     authRoutes);
app.use("/api/auth",     oauthRoutes);
app.use("/api",          trackingRoutes);
app.use("/api",          gpsRoutes);
app.use("/api/admin",    adminRoutes);
app.use("/api/employee", employeeRoutes);
app.use("/api/dashboard",dashboardRoutes);
app.use("/api",          contactRoutes);
app.use("/api",          batchRoutes);
app.use("/api",          containerRoutes);
app.use("/api",          settingsRoutes);

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok", ts: new Date().toISOString() }));

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => respond(res, 404, false, `${req.method} ${req.path} not found`));

// ─── Error handler ────────────────────────────────────────────────────────────
app.use(errorHandler);

module.exports = app;

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
const { errorHandler } = require("./middleware/errorHandler");
const { respond }    = require("./utils/response");
const swaggerSpec   = require("./config/swagger");

// Initialize Passport
const passport = require("passport");
require("./config/passport");

const app = express();

// ─── Security ─────────────────────────────────────────────────────────────────
app.use(helmet());

// ─── CORS ─────────────────────────────────────────────────────────────────────
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "http://localhost:3000").split(",");
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
// DISABLED FOR TESTING - Will re-enable in production
// const general = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
// const auth    = rateLimit({ windowMs: 15 * 60 * 1000, max: 10 });
// const tracker = rateLimit({ windowMs: 60 * 1000, max: 30 });
// const contact = rateLimit({ windowMs: 60 * 60 * 1000, max: 5 }); // 5 requests per hour for contact form

// app.use("/api", general);
// app.use("/api/auth", auth);
// app.use("/api/tracking", tracker);
// app.use("/api/contact", contact);

// ─── Routes ───────────────────────────────────────────────────────────────────
app.use("/api/auth",  authRoutes);
app.use("/api/auth",  oauthRoutes);
app.use("/api",       trackingRoutes);
app.use("/api",       gpsRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/employee", employeeRoutes);
app.use("/api/dashboard", dashboardRoutes);
app.use("/api",       contactRoutes);

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/health", (req, res) => res.json({ status: "ok", ts: new Date().toISOString() }));

// ─── 404 ──────────────────────────────────────────────────────────────────────
app.use((req, res) => respond(res, 404, false, `${req.method} ${req.path} not found`));

// ─── Error handler ────────────────────────────────────────────────────────────
app.use(errorHandler);

module.exports = app;

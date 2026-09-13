const express   = require("express");
const path      = require("path");
const multer    = require("multer");
const router    = express.Router();
const ctrl      = require("../controllers/parcel.controller");
const { authenticate, authorize } = require("../middleware/auth.middleware");
const rateLimit = require("express-rate-limit");

// Memory storage — files are parsed into observations, never written to disk.
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if ([".xlsx", ".xls"].includes(ext)) return cb(null, true);
    cb(new Error("Only .xlsx and .xls files are accepted"), false);
  },
});

const uploadLimiter = rateLimit({
  windowMs:        60 * 60 * 1000,
  max:             parseInt(process.env.UPLOAD_RATE_LIMIT || "60", 10),
  standardHeaders: true,
  legacyHeaders:   false,
  keyGenerator:    (req) => (req.user ? String(req.user._id) : req.ip),
  message: { success: false, message: "Upload limit reached for this hour." },
});

const staffOnly    = [authenticate, authorize("admin", "employee")];
const customerOnly = [authenticate, authorize("customer")];

// Public tracking is unauthenticated; rate-limit to blunt scraping.
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      30,
  message:  { success: false, message: "Too many requests. Please wait a moment." },
});

// ─── Uploads (Layer 1) ────────────────────────────────────────────────────────
router.post("/v2/uploads/validate", ...staffOnly, uploadLimiter, upload.single("file"), ctrl.validateUpload);
router.post("/v2/uploads",          ...staffOnly, uploadLimiter, upload.single("file"), ctrl.upload);
router.get ("/v2/uploads",          ...staffOnly, ctrl.listUploads);
router.delete("/v2/uploads/:fileHash", ...staffOnly, ctrl.revertUpload);

// ─── Parcels (Layer 2, derived) ─────────────────────────────────────────────
router.get("/v2/reconciliation",    ...staffOnly, ctrl.reconciliation);
router.get("/v2/parcels/mine",      ...customerOnly, ctrl.myParcels);
router.get("/v2/parcels",           ...staffOnly, ctrl.listParcels);
router.get("/v2/parcels/:waybill",  ...staffOnly, ctrl.getByWaybill);
router.post("/v2/parcels/bulk-status", ...staffOnly, ctrl.bulkAdjustStatus);
router.patch("/v2/parcels/:waybill/:customerKey", ...staffOnly, ctrl.adjustParcel);

// ─── Containers ─────────────────────────────────────────────────────────────
router.get("/v2/containers",              ...staffOnly, ctrl.listContainers);
router.get("/v2/containers/:containerNo", ...staffOnly, ctrl.getContainer);

// ─── Public tracking (no auth) ────────────────────────────────────────────────
router.get("/v2/track/phone/:phone",     publicLimiter, ctrl.publicTrackByPhone);
router.get("/v2/track/mark/:mark",       publicLimiter, ctrl.publicTrackByMark);
router.get("/v2/track/waybill/:waybill", publicLimiter, ctrl.publicTrackByWaybill);

module.exports = router;

const express = require("express");
const path    = require("path");
const multer  = require("multer");
const router  = express.Router();
const ctrl    = require("../controllers/batch.controller");
const { authenticate, authorize } = require("../middleware/auth.middleware");
const rateLimit = require("express-rate-limit");

// ─── Multer config (memory storage — no disk writes) ─────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    if ([".xlsx", ".xls"].includes(ext)) return cb(null, true);
    cb(new Error("Only .xlsx and .xls files are accepted"), false);
  },
});

// ─── Rate limiter for public endpoints ───────────────────────────────────────
const publicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max:      30,
  message:  { success: false, message: "Too many requests. Please wait a moment." },
});

// ─── Staff-only middleware stack ──────────────────────────────────────────────
const staffOnly = [authenticate, authorize("admin", "employee")];

// ─── Upload endpoints ─────────────────────────────────────────────────────────

/**
 * @swagger
 * /batches/intake:
 *   post:
 *     tags: [Batches]
 *     summary: Upload Stage 1 — Goods received at China warehouse
 *     security: [{bearerAuth: []}]
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       201:
 *         description: Intake batch processed
 *       400:
 *         description: Invalid file
 *       401:
 *         description: Unauthorized
 */
router.post("/batches/intake",  ...staffOnly, upload.single("file"), ctrl.uploadIntake);

/**
 * @swagger
 * /batches/shipped:
 *   post:
 *     tags: [Batches]
 *     summary: Upload Stage 2 — Container departed China
 *     security: [{bearerAuth: []}]
 */
router.post("/batches/shipped", ...staffOnly, upload.single("file"), ctrl.uploadShipped);

/**
 * @swagger
 * /batches/arrived:
 *   post:
 *     tags: [Batches]
 *     summary: Upload Stage 3 — Container arrived in Ghana
 *     security: [{bearerAuth: []}]
 */
router.post("/batches/arrived", ...staffOnly, upload.single("file"), ctrl.uploadArrived);

// ─── Batch list & detail ──────────────────────────────────────────────────────

/**
 * @swagger
 * /batches:
 *   get:
 *     tags: [Batches]
 *     summary: List all batches
 *     security: [{bearerAuth: []}]
 *     parameters:
 *       - in: query
 *         name: stage
 *         schema:
 *           type: string
 *           enum: [intake, shipped, arrived]
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 */
router.get("/batches",              ...staffOnly, ctrl.listBatches);
router.get("/batches/held",         ...staffOnly, ctrl.getHeldItems);
router.get("/batches/:id",          ...staffOnly, ctrl.getBatch);
router.get("/batches/:id/items",    ...staffOnly, ctrl.getBatchItems);

// ─── Item management ──────────────────────────────────────────────────────────

/**
 * @swagger
 * /batches/items/{itemId}/reassign:
 *   patch:
 *     tags: [Batches]
 *     summary: Reassign a held item to a different batch
 *     security: [{bearerAuth: []}]
 *     parameters:
 *       - in: path
 *         name: itemId
 *         required: true
 *         schema:
 *           type: string
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [targetBatchId]
 *             properties:
 *               targetBatchId:
 *                 type: string
 *               note:
 *                 type: string
 */
router.patch("/batches/items/:itemId/reassign", ...staffOnly, ctrl.reassignHeldItem);

/**
 * @swagger
 * /batches/items/{itemId}:
 *   patch:
 *     tags: [Batches]
 *     summary: Manually update an item's details
 *     security: [{bearerAuth: []}]
 */
router.patch("/batches/items/:itemId", ...staffOnly, ctrl.updateItem);

// ─── Public tracking ──────────────────────────────────────────────────────────

/**
 * @swagger
 * /tracking/phone/{phone}:
 *   get:
 *     tags: [Public Tracking]
 *     summary: Look up all shipments for a phone number (public)
 *     parameters:
 *       - in: path
 *         name: phone
 *         required: true
 *         schema:
 *           type: string
 *         example: "0200485487"
 */
router.get("/tracking/phone/:phone",     publicLimiter, ctrl.lookupByPhone);

/**
 * @swagger
 * /tracking/waybill/{waybill}:
 *   get:
 *     tags: [Public Tracking]
 *     summary: Look up a single item by waybill number (public)
 *     parameters:
 *       - in: path
 *         name: waybill
 *         required: true
 *         schema:
 *           type: string
 *         example: "78992390754171"
 */
router.get("/tracking/waybill/:waybill", publicLimiter, ctrl.lookupByWaybill);

// ─── Unified shipments list ───────────────────────────────────────────────────

/**
 * @swagger
 * /shipments/all:
 *   get:
 *     tags: [Batches]
 *     summary: List all shipments (batch items) for dashboard
 *     security: [{bearerAuth: []}]
 *     parameters:
 *       - in: query
 *         name: page
 *         schema:
 *           type: integer
 *       - in: query
 *         name: limit
 *         schema:
 *           type: integer
 *       - in: query
 *         name: status
 *         schema:
 *           type: string
 *           enum: [in_warehouse, shipped, arrived, held]
 *       - in: query
 *         name: search
 *         schema:
 *           type: string
 */
router.get("/shipments/all", ...staffOnly, ctrl.getAllShipments);

module.exports = router;

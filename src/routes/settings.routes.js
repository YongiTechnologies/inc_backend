const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/settings.controller");
const { authenticate, authorize } = require("../middleware/auth.middleware");

// Public — calculator page fetches this on load
router.get("/settings", ctrl.getSettings);

// Admin only — update rates from the dashboard
router.put("/settings", authenticate, authorize("admin"), ctrl.updateSettings);

module.exports = router;

const express = require("express");
const router  = express.Router();
const ctrl    = require("../controllers/container.controller");
const { authenticate, authorize } = require("../middleware/auth.middleware");

// ─── Public ───────────────────────────────────────────────────────────────────
router.get("/container-loadings",          ctrl.listContainerLoadings);
router.get("/container-loadings/search",   ctrl.searchContainerLoadings);
router.get("/container-loadings/:id",      ctrl.getContainerLoading);

// ─── Staff only ───────────────────────────────────────────────────────────────
router.get(
  "/container-loadings/staff/list",
  authenticate, authorize("employee", "admin"),
  ctrl.listContainerLoadingsStaff,
);

router.post(
  "/container-loadings",
  authenticate, authorize("employee", "admin"),
  ctrl.createContainerLoading,
);

router.patch(
  "/container-loadings/:id",
  authenticate, authorize("employee", "admin"),
  ctrl.updateContainerLoading,
);

router.delete(
  "/container-loadings/:id",
  authenticate, authorize("employee", "admin"),
  ctrl.deleteContainerLoading,
);

module.exports = router;

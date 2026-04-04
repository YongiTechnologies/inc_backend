const express = require("express");
const router  = express.Router();
const ctrl    = require("../controllers/dashboard.controller");
const { authenticate, authorize } = require("../middleware/auth.middleware");

/**
 * @swagger
 * /dashboard/customer/stats:
 *   get:
 *     tags:
 *       - Dashboard
 *     summary: Get customer dashboard statistics
 *     description: Retrieve statistics for customer dashboard (total shipments, in transit, delivered, next delivery)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Customer stats retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Customer stats retrieved"
 *                 data:
 *                   type: object
 *                   properties:
 *                     totalShipments:
 *                       type: integer
 *                       example: 15
 *                     inTransit:
 *                       type: integer
 *                       example: 3
 *                     delivered:
 *                       type: integer
 *                       example: 12
 *                     nextDelivery:
 *                       type: string
 *                       format: date-time
 *                       nullable: true
 *                       example: "2025-12-15T10:00:00.000Z"
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - not a customer
 */
router.get("/customer/stats", authenticate, authorize("customer"), ctrl.getCustomerStats);

/**
 * @swagger
 * /dashboard/employee/stats:
 *   get:
 *     tags:
 *       - Dashboard
 *     summary: Get employee dashboard statistics
 *     description: Retrieve statistics for employee dashboard (active shipments, pending updates, completed today)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Employee stats retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Employee stats retrieved"
 *                 data:
 *                   type: object
 *                   properties:
 *                     activeShipments:
 *                       type: integer
 *                       example: 25
 *                     pendingUpdates:
 *                       type: integer
 *                       example: 5
 *                     completedToday:
 *                       type: integer
 *                       example: 8
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - not an employee or admin
 */
router.get("/employee/stats", authenticate, authorize(["employee", "admin"]), ctrl.getEmployeeStats);

/**
 * @swagger
 * /dashboard/admin/stats:
 *   get:
 *     tags:
 *       - Dashboard
 *     summary: Get admin dashboard statistics
 *     description: Retrieve comprehensive statistics for admin dashboard (users and shipments)
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Admin stats retrieved successfully
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Admin stats retrieved"
 *                 data:
 *                   type: object
 *                   properties:
 *                     users:
 *                       type: object
 *                       properties:
 *                         total:
 *                           type: integer
 *                           example: 150
 *                         byRole:
 *                           type: object
 *                           properties:
 *                             customer:
 *                               type: integer
 *                               example: 120
 *                             employee:
 *                               type: integer
 *                               example: 25
 *                             admin:
 *                               type: integer
 *                               example: 5
 *                         newThisMonth:
 *                           type: integer
 *                           example: 12
 *                     shipments:
 *                       type: object
 *                       properties:
 *                         total:
 *                           type: integer
 *                           example: 500
 *                         byStatus:
 *                           type: object
 *                           properties:
 *                             pending:
 *                               type: integer
 *                               example: 10
 *                             in_transit:
 *                               type: integer
 *                               example: 25
 *                             delivered:
 *                               type: integer
 *                               example: 450
 *                         activeLogistics:
 *                           type: integer
 *                           example: 30
 *                         completedThisMonth:
 *                           type: integer
 *                           example: 45
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - not an admin
 */
router.get("/admin/stats", authenticate, authorize("admin"), ctrl.getAdminStats);

/**
 * @swagger
 * /employees/customers/search:
 *   get:
 *     tags:
 *       - Dashboard
 *     summary: Search customers for shipment creation
 *     description: Search customers by name or email for employee shipment creation
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: query
 *         name: q
 *         required: true
 *         schema:
 *           type: string
 *           minLength: 2
 *         description: Search query (name or email)
 *     responses:
 *       200:
 *         description: Customers found
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 success:
 *                   type: boolean
 *                   example: true
 *                 message:
 *                   type: string
 *                   example: "Customers found"
 *                 data:
 *                   type: array
 *                   items:
 *                     type: object
 *                     properties:
 *                       id:
 *                         type: string
 *                         example: "507f1f77bcf86cd799439011"
 *                       name:
 *                         type: string
 *                         example: "John Doe"
 *                       email:
 *                         type: string
 *                         example: "john@example.com"
 *                       phone:
 *                         type: string
 *                         example: "+1234567890"
 *       400:
 *         description: Invalid search query
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden - not an employee or admin
 */
router.get("/employees/customers/search", authenticate, authorize(["employee", "admin"]), ctrl.searchCustomers);

module.exports = router;
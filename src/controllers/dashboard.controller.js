const User         = require("../models/User");
const Shipment     = require("../models/Shipment");
const ShipmentItem = require("../models/ShipmentItem");
const { respond }  = require("../utils/response");
const { normalisePhone } = require("../services/batch.service");

/**
 * Customer dashboard stats — combines both tracking domains:
 *  1. Individual shipments (Shipment model — staff-created, full lifecycle)
 *  2. Batch shipment items (ShipmentItem model — Excel-uploaded)
 */
async function getCustomerStats(req, res, next) {
  try {
    const user       = req.user;
    const customerId = user._id;

    // ── Individual shipments ──────────────────────────────────────────────────
    const shipments = await Shipment.find({ customerId })
      .select("status estimatedDelivery")
      .lean();

    const individualTotal    = shipments.length;
    const individualInTransit = shipments.filter((s) =>
      ["pending", "picked_up", "in_transit", "customs", "out_for_delivery"].includes(s.status)
    ).length;
    const individualDelivered = shipments.filter((s) => s.status === "delivered").length;

    const nextIndividualDelivery = shipments
      .filter((s) => !["delivered", "returned", "failed"].includes(s.status) && s.estimatedDelivery)
      .map((s) => s.estimatedDelivery)
      .sort((a, b) => new Date(a) - new Date(b))[0] || null;

    // ── Batch shipment items ──────────────────────────────────────────────────
    // Match by customerId OR by phone (catches items uploaded before they registered)
    const orConditions = [{ customerId }];
    if (user.phone) {
      const norm = normalisePhone(user.phone);
      if (norm) orConditions.push({ customerPhone: norm });
    }

    const [batchTotal, batchInWarehouse, batchShipped, batchHeld] =
      await Promise.all([
        ShipmentItem.countDocuments({ $or: orConditions }),
        ShipmentItem.countDocuments({ $or: orConditions, status: "in_warehouse" }),
        ShipmentItem.countDocuments({ $or: orConditions, status: "shipped" }),
        ShipmentItem.countDocuments({ $or: orConditions, status: "held" }),
      ]);

    return respond(res, 200, true, "Customer stats retrieved", {
      // Individual tracked shipments
      individual: {
        total:       individualTotal,
        inTransit:   individualInTransit,
        delivered:   individualDelivered,
        nextDelivery: nextIndividualDelivery,
      },
      // Batch / Excel-uploaded shipment items
      batch: {
        total:       batchTotal,
        inWarehouse: batchInWarehouse,
        shipped:     batchShipped,
        held:        batchHeld,
      },
      // Combined quick summary for a simple dashboard counter
      summary: {
        totalItems:  individualTotal + batchTotal,
        inTransit:   individualInTransit + batchShipped,
        delivered:   individualDelivered,
      },
    });
  } catch (err) { next(err); }
}

/**
 * Employee dashboard stats — unchanged
 */
async function getEmployeeStats(req, res, next) {
  try {
    const now          = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const [activeShipments, pendingUpdates, completedToday,
           batchInWarehouse, batchShipped, batchHeld] = await Promise.all([
      Shipment.countDocuments({ status: { $nin: ["delivered", "returned", "failed"] } }),
      Shipment.countDocuments({ status: "pending" }),
      Shipment.countDocuments({ status: "delivered", deliveredAt: { $gte: startOfToday } }),
      ShipmentItem.countDocuments({ status: "in_warehouse" }),
      ShipmentItem.countDocuments({ status: "shipped" }),
      ShipmentItem.countDocuments({ status: "held" }),
    ]);

    return respond(res, 200, true, "Employee stats retrieved", {
      // Individual shipments
      activeShipments,
      pendingUpdates,
      completedToday,
      // Batch items
      batchItems: {
        inWarehouse: batchInWarehouse,
        shipped:     batchShipped,
        held:        batchHeld,
      },
    });
  } catch (err) { next(err); }
}

/**
 * Admin dashboard stats — unchanged, adds batch totals
 */
async function getAdminStats(req, res, next) {
  try {
    const now          = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      userStats,
      shipmentStats,
      completedThisMonth,
      batchStatusCounts,
    ] = await Promise.all([
      Promise.all([
        User.countDocuments(),
        User.aggregate([{ $group: { _id: "$role", count: { $sum: 1 } } }]),
        User.countDocuments({ createdAt: { $gte: startOfMonth } }),
      ]),
      Promise.all([
        Shipment.countDocuments(),
        Shipment.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
        Shipment.countDocuments({
          status: { $in: ["picked_up", "in_transit", "customs", "out_for_delivery"] },
        }),
      ]),
      Shipment.countDocuments({ status: "delivered", deliveredAt: { $gte: startOfMonth } }),
      ShipmentItem.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
    ]);

    const [totalUsers, usersByRole, newUsersThisMonth]       = userStats;
    const [totalShipments, shipmentsByStatus, activeLogistics] = shipmentStats;

    const roleMap = {};
    usersByRole.forEach(({ _id, count }) => { roleMap[_id] = count; });

    const statusMap = {};
    shipmentsByStatus.forEach(({ _id, count }) => { statusMap[_id] = count; });

    const batchStatusMap = {};
    batchStatusCounts.forEach(({ _id, count }) => { batchStatusMap[_id] = count; });

    return respond(res, 200, true, "Admin stats retrieved", {
      users: {
        total:        totalUsers,
        byRole:       roleMap,
        newThisMonth: newUsersThisMonth,
      },
      shipments: {
        total:              totalShipments,
        byStatus:           statusMap,
        activeLogistics,
        completedThisMonth,
      },
      batchItems: {
        total:       Object.values(batchStatusMap).reduce((a, b) => a + b, 0),
        byStatus:    batchStatusMap,
      },
    });
  } catch (err) { next(err); }
}

/**
 * Search customers for employee shipment creation — unchanged
 */
async function searchCustomers(req, res, next) {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) {
      return respond(res, 400, false, "Search query must be at least 2 characters");
    }

    const customers = await User.find({
      role: "customer",
      $or: [
        { name:  { $regex: q, $options: "i" } },
        { email: { $regex: q, $options: "i" } },
      ],
    })
      .select("name email phone")
      .limit(10)
      .lean();

    return respond(res, 200, true, "Customers found", customers.map((c) => ({
      id:    c._id,
      name:  c.name,
      email: c.email,
      phone: c.phone,
    })));
  } catch (err) { next(err); }
}

module.exports = {
  getCustomerStats,
  getEmployeeStats,
  getAdminStats,
  searchCustomers,
};

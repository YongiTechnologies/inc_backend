const User         = require("../models/User");
const ShipmentItem = require("../models/ShipmentItem");
const { respond }  = require("../utils/response");
const { normalisePhone } = require("../services/batch.service");

/**
 * Customer dashboard stats — unified ShipmentItem model.
 */
async function getCustomerStats(req, res, next) {
  try {
    const user       = req.user;
    const customerId = user._id;

    // ── All shipment items (unified model) ────────────────────────────────────
    // Match by customerId OR by phone (catches items uploaded before they registered)
    const orConditions = [{ customerId }];
    if (user.phone) {
      const norm = normalisePhone(user.phone);
      if (norm) orConditions.push({ customerPhone: norm });
    }

    const items = await ShipmentItem.find({ $or: orConditions })
      .select("status estimatedDelivery deliveredAt")
      .lean();

    const totalItems    = items.length;
    const inTransit     = items.filter((item) =>
      ["pending", "picked_up", "in_transit", "customs", "out_for_delivery", "shipped"].includes(item.status)
    ).length;
    const delivered     = items.filter((item) => item.status === "delivered").length;
    const inWarehouse   = items.filter((item) => item.status === "in_warehouse").length;
    const held          = items.filter((item) => item.status === "held").length;

    const nextDelivery = items
      .filter((item) => !["delivered", "returned", "failed"].includes(item.status) && item.estimatedDelivery)
      .map((item) => item.estimatedDelivery)
      .sort((a, b) => new Date(a) - new Date(b))[0] || null;

    return respond(res, 200, true, "Customer stats retrieved", {
      totalItems,
      inTransit,
      delivered,
      inWarehouse,
      held,
      nextDelivery,
    });
  } catch (err) { next(err); }
}

/**
 * Employee dashboard stats — unified ShipmentItem model
 */
async function getEmployeeStats(req, res, next) {
  try {
    const now          = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const [activeItems, pendingUpdates, completedToday,
           inWarehouse, shipped, held] = await Promise.all([
      ShipmentItem.countDocuments({ status: { $nin: ["delivered", "returned", "failed"] } }),
      ShipmentItem.countDocuments({ status: "pending" }),
      ShipmentItem.countDocuments({ status: "delivered", deliveredAt: { $gte: startOfToday } }),
      ShipmentItem.countDocuments({ status: "in_warehouse" }),
      ShipmentItem.countDocuments({ status: "shipped" }),
      ShipmentItem.countDocuments({ status: "held" }),
    ]);

    return respond(res, 200, true, "Employee stats retrieved", {
      activeItems,
      pendingUpdates,
      completedToday,
      batchItems: {
        inWarehouse,
        shipped,
        held,
      },
    });
  } catch (err) { next(err); }
}

/**
 * Admin dashboard stats — unified ShipmentItem model
 */
async function getAdminStats(req, res, next) {
  try {
    const now          = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      userStats,
      itemStats,
      completedThisMonth,
    ] = await Promise.all([
      Promise.all([
        User.countDocuments(),
        User.aggregate([{ $group: { _id: "$role", count: { $sum: 1 } } }]),
        User.countDocuments({ createdAt: { $gte: startOfMonth } }),
      ]),
      Promise.all([
        ShipmentItem.countDocuments(),
        ShipmentItem.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      ]),
      ShipmentItem.countDocuments({ status: "delivered", deliveredAt: { $gte: startOfMonth } }),
    ]);

    const [totalUsers, usersByRole, newUsersThisMonth] = userStats;
    const [totalItems, itemsByStatus] = itemStats;

    const roleMap = {};
    usersByRole.forEach(({ _id, count }) => { roleMap[_id] = count; });

    const statusMap = {};
    itemsByStatus.forEach(({ _id, count }) => { statusMap[_id] = count; });

    // Count active logistics items (in transit statuses)
    const activeLogistics = statusMap["pending"] + statusMap["picked_up"] +
                           statusMap["in_transit"] + statusMap["customs"] +
                           statusMap["out_for_delivery"] + statusMap["shipped"] || 0;

    return respond(res, 200, true, "Admin stats retrieved", {
      users: {
        total:        totalUsers,
        byRole:       roleMap,
        newThisMonth: newUsersThisMonth,
      },
      items: {
        total:              totalItems,
        byStatus:           statusMap,
        activeLogistics,
        completedThisMonth,
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

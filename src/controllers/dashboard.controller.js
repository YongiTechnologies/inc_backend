const trackingService = require("../services/tracking.service");
const User = require("../models/User");
const Shipment = require("../models/Shipment");
const { respond } = require("../utils/response");

/**
 * Customer dashboard stats
 */
async function getCustomerStats(req, res, next) {
  try {
    const customerId = req.user._id;

    // Get all customer's shipments
    const shipments = await Shipment.find({ customerId }).select('status estimatedDelivery').lean();

    const totalShipments = shipments.length;
    const inTransit = shipments.filter(s =>
      ['pending', 'picked_up', 'in_transit', 'customs', 'out_for_delivery'].includes(s.status)
    ).length;
    const delivered = shipments.filter(s => s.status === 'delivered').length;

    // Find nearest estimated delivery among active shipments
    const activeShipments = shipments.filter(s =>
      !['delivered', 'returned', 'failed'].includes(s.status)
    );
    const nextDelivery = activeShipments
      .map(s => s.estimatedDelivery)
      .filter(date => date)
      .sort((a, b) => new Date(a) - new Date(b))[0] || null;

    return respond(res, 200, true, "Customer stats retrieved", {
      totalShipments,
      inTransit,
      delivered,
      nextDelivery,
    });
  } catch (err) { next(err); }
}

/**
 * Employee dashboard stats
 */
async function getEmployeeStats(req, res, next) {
  try {
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());

    const [activeShipments, pendingUpdates, completedToday] = await Promise.all([
      Shipment.countDocuments({
        status: { $nin: ['delivered', 'returned', 'failed'] }
      }),
      Shipment.countDocuments({ status: 'pending' }),
      Shipment.countDocuments({
        status: 'delivered',
        deliveredAt: { $gte: startOfToday }
      }),
    ]);

    return respond(res, 200, true, "Employee stats retrieved", {
      activeShipments,
      pendingUpdates,
      completedToday,
    });
  } catch (err) { next(err); }
}

/**
 * Admin dashboard stats
 */
async function getAdminStats(req, res, next) {
  try {
    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);

    const [
      userStats,
      shipmentStats,
      completedThisMonth
    ] = await Promise.all([
      // User statistics
      Promise.all([
        User.countDocuments(),
        User.aggregate([
          { $group: { _id: '$role', count: { $sum: 1 } } }
        ]),
        User.countDocuments({
          createdAt: { $gte: startOfMonth }
        }),
      ]),
      // Shipment statistics
      Promise.all([
        Shipment.countDocuments(),
        Shipment.aggregate([
          { $group: { _id: '$status', count: { $sum: 1 } } }
        ]),
        Shipment.countDocuments({
          status: { $in: ['picked_up', 'in_transit', 'customs', 'out_for_delivery'] }
        }),
      ]),
      // Completed this month
      Shipment.countDocuments({
        status: 'delivered',
        deliveredAt: { $gte: startOfMonth }
      }),
    ]);

    const [totalUsers, usersByRole, newUsersThisMonth] = userStats;
    const [totalShipments, shipmentsByStatus, activeLogistics] = shipmentStats;

    const roleMap = {};
    usersByRole.forEach(({ _id, count }) => { roleMap[_id] = count; });

    const statusMap = {};
    shipmentsByStatus.forEach(({ _id, count }) => { statusMap[_id] = count; });

    return respond(res, 200, true, "Admin stats retrieved", {
      users: {
        total: totalUsers,
        byRole: roleMap,
        newThisMonth: newUsersThisMonth,
      },
      shipments: {
        total: totalShipments,
        byStatus: statusMap,
        activeLogistics,
        completedThisMonth,
      },
    });
  } catch (err) { next(err); }
}

/**
 * Search customers for employee shipment creation
 */
async function searchCustomers(req, res, next) {
  try {
    const { q } = req.query;
    if (!q || q.length < 2) {
      return respond(res, 400, false, "Search query must be at least 2 characters");
    }

    const customers = await User.find({
      role: 'customer',
      $or: [
        { name: { $regex: q, $options: 'i' } },
        { email: { $regex: q, $options: 'i' } },
      ],
    })
    .select('name email phone')
    .limit(10)
    .lean();

    const results = customers.map(customer => ({
      id: customer._id,
      name: customer.name,
      email: customer.email,
      phone: customer.phone,
    }));

    return respond(res, 200, true, "Customers found", results);
  } catch (err) { next(err); }
}

module.exports = {
  getCustomerStats,
  getEmployeeStats,
  getAdminStats,
  searchCustomers,
};
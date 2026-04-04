const User = require("../models/User");
const AuditLog = require("../models/AuditLog");
const audit = require("../services/audit.service");
const { respond } = require("../utils/response");
const { escapeRegex, validate } = require("../utils/validators");
const Joi = require("joi");

async function listUsers(req, res, next) {
  try {
    const { page = 1, limit = 20, role, search } = req.query;
    const filter = {};
    if (role) filter.role = role;
    if (search) {
      const escaped = escapeRegex(search);
      filter.$or = [
        { name:  new RegExp(escaped, "i") },
        { email: new RegExp(escaped, "i") },
      ];
    }

    const [users, total] = await Promise.all([
      User.find(filter)
        .sort({ createdAt: -1 })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit))
        .select("-password"),
      User.countDocuments(filter),
    ]);

    return respond(res, 200, true, "Users retrieved", {
      users,
      pagination: { total, page: parseInt(page), limit: parseInt(limit), pages: Math.ceil(total / parseInt(limit)) },
    });
  } catch (err) { next(err); }
}

async function createUser(req, res, next) {
  try {
    const schema = Joi.object({
      name:       Joi.string().min(2).required(),
      email:      Joi.string().email().required(),
      phone:      Joi.string().optional(),
      password:   Joi.string().min(8).required(),
      role:       Joi.string().valid("customer", "employee", "admin").required(),
      isVerified: Joi.boolean().optional(),
      isActive:   Joi.boolean().optional(),
    });

    const { error, value } = schema.validate(req.body, { abortEarly: false });
    if (error) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: error.details.map((d) => d.message),
      });
    }

    if (await User.findOne({ email: value.email })) {
      return respond(res, 409, false, "Email already registered");
    }

    const user = await User.create({
      name: value.name,
      email: value.email,
      phone: value.phone,
      password: value.password,
      role: value.role,
      provider: "local",
      isVerified: value.isVerified ?? false,
      isActive: value.isActive ?? true,
    });

    const responseUser = user.toObject();
    delete responseUser.password;

    await audit.log({
      performedBy: req.user._id,
      action:      "CREATE_USER",
      targetModel: "User",
      targetId:    user._id,
      details:     { role: user.role },
      ip:          req.ip,
    });

    return respond(res, 201, true, "User created", responseUser);
  } catch (err) { next(err); }
}

async function updateUser(req, res, next) {
  try {
    const { id } = req.params;

    // Validate request body
    const schema = Joi.object({
      name:      Joi.string().min(2).optional(),
      phone:     Joi.string().optional(),
      role:      Joi.string().valid("customer", "employee", "admin").optional(),
      isActive:  Joi.boolean().optional(),
      isVerified: Joi.boolean().optional(),
    }).min(1); // At least one field must be provided

    const { error, value } = schema.validate(req.body, { abortEarly: false });
    if (error) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: error.details.map((d) => d.message),
      });
    }

    // Get original user for audit logging
    const originalUser = await User.findById(id).select("-password");
    if (!originalUser) return respond(res, 404, false, "User not found");

    // Update user
    const user = await User.findByIdAndUpdate(id, value, { new: true }).select("-password");
    if (!user) return respond(res, 404, false, "User not found");

    // Log changes for audit
    const changes = {};
    Object.keys(value).forEach(key => {
      if (originalUser[key] !== user[key]) {
        changes[key] = { from: originalUser[key], to: user[key] };
      }
    });

    await audit.log({
      performedBy: req.user._id,
      action:      "UPDATE_USER",
      targetModel: "User",
      targetId:    id,
      details:     changes,
      ip:          req.ip,
    });

    return respond(res, 200, true, "User updated", user);
  } catch (err) { next(err); }
}

async function getAuditLogs(req, res, next) {
  try {
    const { page = 1, limit = 50 } = req.query;
    const [logs, total] = await Promise.all([
      AuditLog.find()
        .sort({ timestamp: -1 })
        .skip((parseInt(page) - 1) * parseInt(limit))
        .limit(parseInt(limit))
        .populate("performedBy", "name email role"),
      AuditLog.countDocuments(),
    ]);
    return respond(res, 200, true, "Audit logs retrieved", {
      logs,
      pagination: { total, page: parseInt(page), limit: parseInt(limit) },
    });
  } catch (err) { next(err); }
}

module.exports = { listUsers, createUser, updateUser, getAuditLogs };

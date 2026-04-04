const Joi = require("joi");

/**
 * Escape special regex characters to prevent RegExp injection
 */
function escapeRegex(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const locationSchema = Joi.object({
  address:     Joi.string().required(),
  city:        Joi.string().required(),
  country:     Joi.string().required(),
  coordinates: Joi.array().items(Joi.number()).length(2).optional(),
});

const validators = {
  register: Joi.object({
    name:     Joi.string().min(2).required(),
    email:    Joi.string().email().required(),
    phone:    Joi.string().optional(),
    password: Joi.string().min(8).when("provider", {
      is: "local",
      then: Joi.required(),
      otherwise: Joi.optional()
    }),
    provider: Joi.string().valid("local", "google").optional(),
  }),

  login: Joi.object({
    email:    Joi.string().email().required(),
    password: Joi.string().required(),
  }),

  createShipment: Joi.object({
    trackingNumber:      Joi.string().min(3).max(50).required(),
    customerId:          Joi.string().hex().length(24).required(),
    origin:              locationSchema.required(),
    destination:         locationSchema.required(),
    description:         Joi.string().required(),
    packageType:         Joi.string().valid("document", "parcel", "pallet", "container").optional(),
    weight:              Joi.number().positive().optional(),
    dimensions:          Joi.object({ length: Joi.number(), width: Joi.number(), height: Joi.number() }).optional(),
    quantity:            Joi.number().integer().min(1).optional(),
    declaredValue:       Joi.number().min(0).optional(),
    estimatedDelivery:   Joi.date().iso().optional(),
    requiresCustoms:     Joi.boolean().optional(),
    isFragile:           Joi.boolean().optional(),
    specialInstructions: Joi.string().optional(),
  }),

  logEvent: Joi.object({
    status: Joi.string()
      .valid("pending", "picked_up", "in_transit", "customs", "out_for_delivery", "delivered", "failed", "returned")
      .required(),
    location:         locationSchema.required(),
    note:             Joi.string().optional(),
    internalNote:     Joi.string().optional(),
    carrier:          Joi.string().optional(),
    carrierReference: Joi.string().optional(),
  }),
};

function validate(schema) {
  return (req, res, next) => {
    const { error } = schema.validate(req.body, { abortEarly: false });
    if (error) {
      return res.status(400).json({
        success: false,
        message: "Validation failed",
        errors: error.details.map((d) => d.message),
      });
    }
    next();
  };
}

module.exports = { validators, validate, escapeRegex };

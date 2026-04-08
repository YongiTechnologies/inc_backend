const swaggerJsdoc = require("swagger-jsdoc");

const options = {
  definition: {
    openapi: "3.0.0",
    info: {
      title: "I&C Logistics API",
      version: "1.0.0",
      description: "API for managing logistics tracking, GPS devices, and shipments across Ghana and international routes",
      contact: {
        name: "API Support",
        email: "support@inclogistics.com",
      },
    },
    servers: [
      {
        url: "/api",
        description: "API endpoints",
      },
    ],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "JWT",
          description: "JWT Bearer token from /auth/login (access token)",
        },
        webhookSecret: {
          type: "apiKey",
          in: "header",
          name: "x-webhook-secret",
          description: "Shared secret for GPS provider webhooks",
        },
      },
      schemas: {
        // ─── Primitive schemas ────────────────────────────────────────────────
        Location: {
          type: "object",
          required: ["address", "city", "country"],
          properties: {
            address: {
              type: "string",
              example: "Unit 5, Yiwu International Trade Market",
            },
            city: {
              type: "string",
              example: "Accra",
            },
            country: {
              type: "string",
              example: "Ghana",
            },
            coordinates: {
              type: "array",
              items: { type: "number" },
              minItems: 2,
              maxItems: 2,
              example: [-0.1876, 5.5494],
              description: "[longitude, latitude]",
            },
          },
        },
        User: {
          type: "object",
          properties: {
            id: {
              type: "string",
              example: "507f1f77bcf86cd799439011",
            },
            name: {
              type: "string",
              example: "Kofi Mensah",
            },
            email: {
              type: "string",
              example: "kofi@ghanalogistics.com",
            },
            phone: {
              type: "string",
              example: "+233 26 123 4567",
            },
            role: {
              type: "string",
              enum: ["customer", "employee", "admin"],
              example: "employee",
            },
            isActive: {
              type: "boolean",
              example: true,
            },
            isVerified: {
              type: "boolean",
              example: true,
            },
            createdAt: {
              type: "string",
              format: "date-time",
              example: "2024-01-15T10:30:00Z",
            },
          },
        },
        Shipment: {
          type: "object",
          properties: {
            id: {
              type: "string",
              example: "507f1f77bcf86cd799439012",
            },
            trackingNumber: {
              type: "string",
              example: "GHA-2024-001234",
            },
            customerId: {
              type: "string",
              example: "507f1f77bcf86cd799439011",
            },
            assignedTo: {
              type: "string",
              example: "507f1f77bcf86cd799439010",
            },
            origin: {
              $ref: "#/components/schemas/Location",
            },
            destination: {
              $ref: "#/components/schemas/Location",
            },
            status: {
              type: "string",
              enum: [
                "pending",
                "picked_up",
                "in_transit",
                "customs",
                "out_for_delivery",
                "delivered",
                "failed",
                "returned",
              ],
              example: "in_transit",
            },
            description: {
              type: "string",
              example: "Mixed Clothing & Accessories",
            },
            packageType: {
              type: "string",
              enum: ["document", "parcel", "pallet", "container"],
              example: "container",
            },
            weight: {
              type: "number",
              example: 420,
              description: "Weight in kg",
            },
            quantity: {
              type: "integer",
              example: 8,
            },
            declaredValue: {
              type: "number",
              example: 5000.00,
              description: "Declared value in USD",
            },
            requiresCustoms: {
              type: "boolean",
              example: true,
            },
            isFragile: {
              type: "boolean",
              example: false,
            },
            estimatedDelivery: {
              type: "string",
              format: "date-time",
              example: "2024-02-15T00:00:00Z",
            },
            deliveredAt: {
              type: "string",
              format: "date-time",
              example: "2024-02-10T14:30:00Z",
            },
            createdAt: {
              type: "string",
              format: "date-time",
            },
            updatedAt: {
              type: "string",
              format: "date-time",
            },
          },
        },
        TrackingEvent: {
          type: "object",
          properties: {
            id: {
              type: "string",
              example: "507f1f77bcf86cd799439013",
            },
            shipmentId: {
              type: "string",
              example: "507f1f77bcf86cd799439012",
            },
            updatedBy: {
              type: "object",
              properties: {
                id: {
                  type: "string",
                },
                name: {
                  type: "string",
                },
              },
              example: { id: "507f1f77bcf86cd799439010", name: "Kofi Mensah" },
            },
            status: {
              type: "string",
              enum: [
                "pending",
                "picked_up",
                "in_transit",
                "customs",
                "out_for_delivery",
                "delivered",
                "failed",
                "returned",
              ],
              example: "in_transit",
            },
            location: {
              $ref: "#/components/schemas/Location",
            },
            note: {
              type: "string",
              example: "Cargo loaded and departed.",
              description: "Customer-visible note",
            },
            internalNote: {
              type: "string",
              example: "Auto-logged via GPS update.",
              description: "Staff-only internal note",
            },
            carrier: {
              type: "string",
              example: "Ethiopian Airlines Cargo",
            },
            carrierReference: {
              type: "string",
              example: "ET-CARGO-88821",
            },
            timestamp: {
              type: "string",
              format: "date-time",
              example: "2024-01-20T10:30:00Z",
            },
          },
        },
        GpsDevice: {
          type: "object",
          properties: {
            id: {
              type: "string",
              example: "507f1f77bcf86cd799439014",
            },
            deviceId: {
              type: "string",
              example: "IMEI-123456789",
              description: "Hardware serial or IMEI",
            },
            label: {
              type: "string",
              example: "Tracker-007",
            },
            shipmentId: {
              type: "string",
              nullable: true,
              example: "507f1f77bcf86cd799439012",
            },
            isActive: {
              type: "boolean",
              example: true,
            },
            lastPing: {
              type: "string",
              format: "date-time",
              example: "2024-01-20T10:45:00Z",
            },
            lastCoords: {
              type: "array",
              items: { type: "number" },
              minItems: 2,
              maxItems: 2,
              example: [-0.1876, 5.5494],
              description: "[longitude, latitude]",
            },
            batteryPct: {
              type: "integer",
              minimum: 0,
              maximum: 100,
              example: 85,
            },
            createdAt: {
              type: "string",
              format: "date-time",
            },
            updatedAt: {
              type: "string",
              format: "date-time",
            },
          },
        },
        GpsPing: {
          type: "object",
          properties: {
            id: {
              type: "string",
              example: "507f1f77bcf86cd799439015",
            },
            deviceId: {
              type: "string",
              example: "IMEI-123456789",
            },
            shipmentId: {
              type: "string",
              example: "507f1f77bcf86cd799439012",
            },
            coordinates: {
              type: "array",
              items: { type: "number" },
              minItems: 2,
              maxItems: 2,
              example: [-0.1876, 5.5494],
              description: "[longitude, latitude]",
            },
            accuracy: {
              type: "number",
              example: 15.5,
              description: "Accuracy in metres",
            },
            speed: {
              type: "number",
              example: 45.2,
              description: "Speed in km/h",
            },
            bearing: {
              type: "number",
              example: 180,
              description: "Bearing in degrees (0-360)",
            },
            altitude: {
              type: "number",
              example: 125,
              description: "Altitude in metres",
            },
            batteryPct: {
              type: "integer",
              minimum: 0,
              maximum: 100,
              example: 80,
            },
            provider: {
              type: "string",
              enum: ["traccar", "google", "here", "raw"],
              example: "traccar",
            },
            timestamp: {
              type: "string",
              format: "date-time",
              example: "2024-01-20T10:30:00Z",
            },
          },
        },
        AuditLog: {
          type: "object",
          properties: {
            id: {
              type: "string",
              example: "507f1f77bcf86cd799439016",
            },
            performedBy: {
              type: "object",
              properties: {
                name: {
                  type: "string",
                },
                email: {
                  type: "string",
                },
                role: {
                  type: "string",
                },
              },
              example: {
                name: "Kofi Mensah",
                email: "kofi@ghanalogistics.com",
                role: "employee",
              },
            },
            action: {
              type: "string",
              example: "UPDATE_USER",
            },
            targetModel: {
              type: "string",
              example: "User",
            },
            targetId: {
              type: "string",
              example: "507f1f77bcf86cd799439011",
            },
            details: {
              type: "object",
              example: { name: "Kofi Mensah", role: "admin" },
            },
            ip: {
              type: "string",
              example: "192.168.1.1",
            },
            timestamp: {
              type: "string",
              format: "date-time",
              example: "2024-01-20T10:30:00Z",
            },
          },
        },
        // ─── Response envelope schemas ────────────────────────────────────────
        ApiResponse: {
          type: "object",
          required: ["success", "message"],
          properties: {
            success: {
              type: "boolean",
              example: true,
            },
            message: {
              type: "string",
              example: "Operation successful",
            },
            data: {
              type: "object",
              nullable: true,
              example: {},
            },
          },
        },
        Pagination: {
          type: "object",
          properties: {
            total: {
              type: "integer",
              example: 150,
            },
            page: {
              type: "integer",
              example: 1,
            },
            limit: {
              type: "integer",
              example: 20,
            },
            pages: {
              type: "integer",
              example: 8,
            },
          },
        },
        PaginatedResponse: {
          type: "object",
          properties: {
            success: {
              type: "boolean",
              example: true,
            },
            message: {
              type: "string",
              example: "Data retrieved",
            },
            data: {
              type: "object",
              properties: {
                items: {
                  type: "array",
                  items: { type: "object" },
                },
                pagination: {
                  $ref: "#/components/schemas/Pagination",
                },
              },
            },
          },
        },
        Error400: {
          type: "object",
          properties: {
            success: {
              type: "boolean",
              example: false,
            },
            message: {
              type: "string",
              example: "Validation error: Invalid email format",
            },
            errors: {
              type: "array",
              items: { type: "string" },
              example: ["email is required", "password must be at least 8 characters"],
            },
          },
        },
        Error401: {
          type: "object",
          properties: {
            success: {
              type: "boolean",
              example: false,
            },
            message: {
              type: "string",
              example: "Unauthorized: Invalid or expired token",
            },
          },
        },
        Error403: {
          type: "object",
          properties: {
            success: {
              type: "boolean",
              example: false,
            },
            message: {
              type: "string",
              example: "Forbidden: Insufficient permissions",
            },
          },
        },
        Error404: {
          type: "object",
          properties: {
            success: {
              type: "boolean",
              example: false,
            },
            message: {
              type: "string",
              example: "Not found: Resource does not exist",
            },
          },
        },
        Error409: {
          type: "object",
          properties: {
            success: {
              type: "boolean",
              example: false,
            },
            message: {
              type: "string",
              example: "Conflict: Email already registered",
            },
          },
        },
        Error422: {
          type: "object",
          properties: {
            success: {
              type: "boolean",
              example: false,
            },
            message: {
              type: "string",
              example: "Unprocessable Entity: Invalid status transition",
            },
          },
        },
        Error500: {
          type: "object",
          properties: {
            success: {
              type: "boolean",
              example: false,
            },
            message: {
              type: "string",
              example: "Internal server error",
            },
          },
        },
      },
    },
  },
  apis: ["./src/routes/**/*.js"],
};

module.exports = swaggerJsdoc(options);

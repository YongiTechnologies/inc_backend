# Integration Instructions

## 1. Install new dependencies

```bash
npm install multer xlsx
```

## 2. Register the batch routes in src/app.js

Add these two lines alongside the existing route registrations:

```js
// Add after existing require() block at the top of src/app.js:
const batchRoutes = require("./routes/batch.routes");

// Add after the existing app.use("/api", contactRoutes) line:
app.use("/api", batchRoutes);
```

The relevant section of src/app.js should look like this after the edit:

```js
const authRoutes     = require("./routes/auth.routes");
const trackingRoutes = require("./routes/tracking.routes");
const adminRoutes    = require("./routes/admin.routes");
const employeeRoutes = require("./routes/employee.routes");
const gpsRoutes      = require("./routes/gps.routes");
const dashboardRoutes = require("./routes/dashboard.routes");
const contactRoutes  = require("./routes/contact.routes");
const oauthRoutes    = require("./routes/oauth.routes");
const batchRoutes    = require("./routes/batch.routes");   // ← ADD THIS

// ...existing middleware setup...

app.use("/api/auth",     authRoutes);
app.use("/api/auth",     oauthRoutes);
app.use("/api",          trackingRoutes);
app.use("/api",          gpsRoutes);
app.use("/api/admin",    adminRoutes);
app.use("/api/employee", employeeRoutes);
app.use("/api/dashboard",dashboardRoutes);
app.use("/api",          contactRoutes);
app.use("/api",          batchRoutes);    // ← ADD THIS
```

## 3. File structure added

```
src/
  models/
    Batch.js            ← new
    ShipmentItem.js     ← new
  services/
    batch.service.js    ← new
  controllers/
    batch.controller.js ← new
  routes/
    batch.routes.js     ← new
```

## 4. API Endpoints Summary

### Staff endpoints (require Bearer token, employee or admin role)

| Method | Endpoint                               | Description                          |
|--------|----------------------------------------|--------------------------------------|
| POST   | /api/batches/intake                    | Upload Stage 1 Excel (China intake)  |
| POST   | /api/batches/shipped                   | Upload Stage 2 Excel (departed)      |
| POST   | /api/batches/arrived                   | Upload Stage 3 Excel (arrived Ghana) |
| GET    | /api/batches                           | List all batches (filter by stage)   |
| GET    | /api/batches/held                      | List all held items                  |
| GET    | /api/batches/:id                       | Batch detail + status counts         |
| GET    | /api/batches/:id/items                 | Items in a batch (filter by status)  |
| PATCH  | /api/batches/items/:itemId/reassign    | Reassign held item to another batch  |
| PATCH  | /api/batches/items/:itemId             | Edit item details                    |

### Public endpoints (no auth, rate-limited 30 req/min)

| Method | Endpoint                          | Description                          |
|--------|-----------------------------------|--------------------------------------|
| GET    | /api/tracking/phone/:phone        | Customer looks up items by phone     |
| GET    | /api/tracking/waybill/:waybill    | Look up a single item by waybill no. |

## 5. How to test uploads

Use curl or Postman with multipart/form-data:

```bash
# Stage 1 — Intake
curl -X POST http://localhost:5000/api/batches/intake \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "file=@/path/to/2ND_APRIL_26.xlsx"

# Stage 2 — Shipped
curl -X POST http://localhost:5000/api/batches/shipped \
  -H "Authorization: Bearer YOUR_TOKEN" \
  -F "file=@/path/to/N005-N006_CONTAINER_LIST.xlsx"

# Public lookup by phone
curl http://localhost:5000/api/tracking/phone/0200485487

# Public lookup by waybill
curl http://localhost:5000/api/tracking/waybill/78992390754171
```

## 6. Notes on the existing system

- The existing Shipment model and all existing tracking endpoints are untouched.
- The new ShipmentItem and Batch models are completely separate collections.
- If a customer phone matches an existing User account, the item is linked
  via customerId automatically on upload. No manual action needed.
- Customers can look up their items publicly without needing to log in,
  using just their phone number or waybill number.

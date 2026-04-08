# I&C Logistics — Backend API

Node.js / Express / MongoDB backend for the I&C Logistics platform.
Built by Yongi Technologies.

---

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Set up environment
cp .env.example .env
# Edit .env — add your MONGODB_URI and JWT secrets

# 3. (Optional) Seed the database with demo data
npm run seed

# 4. Start dev server
npm run dev
```

---

## API Reference

### Base URL
`http://localhost:5000/api`

### Auth

| Method | Endpoint            | Auth     | Description                    |
|--------|---------------------|----------|--------------------------------|
| POST   | /auth/register      | Public   | Register new customer account  |
| POST   | /auth/login         | Public   | Login, returns JWT             |
| POST   | /auth/refresh       | Cookie   | Refresh access token           |
| POST   | /auth/logout        | Public   | Clear refresh token cookie     |
| GET    | /auth/me            | Required | Get current user profile       |

### Tracking

| Method | Endpoint                        | Auth              | Description                        |
|--------|---------------------------------|-------------------|------------------------------------|
| GET    | /tracking/:trackingNumber       | Public            | Public shipment tracker            |
| GET    | /shipments/mine                 | Customer          | Customer's own shipments           |
| GET    | /shipments                      | Employee / Admin  | List all shipments (with filters)  |
| POST   | /shipments                      | Employee / Admin  | Create new shipment                |
| GET    | /shipments/:id/tracking         | Employee / Admin  | Full tracking detail (with notes)  |
| POST   | /shipments/:id/tracking         | Employee / Admin  | Log a tracking checkpoint          |
| GET    | /stats                          | Admin             | Dashboard stats                    |

### Admin

| Method | Endpoint            | Auth  | Description           |
|--------|---------------------|-------|-----------------------|
| GET    | /admin/users        | Admin | List all users        |
| PATCH  | /admin/users/:id    | Admin | Update user           |
| GET    | /admin/audit-logs   | Admin | View audit trail      |

---

## Status Flow

Shipment status follows a strict transition graph — you cannot skip steps
or reverse terminal statuses:

```
pending → picked_up → in_transit → customs → out_for_delivery → delivered
                ↘                                             ↘
                 failed → in_transit (retry) or returned
```

---

## Environment Variables

| Variable         | Required | Description                              |
|------------------|----------|------------------------------------------|
| MONGODB_URI      | ✅       | MongoDB connection string                |
| DB_NAME          | ✅       | Database name (default: ghana_logistics) |
| JWT_SECRET       | ✅       | Access token secret (min 64 chars)       |
| JWT_REFRESH_SECRET | ✅    | Refresh token secret (min 64 chars)      |
| JWT_EXPIRES_IN   |          | Access token TTL (default: 15m)          |
| PORT             |          | Server port (default: 5000)              |
| NODE_ENV         |          | production / development                 |
| ALLOWED_ORIGINS  |          | Comma-separated CORS origins             |
| SMTP_HOST        |          | Email host (optional)                    |
| SMTP_PORT        |          | Email port (optional)                    |
| SMTP_USER        |          | Email username (optional)                |
| SMTP_PASS        |          | Email password (optional)                |

Generate JWT secrets:
```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
```

---

## Request / Response Format

All responses follow:
```json
{
  "success": true,
  "message": "Human readable message",
  "data": { }
}
```

### Create Shipment — POST /api/shipments
```json
{
  "customerId": "64a1b2c3d4e5f6a7b8c9d0e1",
  "origin": {
    "address": "Unit 5, Yiwu Trade Market",
    "city": "Yiwu",
    "country": "China",
    "coordinates": [120.0736, 29.3064]
  },
  "destination": {
    "address": "Kantamanto Market, Ring Road Central",
    "city": "Accra",
    "country": "Ghana"
  },
  "description": "Mixed Clothing & Accessories",
  "packageType": "container",
  "weight": 420,
  "quantity": 8,
  "requiresCustoms": true,
  "estimatedDelivery": "2026-04-15T00:00:00Z"
}
```

### Log Tracking Event — POST /api/shipments/:id/tracking
```json
{
  "status": "in_transit",
  "location": {
    "address": "Kotoka International Airport, Cargo Terminal",
    "city": "Accra",
    "country": "Ghana"
  },
  "note": "Arrived in Ghana. Transferred to customs.",
  "internalNote": "Ref: ET-CARGO-88821 — verify manifest",
  "carrier": "Ethiopian Airlines Cargo",
  "carrierReference": "ET-CARGO-88821"
}
```

---

## Project Structure

```
ghana-logistics-backend/
├── server.js                  # Entry point
├── src/
│   ├── app.js                 # Express setup, middleware, routes
│   ├── config/
│   │   └── db.js              # MongoDB connection
│   ├── models/
│   │   ├── User.js
│   │   ├── Shipment.js
│   │   ├── TrackingEvent.js
│   │   └── AuditLog.js
│   ├── routes/
│   │   ├── auth.routes.js
│   │   ├── tracking.routes.js
│   │   └── admin.routes.js
│   ├── controllers/
│   │   ├── auth.controller.js
│   │   ├── tracking.controller.js
│   │   └── admin.controller.js
│   ├── services/
│   │   ├── tracking.service.js  # Core business logic
│   │   ├── email.service.js
│   │   └── audit.service.js
│   ├── middleware/
│   │   ├── auth.middleware.js   # JWT + RBAC
│   │   └── errorHandler.js
│   ├── utils/
│   │   ├── response.js
│   │   ├── jwt.js
│   │   └── validators.js
│   └── scripts/
│       └── seed.js             # Demo data
├── .env.example
└── package.json
```

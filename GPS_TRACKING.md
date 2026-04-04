# GPS Tracking — How It Works

## Overview

The GPS system is **fully optional**. If no GPS device is assigned to a shipment,
everything falls back to manual checkpoint logging by staff. Both modes work
side-by-side — you can have GPS on the local Ghana leg and manual on the China leg.

---

## Physical Setup

```
[GPS Tracker Device]  →  [GPS Provider API]  →  [Your Backend]  →  [Frontend Map]
  (in the shipment)       (Traccar / Google)    /api/gps/webhook    polls every 30s
```

**The physical tracker** is a small SIM-enabled IoT device you place inside
(or cable-tie to) the shipment. It pings its coordinates every 1–5 minutes.

**Recommended hardware:**
- Concox GT06N — cheap, widely used, works with Traccar (~$15–30)
- Teltonika FMB920 — better accuracy, longer battery (~$50–80)
- Any device that supports GPRS/4G and can report to a server

**Recommended GPS server (free/cheap):**
- [Traccar](https://www.traccar.org/) — open-source, self-hostable, free
  Supports 200+ device protocols out of the box.

---

## Supported Providers

| Provider       | Key in .env     | Notes                                        |
|----------------|-----------------|----------------------------------------------|
| Traccar        | `traccar`       | Best option — free, self-host, 200+ devices  |
| Google Fleet   | `google`        | Maps Platform — paid, enterprise             |
| HERE Tracking  | `here`          | Paid, good for logistics                     |
| Raw / Custom   | `raw`           | Your own hardware POSTing directly           |

Set `GPS_PROVIDER=traccar` (or whichever) in your `.env`.

---

## Setup Steps

### 1. Set environment variables

```env
GPS_WEBHOOK_SECRET=some_long_random_secret
GOOGLE_MAPS_API_KEY=your_key_here         # for reverse geocoding + frontend map
GPS_PROVIDER=traccar
```

### 2. Configure your GPS provider to webhook to your server

For **Traccar**:
- Go to Settings → Notifications → Add webhook
- URL: `https://yourdomain.com/api/gps/webhook/traccar`
- Header: `x-webhook-secret: your_secret_here`

For **raw devices** (custom firmware):
- Program the device to POST to:
  `https://yourdomain.com/api/gps/webhook/raw`
- Payload:
  ```json
  {
    "deviceId": "DEVICE_IMEI_OR_SERIAL",
    "lat": 5.6037,
    "lng": -0.1870,
    "speed": 42.5,
    "bearing": 180,
    "batteryPct": 87
  }
  ```
- Header: `x-webhook-secret: your_secret_here`

### 3. Register the device + assign to a shipment

```bash
# Assign device IMEI-123456 to a shipment
POST /api/admin/devices/IMEI-123456/assign
Authorization: Bearer <admin_token>
{ "shipmentId": "64a1b2c3d4e5f6a7b8c9d0e1" }
```

### 4. That's it — pings will now appear on the map

The frontend polls `GET /api/tracking/:trackingNumber/live` every 30 seconds
and renders the trail on the Google Map.

---

## API Endpoints

| Method | Endpoint                                  | Auth          |
|--------|-------------------------------------------|---------------|
| POST   | /api/gps/webhook/:provider                | Webhook secret|
| GET    | /api/tracking/:trackingNumber/live        | Public        |
| GET    | /api/admin/devices                        | Admin JWT     |
| POST   | /api/admin/devices/:deviceId/assign       | Admin JWT     |
| POST   | /api/admin/devices/:deviceId/unassign     | Admin JWT     |

---

## How Automatic TrackingEvents Work

Every GPS ping is stored as a raw `GpsPing`. But we don't want to spam the
customer-facing timeline with a ping every 5 minutes.

Instead, the system auto-logs a new `TrackingEvent` only when the shipment
has moved **50+ km** since the last event. This keeps the timeline clean and
meaningful while still updating the map in real-time.

You can change the threshold in `gps.service.js`:
```js
const AUTO_EVENT_DISTANCE_THRESHOLD_M = 50_000; // 50 km
```

---

## Frontend Integration

```jsx
import ShipmentMap from "./frontend-components/ShipmentMap";

// Drop into any page — handles everything internally
<ShipmentMap
  trackingNumber="GLC-ABCD1234EF"
  height="420px"
  pollInterval={30000}   // ms — how often to refresh live position
/>
```

The map shows:
- 🟢 Origin (green marker)
- 🔴 Destination (red marker)
- 🟣 Manual checkpoints (purple markers, click for details)
- 🔵 GPS trail (blue polyline)
- 🔵 Live position (pulsing blue dot)

---

## Without GPS (Fallback)

If `liveData.hasGps` is false, the map still renders with:
- Origin + destination markers
- Manual checkpoint markers from the timeline
- No polyline or live dot

This means the map is always useful, even without a physical GPS device.

# ShipmentItem Unification Migration Guide

## Goal: Single Tracking Model

**Migrate from two separate tracking models to a unified `ShipmentItem`-only system.**

### Why Unify?

The original `Shipment` model was built before the Excel bulk-upload system existed. The business now works as:
- Customers search by **phone number** → see ALL their items
- Customers search by **tracking/waybill number** → see specific item
- Staff update status on individual items
- Excel bulk upload is the primary intake method

Having two models (`Shipment` and `ShipmentItem`) creates:
- Duplicate code for tracking logic
- Split customer views (some items in one model, some in another)
- Confusing dashboard stats
- Extra maintenance burden

---

## Current State (Before Unification)

### Two Parallel Systems

| Aspect | Shipment (Old) | ShipmentItem (New) |
|--------|----------------|------------------- |
| **Creation** | Staff creates one-by-one via API | Excel bulk upload |
| **Tracking** | `Shipment` + `TrackingEvent` models | `ShipmentItem` with embedded status |
| **Statuses** | `pending` → `delivered` (8 statuses) | All 8 + `in_warehouse`, `shipped`, `held` |
| **Customer Lookup** | By `trackingNumber` only | By `phone` or `waybillNo` |
| **Events/Timeline** | Separate `TrackingEvent` collection | Status history in `stageHistory` array |
| **Primary Use** | Legacy, manual entry | Current Excel-based workflow |

### ShipmentItem Status Enum (Unified)

```javascript
enum: [
  // Traditional workflow (from Shipment)
  "pending",
  "picked_up",
  "in_transit",
  "customs",
  "out_for_delivery",
  "delivered",
  "failed",
  "returned",
  // Batch workflow (Excel-based)
  "in_warehouse",
  "shipped",
  "held",
]
```

---

## Migration Plan

### Phase 1: Prepare ShipmentItem for Full Tracking

**Status**: COMPLETED

- [x] ShipmentItem has full status enum
- [x] Public tracking by phone/waybill works
- [x] Batch upload workflow (intake → shipped) works
- [x] Auto-hold logic for missing items works
- [x] Dashboard `arrived` references cleaned up

### Phase 2: Add Missing Fields to ShipmentItem

**Status**: COMPLETED

- [x] ShipmentItem has all fields from Shipment model
- [x] Origin/destination location schemas in place
- [x] Delivery fields (photo, signature, deliveredAt) added
- [x] Package details (weight, dimensions, declaredValue) added
- [x] stageHistory extended with all TrackingEvent fields

### Phase 3: Create Migration Script

**Status**: COMPLETED

- [x] Migration script created at `src/scripts/migrate-shipments-to-items.js`
- [x] Script migrates Shipment + TrackingEvent → ShipmentItem.stageHistory
- [x] Dry-run mode supported via DRY_RUN=true env var
- [x] Safe migration (does not delete old records)

### Phase 4: Update Services

**Status**: COMPLETED

- [x] tracking.service.js rewritten to use ShipmentItem
- [x] tracking.service functions renamed (getTrackingByNumber, updateItemStatus, etc.)
- [x] STATUS_TRANSITIONS extended for batch workflow
- [x] gps.service.js updated to use ShipmentItem.stageHistory
- [x] Dashboard controller updated to use unified ShipmentItem model

### Phase 5: Update Controllers

**Status**: COMPLETED

- [x] tracking.controller.js updated with new method names
- [x] updateItemStatus replaces addTrackingEvent
- [x] createItem/createShipmentItem for manual entry
- [x] gps.controller.js updated to use ShipmentItem
- [x] dashboard.controller.js unified for ShipmentItem

### Phase 6: Deprecate Old Models

**Status**: IN PROGRESS

- [x] Shipment.js marked as deprecated
- [x] TrackingEvent.js marked as deprecated
- [ ] Remove Shipment/TrackingEvent imports from remaining files
- [ ] Update all tests to use ShipmentItem

### Phase 7: Cleanup

**TODO**:
- [ ] Delete `Shipment.js` model (after verification period)
- [ ] Delete `TrackingEvent.js` model
- [ ] Merge `tracking.service.js` into `batch.service.js` (optional)
- [ ] Merge `tracking.controller.js` into `batch.controller.js` (optional)
- [ ] Update `app.js` route registration
- [ ] Update documentation

| Field | Current Location | Action |
|-------|-----------------|--------|
| `origin` (address, city, country) | Shipment | Add to ShipmentItem |
| `destination` (already has `destinationCity`) | Shipment | Expand to full location |
| `packageType` | Shipment | Add to ShipmentItem |
| `weight` | Shipment | Add to ShipmentItem |
| `dimensions` | Shipment | Add to ShipmentItem |
| `declaredValue` | Shipment | Add to ShipmentItem |
| `estimatedDelivery` | Shipment | Add to ShipmentItem |
| `deliveredAt` | Shipment | Add to ShipmentItem |
| `deliveryPhoto` | Shipment | Add to ShipmentItem |
| `deliverySignature` | Shipment | Add to ShipmentItem |
| `specialInstructions` | Shipment | Add to ShipmentItem |
| `assignedTo` | Shipment | Already on ShipmentItem as `reassignedTo` |
| Tracking events/timeline | TrackingEvent | Use `stageHistory` array |

### Phase 3: Create Migration Script

**TODO**: Script to migrate existing `Shipment` records to `ShipmentItem`:

```javascript
// For each Shipment:
// 1. Create ShipmentItem with mapped fields
// 2. Set waybillNo = trackingNumber
// 3. Map customerId, status, origin, destination
// 4. Import TrackingEvents into stageHistory array
// 5. Verify count matches
// 6. (Optional) Archive or delete Shipment
```

### Phase 4: Update Services

**TODO**: Replace `tracking.service.js` functions to use `ShipmentItem`:

| Function | Current Model | New Model |
|----------|--------------|-----------|
| `getTrackingByNumber` | Shipment + TrackingEvent | ShipmentItem |
| `getTrackingInternal` | Shipment + TrackingEvent | ShipmentItem |
| `addTrackingEvent` | TrackingEvent | ShipmentItem.stageHistory push |
| `createShipment` | Shipment | ShipmentItem (manual staff entry) |
| `updateShipment` | Shipment | ShipmentItem |
| `listShipments` | Shipment | ShipmentItem |
| `getStats` | Shipment | ShipmentItem |

### Phase 5: Update Routes

**TODO**: 
- Merge `/api/tracking` routes with `/api/batches` routes
- Single endpoint for item lookup by tracking number
- Single endpoint for phone lookup (returns all items)
- Single endpoint for staff to list/search items

### Phase 6: Deprecate Old Models

**TODO**:
- Mark `Shipment` model as deprecated (add warning comments)
- Mark `TrackingEvent` model as deprecated
- Update dashboard controller to use ShipmentItem only
- Remove `Shipment` imports from all files

### Phase 7: Cleanup

**TODO**:
- Delete `Shipment.js` model (after verification period)
- Delete `TrackingEvent.js` model
- Delete `tracking.service.js`
- Merge `tracking.controller.js` into `batch.controller.js`
- Merge `tracking.routes.js` into `batch.routes.js`
- Update `app.js` route registration

---

## Field Mapping: Shipment → ShipmentItem

| Shipment Field | ShipmentItem Field | Notes |
|----------------|------------------- |-------|
| `trackingNumber` | `waybillNo` | Use as primary lookup key |
| `customerId` | `customerId` | Direct mapping |
| `status` | `status` | Direct mapping (use unified enum) |
| `origin.address` | `origin.address` | New field to add |
| `origin.city` | `origin.city` | New field to add |
| `origin.country` | `origin.country` | New field to add |
| `destination.address` | Add `destinationAddress` | Expand beyond just city |
| `destination.city` | `destinationCity` | Already exists |
| `destination.country` | Add `destinationCountry` | New field |
| `description` | `productDescription` | Rename |
| `packageType` | `packageType` | Add to ShipmentItem |
| `weight` | `weight` | Add to ShipmentItem |
| `dimensions` | `dimensions` | Add to ShipmentItem |
| `quantity` | `quantity` | Already exists |
| `declaredValue` | `declaredValue` | Add to ShipmentItem |
| `estimatedDelivery` | `estimatedDelivery` | Add to ShipmentItem |
| `deliveredAt` | `deliveredAt` | Add to ShipmentItem |
| `deliveryPhoto` | `deliveryPhoto` | Add to ShipmentItem |
| `deliverySignature` | `deliverySignature` | Add to ShipmentItem |
| `specialInstructions` | `specialInstructions` | Add to ShipmentItem |
| `assignedTo` | `reassignedTo` | Rename, already exists |
| `createdAt` | `createdAt` | Auto from timestamps |
| `updatedAt` | `updatedAt` | Auto from timestamps |
| N/A | `stageHistory` | Import from TrackingEvents |
| N/A | `intakeBatch` | Keep for Excel workflow |
| N/A | `shippedBatch` | Keep for Excel workflow |
| N/A | `customerPhone` | Keep for phone lookup |
| N/A | `invoiceNo` | Keep for Excel workflow |
| N/A | Financial fields | Keep for Excel workflow |

---

## Tracking Events → Stage History

### Current TrackingEvent Schema

```javascript
{
  shipmentId,      // → Remove, use ShipmentItem._id
  updatedBy,       // → Keep in stageHistory
  status,          // → Keep in stageHistory
  location,        // → Keep in stageHistory
  note,            // → Keep in stageHistory
  internalNote,    // → Keep in stageHistory
  carrier,         // → Keep in stageHistory
  carrierReference,// → Keep in stageHistory
  timestamp,       // → Keep as updatedAt in stageHistory
}
```

### Target Stage History Schema (already exists)

```javascript
stageHistory: [{
  stage:     String,      // Map from status
  status:    String,      // Direct from TrackingEvent.status
  batchId:   ObjectId,    // Optional, for batch workflow
  updatedAt: Date,        // From TrackingEvent.timestamp
  note:      String,      // From TrackingEvent.note
}]
```

May need to expand `stageHistorySchema` to include:
- `location` (address, city, country)
- `internalNote`
- `carrier`
- `carrierReference`
- `updatedBy`

---

## API Endpoint Consolidation

### Before (Two Separate Route Files)

| Old Endpoint | New Endpoint | Notes |
|--------------|--------------|-------|
| `GET /api/tracking/:trackingNumber` | `GET /api/items/:waybill` | Public, rename |
| `GET /api/tracking/phone/:phone` | `GET /api/items/phone/:phone` | Public, keep |
| `GET /api/tracking/waybill/:waybill` | `GET /api/items/:waybill` | Public, merge |
| `GET /api/shipments/mine` | `GET /api/items/mine` | Customer, keep |
| `GET /api/shipments` | `GET /api/items` | Staff, keep |
| `POST /api/shipments` | `POST /api/items` | Staff, manual entry |
| `PATCH /api/shipments/:id` | `PATCH /api/items/:id` | Staff, keep |
| `POST /api/shipments/:id/tracking` | `PATCH /api/items/:id/status` | Staff, status update |
| `GET /api/shipments/:id/tracking` | `GET /api/items/:id` | Staff, full detail |

### Batch Endpoints (Keep Most)

| Endpoint | Action |
|----------|--------|
| `POST /api/batches/intake` | Keep - Excel intake upload |
| `POST /api/batches/shipped` | Keep - Excel packing list upload |
| `GET /api/batches` | Keep - List batches |
| `GET /api/batches/:id` | Keep - Batch detail |
| `GET /api/batches/:id/items` | Keep - Items in batch |
| `GET /api/batches/held` | Keep - Held items list |
| `GET /api/batch-shipments` | Merge into `/api/items` |
| `GET /api/batch-shipments/mine` | Merge into `/api/items/mine` |
| `PATCH /api/batches/items/:itemId` | Keep - Staff correction |
| `PATCH /api/batches/items/:itemId/reassign` | Keep - Reassign held |

---

## Database Migration Script (Outline)

```javascript
// scripts/migrate-shipments-to-items.js

const Shipment = require('./src/models/Shipment');
const TrackingEvent = require('./src/models/TrackingEvent');
const ShipmentItem = require('./src/models/ShipmentItem');

async function migrate() {
  const shipments = await Shipment.find().populate('customerId');
  
  for (const shipment of shipments) {
    // 1. Get all tracking events for this shipment
    const events = await TrackingEvent.find({ 
      shipmentId: shipment._id 
    }).sort({ timestamp: 1 });
    
    // 2. Build stageHistory from events
    const stageHistory = events.map(event => ({
      stage: mapStatusToStage(event.status),
      status: event.status,
      updatedAt: event.timestamp,
      note: event.note,
      location: event.location,
      internalNote: event.internalNote,
      updatedBy: event.updatedBy,
      carrier: event.carrier,
      carrierReference: event.carrierReference,
    }));
    
    // 3. Create ShipmentItem
    await ShipmentItem.create({
      waybillNo: shipment.trackingNumber,
      customerId: shipment.customerId._id,
      customerPhone: shipment.customerId.phone,
      status: shipment.status,
      origin: shipment.origin,
      destinationCity: shipment.destination.city,
      destinationAddress: shipment.destination.address,
      destinationCountry: shipment.destination.country,
      productDescription: shipment.description,
      packageType: shipment.packageType,
      weight: shipment.weight,
      dimensions: shipment.dimensions,
      quantity: shipment.quantity,
      declaredValue: shipment.declaredValue,
      estimatedDelivery: shipment.estimatedDelivery,
      deliveredAt: shipment.deliveredAt,
      deliveryPhoto: shipment.deliveryPhoto,
      deliverySignature: shipment.deliverySignature,
      specialInstructions: shipment.specialInstructions,
      reassignedTo: shipment.assignedTo,
      stageHistory,
      // Mark as migrated from traditional shipment
      migratedFrom: 'Shipment',
    });
    
    console.log(`Migrated: ${shipment.trackingNumber}`);
  }
  
  console.log(`Migration complete. ${shipments.length} records migrated.`);
}

function mapStatusToStage(status) {
  // Map traditional statuses to stage names
  const stageMap = {
    pending: 'pending',
    picked_up: 'in_transit',
    in_transit: 'in_transit',
    customs: 'customs',
    out_for_delivery: 'out_for_delivery',
    delivered: 'delivered',
    failed: 'failed',
    returned: 'returned',
  };
  return stageMap[status] || 'pending';
}

migrate().catch(console.error);
```

---

## Testing Checklist

### Before Migration
- [ ] Backup database
- [ ] Document current record counts (Shipment, TrackingEvent, ShipmentItem)
- [ ] Test all current endpoints work

### After Phase 2 (Add Fields)
- [ ] ShipmentItem schema has all required fields
- [ ] Indexes added for new lookup patterns
- [ ] Validation rules in place

### After Phase 3 (Migration Script)
- [ ] Run migration on staging database first
- [ ] Verify record counts match
- [ ] Spot-check random records for data integrity
- [ ] Test phone lookup returns migrated items
- [ ] Test tracking number lookup works for migrated items

### After Phase 4-5 (Services & Routes)
- [ ] Public tracking works for both old and new items
- [ ] Customer dashboard shows all items
- [ ] Staff can update status on all items
- [ ] Excel upload workflow still works
- [ ] Batch stats are correct

### After Phase 6-7 (Deprecation & Cleanup)
- [ ] No code imports `Shipment` or `TrackingEvent`
- [ ] All endpoints use `ShipmentItem`
- [ ] Dashboard stats correct
- [ ] Delete old models after verification period

---

## Rollback Plan

If migration fails:
1. Keep `Shipment` and `TrackingEvent` models intact
2. Revert `app.js` to use old route files
3. Restore from backup if data corruption occurred
4. Debug on staging, retry later

---

## Timeline Estimate

| Phase | Effort | Risk |
|-------|--------|------|
| Phase 2: Add Fields | 1-2 hours | Low |
| Phase 3: Migration Script | 2-3 hours | Medium |
| Phase 4: Update Services | 3-4 hours | Medium |
| Phase 5: Update Routes | 2-3 hours | Medium |
| Phase 6: Deprecate | 1-2 hours | Low |
| Phase 7: Cleanup | 1-2 hours | Low |
| Testing | 4-6 hours | - |
| **Total** | **14-22 hours** | - |

---

## Notes

- The `waybillNo` field becomes the primary tracking identifier (replaces `trackingNumber`)
- Phone number lookup is now the primary customer-facing feature
- Staff can still manually create items for edge cases (use same `/api/items` endpoint)
- Excel bulk upload remains the primary intake method
- Batch metadata (`intakeBatch`, `shippedBatch`) stays for historical tracking

---

## Related Files

See `PATCH_NOTES.md` for previous migration work (Fixes 1-3).

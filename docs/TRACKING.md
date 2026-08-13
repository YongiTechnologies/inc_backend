# How tracking works

This explains what customers type into the tracker, what they get back, and what
staff need to do when a shipment has no phone number on it.

---

## The problem this solves

One tracking number does not always belong to one customer.

On a consolidated shipment, the supplier gives several customers' goods the same
tracking number. In the April sheets, tracking number `13143415511` covers **nine
different customers**, and `15918654152` covers **six**, spread across three
separate uploads.

The system used to assume a tracking number belonged to exactly one person. That
caused two things to go wrong:

- On upload, only the first customer on a shared number was saved. The other
  eight were thrown away — their parcels never entered the system at all.
- When a later packing list arrived, it overwrote the saved customer's name,
  destination, CBM and invoice figures with a different customer's details.

A shipment is now identified by **tracking number + customer**, not by tracking
number alone, so every customer on a shared number is kept separately.

---

## What a customer types

The tracking page has two boxes:

| Box | Required? | What goes in it |
|---|---|---|
| Tracking number | Yes | One or more numbers, separated by commas |
| Phone number or shipping mark | Only when asked | `0244123456`, or a mark like `ACC-28672` |

### Normal case — the number belongs to one customer

They type the tracking number, leave the second box empty, and press **Track
Item**. Nothing has changed for them.

### Shared case — the number covers several customers

They type the tracking number and leave the second box empty. Instead of showing
someone else's shipment, the page says:

> **More than one shipment**
> Tracking number 15918654152 covers 6 customers' goods. Enter your phone number
> or shipping mark above to see yours.

Underneath is a list of the shipments on that number, with names and phone
numbers partly hidden:

```
K••••• M••••••     0547•••790     TAMALE      Shipped
S•••••             0265•••300     ACCRA       Shipped
```

That is enough for a customer to recognise their own entry, and not enough to
learn anyone else's details.

The customer then types their phone number (or shipping mark) into the second box
and searches again. They see only their own shipment.

---

## Three ways to search

**1. By tracking number**
The main route. Add a phone number or shipping mark when the number is shared.

**2. By phone number**
Lists everything for that phone, grouped by status. Accepts any Ghanaian format:
`0244123456`, `+233244123456`, `233244123456`, or the bare 9 digits `244123456`.

**3. By shipping mark**
New. For customers whose sheets never carried a phone number — they are recorded
under a mark like `ACC-28672`, `KSI-5487` or `ANGIE` instead. Spelling is
forgiving: `TAM311333`, `TAM-311333` and `tam-311333` all find the same customer.

---

## Shipping marks: what changed

Staff write **either** a phone number **or** a shipping mark into the CONTACT
column of the spreadsheet. The system used to read that column as a phone number
only, so a value like `ACC-28672` was discarded and the row was left with no way
to identify its owner.

Marks are now read and stored. Across the six April sheets, every single row that
had no phone number turned out to have a mark — so nothing is left unidentifiable.

A cell that holds **both**, such as `0242582198 Priscilla Aboni`, is still read as
a phone number. The mark is only used when no real phone number can be found.

---

## For staff: shipments still missing a phone

A shipment recorded under a shipping mark can only be tracked by that mark until
someone adds a phone number to it. Those rows are flagged.

To see them:

```
GET /api/items?needsPhone=true
```

Adding a phone number to one of these is worth doing — the customer can then track
by phone like everyone else, and the next upload will match them automatically.

The upload preview also reports two counts before anything is saved:

- `needsPhone` — rows on this sheet with no phone number
- `sharedWaybills` — tracking numbers on this sheet used by more than one customer

---

## API reference

```
GET /api/tracking/{trackingNumber}
GET /api/tracking/{trackingNumber}?phone=0244123456
GET /api/tracking/{trackingNumber}?mark=ACC-28672
GET /api/tracking/phone/{phone}
GET /api/tracking/mark/{mark}
GET /api/tracking/waybill/{waybill}?phone=&mark=
```

A shared number searched without `phone` or `mark` returns **HTTP 200** with:

```json
{
  "success": true,
  "message": "This tracking number covers 6 shipments. Enter your phone number or shipping mark to see yours.",
  "data": {
    "ambiguous": true,
    "total": 6,
    "choices": [
      { "customerName": "K••••• M••••••", "customerPhone": "0547•••790",
        "shippingMark": null, "destinationCity": "TAMALE", "status": "shipped" }
    ],
    "items": []
  }
}
```

It is deliberately 200 and not a 3xx, so browser clients do not treat a normal
disambiguation prompt as a failed request.

If `phone` or `mark` is supplied but matches nothing on that number, the response
is **404** — that is a wrong identifier, not an unknown tracking number.

---

## One-time setup

Existing records were saved before customer identity existed, so they need a
one-off backfill. Run it once, against a backed-up database:

```bash
npm run backfill-customer-key -- --dry-run   # report only, writes nothing
npm run backfill-customer-key                # apply
```

It derives each record's identity from what it already holds, recovers shipping
marks that the old parser discarded, and prints how many live tracking numbers
turn out to be shared.

Parcels that were dropped on upload before this fix can be recovered by
re-uploading the original intake sheets — the rows that were previously discarded
will now be created.

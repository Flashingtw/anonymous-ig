# Manual upward number correction

The studio exposes a collapsed owner-only settings area for correcting the last confirmed number upwards. It states the next number and warns that skipped numbers cannot be reused. No send record or image is fabricated or rewritten.

POST `/api/admin/studio/send/number` accepts `revision` and integer `lastNumber` (maximum 1,000,000,000). Existing authentication, enabled checks, owner authorization and CSRF are required. A D1 transaction rechecks the enabled owner and absence of an editing/prepared batch, uses the shared progress revision for concurrency control, and updates the counter with a `send_number_adjust` audit containing old/new values. Audit failure rolls back everything. Existing drafts preview the new next number when reopened.

No new migration or dependency. Local-only implementation; not deployed.

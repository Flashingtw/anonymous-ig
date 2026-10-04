# Multiple saved send batches and submission pagination

Local implementation only; no production migration or deployment performed.

## Batches

- Save multiple team-shared batches (1–10 images each). `batchId: null` creates a new batch; a concrete ID edits that batch. Ambiguous mutations without an ID are rejected when multiple batches exist.
- Saved images are reserved by submission identity, not version ID. They disappear from ready selection immediately. A database trigger prevents reuse in another editing/prepared batch. Cancel releases unconfirmed images; removing an image from an editing batch also releases it.
- With 0012 and IG enabled, multiple batches can reserve final numbers. The lock action takes a publication time, atomically reserves the next contiguous range and creates a queue placeholder. It is irreversible: no cancellation, reset, reordering or manual confirmation. Once PNG/JPEG uploads complete, the same browser action activates the queue. Failed/incomplete uploads retain their reserved range and can resume. Cron cannot skip an incomplete, failed or future-dated head batch.
- Retain global revision/CAS, authorization, CSRF, audit, immutable image snapshots and existing cleanup protections. No number advances on save or download.
- Default caption number lines refresh when opening an editing batch after progress changes; changed defaults are saved before preparation. Custom captions remain untouched.

## Migration

`0011_multiple_send_batches.sql` drops the one-active-batch index and adds cross-batch reservation protection. `0012_automatic_locked_batches.sql` adds automatic-publication metadata, replaces the one-prepared index with unique reserved numbers, and adds database-level irreversible lock guards. Existing rows are preserved. Apply only through separately approved rollout after 0010; preserve production settings and R2 bindings.

Existing manual prepared batches remain manual (no silent migration into auto-publishing). Finish or explicitly resolve them before enabling new automatic locks. With IG disabled, the old manual workflow remains available for rollback compatibility; new automatic locks are rejected. Disabling IG never unlocks or renumbers existing automatic batches.

The visible next number is the first unreserved number; the last published number advances only on successful publication. Default captions are renumbered again by the server at lock time; custom captions are preserved. Safe publication errors retry without changing the reservation. An ambiguous Meta result remains blocked for operator reconciliation rather than risking duplicate posting.

## Submission list

The page still fetches at most 100 entries per request, but “載入更多投稿” continues to subsequent pages without a total cap. The cursor follows `(created_at, id)` rather than an offset, so reviewing preceding entries cannot shift the page. The badge shows total pending submissions. Empty/end states hide the button; fetch failure preserves the current list and permits retry.

Verification covers multiple batches, duplicate reservation, cancellation release, CAS/audit rollback, serial numbering and a 235-submission paginated list. Existing auth and moderation permission checks are unchanged.

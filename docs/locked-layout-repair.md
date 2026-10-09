# Locked batch layout repair

Locked automatic batches retain their numbers, text, source version, order,
caption and schedule. A failed render must not force cancellation or renumbering.

## Eligibility and storage

Migration `0015_send_layout_repairs.sql` adds append-only geometry overrides,
a guarded eligibility view and atomic audit/revision triggers. It does not alter
existing rows or weaken the locked-batch/image-version triggers. The latest
override is used by current batch reads and the shared preview/PNG renderer.

Only an incomplete item (no final PNG, unconfirmed) in an automatic prepared batch
with queue status `none` is eligible. The whole batch must have no IG staged
images/uploads, containers, lease, attempted/uncertain publication or media ID.
Session, CSRF and enabled checks are retained. Owner/admin/moderator may repair.
The server accepts only body/number coordinates and font sizes, not editable text
or a number label. A trigger rechecks eligibility and the global send revision
atomically with the append-only repair and audit; stale/conflicting writes fail.

Geometry-only audit history is lightweight and contains no duplicate submission
text or PNG. Existing seven-day PNG/version cleanup and publication records are
unchanged. Saved final images cannot be repaired or replaced through this API.

## User flow

Open an incomplete locked batch, select **修復排版**, adjust geometry or choose
**自動排版**, then **保存修復**. Preview/export validation must pass before saving.
Saving does not generate/upload an image, enqueue publication or advance numbers.
Use the existing **產圖／繼續產圖與上傳** action afterward. Stale saves retain the
unsaved geometry; close and reload the batch before trying again.

New editing batches pre-render all numbered PNG candidates before irreversible
locking. Font/background/render/size failures leave the batch editable, without
reserving numbers or adding an IG queue row. The global revision still protects
the subsequent lock from races with another administrator.

## Rollout and verification

Run check, full tests, check:rollout, build, audit and studio-visual-review. The
suite covers schema-only preservation, actual workerd D1, disabled/session/CSRF,
geometry-only input, completed/staged/queued refusal, CAS/audit rollback and the
browser overlap → repair → final PNG flow on desktop/mobile.

For an approved deployment, obtain a fresh private D1 Time Travel bookmark, verify
only 0015 is pending and apply the additive migration once. Confirm FK integrity,
all existing table fingerprints and the empty new history table. Then deploy the
approved clean checkpoint, preserving live variables/secrets, private R2, D1,
auth flags and Cron. Check protected APIs, public/admin pages and deployed assets.
Do not repair existing batches, upload images or invoke IG automatically during
deployment; the administrator explicitly performs those actions afterward.

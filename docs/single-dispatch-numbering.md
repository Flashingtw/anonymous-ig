# 本次發送、連續編號與圖片清理

Status: local implementation only; production migration, initial counter verification,
cleanup schedule and deployment require separate approval. Branch:
`codex/single-dispatch-numbering`, based on `71e62be3d4ccb2fa9223b245c710e72607886861`.
The existing uncommitted studio navigation/save-return UI changes are retained.

## Operator flow

1. Create/edit an image and add it to 待發送. The number is a read-only preview;
   its position and size remain editable. Original submission content is unchanged.
2. Select 1–10 images, order them and save 本次發送. Only one shared active group
   exists. Saving does not consume numbers. Existing saved image versions stay pinned.
   New groups default to the supplied 🔒 / 日期📆 / 🔥匿名🔥 caption template, using
   Taiwan's current date and weekday and one #number line per selected image.
   Untouched templates follow selection changes; custom captions and already prepared
   captions are preserved. Existing historical captions are not rewritten.
3. 產生最終圖片並下載 locks order, source text/layout/version, caption and consecutive
   numbers. Browser renders the pinned document with the assigned number. Every PNG
   must be uploaded before individual or ZIP downloads become available.
4. Upload the files to IG manually. The app has no IG API/token or verification.
5. Confirm the first N remaining images. The confirmation dialog identifies the
   operator and exact range. This advances the counter once, transactionally.
6. Remaining items keep their numbers. Complete them, or cancel the unsent remainder.
   If IG's outcome is uncertain, inspect IG before confirming or cancelling.

Initial local last number is 108. Confirming 109–110 leaves last=110; the next group
starts at 111, not 109. Downloads and failed generation never advance it.
Reset preparation invalidates old downloads. It is unavailable after partial
confirmation: continue with the remaining pinned images or cancel them instead.
No auto-registration, account management, authentication or role changes.

## Module design / invariants

`repositories/current-send.js` owns the state machine behind `currentSend`,
`changeSend`, `attachFinal` and `sentRecords`. HTTP/CSRF lives in the existing studio
handler; browser rendering stays in canvas.js. Cleanup is a separate module with
R2 as an injected adapter. No login-system refactor.

0008 adds a singleton progress row and a partial UNIQUE index allowing only one
editing/prepared batch. Every transition uses a global revision CAS inside D1.batch.
A failed assertion aborts the whole transaction before subsequent writes. Stale or
repeated requests return 409/reload; they do not repeat mutations. Ledger constraints
uniquely identify both a final number and a submission. Prefix-only confirmation
writes ledger, counter, cleanup job and audit in the same transaction.

Preparing snapshots the source image version, not the mutable submission ID.
Prepared/confirmed image edits are blocked in the handler and by a database trigger.
Final uploads use unique object keys and the locked generation + revision. Downloads
of unconfirmed images require that same generation, preventing an old cancelled
screen from downloading a later group's reused unconfirmed number.

## 0007 → 0008 and retention

Existing submissions, admins, sessions, audit logs, image drafts/versions and legacy
dispatch captions remain intact. Legacy dispatch items gain submission_id and a
nullable version reference so cleanup can retire PNG/layout without losing ordering
or original submission references. Legacy groups are read-only; copy into an empty
current group. Sent or purged items fail import, never silently disappear from a copy.

Manual confirmation removes the submission from draft/ready lists immediately.
The sent ledger retains submission ID, number, batch/position, confirmer and timestamps.
Authenticated final downloads expire after seven days even if cleanup is delayed.

`cleanupSentImages` processes up to 10 due submission jobs and 20 orphan uploads per
invocation. R2 deletes must finish before the database transaction removes versions,
draft/layout payloads and nulls historical image references. R2 failure retains the
job with an attempt count; retries are idempotent. Live/unconfirmed references block
cleanup. The immutable DELETE trigger allows only due confirmed cleanup candidates;
immutable UPDATE remains blocked. No public delete endpoint exists.

Failed/uncertain upload attempts are recorded before R2 I/O and retained for one day;
cleanup first checks both live source and final references. This does not reconcile
untracked orphan objects created by older deployed code.

## Local verification / preview

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run check:rollout
npm.cmd run build
node scripts/studio-visual-review.mjs --serve
```

The preview prints a loopback URL. It uses ephemeral in-memory SQLite and R2 adapter
data; restarting resets everything. Browser regression also uses local fixtures only;
no production requests. The test suite additionally exercises real isolated workerd
D1.batch and R2 round-trips. Browser PNG hashes are compared against a fresh render
of each server-locked document/number, and ZIP filenames/order/caption are checked.

`wrangler.dev.jsonc` enables SINGLE_SEND_ENABLED, leaves SEND_CLEANUP_ENABLED=false.
Cleanup tests explicitly enable the flag against local data. No cron is configured.

## Later production approval checklist — not performed

Local results: full test suite 191/191; fixed old-Worker/schema compatibility 32/32;
syntax check and dry-run build PASS; studio browser workflow 11 checks / 8 screenshots
PASS; existing public/admin browser regression 20 checks PASS. No production requests
were made by either browser fixture. Screenshots are in `tmp/studio-visual-review/`.

- Verify the actual last manually posted number; 108 must not be assumed current.
- Take a fresh private D1 recovery checkpoint; review/apply 0008 separately.
- Preserve live Access/GitHub settings and private R2 binding; do not deploy the
  checked-in production template blindly (it is not a copy of live configuration).
- Enable SINGLE_SEND_ENABLED only with 0008 and matching frontend/Worker deployed.
- Review cleanup jobs and retention on a read-only snapshot before separately enabling
  SEND_CLEANUP_ENABLED and a Worker scheduled trigger. Keep runtime work bounded.
- Verify owner/admin/moderator flows manually before any real confirmation.

## Known limitations

- An authorized browser renders PNG. The server checks PNG structure/size/dimensions,
  not pixel semantics; an intentionally modified admin client can submit unrelated
  pixels. Normal UI output is covered by byte-for-byte rendering tests.
- Human uploads can still use stale/wrong local files. Cancellation warnings cannot
  revoke a file already downloaded to someone's computer.
- No IG publishing or delivery verification. Confirmation is an administrator's claim.
- The ledger UI pages through 100 records at a time; lightweight records remain in D1.
- Supplied template/font licensing was not re-audited in this change.
- Dependencies/lockfile unchanged. npm audit retains the three known High tooling
  findings (sharp → miniflare → wrangler, GHSA-rgj7-g3m4-5g8c); audit exits 1, not clean.
  No dependency upgrade or audit fix was performed.

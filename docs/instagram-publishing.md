# Instagram batch / carousel publishing

## Local follow-up: scheduled captions and advance preparation (2026-10-05)

These changes are local-only pending a separate deployment approval. The new additive
`0013_instagram_preparation.sql` and `0014_instagram_caption_edits.sql` migrations are **not applied in production**. No dependency
update, production queue rewrite, Cron change or live Meta test is performed by this patch.

- The editor exposes **自訂文字（選填）** and a read-only full caption preview. Custom
  text precedes the lock emoji; date/English weekday use the scheduled instant in
  `Asia/Taipei`, and number lines follow the selected/locked order. Changing the
  date or time updates the preview immediately. The backend independently regenerates
  and validates the full 2,000-grapheme caption before the atomic automatic lock.
- The existing caption column stores the composed text. Reopening an editable draft
  extracts notes around the exact known template; other legacy text is retained as
  custom text. Deploying or opening an editor does **not** rewrite existing snapshots.
  Eligible unstarted queued captions can now be explicitly edited as described below;
  published captions remain immutable.
- Root cause of the regular five-minute delay: `IN_PROGRESS` was thrown as an ordinary
  `InstagramError`, which consumed a failure attempt and moved `publish_at` five minutes.
  It is now a processing state. Readiness polls unfinished children together and then
  the parent, at one-minute intervals with four waits shared across the entire invocation.
  The same containers are reused. Ready images publish in that invocation, without the
  fixed failure backoff. Long processing returns to pending with unchanged schedule
  and failure count; the next Cron resumes it. Real errors retain the existing retry
  budget; ambiguous publishing still stops for manual investigation.
- The publisher renews/checks its lease before each Meta request, including after waits.
  Concurrent invocations cannot claim its batch. Losing the lease prevents subsequent
  external calls. Publication timestamps include the time spent processing.
- The same five-minute Cron also claims one batch within **15 minutes before its requested
  time**. `prepareInstagramPost` creates/checks containers but cannot call `media_publish`.
  D1 persists `preparation_status` (`none`, `processing`, `ready`) and `prepared_at`.
  Ready future batches are skipped until due, so subsequent checks can prepare other batches.
  The UI distinguishes **Meta 圖片處理中** and **已準備，等待發布**. This is media readiness,
  not a guarantee that Meta will approve publication or finish at an exact time.
- At or after the requested time, the due next-number batch takes priority. Its existing
  container is rechecked before publishing. A second D1 due/head/lease guard persists publish
  intent before the external call. Preparing a later-numbered batch never advances numbers;
  an incomplete/failed earlier batch still blocks its publication. Each Cron handles at most
  one batch and publishes at most one post. A preparation invocation that crosses the due
  time still does not publish; the next invocation handles it.
- Genuine transient errors now set `next_attempt_at` separately (5/15-minute backoff),
  preserving requested `publish_at` and its immutable caption. Three failures still stop
  for manual retry; normal processing does not consume the failure budget. Existing saved
  dates are preserved, including any already altered by old production retry behavior.
- A definite `EXPIRED` response before publish intent atomically clears parent/child
  container IDs and readiness, with an `ig_container_expired` audit event. A subsequent
  Cron recreates them using the same image/caption/number snapshots. An ambiguous or
  `PUBLISHED` response never takes this reset path. Expiration is handled by reported
  status rather than assuming an exact container lifetime. No old R2 images are deleted.
- This is not exact-to-the-minute scheduling: the existing five-minute Cron cadence,
  earlier numbered batches and Meta processing/network time can still delay publication.
  Cron and background rendering are unchanged.

Regression coverage includes Monday-to-Tuesday Taiwan rollover, custom prefix and
legacy notes, server-side caption/number snapshots and length rejection, normal
processing without a failed audit/backoff, bounded waits, 15-minute eligibility, future
ready reuse, child/parent/single-image paths, lease loss/concurrency, expiration/audit
rollback, due-head priority, genuine errors, and uncertain outcomes. Migration replay
checks existing snapshots/receipts/FKs and legacy authentication compatibility. The isolated
browser review covers time changes, save/reopen, copy/ZIP equality, ready/processing status,
keyboard refresh, and desktop/mobile without horizontal overflow.

### Future rollout gate (not authorized by this local patch)

1. Approve an exact tested checkpoint; inspect production queue/state and obtain a fresh
   private D1 Time Travel bookmark before any schema mutation.
2. Apply only missing `0013` / `0014` after approval; they add readiness fields and guarded
   caption-edit history, without rewriting existing rows. Validate FKs, data snapshots and
   old Worker compatibility before deploying new code. Do not deploy before both migrations.
3. Deploy with the existing runtime settings/secrets/bindings preserved; do not use the
   repository's placeholder production vars. Cron remains every five minutes.
4. Separately approve live acceptance with a selected batch: observe processing/ready before
   due, no early post or number movement, then one correctly numbered post after due. Confirm
   original scheduled Taiwan date/English weekday and custom text above the lock emoji.
5. If Meta's result is uncertain, stop and manually verify IG; never blindly reset or retry.
   Existing captions change only when an admin explicitly saves an eligible caption edit;
   there is no automatic or bulk repair of previously queued posts.

### Editing an existing scheduled caption (new and legacy queues)

- On **IG 排程**, use **修改內文** for a pending or safely failed batch. The dialog shows the
  original saved text, custom text and regenerated preview using the existing queue's Taiwan
  time and reserved numbers. It never changes time, image files, order, generation or numbers.
- Exact known Chinese/English-weekday templates are separated from custom notes, including
  CRLF captions. Unknown or multiple-template formats are kept **in full**, with a warning
  and a required review checkbox. The user can tidy these notes before saving; nothing is
  discarded or rewritten merely by opening/closing the dialog. Cancel/reload prompt before
  discarding typed changes. Combined text remains limited to 2,000 graphemes.
- `GET /api/admin/instagram/batches/:id/caption` returns a sanitized edit model.
  `POST` on the same path accepts only `{revision, customText}`. The server generates the
  full text from its own schedule/numbers, not a client-supplied caption/date/number list.
  Existing owner/admin/moderator session authentication, enabled checks and CSRF apply.
- The deep module `instagram-captions.js` owns validation and the edit operation. Its one
  insert into append-only `instagram_caption_edits` is the atomic write: a SQL guard rechecks
  queue revision/state, publish intent, receipts, lease, matching snapshots and enabled admin.
  Triggers update both queue and studio caption snapshots, clear parent/child container IDs
  and readiness, invalidate old image-URL expiry, bump the studio revision, and append an
  `ig_caption_updated` audit event. Audit metadata contains only batch ID/revision, not text
  or credentials; the private edit history retains old/new text and editor for traceability.
- The container objects are **not deleted from Meta**. Their IDs are discarded locally and
  will never be used to publish; the next eligible Cron recreates containers using the new
  text. No Meta calls or publishing happen inside the caption-save request. R2 files are
  untouched. Existing attempts/backoff remain; failed jobs require a separate explicit Retry.
- Active preparation also holds a lease, so edits are blocked during it. Publishing,
  uncertain outcomes and saved media receipts are never editable, even if an expired browser
  still shows the button. Revision conflict leaves typed text visible and asks for reload.
  Previously locked image/number/cancel guards remain in place; only the recorded caption
  transition is allowed. An audit/trigger failure rolls the entire insert and updates back.
- `0014` preserves all existing data and does not initiate edits. Local tests exercise legacy
  manual/automatic queues, real workerd D1 triggers, concurrency, rollback, roles/CSRF and
  regeneration. The browser harness uses an isolated seeded admin for edit audits; production
  auth is tested separately with real opaque test sessions. No live Meta acceptance has run.

Local implementation only. No production migration, Cron, secrets, Access policy or publishing has been changed. D1 is the queue authority. This version uses Instagram API with Instagram Login and one professional account. **One 本次發送 batch = one Instagram post**, containing its ordered 1–10 images and one shared caption. A one-image batch uses a normal image container; multiple images use a carousel parent.

## Workflow

Approve and produce images using the existing studio. In **本次發送**, choose a publication time and press **鎖定並產圖，自動排程**. After the irreversible-lock confirmation, the backend atomically reserves numbers, caption/order/time and a queue placeholder. The browser renders final PNGs, converts them to JPEG, uploads them and activates the complete batch in the same action. No additional Schedule/Publish click is needed. Upload failure leaves a resumable locked placeholder, never a partially publishable post.

The queue UI has one status card per batch. New automatic locks cannot be cancelled, reordered, retimed or manually confirmed. Incomplete uploads offer Continue; safe terminal publication failures offer Retry. Approval/saving alone does not publish. Existing manual batches are preserved, not silently scheduled; resolve them before new automatic locks. Upload request order cannot change server-locked image order.

With migrations 0011–0012 multiple batches can reserve consecutive ranges, even before earlier batches publish. Success stores one IG media ID and atomically confirms every item, advances to the batch's last number, writes audit and creates each seven-day cleanup job. Only the next-number batch can publish; later batches wait even if due earlier. No gaps are opened by cancellation because automatic locks cannot be cancelled. Manual posting is not the normal path for these batches.

## Schema and execution

`0010_instagram_publish_queue.sql` (not deployed) adds `instagram_queue` keyed by batch ID, `instagram_items` for immutable ordered images/child container IDs, and temporary `instagram_uploads`. Original submission data stays intact. The queue holds status, schedule, media ID, attempts/error, caption, number range, parent container ID, revision and lease. An atomic UPDATE…RETURNING claims the oldest due batch. A unique partial index allows only one publisher; the next-number condition prevents skipped numbering. One Cron invocation processes at most one batch/post.

The adapter uses the configured API version and bearer authorization. For a carousel it creates/persists all children with `is_carousel_item=true`, checks their readiness, creates a parent with `media_type=CAROUSEL`, ordered `children` and shared caption, persists the parent ID, checks readiness, then calls media_publish **only on the parent**. Processing retries reuse persisted IDs. No token enters URLs/errors; raw Meta error messages are discarded.

Safe failures delay retries by 5 then 15 minutes; the third failure is terminal. Explicit admin Retry resets the attempt budget and container IDs (allowing expired containers to be recreated). A 10-minute lease recovers interrupted work. A durable media receipt is saved before the atomic whole-batch ledger/audit update so database failure can be recovered without reposting.

**Ambiguous publish outcome:** a timeout/5xx after media_publish, or a crash after durable publish intent, is marked failed/uncertain. Neither Cron nor the Retry button republishes it. Meta publishing is not an idempotent transaction with D1; blind retries could duplicate a live post. Manually inspect the Instagram account and the saved container ID. This version deliberately has no automatic reconciliation or force-retry endpoint for an uncertain outcome. A reviewed operator repair is required before continuing that number.

## Images

R2 remains private. Meta receives an opaque random-capability URL under `/api/instagram-media/<random>.jpg`. It requires no login, has a 24-hour database-enforced expiry, no-store headers and only serves active/published queue JPEGs. The URL is never returned in queue listing responses. The token is a media capability, not the IG access token. Do not log or distribute it. Successful JPEGs enter the existing seven-day orphan cleanup queue; failed/cancelled upload attempts are handled by the existing cleanup mechanism. Cleanup remains separately controlled by SEND_CLEANUP_ENABLED. No bucket ACL or public bucket setting is required.

## Configuration and Meta setup

Required Worker configuration:

- `IG_ACCESS_TOKEN`: Cloudflare **secret**, never frontend/D1/Git. Use `wrangler secret put IG_ACCESS_TOKEN --env production` only in the approved rollout checkout/config. Never place the value in command arguments or logs.
- `IG_USER_ID`: professional Instagram account ID (environment variable or secret).
- `IG_API_VERSION`: supported version such as the version selected in your Meta app; required, validated as `v<number>.<number>`, not scattered through code. Tests use a fixture version, not an assertion about the currently recommended version.
- `IG_MEDIA_ORIGIN`: the public HTTPS Worker origin, without a path, query or credentials.
- `IG_PUBLISH_ENABLED`: defaults disabled; set true only after setup and acceptance.
- Existing `DB`, `STUDIO_IMAGES`, auth/session/CSRF configuration must remain intact.

Create/configure a Meta developer app with Instagram API **Instagram Login**. Use a Business or Creator account and authorize `instagram_business_basic` and `instagram_business_content_publish`. Configure login redirect URLs and account/app roles in Meta as required for your chosen access mode; request review/advanced access where Meta requires it for accounts outside app roles. Obtain the token securely through Meta's supported authorization process. This version consumes an operator-provisioned token; automatic OAuth onboarding/token refresh is not implemented. Track token expiry and rotate the Cloudflare secret before it expires. A 190 error is exposed without the token and requires checking authorization.

Reference: [Meta Instagram API documentation](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-instagram-login/content-publishing/) and [Meta's Postman collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api). Confirm current account eligibility, permission requirements and supported version in the Meta console during rollout. Live Meta access was not exercised during local testing.

## Endpoints

- `GET /api/admin/instagram`: batch statuses/count/number range; no secrets/capability URLs.
- `POST /api/admin/studio/send/prepare`: `{revision,batchId,publishAt}` atomically locks the automatic batch and its queue placeholder when IG is enabled. Requires a valid time; cannot be undone. PNG uploads use the existing protected endpoint, matched to the batch generation.
- `POST /api/admin/instagram/batches/:id/image`: image/jpeg (max 8 MiB), X-Send-Generation and X-Image-Position. Returns a staging upload ID; does not enqueue.
- `POST /api/admin/instagram/batches/:id/schedule`: JSON `{revision,generation,publishAt,uploads}` containing all staged upload IDs. Caption/order come from the locked batch.
- `POST .../publish-now`: same JSON for a new batch, or `{revision}` for a pending batch. Backend publishes the whole batch, subject to queue order.
- `POST .../retry-publish`, `POST .../cancel-publish`: JSON `{revision}`.

Cancel and publish-now are only retained for pre-existing manual/legacy queue entries; automatic batches reject them server-side. Automatic activation uses the time already locked in D1, not a client override. Publish-now is not needed for new locks: select the current time and the next eligible Cron will process the batch.

All admin endpoints reuse authenticateAdmin/authorizeAdmin and verifyAdminCsrf. Owner/admin/moderator can publish. The directory is still owner-only. JPEG validation checks framing, size and dimensions; the authenticated administrator's browser generates the media, as in the existing PNG workflow.

## Local verification

`npm.cmd run check`, `node --test test/instagram.test.js`, `npm.cmd test`, `npm.cmd run build`. Build is dry-run only. `node scripts/studio-visual-review.mjs` uses isolated SQLite and an in-memory R2 adapter; mocked Meta tests cover atomic claims, retries, cancellation, immutable snapshots, ambiguous outcomes, receipt recovery and data preservation. Browser tests exercise real canvas JPEG generation and scheduling without Meta calls. Use `--serve` for an ephemeral local UI with test submissions. This preview has no IG credentials and must not be exposed publicly.

For Wrangler local development, apply migrations to the isolated local DB and keep `IG_PUBLISH_ENABLED=false` unless using deliberate mocked test infrastructure. Never paste a live token into frontend fixtures. Cron can be tested through the exported processor in automated tests; a live token plus an enabled local Cron would make real posts.

## Production rollout (separate approval)

1. Inspect current deployed version and back up the complete bindings/settings, including Access team/AUD, Access=true, Local=false, STUDIO_IMAGES, studio flags and schedules. Use the verified production rollout configuration. **Do not run plain `wrangler deploy --env production` with repository placeholder vars. `--keep-vars` does not protect values explicitly overridden by config and does not preserve omitted R2 bindings.**
2. Obtain a fresh D1 Time Travel checkpoint. Review and explicitly approve migrations 0010–0012. Confirm FK check and existing auth, studio and manual-send paths with IG disabled. Resolve existing manually prepared batches before activation; do not silently enqueue them.
3. Configure Meta and secrets in the approved production deployment configuration. Verify JPEG URLs can be fetched by Meta without cookies. Keep R2 private.
4. Deploy code with IG disabled and all current production bindings preserved. Test health, unauthenticated 401, GitHub and Access, PNG download, image studio and copy-caption.
5. After explicit activation approval, set IG_PUBLISH_ENABLED=true and configure `[triggers] crons = ["*/5 * * * *"]` in TOML, or `env.production.triggers.crons = ["*/5 * * * *"]` in this repo's JSONC/generated production config. Preserve any pre-existing schedules. Cron uses UTC and publishes at most one post per invocation. SEND_CLEANUP_ENABLED is an independent decision.
6. Schedule one approved test batch with at least two images and an explicitly approved caption. Verify actual account, carousel order, shared caption, single media ID, all numbers, audit and post timestamp. Also verify one-image fallback. Local mocks cannot certify real Meta permission/token setup.

No production deployment, live IG post, secret setup or migration was performed for this implementation.

## Verification results

### Tooling security patch (2026-10-07)

- GHSA-wq5f-xc86-pv6w made the existing Sharp 0.35.4 development dependency fail full audit. Wrangler 4.148.0 / Miniflare 5.20261006.0-alpha still pin that version, so upgrading those tools alone does not resolve the advisory.
- A narrowly scoped `overrides.miniflare.sharp` pins the patched **0.35.5**, including its matching platform/libvips packages. Wrangler, Miniflare, workerd, esbuild and runtime `jose` remain unchanged. Remove the override once the chosen upstream Miniflare version includes a patched Sharp itself.
- Full `npm audit --audit-level=low` reports **0 vulnerabilities** after this patch. No audit exclusions, threshold changes, forced downgrade or production configuration changes are part of the dependency fix.

### Tooling security checkpoint (2026-10-04)

- Updated only development tooling: Wrangler 4.147.0 and its matching Miniflare 5.20261001.0-alpha, with their lockfile dependencies. Runtime dependency `jose` is unchanged.
- Full `npm audit --audit-level=low`: **0 vulnerabilities**. No audit exclusions, overrides or CI threshold changes were added. This supersedes the historical audit failures below.
- Production migration, deployment, live-post acceptance and Cron activation remain separate approval gates. A passing local build is a dry run, not a production deployment.

### Pre-deployment gate update (2026-10-03)

- `check:rollout` now explicitly permits migrations 0010–0012 while comparing every prior migration against fixed pre-Instagram checkpoint `8ecfc805472a0c14e6b435d8aa584bca2b001d9c`. Pagination is checked through its existing 235-row behavioral test instead of freezing the query implementation.
- Isolated compatibility fixtures actually apply schema 0012, assert the `auto_publish` column and clean foreign keys, and replay unchanged OAuth/security/validation tests from both fixed checkpoints: `a5888345f8a1658c704237452d58111e4dec3f41` (32 tests) and `8ecfc805472a0c14e6b435d8aa584bca2b001d9c` (35 tests). This does not prove deployed source identity; that remains a rollout check.
- The repository production configuration must keep IG disabled and contain no Cron schedule. It remains a placeholder configuration, not a safe production deploy command.
- Full `npm audit` still exits nonzero with four high-severity affected development-tool packages (sharp, undici, miniflare, wrangler); production-only audit reports zero. The current CI's full audit step therefore still blocks a green workflow. No audit suppression or dependency upgrade was performed. Matching package counts do not establish that advisory IDs are unchanged.
- No production migration, code deployment or Instagram publish was performed by this gate.

- Carousel revision: full regression **219/219 PASS**, focused Instagram tests **12/12 PASS**; check and dry-run build PASS. Desktop/mobile browser workflow PASS, including one-card whole-batch schedule/cancel and ordered JPEG snapshots.
- Automatic-lock revision: full regression **227/227 PASS**; check/dry-run build PASS. Browser tests cover a single-action lock/render/schedule, two simultaneously locked contiguous ranges, hidden cancellation/manual controls, JPEG failure/resume and pagination beyond 100. No Meta or production requests were made.
- Automated queue tests include complete-batch validation, ordered carousel containers, only-parent publication, persisted-child retries, whole-batch ledger rollback/recovery, concurrency, cancellation and one-image real workerd/D1 execution.
- Source check and Worker dry-run build pass. Desktop/mobile browser fixture passes, including JPEG generation, ordered schedule/cancel and unchanged PNG/ZIP output.
- `npm audit`: 4 high findings through existing development tooling (sharp/undici/miniflare/wrangler). `npm audit --omit=dev`: 0. No dependency or lockfile changes. Advisories can change over time; these are the findings at this implementation run, not an assertion that all advisory IDs are unchanged.
- Real Meta authorization, token renewal and a real IG post still require deployment acceptance. To pause publishing, turn off IG_PUBLISH_ENABLED; queued rows retain their locks. Resolve/cancel queue entries before returning their images to the manual workflow.

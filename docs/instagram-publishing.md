# Instagram batch / carousel publishing

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

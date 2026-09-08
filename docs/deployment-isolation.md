# Local Auth deployment isolation

> Historical Phase 4.5 checkpoint. Current Phase 4.6 candidate: codex/access-email-otp-integration from 9885847. Only Access auth, additive 0005, binding, admin login UI, tests and docs are added; jose is the sole new runtime dependency. Current check:rollout replays the pinned legacy Worker on schema 0005. See [Access integration](access-email-otp-integration.md). Historical results below do not authorize deployment.

## Fixed scope

Base: `a5888345f8a1658c704237452d58111e4dec3f41` (production main).
Source: `6a0f985491c64d3366ce8d93706e46ff47cd6efc` (binding final checkpoint, 126/126 CI).
Candidate: `codex/local-auth-rollout`, created directly from base; not a merge of the mixed source branch.

| Boundary | Candidate decision |
| --- | --- |
| Auth / sessions / CSRF / PBKDF2 / login limiter | Bring Local Auth implementation and shared GitHub behavior |
| Admin CLI | Bring local management and same-row bind-local |
| Schema | Unmodified 0001 and 0002, plus 0004; no 0003 |
| Submission repository | Exact production baseline; no rendering columns |
| Submission handler | Only shared non-dev audit condition changes |
| Admin HTML / JS / CSS / content | Extract login, password change, shared session; retain original pending moderation and theme |
| Public HTML / app.js / api.js / public graphics | Retain production baseline |
| Worker routes | Add auth endpoints only; no render or preview endpoints |
| Renderer / fonts / R2 / dependencies | Excluded; no @resvg or opentype runtime packages |
| CI | Non-deploy validation on codex push / PR; no new automatic deployment |

## Verification

Local verification on 2026-09-08:

- Candidate suite: 107/107, no skips. Includes real isolated Wrangler D1 binding/rollback and workerd PBKDF2 login/rotation/rate limit.
- Source syntax + content JSON check passed; production Worker dry-run passed, local auth false, DB + assets only.
- Lockfile audit: 0 vulnerabilities at check time.
- `npm run check:rollout` enforces the excluded-file/schema/dependency boundary and retained production public surface.
- The same command reads the exact pinned a588834 Worker and unmodified OAuth/security/validation tests into a disposable directory, changing only the D1 fixture to 0001+0002+0004: 32/32 passed. Separate public-submission probes exercise both old and candidate Workers on the upgraded schema with local auth disabled.
- Shared migration fixtures no longer apply 0003. Migration tests verify preservation of existing admin IDs, sessions, audit and submissions plus foreign keys.
- GitHub network exchange/profile are mocked. No remote D1 mutations or real OAuth sign-in are represented by these tests. Production schema constraints/data, backups, CPU plan and post-migration smoke remain separate release gates.
- Candidate UI was inspected for extraction and accessible fields; source checkpoint's historical 390px visual result is not a new candidate browser sign-off.

32 baseline tests are reported separately, not added to the candidate's 107 test count. The original 126/126 remains the mixed-source checkpoint result; dropping renderer-only tests is intentional.

## Standards

Independent standards review found two small extraction leftovers: unused renderer audit action names and a GitHub-only session-expiry message on shared logout. Both were removed/corrected; final re-review reports **0 remaining findings**. CSS variables resolve against the retained main theme; password, role, migration, identity and release-gate documentation is consistent. No auth redesign was requested or performed.

## Spec

Independent specification review confirmed exclusion of renderer/0003/R2/fonts/branding and retention of required auth/binding/UI. The same two small extraction leftovers were corrected; final re-review reports **0 remaining findings**. Schema-only compatibility is now checked using pinned production code; this does not authorize skipping production smoke tests.

## Deployment decision

This is a code isolation checkpoint, **not permission to bypass rollout gates or evidence of a deployed version**. Read [README](../README.md) and [deployment-status](deployment-status.md) before any production action.

0004 rebuilds identity/session/audit tables, so backup, constraints and preservation checks are mandatory. Apply schema before new Worker even with local=false. Worker and admin assets ship together; do not ship new login UI against old provider-less Worker. Bind the existing owner row, verify unchanged ID/GitHub/role, then enable local auth and test both providers. Friends' moderators come last. Freeze renderer/R2/fonts throughout.

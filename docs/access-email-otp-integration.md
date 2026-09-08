# Phase 4.6 — Access Email OTP 本機整合

日期：2026-09-09，Asia/Taipei。範圍僅 code／tests／migration／文件；沒有 production mutation 或 deploy。本機完成不代表正式 Access 整合已上線。

## 分支與 TDD

PoC 成果已獨立保存於 `codex/access-email-otp-poc` 的 `ca5c4359108777c9fe9246cd6b4061f6d2cddb54`。本候選 `codex/access-email-otp-integration` 從乾淨 `98858477827a7076b0e43cde2ed7f9f252fe2076` 建立，未 cherry-pick PoC／WIP 整包程式。候選變更目前未 commit／push。

依使用者確認的四個 public boundaries 進行 TDD：validator → login/session → binding CLI → migration。每條主要路徑先觀察 failing test，再加入最小實作；後續加入負面、回滾與 regression cases。沒有大型 synthetic benchmark 或 migration failure proof harness。

## JWT / JWKS

- 新模組 `worker/src/security/cloudflare-access.js`。使用鎖定 `jose@6.2.12`，`jwtVerify`＋`createRemoteJWKSet`；Worker WebCrypto，不使用 ctx.access、Node crypto 或自寫 signature verifier。
- 只接受 `Cf-Access-Jwt-Assertion`，最大 16 KiB。算法 allowlist 只有 RS256；required claims：iss、aud、exp、email，另由 jose 驗證標準 nbf／時效／claim type。
- issuer 必须精確為設定的 HTTPS `https://<team>.cloudflareaccess.com`；不接受 path、port、credentials 或其他 domain。AUD 必須是正式 application 的非空 tag。不是拿 decoded payload 做授權。
- 成功後只傳遞 normalized verified email。Email 必須 string、ASCII mailbox、最多 254 字元，trim＋lowercase；不做 provider-specific normalization。
- JWKS 固定 `${ACCESS_TEAM_DOMAIN}/cdn-cgi/access/certs`。Resolver 保留於 isolate，cache 10 分鐘、未知 kid refresh cooldown 30 秒、fetch timeout 3 秒，禁止跟隨 redirect。不每次手動下載 key，不 hardcode production key。
- Key rotation 由 jose resolver 處理。需要 fetch 時若 network／HTTP／JSON failure，一律 fail closed；尚有效 cache 中的已知 signing key 仍可用於密碼學驗證，這不是跳過驗證。沒有 fallback 到未驗證 email。
- 驗證錯誤統一 `403 ACCESS_AUTH_FAILED`，不返回 jose exception。Audit 不保存 JWT、完整 claims、CF_Authorization、OTP、session token 或 email。

設計參考：[Cloudflare 官方 JWT validation](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/)、[jose remote JWKS](https://github.com/panva/jose/blob/main/docs/jwks/remote/functions/createRemoteJWKSet.md)。實際 API／cache 行為也依本次安裝的鎖定套件原始碼核對。

## Login / session / GitHub

`GET /api/auth/access` 在 flag false 時回 `503 ACCESS_AUTH_DISABLED`，不查 mapping 或 JWKS。啟用時驗證 JWT → 查 `admins.access_email_normalized` → enabled／role → 建既有 opaque D1 session → audit → HttpOnly cookie → 固定同源 `/admin/`。Unknown／disabled email 回 `403 NOT_ADMINISTRATOR`，不 INSERT admin。

Session 建立重查 enabled 和 email mapping，避免查詢後 mapping 變更仍登入。建立／success audit／替換目前瀏覽器舊 session 沿用既有 D1 batch；audit failure 不留下已登入 session。D1 存 SHA-256 token hash，不用 Access JWT 當本站 session。

既有 middleware 每次重新取 role／enabled；submissions、CSRF、approve／reject、audit、logout 不建立第二套實作。Logout 清本站 cookie／D1 session，不做 Cloudflare 全域登出；Access SSO 尚有效時再按 Email 登入可能不需 OTP。UI 和 README 均說明。

GitHub OAuth 路徑沒有 Access middleware、沒有 JWKS 依賴。測試中同一 owner 綁 email 後，Access 和完整 GitHub state／PKCE callback 共用同一 admins.id；Access false 或 config 無效時 GitHub 仍成功。

## Migration / binding

新增 `0005_add_access_email.sql`：

```sql
access_email TEXT NULL
access_email_normalized TEXT GENERATED ALWAYS AS (lower(trim(access_email))) VIRTUAL
```

第二欄以 partial unique index 約束非 NULL 正規化 email。沒有 DROP／重建，沒有修改 0001／0002／0004，也沒有 0003。代表性 populated 0004 fixture 包含 enabled owner、disabled moderator、既有 local password 欄位、session、audit；前後完整舊 row 比較，新增欄位 NULL、大小寫唯一性、foreign key check 均驗證。

CLI：`npm run admin:bind-access-email -- --github-user-id NUMERIC_ID --email EMAIL (--local | --remote) [--execute]`。預設 dry-run，只查 metadata、顯示目標。Execute 仍在原 id 更新 email，不改 GitHub identity／created_at／role／enabled／password，不新增 admin row、不撤銷 sessions。已綁定時拒絕覆寫。

Preview 後再以條件 UPDATE 核對 identity／role／enabled／created_at／NULL mapping／無 duplicate。UPDATE assertion 與 `admin_access_email_bound` audit 在同一 D1 file transaction。DB error 回滾；若傳輸失敗，CLI 明示結果可能不確定，先唯讀查核，不宣稱遠端必然回滾。Audit admin_id 為 NULL（CLI 不冒充 web session），metadata 記 source、target_admin_id、provider。

單元測試使用 SQLite transaction；另外真實 Wrangler 在獨立 temporary local D1 執行 0005、dry-run、binding、audit failure rollback。沒有正式 D1 指令。0004 仍要求至少 GitHub 或完整 local identity，因此本階段不建立 email-only admin；朋友 provisioning 必須在後續 Gate 10 另行批准。

## UI / config / password

管理登入頁文案為大安匿名／DAAN ANONYMOUS，Email 按鈕只導向 Access route；flag false 隱藏，GitHub 仍可見。舊 password 表單與改密碼控制保留在 hidden DOM、程式禁用；不改舊 password backend 或資料。前端回歸包含 provider discovery、cookie/session／CSRF 使用與 hidden UI source checks；本輪沒有真人瀏覽器視覺簽核。

Repo production 與 example defaults：`LOCAL_AUTH_ENABLED=false`、`ACCESS_AUTH_ENABLED=false`、`DEV_ADMIN_MODE=false`。TEAM_DOMAIN／AUD 留空，待正式 app Gate 才設定。Password Local Auth: deferred / disabled due Workers Free runtime constraints。本輪沒有 password reset／rehash／delete／降強度，也沒有變更 production vars。最後已知線上 local flag 仍為 true，不能把 repo false 誤報成線上已關閉。

此設計不新增付費服務／寄信供應商，也未升級 Workers。Free 方案、正式 JWKS 冷啟動 CPU／OTP flow 與 Access policy 範圍，仍須受控 rollout 現場驗證；local workerd 通過不能證明 production CPU 配額。

## 驗證結果

2026-09-09 本機最終結果（測試數含 node:test subtests；跨 boundary 的 runtime case 不重複加總）：

| Boundary / gate | 結果 |
| --- | --- |
| JWT validator | PASS：16/16，local keys／JWKS、偽造 claims／header、signature／issuer／AUD／expiry、cache／rotation／failure |
| Access login + existing session | PASS：6/6 endpoint cases，另 1 個完整 GitHub 同列身份 case、1 個 Worker WebCrypto runtime case |
| Email binding CLI | PASS：5/5，另真實隔離 Wrangler D1 dry-run／binding／audit rollback case |
| Migration preservation | PASS：populated 0004 → 0005 完整保留測試，加上真實 D1／workerd migration checks |
| npm test | PASS：137/137，0 skipped／failed |
| npm run check | PASS：57 JS files＋content JSON |
| npm audit --audit-level=low | PASS：0 vulnerabilities |
| npm run build | PASS：production dry-run，121.61 KiB／gzip 30.02 KiB，Access／Local flags false |
| npm run check:rollout | PASS：隔離邊界、雙版本 public submission probe、舊 Worker regression 32/32 on 0005 |

完整 regression 保留 GitHub OAuth／callback/state/PKCE、session、logout、CSRF、roles／enabled、public submission、admin submissions、approve／reject、audit、CORS／production security、Pages build／deployment boundary；歷史 password 測試只在本機隔離環境跑，沒有啟用正式 password auth。正式 Cloudflare end-to-end／GitHub CI 未執行，因本輪未 deploy／push。

**READY FOR ACCESS PRODUCTION ROLLOUT**：指本機候選已可交付下一個受控 gate，不是已上線或可跳過 commit／CI／現場查核／逐關批准。

## 檔案清單

新增：

- `worker/src/security/cloudflare-access.js`、`worker/src/security/access-email.js`
- `worker/src/handlers/access-auth.js`
- `migrations/0005_add_access_email.sql`
- `scripts/bind-access-email.js`
- `test/access-jwt.test.js`、`test/access-login.test.js`、`test/access-migration.test.js`、`test/access-runtime.test.js`、`test/bind-access-email.test.js`、`test/helpers/access.js`
- 本文件 `docs/access-email-otp-integration.md`

修改：

- `worker/src/auth.js`、`worker/src/index.js`、`worker/src/handlers/local-auth.js`（provider discovery）
- `worker/src/repositories/admins.js`、`sessions.js`、`audit-logs.js`
- `frontend/admin/index.html`、`frontend/assets/admin.js`、`frontend/content.json`
- `package.json`、`package-lock.json`、`wrangler.jsonc`、`.env.example`、`.dev.vars.example`
- `scripts/check-rollout.mjs`
- `test/helpers/d1.js`、`test/bind-local-wrangler.test.js`、`test/documentation-rules.test.js`、`test/local-auth-frontend.test.js`、`test/local-auth.test.js`、`test/oauth.test.js`、`test/worker-runtime.test.js`
- `README.md`、`docs/deployment-status.md`、`docs/deployment-isolation.md`、`docs/local-auth-implementation.md`（舊報告標示歷史）

## 後續 rollout

依 README 十個獨立 gates：0005 → same-row owner email binding → exact-path Access app → TEAM/AUD → code＋兩個 auth flags false → GitHub regression → 批准後只開 Access → owner OTP → GitHub 備援 → 朋友 provisioning。之前先保存候選 commit／CI、唯讀查核正式狀態與 checkpoint。**本輪不執行任何 gate；不部署 Pages、不修改 OAuth／secrets、不觸碰 renderer／R2／Instagram。**

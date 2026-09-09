# 大安匿名 / DAAN ANONYMOUS — Admin UX + Team Accounts

目前本機 UI 定稿分支：`codex/admin-minimal-ui`。新投稿上限統一為 **100 Unicode grapheme clusters**，前後端共用計數與常數；舊長文不修改。帳號建立 UI/API 已取消，沿用 CLI + Cloudflare Dashboard。這一輪 UI／限制修改尚未部署；詳見 [UI 定稿說明](docs/ui-finalization-submission-limit.md)。

以下 Phase 4.7 段落保留原 checkpoint 的歷史狀態，不作為目前 production 狀態的查證。

Phase 4.7 本機候選：`codex/admin-ux-team-accounts`，基底為 Phase 4.6 已完成 checkpoint `2027f800218ff1d109d202855451de9d61aa3648`。新版 UI、Access-only team CLI 與 0006 **尚未部署 production**。GitHub OAuth 保留且獨立；Email OTP 和 GitHub 共用既有 D1 opaque session。沒有 renderer、遠端字型、R2、0003、render API、產圖 UI 或 Instagram 變更。不可 merge 整條 renderer branch。

Phase 4.6 正式 Gate 已完成：Access Email OTP enabled、GitHub 備援正常、LOCAL_AUTH_ENABLED=false。Repo 的 Access=false 是保守部署預設，**不代表正式站仍關閉**。4.7 實作、角色矩陣、截圖與限制見 [Phase 4.7 文件](docs/phase-4.7-admin-ux-team-accounts.md)。本輪不執行任何正式部署或帳號建立。

部署前先讀本 README、[部署狀態快照](docs/deployment-status.md) 和 [Access 實作／rollout gates](docs/access-email-otp-integration.md)，再查遠端。**本機通過不代表 production 已更新。** 舊 Phase 4.5 報告只作歷史 checkpoint，不再是啟用 password 的指示。

## 入口與登入方式

- 公開投稿：[GitHub Pages](https://flashingtw.github.io/anonymous-ig/)。
- 正式後台：[Worker /admin/](https://anonymous-submissions-api-production.flashingtw.workers.dev/admin/)；Pages admin 只轉址。
- 本機：`http://127.0.0.1:8787/admin/`，本機帳號／D1 不會自動變成正式資料。
- 新 UI：大安匿名／DAAN ANONYMOUS、Email 驗證碼按鈕、Sign in with GitHub。Email 按鈕僅在 providers API 回報 Access enabled 時顯示，連到 `/api/auth/access`。Email 輸入、寄送、OTP 驗證交給 Access，本站不收存 OTP。
- Username/password 表單及改密碼入口隱藏。**Password Local Auth: deferred / disabled due Workers Free runtime constraints.** 保留 username、password_hash、password_updated_at、0004 和 backend regression tests；不 reset、rehash、刪除或降低 hash 強度。
- Logout 只撤銷 D1 app session、清除本站 cookie，不登出整個 Cloudflare Access。Access SSO session 有效時，再按 Email 登入可能不需重收 OTP。

## 安全邊界

Access application **只能保護 `/api/auth/access`**，不得保護 /admin、/api/admin/*、GitHub login/callback 或整個 hostname。Access 故障不得阻擋 GitHub 備援。

Worker 不依賴 ctx.access，不信任 email query/body、Cf-Access-Authenticated-User-Email 或未驗證 claims。用 jose 驗證 Cf-Access-Jwt-Assertion 的 RS256 signature、issuer、audience、exp 和標準時效，再用 verified email 查 enabled admin。Unknown email 回 403 NOT_ADMINISTRATOR；JWT/JWKS 驗證失敗回 403 ACCESS_AUTH_FAILED，不洩漏底層例外、不自動註冊。

每次管理請求重新確認 enabled／role。Opaque session cookie：host-only、HttpOnly、SameSite=Lax、Path=/、production Secure；D1 只存 token SHA-256 hash，預設 8 小時。Approve／reject／logout 沿用 CSRF。Public Pages 投稿 credentials: omit；管理 API 同源 credentials: include。Production CORS 精確允許 https://flashingtw.github.io，不使用 wildcard。GitHub 保留 state＋PKCE，numeric ID 授權。

## 本機開發與驗證

Node.js 22.5 以上，使用 lockfile：

```sh
npm ci
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

SESSION_SECRET 至少 32 字元；GitHub 本機測試用獨立 OAuth App，callback 精確為 http://127.0.0.1:8787/api/auth/github/callback，不複製 production secrets。範例預設 LOCAL_AUTH_ENABLED=false、ACCESS_AUTH_ENABLED=false、DEV_ADMIN_MODE=false。本阶段不啟用 password。

Access tests 產生 local keypair／JWKS，不呼叫真實 Cloudflare。Runtime／Wrangler tests 使用隔離 temporary local D1。它們不是 production Free CPU／OTP end-to-end 通過的宣告。

```sh
npm run check
npm test
npm audit --audit-level=low
npm run build
npm run check:rollout
```

build 是 Worker production **dry-run**，不 deploy。check:rollout 檢查隔離邊界並重跑固定舊 Worker 在新 schema 的 OAuth／security／moderation 測試。Migrations 只有 0001、0002、0004、0005、0006；前四個不改，沒有 0003。0006 只在隔離本機資料庫測試，尚未套到 production。

## Email 綁定：既有 admin，不新增帳號

0005 只增加 nullable access_email、generated access_email_normalized = lower(trim(access_email)) 及 partial unique index。舊 identities、password、sessions、audit 保留，新欄位預設 NULL。

Email 採 ASCII mailbox、最多 254 字元，trim＋lowercase；不做 Gmail dot／plus normalization。CLI 預設 dry-run，只有 --execute 才寫入：

```sh
npm run admin:bind-access-email -- --github-user-id YOUR_NUMERIC_ID --email admin@example.com --local
npm run admin:bind-access-email -- --github-user-id YOUR_NUMERIC_ID --email admin@example.com --local --execute
```

預覽顯示 target admin id／GitHub identity／role／enabled／email，須核對同一列。拒絕 duplicate、disabled、already-bound、missing／ambiguous identity 及 preview 後 identity 變更。不接受 password／role 參數、不覆寫 mapping。UPDATE＋audit 使用同一 D1 file transaction；DB error 回滾，傳輸失敗結果可能不確定，先唯讀查核再重試。Audit 只記 target admin id／provider，不記 email／JWT／password／hash。Binding 保留 sessions。

Production 另行批准後才使用 --remote。Binding CLI 仍不新增帳號。Phase 4.7 的 0006 允許 Access-only admin，但仍要求至少一種完整登入 identity；沒有公開 registration API。

## Team accounts（本機候選）

owner / admin / moderator 均可查看、Approve、Reject 投稿；只有 owner 可 GET `/api/admin/admins`。管理員頁只讀，沒有 Web mutation API。Email-only identity 在 D1 對應原本 admin id，登入仍用同一套 JWT / session / CSRF / audit。

```sh
npm run admin:create-access -- --email friend@example.com --role moderator --local
npm run admin:create-access -- --email friend@example.com --role moderator --local --execute
```

CLI 預設 dry-run、role=moderator；允許 admin / moderator，禁止 owner。trim + lowercase、UNIQUE、enabled=true、INSERT + audit 同一 transaction。GitHub / local credentials 都是 NULL。
正式朋友 onboarding 另行批准，需同時完成 D1 moderator + Cloudflare Access exact-email allowlist（Require OTP）；不會自動修改 Access policy。

歷史 password 規則仍保留：username 3–32 個英數字或 _、-、.；password 8–128 Unicode grapheme clusters、最多 1024 UTF-8 bytes、不可全空白、不 trim。舊 CLI 存在不代表允許執行正式 reset／rehash。

## Phase 4.6 rollout 歷史參考：已完成，不可直接重跑

以下為前階段 Gate 概要，不是 Phase 4.7 部署指令。Phase 4.7 需另行制定 0006／Worker／Pages 的受控 rollout；目前只做 local visual review。Repo 目標設定不等於線上值。

1. 查 ledger、schema、owner／row counts、Time Travel checkpoint；只 apply pending 0005，核對資料保留與舊 Worker。
2. Dry-run 後把 owner email 綁到原 admins.id=1；核對身份、角色、enabled、row count、audit；保留 password 與 sessions。
3. 建 production Access application，僅保護 /api/auth/access，僅允許核准 Email、選 OTP、保持 Free。
4. 設定 production ACCESS_TEAM_DOMAIN=https://<team>.cloudflareaccess.com（無尾斜線）及該 app ACCESS_POLICY_AUD，不照抄 PoC AUD。
5. 部署 Worker＋同源 admin assets，ACCESS_AUTH_ENABLED=false、LOCAL_AUTH_ENABLED=false、DEV_ADMIN_MODE=false；保留 GitHub／SESSION_SECRET／D1。不 deploy Pages。
6. GitHub OAuth／callback／submissions read／logout／re-login regression，先不 mutate 真實投稿。
7. 獨立批准才開 ACCESS_AUTH_ENABLED=true、顯示 Email 按鈕；LOCAL_AUTH_ENABLED 持續 false。
8. Owner OTP login、同一 admin id／role、CSRF／logout、unknown email denial、Free runtime 實際表現。
9. 再測 GitHub 備援；有效 Access SSO 下不需重收 OTP 是正常行為。
10. 全部通過後才批准朋友 moderator provisioning／binding，更新部署狀態快照。

失敗即停止。未授權不得 deploy、改 production D1／variables／secrets、restore Time Travel。關閉 Access flag 不撤銷既有 D1 sessions；移除 Access policy email 也不是本站 session revoke，本站停用 admin 才會阻止後續授權。保留相容 additive schema，不自行 drop 欄位。

codex branch push／PR 的 validate CI 不部署；**push main 會觸發 Pages deployment**。不得提交 .env、.dev.vars、.wrangler、測試狀態、JWT、cookies、password／hash、secrets 或完整 Time Travel bookmark。

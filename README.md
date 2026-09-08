# 匿名投稿 MVP — Local Auth rollout

此分支 `codex/local-auth-rollout` 從 production main `a5888345f8a1658c704237452d58111e4dec3f41` 建立，只帶入 Phase 4.5 帳密登入。保留 GitHub OAuth、公開投稿與 pending 審核；不包含 renderer、字型、R2、0003、render API、產圖 UI 或品牌改版。**不可將整條 `codex/daan-brand-renderer` merge 到 main。**

部署前必須先讀本 README 與 [部署狀態快照](docs/deployment-status.md)，再查遠端狀態；不依舊對話推測已上線。[實作與安全規則](docs/local-auth-implementation.md)、[隔離檢查](docs/deployment-isolation.md) 提供細節。CI 或本機測試通過不等於已部署。

## 入口與架構

- 公開投稿：[GitHub Pages](https://flashingtw.github.io/anonymous-ig/)。
- 正式登入：[Worker /admin/](https://anonymous-submissions-api-production.flashingtw.workers.dev/admin/)；Pages 的 admin 頁只負責轉址。
- 本機登入：`http://127.0.0.1:8787/admin/`；本機帳號不會自動變成正式帳號。
- Worker 同源提供管理 UI／API／session。Pages 投稿跨 origin，使用 `credentials: omit`；管理 API 使用 `credentials: include`。
- D1 儲存投稿、admins、sessions、audit、登入限流計數。Instagram／Meta 尚未串接。

## 本機開發

需求：Node.js 22.5 以上；使用 lockfile 鎖定依賴。

```sh
npm ci
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

修改 `.dev.vars` 的 `SESSION_SECRET`（至少 32 字元）；帳密登入使用 `ADMIN_AUTH_PROVIDERS=github,local`、`LOCAL_AUTH_ENABLED=true`。GitHub 登入另需自己的 local OAuth App：callback 必須精確為 `http://127.0.0.1:8787/api/auth/github/callback`，填入 `GITHUB_CLIENT_ID`／`GITHUB_CLIENT_SECRET`。不要求 repo、email 或 organization scope。範例檔包含完整設定；不得提交 secrets。

本分支 migrations 只有 `0001`、`0002`、`0004`，刻意略過 renderer 的 `0003`。首次空白 local DB 才使用上述 migrate 指令；既有 production 必須遵循下方更新順序。

### 手動建立與管理帳號

Username：3–32 個英數字或 `_`、`-`、`.`，不分大小寫比對。密碼：8–128 個 Unicode grapheme clusters（使用者可見字元），最多 1024 UTF-8 bytes，不可全空白；不限數字，不截斷、不 trim。

所有寫入預設 dry-run，`--execute` 才執行。密碼走 hidden interactive prompt（輸入不顯示），禁止 `--password`，不要貼進 shell history、聊天或文件。

```sh
npm run admin:add-local -- --username friend01 --role moderator --local
npm run admin:add-local -- --username friend01 --role moderator --local --execute
npm run admin:list -- --local
npm run admin:set-password -- --username friend01 --local --execute
npm run admin:set-role -- --username friend01 --role admin --local --execute
npm run admin:disable -- --username friend01 --local --execute
npm run admin:enable -- --username friend01 --local --execute
```

預設角色 moderator。管理員由受信任 CLI 建立，沒有公開註冊或 email 找回密碼。停用／CLI 重設密碼撤銷該 admin 全部 sessions；不可停用、降級或刪除最後一位 enabled owner。隔離 worktree 的本機 D1 與其他 checkout 的本機庫不同；指令必須在目標 checkout 執行。

### 綁定既有 GitHub owner（不得新增第二列 owner）

```sh
npm run admin:bind-local -- --github-user-id YOUR_NUMERIC_ID --username YOUR_LOCAL_USERNAME --local
npm run admin:bind-local -- --github-user-id YOUR_NUMERIC_ID --username YOUR_LOCAL_USERNAME --local --execute
```

確認 production 前置關卡後才把 `--local` 改為 `--remote`。預覽會唯讀解析並顯示「將綁到 admin id X」；核對 id、GitHub numeric ID、role、enabled。不存在／多筆 GitHub 匹配、disabled、username 被占用、已具 local identity 或預覽後目標變更都拒絕。

Execute 僅在原列新增 local identity，保持 `admins.id`、`github_user_id`、role、enabled；不 INSERT admin。使用既有 PBKDF2 abstraction；綁定、audit、舊 sessions 撤銷在同一交易，失敗回滾。成功不會自動開啟 local auth。兩種登入必須指向同一 admin id。

## API 與安全規則

- 公開：`GET /api/health`、`POST /api/submissions`（trim 後 1–1000 Unicode code points）。
- Auth：`GET /api/auth/providers`、`GET /api/auth/github`、`GET /api/auth/github/callback`、`POST /api/auth/login`、`GET /api/auth/me`、`POST /api/auth/logout`。
- Admin：`GET /api/admin/submissions?limit=50`、`POST /api/admin/submissions/:id/approve`、`POST /api/admin/submissions/:id/reject`、`POST /api/admin/account/password`。
- Roles：owner／admin／moderator；每次驗證 admin existence、enabled、role。兩種登入共用 opaque session、CSRF、audit 與權限。
- 密碼：PBKDF2-HMAC-SHA-256，600,000 iterations，隨機 16-byte salt，32-byte key。只存 hash，不存明文；CPU 預算須在 production 確认，不為方案降低強度。
- 帳密登入強制同源 Origin；預設 IP 與 username 各 900 秒內 5 次驗證，後續封鎖 900 秒，回 429 與 Retry-After。Production 計數存 D1 HMAC identifiers；與公開投稿 limiter 開關獨立。
- 不存在／密碼錯誤／disabled 統一回 401 INVALID_CREDENTIALS，不存在帳號驗證 dummy hash。
- Cookie：host-only、HttpOnly、SameSite=Lax、Path=/、production Secure；D1 只存 token SHA-256 hash。預設 8 小時，不滑動延長。
- Approve／reject／logout／改密碼需 CSRF。UI 改密碼撤銷全部舊 sessions，再發目前瀏覽器新 session／CSRF。
- OAuth 使用 state＋PKCE；GitHub numeric ID 授權，login 僅顯示。Access token 只在記憶體中；不存 D1、不傳 frontend、不寫 log。
- Production CORS 精確允許 `https://flashingtw.github.io`（不含 repo path）；管理 API 同源。安全 headers／CSP／通用錯誤遮蔽沿用 main。Log 不得記 password、hash、token、cookie、OAuth query 或 body。
- DEV token 僅允許 APP_ENV=development 且顯式啟用；production DEV_ADMIN_MODE=false。

## 既有站更新順序（強制 release gate）

此處是待執行 runbook，不表示已取得 Cloudflare 授權或已部署。每一關失败立即停止，記錄實際狀態。

1. 只使用通過 isolation review 與 CI 的 rollout commit；不要 merge 原混合 branch。確認 main／Pages／Worker 版本與無未提交變更。
2. Cloudflare CLI 重新授權（`npx wrangler login`），確認帳號與 production DB binding。查 `npx wrangler deployments list --env production`、`npm run db:migrations:list:production` 及實際 schema／既有 owner。確認方案可負擔 KDF。
3. 確認備份／恢復點可用，檢查既有資料能滿足 0004 constraints。0004 重建 admins、admin_sessions、audit_logs 並保留資料，不只是 ADD COLUMN。若已套用，不重跑；migration ledger 與 schema 不一致時先停止診斷。
4. 只有確認 0001＋0002 已存在、唯一 pending 是 0004，且备份與 review 通過，才執行 `npm run db:migrate:production`。**不套 0003**；若現場狀態不同，先重做 migration review，不盲目跑全部 migrations。核對 IDs、sessions、audit、投稿資料與 foreign keys。
5. 保持舊版 Worker，測 GitHub OAuth、投稿、approve／reject、logout、audit，將 schema 影響與 code 影響分開。自動化的舊碼相容測試不能取代這個 production smoke gate。
6. 部署經驗證的 Local Auth Worker，保持 `LOCAL_AUTH_ENABLED=false`、`ADMIN_AUTH_PROVIDERS=github,local`、`DEV_ADMIN_MODE=false`。新 OAuth 程式即使 local 關閉也讀 0004 欄位，因此 schema 必須先上。
7. 管理 UI 是 Worker assets，與 Worker 一起部署；provider API 的 local=false 會隱藏帳密表單。**不可先部署新版登入 UI 到舊 Worker**，它沒有 providers API。再次測 GitHub／投稿／審核／logout／audit。
8. 先 `admin:bind-local ... --remote` dry-run，核對既有 owner 的 id，再 hidden prompt＋`--execute`。確認前後 id／GitHub ID／role／enabled 完全相同，沒有第二列 owner；不要查出或列印 password_hash。
9. 確認綁定後，受控改為 `LOCAL_AUTH_ENABLED=true` 並部署。開關關閉時無法完成真實帳密登入測試；本機 PBKDF2／binding 測試不是 production credential 驗證。
10. 測 local owner 登入、錯誤密碼、rate limit、改密碼使其他舊 sessions 失效、logout，以及 GitHub OAuth 備援。
11. 全部正常後才建立朋友 moderator，使用 `admin:add-local --remote` 預覽、確認、execute。
12. 更新部署狀態快照（commit／version／migration／smoke evidence）。Renderer／字型／R2 繼續凍結。

若部署新版後失敗，先關閉 local auth；需要 code rollback 時回已確認的舊 Worker 版本，保留已驗證相容的 0004 schema。不得自行 drop 欄位／資料表或回滾 production DB；DB 恢復需根據備份、維護窗口及新增資料風險另行決策。

## 發布邊界與驗證

```sh
npm run check
npm run check:rollout
npm test
npm run build
npm audit --audit-level=low
```

`build` 是 Worker production dry-run，不部署。`validate.yml` 在 codex branch push／PR 執行非部署 CI。Pages workflow 只有 main push／手動觸發才發布；**push main 本身會部署 Pages**，不可視為單純保存 checkpoint。

Worker 實際部署是 `npx wrangler deploy --env production`，不得在未通過上方關卡時執行。現有 production OAuth／SESSION_SECRET／DB 綁定沿用；不建立新 D1／R2 或公開 bootstrap API。Pages 變數使用現有 PAGES_API_BASE_URL 與 PAGES_SITE_URL；`build:pages` 只產生 frontend artifact，不含管理 JavaScript、Worker、migrations、secrets。

公開 health／CORS 唯讀 smoke：設定 SMOKE_API_BASE_URL、SMOKE_FRONTEND_ORIGIN 後執行 `npm run test:smoke:production`。Health 200 不代表 schema／完整登入已驗證。會寫資料的 production 投稿與審核 smoke 必須明確標記測試資料並核對 audit。

文案集中在 `frontend/content.json`；保留動態 placeholders，不放 secrets。不得提交 `.env`、`.dev.vars`、`.wrangler`、測試狀態或 hash。若 secret 曾入 git，必須撤銷／輪替，不是只刪檔。

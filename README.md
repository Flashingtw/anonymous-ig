# 匿名投稿 MVP

純 HTML/CSS/JavaScript frontend、Cloudflare Worker API、Cloudflare D1 與 GitHub OAuth 管理後台。第三階段已整理為可安全進入 production 部署流程的狀態；本專案仍未連接 Instagram、未建立任何線上資源，也未執行部署。

## 架構

Production 建議固定使用同一個 site 下的兩個 HTTPS origin：

```text
https://app.example.com       GitHub Pages frontend
https://api.example.com       Cloudflare Worker API
```

`app.example.com` 與 `api.example.com` 是 **same-site、different-origin**：

- 瀏覽器可以在 `SameSite=Lax` 下把 `api.example.com` 的 host-only session cookie 帶回 API。
- 因為 origin 不同，frontend 的 `fetch` 仍必須使用 `credentials: "include"`，Worker 也必須精確允許 `https://app.example.com` 的 CORS。
- Session cookie 不設定 `Domain=.example.com`。Frontend 不需要、也不應讀取管理 session。
- `USER.github.io` 與 `SERVICE.workers.dev` 是 cross-site，不適合作為本 OAuth cookie 架構的正式組合。

主要功能：

- 匿名投稿，免登入，trim 後 1–1000 個 Unicode code points。
- GitHub OAuth 管理員登入，使用 GitHub numeric user id 白名單。
- OAuth state、PKCE、D1 opaque session、CSRF token。
- `owner`、`admin`、`moderator` 管理角色與 disabled 檢查。
- Pending 投稿查看、approve、reject 與 audit log。
- Production 精確 CORS、安全 cookie、安全標頭、錯誤遮蔽與 D1 health check。
- GitHub Actions 只發布 `frontend/` 產生的 Pages artifact。
- Instagram publishing 邊界保留，但沒有 Meta App、token 或自動發文。

投稿狀態：

```text
pending ──approve──> approved ──未來 publisher──> posted
   └──────reject───> rejected
```

## 專案結構

```text
.github/workflows/deploy-pages.yml  main push 的 GitHub Pages workflow
frontend/                           GitHub Pages 相容的純 HTML/CSS/JS
  admin/                            GitHub 登入與投稿審核 UI
  config.js                         本機公開設定；production 產物會重新生成
  content.json                      可自行修改的網站文字
worker/src/
  handlers/                         auth、health、submissions use cases
  repositories/                     D1 admins、sessions、audit、submissions
  security/                         cookie、crypto、rate limit、CAPTCHA 邊界
  services/publishing.js            未來 Instagram publishing 邊界
  auth.js                           共用 admin auth / authorization / CSRF
migrations/
  0001_create_submissions.sql
  0002_create_admin_auth.sql
scripts/
  build-pages.js                    產生 frontend-only production artifact
  bootstrap-owner.js                私有 CLI owner bootstrap
  smoke-production.js               production 唯讀 smoke test
wrangler.dev.jsonc                  本機 Worker + static frontend
wrangler.jsonc                      production Worker 設定與 named environment
test/                               不呼叫真實 GitHub API 的自動測試
```

Production Worker 不會上傳 frontend assets；本機才由 `wrangler.dev.jsonc` 同源提供 frontend。正式 frontend 只由 GitHub Pages workflow 發布。

## 本地開發

需求：Node.js 22.5 以上與 npm。本專案鎖定 Wrangler `4.127.1`。

### 1. 安裝與本機變數

```bash
npm ci
cp .dev.vars.example .dev.vars
```

編輯 `.dev.vars`：

```dotenv
APP_ENV="development"
ADMIN_AUTH_PROVIDER="github"
GITHUB_CLIENT_ID="你的本機 OAuth App client id"
GITHUB_CLIENT_SECRET="你的本機 OAuth App client secret"
GITHUB_REDIRECT_URI="http://127.0.0.1:8787/api/auth/github/callback"
FRONTEND_URL="http://127.0.0.1:8787/"
SESSION_SECRET="至少 32 字元的本機隨機值"
SESSION_TTL_SECONDS="28800"
DEV_ADMIN_MODE="false"
ALLOWED_ORIGINS="http://127.0.0.1:8787,http://localhost:8787,http://localhost:8000"
```

產生本機 session secret：

```bash
openssl rand -base64 48
```

`.dev.vars` 與 `.env` 二選一；兩者都已忽略。`.dev.vars.example`、`.env.example` 只有假值，必須保留在版本庫。

### 2. 建立本機 GitHub OAuth App（GitHub 網頁）

GitHub **Settings → Developer settings → OAuth Apps → New OAuth App**：

- Homepage URL：`http://127.0.0.1:8787/`
- Authorization callback URL：`http://127.0.0.1:8787/api/auth/github/callback`

Callback 必須與 `GITHUB_REDIRECT_URI` 完全一致。不要啟用 wildcard callback、Device Flow，也不需要 `repo`、email 或 organization scope。建議 local 與 production 分別使用不同 OAuth App 與 secret。

### 3. 建立本機 D1 schema 與 owner

```bash
npm run db:migrate:local
```

查詢自己的 numeric GitHub user id；回應中的 `id` 是授權依據，`login` 只作顯示：

```bash
curl --fail --silent --show-error \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2026-03-10" \
  https://api.github.com/users/YOUR_USERNAME
```

先預覽，再明確加上 `--execute`：

```bash
npm run bootstrap:owner -- \
  --github-user-id 12345678 \
  --github-username YOUR_USERNAME \
  --local

npm run bootstrap:owner -- \
  --github-user-id 12345678 \
  --github-username YOUR_USERNAME \
  --local \
  --execute
```

Script 只接受純數字 GitHub id，使用普通 `INSERT` 建立 `role=owner`、`enabled=1`，再執行唯讀查詢確認；不會建立公開 bootstrap API。

### 4. 啟動

```bash
npm run dev
```

- 公開投稿：<http://127.0.0.1:8787/>
- 管理後台：<http://127.0.0.1:8787/admin/>
- Health：<http://127.0.0.1:8787/api/health>

### 本機 DEV 管理模式

沒有 local OAuth App 時，可以暫時將 `.dev.vars` 改為：

```dotenv
APP_ENV="development"
ADMIN_AUTH_PROVIDER="dev"
DEV_ADMIN_MODE="true"
DEV_ADMIN_TOKEN="至少 24 字元的本機隨機值"
```

並把 `frontend/config.js` 的 `ADMIN_AUTH_MODE` 改成 `"dev"`。只要 `APP_ENV` 不是精確的 `development`，後端就會拒絕 DEV provider，即使誤設 `DEV_ADMIN_MODE=true`。

> DEV mode 絕對不可用於 production。提交前請把 `frontend/config.js` 保持為 `github`。

## API

### Public

- `GET /api/health`：對 D1 執行唯讀 `SELECT 1`，成功只回 `{"ok":true}`。
- `POST /api/submissions`：建立匿名 pending 投稿；成功 `201`，不回顯全文。

### Authentication

- `GET /api/auth/github`
- `GET /api/auth/github/callback`
- `GET /api/auth/me`
- `POST /api/auth/logout`

### Admin

- `GET /api/admin/submissions?limit=50`
- `POST /api/admin/submissions/:id/approve`
- `POST /api/admin/submissions/:id/reject`

所有 `/api/admin/*` 都先驗證 session、admin existence、`enabled=1` 與 role。Approve、reject、logout 另驗證 `X-CSRF-Token`。

## Production 安全行為

### OAuth redirect

```text
https://app.example.com/admin/
→ https://api.example.com/api/auth/github
→ https://github.com/login/oauth/authorize
→ https://api.example.com/api/auth/github/callback
→ https://app.example.com/admin/?auth=<固定結果>
```

成功、取消、非管理員與可恢復的 callback 錯誤都回到 frontend。Frontend URL 只會收到固定的 `success`、`cancelled`、`unauthorized` 或 `error`，載入後立即移除；不會收到 authorization code、state、GitHub token、session id 或 GitHub 的錯誤描述。

OAuth access token 只存在 Worker 記憶體，取得 `/user` profile 後立即丟棄，不存 D1、不傳 frontend、不寫 log。Authorize request 不帶 `scope`。

### Session cookie 與 CSRF

Production session cookie：

```text
HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=...; Expires=...
```

- Cookie 是 `api.example.com` 的 host-only cookie，不設定 `Domain`。
- D1 只存 raw token 的 SHA-256 hash。
- 預設期限 8 小時；`SESSION_TTL_SECONDS` 可設 900 秒到 7 天，且不自動延長。
- Logout 刪除 D1 session 並清除同一路徑 cookie。
- Frontend 的所有 API `fetch` 都使用 `credentials: "include"`。
- Mutation 需要 session-bound CSRF token；token 只留在管理頁記憶體。

### CORS

Production 程式會同時檢查：

1. Request `Origin` 是合法 origin。
2. `ALLOWED_ORIGINS` 包含 `FRONTEND_URL` 的 HTTPS origin。
3. 實際 origin 精確等於該 frontend origin。

因此 production 即使誤把 `localhost`、HTTP、`*` 或其他 HTTPS origin 寫入 allowlist，也不會放行。沒有 `Origin` 的 OAuth top-level navigation、CLI 與 server-to-server request 仍可進入；同源 API request 也允許。

允許的 preflight 會回精確 `Access-Control-Allow-Origin`、`Access-Control-Allow-Credentials: true`、允許的 method/header 與 `Vary: Origin`。未允許 origin 回 `403`，且不附 CORS allow headers。

### Security headers 與 CSP

所有 API JSON、OAuth redirect、preflight 會套用：

- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `Cache-Control: no-store`
- API 專用 CSP：`default-src 'none'; frame-ancestors 'none'; base-uri 'none'`

Frontend HTML 使用 meta CSP；local 只允許 self 與本機 API，Pages build 會由唯一的 `PAGES_API_BASE_URL` 產生精確 production `connect-src`，不使用寬泛 `https:`。也設定 `object-src 'none'`、`frame-src 'none'` 與 `base-uri 'none'`。

GitHub Pages 無法直接自訂 HTTP response headers，而 `frame-ancestors` 不能由 meta CSP 有效設定。若未來需要 frontend 的 header-level `frame-ancestors`，應在可設定 response header 的 edge/proxy 或 hosting 層加入；不要在目前 HTML 假裝已受到該 header 保護。

### Production errors 與 logging

- Unhandled error 對 client 固定回通用 500；D1 health failure回通用 503。
- Production 5xx 不輸出 internal `details`，不回 stack、SQL、binding、secret 或 session 資訊。
- Production log 只記 method、pathname、status、安全 error code 與 error name；不記 query、header、cookie、body、錯誤訊息或 stack。OAuth callback log 也不記 callback URL、code、state 或 token。
- Development 仍可保留較詳細的明確 `HttpError` details。

## GitHub Pages production 設定

Workflow：`.github/workflows/deploy-pages.yml`

- Push 到 `main` 或手動 `workflow_dispatch` 時執行。
- 先執行 source check 與 tests。
- `scripts/build-pages.js` 只複製 `frontend/` 到 `.pages-dist/`。
- 只上傳 `.pages-dist/`；Worker source、migrations、`.dev.vars`、`.env` 與 secrets 不會進 artifact。
- `frontend/config.js` 保留本機 `API_BASE_URL: ""`；production artifact 才注入 API origin。

在 GitHub repository **Settings → Secrets and variables → Actions → Variables** 新增兩個公開變數：

| Repository Variable | 範例 | 限制 |
| --- | --- | --- |
| `PAGES_API_BASE_URL` | `https://api.example.com` | 必須是 HTTPS origin，不能有 path/query/hash |
| `PAGES_SITE_URL` | `https://app.example.com/` | 必須是 HTTPS URL，結尾要 `/` |

這些 URL 是公開設定，不是 secret。不要建立 `GITHUB_CLIENT_SECRET` 或 `SESSION_SECRET` 的 Pages/Actions 變數。

### `app.example.com` custom domain / CNAME

使用 custom GitHub Actions workflow 時，artifact 裡的 `CNAME` 檔會被忽略且不需要。因此本專案不提交或生成 `CNAME` 檔；請做兩個真正生效的設定：

1. DNS provider 建立：

   ```text
   Type: CNAME
   Name: app
   Target: YOUR_GITHUB_OWNER.github.io
   ```

   Target 不包含 repository name，不使用 wildcard。若 DNS 在 Cloudflare，初次驗證建議先用 DNS only。

2. GitHub repository **Settings → Pages → Custom domain** 填 `app.example.com`，驗證與憑證完成後啟用 **Enforce HTTPS**。

官方參考：[GitHub Pages custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)、[Managing a custom domain](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)。

## Cloudflare Worker production 設定

`wrangler.jsonc` 的 `env.production` 是正式 source of truth。部署、remote migrations、secrets 與 D1 execute 都必須帶 `--env production`；不要混用頂層 binding。

先替換：

- `GITHUB_CLIENT_ID`
- `GITHUB_REDIRECT_URI`
- `FRONTEND_URL`
- `ALLOWED_ORIGINS`
- D1 `database_name`
- D1 `database_id`（目前全零 UUID 是 fail-closed placeholder）

Production variables：

| 名稱 | 建議值 |
| --- | --- |
| `APP_ENV` | `production` |
| `ADMIN_AUTH_PROVIDER` | `github` |
| `DEV_ADMIN_MODE` | `false` |
| `GITHUB_CLIENT_ID` | production OAuth App Client ID |
| `GITHUB_REDIRECT_URI` | `https://api.example.com/api/auth/github/callback` |
| `FRONTEND_URL` | `https://app.example.com/` |
| `ALLOWED_ORIGINS` | `https://app.example.com` |
| `SESSION_TTL_SECONDS` | `28800` |

Production secrets 已在 config 中宣告為 required，但沒有值：

- `GITHUB_CLIENT_SECRET`
- `SESSION_SECRET`

設定時讓 Wrangler 顯示隱藏輸入提示；不要把值寫在 command、shell history、`wrangler.jsonc`、`.dev.vars.example`、`.env.example` 或 frontend：

```bash
npx wrangler secret put GITHUB_CLIENT_SECRET --env production
npx wrangler secret put SESSION_SECRET --env production
```

現行 `wrangler secret put` 會建立並立即部署一個 Worker version；只有在 production Worker 已正確建立、D1 id 已填好且準備進入部署流程時才執行。`secrets.required` 會讓缺少任一 secret 的正式 deploy fail closed。[Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。

為避免 dry-run 或初次 deploy 意外變更 DNS，`wrangler.jsonc` 沒有提交 `routes`。正式 Worker 部署後，請在 Cloudflare dashboard 手動加入 `api.example.com` Custom Domain；Cloudflare 會管理對應 DNS 與憑證。官方參考：[Workers Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/)。

## Production D1 migrations

先確認 `wrangler.jsonc` 的 production `database_id` 已替換為剛建立的 D1 id。接著只查看 pending migrations：

```bash
npm run db:migrations:list:production
```

第一次應依序看到：

```text
0001_create_submissions.sql
0002_create_admin_auth.sql
```

確認目標 database 名稱與檔案後再套用：

```bash
npm run db:migrate:production
npm run db:migrations:list:production
```

等價的完整 Wrangler 指令：

```bash
npx wrangler d1 migrations list DB --remote --env production
npx wrangler d1 migrations apply DB --remote --env production
npx wrangler d1 migrations list DB --remote --env production
```

不要對 production 使用 `--local`，也不要在未確認清單時跳過互動確認。D1 會記錄已套用 migration；單一 migration 失敗會 rollback 該 migration，先前成功的 migration 保留。[Wrangler D1 commands](https://developers.cloudflare.com/workers/wrangler/commands/d1/)。

## Bootstrap production 第一位 owner

1. 使用 GitHub public users API 查自己的 `id`；不要從 username 猜測，也不要把 username 當唯一識別。
2. 先用無 `--execute` 指令預覽 target、numeric id 與角色。
3. 確認顯示 `Target: remote` 後再執行。

```bash
npm run bootstrap:owner -- \
  --github-user-id 12345678 \
  --github-username YOUR_USERNAME \
  --remote

npm run bootstrap:owner -- \
  --github-user-id 12345678 \
  --github-username YOUR_USERNAME \
  --remote \
  --execute
```

Script 會使用 `DB --remote --env production`，普通 `INSERT` 建立 owner，並查回 `github_user_id`、display username、role、enabled。重複 numeric id 會由 UNIQUE constraint 拒絕，不會用 `INSERT OR REPLACE` 覆寫或 cascade 既有資料。

## Production smoke test

Worker 與兩個 custom domains 都可用後執行：

```bash
SMOKE_API_BASE_URL="https://api.example.com" \
SMOKE_FRONTEND_ORIGIN="https://app.example.com" \
npm run test:smoke:production
```

Script 只做：

- `GET /api/health` → `200` 與 `{"ok":true}`。
- `GET /api/submissions` → `405` / `Allow: POST`，確認 public route connectivity。
- 未登入 admin list → `401`。
- Allowed OPTIONS → 精確 CORS origin 與 credentials。
- Disallowed OPTIONS → `403` 且沒有 CORS allow headers。

它不會 `POST` 有效投稿，因此不會建立垃圾資料；OAuth、實際投稿、approve/reject、logout 與 expiration 會在結尾提示人工測試。

原本的 `npm run test:smoke` 是 **local-only**，會建立並處理三筆測試投稿，不可指向 production。

## Production Deployment Checklist

以下使用 `YOUR_GITHUB_OWNER`、`YOUR_REPOSITORY`、`example.com` 與 numeric id 作 placeholder。凡標記「網頁」的步驟都需要你登入對應網站；本專案不會替你操作。

### 0. Release gate（本機 CLI）

```bash
npm ci
npm run check
npm test
npm audit
npm run build
```

### 前置：啟用 Cloudflare zone（Cloudflare／網域註冊商網頁，需要登入）

`example.com` 必須先是目前 Cloudflare 帳號中的 **Active zone**，否則第 12 步無法把 `api.example.com` 加為 Worker Custom Domain：

1. Cloudflare **Websites → Add a domain**，加入正式網域。
2. 到網域註冊商把 nameservers 更新為 Cloudflare 指定值。
3. 等待 Cloudflare 顯示 **Active**。
4. 執行 `npx wrangler whoami`，記下 account name/id，並確保後續 D1、Worker、secrets 與 deploy 全部使用同一個 account。`account_id` 不是 secret，但本專案不替你猜測或寫入。

### 1. 建 GitHub repository（GitHub 網頁，需要登入）

建立 repository，不要上傳 `.dev.vars`、`.env` 或任何真 secret。

### 2. Push code 到 `main`（本機 CLI，需要 GitHub authentication）

目前目錄尚未初始化 Git 時：

```bash
git init
git add .
git status --short
git commit -m "Prepare production deployment"
git branch -M main
git remote add origin git@github.com:YOUR_GITHUB_OWNER/YOUR_REPOSITORY.git
git push -u origin main
```

逐項檢查 `git status`：不得出現 `.dev.vars`、`.env`、`dist/`、`.pages-dist/`、`.wrangler/` 或真實 secrets。第一次 Pages workflow 因 repository variables 尚未設定而 fail closed 是正常的；第 13 步會重新執行。

### 3. 建 Cloudflare D1（Cloudflare 登入 + 本機 CLI）

```bash
npx wrangler login
npx wrangler whoami
npx wrangler d1 create anonymous-submissions-production
```

再次確認 `whoami` 顯示的是前置步驟選定的同一 Cloudflare account。

### 4. 填入 `database_id`（本機檔案）

把 Cloudflare 回傳的 `database_name` 與 `database_id` 寫入 `wrangler.jsonc` 的 `env.production.d1_databases[0]`，替換全零 UUID。再次確認 binding 名為 `DB`。

### 5. 建 production Worker（Cloudflare 網頁，需要登入）

在 **Workers & Pages** 建立名為 `anonymous-submissions-api-production` 的 Worker。此名稱需與 `wrangler.jsonc` 的 production name 一致。暫時不要新增 public custom domain。

### 6. 套用 D1 migrations（本機 CLI，需要 Cloudflare 登入）

```bash
npm run db:migrations:list:production
npm run db:migrate:production
npm run db:migrations:list:production
```

確認只有 `0001`、`0002` 依序套用，最後沒有 pending migration。

### 7. Bootstrap 第一位 owner（本機 CLI，需要 Cloudflare 登入）

```bash
curl --fail --silent --show-error \
  -H "Accept: application/vnd.github+json" \
  -H "X-GitHub-Api-Version: 2026-03-10" \
  https://api.github.com/users/YOUR_USERNAME

npm run bootstrap:owner -- \
  --github-user-id 12345678 \
  --github-username YOUR_USERNAME \
  --remote

npm run bootstrap:owner -- \
  --github-user-id 12345678 \
  --github-username YOUR_USERNAME \
  --remote \
  --execute
```

### 8. 建 production GitHub OAuth App（GitHub 網頁，需要登入）

GitHub **Settings → Developer settings → OAuth Apps → New OAuth App**：

- Homepage URL：`https://app.example.com/`
- Authorization callback URL：`https://api.example.com/api/auth/github/callback`
- Wildcard callback：關閉
- Device Flow：關閉

保存 Client ID；Client Secret 只會在第 10 步輸入 Cloudflare。

### 9. 設 Worker variables（本機 `wrangler.jsonc`）

確認：

```text
APP_ENV=production
ADMIN_AUTH_PROVIDER=github
DEV_ADMIN_MODE=false
GITHUB_CLIENT_ID=<production client id>
GITHUB_REDIRECT_URI=https://api.example.com/api/auth/github/callback
FRONTEND_URL=https://app.example.com/
ALLOWED_ORIGINS=https://app.example.com
SESSION_TTL_SECONDS=28800
```

不要加入 localhost，不要使用 `*`。修改後 commit 並 push；仍不可提交 secret。

### 10. 設 Worker secrets（本機 CLI，需要 Cloudflare 登入）

先在本機產生一個新的 production session secret：

```bash
openssl rand -base64 48
```

再逐一執行，於隱藏提示貼上值：

```bash
npx wrangler secret put GITHUB_CLIENT_SECRET --env production
npx wrangler secret put SESSION_SECRET --env production
```

不要把值放在 command argument、pipe、檔案或 shell history。請記得 `secret put` 會立即部署一個新 Worker version。

### 11. 部署 Worker（本機 CLI，需要 Cloudflare 登入）

```bash
npm run build
npx wrangler deploy --env production
```

`npm run build` 是 dry-run；第二行才會實際部署。Required secrets 缺少時會拒絕 deploy。

### 12. 設 `api.example.com`（Cloudflare 網頁，需要登入）

Worker → **Settings → Domains & Routes → Add → Custom Domain**，輸入 `api.example.com`。確認 TLS 憑證有效。不要另建會與 Worker Custom Domain 衝突的手動 CNAME。

### 13. 部署 GitHub Pages（GitHub 網頁，需要登入）

1. Repository **Settings → Secrets and variables → Actions → Variables**：
   - `PAGES_API_BASE_URL=https://api.example.com`
   - `PAGES_SITE_URL=https://app.example.com/`
2. **Settings → Pages → Build and deployment → Source** 選 **GitHub Actions**。
3. 到 **Actions → Deploy frontend to GitHub Pages → Run workflow**，或再 push 一次 `main`。
4. 確認 artifact 來源是 `.pages-dist`。

### 14. 設 `app.example.com`（DNS + GitHub 網頁，需要登入）

1. DNS 建 `app CNAME YOUR_GITHUB_OWNER.github.io`，不含 repository path、不使用 wildcard。
2. GitHub **Settings → Pages → Custom domain** 填 `app.example.com`。
3. 驗證完成後啟用 **Enforce HTTPS**。

### 15. 更新並核對 OAuth URLs（GitHub 網頁，需要登入）

再次確認 Homepage 與 callback 完全一致，包括 scheme、hostname、path 與尾端 `/`。Callback 必須是：

```text
https://api.example.com/api/auth/github/callback
```

### 16. 驗證 health 與 CORS（本機 CLI）

```bash
SMOKE_API_BASE_URL="https://api.example.com" \
SMOKE_FRONTEND_ORIGIN="https://app.example.com" \
npm run test:smoke:production
```

另用瀏覽器 DevTools 確認 API response 的 `Access-Control-Allow-Origin` 是精確 app origin，不是 `*`。

### 17. 完整登入測試（瀏覽器，GitHub 登入）

從 `https://app.example.com/admin/` 開始，確認經 GitHub 與 API callback 回到同一管理頁。Frontend URL 不得出現 code、state、token 或 session id。登入後應顯示 username、role 與 pending list。

再用一個不在 `admins` 的 GitHub 帳號測試，應只看到 `Unauthorized / Not an administrator`，不洩漏其他 admin 資訊。

### 18. 匿名投稿測試（瀏覽器）

送出一篇清楚標記為 production approve test 的投稿，記下 UI 顯示的 submission id，確認成功訊息與管理頁 status=`pending`，並確認公開頁未要求登入。這篇會在第 19 步 approve，不會遺留 pending 測試資料。

### 19. Approve / reject 測試（瀏覽器 + 本機 CLI，需要 Cloudflare 登入）

再建立一篇清楚標記為 production reject test 的投稿並記下 id。Approve 第 18 步的投稿、reject 這篇投稿；確認兩篇都從 pending list 移除。將下列 `123`、`124` 換成實際 id，使用唯讀查詢核對 D1 與 audit：

```bash
npx wrangler d1 execute DB --remote --env production --command \
  "SELECT id, status FROM submissions WHERE id IN (123, 124) ORDER BY id;"

npx wrangler d1 execute DB --remote --env production --command \
  "SELECT action, submission_id, created_at FROM audit_logs WHERE submission_id IN (123, 124) ORDER BY id;"
```

預期一篇 `approved`、一篇 `rejected`，並分別有 `approve_submission`、`reject_submission`。不要使用真實敏感內容。

### 20. Logout / session expiration 測試（瀏覽器 + 本機 CLI，需要 Cloudflare 登入與維護時段）

1. Logout 後重新整理，`/api/auth/me` 與 admin API 應為 `401`。
2. `/api/auth/me` 的 `expiresAt` 應符合 `SESSION_TTL_SECONDS` 且不滑動延長。
3. 若要實際等待 expiration，在維護時段把 `wrangler.jsonc` 的 `SESSION_TTL_SECONDS` 暫設為 `900`，執行：

   ```bash
   npx wrangler deploy --env production
   ```

4. 重新登入取得新 session，等待超過 15 分鐘，確認 `/api/auth/me` 回 `401`。
5. 立即把 `SESSION_TTL_SECONDS` 恢復為 `28800`，再次執行：

   ```bash
   npx wrangler deploy --env production
   ```

6. 最後重新開啟 `wrangler.jsonc` 核對值確實為 `28800`，再登入確認新的 `expiresAt`。不要把測試用 900 秒留在 production。

## Git hygiene

`.gitignore` 已排除：

```text
.dev.vars
.dev.vars.*       （但保留 .dev.vars.example）
.env
.env.*            （但保留 .env.example）
dist/
.pages-dist/
.wrangler/
*.log
```

目前 workspace 尚未初始化 `.git`，因此本階段只能驗證 ignore 規則與檔案內容，不能證明過去是否曾追蹤 secret。建立 repository 後務必在第一次 commit 前人工檢查 `git status`；若 secret 曾被 commit，僅刪檔不夠，必須撤銷並輪替該 secret。

## 驗證指令

```bash
npm run check
npm test
npm audit
npm run build
```

- `npm test` 使用記憶體中的真實 SQLite migrations；GitHub token exchange/profile 完全 mock。
- 測試涵蓋 OAuth、session、CSRF、roles、audit、production cookies、CORS、health、錯誤遮蔽、Pages artifact 與 owner bootstrap SQL。
- `npm run build` 是 `wrangler deploy --dry-run --env production`，只 bundle、不部署。

## 修改網站文字

主要可見文案集中在 `frontend/content.json`。`{current}`、`{max}`、`{over}`、`{count}`、`{id}`、`{min}`、`{username}`、`{role}`、`{year}` 是動態 placeholder；修改句子時保留需要的 placeholder。`content.json` 是公開檔案，絕對不可放 secret。

社群圖文字原稿是 `frontend/og-editable.svg`。修改後可執行：

```bash
npm run generate:og
```

Pages build 會把 public HTML fallback 與 `content.json` 的 social image URL 改為 `PAGES_SITE_URL` 下的 `og.png`。

## 暫不包含

- Instagram Graph API
- Meta App
- 自動發布貼文
- Turnstile
- Cloudflare rate limiting
- 新 framework

Rate limit 與 CAPTCHA adapter 仍保留在程式邊界並預設關閉，沒有在第三階段建立或啟用任何資源。

# 大安匿名 / DAAN ANONYMOUS

「大安匿名」是免登入的匿名投稿平台，使用純 HTML/CSS/JavaScript frontend、Cloudflare Worker API、Cloudflare D1，以及共用同一套安全 session 的 GitHub OAuth／本機帳密管理員登入。既有公開站、Worker、D1 與 GitHub OAuth 已部署；本分支的黑橘品牌改版、圖片 renderer 與 Local Account Login 都仍只在本機開發，尚未套用至 production。本專案未連接 Instagram。

## 文件與目前狀態

本 README 是操作與規則入口；[登入實作報告](docs/local-auth-implementation.md) 記錄安全設計與驗證，[部署狀態快照](docs/deployment-status.md) 記錄有日期的線上查詢結果。歷史驗證成功不等於功能已部署，也不等於正式帳號已建立。

4.5 本機階段已凍結於 `19f18c73ca5e3a4a4831cd045a603b14b0724be4`（101/101 tests）；後續 CI／部署準備另行提交，不改写此 checkpoint。任何人或自動化代理在部署前都必須先讀本 README 與 `docs/deployment-status.md`，再重新查證遠端，不得只依舊對話推測 production 狀態。

- 本機新版：GitHub OAuth 保留，新增一般帳號密碼登入；正式站目前仍是舊版 GitHub 登入。
- 帳號：3–32 個英數字或 `_`、`-`、`.`，登入不分大小寫。密碼：8–128 個使用者可見字元，不限數字、不可全空白，另有 1024 UTF-8 bytes 上限。
- 建立管理員只使用受信任 CLI；沒有公開註冊。新增帳號預設 `moderator`；`owner`、`admin` 必須明確指定，不會因使用帳密登入而自動升權。
- `local` 在登入名稱中指「帳密身分」，不表示只能在本機使用。CLI 的 `--local`／`--remote` 才是資料庫目標；本機帳號不會自動同步到正式 D1。
- 本次只統一規則與文件，不代表授權部署、套用正式 migration 或建立正式帳號。

## 登入入口與資料庫目標

| 環境 | 入口 | 帳號／資料庫 |
| --- | --- | --- |
| 一般本機開發 | `http://127.0.0.1:8787/admin/`，用 `npm run dev` 啟動 | Wrangler 預設 `.wrangler/state/`；使用標準 CLI `--local` |
| 這次的隔離測試 | `http://127.0.0.1:8788/admin/`，需測試服務仍在執行 | `tmp/local-auth-ui-state/`；使用下方測試 helper |
| 正式公開投稿 | [GitHub Pages](https://flashingtw.github.io/anonymous-ig/) | 不承載管理 session；`admin/` 只轉址 |
| 正式管理後台 | [Cloudflare Worker /admin/](https://anonymous-submissions-api-production.flashingtw.workers.dev/admin/) | production D1；經明確授權才使用標準 CLI `--remote` |

8787 與 8788 是兩套不同的本機資料，不能混用建立帳號指令。`tmp/` 被 Git 忽略，測試 helper 不會隨 clone、Pages 或 Worker 部署交付；新的工作目錄請使用下方一般本機開發流程。

目前工作目錄的 8788 隔離測試，PowerShell 執行：

```powershell
cd E:\anonymous
node tmp/manage-test-admin.mjs add-local --username friend01 --role moderator --execute
node tmp/manage-test-admin.mjs list
```

把 `friend01` 換成想建立的帳號；helper 固定本機目標與隔離資料夾，不要另外加 `--local` 或 `--remote`。依序在 `Password:`、`Confirm password:` 輸入相同密碼（不顯示字元），看到 `Admin change completed and audited.` 才算建立成功。若出現 `Password must contain at least 8 characters.`，請重新執行指令並輸入符合規則的密碼；不要把密碼貼進對話或命令列。已存在帳號要重設密碼，將 `add-local` 改成 `set-password` 並移除 `--role moderator`。

## 架構

Production 不使用自訂網域，分成公開網站與管理站兩個邊界：

```text
https://flashingtw.github.io/anonymous-ig/   GitHub Pages 公開投稿頁
https://anonymous-submissions-api-production.flashingtw.workers.dev/      Cloudflare Worker 管理後台 + API
```

這兩個網址是 **cross-site、different-origin**，因此不讓 GitHub Pages 承載管理 session：

- 公開投稿頁跨 origin 呼叫 Worker 時使用 `credentials: "omit"`；production CORS 只允許精確 origin `https://flashingtw.github.io`。Origin 不包含 `/anonymous-ig/` path。
- 管理 UI 由 Worker assets 提供，與 `/api/auth/*`、`/api/admin/*` 完全同源，所有管理 API request 使用 `credentials: "include"`。
- Pages 的 `/anonymous-ig/admin/` 只是一個不含管理程式碼的 handoff 頁，立即導向 Worker `/admin/`。
- Session cookie 是 `anonymous-submissions-api-production.flashingtw.workers.dev` 的 host-only cookie，不設定 `Domain`，GitHub Pages 不需要、也不應讀取管理 session。

目前工作區的功能範圍（不代表全部已上線）：

- 匿名投稿，免登入，trim 後 1–1000 個 Unicode code points。
- GitHub OAuth 管理員登入，使用 GitHub numeric user id 白名單。
- 可選的 Local Account Login；不提供公開註冊，帳號只能由受信任的 CLI 建立。
- OAuth state、PKCE、D1 opaque session、CSRF token。
- `owner`、`admin`、`moderator` 管理角色與 disabled 檢查。
- Pending 投稿查看、approve、reject 與 audit log。
- Pending、approved、rejected 分頁與 approved-only 圖片預覽流程。
- `classic-canva` renderer 只在既有 Canva PNG 上疊加投稿編號與內文，不重畫模板。
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
  admin/                            GitHub／帳密登入與投稿審核 UI
  config.js                         本機公開設定；production 產物會重新生成
  content.json                      可自行修改的網站文字
worker/src/
  handlers/                         auth、health、submissions use cases
  repositories/                     D1 admins、sessions、audit、submissions
  rendering/                        classic-canva 排版、字型與 SVG/WASM renderer
  security/                         cookie、crypto、password KDF、login limiter 與 CAPTCHA 邊界
  storage/                          local memory / future R2 image storage adapters
  services/publishing.js            未來 Instagram publishing 邊界
  auth.js                           共用 admin auth / authorization / CSRF
migrations/
  0001_create_submissions.sql
  0002_create_admin_auth.sql
  0003_add_submission_rendering.sql
  0004_add_local_admin_auth.sql
scripts/
  build-pages.js                    產生 frontend-only production artifact
  bootstrap-owner.js                私有 CLI owner bootstrap
  manage-admin.js                   私有 local admin 管理 CLI
  smoke-production.js               production 唯讀 smoke test
  render-fixtures.mjs               產生 deterministic classic visual fixtures
wrangler.dev.jsonc                  本機 Worker + static frontend
wrangler.jsonc                      production Worker 設定與 named environment
test/                               不呼叫真實 GitHub API 的自動測試
```

Production Worker 透過 Workers Assets 提供管理 UI；`/` 會導回 GitHub Pages 的公開投稿頁。GitHub Pages workflow 則只發布公開 UI，並把 `/admin/` 換成導往 Worker 的安全 handoff 頁。`wrangler.dev.jsonc` 仍在本機同源提供完整 frontend。

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
ADMIN_AUTH_PROVIDERS="github,local"
LOCAL_AUTH_ENABLED="true"
GITHUB_CLIENT_ID="你的本機 OAuth App client id"
GITHUB_CLIENT_SECRET="你的本機 OAuth App client secret"
GITHUB_REDIRECT_URI="http://127.0.0.1:8787/api/auth/github/callback"
FRONTEND_URL="http://127.0.0.1:8787/"
SESSION_SECRET="至少 32 字元的本機隨機值"
SESSION_TTL_SECONDS="28800"
LOGIN_RATE_LIMIT_MAX_ATTEMPTS="5"
LOGIN_RATE_LIMIT_WINDOW_SECONDS="900"
LOGIN_RATE_LIMIT_BLOCK_SECONDS="900"
DEV_ADMIN_MODE="false"
ALLOWED_ORIGINS="http://127.0.0.1:8787,http://localhost:8787,http://localhost:8000"
```

`ADMIN_AUTH_PROVIDER` 是舊版相容設定；非空的 `ADMIN_AUTH_PROVIDERS` 優先。`LOCAL_AUTH_ENABLED` 是帳密登入的決定性開關：精確為 `true` 時加入 local provider，其他值會移除 local provider，即使清單包含 `local` 也不啟用。一般環境保留 `github`，不要為新增帳密登入移除 OAuth；DEV 模式只供本機隔離測試。

產生本機 session secret：

```bash
openssl rand -base64 48
```

`.dev.vars` 與 `.env` 二選一；兩者都已忽略。`.dev.vars.example`、`.env.example` 只有假值，必須保留在版本庫。

### 2. 建立本機 GitHub OAuth App（GitHub 網頁，可選）

GitHub **Settings → Developer settings → OAuth Apps → New OAuth App**：

- Homepage URL：`http://127.0.0.1:8787/`
- Authorization callback URL：`http://127.0.0.1:8787/api/auth/github/callback`

Callback 必須與 `GITHUB_REDIRECT_URI` 完全一致。不要啟用 wildcard callback、Device Flow，也不需要 `repo`、email 或 organization scope。建議 local 與 production 分別使用不同 OAuth App 與 secret。

若這次只測 Local Account Login，可以暫時不建立本機 OAuth App；GitHub 登入按鈕會保留，但 GitHub provider 設定不完整時無法完成登入。

### 3. 建立本機 D1 schema 與帳號

```bash
npm run db:migrate:local
```

只測帳密登入時，直接建立預設的 moderator，不必先建立 GitHub owner：

```powershell
npm run admin:add-local -- --username friend01 --role moderator --local --execute
```

這個帳號在標準 8787 開發資料庫，不在 8788 隔離測試庫。若需要本機 owner，可明確指定 `--role owner`。以下 GitHub owner bootstrap 是另一種選項，僅在需要且尚未建立時使用。

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
ADMIN_AUTH_PROVIDERS="dev"
LOCAL_AUTH_ENABLED="false"
DEV_ADMIN_MODE="true"
DEV_ADMIN_TOKEN="至少 24 字元的本機隨機值"
```

並把 `frontend/config.js` 的 `ADMIN_AUTH_MODE` 改成 `"dev"`。只要 `APP_ENV` 不是精確的 `development`，後端就會拒絕 DEV provider，即使誤設 `DEV_ADMIN_MODE=true`。

> DEV mode 絕對不可用於 production。提交前請把 `frontend/config.js` 保持為 `github`。

## Local Account Login 安全設計

Local login 是 GitHub OAuth 的並存選項，不是另一套權限系統：兩種登入都解析到同一筆 `admins.id`，共用 `admin_sessions`、HttpOnly cookie、role、enabled 檢查、CSRF、audit log 與 `/api/admin/*` middleware。同一筆 admin 可以只有 GitHub、只有 local，或同時有兩種 identity；網站不提供 `/register`、Create account、forgot password 或公開新增管理員 API。

### Username 與 password

- Username 顯示值保留原始大小寫；登入與唯一性使用 trim 後的 ASCII lowercase `username_normalized`。只允許 `A–Z`、`a–z`、`0–9`、`_`、`-`、`.`，長度 3–32，因此 `Flash`、`flash`、`FLASH` 是同一帳號。
- `admins.id` 才是不可變的內部 identity；username 可在未來安全改名，不作 foreign key。
- 密碼長度以 Unicode grapheme cluster 計算，允許 passphrase，需 8–128 graphemes、不可只有空白，且另設 1024 UTF-8 bytes 上限；密碼不做 silent truncation，也不強迫大小寫或特殊符號組合。
- Hash 使用 Workers Web Crypto 的 PBKDF2-HMAC-SHA-256、每筆獨立 16-byte random salt、600,000 iterations、32-byte derived key。儲存格式為 `pbkdf2_sha256$600000$BASE64URL_SALT$BASE64URL_HASH`，方便未來辨識版本與升級 KDF。
- 沒有找到 username 時仍會驗證一個固定、公開且格式正確的 dummy hash，避免最明顯的「不存在帳號立即回應」timing enumeration。這只能縮小差異，不宣稱能完全消除所有 side channel。

目前 Cloudflare Workers 的 Web Crypto 原生支援 PBKDF2，而 Workers 的 Node crypto 相容層沒有 Argon2 API；因此本版不加入 native bcrypt／scrypt addon 或不明 WASM。PBKDF2 參數採 OWASP 現行 PBKDF2-HMAC-SHA-256 建議值。參考：[Cloudflare Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)、[Cloudflare Node crypto compatibility](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)、[OWASP Password Storage Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)。

### 登入防護

- 錯誤 username、錯誤 password 與 disabled admin 對 client 一律回 `401 INVALID_CREDENTIALS`，不指出是哪個欄位錯誤；response 不包含 password hash、session token 或內部 identity。
- 依「client IP」與「normalized username」兩個維度分別限制：15 分鐘內最多 5 次密碼驗證，第 5 次仍可驗證，後續嘗試封鎖 15 分鐘並回 `429 TOO_MANY_ATTEMPTS`。驗證前即以原子操作保留名額，包含同時進行中的請求，防止併發繞過。數值可用 `LOGIN_RATE_LIMIT_MAX_ATTEMPTS`、`LOGIN_RATE_LIMIT_WINDOW_SECONDS`、`LOGIN_RATE_LIMIT_BLOCK_SECONDS` 調整。
- Development/test 使用 process-memory adapter；production 使用 D1 bounded state。IP 與 username 會先以 `SESSION_SECRET` 做 HMAC，D1 不存明文；過期 rate-limit rows 會定期刪除，不逐次永久累積。
- 成功登入只清除該 username 的暫時計數；IP 計數保留並自然到期，避免攻擊者用有效帳號反覆登入來重置對其他人的攻擊預算。共用 NAT 的管理員可能共用此限制。登入產生全新 opaque session token，D1 只存 SHA-256 token hash；若瀏覽器原有 session cookie，建立新 session 時會一併撤銷，避免 session fixation。建立 session 的 SQL 會再次確認 enabled 與驗證過的 password hash，阻止密碼重設期間的舊密碼登入競態。
- Local login 本身沒有既有 CSRF token，所以 production 只接受 Worker 管理頁的同源 `Origin`，並拒絕 cross-site Fetch Metadata。攻擊者頁面無法強迫瀏覽器登入攻擊者帳號。這也表示 production Local login 必須從 Worker 同源 `/admin/` 使用，不從 GitHub Pages 直接送出。
- `local_login_failed` audit 只保存 generic failure metadata；不保存 plaintext password、完整 IP、username、cookie 或 hash。一般 API production log 也不記 request body、query、headers 或 stack。

### Password change 與 owner safety

有 local identity 的已登入管理員可在後台使用「修改密碼」。`POST /api/admin/account/password` 需要現有 admin session 與 session-bound CSRF，會驗證 current password、confirmation 與新密碼 policy。成功時在同一個 D1 batch 中更新 hash、刪除該 admin 的所有 sessions、建立一個只給目前瀏覽器的新 session，並寫入 `password_changed` audit；前端會立即接收旋轉後的新 CSRF token。

`0004_add_local_admin_auth.sql` 另建立 database triggers，禁止 disable、delete 或 demote 最後一位 enabled owner。這是 D1 最終防線，不依賴 CLI 或未來 UI 的按鈕狀態。

密碼更新的 SQL 同時檢查原 session 仍存在且未過期、admin 仍 enabled、原 password hash 未改變。CLI disable 會撤銷既有 sessions，因此重新 enable 不會復活舊 cookie。

### 用 CLI 建立與管理帳號

先套用本機 migration：

```bash
npm run db:migrate:local
```

替朋友建立 `moderator` 時先預覽；預覽不詢問密碼，也不讀寫 D1：

```bash
npm run admin:add-local -- --username friend01 --role moderator --local
```

確認 target、username、role 都正確後才加 `--execute`。只有這時 CLI 才會在 TTY 中隱藏輸入兩次密碼；不接受 `--password`，密碼與 encoded hash 都不會出現在 argv、shell history 或一般 console output：

```bash
npm run admin:add-local -- --username friend01 --role moderator --local --execute
```

其他管理指令：

```bash
npm run admin:list -- --local

npm run admin:set-role -- --username friend01 --role admin --local --execute

npm run admin:disable -- --username friend01 --local --execute

npm run admin:enable -- --username friend01 --local --execute

npm run admin:set-password -- --username friend01 --local --execute
```

所有 mutation 預設都是 dry-run，必須明確加 `--execute`；`list` 只顯示 id、local username、GitHub display username、role、enabled、auth methods 與建立時間，不查詢或顯示 password hash。設定／重設密碼也會撤銷該帳號全部既有 sessions。

### 綁定既有 GitHub 管理員（admin:bind-local）

4.5 checkpoint 之後新增的 rollout 工具；只更新既有管理員的 local identity，不新增 `admins` row，不改 `id`、`github_user_id`、GitHub 顯示名稱、role 或 enabled。自己已有 GitHub owner 時使用這個指令；朋友的新帳號才使用 `admin:add-local`。

本機 8787 先預覽，再執行（將 `12345678` 換成確實存在的 numeric GitHub ID；以下單行指令也適用 PowerShell）：

```powershell
npm run admin:bind-local -- --github-user-id 12345678 --username my.owner --local
npm run admin:bind-local -- --github-user-id 12345678 --username my.owner --local --execute
```

正式環境用法如下，**僅供經授權的 rollout，這次沒有執行**：

```powershell
npm run admin:bind-local -- --github-user-id 12345678 --username my.owner --remote
npm run admin:bind-local -- --github-user-id 12345678 --username my.owner --remote --execute
```

- 與 `add-local` 的純文字預覽不同，`bind-local` 的 dry-run 會唯讀查詢指定 D1，所以需要已套用 `0004` 且具備該環境查詢權限。它不詢問密碼、不寫入 DB，顯示 `Target: remote`／`local` 及 `Will bind to admin id X (role owner, unchanged). No new admin row.`；先核對 ID 與角色，不正確就停止。
- `--execute` 仍會先查詢並顯示目標 ID，再透過 hidden TTY 輸入／確認 8–128 字元密碼。拒絕 `--password`、`--role`、不存在或多筆 GitHub identity、disabled admin、username 衝突，以及已具 local identity 的目標。
- 寫入當下再次檢查預覽的 admin ID、GitHub ID、角色、enabled、尚未綁定與 username 未被使用，避免預覽後的競態。不覆寫現有帳密；重設已綁帳號請用 `admin:set-password`，改綁 username 不屬此指令範圍。
- 沿用 PBKDF2 abstraction、私有暫存 SQL 與日誌；同一個 D1 transaction 內更新帳密、寫入 `admin_local_identity_bound` audit、撤銷該 admin 的全部 sessions。audit actor 為 NULL，metadata 包含 CLI source 與 target admin ID，不存明文密碼／hash。失敗回滾，其他管理員不受影響。
- 成功不會啟用 `LOCAL_AUTH_ENABLED`。開關仍為 false 時只能確認 CLI 綁定結果與 GitHub 備援，不能宣稱已完成正式帳密登入；正式帳密端到端驗證要等受控啟用後進行。

此指令使用標準 `.wrangler/state/` 或 production D1；不搭配 gitignored 的 8788 helper，避免查詢與寫入落在不同測試庫。

CLI 在 Windows 直接以 Node 啟動已安裝的 Wrangler，避免 `.cmd` shell 相容性與字串插值問題。含 hash 的 SQL 與 Wrangler 日誌放在同一個私人暫存目錄，完成或失敗後一起刪除；Unix 使用 `0700/0600`，Windows 使用僅目前帳號與 SYSTEM 可存取的 ACL，無法套用 ACL 時停止。不要在不支援 ACL 的 Windows 暫存磁碟執行密碼管理；主機管理員仍屬受信任邊界。

API 錯誤保留既有 `{ ok: false, error: { code, message } }` 格式。無效帳密一律使用 `INVALID_CREDENTIALS`，限流使用 `TOO_MANY_ATTEMPTS`，不增加第二套前端錯誤格式。

### 本機驗證與 production 前確認

`npm test` 現在包含 workerd / Miniflare 實際 runtime 驗證，涵蓋帶有既有資料的 `0001`–`0003` 升級、PBKDF2 600,000 次登入、Worker 產生的 hash 與 Node CLI 互通、session rotation、D1 限流併發與 CLI SQL。測試使用獨立暫存資料庫；GitHub 網路呼叫仍為 mock。Windows ACL 測試必須在可設定測試目錄 ACL 的正常使用者環境執行。

2026-09-07 已在獨立本機目錄 `tmp/local-auth-ui-state/` 透過 Wrangler 成功套用 `0001`–`0004`，並檢查 390px 登入頁與 Enter 錯誤提示。此結果不代表 production migrations 已套用。AppleDouble `._*` 保留在磁碟，但來源檢查、Pages/Worker assets 和 migration 探索都已排除它們；`.git` 內既有 metadata 的修復不屬本次登入實作。

Production 仍維持 `LOCAL_AUTH_ENABLED=false`。發布前先備份並核對實際 migration 狀態：若 production 已有 `0003`，只套用 `0004`；先完成 schema，再更新程式，驗證 GitHub OAuth，建立 local admin，最後才啟用 local login。帳密登入沿用 `DB`，不需要新的付費 Rate Limiting / Durable Object / R2 binding。Render 的 R2 是獨立需求。

另外需確認 Worker 的 CPU 預算：本機 workerd 成功不等於 production plan 足夠。PBKDF2 與改密碼需要密集計算；上線前應依實際方案與當時的 [Workers limits](https://developers.cloudflare.com/workers/platform/limits/) 驗證 CPU 指標，不應為了遷就方案降低 KDF 強度。完整交付說明見 [Local Account Login 實作報告](docs/local-auth-implementation.md)。

未來部署經人工確認後，可把上例的 `--local` 換成 `--remote`；remote 固定使用 production D1 binding 與 `--env production`。**本階段不要執行 remote mutation。** `add-local` 只建立全新的 local-only row；若某人已經是 GitHub admin，應使用 `admin:bind-local` 綁定同一筆 `admins.id`，不要再建立第二列。沒有公開 account-linking UI／API。

## API

以下是本機新版契約，不是正式站即時 API 清單；正式可用狀態見 [部署狀態快照](docs/deployment-status.md)。

### Public

- `GET /api/health`：對 D1 執行唯讀 `SELECT 1`，成功只回 `{"ok":true}`。
- `POST /api/submissions`：建立匿名 pending 投稿；成功 `201`，不回顯全文。

### Authentication

- `GET /api/auth/providers`
- `POST /api/auth/login`
- `GET /api/auth/github`
- `GET /api/auth/github/callback`
- `GET /api/auth/me`
- `POST /api/auth/logout`

### Admin

- `GET /api/admin/submissions?status=pending|approved|rejected&limit=50`
- `POST /api/admin/submissions/:id/approve`
- `POST /api/admin/submissions/:id/reject`
- `POST /api/admin/submissions/:id/render`
- `GET /api/admin/submissions/:id/preview`
- `POST /api/admin/account/password`

所有 `/api/admin/*` 都先驗證 session、admin existence、`enabled=1` 與 role。Approve、reject、render、password change、logout 另驗證 `X-CSRF-Token`。只有 `approved` 投稿可以 render；preview 圖片 key 永不回傳 frontend。

## Classic Canva 圖片 renderer（本機開發中）

正式模板是 `assets/DAAN-anonymous.png`（1080 × 1350）。程式不重畫背景、紙張、膠帶或材質，只加入 `#XXX` 與投稿內容。所有初始 calibration 位於 `worker/src/rendering/templates/classic-canva.js`。

Renderer 使用：

- `opentype.js` 解析實際字型、量測 advance/outline bounding box，並把文字轉成 SVG path。
- `@resvg/resvg-wasm` 在 Cloudflare Workers 相容的 WASM runtime 中，把原始 PNG 與 SVG paths 合成 PNG。
- 同一組 glyph outline 同時用於量測與繪製，因此編號可依可見 bounding box 精準置中，不使用 synthetic bold。
- `Intl.Segmenter` 以 Unicode grapheme cluster 計數；換行依實際 rendered width，不使用固定字數切行。

正式字型不允許 fallback。需要合法檔案：

```text
assets/fonts/Anton-Regular.ttf
assets/fonts/KeHuaJinXiuTi-Traditional.ttf
```

如果檔案不存在，正式 renderer 會以 `RENDER_FONT_ASSET_MISSING` 明確停止。若正式中文字型缺少某個 emoji glyph，也會拒絕而不是顯示 tofu 或偷偷換字型。

Deterministic fixtures 指令：

```bash
npm run render:fixtures
```

成功時輸出到 gitignored 的 `tmp/render-fixtures/`。目前缺正式字型時，這個指令預期會停止並列出缺少的合法字型路徑。

圖片 binary 不寫入 D1。`imageStorage.put/get/delete` 的 local memory adapter 只供本機與測試；R2 adapter 已預留，但 production 未建立或綁定 R2，因此 production 會 fail closed，不能使用 isolate memory 假裝永久儲存。

## Production 安全行為

### OAuth redirect

```text
https://flashingtw.github.io/anonymous-ig/admin/       （Pages handoff）
→ https://anonymous-submissions-api-production.flashingtw.workers.dev/admin/
→ https://anonymous-submissions-api-production.flashingtw.workers.dev/api/auth/github
→ https://github.com/login/oauth/authorize
→ https://anonymous-submissions-api-production.flashingtw.workers.dev/api/auth/github/callback
→ https://anonymous-submissions-api-production.flashingtw.workers.dev/admin/?auth=<固定結果>
```

成功、取消、非管理員與可恢復的 callback 錯誤都回到 Worker 管理頁。管理頁 URL 只會收到固定的 `success`、`cancelled`、`unauthorized` 或 `error`，載入後立即移除；不會收到 authorization code、state、GitHub token、session id 或 GitHub 的錯誤描述。

OAuth access token 只存在 Worker 記憶體，取得 `/user` profile 後立即丟棄，不存 D1、不傳 frontend、不寫 log。Authorize request 不帶 `scope`。

### Session cookie 與 CSRF

Production session cookie：

```text
HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=...; Expires=...
```

- Cookie 是 `anonymous-submissions-api-production.flashingtw.workers.dev` 的 host-only cookie，不設定 `Domain`，也不會提供給 GitHub Pages。
- D1 只存 raw token 的 SHA-256 hash。
- 預設期限 8 小時；`SESSION_TTL_SECONDS` 可設 900 秒到 7 天，且不自動延長。
- Logout 刪除 D1 session 並清除同一路徑 cookie。
- Worker 管理頁的 API `fetch` 使用 `credentials: "include"`；Pages 公開投稿 request 明確使用 `credentials: "omit"`。
- Mutation 需要 session-bound CSRF token；token 只留在管理頁記憶體。

### CORS

Production 的 cross-origin public API 只允許精確的 `https://flashingtw.github.io`。`/anonymous-ig/` 是 URL path，不可寫入 `ALLOWED_ORIGINS`。`localhost`、HTTP、`*`、`null` 或其他 HTTPS origin 都不會放行。沒有 `Origin` 的 OAuth top-level navigation、CLI 與 server-to-server request仍可進入；Worker 管理頁的同源 API request 也允許。

允許的 Pages preflight 會回精確 `Access-Control-Allow-Origin: https://flashingtw.github.io`、允許的 method/header 與 `Vary: Origin`；公開 request 不依賴 credentialed CORS。未允許 origin 回 `403`，且不附 CORS allow headers。管理 UI 與管理 API 同源，不依賴 CORS 傳送 session cookie。

### Security headers 與 CSP

所有 API JSON、OAuth redirect、preflight 會套用：

- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: no-referrer`
- `Cache-Control: no-store`
- API 專用 CSP：`default-src 'none'; frame-ancestors 'none'; base-uri 'none'`

Frontend HTML 使用 meta CSP；local 只允許 self 與本機 API，Pages build 會由唯一的 `PAGES_API_BASE_URL` 產生精確 Worker `connect-src`，不使用寬泛 `https:`。Worker 另外為管理 HTML 設定只允許 `'self'` 的 response CSP 與 `X-Frame-Options: DENY`。兩邊也設定 `object-src 'none'`、`frame-src 'none'` 與 `base-uri 'none'`。

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
- Build 會保留公開投稿頁，但把 `.pages-dist/admin/` 改成只導向 Worker `/admin/` 的 handoff，且不把管理 JavaScript 放進 Pages artifact。
- 只上傳 `.pages-dist/`；Worker source、migrations、`.dev.vars`、`.env` 與 secrets 不會進 artifact。
- `frontend/config.js` 保留本機 `API_BASE_URL: ""`；production artifact 才注入 API origin。

在 GitHub repository **Settings → Secrets and variables → Actions → Variables** 新增兩個公開變數：

| Repository Variable | 範例 | 限制 |
| --- | --- | --- |
| `PAGES_API_BASE_URL` | `https://anonymous-submissions-api-production.flashingtw.workers.dev` | 必須使用實際 deploy 回傳的 Worker HTTPS origin，不能有 path/query/hash |
| `PAGES_SITE_URL` | `https://flashingtw.github.io/anonymous-ig/` | 固定的 GitHub Pages project site URL，結尾要 `/` |

這些 URL 是公開設定，不是 secret。不要建立 `GITHUB_CLIENT_SECRET` 或 `SESSION_SECRET` 的 Pages/Actions 變數。

### Pages 網址（不使用 custom domain）

Repository 是 `Flashingtw/anonymous-ig`，所以公開 project site 固定為：

```text
https://flashingtw.github.io/anonymous-ig/
```

不需要 Cloudflare zone、DNS record、CNAME 檔或 GitHub Pages Custom domain。Repository **Settings → Pages → Build and deployment → Source** 選 **GitHub Actions** 即可；部署完成後確認顯示的 URL 與上述網址一致。官方參考：[GitHub Pages custom workflows](https://docs.github.com/en/pages/getting-started-with-github-pages/using-custom-workflows-with-github-pages)。

## Cloudflare Worker production 設定

`wrangler.jsonc` 的 `env.production` 是正式 source of truth。部署、remote migrations、secrets 與 D1 execute 都必須帶 `--env production`；不要混用頂層 binding。

目前設定已指向既有 production 資源。更新時只核對，不要重新建立 D1 或隨意替換 OAuth／session 設定：

- `GITHUB_CLIENT_ID`
- `GITHUB_REDIRECT_URI`（實際 Worker callback URL）
- `FRONTEND_URL`（實際 Worker origin，結尾 `/`）
- `PUBLIC_SITE_URL`
- `ALLOWED_ORIGINS`
- D1 `database_name`
- D1 `database_id`（必須是既有 production D1；新環境才使用新建的 id）

Production variables：

| 名稱 | 建議值 |
| --- | --- |
| `APP_ENV` | `production` |
| `ADMIN_AUTH_PROVIDER` | `github` |
| `ADMIN_AUTH_PROVIDERS` | `github,local` |
| `LOCAL_AUTH_ENABLED` | 先保持 `false`；套用 `0004` 並建立 local admin 後才改為 `true` |
| `DEV_ADMIN_MODE` | `false` |
| `GITHUB_CLIENT_ID` | production OAuth App Client ID |
| `GITHUB_REDIRECT_URI` | `https://anonymous-submissions-api-production.flashingtw.workers.dev/api/auth/github/callback` |
| `FRONTEND_URL` | `https://anonymous-submissions-api-production.flashingtw.workers.dev/` |
| `PUBLIC_SITE_URL` | `https://flashingtw.github.io/anonymous-ig/` |
| `ALLOWED_ORIGINS` | `https://flashingtw.github.io` |
| `SESSION_TTL_SECONDS` | `28800` |
| `LOGIN_RATE_LIMIT_MAX_ATTEMPTS` | `5` |
| `LOGIN_RATE_LIMIT_WINDOW_SECONDS` | `900` |
| `LOGIN_RATE_LIMIT_BLOCK_SECONDS` | `900` |

Production secrets 已在 config 中宣告為 required，但沒有值：

- `GITHUB_CLIENT_SECRET`
- `SESSION_SECRET`

設定時讓 Wrangler 顯示隱藏輸入提示；不要把值寫在 command、shell history、`wrangler.jsonc`、`.dev.vars.example`、`.env.example` 或 frontend：

```bash
npx wrangler secret put GITHUB_CLIENT_SECRET --env production
npx wrangler secret put SESSION_SECRET --env production
```

現行 `wrangler secret put` 會建立並立即部署一個 Worker version；只有在 production Worker、D1 binding 與公開 variables 都正確時才執行。`secrets.required` 只提供本機設定驗證／型別資訊，不可當成遠端 deployment gate；正式 deploy 前必須用 `npx wrangler secret list --env production` 人工確認兩個名稱都存在。Runtime auth 在缺值時仍會 fail closed。[Cloudflare Workers secrets](https://developers.cloudflare.com/workers/configuration/secrets/)。

Production 保留 `workers_dev=true`，並用 Workers Assets 上傳 `frontend/` 供同源管理頁使用；不需要 `routes`、Cloudflare zone、DNS 或 Custom Domain。Deploy 完成後以 Wrangler 輸出或 Cloudflare **Workers & Pages → anonymous-submissions-api-production** 顯示的實際 URL 為準，不要自行猜 account subdomain：

```text
https://anonymous-submissions-api-production.<ACCOUNT_SUBDOMAIN>.workers.dev
```

Worker `/` 會導回 `PUBLIC_SITE_URL`，`/admin/` 留在 Worker；其他非管理用途的靜態路徑會回 `404`。對外公開連結只使用 GitHub Pages URL。

## Production D1 migrations

先核對 `wrangler.jsonc` 的 production `database_id` 指向正確的既有 D1。接著只查看 pending migrations：

```bash
npm run db:migrations:list:production
```

全新空資料庫才預期看到全部四個 migration；既有 production 只應顯示尚未套用者，不要根據本機檔案推測遠端狀態：

```text
0001_create_submissions.sql
0002_create_admin_auth.sql
0003_add_submission_rendering.sql
0004_add_local_admin_auth.sql
```

`0003` 與 `0004` 是目前未發布變更；因 CLI 缺少可用 Cloudflare 憑證，正式 D1 是否已套用尚未查證，不可宣稱遠端缺少或已有它們。先備份、核對 pending 清單並驗證升級相容性，再經明確授權套用。`0004` 本身只依賴 `0001`／`0002` 的既有表，不依賴 `0003`、R2、renderer 或字型；但目前完整 checkpoint 的投稿查詢包含 `0003` 欄位，不能將「0004 可單獨套用」誤當「整個 checkpoint 不需要 0003」。只有包含實際產圖的 release 才需要另完成字型、renderer、R2 與 visual fixtures。文件中的 remote 指令是操作手冊，不代表執行授權。

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

僅適用於尚無 owner 的新環境。既有正式站更新時先核對身分，不要重複 bootstrap 或重建管理員。

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

Worker `workers.dev` URL 與 GitHub Pages 都可用後執行：

```bash
SMOKE_API_BASE_URL="https://anonymous-submissions-api-production.flashingtw.workers.dev" \
SMOKE_FRONTEND_ORIGIN="https://flashingtw.github.io" \
npm run test:smoke:production
```

Script 只做：

- `GET /api/health` → `200` 與 `{"ok":true}`。
- `GET /api/submissions` → `405` / `Allow: POST`，確認 public route connectivity。
- 未登入 admin list → `401`。
- Allowed OPTIONS → 精確 Pages CORS origin。
- Disallowed OPTIONS → `403` 且沒有 CORS allow headers。

它不會 `POST` 有效投稿，因此不會建立垃圾資料；OAuth、實際投稿、approve/reject、logout 與 expiration 會在結尾提示人工測試。

原本的 `npm run test:smoke` 是 **local-only**，會建立並處理三筆測試投稿，不可指向 production。

## Production Deployment Checklist

### 既有站更新順序（目前適用）

1. 確認 release 範圍、source check、tests 與 dry-run；產圖未完成時不得宣稱此 release 已提供產圖。`npm run build` 不會上線。
2. 取得 Cloudflare 授權，唯讀核對部署版本、secret 名稱、D1 目標與 pending migrations，備份並準備恢復方式。缺少授權就停止正式操作，不建立替代資源。
3. 經明確批准後，按依賴順序套用必要 schema，再部署 Worker 程式；初次上新版保持 `LOCAL_AUTH_ENABLED=false`，驗證 health 與 GitHub OAuth。
4. 經 GitHub numeric ID、admin ID／角色確認後，用 `admin:bind-local` 先 `--remote` dry-run，再 `--remote --execute` 綁定既有 owner；不可把本機 DB、測試 secret 或 `tmp/` 搬上線，不另外新增第二個 owner。
5. 確認 CPU 預算後，在受控發布步驟將 `LOCAL_AUTH_ENABLED=true` 並部署，才測試正式帳密登入、錯誤限流、改密碼與登出；開關關閉時不能完成帳密登入驗證。異常時關回 `false` 並部署，保留 GitHub OAuth；不要直接回滾或刪除正式 schema。
6. Worker API 驗證完成後，才將已審查的 release 合併／push 到 `main` 觸發 Pages。GitHub Actions 只部署 Pages，不會部署 Worker、套用 D1 或建立帳號；不得先發布依賴新版 API 的前端。
7. 核對 Pages workflow、公開頁、Worker `/admin/` 與授權的端到端測試，更新 [部署狀態快照](docs/deployment-status.md)，記錄實際版本、時間與未驗證項目。

不可把上述順序改成「先部署新版、再套 schema」：GitHub admin／session 查詢即使在 `LOCAL_AUTH_ENABLED=false` 仍會讀取 `0004` 新增欄位。`bind-local` 綁定既有 GitHub row，`add-local` 新增 row，`set-password` 重設已綁帳密，三者不可混用。朋友的 moderator 於 owner 雙登入驗證成功後才建立。

`.github/workflows/validate.yml` 在 `codex/**` push／對 `main` 的 PR 執行純驗證，分別 checkout 固定 4.5 checkpoint 與當次版本，執行 `check`、`test`、Worker dry-run build、audit。它只有 `contents: read`、不使用 production secrets，不部署 Pages／Worker、不執行 remote migrations。Pages 仍只由原本的部署 workflow 發布；保存 checkpoint 時不要 push `main`。

下方編號 0–18 保留作「全新環境首次建置」參考，不是目前站點必須重跑的清單；其中 remote writes、推送、部署與測試投稿都需要明確授權。Bash 區塊的 `\` 續行與前置環境變數語法不可直接貼入 PowerShell；Windows 請合併指令為單行並以 `$env:變數名稱` 設定環境變數。

正式公開網址固定為 `https://flashingtw.github.io/anonymous-ig/`；管理/API 網址固定為 `https://anonymous-submissions-api-production.flashingtw.workers.dev/`。凡標記「網頁」的步驟都需要登入對應網站。此架構不需要購買網域、加入 Cloudflare zone、設定 DNS/CNAME 或建立 Custom Domain。

### 0. Release gate（本機 CLI）

```bash
npm ci
npm run check
npm test
npm audit
npm run build
```

### 1. 確認 GitHub repository（GitHub 網頁，需要登入）

使用既有 repository `https://github.com/Flashingtw/anonymous-ig`。確認它沒有 `.dev.vars`、`.env` 或任何真 secret。

### 2. Push code 到 `main`（本機 CLI，需要 GitHub authentication）

目前目錄尚未初始化 Git 時：

```bash
git init
git add .
git status --short
git commit -m "Prepare split-origin production deployment"
git branch -M main
git remote add origin https://github.com/Flashingtw/anonymous-ig.git
git push -u origin main
```

逐項檢查 `git status`：不得出現 `.dev.vars`、`.env`、`dist/`、`.pages-dist/`、`.wrangler/` 或真實 secrets。第一次 Pages workflow 因 repository variables 尚未設定而 fail closed 是正常的；第 12 步會重新執行。

### 3. 確認 Cloudflare account 與 workers.dev subdomain（CLI + Cloudflare 網頁，需要登入）

```bash
npx wrangler login
npx wrangler whoami
```

在 Cloudflare **Workers & Pages** 查看目前 account 的 `workers.dev` subdomain，據此確認完整 Worker origin；不要猜測：

```text
https://anonymous-submissions-api-production.<ACCOUNT_SUBDOMAIN>.workers.dev
```

### 4. 建 Cloudflare D1（本機 CLI，需要 Cloudflare 登入）

若 production D1 尚未存在才執行：

```bash
npx wrangler d1 create anonymous-submissions-production
```

### 5. 填入 D1 與正式 URLs（本機檔案）

把 Cloudflare 回傳的 `database_name` 與 `database_id` 寫入 `wrangler.jsonc` 的 `env.production.d1_databases[0]`，確認 binding 名為 `DB`，並核對實際 Worker origin：

```text
APP_ENV=production
ADMIN_AUTH_PROVIDER=github
ADMIN_AUTH_PROVIDERS=github,local
LOCAL_AUTH_ENABLED=false
DEV_ADMIN_MODE=false
GITHUB_REDIRECT_URI=https://anonymous-submissions-api-production.flashingtw.workers.dev/api/auth/github/callback
FRONTEND_URL=https://anonymous-submissions-api-production.flashingtw.workers.dev/
PUBLIC_SITE_URL=https://flashingtw.github.io/anonymous-ig/
ALLOWED_ORIGINS=https://flashingtw.github.io
SESSION_TTL_SECONDS=28800
LOGIN_RATE_LIMIT_MAX_ATTEMPTS=5
LOGIN_RATE_LIMIT_WINDOW_SECONDS=900
LOGIN_RATE_LIMIT_BLOCK_SECONDS=900
workers_dev=true
```

### 6. 套用 D1 migrations（本機 CLI，需要 Cloudflare 登入）

```bash
npm run db:migrations:list:production
npm run db:migrate:production
npm run db:migrations:list:production
```

部署 Local Account Login 的 release 才確認必要的 `0001`–`0004` 依序套用，最後沒有 pending migration；未獲授權不執行 remote apply。先完成 schema、部署程式並建立 local admin，再於受控發布中啟用 `LOCAL_AUTH_ENABLED=true`，最後實際驗證帳密登入；詳見上方既有站更新順序。

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

- Homepage URL：`https://flashingtw.github.io/anonymous-ig/`
- Authorization callback URL：`https://anonymous-submissions-api-production.flashingtw.workers.dev/api/auth/github/callback`
- Wildcard callback：關閉
- Device Flow：關閉

保存 Client ID；Client Secret 只會在第 10 步輸入 Cloudflare。

### 9. 設 Worker variables（本機 `wrangler.jsonc`）

確認：

```text
APP_ENV=production
ADMIN_AUTH_PROVIDER=github
ADMIN_AUTH_PROVIDERS=github,local
LOCAL_AUTH_ENABLED=false
DEV_ADMIN_MODE=false
GITHUB_CLIENT_ID=<production client id>
GITHUB_REDIRECT_URI=https://anonymous-submissions-api-production.flashingtw.workers.dev/api/auth/github/callback
FRONTEND_URL=https://anonymous-submissions-api-production.flashingtw.workers.dev/
PUBLIC_SITE_URL=https://flashingtw.github.io/anonymous-ig/
ALLOWED_ORIGINS=https://flashingtw.github.io
SESSION_TTL_SECONDS=28800
LOGIN_RATE_LIMIT_MAX_ATTEMPTS=5
LOGIN_RATE_LIMIT_WINDOW_SECONDS=900
LOGIN_RATE_LIMIT_BLOCK_SECONDS=900
```

不要把 `/anonymous-ig/` path 寫進 `ALLOWED_ORIGINS`，不要加入 localhost，也不要使用 `*`。修改後 commit 並 push；仍不可提交 secret。

### 10. 設 Worker secrets（本機 CLI，需要 Cloudflare 登入）

先在本機產生一個新的 production session secret：

```bash
openssl rand -base64 48
```

再逐一執行，於隱藏提示貼上值：

```bash
npx wrangler secret put GITHUB_CLIENT_SECRET --env production
npx wrangler secret put SESSION_SECRET --env production
npx wrangler secret list --env production
```

不要把值放在 command argument、pipe、檔案或 shell history。請記得 `secret put` 會立即部署一個新 Worker version。

### 11. 部署 Worker（本機 CLI，需要 Cloudflare 登入）

```bash
npm run build
npx wrangler deploy --env production
```

`npm run build` 是 dry-run；第二行才會實際部署。Wrangler 不會把 `secrets.required` 當成可靠的部署閘門，因此部署前必須用 `wrangler secret list` 親自確認兩個 secret 名稱都存在；Worker 在缺少 secret 時仍會於 OAuth runtime fail closed。

確認 deploy 輸出的 URL 與 config 中的 Worker origin 完全一致；若不一致，先修正 Worker variables 與 GitHub OAuth callback 再繼續。驗證：

```bash
curl --fail --silent --show-error \
  https://anonymous-submissions-api-production.flashingtw.workers.dev/api/health
```

應只得到 `{"ok":true}`。不需要進入 Domains & Routes，也不需要 Custom Domain。

### 12. 部署 GitHub Pages（GitHub 網頁，需要登入）

1. Repository **Settings → Secrets and variables → Actions → Variables**：
   - `PAGES_API_BASE_URL=https://anonymous-submissions-api-production.flashingtw.workers.dev`
   - `PAGES_SITE_URL=https://flashingtw.github.io/anonymous-ig/`
2. **Settings → Pages → Build and deployment → Source** 選 **GitHub Actions**。
3. 到 **Actions → Deploy frontend to GitHub Pages → Run workflow**，或再 push 一次 `main`。
4. 確認 artifact 來源是 `.pages-dist`，公開頁是 `https://flashingtw.github.io/anonymous-ig/`。
5. 開啟 `https://flashingtw.github.io/anonymous-ig/admin/`，確認會 handoff 到 Worker `/admin/`。

### 13. 更新並核對 OAuth URLs（GitHub 網頁，需要登入）

再次確認 Homepage 與 callback 完全一致，包括 scheme、hostname、path 與尾端 `/`。Callback 必須是：

```text
https://anonymous-submissions-api-production.flashingtw.workers.dev/api/auth/github/callback
```

OAuth App Homepage 必須是 `https://flashingtw.github.io/anonymous-ig/`；callback 則是 Worker，不可填 Pages `/admin/`。

### 14. 驗證 health 與 CORS（本機 CLI）

```bash
SMOKE_API_BASE_URL="https://anonymous-submissions-api-production.flashingtw.workers.dev" \
SMOKE_FRONTEND_ORIGIN="https://flashingtw.github.io" \
npm run test:smoke:production
```

另用瀏覽器 DevTools 確認公開投稿 request 使用 `credentials: omit`，response 的 `Access-Control-Allow-Origin` 是精確 `https://flashingtw.github.io`，不是 `*`。管理頁 request 應從 Worker 同源發出並使用 `credentials: include`。

### 15. 完整登入測試（瀏覽器，GitHub 登入）

從 `https://flashingtw.github.io/anonymous-ig/admin/` 開始，確認先 handoff 到 Worker，再經 GitHub 與 Worker callback 回到 Worker 管理頁。Pages URL 與 callback 後的 Worker URL 都不得出現 code、state、token 或 session id。登入後應顯示 username、role 與 pending list。

再用一個不在 `admins` 的 GitHub 帳號測試，應只看到 `Unauthorized / Not an administrator`，不洩漏其他 admin 資訊。

### 16. 大安匿名投稿測試（瀏覽器）

送出一篇清楚標記為 production approve test 的投稿，記下 UI 顯示的 submission id，確認成功訊息與管理頁 status=`pending`，並確認公開頁未要求登入。這篇會在第 17 步 approve，不會遺留 pending 測試資料。

### 17. Approve / reject 測試（瀏覽器 + 本機 CLI，需要 Cloudflare 登入）

再建立一篇清楚標記為 production reject test 的投稿並記下 id。Approve 第 16 步的投稿、reject 這篇投稿；確認兩篇都從 pending list 移除。將下列 `123`、`124` 換成實際 id，使用唯讀查詢核對 D1 與 audit：

```bash
npx wrangler d1 execute DB --remote --env production --command \
  "SELECT id, status FROM submissions WHERE id IN (123, 124) ORDER BY id;"

npx wrangler d1 execute DB --remote --env production --command \
  "SELECT action, submission_id, created_at FROM audit_logs WHERE submission_id IN (123, 124) ORDER BY id;"
```

預期一篇 `approved`、一篇 `rejected`，並分別有 `approve_submission`、`reject_submission`。不要使用真實敏感內容。

### 18. Logout / session expiration 測試（瀏覽器 + 本機 CLI，需要 Cloudflare 登入與維護時段）

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
tmp/
*.log
```

每次 commit 前都要檢查 `git status` 與 staged diff；若 secret 曾被 commit，僅刪檔不夠，必須立即撤銷、輪替該 secret，並依 repository 狀況清理 history。

## 驗證指令

```bash
npm run check
npm test
npm audit --audit-level=low
npm run build
npm run render:fixtures
```

- `npm test` 使用記憶體中的真實 SQLite migrations；GitHub token exchange/profile 完全 mock。
- 測試涵蓋 PBKDF2 與 Unicode password policy、local login normalization／統一錯誤、IP＋username rate limit、session rotation、password change、0004 相容性、last-owner triggers、安全 CLI、OAuth、CSRF、roles、audit、production cookies、CORS、health、錯誤遮蔽、Pages artifact 與 owner bootstrap SQL。
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

此處的「Cloudflare rate limiting」指未接入的外部服務；公開投稿的 `RATE_LIMITING_ENABLED` 與 `CAPTCHA_ENABLED` 預設關閉。帳密登入則已有內建 IP＋username 限流，以 `LOGIN_RATE_LIMIT_*` 設定；啟用 local login 時會執行，與投稿防濫用開關無關。

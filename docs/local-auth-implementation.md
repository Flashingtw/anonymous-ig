# Local Account Login 交付報告

初版日期：2026-09-07；規則同步：2026-09-08。已完成本機帳密登入實作與驗證，保留 GitHub OAuth；未部署 production、未修改 production D1、未新增公開註冊。延續工作區原本已有的實作，補上 Worker/D1 相容性、安全競態與 Windows CLI 保護。

操作方式以 [README](../README.md) 為入口；線上查詢結果與未驗證項目見 [部署狀態快照](deployment-status.md)。此報告的本機功能驗證不代表已發布，也不代表已建立正式帳號。

## 1–5. 密碼與帳號規則

1. **演算法**：PBKDF2-HMAC-SHA-256，600,000 iterations，16-byte 獨立隨機 salt，32-byte derived key。`hashPassword` / `verifyPassword` 集中在 `worker/src/security/passwords.js`，可替換未來演算法。
2. **Worker 適用性**：使用 `crypto.subtle` 原生 Web Crypto，無 native addon。Cloudflare 的 Node crypto 尚不支援 Argon2；scrypt 雖可透過 Node 相容層評估，本版選擇直接支援的 Web Crypto PBKDF2，避免額外 WASM 或記憶體參數調校。已在 workerd 實測 600,000 iterations、Node hash → Worker login、Worker 改密碼 hash → Node verify。參考：[Cloudflare Web Crypto](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)、[Node crypto 支援範圍](https://developers.cloudflare.com/workers/runtime-apis/nodejs/crypto/)、[OWASP Password Storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)。
3. **Hash 格式**：`pbkdf2_sha256$600000$BASE64URL_SALT$BASE64URL_DERIVED_KEY`。不是直接 hash(password)，也不是可解密儲存。
4. **Username**：trim 後 3–32 個 ASCII 字元，只允許 `A–Z a–z 0–9 _ - .`。`username` 保留大小寫，`username_normalized` 轉小寫且有 unique index；`Flash` / `flash` / `FLASH` 相同。`admins.id` 仍為內部 identity。
5. **Password policy**：8–128 個 Unicode grapheme clusters，最多 1024 UTF-8 bytes，不接受全空白；允許長句、中文、emoji，不要求字元種類組合，不截斷，也不 trim 密碼本身。

## 6. Login rate limit 與錯誤

- IP 與 normalized username 各自限制。預設 900 秒內 5 次密碼驗證，第 5 次仍處理，後續封鎖 900 秒並回 429 / `Retry-After`。
- 在 KDF 之前原子保留名額，包含進行中的請求；12 個併發錯誤登入實測為 5 個 401、7 個 429。
- Development 使用 memory，其他環境使用 D1。D1 只保存 HMAC identifiers 與有期限的計數，過期紀錄會清除，不逐筆永久累積 attempts。
- 成功只重置 username 預算，IP 保留至自然到期；防止以合法帳號重置其他帳號的暴力攻擊預算。
- 不存在帳號會驗證 dummy hash。不存在、錯誤密碼、disabled 一律 401 `INVALID_CREDENTIALS`。這降低明顯 timing enumeration，並非完全消除 side channel。
- 延續既有 JSON envelope：`{ ok: false, error: { code, message } }`，前端分別顯示「帳號或密碼錯誤。」與「登入嘗試次數過多，請稍後再試。」。
- Production login 強制 Worker 同源 Origin，拒絕跨站 Fetch Metadata；其他 mutation 沿用 session-bound CSRF。

## 7. Migration

新增 `migrations/0004_add_local_admin_auth.sql`；本次未修改 `0001`、`0002`、`0003`。

`0004` 支援 GitHub-only、local-only、dual identity，至少一種完整 identity；保留既有 admin IDs、sessions、audit、submission/render 資料及 foreign keys，增加 username 唯一性、最後一位 enabled owner 防護 triggers、D1 limiter table。

驗證同時包括：帶有既有資料的 `0001`–`0003` 升級測試、實際 workerd/D1 升級、Wrangler 在獨立 `tmp/local-auth-ui-state/` 套用四個 migrations。這不是既有開發資料庫或 production 資料庫。

## 8. 新增／修改檔案

| 範圍 | 主要檔案 |
| --- | --- |
| Schema | `migrations/0004_add_local_admin_auth.sql` |
| Password / limiter | `worker/src/security/passwords.js`, `worker/src/security/login-rate-limit.js` |
| 登入、改密碼 API | `worker/src/handlers/local-auth.js`, `worker/src/index.js` |
| 共用授權與 OAuth | `worker/src/auth.js`, `worker/src/handlers/auth.js` |
| D1 repositories | `worker/src/repositories/admins.js`, `sessions.js`, `audit-logs.js` |
| CLI | `scripts/manage-admin.js`, `package.json` |
| UI | `frontend/admin/index.html`, `frontend/assets/admin.js`, `admin-auth.js`, `api.js`, `styles.css`, `frontend/content.json` |
| Config / dependencies | `.dev.vars.example`, `.env.example`, `wrangler.dev.jsonc`, `wrangler.jsonc`, `package-lock.json` |
| Tests | `test/local-auth.test.js`, `local-auth-migration.test.js`, `local-auth-frontend.test.js`, `manage-admin.test.js`, `worker-runtime.test.js`, `oauth.test.js`, `security.test.js`, `test/helpers/d1.js` |
| 驗證與 artifacts | `scripts/check-source.mjs`, `scripts/build-pages.js`, `.gitignore`, `frontend/.assetsignore` |
| 文件 | `README.md`, 本報告 |

上述為這項功能在目前工作區的相關檔案；品牌與 renderer 的其他既有變更未一併重新實作。

## 9–10. CLI 與建立朋友帳號

支援 `admin:add-local`、`admin:bind-local`（checkpoint 後新增）、`admin:list`、`admin:set-role`、`admin:disable`、`admin:enable`、`admin:set-password`。所有 mutation 預設 dry-run，需要 `--execute` 才寫入；`bind-local` 的預覽會唯讀解析指定 D1 的既有 admin ID，不詢問密碼。帳密只接受 hidden TTY prompt，拒絕 `--password`；不提供公開註冊／找回密碼 API。

以下指令建立一般 8787 開發環境的 moderator，使用預設 `.wrangler/state/`。這次的 8788 測試服務使用獨立 `tmp/local-auth-ui-state/`，必須使用 README 的隔離測試 helper，不可混用。登入名稱中的 local 指帳密身分；CLI 的 `--local` 才指定本機資料庫。

```sh
npm run db:migrate:local
npm run admin:add-local -- --username friend01 --role moderator --local
npm run admin:add-local -- --username friend01 --role moderator --local --execute
```

最後一步會要求 `Password:`、`Confirm password:`，輸入不顯示；密碼 8–128 個字元，不限數字，另受 1024 UTF-8 bytes 上限限制。看到 `Admin change completed and audited.` 才代表建立成功。預設角色為 `moderator`；更高角色必須明確指定。日後經批准部署才使用 `--remote --execute`，本機帳號不會自動搬到正式站。

```sh
npm run admin:list -- --local
npm run admin:set-role -- --username friend01 --role admin --local --execute
npm run admin:disable -- --username friend01 --local --execute
npm run admin:enable -- --username friend01 --local --execute
npm run admin:set-password -- --username friend01 --local --execute
```

`list` 不查詢／顯示 hash。CLI 使用實際 D1 可執行的 SQL，不使用 D1 禁止的 TEMP TABLE。敏感 SQL 與 Wrangler 日誌使用同一個私人暫存目錄，完成／失敗後刪除；Unix 0700/0600，Windows 僅目前使用者與 SYSTEM 的 ACL。ACL 失敗時先停止，尚未寫入 hash。

## 11–12. 修改密碼與 session 失效

有 local identity 的管理員登入後點「修改密碼」，填目前、新密碼與確認。`POST /api/admin/account/password` 驗證 session、CSRF、目前密碼及 policy，以 D1 batch 更新 hash、時間與 audit，撤銷該 admin 全部 sessions，再給目前瀏覽器新 session／CSRF token。

Session 是隨機 opaque token，D1 只存 SHA-256 token hash；cookie 使用 HttpOnly、Path=/、SameSite=Lax、production Secure 及 expiry。登入也會旋轉原 browser session，logout 刪除 session。

SQL 會重新檢查 enabled、驗證過的 hash、改密碼所用 session 仍有效；CLI reset 密碼撤销全部 sessions，disable 亦撤銷 sessions，enable 不會復活舊 cookie。

## 13. GitHub OAuth 共存

GitHub numeric ID、local username 都指向同一個 `admins.id`；兩種登入使用同一張 session table、role、enabled、CSRF、audit 與 middleware。已新增測試證明 dual identity 透過兩個 provider 登入後仍只有一筆 admin row。

`add-local` 建立新 local-only admin，不會自行猜測 GitHub 使用者身分。已是 GitHub admin 的人不要再建立第二列，使用 checkpoint 後新增的 `admin:bind-local`：以明確 numeric GitHub ID 解析唯一 enabled 管理員、顯示實際 admin ID、確認 username 未被占用且目標未有 local identity，再於原列寫入帳密，保持 id／GitHub identity／角色不變。成功寫入 `admin_local_identity_bound` audit 並撤銷該 admin 舊 sessions；失敗回滾。沒有公開 account-linking UI。指令、預覽及拒絕條件見 [README](../README.md)。

## 14. 驗證結果

以下保留驗證時間，避免把舊結果當成即時狀態。最新執行結果以當次測試輸出為準。

| 檢查 | 結果 |
| --- | --- |
| `npm run check` | 2026-09-08 binding CLI 更新後：通過，67 個 JS/MJS + content JSON |
| `npm test` | 2026-09-08 binding CLI 更新後：126/126 通過，無 skip；凍結 checkpoint 仍是 101/101 |
| `npm audit --audit-level=low` | 2026-09-08：0 vulnerabilities，非未來依賴安全保證 |
| `npm run build` | 2026-09-08：production configuration dry-run 成功，沒有部署 |
| 實際 workerd / D1 | PBKDF2、migrations、登入、改密碼、CLI SQL、併發限流通過 |
| Wrangler local migrations | 獨立測試資料目錄 0001–0004 全部成功 |
| 真實 Wrangler binding | 在獨立暫存 D1 套用 0001＋0002＋0004，唯讀預覽／原列綁定通過，audit 失敗確認 transaction 回滾；無 renderer 依賴 |
| 390px UI | 視覺正常，無水平溢出，Enter 錯誤提示、autocomplete、label 正常 |
| 既有功能回歸 | OAuth、approve/reject、submission validation、Pages artifact/workflow、render API/layout/storage 測試通過 |

GitHub 外部交換使用 mock，未登入真實 GitHub 或操作 production。既有 renderer 的 API 合約測試通過，但實際 renderer 尚未接入 Worker、缺正式中文字型，production R2 亦未配置；本次未改 calibration，不能據此宣稱真實產圖已可用。

## 15. Production 前的 variables / bindings

先備份並確認實際 migration 狀態；若已有 rendering migration `0003`，只套 `0004`。先 schema，再程式，初次部署維持 local 關閉並驗證 GitHub OAuth；建立正式帳號、確認 CPU 預算後，才在受控發布中啟用 local 並驗證帳密登入。開關為 false 時不能完成帳密登入驗證。完整順序以 README「既有站更新順序」為準。

目前 repo 的 production 設定（不是遠端即時讀值）：

```dotenv
ADMIN_AUTH_PROVIDERS=github,local
LOCAL_AUTH_ENABLED=false
LOGIN_RATE_LIMIT_MAX_ATTEMPTS=5
LOGIN_RATE_LIMIT_WINDOW_SECONDS=900
LOGIN_RATE_LIMIT_BLOCK_SECONDS=900
```

只有上述前置條件通過並獲授權啟用時，才將 `LOCAL_AUTH_ENABLED` 改為 `true` 並部署。沿用既有 `DB`、`SESSION_SECRET`、session TTL、OAuth variables/secrets 與同源管理頁；帳密登入不需要新 binding，沒有新增付費 Rate Limiting 服務。內建登入限流與公開投稿的 `RATE_LIMITING_ENABLED` 開關無關。

## 16. 人工確認的取捨與限制

- **CPU 預算**：原生 runtime 相容已驗證，production 方案與 CPU 用量尚未驗證；上線前依實際方案與當時的 [Cloudflare limits](https://developers.cloudflare.com/workers/platform/limits/) 確認足以負擔 KDF，不應降低 KDF 強度來遷就方案。
- **限流**：同一出口 IP 的多人共用預算，攻擊者亦可能刻意讓已知 username 暫時被限流；現存 session 與 GitHub OAuth 不受此 local-login 限制。數值可調整。
- **主機信任**：CLI 在受信任主機執行，系統管理員仍能存取程序／暫存檔；不應把帳號管理放在不可信共用主機。
- **恢復方式**：本版無 email recovery、MFA、account-linking UI；透過受信任 CLI 重設，最後 enabled owner 由 DB triggers 保護。
- **工作區**：macOS `._*` 仍保留，已從 source checks、assets、migration 探索排除。`.git` 內既有 metadata 未清理；新功能變更仍未 commit。

本機實作已完成；後續正式發布仍需通過 README 的 release gate 並取得明確授權。沒有 production 部署或 D1 remote mutation。

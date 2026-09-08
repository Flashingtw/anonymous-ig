# Phase 4.7 — Admin UX + Team Accounts

狀態：本機候選，等待視覺審查；**production 尚未部署 4.7，0006 未套到 production**。
分支 `codex/admin-ux-team-accounts`，基底 Phase 4.6 `2027f800218ff1d109d202855451de9d61aa3648`。
不 push、不部署、不新增正式朋友帳號、不修改 Cloudflare policy。沒有任何圖片工作流程。

## UI architecture

沿用原生 HTML / CSS / ES modules，不新增 UI framework 或遠端字型。
公開頁 `frontend/index.html` + `assets/app.js`；投稿 API 和送出邏輯不變。
Admin `frontend/admin/index.html` + `assets/admin.js`；providers API 決定 Email / GitHub 顯示，Local Password 與改密碼仍隱藏。
共用 `assets/styles.css` 與 `content.json`：深炭黑、暖白紙張、橘色 accent、直角按鈕。依視覺審查回饋，公開頁只保留置中的投稿表單，標題「發送匿名」，移除介紹、便條與頁首／頁尾。後台保留微傾便條，Desktop 雙欄、mobile 單欄。
Textarea 有 label、focus / invalid state、字數提示；loading / success / error 沿用 live regions。
支援 skip link、鍵盤 focus、reduced-motion；沒有將投稿或 Email 寫入 innerHTML。

後台延用待審核列表（最多 100 筆）、approve/reject、CSRF、Logout。
新增 owner-only「管理員」只讀頁，loading/error、identity/email、role、enabled、providers。
名冊請求在切頁／登出時丟棄過期結果，避免已登出後重現名冊。
Access-only 身份在 `/api/auth/me` 增加 `accessEmail` / `adminId` 與 access provider 展示；不更動 JWT validator、session 系統或 OAuth 流程。

## Role matrix

| 功能 | owner | admin | moderator |
|---|---|---|---|
| 讀取待審核投稿 | 允許 | 允許 | 允許 |
| Approve / Reject（CSRF） | 允許 | 允許 | 允許 |
| GET /api/admin/admins | 允許 | 403 | 403 |
| 建立／改角色／停用管理員的 Web API | 未提供 | 未提供 | 未提供 |

未登入管理 API 401。名冊 owner 以外先由既有 authorizeAdmin 拒絕，不能靠前端隱藏繞過。
名冊只 SELECT 安全欄位，不回 password hash / session token；Cache-Control: no-store。
POST / PATCH / DELETE 名冊：owner 405，admin / moderator 403。
CLI 是受信任維運者持有 Cloudflare/D1 權限後的工具，不是已登入網頁使用者的權限升級通道。

## 0006 migration design

`migrations/0006_access_only_admins.sql` 不修改 0001 / 0002 / 0004 / 0005。
0004 的 table CHECK 無法用單純 ADD COLUMN 放寬，因此同一 migration file 重建 admins 及引用它的 admin_sessions / audit_logs，逐欄複製並保留 IDs、created_at、GitHub、local credentials、Access Email、roles、enabled、sessions、audit。
重新建立既有 FK、UNIQUE indexes、last-enabled-owner triggers；保留 admins/audit AUTOINCREMENT high-water mark，避免重用刪除過的 ID。
保留 rate-limit tables 與 submissions，不建立 render schema。

身份 invariant：完整 GitHub identity **OR** 完整 local identity **OR** 非 NULL access_email。
既有 GitHub/local 配對欄位 CHECK 不放寬，三種 identity 全無仍拒絕。
Access Email generated normalization = lower(trim(access_email))；partial UNIQUE 覆蓋各種大小寫／前後空白。
Email-only admin 的 GitHub、local username/password 欄位皆 NULL。
不降低 PBKDF2 參數、不刪既有 password hash、不另建 session system。

測試使用代表性 populated fixture，驗證逐欄資料、FK、UNIQUE、owner id=1、sequence 和三種身份。
SQLite transaction 與真實 Wrangler **isolated local D1** 都執行 migration；沒有 production SQL。
未來套正式 migration 仍需獨立批准、確認 DB identity / checkpoint / pending migrations。

## Friend onboarding（本輪只文件化）

需要兩個獨立 allowlist 同時存在：

1. D1 建立 normalized Email 的 enabled moderator。
2. Cloudflare Access 正式 application 的 exact-email Include 加入同一 Email；保留 Require One-time PIN。

不要允許整個 gmail.com 或 Everyone，不自動修改 policy，不做公開 registration。
只有 Access allowlist 而 D1 沒有該身份會 403；只有 D1 身份而 Access 不允許仍不能通過 Access。

先在本機套 migration、dry-run，再 execute（以下全部為虛構 example.com）：

```sh
npm run db:migrate:local
npm run admin:create-access -- --email friend@example.com --role moderator --local
npm run admin:create-access -- --email friend@example.com --role moderator --local --execute
```

未來正式 provisioning 另行批准後，使用：

```sh
npm run admin:create-access -- --email friend@example.com --role moderator --remote
# 確認預覽及正式 Gate 後，才加 --execute
```

CLI 預設 role=moderator；只允許 admin / moderator，**owner 一律拒絕**。
Email 使用既有 ASCII mailbox validator、trim + lowercase、最多 254 字元，不合併 Gmail dots / plus aliases。
強制明確 --local 或 --remote；沒有 --execute 時只查詢，不寫 DB。
INSERT + audit 為同一 D1 file transaction；duplicate race 由 UNIQUE 拒絕，audit 失敗回滾。
Audit action `admin_access_created`；metadata 僅 source、target_admin_id、role、provider，不含 Email/credentials。
SQL 使用既有受限權限暫存檔並清理，抑制原始寫入 stdout/stderr，避免散佈 D1 bookmark。
網路中斷可能使結果不確定；先唯讀核對身份與 audit，不盲目重試。

## Verification / screenshots

```sh
npm run check
npm test
npm run check:rollout
npm run build
npm audit --audit-level=low
```

build 為 wrangler deploy **--dry-run**，不是部署。舊 Worker compatibility 以固定 a588834 回放原測試到 0006 schema。
Windows ACL tests 需要允許子程序設定 NTFS 暫存目錄權限；不能為了跑測試關閉敏感檔案保護。

`scripts/visual-review.mjs` 用隔離 headless browser、loopback 靜態頁面與 API fixtures；不存取 production。
Playwright 為可選的開發外部工具，不進 production dependencies。可安裝於外部工具目錄，將 `PLAYWRIGHT_MODULE` 設為絕對 module path；Windows 可用 `VISUAL_BROWSER_CHANNEL=msedge`。
執行 `node scripts/visual-review.mjs` 產生 `tmp/phase-4.7-visual-review/` 七張截圖與 report.json（gitignored）：public desktop/mobile、admin login desktop/mobile、dashboard desktop/mobile、owner team directory。
這些是實際 HTML/CSS 本機截圖，但資料與 auth responses 是標示的 fixtures，**不是正式登入驗證**。安全與角色測試另走真實 Worker handler / local D1。

## Known limitations

本輪驗證結果：完整 regression **148/148**、固定舊 Worker compatibility **32/32**、syntax check PASS、Worker dry-run build PASS、npm audit **0 vulnerabilities**、七張本機視覺截圖與 interaction checks PASS。TDD 採已確認的四個邊界；migration、CLI execution、owner directory、Access-only identity 展示皆先觀察 failing test，再加入對應實作。

新增：0006 migration、create-access-admin CLI、admin-directory handler、team-migration / team-api / create-access tests、visual-review runner、本文件。
修改：公開頁 / Admin HTML、共用 CSS / content、Admin UI JS、Worker route / me presentation、package scripts、D1 test helper、real Wrangler integration test、rollout isolation check、README / deployment-status。既有 auth validator / session / CSRF / OAuth callback 與 public submission backend 未重構。

- 名冊只讀，無 Web create/change-role/disable；朋友 onboarding 仍需維運 CLI + 手動 Access allowlist。
- 只显示既有 pending queue，最多 100 筆；無搜尋、歷史狀態列表或分頁。
- 顯示 Local provider 表示身份仍保存，不代表正式 Local Login 已開。
- 移除 Access allowlist 不會立即撤銷既有 App session；停用帳號需未來獨立管理流程，本輪不新增。
- 截圖使用系統字型；其他 OS 字型排版可能略有差異。
- production runtime vars 與 repo 預設不同：正式 Access 已開，repo 仍保守預設 false；未來部署必須明確保留正式設定，不可直接用 dry-run defaults 上線。
- 無 production rollout、Cloudflare policy 更新、朋友帳號或圖片功能。

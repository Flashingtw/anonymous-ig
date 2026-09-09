# UI 定稿與投稿上限 100

本輪分支：`codex/admin-minimal-ui`。僅為本機 review candidate；**未部署 Worker / Pages，未修改 production D1、帳號、feature flags 或 Access policy**。

## 範圍

- 保留既有四個極簡 UI 修改，整理公開頁、管理登入、投稿列表與唯讀管理員名冊。
- 帳號新增 UI / API 正式取消，本輪未實作，也沒有相關 WIP 需要刪除。Owner 名冊仍僅 GET；POST 回 405。沒有 `/api/admin/accounts`。
- 帳號 provisioning 繼續使用既有 CLI 與 Cloudflare exact-email allowlist；這兩件事都不由 UI 自動執行。
- 沒有 renderer、R2、Instagram、圖片功能或 migration 變更。本分支未發現 renderer 的 140-grapheme config；不碰其他 worktree。

## Canonical 投稿限制

`frontend/assets/submission-content.js` 的 `MAX_CONTENT_LENGTH = 100` 是前後端共用唯一上限。前台 counter / validation 及 Worker `POST /api/submissions` 都使用它。

`frontend/assets/graphemes.js` 使用既有 `Intl.Segmenter` grapheme 計數實作，抽成瀏覽器與 Worker 共用 utility。原本 password 計數也改用相同 utility，**密碼限制、PBKDF2、安全參數與 auth 流程沒有改變**。

- 沿用原投稿 API 的 `trim()`：外圍空白不計入／不儲存；內文不截斷，內部空白及換行保留。
- 中文「你好」算 2；ZWJ 家庭 emoji、旗幟、膚色 emoji、字母加 combining mark 各按 grapheme 計算。
- 99 / 100 接受，101 拒絕。90 起 counter 提示接近上限，超限顯示原因並禁止送出；Worker 獨立驗證。
- 既有 16 KiB request body 安全限制保留。極端大量 combining marks 仍可能碰到 request body 限制。
- 舊投稿即使超過 100 字仍可列出及審核；沒有 migration、UPDATE、刪除或自動截斷。
- 瀏覽器需支援 `Intl.Segmenter`，不以 code point fallback 偷換計數語意。

## UI / accessibility

- 深灰背景、暖白紙張、少量橘色；公開頁只保留簡短品牌與投稿區。
- 管理登入按 providers API 顯示 Email OTP / GitHub；Local Password 與開發表單在正式模式不顯示。保留原本未啟用的 legacy handlers 以免破壞 regression。
- Owner 保留唯讀名冊，admin / moderator 不顯示管理員入口；server-side RBAC 不變。
- 投稿與審核都有 in-flight guard、防重複送出、loading、錯誤重試。審核成功直接移除已處理卡片，更新數量／空列表；鍵盤焦點回到下一張卡片或空列表按鈕。
- 公開送出失敗保留草稿；成功清空並公告。不新增公開列表或登入。
- 檢查 320 / 390 / 768 / 1024 / 1440px、長 Email、無空格長文、focus、disabled、loading / empty / error。

## 本機驗證

- `npm.cmd run check`
- `npm.cmd run check:rollout`：只將舊 `app.js` 的逐字凍結條件改為本次批准的共用 100-grapheme contract。其他隔離檢查保留，舊 Worker/schema compatibility 32/32 通過。
- `npm.cmd test`（Windows ACL tests 需要可設定暫存檔 ACL 的執行環境）
- `npm.cmd run build`：Wrangler **dry-run**，並非部署；repo vars 是保守預設，不代表目前 production flags。
- `npm.cmd audit --json`：原先 sharp / miniflare / wrangler 三個 High、同一 sharp advisory 與 inherited meta-vulnerability；仍是已分類的 DEV/TOOLING ONLY，**audit exit code 仍為 1，非零漏洞**。未改 dependency / lockfile，未執行 audit fix。
- `node scripts/visual-review.mjs`：需既有 Playwright（可由 `PLAYWRIGHT_MODULE` 指定路徑）與 Chromium/Edge（`VISUAL_BROWSER_CHANNEL=msedge`）。所有 API 用本機 HTTP fixtures；外部請求全部封鎖，未使用正式登入或資料。

截圖與瀏覽器驗證報告輸出：`tmp/phase-4.7-visual-review/`（gitignored）。Public desktop/mobile、Admin login desktop/mobile、pending desktop/mobile、owner roster desktop，共 7 張。

UI finalization 已完成人工 screenshot review；最終 polish 沿用相同版型。Node regression 166/166；瀏覽器 20 組情境。使用者已批准驗證通過後 commit、push `codex/admin-minimal-ui` 並等待 CI；**仍不部署**。

## 最終 polish

- 公開頁主標題為「匿名投稿」，保留兩種品牌文字與原 composition。
- 管理員 tab page heading 顯示「管理員」，回投稿 tab 恢復「投稿管理」。
- 正常登出訊息採 muted info／polite status；真正登入錯誤仍為 error／alert。不改登入或登出流程。
- Mobile 工具列分成 identity、待審數量、兩個等寬操作按鈕三排，按鈕至少 48px 高；desktop 不改排版。
- 待審 badge 加深低飽和棕色文字，暖紙底色；瀏覽器驗證文字對比至少 7:1。
- 不更動 card layout、approve/reject 互動、後端、100 grapheme、權限或依賴。

## 變更檔案（含四個既有未提交 UI 修改）

- UI：`frontend/index.html`、`frontend/admin/index.html`、`frontend/assets/styles.css`、`frontend/content.json`、`frontend/assets/app.js`、`frontend/assets/admin.js`。
- 共用計數：`frontend/assets/graphemes.js`、`frontend/assets/submission-content.js`（新增）。
- Worker：`worker/src/validation.js`、`worker/src/security/passwords.js`（只抽出既有計數 helper）、`worker/src/index.js`（新增共用 JS 的 admin 靜態資源 allowlist）。
- 驗證：`test/submission-limit.test.js`（新增）、`test/access-runtime.test.js`、`test/content.test.js`、`test/validation.test.js`、`scripts/check-rollout.mjs`、`scripts/visual-review.mjs`。
- 文件：`README.md`、本文件（新增）。

共 19 個檔案。無 package / lockfile、CLI、auth policy、production config、migration 變更。

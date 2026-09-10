# 圖片工作室：本機視覺審查版

Branch: `codex/admin-image-editor`，基於已部署 checkpoint `61c89bd5c324af2f104ac49aea277f7f8e61dc4d`。
尚未部署、未建立正式 bucket/binding、未套用正式 0007、未修改正式資料或 Access policy。沒有 IG API、token、發布任務或 published 狀態。

## 本機操作

在此 checkout 執行：

```powershell
node scripts/studio-visual-review.mjs --serve
```

開啟命令顯示的 `http://127.0.0.1:<port>/admin/studio/`。這是隔離的視覺 fixture：SQLite D1 adapter 與記憶體圖片儲存、兩篇測試投稿、僅本機開發身份。重新整理可重開草稿，但停止程序會清空 fixture；不使用正式帳號或網路資料。Ctrl+C 停止。

實際 Workers 本機環境使用既有 `npm.cmd run db:migrate:local`、`npm.cmd run dev`；`wrangler.dev.jsonc` 配置本機 `STUDIO_IMAGES` R2 binding 及 `IMAGE_STUDIO_ENABLED=true`。只用本機開發憑證，不複製正式 secrets；不要使用 `--remote`。本機 workerd 測試亦實際執行隔離 D1/R2 round-trip。

## 操作流程

1. 核准投稿時建立圖片草稿；已核准舊投稿在圖片草稿頁按「建立圖片草稿」。不批次改舊資料。
2. 開啟編輯器載入底圖、兩款字型後自動排版，內文預設中心 (540,675)。修改正文副本、換行、拖曳、調整字級或 X/Y。選取正文／編號後也可用方向鍵（Shift 為 10 px）；拖曳支援水平／垂直中心線吸附，Alt 暫停吸附。圖片編號可手動填寫，預設 109、字級 40、位置 (540,385)，不改原投稿 ID、不占正式流水號。還原排版保留手動編號；舊文件沒有獨立編號時沿用原投稿 ID。
3. 「還原自動排版」重置位置與縮字；「保存草稿」保存文字及座標。超出安全區、文字框重疊、空白或超過 1,000 grapheme 時不能加入待發送。原始投稿仍保留 100 grapheme 規則且不被覆寫。
4. 「加入待發送」以相同 Canvas 排版產生 1080×1350 PNG，先上傳再完成 revision compare-and-swap；成功後出現在待發送。「保存草稿」與「加入待發送」成功後均關閉編輯器、回到圖片草稿列表；錯誤時不關閉。
5. 選 1–10 張（本版產品上限，不代表 IG 限制），調整順序、填寫最多 2,000 grapheme 的說明，保存團隊共用發送草稿。可重開、移除及排序。
6. 發送草稿固定引用圖片版本。新版本出現時，必須明確按「換成最新圖片」並保存，舊版本不自動替換。
7. 單張下載 PNG，整組下載 ZIP：`01-submission-ID.png` 等有序檔名及 UTF-8 `caption.txt`。下載不代表已發布。

未保存离開有提醒。revision 衝突不覆寫遠端版本；先保留自己的文字再重新載入比較。上傳或保存失敗會顯示錯誤；不宣稱成功。

## 模組與資料

- `frontend/admin/studio/model.js`：文件格式、尺寸、安全區與數量規則。
- `canvas.js`：字型／背景載入、grapheme 換行、縮字、文字 ink bounds、預覽和 PNG 同一繪圖邏輯。
- `studio.js`：編輯交互、明確保存、待發送選取及發送草稿 UI。
- `zip.js`：零新增依賴的 ZIP STORE 與 CRC32。
- `worker/src/handlers/image-studio.js`：驗證與私有圖片讀寫邊界。
- `worker/src/repositories/image-drafts.js`：D1 原子操作、revision CAS、版本引用及 audit。

`0007_image_drafts.sql` 是 additive migration：image_drafts、image_versions、dispatch_drafts、dispatch_items。既有 admins/submissions/sessions/audit 不重建、不改 ID；新增外鍵引用既有資料。圖片版本以 trigger 禁止修改／刪除。草稿以投稿 ID 保證一篇一份，dispatch items 保存位置及版本 FK。

核准＋建草稿、保存＋audit、ready＋immutable version＋audit、dispatch＋items＋audit 分別使用 D1 batch transaction。R2 與 D1 不存在跨服務 transaction：R2 先寫新 UUID key，再用 revision CAS 提交 D1。D1 錯誤或結果不明時保留私有孤立 object，不冒險刪除可能已提交的圖片；上一個版本不受影響。

## API 與權限

所有路由在 `/api/admin/studio` 下，沿用既有 session、enabled、RBAC；mutation 必須既有 CSRF。owner/admin/moderator 都可使用；管理員名冊仍只允許 owner。

| Method / suffix | 用途 |
| --- | --- |
| GET `/` | 草稿、舊核准投稿及發送草稿列表 |
| POST `/drafts/:id` | 冪等建立舊核准投稿草稿 |
| GET / PUT `/drafts/:id` | 讀取／保存 `{revision,text,layout}` |
| POST `/drafts/:id/ready` | PNG body，`If-Match` 為草稿 revision |
| GET `/images/:versionId` | 私有 PNG；`?download` 系統下載檔名 |
| POST `/dispatches` | 建立 `{revision:0,caption,items:[versionId]}` |
| GET / PUT `/dispatches/:id` | 讀取／CAS 保存發送草稿 |

PNG 上限 8 MiB，檢查 signature、IHDR 固定尺寸、RGB/RGBA 8-bit、chunk 長度／CRC、IDAT、IEND、拒絕 APNG。文件 JSON 最多 32 KiB、dispatch JSON 最多 16 KiB。圖片回應 no-store/nosniff；R2 key 不公開；studio CSP 只額外允許 blob 圖片縮圖。

## 測試

```powershell
npm.cmd run check
npm.cmd test
npm.cmd run check:rollout
npm.cmd run build
npm.cmd audit --json
```

Browser review：設定 `PLAYWRIGHT_MODULE` 指向已安裝 Playwright 的 index.mjs，再 `node scripts/studio-visual-review.mjs`。預設使用 Edge；可透過 `VISUAL_BROWSER_CHANNEL` 選擇。輸出位於 gitignored `tmp/studio-visual-review/`。涵蓋字型失敗重試、實際 Canvas PNG、文字／鍵盤、ready、多選排序、ZIP 內容、草稿重開、手機 overflow、安全區及字數。

`test/image-studio.test.js` 涵蓋三角色及 roster、真實 Access session、CSRF、disabled、migration populated session/audit preservation、FK、原文保留、atomic rollback、CAS、不可變版本、R2 失敗／重試、workerd 真實本機 D1/R2 round-trip。舊 Worker 32 項測試於新 0007 fixture 重播。

## 已知限制與下一個 Gate

- 不接 IG；沒有排程、發布、分頁產圖或圖片刪除。
- 列表尚未分頁；ZIP 在瀏覽器記憶體建立，大型團隊／大量歷史資料需另做容量評估。
- 正文無法在最小字級容納時，要求人工調整，不裁切或刪字。emoji/罕見字元仍受字型實際 glyph 覆蓋與作業系統 emoji 支援影響。
- 使用提供的 Canva 字型（約 12.5 MB）；本機實測成功但尚未驗證再散布授權。首次載入需時間；本 Gate 不發布這些資產。
- Worker 驗證 PNG 結構，不在伺服器重繪或核對像素是否等於文字副本。不能把客戶端安全區提示視為伺服器排版驗證。
- 保留孤立 R2 object，沒有自動清理；正式部署前應另外批准 retention／reconciliation 策略。
- 正式 `wrangler.jsonc` 未新增 binding 或啟用 studio。正式 bucket、binding、0007 backup/migration、feature flag、部署及人工 regression 都需獨立批准；不能直接套用本機 fixture 設定。

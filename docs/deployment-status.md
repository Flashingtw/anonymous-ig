# 部署狀態快照

查詢時間：2026-09-08 約 18:58–18:59（Asia/Taipei）。這是唯讀查詢的歷史快照，不是持續監控；後續發布或設定變更後必須重新確認。操作與規則以 [README](../README.md) 為入口。

## 已確認

| 項目 | 查詢結果／依據 |
| --- | --- |
| GitHub `main` | `a5888345f8a1658c704237452d58111e4dec3f41`，`Add sanitized OAuth callback diagnostics`；[commit](https://github.com/Flashingtw/anonymous-ig/commit/a5888345f8a1658c704237452d58111e4dec3f41) |
| GitHub Pages 最近 workflow | 2026-09-03 18:23（Asia/Taipei）建立，completed / success，使用上述 commit；[run 33744006087](https://github.com/Flashingtw/anonymous-ig/actions/runs/33744006087) |
| 公開投稿頁 | [GitHub Pages](https://flashingtw.github.io/anonymous-ig/) HTTP 200；公開 `config.js` 指向下方 Worker API |
| 正式管理頁 | [Worker /admin/](https://anonymous-submissions-api-production.flashingtw.workers.dev/admin/) HTTP 200；頁面提供 GitHub 登入，沒有新版帳密表單 |
| API health | [GET /api/health](https://anonymous-submissions-api-production.flashingtw.workers.dev/api/health) HTTP 200，`{"ok":true}`；這只驗證健康端點，不等於完整 schema 或登入流程通過 |
| 未登入管理資料 | `GET /api/admin/submissions` HTTP 401、`UNAUTHORIZED`，未公開管理資料 |
| 新版 provider API | `GET /api/auth/providers` HTTP 404、`NOT_FOUND`；結合管理頁判斷新版帳密登入尚未上線 |

## 本機與正式環境的差異

- 本機新版已完成 8–128 字元密碼、CLI 管理、GitHub／帳密共用 session、限流與改密碼驗證；新版變更在此次查詢時尚未 commit／push。
- 本機驗證（2026-09-08，含後續文件一致性更新）：101/101 tests 通過，65 個 JavaScript 檔案與 content JSON 檢查通過；同日 Worker production dry-run 成功。這些結果不代表部署成功；Wrangler 曾有沙箱日誌寫入權限警告，dry-run 本身完成。
- repo 的 `env.production.vars.LOCAL_AUTH_ENABLED` 保持 `false`；這是待部署設定，不是從 Cloudflare 後台讀出的即時值。
- 8787 預設開發庫、8788 隔離測試庫、production D1 各自獨立；建立本機帳號不會建立正式帳號。未在此文件記錄密碼或個人帳號狀態。
- Renderer API／排版基礎已有測試，但真實 renderer 尚未接入 Worker，缺正式中文字型，repo 未配置 production R2 binding；不可宣稱產圖可用。尚未連接 Instagram。

## 尚未驗證／目前阻擋

Cloudflare CLI 的 `deployments list --env production` 與 `d1 migrations list DB --remote --env production` 因缺少可用 Cloudflare 授權而失敗；沒有為此建立臨時帳號或資源。因此下列仍未知：

- 遠端 Worker 實際 version ID、部署時間、variables／secret 狀態。
- 正式 D1 的 migration 清單、現有管理員與備份狀態。
- 正式方案的密碼運算 CPU 預算。
- 真實 GitHub OAuth 完整登入，以及正式帳密登入、改密碼、登出等端到端結果。

此輪沒有提交投稿、建立正式帳號、套用 migration、修改 secret 或部署。下一次發布按 README 的「既有站更新順序」進行，不重跑首次建站步驟。

## 4.5 凍結與 rollout 前置檢查（2026-09-08）

- 已建立本機 checkpoint commit：`19f18c73ca5e3a4a4831cd045a603b14b0724be4`，訊息 `Add local admin authentication`，分支 `codex/daan-brand-renderer`。上方「尚未 commit」僅描述 18:58 查詢當時狀態。
- checkpoint 保留 101/101 通過的完整工作區，包括原有但未完成的品牌／renderer 基礎；沒有繼續修改產圖。它不是已拆分的 local-auth-only 部署套件。
- 後續獨立的 `validate.yml` 只做 CI，分別驗證固定 checkpoint 與当前版本；push 此分支不符合 Pages 的 main 自動部署條件。CI 成功與否應查對應 commit 的 Actions，不由本機結果推測。
- 本機唯讀 schema 探針確認：新版 `findAdminByGithubUserId` 在 `0001＋0002` schema 上因缺少 `username` 失敗。這與 local 開關無關，因此正式操作必須先核對／升級 schema，再部署新版。
- 在同一探針直接套 `0004`（跳過 `0003`）成功，既有 owner、session、audit 與 foreign keys 保留；沒有 R2、renderer 或字型依賴。這不代表已對正式 D1 驗證；完整工作區的投稿查詢仍需要 `0003` 欄位。
- 自己的 local owner 應綁定既有 GitHub owner 的同一筆 identity。現有 CLI 沒有綁定指令，不能用 `add-local` 建立第二筆 owner 充當綁定；這是正式啟用前的待辦，不是 4.5 功能需求變更。
- 尚未部署 Worker／Pages、套用 production migration、建立正式 owner 或朋友帳號。正式 rollout 仍受 Cloudflare 授權、schema／備份確認及 owner 綁定流程限制。

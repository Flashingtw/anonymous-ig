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

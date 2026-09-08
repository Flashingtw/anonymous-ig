# 部署狀態快照

更新：2026-09-08（Asia/Taipei）。這是帶時間的證據紀錄，不是即時監控。每次部署前先讀 [README](../README.md)，再查 Cloudflare／GitHub 現況。

## 已固定的 checkpoints

- Production main 基線：`a5888345f8a1658c704237452d58111e4dec3f41`。
- Local Auth 初始安全點：`19f18c73ca5e3a4a4831cd045a603b14b0724be4`，101/101；不改寫。
- Binding final checkpoint：`6a0f985491c64d3366ce8d93706e46ff47cd6efc`，已 push 至 `codex/daan-brand-renderer`。[CI 34221235995](https://github.com/Flashingtw/anonymous-ig/actions/runs/34221235995) success，current 126/126，另驗證 frozen checkpoint。
- 上述來源 branch 含 renderer／品牌未完成工作，不能整條 merge 或部署。
- 獨立候選：`codex/local-auth-rollout` 從 production 基線建立；只取 auth／binding／0004／必要 UI、測試與文件。驗證及選取邊界見 [deployment isolation](deployment-isolation.md)。

## 最後一次 production 唯讀快照

2026-09-08 18:58–18:59（Asia/Taipei）：

- [公開 Pages](https://flashingtw.github.io/anonymous-ig/) HTTP 200，config 指向正式 Worker。
- [正式 /admin/](https://anonymous-submissions-api-production.flashingtw.workers.dev/admin/) HTTP 200，只有 GitHub 登入。
- /api/health 200；未登入 /api/admin/submissions 401。
- /api/auth/providers 404；新版帳密登入當時尚未上線。
- Pages 最近成功發布：[33744006087](https://github.com/Flashingtw/anonymous-ig/actions/runs/33744006087)，使用 a588834。

這些是歷史觀測，不能證明目前 Worker 版本。Cloudflare CLI 查部署／D1 因缺少可用授權而失敗，因此正式 migration ledger、schema、owner、variables、backup、version ID、CPU 方案尚未確認。

## 當前 release gates

- Phase 4.5 功能／binding 已完成並凍結；來源 final checkpoint／CI 已保存。
- Production isolation：候選已整理；以對應 commit 的本機與 CI 結果簽核。
- Production migration review：待 Cloudflare 授權、實際 schema、備份與 constraints 核對。
- Production rollout：尚未開始；未套 production 0004、未部署 Worker／Pages、未建立或綁定正式帳號。
- Repo production LOCAL_AUTH_ENABLED=false 是待部署設定，不是 Cloudflare 即時讀值。
- Renderer／R2／字型凍結且不在此候選；Instagram／Meta 尚未串接。

## 下一步

依 README 順序：授權與查核 → 備份／migration review → schema 先上 → 舊 Worker smoke → 新 Worker＋管理 assets（local=false）→ 舊功能 smoke → 同列 owner binding → 確認 id 不變 → 受控啟用 → 帳密與 GitHub 備援測試 → 朋友 moderator。未取得前置資料前不得跳關。

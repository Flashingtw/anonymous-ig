# 部署狀態快照

更新：2026-09-09（Asia/Taipei）。本輪 Phase 4.7 **只修改本機程式與文件，未查改 production**。
正式資訊引用前一 Gate 的 API / D1 唯讀紀錄與使用者人工確認，不是持續監控。
部署前必須先讀 [README](../README.md)，再唯讀確認實際遠端狀態；禁止只根據舊對話部署。

## Production：Phase 4.6 已完成

- Code checkpoint：`2027f800218ff1d109d202855451de9d61aa3648`，來源 `codex/access-email-otp-integration`。
- Worker：anonymous-submissions-api-production。
- Version：`f02e5d39-bb40-44ee-a021-ff1da288f71b`；deployment `ef61f414-dc08-4654-a7c5-48663135f6c6`。
- Access enable config 驗證 UTC：2026-09-08T18:04:46.585Z；code / static assets hashes 不變。
- 正式 flags：`ACCESS_AUTH_ENABLED=true`、`LOCAL_AUTH_ENABLED=false`。
- 正式 JWT Team Domain / AUD 已設定驗證，AUD 不等於 Application ID。此處不散佈完整設定。
- D1：anonymous-submissions-production；0001 / 0002 / 0004 / 0005 已套用，沒有 0003。
- 唯一 owner 仍為 admins.id=1，GitHub / Local / Access 三種 identity 保留，role=owner、enabled=1。
- DAAN Anonymous Email Login 僅保護 /api/auth/access；exact-email allowlist + Require One-time PIN；Access session 30 分鐘。
- Email OTP → app session → Logout → Email re-entry → Logout → GitHub fallback 已完成。
- Gate 結論：**PHASE 4.6 ACCESS EMAIL OTP COMPLETE**。
- 本機證據檔：tmp/access-auth-enable-gate.json（gitignored；包含安全摘要，不含 credentials）。
- Pages 本階段未部署；先前 main / Pages 歷史基準 a5888345f8a1658c704237452d58111e4dec3f41，未在本輪重新查詢。

## Local：Phase 4.7 尚未上線

- 分支：`codex/admin-ux-team-accounts`，基底 2027f800…。
- 公開頁 / Admin UI 重新設計；owner-only read-only directory；Access-only admin CLI。
- 0006 僅本機候選，**未 apply production**。
- 不新增朋友正式帳號，不修改 Access policy，不部署 Worker / Pages。
- 無 renderer / R2 / 字型資產 / Instagram / 圖片流程。
- Repo wrangler config 仍保留 Access=false、Local=false 保守 defaults，不應直接覆蓋 production 的已驗證設定。
- 詳見 [Phase 4.7 設計與 onboarding](phase-4.7-admin-ux-team-accounts.md)。

## 歷史隔離 checkpoint

4.5 rollout：98858477827a7076b0e43cde2ed7f9f252fe2076。
Hasher WIP 保留於 codex/local-auth-wip，未移入本分支。
Email OTP PoC：codex/access-email-otp-poc / ca5c4359108777c9fe9246cd6b4061f6d2cddb54，非正式資源依賴。
舊 Phase 4.5 / 4.6 本機報告僅供歷史追溯，不可當成目前 production flags 或 migration state。

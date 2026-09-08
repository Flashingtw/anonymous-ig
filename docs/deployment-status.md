# 部署狀態快照

更新：2026-09-09（Asia/Taipei）。本輪為 Phase 4.6 本機 code／tests／migration，**未重新查詢或修改 production**。線上資訊引用前序 rollout 紀錄與使用者人工驗證，不是即時監控。部署前先讀 [README](../README.md)，再唯讀查核遠端。

## Checkpoints

- main／Pages 歷史基準：a5888345f8a1658c704237452d58111e4dec3f41。
- 4.5 初始：19f18c73ca5e3a4a4831cd045a603b14b0724be4；binding 來源：6a0f985491c64d3366ce8d93706e46ff47cd6efc。來源 renderer branch 不能整條合併。
- 隔離 rollout 基準：98858477827a7076b0e43cde2ed7f9f252fe2076。
- WIP hasher experiments 留在 codex/local-auth-wip，未移入。
- VERIFIED PoC 獨立保存：codex/access-email-otp-poc，ca5c4359108777c9fe9246cd6b4061f6d2cddb54。未 merge／deploy production。
- 本輪 integration：codex/access-email-otp-integration，從乾淨 9885847 建立；變更尚未 commit／push。沒有 renderer／R2／字型／0003／benchmark。

## 前序 production 紀錄：本輪未重新驗證

- Worker code 基準 9885847；version b976a804-a000-44bf-b291-9f18e0dbe3dd。
- D1 anonymous-submissions-production，ID 281ce1f3-dcdb-4d13-a749-709dee63043f；0001／0002／0004 已套用，本輪未套 0005。
- Owner id=1、GitHub numeric ID=141396710、GitHub username=Flashingtw、role=owner、enabled=1；local username=flashingtw 已綁同一列。不得列印 password_hash。
- 使用者已人工確認 GitHub login／既有 owner／submissions read／logout／re-login（含 local binding 後）正常。
- 後續 password login 在 Workers Free 遇到問題，決定 deferred。前序最後已知線上 LOCAL_AUTH_ENABLED=true；**repo false 不代表線上已關閉**。正式 rollout 必須明確批准改為 false，本輪未調整線上 flag。
- 本輪未建立 production Access application、未 bind production email、未啟用 ACCESS_AUTH_ENABLED。前序 PoC 為獨立 Worker，僅作 PoC evidence。

## 當前 Gate

本機結果見 [Phase 4.6 報告](access-email-otp-integration.md)。Repo defaults：LOCAL_AUTH_ENABLED=false、ACCESS_AUTH_ENABLED=false、DEV_ADMIN_MODE=false、TEAM_DOMAIN／AUD 空值，都是**待批准部署設定**。

下一步只能按 README 十個 gates 分別批准。先保存候選 commit／CI、查核正式 ledger／schema／備份／flags，再討論 apply 0005。不得因本機通過就自動 deploy／bind／enable。Pages、production OAuth／secrets、renderer／R2／Instagram 均未修改。

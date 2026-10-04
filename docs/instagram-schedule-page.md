# 獨立 IG 排程頁（本機待驗收）

- `/admin/instagram/`：IG 批次狀態、排程與既有發布操作。沿用 session、CSRF 及原本 API，沒有新增發布方式或權限。
- `/admin/studio/`：製圖、選圖、排序及產圖；不再顯示 IG 排程面板。仍會讀取 IG 狀態以保留既有鎖定／產圖流程。
- 投稿管理及工作室都提供「IG 排程」入口。舊 `/admin/studio/#instagram-panel` 連結轉到新頁。
- 待完成圖片的批次從排程頁返回 `/admin/studio/?batch=<id>`；只開啟指定批次，不會在導航時自動產圖或發布。
- IG 關閉時新頁明確顯示暫停，不隱藏整頁，也不自行啟用功能或 Cron。

本次僅前端拆頁與本機瀏覽器測試，未部署、未修改 production 設定或資料。正式部署需另行批准。

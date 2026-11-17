# 山石庫存系統

Node.js 22 以上，執行 `npm ci`、`npm test`。瀏覽器測試預設使用已安裝的 Microsoft Edge，API 與相機均模擬，不會寫入正式資料。

`npm run check:deploy` 做 Worker 打包驗證；`npm run dev:api` 啟動本機 API；`npm run deploy:api` 發布 API。

空白本機資料庫依序執行 schema.sql、20261117_request_identity.sql、20261117_balance_versions.sql；schema.sql 已含 20260928 結構，不重複執行舊 migration。正式既有資料庫只執行尚未套用的 migration，新增版本欄位不可重複執行。

整合測試為 tests/worker.integration.mjs 及 tests/worker.safety.mjs，使用本機 8799 API。需先建立隔離測試 fixture：ACTIVE、STOP 品項、101/102 批次與測試帳號。測試 token 不可用於正式環境。

前端由 GitHub Pages main 根目錄發布。API 與 migration 先於前端發布。發布前匯出資料庫，確認備份可讀回及測試通過。

2026-11-17 新增表與欄位向後相容；回退程式不刪欄位。前端回退使用 Git revert，API 先查 Wrangler 部署紀錄再回退目標版本。禁止直接以舊備份覆蓋上線後的新交易。

backups/ 包含敏感業務資料，禁止提交或發布；密鑰使用 Worker secrets。完整目標與待驗收內容見商用化定稿規格.md 及部署紀錄.md。

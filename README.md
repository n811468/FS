# 車型損益試算系統

以 Google Sheet 當資料庫、Apps Script 當後端的車型損益試算工具。
安裝與使用說明見 [`apps-script/README.md`](apps-script/README.md)，
資料結構見 [`docs/data-schema.md`](docs/data-schema.md)，架構見 [`docs/architecture.md`](docs/architecture.md)。

## 驗算

`tools/` 底下有一層記憶體版的 Apps Script 模擬層，讓 `apps-script/*.gs` 可以直接在 Node 上跑，
不必部署就能驗證計算結果與畫面產出（需要 Node.js，不需要安裝任何套件）：

```bash
node tools/verify-gatef.js             # 用實際 Gate F 損益試算表的數字逐格驗算（317 格）
node tools/verify-features.js          # 情境帶入、科目自動編號、匯率精簡等行為
node tools/verify-ui.js                # 損益表版面、% 基準、小計警示、CSV 欄數
node tools/verify-firestore-client.js  # Firestore REST 用戶端：JWT 簽章、token 快取、CRUD 呼叫格式
```

`verify-gatef.js` 會順便把比較表印出來，方便跟原始試算表並排肉眼再對一次。

## 資料庫遷移（Google Sheets → Firestore）

正在進行把資料庫從 Google Sheets 換成 Firestore 的遷移，理由與階段規劃見
[`docs/firestore-migration.md`](docs/firestore-migration.md)。

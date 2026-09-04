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
node tools/verify-write-batching.js    # 整批寫入：跨情境隔離、新增/更新/刪除混合、呼叫次數不隨格數線性成長
```

`verify-gatef.js` 會順便把比較表印出來，方便跟原始試算表並排肉眼再對一次。

## 本機預覽（不必部署）

```bash
node tools/dev-server.js               # 打開 http://localhost:8787
```

用同一層模擬層把後端跑在 Node 上，灌一組示範資料（Gate F 現況、由它衍生的目標情境、另一個車型），
前端的 `google.script.run` 被換成打 `/rpc` 給這台伺服器。改完 `script.html` / `style.html` 存檔後按 F5 就看得到，
資料只在記憶體、重啟就回到示範資料。適合調版面、看儀表板的圖表與 hover 提示。

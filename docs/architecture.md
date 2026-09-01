# 系統架構草案 — Google Sheet + Apps Script

資料結構定義見 `docs/data-schema.md`。本文件定義前端輸入 → Sheet 寫入 → 前端呈現的完整流程與專案檔案配置。

---

## 1. 整體資料流

```
使用者操作前端表單
   │  (google.script.run.withSuccessHandler)
   ▼
Apps Script Server 端函式 (DataService.gs)
   │  驗證欄位 → LockService 上鎖 → upsert 寫入對應分頁
   ▼
Google Sheet（資料庫）
   │
   ▼
CalcEngine.gs 觸發重算
   │  讀 SalesMix / MaterialCost / DevInvestment / Parameters
   │  依 PLLineItems 科目鏈逐項 rollup (A→B→C→...→K)
   ▼
寫回 PLResult 分頁
   │
   ▼
前端呼叫 getPLResult(scenarioId, vehicleId)
   │
   ▼
Dashboard 頁面渲染損益表 + 結構圖表
```

**關鍵原則：Sheet 只存「輸入資料」與「計算結果快照」，不存公式。**
所有損益公式都在 `CalcEngine.gs` 用 JavaScript 運算，理由：
1. Apps Script 讀寫 Sheet 公式效能差，且多情境比較時公式引用容易錯亂。
2. 計算邏輯集中在一處，方便日後改公式、加科目、單元測試。
3. `PLResult` 是「快照」，可以保留每次計算的時間戳記，做歷史軌跡。

---

## 2. Apps Script 專案檔案配置

```
project/
├─ Code.gs              # doGet 入口、路由、include() 工具
├─ DataService.gs        # 各表 CRUD：getXxx() / saveXxx() / deleteXxx()
├─ CalcEngine.gs          # 損益計算引擎，對應 Gate F 公式鏈
├─ Utils.gs               # ID 產生器、日期格式、快取(CacheService)
├─ Constants.gs           # 分頁名稱、欄位索引、科目代碼常數
├─ index.html             # SPA 外殼（含 nav 切換 輸入/儀表板）
├─ input_salesmix.html    # 銷售構成輸入表單
├─ input_materialcost.html# 材料成本輸入表單
├─ input_devinvestment.html# 開發總投輸入表單
├─ input_parameters.html  # 參數設定（稅率/佣金率/匯率）
├─ dashboard.html         # 車型損益呈現（表格＋圖表，可切換情境比較）
├─ style.html             # 共用 CSS（用 <?!= include('style') ?> 帶入）
└─ script.html            # 共用前端 JS（fetch 封裝、格式化函式）
```

---

## 3. 後端函式介面（DataService.gs）

```js
// 每張表都提供一致介面，例如 SalesMix：
function getSalesMix(scenarioId)            // 回傳該情境所有列 (array of object)
function saveSalesMixRow(rowObj)            // rowObj.RowID 有值→更新，無值→新增+產生RowID
function deleteSalesMixRow(rowId)

// 其餘比照：getMaterialCost / saveMaterialCostRow / deleteMaterialCostRow
//           getDevInvestment / saveDevInvestmentRow / deleteDevInvestmentRow
//           getVehicles / getScenarios / getParameters(scenarioId)

// 寫入時用 LockService 避免多人同時編輯衝突：
function saveSalesMixRow(rowObj) {
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    // 1. 驗證必填欄位
    // 2. 依 RowID 找列號，找不到就 appendRow 並產生新 RowID
    // 3. 寫入 AuditLog
  } finally {
    lock.releaseLock();
  }
}
```

---

## 4. 計算引擎（CalcEngine.gs）介面

```js
function calculatePL(scenarioId, vehicleId) {
  // 1. 讀取該 scenario+vehicle 的 SalesMix、MaterialCost、DevInvestment、Parameters
  // 2. 依序算出：
  //    實際零售價③ = 建議零售價① - 廢車處理費②
  //    營業稅 = ③ × 稅率
  //    銷售佣金 = ③ × 佣金率(依車型)
  //    廠價(未稅) = ③ - 營業稅 - 銷售佣金 - 季margin
  //    A 收入 = 廠價 + 強配收入
  //    B 銷貨成本 = Σ(材料成本LP+KD+運雜+人工+製造費用+模具攤提+技酬金+防鏽+廢棄物+貨物稅)
  //    C 生產毛利 = A - B
  //    E 銷貨毛利 = C - Σd(廣宣/促銷/批標售/margin/索賠)
  //    G 產品貢獻 = E - Σf(直接歸屬費用 + 車型專案開發費用，由 DevInvestment 分攤單台成本得出)
  //    I 營業淨利(未扣前瞻) = G - Σh(固定營業費用/品牌廣宣/特別加發)
  //    K 營業淨利 = I - J(前瞻費用)
  // 3. 每個科目連同 %收入 寫入 PLResult（先刪除該 scenario+vehicle 的舊快照再寫新的）
  // 4. 回傳計算後的 JSON 給前端直接渲染，不必等前端再查一次
  return { scenarioId, vehicleId, lines: [...], calculatedAt: new Date() };
}

function calculatePLAllVehicles(scenarioId) {
  // 迴圈呼叫 calculatePL，並額外算出「DA車加權平均」列（用 SalesMixPct 加權）
}
```

DevInvestment → 單台成本分攤邏輯（對應 Excel 的 CMC單台/BASE廠單台）：
```
該情境總銷售台數 = Σ(SalesMix.MonthlyVolume × 12 × LifeCycleYears)  // 依車型加總
單台開發攤提 = DevInvestment該部門低減後金額 / 該情境總銷售台數
```

---

## 5. 前端頁面設計

- **input_*.html**：表格式輸入（可用簡單的 HTML table + 動態新增列，或用 Google Sheet 內建的資料驗證下拉選單先做，前端表單第二階段再優化成更好用的 UI）。
  - 送出後呼叫 `google.script.run.withSuccessHandler(onSaved).saveXxxRow(formData)`
  - 存檔成功後自動呼叫 `calculatePL()` 更新儀表板快取

- **dashboard.html**：
  - 上方：情境選擇器（下拉選單，可複選比較，如「現況」vs「目標」）
  - 中間：損益表（依 PLLineItems 科目順序，逐車型 + 加權平均欄）
  - 下方：圖表（收入結構堆疊圖、成本結構圓餅圖、多情境營業淨利對比長條圖）— 用 Chart.js（Apps Script HTML Service 可直接掛 CDN script）

---

## 6. 部署與權限

- 部署為 **Web App**：「執行身份：我」＋「存取權：僅限機構內的使用者」（依貴公司網域限制），避免資料外洩。
- 若需要多人同時編輯，Sheet 端另外用「保護範圍」鎖定計算欄位，避免有人手動改到 `PLResult`。
- 建議把 Sheet 拆成兩顆檔案：**輸入資料庫.gsheet**（Vehicles/Scenarios/SalesMix/MaterialCost/DevInvestment/Parameters）與 **計算結果.gsheet**（PLLineItems/PLResult/AuditLog），避免使用者誤改到公式相關分頁；Apps Script 用 `SpreadsheetApp.openById()` 分別存取。（也可以先合併在同一檔案，等資料量/人數變多再拆分）

---

## 7. 待確認事項

1. 使用者是否需要 Google 帳號登入權限控管？（決定部署存取權設定）
2. 是否需要「核准/鎖定」機制，避免情境定案後被誤改？（`Scenarios.Locked` 已預留欄位）
3. 開發總投的部門清單是否固定，或需要讓使用者自行新增部門？
4. Chart.js 走 CDN 是否符合貴公司資安規範，或需要改用 Google Charts（Apps Script 原生支援，不需外部 CDN）？

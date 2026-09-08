# 現金回本點與雙變數敏感度矩陣 — 規格

> **狀態：規格草案，尚未實作。** 本文件記錄評估結論與實作範圍，程式碼另行開發。
> 計算引擎現況見 [`docs/architecture.md`](architecture.md) 第 4 節，資料結構見 [`docs/data-schema.md`](data-schema.md)。

要回答的兩個問題：

1. **這個車型專案幾年回本？** —— 逐年現金流與回本點。
2. **台數與匯率的變動，會把回本點推遲多久？** —— 雙變數敏感度矩陣。

---

## 1. 背景：現行模型是「單台 × LC 平均」

整套系統目前沒有時間維度。時間只在三個地方出現：

| 位置 | 用途 |
|---|---|
| `SalesMix.MonthlyVolume × 12 × LifeCycleYears`（`CalcEngine.gs:483`） | 開發總投攤提的分母 |
| `Scenarios.AmortMonthlyVolume × 12 × AmortLifeCycleYears`（`CalcEngine.gs:472`） | 攤提基準覆寫 |
| 前端 `basisFactor_`（`script.html:2016`） | **只是顯示換算**：單台 × 月銷量 × 12 |

第三項要特別留意：儀表板現有的「年度總額」**不是年度損益**，它是「單台金額 × 年台數」，
隱含假設每一年都一模一樣。

另外，`SalesMix` / `CostOfSales` / `DevInvestment` / `OperatingExpense` / `Parameters`
幾乎每張表都有 `EffectiveDate` 欄位，但**沒有任何一行計算讀它**
（`CalcEngine.gs` 裡零次出現，只有 `DataService.gs:757` 原樣回傳給畫面）。
系統早就替時間留了位子，只是從未啟用。

---

## 2. 前提

以下三點已確認，它們是本規格能大幅收斂的原因：

| # | 前提 | 消除了什麼 |
|---|---|---|
| 1 | **開發總投全部發生在 SOP 前**，目標低減也在 SOP 前達成 | 投資是 t=0 的一筆整數，不需要 `InvestYear`；低減率維持情境層級，不需要年度化 |
| 2 | **h1 固定營業費用 / h3 品牌廣宣 / h4 特別加發 是「單台標準值」**，不隨台數變動 | 不需要替科目加「固定/變動」屬性；除開發攤提外，所有科目都是與台數無關的單台常數 |
| 3 | **回本點採現金口徑** | 現金不看會計攤提怎麼分年，因此**完全不需要攤提排程**（`AmortStartYear` / `AmortYears` / 逐年攤提表一律不做） |

前提 2 的推論很重要：**台數對損益只剩一條影響路徑**

```
台數 → getLifeCycleUnits() → 開發攤提分母 → b5 / b8 / f3 / f4
```

---

## 3. 名詞與口徑

| 符號 | 意義 | 現行來源 |
|---|---|---|
| `I` | 低減後開發總投（元） | `amortizeDevInvestmentPerUnit_()` 的 `totalsByLine` 加總（`CalcEngine.gs:441`）；亦即 `getDevInvestmentSummary().targets[].Total` 的加總 |
| `N` | LIFE CYCLE 總台數 | `getLifeCycleUnits(scenarioId)`（`CalcEngine.gs:472`） |
| `K` | 單台營業淨利 | `lineValues.K` |
| `a` | 單台開發攤提 | `amortizeDevInvestmentPerUnit_()` 的 `perUnit` 加總，等於 `I / N` |
| `m` | **單台現金貢獻**（排除開發攤提） | `K + a` |
| `n*` | **損平台數** | `I / m` |

`perUnit` 加總而非只取 `b5 + b8 + f3 + f4`，是為了自動涵蓋使用者自訂的攤提落點
（`AutoSource = DEV_AMORT`，見 `applyDevAmortLines_`）。

### 現金口徑的定義

本規格的「現金」是**稅前、不含營運資金**的簡化口徑：

- 系統的 `K` 是營業淨利，**沒有企業所得稅**
- **沒有應收帳款 / 存貨的資金占用**
- 假設售出當期即為現金收付

拿去跟財務部的正式投資回收年比對時，差異就在這兩項。**這句話必須顯示在畫面上。**

---

## 4. 核心公式

### 4.1 損平台數

`K` 已經扣過單台開發攤提，把它加回去就是單台現金貢獻：

```
m  = K + a           其中 a = Σ perUnit = I / N
n* = I / m           ← 損平台數
```

### 4.2 一個好用的恆等式

把 `m = K + I/N` 代入：

```
n*     I                       N · I
──  = ─────────        n*  =  ─────────
N     N·K + I                 N·K + I
```

因此**帳面 `K` 的正負，直接決定 LC 內回不回得了本**：

| 帳面 `K` | 損平台數 | 判讀 |
|---|---|---|
| `K > 0` | `n* < N` | LC 內回得了本，`1 − n*/N` 即安全邊際 |
| `K = 0` | `n* = N` | 剛好在 LC 最後一台回本 |
| `K < 0` | `n* > N` | 整個 LC 都回不了本 |

> **現有儀表板其實已經在回答「回不回得了本」了** —— `K` 的正負就是答案。
> 缺的只有「哪一年」，那需要年度台數曲線（第 5 節）。

### 4.3 數值範例

`I` = 4.32 億、`N` = 43,200 台、`a` = 10,000 元／台：

| 單台 `K` | `m` | `n*` | `n*/N` | 判讀 |
|---|---|---|---|---|
| +5,000 | 15,000 | 28,800 台 | 0.67 | LC 內回本，安全邊際 33% |
| 0 | 10,000 | 43,200 台 | 1.00 | 剛好在 LC 最後一台回本 |
| −2,000 | 8,000 | 54,000 台 | 1.25 | LC 內回不了本 |

### 4.4 邊界情況

| 情況 | 處理 |
|---|---|
| `m ≤ 0` | 每賣一台現金反而流出，永遠不回本。顯示「不回本」而非 `∞` 或負數 |
| `I = 0` | 沒有開發投資，`n* = 0`。顯示「無開發投資」 |
| `N = 0` | 沿用 `amortizeDevInvestmentPerUnit_` 現有行為（回傳空攤提），`a = 0`、`m = K` |

### 4.5 損平台數只在「車型層級」有意義

`DevInvestment` 是**部門別層級、不綁車系**（見 `data-schema.md` 2.5），
所以 `I` 是整個車型共用的。`n*` 必須用**加權平均的 `m`** 去除，
算出來是「車型總台數」的損平點。

在單一車系欄位上顯示 `n*` 會誤導 —— 那等於假設「全部台數都是這個車系」。

**規則：`n*` 與回本年只顯示在加權平均欄位。** 單一車系欄位顯示「—」。

---

## 5. 資料模型改動

**只需要新增「年度台數曲線」一項。** 其餘資料表一律不動。

### 方案 A：車系層級（`SalesMixByYear`）

| 欄位 | 型別 | 說明 |
|---|---|---|
| RowID (PK) | text | |
| ScenarioID (FK) | text | |
| VehicleID (FK) | text | |
| Year | number | 相對年序，`1` = SOP 當年 |
| AnnualVolume | number | 該年台數 |

- 資料列數 = 車系數 × LC 年數（5 車系 × 12 年 = 60 列／情境）
- 可表達各車系上市時間不同、構成比逐年變化

### 方案 B：車型層級曲線（較省事）

只存「該情境每一年的總台數」，各車系用現有 `SalesMixPct` 分攤。

- 資料列數 = LC 年數（12 列／情境）
- 輸入介面單純很多：一列數字
- 限制：假設構成比逐年不變

> **待確認事項 1** —— 見第 9 節。若沒有「各車系上市時間不同」的需求，建議方案 B。

### 一致性約束

`Σ AnnualVolume` 應等於 `N`（`getLifeCycleUnits()`）。兩者不一致時：

- **不要**自動改寫任一邊
- 比照現有 `weightedTotalCaveat_()` 的做法，在畫面上標出差幾台並說明怎麼調回來

---

## 6. 後端 API

### 6.1 新增

```js
/**
 * 現金回本分析。VehicleID 一律不傳 —— 開發總投不綁車系，
 * 損平台數只在車型(加權平均)層級有意義（見 4.5）。
 */
function getPaybackAnalysis(scenarioId) {
  return {
    investment: 0,        // I 低減後開發總投
    lifeCycleUnits: 0,    // N
    perUnitAmort: 0,      // a = I / N
    perUnitProfitK: 0,    // K（加權平均）
    perUnitCash: 0,       // m = K + a
    breakEvenUnits: 0,    // n* = I / m；不回本時為 null
    breakEvenRatio: 0,    // n* / N；不回本時為 null
    withinLifeCycle: true,

    years: [{
      year: 1,
      volume: 0,          // 該年台數
      cumulativeVolume: 0,
      cashFlow: 0,        // m × 該年台數
      cumulativeCash: 0   // Σ cashFlow − I（從 −I 起跳）
    }],

    paybackYear: null,       // 累計現金流首次 ≥ 0 的年度；不回本為 null
    paybackYearFraction: 0,  // 該年度內線性內插的位置（0~1），用於畫穿越點
    volumeCaveat: null       // Σ AnnualVolume ≠ N 時的說明文字
  };
}
```

### 6.2 明確不改動的東西

| 項目 | 原因 |
|---|---|
| `calculatePLCoreUncached_` 那 108 行公式鏈（`CalcEngine.gs:100-208`） | 現金口徑把攤提整個加回去，公式鏈不需要年度化 |
| `devPerUnit` 注入點（`CalcEngine.gs:131, 138, 155, 167, 173`） | 同上 |
| `PL_CORE_MEMO_` 的鍵（`CalcEngine.gs:93-97`） | 回本分析不需要逐年重算損益 |
| `CostOfSales` / `OperatingExpense` / `DevInvestment` / `Parameters` | 逐年成本假設不在本次範圍（見第 8 節） |

`getPaybackAnalysis()` 需要的量全部來自現有函式的回傳值，
**損平台數 KPI 可以在年度台數表完成之前先上線**（只有逐年曲線需要新資料）。

---

## 7. 前端呈現

### 7.1 損平台數 KPI（零資料改動，可先做）

加進儀表板「損益表」子頁籤的重點指標卡片，只在加權平均欄位顯示：

```
損平台數   28,800 台
           佔 LC 總台數 67%（安全邊際 33%）
```

`K < 0` 時顯示「LC 內不回本（需 54,000 台，超出 LC 10,800 台）」。

### 7.2 回本曲線（新子頁籤「回本分析」）

沿用現有 `svgBarChart_`（`script.html:2377`，浮動長條 y0→y1 的通用產生器）改折線，
hover 掛 `installTooltipEngine_`（`script.html:3147`）的 `data-tipfn`，
金額換算沿用 `displayAmount_`（`script.html:2023`）：

```
X 軸 = 年度（1 = SOP 當年）
線1  = 年度現金流       = m × 該年台數
線2  = 累計現金流 − I   ← 從 −I 起跳，穿越 0 的點就是回本點
標記 = n* 損平台數落在哪一年（垂直虛線）
```

搭配一張逐年表格（年度／台數／累計台數／年度現金流／累計現金流），可匯出 CSV。

畫面上固定顯示口徑聲明：**稅前現金流，未計企業所得稅與營運資金占用。**

---

## 8. 雙變數敏感度矩陣（台數 × 匯率）

### 8.1 指標與軸的有效性

**這是設計上最容易做錯的一點。** 不同指標下，台數軸的意義完全不同：

| 指標 | 台數軸 | 匯率軸 | 說明 |
|---|---|---|---|
| 單台 `K` | 有效 | 有效 | 台數透過攤提稀釋影響 `K`，是 1/x 曲線 |
| **損平台數 `n*`** | **無效（整排相同）** | 有效 | `n* = I / m`，`I` 與 `m` 都不含台數 |
| **回本年** | **有效** | **有效** | 台數決定「多快賣到 `n*` 台」，不是「`n*` 是多少」 |

**`台數 × 匯率 → 回本年` 才是要做的那張矩陣。**
若要看匯率對 `n*` 的影響，配一張單軸圖即可，不要做成二維。

### 8.2 匯率的雙重影響

匯率同時影響兩條路徑，**方向相同**：

| 路徑 | 程式位置 | 效果 |
|---|---|---|
| 外幣開發投資換算 | `CalcEngine.gs:430` | 匯率升 → `I` 上升 |
| 外幣材料成本換算 | `CalcEngine.gs:153` | 匯率升 → `m` 下降 |

兩者都讓 `n*` 惡化，所以 `n*` 對匯率相當敏感。這正是這張矩陣的價值所在。

### 8.3 API

```js
function calculateSensitivity(scenarioId, spec) {
  // spec = {
  //   volumeAxis:  [0.7, 0.85, 1.0, 1.15, 1.3],   // 年度台數曲線的縮放係數
  //   fxAxis:      { currency: 'JPY', values: [0.20, 0.22, 0.24] },
  //   metric:      'paybackYear' | 'breakEvenUnits' | 'K'
  // }
  // 回傳 { rows, cols, cells: [[...]], baseCell: {r, c} }
}
```

### 8.4 必要的重構

`calculatePLCoreUncached_` 目前自己讀表（`getSalesMix` / `getParameters` /
`getCostOfSales` / `getOperatingExpense`）。敏感度需要「不存檔就試算」，
因此要把「讀表」與「算」分開：

```
loadPLInputs_(scenarioId, vehicleId)  →  inputs 物件
calcFromInputs_(inputs)               →  lineValues
```

這個模式在 codebase 已有先例：`amortizeDevInvestmentPerUnit_(scenarioId, overrideRows)`
與 `previewDevInvestmentSummary()`（`CalcEngine.gs:415, 550`），
開發總投頁面的即時預覽就是這樣做的。

### 8.5 實作陷阱

> **`PL_CORE_MEMO_` 必須繞過。**
> 它以「情境\|車系」為鍵（`CalcEngine.gs:93-97`），只有寫入時才會被
> `resetExecutionCaches_()`（`Utils.gs:66`）清掉。敏感度矩陣每一格的情境與車系都相同，
> 不繞過的話 **49 格會全部拿到同一個數字** —— 而且看起來像「功能沒作用」，不像 bug。

### 8.6 效能

不是問題。7×7 = 49 格，每格一次純 JS 運算；讀表有 `SHEET_CACHE_` 單次執行快取
（`Utils.gs:43`），**Sheets API 呼叫次數不隨格數成長**。距離 Apps Script 的 6 分鐘上限很遠。
加權平均會再乘上車系數，仍在安全範圍。

---

## 9. 明確不做的事

列在這裡，避免範圍蔓延：

| 不做 | 原因 |
|---|---|
| 攤提排程（`AmortStartYear` / `AmortYears` / 逐年攤提） | 現金口徑不看會計攤提怎麼分年（前提 3） |
| 挑戰低減率年度化 | 低減在 SOP 前達成（前提 1） |
| 逐年成本／售價假設（材料降價曲線、年度調價） | 這是另一個層級的工程（三個矩陣頁面要從 2D 變 3D、`DataService` 全面改鍵）。回本點與趨勢不需要它 |
| 科目的「固定／變動」屬性 | h 類是單台標準值（前提 2） |
| NPV / IRR / 折現 | 需要折現率政策，且非本次要回答的問題 |
| 殘值 / 減損 | 投資在 SOP 前一次發生、現金口徑下不產生未攤提餘額的問題 |

---

## 10. 待確認事項

1. **年度台數放在車型層級還是車系層級？**（第 5 節方案 A / B）
   —— 有沒有「各車系上市時間不同」的需求？沒有的話建議方案 B。
2. **匯率軸是單一幣別，還是全部外幣同步變動？**
   實務上通常是單一幣別（JPY 或 CNY），需要一個幣別選擇器。
3. **年度台數與 `getLifeCycleUnits()` 不一致時**，除了畫面示警之外，
   回本分析要以哪一邊為準？（建議以年度台數為準，因為它才有時間資訊）
4. **`Scenarios.AmortMonthlyVolume / AmortLifeCycleYears` 這個攤提基準覆寫**，
   在有年度台數之後是否還保留？兩者概念重疊。

---

## 11. 驗證計畫

沿用 `tools/` 的記憶體模擬層，新增 `tools/verify-payback.js`：

| 測試 | 內容 |
|---|---|
| 恆等式 | `n* / N == I / (N·K + I)`，用 Gate F 實際數字驗 |
| 邊界 | `K = 0` 時 `n* == N`；`m ≤ 0` 時回傳「不回本」而非負數／`Infinity` |
| 累計一致 | `Σ 年度現金流 − I == N × K`（全 LC 賣完後的累計現金 = 帳面總淨利） |
| 台數縮放 | 年度台數整體 ×k 時，`n*` **不變**、回本年提前（驗 8.1 那張表的結論） |
| 匯率單調 | 匯率上升時 `n*` 單調惡化（驗 8.2 的雙路徑同向） |
| 敏感度中心格 | 矩陣中心格 == 現行儀表板算出的同一個數字（防止重構走樣） |

另外，第 8.4 節的重構完成後，`tools/verify-gatef.js` 的 317 格逐格驗算**必須完全不變** ——
這是重構沒有改到計算結果的保證。

# 車型損益試算系統 — 資料結構草案

依據實務 Gate F 損益試算 Excel（材料成本 / 開發總投 / GATE F 含TNCAP）整理而成。
架構：**Google Sheet 作為資料庫**（每個分頁 = 一張表），**Apps Script 作為後端 API**，
**HTML Service 作為前端**。

---

## 1. 命名慣例

- 每張表第 1 列為欄位標題（英文代碼），第 2 列可放中文說明（Apps Script 讀取時跳過）。
- 每張表第 1 欄為 `RowID`（唯一鍵，格式 `表前綴-流水號`，如 `MC-000123`），方便 upsert 與追蹤。
- 所有金額欄位單位為「元」，比例欄位存小數（0.15 代表 15%），不存整數 15。
- 日期欄位一律 `yyyy-mm-dd`。

---

## 2. 分頁（表）設計

### 2.0 `VehicleTypes` 車型主檔（上層）

前端最上層的選單單位。使用者必須先在這裡選擇/建立車型（如 `DA`），
才能在下層 `Vehicles`（車系）新增資料 —— 車系不能脫離車型獨立存在。

| 欄位 | 型別 | 說明 |
|---|---|---|
| VehicleTypeID (PK) | text | 車型代號，如 `DA`、`DE`、`DH`、`DX` |
| VehicleTypeName | text | 車型名稱（選填） |
| Notes | text | 備註 |

### 2.1 `Vehicles` 車系設定（下層，隸屬某個車型）

| 欄位 | 型別 | 說明 |
|---|---|---|
| VehicleID (PK) | text | 如 `DA-3T`、`DA-9C`、`DA-9P` |
| VehicleTypeID (FK) | text | 對應 `VehicleTypes.VehicleTypeID`，如 `DA` |
| VehicleCode | text | 車系名稱：3人貨車 / 9人客貨車(商用) / 9人客貨車(接駁) / 幼童車 / 福祉車 |
| Notes | text | 備註 |

> 不再有 `Status`（現況/開發中/量產）欄位；車型只有「存在/不存在」兩種狀態，
> 不需要的車系直接在「車系設定」頁面刪除即可。

### 2.2 `Scenarios` 情境主檔

損益試算常需要多情境比較（現況 vs 目標 vs 已知低減方向 vs DE基準 vs DH目標），
所有交易表都用 `ScenarioID` 做區隔，同一車型可以有多筆情境版本。
前端導覽以「車型」為第一層選單，「情境」是車型底下的第二層選單，
切換車型後情境選單會重新載入該車型專屬的情境清單。

| 欄位 | 型別 | 說明 |
|---|---|---|
| ScenarioID (PK) | text | 如 `SC-2026-CURRENT`、`SC-2026-TARGET` |
| ScenarioName | text | 現況 / 目標 / 已知低減方向 / DE次車型定價 / DH目標成本 |
| VehicleTypeID (FK) | text | 對應 `VehicleTypes.VehicleTypeID` |
| BaseScenarioID | text | 若為情境衍生（如「目標」衍生自「現況」），記來源 |
| CreatedBy / CreatedDate | text/date | 建立者、日期 |
| Locked | boolean | 是否鎖定（避免定案後誤改） |
| Notes | text | 備註 |

### 2.3 `SalesMix` 銷售構成與售價（車型構成含售價台數）

每列 = 一個「情境 × 車型」的銷售假設。

| 欄位 | 型別 | 說明 |
|---|---|---|
| RowID (PK) | text | |
| ScenarioID (FK) | text | |
| VehicleID (FK) | text | |
| SalesMixPct | % | 銷售構成比 |
| MonthlyVolume | number | 預估銷售台數(月) |
| LifeCycleYears | number | LC 年限（如 12） |
| ListPriceTaxIncl | currency | 建議零售價(含稅) |
| MandatoryAccessoryPrice | currency | 強配件售價 |
| ScrapFee | currency | 廢車處理費 |
| ScrapFeeTaxStatus | text | 含稅 / 未稅 —— 標明 `ScrapFee` 是否已含稅，CalcEngine 一律換算成含稅金額後再從零售價扣除，確保全份損益試算稅別口徑一致 |
| EffectiveDate | date | 生效日 |
| Notes | text | |

> 廠價(未稅)、實際零售價、營業稅、銷售佣金等屬於**計算欄位**，不落地存，由 CalcEngine 用 `Parameters` 的稅率/佣金率即時算出並寫入 `PLResult`。
>
> **LIFE CYCLE 總台數**（供 `DevInvestment` 單台攤提使用）= `MonthlyVolume × 12 × LifeCycleYears`，屬計算欄位不落地存。
>
> **銷售構成雙向輸入**：`SalesMixPct`（百分比）與 `MonthlyVolume`（台數）兩欄位皆可直接輸入；
> 前端「銷售構成」頁面提供「依台數重算百分比」「依百分比反推台數」兩個工具按鈕，
> 呼叫 `recalcSalesMixPctByVolume(scenarioId)` / `recalcSalesMixVolumeByPct(scenarioId, totalMonthlyVolume)`
> 對同一情境（= 同一車型）下的所有車系列做批次換算並回寫。

### 2.4 `MaterialCost` 材料成本明細（銷貨成本，不分採購模式）

材料成本試算即銷貨成本（B 科目 b1~b13），LP（在地採購）與 KD（進口）皆為成本項目，
不再另立「採購模式」欄位；LP/KD 的區分已內含在 `CostCategory`（如「材料成本-LP」「材料成本-KD」）
與其對應的 `LineCode`（b1/b2）之中。

| 欄位 | 型別 | 說明 |
|---|---|---|
| RowID (PK) | text | |
| ScenarioID (FK) | text | |
| VehicleID (FK) | text | |
| CostCategory | text | 材料成本-LP / 材料成本-KD / 內陸運雜 / 強配成本 / 一般材料 / 模具費用 / 直接人工 / 製造費用 / 新增專屬設備 / 技酬金 / 水平配件 / 防鏽 / 廢棄物處理及包材 / 貨物稅 |
| Amount | currency | |
| Currency | text | TWD / CNY |
| ExchangeRate | number | 若原幣別非 TWD |
| Source | text | 資料來源說明，如「8/4 BASE廠報價」 |
| EffectiveDate | date | |

### 2.5 `DevInvestment` 開發總投

對應 Excel「部門別 × 資產類(模具/設備)/費用類 × 是否對應TNCAP」三維結構。

| 欄位 | 型別 | 說明 |
|---|---|---|
| RowID (PK) | text | |
| ScenarioID (FK) | text | |
| Department | text | 部門自由新增/刪除（如產專室 / 產工部 / 試驗部 / 開發部...），每一列投入金額皆可獨立刪除，不受限於固定清單 |
| AssetType | text | 模具 / 設備 / 費用 |
| TNCAPFlag | text | 對應TNCAP / 不對應TNCAP |
| Amount | currency | 原始投入金額 |
| ChallengeReductionPct | number | 挑戰低減目標%，以 0~100 的百分比數值輸入/儲存（如 15 代表 15%），與其他比例欄位存小數(0~1)的慣例不同 |
| Notes | text | |
| EffectiveDate | date | |

> 「低減後金額」「低減金額」「CMC單台」「BASE廠單台」皆為計算欄位，由 CalcEngine 依 `SalesMix.LifeCycleYears × MonthlyVolume` 算出總台數後分攤。

### 2.6 `Parameters` 參數設定

前端拆成兩個獨立分頁籤管理（底層仍是同一張 `Parameters` 表，只是依 `ParamName` 篩選）：
- **稅務/費用比率**：營業稅率 / 銷售佣金率 / 季Margin率 / 貨物稅率
- **匯率設定**：集團預算匯率 / 現況匯率

| 欄位 | 型別 | 說明 |
|---|---|---|
| ParamID (PK) | text | |
| ScenarioID | text | 空白代表全域預設值 |
| VehicleID | text | 空白代表不分車系（如佣金率因車系而異時才填） |
| ParamName | text | 營業稅率 / 銷售佣金率 / 貨物稅率 / 季Margin率 / 集團預算匯率 / 現況匯率 |
| Value | number | |
| EffectiveDate | date | |

### 2.7 `PLLineItems` 損益科目定義（靜態參照表）

固定損益結構，程式依此逐科目 rollup，不隨情境變動。

| LineCode | LineName | ParentLine | Category |
|---|---|---|---|
| A | 收入(未稅,含強配) | - | 收入 |
| B | 銷貨成本合計 | - | 成本 |
| b1 | 材料成本-LP | B | 成本明細 |
| b2 | 材料成本-KD | B | 成本明細 |
| b3~b13 | 強配成本/一般材料/水平配件/新增專屬設備/模具費用/直接人工/製造費用/技酬金/防鏽/廢棄物/貨物稅 | B | 成本明細 |
| C | 生產毛利 (=A-B) | - | 毛利 |
| d1~d5 | 廣宣費用/促銷/批標售/0.5%Margin/索賠 | E | 費用明細 |
| E | 銷貨毛利 (=C-Σd) | - | 毛利 |
| f1,f3,f4 | 直接歸屬費用/車型專案開發費用-CMC/BASE廠 | G | 費用明細 |
| G | 產品貢獻 (=E-Σf) | - | 貢獻 |
| h1,h3,h4 | 固定營業費用/品牌廣宣費用/特別加發 | I | 費用明細 |
| I | 營業淨利(未扣前瞻) (=G-Σh) | - | 淨利 |
| J | 前瞻費用 | - | 費用 |
| K | 營業淨利 (=I-J) | - | 淨利 |

### 2.8 `PLResult` 損益計算結果（CalcEngine 寫回）

| 欄位 | 型別 | 說明 |
|---|---|---|
| ResultID (PK) | text | |
| ScenarioID (FK) | text | |
| VehicleID (FK) | text | 空白代表「DA車加權平均」列 |
| LineCode (FK) | text | 對應 PLLineItems |
| Amount | currency | |
| PctOfRevenue | % | 佔 A 的比例 |
| CalcTimestamp | datetime | 計算時間，用來判斷是否為最新結果 |

### 2.9 `OperatingExpense` 營業費用明細（d / f1 / h 科目）

材料成本表只涵蓋 B 銷貨成本（b1~b13）。E 之後的廣宣、促銷、費用類科目（d1~d5、f1、h1、h3、h4）另立一張表，結構與 `MaterialCost` 相同、只是科目集合不同，方便同一輸入表單的邏輯重用。

| 欄位 | 型別 | 說明 |
|---|---|---|
| RowID (PK) | text | |
| ScenarioID (FK) | text | |
| VehicleID (FK) | text | |
| LineCode | text | d1廣宣費用 / d2促銷 / d3批標售 / d4margin / d5索賠 / f1直接歸屬費用 / h1固定營業費用 / h3品牌廣宣費用 / h4特別加發 / J前瞻費用 |
| Amount | currency | |
| Notes | text | |
| EffectiveDate | date | |

> f3（車型專案開發費用-CMC）、f4（車型專案開發費用-BASE廠）不在此表手動輸入，而是由 `CalcEngine` 依 `DevInvestment` 總投金額 ÷ 該情境總銷售台數（LC年限 × 月台數 × 12）自動攤提得出「單台開發成本」。

### 2.10 `AuditLog` 異動紀錄（選配，建議加）

| 欄位 | 型別 | 說明 |
|---|---|---|
| Timestamp | datetime | |
| User | text | `Session.getActiveUser().getEmail()` |
| SheetName | text | 異動的表 |
| RowID | text | |
| Action | text | INSERT / UPDATE / DELETE |
| OldValue / NewValue | text | JSON 字串 |

---

## 3. 資料表關聯

```
VehicleTypes ──< Vehicles(車系) ──┬──< SalesMix >──┐
                                   ├──< MaterialCost >──┤
                                   └──< DevInvestment(部門別，不綁單一車系) >──┤
VehicleTypes ──< Scenarios ────────────────────────────┤
                                                          ├─ Scenarios
Parameters ───(依 ScenarioID/VehicleID 查詢)──────────────┤
                                                          │
PLLineItems ──(靜態科目表)──> CalcEngine ──> PLResult >──┘
```

- 前端導覽順序：先選「車型」(`VehicleTypes`，如 DA)，車型底下管理「車系」(`Vehicles`，如 3人貨車/9人客貨車) 與「情境」(`Scenarios`)；情境是車型的次要選單，同一車型下可以有多個 `ScenarioID`（現況/目標/已知低減方向），前端可並排比較。
- `DevInvestment` 是「部門別」層級，不直接綁車系；分攤到車系時透過 `SalesMix` 的 `LifeCycleYears × MonthlyVolume` 算出的「總台數」比例分攤（對應 Excel 的 CMC單台 / BASE廠單台邏輯）。

---

## 4. 後續：Apps Script 架構與資料流

見 `docs/architecture.md`。

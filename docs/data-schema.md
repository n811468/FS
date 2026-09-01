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

### 2.1 `Vehicles` 車型主檔

| 欄位 | 型別 | 說明 |
|---|---|---|
| VehicleID (PK) | text | 如 `DA-3T`、`DA-9C`、`DA-9P` |
| VehicleSeries | text | 車系，如 DA / DE / DH / DX |
| VehicleCode | text | 車型名稱：3人貨車 / 9人客貨車(商用) / 9人客貨車(接駁) / 幼童車 / 福祉車 |
| Status | text | 現況 / 開發中 / 量產 |
| Notes | text | 備註 |

### 2.2 `Scenarios` 情境主檔

損益試算常需要多情境比較（現況 vs 目標 vs 已知低減方向 vs DE基準 vs DH目標），
所有交易表都用 `ScenarioID` 做區隔，同一車型可以有多筆情境版本。

| 欄位 | 型別 | 說明 |
|---|---|---|
| ScenarioID (PK) | text | 如 `SC-2026-CURRENT`、`SC-2026-TARGET` |
| ScenarioName | text | 現況 / 目標 / 已知低減方向 / DE次車型定價 / DH目標成本 |
| VehicleSeries | text | 對應車系 |
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
| EffectiveDate | date | 生效日 |
| Notes | text | |

> 廠價(未稅)、實際零售價、營業稅、銷售佣金等屬於**計算欄位**，不落地存，由 CalcEngine 用 `Parameters` 的稅率/佣金率即時算出並寫入 `PLResult`。

### 2.4 `MaterialCost` 材料成本明細

| 欄位 | 型別 | 說明 |
|---|---|---|
| RowID (PK) | text | |
| ScenarioID (FK) | text | |
| VehicleID (FK) | text | |
| CostType | text | LP（在地採購）/ KD（進口） |
| CostCategory | text | 式樣調整 / VAVE / 座椅 / 車身 / 電池 / K件 / 一般材料 / 水平配件 / 新增專屬設備 / 內陸運雜 / 模具費用 / 直接人工 / 製造費用 / 技酬金 / 防鏽 / 廢棄物處理及包材 / 貨物稅 |
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
| Department | text | 產專室 / 產工部 / 試驗部 / 開發部 / 電電部 / 前瞻技術室 / 造型部 / 生技部 / 品管部 / 楊梅廠 / 新竹廠 / 業務部 / 服務部 / 生管部 |
| AssetType | text | 模具 / 設備 / 費用 |
| TNCAPFlag | text | 對應TNCAP / 不對應TNCAP |
| Amount | currency | 原始投入金額 |
| ChallengeReductionPct | % | 挑戰低減目標% |
| Notes | text | |
| EffectiveDate | date | |

> 「低減後金額」「低減金額」「CMC單台」「BASE廠單台」皆為計算欄位，由 CalcEngine 依 `SalesMix.LifeCycleYears × MonthlyVolume` 算出總台數後分攤。

### 2.6 `Parameters` 參數設定

| 欄位 | 型別 | 說明 |
|---|---|---|
| ParamID (PK) | text | |
| ScenarioID | text | 空白代表全域預設值 |
| VehicleID | text | 空白代表不分車型（如佣金率因車型而異時才填） |
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

### 2.9 `AuditLog` 異動紀錄（選配，建議加）

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
Vehicles ──┬──< SalesMix >──┐
           ├──< MaterialCost >──┤
           └──< DevInvestment(部門別，不綁單一車型) >──┤
                                                          ├─ Scenarios
Parameters ───(依 ScenarioID/VehicleID 查詢)──────────────┤
                                                          │
PLLineItems ──(靜態科目表)──> CalcEngine ──> PLResult >──┘
```

- `DevInvestment` 是「部門別」層級，不直接綁車型；分攤到車型時透過 `SalesMix` 的 `LifeCycleYears × MonthlyVolume` 算出的「總台數」比例分攤（對應 Excel 的 CMC單台 / BASE廠單台邏輯）。
- 同一 `VehicleSeries` 下可以有多個 `ScenarioID`（現況/目標/已知低減方向），前端可並排比較。

---

## 4. 後續：Apps Script 架構與資料流

見 `docs/architecture.md`。

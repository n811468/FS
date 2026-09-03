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
   │  讀 SalesMix / CostOfSales / DevInvestment / OperatingExpense / Parameters
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
apps-script/                # 貼進 Apps Script 編輯器的檔案（檔名需一致）
├─ appsscript.json         # 專案設定（webapp.access = MYSELF）
├─ Code.gs                 # doGet 入口、Sheets 自訂選單
├─ Constants.gs            # 分頁名稱、SCHEMA、科目表、預設參數
├─ Utils.gs                # ID 產生器、日期正規化、upsert/delete、分頁讀取快取(單次執行內)
├─ SetupSheets.gs          # 初始化分頁與科目表；重設科目排序、清除未使用參數等維護作業
├─ DataService.gs          # 各表 CRUD 與表格式整批存檔：getXxxGrid() / saveXxxGrid()
├─ CalcEngine.gs           # 損益計算引擎，對應 Gate F 公式鏈；比較 API 與小計驗算
├─ index.html              # SPA 外殼（nav 分頁 + 各 panel 容器）
├─ style.html              # 共用 CSS（用 <?!= include('style') ?> 帶入）
└─ script.html             # 全部前端 JS：主檔表格、各輸入表格、儀表板

tools/                      # 只在本機用 Node 執行，不會部署到 Apps Script
├─ fake-apps-script.js     # 記憶體版的 SpreadsheetApp/LockService/Utilities，讓 .gs 能在 Node 跑
├─ verify-gatef.js         # 用實際 Gate F 表的數字逐格驗算計算引擎
├─ verify-features.js      # 驗這一版的行為（情境帶入、科目自動編號、匯率精簡…）
├─ verify-ui.js            # 前端純函式的靜態驗證（損益表結構、hover 提示內容、SVG 圖表、差異模式…）
└─ dev-server.js           # 本機預覽：把 .gs 跑在 Node 上、假的 google.script.run 走 HTTP，瀏覽器直接開整個前端
```

> 前端全部集中在 `script.html`（單一 SPA），沒有 `input_*.html` / `dashboard.html` 這類分檔 ——
> 每個分頁都是同一套表格元件的組態差異，拆檔只會讓共用邏輯散掉。

---

## 3. 後端函式介面（DataService.gs）

```js
// 每張表都提供一致介面，例如 SalesMix：
function getSalesMix(scenarioId)            // 回傳該情境所有列 (array of object)
function saveSalesMixRow(rowObj)            // rowObj.RowID 有值→更新，無值→新增+產生RowID
function deleteSalesMixRow(rowId)

// 其餘比照：getCostOfSales / saveCostOfSalesRow / deleteCostOfSalesRow
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
  // 1. 讀取該 scenario+vehicle 的 SalesMix、CostOfSales、DevInvestment、OperatingExpense、Parameters
  //    (比率參數一律以百分比數值儲存，取用時經 pct_() 除以 100)
  // 2. 依序算出（P1~P9 售價結構會逐列輸出到儀表板，不再只是中間變數）：
  //    P3 建議零售價(不含強配,含稅) = P1 建議零售價(含稅) - P2 強配件售價
  //    P5 實際零售價(含稅) = P3 - P4 廢車處理費(換算含稅)
  //    P6 營業稅 = P5 × 稅率/(1+稅率)        → 內含稅反推
  //    P7 銷售佣金 = (P5 - P6) × 佣金率        → 基礎為未稅零售價
  //    P8 廠價(未稅) = P5 - P6 - P7
  //    A 收入(未稅,含強配) = P8 + P9 強配收入
  //    B 銷貨成本 = Σ(手動輸入的成本科目，外幣以現況匯率換算)
  //               + b5 模具攤提 + b8 設備攤提 (開發總投 ÷ LC總台數)
  //               + b13 貨物稅 ((廠價-水平配件調降-廣促margin)×完稅計算率÷(1+率)×率)
  //    C 生產毛利 = A - B
  //    E 銷貨毛利 = C - Σd(廣宣/促銷/批標售/索賠 + d4 季Margin = P8 廠價(未稅) × 季Margin率)
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
LIFE CYCLE 總台數 = 情境的攤提基準(AmortMonthlyVolume × 12 × AmortLifeCycleYears)
                    留空才用 Σ(SalesMix.MonthlyVolume × 12 × LifeCycleYears)
低減後金額 = Amount × (1 - ChallengeReductionPct/100)
單台攤提 = 低減後金額 / LIFE CYCLE 總台數，依 AssetType 落到不同科目：
  模具 → b5 模具費用(銷貨成本)          設備 → b8 新增專屬設備(銷貨成本)
  費用 → f3 開發費用-CMC；Department = 「BASE廠開發費」時落 f4 開發費用-BASE廠
```

---

## 5. 前端頁面設計

所有頁面都是表格式編輯：一次看到全部資料、直接在格子裡改、最後按一次「儲存」整批送出。
沒有「先按編輯才能改某一列」的模式 —— 那會讓一次要調十幾個數字的作業變成點十幾次編輯。

Apps Script 的 HtmlService 網頁跑久了偶爾會自己整頁重新整理（Google 內部的工作階段/驗證更新機制，
前端程式碼管不到、也無法阻止）。為了不讓使用者覺得「莫名其妙跳回第一頁」，`switchTab()` /
`onVehicleTypeChange()` / `setCurrentScenario()` 都會把「目前在哪一頁、選了哪個車型/情境」存進
`localStorage`（`saveAppState_()`），開場 `DOMContentLoaded` 時讀回來還原（`loadAppState_()`）。
表格編輯頁裡「還沒存檔的修改」本來就無法安全地跨一次整頁重新整理還原，不在這個機制處理範圍內。

- **主檔維護頁**（車型 / 車系 / 情境 / 科目設定）：共用一套可直接編輯的表格元件
  （`renderEntityPanel` / `drawEntityGrid` / `saveEntityGrid`），「新增一列」在表格最後補一列空白列，
  跟其他修改一起送出（`saveVehicleTypeGrid` / `saveVehicleGrid` / `saveScenarioGrid` / `savePLLineItemGrid`）。
  - 主鍵欄位（車型代號、車系代號）建立後就鎖住：主鍵是所有資料的鍵值，改掉等於另開一筆、舊資料會變孤兒。
  - 科目設定的 `LineCode` 由後端自動編號（`nextLineCode_()`：父科目字首 + 最小未使用號碼），
    使用者只選父科目、填名稱；新增列在儲存當下才配號。
  - **自動計算科目與結構科目的名稱由程式擁有**：名稱寫的就是它的公式，畫面上不開放修改，
    且 `getBootstrap()` 每次都會呼叫 `syncCodeOwnedLineItems_()` 把 Sheet 上的舊名稱對回程式碼。
    改版重新編號（售價結構從 8 列變 9 列）之後，舊 Sheet 上會出現欄位名稱與數字對不起來的情形，
    而 `seedPLLineItems_()` 為了保留使用者改過的名稱不會覆蓋既有科目 —— 名稱是描述公式的，
    就該由公式那一邊決定。明細科目的名稱仍屬使用者，要整批回復用 `restoreBuiltInLineItems()`。
  - 情境設定另有「以既有情境為基礎建立」（`createScenarioFrom()`）與「帶入目前情境」
    （`copyScenarioData()`），限同一車型 —— 跨車型的車系對不上，會產生看不見卻仍被計入損益的資料。

- **表格編輯頁**（銷售構成 / 銷貨成本 / 開發總投 / 營業費用 / 稅務費用比率 / 匯率設定）：
  一次看到全部資料、直接在格子裡改、最後按一次「儲存」整批送出，避免逐筆開表單輸入。
  - 銷售構成：依車系自動列出，台數與構成比即時互相連動（`getSalesMixGrid` / `saveSalesMixGrid`）。
  - 銷貨成本 / 營業費用：矩陣式（列 = 科目、欄 = 車系），科目可直接在該頁新增/刪除
    （`getCostOfSalesMatrix` / `saveCostOfSalesMatrix`、`addLineItemInline` / `deleteLineItemInline`）。
    最右欄是**加權平均**而非跨車系合計：一列是同一個成本項目在各車系的單台金額，相加沒有意義；
    矩陣 API 會一併回傳各車系的 `SalesMixPct`，前端據此算 Σ(金額×構成比)÷Σ構成比。
  - 開發總投：每一列選「攤提落點」(`DEV_ASSET_TYPES`)，落點直接對應損益科目
    （`DEV_ASSET_TYPE_TARGET`：模具→b5、設備→b8、費用-CMC→f3、費用-BASE廠→f4），
    同一列旁邊就顯示會攤到哪個科目，下方另有各落點的投資總額與單台攤提對照表。
    舊版靠 `Department === 'BASE廠開發費'` 這個字串來分 f3/f4，部門是自由輸入欄位，
    打成別的字就整筆落到 f3、而且畫面上看不出來（f4 永遠是 0）；舊資料仍照原規則判讀後自動轉換。
    目標情境才顯示挑戰低減目標欄位，並可用 `copyScenarioData()` 從其他情境整批帶入資料。
    使用者自訂的攤提落點（`AutoSource=DEV_AMORT`，跟內建的 b5/b8/f3/f4 不同）沒有任何情境的
    開發總投列指到它時，不會再強制以 0 出現在損益表/矩陣頁面上，也可以直接在「科目設定」刪除
    （`deletePLLineItem` 只擋「還有資料指到這裡」的情況，不像其他自動計算科目一律鎖死）。
  - 稅務費用比率：「全車系適用」一欄 + 各車系覆寫欄，留白自動沿用（`getRateGrid` / `saveRateGrid`）。
  - 匯率設定：以幣別管理（`getFxGrid` / `saveFxGrid`），設定過匯率的幣別才會出現在銷貨成本的幣別選單。
    只有一種「現況匯率」；舊版的「集團預算匯率」沒有任何計算讀它，已移除。

- **損益儀表板（多車型維度比較）**：
  - **拆成四個子頁籤**（`dashSubNavHtml` / `dashView`），一次只專心看一件事，不再把建構欄位、
    重點指標、圖表、差異卡片全部疊在同一個長頁面上：
    「比較欄位」建構要比的欄位、「損益表」主表格+重點指標+小計驗算、「圖表」四種柱狀圖、
    「差異比較」使用者自選兩欄的差異卡片。目前停在哪個子頁籤也記在 `localStorage`，重新整理後還在原地。
  - **比較欄位**：每一列是一個比較欄位(車型 × 情境(GATE) × 車系，或該情境的「加權平均」)，
    整張表都是下拉選單（`comparisonBuilderHtml_`），改哪一列就直接換那一欄要比的資料 ——
    跟系統其他頁面「表格式編輯」的慣例一致，不再另外用一組獨立的挑選器 + 卡片列表。
    最後一列固定是「新增」列；改成跟別欄重複的組合會被擋下來並還原。
    可同時加入**不同車型**的欄位並排比較（如 DA GATE F 目標 vs DE GATE F 現況），可用箭頭或拖曳排序。
    加入新欄位只把「還沒算過」的欄位送後端（`calculateComparison(missing)`），算回來後在前端併進手上的結果
    （`mergeComparison_` 取科目聯集、`reorderComparison_` 依選擇順序重排）；調整順序、移除欄位完全不打後端。
    進儀表板與按「重新計算」一律整份重算，避免其他分頁剛改過的資料被舊結果蓋掉。
    比較欄位、差異組合與所有顯示設定都記在瀏覽器 `localStorage`（`saveDashPrefs_` / `loadDashPrefs_`），
    下次打開不必重新加欄位；已刪掉的情境/車系會被濾掉、不合法的設定值會被忽略。
  - **重點指標卡片**：每個欄位一張，營業淨利 + 淨利率、收入與各段毛利率，以及「vs 基準」的差異(有設定比較基準才顯示)。
  - 損益表（依 PLLineItems 的 SortOrder 排序），版面比照實際 Gate F 損益試算表 ——
    每個比較欄位分「金額」與第二小欄，明細科目縮排在它的小計底下，小計/毛利/淨利整列反白，
    售價結構 P1~P9 另成一段（可關掉），B/E/G/I 大項可收合，這樣「哪幾列加起來等於哪一列」在畫面上是看得見的。
  - **第二小欄可切換**：對廠價(未稅) P8 %（預設）、對收入(未稅,含強配) A %、**與基準欄位的差異（金額或 %）**。
    **比較基準不是必要的** —— 預設不設定，`baselineCol_()` 不會偷偷選第一欄；用工具列的「比較基準」
    下拉選單或欄位標題/卡片上的 ★ 指定，再點一次目前的基準會取消。沒設定基準時，差異欄顯示「—」、
    hover 提示與重點指標卡片也不會出現「vs 基準」。差異的紅綠依科目方向決定
    （`lineBetter_`：收入/毛利/淨利越高越好，成本/費用越低越好；售價結構沒有方向）；
    差異數字用 `signed_()` 顯示，四捨五入後會變成「+0」但其實不是 0 時(如千元單位下差幾百元)
    自動多留小數，不會讓使用者以為這個功能沒作用。
  - **金額單位**（元 / 千元）與**金額基礎**（單台 / 年度總額 = 單台 × 月銷量 × 12 / LC 總額 = 單台 × LC 總台數）
    一次套到表格、卡片、圖表與 CSV（`displayAmount_`）；百分比不受影響。台數資料由後端 `columnVolumeInfo_()` 隨欄位回傳，
    加權平均欄位的總台數是各車系加總，並附各車系構成比供標題 hover 顯示。
  - **標示最佳/最差**：每一列把數字最好的欄位標 ▲、最差的標 ▼（同分都標），方向同上。
  - **hover 提示**（`installTooltipEngine_`）：自己畫的 fixed 定位提示，不用原生 `title`
    （原生 title 在有橫向捲動與 sticky 釘住欄位的表格裡會被裁掉）。
    固定文字用 `data-tip`；表格格子/欄位標題/科目名稱/圖表長條用 `data-tipfn` 指定產生器，移過去才算內容：
    格子顯示欄位、科目、金額(單台與總額)、兩種百分比、與基準的差異、貨物稅的完整計算過程；
    欄位標題顯示情境性質、月銷量 × LC 年限 = 總台數、加權平均的組成；科目名稱顯示公式（代碼換成名稱，Σd 換成「Σ銷售費用」）與方向。
    表格格子的提示延遲 180ms 才出現（掃過表格時不會一路閃），捲動/點擊/重畫時一律收掉；
    量尺寸前先把提示挪回左上角，避免上一次停在靠右位置時被視窗邊緣壓扁而算錯位置。
    另有**十字游標**：滑鼠所在的列與欄一起變色（`installTableCrosshair_`）。
  - **小計自動驗算**：`subtotalChecks_()` 把 A=P8+P9、B=Σ成本明細、C=A-B、E=C-Σd、G=E-Σf、
    I=G-Σh、K=I-J 逐條重算（容差 0.5 元，吸收營業稅/佣金的四捨五入），對不起來的才回傳，
    前端在表格上方示警。加總錯誤不必靠肉眼發現。
  - 因為不同車型的科目不見得相同，只列出至少一個欄位真的算出數字的科目；
    某欄位沒有該科目時顯示「—」而非 0。另一方面，**沒填金額的成本科目仍會以 0 列出**
    （`calculatePL()` 先用 `manualLineCodesFor_(['B'])` 把 b 科目補齊），
    否則畫面上少了幾列，看到的明細加起來會對不上 B 銷貨成本合計，看起來就像加總算錯。
    自動計算科目（售價結構 P1~P9、貨物稅、季Margin、開發攤提）以圓點標示，hover 看來源。
  - 「匯出 CSV」把整張比較表（含 % 欄、目前的單位/基礎）複製貼進 Excel，可一鍵複製到剪貼簿。
  - **圖表全部是前端自己產生的 SVG**（`svgBarChart_`：浮動長條 y0→y1 的通用產生器，堆疊/瀑布都靠它），
    不再載入 Google Charts —— 外部載入在公司網路偶爾失敗、整個儀表板的初始化跟著掛掉，
    hover 的長相也跟表格不一致，而且沒辦法在 Node 裡驗證。四種圖：
    **科目比較**（橫軸 = 勾選的科目，同一組裡並排各欄位）、**依欄位**（倒過來）、
    **損益結構**（每欄一根堆疊長條：銷貨成本、各段費用、營業淨利；虛線是收入，淨利為負就落到 0 以下）、
    **損益瀑布**（每欄一張：收入 → −銷貨成本 → 生產毛利 → … → 營業淨利）。
    數值可切金額或百分比，數值標籤可開關；viewBox 讓圖跟著視窗寬度縮放。
    差異卡片底下的差異圖用同一個產生器，綠色 = 往好的方向、紅色 = 往壞的方向。
    要畫哪幾個科目用核取方塊勾選（`<select multiple>` 要按住 Ctrl 才選得動，等於選不動）。
  - 後端 API：`getComparisonOptions()` 取得車型→情境/車系選項樹；
    `calculateComparison([{ScenarioID, VehicleID}])` 回傳各欄位金額、兩種百分比基準、台數資訊、
    科目聯集（含 ParentLine 供縮排）與小計驗算結果。同一次執行內 `calculatePLCore_` 以（情境,車系）記住結果，
    同一情境的各車系 + 加權平均一起比較時每個車系只算一次。

---

## 6. 部署與權限

- 部署為 **Web App**：「執行身份：我」＋「存取權：僅限機構內的使用者」（依貴公司網域限制），避免資料外洩。
- 若需要多人同時編輯，Sheet 端另外用「保護範圍」鎖定計算欄位，避免有人手動改到 `PLResult`。
- 建議把 Sheet 拆成兩顆檔案：**輸入資料庫.gsheet**（VehicleTypes/Vehicles/Scenarios/SalesMix/CostOfSales/DevInvestment/OperatingExpense/Parameters）與 **計算結果.gsheet**（PLLineItems/PLResult/AuditLog），避免使用者誤改到公式相關分頁；Apps Script 用 `SpreadsheetApp.openById()` 分別存取。（也可以先合併在同一檔案，等資料量/人數變多再拆分）

---

## 7. 待確認事項

1. 使用者是否需要 Google 帳號登入權限控管？（決定部署存取權設定）
2. 是否需要「核准/鎖定」機制，避免情境定案後被誤改？（`Scenarios.Locked` 已預留欄位）
3. 開發總投的部門清單是否固定，或需要讓使用者自行新增部門？（現況：自由輸入，並提供已用過的部門建議）
4. ~~圖表程式庫的資安規範~~ —— 已改成前端自己產生 SVG，不載入任何外部程式庫。

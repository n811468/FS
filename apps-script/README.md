# 車型損益試算系統 — Apps Script 程式碼

個人使用版本（無登入權限控管、無情境鎖定、部門/科目可自由新增、圖表用 Google Charts）。
資料結構說明見 `../docs/data-schema.md`，架構說明見 `../docs/architecture.md`。

## 安裝步驟

1. 建立一個新的 Google Sheet（作為資料庫）。
2. 選單「擴充功能 → Apps Script」，開啟綁定的 Apps Script 專案。
3. 把本資料夾內所有檔案內容複製貼上到 Apps Script 編輯器（檔名需一致）：
   - `appsscript.json`（在編輯器左側「專案設定」勾選「顯示 appsscript.json」後才看得到）
   - `Code.gs` / `Constants.gs` / `Utils.gs` / `SetupSheets.gs` / `DataService.gs` / `CalcEngine.gs`
   - `index.html` / `style.html` / `script.html`
4. 在編輯器上方函式下拉選單選擇 `setupSpreadsheet`，按執行（首次執行會跳出授權視窗，同意即可）。
   執行後會在該 Google Sheet 自動建立所有分頁與標題列，並灌入固定的損益科目表。
5. 選單「部署 → 新增部署作業 → 網頁應用程式」：
   - 執行身份：我
   - 誰可以存取：僅限我自己
   - 部署後會得到一個網址，就是輸入/儀表板頁面。

## 使用順序

1. 「車型主檔」新增車型（如 3人貨車 / 9人客貨車(商用) / 9人客貨車(接駁)）。
2. 「情境設定」新增至少一個情境（如「2026目標」），上方情境選單即可選到。
3. 「銷售構成」輸入各車型的銷售構成比、預估月台數、LC年限、售價。
4. 「材料成本」「開發總投」「營業費用」「參數設定」依序輸入。
5. 切到「損益儀表板」按「重新計算」，即可看到各車型損益表與圖表。

## 已知簡化（相對於原始 Gate F Excel）

- 營業稅、銷售佣金、季Margin 用 `Parameters` 設定的比率計算，未逐車型個別調整佣金級距；
  如需要特定車型不同費率，在 `Parameters` 加一列同 `ParamName`、填上 `VehicleID` 覆寫全域值即可。
- f3（車型專案開發費用-CMC）、f4（車型專案開發費用-BASE廠）由 `DevInvestment` 總投金額
  ÷ 情境總銷售台數自動攤提，未做 TNCAP 對應/不對應兩組獨立試算（該邏輯可在
  `CalcEngine.gs` 的 `amortizeDevInvestmentPerUnit_()` 擴充）。
- 沒有實作情境鎖定/核准流程、沒有登入權限分級（依你先前確認為個人使用，皆非必要）。

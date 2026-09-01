/**
 * Web App 入口。個人使用版本：不做登入權限判斷，直接回傳單頁應用(index.html)。
 * 部署設定見 appsscript.json（webapp.access = MYSELF）。
 */
function doGet() {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('車型損益試算系統')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/** 開啟 Google Sheet 時掛上自訂選單，初始化與範例資料匯入都可以從這裡一鍵執行 */
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('車型損益試算')
    .addItem('初始化資料庫(建立分頁)', 'setupSpreadsheet')
    .addItem('匯入 Gate F 範例資料', 'importGateFSample')
    .addToUi();
}

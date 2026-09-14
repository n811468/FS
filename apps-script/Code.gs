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

/**
 * index.html 的 `<?!= include('style') ?>` / `<?!= include('script') ?>` 用的樣板輔助函式。
 *
 * 刻意跟 doGet() 放在同一個檔案：它只服務這個進入點，而且是整個網頁應用的必要條件。
 * 之前放在 Utils.gs 的最後一行，只要那個檔案沒貼進 Apps Script 專案、或貼到一半被截斷，
 * 開啟網址就會得到「ReferenceError: include is not defined (第 5 行)」——
 * 錯誤訊息指向 index.html，完全看不出真正缺的是另一個檔案的結尾。
 */
function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

/**
 * 開啟 Google Sheet 時掛上自訂選單，初始化資料庫可以從這裡一鍵執行。
 *
 * 只有「由試算表開啟」這個情境才有 UI 可以掛選單。onOpen 是本檔第一個函式，
 * Apps Script 編輯器的函式下拉選單預設就停在它上面，很容易被誤按執行 ——
 * 那個情境沒有 UI，丟出「Cannot call SpreadsheetApp.getUi() from this context」
 * 只會讓人以為程式壞了。選單本來就不是那個情境需要的東西，記一筆執行紀錄就好。
 * 要在編輯器裡做初始化，請改選 setupSpreadsheet 執行。
 */
function onOpen() {
  try {
    SpreadsheetApp.getUi()
      .createMenu('車型損益試算')
      .addItem('初始化資料庫(建立分頁)', 'setupSpreadsheet')
      .addSeparator()
      .addItem('重設內建科目名稱與排序', 'resetPLLineItemDefaults')
      .addItem('清除未使用的參數', 'removeUnusedParameters')
      .addToUi();
  } catch (e) {
    Logger.log('這個情境沒有試算表 UI，略過建立自訂選單。' +
      '要執行初始化請直接執行 setupSpreadsheet()。(' + e.message + ')');
  }
}

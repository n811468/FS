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
  try {
    return HtmlService.createHtmlOutputFromFile(filename).getContent();
  } catch (e) {
    // Apps Script 對「找不到這個 HTML 檔」丟的是 'Exception: Bad value'，
    // 訊息裡不會提到是哪一個檔案，堆疊只指到 include() 這一行 —— 等於什麼線索都沒有。
    // 這裡換成講得出檔名的訊息，並提示用 checkInstall() 一次看完缺了什麼。
    throw new Error('讀不到 HTML 檔「' + filename + '」。請確認 Apps Script 專案裡有一個名為 '
      + filename + ' 的 HTML 檔(編輯器裡不顯示 .html 副檔名)，內容為 apps-script/' + filename
      + '.html 的完整內容。執行 checkInstall() 可以一次列出所有缺少的檔案。原始錯誤：' + e.message);
  }
}

/**
 * 安裝自我檢查：一次列出每個必要檔案是不是真的在這個 Apps Script 專案裡。
 *
 * 這套系統是靠「把檔案內容一個一個貼進編輯器」安裝的，漏貼一個檔、或貼到一半被截斷，
 * 得到的錯誤訊息往往指向完全無關的地方(例如 include() 的 'Bad value'、
 * 或某個函式 is not defined)。與其一個一個試，不如直接問專案本身。
 *
 * 在編輯器的函式下拉選單選 checkInstall 執行，然後看「執行紀錄」。
 */
function checkInstall() {
  var gsFiles = [
    ['Code.gs', 'doGet'],
    ['Constants.gs', 'SHEETS'],
    ['Utils.gs', 'sheetToObjects_'],
    ['SetupSheets.gs', 'setupSpreadsheet'],
    ['DataService.gs', 'getSalesMix'],
    ['CalcEngine.gs', 'calculatePL']
  ];
  var htmlFiles = ['index', 'style', 'script'];
  var missing = [];
  var lines = ['=== 安裝檢查 ==='];

  gsFiles.forEach(function (pair) {
    var ok;
    try { ok = eval('typeof ' + pair[1]) !== 'undefined'; } catch (e) { ok = false; }
    lines.push((ok ? '[OK] ' : '[缺] ') + pair[0] + '（檢查 ' + pair[1] + '）');
    if (!ok) missing.push(pair[0]);
  });

  htmlFiles.forEach(function (name) {
    var ok = true, size = 0;
    try { size = HtmlService.createHtmlOutputFromFile(name).getContent().length; } catch (e) { ok = false; }
    lines.push((ok ? '[OK] ' : '[缺] ') + name + '.html'
      + (ok ? '（' + size + ' 字元）' : '（讀不到，請確認專案裡有這個 HTML 檔）'));
    if (!ok) missing.push(name + '.html');
  });

  // 分頁只有在綁定試算表時才檢查得到；從編輯器直接執行也是綁定的，所以正常都查得到
  try {
    var ss = SpreadsheetApp.getActiveSpreadsheet();
    if (ss) {
      var sheetMissing = Object.keys(SCHEMA).filter(function (n) { return !ss.getSheetByName(n); });
      lines.push(sheetMissing.length
        ? '[缺] 分頁：' + sheetMissing.join('、') + ' —— 執行 setupSpreadsheet() 建立'
        : '[OK] 所有分頁都在');
      if (sheetMissing.length) missing.push('分頁 ' + sheetMissing.join('、'));
    }
  } catch (e) {
    lines.push('[略] 這個情境讀不到試算表，略過分頁檢查');
  }

  lines.push(missing.length ? '→ 缺少：' + missing.join('、') : '→ 全部齊全');
  var report = lines.join('\n');
  Logger.log(report);
  return report;
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
      .addSeparator()
      .addItem('安裝檢查(列出缺少的檔案/分頁)', 'checkInstall')
      .addToUi();
  } catch (e) {
    Logger.log('這個情境沒有試算表 UI，略過建立自訂選單。' +
      '要執行初始化請直接執行 setupSpreadsheet()。(' + e.message + ')');
  }
}

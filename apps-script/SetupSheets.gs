/**
 * 第一次使用時，在 Apps Script 編輯器手動執行一次 setupSpreadsheet()，
 * 會自動建立所有分頁、寫入標題列，並灌入固定的損益科目表(PLLineItems)。
 * 重複執行是安全的（已存在的分頁/資料不會被清空）。
 */
function setupSpreadsheet() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();

  Object.keys(SCHEMA).forEach(function (sheetName) {
    var sheet = ss.getSheetByName(sheetName);
    if (!sheet) {
      sheet = ss.insertSheet(sheetName);
    }
    var headers = SCHEMA[sheetName];
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    sheet.setFrozenRows(1);
  });

  // AuditLog 為選配表，獨立處理（欄位固定，不放進主要 SCHEMA 迴圈）
  var auditSheet = ss.getSheetByName('AuditLog');
  if (!auditSheet) {
    auditSheet = ss.insertSheet('AuditLog');
    auditSheet.getRange(1, 1, 1, 6).setValues([['Timestamp', 'User', 'SheetName', 'RowID', 'Action', 'Payload']]);
    auditSheet.setFrozenRows(1);
  }

  seedPLLineItems_();

  // 移除當初建立 Sheet 時自動附帶的空白預設分頁。
  // 不同語系的 Google Sheet 預設分頁名稱不同(英文 Sheet1、中文 工作表1...)，
  // 所以不比對名稱，只要是「完全空白(0列0欄)」且不在我們預期的分頁清單裡，就視為可清除的預設分頁。
  var expectedNames = Object.keys(SCHEMA).concat(['AuditLog']);
  ss.getSheets().forEach(function (sheet) {
    var name = sheet.getName();
    if (expectedNames.indexOf(name) === -1 && sheet.getLastRow() === 0 && sheet.getLastColumn() === 0) {
      ss.deleteSheet(sheet);
    }
  });

  var summary = '資料庫初始化完成，共建立 ' + ss.getSheets().length + ' 個分頁。';
  try {
    SpreadsheetApp.getUi().alert(summary);
  } catch (e) {
    // 從 Apps Script 編輯器直接執行(而非透過 Sheets 選單)時 getUi() 可能無法使用，
    // 這不影響初始化本身是否成功，改用記錄檔輸出即可。
    Logger.log(summary);
  }
}

function seedPLLineItems_() {
  var sheet = getSheet_(SHEETS.PL_LINE_ITEMS);
  var existing = sheetToObjects_(SHEETS.PL_LINE_ITEMS).map(function (r) { return r.LineCode; });
  PL_LINE_ITEMS.forEach(function (line) {
    if (existing.indexOf(line.LineCode) === -1) {
      sheet.appendRow(SCHEMA.PLLineItems.map(function (h) { return line[h]; }));
    }
  });
}

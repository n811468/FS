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

  // 移除預設的 Sheet1（如果還存在且是空的）
  var defaultSheet = ss.getSheetByName('Sheet1');
  if (defaultSheet && defaultSheet.getLastRow() === 0) {
    ss.deleteSheet(defaultSheet);
  }

  SpreadsheetApp.getUi().alert('資料庫初始化完成，共建立 ' + ss.getSheets().length + ' 個分頁。');
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

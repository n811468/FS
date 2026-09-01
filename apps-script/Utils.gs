/** 共用工具函式 */

function getSheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('找不到分頁：' + name + '，請先執行 setupSpreadsheet()');
  return sheet;
}

function generateId_(prefix) {
  return prefix + '-' + Utilities.getUuid().slice(0, 8);
}

/**
 * google.script.run 序列化巢狀 Date 物件時不穩定（陣列包物件、物件裡又包 Date，
 * 有機會整包回傳值直接變成 null，且不會丟出任何錯誤）。
 * Sheet 的日期欄位讀出來就是 JS Date，所以一律在這裡轉成 yyyy-MM-dd 字串再往外傳。
 */
function normalizeCellValue_(v) {
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return Utilities.formatDate(v, Session.getScriptTimeZone() || 'Asia/Taipei', 'yyyy-MM-dd');
  }
  return v;
}

/** 把整張表讀成 [{欄位:值,...}, ...]，第一列為標題 */
function sheetToObjects_(sheetName) {
  var sheet = getSheet_(sheetName);
  var lastRow = sheet.getLastRow();
  var lastCol = sheet.getLastColumn();
  if (lastRow < 2) return [];
  var headers = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var values = sheet.getRange(2, 1, lastRow - 1, lastCol).getValues();
  return values
    .filter(function (row) { return row.some(function (v) { return v !== '' && v !== null; }); })
    .map(function (row) {
      var obj = {};
      headers.forEach(function (h, i) { obj[h] = normalizeCellValue_(row[i]); });
      return obj;
    });
}

/** 依 PK 欄位(通常是第一欄) upsert 一列；找不到就新增 */
function upsertRow_(sheetName, pkField, rowObj) {
  var sheet = getSheet_(sheetName);
  var headers = SCHEMA[sheetName];
  var pkCol = headers.indexOf(pkField) + 1;

  if (!rowObj[pkField]) {
    rowObj[pkField] = generateId_(rowIdPrefix_(sheetName));
  }

  var lastRow = sheet.getLastRow();
  var targetRow = -1;
  if (lastRow >= 2) {
    var pkValues = sheet.getRange(2, pkCol, lastRow - 1, 1).getValues();
    for (var i = 0; i < pkValues.length; i++) {
      if (pkValues[i][0] === rowObj[pkField]) {
        targetRow = i + 2;
        break;
      }
    }
  }

  var rowArray = headers.map(function (h) { return rowObj[h] !== undefined ? rowObj[h] : ''; });

  if (targetRow === -1) {
    sheet.appendRow(rowArray);
  } else {
    sheet.getRange(targetRow, 1, 1, rowArray.length).setValues([rowArray]);
  }
  logAudit_(sheetName, rowObj[pkField], targetRow === -1 ? 'INSERT' : 'UPDATE', rowObj);
  return rowObj;
}

function deleteRow_(sheetName, pkField, pkValue) {
  var sheet = getSheet_(sheetName);
  var headers = SCHEMA[sheetName];
  var pkCol = headers.indexOf(pkField) + 1;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  var pkValues = sheet.getRange(2, pkCol, lastRow - 1, 1).getValues();
  for (var i = 0; i < pkValues.length; i++) {
    if (pkValues[i][0] === pkValue) {
      sheet.deleteRow(i + 2);
      logAudit_(sheetName, pkValue, 'DELETE', {});
      return true;
    }
  }
  return false;
}

function rowIdPrefix_(sheetName) {
  var map = {
    SalesMix: 'SM', CostOfSales: 'CS', DevInvestment: 'DI',
    OperatingExpense: 'OE', Parameters: 'PM', PLResult: 'PR',
    VehicleTypes: 'VT', Vehicles: 'VH', Scenarios: 'SC'
  };
  return map[sheetName] || 'RW';
}

function logAudit_(sheetName, rowId, action, payload) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName('AuditLog');
  if (!sheet) return; // AuditLog 為選配表，不存在就略過
  sheet.appendRow([new Date(), Session.getActiveUser().getEmail(), sheetName, rowId, action, JSON.stringify(payload)]);
}

function toNumber_(v) {
  var n = Number(v);
  return isNaN(n) ? 0 : n;
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

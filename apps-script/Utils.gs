/** 共用工具函式 */

function getSheet_(name) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('找不到分頁：' + name + '，請先執行 setupSpreadsheet()');
  return sheet;
}

// 同一次執行內的流水號：整批寫入(如一次存下整張表格)會連續產生很多 ID，
// 只取 UUID 前 8 碼有機會撞號，撞號的後果是後一列直接覆蓋前一列、而且不會報錯。
var ID_SEQ_ = 0;

function generateId_(prefix) {
  return prefix + '-' + Utilities.getUuid().slice(0, 8) + '-' + (++ID_SEQ_);
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

/**
 * 單次執行內的分頁讀取快取。
 * 一次損益計算會重複讀同一張表很多次（光是科目表 PLLineItems，每算一個車系就會被讀 5 次以上），
 * 每次都是一趟 Sheet API 呼叫，是頁面變慢的主因。這裡在同一次執行中把結果記起來，
 * 任何寫入都會整個清掉，所以不會讀到過期資料。
 * 注意：繞過 upsertRow_/deleteRow_ 直接寫 Sheet 的地方(SetupSheets、writePLResult_)
 * 必須自己呼叫 invalidateSheetCache_()。
 */
var SHEET_CACHE_ = {};

function invalidateSheetCache_(sheetName) {
  if (sheetName) delete SHEET_CACHE_[sheetName];
  else SHEET_CACHE_ = {};
}

/** 把整張表讀成 [{欄位:值,...}, ...]，第一列為標題 */
function sheetToObjects_(sheetName) {
  if (SHEET_CACHE_[sheetName]) return SHEET_CACHE_[sheetName];
  var rows = readSheetObjects_(sheetName);
  SHEET_CACHE_[sheetName] = rows;
  return rows;
}

function readSheetObjects_(sheetName) {
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

/**
 * 主鍵比對：Sheet 讀回來的值可能是 Number(例如純數字的代號)，
 * 而前端傳來的一律是 String，直接用 === 會永遠不相等 → 變成重複新增、刪不掉。
 */
function samePk_(a, b) {
  if (a === null || a === undefined || a === '') return false;
  return String(a) === String(b);
}

/**
 * 只更新有帶到的欄位，其餘沿用既有值。
 * 表單只送出畫面上有的欄位，若直接 upsert，沒出現在表單上的欄位(如情境的攤提基準台數、
 * 科目的自動計算標記)會被寫成空字串，等於靜靜地把設定清掉。
 */
function upsertRowMerge_(sheetName, pkField, rowObj) {
  var existing = sheetToObjects_(sheetName).filter(function (r) {
    return samePk_(r[pkField], rowObj[pkField]);
  })[0];
  if (existing) {
    SCHEMA[sheetName].forEach(function (h) {
      if (rowObj[h] === undefined) rowObj[h] = existing[h];
    });
  }
  return upsertRow_(sheetName, pkField, rowObj);
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
      if (samePk_(pkValues[i][0], rowObj[pkField])) {
        targetRow = i + 2;
        break;
      }
    }
  }

  var rowArray = headers.map(function (h) { return rowObj[h] !== undefined ? rowObj[h] : ''; });
  var writeRow = targetRow === -1 ? lastRow + 1 : targetRow;
  var range = sheet.getRange(writeRow, 1, 1, rowArray.length);
  applyTextColumnFormats_(range, headers, sheetName);
  range.setValues([rowArray]);
  invalidateSheetCache_(sheetName);
  logAudit_(sheetName, rowObj[pkField], targetRow === -1 ? 'INSERT' : 'UPDATE', rowObj);
  return rowObj;
}

/**
 * 在寫入前把純文字欄位(TEXT_COLUMNS)的儲存格格式設成純文字('@')，
 * 避免 Sheet 把「0901」這種看起來像數字的字串自動轉成 901。
 * 用 getNumberFormats() 先讀出目前格式，只覆蓋純文字欄位那幾格，其餘欄位(金額/比率)維持原狀，
 * 且只在格式真的需要改變時才寫入，避免每次存檔都多一次 API 呼叫。
 */
function applyTextColumnFormats_(range, headers, sheetName) {
  var textCols = TEXT_COLUMNS[sheetName];
  if (!textCols || !textCols.length) return;
  var current = range.getNumberFormats()[0];
  var changed = false;
  var next = headers.map(function (h, i) {
    if (textCols.indexOf(h) !== -1 && current[i] !== '@') { changed = true; return '@'; }
    return current[i];
  });
  if (changed) range.setNumberFormats([next]);
}

function deleteRow_(sheetName, pkField, pkValue) {
  var sheet = getSheet_(sheetName);
  var headers = SCHEMA[sheetName];
  var pkCol = headers.indexOf(pkField) + 1;
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return false;
  var pkValues = sheet.getRange(2, pkCol, lastRow - 1, 1).getValues();
  for (var i = 0; i < pkValues.length; i++) {
    if (samePk_(pkValues[i][0], pkValue)) {
      sheet.deleteRow(i + 2);
      invalidateSheetCache_(sheetName);
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

/** 依某個排序欄位排序，留白視為排在最後面；相對順序穩定，不會因為排序值相同就跳來跳去 */
function sortByOrder_(rows, field) {
  var withIndex = rows.map(function (r, i) { return { row: r, i: i }; });
  withIndex.sort(function (a, b) {
    var av = a.row[field] === '' || a.row[field] === undefined || a.row[field] === null ? Infinity : toNumber_(a.row[field]);
    var bv = b.row[field] === '' || b.row[field] === undefined || b.row[field] === null ? Infinity : toNumber_(b.row[field]);
    return av !== bv ? av - bv : a.i - b.i;
  });
  return withIndex.map(function (x) { return x.row; });
}

function include(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

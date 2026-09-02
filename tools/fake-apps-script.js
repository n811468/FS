/**
 * 讓 apps-script/*.gs 可以在 Node 上跑起來的最小 Google Apps Script 模擬層。
 * 只實作專案實際用到的 API：記憶體版的試算表、LockService、Utilities、Session、Logger。
 *
 * 目的是讓驗算腳本走完整條真實路徑（setupSpreadsheet → 各 save 函式 → CalcEngine），
 * 而不是另外抄一份公式來對答案 —— 抄一份的話，抄錯或程式改了沒同步都驗不出來。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Sheets 的「自動偵測格式」：純數字字串(含前導零)在一般格式('general')的儲存格裡
// 會被自動轉成 Number，前導零因此消失；格式設成 '@'(純文字)就不會被轉換。
// 這裡只模擬這一種會咬掉前導零的情況，其餘型別維持字串/數字原樣，足以驗證 applyTextColumnFormats_ 有沒有生效。
function autoDetectCellValue_(v, format) {
  if (format === '@') return v;
  if (typeof v === 'string' && /^0\d+$/.test(v)) return Number(v);
  return v;
}

class FakeSheet {
  constructor(name) { this.name = name; this.grid = []; this.formats = []; }
  getName() { return this.name; }
  setFrozenRows() { }

  _ensure(rows, cols) {
    while (this.grid.length < rows) this.grid.push([]);
    while (this.formats.length < rows) this.formats.push([]);
    this.grid.forEach(row => { while (row.length < cols) row.push(''); });
    this.formats.forEach(row => { while (row.length < cols) row.push('general'); });
  }
  _filled(v) { return v !== '' && v !== null && v !== undefined; }

  getLastRow() {
    let last = 0;
    this.grid.forEach((row, i) => { if (row.some(v => this._filled(v))) last = i + 1; });
    return last;
  }
  getLastColumn() {
    let last = 0;
    this.grid.forEach(row => row.forEach((v, j) => { if (this._filled(v)) last = Math.max(last, j + 1); }));
    return last;
  }
  appendRow(values) {
    const r = this.getLastRow();
    this._ensure(r + 1, values.length);
    values.forEach((v, j) => { this.grid[r][j] = v; });
  }
  deleteRow(rowIndex) { this.grid.splice(rowIndex - 1, 1); }

  getRange(row, col, numRows, numCols) {
    const sheet = this;
    const nr = numRows || 1;
    const nc = numCols || 1;
    sheet._ensure(row + nr - 1, col + nc - 1);
    return {
      getValues() {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const line = [];
          for (let j = 0; j < nc; j++) line.push(sheet.grid[row - 1 + i][col - 1 + j]);
          out.push(line);
        }
        return out;
      },
      setValues(values) {
        sheet._ensure(row + nr - 1, col + nc - 1);
        for (let i = 0; i < nr; i++) {
          for (let j = 0; j < nc; j++) {
            const fmt = sheet.formats[row - 1 + i][col - 1 + j];
            sheet.grid[row - 1 + i][col - 1 + j] = autoDetectCellValue_(values[i][j], fmt);
          }
        }
      },
      clearContent() {
        for (let i = 0; i < nr; i++) {
          for (let j = 0; j < nc; j++) sheet.grid[row - 1 + i][col - 1 + j] = '';
        }
      },
      getValue() { return sheet.grid[row - 1][col - 1]; },
      setValue(v) { sheet._ensure(row, col); sheet.grid[row - 1][col - 1] = v; },
      getNumberFormats() {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const line = [];
          for (let j = 0; j < nc; j++) line.push(sheet.formats[row - 1 + i][col - 1 + j]);
          out.push(line);
        }
        return out;
      },
      setNumberFormats(formats) {
        sheet._ensure(row + nr - 1, col + nc - 1);
        for (let i = 0; i < nr; i++) {
          for (let j = 0; j < nc; j++) sheet.formats[row - 1 + i][col - 1 + j] = formats[i][j];
        }
      }
    };
  }
}

class FakeSpreadsheet {
  constructor() { this.sheets = []; }
  getSheetByName(name) { return this.sheets.filter(s => s.getName() === name)[0] || null; }
  insertSheet(name) { const s = new FakeSheet(name); this.sheets.push(s); return s; }
  getSheets() { return this.sheets.slice(); }
  deleteSheet(sheet) { this.sheets = this.sheets.filter(s => s !== sheet); }
}

/** 載入 apps-script 的 .gs 檔並回傳可以直接呼叫其中函式的 context */
function loadAppsScript(files) {
  const spreadsheet = new FakeSpreadsheet();
  let uuidSeq = 0;

  const context = {
    console: console,
    SpreadsheetApp: {
      getActiveSpreadsheet: () => spreadsheet,
      // 從編輯器(而非 Sheets 選單)執行時 getUi() 本來就不能用，程式已有 try/catch
      getUi: () => { throw new Error('no UI in this context'); }
    },
    LockService: { getScriptLock: () => ({ waitLock() { }, releaseLock() { } }) },
    Utilities: {
      getUuid: () => 'uuid' + String(++uuidSeq).padStart(8, '0'),
      formatDate: (d) => d.toISOString().slice(0, 10)
    },
    Session: {
      getScriptTimeZone: () => 'Asia/Taipei',
      getActiveUser: () => ({ getEmail: () => 'verify@local' })
    },
    Logger: { log: () => { } },
    HtmlService: null
  };
  vm.createContext(context);

  files.forEach(file => {
    const code = fs.readFileSync(path.join(__dirname, '..', 'apps-script', file), 'utf8');
    vm.runInContext(code, context, { filename: file });
  });
  return context;
}

module.exports = { loadAppsScript };

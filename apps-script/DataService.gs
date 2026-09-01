/**
 * 資料存取層：每張表提供 get / save / delete。
 * 個人使用版本，仍用 LockService 避免同一個瀏覽器分頁快速連點造成資料錯亂。
 */

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

// ---- VehicleTypes（車型主檔，如 DA/DE/DH/DX，需先建立才能在底下新增車系） ----
function getVehicleTypes() {
  return sheetToObjects_(SHEETS.VEHICLE_TYPES) || [];
}
function saveVehicleType(rowObj) {
  return withLock_(function () { return upsertRow_(SHEETS.VEHICLE_TYPES, 'VehicleTypeID', rowObj); });
}
function deleteVehicleType(vehicleTypeId) {
  return withLock_(function () { return deleteRow_(SHEETS.VEHICLE_TYPES, 'VehicleTypeID', vehicleTypeId); });
}

// ---- Vehicles（車系，如 3人貨車/9人客貨車，隸屬某個 VehicleType） ----
function getVehicles(vehicleTypeId) {
  var rows = sheetToObjects_(SHEETS.VEHICLES) || [];
  return vehicleTypeId ? rows.filter(function (r) { return r.VehicleTypeID === vehicleTypeId; }) : rows;
}
function saveVehicle(rowObj) {
  return withLock_(function () { return upsertRow_(SHEETS.VEHICLES, 'VehicleID', rowObj); });
}
function deleteVehicle(vehicleId) {
  return withLock_(function () { return deleteRow_(SHEETS.VEHICLES, 'VehicleID', vehicleId); });
}

// ---- Scenarios（隸屬某個 VehicleType，同一車型可有多個情境版本並排比較） ----
function getScenarios(vehicleTypeId) {
  var rows = sheetToObjects_(SHEETS.SCENARIOS) || [];
  return vehicleTypeId ? rows.filter(function (r) { return r.VehicleTypeID === vehicleTypeId; }) : rows;
}
function saveScenario(rowObj) {
  return withLock_(function () { return upsertRow_(SHEETS.SCENARIOS, 'ScenarioID', rowObj); });
}
function deleteScenario(scenarioId) {
  return withLock_(function () { return deleteRow_(SHEETS.SCENARIOS, 'ScenarioID', scenarioId); });
}

// ---- SalesMix ----
function getSalesMix(scenarioId) {
  var rows = sheetToObjects_(SHEETS.SALES_MIX) || [];
  return scenarioId ? rows.filter(function (r) { return r.ScenarioID === scenarioId; }) : rows;
}
function saveSalesMixRow(rowObj) {
  return withLock_(function () { return upsertRow_(SHEETS.SALES_MIX, 'RowID', rowObj); });
}
function deleteSalesMixRow(rowId) {
  return withLock_(function () { return deleteRow_(SHEETS.SALES_MIX, 'RowID', rowId); });
}

/**
 * 銷售構成雙向輸入(台數/百分比)：
 *   - recalcSalesMixPctByVolume：以目前各車系已填的「預估銷售台數(月)」，
 *     依佔比反推並回寫 SalesMixPct。
 *   - recalcSalesMixVolumeByPct：以使用者輸入的「情境總銷售台數(月)」為基準，
 *     依各車系已填的 SalesMixPct 反推並回寫 MonthlyVolume。
 * 同一情境下的所有 SalesMix 列即為同一車型底下的各車系構成。
 */
function recalcSalesMixPctByVolume(scenarioId) {
  return withLock_(function () {
    var rows = getSalesMix(scenarioId);
    var total = rows.reduce(function (s, r) { return s + toNumber_(r.MonthlyVolume); }, 0);
    rows.forEach(function (r) {
      r.SalesMixPct = total > 0 ? toNumber_(r.MonthlyVolume) / total : 0;
      upsertRow_(SHEETS.SALES_MIX, 'RowID', r);
    });
    return getSalesMix(scenarioId);
  });
}
function recalcSalesMixVolumeByPct(scenarioId, totalMonthlyVolume) {
  return withLock_(function () {
    var rows = getSalesMix(scenarioId);
    var total = toNumber_(totalMonthlyVolume);
    rows.forEach(function (r) {
      r.MonthlyVolume = Math.round(toNumber_(r.SalesMixPct) * total);
      upsertRow_(SHEETS.SALES_MIX, 'RowID', r);
    });
    return getSalesMix(scenarioId);
  });
}

// ---- MaterialCost ----
function getMaterialCost(scenarioId, vehicleId) {
  var rows = sheetToObjects_(SHEETS.MATERIAL_COST) || [];
  return rows.filter(function (r) {
    return (!scenarioId || r.ScenarioID === scenarioId) && (!vehicleId || r.VehicleID === vehicleId);
  });
}
function saveMaterialCostRow(rowObj) {
  if (rowObj.CostCategory && MATERIAL_COST_LINE_MAP[rowObj.CostCategory]) {
    rowObj.LineCode = MATERIAL_COST_LINE_MAP[rowObj.CostCategory];
  }
  return withLock_(function () { return upsertRow_(SHEETS.MATERIAL_COST, 'RowID', rowObj); });
}
function deleteMaterialCostRow(rowId) {
  return withLock_(function () { return deleteRow_(SHEETS.MATERIAL_COST, 'RowID', rowId); });
}
function getMaterialCostCategories() {
  return Object.keys(MATERIAL_COST_LINE_MAP);
}

// ---- DevInvestment ----
function getDevInvestment(scenarioId) {
  var rows = sheetToObjects_(SHEETS.DEV_INVESTMENT) || [];
  return scenarioId ? rows.filter(function (r) { return r.ScenarioID === scenarioId; }) : rows;
}
function saveDevInvestmentRow(rowObj) {
  return withLock_(function () { return upsertRow_(SHEETS.DEV_INVESTMENT, 'RowID', rowObj); });
}
function deleteDevInvestmentRow(rowId) {
  return withLock_(function () { return deleteRow_(SHEETS.DEV_INVESTMENT, 'RowID', rowId); });
}
/** 部門清單允許自由新增：回傳目前已出現過的部門，前端用來做輸入建議(datalist)，非強制下拉 */
function getKnownDepartments() {
  var rows = sheetToObjects_(SHEETS.DEV_INVESTMENT) || [];
  var set = {};
  rows.forEach(function (r) { if (r.Department) set[r.Department] = true; });
  return Object.keys(set);
}

// ---- OperatingExpense ----
function getOperatingExpense(scenarioId, vehicleId) {
  var rows = sheetToObjects_(SHEETS.OPERATING_EXPENSE) || [];
  return rows.filter(function (r) {
    return (!scenarioId || r.ScenarioID === scenarioId) && (!vehicleId || r.VehicleID === vehicleId);
  });
}
function saveOperatingExpenseRow(rowObj) {
  return withLock_(function () { return upsertRow_(SHEETS.OPERATING_EXPENSE, 'RowID', rowObj); });
}
function deleteOperatingExpenseRow(rowId) {
  return withLock_(function () { return deleteRow_(SHEETS.OPERATING_EXPENSE, 'RowID', rowId); });
}

// ---- Parameters ----
function getParameters(scenarioId) {
  var rows = sheetToObjects_(SHEETS.PARAMETERS) || [];
  return scenarioId ? rows.filter(function (r) { return !r.ScenarioID || r.ScenarioID === scenarioId; }) : rows;
}
function saveParameterRow(rowObj) {
  return withLock_(function () { return upsertRow_(SHEETS.PARAMETERS, 'ParamID', rowObj); });
}
function deleteParameterRow(paramId) {
  return withLock_(function () { return deleteRow_(SHEETS.PARAMETERS, 'ParamID', paramId); });
}

// 「參數設定」頁面拆成兩組管理：稅務/費用比率 vs 匯率設定，各自獨立的分頁籤與表格，
// 底層仍寫入同一張 Parameters 分頁，只是依 ParamName 篩選讀取範圍。
function getTaxRateParameters(scenarioId) {
  return getParameters(scenarioId).filter(function (p) { return TAX_RATE_PARAM_NAMES.indexOf(p.ParamName) !== -1; });
}
function getFxParameters(scenarioId) {
  return getParameters(scenarioId).filter(function (p) { return FX_PARAM_NAMES.indexOf(p.ParamName) !== -1; });
}

/** 依 ParamName(+可選VehicleID) 查值，找不到就用 DEFAULT_PARAMS，最後 fallback 0 */
function lookupParam_(paramsForScenario, paramName, vehicleId) {
  var match = paramsForScenario.filter(function (p) {
    return p.ParamName === paramName && (!p.VehicleID || p.VehicleID === vehicleId);
  });
  // 有指定車型的參數優先於全域參數
  var specific = match.filter(function (p) { return p.VehicleID === vehicleId; });
  var picked = specific.length ? specific[0] : match[0];
  if (picked) return toNumber_(picked.Value);
  return DEFAULT_PARAMS[paramName] !== undefined ? DEFAULT_PARAMS[paramName] : 0;
}

// ---- PLLineItems (唯讀參照表) ----
function getPLLineItems() {
  return (sheetToObjects_(SHEETS.PL_LINE_ITEMS) || []).sort(function (a, b) { return a.SortOrder - b.SortOrder; });
}

/**
 * 系統診斷：回傳目前這個部署實際綁定的 Google Sheet 檔案，以及每個分頁的列數。
 * 前端「系統診斷」按鈕會呼叫這個函式，用來確認：
 *   1. 網頁應用程式是否真的連到你以為的那個 Google Sheet
 *   2. 每張表 Apps Script 實際讀到幾列資料（跟你人眼在 Sheet 上看到的是否一致）
 */
function runDiagnostics() {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  if (!ss) {
    return { ok: false, error: 'SpreadsheetApp.getActiveSpreadsheet() 回傳 null，代表這個部署沒有正確綁定到任何 Google Sheet。' };
  }
  var sheetsInfo = ss.getSheets().map(function (s) {
    return { name: s.getName(), lastRow: s.getLastRow(), lastCol: s.getLastColumn() };
  });
  var missing = Object.keys(SHEETS).map(function (k) { return SHEETS[k]; })
    .filter(function (name) { return sheetsInfo.every(function (s) { return s.name !== name; }); });

  // 直接用跟 getScenarios() 等函式相同的解析邏輯(sheetToObjects_)跑一次，
  // 拿掉業務邏輯後單純比對「原始列數」vs「實際解析出幾筆物件」，藏在哪一步漏資料一看就知道。
  var parseCheck = {};
  Object.keys(SCHEMA).forEach(function (sheetName) {
    try {
      var raw = sheetToObjects_(sheetName);
      parseCheck[sheetName] = { parsedCount: raw.length, sample: raw[0] || null };
    } catch (e) {
      parseCheck[sheetName] = { error: e.message };
    }
  });

  return {
    ok: true,
    spreadsheetId: ss.getId(),
    spreadsheetName: ss.getName(),
    spreadsheetUrl: ss.getUrl(),
    sheets: sheetsInfo,
    missingExpectedSheets: missing,
    parseCheck: parseCheck
  };
}

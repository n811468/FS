/**
 * 資料存取層：每張表提供 get / save / delete。
 * 個人使用版本，仍用 LockService 避免同一個瀏覽器分頁快速連點造成資料錯亂。
 */

// 可重入：有些整批作業(如刪科目連帶刪金額)會呼叫其他同樣上鎖的函式，
// 巢狀時只由最外層真正取得/釋放鎖，避免自己卡住自己。
var LOCK_DEPTH_ = 0;

function withLock_(fn) {
  var lock = LockService.getScriptLock();
  if (LOCK_DEPTH_ === 0) lock.waitLock(10000);
  LOCK_DEPTH_++;
  try {
    return fn();
  } finally {
    LOCK_DEPTH_--;
    if (LOCK_DEPTH_ === 0) lock.releaseLock();
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
  return withLock_(function () {
    // 情境代號改用 GATE 別，情境名稱自訂；同一個 GATE 下可以有多個情境(GATE F 現況 / GATE F 目標)，
    // 所以 ScenarioID 只是系統內部鍵值，由 upsertRow_ 自動產生，不需使用者自行編碼。
    if (!rowObj.Gate) throw new Error('請選擇 GATE 別');
    if (GATE_OPTIONS.indexOf(rowObj.Gate) === -1) throw new Error('GATE 別不正確：' + rowObj.Gate);
    return upsertRow_(SHEETS.SCENARIOS, 'ScenarioID', rowObj);
  });
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
 * 銷售構成表格：一定會依「車系設定」把該車型底下每個車系各列一列，
 * 已存在的 SalesMix 資料合併進去，沒有的就是空白列，使用者不需要自己一列一列新增。
 */
function getSalesMixGrid(scenarioId, vehicleTypeId) {
  var existing = getSalesMix(scenarioId);
  var rows = getVehicles(vehicleTypeId).map(function (v) {
    var row = existing.filter(function (r) { return r.VehicleID === v.VehicleID; })[0] || {};
    return {
      VehicleID: v.VehicleID,
      VehicleCode: v.VehicleCode || '',
      RowID: row.RowID || '',
      SalesMixPct: row.SalesMixPct === undefined || row.SalesMixPct === '' ? '' : toNumber_(row.SalesMixPct),
      MonthlyVolume: row.MonthlyVolume === undefined || row.MonthlyVolume === '' ? '' : toNumber_(row.MonthlyVolume),
      LifeCycleYears: row.LifeCycleYears === undefined || row.LifeCycleYears === '' ? '' : toNumber_(row.LifeCycleYears),
      ListPriceTaxIncl: row.ListPriceTaxIncl === undefined || row.ListPriceTaxIncl === '' ? '' : toNumber_(row.ListPriceTaxIncl),
      MandatoryAccessoryPrice: row.MandatoryAccessoryPrice === undefined || row.MandatoryAccessoryPrice === '' ? '' : toNumber_(row.MandatoryAccessoryPrice),
      ScrapFee: row.ScrapFee === undefined || row.ScrapFee === '' ? '' : toNumber_(row.ScrapFee),
      ScrapFeeTaxStatus: row.ScrapFeeTaxStatus || '含稅',
      HorizontalPartsPriceAdj: row.HorizontalPartsPriceAdj === undefined || row.HorizontalPartsPriceAdj === '' ? '' : toNumber_(row.HorizontalPartsPriceAdj),
      Notes: row.Notes || ''
    };
  });
  return { rows: rows, scrapFeeTaxStatusOptions: SCRAP_FEE_TAX_STATUS };
}

/** 銷售構成整批儲存（表格一次送出，不必逐列存檔） */
function saveSalesMixGrid(scenarioId, vehicleTypeId, rows) {
  return withLock_(function () {
    (rows || []).forEach(function (r) {
      r.ScenarioID = scenarioId;
      upsertRow_(SHEETS.SALES_MIX, 'RowID', r);
    });
    return getSalesMixGrid(scenarioId, vehicleTypeId);
  });
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
      // SalesMixPct 以百分比數值儲存(0~100)
      r.SalesMixPct = total > 0 ? toNumber_(r.MonthlyVolume) / total * 100 : 0;
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
      r.MonthlyVolume = Math.round(toNumber_(r.SalesMixPct) / 100 * total);
      upsertRow_(SHEETS.SALES_MIX, 'RowID', r);
    });
    return getSalesMix(scenarioId);
  });
}

// ---- CostOfSales 銷貨成本（原材料成本頁；LP/KD 皆為成本項目，成本科目可自由增刪） ----
function getCostOfSales(scenarioId, vehicleId) {
  var rows = sheetToObjects_(SHEETS.COST_OF_SALES) || [];
  return rows.filter(function (r) {
    return (!scenarioId || r.ScenarioID === scenarioId) && (!vehicleId || r.VehicleID === vehicleId);
  });
}
function saveCostOfSalesRow(rowObj) {
  return withLock_(function () { return upsertRow_(SHEETS.COST_OF_SALES, 'RowID', rowObj); });
}
function deleteCostOfSalesRow(rowId) {
  return withLock_(function () { return deleteRow_(SHEETS.COST_OF_SALES, 'RowID', rowId); });
}

/* ------------------------------------------------------------------
 * 金額矩陣（列 = 科目、欄 = 車系）：銷貨成本與營業費用共用同一套邏輯，
 * 使用者在一張表格內把所有車系的金額一次填完、一次送出。
 * ---------------------------------------------------------------- */
function buildAmountMatrix_(sheetName, scenarioId, vehicleTypeId, lineOptions) {
  var vehicles = getVehicles(vehicleTypeId).map(function (v) {
    return { VehicleID: v.VehicleID, VehicleCode: v.VehicleCode || '' };
  });
  var rows = (sheetToObjects_(sheetName) || []).filter(function (r) { return r.ScenarioID === scenarioId; });

  var values = {};   // values[LineCode][VehicleID] = { RowID, Amount, Currency, Notes }
  rows.forEach(function (r) {
    if (!r.LineCode) return;
    if (!values[r.LineCode]) values[r.LineCode] = {};
    values[r.LineCode][r.VehicleID] = {
      RowID: r.RowID,
      Amount: r.Amount === '' || r.Amount === undefined ? '' : toNumber_(r.Amount),
      Currency: r.Currency || BASE_CURRENCY,
      Notes: r.Notes || ''
    };
  });

  return { lines: lineOptions, vehicles: vehicles, values: values };
}

function saveAmountMatrix_(sheetName, scenarioId, cells) {
  return withLock_(function () {
    (cells || []).forEach(function (c) {
      var isEmpty = c.Amount === '' || c.Amount === null || c.Amount === undefined;
      if (isEmpty && !c.Notes) {
        // 清空的格子代表這個科目在這個車系沒有金額：有舊資料就刪掉，避免殘留
        if (c.RowID) deleteRow_(sheetName, 'RowID', c.RowID);
        return;
      }
      c.ScenarioID = scenarioId;
      upsertRow_(sheetName, 'RowID', c);
    });
    return true;
  });
}

/** 銷貨成本矩陣：列 = 成本項目、欄 = 車系 */
function getCostOfSalesMatrix(scenarioId, vehicleTypeId) {
  var matrix = buildAmountMatrix_(SHEETS.COST_OF_SALES, scenarioId, vehicleTypeId, getCostOfSalesLineOptions());
  matrix.currencies = getConfiguredCurrencies(scenarioId);
  return matrix;
}
function saveCostOfSalesMatrix(scenarioId, cells) {
  return saveAmountMatrix_(SHEETS.COST_OF_SALES, scenarioId, cells);
}

/** 營業費用矩陣：列 = 科目、欄 = 車系 */
function getOperatingExpenseMatrix(scenarioId, vehicleTypeId) {
  return buildAmountMatrix_(SHEETS.OPERATING_EXPENSE, scenarioId, vehicleTypeId, getOperatingExpenseLineOptions());
}
function saveOperatingExpenseMatrix(scenarioId, cells) {
  return saveAmountMatrix_(SHEETS.OPERATING_EXPENSE, scenarioId, cells);
}

/**
 * 在銷貨成本／營業費用頁面直接新增科目（不必跑去「科目設定」頁）。
 * parentLine 決定這個科目屬於哪一段損益：B = 銷貨成本、E/G/I = 各段費用。
 * LineCode 自動產生（父科目字首 + 流水號），使用者只需要填科目名稱。
 */
function addLineItemInline(parentLine, lineName) {
  return withLock_(function () {
    if (!lineName) throw new Error('請輸入科目名稱');
    var prefixMap = { B: 'b', E: 'd', G: 'f', I: 'h' };
    var prefix = prefixMap[parentLine];
    if (!prefix) throw new Error('父科目不正確：' + parentLine);

    var existing = getPLLineItems();
    var used = {};
    var maxSort = 0;
    existing.forEach(function (d) {
      used[d.LineCode] = true;
      if (d.ParentLine === parentLine) maxSort = Math.max(maxSort, toNumber_(d.SortOrder));
    });
    var n = 1;
    while (used[prefix + n]) n++;

    var row = {
      LineCode: prefix + n,
      LineName: lineName,
      ParentLine: parentLine,
      Category: parentLine === 'B' ? '成本明細' : '費用明細',
      SortOrder: (maxSort || 20) + 0.5,   // 排在同一段的最後面，之後可在科目設定頁微調
      AutoSource: ''
    };
    return upsertRow_(SHEETS.PL_LINE_ITEMS, 'LineCode', row);
  });
}

/** 在銷貨成本／營業費用頁面直接刪除科目，連同該科目已輸入的金額一併清掉 */
function deleteLineItemInline(lineCode) {
  return withLock_(function () {
    [SHEETS.COST_OF_SALES, SHEETS.OPERATING_EXPENSE].forEach(function (sheetName) {
      (sheetToObjects_(sheetName) || []).forEach(function (r) {
        if (r.LineCode === lineCode) deleteRow_(sheetName, 'RowID', r.RowID);
      });
    });
    return deletePLLineItem(lineCode);
  });
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
/** 開發總投整批儲存（表格一次送出）；空白列(沒部門也沒金額)會被刪除 */
function saveDevInvestmentGrid(scenarioId, rows) {
  return withLock_(function () {
    (rows || []).forEach(function (r) {
      var isEmpty = !r.Department && (r.Amount === '' || r.Amount === null || r.Amount === undefined);
      if (isEmpty) {
        if (r.RowID) deleteRow_(SHEETS.DEV_INVESTMENT, 'RowID', r.RowID);
        return;
      }
      r.ScenarioID = scenarioId;
      upsertRow_(SHEETS.DEV_INVESTMENT, 'RowID', r);
    });
    return getDevInvestmentSummary(scenarioId);
  });
}

/**
 * 目標情境用：從另一個情境把資料整批帶入後再調整低減目標。
 * 只覆蓋所選的資料類別，帶入前會先清掉目標情境同類別的既有資料。
 * 帶入的開發總投列，其挑戰低減目標一律歸零，由使用者自己填新的目標值。
 */
function copyScenarioData(sourceScenarioId, targetScenarioId, parts) {
  return withLock_(function () {
    if (!sourceScenarioId || !targetScenarioId) throw new Error('請選擇來源情境與目標情境');
    if (sourceScenarioId === targetScenarioId) throw new Error('來源情境與目標情境不能相同');
    parts = parts && parts.length ? parts : ['salesmix', 'costofsales', 'devinvestment', 'operatingexpense', 'parameters'];

    var map = {
      salesmix: SHEETS.SALES_MIX,
      costofsales: SHEETS.COST_OF_SALES,
      devinvestment: SHEETS.DEV_INVESTMENT,
      operatingexpense: SHEETS.OPERATING_EXPENSE,
      parameters: SHEETS.PARAMETERS
    };
    var pkOf = function (sheetName) { return sheetName === SHEETS.PARAMETERS ? 'ParamID' : 'RowID'; };
    var copied = {};

    parts.forEach(function (part) {
      var sheetName = map[part];
      if (!sheetName) return;
      var pk = pkOf(sheetName);
      var all = sheetToObjects_(sheetName) || [];

      all.filter(function (r) { return r.ScenarioID === targetScenarioId; })
        .forEach(function (r) { deleteRow_(sheetName, pk, r[pk]); });

      var sourceRows = all.filter(function (r) { return r.ScenarioID === sourceScenarioId; });
      sourceRows.forEach(function (r) {
        var copy = {};
        SCHEMA[sheetName].forEach(function (h) { copy[h] = r[h]; });
        copy[pk] = '';                       // 產生新的鍵值，不要蓋到來源列
        copy.ScenarioID = targetScenarioId;
        // 低減目標屬於目標情境自己的假設，帶入後歸零讓使用者重新填
        if (sheetName === SHEETS.DEV_INVESTMENT) copy.ChallengeReductionPct = '';
        upsertRow_(sheetName, pk, copy);
      });
      copied[part] = sourceRows.length;
    });

    return copied;
  });
}

/**
 * 開發總投的攤提基準台數（存在情境上）。
 * 實務上開發投資的攤提基準台數常與銷售構成的預估台數不同
 * （例如銷售估 365 台/月，但開發投資以 300 台/月 × 12 年攤提），所以獨立設定；
 * 留空就自動改用銷售構成推算的 LIFE CYCLE 總台數。
 */
function saveAmortBasis(scenarioId, monthlyVolume, lifeCycleYears) {
  return withLock_(function () {
    var scenario = getScenarios().filter(function (s) { return s.ScenarioID === scenarioId; })[0];
    if (!scenario) throw new Error('找不到情境：' + scenarioId);
    scenario.AmortMonthlyVolume = monthlyVolume === '' || monthlyVolume === null ? '' : toNumber_(monthlyVolume);
    scenario.AmortLifeCycleYears = lifeCycleYears === '' || lifeCycleYears === null ? '' : toNumber_(lifeCycleYears);
    upsertRow_(SHEETS.SCENARIOS, 'ScenarioID', scenario);
    return getDevInvestmentSummary(scenarioId);
  });
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

/**
 * 稅務/費用比率表格：同一車型各車系的費率大多相同，所以預設只填「全車系適用」那一列，
 * 各車系留白就自動沿用全車系值；只有真的不同的車系才需要填覆寫值。
 * 沒設定過的比率會帶入系統預設值(DEFAULT_PARAMS)，直接按儲存即可。
 */
function getRateGrid(scenarioId, vehicleTypeId) {
  var params = getTaxRateParameters(scenarioId).filter(function (p) { return p.ScenarioID === scenarioId; });
  var vehicles = getVehicles(vehicleTypeId).map(function (v) {
    return { VehicleID: v.VehicleID, VehicleCode: v.VehicleCode || '' };
  });

  var find = function (name, vehicleId) {
    return params.filter(function (p) {
      return p.ParamName === name && (p.VehicleID || '') === (vehicleId || '');
    })[0];
  };

  var rates = TAX_RATE_PARAM_NAMES.map(function (name) {
    var global = find(name, '');
    var overrides = {};
    vehicles.forEach(function (v) {
      var row = find(name, v.VehicleID);
      overrides[v.VehicleID] = row ? { ParamID: row.ParamID, Value: toNumber_(row.Value) } : { ParamID: '', Value: '' };
    });
    return {
      ParamName: name,
      globalParamID: global ? global.ParamID : '',
      // 沒設定過就帶系統預設值，使用者確認後按儲存即可，不必每次自己查稅率
      globalValue: global ? toNumber_(global.Value) : (DEFAULT_PARAMS[name] !== undefined ? DEFAULT_PARAMS[name] : ''),
      isDefault: !global,
      overrides: overrides
    };
  });

  return { vehicles: vehicles, rates: rates };
}

/** 稅務/費用比率整批儲存：留白的車系覆寫值代表沿用全車系值，會刪掉舊的覆寫列 */
function saveRateGrid(scenarioId, rows) {
  return withLock_(function () {
    (rows || []).forEach(function (r) {
      var isEmpty = r.Value === '' || r.Value === null || r.Value === undefined;
      if (isEmpty) {
        if (r.ParamID) deleteRow_(SHEETS.PARAMETERS, 'ParamID', r.ParamID);
        return;
      }
      upsertRow_(SHEETS.PARAMETERS, 'ParamID', {
        ParamID: r.ParamID || '',
        ScenarioID: scenarioId,
        VehicleID: r.VehicleID || '',
        ParamName: r.ParamName,
        Currency: '',
        Value: r.Value,
        EffectiveDate: r.EffectiveDate || ''
      });
    });
    return true;
  });
}

/**
 * 匯率設定表格：以「幣別 × 匯率種類(集團預算匯率/現況匯率)」管理，1 外幣 = Value 台幣。
 * 銷貨成本頁的幣別選單就是這裡設定過的幣別。
 */
function getFxGrid(scenarioId) {
  var params = getFxParameters(scenarioId).filter(function (p) { return p.ScenarioID === scenarioId; });
  var currencies = {};
  params.forEach(function (p) { if (p.Currency) currencies[p.Currency] = true; });
  DEFAULT_FX_CURRENCIES.forEach(function (c) { currencies[c] = true; });

  var rows = Object.keys(currencies).sort().map(function (currency) {
    var cells = {};
    FX_PARAM_NAMES.forEach(function (name) {
      var row = params.filter(function (p) { return p.ParamName === name && p.Currency === currency; })[0];
      cells[name] = row ? { ParamID: row.ParamID, Value: toNumber_(row.Value) } : { ParamID: '', Value: '' };
    });
    return { Currency: currency, cells: cells };
  });

  return { baseCurrency: BASE_CURRENCY, paramNames: FX_PARAM_NAMES, rows: rows };
}

/** 匯率整批儲存；留白代表未設定該幣別的匯率，會刪掉舊資料 */
function saveFxGrid(scenarioId, cells) {
  return withLock_(function () {
    (cells || []).forEach(function (c) {
      var isEmpty = c.Value === '' || c.Value === null || c.Value === undefined;
      if (isEmpty) {
        if (c.ParamID) deleteRow_(SHEETS.PARAMETERS, 'ParamID', c.ParamID);
        return;
      }
      if (!c.Currency) throw new Error('請選擇幣別');
      upsertRow_(SHEETS.PARAMETERS, 'ParamID', {
        ParamID: c.ParamID || '',
        ScenarioID: scenarioId,
        VehicleID: '',
        ParamName: c.ParamName,
        Currency: c.Currency,
        Value: c.Value,
        EffectiveDate: ''
      });
    });
    return getFxGrid(scenarioId);
  });
}

/** 銷貨成本幣別選單：本位幣 + 匯率設定頁已經設定過匯率的幣別 */
function getConfiguredCurrencies(scenarioId) {
  var list = [BASE_CURRENCY];
  getFxParameters(scenarioId).forEach(function (p) {
    if (p.Currency && p.ParamName === COST_FX_PARAM_NAME && toNumber_(p.Value) && list.indexOf(p.Currency) === -1) {
      list.push(p.Currency);
    }
  });
  return list;
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

// ---- PLLineItems 科目設定（明細科目可自由新增/刪除） ----
function getPLLineItems() {
  return (sheetToObjects_(SHEETS.PL_LINE_ITEMS) || []).sort(function (a, b) { return a.SortOrder - b.SortOrder; });
}
function savePLLineItem(rowObj) {
  return withLock_(function () {
    if (!rowObj.LineCode) throw new Error('科目代碼(LineCode)為必填');
    // 自動計算科目由 CalcEngine 產生，使用者新增的科目一律是手動輸入科目
    var existing = getPLLineItems().filter(function (d) { return d.LineCode === rowObj.LineCode; })[0];
    rowObj.AutoSource = existing ? (existing.AutoSource || '') : '';
    return upsertRow_(SHEETS.PL_LINE_ITEMS, 'LineCode', rowObj);
  });
}
function deletePLLineItem(lineCode) {
  return withLock_(function () {
    if (PROTECTED_LINE_CODES.indexOf(lineCode) !== -1) {
      throw new Error('「' + lineCode + '」是損益結構科目(小計/毛利/淨利)，刪除會讓損益鏈斷掉，不可刪除。');
    }
    var def = getPLLineItems().filter(function (d) { return d.LineCode === lineCode; })[0];
    if (def && def.AutoSource) {
      throw new Error('「' + lineCode + ' ' + def.LineName + '」是自動計算科目，由比率設定或開發總投攤提產生，不可刪除。');
    }
    return deleteRow_(SHEETS.PL_LINE_ITEMS, 'LineCode', lineCode);
  });
}

/**
 * 科目下拉選單選項：只回傳「可手動輸入」的明細科目(排除自動計算科目)，
 * 回傳 [{value, label}]，前端 renderForm 直接吃這個格式。
 */
function lineOptionsFor_(parentCodes, extraCodes) {
  var opts = getPLLineItems()
    .filter(function (d) {
      return !d.AutoSource &&
        (parentCodes.indexOf(d.ParentLine) !== -1 || (extraCodes || []).indexOf(d.LineCode) !== -1);
    })
    .map(function (d) { return { value: d.LineCode, label: d.LineCode + ' ' + d.LineName }; });
  return opts;
}
/** 銷貨成本頁的成本項目選單（B 底下、可手動輸入的科目） */
function getCostOfSalesLineOptions() {
  return lineOptionsFor_(['B']);
}
/** 營業費用頁的科目選單（E/G/I 底下可手動輸入的科目，外加 J 前瞻費用） */
function getOperatingExpenseLineOptions() {
  return lineOptionsFor_(['E', 'G', 'I'], ['J']);
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

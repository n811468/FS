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

/**
 * 開場資料：車型清單 + 預設選到的車型與它底下的情境，一次取回。
 * 前端載入時原本要分別呼叫 getVehicleTypes / getScenarios 並各觸發一次重繪，
 * 每趟 google.script.run 往返都是數百毫秒，合併成一次可以明顯縮短開場等待。
 */
function getBootstrap(preferredVehicleTypeId) {
  // 開頁時順手把「由程式定義的科目名稱」對回來。做成自動修復而不是維護選單，
  // 是因為名稱對不上數字的畫面看起來就是「系統算錯了」，不該要使用者先知道有這支維護功能。
  // 只有真的對不上時才寫入，之後每次開頁都只是一次讀取。
  withLock_(function () { return syncCodeOwnedLineItems_(); });

  var types = getVehicleTypes();
  var ids = types.map(function (t) { return t.VehicleTypeID; });
  var pick = (preferredVehicleTypeId && ids.indexOf(preferredVehicleTypeId) !== -1)
    ? preferredVehicleTypeId : (ids[0] || '');
  return {
    vehicleTypes: types,
    vehicleTypeId: pick,
    scenarios: pick ? getScenarios(pick) : []
  };
}

// ---- VehicleTypes（車型主檔，如 DA/DE/DH/DX，需先建立才能在底下新增車系） ----
function getVehicleTypes() {
  return sheetToObjects_(SHEETS.VEHICLE_TYPES) || [];
}
function saveVehicleType(rowObj) {
  return withLock_(function () { return upsertRowMerge_(SHEETS.VEHICLE_TYPES, 'VehicleTypeID', rowObj); });
}
function deleteVehicleType(vehicleTypeId) {
  return withLock_(function () { return deleteRow_(SHEETS.VEHICLE_TYPES, 'VehicleTypeID', vehicleTypeId); });
}
/** 車型主檔整批儲存：整張表直接編輯、按一次儲存（沒填代號的空白新增列會被略過） */
function saveVehicleTypeGrid(rows) {
  return withLock_(function () {
    (rows || []).forEach(function (r) {
      if (!r.VehicleTypeID) return;
      upsertRowMerge_(SHEETS.VEHICLE_TYPES, 'VehicleTypeID', r);
    });
    return getVehicleTypes();
  });
}

// ---- Vehicles（車系，如 3人貨車/9人客貨車，隸屬某個 VehicleType） ----
function getVehicles(vehicleTypeId) {
  var rows = sheetToObjects_(SHEETS.VEHICLES) || [];
  return vehicleTypeId ? rows.filter(function (r) { return r.VehicleTypeID === vehicleTypeId; }) : rows;
}
function saveVehicle(rowObj) {
  return withLock_(function () { return upsertRowMerge_(SHEETS.VEHICLES, 'VehicleID', rowObj); });
}
function deleteVehicle(vehicleId) {
  return withLock_(function () { return deleteRow_(SHEETS.VEHICLES, 'VehicleID', vehicleId); });
}
/** 車系設定整批儲存 */
function saveVehicleGrid(vehicleTypeId, rows) {
  return withLock_(function () {
    (rows || []).forEach(function (r) {
      if (!r.VehicleID) return;
      r.VehicleTypeID = vehicleTypeId;
      upsertRowMerge_(SHEETS.VEHICLES, 'VehicleID', r);
    });
    return getVehicles(vehicleTypeId);
  });
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
    // 用合併式 upsert：情境表單沒有攤提基準台數欄位，直接覆寫會把開發總投頁設定的值清掉
    return upsertRowMerge_(SHEETS.SCENARIOS, 'ScenarioID', rowObj);
  });
}
function deleteScenario(scenarioId) {
  return withLock_(function () { return deleteRow_(SHEETS.SCENARIOS, 'ScenarioID', scenarioId); });
}

/** 情境設定整批儲存（既有情境直接在表格上改名/改性質，按一次儲存） */
function saveScenarioGrid(vehicleTypeId, rows) {
  return withLock_(function () {
    (rows || []).forEach(function (r) {
      if (!r.ScenarioID && !r.Gate && !r.ScenarioName) return;
      r.VehicleTypeID = vehicleTypeId;
      saveScenario(r);
    });
    return getScenarios(vehicleTypeId);
  });
}

/**
 * 以既有情境為基礎建立新情境。
 * 實務上新情境幾乎都是既有情境的變形（「GATE F 目標」通常就是「GATE F 現況」改幾個數字，
 * 而下一版的目標又是以上一版目標為底），從頭把銷售構成、成本、開發總投重打一次很不合理。
 * sourceScenarioId 留空就是建立一個空白情境。
 */
function createScenarioFrom(rowObj, sourceScenarioId, parts) {
  return withLock_(function () {
    var saved = saveScenario(rowObj);
    if (sourceScenarioId) {
      copyScenarioData(sourceScenarioId, saved.ScenarioID, parts);
    }
    return saved;
  });
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
  // 帶出各車系的銷售構成比：金額矩陣不顯示跨車系的「合計」(把不同車系的單台成本相加沒有意義)，
  // 改成用構成比加權的平均值，跟損益儀表板的加權平均欄位是同一個口徑。
  var mix = {};
  getSalesMix(scenarioId).forEach(function (r) { mix[r.VehicleID] = toNumber_(r.SalesMixPct); });
  var vehicles = getVehicles(vehicleTypeId).map(function (v) {
    return { VehicleID: v.VehicleID, VehicleCode: v.VehicleCode || '', SalesMixPct: mix[v.VehicleID] || 0 };
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
    return upsertRow_(SHEETS.PL_LINE_ITEMS, 'LineCode', newLineItemRow_(parentLine, lineName));
  });
}

/**
 * 產生一筆新科目（代碼與排序值都由系統決定，使用者只選父科目、填名稱）。
 * 呼叫端必須已經在 withLock_ 內，否則兩個同時新增的科目有機會拿到同一個代碼。
 */
function newLineItemRow_(parentLine, lineName) {
  return {
    LineCode: nextLineCode_(parentLine),
    LineName: lineName,
    ParentLine: parentLine,
    Category: parentLine === 'B' ? '成本明細' : '費用明細',
    SortOrder: nextSortOrder_(parentLine),
    AutoSource: ''
  };
}

/** 下一個可用的科目代碼：父科目字首 + 最小未使用號碼(b1、b2、d1...) */
function nextLineCode_(parentLine) {
  var prefix = LINE_CODE_PREFIX[parentLine];
  if (!prefix) throw new Error('父科目不正確：' + (parentLine || '(未選擇)'));
  var used = {};
  getPLLineItems().forEach(function (d) { used[d.LineCode] = true; });
  var n = 1;
  while (used[prefix + n]) n++;
  return prefix + n;
}

/** 新科目排在同一段的最後面(+0.5)，之後可在科目設定頁直接改排序值微調 */
function nextSortOrder_(parentLine) {
  var maxSort = 0;
  getPLLineItems().forEach(function (d) {
    if (d.ParentLine === parentLine) maxSort = Math.max(maxSort, toNumber_(d.SortOrder));
  });
  return (maxSort || 20) + 0.5;
}

/**
 * 刪除科目，並清掉該科目在「所有情境」已輸入的金額。
 * 科目表是全域的，只清當前情境會讓其他情境留下孤兒金額，
 * 那些金額不會顯示在任何頁面上，卻仍被計入銷貨成本，最難察覺。
 */
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

/**
 * 一列開發總投要攤提到哪個科目（b5 模具 / b8 設備 / f3 開發費-CMC / f4 開發費-BASE廠）。
 * 舊資料的資產類型只有一個「費用」，落點是靠 Department 剛好等於 'BASE廠開發費' 判斷的 ——
 * 部門是自由輸入欄位，打成「BASE廠」就會整筆跑到 f3，畫面上還看不出來。
 * 新資料直接用資產類型決定；舊資料仍沿用原本的判斷，讀進畫面時會順手轉成新的選項值。
 */
function devAmortTargetOf_(row) {
  var type = row.AssetType;
  if (type === DEV_ASSET_TYPE_LEGACY_EXPENSE) {
    return row.Department === DEV_INVESTMENT_BASE_FACTORY_DEPT ? 'f4' : 'f3';
  }
  return DEV_ASSET_TYPE_TARGET[type] || '';
}

/** 舊的「費用」資產類型轉成新的「費用-CMC」/「費用-BASE廠」 */
function normalizeDevAssetType_(row) {
  if (row.AssetType !== DEV_ASSET_TYPE_LEGACY_EXPENSE) return row.AssetType;
  return row.Department === DEV_INVESTMENT_BASE_FACTORY_DEPT ? '費用-BASE廠' : '費用-CMC';
}

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
      // 沒選資產類型的列不會被攤提到任何科目，金額等於憑空消失，所以直接擋下來
      if (toNumber_(r.Amount) && DEV_ASSET_TYPES_ACCEPTED.indexOf(r.AssetType) === -1) {
        throw new Error('「' + (r.Department || '未命名部門') + '」有金額但沒有選攤提落點，請選擇 ' +
          DEV_ASSET_TYPES.join(' / ') + '。');
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
    // 銷售構成/成本/費用都是以 VehicleID(車系) 為鍵，跨車型帶入會把來源車型的車系搬進來，
    // 在目標車型的頁面上完全看不到那些列，卻仍被計入損益 —— 直接擋掉。
    var allScenarios = getScenarios();
    var findScenario = function (id) {
      return allScenarios.filter(function (s) { return s.ScenarioID === id; })[0];
    };
    var source = findScenario(sourceScenarioId);
    var target = findScenario(targetScenarioId);
    if (!source) throw new Error('找不到來源情境：' + sourceScenarioId);
    if (!target) throw new Error('找不到目標情境：' + targetScenarioId);
    if (source.VehicleTypeID !== target.VehicleTypeID) {
      throw new Error('只能從同一個車型底下的情境帶入（來源為 ' + (source.VehicleTypeID || '(未設定)') +
        '，目標為 ' + (target.VehicleTypeID || '(未設定)') + '）。');
    }
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
 * 匯率設定表格：以幣別管理，1 外幣 = Value 台幣。
 * 只有一種匯率(現況匯率)，銷貨成本與開發總投的外幣金額都用它換算；
 * 銷貨成本頁的幣別選單就是這裡設定過匯率的幣別。
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

/**
 * 把「由程式定義」的科目名稱與位置對回程式碼。
 *
 * 有兩類科目的名稱不屬於使用者：
 *   - 自動計算科目(AutoSource 有值)：金額是公式算出來的，名稱寫的就是那條公式
 *   - 結構科目(A/B/C/E/G/I/K)：名稱寫的是它跟哪些明細的加總關係
 * 這兩類一旦跟程式對不起來，畫面上就會出現「欄位寫廢車處理費、數字卻是強配件售價」——
 * 舊版的售價結構只有 8 列(P2 是廢車處理費)，改版重新編號成 9 列之後，
 * seedPLLineItems_() 又刻意不覆蓋既有科目(使用者可能自己改過名稱)，
 * 於是新代碼配著舊名稱一直留在 Sheet 上。名稱是描述公式的，就該由公式那一邊決定。
 *
 * 明細科目(b1/d1/f1/h1...)的名稱與排序仍然屬於使用者，這裡完全不動 ——
 * 要整個回復成內建預設值請用 restoreBuiltInLineItems()。
 */
function syncCodeOwnedLineItems_() {
  var existing = {};
  getPLLineItems().forEach(function (d) { existing[d.LineCode] = d; });

  var fixed = [];
  PL_LINE_ITEMS.forEach(function (line) {
    var isCodeOwned = line.AutoSource || PROTECTED_LINE_CODES.indexOf(line.LineCode) !== -1;
    if (!isCodeOwned) return;
    var current = existing[line.LineCode];
    if (!current) return;                       // 還沒建立的科目交給 seedPLLineItems_() 補
    var same = function (field) {
      var a = current[field] === undefined || current[field] === null ? '' : current[field];
      var b = line[field] === undefined || line[field] === null ? '' : line[field];
      return String(a) === String(b);
    };
    if (['LineName', 'ParentLine', 'Category', 'SortOrder'].every(same)) return;

    var row = {};
    SCHEMA.PLLineItems.forEach(function (h) {
      row[h] = line[h] !== undefined ? line[h] : (current[h] !== undefined ? current[h] : '');
    });
    upsertRow_(SHEETS.PL_LINE_ITEMS, 'LineCode', row);
    fixed.push(line.LineCode);
  });
  return fixed;
}

/**
 * 把所有內建科目(含明細科目)的名稱、父科目、分類、排序值整個回復成程式碼中的預設值。
 * 使用者自己新增的科目不受影響。排序值會一併回到實際損益試算表的列序。
 */
function restoreBuiltInLineItems() {
  return withLock_(function () {
    PL_LINE_ITEMS.forEach(function (line) {
      var row = {};
      SCHEMA.PLLineItems.forEach(function (h) { row[h] = line[h] !== undefined ? line[h] : ''; });
      upsertRow_(SHEETS.PL_LINE_ITEMS, 'LineCode', row);
    });
    return getPLLineItems();
  });
}

function getPLLineItems() {
  return (sheetToObjects_(SHEETS.PL_LINE_ITEMS) || []).sort(function (a, b) { return a.SortOrder - b.SortOrder; });
}
function savePLLineItem(rowObj) {
  return withLock_(function () { return savePLLineItem_(rowObj); });
}

/**
 * 儲存一筆科目。沒有帶 LineCode 就視為新增，代碼與排序值由系統產生
 * （使用者只選父科目、填名稱，不必自己編碼，也不會跟既有科目撞號）。
 * 呼叫端必須已經在 withLock_ 內。
 */
function savePLLineItem_(rowObj) {
  if (!rowObj.LineName) throw new Error('科目名稱為必填');

  if (!rowObj.LineCode) {
    var created = newLineItemRow_(rowObj.ParentLine, rowObj.LineName);
    // 使用者若在新增列自己填了分類/排序值就尊重他的值，其餘沿用系統產生的預設
    if (rowObj.Category) created.Category = rowObj.Category;
    if (rowObj.SortOrder !== '' && rowObj.SortOrder !== undefined && rowObj.SortOrder !== null) {
      created.SortOrder = toNumber_(rowObj.SortOrder);
    }
    return upsertRow_(SHEETS.PL_LINE_ITEMS, 'LineCode', created);
  }

  var existing = getPLLineItems().filter(function (d) { return d.LineCode === rowObj.LineCode; })[0];
  // 自動計算科目由 CalcEngine 產生，使用者新增的科目一律是手動輸入科目；
  // CommodityTaxDeduct(貨物稅完稅價格可扣除)等表單沒有的欄位由合併式 upsert 保留原值
  rowObj.AutoSource = existing ? (existing.AutoSource || '') : '';
  // 結構科目(A/B/C/E/G/I/K)與自動計算科目改掉父科目會讓損益鏈接錯段，一律沿用原值
  if (existing && (PROTECTED_LINE_CODES.indexOf(rowObj.LineCode) !== -1 || existing.AutoSource)) {
    rowObj.ParentLine = existing.ParentLine || '';
  }
  return upsertRowMerge_(SHEETS.PL_LINE_ITEMS, 'LineCode', rowObj);
}

/**
 * 科目設定整批儲存：整張表直接編輯、按一次儲存。
 * 沒有 LineCode 的列就是新增列，代碼由系統自動產生。
 */
function savePLLineItemGrid(rows) {
  return withLock_(function () {
    (rows || []).forEach(function (r) {
      // 完全空白的新增列直接跳過，使用者按了「新增一列」又沒填東西不該報錯
      if (!r.LineCode && !r.LineName) return;
      savePLLineItem_(r);
    });
    return getPLLineItems();
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


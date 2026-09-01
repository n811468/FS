/**
 * 一鍵匯入 Gate F 範例資料（DA 車 / GATE F）。
 *
 * 資料來源：實務 Gate F 損益試算 Excel 的「GATE F含TNCAP」與「開發總投」兩張分頁，
 * 一次建立 3 個情境，可以直接在儀表板並排比較：
 *   1. GATE F 含TNCAP 現況    —— 對應 Excel 主表(未套挑戰低減目標)
 *   2. GATE F 含TNCAP 目標    —— 同上，但套用各部門的挑戰低減目標%
 *   3. GATE F 不含TNCAP 現況  —— 費用類扣除 TNCAP 對應金額後的版本
 *
 * 執行方式（擇一）：
 *   - Google Sheet 選單「車型損益試算 → 匯入 Gate F 範例資料」
 *   - Apps Script 編輯器選函式 importGateFSample 後按執行
 *
 * 重複執行是安全的：會先清掉這三個情境的既有資料再重寫，不會產生重複列。
 */

var GATE_F_SAMPLE = {
  vehicleTypeId: 'DA',

  // 車系：Excel 的幼童車/福祉車銷售構成為 0 且未定價，故不匯入
  vehicles: [
    { VehicleID: 'DA-3T', VehicleCode: '3人貨車' },
    { VehicleID: 'DA-9C', VehicleCode: '9人客貨車(商用)' },
    { VehicleID: 'DA-9P', VehicleCode: '9人客貨車(接駁)' }
  ],

  // 情境：同一個 GATE F 底下三個版本
  scenarios: [
    { ScenarioID: 'SC-DA-GATEF-CUR', Gate: 'GATE F', ScenarioName: '含TNCAP 現況', ScenarioType: '現況' },
    { ScenarioID: 'SC-DA-GATEF-TGT', Gate: 'GATE F', ScenarioName: '含TNCAP 目標', ScenarioType: '目標' },
    { ScenarioID: 'SC-DA-GATEF-NOTNCAP', Gate: 'GATE F', ScenarioName: '不含TNCAP 現況', ScenarioType: '現況' }
  ],

  // 開發總投攤提基準：Excel 開發總投 B25 = 300 台/月 × 12 月 × 12 年 = 43,200 台
  // （與銷售構成的 365 台/月不同，所以要獨立設定）
  amortMonthlyVolume: 300,
  amortLifeCycleYears: 12,

  // 銷售構成：構成比% / 月台數 / 建議零售價(含稅)
  // 廢車處理費 Excel 為 ROUND(3800×1.05)，故以未稅 3,800 登打
  salesMix: [
    { VehicleID: 'DA-3T', SalesMixPct: 5, MonthlyVolume: 18.25, ListPriceTaxIncl: 950000 },
    { VehicleID: 'DA-9C', SalesMixPct: 25, MonthlyVolume: 91.25, ListPriceTaxIncl: 1050000 },
    { VehicleID: 'DA-9P', SalesMixPct: 70, MonthlyVolume: 255.5, ListPriceTaxIncl: 1250000 }
  ],
  salesMixCommon: {
    LifeCycleYears: 12,
    MandatoryAccessoryPrice: 0,
    ScrapFee: 3800,
    ScrapFeeTaxStatus: '未稅',
    HorizontalPartsPriceAdj: ''
  },

  // 匯入時要補建的成本科目（預設科目表沒有「內陸運雜」，比照 Excel 獨立一列）
  extraLineItems: [
    { LineCode: 'b14', LineName: '內陸運雜', ParentLine: 'B', Category: '成本明細', SortOrder: 22.5, AutoSource: '', CommodityTaxDeduct: '' }
  ],

  // 銷貨成本：[科目, 3人貨車, 9人商用, 9人接駁]
  // b5 模具 / b8 設備 / b13 貨物稅為自動計算科目，不在此匯入
  costOfSales: [
    ['b1', 433466, 506850, 581823],           // 材料成本-LP
    ['b14', 3391, 3391, 3391],                // 內陸運雜
    ['b2', 372148, 372148, 372148],           // 材料成本-KD
    ['b4', 7166.4, 7166.4, 7166.4],           // 一般材料
    ['b6', 18231.6245, 18480.0733, 18625.7157], // 直接人工
    ['b7', 29525.7737, 29933.8082, 30010.9967], // 製造費用
    ['b11', 764, 764, 764],                   // 防鏽
    ['b12', 2396.4, 2396.4, 2396.4]           // 廢棄物處理及包材
  ],

  // 營業費用：[科目, 3人貨車, 9人商用, 9人接駁]（Excel 三個車系相同）
  // d4 季Margin、f3/f4 開發費用為自動計算科目，不在此匯入
  operatingExpense: [
    ['d1', 5555.6667, 5555.6667, 5555.6667],  // 廣宣費用
    ['d2', 23158, 23158, 23158],              // 促銷
    ['d3', 20282.6667, 20282.6667, 20282.6667], // 批標售
    ['d5', 3431, 3431, 3431],                 // 索賠(含索賠取回)
    ['f1', 3196, 3196, 3196],                 // 直接歸屬費用-CMC&SDM
    ['h1', 41131, 41131, 41131],              // 固定營業費用-CMC&SDM
    ['h3', 2164, 2164, 2164],                 // 品牌廣宣費用
    ['h4', 7237, 7237, 7237]                  // 特別加發
  ],

  /**
   * 開發總投（含TNCAP）：[部門, 模具, 設備, 費用, 挑戰低減目標%, TNCAP對應金額]
   * 「不含TNCAP」情境的費用類 = 費用 − TNCAP對應金額（Excel 開發總投 P 欄）。
   * 試驗部的費用類低減率 Excel 用 10%，其餘部門 20%。
   */
  devInvestment: [
    ['產專室', 0, 0, 66610000, 20, 8580000],
    ['產工部', 0, 0, 123456000, 20, 52386000],
    ['試驗部', 0, 0, 105027540, 10, 23175000],
    ['開發部', 1415574014, 0, 130361500, 20, 88590000],
    ['電電部', 20300000, 0, 164978000, 20, 45760000],
    ['前瞻技術室', 0, 0, 8100000, 20, 0],
    ['造型部', 0, 0, 34220000, 20, 0],
    ['生技部', 0, 478204000, 15499000, 20, 0],
    ['品管部', 0, 11055800, 6940435, 20, 0],
    ['楊梅廠', 0, 1270000, 1617000, 20, 0],
    ['業務部', 0, 0, 30980000, 20, 30000000],
    ['服務部', 0, 0, 63500, 20, 0],
    ['生管部', 0, 6041000, 10195500, 20, 0]
  ],

  // BASE廠開發費：Excel =(6000萬CNY ÷ 0.8) × 現況匯率，以 CNY 登打，由匯率設定換算
  baseFactoryDev: { AmountCNY: 75000000, ChallengeReductionPct: 0 },

  // 稅務費用比率（0~100 百分比數值）
  rates: {
    '營業稅率': 5,
    '銷售佣金率': 7,
    '季Margin率': 0.5,
    '貨物稅率': 15,
    '貨物稅完稅價格計算率': 91
  },
  // 匯率：1 外幣 = ? 台幣（Excel 開發總投 B1 集團預算匯率 4.3 / D1 現況匯率 4.65）
  fx: [
    { Currency: 'CNY', ParamName: '集團預算匯率', Value: 4.3 },
    { Currency: 'CNY', ParamName: '現況匯率', Value: 4.65 }
  ]
};

/**
 * 把範例資料展開成各分頁要寫入的資料列。
 * 抽成獨立函式，方便不連 Google Sheet 也能驗證資料正確性。
 */
function buildGateFSampleRows_() {
  var S = GATE_F_SAMPLE;
  var typeId = S.vehicleTypeId;
  var vehicleIds = S.vehicles.map(function (v) { return v.VehicleID; });
  var scenarioIds = S.scenarios.map(function (s) { return s.ScenarioID; });
  var curId = scenarioIds[0], tgtId = scenarioIds[1], noTncapId = scenarioIds[2];

  var out = {
    scenarioIds: scenarioIds,
    vehicleTypes: [{ VehicleTypeID: typeId, Notes: 'Gate F 範例資料' }],
    vehicles: S.vehicles.map(function (v) {
      return { VehicleID: v.VehicleID, VehicleTypeID: typeId, VehicleCode: v.VehicleCode, Notes: '' };
    }),
    scenarios: S.scenarios.map(function (s) {
      return {
        ScenarioID: s.ScenarioID, Gate: s.Gate, ScenarioName: s.ScenarioName, ScenarioType: s.ScenarioType,
        VehicleTypeID: typeId,
        AmortMonthlyVolume: S.amortMonthlyVolume, AmortLifeCycleYears: S.amortLifeCycleYears,
        CreatedBy: '', CreatedDate: '', Notes: '由 Gate F 範例資料匯入'
      };
    }),
    lineItems: S.extraLineItems,
    salesMix: [], costOfSales: [], operatingExpense: [], devInvestment: [], parameters: []
  };

  scenarioIds.forEach(function (scenarioId) {
    // ---- 銷售構成（三個情境的售價與台數相同）----
    S.salesMix.forEach(function (m) {
      var row = { RowID: '', ScenarioID: scenarioId, VehicleID: m.VehicleID,
        SalesMixPct: m.SalesMixPct, MonthlyVolume: m.MonthlyVolume, ListPriceTaxIncl: m.ListPriceTaxIncl,
        EffectiveDate: '', Notes: '' };
      Object.keys(S.salesMixCommon).forEach(function (k) { row[k] = S.salesMixCommon[k]; });
      out.salesMix.push(row);
    });

    // ---- 銷貨成本 / 營業費用（列 = 科目，欄 = 車系）----
    S.costOfSales.forEach(function (line) {
      vehicleIds.forEach(function (vid, i) {
        if (!line[i + 1]) return;
        out.costOfSales.push({ RowID: '', ScenarioID: scenarioId, VehicleID: vid, LineCode: line[0],
          Amount: line[i + 1], Currency: BASE_CURRENCY, Notes: '', EffectiveDate: '' });
      });
    });
    S.operatingExpense.forEach(function (line) {
      vehicleIds.forEach(function (vid, i) {
        if (!line[i + 1]) return;
        out.operatingExpense.push({ RowID: '', ScenarioID: scenarioId, VehicleID: vid, LineCode: line[0],
          Amount: line[i + 1], Notes: '', EffectiveDate: '' });
      });
    });

    // ---- 開發總投 ----
    var isTarget = scenarioId === tgtId;
    var isNoTncap = scenarioId === noTncapId;
    S.devInvestment.forEach(function (d) {
      var dept = d[0], mold = d[1], equip = d[2], expense = d[3], reduction = d[4], tncap = d[5];
      if (isNoTncap) expense = expense - tncap;   // 不含TNCAP：費用類扣除 TNCAP 對應金額
      var push = function (assetType, amount) {
        if (!amount) return;
        out.devInvestment.push({ RowID: '', ScenarioID: scenarioId, Department: dept, AssetType: assetType,
          Amount: amount, Currency: BASE_CURRENCY,
          // 現況情境不套低減目標，目標情境才填
          ChallengeReductionPct: isTarget ? reduction : '', Notes: '', EffectiveDate: '' });
      };
      push('模具', mold);
      push('設備', equip);
      push('費用', expense);
    });
    out.devInvestment.push({ RowID: '', ScenarioID: scenarioId, Department: DEV_INVESTMENT_BASE_FACTORY_DEPT,
      AssetType: '費用', Amount: S.baseFactoryDev.AmountCNY, Currency: 'CNY',
      ChallengeReductionPct: isTarget ? S.baseFactoryDev.ChallengeReductionPct : '',
      Notes: '6000萬CNY ÷ 0.8', EffectiveDate: '' });

    // ---- 參數（比率 + 匯率）----
    Object.keys(S.rates).forEach(function (name) {
      out.parameters.push({ ParamID: '', ScenarioID: scenarioId, VehicleID: '', ParamName: name,
        Currency: '', Value: S.rates[name], EffectiveDate: '' });
    });
    S.fx.forEach(function (f) {
      out.parameters.push({ ParamID: '', ScenarioID: scenarioId, VehicleID: '', ParamName: f.ParamName,
        Currency: f.Currency, Value: f.Value, EffectiveDate: '' });
    });
  });

  return out;
}

/** 一鍵匯入 Gate F 範例資料 */
function importGateFSample() {
  var data = buildGateFSampleRows_();

  var summary = withLock_(function () {
    // 主檔用 upsert（不刪既有資料，避免蓋掉使用者自己建的其他車型）
    data.vehicleTypes.forEach(function (r) { upsertRow_(SHEETS.VEHICLE_TYPES, 'VehicleTypeID', r); });
    data.vehicles.forEach(function (r) { upsertRow_(SHEETS.VEHICLES, 'VehicleID', r); });
    data.scenarios.forEach(function (r) { upsertRow_(SHEETS.SCENARIOS, 'ScenarioID', r); });
    data.lineItems.forEach(function (r) {
      var exists = getPLLineItems().filter(function (d) { return d.LineCode === r.LineCode; })[0];
      if (!exists) upsertRow_(SHEETS.PL_LINE_ITEMS, 'LineCode', r);
    });

    // 交易資料整批重寫（先清掉這三個情境的舊資料，重複執行才不會變成兩倍）
    replaceScenarioRows_(SHEETS.SALES_MIX, data.scenarioIds, data.salesMix);
    replaceScenarioRows_(SHEETS.COST_OF_SALES, data.scenarioIds, data.costOfSales);
    replaceScenarioRows_(SHEETS.OPERATING_EXPENSE, data.scenarioIds, data.operatingExpense);
    replaceScenarioRows_(SHEETS.DEV_INVESTMENT, data.scenarioIds, data.devInvestment);
    replaceScenarioRows_(SHEETS.PARAMETERS, data.scenarioIds, data.parameters);
    replaceScenarioRows_(SHEETS.PL_RESULT, data.scenarioIds, []); // 舊的計算快照一併清掉

    return {
      車型: data.vehicleTypes.length, 車系: data.vehicles.length, 情境: data.scenarios.length,
      銷售構成: data.salesMix.length, 銷貨成本: data.costOfSales.length,
      營業費用: data.operatingExpense.length, 開發總投: data.devInvestment.length,
      參數: data.parameters.length
    };
  });

  var msg = 'Gate F 範例資料匯入完成：\n' +
    Object.keys(summary).map(function (k) { return '  ' + k + '：' + summary[k] + ' 筆'; }).join('\n') +
    '\n\n請到網頁應用程式上方選車型 DA，即可看到三個 GATE F 情境。';
  try {
    SpreadsheetApp.getUi().alert(msg);
  } catch (e) {
    Logger.log(msg); // 從編輯器直接執行時沒有 UI，改寫到記錄檔
  }
  return summary;
}

/**
 * 把某幾個情境的資料整批換成新的：先刪除舊列，再一次寫入。
 * 用 setValues 批次寫入（而非逐列 appendRow），資料量大時才不會跑到逾時。
 */
function replaceScenarioRows_(sheetName, scenarioIds, newRows) {
  var sheet = getSheet_(sheetName);
  var headers = SCHEMA[sheetName];
  var pk = headers[0];
  var lastRow = sheet.getLastRow();

  var kept = [];
  if (lastRow >= 2) {
    var existing = sheet.getRange(2, 1, lastRow - 1, headers.length).getValues();
    kept = existing.filter(function (row) {
      var isBlank = row.every(function (v) { return v === '' || v === null; });
      if (isBlank) return false;
      var scenarioIdx = headers.indexOf('ScenarioID');
      return scenarioIdx === -1 || scenarioIds.indexOf(row[scenarioIdx]) === -1;
    });
    sheet.getRange(2, 1, lastRow - 1, headers.length).clearContent();
  }

  var added = newRows.map(function (r) {
    if (!r[pk]) r[pk] = generateId_(rowIdPrefix_(sheetName));
    return headers.map(function (h) { return r[h] !== undefined ? r[h] : ''; });
  });

  var all = kept.concat(added);
  if (all.length) sheet.getRange(2, 1, all.length, headers.length).setValues(all);
}

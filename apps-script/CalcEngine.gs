/**
 * 損益計算引擎：重現 Gate F 損益試算的公式鏈。
 * 為求可維護，公式做了以下簡化(相對於原始 Excel)：
 *   - 營業稅一律用「內含稅價 - 內含稅價/(1+稅率)」反推
 *   - 銷售佣金、貨物稅一律用 Parameters 設定的比率 × 對應基礎金額計算
 *   - f3/f4(車型專案開發費用) 由 DevInvestment 總投金額除以情境總銷售台數自動攤提
 * 需要更精細的個別車型調整時，可在 Parameters 加上 VehicleID 覆寫全域比率。
 */

function calculatePL(scenarioId, vehicleId) {
  var salesMixRow = getSalesMix(scenarioId).filter(function (r) { return r.VehicleID === vehicleId; })[0];
  if (!salesMixRow) throw new Error('找不到 SalesMix 資料：' + scenarioId + ' / ' + vehicleId);

  var params = getParameters(scenarioId);
  var taxRate = lookupParam_(params, '營業稅率', vehicleId);
  var commissionRate = lookupParam_(params, '銷售佣金率', vehicleId);
  var marginRate = lookupParam_(params, '季Margin率', vehicleId);

  var listPrice = toNumber_(salesMixRow.ListPriceTaxIncl);
  var accessoryPrice = toNumber_(salesMixRow.MandatoryAccessoryPrice);
  var scrapFeeRaw = toNumber_(salesMixRow.ScrapFee);
  // 廢車處理費可能用含稅或未稅金額登打，一律換算成含稅金額後再扣，
  // 確保跟 ListPriceTaxIncl(含稅零售價)口徑一致，全份損益試算稅別才不會混用。
  var scrapFee = salesMixRow.ScrapFeeTaxStatus === '未稅' ? scrapFeeRaw * (1 + taxRate) : scrapFeeRaw;

  var actualRetailPrice = listPrice - scrapFee; // ③
  var salesTax = actualRetailPrice - actualRetailPrice / (1 + taxRate); // 內含稅反推
  var commission = actualRetailPrice * commissionRate;
  var marginDeduction = actualRetailPrice * marginRate;
  var exFactoryPrice = actualRetailPrice - salesTax - commission - marginDeduction; // 廠價(未稅)

  var revenueA = exFactoryPrice + accessoryPrice; // A

  // ---- B 銷貨成本：彙總 MaterialCost 的 b1~b13 ----
  var materialRows = getMaterialCost(scenarioId, vehicleId);
  var bLines = {};
  materialRows.forEach(function (r) {
    var code = r.LineCode || MATERIAL_COST_LINE_MAP[r.CostCategory];
    if (!code) return;
    bLines[code] = (bLines[code] || 0) + toNumber_(r.Amount);
  });
  var totalB = sumValues_(bLines);
  var grossProfitC = revenueA - totalB; // C 生產毛利

  // ---- Σd 銷售費用(d1~d5) ----
  var opexRows = getOperatingExpense(scenarioId, vehicleId);
  var dLines = pickLines_(opexRows, ['d1', 'd2', 'd3', 'd4', 'd5']);
  var totalD = sumValues_(dLines);
  var grossProfitE = grossProfitC - totalD; // E 銷貨毛利

  // ---- Σf 費用(f1 直接輸入 + f3/f4 由開發總投攤提) ----
  var f1 = pickLines_(opexRows, ['f1']).f1 || 0;
  var perUnit = amortizeDevInvestmentPerUnit_(scenarioId);
  var f3 = perUnit.cmcPerUnit;
  var f4 = perUnit.basePerUnit;
  var totalF = f1 + f3 + f4;
  var contributionG = grossProfitE - totalF; // G 產品貢獻

  // ---- Σh 固定營業費用(h1,h3,h4) ----
  var hLines = pickLines_(opexRows, ['h1', 'h3', 'h4']);
  var totalH = sumValues_(hLines);
  var operatingProfitI = contributionG - totalH; // I 營業淨利(未扣前瞻)

  var j = pickLines_(opexRows, ['J']).J || 0;
  var operatingProfitK = operatingProfitI - j; // K 營業淨利

  var lineValues = Object.assign(
    { A: revenueA, B: totalB },
    bLines,
    { C: grossProfitC },
    dLines,
    { E: grossProfitE, f1: f1, f3: f3, f4: f4, G: contributionG },
    hLines,
    { I: operatingProfitI, J: j, K: operatingProfitK }
  );

  var timestamp = new Date();
  writePLResult_(scenarioId, vehicleId, lineValues, revenueA, timestamp);

  return {
    scenarioId: scenarioId,
    vehicleId: vehicleId,
    calculatedAt: timestamp.toISOString(), // 巢狀 Date 物件會讓 google.script.run 整包回傳變 null，一律轉字串
    lines: buildResultLines_(lineValues, revenueA)
  };
}

function calculatePLAllVehicles(scenarioId) {
  var salesMix = getSalesMix(scenarioId);
  var results = salesMix.map(function (row) { return calculatePL(scenarioId, row.VehicleID); });

  // 加權平均列（以 SalesMixPct 加權，寫入 VehicleID 空白的 PLResult 列）
  var totalPct = salesMix.reduce(function (s, r) { return s + toNumber_(r.SalesMixPct); }, 0) || 1;
  var weighted = {};
  results.forEach(function (res, idx) {
    var pct = toNumber_(salesMix[idx].SalesMixPct) / totalPct;
    res.lines.forEach(function (line) {
      weighted[line.LineCode] = (weighted[line.LineCode] || 0) + line.Amount * pct;
    });
  });
  var timestamp = new Date();
  writePLResult_(scenarioId, '', weighted, weighted.A || 0, timestamp);

  return {
    scenarioId: scenarioId,
    vehicles: results,
    weightedAverage: buildResultLines_(weighted, weighted.A || 0)
  };
}

/** 依 DevInvestment 攤提出「CMC單台」「BASE廠單台」開發成本 */
function amortizeDevInvestmentPerUnit_(scenarioId) {
  var devRows = getDevInvestment(scenarioId);
  var salesMix = getSalesMix(scenarioId);

  var totalUnits = salesMix.reduce(function (sum, r) {
    return sum + toNumber_(r.MonthlyVolume) * 12 * toNumber_(r.LifeCycleYears);
  }, 0);
  if (totalUnits <= 0) return { cmcPerUnit: 0, basePerUnit: 0 };

  var cmcTotal = 0, baseTotal = 0;
  devRows.forEach(function (r) {
    // ChallengeReductionPct 以 0~100 的百分比數值儲存(如 15 代表 15%)，換算時需 /100。
    var reduced = toNumber_(r.Amount) * (1 - toNumber_(r.ChallengeReductionPct) / 100);
    if (r.Department === DEV_INVESTMENT_BASE_FACTORY_DEPT) {
      baseTotal += reduced;
    } else {
      cmcTotal += reduced;
    }
  });

  return {
    cmcPerUnit: cmcTotal / totalUnits,
    basePerUnit: baseTotal / totalUnits
  };
}

function pickLines_(rows, codes) {
  var result = {};
  codes.forEach(function (c) { result[c] = 0; });
  rows.forEach(function (r) {
    if (codes.indexOf(r.LineCode) !== -1) {
      result[r.LineCode] += toNumber_(r.Amount);
    }
  });
  return result;
}

function sumValues_(obj) {
  return Object.keys(obj).reduce(function (s, k) { return s + obj[k]; }, 0);
}

function writePLResult_(scenarioId, vehicleId, lineValues, revenue, timestamp) {
  var sheet = getSheet_(SHEETS.PL_RESULT);
  // 先刪除該 scenario+vehicle 的舊快照
  var lastRow = sheet.getLastRow();
  if (lastRow >= 2) {
    var data = sheet.getRange(2, 1, lastRow - 1, SCHEMA.PLResult.length).getValues();
    for (var i = data.length - 1; i >= 0; i--) {
      if (data[i][1] === scenarioId && data[i][2] === vehicleId) {
        sheet.deleteRow(i + 2);
      }
    }
  }
  var rows = Object.keys(lineValues).map(function (code) {
    var amount = lineValues[code];
    return [generateId_('PR'), scenarioId, vehicleId, code, amount, revenue ? amount / revenue : 0, timestamp];
  });
  if (rows.length) {
    sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, SCHEMA.PLResult.length).setValues(rows);
  }
}

function buildResultLines_(lineValues, revenue) {
  var lineDefs = getPLLineItems();
  return lineDefs
    .filter(function (def) { return lineValues[def.LineCode] !== undefined; })
    .map(function (def) {
      var amount = lineValues[def.LineCode];
      return {
        LineCode: def.LineCode,
        LineName: def.LineName,
        Category: def.Category,
        Amount: amount,
        PctOfRevenue: revenue ? amount / revenue : 0
      };
    });
}

function getPLResult(scenarioId, vehicleId) {
  var rows = sheetToObjects_(SHEETS.PL_RESULT);
  return rows.filter(function (r) { return r.ScenarioID === scenarioId && r.VehicleID === (vehicleId || ''); });
}

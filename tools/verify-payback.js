/**
 * 現金回本分析的驗證（跑在同一套記憶體版試算表上）：
 *
 *   node tools/verify-payback.js
 *
 * 規格：docs/payback-and-sensitivity.md 第 11 節。
 * 重點在幾條不變式 —— 尤其是「改攤提基準，n* 必須完全不變」，
 * 那是規格 4.3 的核心結論，也是最容易寫錯的一條。
 */
const { loadAppsScript } = require('./fake-apps-script');

const results = [];
function check(name, fn) {
  try { fn(); results.push({ name, ok: true }); }
  catch (e) { results.push({ name, ok: false, message: e.message }); }
}
function assert(cond, message) { if (!cond) throw new Error(message); }
function close(actual, expected, tol, message) {
  if (!(Math.abs(actual - expected) <= tol)) {
    throw new Error(`${message}：實際 ${actual}，預期 ${expected}（容差 ${tol}）`);
  }
}

const gs = loadAppsScript(['Constants.gs', 'Utils.gs', 'DataService.gs', 'CalcEngine.gs', 'SetupSheets.gs']);
gs.setupSpreadsheet();
gs.saveVehicleType({ VehicleTypeID: 'DA' });
gs.saveVehicle({ VehicleID: 'V1', VehicleTypeID: 'DA', VehicleCode: '3人貨車' });
gs.saveVehicle({ VehicleID: 'V2', VehicleTypeID: 'DA', VehicleCode: '9人客貨車' });

const sc = gs.createScenarioFrom(
  { ScenarioID: '', Gate: 'GATE F', ScenarioName: '現況', ScenarioType: '現況', VehicleTypeID: 'DA' }, '', []);
const SID = sc.ScenarioID;

// 兩個車系、各 10 年 LC。月銷量合計 100 台 → 銷售構成推算 LC 總台數 = 100 × 12 × 10 = 12,000
gs.saveSalesMixGrid(SID, 'DA', [
  { RowID: '', VehicleID: 'V1', SalesMixPct: 40, MonthlyVolume: 40, LifeCycleYears: 10,
    ListPriceTaxIncl: 1000000, ScrapFee: 0, ScrapFeeTaxStatus: '含稅' },
  { RowID: '', VehicleID: 'V2', SalesMixPct: 60, MonthlyVolume: 60, LifeCycleYears: 10,
    ListPriceTaxIncl: 1000000, ScrapFee: 0, ScrapFeeTaxStatus: '含稅' }
]);
gs.saveCostOfSalesMatrix(SID, [
  { RowID: '', VehicleID: 'V1', LineCode: 'b1', Amount: 500000, Currency: 'TWD' },
  { RowID: '', VehicleID: 'V2', LineCode: 'b1', Amount: 500000, Currency: 'TWD' }
]);
gs.saveDevInvestmentGrid(SID, [
  { RowID: '', Department: '產專室', AssetType: '模具', TargetLineCode: 'b5',
    Amount: 120000000, Currency: 'TWD', ChallengeReductionPct: 0 }
]);

const A = gs.getPaybackAnalysis(SID);

check('m = K + 單台開發攤提', () => {
  close(A.perUnitCash, A.perUnitProfitK + A.perUnitAmort, 0.01, 'm 與 K + a 不符');
});

check('n* = I / m', () => {
  close(A.breakEvenUnits, A.investment / A.perUnitCash, 0.01, '損平台數與 I / m 不符');
});

check('恆等式 n*/N == I / (N·K + I)', () => {
  const N = A.lifeCycleUnits, K = A.perUnitProfitK, I = A.investment;
  close(A.breakEvenUnits / N, I / (N * K + I), 1e-9, '恆等式不成立');
});

check('單台攤提 a == I / N', () => {
  close(A.perUnitAmort, A.investment / A.lifeCycleUnits, 0.01, 'a 與 I/N 不符');
});

// ---- 規格 4.3 的核心結論：攤提基準只影響帳面 K，不影響 n* ----
check('改攤提基準後 n* 完全不變（K 會變）', () => {
  const before = gs.getPaybackAnalysis(SID);
  gs.saveScenarioGrid('DA', [{
    ScenarioID: SID, Gate: 'GATE F', ScenarioName: '現況', ScenarioType: '現況',
    AmortMonthlyVolume: 60, AmortLifeCycleYears: 10   // 覆寫成 7,200 台，低於銷售預估的 12,000
  }]);
  const after = gs.getPaybackAnalysis(SID);

  assert(after.lifeCycleUnits !== before.lifeCycleUnits, '攤提基準應該真的被改掉了（測試前提不成立）');
  assert(Math.abs(after.perUnitProfitK - before.perUnitProfitK) > 0.01,
    '攤提基準改了，帳面 K 應該要跟著變');
  close(after.breakEvenUnits, before.breakEvenUnits, 0.01,
    'n* 必須與攤提基準無關（規格 4.3）');
  close(after.perUnitCash, before.perUnitCash, 0.01, 'm 必須與攤提基準無關');

  // 還原，後面的測試用原本的基準
  gs.saveScenarioGrid('DA', [{
    ScenarioID: SID, Gate: 'GATE F', ScenarioName: '現況', ScenarioType: '現況',
    AmortMonthlyVolume: '', AmortLifeCycleYears: ''
  }]);
});

check('K < 0 仍可能回本：n* 要跟銷售預估比，不是跟攤提基準比', () => {
  // 攤提基準壓到遠低於銷售預估 → 單台攤提暴增、K 轉負，但實際賣得多，現金仍回本
  gs.saveScenarioGrid('DA', [{
    ScenarioID: SID, Gate: 'GATE F', ScenarioName: '現況', ScenarioType: '現況',
    AmortMonthlyVolume: 5, AmortLifeCycleYears: 1
  }]);
  gs.seedYearVolumeFromSalesMix(SID);
  const r = gs.getPaybackAnalysis(SID);
  assert(r.perUnitProfitK < 0, '這個設定下帳面 K 應為負（測試前提不成立）');
  assert(r.breakEvenUnits > r.lifeCycleUnits, 'n* 應超過攤提基準台數');
  assert(r.withinPlannedVolume === true, 'K 為負，但依銷售預估仍應回得了本');
  assert(r.paybackYear !== null, '應該找得到回本年');

  gs.saveScenarioGrid('DA', [{
    ScenarioID: SID, Gate: 'GATE F', ScenarioName: '現況', ScenarioType: '現況',
    AmortMonthlyVolume: '', AmortLifeCycleYears: ''
  }]);
});

// ---- 年度台數曲線 ----
check('seedYearVolumeFromSalesMix 填滿且合計等於銷售構成推算', () => {
  const grid = gs.seedYearVolumeFromSalesMix(SID);
  assert(grid.rows.length === 10, `應有 10 年，實際 ${grid.rows.length}`);
  close(grid.enteredTotal, grid.salesMixLifeCycleUnits, 0.5, '合計應等於銷售構成推算的 LC 總台數');
  close(grid.diffFromSalesMix, 0, 0.5, '落差應為 0');
});

check('累計現金流收斂：Σ 年度現金流 == m × Σ 年度台數', () => {
  const r = gs.getPaybackAnalysis(SID);
  const sumFlow = r.years.reduce((s, y) => s + y.cashFlow, 0);
  close(sumFlow, r.perUnitCash * r.plannedVolume, 0.5, '年度現金流合計不符');
  const last = r.years[r.years.length - 1];
  close(last.cumulativeCash, sumFlow - r.investment, 0.5, '累計現金流終點不符');
});

check('Σ年度台數 == N 時，累計現金流終點 == N × K', () => {
  const r = gs.getPaybackAnalysis(SID);
  close(r.plannedVolume, r.lifeCycleUnits, 0.5, '這個案例下兩者應相等（測試前提）');
  const last = r.years[r.years.length - 1];
  close(last.cumulativeCash, r.lifeCycleUnits * r.perUnitProfitK, 1, '終點應等於 N × K');
});

check('回本年的內插落點 == 累計台數跨過 n* 的落點', () => {
  const r = gs.getPaybackAnalysis(SID);
  assert(r.paybackYear !== null, '應該找得到回本年');
  const idx = r.years.findIndex(y => y.year === r.paybackYear);
  const prevCum = idx > 0 ? r.years[idx - 1].cumulativeVolume : 0;
  const yearVol = r.years[idx].volume;
  const volFraction = (r.breakEvenUnits - prevCum) / yearVol;
  close(r.paybackYearFraction, volFraction, 1e-6, '現金內插與台數內插應一致');
});

check('台數整體縮放：n* 不變、回本年提前', () => {
  const before = gs.getPaybackAnalysis(SID);
  const grid = gs.getYearVolumeGrid(SID);
  gs.saveYearVolumeGrid(SID, grid.rows.map(r => ({
    RowID: r.RowID, Year: r.Year, AnnualVolume: Number(r.AnnualVolume) * 1.5, Notes: r.Notes
  })));
  const after = gs.getPaybackAnalysis(SID);
  close(after.breakEvenUnits, before.breakEvenUnits, 0.01, '台數縮放不該改變 n*');
  const beforeAt = before.paybackYear + before.paybackYearFraction;
  const afterAt = after.paybackYear + after.paybackYearFraction;
  assert(afterAt < beforeAt, `賣得多應該更早回本：原 ${beforeAt}，現 ${afterAt}`);

  gs.saveYearVolumeGrid(SID, grid.rows.map(r => ({
    RowID: r.RowID, Year: r.Year, AnnualVolume: r.AnnualVolume, Notes: r.Notes
  })));
});

check('年度台數與銷售構成不一致時要示警，且不自動改寫', () => {
  const grid = gs.getYearVolumeGrid(SID);
  const rows = grid.rows.map(r => ({ RowID: r.RowID, Year: r.Year, AnnualVolume: r.AnnualVolume, Notes: r.Notes }));
  rows[0].AnnualVolume = Number(rows[0].AnnualVolume) + 500;
  gs.saveYearVolumeGrid(SID, rows);

  const r = gs.getPaybackAnalysis(SID);
  assert(r.volumeCaveat, '落差 500 台應該要示警');
  const after = gs.getYearVolumeGrid(SID);
  close(after.diffFromSalesMix, 500, 0.5, '不該自動改寫任一邊');

  gs.saveYearVolumeGrid(SID, grid.rows.map(r2 => ({
    RowID: r2.RowID, Year: r2.Year, AnnualVolume: r2.AnnualVolume, Notes: r2.Notes
  })));
});

check('m ≤ 0 時回傳「不回本」而非負數或 Infinity', () => {
  const bad = gs.createScenarioFrom(
    { ScenarioID: '', Gate: 'GATE E', ScenarioName: '賠錢', ScenarioType: '現況', VehicleTypeID: 'DA' }, '', []);
  gs.saveSalesMixGrid(bad.ScenarioID, 'DA', [
    { RowID: '', VehicleID: 'V1', SalesMixPct: 100, MonthlyVolume: 10, LifeCycleYears: 5,
      ListPriceTaxIncl: 100000, ScrapFee: 0, ScrapFeeTaxStatus: '含稅' }
  ]);
  gs.saveCostOfSalesMatrix(bad.ScenarioID, [
    { RowID: '', VehicleID: 'V1', LineCode: 'b1', Amount: 900000, Currency: 'TWD' }
  ]);
  const r = gs.getPaybackAnalysis(bad.ScenarioID);
  assert(r.perUnitCash <= 0, '這個設定下 m 應 ≤ 0（測試前提不成立）');
  assert(r.breakEvenUnits === null, `不回本時 n* 應為 null，實際 ${r.breakEvenUnits}`);
  assert(r.breakEvenRatio === null, '不回本時比值也應為 null');
  assert(r.withinPlannedVolume === false, '不回本時 withinPlannedVolume 應為 false');
  assert(r.paybackYear === null, '不回本時不應有回本年');
});

check('沒有年度台數曲線時不炸，只是沒有時序', () => {
  const noCurve = gs.createScenarioFrom(
    { ScenarioID: '', Gate: 'GATE D', ScenarioName: '沒曲線', ScenarioType: '現況', VehicleTypeID: 'DA' }, '', []);
  gs.saveSalesMixGrid(noCurve.ScenarioID, 'DA', [
    { RowID: '', VehicleID: 'V1', SalesMixPct: 100, MonthlyVolume: 50, LifeCycleYears: 8,
      ListPriceTaxIncl: 1000000, ScrapFee: 0, ScrapFeeTaxStatus: '含稅' }
  ]);
  gs.saveCostOfSalesMatrix(noCurve.ScenarioID, [
    { RowID: '', VehicleID: 'V1', LineCode: 'b1', Amount: 500000, Currency: 'TWD' }
  ]);
  gs.saveDevInvestmentGrid(noCurve.ScenarioID, [
    { RowID: '', Department: '產專室', AssetType: '模具', TargetLineCode: 'b5',
      Amount: 60000000, Currency: 'TWD', ChallengeReductionPct: 0 }
  ]);
  const r = gs.getPaybackAnalysis(noCurve.ScenarioID);
  assert(r.hasYearCurve === false, '應標示沒有年度曲線');
  assert(r.years.length === 0, '不應有年度資料');
  assert(r.breakEvenUnits > 0, '損平台數仍應算得出來（不需要年度曲線）');
  assert(r.paybackYear === null, '沒有曲線就沒有回本年');
});

check('沒有開發投資時 n* = 0（規格 4.5 邊界）', () => {
  const free = gs.createScenarioFrom(
    { ScenarioID: '', Gate: 'GATE C', ScenarioName: '無投資', ScenarioType: '現況', VehicleTypeID: 'DA' }, '', []);
  gs.saveSalesMixGrid(free.ScenarioID, 'DA', [
    { RowID: '', VehicleID: 'V1', SalesMixPct: 100, MonthlyVolume: 50, LifeCycleYears: 8,
      ListPriceTaxIncl: 1000000, ScrapFee: 0, ScrapFeeTaxStatus: '含稅' }
  ]);
  gs.saveCostOfSalesMatrix(free.ScenarioID, [
    { RowID: '', VehicleID: 'V1', LineCode: 'b1', Amount: 500000, Currency: 'TWD' }
  ]);
  const r = gs.getPaybackAnalysis(free.ScenarioID);
  close(r.investment, 0, 0.01, '這個情境不應有開發投資（測試前提）');
  close(r.breakEvenUnits, 0, 0.01, '沒有投資時損平台數應為 0，不是 null');
  close(r.perUnitAmort, 0, 0.01, '沒有投資時單台攤提應為 0');
});

const failed = results.filter(r => !r.ok);
results.forEach(r => console.log(`${r.ok ? '✓' : '✗'} ${r.name}${r.ok ? '' : '\n    ' + r.message}`));
console.log();
if (failed.length) {
  console.log(`${failed.length} / ${results.length} 項失敗`);
  process.exit(1);
}
console.log(`全部 ${results.length} 項通過`);

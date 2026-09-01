/**
 * 這次改動的行為驗證（跑在同一套記憶體版試算表上）：
 *
 *   node tools/verify-features.js
 *
 * 涵蓋：情境帶入、科目代碼自動編號與直接編輯、集團預算匯率移除、
 * 銷貨成本矩陣的加權欄位資料、以及銷貨成本明細不再因為沒填金額就消失。
 */
const { loadAppsScript } = require('./fake-apps-script');

const results = [];
function check(name, fn) {
  try {
    fn();
    results.push({ name: name, ok: true });
  } catch (e) {
    results.push({ name: name, ok: false, message: e.message });
  }
}
function assert(cond, message) { if (!cond) throw new Error(message); }
function assertEqual(actual, expected, message) {
  if (String(actual) !== String(expected)) {
    throw new Error(`${message}：實際 ${actual}，預期 ${expected}`);
  }
}

const gs = loadAppsScript(['Constants.gs', 'Utils.gs', 'DataService.gs', 'CalcEngine.gs', 'SetupSheets.gs']);
gs.setupSpreadsheet();
gs.saveVehicleType({ VehicleTypeID: 'DA' });
gs.saveVehicleType({ VehicleTypeID: 'DE' });
gs.saveVehicle({ VehicleID: 'V1', VehicleTypeID: 'DA', VehicleCode: '3人貨車' });
gs.saveVehicle({ VehicleID: 'V2', VehicleTypeID: 'DA', VehicleCode: '9人客貨車' });
gs.saveVehicle({ VehicleID: 'W1', VehicleTypeID: 'DE', VehicleCode: 'DE車系' });

const base = gs.createScenarioFrom({
  ScenarioID: '', Gate: 'GATE F', ScenarioName: '現況', ScenarioType: '現況', VehicleTypeID: 'DA'
}, '', []);

gs.saveSalesMixGrid(base.ScenarioID, 'DA', [
  { RowID: '', VehicleID: 'V1', SalesMixPct: 40, MonthlyVolume: 40, LifeCycleYears: 10, ListPriceTaxIncl: 1000000, ScrapFee: 3990, ScrapFeeTaxStatus: '含稅' },
  { RowID: '', VehicleID: 'V2', SalesMixPct: 60, MonthlyVolume: 60, LifeCycleYears: 10, ListPriceTaxIncl: 1200000, ScrapFee: 3990, ScrapFeeTaxStatus: '含稅' }
]);
gs.saveCostOfSalesMatrix(base.ScenarioID, [
  { RowID: '', VehicleID: 'V1', LineCode: 'b1', Amount: 400000, Currency: 'TWD' },
  { RowID: '', VehicleID: 'V2', LineCode: 'b1', Amount: 500000, Currency: 'TWD' }
]);
gs.saveDevInvestmentGrid(base.ScenarioID, [
  { RowID: '', Department: '生技部', AssetType: '模具', Amount: 12000000, Currency: 'TWD', ChallengeReductionPct: '' }
]);

check('以既有情境為基礎建立新情境，資料會整批帶過去', () => {
  const target = gs.createScenarioFrom({
    ScenarioID: '', Gate: 'GATE F', ScenarioName: '目標 26/8', ScenarioType: '目標', VehicleTypeID: 'DA'
  }, base.ScenarioID, ['salesmix', 'costofsales', 'devinvestment']);

  assertEqual(gs.getSalesMix(target.ScenarioID).length, 2, '帶入後的銷售構成列數');
  assertEqual(gs.getCostOfSales(target.ScenarioID).length, 2, '帶入後的銷貨成本列數');
  assertEqual(gs.getDevInvestment(target.ScenarioID).length, 1, '帶入後的開發總投列數');
  // 來源情境不能被動到
  assertEqual(gs.getSalesMix(base.ScenarioID).length, 2, '來源情境的銷售構成列數');
  // 挑戰低減目標屬於目標情境自己的假設，帶入後要歸零
  assertEqual(gs.getDevInvestment(target.ScenarioID)[0].ChallengeReductionPct, '', '帶入後的挑戰低減目標');
});

check('不能跨車型帶入（車系對不上會算出看不見的成本）', () => {
  const other = gs.createScenarioFrom({
    ScenarioID: '', Gate: 'GATE F', ScenarioName: 'DE 現況', ScenarioType: '現況', VehicleTypeID: 'DE'
  }, '', []);
  let threw = '';
  try { gs.copyScenarioData(base.ScenarioID, other.ScenarioID, ['salesmix']); }
  catch (e) { threw = e.message; }
  assert(threw.indexOf('只能從同一個車型') === 0, '應該擋下跨車型帶入，實際訊息：' + (threw || '(沒有丟錯)'));
});

check('新增科目時代碼自動編流水號', () => {
  const created = gs.addLineItemInline('B', '測試成本項目');
  assertEqual(created.LineCode, 'b15', '自動產生的成本科目代碼');   // b1~b14 已被內建科目用掉
  const created2 = gs.savePLLineItemGrid([{ LineCode: '', LineName: '第二個測試項目', ParentLine: 'E' }])
    .filter(d => d.LineName === '第二個測試項目')[0];
  assertEqual(created2.LineCode, 'd6', '自動產生的費用科目代碼');   // d1~d5 已被內建科目用掉
});

check('科目直接改名/改排序，一次儲存就生效', () => {
  const before = gs.getPLLineItems().filter(d => d.LineCode === 'b15')[0];
  assert(before, '找不到剛新增的 b15');
  gs.savePLLineItemGrid([
    { LineCode: 'b15', LineName: '改過名字的項目', ParentLine: 'B', Category: '成本明細', SortOrder: 26.5 }
  ]);
  const after = gs.getPLLineItems().filter(d => d.LineCode === 'b15')[0];
  assertEqual(after.LineName, '改過名字的項目', '改名後的科目名稱');
  assertEqual(after.SortOrder, 26.5, '改過的排序值');
});

check('結構科目與自動計算科目不可刪除，父科目也改不掉', () => {
  let threw = 0;
  try { gs.deletePLLineItem('B'); } catch (e) { threw++; }
  try { gs.deletePLLineItem('b13'); } catch (e) { threw++; }
  assertEqual(threw, 2, '應該擋下的刪除次數');

  gs.savePLLineItemGrid([{ LineCode: 'b13', LineName: '貨物稅', ParentLine: 'E', SortOrder: 34 }]);
  assertEqual(gs.getPLLineItems().filter(d => d.LineCode === 'b13')[0].ParentLine, 'B',
    '自動計算科目的父科目應維持原值');
});

check('匯率設定只剩現況匯率', () => {
  const grid = gs.getFxGrid(base.ScenarioID);
  assertEqual(grid.paramNames.length, 1, '匯率種類數量');
  assertEqual(grid.paramNames[0], '現況匯率', '唯一的匯率種類');
  assert(gs.DEFAULT_PARAMS['集團預算匯率'] === undefined, '預設參數不應再有集團預算匯率');
});

check('清除未使用的參數會刪掉舊的集團預算匯率資料', () => {
  gs.saveParameterRow({
    ParamID: '', ScenarioID: base.ScenarioID, VehicleID: '',
    ParamName: '集團預算匯率', Currency: 'CNY', Value: 4.5, EffectiveDate: ''
  });
  assertEqual(gs.getParameters(base.ScenarioID).filter(p => p.ParamName === '集團預算匯率').length, 1,
    '清除前的殘留列數');
  gs.removeUnusedParameters();
  assertEqual(gs.getParameters(base.ScenarioID).filter(p => p.ParamName === '集團預算匯率').length, 0,
    '清除後的殘留列數');
});

check('成本矩陣帶出銷售構成比，讓畫面可以算加權平均', () => {
  const matrix = gs.getCostOfSalesMatrix(base.ScenarioID, 'DA');
  assertEqual(matrix.vehicles.length, 2, '車系數量');
  assertEqual(matrix.vehicles[0].SalesMixPct, 40, 'V1 的銷售構成比');
  assertEqual(matrix.vehicles[1].SalesMixPct, 60, 'V2 的銷售構成比');

  // 畫面上的加權平均算法：Σ(金額×構成比) ÷ Σ構成比
  const weighted = (400000 * 40 + 500000 * 60) / 100;
  assertEqual(weighted, 460000, 'b1 材料成本-LP 的加權平均');
});

check('沒填金額的成本科目仍會出現，B 才等於畫面上明細的加總', () => {
  const result = gs.calculatePL(base.ScenarioID, 'V1');
  const codes = result.lines.map(l => l.LineCode);
  ['b3', 'b9', 'b10', 'b11', 'b12'].forEach(code => {
    assert(codes.indexOf(code) !== -1, `沒填金額的 ${code} 也應該列出來`);
  });
  const detailSum = result.lines
    .filter(l => l.ParentLine === 'B')
    .reduce((s, l) => s + l.Amount, 0);
  const b = result.lines.filter(l => l.LineCode === 'B')[0].Amount;
  assert(Math.abs(detailSum - b) < 0.01, `B ${b} 應等於成本明細加總 ${detailSum}`);
});

check('儀表板的小計驗算對正常資料不應報警', () => {
  const cmp = gs.calculateComparison([
    { ScenarioID: base.ScenarioID, VehicleID: 'V1' },
    { ScenarioID: base.ScenarioID, VehicleID: '' }
  ]);
  cmp.columns.forEach(col => {
    assertEqual((col.checks || []).length, 0, `${col.label} 的小計驗算差異數`);
    assert(col.exFactoryPrice > 0, `${col.label} 應該有廠價可以當百分比基準`);
  });
  assert(cmp.lines.some(l => l.isPriceStructure), '應該標示出售價結構科目');
  assert(cmp.lines.some(l => l.isSubtotal), '應該標示出小計科目');
});

const failed = results.filter(r => !r.ok);
results.forEach(r => console.log((r.ok ? '  ✓ ' : '  ✗ ') + r.name + (r.ok ? '' : ' — ' + r.message)));
console.log('');
console.log(failed.length ? `${failed.length} / ${results.length} 項未通過` : `全部 ${results.length} 項通過`);
process.exit(failed.length ? 1 : 0);

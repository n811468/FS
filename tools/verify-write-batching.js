/**
 * 驗證整批寫入(batchWriteRows_)：
 *
 *   node tools/verify-write-batching.js
 *
 * 這支腳本要驗兩件事：
 *   1. 正確性 —— 整段讀一次、整段寫一次，容易犯的錯是「不小心動到不該動的列」。
 *      CostOfSales 這種分頁是所有情境共用同一張表，batchWriteRows_ 會把整張表讀出來
 *      重寫一次，所以最重要的測試是：存某個情境的矩陣，另一個情境放在同一張表裡的列
 *      要原封不動 —— RowID、內容都不能變，不能被誤刪也不能被誤改。
 *      同時驗新增/更新/刪除混在同一批裡都正確、AuditLog 記到的筆數與動作正確。
 *   2. 效能 —— 呼叫次數不能隨格數線性成長。用假的 Sheets 層(tools/fake-apps-script.js)
 *      量真實的 API 呼叫次數，逐格處理的話 55 格大約 330 次呼叫，整批後應該是個位數，
 *      而且格數從 5 格加到 50 格，呼叫次數不該跟著漲 10 倍。
 */
const { loadAppsScript, resetApiCallCounts_, getApiCallCounts_, totalApiCalls_ } = require('./fake-apps-script');

const failures = [];
function assert(cond, message) { if (!cond) failures.push(message); }

const gs = loadAppsScript(['Constants.gs', 'Utils.gs', 'DataService.gs', 'CalcEngine.gs', 'SetupSheets.gs']);
gs.setupSpreadsheet();
gs.saveVehicleType({ VehicleTypeID: 'DA' });
gs.saveVehicle({ VehicleID: 'V1', VehicleTypeID: 'DA', VehicleCode: '3人貨車' });
gs.saveVehicle({ VehicleID: 'V2', VehicleTypeID: 'DA', VehicleCode: '9人客貨車' });

const scA = gs.createScenarioFrom({ ScenarioID: '', Gate: 'GATE F', ScenarioName: 'A', ScenarioType: '現況', VehicleTypeID: 'DA' }, '', []);
const scB = gs.createScenarioFrom({ ScenarioID: '', Gate: 'GATE F', ScenarioName: 'B', ScenarioType: '現況', VehicleTypeID: 'DA' }, '', []);
[scA, scB].forEach(sc => gs.saveSalesMixGrid(sc.ScenarioID, 'DA', [
  { RowID: '', VehicleID: 'V1', SalesMixPct: 40, MonthlyVolume: 40, LifeCycleYears: 10, ListPriceTaxIncl: 1000000, ScrapFee: 3990, ScrapFeeTaxStatus: '含稅' },
  { RowID: '', VehicleID: 'V2', SalesMixPct: 60, MonthlyVolume: 60, LifeCycleYears: 10, ListPriceTaxIncl: 1200000, ScrapFee: 3990, ScrapFeeTaxStatus: '含稅' }
]));

/* ---- 1. 情境 B 先存好一批資料，之後全程只存情境 A，情境 B 的列不該被動到 ---- */
gs.saveCostOfSalesMatrix(scB.ScenarioID, [
  { RowID: '', VehicleID: 'V1', LineCode: 'b1', Amount: 111111, Currency: 'TWD' },
  { RowID: '', VehicleID: 'V2', LineCode: 'b1', Amount: 222222, Currency: 'TWD' }
]);
const bBefore = gs.getCostOfSalesMatrix(scB.ScenarioID, 'DA');
const bRowIdsBefore = { V1: bBefore.values.b1.V1.RowID, V2: bBefore.values.b1.V2.RowID };

gs.saveCostOfSalesMatrix(scA.ScenarioID, [
  { RowID: '', VehicleID: 'V1', LineCode: 'b1', Amount: 400000, Currency: 'TWD' },
  { RowID: '', VehicleID: 'V2', LineCode: 'b1', Amount: 500000, Currency: 'TWD' },
  { RowID: '', VehicleID: 'V1', LineCode: 'b2', Amount: 90000, Currency: 'TWD' }
]);

const bAfter = gs.getCostOfSalesMatrix(scB.ScenarioID, 'DA');
assert(bAfter.values.b1.V1.Amount === 111111, `存情境 A 不該動到情境 B 的資料，實際 ${bAfter.values.b1.V1.Amount}`);
assert(bAfter.values.b1.V2.Amount === 222222, `存情境 A 不該動到情境 B 的資料，實際 ${bAfter.values.b1.V2.Amount}`);
assert(bAfter.values.b1.V1.RowID === bRowIdsBefore.V1, '情境 B 的 RowID 不該因為存了別的情境而改變');
assert(bAfter.values.b1.V2.RowID === bRowIdsBefore.V2, '情境 B 的 RowID 不該因為存了別的情境而改變');

const aAfterFirstSave = gs.getCostOfSalesMatrix(scA.ScenarioID, 'DA');
assert(aAfterFirstSave.values.b1.V1.Amount === 400000, '情境 A 新增的資料應該存進去');
assert(aAfterFirstSave.values.b2.V1.Amount === 90000, '情境 A 新增的資料應該存進去');

/* ---- 2. 同一批裡混新增/更新/刪除 ---- */
const rowIdB1V1 = aAfterFirstSave.values.b1.V1.RowID;
const rowIdB1V2 = aAfterFirstSave.values.b1.V2.RowID;
gs.saveCostOfSalesMatrix(scA.ScenarioID, [
  { RowID: rowIdB1V1, VehicleID: 'V1', LineCode: 'b1', Amount: 450000, Currency: 'TWD' },  // 更新
  { RowID: rowIdB1V2, VehicleID: 'V2', LineCode: 'b1', Amount: '', Currency: 'TWD' },       // 清空 = 刪除
  { RowID: '', VehicleID: 'V2', LineCode: 'b2', Amount: 80000, Currency: 'TWD' }            // 新增
]);
const aAfterMixed = gs.getCostOfSalesMatrix(scA.ScenarioID, 'DA');
assert(aAfterMixed.values.b1.V1.Amount === 450000, `更新應該生效，實際 ${aAfterMixed.values.b1.V1.Amount}`);
assert(aAfterMixed.values.b1.V1.RowID === rowIdB1V1, '更新既有列不該改變它的 RowID');
assert(aAfterMixed.values.b1.V2 === undefined || aAfterMixed.values.b1.V2.Amount === '', '清空的格子應該視同刪除');
assert(aAfterMixed.values.b2.V1.Amount === 90000, '這一批沒提到的舊資料(b2/V1)應該原封不動保留');
assert(aAfterMixed.values.b2.V2.Amount === 80000, '同一批裡的新增應該生效');

// 底層真的刪掉了那一列，不是留著空字串的殘影 —— 直接數 CostOfSales 分頁的列數
const rawRows = gs.sheetToObjects_ ? null : null; // sheetToObjects_ 不是對外函式，改用取資料驗證筆數
const allCostRows = gs.getCostOfSales(''); // 不分情境，取全部
const stillThere = allCostRows.some(r => r.RowID === rowIdB1V2);
assert(!stillThere, '清空後對應的列應該從分頁上真的刪除，不是留著空白列');

/* ---- 3. AuditLog：整批寫入也要留下逐列的稽核紀錄，不是只留一筆「批次」摘要 ---- */
const auditRows = gs.getAuditLogRows ? gs.getAuditLogRows() : null;
// AuditLog 沒有現成的讀取函式，直接用假的 SpreadsheetApp 拿分頁內容
const auditSheet = gs.SpreadsheetApp.getActiveSpreadsheet().getSheetByName('AuditLog');
const auditLastRow = auditSheet.getLastRow();
const auditValues = auditSheet.getRange(2, 1, auditLastRow - 1, 6).getValues();
const costAuditRows = auditValues.filter(r => r[2] === 'CostOfSales');
const insertCount = costAuditRows.filter(r => r[4] === 'INSERT').length;
const updateCount = costAuditRows.filter(r => r[4] === 'UPDATE').length;
const deleteCount = costAuditRows.filter(r => r[4] === 'DELETE').length;
assert(insertCount >= 5, `應該至少有 5 筆 INSERT 稽核紀錄(情境B 2筆+情境A 3筆)，實際 ${insertCount}`);
assert(updateCount >= 1, `應該至少有 1 筆 UPDATE 稽核紀錄，實際 ${updateCount}`);
assert(deleteCount >= 1, `應該至少有 1 筆 DELETE 稽核紀錄，實際 ${deleteCount}`);

/* ---- 4. 效能：呼叫次數要是常數等級，不能隨格數線性成長 ---- */
function saveNCells(sc, n) {
  const cells = [];
  for (let i = 0; i < n; i++) {
    cells.push({ RowID: '', VehicleID: i % 2 === 0 ? 'V1' : 'V2', LineCode: 'b' + (10 + i), Amount: 1000 + i, Currency: 'TWD' });
  }
  resetApiCallCounts_();
  gs.saveCostOfSalesMatrix(sc.ScenarioID, cells);
  return totalApiCalls_();
}
const scSmall = gs.createScenarioFrom({ ScenarioID: '', Gate: 'GATE F', ScenarioName: 'Small', ScenarioType: '現況', VehicleTypeID: 'DA' }, '', []);
gs.saveSalesMixGrid(scSmall.ScenarioID, 'DA', [{ RowID: '', VehicleID: 'V1', SalesMixPct: 100, MonthlyVolume: 100, LifeCycleYears: 10, ListPriceTaxIncl: 1000000, ScrapFee: 0, ScrapFeeTaxStatus: '含稅' }]);
const scLarge = gs.createScenarioFrom({ ScenarioID: '', Gate: 'GATE F', ScenarioName: 'Large', ScenarioType: '現況', VehicleTypeID: 'DA' }, '', []);
gs.saveSalesMixGrid(scLarge.ScenarioID, 'DA', [{ RowID: '', VehicleID: 'V1', SalesMixPct: 100, MonthlyVolume: 100, LifeCycleYears: 10, ListPriceTaxIncl: 1000000, ScrapFee: 0, ScrapFeeTaxStatus: '含稅' }]);

const callsFor5 = saveNCells(scSmall, 5);
const callsFor50 = saveNCells(scLarge, 50);
assert(callsFor5 <= 12, `存 5 格不該超過個位數~十來次 API 呼叫，實際 ${callsFor5}`);
assert(callsFor50 <= callsFor5 + 5, `存 50 格的呼叫次數不該比存 5 格多太多(整批寫入應該是常數等級)，5 格 ${callsFor5} 次、50 格 ${callsFor50} 次`);
assert(callsFor50 < 50, `無論如何都不該退化回「每格一次呼叫」，50 格卻打了 ${callsFor50} 次`);

if (failures.length) {
  console.log(`整批寫入驗證失敗：${failures.length} 項`);
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('整批寫入驗證通過：跨情境隔離、新增/更新/刪除混合、AuditLog 逐筆記錄、呼叫次數不隨格數線性成長皆正確。');
console.log(`  範例：存 5 格 ${callsFor5} 次 API 呼叫、存 50 格 ${callsFor50} 次 API 呼叫（逐格處理原本约需要 5~7 倍格數的呼叫次數）。`);

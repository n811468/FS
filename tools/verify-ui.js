/**
 * 前端渲染的靜態驗證：
 *
 *   node tools/verify-ui.js
 *
 * script.html 只有在瀏覽器裡才跑得到，但裡面產生 HTML 的函式其實是純函式。
 * 這裡把 script.html 的 JS 抽出來、給最小的 document/google 假物件，
 * 再用計算引擎真實算出來的資料呼叫那些函式，檢查產出的表格結構是否正確
 * （欄數、colspan、縮排、% 欄基準），避免版面改壞了卻要部署後才發現。
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { loadAppsScript } = require('./fake-apps-script');

const failures = [];
function assert(cond, message) { if (!cond) failures.push(message); }

/* ---- 1. 用計算引擎算出一份真實的比較結果 ---- */
const gs = loadAppsScript(['Constants.gs', 'Utils.gs', 'DataService.gs', 'CalcEngine.gs', 'SetupSheets.gs']);
gs.setupSpreadsheet();
gs.saveVehicleType({ VehicleTypeID: 'DA' });
gs.saveVehicle({ VehicleID: 'V1', VehicleTypeID: 'DA', VehicleCode: '3人貨車' });
gs.saveVehicle({ VehicleID: 'V2', VehicleTypeID: 'DA', VehicleCode: '9人客貨車' });
const sc = gs.createScenarioFrom({
  ScenarioID: '', Gate: 'GATE F', ScenarioName: '901', ScenarioType: '現況', VehicleTypeID: 'DA'
}, '', []);
gs.saveSalesMixGrid(sc.ScenarioID, 'DA', [
  { RowID: '', VehicleID: 'V1', SalesMixPct: 40, MonthlyVolume: 40, LifeCycleYears: 10, ListPriceTaxIncl: 1000000, MandatoryAccessoryPrice: 10574, ScrapFee: 3990, ScrapFeeTaxStatus: '含稅' },
  { RowID: '', VehicleID: 'V2', SalesMixPct: 60, MonthlyVolume: 60, LifeCycleYears: 10, ListPriceTaxIncl: 1200000, ScrapFee: 3990, ScrapFeeTaxStatus: '含稅' }
]);
gs.saveCostOfSalesMatrix(sc.ScenarioID, [
  { RowID: '', VehicleID: 'V1', LineCode: 'b1', Amount: 400000, Currency: 'TWD' },
  { RowID: '', VehicleID: 'V2', LineCode: 'b1', Amount: 500000, Currency: 'TWD' }
]);
const comparison = gs.calculateComparison([
  { ScenarioID: sc.ScenarioID, VehicleID: 'V1' },
  { ScenarioID: sc.ScenarioID, VehicleID: 'V2' },
  { ScenarioID: sc.ScenarioID, VehicleID: '' }
]);

/* ---- 2. 把 script.html 的 JS 載進來 ---- */
const html = fs.readFileSync(path.join(__dirname, '..', 'apps-script', 'script.html'), 'utf8');
const js = html.replace(/^\s*<script>/, '').replace(/<\/script>\s*$/, '');
const noopEl = {
  innerHTML: '', textContent: '', className: '', value: '', style: {}, options: [],
  querySelector: () => noopEl, querySelectorAll: () => [], insertAdjacentHTML: () => { }, select: () => { }
};
const ctx = {
  console,
  document: { getElementById: () => noopEl, querySelector: () => noopEl, querySelectorAll: () => [] },
  window: { addEventListener: () => { } },
  google: { charts: { load: () => { }, setOnLoadCallback: () => { } }, script: { run: {} } },
  confirm: () => true, alert: () => { }
};
vm.createContext(ctx);
vm.runInContext(js, ctx, { filename: 'script.html' });

// script.html 用 const/let 宣告，這些是 context 的語彙繫結而不是 global 屬性，
// 不能用 ctx.xxx 存取，得在同一個 context 裡再跑一段程式碼才拿得到／改得動。
const api = expr => vm.runInContext(expr, ctx);
ctx.__in = {};   // 要塞進 context 的外部資料先掛在這裡

/* ---- 3. 檢查損益表的結構 ---- */
const countTag = (s, tag) => (s.match(new RegExp('<' + tag + '[\\s>]', 'g')) || []).length;
const cols = comparison.columns;
const lines = comparison.lines;

function checkTable(pctBase, showPriceStructure) {
  api(`pctBase = ${JSON.stringify(pctBase)}`);
  api(`showPriceStructure = ${showPriceStructure}`);
  const label = `pctBase=${pctBase} 售價結構=${showPriceStructure}`;
  const table = api('plTableHtml')(cols, lines);
  const perCol = pctBase === 'none' ? 1 : 2;
  const span = cols.length * perCol + 2;

  assert(table.indexOf('undefined') === -1, `${label}：表格中出現 undefined`);
  assert(table.indexOf('[object Object]') === -1, `${label}：表格中出現 [object Object]`);

  // 區段標題列的 colspan 要剛好蓋滿整張表
  const spans = (table.match(/colspan="(\d+)"/g) || []).map(m => Number(m.match(/\d+/)[0]));
  const sectionSpans = spans.filter(n => n > 2);
  assert(sectionSpans.length > 0, `${label}：找不到區段標題列`);
  sectionSpans.forEach(n => assert(n === span, `${label}：區段列 colspan ${n} 應為 ${span}`));

  // 每一列的儲存格數 = 科目 + 項目 + 各比較欄位
  const bodyRows = table.split('<tbody>')[1].split('</tbody>')[0]
    .split('<tr').slice(1).filter(r => r.indexOf('class="section"') === -1);
  bodyRows.forEach(row => {
    const tds = countTag(row, 'td');
    assert(tds === span, `${label}：資料列的儲存格數為 ${tds}，應為 ${span}`);
  });

  // 科目代碼與名稱是兩個儲存格，所以找代碼欄本身
  const priceRowShown = table.indexOf('<td class="code">P8</td>') !== -1;
  assert(priceRowShown === showPriceStructure, `${label}：售價結構的顯示狀態不正確`);

  // 明細科目要縮排、小計要反白
  assert(table.indexOf('class="detail"') !== -1, `${label}：成本明細列應該帶 detail 樣式`);
  assert(table.indexOf('<tr class="subtotal">') !== -1, `${label}：小計列應該帶 subtotal 樣式`);
  return table;
}

const tableExFactory = checkTable('exfactory', true);
checkTable('revenue', true);
checkTable('none', false);

/* ---- 4. % 欄的基準要真的不同（這份資料有強配件，廠價 ≠ 收入） ---- */
api("pctBase = 'exfactory'");
const col0 = cols[0];
assert(Math.abs(col0.revenue - col0.exFactoryPrice) > 1,
  '測試資料應該要有強配收入，才能分辨兩種百分比基準');
const pctEx = api('pctCellHtml')(col0.amounts.B, col0);
api("pctBase = 'revenue'");
const pctRev = api('pctCellHtml')(col0.amounts.B, col0);
assert(pctEx !== pctRev, '切換 % 基準後銷貨成本的百分比應該要改變');
const expectedEx = (col0.amounts.B / col0.exFactoryPrice * 100).toFixed(1) + '%';
assert(pctEx.indexOf(expectedEx) !== -1, `對廠價% 應為 ${expectedEx}，實際 ${pctEx}`);

/* ---- 5. 小計驗算與工具列 ---- */
assert(api('subtotalCheckHtml')(cols).indexOf('小計驗算通過') !== -1, '正常資料應顯示驗算通過');
const broken = [{ label: '測試欄', checks: [{ label: 'C = A - B', actual: 1, expected: 2, diff: -1 }] }];
assert(api('subtotalCheckHtml')(broken).indexOf('check-box') !== -1, '有差異時應顯示警告框');

api("chartLineCodes = ['A', 'K']");
const toolbar = api('dashboardToolbarHtml')(lines);
assert(toolbar.indexOf('id="chart-lines"') !== -1, '工具列應該有圖表科目選擇區');
// 原生 multiple select 要按住 Ctrl 才能複選，等於選不動；必須是核取方塊
assert(toolbar.indexOf('multiple') === -1, '圖表科目不該用原生 multiple select');
const chartPicker = toolbar.split('id="chart-lines"')[1].split('</div>')[0];
assert((chartPicker.match(/type="checkbox"/g) || []).length > 10, '每個科目都應該有一個核取方塊');
assert((chartPicker.match(/ checked/g) || []).length === 2, '預設應勾選 A 與 K 兩個科目');
assert(chartPicker.indexOf('onchange="onChartLineToggle') !== -1, '勾選應該即時重畫圖表');
assert(chartPicker.indexOf('value="P8"') === -1, '售價結構科目不應出現在圖表科目選單');

// 勾選/取消要真的改變圖表要畫的科目
api("chartLineCodes = ['A', 'K']");
ctx.__in.noop = () => { };
api('drawCharts = __in.noop');            // 圖表本身在 Node 畫不了，只驗狀態變化
api('onChartLineToggle')('C', true);
assert(api('chartLineCodes').join(',') === 'A,K,C', `勾選後應加入科目，實際 ${api('chartLineCodes')}`);
api('onChartLineToggle')('A', false);
assert(api('chartLineCodes').join(',') === 'K,C', `取消勾選後應移除科目，實際 ${api('chartLineCodes')}`);

/* ---- 6. 主檔表格：主鍵鎖定與自動編號提示 ---- */
const ENTITIES = api('ENTITIES');
const entityCellHtml = api('entityCellHtml');
const entityRowActionHtml = api('entityRowActionHtml');
const lineCfg = ENTITIES.lineitems;
const codeCol = lineCfg.columns.filter(c => c.name === 'LineCode')[0];
const newRowCell = entityCellHtml('lineitems', 0, codeCol, { __existing: false, LineCode: '' });
assert(newRowCell.indexOf('自動編號') !== -1, '新增列的科目代碼應顯示為自動編號');
assert(newRowCell.indexOf('<input') === -1, '科目代碼不該讓使用者手動輸入');

const parentCol = lineCfg.columns.filter(c => c.name === 'ParentLine')[0];
const fixedCell = entityCellHtml('lineitems', 0, parentCol, { __existing: true, LineCode: 'b13', AutoSource: 'RATE_COMMODITY_TAX' });
assert(fixedCell.indexOf('<select') === -1, '自動計算科目的父科目不該可改');
const freeCell = entityCellHtml('lineitems', 0, parentCol, { __existing: true, LineCode: 'b1', AutoSource: '', ParentLine: 'B' });
assert(freeCell.indexOf('<select') !== -1, '一般科目的父科目應該可以直接改');
assert(freeCell.indexOf('value="B" selected') !== -1, '父科目下拉應該選中目前的值');

const typeCfg = ENTITIES.vehicletypes;
const idCol = typeCfg.columns[0];
assert(entityCellHtml('vehicletypes', 0, idCol, { __existing: true, VehicleTypeID: 'DA' }).indexOf('<input') === -1,
  '已建立的車型代號應該鎖住');
assert(entityCellHtml('vehicletypes', 0, idCol, { __existing: false, VehicleTypeID: '' }).indexOf('<input') !== -1,
  '新增列的車型代號應該可以輸入');
assert(entityRowActionHtml('lineitems', 0, { __existing: true, LineCode: 'B' }).indexOf('不可刪除') !== -1,
  '結構科目不該顯示刪除按鈕');

/* ---- 6b. 開發總投：每一列都看得到自己會攤到哪個損益科目 ---- */
gs.saveDevInvestmentGrid(sc.ScenarioID, [
  { RowID: '', Department: '大陸廠', AssetType: '費用-BASE廠', Amount: 8000, Currency: 'TWD' }
]);
ctx.__in.devSummary = gs.getDevInvestmentSummary(sc.ScenarioID);
api('devSummary = __in.devSummary');
const devTargetLabel = api('devTargetLabel');
assert(devTargetLabel('費用-BASE廠').indexOf('f4') === 0,
  `費用-BASE廠 應顯示落點 f4，實際 ${devTargetLabel('費用-BASE廠')}`);
assert(devTargetLabel('費用-CMC').indexOf('f3') === 0,
  `費用-CMC 應顯示落點 f3，實際 ${devTargetLabel('費用-CMC')}`);
assert(devTargetLabel('模具').indexOf('b5') === 0, '模具應顯示落點 b5');
assert(devTargetLabel('').indexOf('不會攤提') !== -1, '沒選落點應明講不會攤提');

/* ---- 7. CSV 匯出欄數 ---- */
ctx.__in.comparison = comparison;
api('lastComparison = __in.comparison');
api("pctBase = 'exfactory'");
api('showPriceStructure = true');
let csvHtml = '';
ctx.document.getElementById = () => ({
  style: {}, set innerHTML(v) { csvHtml = v; }, get innerHTML() { return csvHtml; },
  querySelector: () => ({ select: () => { } })
});
api('showComparisonCsv')();
// CSV 內容是用 esc() 轉義後才塞進 textarea 的（科目名稱可能含 & < >），比對前要還原
const csvBody = csvHtml.split('<textarea class="csv-box">')[1].split('</textarea>')[0]
  .replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');
const csvRows = csvBody.split('\n');
const headerCells = csvRows[0].split('","').length;
assert(headerCells === 2 + cols.length * 2, `CSV 標題列應有 ${2 + cols.length * 2} 欄，實際 ${headerCells}`);
csvRows.forEach((r, i) => {
  const n = r.split('","').length;
  assert(n === headerCells, `CSV 第 ${i + 1} 列有 ${n} 欄，應為 ${headerCells}`);
});

if (failures.length) {
  console.log(`前端驗證失敗：${failures.length} 項`);
  failures.forEach(f => console.log('  ✗ ' + f));
  process.exit(1);
}
console.log('前端驗證通過：損益表結構、% 基準、小計警示、主檔表格鎖定與 CSV 欄數皆正確。');
console.log('');
console.log('損益表前 12 列的產出片段：');
console.log(tableExFactory.split('<tr').slice(0, 13).join('<tr').replace(/\n\s+/g, ' '));

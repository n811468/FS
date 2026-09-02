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
// draw*() 函式常常對好幾個不同 id 的元素各自設 innerHTML(工具列/表格分開設定)，
// 單一共用的 noopEl 會讓後面的賦值蓋掉前面的內容，測試就讀不到工具列那段 HTML。
// 這裡改成依 id 各自存一份，才能個別檢查每個區塊實際產生的內容。
const elById_ = {};
function elFor_(id) {
  if (!elById_[id]) {
    elById_[id] = Object.assign({}, noopEl, { innerHTML: '' });
  }
  return elById_[id];
}
// google.script.run 呼叫鏈(withSuccessHandler().withFailureHandler().任何RPC函式())在 Node 裡沒有
// 真的後端可以回應，這裡用一個「呼叫什麼都回傳自己」的 Proxy 接住整條鏈，讓 draw*/render* 這類
// 會觸發 google.script.run 的函式在測試裡也能正常跑完，不會因為 run 是空物件而丟例外。
const scriptRunStub = new Proxy(() => scriptRunStub, { get: () => scriptRunStub });
const ctx = {
  console,
  document: { getElementById: id => elFor_(id), querySelector: () => noopEl, querySelectorAll: () => [] },
  window: { addEventListener: () => { } },
  google: { charts: { load: () => { }, setOnLoadCallback: () => { } }, script: { run: scriptRunStub } },
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
  const span = cols.length * perCol + 1;

  assert(table.indexOf('undefined') === -1, `${label}：表格中出現 undefined`);
  assert(table.indexOf('[object Object]') === -1, `${label}：表格中出現 [object Object]`);

  // 區段標題列的 colspan 要剛好蓋滿整張表
  const spans = (table.match(/colspan="(\d+)"/g) || []).map(m => Number(m.match(/\d+/)[0]));
  const sectionSpans = spans.filter(n => n > 2);
  assert(sectionSpans.length > 0, `${label}：找不到區段標題列`);
  sectionSpans.forEach(n => assert(n === span, `${label}：區段列 colspan ${n} 應為 ${span}`));

  // 每一列的儲存格數 = 項目(不含科目代碼) + 各比較欄位
  const bodyRows = table.split('<tbody>')[1].split('</tbody>')[0]
    .split('<tr').slice(1).filter(r => r.indexOf('class="section"') === -1);
  bodyRows.forEach(row => {
    const tds = countTag(row, 'td');
    assert(tds === span, `${label}：資料列的儲存格數為 ${tds}，應為 ${span}`);
  });

  // 科目代碼欄已移除(不利閱讀)，改用售價結構的區段標題判斷有沒有顯示
  // (不能用「廠價(未稅)」字樣本身 —— 貨物稅格子的 hover 提示文字裡也會出現這幾個字)
  const priceRowShown = table.indexOf('class="section"><td colspan') !== -1 && table.indexOf('售價結構（由「銷售構成」') !== -1;
  assert(priceRowShown === showPriceStructure, `${label}：售價結構的顯示狀態不正確`);
  assert(table.indexOf('<td class="code">') === -1, `${label}：不應再出現科目代碼欄`);

  // 明細科目要縮排、小計要反白
  assert(table.indexOf('class="detail"') !== -1, `${label}：成本明細列應該帶 detail 樣式`);
  assert(table.indexOf('<tr class="subtotal">') !== -1, `${label}：小計列應該帶 subtotal 樣式`);
  return table;
}

const tableExFactory = checkTable('exfactory', true);
checkTable('revenue', true);
checkTable('none', false);

/* ---- 3b. 損益表：B/E/G/I 大項可收合，且提示改用 data-tip(不是原生 title) ---- */
api('collapsedGroups = new Set()');
const expandedTable = api('plTableHtml')(cols, lines);
assert(expandedTable.indexOf('class="row-toggle"') !== -1, '大項小計列應該有收合按鈕');
assert(expandedTable.indexOf('aria-expanded="true"') !== -1, '預設應該是展開狀態');
assert(expandedTable.indexOf(' title="') === -1, '公式/自動計算提示不該用原生 title(會被表格的橫向捲動裁切)');
assert((expandedTable.match(/data-tip="/g) || []).length > 0, '公式/自動計算提示應該用 data-tip');
assert(expandedTable.indexOf('class="auto-dot"') !== -1, '自動計算科目應該有提示用的圓點');

api("toggleGroupCollapse('B')");
assert(api('collapsedGroups').has('B'), '收合後 collapsedGroups 應該記得 B 已收合');
const collapsedTable = api('plTableHtml')(cols, lines);
assert(collapsedTable.indexOf('aria-expanded="false"') !== -1, '收合後按鈕狀態應該變成 false');
const collapsedDetailRows = collapsedTable.split('<tbody>')[1].split('</tbody>')[0]
  .split('<tr').slice(1).filter(r => r.indexOf('class="detail"') !== -1 && r.indexOf(' hidden') !== -1);
assert(collapsedDetailRows.length > 0, 'B 收合後，B 底下的明細列應該帶 hidden 屬性');
api("toggleGroupCollapse('B')"); // 復原，避免影響後面的測試
assert(!api('collapsedGroups').has('B'), '再次點擊應該恢復展開');

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
const toolbar = api('dashboardToolbarHtml')();
assert(toolbar.indexOf('id="chart-lines"') === -1, '% 基準工具列不該再混著圖表科目選擇區(已移到圖表旁邊)');
const chartSection = api('chartSectionHtml')(cols, lines);
assert(chartSection.indexOf('id="chart-lines"') !== -1, '圖表區塊應該有科目選擇區');
assert(chartSection.indexOf('id="chart-compare"') !== -1, '圖表區塊應該跟科目選擇區放在一起');
// 原生 multiple select 要按住 Ctrl 才能複選，等於選不動；必須是核取方塊
assert(chartSection.indexOf('multiple') === -1, '圖表科目不該用原生 multiple select');
const chartPicker = chartSection.split('id="chart-lines"')[1].split('</div>')[0];
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

/* ---- 6b. 開發總投：攤提落點直接選損益科目，畫面上不出現科目代碼 ---- */
gs.saveDevInvestmentGrid(sc.ScenarioID, [
  { RowID: '', Department: '大陸廠', TargetLineCode: 'f4', Amount: 8000, Currency: 'TWD' }
]);
const devSummary = gs.getDevInvestmentSummary(sc.ScenarioID);
assert(devSummary.rows[0].TargetLineCode === 'f4', '存檔後攤提落點應為 f4');
assert((devSummary.targetOptions || []).some(o => o.value === 'f4'), '落點選項應包含 f4');
assert((devSummary.targetOptions || []).every(o => !/^[a-z]\d/.test(o.label)),
  '落點選項的顯示名稱不該以科目代碼開頭');
ctx.__in.devSummary = devSummary;
api('devSummary = __in.devSummary');
api('devRows = __in.devSummary.rows.map(r => Object.assign({}, r))');
api('drawDevGrid')();
assert(elFor_('grid-devinvestment').innerHTML.indexOf('value="f4" selected') !== -1,
  '目前選取的攤提落點應該在下拉選單中被選中');
assert(elFor_('toolbar-devinvestment').innerHTML.indexOf('新增攤提科目') !== -1,
  '應該有新增攤提科目的入口');
// f4 屬於「費用」大類，大類下拉應該自動選中「費用」，且落點選單只列出費用大類底下的選項(f3/f4)
const devGridHtml = elFor_('grid-devinvestment').innerHTML;
assert(devGridHtml.indexOf('value="費用" selected') !== -1, '大類下拉應該依目前落點自動選中「費用」');
assert(devGridHtml.indexOf('value="b5"') === -1, '費用大類篩選後不該出現模具(b5)這個選項');

// 大類下拉本身：切換大類要能清空不屬於新大類的落點、並只顯示 DEV_AMORT_CATEGORIES 三個大類
const categoryOptions = api('DEV_AMORT_CATEGORIES');
assert(categoryOptions.join(',') === '設備,模具,費用', '大類應該固定是設備/模具/費用三個');
api("onDevCategoryChange(0, '模具')");
assert(api('devRows')[0].TargetLineCode === '', '切到不含原落點的大類後，原本選的落點應該被清空');

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

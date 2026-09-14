/**
 * 本機預覽伺服器：不用部署到 Apps Script 就能在瀏覽器打開整個前端。
 *
 *   node tools/dev-server.js            # http://localhost:8787
 *   PORT=9000 node tools/dev-server.js
 *
 * 做法：用 tools/fake-apps-script.js 的記憶體版試算表把 apps-script/*.gs 跑起來，
 * 灌一組示範資料(Gate F 現況 + 目標情境、另一個車型)，然後把 index.html 的
 * `<?!= include('style'); ?>` 這類樣板語法替換成實際檔案內容，並補上一個假的
 * `google.script.run`：前端呼叫什麼後端函式，就 POST /rpc 到這裡、由 Node 端的 .gs 執行後回傳。
 *
 * 前端 script.html / style.html 完全是原檔，不需要為了本機預覽另外改寫；
 * 每次重新整理頁面都會重新讀檔，改完前端存檔、按 F5 就看得到。
 * 資料只存在記憶體，重啟伺服器就回到示範資料。
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { loadAppsScript } = require('./fake-apps-script');
const gatef = require('./verify-gatef');

const ROOT = path.join(__dirname, '..', 'apps-script');
const PORT = Number(process.env.PORT) || 8787;

/* ---- 示範資料：Gate F 現況(來自驗算腳本)、由它衍生的目標情境、再加一個別的車型 ---- */
/**
 * 年度台數曲線：回本分析要有時序才畫得出 J 曲線。
 * 做成爬坡→高原→衰退的形狀(而不是每年一樣)，才看得出回本點落在哪一年；
 * 總量對齊銷售構成推算值，否則畫面上會一直掛著「與銷售構成不符」的提醒。
 */
function seedYearCurve(gs, scenarioId) {
  const grid = gs.getYearVolumeGrid(scenarioId);
  if (!grid.rows.length) return;
  const shape = [0.5, 1.0, 1.25, 1.3, 1.2, 1.1, 1.0, 0.9, 0.8, 0.65, 0.5, 0.4];
  const monthly = gs.getSalesMix(scenarioId).reduce((sum, r) => sum + (Number(r.MonthlyVolume) || 0), 0);
  const raw = grid.rows.map((r, i) => (shape[i] === undefined ? 1 : shape[i]) * monthly * 12);
  const total = raw.reduce((a, b) => a + b, 0);
  const scale = total > 0 ? grid.salesMixLifeCycleUnits / total : 1;
  gs.saveYearVolumeGrid(scenarioId, grid.rows.map((r, i) => ({
    RowID: r.RowID, Year: r.Year, AnnualVolume: Math.round(raw[i] * scale), Notes: ''
  })));
}

function seedDemoData() {
  const gs = loadAppsScript(['Constants.gs', 'Utils.gs', 'DataService.gs', 'CalcEngine.gs', 'SetupSheets.gs']);
  const baselineId = gatef.buildScenario(gs);

  // 目標情境：整批帶入現況資料，再改幾個數字讓兩個情境看得出差異
  const target = gs.createScenarioFrom({
    ScenarioID: '', Gate: 'GATE F', ScenarioName: '901 目標', ScenarioType: '目標',
    VehicleTypeID: 'DA', CreatedDate: '2026-08-15', Notes: '示範：材料成本 -3%、開發總投低減 15%'
  }, baselineId, []);
  const targetId = target.ScenarioID;
  const cost = gs.getCostOfSalesMatrix(targetId, 'DA');
  const cells = [];
  Object.keys(cost.values).forEach(code => {
    Object.keys(cost.values[code]).forEach(vehicleId => {
      const cell = cost.values[code][vehicleId];
      const amount = Number(cell.Amount) || 0;
      cells.push({ RowID: cell.RowID || '', VehicleID: vehicleId, LineCode: code,
        Amount: code === 'b1' ? Math.round(amount * 0.97) : amount, Currency: cell.Currency || 'TWD', Notes: '' });
    });
  });
  gs.saveCostOfSalesMatrix(targetId, cells);
  const dev = gs.getDevInvestmentSummary(targetId);
  gs.saveDevInvestmentGrid(targetId, dev.rows.map(r => Object.assign({}, r, { ChallengeReductionPct: 15 })));

  seedYearCurve(gs, baselineId);
  seedYearCurve(gs, targetId);

  // 另一個車型：只有一個車系、售價與成本都不同，用來看跨車型並排比較
  gs.saveVehicleType({ VehicleTypeID: 'DE', Notes: '示範車型' });
  gs.saveVehicle({ VehicleID: 'DE1', VehicleTypeID: 'DE', VehicleCode: '5人休旅' });
  const de = gs.createScenarioFrom({
    ScenarioID: '', Gate: 'GATE E', ScenarioName: '1015', ScenarioType: '現況', VehicleTypeID: 'DE', CreatedDate: '2026-08-20'
  }, '', []);
  gs.saveSalesMixGrid(de.ScenarioID, 'DE', [
    { RowID: '', VehicleID: 'DE1', SalesMixPct: 100, MonthlyVolume: 300, LifeCycleYears: 8,
      ListPriceTaxIncl: 1450000, MandatoryAccessoryPrice: 20000, ScrapFee: 3990, ScrapFeeTaxStatus: '含稅' }
  ]);
  gs.saveFxGrid(de.ScenarioID, [{ ParamID: '', Currency: 'JPY', ParamName: '現況匯率', Value: 0.22 }]);
  gs.saveCostOfSalesMatrix(de.ScenarioID, [
    { RowID: '', VehicleID: 'DE1', LineCode: 'b1', Amount: 650000, Currency: 'TWD' },
    // KD 件以日圓計價(實務上進口件多半如此)，匯率敏感度才有東西可看
    { RowID: '', VehicleID: 'DE1', LineCode: 'b2', Amount: 950000, Currency: 'JPY' },
    { RowID: '', VehicleID: 'DE1', LineCode: 'b6', Amount: 21000, Currency: 'TWD' },
    { RowID: '', VehicleID: 'DE1', LineCode: 'b7', Amount: 33000, Currency: 'TWD' }
  ]);
  // DA 的 Gate F 實際數字是賠錢的(B > A)，m < 0 所以永遠不回本 ——
  // 那是真實資料、也是「不回本」畫面的好例子，但看不到 J 曲線。
  // DE 給它開發總投與外幣成本，才示範得到回本點與匯率敏感度。
  gs.saveDevInvestmentGrid(de.ScenarioID, [
    { RowID: '', Department: '產專室', AssetType: '模具', TargetLineCode: 'b5',
      Amount: 1600000000, Currency: 'TWD', ChallengeReductionPct: 0, SortOrder: 1 },
    { RowID: '', Department: 'BASE廠開發費', AssetType: '費用-BASE廠', TargetLineCode: 'f4',
      Amount: 180000000, Currency: 'JPY', ChallengeReductionPct: 0, SortOrder: 2 }
  ]);
  gs.saveOperatingExpenseMatrix(de.ScenarioID, [
    { RowID: '', VehicleID: 'DE1', LineCode: 'd1', Amount: 8000 },
    { RowID: '', VehicleID: 'DE1', LineCode: 'd2', Amount: 25000 },
    { RowID: '', VehicleID: 'DE1', LineCode: 'h1', Amount: 45000 }
  ]);
  seedYearCurve(gs, de.ScenarioID);
  return gs;
}

/* ---- 樣板：把 <?!= include('xxx'); ?> 換成檔案內容，再塞進假的 google.script.run ---- */
const RUN_STUB = `
<script>
  // 本機預覽用的 google.script.run 替身：呼叫鏈跟真的一樣，實際是 POST /rpc 給 dev-server
  window.google = window.google || {};
  google.script = {
    run: new Proxy({}, {
      get(_, fn) {
        const state = { ok: r => r, fail: e => console.error(e) };
        const chain = new Proxy({}, {
          get(_, name) {
            if (name === 'withSuccessHandler') return h => { state.ok = h; return chain; };
            if (name === 'withFailureHandler') return h => { state.fail = h; return chain; };
            if (name === 'withUserObject') return () => chain;
            return (...args) => {
              fetch('/rpc', { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fn: name, args }) })
                .then(r => r.json())
                .then(res => { if (res.error) state.fail(new Error(res.error)); else state.ok(res.result); })
                .catch(err => state.fail(err));
            };
          }
        });
        return chain[fn];
      }
    }),
    host: { close() { } }
  };
</script>`;

function renderIndex() {
  let html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  html = html.replace(/<\?!=\s*include\('([^']+)'\);?\s*\?>/g, (m, name) =>
    fs.readFileSync(path.join(ROOT, name + '.html'), 'utf8'));
  // 假的 google.script.run 要在 script.html 之前就位
  return html.replace('<body>', '<body>' + RUN_STUB);
}

function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => resolve(body));
  });
}

function start() {
  let gs = seedDemoData();
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && (req.url === '/' || req.url.indexOf('/?') === 0)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderIndex());
      return;
    }
    if (req.method === 'POST' && req.url === '/reset') {
      gs = seedDemoData();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
      return;
    }
    if (req.method === 'POST' && req.url === '/rpc') {
      let payload;
      try {
        payload = JSON.parse(await readBody(req));
        if (typeof gs[payload.fn] !== 'function' || /_$/.test(payload.fn)) {
          throw new Error('沒有這個後端函式：' + payload.fn);
        }
        // 模擬 google.script.run：每次呼叫都是新的執行，單次執行內的快取要清掉
        gs.SHEET_CACHE_ = {};
        gs.resetCalcMemo_();
        const result = gs[payload.fn].apply(null, payload.args || []);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ result: result === undefined ? null : result }));
      } catch (e) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: e && e.message ? e.message : String(e) }));
      }
      return;
    }
    res.writeHead(404); res.end('not found');
  });
  server.listen(PORT, () => {
    console.log(`本機預覽：http://localhost:${PORT}  （示範資料在記憶體，POST /reset 可重灌）`);
  });
  return server;
}

if (require.main === module) start();
module.exports = { start, seedDemoData, renderIndex };

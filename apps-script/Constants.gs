/**
 * 分頁名稱、欄位定義、固定科目表。
 * 個人使用版本：無登入權限控管、無情境鎖定機制，部門/科目允許自由新增。
 */

var SHEETS = {
  VEHICLE_TYPES: 'VehicleTypes',
  VEHICLES: 'Vehicles',
  SCENARIOS: 'Scenarios',
  SALES_MIX: 'SalesMix',
  MATERIAL_COST: 'MaterialCost',
  DEV_INVESTMENT: 'DevInvestment',
  OPERATING_EXPENSE: 'OperatingExpense',
  PARAMETERS: 'Parameters',
  PL_LINE_ITEMS: 'PLLineItems',
  PL_RESULT: 'PLResult'
};

// 每張表的欄位順序，同時作為 Sheet 標題列與 Apps Script 讀寫時的欄位對應。
// 車型階層：VehicleTypes(車型，如 DA) 為上層主檔，Vehicles(車系，如 3人貨車) 為下層，
// 需先在「車型主檔」選擇/建立車型，才能在「車系設定」底下新增車系。
var SCHEMA = {
  VehicleTypes: ['VehicleTypeID', 'VehicleTypeName', 'Notes'],
  Vehicles: ['VehicleID', 'VehicleTypeID', 'VehicleCode', 'Notes'],
  Scenarios: ['ScenarioID', 'ScenarioName', 'VehicleTypeID', 'BaseScenarioID', 'CreatedBy', 'CreatedDate', 'Notes'],
  SalesMix: ['RowID', 'ScenarioID', 'VehicleID', 'SalesMixPct', 'MonthlyVolume', 'LifeCycleYears',
    'ListPriceTaxIncl', 'MandatoryAccessoryPrice', 'ScrapFee', 'ScrapFeeTaxStatus', 'EffectiveDate', 'Notes'],
  MaterialCost: ['RowID', 'ScenarioID', 'VehicleID', 'CostCategory', 'LineCode',
    'Amount', 'Currency', 'ExchangeRate', 'Source', 'EffectiveDate'],
  DevInvestment: ['RowID', 'ScenarioID', 'Department', 'AssetType', 'TNCAPFlag',
    'Amount', 'ChallengeReductionPct', 'Notes', 'EffectiveDate'],
  OperatingExpense: ['RowID', 'ScenarioID', 'VehicleID', 'LineCode', 'Amount', 'Notes', 'EffectiveDate'],
  Parameters: ['ParamID', 'ScenarioID', 'VehicleID', 'ParamName', 'Value', 'EffectiveDate'],
  PLLineItems: ['LineCode', 'LineName', 'ParentLine', 'Category', 'SortOrder'],
  PLResult: ['ResultID', 'ScenarioID', 'VehicleID', 'LineCode', 'Amount', 'PctOfRevenue', 'CalcTimestamp']
};

// 廢車處理費稅別選項：讓損益試算全程稅別口徑一致(一律換算為含稅金額後再從零售價扣除)。
var SCRAP_FEE_TAX_STATUS = ['含稅', '未稅'];

// Parameters 依用途分兩組管理：稅務/費用比率 vs 匯率設定(對應「參數設定」頁面拆分需求)。
var TAX_RATE_PARAM_NAMES = ['營業稅率', '銷售佣金率', '季Margin率', '貨物稅率'];
var FX_PARAM_NAMES = ['集團預算匯率', '現況匯率'];

// 材料成本 CostCategory -> B 科目代碼對應（銷貨成本 b1~b13）
var MATERIAL_COST_LINE_MAP = {
  '材料成本-LP': 'b1',
  '材料成本-KD': 'b2',
  '內陸運雜': 'b2',
  '強配成本': 'b3',
  '一般材料': 'b4',
  '模具費用': 'b5',
  '直接人工': 'b6',
  '製造費用': 'b7',
  '新增專屬設備': 'b8',
  '技酬金': 'b9',
  '水平配件': 'b10',
  '防鏽': 'b11',
  '廢棄物處理及包材': 'b12',
  '貨物稅': 'b13'
};

// 損益科目鏈（靜態，SetupSheets 會寫入 PLLineItems 分頁）
var PL_LINE_ITEMS = [
  { LineCode: 'A', LineName: '收入(未稅,含強配)', ParentLine: '', Category: '收入', SortOrder: 10 },
  { LineCode: 'B', LineName: '銷貨成本合計', ParentLine: '', Category: '成本', SortOrder: 20 },
  { LineCode: 'b1', LineName: '材料成本-LP', ParentLine: 'B', Category: '成本明細', SortOrder: 21 },
  { LineCode: 'b2', LineName: '材料成本-KD(含內陸運雜)', ParentLine: 'B', Category: '成本明細', SortOrder: 22 },
  { LineCode: 'b3', LineName: '強配成本', ParentLine: 'B', Category: '成本明細', SortOrder: 23 },
  { LineCode: 'b4', LineName: '一般材料', ParentLine: 'B', Category: '成本明細', SortOrder: 24 },
  { LineCode: 'b5', LineName: '模具費用', ParentLine: 'B', Category: '成本明細', SortOrder: 25 },
  { LineCode: 'b6', LineName: '直接人工', ParentLine: 'B', Category: '成本明細', SortOrder: 26 },
  { LineCode: 'b7', LineName: '製造費用', ParentLine: 'B', Category: '成本明細', SortOrder: 27 },
  { LineCode: 'b8', LineName: '新增專屬設備', ParentLine: 'B', Category: '成本明細', SortOrder: 28 },
  { LineCode: 'b9', LineName: '技酬金', ParentLine: 'B', Category: '成本明細', SortOrder: 29 },
  { LineCode: 'b10', LineName: '水平配件', ParentLine: 'B', Category: '成本明細', SortOrder: 30 },
  { LineCode: 'b11', LineName: '防鏽', ParentLine: 'B', Category: '成本明細', SortOrder: 31 },
  { LineCode: 'b12', LineName: '廢棄物處理及包材', ParentLine: 'B', Category: '成本明細', SortOrder: 32 },
  { LineCode: 'b13', LineName: '貨物稅', ParentLine: 'B', Category: '成本明細', SortOrder: 33 },
  { LineCode: 'C', LineName: '生產毛利(=A-B)', ParentLine: '', Category: '毛利', SortOrder: 40 },
  { LineCode: 'd1', LineName: '廣宣費用', ParentLine: 'E', Category: '費用明細', SortOrder: 41 },
  { LineCode: 'd2', LineName: '促銷', ParentLine: 'E', Category: '費用明細', SortOrder: 42 },
  { LineCode: 'd3', LineName: '批標售', ParentLine: 'E', Category: '費用明細', SortOrder: 43 },
  { LineCode: 'd4', LineName: '0.5%Margin', ParentLine: 'E', Category: '費用明細', SortOrder: 44 },
  { LineCode: 'd5', LineName: '索賠(含索賠取回)', ParentLine: 'E', Category: '費用明細', SortOrder: 45 },
  { LineCode: 'E', LineName: '銷貨毛利(=C-Σd)', ParentLine: '', Category: '毛利', SortOrder: 50 },
  { LineCode: 'f1', LineName: '直接歸屬費用-CMC&SDM', ParentLine: 'G', Category: '費用明細', SortOrder: 51 },
  { LineCode: 'f3', LineName: '車型專案開發費用-CMC(單台攤提)', ParentLine: 'G', Category: '費用明細', SortOrder: 52 },
  { LineCode: 'f4', LineName: '車型專案開發費用-BASE廠(單台攤提)', ParentLine: 'G', Category: '費用明細', SortOrder: 53 },
  { LineCode: 'G', LineName: '產品貢獻(=E-Σf)', ParentLine: '', Category: '貢獻', SortOrder: 60 },
  { LineCode: 'h1', LineName: '固定營業費用-CMC&SDM', ParentLine: 'I', Category: '費用明細', SortOrder: 61 },
  { LineCode: 'h3', LineName: '品牌廣宣費用', ParentLine: 'I', Category: '費用明細', SortOrder: 62 },
  { LineCode: 'h4', LineName: '特別加發', ParentLine: 'I', Category: '費用明細', SortOrder: 63 },
  { LineCode: 'I', LineName: '營業淨利(未扣前瞻)(=G-Σh)', ParentLine: '', Category: '淨利', SortOrder: 70 },
  { LineCode: 'J', LineName: '前瞻費用', ParentLine: '', Category: '費用', SortOrder: 71 },
  { LineCode: 'K', LineName: '營業淨利(=I-J)', ParentLine: '', Category: '淨利', SortOrder: 80 }
];

// 全域預設參數（Parameters 分頁沒有查到對應值時的 fallback）
var DEFAULT_PARAMS = {
  '營業稅率': 0.05,
  '銷售佣金率': 0.06,
  '季Margin率': 0.005,
  '貨物稅率': 0.15
};

var DEV_INVESTMENT_BASE_FACTORY_DEPT = 'BASE廠開發費'; // Department 欄位用這個值標記 f4 的攤提來源

// ChallengeReductionPct 以「百分比數值(0~100)」輸入及儲存(如 15 代表 15%)，
// 與其他比例欄位存小數(0~1)的慣例不同，CalcEngine 換算低減後金額時需 /100。

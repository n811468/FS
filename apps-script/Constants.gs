/**
 * 分頁名稱、欄位定義、損益科目表。
 * 個人使用版本：無登入權限控管、無情境鎖定機制，部門/科目皆允許自由新增與刪除。
 *
 * 兩個重要慣例：
 *   1. 所有「比率」欄位一律以百分比數值(0~100)輸入與儲存，如 5 代表 5%、0.5 代表 0.5%。
 *      CalcEngine 使用時一律 /100（見 CalcEngine.gs 的 pct_()）。匯率不是比率，維持原始數值。
 *   2. 部分科目為「自動計算」科目(AutoSource 有值)，不開放手動輸入，由 CalcEngine 依
 *      比率設定或開發總投攤提自動算出，避免與手動輸入重複計列。
 */

var SHEETS = {
  VEHICLE_TYPES: 'VehicleTypes',
  VEHICLES: 'Vehicles',
  SCENARIOS: 'Scenarios',
  SALES_MIX: 'SalesMix',
  COST_OF_SALES: 'CostOfSales',
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
  Scenarios: ['ScenarioID', 'Gate', 'ScenarioName', 'VehicleTypeID', 'CreatedBy', 'CreatedDate', 'Notes'],
  SalesMix: ['RowID', 'ScenarioID', 'VehicleID', 'SalesMixPct', 'MonthlyVolume', 'LifeCycleYears',
    'ListPriceTaxIncl', 'MandatoryAccessoryPrice', 'ScrapFee', 'ScrapFeeTaxStatus', 'EffectiveDate', 'Notes'],
  CostOfSales: ['RowID', 'ScenarioID', 'VehicleID', 'LineCode', 'Amount', 'Currency',
    'Source', 'Notes', 'EffectiveDate'],
  DevInvestment: ['RowID', 'ScenarioID', 'Department', 'AssetType',
    'Amount', 'ChallengeReductionPct', 'Notes', 'EffectiveDate'],
  OperatingExpense: ['RowID', 'ScenarioID', 'VehicleID', 'LineCode', 'Amount', 'Notes', 'EffectiveDate'],
  Parameters: ['ParamID', 'ScenarioID', 'VehicleID', 'ParamName', 'Value', 'EffectiveDate'],
  PLLineItems: ['LineCode', 'LineName', 'ParentLine', 'Category', 'SortOrder', 'AutoSource'],
  PLResult: ['ResultID', 'ScenarioID', 'VehicleID', 'LineCode', 'Amount', 'PctOfRevenue', 'CalcTimestamp']
};

// 情境代號改用 GATE 別；同一個 GATE 底下可以有多個情境(如 GATE F 現況 / GATE F 目標)，
// 情境名稱由使用者自訂，ScenarioID 由系統自動產生，不需使用者自行編碼。
var GATE_OPTIONS = ['GATE F', 'GATE E', 'GATE D', 'GATE C', 'GATE B', 'GATE A', 'GATE Z'];

// 廢車處理費稅別選項：讓損益試算全程稅別口徑一致(一律換算為含稅金額後再從零售價扣除)。
var SCRAP_FEE_TAX_STATUS = ['含稅', '未稅'];

// 開發總投資產類型：模具/設備攤提進銷貨成本(b5/b8)，費用類攤提為車型專案開發費用(f3/f4)。
var DEV_ASSET_TYPES = ['模具', '設備', '費用'];

// Parameters 依用途分兩組管理：稅務/費用比率(0~100 百分比) vs 匯率設定(原始匯率數值)。
var TAX_RATE_PARAM_NAMES = ['營業稅率', '銷售佣金率', '季Margin率', '貨物稅率'];
var FX_PARAM_NAMES = ['集團預算匯率', '現況匯率'];

// 銷貨成本以外幣登打時，用這個匯率參數換算成台幣（於「匯率設定」頁面維護）。
var COST_FX_PARAM_NAME = '現況匯率';

// 自動計算科目的來源代碼（PLLineItems.AutoSource）。有 AutoSource 的科目不出現在
// 手動輸入頁面的科目下拉選單中，一律由 CalcEngine 依比率或開發總投攤提算出。
var AUTO_SOURCE = {
  PRICE: 'PRICE',                          // 售價結構列，由 SalesMix 售價欄位推算
  DEV_MOLD: 'DEV_MOLD',                    // 開發總投(模具) / LIFE CYCLE 總台數
  DEV_EQUIP: 'DEV_EQUIP',                  // 開發總投(設備) / LIFE CYCLE 總台數
  DEV_EXPENSE_CMC: 'DEV_EXPENSE_CMC',      // 開發總投(費用, CMC) / LIFE CYCLE 總台數
  DEV_EXPENSE_BASE: 'DEV_EXPENSE_BASE',    // 開發總投(費用, BASE廠) / LIFE CYCLE 總台數
  RATE_COMMODITY_TAX: 'RATE_COMMODITY_TAX',// 廠價(未稅) × 貨物稅率
  RATE_QUARTER_MARGIN: 'RATE_QUARTER_MARGIN' // 實際零售價(未稅) × 季Margin率
};

// 結構科目(小計/毛利/淨利)與自動計算科目不允許在「科目設定」頁面刪除，
// 否則損益鏈會斷掉。其餘明細科目(b*/d*/f1/h*/J)皆可自由新增與刪除。
var PROTECTED_LINE_CODES = ['A', 'B', 'C', 'E', 'G', 'I', 'K'];

// 損益科目鏈（SetupSheets 會寫入 PLLineItems 分頁，之後可在「科目設定」頁面增刪明細科目）
var PL_LINE_ITEMS = [
  // ---- 售價結構(P*)：全部由 SalesMix 售價欄位與比率設定推算，讓儀表板看得到中間過程 ----
  { LineCode: 'P1', LineName: '建議零售價(含稅)', ParentLine: '', Category: '售價結構', SortOrder: 1, AutoSource: AUTO_SOURCE.PRICE },
  { LineCode: 'P2', LineName: '廢車處理費(換算含稅)', ParentLine: '', Category: '售價結構', SortOrder: 2, AutoSource: AUTO_SOURCE.PRICE },
  { LineCode: 'P3', LineName: '實際零售價(含稅)(=P1-P2)', ParentLine: '', Category: '售價結構', SortOrder: 3, AutoSource: AUTO_SOURCE.PRICE },
  { LineCode: 'P4', LineName: '營業稅(內含反推)', ParentLine: '', Category: '售價結構', SortOrder: 4, AutoSource: AUTO_SOURCE.PRICE },
  { LineCode: 'P5', LineName: '銷售佣金', ParentLine: '', Category: '售價結構', SortOrder: 5, AutoSource: AUTO_SOURCE.PRICE },
  { LineCode: 'P6', LineName: '實際零售價(未稅)', ParentLine: '', Category: '售價結構', SortOrder: 6, AutoSource: AUTO_SOURCE.PRICE },
  { LineCode: 'P7', LineName: '廠價(未稅)', ParentLine: '', Category: '售價結構', SortOrder: 7, AutoSource: AUTO_SOURCE.PRICE },
  { LineCode: 'P8', LineName: '強配件售價', ParentLine: '', Category: '售價結構', SortOrder: 8, AutoSource: AUTO_SOURCE.PRICE },

  { LineCode: 'A', LineName: '收入(未稅,含強配)', ParentLine: '', Category: '收入', SortOrder: 10, AutoSource: '' },
  { LineCode: 'B', LineName: '銷貨成本合計', ParentLine: '', Category: '成本', SortOrder: 20, AutoSource: '' },
  { LineCode: 'b1', LineName: '材料成本-LP', ParentLine: 'B', Category: '成本明細', SortOrder: 21, AutoSource: '' },
  { LineCode: 'b2', LineName: '材料成本-KD(含內陸運雜)', ParentLine: 'B', Category: '成本明細', SortOrder: 22, AutoSource: '' },
  { LineCode: 'b3', LineName: '強配成本', ParentLine: 'B', Category: '成本明細', SortOrder: 23, AutoSource: '' },
  { LineCode: 'b4', LineName: '一般材料', ParentLine: 'B', Category: '成本明細', SortOrder: 24, AutoSource: '' },
  { LineCode: 'b5', LineName: '模具費用(開發總投/LC總台數)', ParentLine: 'B', Category: '成本明細', SortOrder: 25, AutoSource: AUTO_SOURCE.DEV_MOLD },
  { LineCode: 'b6', LineName: '直接人工', ParentLine: 'B', Category: '成本明細', SortOrder: 26, AutoSource: '' },
  { LineCode: 'b7', LineName: '製造費用', ParentLine: 'B', Category: '成本明細', SortOrder: 27, AutoSource: '' },
  { LineCode: 'b8', LineName: '新增專屬設備(開發總投/LC總台數)', ParentLine: 'B', Category: '成本明細', SortOrder: 28, AutoSource: AUTO_SOURCE.DEV_EQUIP },
  { LineCode: 'b9', LineName: '技酬金', ParentLine: 'B', Category: '成本明細', SortOrder: 29, AutoSource: '' },
  { LineCode: 'b10', LineName: '水平配件', ParentLine: 'B', Category: '成本明細', SortOrder: 30, AutoSource: '' },
  { LineCode: 'b11', LineName: '防鏽', ParentLine: 'B', Category: '成本明細', SortOrder: 31, AutoSource: '' },
  { LineCode: 'b12', LineName: '廢棄物處理及包材', ParentLine: 'B', Category: '成本明細', SortOrder: 32, AutoSource: '' },
  { LineCode: 'b13', LineName: '貨物稅(廠價×貨物稅率)', ParentLine: 'B', Category: '成本明細', SortOrder: 33, AutoSource: AUTO_SOURCE.RATE_COMMODITY_TAX },
  { LineCode: 'C', LineName: '生產毛利(=A-B)', ParentLine: '', Category: '毛利', SortOrder: 40, AutoSource: '' },
  { LineCode: 'd1', LineName: '廣宣費用', ParentLine: 'E', Category: '費用明細', SortOrder: 41, AutoSource: '' },
  { LineCode: 'd2', LineName: '促銷', ParentLine: 'E', Category: '費用明細', SortOrder: 42, AutoSource: '' },
  { LineCode: 'd3', LineName: '批標售', ParentLine: 'E', Category: '費用明細', SortOrder: 43, AutoSource: '' },
  { LineCode: 'd4', LineName: '季Margin(實際零售價未稅×季Margin率)', ParentLine: 'E', Category: '費用明細', SortOrder: 44, AutoSource: AUTO_SOURCE.RATE_QUARTER_MARGIN },
  { LineCode: 'd5', LineName: '索賠(含索賠取回)', ParentLine: 'E', Category: '費用明細', SortOrder: 45, AutoSource: '' },
  { LineCode: 'E', LineName: '銷貨毛利(=C-Σd)', ParentLine: '', Category: '毛利', SortOrder: 50, AutoSource: '' },
  { LineCode: 'f1', LineName: '直接歸屬費用-CMC&SDM', ParentLine: 'G', Category: '費用明細', SortOrder: 51, AutoSource: '' },
  { LineCode: 'f3', LineName: '車型專案開發費用-CMC(開發總投/LC總台數)', ParentLine: 'G', Category: '費用明細', SortOrder: 52, AutoSource: AUTO_SOURCE.DEV_EXPENSE_CMC },
  { LineCode: 'f4', LineName: '車型專案開發費用-BASE廠(開發總投/LC總台數)', ParentLine: 'G', Category: '費用明細', SortOrder: 53, AutoSource: AUTO_SOURCE.DEV_EXPENSE_BASE },
  { LineCode: 'G', LineName: '產品貢獻(=E-Σf)', ParentLine: '', Category: '貢獻', SortOrder: 60, AutoSource: '' },
  { LineCode: 'h1', LineName: '固定營業費用-CMC&SDM', ParentLine: 'I', Category: '費用明細', SortOrder: 61, AutoSource: '' },
  { LineCode: 'h3', LineName: '品牌廣宣費用', ParentLine: 'I', Category: '費用明細', SortOrder: 62, AutoSource: '' },
  { LineCode: 'h4', LineName: '特別加發', ParentLine: 'I', Category: '費用明細', SortOrder: 63, AutoSource: '' },
  { LineCode: 'I', LineName: '營業淨利(未扣前瞻)(=G-Σh)', ParentLine: '', Category: '淨利', SortOrder: 70, AutoSource: '' },
  { LineCode: 'J', LineName: '前瞻費用', ParentLine: '', Category: '費用', SortOrder: 71, AutoSource: '' },
  { LineCode: 'K', LineName: '營業淨利(=I-J)', ParentLine: '', Category: '淨利', SortOrder: 80, AutoSource: '' }
];

// 全域預設參數（Parameters 分頁沒有查到對應值時的 fallback）。
// 比率一律為百分比數值：5 = 5%、0.5 = 0.5%。
var DEFAULT_PARAMS = {
  '營業稅率': 5,
  '銷售佣金率': 6,
  '季Margin率': 0.5,
  '貨物稅率': 15,
  '集團預算匯率': 1,
  '現況匯率': 1
};

var DEV_INVESTMENT_BASE_FACTORY_DEPT = 'BASE廠開發費'; // Department 欄位用這個值標記 f4 的攤提來源

// ChallengeReductionPct 同樣以百分比數值(0~100)輸入及儲存(如 15 代表 15%)。
// 挑戰低減目標屬於情境層級的假設：同一個 GATE 下的「現況」與「目標」情境各自填自己的低減目標，
// 因此不需要額外欄位標記，直接由該情境的 DevInvestment 列決定。

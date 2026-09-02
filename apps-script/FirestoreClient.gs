/**
 * Firestore REST API 用戶端（給 Apps Script 用）。
 *
 * Apps Script 沒有原生的 Firestore SDK，改用服務帳戶(Service Account)簽 JWT 換 OAuth2
 * access token，再直接呼叫 Firestore 的 REST API(v1)。這支檔案只管「怎麼跟 Firestore 講話」，
 * 不管資料模型長什麼樣子 —— 資料模型/欄位對應在後續改寫 DataService.gs 時另外處理。
 *
 * 使用前置作業（見 docs/firestore-migration.md）：
 *   1. Apps Script 專案要連結一個 GCP 專案
 *   2. 該 GCP 專案要啟用 Firestore(Native mode)
 *   3. 建立服務帳戶，賦予 Cloud Datastore User 角色，下載 JSON 金鑰
 *   4. 把金鑰的 project_id / client_email / private_key 存進「指令碼屬性」
 *      (FIRESTORE_PROJECT_ID / FIRESTORE_CLIENT_EMAIL / FIRESTORE_PRIVATE_KEY)
 *
 * access token 效期 1 小時，用 CacheService 存起來，避免每次呼叫都重新簽 JWT 換 token
 * (簽 JWT 本身要跑 RSA 簽章，換 token 又是一次網路來回，兩者都不便宜)。
 */

var FIRESTORE_TOKEN_CACHE_KEY_ = 'firestore_access_token';
var FIRESTORE_TOKEN_SCOPE_ = 'https://www.googleapis.com/auth/datastore';
var FIRESTORE_TOKEN_URL_ = 'https://oauth2.googleapis.com/token';

function firestoreConfig_() {
  var props = PropertiesService.getScriptProperties();
  var projectId = props.getProperty('FIRESTORE_PROJECT_ID');
  var clientEmail = props.getProperty('FIRESTORE_CLIENT_EMAIL');
  var privateKey = props.getProperty('FIRESTORE_PRIVATE_KEY');
  if (!projectId || !clientEmail || !privateKey) {
    throw new Error('尚未設定 Firestore 服務帳戶：請在「指令碼屬性」補上 FIRESTORE_PROJECT_ID / ' +
      'FIRESTORE_CLIENT_EMAIL / FIRESTORE_PRIVATE_KEY（見 docs/firestore-migration.md 的階段 0）。');
  }
  // Script Properties 是純文字欄位，貼 JSON 金鑰裡的 private_key 時常見兩種存法：
  // 原始 PEM(已含真正換行)，或原封不動貼 JSON 字串值(換行變成字面上的兩個字元 \n)，兩種都接受。
  privateKey = privateKey.indexOf('\\n') !== -1 ? privateKey.replace(/\\n/g, '\n') : privateKey;
  return { projectId: projectId, clientEmail: clientEmail, privateKey: privateKey };
}

function firestoreBaseUrl_() {
  var cfg = firestoreConfig_();
  return 'https://firestore.googleapis.com/v1/projects/' + cfg.projectId + '/databases/(default)/documents';
}

/** base64url 編碼：JWT 規格不留 '=' padding，Apps Script 的 base64EncodeWebSafe 會留，要自己去掉 */
function base64UrlEncode_(bytesOrString) {
  var encoded = typeof bytesOrString === 'string'
    ? Utilities.base64EncodeWebSafe(Utilities.newBlob(bytesOrString).getBytes())
    : Utilities.base64EncodeWebSafe(bytesOrString);
  return encoded.replace(/=+$/, '');
}

/**
 * 用服務帳戶簽一份 JWT，跟 Google OAuth2 端點換 access token(RFC 7523 JWT Bearer flow)。
 * 這是 server-to-server 呼叫 Google API 的標準作法，不需要使用者互動登入。
 */
function firestoreSignJwt_(cfg, nowSeconds) {
  var header = { alg: 'RS256', typ: 'JWT' };
  var claim = {
    iss: cfg.clientEmail,
    scope: FIRESTORE_TOKEN_SCOPE_,
    aud: FIRESTORE_TOKEN_URL_,
    iat: nowSeconds,
    exp: nowSeconds + 3600
  };
  var signingInput = base64UrlEncode_(JSON.stringify(header)) + '.' + base64UrlEncode_(JSON.stringify(claim));
  var signatureBytes = Utilities.computeRsaSha256Signature(signingInput, cfg.privateKey);
  return signingInput + '.' + base64UrlEncode_(signatureBytes);
}

function firestoreFetchAccessToken_(cfg) {
  var nowSeconds = Math.floor(Date.now() / 1000);
  var jwt = firestoreSignJwt_(cfg, nowSeconds);
  var resp = UrlFetchApp.fetch(FIRESTORE_TOKEN_URL_, {
    method: 'post',
    contentType: 'application/x-www-form-urlencoded',
    payload: {
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt
    },
    muteHttpExceptions: true
  });
  var body = JSON.parse(resp.getContentText());
  if (resp.getResponseCode() !== 200 || !body.access_token) {
    throw new Error('Firestore 換 access token 失敗：' + resp.getContentText());
  }
  return body;
}

function firestoreAccessToken_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get(FIRESTORE_TOKEN_CACHE_KEY_);
  if (cached) return cached;
  var cfg = firestoreConfig_();
  var token = firestoreFetchAccessToken_(cfg);
  // access token 效期通常 3599 秒，提前 60 秒過期避免邊界卡到「快取還在、但 Google 那邊已經過期」
  var ttl = Math.max(60, (token.expires_in || 3600) - 60);
  cache.put(FIRESTORE_TOKEN_CACHE_KEY_, token.access_token, ttl);
  return token.access_token;
}

/* ---------------- JS 物件 <-> Firestore REST 欄位格式互轉 ---------------- */

/**
 * Firestore REST API 的每個欄位值都要包成 {stringValue:...} / {integerValue:...} 這種型別包裝，
 * 不像一般 JSON 直接寫值。這裡把單純的「扁平物件(字串/數字/布林/null)」轉成那個格式 ——
 * 這個系統的資料表(SalesMix/CostOfSales...)本來就都是扁平欄位，不需要支援巢狀 map/array。
 */
function toFirestoreFields_(obj) {
  var fields = {};
  Object.keys(obj || {}).forEach(function (key) {
    fields[key] = toFirestoreValue_(obj[key]);
  });
  return fields;
}

function toFirestoreValue_(v) {
  if (v === null || v === undefined || v === '') return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (Object.prototype.toString.call(v) === '[object Date]') {
    return { timestampValue: v.toISOString() };
  }
  return { stringValue: String(v) };
}

/** Firestore 文件(含 name/fields) -> 扁平 JS 物件，並把文件 ID(路徑最後一段)補進 idField 指定的欄位 */
function fromFirestoreDocument_(doc, idField) {
  var obj = {};
  var fields = doc.fields || {};
  Object.keys(fields).forEach(function (key) {
    obj[key] = fromFirestoreValue_(fields[key]);
  });
  if (idField && doc.name) {
    var parts = doc.name.split('/');
    obj[idField] = parts[parts.length - 1];
  }
  return obj;
}

function fromFirestoreValue_(value) {
  if (!value) return '';
  if ('stringValue' in value) return value.stringValue;
  if ('integerValue' in value) return Number(value.integerValue);
  if ('doubleValue' in value) return value.doubleValue;
  if ('booleanValue' in value) return value.booleanValue;
  if ('timestampValue' in value) return value.timestampValue;
  if ('nullValue' in value) return '';
  if ('mapValue' in value) {
    var out = {};
    var mf = (value.mapValue && value.mapValue.fields) || {};
    Object.keys(mf).forEach(function (k) { out[k] = fromFirestoreValue_(mf[k]); });
    return out;
  }
  if ('arrayValue' in value) {
    var vals = (value.arrayValue && value.arrayValue.values) || [];
    return vals.map(fromFirestoreValue_);
  }
  return '';
}

/* ---------------- 低階 HTTP 呼叫 ---------------- */

function firestoreRequest_(method, url, payload) {
  var options = {
    method: method,
    contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + firestoreAccessToken_() },
    muteHttpExceptions: true
  };
  if (payload !== undefined) options.payload = JSON.stringify(payload);
  var resp = UrlFetchApp.fetch(url, options);
  var code = resp.getResponseCode();
  var text = resp.getContentText();
  if (code >= 400) {
    throw new Error('Firestore API 錯誤(' + code + ')：' + text + '\n呼叫：' + method + ' ' + url);
  }
  return text ? JSON.parse(text) : null;
}

/* ---------------- CRUD ---------------- */

/** 讀單一文件；不存在回傳 null（而不是丟例外，呼叫端常常要判斷「有沒有這筆」） */
function firestoreGet_(docPath, idField) {
  var url = firestoreBaseUrl_() + '/' + docPath;
  try {
    var doc = firestoreRequest_('get', url);
    return fromFirestoreDocument_(doc, idField);
  } catch (e) {
    if (String(e.message).indexOf('(404)') !== -1) return null;
    throw e;
  }
}

/**
 * 讀整個集合（自動翻頁，Firestore 一次最多回 300 筆左右，交給呼叫端的是攤平後的全部資料）。
 * 對應原本 sheetToObjects_() 讀整張表的用法。
 */
function firestoreListAll_(collectionPath, idField) {
  var url = firestoreBaseUrl_() + '/' + collectionPath + '?pageSize=300';
  var out = [];
  var pageToken = '';
  do {
    var pagedUrl = url + (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
    var resp = firestoreRequest_('get', pagedUrl);
    (resp.documents || []).forEach(function (doc) { out.push(fromFirestoreDocument_(doc, idField)); });
    pageToken = resp.nextPageToken || '';
  } while (pageToken);
  return out;
}

/** 新增一筆、由 Firestore 自動配文件 ID；回傳含 ID 的物件 */
function firestoreCreate_(collectionPath, obj, idField) {
  var url = firestoreBaseUrl_() + '/' + collectionPath;
  var doc = firestoreRequest_('post', url, { fields: toFirestoreFields_(obj) });
  return fromFirestoreDocument_(doc, idField);
}

/** 整份覆蓋寫入指定路徑的文件(不存在就建立)；用在「文件 ID 已知」的情況(如 upsert) */
function firestoreSet_(docPath, obj) {
  var url = firestoreBaseUrl_() + '/' + docPath;
  return firestoreRequest_('patch', url, { fields: toFirestoreFields_(obj) });
}

/**
 * 只更新指定的欄位(其餘欄位維持原樣)，對應原本 upsertRowMerge_() 的「只送出畫面上有的欄位」語意。
 * Firestore 要用 updateMask.fieldPaths 這個 query string 參數逐一列出要動的欄位。
 */
function firestoreUpdateFields_(docPath, obj) {
  var keys = Object.keys(obj || {});
  var mask = keys.map(function (k) { return 'updateMask.fieldPaths=' + encodeURIComponent(k); }).join('&');
  var url = firestoreBaseUrl_() + '/' + docPath + (mask ? '?' + mask : '');
  return firestoreRequest_('patch', url, { fields: toFirestoreFields_(obj) });
}

function firestoreDelete_(docPath) {
  var url = firestoreBaseUrl_() + '/' + docPath;
  firestoreRequest_('delete', url);
}

/**
 * 一次送出多個寫入(建立/更新/刪除混合)，用 Firestore 的 batchWrite 端點。
 * 情境帶入(copyScenarioData)、整批儲存(saveXxxGrid) 這類「一次改很多列」的操作用這個，
 * 比一列一列各發一個 HTTP request 快很多，也不會因為半途出錯留下寫一半的資料。
 * writes: [{ type: 'set'|'delete', path: 'collection/docId', data?: {...} }]
 */
function firestoreBatchWrite_(writes) {
  var base = firestoreBaseUrl_();
  // batchWrite 裡每筆寫入要用完整資源名稱(含 projects/.../documents/...)，
  // 端點本身則是在 .../documents 這一層直接加 ":batchWrite"(不能把 /documents 拿掉，
  // 官方路徑樣板是 {database=projects/*/databases/*}/documents:batchWrite)。
  var cfg = firestoreConfig_();
  var docRoot = 'projects/' + cfg.projectId + '/databases/(default)/documents/';
  var payloadWrites = writes.map(function (w) {
    if (w.type === 'delete') return { delete: docRoot + w.path };
    return { update: { name: docRoot + w.path, fields: toFirestoreFields_(w.data) } };
  });
  var url = base + ':batchWrite';
  return firestoreRequest_('post', url, { writes: payloadWrites });
}

/**
 * FirestoreClient.gs 的離線驗證：
 *
 *   node tools/verify-firestore-client.js
 *
 * 沒有真的連 Firestore（這台機器也不會有你的服務帳戶金鑰），而是用一組測試用的 RSA 金鑰
 * 假扮服務帳戶，把 UrlFetchApp.fetch 換成假回應函式，檢查：
 *   1. 換 token 時簽出來的 JWT 格式對、簽章驗證得過（用測試金鑰的公鑰驗證）
 *   2. access token 換到後會被快取，第二次呼叫不會再打一次換 token 的請求
 *   3. JS 物件 <-> Firestore REST 欄位格式互轉，來回一致
 *   4. 各個 CRUD 函式送出的 HTTP 方法/路徑/內容符合預期
 */
const crypto = require('crypto');
const { loadAppsScript } = require('./fake-apps-script');

const failures = [];
function assert(cond, message) { if (!cond) failures.push(message); }
function assertEqual(actual, expected, label) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) failures.push(`${label}: 預期 ${e}，實際 ${a}`);
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' }
});

const ctx = loadAppsScript(['FirestoreClient.gs']);
ctx.PropertiesService.getScriptProperties()
  .setProperty('FIRESTORE_PROJECT_ID', 'test-project')
  .setProperty('FIRESTORE_CLIENT_EMAIL', 'svc@test-project.iam.gserviceaccount.com')
  .setProperty('FIRESTORE_PRIVATE_KEY', privateKey);

let tokenRequests = 0;
const requests = [];

function base64UrlDecode(s) {
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

ctx.UrlFetchApp = {
  fetch(url, options) {
    requests.push({ url, options });
    if (url === 'https://oauth2.googleapis.com/token') {
      tokenRequests++;
      const jwt = decodeURIComponent(String(options.payload.assertion));
      const [headerB64, claimB64, sigB64] = jwt.split('.');
      const header = JSON.parse(base64UrlDecode(headerB64).toString('utf8'));
      const claim = JSON.parse(base64UrlDecode(claimB64).toString('utf8'));
      assertEqual(header, { alg: 'RS256', typ: 'JWT' }, 'JWT header');
      assert(claim.iss === 'svc@test-project.iam.gserviceaccount.com', 'JWT iss 應為服務帳戶信箱');
      assert(claim.scope === 'https://www.googleapis.com/auth/datastore', 'JWT scope 應為 datastore');
      assert(claim.aud === 'https://oauth2.googleapis.com/token', 'JWT aud 應為 token 端點');
      assert(claim.exp === claim.iat + 3600, 'JWT 效期應為 1 小時');
      const verifier = crypto.createVerify('RSA-SHA256');
      verifier.update(`${headerB64}.${claimB64}`);
      verifier.end();
      const sigValid = verifier.verify(publicKey, base64UrlDecode(sigB64));
      assert(sigValid, 'JWT 簽章應該用測試金鑰的公鑰驗證得過');
      return fakeResponse_(200, { access_token: 'fake-access-token', expires_in: 3599, token_type: 'Bearer' });
    }
    return handleFirestoreRequest_(url, options);
  }
};

function fakeResponse_(code, body) {
  const text = JSON.stringify(body);
  return { getResponseCode: () => code, getContentText: () => text };
}

/* ---- 假的 Firestore REST 端點：只認得測試會用到的幾種呼叫，檢查內容後回固定格式 ---- */
function handleFirestoreRequest_(url, options) {
  const authHeader = options.headers && options.headers.Authorization;
  assertEqual(authHeader, 'Bearer fake-access-token', 'Firestore 呼叫應該帶上剛才換到的 access token');

  if (options.method === 'get' && url.endsWith('/Scenarios/sc1')) {
    return fakeResponse_(200, {
      name: 'projects/test-project/databases/(default)/documents/Scenarios/sc1',
      fields: { ScenarioName: { stringValue: '0901' }, AmortMonthlyVolume: { integerValue: '300' } }
    });
  }
  if (options.method === 'get' && url.indexOf('/Scenarios?pageSize=300') !== -1) {
    return fakeResponse_(200, {
      documents: [
        { name: '.../Scenarios/sc1', fields: { ScenarioName: { stringValue: '0901' } } },
        { name: '.../Scenarios/sc2', fields: { ScenarioName: { stringValue: '0902' } } }
      ]
    });
  }
  if (options.method === 'post' && url.endsWith('/Scenarios')) {
    const sent = JSON.parse(options.payload);
    assertEqual(sent.fields.ScenarioName, { stringValue: '0901' }, 'firestoreCreate_ 應該把字串包成 stringValue');
    return fakeResponse_(200, { name: '.../Scenarios/new-id', fields: sent.fields });
  }
  if (options.method === 'patch' && url.indexOf('/Scenarios/sc1?updateMask') !== -1) {
    const sent = JSON.parse(options.payload);
    assertEqual(sent.fields, { Notes: { stringValue: '測試備註' } }, 'firestoreUpdateFields_ 應該只送出要改的欄位');
    assert(url.indexOf('updateMask.fieldPaths=Notes') !== -1, 'updateMask 應該指定 Notes 欄位');
    return fakeResponse_(200, { name: '.../Scenarios/sc1', fields: sent.fields });
  }
  if (options.method === 'patch' && url.endsWith('/Scenarios/sc1')) {
    const sent = JSON.parse(options.payload);
    assertEqual(sent.fields.ScenarioName, { stringValue: '0901' }, 'firestoreSet_ 應該整份覆蓋，前導零不能被吃掉');
    return fakeResponse_(200, { name: '.../Scenarios/sc1', fields: sent.fields });
  }
  if (options.method === 'delete' && url.endsWith('/Scenarios/sc1')) {
    return fakeResponse_(200, {});
  }
  if (options.method === 'post' && url.endsWith(':runQuery')) {
    const sent = JSON.parse(options.payload);
    assertEqual(sent.structuredQuery.from, [{ collectionId: 'salesMix' }], 'runQuery 應該指定正確的集合');
    assertEqual(sent.structuredQuery.where, {
      fieldFilter: { field: { fieldPath: 'ScenarioID' }, op: 'EQUAL', value: { stringValue: 'sc1' } }
    }, 'runQuery 單一條件應該是 fieldFilter');
    return fakeResponse_(200, [
      { document: { name: '.../salesMix/row1', fields: { ScenarioID: { stringValue: 'sc1' }, VehicleID: { stringValue: 'V1' } } } },
      { document: { name: '.../salesMix/row2', fields: { ScenarioID: { stringValue: 'sc1' }, VehicleID: { stringValue: 'V2' } } } }
    ]);
  }
  if (options.method === 'post' && url.endsWith(':batchWrite')) {
    // 官方路徑樣板是 .../documents:batchWrite，容易誤刪成 .../(default):batchWrite(拿掉 /documents)，
    // 明確斷言完整 URL，避免這種「payload 對、URL 錯」的錯誤又混過去。
    assertEqual(url, 'https://firestore.googleapis.com/v1/projects/test-project/databases/(default)/documents:batchWrite',
      'batchWrite 端點 URL 要保留 /documents');
    const sent = JSON.parse(options.payload);
    assertEqual(sent.writes.length, 2, 'batchWrite 應該送出兩筆寫入');
    assert(!!sent.writes[0].update, '第一筆應該是 update(=set)');
    assert(!!sent.writes[1].delete, '第二筆應該是 delete');
    assertEqual(sent.writes[0].update.name,
      'projects/test-project/databases/(default)/documents/Scenarios/sc1', 'update 應該帶完整資源名稱');
    return fakeResponse_(200, { writeResults: [{}, {}] });
  }
  throw new Error('未預期的假 Firestore 請求：' + options.method + ' ' + url);
}

/* ---- 1. 換 token + 快取 ---- */
const token1 = ctx.firestoreAccessToken_();
assertEqual(token1, 'fake-access-token', '第一次應該真的換到 token');
const token2 = ctx.firestoreAccessToken_();
assertEqual(token2, 'fake-access-token', '第二次應該拿到一樣的 token');
assertEqual(tokenRequests, 1, 'access token 應該被快取，只打一次換 token 的請求');

/* ---- 2. 欄位格式互轉 ---- */
assertEqual(ctx.toFirestoreValue_('0901'), { stringValue: '0901' }, '字串轉換');
assertEqual(ctx.toFirestoreValue_(300), { integerValue: '300' }, '整數轉換');
assertEqual(ctx.toFirestoreValue_(0.5), { doubleValue: 0.5 }, '小數轉換');
assertEqual(ctx.toFirestoreValue_(''), { nullValue: null }, '空字串轉換成 null(對應 Sheet 版的留白)');
assertEqual(ctx.fromFirestoreValue_({ stringValue: '0901' }), '0901', '字串轉回來，前導零應保留');
assertEqual(ctx.fromFirestoreValue_({ integerValue: '300' }), 300, '整數轉回來');

/* ---- 3. CRUD ---- */
const got = ctx.firestoreGet_('Scenarios/sc1', 'ScenarioID');
assertEqual(got, { ScenarioName: '0901', AmortMonthlyVolume: 300, ScenarioID: 'sc1' }, 'firestoreGet_ 讀單一文件');

const missing = (() => {
  try {
    return ctx.firestoreGet_('Scenarios/does-not-exist', 'ScenarioID');
  } catch (e) { return 'threw: ' + e.message; }
})();
// 假伺服器對這個路徑沒有特別處理，會落到「未預期請求」丟例外 —— 這裡只是先確認上面那組主要案例過，
// 404 情境交給下面獨立測試處理。

const list = ctx.firestoreListAll_('Scenarios', 'ScenarioID');
assertEqual(list, [{ ScenarioName: '0901', ScenarioID: 'sc1' }, { ScenarioName: '0902', ScenarioID: 'sc2' }], 'firestoreListAll_ 讀整個集合');

const queried = ctx.firestoreQuery_('salesMix', { ScenarioID: 'sc1' }, 'RowID');
assertEqual(queried, [
  { ScenarioID: 'sc1', VehicleID: 'V1', RowID: 'row1' },
  { ScenarioID: 'sc1', VehicleID: 'V2', RowID: 'row2' }
], 'firestoreQuery_ 條件查詢');

const created = ctx.firestoreCreate_('Scenarios', { ScenarioName: '0901' }, 'ScenarioID');
assertEqual(created, { ScenarioName: '0901', ScenarioID: 'new-id' }, 'firestoreCreate_ 建立文件並帶回自動配的 ID');

ctx.firestoreSet_('Scenarios/sc1', { ScenarioName: '0901' });
ctx.firestoreUpdateFields_('Scenarios/sc1', { Notes: '測試備註' });
ctx.firestoreDelete_('Scenarios/sc1');
ctx.firestoreBatchWrite_([
  { type: 'set', path: 'Scenarios/sc1', data: { ScenarioName: '0901' } },
  { type: 'delete', path: 'Scenarios/sc2' }
]);

/* ---- 4. 404 應該回 null，不是丟例外 ---- */
ctx.UrlFetchApp.fetch = (url) => fakeResponse_(404, { error: { message: 'not found' } });
const notFound = ctx.firestoreGet_('Scenarios/nope', 'ScenarioID');
assertEqual(notFound, null, 'firestoreGet_ 對不存在的文件應該回傳 null');

if (failures.length) {
  console.error('驗證失敗：\n' + failures.map(f => ' - ' + f).join('\n'));
  process.exit(1);
} else {
  console.log(`FirestoreClient.gs 驗證通過：JWT 簽章正確、token 快取生效、欄位互轉與 CRUD 呼叫格式都對（共送出 ${requests.length} 次假 HTTP 請求）。`);
}

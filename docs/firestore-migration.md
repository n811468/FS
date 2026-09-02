# 遷移計畫：Google Sheets → Firestore

## 為什麼要換

現在的架構把 Google Sheets 當資料庫，每次讀寫都是走 Sheets API，讀一張表要整張掃過
（`readSheetObjects_()`），車型/情境/科目一多，每次切分頁、每次算儀表板的延遲都會跟著變大。
使用情境是 3-5 人各自負責各自車型（不會搶同一批資料）、中等資料規模、想維持零維運/不開新帳單、
且都是透過網頁操作（不需要在 Sheets 介面上直接看/改數字）——這個組合最適合的方案是
**保留 Apps Script（不用自己開伺服器），把資料庫從 Sheets 換成 Firestore**：
甩開 Sheets 的列掃描式讀取，換成真正有索引的查詢，且落在 Firestore 免費額度內
（每天 5 萬次讀 / 2 萬次寫 / 1GB 儲存），不需要額外費用。

## 階段總覽

| 階段 | 內容 | 狀態 |
|---|---|---|
| 0 | 手動設定 GCP 專案、啟用 Firestore、建立服務帳戶金鑰 | **需要你手動完成** |
| 1 | `FirestoreClient.gs`：REST API 用戶端 | ✅ 已完成 |
| 2 | Firestore 資料模型設計 | 進行中 |
| 3 | 一次性搬遷腳本（Sheets → Firestore，跟現有系統並存） | 待做 |
| 4 | `DataService.gs` 逐表改寫成 Firestore 版 | 待做 |
| 5 | `SetupSheets.gs` → Firestore 版初始化/科目表 seed | 待做 |
| 6 | 雙軌驗證：兩邊算出來的損益數字逐格比對 | 待做 |
| 7 | 正式切斷 Sheets，只留 Firestore | 待做 |

---

## 階段 0：手動設定（一次性，約 10 分鐘）

這一步只有你能做，我沒有你 Google 帳號的存取權限。

1. 打開你的 Google Sheets → **擴充功能 → Apps Script**，進到編輯器
2. 左側齒輪「專案設定」→「Google Cloud Platform (GCP) 專案」→ 點「變更專案」
3. 如果還沒有 GCP 專案：到 https://console.cloud.google.com/ 建一個新專案
   （不啟用付費功能就不會有帳單）
4. 把新 GCP 專案的「專案編號」貼回 Apps Script 的「變更專案」欄位
5. GCP Console → 搜尋「Firestore」→ 建立資料庫 → 選 **Native mode**、選一個 region
   （例如 `asia-east1`）
6. GCP Console →「IAM 與管理」→「服務帳戶」→ 建立服務帳戶 → 角色選
   **Cloud Datastore User**
7. 該服務帳戶 →「金鑰」→「新增金鑰」→ JSON → 下載金鑰檔
   （**這個檔案很敏感，不要傳給任何人、不要貼進對話或提交進 git**）
8. 打開下載的 JSON，把裡面的三個值存進 Apps Script 的「指令碼屬性」
   （專案設定 → 指令碼屬性 → 新增屬性）：

   | 屬性鍵名 | 對應 JSON 欄位 |
   |---|---|
   | `FIRESTORE_PROJECT_ID` | `project_id` |
   | `FIRESTORE_CLIENT_EMAIL` | `client_email` |
   | `FIRESTORE_PRIVATE_KEY` | `private_key`（含 `-----BEGIN PRIVATE KEY-----` 那一整段） |

完成後不需要把任何金鑰內容告訴我——`FirestoreClient.gs` 執行時會自己從指令碼屬性讀取。

---

## 階段 1：FirestoreClient.gs（已完成）

新增 `apps-script/FirestoreClient.gs`，提供跟 Firestore REST API 溝通的底層函式：

- `firestoreAccessToken_()`：用服務帳戶簽 JWT 換 OAuth2 access token，換到的 token 用
  `CacheService` 快取（效期內重複呼叫不會重新簽章/換 token）
- `firestoreGet_(docPath, idField)`：讀單一文件，不存在回傳 `null`
- `firestoreListAll_(collectionPath, idField)`：讀整個集合（自動翻頁），對應原本
  `sheetToObjects_()` 讀整張表的用法
- `firestoreCreate_(collectionPath, obj, idField)`：新增文件、自動配 ID
- `firestoreSet_(docPath, obj)`：整份覆蓋寫入（對應 upsert 的「更新」情境）
- `firestoreUpdateFields_(docPath, obj)`：只更新指定欄位（對應
  `upsertRowMerge_()`「只送出畫面上有的欄位」的語意）
- `firestoreDelete_(docPath)`
- `firestoreBatchWrite_(writes)`：一次送出多筆寫入（`saveXxxGrid`／`copyScenarioData`
  這類「一次改很多列」的操作用這個）

沒有真的連線測試（這個環境沒有你的服務帳戶金鑰），改用
`tools/verify-firestore-client.js` 產生一組測試用 RSA 金鑰假扮服務帳戶，把
`UrlFetchApp.fetch` 換成假回應函式，驗證：

- 簽出來的 JWT 格式正確、簽章驗證得過
- access token 有被快取（重複呼叫不會重新換 token）
- JS 物件 ↔ Firestore REST 欄位格式互轉一致（尤其是字串型別要能保留前導零，如「0901」）
- 各 CRUD 函式送出的 HTTP 方法/路徑/內容符合 Firestore REST API 規格

```bash
node tools/verify-firestore-client.js
```

`appsscript.json` 也補上了 `oauthScopes`（外部 HTTP 請求、指令碼儲存空間），
遷移期間仍保留 `spreadsheets` 權限（階段 6 雙軌驗證還需要讀 Sheets 對答案）。

---

## 階段 2：資料模型設計（進行中）

（後續會在這裡補上 Firestore collection/document 結構，對應原本 `Constants.gs` 的
`SCHEMA` 定義。）

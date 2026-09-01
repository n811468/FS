/**
 * Web App 入口。個人使用版本：不做登入權限判斷，直接回傳單頁應用(index.html)。
 * 部署設定見 appsscript.json（webapp.access = MYSELF）。
 */
function doGet() {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('車型損益試算系統')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

/**
 * 科目自訂公式引擎：讓「科目設定」頁的明細科目可以用公式取代手動輸入金額。
 * 公式語法只支援四則運算＋括號，引用售價結構(P1~P9)、其他明細科目(b*、d*、f*、h*)、
 * 比率/匯率參數，全部直接寫名稱、不加任何符號，例如：P8 * 貨物稅率 * 0.85、b1 + b2。
 *
 * 純手刻 tokenizer/parser/evaluator，不使用 eval()/Function()，避免任意程式碼執行風險，
 * 也讓「這個名稱到底是不是合法引用」在存檔當下就能逐一檢查清楚。
 *
 * 不處理小計/毛利/淨利(A/B/C/E/G/I/K)或內建自動計算科目(b5/b8/b13/d4/f3/f4/開發總投
 * 自訂攤提落點)——公式只在「明細科目之間」運作，見 CalcEngine.gs 如何呼叫這個檔案。
 */

/** 識別字：CJK 或英文字母開頭，後面接 CJK/英文/數字(涵蓋 P8、b13、貨物稅率這類名稱) */
var FORMULA_IDENT_RE_ = /^[一-龥A-Za-z][一-龥A-Za-z0-9]*/;
var FORMULA_NUM_RE_ = /^\d+(\.\d+)?/;

/**
 * 把公式字串切成 token 陣列：{type: 'num'|'ident'|'+'|'-'|'*'|'/'|'('|')', value}。
 * 不合法的字元(不是數字/識別字/運算子/括號/空白)直接丟錯誤，訊息帶出是哪個字元。
 */
function formulaTokenize_(src) {
  var s = String(src || '');
  var tokens = [];
  var i = 0;
  while (i < s.length) {
    var ch = s[i];
    if (/\s/.test(ch)) { i++; continue; }
    if ('+-*/()'.indexOf(ch) !== -1) { tokens.push({ type: ch }); i++; continue; }
    var rest = s.slice(i);
    var numMatch = rest.match(FORMULA_NUM_RE_);
    if (numMatch) { tokens.push({ type: 'num', value: Number(numMatch[0]) }); i += numMatch[0].length; continue; }
    var identMatch = rest.match(FORMULA_IDENT_RE_);
    if (identMatch) { tokens.push({ type: 'ident', value: identMatch[0] }); i += identMatch[0].length; continue; }
    throw new Error('公式格式不正確：無法辨識的字元「' + ch + '」');
  }
  tokens.push({ type: 'eof' });
  return tokens;
}

/**
 * 遞迴下降剖析，文法：
 *   expr   := term (('+'|'-') term)*
 *   term   := unary (('*'|'/') unary)*
 *   unary  := '-' unary | primary
 *   primary:= number | ident | '(' expr ')'
 * 回傳 AST：{type:'num',value} | {type:'ref',name} | {type:'neg',arg} | {type:'bin',op,left,right}
 */
function formulaParse_(src) {
  var tokens = formulaTokenize_(src);
  var pos = 0;
  function peek() { return tokens[pos]; }
  function next() { return tokens[pos++]; }
  function expect(type) {
    if (peek().type !== type) throw new Error('公式格式不正確：預期是「' + type + '」，但看到的是「' + (peek().value || peek().type) + '」');
    return next();
  }
  function parsePrimary() {
    var t = peek();
    if (t.type === 'num') { next(); return { type: 'num', value: t.value }; }
    if (t.type === 'ident') { next(); return { type: 'ref', name: t.value }; }
    if (t.type === '(') {
      next();
      var inner = parseExpr();
      expect(')');
      return inner;
    }
    throw new Error('公式格式不正確：預期是數字、科目/參數名稱或括號，但看到的是「' + (t.value || t.type) + '」');
  }
  function parseUnary() {
    if (peek().type === '-') { next(); return { type: 'neg', arg: parseUnary() }; }
    if (peek().type === '+') { next(); return parseUnary(); } // 允許多餘的正號
    return parsePrimary();
  }
  function parseTerm() {
    var node = parseUnary();
    while (peek().type === '*' || peek().type === '/') {
      var op = next().type;
      node = { type: 'bin', op: op, left: node, right: parseUnary() };
    }
    return node;
  }
  function parseExpr() {
    var node = parseTerm();
    while (peek().type === '+' || peek().type === '-') {
      var op = next().type;
      node = { type: 'bin', op: op, left: node, right: parseTerm() };
    }
    return node;
  }
  if (peek().type === 'eof') throw new Error('公式不能是空白');
  var ast = parseExpr();
  expect('eof');
  return ast;
}

/** 走一遍 AST，收集所有被引用到的識別字名稱(去重，依出現順序) */
function formulaExtractRefs_(ast) {
  var seen = {};
  var refs = [];
  function walk(node) {
    if (!node) return;
    if (node.type === 'ref') { if (!seen[node.name]) { seen[node.name] = true; refs.push(node.name); } return; }
    if (node.type === 'neg') { walk(node.arg); return; }
    if (node.type === 'bin') { walk(node.left); walk(node.right); return; }
  }
  walk(ast);
  return refs;
}

/**
 * 依 AST 算出數值。valueOf(name) 由呼叫端提供，負責決定一個引用名稱該對應到什麼數字
 * (科目金額或參數值)，找不到就自己丟錯誤，這裡直接讓錯誤往外傳。
 */
function formulaEvaluate_(ast, valueOf) {
  switch (ast.type) {
    case 'num': return ast.value;
    case 'ref': return toNumber_(valueOf(ast.name));
    case 'neg': return -formulaEvaluate_(ast.arg, valueOf);
    case 'bin': {
      var l = formulaEvaluate_(ast.left, valueOf);
      var r = formulaEvaluate_(ast.right, valueOf);
      switch (ast.op) {
        case '+': return l + r;
        case '-': return l - r;
        case '*': return l * r;
        case '/':
          if (r === 0) throw new Error('公式計算錯誤：除數為 0');
          return l / r;
      }
    }
  }
  throw new Error('公式內部錯誤：無法識別的節點類型');
}

/**
 * 對一批「公式科目」做拓樸排序，只在意「這個公式引用了另一個也是公式的科目」的依賴關係——
 * 引用手動輸入的科目或參數不需要排序(值已經知道)。抓到循環引用就丟出清楚的錯誤，
 * 把整條循環路徑列出來，方便使用者定位是哪幾個科目互相引用。
 *
 * formulaDefs: [{ code, refs }]，refs 是 formulaExtractRefs_() 的結果。
 * 回傳依賴順序排好的 code 陣列(依賴的科目排在前面)。
 */
function formulaTopoSort_(formulaDefs) {
  var byCode = {};
  formulaDefs.forEach(function (d) { byCode[d.code] = d; });

  var state = {}; // 'visiting' | 'done'
  var order = [];
  var stack = [];

  function visit(code) {
    if (state[code] === 'done') return;
    if (state[code] === 'visiting') {
      var cycleStart = stack.indexOf(code);
      var cyclePath = stack.slice(cycleStart).concat([code]);
      throw new Error('科目公式出現循環引用：' + cyclePath.join(' → '));
    }
    var def = byCode[code];
    if (!def) return; // 不是公式科目(手動輸入或參數)，不需要排序
    state[code] = 'visiting';
    stack.push(code);
    def.refs.forEach(function (ref) { if (byCode[ref]) visit(ref); });
    stack.pop();
    state[code] = 'done';
    order.push(code);
  }

  formulaDefs.forEach(function (d) { visit(d.code); });
  return order;
}

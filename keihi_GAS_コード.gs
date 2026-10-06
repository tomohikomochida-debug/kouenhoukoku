/****************************************************************
 * 庭乃持田園 経費アプリ — GAS バックエンド (Code.gs)
 * ・スプレッドシートに保存（明細／入金／月設定／過不足／編集履歴）
 * ・レシート画像を Gemini で読み取り（費目・支払い方法を自動判定）
 * ・財布の残高は「最初からの通し計算」で常に即時（締めなくても翌月につながる）
 * ・財布を数えて帳簿とズレていたら、差額を「過不足」として記録して合わせる
 * ・明細の編集／削除を「編集履歴」シートに自動で記録（いつ・誰が・どの項目を・旧→新）
 *
 * 返り値はすべて { ok:true/false, error?:"..." } 形式（日報アプリと同じ作法）
 ****************************************************************/

var GEMINI_MODEL = 'gemini-2.5-flash';

var SHEETS = {
  rec: { name: '明細', head: ['id', 'ym', 'date', 'category', 'store', 'items', 'amount', 'pay', 'who', 'settled', 'createdAt', 'author'] },
  inj: { name: '入金', head: ['id', 'ym', 'amount', 'createdAt'] },
  mon: { name: '月設定', head: ['ym', 'opening', 'counted', 'closed'] },
  adj: { name: '過不足', head: ['id', 'ym', 'amount', 'counted', 'book', 'who', 'createdAt'] },
  log: { name: '編集履歴', head: ['id', 'at', 'editor', 'recId', 'ym', 'field', 'before', 'after', 'action'] }
};

// 編集履歴に残すときの項目名（日本語）
var FIELD_LBL = { date: '日付', category: '費目', store: '店名', amount: '金額', pay: '支払い', who: '立替の人', settled: '精算', items: '品目', author: '記録者' };

// レシート読み取りの指示文（費目は「買った物の中身」で判定）
var PROMPT =
  'あなたは造園会社の経理担当です。レシート画像から現金出納帳の1行を作ります。' +
  'JSONだけ返してください。' +
  '{"date":"M/D","store":"店名","items":["主な品目を最大5つ"],"total":合計金額の数値,"category":費目,"pay":"cash または card","why":"理由15字","confidence":0〜1}' +
  '費目は必ず次から1つ: 車両費 / 材料費 / 消耗品費 / 設備費 / 処分費 / 交通費 / 福利厚生費 / 雑費。' +
  '費目は店ではなく買った物の中身で決める（例：ホームセンターでも刃やビスは消耗品費、木材や砂利や植木は材料費、棚や機械は設備費）。' +
  'ガソリン・軽油・高速料金・駐車場・洗車・車の整備や部品は車両費。残土や廃材やゴミの処分代は処分費。' +
  '飲み物・食事・お茶菓子・休憩の買い物は福利厚生費。郵便・印鑑・事務用品など少額のその他は雑費。' +
  'pay は支払い方法：「クレジット」「カード」とあれば card、「お預り」「お釣り」など現金なら cash。';

/* ============ 共通 ============ */
function sh_(key) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var def = SHEETS[key];
  var s = ss.getSheetByName(def.name);
  if (!s) { s = ss.insertSheet(def.name); s.appendRow(def.head); }
  return s;
}
function setup() { sh_('rec'); sh_('inj'); sh_('mon'); sh_('adj'); sh_('log'); } // 初回に1度だけ手動実行

function out_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
function uid_() { return 'x' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36); }
function bool_(v) { return v === true || v === 'TRUE' || v === 'true'; }

/* スプレッドシートが「2026-08」を日付に変えてしまうことがあるので、読むときに必ず 'yyyy-MM' にそろえる */
function ymOf_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM');
  return String(v == null ? '' : v).slice(0, 7);
}
/* レシート日付（M/D）も日付に変わっていたら 'M/d' に戻す */
function mdOf_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Tokyo', 'M/d');
  return v == null ? '' : String(v);
}
function rows_(key) {
  var head = SHEETS[key].head;
  var vals = sh_(key).getDataRange().getValues();
  vals.shift();
  return vals.map(function (r) {
    var o = {}; head.forEach(function (h, i) { o[h] = r[i]; });
    if ('ym' in o) o.ym = ymOf_(o.ym);
    if (key === 'rec') o.date = mdOf_(o.date);
    return o;
  }).filter(function (o) { return String(o[head[0]]) !== ''; });
}

/* ============ 編集履歴 ============ */
function logRows_(recId, ym, editor, triples, action) {
  var s = sh_('log'); var now = new Date();
  triples.forEach(function (t) {
    s.appendRow([uid_(), now, editor || '', recId, ym, t[0], t[1], t[2], action]);
  });
}
/* レシートごとの編集回数（update/delete の件数）を集計 */
function logCountByRec_() {
  var L = rows_('log'); var m = {};
  L.forEach(function (x) {
    if (x.action === 'update' || x.action === 'delete') { m[x.recId] = (m[x.recId] || 0) + 1; }
  });
  return m;
}

/* ============ 読み取り（GET） ============ */
function doGet(e) {
  var a = (e.parameter.action || '');
  if (a === 'ping') return out_({ ok: true, msg: 'ok', model: GEMINI_MODEL });
  if (a === 'month') return out_(readMonth(e.parameter.ym));
  if (a === 'summary') return out_(getSummary());
  return out_({ ok: false, error: 'unknown action' });
}

/* ============ 財布の通し計算（台帳） ============
 * 月ごとに「入金＋、現金払い−、立替清算−、過不足±」を集め、古い月から順に足し引きしていく。
 * 月初の残高＝前の月の月末残高（締めていなくても自動でつながる）。
 * いちばん古い月の月初だけは「月設定」の opening を使う（最初の残高。無ければ0）。 */
function curYm_() { return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM'); }
function ledger_() {
  var rec = rows_('rec'), inj = rows_('inj'), mon = rows_('mon'), adj = rows_('adj');
  var byYm = {};
  function ensure(ym) {
    if (!byYm[ym]) byYm[ym] = { ym: ym, cats: {}, expenseAll: 0, cash: 0, card: 0, advance: 0, settledAdv: 0, unsettled: {},
                                inj: 0, adj: 0, opening: 0, balance: 0, counted: '', closed: false, count: 0 };
    return byYm[ym];
  }
  var moves = [];   // 財布の出入り（最近の動き用）
  rec.forEach(function (r) {
    var ym = String(r.ym); if (!ym) return;
    if (!(Number(r.amount) || 0) && !r.store) return;     // 金額も店名も無い空の行は数えない
    var o = ensure(ym), amt = Number(r.amount) || 0, cat = r.category || '';
    o.count++;
    if (cat) o.cats[cat] = (o.cats[cat] || 0) + amt;
    o.expenseAll += amt;
    var pay = r.pay || 'cash';
    if (pay === 'cash') { o.cash += amt; if (amt) moves.push({ t: r.createdAt, ym: ym, kind: 'cash', label: r.store || r.category || '現金払い', date: r.date || '', amount: -amt }); }
    else if (pay === 'card') o.card += amt;
    else if (pay === 'advance') {
      o.advance += amt;
      if (bool_(r.settled)) { o.settledAdv += amt; if (amt) moves.push({ t: r.createdAt, ym: ym, kind: 'settle', label: '立替の清算（' + (r.who || '名前なし') + '）', date: r.date || '', amount: -amt }); }
      else { var who = r.who || '（名前なし）'; o.unsettled[who] = (o.unsettled[who] || 0) + amt; }
    }
  });
  inj.forEach(function (x) { var ym = String(x.ym); if (!ym) return; var a = Number(x.amount) || 0; ensure(ym).inj += a;
    if (a) moves.push({ t: x.createdAt, ym: ym, kind: 'inj', label: '入金', date: '', amount: a }); });
  adj.forEach(function (x) { var ym = String(x.ym); if (!ym) return; var a = Number(x.amount) || 0; ensure(ym).adj += a;
    if (a) moves.push({ t: x.createdAt, ym: ym, kind: 'adj', label: '過不足の調整（数えた額 ' + x.counted + '円）', date: '', amount: a }); });
  var monBy = {};
  mon.forEach(function (m) { var ym = String(m.ym); if (!ym) return; monBy[ym] = m; var o = ensure(ym);
    o.counted = (m.counted === '' || m.counted == null) ? '' : Number(m.counted); o.closed = bool_(m.closed); });
  ensure(curYm_());
  var yms = Object.keys(byYm).sort();
  var run = yms.length && monBy[yms[0]] ? (Number(monBy[yms[0]].opening) || 0) : 0;
  yms.forEach(function (ym) {
    var o = byYm[ym];
    o.opening = run;
    o.balance = o.opening + o.inj - o.cash - o.settledAdv + o.adj;
    run = o.balance;
  });
  // 最近の動き：入力した順に並べ、財布の残りを付ける
  moves.forEach(function (m) { m.ts = (m.t instanceof Date) ? m.t.getTime() : (new Date(m.t).getTime() || 0); });
  moves.sort(function (a, b) { return a.ts - b.ts; });
  var r2 = yms.length && monBy[yms[0]] ? (Number(monBy[yms[0]].opening) || 0) : 0;
  moves.forEach(function (m) { r2 += m.amount; m.after = r2;
    m.when = m.ts ? Utilities.formatDate(new Date(m.ts), 'Asia/Tokyo', 'M/d') : ''; delete m.t; });
  return { byYm: byYm, yms: yms, balanceNow: run, moves: moves };
}

// 全月の集計（ダッシュボード用）
function getSummary() {
  var L = ledger_();
  var arr = L.yms.map(function (ym) { return L.byYm[ym]; }).reverse();   // 新しい月が先
  var owedAll = {};
  arr.forEach(function (o) { Object.keys(o.unsettled).forEach(function (w) { owedAll[w] = (owedAll[w] || 0) + o.unsettled[w]; }); });
  var tot = { inj: 0, cash: 0, settledAdv: 0, adj: 0 };
  arr.forEach(function (o) { tot.inj += o.inj; tot.cash += o.cash; tot.settledAdv += o.settledAdv; tot.adj += o.adj; });
  var first = L.yms.length ? L.byYm[L.yms[0]] : null;
  return { ok: true, months: arr,
           wallet: { balance: L.balanceNow, start: first ? first.opening : 0, startYm: first ? first.ym : '', total: tot },
           recent: L.moves.slice(-30).reverse(), owedAll: owedAll };
}

function readMonth(ym) {
  ym = String(ym || '');
  var L = ledger_();
  var o = L.byYm[ym];
  var opening;
  if (o) opening = o.opening;
  else {   // まだ何も無い月：その月より前の最後の月末残高
    opening = 0; for (var i = 0; i < L.yms.length; i++) { if (L.yms[i] < ym) opening = L.byYm[L.yms[i]].balance; }
  }
  var rec = rows_('rec').filter(function (r) { return String(r.ym) === ym; });
  var inj = rows_('inj').filter(function (r) { return String(r.ym) === ym; });
  var adj = rows_('adj').filter(function (r) { return String(r.ym) === ym; });
  var mon = rows_('mon').filter(function (r) { return String(r.ym) === ym; })[0] || { opening: 0, counted: '', closed: false };
  var lc = logCountByRec_();
  rec.forEach(function (r) {
    r.amount = Number(r.amount) || 0;
    r.settled = bool_(r.settled);
    r.items = r.items ? String(r.items).split('/') : [];
    r.author = r.author == null ? '' : String(r.author);
    r.edited = (lc[r.id] || 0) > 0;
    r.editCount = lc[r.id] || 0;
  });
  inj.forEach(function (r) { r.amount = Number(r.amount) || 0; });
  adj.forEach(function (r) { r.amount = Number(r.amount) || 0; });
  return {
    ok: true, ym: ym,
    opening: opening,
    counted: (mon.counted === '' || mon.counted == null) ? '' : Number(mon.counted),
    closed: bool_(mon.closed),
    records: rec, injections: inj, adjustments: adj,
    walletNow: L.balanceNow
  };
}

/* ============ 書き込み（POST） ============ */
function doPost(e) {
  var b = {};
  try { b = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: 'bad json' }); }
  try {
    switch (b.mode) {
      case 'analyze':         return out_(analyzeReceipt(b.image));
      case 'addRecord':       return out_(addRecord(b.row));
      case 'updateRecord':    return out_(updateRecord(b.id, b.patch, b.editor));
      case 'deleteRecord':    return out_(deleteRecord(b.id, b.editor));
      case 'addInjection':    return out_(addInjection(b.ym, b.amount));
      case 'updateInjection': return out_(updateInjection(b.id, b.amount));
      case 'deleteInjection': return out_(deleteRow('inj', b.id));
      case 'settle':          return out_(settle(b.ym, b.who));
      case 'closeMonth':      return out_(closeMonth(b.ym, b.counted));
      case 'countCash':       return out_(countCash(b.ym, b.counted, b.who));
      case 'deleteAdjustment':return out_(deleteRow('adj', b.id));
      default:                return out_({ ok: false, error: 'unknown mode' });
    }
  } catch (err) { return out_({ ok: false, error: String(err) }); }
}

function addRecord(row) {
  var id = uid_();
  sh_('rec').appendRow([
    id, row.ym, row.date || '', row.category || '', row.store || '',
    (row.items || []).join('/'), Number(row.amount) || 0,
    row.pay || 'cash', row.who || '', row.settled ? true : false, new Date(), row.author || ''
  ]);
  return { ok: true, id: id };
}

/* 明細の更新。変わった項目だけ「編集履歴」に残す（editor＝編集した人の名前）。 */
function updateRecord(id, patch, editor) {
  var s = sh_('rec'), head = SHEETS.rec.head;
  var vals = s.getDataRange().getValues();
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i][0]) === String(id)) {
      var ym = ymOf_(vals[i][1]);
      var logs = [];
      head.forEach(function (h, c) {
        if (patch.hasOwnProperty(h)) {
          var nv = patch[h];
          if (h === 'items') nv = (nv || []).join('/');
          if (h === 'settled') nv = nv ? true : false;
          var ov = vals[i][c];
          var ovs = (h === 'settled') ? (bool_(ov) ? '✓' : '') : String(ov == null ? '' : ov);
          var nvs = (h === 'settled') ? ((nv === true) ? '✓' : '') : String(nv == null ? '' : nv);
          if (ovs !== nvs) {
            logs.push([FIELD_LBL[h] || h, ovs, nvs]);
            s.getRange(i + 1, c + 1).setValue(nv);
          }
        }
      });
      if (logs.length) logRows_(id, ym, editor, logs, 'update');
      return { ok: true };
    }
  }
  return { ok: false, error: 'not found' };
}

/* 明細の削除。削除したことと主な中身を「編集履歴」に残してから消す。 */
function deleteRecord(id, editor) {
  var s = sh_('rec'), vals = s.getDataRange().getValues();
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i][0]) === String(id)) {
      var ym = ymOf_(vals[i][1]);
      var store = vals[i][4], amount = vals[i][6];
      logRows_(id, ym, editor, [['（削除）', (store || '') + ' ' + (Number(amount) || 0) + '円', '']], 'delete');
      s.deleteRow(i + 1);
      return { ok: true };
    }
  }
  return { ok: false, error: 'not found' };
}

function deleteRow(key, id) {
  var s = sh_(key), vals = s.getDataRange().getValues();
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i][0]) === String(id)) { s.deleteRow(i + 1); return { ok: true }; }
  }
  return { ok: false, error: 'not found' };
}

function addInjection(ym, amount) {
  var id = uid_();
  sh_('inj').appendRow([id, ym, Number(amount) || 0, new Date()]);
  return { ok: true, id: id };
}

function updateInjection(id, amount) {
  var s = sh_('inj'), vals = s.getDataRange().getValues();
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i][0]) === String(id)) { s.getRange(i + 1, 3).setValue(Number(amount) || 0); return { ok: true }; }
  }
  return { ok: false, error: 'not found' };
}

function settle(ym, who) {
  var s = sh_('rec'), vals = s.getDataRange().getValues();
  var cSet = 10; // 1始まりの列：settled=10
  for (var i = 1; i < vals.length; i++) {
    if (ymOf_(vals[i][1]) === ymOf_(ym) && vals[i][7] === 'advance' && String(vals[i][8]) === String(who) && !bool_(vals[i][9])) {
      s.getRange(i + 1, cSet).setValue(true);
    }
  }
  return { ok: true };
}

function nextYm_(ym) {
  var p = String(ym).split('-'); var y = +p[0], m = +p[1] + 1;
  if (m > 12) { m = 1; y++; }
  return y + '-' + ('0' + m).slice(-2);
}

function setMon_(ym, patch) {
  var s = sh_('mon'), vals = s.getDataRange().getValues();
  for (var i = 1; i < vals.length; i++) {
    if (ymOf_(vals[i][0]) === ymOf_(ym)) {
      if (patch.hasOwnProperty('opening')) s.getRange(i + 1, 2).setValue(patch.opening);
      if (patch.hasOwnProperty('counted')) s.getRange(i + 1, 3).setValue(patch.counted);
      if (patch.hasOwnProperty('closed'))  s.getRange(i + 1, 4).setValue(patch.closed);
      return;
    }
  }
  s.appendRow([ym, patch.opening || 0, patch.hasOwnProperty('counted') ? patch.counted : '', patch.closed || false]);
}

function hasCount_(v) { return !(v === '' || v === null || v === undefined); }
function addAdj_(ym, diff, counted, book, who) {
  var id = uid_();
  sh_('adj').appendRow([id, ym, diff, counted, book, who || '', new Date()]);
  return id;
}
/* いまの財布を数えた額で合わせる（差額を過不足として記録）。book＝いまの帳簿残高（全期間の通し） */
function countCash(ym, counted, who) {
  if (!hasCount_(counted)) return { ok: false, error: '数えた額が入っていません' };
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var c = Number(counted) || 0;
    var book = ledger_().balanceNow;
    var diff = c - book;
    var id = diff !== 0 ? addAdj_(ym || curYm_(), diff, c, book, who) : '';
    return { ok: true, book: book, counted: c, diff: diff, id: id, balance: c };
  } finally { lock.releaseLock(); }
}
/* 月締め：数えた額があれば、その月末の帳簿と比べて差額を過不足で記録し、締め済みにする。
   残高は通し計算なので、翌月への繰り越し操作はもう要らない。 */
function closeMonth(ym, counted) {
  var lock = LockService.getScriptLock(); lock.waitLock(20000);
  try {
    var L = ledger_();
    var o = L.byYm[String(ym)];
    var book = o ? o.balance : 0;
    var diff = 0;
    // 旧版の入力アプリは空欄でも 0 を送ってくるため、月締めでは 0 は「数えていない」とみなす
    if (hasCount_(counted) && Number(counted) !== 0) {
      var c = Number(counted) || 0;
      diff = c - book;
      if (diff !== 0) addAdj_(ym, diff, c, book, '月締め');
      setMon_(ym, { counted: c, closed: true });
    } else {
      setMon_(ym, { closed: true });
    }
    return { ok: true, ending: book + diff, diff: diff, nextYm: nextYm_(ym) };
  } finally { lock.releaseLock(); }
}

/* ============ Gemini 読み取り ============ */
function analyzeReceipt(b64) {
  var key = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!key) return { ok: false, error: 'GEMINI_API_KEY が未設定です（スクリプト プロパティに登録してください）' };
  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + key;
  var payload = {
    contents: [{ parts: [
      { inline_data: { mime_type: 'image/jpeg', data: b64 } },
      { text: PROMPT }
    ] }],
    generationConfig: { responseMimeType: 'application/json', temperature: 0 }
  };
  var res = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
    payload: JSON.stringify(payload), muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code !== 200) return { ok: false, error: 'Gemini HTTP ' + code + '：' + res.getContentText().slice(0, 200) };
  var data = JSON.parse(res.getContentText());
  var text = ((((data.candidates || [])[0] || {}).content || {}).parts || [])
    .map(function (p) { return p.text || ''; }).join('');
  var j;
  try { j = JSON.parse(text); } catch (e2) {
    var s = text.indexOf('{'), e = text.lastIndexOf('}');
    if (s === -1 || e === -1) return { ok: false, error: '読み取り結果を解釈できませんでした' };
    j = JSON.parse(text.slice(s, e + 1));
  }
  var allow = ['車両費','材料費','消耗品費','設備費','処分費','交通費','福利厚生費','雑費'];
  return {
    ok: true,
    data: {
      date: j.date || '',
      store: j.store || '',
      items: Array.isArray(j.items) ? j.items : [],
      total: Number(String(j.total).replace(/[^\d.-]/g, '')) || 0,
      category: allow.indexOf(j.category) >= 0 ? j.category : '',
      pay: j.pay === 'card' ? 'card' : 'cash',
      why: j.why || '',
      confidence: Number(j.confidence) || 0
    }
  };
}

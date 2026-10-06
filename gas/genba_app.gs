/****************************************************************
 * 庭乃持田園 現場アプリ（段取り・道具管理・用語集）— GAS バックエンド（1本にまとめた版）
 *
 *  ・用語集  （app=yougo） ：言葉のマスタ。用語／呼び方／聞き間違い。AIで探す・意味の下書き
 *  ・道具管理（app=dougu） ：道具マスタ（用語IDでつなぐ）・番地・写真。登録時のAI照合
 *  ・段取り  （app=dandori）：段取りカード。Googleカレンダー（現場カレンダー・出勤調整カレンダー）の読み取り。AIで話を整理
 *  返り値はすべて { ok:true/false, error?:"..." } 形式（社内アプリ共通ルール）
 *
 * ───────── 置き方 ─────────
 *  この本体は GitHub に置き、GAS「現場アプリ」に貼った「読み込み係（gas/loader.gs）」が自動で読み込みます。
 *  ここを直して GitHub に上げれば、数分でアプリに反映されます（GASの貼り直し・デプロイのし直しは不要）。
 *  スクリプト プロパティ：GEMINI_API_KEY（AIのキー）／SHEET_ID（自動）／GEMINI_MODEL（任意：AIのモデル名）
 *  ※カレンダー：マイカレンダーの「現場カレンダー」を現場、「出勤調整カレンダー」を休みとして読みます
 *    （時間の決まった予定は、段取りアプリで「使う／使わない」を聞いてから使います）
 *    名前を変えたときは、スクリプト プロパティ SITE_CALENDAR／HOLIDAY_CALENDAR に新しい名前を登録
 *    読めているかの確認：URLの後ろに ?app=dandori&action=colors を付けて開く
 ****************************************************************/

var GEMINI_MODEL = 'gemini-2.5-flash';   // スクリプト プロパティ GEMINI_MODEL に書けば、コードを直さずに切り替えられる
var TZ = 'Asia/Tokyo';
var PHOTO_FOLDER = '道具写真';
var SHEET_NAME = '現場アプリデータ（段取り・道具・用語）';
var CATEGORIES = ['剪定・手入れ', '枝・芽の名前', '樹形・仕立て', '植栽・移植', '支柱・結束', '樹木の部位・規格',
  '季節の作業・土と肥料', '病害虫', '庭づくり（石・水・配置）', '現場の言葉', '道具', '資材', '社内用語'];
var ALIAS_TYPES = ['社内呼び', '別名', '略称', '聞き間違い'];

var SHEETS = {
  terms:     { name: '用語',         head: ['termId', 'term', 'kana', 'category', 'meaning', 'usage', 'related', 'toolId', 'source', 'photoUrl', 'reviewState', 'addedBy', 'updatedAt'] },
  aliases:   { name: '呼び方',       head: ['alias', 'kana', 'termId', 'type', 'state', 'addedBy', 'addedAt'] },
  tools:     { name: '道具マスタ',   head: ['id', 'termId', 'location', 'qty', 'photoUrl', 'photoId', 'status', 'statusSite', 'statusBy', 'statusAt', 'registeredBy', 'reviewState', 'createdAt', 'updatedAt'] },
  locations: { name: '番地',         head: ['code', 'floor', 'area', 'place', 'container', 'mapX', 'mapY'] },
  toolLog:   { name: '持ち出し履歴', head: ['at', 'toolId', 'action', 'site', 'by'] },
  cards:     { name: '段取りカード', head: ['cardId', 'date', 'site', 'eventId', 'meetTime', 'staff', 'vehicle', 'stops', 'items', 'steps', 'notes', 'rawText', 'createdBy', 'updatedAt', 'kind', 'title', 'dateNote', 'doneAt', 'doneBy'] },
  nicknames: { name: '呼び名',       head: ['name', 'nickname', 'addedBy', 'addedAt'] },
  suppliers: { name: '取引先',       head: ['id', 'name', 'kana', 'kind', 'aliases', 'phone', 'address', 'contact', 'items', 'memo', 'updatedBy', 'updatedAt'] },
  vehicles:  { name: '車両',         head: ['id', 'name', 'aliases', 'ownership', 'plate', 'model', 'shakenDate', 'insuranceDate', 'rentalShop', 'rentalFrom', 'rentalTo', 'photoUrl', 'photoId', 'status', 'memo', 'updatedBy', 'updatedAt'] },
  vehicleLog:{ name: '車両の記録',   head: ['logId', 'vehicleId', 'date', 'type', 'content', 'shop', 'cost', 'odometer', 'by', 'at'] },
  toolRepair:{ name: '修理履歴',     head: ['logId', 'toolId', 'date', 'type', 'content', 'shop', 'cost', 'by', 'at'] },
  vehicleDocs:{ name: '車両の書類',  head: ['docId', 'vehicleId', 'type', 'name', 'mime', 'fileId', 'url', 'note', 'by', 'at'] }
};
var JSON_COLS = ['stops', 'items', 'steps', 'notes'];

/* ================================================================
 *  はじめの準備
 * ================================================================ */
function setup() {
  var props = PropertiesService.getScriptProperties();
  var ss = null, id = props.getProperty('SHEET_ID');
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) { try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; } }
  if (!ss) { ss = findSheet_(); if (ss) props.setProperty('SHEET_ID', ss.getId()); }   // 控えが消えていても、同じ名前のものを探して使う
  if (!ss) {   // スプレッドシートを自動で作る
    ss = SpreadsheetApp.create(SHEET_NAME);
    ss.setSpreadsheetTimeZone(TZ);
    props.setProperty('SHEET_ID', ss.getId());
  }
  Object.keys(SHEETS).forEach(sh_);
  var first = ss.getSheetByName('シート1') || ss.getSheetByName('Sheet1');
  if (first && ss.getSheets().length > 1 && first.getLastRow() === 0) ss.deleteSheet(first);
  var n = rows_('terms').length ? { terms: 0, aliases: 0 } : seedImport_();   // 用語集の下書きを取り込む（空のときだけ）
  folder_();                                     // 写真フォルダ
  CalendarApp.getDefaultCalendar().getName();    // カレンダーの読み取り許可
  ['SITE_CALENDAR', 'HOLIDAY_CALENDAR'].forEach(function (k) {
    var n = calName_(k); Logger.log((k === 'SITE_CALENDAR' ? '現場' : '休み') + 'のカレンダー「' + n + '」：' + (calByName_(n) ? '見つかりました' : '見つかりません（色で見分けます）'));
  });
  Logger.log('準備できました。スプレッドシート：' + ss.getUrl());
  Logger.log('用語の取り込み：' + n.terms + '語、呼び方：' + n.aliases + '件');
  Logger.log('次は ⚙スクリプト プロパティに GEMINI_API_KEY を登録して、ウェブアプリとしてデプロイしてください。');
}

/* ================================================================
 *  共通
 * ================================================================ */
function prop_(k, d) { var v = PropertiesService.getScriptProperties().getProperty(k); v = v == null ? '' : String(v).trim(); return v === '' ? d : v; }
function findSheet_() {
  var it = DriveApp.getFilesByName(SHEET_NAME);
  return it.hasNext() ? SpreadsheetApp.open(it.next()) : null;
}
var SS_CACHE_ = null;
function ss_() {
  if (SS_CACHE_) return SS_CACHE_;
  var id = prop_('SHEET_ID', ''), ss = null;
  if (id) { try { ss = SpreadsheetApp.openById(id); } catch (e) { ss = null; } }
  if (!ss) {   // 控え（SHEET_ID）が消えた・間違っているときは、名前で探して控え直す
    ss = findSheet_();
    if (ss) PropertiesService.getScriptProperties().setProperty('SHEET_ID', ss.getId());
  }
  if (!ss) { try { ss = SpreadsheetApp.getActiveSpreadsheet(); } catch (e) { ss = null; } }
  if (!ss) throw new Error('はじめに setup を実行してください');
  return (SS_CACHE_ = ss);
}
function sh_(key) {
  var ss = ss_(), def = SHEETS[key], s = ss.getSheetByName(def.name);
  if (!s) { s = ss.insertSheet(def.name); s.appendRow(def.head); s.setFrozenRows(1); }
  else if (s.getLastColumn() < def.head.length) s.getRange(1, 1, 1, def.head.length).setValues([def.head]);   // 列が増えたとき見出しを足す
  return s;
}
function out_(o) { return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON); }
function now_() { return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'); }
function ymd_(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }
function day_(s) { var p = String(s).split('-'); return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])); }
function addDays_(s, n) { var d = day_(s); d.setDate(d.getDate() + n); return ymd_(d); }
function isKana_(s) { return /^[ぁ-ゖァ-ーー\s]+$/.test(String(s || '')); }
function toHira_(s) { return String(s || '').replace(/[ァ-ヶ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0x60); }); }
function rows_(key) {
  var head = SHEETS[key].head, vals = sh_(key).getDataRange().getValues(), list = [];
  for (var i = 1; i < vals.length; i++) {
    if (vals[i].join('') === '') continue;
    var o = {};
    head.forEach(function (h, c) {
      var v = vals[i][c];
      if (v instanceof Date) v = /^date$|Date$|From$|To$/.test(h) ? ymd_(v) : Utilities.formatDate(v, TZ, 'yyyy-MM-dd HH:mm');
      o[h] = v == null ? '' : v;
    });
    list.push(o);
  }
  return list;
}
function nextId_(key, col, prefix) {
  var max = 0;
  rows_(key).forEach(function (r) { var n = Number(String(r[col]).replace(/\D/g, '')) || 0; if (n > max) max = n; });
  return prefix + ('000' + (max + 1)).slice(-4);
}
function withLock_(fn) { var l = LockService.getScriptLock(); l.waitLock(25000); try { return out_(fn()); } finally { l.releaseLock(); } }

// 使うモデルの順番。混み合っている（503など）ときは少し待ってやり直し、だめなら次のモデルへ
var GEMINI_FALLBACK = ['gemini-2.5-flash-lite', 'gemini-3.5-flash-lite'];
function models_() {
  var list = [prop_('GEMINI_MODEL', GEMINI_MODEL)].concat(String(prop_('GEMINI_FALLBACK', GEMINI_FALLBACK.join(','))).split(','));
  return list.map(function (m) { return String(m).trim(); }).filter(function (m, i, a) { return m && a.indexOf(m) === i; });
}
function gemini_(parts) {   // parts：文字列 または Gemini の parts 配列
  var key = prop_('GEMINI_API_KEY', '');
  if (!key) throw new Error('GEMINI_API_KEY が未設定です（スクリプト プロパティに登録してください）');
  if (typeof parts === 'string') parts = [{ text: parts }];
  var models = models_(), started = Date.now(), last = '';
  for (var m = 0; m < models.length; m++) {
    var model = models[m];
    var cfg = { responseMimeType: 'application/json' };
    if (/^gemini-[12]\./.test(model)) cfg.temperature = 0;   // Gemini 3 以降は既定の温度のまま使う（下げると答えが乱れることがある）
    for (var tryNo = 0; tryNo < 2; tryNo++) {
      var res = UrlFetchApp.fetch('https://generativelanguage.googleapis.com/v1beta/models/' + model + ':generateContent?key=' + key, {
        method: 'post', contentType: 'application/json', muteHttpExceptions: true,
        payload: JSON.stringify({ contents: [{ parts: parts }], generationConfig: cfg })
      });
      var code = res.getResponseCode();
      if (code === 200) {
        var data = JSON.parse(res.getContentText());
        var t = ((((data.candidates || [])[0] || {}).content || {}).parts || []).filter(function (p) { return !p.thought; }).map(function (p) { return p.text || ''; }).join('');
        try { return JSON.parse(t); } catch (e) {
          var a = t.indexOf('{'), z = t.lastIndexOf('}');
          if (a >= 0 && z > a) { try { return JSON.parse(t.slice(a, z + 1)); } catch (e2) {} }
          last = 'AIの結果を解釈できませんでした'; break;   // 次のモデルで試す
        }
      }
      last = 'Gemini HTTP ' + code + '：' + res.getContentText().slice(0, 200);
      if (code === 400 || code === 401 || code === 403) {   // キーや設定の問題はやり直しても同じ
        throw new Error(code === 400 && /model/i.test(res.getContentText()) ? 'AIのモデル名「' + model + '」が使えません：' + last : 'AIのキーを確認してください（' + last + '）');
      }
      if (code === 404) break;   // モデルが無い → 次のモデル
      if (Date.now() - started > 60000) break;
      if (tryNo === 0 && typeof Utilities.sleep === 'function') Utilities.sleep(2000);   // 混み合い（429・500・503）は少し待ってもう一度
    }
  }
  if (/HTTP (429|500|503)/.test(last)) throw new Error('AIが混み合っていて使えませんでした。少し時間をおいて、もう一度押してください。（' + last.slice(0, 60) + '）');
  throw new Error(last || 'AIに接続できませんでした');
}

/* ================================================================
 *  入口（GET：読み取り／POST：書き込み）。app でアプリを分ける
 * ================================================================ */
function doGet(e) {
  var p = (e && e.parameter) || {}, app = p.app || '', a = p.action || '';
  try {
    if (a === 'ping') return out_({ ok: true, model: prop_('GEMINI_MODEL', GEMINI_MODEL) });
    if (app === 'yougo' && a === 'data') return out_({ ok: true, terms: rows_('terms'), aliases: rows_('aliases') });
    if (app === 'dougu' && a === 'data') return out_({ ok: true, tools: rows_('tools'), locations: rows_('locations'), repairs: rows_('toolRepair') });
    if (app === 'torihiki' && a === 'data') return out_({ ok: true, suppliers: rows_('suppliers') });
    if (app === 'sharyo' && a === 'data') return out_({ ok: true, vehicles: rows_('vehicles'), logs: rows_('vehicleLog'), docs: rows_('vehicleDocs'), suppliers: rows_('suppliers') });
    if (app === 'dandori') {
      var today = ymd_(new Date());
      if (a === 'data') return out_({ ok: true, cards: cards_(p.from || addDays_(today, -7), p.to || addDays_(today, 30)), nicknames: rows_('nicknames'), suppliers: rows_('suppliers'), vehicles: rows_('vehicles') });
      if (a === 'calendar') { var c = calendar_(p.from || today, p.to || addDays_(today, 14)); return out_({ ok: true, sites: c.sites, holidays: c.holidays, timed: c.timed }); }
      if (a === 'colors') return out_(Object.assign({ ok: true }, colors_(today, addDays_(today, 30))));
    }
    return out_({ ok: false, error: 'unknown action' });
  } catch (err) { return out_({ ok: false, error: String(err) }); }
}
function doPost(e) {
  var b = {};
  try { b = JSON.parse(e.postData.contents); } catch (err) { return out_({ ok: false, error: 'bad json' }); }
  try {
    var key = (b.app || '') + ':' + (b.mode || '');
    switch (key) {
      /* 用語集 */
      case 'yougo:aiSearch':   return out_(aiSearch_(b.query, b.categories));
      case 'yougo:explain':    return out_(explain_(b.word));
      case 'yougo:addTerm':    return withLock_(function () { return addTerm_(b.term, b.aliases, b.by); });
      case 'yougo:updateTerm': return withLock_(function () { return updateTerm_(b.id, b.patch); });
      case 'yougo:addAlias':   return withLock_(function () { return addAlias_(b.alias, b.termId, b.type, b.by, b.kana, b.state); });
      case 'yougo:review':     return withLock_(function () { return reviewWord_(b.kind, b.key, b.action); });
      case 'yougo:import':     return withLock_(function () { return import_(b.terms, b.aliases); });
      /* 道具管理 */
      case 'dougu:identify':   return out_(identify_(b.text, b.image, b.loc, b.catalog));
      case 'dougu:addTool':    return withLock_(function () { return addTool_(b.tool, b.image, b.by); });
      case 'dougu:updateTool': return withLock_(function () { return updateTool_(b.id, b.patch, b.by); });
      case 'dougu:review':     return withLock_(function () { return updateTool_(b.key, { reviewState: b.action === 'approve' ? '確認済' : '未確認' }); });
      case 'dougu:addRepair':  return withLock_(function () { return addRepair_(b.log, b.by); });
      case 'dougu:deleteRepair': return withLock_(function () { return remove_('toolRepair', b.logId); });
      /* 取引先 */
      case 'torihiki:save':    return withLock_(function () { return upsert_('suppliers', 'id', 'S', b.item, b.by); });
      case 'torihiki:delete':  return withLock_(function () { return remove_('suppliers', b.id); });
      /* 車両 */
      case 'sharyo:save':      return withLock_(function () { return saveVehicle_(b.item, b.image, b.by); });
      case 'sharyo:delete':    return withLock_(function () { return remove_('vehicles', b.id); });
      case 'sharyo:addLog':    return withLock_(function () { return upsert_('vehicleLog', 'logId', 'L', Object.assign({ by: b.by, at: now_() }, b.log), b.by); });
      case 'sharyo:deleteLog': return withLock_(function () { return remove_('vehicleLog', b.logId); });
      case 'sharyo:addDoc':    return out_(addVehicleDoc_(b));
      case 'sharyo:deleteDoc': return withLock_(function () { return deleteVehicleDoc_(b.docId); });
      case 'sharyo:readDoc':   return out_(readShaken_(b.data, b.mime));
      /* 段取り */
      case 'dandori:organize':   return out_(organize_(b));
      case 'dandori:saveCards':  return withLock_(function () { return saveCards_(b.cards, b.by); });
      case 'dandori:updateCard': return withLock_(function () { return updateCard_(b.cardId, b.patch); });
      case 'dandori:deleteCard': return withLock_(function () { return deleteCard_(b.cardId); });
      case 'dandori:addNickname':    return withLock_(function () { return addNickname_(b.name, b.nickname, b.by); });
      case 'dandori:deleteNickname': return withLock_(function () { return deleteNickname_(b.name, b.nickname); });
      default: return out_({ ok: false, error: 'unknown mode: ' + key });
    }
  } catch (err) { return out_({ ok: false, error: String(err) }); }
}

/* ================================================================
 *  取引先・車両・修理履歴（1行1件の表。id で上書き、無ければ追加）
 * ================================================================ */
function cell_(v) {   // 電話番号・ナンバー・日付などを、スプレッドシートに勝手に数字や日付へ変えられないよう文字のまま入れる
  if (typeof v === 'string' && /^[\d\-\/\.:\s+()]+$/.test(v) && v.trim() !== '') return "'" + v;
  return v;
}
function upsert_(key, idCol, prefix, obj, by) {
  obj = obj || {};
  var s = sh_(key), head = SHEETS[key].head, vals = s.getDataRange().getValues(), row = 0, id = String(obj[idCol] || '').trim();
  if (id) for (var i = 1; i < vals.length; i++) if (String(vals[i][0]) === id) { row = i + 1; break; }
  if (!id) id = nextId_(key, idCol, prefix);
  obj[idCol] = id;
  if (head.indexOf('updatedBy') >= 0) obj.updatedBy = by || obj.updatedBy || '';
  if (head.indexOf('updatedAt') >= 0) obj.updatedAt = now_();
  var old = row ? vals[row - 1] : null;
  var r = head.map(function (h, c) { var v = obj.hasOwnProperty(h) ? obj[h] : (old ? old[c] : ''); return cell_(v == null ? '' : v); });
  if (row) s.getRange(row, 1, 1, r.length).setValues([r]); else s.appendRow(r);
  return { ok: true, id: id };
}
function remove_(key, id) {
  var s = sh_(key), vals = s.getDataRange().getValues();
  for (var i = vals.length - 1; i >= 1; i--) if (String(vals[i][0]) === String(id)) { s.deleteRow(i + 1); return { ok: true }; }
  return { ok: false, error: '見つかりません: ' + id };
}
function saveVehicle_(item, image, by) {
  item = item || {};
  if (!item.id && !String(item.name || '').trim()) return { ok: false, error: '車両の名前がありません' };
  var r = upsert_('vehicles', 'id', 'V', item, by);
  if (image) { var p = savePhoto_(image, r.id); upsert_('vehicles', 'id', 'V', { id: r.id, photoUrl: p.url, photoId: p.id }, by); r.photoUrl = p.url; }
  return r;
}
/* 車両の書類（車検証・保険証など）：公開リンクにはせず、スプレッドシートと同じフォルダの「車両の書類」に置く
   （社内アプリのフォルダを共有しているスタッフだけが、Googleにログインして開ける） */
var DOCS_FOLDER = '車両の書類';
function docsFolder_() {
  var p = PropertiesService.getScriptProperties(), id = prop_('DOCS_FOLDER_ID', '');
  if (id) { try { var f = DriveApp.getFolderById(id); if (!f.isTrashed()) return f; } catch (e) {} }
  var parent;
  try { var ps = DriveApp.getFileById(ss_().getId()).getParents(); parent = ps.hasNext() ? ps.next() : DriveApp.getRootFolder(); } catch (e) { parent = DriveApp.getRootFolder(); }
  var it = parent.getFoldersByName(DOCS_FOLDER), folder = it.hasNext() ? it.next() : parent.createFolder(DOCS_FOLDER);
  p.setProperty('DOCS_FOLDER_ID', folder.getId());
  return folder;
}
function addVehicleDoc_(b) {
  if (!b.vehicleId || !b.data) return { ok: false, error: '車両か書類がありません' };
  var v = rows_('vehicles').filter(function (x) { return String(x.id) === String(b.vehicleId); })[0];
  var mime = b.mime || 'image/jpeg', ext = mime === 'application/pdf' ? '.pdf' : '.jpg';
  var name = [(v && v.name) || b.vehicleId, b.type || '書類', Utilities.formatDate(new Date(), TZ, 'yyyyMMdd_HHmmss')].join('_') + ext;
  var file = docsFolder_().createFile(Utilities.newBlob(Utilities.base64Decode(b.data), mime, name));
  var r = withLockRaw_(function () { return upsert_('vehicleDocs', 'docId', 'D', { vehicleId: b.vehicleId, type: b.type || 'その他', name: name, mime: mime, fileId: file.getId(), url: file.getUrl(), note: b.note || '', by: b.by || '', at: now_() }, b.by); });
  var out = { ok: true, id: r.id, url: file.getUrl() };
  if (b.read) { try { out.read = readShaken_(b.data, mime).data; } catch (e) { out.readError = String(e.message || e); } }
  return out;
}
function deleteVehicleDoc_(docId) {
  var d = rows_('vehicleDocs').filter(function (x) { return String(x.docId) === String(docId); })[0];
  if (!d) return { ok: false, error: '書類が見つかりません' };
  try { DriveApp.getFileById(d.fileId).setTrashed(true); } catch (e) { /* ファイルが既に無くても行は消す */ }
  return remove_('vehicleDocs', docId);
}
function readShaken_(b64, mime) {   // 車検証の写真・PDFから、ナンバー・車名・車検の満了日を読む
  var prompt = 'これは日本の自動車検査証（車検証）、または電子車検証の「自動車検査証記録事項」の写真かPDFです。次の項目を読み取り、JSONだけ返してください。' +
    '{"plate":"自動車登録番号・車両番号（例：川崎 400 あ 12-34）","model":"車名と型式（例：いすゞ エルフ TRG-NJR85AN）","shakenDate":"有効期間の満了する日を西暦 YYYY-MM-DD で（令和n年＝2018+n年）","firstReg":"初度登録年月 YYYY-MM","kind":"自家用・事業用 など"}' +
    '。読めない項目は空文字。推測で埋めない。';
  var j = gemini_([{ inline_data: { mime_type: mime || 'image/jpeg', data: b64 } }, { text: prompt }]) || {};
  return { ok: true, data: { plate: j.plate || '', model: j.model || '', shakenDate: /^\d{4}-\d{2}-\d{2}$/.test(j.shakenDate || '') ? j.shakenDate : '', firstReg: j.firstReg || '', kind: j.kind || '' } };
}
function withLockRaw_(fn) { var l = LockService.getScriptLock(); l.waitLock(25000); try { return fn(); } finally { l.releaseLock(); } }
function addRepair_(log, by) {   // 道具の修理の記録。「修理に出した」「修理から戻った」は道具の今どこも変える
  log = log || {};
  if (!log.toolId) return { ok: false, error: '道具がありません' };
  var r = upsert_('toolRepair', 'logId', 'R', Object.assign({ date: ymd_(new Date()), by: by || '', at: now_() }, log), by);
  if (log.type === '修理に出した') updateTool_(log.toolId, { status: '修理中', statusSite: log.shop || '', statusBy: by || '', statusAt: now_() }, by);
  if (log.type === '修理から戻った') updateTool_(log.toolId, { status: '倉庫', statusSite: '', statusBy: by || '', statusAt: now_() }, by);
  return r;
}

/* ================================================================
 *  用語集（言葉のマスタ）
 * ================================================================ */
function addTerm_(t, aliases, by) {
  if (!t || !t.term) return { ok: false, error: '用語がありません' };
  var dup = rows_('terms').filter(function (r) { return String(r.term) === String(t.term); })[0];
  if (dup) return { ok: false, error: '「' + t.term + '」はすでに登録されています', termId: dup.termId };
  var id = nextId_('terms', 'termId', 'Y');
  var kana = t.kana || (isKana_(t.term) ? toHira_(t.term) : reading_(t.term));
  sh_('terms').appendRow([id, t.term, kana, t.category || '社内用語', t.meaning || '', t.usage || '', t.related || '', t.toolId || '',
    t.source || '社内', t.photoUrl || '', t.reviewState || '未確認', by || '', now_()]);
  (aliases || []).forEach(function (a) { if (a && a.alias) addAlias_(a.alias, id, a.type, by, a.kana, a.state); });
  return { ok: true, termId: id, kana: kana };
}
function updateTerm_(id, patch) {
  var s = sh_('terms'), head = SHEETS.terms.head, vals = s.getDataRange().getValues();
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i][0]) !== String(id)) continue;
    patch = patch || {}; patch.updatedAt = now_();
    head.forEach(function (h, c) { if (patch.hasOwnProperty(h) && h !== 'termId') s.getRange(i + 1, c + 1).setValue(patch[h]); });
    return { ok: true, termId: id };
  }
  return { ok: false, error: '用語が見つかりません: ' + id };
}
function addAlias_(alias, termId, type, by, kana, state) {
  alias = String(alias || '').trim();
  if (!alias || !termId) return { ok: false, error: '呼び方か用語IDがありません' };
  if (rows_('aliases').some(function (r) { return String(r.termId) === String(termId) && String(r.alias) === alias; })) return { ok: true, duplicate: true };
  if (ALIAS_TYPES.indexOf(type) < 0) type = '別名';
  var k = kana || (isKana_(alias) ? toHira_(alias) : reading_(alias));
  sh_('aliases').appendRow([alias, k, termId, type, state || '承認待ち', by || '', now_()]);
  return { ok: true, kana: k };
}
function reviewWord_(kind, key, action) {
  if (kind === 'term') return updateTerm_(key, { reviewState: action === 'approve' ? '確認済' : '未確認' });
  if (kind === 'alias') {
    var s = sh_('aliases'), vals = s.getDataRange().getValues();
    for (var i = vals.length - 1; i >= 1; i--) {
      if (String(vals[i][2]) === String(key.termId) && String(vals[i][0]) === String(key.alias)) {
        if (action === 'approve') s.getRange(i + 1, 5).setValue('承認済'); else s.deleteRow(i + 1);
        return { ok: true };
      }
    }
    return { ok: false, error: '呼び方が見つかりません' };
  }
  return { ok: false, error: 'unknown kind' };
}
function import_(terms, aliases) {   // 同じ termId は飛ばす（何回やっても二重にならない）
  var have = {}; rows_('terms').forEach(function (t) { have[t.termId] = 1; });
  var haveA = {}; rows_('aliases').forEach(function (a) { haveA[a.termId + '|' + a.alias] = 1; });
  var tRows = (terms || []).filter(function (t) { return !have[t.termId]; }).map(function (t) {
    return [t.termId, t.term, t.kana, t.category, t.meaning, t.usage, t.related, t.toolId || '', t.source || '業界', '', t.reviewState || '下書き', t.addedBy || 'Claude下書き', now_()];
  });
  var aRows = (aliases || []).filter(function (a) { return !haveA[a.termId + '|' + a.alias]; }).map(function (a) {
    return [a.alias, a.kana || '', a.termId, a.type, a.state || '承認済', a.addedBy || 'Claude下書き', now_()];
  });
  if (tRows.length) { var s = sh_('terms'); s.getRange(s.getLastRow() + 1, 1, tRows.length, tRows[0].length).setValues(tRows); }
  if (aRows.length) { var s2 = sh_('aliases'); s2.getRange(s2.getLastRow() + 1, 1, aRows.length, aRows[0].length).setValues(aRows); }
  return { ok: true, terms: tRows.length, aliases: aRows.length };
}
function seedImport_() {
  return import_(SEED_TERMS.map(function (r) { return { termId: r[0], term: r[1], kana: r[2], category: r[3], meaning: r[4], usage: r[5], related: r[6], toolId: '' }; }),
    SEED_ALIASES.map(function (a) { return { alias: a[0], kana: a[1], termId: a[2], type: a[3] }; }));
}
function catalog_(categories) {
  var al = {};
  rows_('aliases').forEach(function (a) { (al[a.termId] = al[a.termId] || []).push(a.alias + (a.kana ? '(' + a.kana + ')' : '')); });
  return rows_('terms').filter(function (t) { return !categories || !categories.length || categories.indexOf(t.category) >= 0; }).map(function (t) {
    return [t.termId, t.term + '(' + t.kana + ')', t.category, '呼び方:' + (al[t.termId] || []).join('/'), '意味:' + String(t.meaning).slice(0, 40)].join(' | ');
  }).join('\n');
}
function aiSearch_(query, categories) {   // 聞き間違い・うろ覚え・説明から候補を探す
  if (!query) return { ok: false, error: '検索する言葉がありません' };
  var j = gemini_(
    'あなたは造園会社（植木屋）のベテラン職人です。新人が現場で聞いた言葉を調べています。新人の入力：「' + query + '」。' +
    'これは用語・社内の呼び方・聞き間違い（音が似た別の言葉、例：「竹屋」→「掛矢」、「しおる」→「枝しおり」）・' +
    'うろ覚え・意味の説明のどれかです。読み（音）の近さも考えて、次の一覧から当てはまるものを最大3つ選んでください。' +
    'JSONだけ返す：{"results":[{"id":"用語ID","reason":"理由15字以内"}]}\n一覧：\n' + catalog_(categories));
  var ids = {}; rows_('terms').forEach(function (t) { ids[t.termId] = 1; });
  return { ok: true, results: (j.results || []).filter(function (r) { return ids[r.id]; }).slice(0, 3) };
}
function explain_(word) {   // 新しい言葉の意味を下書き（必ず人が確認する前提）
  if (!word) return { ok: false, error: '言葉がありません' };
  var j = gemini_(
    'あなたは造園会社（植木屋）のベテラン職人で、新入社員に言葉を教えます。言葉：「' + word + '」。' +
    '造園・植木の現場での意味を、中学生にも分かるやさしい言葉で1〜2文で説明してください。分からなければ meaning を空にしてください。' +
    '分類は次から1つ：' + CATEGORIES.join('／') + '。' +
    'JSONだけ返す：{"kana":"ひらがな読み","category":"分類","meaning":"意味","usage":"現場での言い回しの例（「」付き）"}');
  return { ok: true, data: { kana: toHira_(j.kana || ''), category: CATEGORIES.indexOf(j.category) >= 0 ? j.category : '社内用語', meaning: j.meaning || '', usage: j.usage || '' } };
}
function reading_(word) {
  try { return toHira_((gemini_('造園の言葉「' + word + '」のひらがな読みをJSONだけで返す：{"kana":"よみ"}') || {}).kana || ''); }
  catch (e) { return ''; }
}

/* ================================================================
 *  道具管理（道具マスタは用語IDで用語集とつながる）
 * ================================================================ */
function addTool_(t, image, by) {
  if (!t || !t.termId) return { ok: false, error: '用語ID（termId）がありません' };
  var id = nextId_('tools', 'id', 'T');
  var photo = image ? savePhoto_(image, id) : { url: '', id: '' };
  sh_('tools').appendRow([id, t.termId, t.location || '', Number(t.qty) || 1, photo.url, photo.id, '倉庫', '', '', '', by || '', '未確認', now_(), now_()]);
  return { ok: true, id: id, photoUrl: photo.url };
}
function updateTool_(id, patch, by) {
  var s = sh_('tools'), head = SHEETS.tools.head, vals = s.getDataRange().getValues();
  for (var i = 1; i < vals.length; i++) {
    if (String(vals[i][0]) !== String(id)) continue;
    patch = patch || {};
    if (patch.addQty) { patch.qty = (Number(vals[i][head.indexOf('qty')]) || 0) + Number(patch.addQty); delete patch.addQty; }
    if (patch.image) { var p = savePhoto_(patch.image, id); patch.photoUrl = p.url; patch.photoId = p.id; delete patch.image; }
    if (patch.status && patch.status !== vals[i][head.indexOf('status')]) {   // 持ち出し・戻しを履歴に残す
      sh_('toolLog').appendRow([now_(), id, patch.status, patch.statusSite || '', patch.statusBy || by || '']);
    }
    patch.updatedAt = now_();
    head.forEach(function (h, c) { if (patch.hasOwnProperty(h) && h !== 'id') s.getRange(i + 1, c + 1).setValue(patch[h]); });
    return { ok: true, id: id, qty: patch.qty, photoUrl: patch.photoUrl };
  }
  return { ok: false, error: '道具が見つかりません: ' + id };
}
function folder_() {
  var it = DriveApp.getFoldersByName(PHOTO_FOLDER);
  return it.hasNext() ? it.next() : DriveApp.createFolder(PHOTO_FOLDER);
}
function savePhoto_(b64, name) {
  var f = folder_().createFile(Utilities.newBlob(Utilities.base64Decode(b64), 'image/jpeg', name + '_' + Date.now() + '.jpg'));
  f.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  return { id: f.getId(), url: 'https://drive.google.com/thumbnail?id=' + f.getId() + '&sz=w800' };
}
function identify_(text, image, loc, catalog) {   // 写真と話した名前から、登録済みの道具と同じかを判定
  var prompt =
    'あなたは造園会社（植木屋）の道具係です。スタッフが倉庫で道具を登録しています。' +
    'スタッフが話した呼び方：「' + (text || '（なし）') + '」。保管場所：' + (loc || '不明') + '。' + (image ? '写真も添付します。' : '') +
    '次の登録済み一覧に同じ道具があるか判定し、なければ新しい道具として正式名を考えてください。' +
    '話した言葉は社内の呼び方・略称・音声の聞き間違い（例：たけや→かけや）の可能性があります。' +
    '正式名は造園業界で一般的な名称（例：剪定鋏、刈込鋏、唐鍬、掛矢、ヘッジトリマー）にしてください。' +
    'JSONだけ返す：{"matchId":"一致する道具のID または null","matchConfidence":0〜1,' +
    '"name":"正式名","kana":"正式名のひらがな読み","commonName":"現場でよく使う呼び方（話した言葉が適切ならそれ）",' +
    '"feature":"見た目と用途を20字以内","why":"判断理由20字以内"}\n登録済み一覧：\n' + (catalog || '（まだありません）');
  var parts = [];
  if (image) parts.push({ inline_data: { mime_type: 'image/jpeg', data: image } });
  parts.push({ text: prompt });
  var j = gemini_(parts);
  return { ok: true, data: { matchId: j.matchId && j.matchId !== 'null' ? String(j.matchId) : null, matchConfidence: Number(j.matchConfidence) || 0,
    name: j.name || '', kana: toHira_(j.kana || ''), commonName: j.commonName || '', feature: j.feature || '', why: j.why || '' } };
}

/* ================================================================
 *  段取り（カード・カレンダー・AI整理）
 * ================================================================ */
function cards_(from, to) {
  return rows_('cards').map(function (o) {
    JSON_COLS.forEach(function (h) { try { o[h] = o[h] ? JSON.parse(o[h]) : []; } catch (e) { o[h] = []; } });
    o.staff = o.staff ? String(o.staff).split('・') : [];
    return o;
  }).filter(function (o) { return !o.date || ((!from || o.date >= from) && (!to || o.date <= to)); });   // 日付未定のカードは常に返す
}
/* 名簿の呼び名（あだ名）：山ちゃん→山口 など */
function addNickname_(name, nick, by) {
  name = String(name || '').trim(); nick = String(nick || '').trim();
  if (!name || !nick) return { ok: false, error: '名前か呼び名がありません' };
  if (rows_('nicknames').some(function (r) { return r.name === name && r.nickname === nick; })) return { ok: true, duplicate: true };
  sh_('nicknames').appendRow([name, nick, by || '', now_()]);
  return { ok: true };
}
function deleteNickname_(name, nick) {
  var s = sh_('nicknames'), vals = s.getDataRange().getValues();
  for (var i = vals.length - 1; i >= 1; i--) if (vals[i][0] === name && vals[i][1] === nick) { s.deleteRow(i + 1); return { ok: true }; }
  return { ok: false, error: '呼び名が見つかりません' };
}
function saveCards_(cards, by) {
  var s = sh_('cards'), head = SHEETS.cards.head, vals = s.getDataRange().getValues(), idx = {}, ids = [];
  for (var i = 1; i < vals.length; i++) idx[String(vals[i][0])] = i + 1;
  (cards || []).forEach(function (c) {
    c.cardId = c.cardId || ('C' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36));
    c.createdBy = c.createdBy || by || '';
    c.updatedAt = now_();
    var r = head.map(function (h) {
      var v = c[h];
      if (h === 'staff') return (v || []).join('・');
      if (JSON_COLS.indexOf(h) >= 0) return JSON.stringify(v || []);
      return v == null ? '' : v;
    });
    if (idx[c.cardId]) s.getRange(idx[c.cardId], 1, 1, r.length).setValues([r]);
    else { s.appendRow(r); idx[c.cardId] = s.getLastRow(); }
    ids.push(c.cardId);
  });
  return { ok: true, cardIds: ids };
}
function updateCard_(id, patch) {
  var c = cards_().filter(function (x) { return String(x.cardId) === String(id); })[0];
  if (!c) return { ok: false, error: 'カードが見つかりません' };
  Object.keys(patch || {}).forEach(function (k) { c[k] = patch[k]; });
  return saveCards_([c]);
}
function deleteCard_(id) {
  var s = sh_('cards'), vals = s.getDataRange().getValues();
  for (var i = vals.length - 1; i >= 1; i--) if (String(vals[i][0]) === String(id)) { s.deleteRow(i + 1); return { ok: true }; }
  return { ok: false, error: 'カードが見つかりません' };
}
// カレンダー：マイカレンダーの名前で選ぶ（既定：現場＝「現場カレンダー」、休み＝「出勤調整カレンダー」）
function calName_(k) { return prop_(k, k === 'SITE_CALENDAR' ? '現場カレンダー' : '出勤調整カレンダー'); }
function calByName_(name) {
  var n = String(name || '').replace(/\s/g, '');
  if (!n) return null;
  var hit = CalendarApp.getCalendarsByName(name);
  if (hit.length) return hit[0];
  var all = CalendarApp.getAllCalendars();   // 空白のちがいは気にしない
  for (var i = 0; i < all.length; i++) if (all[i].getName().replace(/\s/g, '') === n) return all[i];
  return null;
}
// 予定の一覧。高度なサービス（Google Calendar API）を追加してあれば色番号と添付資料も読む
function events_(from, to, cal) {
  cal = cal || (prop_('CALENDAR_ID', 'primary') === 'primary' ? CalendarApp.getDefaultCalendar() : CalendarApp.getCalendarById(prop_('CALENDAR_ID', '')));
  var list = [], tMin = day_(from), tMax = day_(addDays_(to, 1));
  if (typeof Calendar !== 'undefined') {
    var token, items = [];
    do {
      var res = Calendar.Events.list(cal.getId(), { timeMin: tMin.toISOString(), timeMax: tMax.toISOString(), singleEvents: true, orderBy: 'startTime', maxResults: 250, pageToken: token });
      items = items.concat(res.items || []); token = res.nextPageToken;
    } while (token);
    items.forEach(function (ev) {
      if (ev.status === 'cancelled') return;
      var allDay = !!(ev.start && ev.start.date);
      list.push({ id: ev.id, title: ev.summary || '', color: ev.colorId || '', allDay: allDay,
        time: allDay ? '' : Utilities.formatDate(new Date(ev.start.dateTime), TZ, 'H:mm'),
        start: allDay ? ev.start.date : ymd_(new Date(ev.start.dateTime)),
        endEx: allDay ? ev.end.date : addDays_(ymd_(new Date(ev.end.dateTime)), 1),
        attachments: (ev.attachments || []).map(function (a) { return { title: a.title, url: a.fileUrl }; }) });
    });
  } else {
    cal.getEvents(tMin, tMax).forEach(function (ev) {
      var allDay = ev.isAllDayEvent();
      list.push({ id: ev.getId(), title: ev.getTitle(), color: ev.getColor() || '', allDay: allDay,
        time: allDay ? '' : Utilities.formatDate(ev.getStartTime(), TZ, 'H:mm'),
        start: ymd_(allDay ? ev.getAllDayStartDate() : ev.getStartTime()),
        endEx: allDay ? ymd_(ev.getAllDayEndDate()) : addDays_(ymd_(ev.getEndTime()), 1), attachments: [] });
    });
  }
  return list;
}
function calendar_(from, to) {
  var siteCal = calByName_(calName_('SITE_CALENDAR')), holCal = calByName_(calName_('HOLIDAY_CALENDAR'));
  var sites = [], holidays = [], timed = [];
  function put(ev, kind) {
    if (!ev.allDay) {   // 時間の決まった予定は候補として返し、使うかどうかはアプリで聞く
      if (ev.start >= from && ev.start <= to) timed.push({ id: ev.id, date: ev.start, time: ev.time, title: ev.title, kind: kind });
      return;
    }
    for (var d = ev.start; d < ev.endEx; d = addDays_(d, 1)) {
      if (d < from || d > to) continue;
      if (kind === 'site') sites.push({ id: ev.id, date: d, title: ev.title, attachments: ev.attachments });
      else holidays.push({ id: ev.id, date: d, title: ev.title, all: /@all|全員/i.test(ev.title) });
    }
  }
  // 専用のカレンダーがあれば、その予定を読む（終日＝そのまま使う、時間あり＝候補）
  if (siteCal) events_(from, to, siteCal).forEach(function (ev) { put(ev, 'site'); });
  if (holCal) events_(from, to, holCal).forEach(function (ev) { put(ev, 'holiday'); });
  if (!siteCal || !holCal) {   // 見つからないときだけ、自分のカレンダーの色で見分ける（黄土色＝現場・ピンク＝休み）
    var siteColor = String(prop_('SITE_COLOR', '')), holColor = String(prop_('HOLIDAY_COLOR', '4'));
    events_(from, to).forEach(function (ev) {
      var c = String(ev.color || '');
      var kind = (c === siteColor || (siteColor === '' && (c === '' || c === '0'))) ? 'site' : (c === holColor ? 'holiday' : '');
      if (!ev.allDay) return;   // 自分のカレンダーの時間の予定は読まない
      if (kind === 'site' && !siteCal) put(ev, 'site');
      if (kind === 'holiday' && !holCal) put(ev, 'holiday');
    });
  }
  return { sites: sites, holidays: holidays, timed: timed };
}
function colors_(from, to) {   // 読めているかの確認用
  var siteName = calName_('SITE_CALENDAR'), holName = calName_('HOLIDAY_CALENDAR');
  var c = calendar_(from, to);
  return {
    現場のカレンダー: siteName + (calByName_(siteName) ? '（読めています）' : '（見つかりません：自分のカレンダーの色で見分けています）'),
    休みのカレンダー: holName + (calByName_(holName) ? '（読めています）' : '（見つかりません：自分のカレンダーの色で見分けています）'),
    マイカレンダーの一覧: CalendarApp.getAllCalendars().map(function (x) { return x.getName(); }),
    現場: c.sites.map(function (x) { return x.date + ' ' + x.title; }),
    休み: c.holidays.map(function (x) { return x.date + ' ' + x.title; }),
    時間の予定_アプリで確認: c.timed.map(function (x) { return x.date + ' ' + x.time + ' ' + x.title + '（' + (x.kind === 'site' ? '現場' : '休み') + 'のカレンダー）'; })
  };
}
function organize_(b) {   // 順不同に話した段取りを「日付×現場」のカード（と現場のない「やること」）に整理
  var prompt =
    'あなたは造園会社（植木屋）の段取り係です。親方が順番を気にせず話した段取りを、「日付×現場」ごとのカード（と、現場のない用事・みんなへのお知らせ）に整理してください。\n' +
    '話した日時：' + (b.spokenAt || now_()) + '（「今日」「明日」「明後日」「木曜」「来週月曜」はこの日時を基準に実際の日付 YYYY-MM-DD に直す）\n' +
    '話している人：' + (b.speaker || '親方') + '（「私」「俺」はこの人）\n' +
    'ルール：\n' +
    '・1つの話に複数の日付・現場が混ざっていたら別々のカードにする。同じ大きな現場でも、班が分かれて別の公園に行くなら公園ごとに分ける\n' +
    '・現場名は「現場マスタ」の名前に合わせる。音声の聞き間違いが多い（例：「高津大さん上作第3公園」→「上作延第3公園」）ので、音や字が近い名前に直し、直したら corrections に「元の言葉→直した名前」を書く。カレンダーの予定名（例：高津公園）は委託全体の名前のことがある\n' +
    '・現場に結びつかない用事（残土を捨てに行く、買い物だけ、機械の修理など）は kind を "task" にし、title に短い名前（例：残土処分）を付ける。現場のカードは kind を "site"\n' +
    '・予定や作業ではない、みんなへの連絡（例：「みんなに伝えておいて」「お知らせ」、道具の置き場所が変わった、来週から朝礼の時間が変わる、健康診断の日程、雨具を持ってくる、値上げ前にまとめて注文するので欲しい人は申し出て）は kind を "notice" にし、title にお知らせの文を、スタッフが読んで分かる短い文で書く。date は「いつまで表示するか」で、話に期限や日付があればその日、なければ空。notice には members・items などは書かない\n' +
    '・日付がはっきりしない用事は date を空にし、dateNote に話した条件を書く（例：「明日が厳しければ別の日」なら date は明日、dateNote に「厳しければ別の日」）\n' +
    '・期限のある用事（「今週中に」「〇日までに」）は date に期限の日（「今週中」はその週の土曜日、「来週中」は次の週の土曜日）、dateNote に「今週中に」「〇日までに」のように「まで」「中に」を入れて書く\n' +
    '・メンバーは名簿の正式な名前で書く。呼び名（あだ名・〜くん・〜ちゃん）は名簿の呼び名で直す。名簿に無い呼び名は unknownPeople に話したとおり書く\n' +
    '・スタッフではない人（業者・お店・「〜屋さん」・お客さん・元請・役所の担当者など。名簿の「スタッフではない人」も含む）は、members にも unknownPeople にも入れない。必要なら notes に「竹屋さんに聞いた」のように書く\n' +
    '・「全員」「私以外全員」「他の人」は名簿から展開する。その日休みの人（休みの人の一覧）は入れず、notes に「○○さんは休み」と書く\n' +
    '・言い直し（「12本、いや15本」「やっぱ15本」）は後の発言を採用する\n' +
    '・items は現場に持って行く道具・資材。stops は立ち寄り先と、そこで買う／受け取る物（話した順に order を振る）\n' +
    '・steps は作業の流れを順番に短く（例：抜根、掘削、植付、支柱）。notes は注意点・準備・誰が決めるか・誰に聞くかなど\n' +
    '・道具や資材の名前は、下の辞書の「正式名」に直す（社内の呼び方・聞き間違いも辞書で直す）\n' +
    '・誰か・どこかが分からない言葉（「あそこ」「あれ」、聞き取れない地名）は unresolved に質問として書く\n' +
    '・話に出ていないことは書かない（道具を勝手に足さない）\n' +
    'JSONだけ返す：{"cards":[{"kind":"site・task・notice のどれか","date":"YYYY-MM-DD または空","dateNote":"","site":"現場名（task なら空）","title":"task の名前・notice のお知らせ文（site なら空）",' +
    '"meetTime":"7:30 など、なければ空","members":["名簿の名前"],"vehicle":"車両、なければ空",' +
    '"stops":[{"order":1,"place":"立ち寄り先","items":[{"name":"品名","qty":数または空,"unit":"本 など"}]}],' +
    '"items":[{"name":"正式名","qty":数または空,"unit":""}],"steps":["作業"],"notes":["注意点"],"unresolved":["確認したいこと"],' +
    '"unknownPeople":["名簿に無い呼び名"],"corrections":["元の言葉→直した名前"]}]}\n\n' +
    'カレンダー（現場の予定）：\n' + (b.sites || []).map(function (s) { return s.date + '：' + s.title; }).join('\n') + '\n' +
    '休みの人：\n' + (b.holidays || []).map(function (h) { return h.date + '：' + h.title; }).join('\n') + '\n' +
    '名簿（正式な名前：呼び名）：\n' + (b.roster || (b.staff || []).join('、')) + '\n' +
    '現場マスタ（実際の現場名）：\n' + (b.masterSites || []).join('、') + '\n' +
    (b.suppliers ? '取引先（正式名：呼び方。立ち寄り先 stops.place はこの正式名に直す。取引先の店・人はスタッフではない）：\n' + b.suppliers + '\n' : '') +
    (b.vehicles ? '車両（vehicle はこの名前に合わせる）：\n' + b.vehicles + '\n' : '') +
    '道具・資材の辞書（呼び方→正式名）：\n' + (b.dict || '') + '\n\n' +
    '話した内容：\n' + b.text;
  var j = gemini_(prompt);
  return { ok: true, cards: j.cards || [] };
}

/* ================================================================
 *  用語集の下書き（setup で自動取り込み）。意味はすべて Claude の下書き＝要確認
 * ================================================================ */
var SEED_TERMS = [["Y0001","剪定","せんてい","剪定・手入れ","枝を切って木の形や大きさを整え、木を健康に保つ作業。","「今日は高津公園のケヤキの剪定」","透かし剪定・刈り込み",""],
  ["Y0002","透かし剪定","すかしせんてい","剪定・手入れ","混み合った枝を付け根から間引き、木の形は残したまま風通しと日当たりを良くする剪定。","「この木は透かしで軽くして」","大透かし・中透かし・小透かし・忌み枝",""],
  ["Y0003","大透かし","おおすかし","剪定・手入れ","木の骨組みになる太い枝（主枝）の一部を、分かれ目から抜く透かし。大きく軽くなる。","","透かし剪定・主枝",""],
  ["Y0004","中透かし","ちゅうすかし","剪定・手入れ","主枝から出た二番目の太さの枝（副主枝）を、分かれ目から間引く透かし。","","透かし剪定",""],
  ["Y0005","小透かし","こすかし","剪定・手入れ","枝先の細かい枝を間引いて、木の外側を軽く整える透かし。","「今年は小透かし程度でいい」","透かし剪定",""],
  ["Y0006","枝おろし","えだおろし","剪定・手入れ","太い枝を付け根から切り落とすこと。下の枝を落として木の下をすっきりさせるときにも言う。","「下枝を2本おろして」","二段切り・枝下高",""],
  ["Y0007","切り返し","きりかえし","剪定・手入れ","長く伸びた枝を、途中の分かれ目にある短い枝の所で切って、枝先を内側に戻す剪定。木をひと回り小さくできる。","","切り詰め",""],
  ["Y0008","切り詰め","きりつめ","剪定・手入れ","枝を途中で切って短くすること。そこから新しい芽を出させて枝を作り直す。","","切り返し・ぶつ切り",""],
  ["Y0009","刈り込み","かりこみ","剪定・手入れ","刈込鋏やバリカンで、生垣や玉物の表面を切りそろえること。","「生垣は刈り込みで面をそろえて」","刈込鋏・ヘッジトリマー・生垣・玉物",""],
  ["Y0010","二段切り","にだんぎり","剪定・手入れ","太い枝を切るとき、先に少し先の所で枝を落としてから付け根で切り直す切り方。重みで樹皮が裂けるのを防ぐ。","「太いから二段で切って」","枝おろし",""],
  ["Y0011","ぶつ切り","ぶつぎり","剪定・手入れ","枝分かれを考えずに枝や幹の途中で切ること。こぶや胴吹きの原因になり、見た目も悪いので基本は避ける。","","切り詰め・剪定こぶ・胴吹き",""],
  ["Y0012","剪定こぶ","せんていこぶ","剪定・手入れ","同じ場所で何度も切り詰めたせいで、枝先にできたこぶ状のふくらみ。","","ぶつ切り",""],
  ["Y0013","芯止め","しんどめ","剪定・手入れ","木のてっぺんの幹（芯）を切って、それ以上高くならないようにすること。","「この高さで芯を止めて」","芯",""],
  ["Y0014","枝しおり","えだしおり","剪定・手入れ","掘り取りや運搬の前に、広がった枝を縄で幹の方へ寄せて束ねておくこと。枝が折れず、作業や積み込みがしやすくなる。","「積む前に枝をしおっておいて」","掘り取り・移植・シュロ縄",""],
  ["Y0015","マルキ","まるき","剪定・手入れ","切った枝などを束ねて縄で結ぶこと。またはその束（地域や会社によって言い方が違う）。","「枝はマルキにしてトラックへ」","発生材",""],
  ["Y0016","みどり摘み","みどりつみ","剪定・手入れ","春に松の新しい芽（みどり）を手で摘んで、伸びる長さや数をそろえる作業。","「5月は松のみどり摘み」","もみあげ・芽摘み",""],
  ["Y0017","もみあげ","もみあげ","剪定・手入れ","秋から冬にかけて、松の古い葉を手でむしり取る作業。中まで光と風が入る。","「冬は松のもみあげ」","みどり摘み",""],
  ["Y0018","芽摘み","めつみ","剪定・手入れ","伸び始めた新芽を指や鋏で摘んで、枝の伸びすぎを抑えること。","","みどり摘み・芽切鋏",""],
  ["Y0019","伐採","ばっさい","剪定・手入れ","木を根元近くで切り倒すこと。","「枯れたサクラを伐採」","抜根・玉切り",""],
  ["Y0020","抜根","ばっこん","剪定・手入れ","木の根を掘り起こして取り除くこと。","「抜根してから植える」","伐採・唐鍬",""],
  ["Y0021","玉切り","たまぎり","剪定・手入れ","切り倒した幹や太い枝を、運べる長さに輪切りにすること。","「幹は50センチで玉切り」","伐採・チェーンソー",""],
  ["Y0022","消毒","しょうどく","剪定・手入れ","病気や害虫を防ぐために薬剤をまくこと。","「明日はツバキの消毒」","動力噴霧器・チャドクガ",""],
  ["Y0023","除草","じょそう","剪定・手入れ","雑草を取り除くこと。手で抜く、刈る、薬を使うなどの方法がある。","","草刈り",""],
  ["Y0024","草刈り","くさかり","剪定・手入れ","伸びた草を刈払機や鎌で刈ること。","","刈払機・除草",""],
  ["Y0025","癒合剤","ゆごうざい","剪定・手入れ","太い枝を切った後の切り口に塗る薬。切り口を保護し、腐れや乾燥を防ぐ。","「切り口に癒合剤を塗っておいて」","二段切り",""],
  ["Y0026","フラッシュカット","ふらっしゅかっと","剪定・手入れ","枝を幹にぴったり沿わせて切る切り方。枝の付け根の守りの組織まで削ってしまうので避ける。","","ブランチカラー",""],
  ["Y0027","ブランチカラー","ぶらんちからー","剪定・手入れ","枝の付け根にある少しふくらんだ部分。ここを残して切ると切り口がふさがりやすい。","","フラッシュカット",""],
  ["Y0028","忌み枝","いみえだ","枝・芽の名前","木の形を乱したり、木を弱らせたりする、切るべき枝の呼び名の総称。","「まず忌み枝から抜いていく」","徒長枝・逆さ枝・からみ枝・平行枝・車枝・ふところ枝・胴吹き・ひこばえ",""],
  ["Y0029","徒長枝","とちょうし","枝・芽の名前","勢いよく真上にまっすぐ長く伸びた枝。花や実がつきにくく、形を乱す。","「徒長枝は付け根から抜いて」","忌み枝・立ち枝",""],
  ["Y0030","立ち枝","たちえだ","枝・芽の名前","横に広がる枝から、真上に向かって立ち上がる枝。","","徒長枝",""],
  ["Y0031","逆さ枝","さかさえだ","枝・芽の名前","木の内側（幹の方）や下に向かって伸びる枝。","","忌み枝",""],
  ["Y0032","からみ枝","からみえだ","枝・芽の名前","ほかの枝と交差したり、こすれ合ったりしている枝。","","忌み枝",""],
  ["Y0033","平行枝","へいこうし","枝・芽の名前","近い所から同じ方向に並んで伸びる枝。どちらか一方を切る。","","忌み枝",""],
  ["Y0034","車枝","くるまえだ","枝・芽の名前","幹の同じ高さから、車輪のように放射状に何本も出た枝。間引いて1〜2本にする。","","忌み枝",""],
  ["Y0035","ふところ枝","ふところえだ","枝・芽の名前","木の内側の日陰に出た、細くて弱い枝。","","忌み枝",""],
  ["Y0036","胴吹き","どうぶき","枝・芽の名前","幹から直接出てくる小さな枝や芽。","「幹の胴吹きは全部かいて」","忌み枝・ひこばえ",""],
  ["Y0037","ひこばえ","ひこばえ","枝・芽の名前","根元や地面の近くから出てくる若い芽や枝。","「根元のやごを取っておいて」","胴吹き・忌み枝",""],
  ["Y0038","枯れ枝","かれえだ","枝・芽の名前","枯れてしまった枝。落ちると危ないので見つけたら取る。","","",""],
  ["Y0039","主枝","しゅし","枝・芽の名前","幹から出て木の骨組みになる、いちばん太い枝。","","大透かし・側枝",""],
  ["Y0040","側枝","そくし","枝・芽の名前","主枝などから分かれて出る細い枝。","","主枝",""],
  ["Y0041","芯","しん","枝・芽の名前","木のてっぺんに向かって伸びる中心の幹。","「芯を一本に決めて」","芯止め",""],
  ["Y0042","頂芽","ちょうが","枝・芽の名前","枝の先端にある芽。いちばん勢いよく伸びる。","","脇芽",""],
  ["Y0043","脇芽","わきめ","枝・芽の名前","葉の付け根から出る芽。","","頂芽",""],
  ["Y0044","花芽","はなめ","枝・芽の名前","咲くと花になる芽。花木はこれを切らないように剪定の時期を選ぶ。","「花芽を落とさないように」","葉芽",""],
  ["Y0045","葉芽","はめ","枝・芽の名前","伸びると葉や枝になる芽。","","花芽",""],
  ["Y0046","自然樹形","しぜんじゅけい","樹形・仕立て","その木が本来持っている形を生かした樹形。","","透かし剪定・人工樹形",""],
  ["Y0047","人工樹形","じんこうじゅけい","樹形・仕立て","刈り込みなどで、人が決めた形に作った樹形。","","玉物・段作り・生垣",""],
  ["Y0048","仕立て","したて","樹形・仕立て","剪定や刈り込みで、木を決まった形に作り上げること。","「この木は玉散らしに仕立ててある」","玉物・玉散らし・段作り",""],
  ["Y0049","玉物","たまもの","樹形・仕立て","丸く刈り込んで作った低木。ツツジ・サツキ・キャラなど。","「玉物は丸く刈って」","刈り込み・人工樹形",""],
  ["Y0050","玉散らし","たまちらし","樹形・仕立て","枝先ごとに小さな丸い葉のかたまり（玉）をいくつも作った仕立て。マキやイヌツゲに多い。","","仕立て・段作り",""],
  ["Y0051","段作り","だんづくり","樹形・仕立て","幹に沿って、丸い葉のかたまりを何段も重ねた仕立て。","","玉散らし",""],
  ["Y0052","生垣","いけがき","樹形・仕立て","木を列に植えて刈り込み、塀や目隠しにしたもの。","「生垣の天端をそろえて」","刈り込み・布掛け",""],
  ["Y0053","株立ち","かぶだち","樹形・仕立て","根元から何本もの幹が立ち上がっている樹形。","「シマトネリコの株立ち、3本立ち」","単幹",""],
  ["Y0054","単幹","たんかん","樹形・仕立て","根元から一本の幹で立っている樹形。","","株立ち",""],
  ["Y0055","門かぶり","もんかぶり","樹形・仕立て","門の上に枝がかぶさるように植えて仕立てた木。松やマキが多い。","","見越しの松",""],
  ["Y0056","見越しの松","みこしのまつ","樹形・仕立て","塀の内側に植えて、外から塀越しに見えるように仕立てた松。","","門かぶり",""],
  ["Y0057","台杉","だいすぎ","樹形・仕立て","一つの株から何本もの幹をまっすぐ立てた杉の仕立て。","","仕立て",""],
  ["Y0058","枝垂れ","しだれ","樹形・仕立て","枝が下に垂れ下がる性質や樹形。シダレザクラ・シダレヤナギなど。","","",""],
  ["Y0059","植栽","しょくさい","植栽・移植","木や草花を植えること。","「来週は新築の植栽」","植え穴・立て込み",""],
  ["Y0060","移植","いしょく","植栽・移植","植わっている木を掘り上げて、別の場所に植え替えること。","","根回し・掘り取り・根巻き",""],
  ["Y0061","根回し","ねまわし","植栽・移植","移植の半年〜1年前に、根の一部を切っておくこと。根元近くに細い根を出させて、移植しても枯れにくくする。","「来年動かす木は今のうちに根回し」","移植・根鉢",""],
  ["Y0062","掘り取り","ほりとり","植栽・移植","移植のために、木を根鉢ごと掘り上げること。","「明日は3本掘り取り」","根鉢・根巻き・枝しおり",""],
  ["Y0063","根鉢","ねばち","植栽・移植","掘り上げたときに根と一緒についてくる土のかたまり。現場では単に「鉢」と言うことが多い。","「鉢を崩さないように」","根巻き・掘り取り",""],
  ["Y0064","根巻き","ねまき","植栽・移植","掘り上げた根鉢が崩れないように、縄や布で巻いて締めること。","「根巻きは縄でしっかり」","根鉢・掘り取り",""],
  ["Y0065","振るい","ふるい","植栽・移植","根の土を落として、根だけの状態で移植するやり方。","","移植",""],
  ["Y0066","仮植え","かりうえ","植栽・移植","本植えまでの間、一時的に植えておくこと。","","",""],
  ["Y0067","植え穴","うえあな","植栽・移植","木を植えるために掘った穴。根鉢よりひと回り大きく掘る。","","立て込み・客土",""],
  ["Y0068","立て込み","たてこみ","植栽・移植","植え穴に木を立てて、向き（表）・傾き・高さを決めること。","「立て込んだら表を見て」","表・植え穴",""],
  ["Y0069","表","おもて","植栽・移植","木のいちばん見栄えのする面。植えるときはこちらを正面（見る人の方）に向ける。","「表はどっち？」","立て込み・見付",""],
  ["Y0070","埋め戻し","うめもどし","植栽・移植","掘った穴に土を戻して埋めること。","","水極め・土極め",""],
  ["Y0071","水極め","みずぎめ","植栽・移植","埋め戻しながら水をたっぷり入れ、棒で突いて泥水を根の隙間まで流し込む植え方。","「水極めでしっかり」","土極め・突き棒・水鉢",""],
  ["Y0072","土極め","つちぎめ","植栽・移植","水を使わず、土を少しずつ入れて棒で突き固める植え方。水を嫌う木に使う。","","水極め・突き棒",""],
  ["Y0073","水鉢","みずばち","植栽・移植","植えた木の周りに土で輪の土手を作り、水がたまるようにしたもの。","「水鉢を切っておいて」","水極め",""],
  ["Y0074","客土","きゃくど","植栽・移植","よそから良い土を持ち込んで入れること。また、その土。","「植え穴に客土を入れて」","土壌改良材・植え穴",""],
  ["Y0075","根締め","ねじめ","植栽・移植","木の根元に植える低木や草花。根元を引き締めて見せる。","「根締めにタマリュウ」","下草",""],
  ["Y0076","下草","したくさ","植栽・移植","木の下に植える草花や低い植物。","","根締め",""],
  ["Y0077","ポット苗","ぽっとなえ","植栽・移植","ビニールの鉢（ポット）に入った苗。","「ポット苗50株」","",""],
  ["Y0078","支柱","しちゅう","支柱・結束","植えた木が風で倒れたり揺れたりしないように支える柱。","「植えたらすぐ支柱」","八ツ掛け・鳥居支柱・布掛け・添え木",""],
  ["Y0079","八ツ掛け","やつがけ","支柱・結束","丸太や竹を3〜4本、幹に斜めに立てかけて結ぶ支柱。","「このクスは八ツ掛けで」","支柱・丸太・杉皮",""],
  ["Y0080","鳥居支柱","とりいしちゅう","支柱・結束","木の両側に柱を立てて横木でつなぎ、幹を横木に結ぶ支柱。鳥居の形に似ている。","「街路樹は二脚鳥居」","支柱",""],
  ["Y0081","布掛け","ぬのがけ","支柱・結束","並んで植えた木に横木を通して、まとめて支える支柱。生垣に多い。","","生垣・支柱",""],
  ["Y0082","添え木","そえぎ","支柱・結束","幹に竹や棒を1本添えて結ぶ、簡単な支柱。","","支柱",""],
  ["Y0083","男結び","おとこむすび","支柱・結束","シュロ縄で支柱や竹垣を結ぶときの、ほどけにくい結び方。","「全部男結びで」","シュロ縄・綾掛け",""],
  ["Y0084","綾掛け","あやがけ","支柱・結束","十字に交わる竹や木に、縄をたすき状に掛けて結ぶ掛け方。","","男結び",""],
  ["Y0085","竹垣","たけがき","支柱・結束","竹で作った垣根。","","四つ目垣・建仁寺垣・袖垣",""],
  ["Y0086","四つ目垣","よつめがき","支柱・結束","竹を縦横に組んで四角い目を作った、透けて見える竹垣。","","竹垣",""],
  ["Y0087","建仁寺垣","けんにんじがき","支柱・結束","割った竹をすき間なく縦に並べた、目隠しになる竹垣。","","竹垣",""],
  ["Y0088","袖垣","そでがき","支柱・結束","建物や門の脇に付ける、短い仕切りの垣根。","","竹垣",""],
  ["Y0089","樹高","じゅこう","樹木の部位・規格","地面から木のてっぺんまでの高さ。図面や見積ではHと書く。","「H3.0のシラカシ」","幹周・枝張り",""],
  ["Y0090","幹周","みきまわり","樹木の部位・規格","地面から1.2mの高さで測った幹のまわりの長さ。図面や見積ではCと書く。","「C15のケヤキ」","目通り・樹高",""],
  ["Y0091","枝張り","えだはり","樹木の部位・規格","枝や葉が横に広がっている幅。図面や見積ではWと書く。","「W1.5」","樹高・樹冠",""],
  ["Y0092","目通り","めどおり","樹木の部位・規格","地面から約1.2mの高さ（大人の目の高さくらい）。幹周はここで測る。","「目通りで測って」","幹周",""],
  ["Y0093","枝下高","えだしたこう","樹木の部位・規格","地面から一番下の枝までの高さ。","「枝下を2.5mまで上げて」","枝おろし",""],
  ["Y0094","樹冠","じゅかん","樹木の部位・規格","枝と葉が作る木の外形全体。","","枝張り",""],
  ["Y0095","地際","じぎわ","樹木の部位・規格","幹が地面に接しているところ。","「地際から切って」","根張り",""],
  ["Y0096","根張り","ねばり","樹木の部位・規格","根元が四方に張り出している様子。","","地際",""],
  ["Y0097","樹勢","じゅせい","樹木の部位・規格","木の元気さ、勢い。","「樹勢が弱っているから強く切らない」","",""],
  ["Y0098","高木","こうぼく","樹木の部位・規格","大きくなる木。図面ではおおむね樹高3m以上を指すことが多い（区分は図面・仕様書で確認）。","","中木・低木",""],
  ["Y0099","中木","ちゅうぼく","樹木の部位・規格","高木と低木の中間の大きさの木（区分は図面・仕様書で確認）。","","高木・低木",""],
  ["Y0100","低木","ていぼく","樹木の部位・規格","背の低い木。ツツジ・アベリアなど（区分は図面・仕様書で確認）。","","高木・玉物",""],
  ["Y0101","こも巻き","こもまき","季節の作業・土と肥料","秋に松の幹にわらのこもを巻いて害虫を集め、春に外して処分する作業。","「11月はこも巻き」","",""],
  ["Y0102","雪吊り","ゆきづり","季節の作業・土と肥料","雪の重みで枝が折れないように、柱から縄を張って枝を吊る作業。","","",""],
  ["Y0103","霜除け","しもよけ","季節の作業・土と肥料","寒さや霜から木や草花を守るために覆いをすること。","","",""],
  ["Y0104","寒肥","かんごえ","季節の作業・土と肥料","冬の休眠中に与える肥料。春の芽吹きのための栄養になる。","","元肥・追肥",""],
  ["Y0105","元肥","もとごえ","季節の作業・土と肥料","植え付けるときに、あらかじめ土に混ぜておく肥料。","","追肥",""],
  ["Y0106","追肥","ついひ","季節の作業・土と肥料","育っている途中で追加して与える肥料。","","元肥",""],
  ["Y0107","土壌改良材","どじょうかいりょうざい","季節の作業・土と肥料","土の水はけや水もち、やわらかさを良くするために混ぜる材料。腐葉土・堆肥・パーライトなど。","","客土・腐葉土",""],
  ["Y0108","腐葉土","ふようど","季節の作業・土と肥料","落ち葉を腐らせて作った土。土をふかふかにする。","","土壌改良材",""],
  ["Y0109","マルチング","まるちんぐ","季節の作業・土と肥料","根元の地面をバークや藁などで覆うこと。乾燥・雑草・寒さを防ぐ。","","",""],
  ["Y0110","チャドクガ","ちゃどくが","病害虫","ツバキやサザンカにつく毒のある毛虫。死んだ虫や抜け殻の毛でもかぶれる。","「ツバキはチャドクガ注意」","消毒",""],
  ["Y0111","イラガ","いらが","病害虫","サクラやカキなどにつく毛虫。刺されると電気が走ったように痛い。","","",""],
  ["Y0112","アメリカシロヒトリ","あめりかしろひとり","病害虫","夏から秋にサクラなどの葉を集団で食べる毛虫。巣網を作る。","","",""],
  ["Y0113","カイガラムシ","かいがらむし","病害虫","枝や幹にくっついて汁を吸う小さな虫。すす病の原因にもなる。","","すす病",""],
  ["Y0114","アブラムシ","あぶらむし","病害虫","新芽や葉裏に群がって汁を吸う小さな虫。","","",""],
  ["Y0115","クビアカツヤカミキリ","くびあかつやかみきり","病害虫","サクラ・ウメ・モモなどの幹の中を食べる外来のカミキリムシ。根元のフラスで見つかる。","「根元にフラスがあったらクビアカを疑う」","フラス・テッポウムシ",""],
  ["Y0116","テッポウムシ","てっぽうむし","病害虫","カミキリムシの幼虫。幹の中にトンネルを掘って木を弱らせる。","","クビアカツヤカミキリ・フラス",""],
  ["Y0117","フラス","ふらす","病害虫","幹に入った虫が穴から出す、木くずとフンが混じったもの。","「フラスが出てる穴を探して」","クビアカツヤカミキリ",""],
  ["Y0118","うどんこ病","うどんこびょう","病害虫","葉が白い粉をかけたようになる病気。","","",""],
  ["Y0119","すす病","すすびょう","病害虫","葉や枝が黒いすすをかぶったようになる病気。虫の出す汁がもとになることが多い。","","カイガラムシ",""],
  ["Y0120","てんぐ巣病","てんぐすびょう","病害虫","枝の一部から細い枝がほうきのように密集して出る病気。サクラに多い。","","",""],
  ["Y0121","景石","けいせき","庭づくり（石・水・配置）","庭の景色として据える石。","","据える・天端・根入れ",""],
  ["Y0122","据える","すえる","庭づくり（石・水・配置）","石や灯籠を、向きと高さを決めて動かないように置くこと。","「石を据えて」","景石・見付",""],
  ["Y0123","天端","てんば","庭づくり（石・水・配置）","石や構造物、生垣などのいちばん上の面。","「生垣の天端をそろえて」","景石・生垣",""],
  ["Y0124","根入れ","ねいれ","庭づくり（石・水・配置）","石などを地面に埋め込む深さ。しっかり埋めると安定して自然に見える。","","景石・据える",""],
  ["Y0125","見付","みつき","庭づくり（石・水・配置）","正面から見える面。石や木を一番見せたい向き。","","表・据える",""],
  ["Y0126","飛び石","とびいし","庭づくり（石・水・配置）","歩くために間をあけて並べた平らな石。","","延段",""],
  ["Y0127","延段","のべだん","庭づくり（石・水・配置）","石を組み合わせて敷いた、帯状の園路。","","飛び石",""],
  ["Y0128","築山","つきやま","庭づくり（石・水・配置）","土を盛って作った小さな山。","","",""],
  ["Y0129","枯山水","かれさんすい","庭づくり（石・水・配置）","水を使わず、石と砂利で山や水の流れを表した庭。","","",""],
  ["Y0130","蹲","つくばい","庭づくり（石・水・配置）","茶庭などにある、かがんで手を洗うための石の手水鉢とその周りの石組み。","","",""],
  ["Y0131","地割り","じわり","庭づくり（石・水・配置）","庭全体の配置（どこに何を置くか）を決めること。","","",""],
  ["Y0132","借景","しゃっけい","庭づくり（石・水・配置）","庭の外の山や木などの景色を、庭の一部として取り込む手法。","","",""],
  ["Y0133","段取り","だんどり","現場の言葉","仕事の手順や準備を前もって決めておくこと。","「明日の段取りは？」","",""],
  ["Y0134","手元","てもと","現場の言葉","職人のそばで材料を渡したり片付けたりする補助の役目。また、その人。","「今日は手元に入って」","",""],
  ["Y0135","養生","ようじょう","現場の言葉","周りの物を汚したり傷つけたりしないよう、シートなどで覆って守ること。植えた木の世話のことも言う。","「車に養生して」","ブルーシート",""],
  ["Y0136","発生材","はっせいざい","現場の言葉","作業で出た枝・葉・幹・根・刈りカスなどのごみ。","「発生材は処分場へ」","マルキ・搬出",""],
  ["Y0137","ガラ","がら","現場の言葉","掘ったときなどに出る、コンクリートや石の破片。","「ガラが出たら土のうに」","土嚢袋",""],
  ["Y0138","搬出","はんしゅつ","現場の言葉","発生材や道具を現場から運び出すこと。","","発生材",""],
  ["Y0139","人工","にんく","現場の言葉","1人が1日働く作業量の単位。「3人工」は3人で1日、または1人で3日分。","「この現場は2人工」","出面",""],
  ["Y0140","出面","でづら","現場の言葉","その日に出勤した人数や日数の記録。","「出面をつけておいて」","人工",""],
  ["Y0141","乗り込み","のりこみ","現場の言葉","その現場に初めて作業に入る日。","「来週月曜が乗り込み」","",""],
  ["Y0142","詰め所","つめしょ","現場の言葉","現場で休憩したり集まったりする場所。","","",""],
  ["Y0143","施主","せしゅ","現場の言葉","工事を頼んだお客様（お金を出す人）。","「施主さんに挨拶して」","元請け",""],
  ["Y0144","元請け","もとうけ","現場の言葉","発注者から直接仕事を請けた会社。そこから仕事をもらう側が下請け。","","施主",""],
  ["Y0145","鋤取り","すきとり","現場の言葉","地面の表面を薄く削り取ること。","","不陸",""],
  ["Y0146","不陸","ふりく","現場の言葉","地面などがでこぼこで平らでないこと。","「不陸をならして」","転圧",""],
  ["Y0147","転圧","てんあつ","現場の言葉","土や砂利を機械などで押し固めること。","","不陸",""],
  ["Y0148","天地返し","てんちがえし","現場の言葉","深い所の土と表面の土を入れ替えること。","","",""],
  ["Y0149","KY","けーわい","現場の言葉","作業の前に、その日の危ないところと対策を話し合うこと（危険予知）。","「朝礼でKYやって」","",""],
  ["Y0150","ロップ","ろっぷ","現場の言葉","ロープのこと（年配の職人の言い方）。","","",""],
  ["Y0151","二つ折り","ふたつおり","現場の言葉","4本足の脚立のこと（地域や会社によって言い方が違う）。","","四脚脚立",""],
  ["Y0152","番頭","ばんとう","現場の言葉","親方の右腕になる、職人の中でいちばん上の立場の人。","","",""],
  ["Y0153","剪定鋏","せんていばさみ","道具","片手で使う小型の鋏、太めの枝も切れる。","","","T0001"],
  ["Y0154","木鋏","きばさみ","道具","輪の持ち手の鋏、細かい枝や葉の整え用。","","","T0002"],
  ["Y0155","芽切鋏","めきりばさみ","道具","刃先の細い小さな鋏、芽摘み・松の手入れ用。","","","T0003"],
  ["Y0156","刈込鋏","かりこみばさみ","道具","両手で使う刃の長い鋏、生垣・玉物の刈込み。","","","T0004"],
  ["Y0157","剪定鋸","せんていのこぎり","道具","枝を切る細身のノコギリ、腰に下げる。","","","T0005"],
  ["Y0158","両刃鋸","りょうばのこぎり","道具","刃が両側にある大工用ノコギリ、丸太や竹を切る。","","","T0006"],
  ["Y0159","高枝切鋏","たかえだきりばさみ","道具","柄の長い鋏、脚立が届かない高い枝用。","","","T0007"],
  ["Y0160","高枝鋸","たかえだのこぎり","道具","伸縮する長い柄の先にノコギリ。","","","T0008"],
  ["Y0161","草刈鎌","くさかりがま","道具","草を刈る片手の鎌。","","","T0009"],
  ["Y0162","ヘッジトリマー","へっじとりまー","道具","生垣の刈込み用、エンジン式の長い刃。","","","T0010"],
  ["Y0163","チェーンソー","ちぇーんそー","道具","エンジン式の木を切る機械、伐採・玉切り。","","","T0011"],
  ["Y0164","トップハンドルソー","とっぷはんどるそー","道具","片手で扱える小型のチェーンソー、木の上の作業用。","","","T0012"],
  ["Y0165","刈払機","かりばらいき","道具","肩に掛けて回転刃で草を刈る機械。","","","T0013"],
  ["Y0166","ブロワー","ぶろわー","道具","風で落ち葉や刈りカスを吹き飛ばす機械。","","","T0014"],
  ["Y0167","動力噴霧器","どうりょくふんむき","道具","エンジンで薬剤を散布する機械、ホース付き。","","","T0015"],
  ["Y0168","背負い式噴霧器","せおいしきふんむき","道具","背中に背負って手で薬剤を撒くタンク。","","","T0016"],
  ["Y0169","唐鍬","とうぐわ","道具","刃が厚く重い鍬、根切り・抜根・固い土の掘り起こし。","","","T0017"],
  ["Y0170","ツルハシ","つるはし","道具","両側がとがった掘削用具、石混じりの土を砕く。","","","T0018"],
  ["Y0171","剣先スコップ","けんさきすこっぷ","道具","先がとがったスコップ、植え穴掘り用。","","","T0019"],
  ["Y0172","角スコップ","かくすこっぷ","道具","先が平らなスコップ、土やゴミをすくう。","","","T0020"],
  ["Y0173","移植ゴテ","いしょくごて","道具","片手で使う小さなスコップ、草花の植え付け。","","","T0021"],
  ["Y0174","レーキ","れーき","道具","鉄の爪が並んだ道具、土をならす・石を集める。","","","T0022"],
  ["Y0175","熊手","くまで","道具","落ち葉をかき集める扇形の道具。","","","T0023"],
  ["Y0176","竹箒","たけぼうき","道具","竹の枝で作ったほうき、仕上げの掃除。","","","T0024"],
  ["Y0177","手箕","てみ","道具","取っ手付きの浅いちりとり型のかご、ゴミ運び。","","","T0025"],
  ["Y0178","一輪車","いちりんしゃ","道具","車輪1つの手押し車、土や枝の運搬。","","","T0026"],
  ["Y0179","掛矢","かけや","道具","柄の長い大きな木づち、支柱の杭打ち用。","","","T0027"],
  ["Y0180","大ハンマー","おおはんまー","道具","鉄の重いハンマー、杭打ち・石割り。","","","T0028"],
  ["Y0181","突き棒","つきぼう","道具","植え付け時に土を突き固める棒。","","","T0029"],
  ["Y0182","バール","ばーる","道具","先が曲がった鉄の棒、てこで持ち上げ・釘抜き。","","","T0030"],
  ["Y0183","シノ","しの","道具","番線をねじって締める先のとがった工具。","","","T0031"],
  ["Y0184","番線カッター","ばんせんかったー","道具","番線（太い針金）を切る大きなペンチ。","","","T0032"],
  ["Y0185","三脚脚立","さんきゃくきゃたつ","道具","植木用の3本足の脚立、生垣の中にも立てられる。","","","T0033"],
  ["Y0186","四脚脚立","よんきゃくきゃたつ","道具","4本足のアルミ脚立、平らな地面用。","","","T0034"],
  ["Y0187","梯子","はしご","道具","伸縮する梯子、高木に掛ける。","","","T0035"],
  ["Y0188","フルハーネス","ふるはーねす","道具","高所作業で体を支える墜落防止の器具。","","","T0036"],
  ["Y0189","カラーコーン","からーこーん","道具","道路作業の区画に置く円すいの標識。","","","T0037"],
  ["Y0190","コーンバー","こーんばー","道具","カラーコーン同士をつなぐ棒。","","","T0038"],
  ["Y0191","シュロ縄","しゅろなわ","資材","支柱や竹垣の結束に使う黒い縄。","","","T0039"],
  ["Y0192","杉皮","すぎかわ","資材","支柱を結ぶ所の幹に巻いて傷を防ぐ皮。","","","T0040"],
  ["Y0193","番線","ばんせん","資材","支柱の固定などに使う太い針金（巻き）。","","","T0041"],
  ["Y0194","幹巻きテープ","みきまきてーぷ","資材","植え付け後の幹を日焼けや乾燥から守るテープ。","","","T0042"],
  ["Y0195","土嚢袋","どのうぶくろ","資材","土や刈りカスを入れる袋。","","","T0043"],
  ["Y0196","ブルーシート","ぶるーしーと","資材","作業時に下に敷く青いシート。","","","T0044"],
  ["Y0197","丸太","まるた","資材","皮をむいた細い木の幹。支柱に使う。","「八ツ掛け用の丸太を10本」","八ツ掛け",""],
  ["Y0198","支柱竹","しちゅうたけ","資材","支柱や布掛けに使う真竹などの竹。","「竹屋で竹12本」","支柱・布掛け",""]];
var SEED_ALIASES = [["手入れ","ていれ","Y0001","別名"],
  ["透かし","すかし","Y0002","略称"],
  ["枝透かし","えだすかし","Y0002","別名"],
  ["散らし","ちらし","Y0002","別名"],
  ["枝を下ろす","えだをおろす","Y0006","別名"],
  ["切り返し剪定","きりかえしせんてい","Y0007","別名"],
  ["切り詰め剪定","きりつめせんてい","Y0008","別名"],
  ["詰める","つめる","Y0008","略称"],
  ["刈込","かりこみ","Y0009","別名"],
  ["刈る","かる","Y0009","略称"],
  ["ぶつ切る","ぶつぎる","Y0011","別名"],
  ["こぶ","こぶ","Y0012","略称"],
  ["げんこつ","げんこつ","Y0012","別名"],
  ["芯を止める","しんをとめる","Y0013","別名"],
  ["しおる","しおる","Y0014","別名"],
  ["しおり","しおり","Y0014","略称"],
  ["枝折り","しおり","Y0014","別名"],
  ["緑摘み","みどりつみ","Y0016","別名"],
  ["芽摘み","めつみ","Y0016","別名"],
  ["みどり","みどり","Y0016","略称"],
  ["葉もみ","はもみ","Y0017","別名"],
  ["古葉取り","ふるはとり","Y0017","別名"],
  ["葉むしり","はむしり","Y0017","別名"],
  ["芽かき","めかき","Y0018","別名"],
  ["伐る","きる","Y0019","略称"],
  ["根起こし","ねおこし","Y0020","別名"],
  ["薬剤散布","やくざいさんぷ","Y0022","別名"],
  ["防除","ぼうじょ","Y0022","別名"],
  ["薬まき","くすりまき","Y0022","略称"],
  ["草取り","くさとり","Y0023","別名"],
  ["草むしり","くさむしり","Y0023","別名"],
  ["刈り払い","かりはらい","Y0024","別名"],
  ["防腐剤","ぼうふざい","Y0025","別名"],
  ["ペースト","ぺーすと","Y0025","略称"],
  ["枝の付け根","えだのつけね","Y0027","別名"],
  ["不要枝","ふようし","Y0028","別名"],
  ["悪い枝","わるいえだ","Y0028","別名"],
  ["徒長","とちょう","Y0029","略称"],
  ["飛び枝","とびえだ","Y0029","別名"],
  ["立枝","たちえだ","Y0030","別名"],
  ["逆枝","さかえだ","Y0031","別名"],
  ["戻り枝","もどりえだ","Y0031","別名"],
  ["交差枝","こうさし","Y0032","別名"],
  ["へいこうえだ","へいこうえだ","Y0033","別名"],
  ["輪生枝","りんせいし","Y0034","別名"],
  ["懐枝","ふところえだ","Y0035","別名"],
  ["胴吹き枝","どうぶきえだ","Y0036","別名"],
  ["幹吹き","みきぶき","Y0036","別名"],
  ["胴ぶき","どうぶき","Y0036","別名"],
  ["やご","やご","Y0037","社内呼び"],
  ["根元の芽","ねもとのめ","Y0037","別名"],
  ["孫生え","ひこばえ","Y0037","別名"],
  ["枯枝","かれえだ","Y0038","別名"],
  ["親枝","おやえだ","Y0039","別名"],
  ["小枝","こえだ","Y0040","別名"],
  ["心","しん","Y0041","別名"],
  ["頭","あたま","Y0041","別名"],
  ["先芽","さきめ","Y0042","別名"],
  ["腋芽","えきが","Y0043","別名"],
  ["かが","かが","Y0044","別名"],
  ["ようが","ようが","Y0045","別名"],
  ["自然形","しぜんけい","Y0046","略称"],
  ["仕立てる","したてる","Y0048","別名"],
  ["玉","たま","Y0049","略称"],
  ["玉作り","たまづくり","Y0049","別名"],
  ["玉物仕立て","たまものじたて","Y0049","別名"],
  ["散らし玉","ちらしだま","Y0050","別名"],
  ["段物","だんもの","Y0051","別名"],
  ["垣根","かきね","Y0052","別名"],
  ["いけ垣","いけがき","Y0052","別名"],
  ["株物","かぶもの","Y0053","別名"],
  ["株","かぶ","Y0053","略称"],
  ["一本立ち","いっぽんだち","Y0054","別名"],
  ["1本幹","いっぽんかん","Y0054","別名"],
  ["門冠り","もんかぶり","Y0055","別名"],
  ["門かぶりの松","もんかぶりのまつ","Y0055","別名"],
  ["見越し","みこし","Y0056","略称"],
  ["台杉仕立て","だいすぎじたて","Y0057","別名"],
  ["枝垂れ物","しだれもの","Y0058","別名"],
  ["しだれもの","しだれもの","Y0058","別名"],
  ["植え付け","うえつけ","Y0059","別名"],
  ["植込み","うえこみ","Y0059","別名"],
  ["植える","うえる","Y0059","略称"],
  ["植え替え","うえかえ","Y0060","別名"],
  ["移植する","いしょくする","Y0060","別名"],
  ["掘り上げ","ほりあげ","Y0062","別名"],
  ["鉢","はち","Y0063","略称"],
  ["根玉","ねだま","Y0063","別名"],
  ["鉢巻き","はちまき","Y0064","別名"],
  ["根まき","ねまき","Y0064","別名"],
  ["振るい掘り","ふるいぼり","Y0065","別名"],
  ["仮植","かしょく","Y0066","別名"],
  ["かしょく","かしょく","Y0066","別名"],
  ["植穴","うえあな","Y0067","別名"],
  ["穴","あな","Y0067","略称"],
  ["立込み","たてこみ","Y0068","別名"],
  ["木の表","きのおもて","Y0069","別名"],
  ["正面","しょうめん","Y0069","別名"],
  ["埋戻し","うめもどし","Y0070","別名"],
  ["水ぎめ","みずぎめ","Y0071","別名"],
  ["水締め","みずじめ","Y0071","別名"],
  ["土ぎめ","つちぎめ","Y0072","別名"],
  ["水鉢を切る","みずばちをきる","Y0073","別名"],
  ["入れ土","いれつち","Y0074","別名"],
  ["下植え","したうえ","Y0076","別名"],
  ["グランドカバー","ぐらんどかばー","Y0076","別名"],
  ["ポット","ぽっと","Y0077","略称"],
  ["ポット物","ぽっともの","Y0077","別名"],
  ["八つ掛け","やつがけ","Y0079","別名"],
  ["八掛け","はちがけ","Y0079","別名"],
  ["やつがけ","やつがけ","Y0079","別名"],
  ["鳥居","とりい","Y0080","略称"],
  ["二脚鳥居","にきゃくとりい","Y0080","別名"],
  ["三脚鳥居","さんきゃくとりい","Y0080","別名"],
  ["十字鳥居","じゅうじとりい","Y0080","別名"],
  ["布掛","ぬのがけ","Y0081","別名"],
  ["添え柱","そえばしら","Y0082","別名"],
  ["一本支柱","いっぽんしちゅう","Y0082","別名"],
  ["いぼ結び","いぼむすび","Y0083","別名"],
  ["垣根結び","かきねむすび","Y0083","別名"],
  ["あや","あや","Y0084","略称"],
  ["四ツ目垣","よつめがき","Y0086","別名"],
  ["H","えいち","Y0089","略称"],
  ["高さ","たかさ","Y0089","別名"],
  ["エイチ","えいち","Y0089","別名"],
  ["C","しー","Y0090","略称"],
  ["目通り周","めどおりしゅう","Y0090","別名"],
  ["シー","しー","Y0090","別名"],
  ["W","だぶりゅー","Y0091","略称"],
  ["葉張り","はばり","Y0091","別名"],
  ["ダブリュー","だぶりゅー","Y0091","別名"],
  ["枝下","えだした","Y0093","略称"],
  ["クラウン","くらうん","Y0094","別名"],
  ["根際","ねぎわ","Y0095","別名"],
  ["根元","ねもと","Y0095","別名"],
  ["勢い","いきおい","Y0097","別名"],
  ["灌木","かんぼく","Y0100","別名"],
  ["こも","こも","Y0101","略称"],
  ["菰巻き","こもまき","Y0101","別名"],
  ["霜囲い","しもがこい","Y0103","別名"],
  ["かんぴ","かんぴ","Y0104","別名"],
  ["基肥","きひ","Y0105","別名"],
  ["おいごえ","おいごえ","Y0106","別名"],
  ["改良材","かいりょうざい","Y0107","略称"],
  ["改良土","かいりょうど","Y0107","別名"],
  ["マルチ","まるち","Y0109","略称"],
  ["チャドク","ちゃどく","Y0110","略称"],
  ["茶毒蛾","ちゃどくが","Y0110","別名"],
  ["デンキムシ","でんきむし","Y0111","社内呼び"],
  ["電気虫","でんきむし","Y0111","別名"],
  ["アメシロ","あめしろ","Y0112","略称"],
  ["カイガラ","かいがら","Y0113","略称"],
  ["アリマキ","ありまき","Y0114","別名"],
  ["クビアカ","くびあか","Y0115","略称"],
  ["鉄砲虫","てっぽうむし","Y0116","別名"],
  ["木くず","きくず","Y0117","別名"],
  ["白粉病","はくふんびょう","Y0118","別名"],
  ["天狗巣病","てんぐすびょう","Y0120","別名"],
  ["庭石","にわいし","Y0121","別名"],
  ["添景石","てんけいせき","Y0121","別名"],
  ["据え付け","すえつけ","Y0122","別名"],
  ["てんぱ","てんぱ","Y0123","聞き間違い"],
  ["見付き","みつき","Y0125","別名"],
  ["見つけ","みつけ","Y0125","別名"],
  ["飛石","とびいし","Y0126","別名"],
  ["のべ段","のべだん","Y0127","別名"],
  ["つくばい","つくばい","Y0130","別名"],
  ["手水鉢","ちょうずばち","Y0130","別名"],
  ["地割","じわり","Y0131","別名"],
  ["養生シート","ようじょうしーと","Y0135","別名"],
  ["残材","ざんざい","Y0136","別名"],
  ["ゴミ","ごみ","Y0136","略称"],
  ["コンガラ","こんがら","Y0137","別名"],
  ["運び出し","はこびだし","Y0138","別名"],
  ["にんこう","にんこう","Y0139","聞き間違い"],
  ["でめん","でめん","Y0140","別名"],
  ["お施主さん","おせしゅさん","Y0143","別名"],
  ["施工主","せこうぬし","Y0143","別名"],
  ["元請","もとうけ","Y0144","別名"],
  ["すき取り","すきとり","Y0145","別名"],
  ["不陸整正","ふりくせいせい","Y0146","別名"],
  ["危険予知","きけんよち","Y0149","別名"],
  ["KY活動","けーわいかつどう","Y0149","別名"],
  ["パチン","ぱちん","Y0153","社内呼び"],
  ["はさみ","はさみ","Y0153","略称"],
  ["剪定バサミ","せんていばさみ","Y0153","別名"],
  ["植木鋏","うえきばさみ","Y0154","別名"],
  ["わらび手","わらびて","Y0154","別名"],
  ["芽切り","めきり","Y0155","略称"],
  ["芽切りばさみ","めきりばさみ","Y0155","別名"],
  ["両手","りょうて","Y0156","社内呼び"],
  ["刈込","かりこみ","Y0156","略称"],
  ["両手鋏","りょうてばさみ","Y0156","別名"],
  ["ノコ","のこ","Y0157","略称"],
  ["腰ノコ","こしのこ","Y0157","別名"],
  ["ノコ","のこ","Y0158","略称"],
  ["高枝","たかえだ","Y0159","社内呼び"],
  ["高ノコ","たかのこ","Y0160","社内呼び"],
  ["ポールソー","ぽーるそー","Y0160","別名"],
  ["鎌","かま","Y0161","略称"],
  ["バリカン","ばりかん","Y0162","社内呼び"],
  ["トリマー","とりまー","Y0162","略称"],
  ["ヘッジ","へっじ","Y0162","略称"],
  ["チェンソー","ちぇんそー","Y0163","社内呼び"],
  ["チェーン","ちぇーん","Y0163","略称"],
  ["トップハン","とっぷはん","Y0164","社内呼び"],
  ["小チェン","こちぇん","Y0164","社内呼び"],
  ["草刈機","くさかりき","Y0165","別名"],
  ["ビーバー","びーばー","Y0165","社内呼び"],
  ["草刈り","くさかり","Y0165","略称"],
  ["刈り払い","かりはらい","Y0165","略称"],
  ["ブロア","ぶろあ","Y0166","別名"],
  ["送風機","そうふうき","Y0166","別名"],
  ["動噴","どうふん","Y0167","社内呼び"],
  ["消毒機","しょうどくき","Y0167","社内呼び"],
  ["背負い","せおい","Y0168","社内呼び"],
  ["噴霧器","ふんむき","Y0168","略称"],
  ["からくわ","からくわ","Y0169","聞き間違い"],
  ["とんが","とんが","Y0169","社内呼び"],
  ["唐鍬","からぐわ","Y0169","別名"],
  ["つるはし","つるはし","Y0170","別名"],
  ["ピック","ぴっく","Y0170","別名"],
  ["スコップ","すこっぷ","Y0171","社内呼び"],
  ["剣スコ","けんすこ","Y0171","略称"],
  ["シャベル","しゃべる","Y0171","別名"],
  ["角スコ","かくすこ","Y0172","略称"],
  ["平スコ","ひらすこ","Y0172","別名"],
  ["コテ","こて","Y0173","略称"],
  ["移植","いしょく","Y0173","略称"],
  ["くま","くま","Y0175","略称"],
  ["竹熊手","たけくまで","Y0175","別名"],
  ["ほうき","ほうき","Y0176","略称"],
  ["竹ぼうき","たけぼうき","Y0176","別名"],
  ["てみ","てみ","Y0177","社内呼び"],
  ["箕","み","Y0177","別名"],
  ["手み","てみ","Y0177","別名"],
  ["ネコ","ねこ","Y0178","社内呼び"],
  ["ネコ車","ねこぐるま","Y0178","別名"],
  ["かけや","かけや","Y0179","社内呼び"],
  ["大木槌","おおきづち","Y0179","別名"],
  ["竹屋","たけや","Y0179","聞き間違い"],
  ["大ハン","おおはん","Y0180","社内呼び"],
  ["セットハンマー","せっとはんまー","Y0180","別名"],
  ["つき棒","つきぼう","Y0181","別名"],
  ["かじや","かじや","Y0182","社内呼び"],
  ["鍛冶屋","かじや","Y0182","別名"],
  ["番線しめ","ばんせんしめ","Y0183","社内呼び"],
  ["番線切り","ばんせんきり","Y0184","社内呼び"],
  ["ボルトクリッパー","ぼるとくりっぱー","Y0184","別名"],
  ["三脚","さんきゃく","Y0185","社内呼び"],
  ["植木脚立","うえききゃたつ","Y0185","別名"],
  ["脚立","きゃたつ","Y0185","略称"],
  ["脚立","きゃたつ","Y0186","社内呼び"],
  ["安全帯","あんぜんたい","Y0188","社内呼び"],
  ["ハーネス","はーねす","Y0188","略称"],
  ["コーン","こーん","Y0189","社内呼び"],
  ["パイロン","ぱいろん","Y0189","別名"],
  ["三角コーン","さんかくこーん","Y0189","別名"],
  ["シュロ","しゅろ","Y0191","略称"],
  ["棕櫚縄","しゅろなわ","Y0191","別名"],
  ["針金","はりがね","Y0193","別名"],
  ["幹巻き","みきまき","Y0194","社内呼び"],
  ["緑化テープ","りょっかてーぷ","Y0194","別名"],
  ["土のう","どのう","Y0195","社内呼び"],
  ["シート","しーと","Y0196","略称"],
  ["丸木","まるき","Y0197","社内呼び"],
  ["マル","まる","Y0197","略称"],
  ["竹","たけ","Y0198","略称"]];


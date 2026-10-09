/****************************************************************
 * 庭乃持田園 現場アプリ（段取り・道具管理・用語集）— 読み込み係
 *
 *  このファイルだけを GAS「現場アプリ」に貼っておきます。
 *  プログラムの本体は GitHub（kouenhoukoku/gas/genba_app.gs）に置いてあり、
 *  ここが自動で読み込みます。本体を直したら、数分でアプリに反映されます
 *  （GASの貼り直しも、デプロイのし直しもいりません）。
 *
 *  ・すぐ反映させたいとき：ウェブアプリのURLの後ろに ?action=reload を付けて開く
 *  ・GitHubにつながらないときは、最後に読み込めた本体（マイドライブの控えファイル）で動きます
 ****************************************************************/
var SRC_URL = 'https://raw.githubusercontent.com/tomohikomochida-debug/kouenhoukoku/main/gas/genba_app.gs';
var CACHE_SEC = 300;   // 本体を読み直す間隔（秒）

function doGet(e) {
  var a = (e && e.parameter && e.parameter.action) || '';
  if (a === 'reload') { clearCache_(); var m = mod_(); return m.doGet({ parameter: { action: 'ping' } }); }
  return mod_().doGet(e);
}
function doPost(e) { return mod_().doPost(e); }
function setup() { return mod_().setup(); }
function update() { clearCache_(); mod_(); Logger.log('最新の本体を読み込みました（控えの更新：' + backupAt_() + '）'); }

var MOD_ = null;
function mod_() {
  if (MOD_) return MOD_;
  var code = src_();
  MOD_ = new Function(code + '\nreturn { doGet: doGet, doPost: doPost, setup: setup };')();
  return MOD_;
}
function src_() {
  var cache = CacheService.getScriptCache(), code = getChunks_(cache);
  if (code) return code;
  try {
    var res = UrlFetchApp.fetch(SRC_URL, { muteHttpExceptions: true, headers: { 'Cache-Control': 'no-cache' } });
    var t = res.getContentText('UTF-8');
    if (res.getResponseCode() === 200 && /function doGet\s*\(/.test(t) && /function doPost\s*\(/.test(t)) {
      putChunks_(cache, t);
      saveBackup_(t);
      return t;
    }
  } catch (err) { /* GitHub につながらないときは控えで動く */ }
  code = loadBackup_();
  if (code) return code;
  throw new Error('プログラム本体を読み込めませんでした（GitHub に接続できません）');
}

/* キャッシュ（1つ100KBまでなので分けて入れる） */
function getChunks_(cache) {
  var n = Number(cache.get('src_n') || 0); if (!n) return '';
  var keys = []; for (var i = 0; i < n; i++) keys.push('src_' + i);
  var got = cache.getAll(keys), out = '';
  for (var j = 0; j < n; j++) { if (got['src_' + j] == null) return ''; out += got['src_' + j]; }
  return out;
}
function putChunks_(cache, t) {
  var obj = {}, size = 20000, n = Math.ceil(t.length / size);
  for (var i = 0; i < n; i++) obj['src_' + i] = t.slice(i * size, (i + 1) * size);
  obj.src_n = String(n);
  try { cache.putAll(obj, CACHE_SEC); } catch (e) {}
}
function clearCache_() { CacheService.getScriptCache().remove('src_n'); MOD_ = null; }

/* 控え：最後に読み込めた本体を、マイドライブのテキストファイルに残す（中身が変わったときだけ書く） */
var BACKUP_NAME = '現場アプリ_本体の控え（自動・消さない）.txt';
function hash_(t) { return Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, t, Utilities.Charset.UTF_8).map(function (b) { return ('0' + (b & 255).toString(16)).slice(-2); }).join(''); }
function backupFile_(create) {
  var p = PropertiesService.getScriptProperties(), id = String(p.getProperty('BACKUP_FILE_ID') || '').trim();
  if (id) { try { var f = DriveApp.getFileById(id); if (!f.isTrashed()) return f; } catch (e) {} }
  var it = DriveApp.getFilesByName(BACKUP_NAME);
  var file = it.hasNext() ? it.next() : (create ? DriveApp.createFile(BACKUP_NAME, '', MimeType.PLAIN_TEXT) : null);
  if (file) p.setProperty('BACKUP_FILE_ID', file.getId());
  return file;
}
function saveBackup_(t) {
  try {
    var h = hash_(t), f = backupFile_(true);
    if (f.getDescription() === h) return;
    f.setContent(t); f.setDescription(h);
  } catch (e) { /* 控えが書けなくても動作は続ける */ }
}
function loadBackup_() {
  try { var f = backupFile_(false); return f ? f.getBlob().getDataAsString('UTF-8') : ''; } catch (e) { return ''; }
}
function backupAt_() { try { var f = backupFile_(false); return f ? Utilities.formatDate(f.getLastUpdated(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm') : 'なし'; } catch (e) { return '不明'; } }

/* 権限の確認用（呼ばれません）。本体が使う Google のサービスを、ここに書いておくと最初の許可で一緒に許可されます */
function permissions_() {
  SpreadsheetApp.openById(''); SpreadsheetApp.create(''); DriveApp.getFilesByName(''); DriveApp.createFolder('');
  CalendarApp.getAllCalendars(); UrlFetchApp.fetch(''); LockService.getScriptLock(); DriveApp.getFileById('');
  MailApp.sendEmail('', '', ''); Maps.newGeocoder();   // 事故報告：親方へのメールのお知らせ・場所の住所
}

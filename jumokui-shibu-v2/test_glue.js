// Google のサービスを真似た模擬環境で、シート操作の部分を通しで動かすテスト。
// 実行：cp コード.gs /tmp/code.js && node test_glue.js /tmp/code.js
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const src = fs.readFileSync(process.argv[2] || './code.js', 'utf8');

const TZ_OFFSET = 9 * 3600 * 1000;
const pad = n => String(n).padStart(2, '0');
function fmt(d, f) {
  const t = new Date(d.getTime() + TZ_OFFSET);
  return f.replace('yyyy', t.getUTCFullYear()).replace('MM', pad(t.getUTCMonth() + 1)).replace('dd', pad(t.getUTCDate()))
    .replace('HH', pad(t.getUTCHours())).replace('mm', pad(t.getUTCMinutes())).replace('ss', pad(t.getUTCSeconds()));
}
let FIXED_NOW = Date.parse('2026-10-02T03:00:00Z');

class Protection {
  constructor(sheet) { this.sheet = sheet; this.desc = ''; this.editors = ['owner@example.invalid']; }
  setDescription(d) { this.desc = d; return this; } getDescription() { return this.desc; }
  setWarningOnly() { return this; } addEditor() { return this; } removeEditors() { return this; } setUnprotectedRanges(r) { this.unprotected = r; return this; }
  getEditors() { return this.editors.map(e => ({ getEmail: () => e })); } canDomainEdit() { return false; } setDomainEdit() { return this; }
  remove() { this.sheet.protections = this.sheet.protections.filter(p => p !== this); }
}
class Range {
  constructor(sh, r, c, nr, nc) { Object.assign(this, { sh, r, c, nr: nr || 1, nc: nc || 1 }); }
  getSheet() { return this.sh; } getRow() { return this.r; } getColumn() { return this.c; } getNumRows() { return this.nr; } getNumColumns() { return this.nc; }
  getLastRow() { return this.r + this.nr - 1; } getLastColumn() { return this.c + this.nc - 1; }
  getA1Notation() { return 'R' + this.r + 'C' + this.c + ':R' + this.getLastRow() + 'C' + this.getLastColumn(); }
  each(fn) { for (let i = 0; i < this.nr; i++) for (let j = 0; j < this.nc; j++) fn(this.r + i, this.c + j, i, j); }
  getValues() { const out = []; for (let i = 0; i < this.nr; i++) { const row = []; for (let j = 0; j < this.nc; j++) row.push(this.sh.get(this.r + i, this.c + j)); out.push(row); } return out; }
  getValue() { return this.sh.get(this.r, this.c); }
  setValues(v) { assert.strictEqual(v.length, this.nr, 'setValues rows'); v.forEach(row => assert.strictEqual(row.length, this.nc, 'setValues cols')); this.each((r, c, i, j) => this.sh.set(r, c, v[i][j])); return this; }
  setValue(v) { this.each((r, c) => this.sh.set(r, c, v)); return this; }
  clearContent() { this.each((r, c) => this.sh.set(r, c, '')); return this; }
  insertCheckboxes() { this.each((r, c) => { this.sh.check.add(r + ':' + c); if (this.sh.get(r, c) === '') this.sh.set(r, c, false); }); return this; }
  setNumberFormat(f) { this.each((r, c) => this.sh.fmt.set(r + ':' + c, f)); return this; } setDataValidation() { return this; } setBackground() { return this; } setBackgrounds(b) { assert.strictEqual(b.length, this.nr); return this; }
  setFontWeight() { return this; } setFontColor() { return this; } setWrap() { return this; } clearDataValidations() { this.each((r, c) => this.sh.check.delete(r + ':' + c)); return this; }
  protect() { const p = new Protection(this.sh); p.type = 'RANGE'; this.sh.protections.push(p); return p; }
}
class Sheet {
  constructor(ss, name) { Object.assign(this, { ss, name, cells: new Map(), fmt: new Map(), maxRows: 1000, maxCols: 26, protections: [], check: new Set(), hidden: [] }); }
  getName() { return this.name; } getParent() { return this.ss; } setName(n) { this.name = n; return this; }
  deleteRow(r) { const next = new Map(); for (const [k, v] of this.cells) { const [rr, cc] = k.split(':').map(Number); if (rr < r) next.set(k, v); else if (rr > r) next.set((rr - 1) + ':' + cc, v); } this.cells = next; }
  get(r, c) { const v = this.cells.get(r + ':' + c); return v === undefined ? '' : v; }
  set(r, c, v) {
    assert.ok(r >= 1 && c >= 1 && r <= this.maxRows && c <= this.maxCols, this.name + ' 範囲外 ' + r + ',' + c);
    if (typeof v === 'string' && /^\d+$/.test(v) && this.fmt.get(r + ':' + c) !== '@') v = Number(v); // 本物と同じく、書式が文字でなければ数字は数値になる
    else if (typeof v === 'string' && v.startsWith("'")) v = v.slice(1); // 先頭の ' は「文字として保存」の印
    else if (typeof v === 'string' && /^[=+]/.test(v)) throw new Error('数式になる文字列を書こうとしました: ' + v);
    if (v === '' || v === null || v === undefined) this.cells.delete(r + ':' + c); else this.cells.set(r + ':' + c, v);
  }
  getRange(r, c, nr, nc) {
    if (typeof r === 'string') throw new Error('A1 notation not mocked');
    assert.ok(r >= 1 && c >= 1 && (nr || 1) >= 1 && (nc || 1) >= 1, this.name + ' getRange 引数 ' + [r, c, nr, nc]);
    return new Range(this, r, c, nr, nc);
  }
  getLastRow() { let m = 0; for (const k of this.cells.keys()) m = Math.max(m, Number(k.split(':')[0])); return m; }
  getLastColumn() { let m = 0; for (const k of this.cells.keys()) m = Math.max(m, Number(k.split(':')[1])); return m; }
  getMaxRows() { return this.maxRows; } getMaxColumns() { return this.maxCols; }
  insertRowsAfter(after, n) { this.maxRows += n; } insertColumnsAfter(after, n) { this.maxCols += n; }
  setFrozenRows() {} setColumnWidth() { return this; } hideColumns(c) { this.hidden.push(c); }
  hideSheet() { this.sheetHidden = true; return this; } showSheet() { this.sheetHidden = false; return this; } isSheetHidden() { return !!this.sheetHidden; }
  insertColumnAfter(col) {
    const shift = m => { const next = new Map(); for (const [k, v] of m) { const [r, c] = k.split(':').map(Number); next.set(r + ':' + (c > col ? c + 1 : c), v); } return next; };
    this.cells = shift(this.cells); this.fmt = shift(this.fmt); this.maxCols++;
  }
  protect() { const p = new Protection(this); p.type = 'SHEET'; this.protections.push(p); return p; }
  getProtections(type) { return this.protections.filter(p => p.type === type); }
  appendRow(row) { const r = this.getLastRow() + 1; row.forEach((v, i) => this.set(r, i + 1, v)); }
  clearContents() { this.cells.clear(); }
}
class Book {
  constructor(id) { this.id = id; this.sheets = [new Sheet(this, 'シート1')]; }
  getId() { return this.id; } getName() { return 'ブック' + this.id.slice(0, 4); }
  getSheetByName(n) { return this.sheets.find(s => s.name === n) || null; }
  insertSheet(n, i) { const s = new Sheet(this, n); if (i === undefined) this.sheets.push(s); else this.sheets.splice(i, 0, s); return s; }
  deleteSheet(s) { this.sheets = this.sheets.filter(x => x !== s); }
  getSheets() { return this.sheets; }
  setSpreadsheetTimeZone() {} setSpreadsheetLocale() {}
}
const books = {};
const props = new Map();
const triggers = [];
function builder() { const b = { requireValueInList: () => b, setAllowInvalid: () => b, requireDate: () => b, build: () => ({}) }; return b; }
const mails = [];
let activeUser = 'owner@example.invalid'; // Apps Script の画面から実行している人（照会ページからの呼び出しは空欄）
const cache = new Map();
let webAppUrl = null;
// フォームの模擬
const forms = new Map();
class FormItem {
  constructor(type) { this.type = type; this.title = ''; }
  setTitle(t) { this.title = t; return this; } getTitle() { return this.title; } setChoiceValues(v) { this.choices = v; return this; }
  setRequired(r) { this.required = r; return this; } setHelpText() { return this; } setValidation(v) { this.validation = v; return this; }
}
class Form {
  constructor(id, title) { Object.assign(this, { id, title, items: [], responses: [], accepting: true, desc: '' }); }
  getId() { return this.id; } getPublishedUrl() { return 'https://forms.example/' + this.id + '/viewform'; } getEditUrl() { return 'https://forms.example/' + this.id + '/edit'; }
  setTitle(t) { this.title = t; return this; } setDescription(d) { this.desc = d; return this; }
  setCollectEmail() { return this; } setAllowResponseEdits() { return this; } setShowLinkToRespondAgain() { return this; } setConfirmationMessage() { return this; } setCustomClosedFormMessage() { return this; }
  setRequireLogin() { throw new Error('Google Workspace のフォームだけで使えます'); }
  addMultipleChoiceItem() { const i = new FormItem('choice'); this.items.push(i); return i; }
  addTextItem() { const i = new FormItem('text'); this.items.push(i); return i; }
  addParagraphTextItem() { const i = new FormItem('paragraph'); this.items.push(i); return i; }
  setAcceptingResponses(b) { this.accepting = b; return this; } isAcceptingResponses() { return this.accepting; }
  getItems() { return this.items.slice(); } moveItem(from, to) { const [i] = this.items.splice(from, 1); this.items.splice(to, 0, i); }
  respond(id, email, answers) { assert.ok(this.accepting, '受付が終わったフォームに回答'); this.responses.push({ id, email, answers, ts: FIXED_NOW }); }
  getResponses() {
    return this.responses.map(r => ({
      getId: () => r.id, getTimestamp: () => new sandbox.Date(r.ts), getRespondentEmail: () => r.email,
      getItemResponses: () => Object.entries(r.answers).map(([k, v]) => ({ getItem: () => ({ getTitle: () => k }), getResponse: () => v })),
    }));
  }
}
let mailQuota = 100;
const sandbox = {
  FormApp: {
    create: t => { const f = new Form('form' + (forms.size + 1), t); forms.set(f.id, f); return f; },
    openById: id => { if (!forms.has(id)) throw new Error('フォームがありません'); return forms.get(id); },
    createTextValidation: () => { const b = { setHelpText: () => b, requireTextMatchesPattern: () => b, build: () => ({}) }; return b; },
  },
  MailApp: { sendEmail: m => { mails.push(m); mailQuota--; }, getRemainingDailyQuota: () => mailQuota },
  console: { log: () => {}, error: m => { sandbox.__errors.push(m); } }, __errors: [],
  SpreadsheetApp: {
    openById: id => books[id] || (books[id] = new Book(id)),
    newDataValidation: builder, ProtectionType: { SHEET: 'SHEET', RANGE: 'RANGE' }, flush: () => {},
  },
  Utilities: {
    formatDate: (d, tz, f) => fmt(d, f),
    parseDate: (s, tz, f) => { const [y, m, d] = s.split('-').map(Number); return new sandbox.Date(Date.UTC(y, m - 1, d) - TZ_OFFSET); },
    getUuid: () => require('crypto').randomUUID(),
  },
  Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@example.invalid' }), getActiveUser: () => ({ getEmail: () => activeUser }) },
  CacheService: { getScriptCache: () => ({ get: k => (cache.has(k) ? cache.get(k) : null), put: (k, v) => cache.set(k, v) }) },
  HtmlService: { createHtmlOutput: h => { const o = { html: h, setTitle: t => { o.title = t; return o; }, addMetaTag: () => o }; return o; } },
  LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => (props.has(k) ? props.get(k) : null), setProperty: (k, v) => props.set(k, v), deleteProperty: k => props.delete(k) }) },
  ScriptApp: {
    getProjectTriggers: () => triggers.slice(),
    getService: () => ({ getUrl: () => webAppUrl }),
    deleteTrigger: t => { triggers.splice(triggers.indexOf(t), 1); },
    newTrigger: name => {
      const t = { getHandlerFunction: () => name };
      const chain = { forSpreadsheet: () => chain, onEdit: () => chain, timeBased: () => chain, everyMinutes: () => chain, create: () => { triggers.push(t); return t; } };
      return chain;
    },
  },
};
sandbox.Date = class extends Date { constructor(...a) { if (a.length) super(...a); else super(FIXED_NOW); } static now() { return FIXED_NOW; } };
vm.createContext(sandbox);
vm.runInContext(src.replace(/lookupUrl: '[^']*'/, "lookupUrl: ''") + '\n;this.__api={Logic,APP,初期設定,架空データを入れる,研修の架空データを入れる,今すぐ一覧を更新,トリガーを止める,memberLookup,doGet,handleSoumuEdit,handleKaikeiEdit,handleKouhouEdit,handleKenshuEdit,refreshTick,headerMap_,APPLY_HEADERS,TRAINING_HEADERS,ROSTER_HEADERS,MOVE_HEADERS,LEDGER_HEADERS,SETTINGS_HEADERS,TRANSFER_IN_HEADERS};', sandbox);
const api = sandbox.__api;
const soumu = () => books[api.APP.books.soumu], kaikei = () => books[api.APP.books.kaikei], kouhou = () => books[api.APP.books.kouhou], kenshu = () => books[api.APP.books.kenshu];
const sh = (b, n) => b.getSheetByName(n);
const col = (s, h) => api.headerMap_(s, [h])[h];
function edit(book, sheetName, row, header, value, handler) {
  const s = sh(book, sheetName), c = col(s, header), old = s.get(row, c);
  s.set(row, c, value);
  const range = s.getRange(row, c);
  api[handler]({ range, value: String(value), oldValue: old === '' ? undefined : String(old), user: { getEmail: () => 'kaikei@example.invalid' } });
}
function tick(book, sheetName, row, header, handler) { edit(book, sheetName, row, header, true, handler); }
function cellOf(book, sheetName, row, header) { const s = sh(book, sheetName); return s.get(row, col(s, header)); }
function ledgerRows() {
  const out = [];
  kaikei().getSheets().filter(x => /^会費台帳_\d{4}$/.test(x.name)).forEach(s => {
    const H = api.headerMap_(s, api.LEDGER_HEADERS), year = Number(s.name.slice(-4));
    for (let r = 2; r <= s.getLastRow(); r++) if (s.get(r, H['登録番号']) !== '') out.push({ r, sheet: s.name, id: s.get(r, H['登録番号']), name: s.get(r, H['氏名（自動）']), year, amount: s.get(r, H['請求金額']), status: s.get(r, H['納入状況']), check: s.get(r, H['チェック（自動）']), due: s.get(r, H['納期限']) });
  });
  return out.sort((a, b) => a.year - b.year || a.r - b.r);
}
// 10分ごとの自動実行（1分以内の連続呼び出しは止まるので、前回の時刻を消してから呼ぶ）
function runTick() { props.delete('LAST_TICK'); api.refreshTick(); }
let passed = 0;
function step(name, fn) { fn(); passed++; console.log('OK  ' + name); }

step('初期設定：シート・トリガーができる', () => {
  api.初期設定();
  assert.deepStrictEqual(soumu().getSheets().map(s => s.name), ['正本', '異動受付', '会員異動履歴', '管理', 'エラー記録', '送信設定', '送信記録', '郵送リスト', '会員照会', '照会記録', '長期未納']);
  assert.deepStrictEqual(kenshu().getSheets().map(s => s.name), ['研修一覧', '判定の基準']);
  assert.deepStrictEqual(kaikei().getSheets().map(s => s.name), ['年度設定', '送金入力', '送金記録', '会計一覧', '年度別集計', '送金集計', '台帳変更履歴']);
  assert.deepStrictEqual(triggers.map(t => t.getHandlerFunction()), ['handleSoumuEdit', 'handleKaikeiEdit', 'handleKouhouEdit', 'handleKenshuEdit', 'refreshTick']);
  assert.deepStrictEqual(kouhou().getSheets().map(s => s.name), ['文面', '督促対象', '文面の確認', '送信結果', '送信設定', '送信実行']);
  assert.ok(['送信設定', '送信記録', '郵送リスト'].every(n => soumu().getSheetByName(n)));
  api.初期設定(); // 2回目も壊れない
  assert.strictEqual(triggers.length, 5);
  assert.strictEqual(sh(soumu(), '送信設定').getLastRow(), 2, '総務は本番アカウントの1行だけ');
  assert.strictEqual(sh(kouhou(), '送信設定').getLastRow(), 7, '広報の設定行は重複しない');
});

step('架空データ：台帳がすべてOKになる', () => {
  api.架空データを入れる();
  const rows = ledgerRows();
  assert.strictEqual(rows.length, 8);
  assert.strictEqual(kaikei().getSheets()[0].name, '会費台帳_2026', '年度のシートが先頭にできる');
  assert.ok(rows.every(r => r.check === 'OK'), JSON.stringify(rows.filter(r => r.check !== 'OK')));
  assert.strictEqual(rows[0].name, '架空 桜子');
  assert.ok(rows[0].due instanceof Date, '納期限は日付で保存');
  assert.strictEqual(typeof rows[0].amount, 'number', '金額は数値で保存');
  assert.throws(() => api.架空データを入れる(), /既にデータ/);
  // 督促：0004（メールあり）と 0008（メールなし＝郵送）
  const t = sh(kouhou(), '督促対象');
  assert.deepStrictEqual([t.get(3, 2), t.get(3, 8), t.get(3, 1)], ['0004', 'メール', true]);
  assert.deepStrictEqual([t.get(4, 2), t.get(4, 8), t.get(4, 1)], ['0008', '郵送', false]);
  const post = sh(soumu(), '郵送リスト');
  assert.deepStrictEqual([post.get(3, 1), post.get(3, 7)], ['0008', '架空市 見本町']);
  assert.match(String(sh(kouhou(), '文面の確認').get(3, 1)), /会員各位[\s\S]*18,000円[\s\S]*架空銀行/);
});

step('年度追加：1回目は確認、2回目で追加', () => {
  tick(kaikei(), '年度設定', 3, '年度追加', 'handleKaikeiEdit');
  assert.strictEqual(cellOf(kaikei(), '年度設定', 3, '状態'), '確認待ち');
  assert.match(cellOf(kaikei(), '年度設定', 3, '結果・確認内容'), /在籍 5名 × 18,000円/);
  assert.strictEqual(cellOf(kaikei(), '年度設定', 3, '年度追加'), false);
  tick(kaikei(), '年度設定', 3, '年度追加', 'handleKaikeiEdit');
  assert.strictEqual(cellOf(kaikei(), '年度設定', 3, '状態'), '完了');
  assert.deepStrictEqual(kaikei().getSheets().slice(0, 2).map(x => x.name), ['会費台帳_2027', '会費台帳_2026'], '新しい年度が先頭');
  const y27 = ledgerRows().filter(r => r.year === 2027);
  assert.deepStrictEqual(y27.map(r => r.id), ['0001', '0002', '0003', '0004', '0008']);
  assert.ok(y27.every(r => r.amount === 18000 && r.status === '未納' && r.name));
});

step('新入会：確認 → 入力を変えると確認やり直し → 保存', () => {
  const b = soumu(), n = '異動受付', h = 'handleSoumuEdit';
  edit(b, n, 2, '手続き', '新入会', h);
  edit(b, n, 2, '異動日', '2026-10-01', h);
  edit(b, n, 2, '登録番号', '9', h);
  edit(b, n, 2, '氏名', '新 太郎', h);
  edit(b, n, 2, 'よみがな', 'シン タロウ', h);
  edit(b, n, 2, '登録期', '36期', h);
  edit(b, n, 2, '確認内容・理由', '入会届を受領', h);
  tick(b, n, 2, '実行', h);
  assert.strictEqual(cellOf(b, n, 2, '状態'), 'エラー');
  assert.match(cellOf(b, n, 2, '結果・確認内容'), /個別納期限/);
  edit(b, n, 2, '個別納期限', '2026-10-31', h);
  tick(b, n, 2, '実行', h);
  assert.strictEqual(cellOf(b, n, 2, '状態'), '確認待ち');
  assert.match(cellOf(b, n, 2, '結果・確認内容'), /0009 新 太郎[\s\S]*2026年度 未納／請求 18,000円[\s\S]*2027年度/);
  edit(b, n, 2, '確認内容・理由', '入会届を受領（9/30付）', h);
  assert.strictEqual(cellOf(b, n, 2, '状態'), '');
  tick(b, n, 2, '実行', h);
  tick(b, n, 2, '実行', h);
  assert.strictEqual(cellOf(b, n, 2, '状態'), '完了', cellOf(b, n, 2, '結果・確認内容'));
  const roster = sh(b, '正本'), RH = api.headerMap_(roster, api.ROSTER_HEADERS);
  assert.strictEqual(roster.get(10, RH['登録番号']), '0009');
  assert.strictEqual(roster.get(10, RH['在籍状況']), '在籍');
  assert.strictEqual(roster.get(10, RH['都道府県名']), '神奈川県');
  assert.ok(roster.get(10, RH['修正日']) instanceof Date);
  const mine = ledgerRows().filter(r => r.id === '0009');
  assert.deepStrictEqual(mine.map(r => [r.year, r.amount, r.status, r.name]), [[2026, 18000, '未納', '新 太郎'], [2027, 18000, '未納', '新 太郎']]);
  assert.strictEqual(sh(b, '会員異動履歴').get(2, 2), '完了');
  tick(b, n, 2, '実行', h);
  assert.match(cellOf(b, n, 2, '結果・確認内容'), /保存済み/);
});

step('退会：翌年度の未納が対象外になる', () => {
  const b = soumu(), n = '異動受付', h = 'handleSoumuEdit';
  edit(b, n, 3, '手続き', '退会', h);
  edit(b, n, 3, '異動日', '2026-10-01', h);
  edit(b, n, 3, '登録番号', '0002', h);
  edit(b, n, 3, '確認内容・理由', '退会届', h);
  tick(b, n, 3, '実行', h);
  tick(b, n, 3, '実行', h);
  assert.strictEqual(cellOf(b, n, 3, '状態'), '完了', cellOf(b, n, 3, '結果・確認内容'));
  const r27 = ledgerRows().find(r => r.id === '0002' && r.year === 2027);
  assert.strictEqual(r27.status, '対象外');
  assert.strictEqual(ledgerRows().find(r => r.id === '0002' && r.year === 2026).status, '納入済み');
});

step('会費台帳の直接入力：検査と変更履歴', () => {
  const k = kaikei();
  const r = ledgerRows().find(x => x.id === '0008' && x.year === 2026).r;
  edit(k, '会費台帳_2026', r, '納入状況', '納入済み', 'handleKaikeiEdit');
  assert.match(cellOf(k, '会費台帳_2026', r, 'チェック（自動）'), /要確認：.*同額/);
  const audit = sh(k, '台帳変更履歴');
  assert.strictEqual(audit.get(audit.getLastRow(), 6), '納入状況');
  assert.strictEqual(audit.get(audit.getLastRow(), 8), '納入済み');
  assert.strictEqual(audit.get(audit.getLastRow(), 5), 2026, '変更履歴に年度が入る');
  edit(k, '会費台帳_2026', r, '入金額', 18000, 'handleKaikeiEdit');
  // 日付セルの編集では通し番号が渡される（46295 = 2026-09-30）
  const ds = sh(k, '会費台帳_2026'), dc = col(ds, '入金日');
  ds.set(r, dc, new sandbox.Date(Date.UTC(2026, 8, 30) - 9 * 3600 * 1000));
  api.handleKaikeiEdit({ range: ds.getRange(r, dc), value: '46295', oldValue: undefined, user: { getEmail: () => 'kaikei@example.invalid' } });
  assert.strictEqual(audit.get(audit.getLastRow(), 8), '2026-09-30', '日付は日付の形で記録');
  assert.strictEqual(cellOf(k, '会費台帳_2026', r, 'チェック（自動）'), 'OK');
});

step('送金入力：確認 → 記録 → 二重記録しない → 取消', () => {
  const k = kaikei(), n = '送金入力', h = 'handleKaikeiEdit';
  edit(k, n, 2, '年度', 2026, h);
  edit(k, n, 2, '送金先', '本会', h);
  edit(k, n, 2, '対象人数', 3, h);
  edit(k, n, 2, '送金額', 36000, h);
  edit(k, n, 2, '送金日', '2026-09-25', h);
  tick(k, n, 2, '実行', h);
  assert.match(cellOf(k, n, 2, '結果・確認内容'), /納入済み 3名 → 送るべき額の目安 36,000円/);
  tick(k, n, 2, '実行', h);
  assert.strictEqual(cellOf(k, n, 2, '状態'), '完了');
  const log = sh(k, '送金記録');
  assert.strictEqual(log.getLastRow(), 2);
  assert.strictEqual(log.get(2, 6), 36000);
  const sumSheet = sh(k, '送金集計');
  const now26 = sumSheet.getRange(3, 1, sumSheet.getLastRow() - 2, 9).getValues().find(r => r[0] === 2026 && r[1] === '本会');
  assert.strictEqual(now26[5], 36000, '送金記録の直後に送金集計が更新される');
  tick(k, n, 2, '実行', h);
  assert.strictEqual(log.getLastRow(), 2, '二重に記録しない');
  const id = log.get(2, 1);
  edit(k, n, 3, '取消する記録ID', id, h);
  edit(k, n, 3, '備考', '人数誤り', h);
  tick(k, n, 3, '実行', h);
  tick(k, n, 3, '実行', h);
  assert.strictEqual(log.get(3, 2), '取消');
  assert.strictEqual(log.get(3, 6), -36000);
});

step('一覧・集計・管理シートの更新', () => {
  runTick();
  assert.ok(!props.has('DIRTY'));
  const m = sh(kaikei(), '会計一覧');
  assert.deepStrictEqual(m.getRange(2, 1, 1, 6).getValues()[0], ['登録番号', '氏名', '登録期', '在籍状況', '2027年度', '2026年度']);
  assert.strictEqual(m.get(3, 1), '0001', '会計一覧の番号は先頭の0を残す');
  const s = sh(kaikei(), '送金集計');
  const rows = s.getRange(3, 1, s.getLastRow() - 2, 9).getValues();
  const h26 = rows.find(r => r[0] === 2026 && r[1] === '本会');
  assert.deepStrictEqual(h26.slice(2), [3, 12000, 36000, 0, 36000, '2026-09-30', '期限を過ぎて未送金あり']);
  const admin = sh(soumu(), '管理');
  assert.strictEqual(admin.get(2, 2), api.APP.version);
  assert.match(String(admin.get(4, 2)), /^5／1／2／1$/);
  assert.deepStrictEqual(sandbox.__errors, [], 'エラー記録なし');
});

step('数式になる名前でも安全に保存', () => {
  const b = soumu(), n = '異動受付', h = 'handleSoumuEdit';
  edit(b, n, 4, '手続き', '新入会', h);
  edit(b, n, 4, '異動日', '2026-07-01', h);
  edit(b, n, 4, '登録番号', '10', h);
  edit(b, n, 4, '氏名', "'=HYPERLINK(\"x\")", h); // 文字として入力された「=」で始まる名前
  edit(b, n, 4, 'よみがな', 'テスト', h);
  edit(b, n, 4, '登録期', '36期', h);
  edit(b, n, 4, '確認内容・理由', "'+検査", h);
  tick(b, n, 4, '実行', h);
  tick(b, n, 4, '実行', h);
  assert.strictEqual(cellOf(b, n, 4, '状態'), '完了', cellOf(b, n, 4, '結果・確認内容'));
  const roster = sh(b, '正本'), RH = api.headerMap_(roster, api.ROSTER_HEADERS);
  assert.strictEqual(roster.get(11, RH['氏名']), '=HYPERLINK("x")', '文字のまま保存');
  api.今すぐ一覧を更新();
});

step('督促メール：停止中は送れない → 試験で確認 → 送信 → 二重送信しない', () => {
  const b = kouhou(), n = '送信実行', h = 'handleKouhouEdit';
  edit(b, n, 2, '対象年度', 2026, h);
  tick(b, n, 2, '実行', h);
  assert.match(cellOf(b, n, 2, '結果・確認内容'), /送信モードが「停止」/);
  const set = sh(b, '送信設定');
  const rowOf = key => { for (let r = 2; r <= set.getLastRow(); r++) if (set.get(r, 1) === key) return r; };
  set.set(rowOf('送信モード'), 2, '試験');
  set.set(rowOf('試験送信先'), 2, 'tester@example.invalid');
  tick(b, n, 2, '実行', h);
  assert.strictEqual(cellOf(b, n, 2, '状態'), '確認待ち');
  assert.match(cellOf(b, n, 2, '結果・確認内容'), /今回の宛先：1名（メール 1通）[\s\S]*tester@example.invalid[\s\S]*本番では次の 1名にBCC[\s\S]*0004 架空 梅二[\s\S]*会員各位/);
  assert.strictEqual(mails.length, 0, '1回目では送らない');
  tick(b, n, 2, '実行', h);
  assert.strictEqual(cellOf(b, n, 2, '状態'), '完了', cellOf(b, n, 2, '結果・確認内容'));
  assert.strictEqual(mails.length, 1);
  assert.deepStrictEqual([mails[0].to, mails[0].name], ['tester@example.invalid', '日本樹木医会神奈川県支部']);
  assert.match(mails[0].subject, /^【試験】/);
  const log = sh(soumu(), '送信記録');
  assert.deepStrictEqual([log.get(2, 3), log.get(2, 7), log.get(2, 8)], ['0004', '試験', '試験送信済み']);
  assert.strictEqual(sh(kouhou(), '送信結果').get(3, 2), '0004');
  // 7日以内は同じ人に送らない
  edit(b, n, 3, '対象年度', 2026, h);
  tick(b, n, 3, '実行', h);
  assert.match(cellOf(b, n, 3, '結果・確認内容'), /最近送信済み 1名[\s\S]*送る相手がいません/);
});

step('督促メール：「送る」を外す・文面の誤り・本番の安全装置', () => {
  const b = kouhou(), n = '送信実行', h = 'handleKouhouEdit';
  const set = sh(b, '送信設定'), sset = sh(soumu(), '送信設定');
  const rowOf = key => { for (let r = 2; r <= set.getLastRow(); r++) if (set.get(r, 1) === key) return r; };
  // 本番：送信アカウントが未登録なら止める
  set.set(rowOf('送信モード'), 2, '本番');
  edit(b, n, 4, '対象年度', 2026, h);
  tick(b, n, 4, '実行', h);
  assert.match(cellOf(b, n, 4, '結果・確認内容'), /本番で使う送信アカウント/);
  // 登録しても、試験用アドレス（.invalid）の会員には送らない
  sset.set(2, 2, 'owner@example.invalid'); // 総務が本番の送信アカウントを登録
  tick(b, n, 4, '実行', h);
  assert.match(cellOf(b, n, 4, '結果・確認内容'), /試験用のアドレス/);
  // 会費案内先を本物らしいアドレスにすると、本番はBCCで送られる
  const roster = sh(soumu(), '正本'), RH = api.headerMap_(roster, api.ROSTER_HEADERS);
  for (let r = 2; r <= roster.getLastRow(); r++) if (roster.get(r, RH['登録番号']) === '0004') roster.set(r, RH['会費案内先'], 'ume@mail.jp');
  tick(b, n, 4, '実行', h);
  assert.match(cellOf(b, n, 4, '結果・確認内容'), /BCCで一斉[\s\S]*未納者は全員BCC/);
  tick(b, n, 4, '実行', h);
  assert.strictEqual(cellOf(b, n, 4, '状態'), '完了', cellOf(b, n, 4, '結果・確認内容'));
  const last = mails[mails.length - 1];
  assert.deepStrictEqual([last.to, last.bcc, last.subject], ['owner@example.invalid', 'ume@mail.jp', '【日本樹木医会神奈川県支部】年会費納入のお願い']);
  const log = sh(soumu(), '送信記録');
  assert.deepStrictEqual([log.get(log.getLastRow(), 6), log.get(log.getLastRow(), 8)], ['BCC：ume@mail.jp', '送信済み']);
  set.set(rowOf('送信モード'), 2, '試験');
  // 文面に使えない差し込み
  const tpl = sh(kouhou(), '文面');
  const body = tpl.get(3, 2);
  tpl.set(3, 2, body + '{{住所}}');
  api.handleKouhouEdit({ range: tpl.getRange(3, 2) });
  assert.match(String(sh(kouhou(), '文面の確認').get(3, 1)), /使えない差し込み項目.*住所/);
  tpl.set(3, 2, body);
  api.handleKouhouEdit({ range: tpl.getRange(3, 2) });
  assert.strictEqual(mails.length, 2, '誤りのときは送っていない');
  // 「送る」を外すと対象から外れ、一覧を更新してもチェックは外れたまま
  const t = sh(kouhou(), '督促対象');
  t.set(3, 1, false);
  api.handleKouhouEdit({ range: t.getRange(3, 1) });
  api.今すぐ一覧を更新();
  assert.strictEqual(sh(kouhou(), '督促対象').get(3, 1), false);
  edit(b, n, 5, '対象年度', 2026, h);
  tick(b, n, 5, '実行', h);
  assert.match(cellOf(b, n, 5, '結果・確認内容'), /チェックなし 1名/);
});

step('研修：研修会ごとの申込シートで判定 → フォーム作成 → 回答の取り込み → 研修担当の判断 → 入金状況の反映', () => {
  const K = api.Logic.KUBUN, b = kenshu(), h = 'handleKenshuEdit';
  api.研修の架空データを入れる();
  assert.deepStrictEqual(b.getSheets().map(x => x.name), ['研修一覧', '申込_TEST-02', '申込_TEST-01', '判定の基準', '年度集計_2026']);
  const S2 = '申込_TEST-02', ap = sh(b, S2);
  const A = (r, hd) => cellOf(b, S2, r, hd), T = (r, hd) => cellOf(b, '研修一覧', r, hd);
  assert.deepStrictEqual([cellOf(b, '申込_TEST-01', 2, '登録番号'), cellOf(b, '申込_TEST-01', 2, '判定（自動）')], ['0004', '参加可']);
  assert.match(cellOf(b, '申込_TEST-01', 2, '理由（自動）'), /納期限（2026-07-31）前/);
  assert.deepStrictEqual([2, 3, 4, 5, 6, 7, 8].map(r => [A(r, '登録番号'), A(r, '判定（自動）')]), [
    ['0001', '参加可'], ['0003', '参加可'], ['0004', '参加不可'], ['0006', '参加不可'], ['0001', '要確認'], ['1234', api.Logic.EXTERNAL], ['', api.Logic.EXTERNAL]]);
  assert.match(A(4, '理由（自動）'), /2026年度の会費が未納/);
  assert.match(A(6, '理由（自動）'), /重複[\s\S]*氏名が名簿と違います/);
  assert.match(String(A(2, '受付ID')), /^M-/);
  assert.deepStrictEqual([T(2, '年度（自動）'), T(2, '申込シート（自動）'), T(2, '受付（自動）'), T(3, '受付（自動）'), T(3, '申込（自動）'), T(3, '参加可（自動）'), T(3, '外部（自動）')],
    [2026, '申込_TEST-01', '終了（開催済み）', 'フォーム未作成', 6, 2, 2]);
  // 研修IDは空欄なら年度の連番。IDを変えるとシート名も変わる
  edit(b, '研修一覧', 4, '研修名', '架空・冬の研修', h);
  edit(b, '研修一覧', 4, '開催日', new sandbox.Date(Date.UTC(2027, 1, 10) - 9 * 3600 * 1000), h);
  assert.deepStrictEqual([T(4, '研修ID'), T(4, '年度（自動）'), T(4, '申込シート（自動）')], ['2026-01', 2026, '申込_2026-01']);
  edit(b, '研修一覧', 4, '研修ID', '2026-03', h);
  assert.ok(sh(b, '申込_2026-03') && !sh(b, '申込_2026-01'), 'シート名が変わる');
  // フォームを作る（個人のアカウントでは setRequireLogin が使えなくても止まらない）
  tick(b, '研修一覧', 3, 'フォーム作成', h);
  assert.match(String(T(3, '結果・確認内容')), /フォームを作りました/);
  const form = forms.get(T(3, 'フォームID'));
  assert.ok(form && form.accepting);
  assert.strictEqual(T(3, 'フォームURL（自動）'), form.getPublishedUrl());
  assert.strictEqual(T(3, '受付（自動）'), '受付中');
  assert.deepStrictEqual(form.items.map(i => i.title), ['区分', '樹木医登録番号', '樹木医の登録期', '氏名', '所属・勤務先', '連絡事項']);
  // 前の版で作ったフォーム（登録期の質問なし）にも、自動で足される
  form.items.splice(2, 1);
  form.items.push(new FormItem('text').setTitle('懇親会'));
  props.set('FORMTXT_' + form.id, '前の版');
  edit(b, '研修一覧', 3, '会場', '架空公園 管理棟', h);
  assert.deepStrictEqual(form.items.map(i => i.title), ['区分', '樹木医登録番号', '樹木医の登録期', '氏名', '所属・勤務先', '連絡事項', '懇親会']);
  assert.match(form.desc, /会場：架空公園 管理棟/);
  assert.match(form.title, /架空・秋の研修.*参加申込/);
  tick(b, '研修一覧', 3, 'フォーム作成', h);
  assert.strictEqual(forms.size, 1, '2回目は作らない');
  // 回答 → 10分ごとの処理で、その研修の申込シートへ取り込む（同じ回答は1回だけ）
  form.respond('r1', 'shin@mail.jp', { '区分': K[0], '樹木医登録番号': '9', '樹木医の登録期': '第36期', '氏名': '新 太郎', '懇親会': '参加' });
  runTick(); runTick();
  assert.strictEqual(ap.getLastRow(), 9);
  assert.deepStrictEqual([A(9, '受付ID'), A(9, '登録番号'), A(9, '登録期'), A(9, 'メール'), A(9, 'その他の回答'), A(9, '判定（自動）')],
    ['F-r1', '9', '第36期', 'shin@mail.jp', '懇親会：参加', '参加不可']);
  assert.match(A(9, '理由（自動）'), /納期限 2026-10-31/);
  // 研修担当の判断が「最終」に反映
  edit(b, S2, 4, '研修担当の判断', '参加可', h);
  assert.deepStrictEqual([A(4, '判定（自動）'), A(4, '最終（自動）')], ['参加不可', '参加可']);
  edit(b, S2, 4, '研修担当の判断', '', h);
  // 会計で「確認中」にすると、判定が自動で変わる
  const r04 = ledgerRows().find(x => x.id === '0004' && x.year === 2026).r;
  edit(kaikei(), '会費台帳_2026', r04, '納入状況', '確認中', 'handleKaikeiEdit');
  assert.deepStrictEqual([A(4, '判定（自動）'), A(4, '理由（自動）')], ['要確認', '2026年度の会費が確認中です']);
  // 定員に達するとフォームを閉じる
  edit(b, '研修一覧', 3, '定員', 7, h);
  assert.deepStrictEqual([T(3, '申込（自動）'), T(3, '受付（自動）'), form.accepting], [7, '定員到達', false]);
  edit(b, '研修一覧', 3, '定員', 30, h);
  assert.deepStrictEqual([T(3, '受付（自動）'), form.accepting], ['受付中', true]);
  // 開催日を過ぎると判定は固定。出欠は年度集計へ
  const saved = FIXED_NOW;
  FIXED_NOW = Date.parse('2026-11-20T03:00:00Z');
  runTick();
  assert.deepStrictEqual([T(3, '受付（自動）'), form.accepting], ['終了（開催済み）', false]);
  edit(kaikei(), '会費台帳_2026', r04, '納入状況', '未納', 'handleKaikeiEdit');
  assert.strictEqual(A(4, '判定（自動）'), '要確認', '開催後は変わらない');
  edit(b, '研修一覧', 3, '研修名', '', h);
  assert.match(String(T(3, '結果・確認内容')), /^入力を確認：研修名/);
  assert.strictEqual(A(4, '判定（自動）'), '要確認', '研修一覧の入力が崩れても、判定は残る');
  edit(b, '研修一覧', 3, '研修名', '架空・秋の研修（納期限後）', h);
  assert.strictEqual(T(3, '結果・確認内容'), '', '直したら注意書きは消える');
  edit(b, S2, 2, '出欠', '出席', h);
  edit(b, S2, 7, '出欠', '出席', h);
  edit(b, S2, 5, '出欠', '申込取消', h);
  edit(b, '申込_TEST-01', 2, '出欠', '出席', h);
  assert.strictEqual(T(3, '出席（自動）'), 2);
  const y = sh(b, '年度集計_2026');
  assert.deepStrictEqual(y.getRange(2, 1, 1, 7).getValues()[0], ['登録番号', '氏名', '区分', '出席回数', 'TEST-01（07/20）', 'TEST-02（11/15）', '2026-03（02/10）']);
  const grid = y.getRange(3, 1, y.getLastRow() - 2, 7).getValues().map(r => r.join('|'));
  assert.ok(grid.includes('0001|架空 桜子|' + K[0] + '|1||出席|'), grid.join('\n'));
  assert.ok(grid.includes('0004|架空 梅二|' + K[0] + '|1|出席|申込|'), grid.join('\n'));
  assert.ok(grid.includes('0006|架空 楓|' + K[0] + '|0||取消|'), grid.join('\n'));
  assert.ok(grid.includes('|一般 次郎|' + K[2] + '|0||申込|'), grid.join('\n'));
  // 年度が変わると、前の年度の研修のシートは非表示。手で再表示したものは、そのまま
  assert.ok(b.getSheets().every(x => !x.isSheetHidden()));
  FIXED_NOW = Date.parse('2027-04-02T03:00:00Z');
  runTick();
  assert.deepStrictEqual(b.getSheets().filter(x => x.isSheetHidden()).map(x => x.name).sort(), ['年度集計_2026', '申込_2026-03', '申込_TEST-01', '申込_TEST-02']);
  sh(b, '申込_TEST-02').showSheet();
  api.今すぐ一覧を更新();
  assert.ok(!sh(b, '申込_TEST-02').isSheetHidden(), '再表示したシートは隠し直さない');
  edit(b, '研修一覧', 5, '研修名', '架空・前年度の研修（後から入力）', h);
  edit(b, '研修一覧', 5, '開催日', new sandbox.Date(Date.UTC(2027, 2, 1) - 9 * 3600 * 1000), h);
  assert.ok(sh(b, '申込_2026-04').isSheetHidden(), '前の年度の研修を後から入れたら、シートは非表示で作る');
  assert.ok(!sh(b, '研修一覧').isSheetHidden() && !sh(b, '判定の基準').isSheetHidden());
  FIXED_NOW = saved;
  api.今すぐ一覧を更新();
  assert.deepStrictEqual(sh(soumu(), '長期未納').getRange(2, 1, 1, 5).getValues()[0], ['登録番号', '氏名', '登録期', '未納の年度', '未納額の合計']);
  assert.deepStrictEqual(sandbox.__errors, [], 'エラー記録なし');
});

step('会員照会：停止中・公開・番号の入力・上限、管理用の関数は照会ページからは動かない', () => {
  const look = n => api.memberLookup(n);
  assert.match(look('4').message, /停止/);
  const ls = sh(soumu(), '会員照会');
  const rowOf = key => { for (let r = 2; r <= ls.getLastRow(); r++) if (ls.get(r, 1) === key) return r; };
  assert.strictEqual(ls.get(rowOf('照会のURL'), 2), '', 'URLは最初は空欄');
  ls.set(rowOf('照会の公開'), 2, '公開');
  ls.set(rowOf('照会画面のお知らせ'), 2, '試験中です');
  const v = look('４');
  assert.ok(v.ok, JSON.stringify(v));
  assert.deepStrictEqual([v.id, v.name, v.notice], ['0004', '架〇 梅〇', '試験中です']);
  assert.strictEqual(JSON.stringify(v.rows.map(r => [r.year, r.status])), '[[2026,"未納"]]', '翌年度（2027）は出さない');
  assert.match(v.pay[0].bank, /架空銀行/);
  assert.match(look('0005').message, /見つかりませんでした/, '退会者は出さない');
  assert.match(look('abc').message, /数字で/);
  const log = sh(soumu(), '照会記録');
  assert.deepStrictEqual([log.get(log.getLastRow(), 2), log.get(log.getLastRow(), 3)], ['0005', '該当なし']);
  for (let i = 0; i < 19; i++) look('0001');
  assert.ok(look('0001').ok);
  assert.match(look('0001').message, /本日の上限/, '同じ番号は1日20回まで');
  cache.clear();
  // ページの表示と、URLの記録
  assert.match(api.doGet().html, /年会費の納入状況の確認[\s\S]*memberLookup/);
  webAppUrl = 'https://script.google.com/macros/s/head/dev';
  api.今すぐ一覧を更新();
  assert.strictEqual(ls.get(rowOf('照会のURL'), 2), '', '/dev（持ち主専用）のURLは入れない');
  assert.ok(sh(soumu(), '管理').getRange(2, 2, 30, 1).getValues().some(r => /照会のURLが未設定/.test(r[0])));
  webAppUrl = 'https://script.google.com/macros/s/xxx/exec';
  api.今すぐ一覧を更新();
  assert.strictEqual(ls.get(rowOf('照会のURL'), 2), webAppUrl, '公開用（/exec）が分かれば入れる');
  ls.set(rowOf('照会のURL'), 2, 'https://script.google.com/macros/s/mine/exec');
  api.今すぐ一覧を更新();
  assert.strictEqual(ls.get(rowOf('照会のURL'), 2), 'https://script.google.com/macros/s/mine/exec', '貼り付けたURLは書き換えない');
  // 前の版の「照会のURL（自動）」（/dev 入り）は、貼り付ける形に変わる
  ls.set(rowOf('照会のURL'), 1, '照会のURL（自動）'); ls.set(rowOf('照会のURL（自動）'), 2, 'https://script.google.com/macros/s/head/dev');
  api.初期設定();
  assert.deepStrictEqual([rowOf('照会のURL（自動）'), ls.get(rowOf('照会のURL'), 2)], [undefined, 'https://script.google.com/macros/s/xxx/exec']);
  // 照会ページ（だれでも開ける）から管理用の関数を呼ばれても動かない
  activeUser = '';
  assert.throws(() => api.トリガーを止める(), /Apps Script の画面から/);
  assert.throws(() => api.初期設定(), /Apps Script の画面から/);
  assert.throws(() => api.架空データを入れる(), /Apps Script の画面から/);
  assert.strictEqual(triggers.length, 5, 'トリガーは止まっていない');
  assert.ok(look('0001').ok, '照会はできる');
  activeUser = 'owner@example.invalid';
  // 自動更新は1分以内に何度呼ばれても1回だけ
  props.set('DIRTY', '1'); runTick(); assert.ok(!props.has('DIRTY'));
  props.set('DIRTY', '1'); api.refreshTick(); assert.ok(props.has('DIRTY'), '1分以内の2回目は何もしない');
  props.delete('DIRTY');
  ls.set(rowOf('照会の公開'), 2, '停止');
  assert.match(look('0001').message, /停止/);
  assert.deepStrictEqual(sandbox.__errors, [], 'エラー記録なし');
});

step('旧形式の「会費台帳」1枚を年度ごとのシートへ移す', () => {
  delete books[api.APP.books.soumu]; delete books[api.APP.books.kaikei]; delete books[api.APP.books.kouhou];
  triggers.length = 0;
  const k = api.Logic && (books[api.APP.books.kaikei] = new Book(api.APP.books.kaikei));
  const old = k.insertSheet('会費台帳');
  const head = ['登録番号', '氏名（自動）', '登録期（自動）', '在籍状況（自動）', '年度', '請求金額', '納期限', '納入状況', '入金日', '入金額', '会計備考', 'チェック（自動）', '最終更新（自動）'];
  head.forEach((h, i) => old.set(1, i + 1, h));
  [['0001', 2026, 18000, '納入済み', 18000, '2026-07-10'], ['0001', 2027, 18000, '未納', 0, ''], ['0002', 2026, 18000, '未納', 0, '']].forEach((v, i) => {
    old.fmt.set((i + 2) + ':1', '@');
    old.set(i + 2, 1, v[0]); old.set(i + 2, 5, v[1]); old.set(i + 2, 6, v[2]); old.set(i + 2, 7, '2026-07-31'); old.set(i + 2, 8, v[3]); old.set(i + 2, 10, v[4]); old.set(i + 2, 9, v[5]);
  });
  // 前の版：総務に送信設定（全項目）と送信実行があった
  const so = books[api.APP.books.soumu] = new Book(api.APP.books.soumu);
  const oldSet = so.insertSheet('送信設定');
  [['項目', '値', '説明'], ['送信モード', '試験', ''], ['試験送信先', 'me@mail.jp', ''], ['差出人の表示名', '日本樹木医会神奈川県支部', ''], ['返信先', '', ''], ['本番で使う送信アカウント', 'shibu@ws.jp', ''], ['1回の送信上限', 30, ''], ['送り方', 'BCCで一斉', '']]
    .forEach((row, i) => row.forEach((v, j) => oldSet.set(i + 1, j + 1, v)));
  so.insertSheet('送信実行').set(1, 1, '実行');
  // 前の版の研修ブック：研修一覧（年度・申込シートの列なし）と、全研修を1枚にした申込一覧（登録期なし）
  const ke = books[api.APP.books.kenshu] = new Book(api.APP.books.kenshu);
  const oldTl = ke.insertSheet('研修一覧');
  const oldTh = api.TRAINING_HEADERS.filter(x => !['年度（自動）', '申込シート（自動）'].includes(x));
  oldTh.forEach((x, i) => oldTl.set(1, i + 1, x));
  oldTl.fmt.set('2:1', '@');
  [['研修ID', '2026-07'], ['研修名', '前の版の研修'], ['開催日', '2026-12-01'], ['フォームID', 'oldform']].forEach(([k, v]) => oldTl.set(2, oldTh.indexOf(k) + 1, v));
  const oldAp = ke.insertSheet('申込一覧');
  const oldHead = ['受付ID', '受付日時', '研修ID', '区分', '登録番号', '氏名', '判定（自動）', '出欠'];
  oldHead.forEach((x, i) => oldAp.set(1, i + 1, x));
  [['F-a', '2026-10-01 10:00:00', '2026-07', api.Logic.KUBUN[1], '1234', '前の版 の人', '外部（判定なし）', '出席'],
    ['F-b', '2026-10-01 11:00:00', 'NOPE', api.Logic.KUBUN[2], '', '行き先なし', '', '']].forEach((r, i) => r.forEach((v, j) => { oldAp.fmt.set((i + 2) + ':' + (j + 1), '@'); oldAp.set(i + 2, j + 1, v); }));
  api.初期設定();
  const TH = api.headerMap_(oldTl, api.TRAINING_HEADERS);
  assert.strictEqual(oldTl.get(2, TH['研修名']), '前の版の研修', '研修一覧に列が入っても値はそのまま');
  assert.strictEqual(oldTl.fmt.get('2:' + TH['年度（自動）']), '0', '年度は数字の書式（日付の書式を引き継がない）');
  assert.strictEqual(oldTl.get(2, TH['申込シート（自動）']), '申込_2026-07');
  const moved = ke.getSheetByName('申込_2026-07'), MH = api.headerMap_(moved, api.APPLY_HEADERS);
  assert.deepStrictEqual([moved.get(2, MH['受付ID']), moved.get(2, MH['登録番号']), moved.get(2, MH['氏名']), moved.get(2, MH['出欠']), moved.get(3, MH['受付ID'])], ['F-a', '1234', '前の版 の人', '出席', '']);
  assert.ok(ke.getSheetByName('旧_申込一覧（1行は移せませんでした）'), '移せない行があれば元のシートに残す');
  api.初期設定();
  assert.strictEqual(moved.getLastRow(), 2, '2回目は移さない');
  assert.deepStrictEqual([oldSet.getLastRow(), oldSet.get(2, 1), oldSet.get(2, 2)], [2, '本番で使う送信アカウント', 'shibu@ws.jp'], '総務には本番アカウントだけ残る');
  const ks = sh(kouhou(), '送信設定');
  const val = key => { for (let r = 2; r <= ks.getLastRow(); r++) if (ks.get(r, 1) === key) return ks.get(r, 2); };
  assert.deepStrictEqual([val('送信モード'), val('試験送信先')], ['試験', 'me@mail.jp'], '広報へ値が移る');
  assert.ok(so.getSheetByName('旧_送信実行（広報へ移動）'));
  assert.deepStrictEqual(k.getSheets().filter(x => x.name.startsWith('会費台帳_')).map(x => x.name), ['会費台帳_2027', '会費台帳_2026']);
  assert.ok(k.getSheetByName('旧_会費台帳（移行済み）'));
  const rows = ledgerRows();
  assert.deepStrictEqual(rows.map(r => [r.year, r.id, r.status]), [[2026, '0001', '納入済み'], [2026, '0002', '未納'], [2027, '0001', '未納']]);
  api.初期設定(); // 2回目は何もしない
  assert.strictEqual(ledgerRows().length, 3);
});

console.log('\n全 ' + passed + ' 件の通しテストに合格しました');

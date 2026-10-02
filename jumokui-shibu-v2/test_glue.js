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
  setWarningOnly() { return this; } addEditor() { return this; } removeEditors() { return this; }
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
  setFontWeight() { return this; } setFontColor() { return this; } setWrap() { return this; }
  protect() { const p = new Protection(this.sh); p.type = 'RANGE'; this.sh.protections.push(p); return p; }
}
class Sheet {
  constructor(ss, name) { Object.assign(this, { ss, name, cells: new Map(), fmt: new Map(), maxRows: 1000, maxCols: 26, protections: [], check: new Set(), hidden: [] }); }
  getName() { return this.name; } getParent() { return this.ss; } setName(n) { this.name = n; return this; }
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
  protect() { const p = new Protection(this); p.type = 'SHEET'; this.protections.push(p); return p; }
  getProtections(type) { return this.protections.filter(p => p.type === type); }
  appendRow(row) { const r = this.getLastRow() + 1; row.forEach((v, i) => this.set(r, i + 1, v)); }
  clearContents() { this.cells.clear(); }
}
class Book {
  constructor(id) { this.id = id; this.sheets = [new Sheet(this, 'シート1')]; }
  getId() { return this.id; }
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
const sandbox = {
  console: { log: () => {}, error: m => { sandbox.__errors.push(m); } }, __errors: [],
  SpreadsheetApp: {
    openById: id => books[id] || (books[id] = new Book(id)),
    newDataValidation: builder, ProtectionType: { SHEET: 'SHEET', RANGE: 'RANGE' },
  },
  Utilities: {
    formatDate: (d, tz, f) => fmt(d, f),
    parseDate: (s, tz, f) => { const [y, m, d] = s.split('-').map(Number); return new sandbox.Date(Date.UTC(y, m - 1, d) - TZ_OFFSET); },
    getUuid: () => 'uuid-' + Math.random().toString(16).slice(2, 10),
  },
  Session: { getEffectiveUser: () => ({ getEmail: () => 'owner@example.invalid' }) },
  LockService: { getScriptLock: () => ({ tryLock: () => true, waitLock: () => {}, releaseLock: () => {} }) },
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => (props.has(k) ? props.get(k) : null), setProperty: (k, v) => props.set(k, v), deleteProperty: k => props.delete(k) }) },
  ScriptApp: {
    getProjectTriggers: () => triggers.slice(),
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
vm.runInContext(src + '\n;this.__api={Logic,APP,初期設定,架空データを入れる,今すぐ一覧を更新,handleSoumuEdit,handleKaikeiEdit,refreshTick,headerMap_,ROSTER_HEADERS,MOVE_HEADERS,LEDGER_HEADERS,SETTINGS_HEADERS,TRANSFER_IN_HEADERS};', sandbox);
const api = sandbox.__api;
const soumu = () => books[api.APP.books.soumu], kaikei = () => books[api.APP.books.kaikei];
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
let passed = 0;
function step(name, fn) { fn(); passed++; console.log('OK  ' + name); }

step('初期設定：シート・トリガーができる', () => {
  api.初期設定();
  assert.deepStrictEqual(soumu().getSheets().map(s => s.name), ['正本', '異動受付', '会員異動履歴', '管理', 'エラー記録']);
  assert.deepStrictEqual(kaikei().getSheets().map(s => s.name), ['年度設定', '送金入力', '送金記録', '会計一覧', '年度別集計', '送金集計', '台帳変更履歴']);
  assert.deepStrictEqual(triggers.map(t => t.getHandlerFunction()), ['handleSoumuEdit', 'handleKaikeiEdit', 'refreshTick']);
  api.初期設定(); // 2回目も壊れない
  assert.strictEqual(triggers.length, 3);
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
  api.refreshTick();
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

step('旧形式の「会費台帳」1枚を年度ごとのシートへ移す', () => {
  delete books[api.APP.books.soumu]; delete books[api.APP.books.kaikei];
  triggers.length = 0;
  const k = api.Logic && (books[api.APP.books.kaikei] = new Book(api.APP.books.kaikei));
  const old = k.insertSheet('会費台帳');
  const head = ['登録番号', '氏名（自動）', '登録期（自動）', '在籍状況（自動）', '年度', '請求金額', '納期限', '納入状況', '入金日', '入金額', '会計備考', 'チェック（自動）', '最終更新（自動）'];
  head.forEach((h, i) => old.set(1, i + 1, h));
  [['0001', 2026, 18000, '納入済み', 18000, '2026-07-10'], ['0001', 2027, 18000, '未納', 0, ''], ['0002', 2026, 18000, '未納', 0, '']].forEach((v, i) => {
    old.fmt.set((i + 2) + ':1', '@');
    old.set(i + 2, 1, v[0]); old.set(i + 2, 5, v[1]); old.set(i + 2, 6, v[2]); old.set(i + 2, 7, '2026-07-31'); old.set(i + 2, 8, v[3]); old.set(i + 2, 10, v[4]); old.set(i + 2, 9, v[5]);
  });
  api.初期設定();
  assert.deepStrictEqual(k.getSheets().filter(x => x.name.startsWith('会費台帳_')).map(x => x.name), ['会費台帳_2027', '会費台帳_2026']);
  assert.ok(k.getSheetByName('旧_会費台帳（移行済み）'));
  const rows = ledgerRows();
  assert.deepStrictEqual(rows.map(r => [r.year, r.id, r.status]), [[2026, '0001', '納入済み'], [2026, '0002', '未納'], [2027, '0001', '未納']]);
  api.初期設定(); // 2回目は何もしない
  assert.strictEqual(ledgerRows().length, 3);
});

console.log('\n全 ' + passed + ' 件の通しテストに合格しました');

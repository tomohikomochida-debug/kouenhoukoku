// 判定・計画部分（Logic）のテスト。実行：cp コード.gs /tmp/code.js && node test_logic.js /tmp/code.js
const assert = require('assert');
const path = process.argv[2] || './code.js';
const { Logic } = require(require('path').resolve(path));

let passed = 0;
function test(name, fn) { fn(); passed++; console.log('OK  ' + name); }
function throws(fn, re) { assert.throws(fn, e => re.test(e.message), 'expected error ' + re); }

// ---- 基本 ----
test('登録番号（樹木医番号）を4桁にそろえる', () => {
  assert.strictEqual(Logic.normId('6', 4), '0006');
  assert.strictEqual(Logic.normId('１２３', 4), '0123');
  assert.strictEqual(Logic.normId(' 0006 ', 4), '0006');
  assert.strictEqual(Logic.normId(6, 4), '0006');
  assert.strictEqual(Logic.normId('0006', 4), '0006');
  assert.strictEqual(Logic.normId('3456', 4), '3456');
  assert.strictEqual(Logic.normId('12345', 4), null);
  assert.strictEqual(Logic.normId('0', 4), null);
  assert.strictEqual(Logic.normId('A12', 4), null);
});
test('日付の読み取り', () => {
  assert.strictEqual(Logic.normDate('2026/7/1'), '2026-07-01');
  assert.strictEqual(Logic.normDate('2026年7月1日'), '2026-07-01');
  assert.strictEqual(Logic.normDate(''), '');
  assert.strictEqual(Logic.normDate('2026-02-30'), null);
});
test('会費の年度（4月始まり）', () => {
  assert.strictEqual(Logic.fiscalYear('2027-03-31', 4), 2026);
  assert.strictEqual(Logic.fiscalYear('2027-04-01', 4), 2027);
});
test('金額表示', () => { assert.strictEqual(Logic.yen(18000), '18,000円'); assert.strictEqual(Logic.yen(-12000), '-12,000円'); });

// ---- 試験用データ ----
const today = '2026-10-02';
function ctxOf(memberRows, feeRows, transfers) {
  const mem = Logic.parseMembers(memberRows.map((m, i) => Object.assign({ row: i + 2 }, m)), 4);
  const st = Logic.parseSettings([
    { row: 2, year: 2026, main: 12000, branch: 5000, district: 1000, due: '2026-07-31' },
    { row: 3, year: 2027, main: 12000, branch: 5000, district: 1000, due: '2027-07-31' },
  ]);
  const fees = Logic.parseFees(feeRows.map((f, i) => Object.assign({ row: i + 2, paid: 0, paidDate: '', note: '', due: f.year + '-07-31' }, f)), new Set(mem.byId.keys()), today, 4);
  return { today, digits: 4, startMonth: 4, members: mem.list, membersById: mem.byId, memberErrors: mem.errors, settings: st.map, settingErrors: st.errors, fees, transfers: transfers || [] };
}
const M = [
  { id: '0001', name: '架空 桜子', kana: 'カクウ サクラコ', cohort: '21期', membership: '在籍', emails: 'a@example.invalid' },
  { id: '0002', name: '架空 欅一', kana: 'カクウ ケヤキイチ', cohort: '21期', membership: '在籍', emails: '' },
  { id: '0005', name: '架空 杉子', kana: 'カクウ スギコ', cohort: '34期', membership: '退会', emails: '' },
  { id: '0006', name: '架空 楓', kana: 'カクウ カエデ', cohort: '30期', membership: '休会', emails: '' },
  { id: '0007', name: '架空 椿', kana: 'カクウ ツバキ', cohort: '32期', membership: '転出', emails: '' },
];

test('設定：会費額は内訳の合計', () => {
  const c = ctxOf(M, []);
  assert.strictEqual(c.settings[2026].total, 18000);
});

test('会費台帳の検査', () => {
  const c = ctxOf(M, [
    { id: '1', year: 2026, amount: 18000, status: '納入済み', paid: 18000, paidDate: '2026-07-01' },
    { id: '0002', year: 2026, amount: 18000, status: '納入済み', paid: 5000, paidDate: '2026-07-01' },
    { id: '0002', year: 2026, amount: 18000, status: '未納' },
    { id: '0009', year: 2026, amount: 18000, status: '未納' },
    { id: '0005', year: 2026, amount: 0, status: '他支部納入済み', note: '' },
    { id: '0006', year: 2026, amount: 18000, status: '確認中', paid: 5000, paidDate: '2026-12-01' },
  ]);
  const f = c.fees;
  assert.ok(f[0].ok, '1 は 0001 として読める');
  assert.ok(f[1].errors.some(e => e.includes('同額')));
  assert.ok(f[1].errors.some(e => e.includes('重複')) && f[2].errors.some(e => e.includes('重複')));
  assert.ok(f[3].errors.some(e => e.includes('正本にない')));
  assert.ok(f[4].errors.some(e => e.includes('他支部納入済み')));
  assert.ok(f[5].errors.some(e => e.includes('未来')));
});

test('新入会：今年度の会費と、既にある後の年度の会費を作る', () => {
  const c = ctxOf(M, [{ id: '0001', year: 2027, amount: 18000, status: '未納' }]);
  const p = Logic.planMembership({ action: '新入会', date: '2026-10-01', id: '10', name: '新 太郎', kana: 'シン タロウ', cohort: '36期', reason: '入会届受領', due: '2026-10-31' }, c);
  assert.strictEqual(p.id, '0010');
  assert.deepStrictEqual(p.feeAdds.map(f => [f.year, f.amount, f.status, f.due]), [[2026, 18000, '未納', '2026-10-31'], [2027, 18000, '未納', '2027-07-31']]);
  assert.ok(p.warnings.some(w => w.includes('郵送')));
  assert.ok(Logic.membershipPreview(p).includes('18,000円'));
});
test('新入会：標準納期限を過ぎていて個別納期限がないと止める', () => {
  const c = ctxOf(M, []);
  throws(() => Logic.planMembership({ action: '新入会', date: '2026-10-01', id: '10', name: '新 太郎', kana: 'シン タロウ', cohort: '36期', reason: 'x' }, c), /個別納期限/);
});
test('新入会：既にある番号は止める・同姓同名は警告', () => {
  const c = ctxOf(M, []);
  throws(() => Logic.planMembership({ action: '新入会', date: '2026-10-01', id: '0001', name: 'x', kana: 'x', cohort: 'x', reason: 'x' }, c), /既に正本/);
  const p = Logic.planMembership({ action: '新入会', date: '2026-07-01', id: '11', name: '架空　桜子', kana: 'ベツ', cohort: '36期', reason: 'x' }, c);
  assert.ok(p.warnings.some(w => w.includes('同じ氏名')));
});
test('未来の異動日は止める', () => {
  const c = ctxOf(M, []);
  throws(() => Logic.planMembership({ action: '退会', date: '2026-10-03', id: '1', reason: 'x' }, c), /今日以前/);
});
test('転入：本人申告で元支部納入済みなら請求0の他支部納入済み（備考に確認不可と記録）', () => {
  const c = ctxOf(M, []);
  const p = Logic.planMembership({ action: '転入', date: '2026-09-01', id: '20', name: '転 花子', kana: 'テン ハナコ', cohort: '30期', branch: '東京都支部', payment: '本人申告：元支部で納入済み', reason: '転入届', due: '' }, c);
  assert.deepStrictEqual(p.feeAdds.map(f => [f.year, f.amount, f.status]), [[2026, 0, '他支部納入済み']]);
  assert.ok(p.feeAdds[0].note.includes('確認不可'));
  // 作られた行が台帳の検査に通ること
  const fees = Logic.parseFees([Object.assign({ row: 2 }, p.feeAdds[0])], new Set(['20'.padStart(4, '0')]), today, 4);
  assert.ok(fees[0].ok, fees[0].errors.join());
});
test('転入：申告なし（空欄）なら当支部で満額請求', () => {
  const c = ctxOf(M, []);
  const p = Logic.planMembership({ action: '転入', date: '2026-07-01', id: '21', name: '転 次郎', kana: 'テン ジロウ', cohort: '30期', branch: '東京都支部', payment: '', reason: '転入届' }, c);
  assert.deepStrictEqual(p.feeAdds.map(f => [f.amount, f.status]), [[18000, '未納']]);
  throws(() => Logic.planMembership({ action: '転入', date: '2026-07-01', id: '22', name: 'x', kana: 'x', cohort: 'x', branch: 'x', payment: '確認中', reason: 'x' }, c), /本人申告/);
});
test('退会：異動日より後の年度の未納は対象外、当年度は残して警告', () => {
  const c = ctxOf(M, [
    { id: '0001', year: 2026, amount: 18000, status: '未納' },
    { id: '0001', year: 2027, amount: 18000, status: '未納' },
  ]);
  const p = Logic.planMembership({ action: '退会', date: '2026-10-01', id: '1', reason: '退会届' }, c);
  assert.strictEqual(p.after.membership, '退会');
  assert.deepStrictEqual(p.feeUpdates.map(u => [u.year, u.from.status, u.to.status]), [[2027, '未納', '対象外']]);
  assert.ok(p.warnings.some(w => w.includes('2026年度')));
});
test('再入会：退会者のみ。対象外になった行は未納に戻す', () => {
  const c = ctxOf(M, [{ id: '0005', year: 2027, amount: 18000, status: '対象外', note: '退会により対象外' }]);
  const p = Logic.planMembership({ action: '再入会', date: '2026-10-01', id: '5', reason: '再入会届', due: '2026-10-31' }, c);
  assert.strictEqual(p.after.membership, '在籍');
  assert.deepStrictEqual(p.feeAdds.map(f => f.year), [2026]);
  assert.deepStrictEqual(p.feeUpdates.map(u => [u.year, u.to.status]), [[2027, '未納']]);
  throws(() => Logic.planMembership({ action: '再入会', date: '2026-10-01', id: '1', reason: 'x' }, c), /退会/);
});
test('転出：転出先が必要。在籍以外は不可', () => {
  const c = ctxOf(M, []);
  throws(() => Logic.planMembership({ action: '転出', date: '2026-10-01', id: '1', reason: 'x' }, c), /関係支部/);
  throws(() => Logic.planMembership({ action: '転出', date: '2026-10-01', id: '7', branch: 'x', reason: 'x' }, c), /在籍・休会/);
});
test('休会・復会は会費を変えない', () => {
  const c = ctxOf(M, []);
  const p = Logic.planMembership({ action: '休会', date: '2026-10-01', id: '2', reason: 'x' }, c);
  assert.strictEqual(p.after.membership, '休会');
  assert.strictEqual(p.feeAdds.length + p.feeUpdates.length, 0);
  const q = Logic.planMembership({ action: '復会', date: '2026-10-01', id: '6', reason: 'x' }, c);
  assert.ok(q.warnings.some(w => w.includes('会費行がありません')));
});
test('台帳にエラーのある行を変えようとすると止める', () => {
  const c = ctxOf(M, [{ id: '0001', year: 2027, amount: 18000, status: '未納' }, { id: '0001', year: 2027, amount: 18000, status: '未納' }]);
  throws(() => Logic.planMembership({ action: '退会', date: '2026-10-01', id: '1', reason: 'x' }, c), /エラー/);
});
test('同じ入力からは同じ確認キー', () => {
  const c = ctxOf(M, []);
  const v = { action: '休会', date: '2026-10-01', id: '2', reason: 'x' };
  assert.strictEqual(Logic.hash(JSON.stringify(Logic.planMembership(v, c))), Logic.hash(JSON.stringify(Logic.planMembership(v, c))));
  assert.notStrictEqual(Logic.hash(JSON.stringify(Logic.planMembership(v, c))), Logic.hash(JSON.stringify(Logic.planMembership(Object.assign({}, v, { reason: 'y' }), c))));
});

// ---- 年度追加 ----
test('年度追加：在籍者で行のない人だけ、会費額で追加', () => {
  const c = ctxOf(M, [{ id: '0001', year: 2027, amount: 5000, status: '未納' }]);
  const p = Logic.planNewYear(2027, c);
  assert.deepStrictEqual(p.adds.map(a => [a.id, a.amount, a.due]), [['0002', 18000, '2027-07-31']]);
  assert.strictEqual(p.mismatched, 1);
  assert.ok(Logic.newYearPreview(p).includes('違う請求金額'));
  throws(() => Logic.planNewYear(2030, c), /年度設定/);
});

// ---- 送金 ----
test('送金：参考額と取消', () => {
  const fees = [
    { id: '0001', year: 2026, amount: 18000, status: '納入済み', paid: 18000, paidDate: '2026-07-01' },
    { id: '0002', year: 2026, amount: 18000, status: '納入済み', paid: 18000, paidDate: '2026-07-01' },
    { id: '0005', year: 2026, amount: 0, status: '他支部納入済み', note: '東京' },
  ];
  const transfers = [{ id: 'T1', kind: '送金', year: 2026, recipient: '本会', count: 1, amount: 12000, date: '2026-09-01', note: '', cancelOf: '' }];
  const c = ctxOf(M, fees, transfers);
  const p = Logic.planTransfer({ year: '2026', recipient: '本会', count: '1', amount: '12000', date: '2026-09-20', note: '' }, c);
  assert.deepStrictEqual(p.reference, { paid: 2, expected: 24000, sent: 12000, after: 24000 });
  throws(() => Logic.planTransfer({ year: '2026', recipient: '本会', count: '1', amount: '12000', date: '2026-10-03', note: '' }, c), /今日以前/);
  const q = Logic.planTransfer({ cancelId: 'T1', note: '金額誤り' }, c);
  assert.strictEqual(q.amount, -12000);
  const c2 = ctxOf(M, fees, transfers.concat([{ id: 'T2', kind: '取消', cancelOf: 'T1', year: 2026, recipient: '本会', count: -1, amount: -12000 }]));
  throws(() => Logic.planTransfer({ cancelId: 'T1', note: 'x' }, c2), /既に取り消/);
  Logic.setRemitDeadline('09-30');
  const s = Logic.transferSummary(c.fees, c.settings, c.transfers, today);
  const honkai2026 = s.rows.find(r => r[0] === 2026 && r[1] === '本会');
  assert.deepStrictEqual(honkai2026.slice(2, 9), [2, 12000, 24000, 12000, 12000, '2026-09-30', '期限を過ぎて未送金あり']);
});

// ---- 集計 ----
test('会計一覧と年度別集計', () => {
  const c = ctxOf(M, [
    { id: '0001', year: 2026, amount: 18000, status: '納入済み', paid: 18000, paidDate: '2026-07-01' },
    { id: '0002', year: 2026, amount: 18000, status: '確認中', paid: 5000, paidDate: '2026-07-01' },
    { id: '0002', year: 2027, amount: 18000, status: '未納' },
  ]);
  const m = Logic.matrix(c.members, c.fees);
  assert.deepStrictEqual(m.header, ['登録番号', '氏名', '登録期', '在籍状況', '2027年度', '2026年度']);
  assert.deepStrictEqual(m.rows[0], ['0001', '架空 桜子', '21期', '在籍', '—', '納入済み']);
  const t = Logic.yearTotals(c.fees);
  const y26 = t.rows.find(r => r[0] === 2026);
  assert.deepStrictEqual(y26.slice(9), [36000, 23000, 13000]);
});

console.log('\n全 ' + passed + ' 件のテストに合格しました');

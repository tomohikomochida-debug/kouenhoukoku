/**
 * 日本樹木医会 神奈川県支部 支部管理システム v2
 * 第1段階：総務（正本・会員の異動）＋ 会計（会費台帳・年度追加・送金記録）
 *
 * 【はじめての設定】
 *  1. 新しい Apps Script プロジェクトの「コード.gs」に、このファイルの内容を全部貼り付けて保存する。
 *  2. 上の関数の選択欄で「初期設定」を選んで「実行」。初回だけ権限の確認が出るので許可する。
 *  3. 試験するときは「架空データを入れる」を実行する（正本が空のときだけ動きます）。
 *
 * 【ふだんの使い方】
 *  - 会員の異動：総務ブックの「異動受付」に1行入力し、「実行」にチェック → 確認内容が出る
 *    → もう一度「実行」にチェックすると保存。
 *  - 会費：会計ブックの「会費台帳_2026」など年度ごとのシートに直接入力（入力ルールと自動チェックあり）。
 *  - 年度追加：会計ブックの「年度設定」の「年度追加」にチェック（2回チェックで実行）。その年度のシートができます。
 *  - 送金記録：会計ブックの「送金入力」に1行入力し、「実行」にチェック（2回チェックで保存）。
 *  - 一覧・集計は10分以内に自動更新。すぐ更新したいときは「今すぐ一覧を更新」を実行。
 *
 * このプロジェクトはウェブアプリとして公開しないでください。
 */

const APP = {
  version: 'v2-第1段階-20261002',
  books: {
    soumu: '1EpwGgak2yF5cEbu4YDUKmjwqaKj5-3690rOcnJu-oXs',   // 総務_正本_v2
    kaikei: '1CQv396GIBXz1M4xBi8pHE3J97iKJtsOeBey9n2-roUc',  // 会計_会費台帳_v2
  },
  tz: 'Asia/Tokyo',
  fiscalStartMonth: 4,  // 会費の年度は4月始まり
  idDigits: 4,          // 登録番号（＝樹木医番号）の桁数
  pref: { code: '14', name: '神奈川県' },
  remitDeadline: '09-30', // 本会への納入期限（取扱要領 第4条）
};

/* ======================================================================
 * 判定・計画（Google のサービスを使わない部分。Node でテスト可能）
 * ====================================================================== */
const Logic = (() => {
  const FEE_STATUSES = ['未納', '納入済み', '確認中', '免除', '他支部納入済み', '対象外'];
  const MEMBER_STATUSES = ['在籍', '休会', '退会', '転出'];
  const ACTIONS = ['新入会', '再入会', '転入', '転出', '退会', '休会', '復会'];
  // 他支部での納入は当支部では確認できないため、本人の申告だけを記録する
  const PAYMENTS = ['申告なし（当支部で請求）', '本人申告：元支部で納入済み'];
  const RECIPIENTS = ['本会', '関東甲信地区協議会'];

  function fail(msg) { throw new Error(msg); }
  function check(ok, msg) { if (!ok) fail(msg); }

  function text(v) { return String(v === null || v === undefined ? '' : v).trim(); }

  function normId(v, digits) {
    const s = text(v).normalize('NFKC').replace(/\s/g, '');
    if (!/^\d+$/.test(s) || /^0+$/.test(s)) return null;
    const t = s.replace(/^0+/, '');
    if (t.length > digits) return null;
    return t.padStart(digits, '0');
  }

  function isDate(s) {
    return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) &&
      !isNaN(Date.parse(s + 'T00:00:00Z')) &&
      new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
  }

  // '' = 空欄、null = 日付として読めない
  function normDate(v) {
    const s = text(v).normalize('NFKC');
    if (!s) return '';
    const m = s.match(/^(\d{4})[-\/.年](\d{1,2})[-\/.月](\d{1,2})日?$/);
    if (!m) return null;
    const d = m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
    return isDate(d) ? d : null;
  }

  function toInt(v) {
    if (typeof v === 'number') return Number.isSafeInteger(v) ? v : NaN;
    const s = text(v).normalize('NFKC').replace(/[,円\s]/g, '');
    if (!s) return NaN;
    return /^-?\d+$/.test(s) ? Number(s) : NaN;
  }

  function fiscalYear(dateStr, startMonth) {
    const y = Number(dateStr.slice(0, 4)), m = Number(dateStr.slice(5, 7));
    return m >= startMonth ? y : y - 1;
  }

  function nameKey(s) { return text(s).normalize('NFKC').replace(/\s/g, '').toLowerCase(); }

  function yen(n) { return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',') + '円'; }

  function normEmails(v) {
    const s = text(v).normalize('NFKC');
    if (!s) return '';
    const list = s.split(/[,、;\s]+/).map(x => x.trim().toLowerCase()).filter(Boolean);
    list.forEach(x => check(/^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(x), '会費案内先のメールアドレスを確認してください：' + x));
    return [...new Set(list)].join(',');
  }

  function hash(str) {
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 16777619) >>> 0;
      h2 = Math.imul(h2 ^ c, 2246822519) >>> 0;
    }
    return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
  }

  /* ---------- 読み込みデータの整形と検査 ---------- */

  function parseMembers(rows, digits) {
    const list = [], errors = [], byId = new Map();
    rows.forEach(r => {
      const id = normId(r.id, digits);
      if (!id) { errors.push('正本 ' + r.row + '行目：登録番号「' + text(r.id) + '」を確認してください'); return; }
      const m = {
        row: r.row, id, name: text(r.name), kana: text(r.kana), cohort: text(r.cohort),
        membership: text(r.membership), emails: text(r.emails),
      };
      if (!m.name) errors.push('正本 ' + r.row + '行目：氏名が空欄です');
      if (!MEMBER_STATUSES.includes(m.membership)) errors.push('正本 ' + r.row + '行目：在籍状況「' + m.membership + '」を確認してください（' + MEMBER_STATUSES.join('・') + '）');
      if (byId.has(id)) { errors.push('正本：登録番号 ' + id + ' が重複しています（' + byId.get(id).row + '行目と' + r.row + '行目）'); return; }
      byId.set(id, m); list.push(m);
    });
    return { list, byId, errors };
  }

  function parseSettings(rows) {
    const map = {}, errors = [];
    rows.forEach(r => {
      const year = toInt(r.year);
      const parts = [r.main, r.branch, r.district].map(toInt);
      const due = normDate(r.due);
      const where = '年度設定 ' + r.row + '行目：';
      if (!(year >= 2000 && year <= 2099)) { errors.push(where + '年度を4桁で入力してください'); return; }
      if (map[year]) { errors.push(where + year + '年度が重複しています'); return; }
      if (parts.some(n => !(n >= 0))) { errors.push(where + '本会分・支部分・地区協議会分は0以上の整数で入力してください'); return; }
      if (!due) { errors.push(where + '標準納期限を日付で入力してください'); return; }
      map[year] = {
        row: r.row, year, main: parts[0], branch: parts[1], district: parts[2],
        total: parts[0] + parts[1] + parts[2], due,
        bank: text(r.bank), payer: text(r.payer), contact: text(r.contact),
      };
    });
    return { map, errors };
  }

  function parseFees(rows, memberIds, today, digits) {
    const fees = [], seen = new Map();
    rows.forEach(r => {
      const paidRaw = text(r.paid);
      const f = {
        row: r.row, sheet: text(r.sheet) || '会費台帳', idRaw: text(r.id), id: normId(r.id, digits), year: toInt(r.year),
        amount: toInt(r.amount), due: normDate(r.due), status: text(r.status),
        paidDate: normDate(r.paidDate), paid: paidRaw === '' ? 0 : toInt(paidRaw), note: text(r.note),
      };
      const e = [];
      if (!f.id) e.push('登録番号を確認');
      else if (!memberIds.has(f.id)) e.push('正本にない登録番号');
      if (!(f.year >= 2000 && f.year <= 2099)) e.push('年度を確認');
      if (!(f.amount >= 0)) e.push('請求金額は0以上の整数');
      if (!(f.paid >= 0)) e.push('入金額は0以上の整数');
      if (!f.due) e.push('納期限を日付で');
      if (f.paidDate === null) e.push('入金日を日付で');
      else if (f.paidDate && f.paidDate > today) e.push('入金日が未来の日付');
      if (!FEE_STATUSES.includes(f.status)) e.push('納入状況を選択');
      if (f.status === '納入済み' && (!f.paidDate || f.paid !== f.amount)) e.push('納入済みには入金日と、請求金額と同額の入金額が必要（一部入金などは「確認中」）');
      if (f.status === '他支部納入済み' && (f.amount !== 0 || f.paid !== 0 || f.paidDate || !f.note)) e.push('他支部納入済みは請求0円・入金0円・入金日空欄・会計備考に支部名と根拠（本人申告など）');
      if (f.id && f.year >= 2000) {
        const key = f.id + ':' + f.year;
        if (seen.has(key)) {
          e.push('同じ会員・年度の行が重複（' + seen.get(key).row + '行目）');
          const o = seen.get(key);
          if (!o.errors.some(x => x.startsWith('同じ会員・年度'))) o.errors.push('同じ会員・年度の行が重複（' + f.row + '行目）');
        } else seen.set(key, f);
      }
      f.errors = e;
      fees.push(f);
    });
    fees.forEach(f => { f.ok = f.errors.length === 0; });
    return fees;
  }

  function parseTransfers(rows) {
    return rows.map(r => ({
      row: r.row, id: text(r.id), kind: text(r.kind), year: toInt(r.year), recipient: text(r.recipient),
      count: toInt(r.count), amount: toInt(r.amount), date: normDate(r.date), note: text(r.note), cancelOf: text(r.cancelOf),
    }));
  }

  function snapFee(f) {
    return { status: f.status, amount: f.amount, due: f.due, paidDate: f.paidDate || '', paid: f.paid, note: f.note };
  }

  /* ---------- 会員の異動 ---------- */

  function planMembership(v, ctx) {
    const today = ctx.today, digits = ctx.digits;
    const action = text(v.action);
    check(ACTIONS.includes(action), '「手続き」を選んでください（' + ACTIONS.join('・') + '）');
    const date = normDate(v.date);
    check(date, '「異動日」を 2026-10-02 の形で入力してください');
    check(date <= today, '異動日は今日以前の日付にしてください（未来の予約はできません）');
    const id = normId(v.id, digits);
    check(id, '「登録番号」（樹木医番号）は数字で入力してください（' + digits + '桁まで。先頭の0は自動で補います）');
    const reason = text(v.reason);
    check(reason, '「確認内容・理由」を入力してください');
    check(reason.length <= 1000, '確認内容・理由は1000文字以内にしてください');

    const old = ctx.membersById.get(id) || null;
    const before = old ? { id: old.id, name: old.name, kana: old.kana, cohort: old.cohort, membership: old.membership, emails: old.emails } : null;
    const warnings = [];
    let branch = '', payment = '';
    const req = (x, label) => { const s = text(x); check(s, '「' + label + '」を入力してください'); check(s.length <= 100, label + 'は100文字以内にしてください'); return s; };

    switch (action) {
      case '新入会':
        check(!old, '登録番号 ' + id + ' は既に正本にあります（' + (old && old.name) + '／' + (old && old.membership) + '）。再入会・転入・復会のどれかを選んでください');
        break;
      case '再入会':
        check(old && old.membership === '退会', '再入会は、正本で「退会」になっている方だけです');
        break;
      case '転入':
        check(!old || old.membership === '転出', '正本に既にある方の転入は、「転出」になっている方だけです');
        branch = req(v.branch, '関係支部（転入元）');
        payment = text(v.payment) || PAYMENTS[0];
        check(PAYMENTS.includes(payment), '「元支部での納入（本人申告）」を選んでください（' + PAYMENTS.join('・') + '）');
        break;
      case '転出':
        check(old && ['在籍', '休会'].includes(old.membership), '転出は、正本で在籍・休会の方だけです');
        branch = req(v.branch, '関係支部（転出先）');
        break;
      case '退会':
        check(old && old.membership !== '退会', '退会は、正本にあり、まだ退会していない方だけです');
        break;
      case '休会':
        check(old && old.membership === '在籍', '休会は、正本で在籍の方だけです');
        break;
      case '復会':
        check(old && old.membership === '休会', '復会は、正本で休会の方だけです');
        break;
    }

    let after;
    if (!old) {
      const name = req(v.name, '氏名'), kana = req(v.kana, 'よみがな');
      let cohort = req(v.cohort, '登録期').normalize('NFKC');
      if (/^\d+$/.test(cohort)) cohort += '期'; // 「51」→「51期」
      after = { id, name, kana, cohort, membership: '在籍', emails: normEmails(v.emails) };
      const dup = ctx.members.filter(m => nameKey(m.name) === nameKey(name) || nameKey(m.kana) === nameKey(kana));
      if (dup.length) warnings.push('同じ氏名またはよみがなの会員がいます（' + dup.map(m => m.id + ' ' + m.name + '／' + m.membership).join('、') + '）。同じ方なら登録番号を確認してください');
      if (!after.emails) warnings.push('会費案内先のメールアドレスがありません（郵送での案内が必要です）');
    } else {
      const next = { '再入会': '在籍', '転入': '在籍', '転出': '転出', '退会': '退会', '休会': '休会', '復会': '在籍' }[action];
      after = Object.assign({}, before, { membership: next });
      if (text(v.name) || text(v.kana) || text(v.cohort) || text(v.emails)) warnings.push('正本に既にある方なので、入力された氏名・よみがな・登録期・会費案内先は使いません（正本の内容を保持します）');
    }

    const feeAdds = [], feeUpdates = [];
    const myFees = ctx.fees.filter(f => f.id === id);
    let targetYear = null;

    if (['新入会', '再入会', '転入'].includes(action)) {
      targetYear = text(v.year) ? toInt(v.year) : fiscalYear(date, ctx.startMonth);
      check(targetYear >= 2000 && targetYear <= 2099, '「対象年度」を4桁で入力してください（空欄なら異動日の年度）');
      const s = ctx.settings[targetYear];
      check(s, targetYear + '年度の年度設定がありません。会計ブックの「年度設定」に先に入力してください');
      let status = '未納', amount = s.total;
      let note = date + ' ' + action + '：' + reason;
      if (action === '転入') {
        note += '／転入元：' + branch;
        if (payment === PAYMENTS[1]) { status = '他支部納入済み'; amount = 0; note += '／本人申告により元支部で納入済み（当支部では確認不可）'; }
      }
      let due = s.due;
      if (text(v.due)) { due = normDate(v.due); check(due, '「個別納期限」を日付で入力してください'); }
      if (status !== '他支部納入済み' && due < date) fail(targetYear + '年度の納期限（' + due + '）が異動日より前です。「個別納期限」に異動日以降の日付を入れてください');

      const planFor = (year, target) => {
        const ex = myFees.filter(f => f.year === year);
        check(ex.length <= 1, '会費台帳に ' + id + ' の ' + year + '年度が重複しています。会計で先に直してください');
        if (!ex.length) { feeAdds.push(Object.assign({ id, year }, target, { paidDate: '', paid: 0 })); return; }
        const f = ex[0];
        check(f.ok, f.sheet + ' ' + f.row + '行目（' + id + '）にエラーがあります。会計で先に直してください');
        if (f.status === '対象外') feeUpdates.push({ id, year, from: snapFee(f), to: Object.assign({}, target, { paidDate: '', paid: 0 }) });
        else warnings.push(year + '年度の会費記録が既にあるため変更しません（' + f.status + '）');
      };
      planFor(targetYear, { status, amount, due, note });
      const laterYears = [...new Set(ctx.fees.map(f => f.year))].filter(y => y > targetYear).sort((a, b) => a - b);
      laterYears.forEach(y => {
        const sy = ctx.settings[y];
        check(sy, y + '年度の会費行が台帳にあるのに、年度設定がありません。会計で年度設定を入力してください');
        planFor(y, { status: '未納', amount: sy.total, due: sy.due, note: date + ' ' + action + '（' + targetYear + '年度より後の年度分）' });
      });
    }

    if (['転出', '退会'].includes(action)) {
      const fy = fiscalYear(date, ctx.startMonth);
      myFees.filter(f => f.year > fy).forEach(f => {
        if (f.status === '未納') {
          check(f.ok, f.sheet + ' ' + f.row + '行目にエラーがあります。会計で先に直してください');
          feeUpdates.push({ id, year: f.year, from: snapFee(f), to: Object.assign(snapFee(f), { status: '対象外', note: (f.note ? f.note + '／' : '') + date + ' ' + action + 'により対象外' }) });
        } else if (f.status !== '対象外') {
          warnings.push(f.year + '年度は「' + f.status + '」のため変更しません。返金などは会計で確認してください');
        }
      });
      const cur = myFees.find(f => f.year === fy);
      if (cur && ['未納', '確認中'].includes(cur.status)) warnings.push(fy + '年度（異動した年度）は「' + cur.status + '」のまま残します。請求を続けるか、免除・対象外にするかは会計で判断してください');
    }

    if (['休会', '復会'].includes(action)) {
      warnings.push('会費の記録は自動では変えません。必要なら会計で調整してください');
      if (action === '復会') {
        const fy = fiscalYear(date, ctx.startMonth);
        if (!myFees.some(f => f.year === fy)) warnings.push(fy + '年度の会費行がありません。請求する場合は会計で「会費台帳_' + fy + '」に行を追加してください');
      }
    }

    return { action, date, id, reason, branch, payment, targetYear, before, after, feeAdds, feeUpdates, warnings, today };
  }

  function membershipPreview(p) {
    const lines = [];
    lines.push('【' + p.action + '】' + p.id + ' ' + p.after.name + '（' + (p.after.cohort || '登録期なし') + '）／異動日 ' + p.date);
    lines.push('在籍状況：' + (p.before ? p.before.membership : '未登録') + ' → ' + p.after.membership);
    if (p.branch) lines.push('関係支部：' + p.branch);
    if (p.payment) lines.push('元支部での納入（本人申告）：' + p.payment);
    p.feeAdds.forEach(f => lines.push('会費を追加：' + f.year + '年度 ' + f.status + '／請求 ' + yen(f.amount) + '／納期限 ' + f.due));
    p.feeUpdates.forEach(u => lines.push('会費を変更：' + u.year + '年度 ' + u.from.status + ' → ' + u.to.status + (u.to.amount !== u.from.amount ? '／請求 ' + yen(u.to.amount) : '')));
    if (!p.feeAdds.length && !p.feeUpdates.length) lines.push('会費：変更なし');
    p.warnings.forEach(w => lines.push('※ ' + w));
    lines.push('→ この内容でよければ、もう一度「実行」にチェックしてください');
    return lines.join('\n');
  }

  /* ---------- 年度追加 ---------- */

  function planNewYear(year, ctx) {
    const s = ctx.settings[year];
    check(s, year + '年度の年度設定が正しく入力されていません');
    const have = new Set(ctx.fees.filter(f => f.year === year).map(f => f.id));
    const adds = ctx.members.filter(m => m.membership === '在籍' && !have.has(m.id))
      .map(m => ({ id: m.id, year, status: '未納', amount: s.total, due: s.due, paidDate: '', paid: 0, note: '' }));
    const mismatched = ctx.fees.filter(f => f.year === year && !['他支部納入済み', '対象外', '免除'].includes(f.status) && f.amount !== s.total).length;
    return { year, total: s.total, main: s.main, branch: s.branch, district: s.district, due: s.due, adds, existing: have.size, mismatched, today: ctx.today };
  }

  function newYearPreview(p) {
    const lines = [];
    lines.push(p.year + '年度の会費行を追加します：在籍 ' + p.adds.length + '名 × ' + yen(p.total) + '（本会' + yen(p.main) + '・支部' + yen(p.branch) + '・地区協議会' + yen(p.district) + '）／納期限 ' + p.due);
    if (p.existing) lines.push('既にこの年度の行がある ' + p.existing + '名には追加しません');
    if (p.mismatched) lines.push('※ この年度の既存の行に、会費額と違う請求金額の行が ' + p.mismatched + '件あります（変更しません）');
    if (!p.adds.length) lines.push('追加する人はいません');
    else lines.push('→ この内容でよければ、もう一度「年度追加」にチェックしてください');
    return lines.join('\n');
  }

  /* ---------- 送金記録 ---------- */

  function paidCount(fees, year) {
    return fees.filter(f => f.ok && f.year === year && f.status === '納入済み').length;
  }

  function sentTotal(transfers, year, recipient) {
    return transfers.filter(t => t.year === year && t.recipient === recipient)
      .reduce((a, t) => ({ count: a.count + (t.count || 0), amount: a.amount + (t.amount || 0) }), { count: 0, amount: 0 });
  }

  function perHead(s, recipient) { return recipient === '本会' ? s.main : s.district; }

  function planTransfer(v, ctx) {
    const today = ctx.today;
    const cancelId = text(v.cancelId);
    let rec;
    if (cancelId) {
      const orig = ctx.transfers.find(t => t.id === cancelId);
      check(orig && orig.kind === '送金', '取消する記録ID「' + cancelId + '」が送金記録にありません');
      check(!ctx.transfers.some(t => t.kind === '取消' && t.cancelOf === cancelId), 'この記録は既に取り消されています');
      const note = text(v.note);
      check(note, '取消の理由を「備考」に入力してください');
      rec = { kind: '取消', year: orig.year, recipient: orig.recipient, count: -orig.count, amount: -orig.amount, date: today, note, cancelOf: cancelId };
    } else {
      const year = toInt(v.year);
      check(ctx.settings[year], '「年度」は年度設定にある年度を入力してください');
      const recipient = text(v.recipient);
      check(RECIPIENTS.includes(recipient), '「送金先」を選んでください（' + RECIPIENTS.join('・') + '）');
      const count = toInt(v.count), amount = toInt(v.amount);
      check(count >= 1, '「対象人数」は1以上の整数で入力してください');
      check(amount >= 1, '「送金額」は1以上の整数で入力してください');
      const date = normDate(v.date);
      check(date, '「送金日」を日付で入力してください');
      check(date <= today, '送金日は実際に送金した日（今日以前）にしてください');
      const note = text(v.note);
      check(note.length <= 1000, '備考は1000文字以内にしてください');
      rec = { kind: '送金', year, recipient, count, amount, date, note, cancelOf: '' };
    }
    const s = ctx.settings[rec.year];
    const n = paidCount(ctx.fees, rec.year);
    const expected = s ? n * perHead(s, rec.recipient) : 0;
    const sent = sentTotal(ctx.transfers, rec.year, rec.recipient).amount;
    return Object.assign(rec, { reference: { paid: n, expected, sent, after: sent + rec.amount }, today });
  }

  function transferPreview(p) {
    const r = p.reference, lines = [];
    if (p.kind === '取消') lines.push('【取消】記録 ' + p.cancelOf + '（' + p.year + '年度 ' + p.recipient + ' ' + yen(-p.amount) + '）を取り消します');
    else lines.push('【送金済みの記録】' + p.year + '年度分 → ' + p.recipient + '／' + p.count + '名分 ' + yen(p.amount) + '／送金日 ' + p.date);
    lines.push('参考：台帳上の納入済み ' + r.paid + '名 → 送るべき額の目安 ' + yen(r.expected) + '／これまでの記録 ' + yen(r.sent) + '／この記録の後 ' + yen(r.after) + '（差 ' + yen(r.expected - r.after) + '）');
    lines.push('※ 参考額は台帳の「納入済み」の人数から計算した目安です。送金額は自動では決めません');
    lines.push('→ この内容でよければ、もう一度「実行」にチェックしてください');
    return lines.join('\n');
  }

  /* ---------- 一覧・集計 ---------- */

  function feeYears(fees) {
    return [...new Set(fees.filter(f => f.year >= 2000).map(f => f.year))].sort((a, b) => b - a);
  }

  function matrix(members, fees) {
    const years = feeYears(fees);
    const byId = new Map();
    fees.forEach(f => { if (f.id) { if (!byId.has(f.id)) byId.set(f.id, new Map()); byId.get(f.id).set(f.year, f); } });
    const rows = members.filter(m => m.membership === '在籍' || byId.has(m.id))
      .sort((a, b) => a.id.localeCompare(b.id))
      .map(m => [m.id, m.name, m.cohort, m.membership].concat(years.map(y => {
        const f = byId.get(m.id) && byId.get(m.id).get(y);
        if (!f) return '—';
        return f.ok ? f.status : f.status + '（要確認）';
      })));
    return { header: ['登録番号', '氏名', '登録期', '在籍状況'].concat(years.map(y => y + '年度')), rows };
  }

  function yearTotals(fees) {
    const years = feeYears(fees);
    const header = ['年度', '行数', '未納', '納入済み', '確認中', '免除', '他支部納入済み', '対象外', '要確認の行', '請求額の合計', '入金額の合計', '未収額（未納・確認中）'];
    const rows = years.map(y => {
      const list = fees.filter(f => f.year === y);
      const ok = list.filter(f => f.ok);
      const cnt = st => ok.filter(f => f.status === st).length;
      const billed = ok.filter(f => !['他支部納入済み', '対象外', '免除'].includes(f.status)).reduce((a, f) => a + f.amount, 0);
      const received = ok.reduce((a, f) => a + f.paid, 0);
      const open = ok.filter(f => ['未納', '確認中'].includes(f.status)).reduce((a, f) => a + Math.max(0, f.amount - f.paid), 0);
      return [y, list.length, cnt('未納'), cnt('納入済み'), cnt('確認中'), cnt('免除'), cnt('他支部納入済み'), cnt('対象外'), list.length - ok.length, billed, received, open];
    });
    return { header, rows };
  }

  function transferSummary(fees, settings, transfers, today) {
    const years = [...new Set(Object.keys(settings).map(Number).concat(feeYears(fees)))].sort((a, b) => b - a);
    const header = ['年度', '送金先', '納入済み人数', '1人あたり', '送るべき額（目安）', '送金済み額', '差額', '期限', '状況'];
    const rows = [];
    years.forEach(y => {
      const s = settings[y];
      RECIPIENTS.forEach(rc => {
        const n = paidCount(fees, y);
        const per = s ? perHead(s, rc) : '';
        const expected = s ? n * per : '';
        const sent = sentTotal(transfers, y, rc).amount;
        const deadline = rc === '本会' ? y + '-' + APP_REMIT_DEADLINE : '';
        let state = '年度設定なし';
        if (s) {
          const diff = expected - sent;
          if (diff > 0) state = deadline && today > deadline ? '期限を過ぎて未送金あり' : '未送金あり';
          else if (diff < 0) state = '送金額が目安を超えています（確認）';
          else state = n ? '一致' : '—';
        }
        rows.push([y, rc, n, per, expected, sent, s ? expected - sent : '', deadline, state]);
      });
    });
    return { header, rows };
  }

  let APP_REMIT_DEADLINE = '09-30';
  function setRemitDeadline(md) { APP_REMIT_DEADLINE = md; }

  return {
    FEE_STATUSES, MEMBER_STATUSES, ACTIONS, PAYMENTS, RECIPIENTS,
    text, normId, normDate, isDate, toInt, fiscalYear, yen, normEmails, hash, nameKey,
    parseMembers, parseSettings, parseFees, parseTransfers, snapFee,
    planMembership, membershipPreview, planNewYear, newYearPreview, planTransfer, transferPreview,
    matrix, yearTotals, transferSummary, setRemitDeadline,
  };
})();
if (typeof module !== 'undefined') module.exports = { Logic, APP };

/* ======================================================================
 * シートの設計
 * ====================================================================== */
const ROSTER_HEADERS = ['都道府県番号', '都道府県名', '登録番号', '登録期', '氏名', 'よみがな', '自宅〒', '自宅住所', '自宅電話番号', '自宅ＦＡＸ番号', 'メール自宅', 'メール勤務先', '勤務先〒', '勤務先住所', '勤務先名', '勤務先電話番号', '勤務先ＦＡＸ番号', '郵送対象者', '（予備）', 'ＭＬ登録アドレス', 'ＭＬ登録アドレス2', '修正日', '備考', '在籍状況', '会費案内先'];
const ROSTER_REQUIRED = ['都道府県番号', '都道府県名', '登録番号', '登録期', '氏名', 'よみがな', '修正日', '備考', '在籍状況', '会費案内先'];
const MOVE_HEADERS = ['実行', '状態', '結果・確認内容', '手続き', '異動日', '登録番号', '氏名', 'よみがな', '登録期', '会費案内先', '関係支部', '元支部での納入（本人申告）', '対象年度', '個別納期限', '確認内容・理由', '受付ID', '確認キー', '処理日時'];
const MOVE_INPUTS = ['手続き', '異動日', '登録番号', '氏名', 'よみがな', '登録期', '会費案内先', '関係支部', '元支部での納入（本人申告）', '対象年度', '個別納期限', '確認内容・理由'];
const JOURNAL_HEADERS = ['受付ID', '処理状態', '受付日時', '異動日', '手続き', '登録番号', '氏名', '変更前', '変更後', '関係支部', '確認内容', '処理計画'];
// 会費台帳は年度ごとのシート（会費台帳_2026 など）。年度はシート名で表す
const LEDGER_HEADERS = ['登録番号', '氏名（自動）', '登録期（自動）', '在籍状況（自動）', '請求金額', '納期限', '納入状況', '入金日', '入金額', '会計備考', 'チェック（自動）', '最終更新（自動）'];
const LEDGER_INPUTS = ['登録番号', '請求金額', '納入状況'];
const OLD_LEDGER_HEADERS = ['登録番号', '年度', '請求金額', '納期限', '納入状況', '入金日', '入金額', '会計備考'];
const LEDGER_AUTO = ['氏名（自動）', '登録期（自動）', '在籍状況（自動）', 'チェック（自動）', '最終更新（自動）'];
const SETTINGS_HEADERS = ['年度', '本会分', '支部分', '地区協議会分', '会費額（自動）', '標準納期限', '振込先', '振込名義', '問い合わせ先', '年度追加', '状態', '結果・確認内容', '確認キー'];
const TRANSFER_IN_HEADERS = ['実行', '状態', '結果・確認内容', '年度', '送金先', '対象人数', '送金額', '送金日', '備考', '取消する記録ID', '確認キー', '記録ID'];
const TRANSFER_IN_INPUTS = ['年度', '送金先', '対象人数', '送金額', '送金日', '備考', '取消する記録ID'];
const TRANSFER_LOG_HEADERS = ['記録ID', '区分', '年度', '送金先', '対象人数', '送金額', '送金日', '備考', '取消対象ID', '記録日時'];
const AUDIT_HEADERS = ['日時', '操作した人', '行', '登録番号', '年度', '項目', '変更前', '変更後'];
const ERROR_HEADERS = ['日時', 'ブック', 'シート', '行', '内容'];

const AUTO_FILL = '#eef2f0';
const INPUT_ROWS = 500;

/* ======================================================================
 * 共通の小道具
 * ====================================================================== */
function book_(key) { return SpreadsheetApp.openById(APP.books[key]); }
function today_() { return Utilities.formatDate(new Date(), APP.tz, 'yyyy-MM-dd'); }
function now_() { return Utilities.formatDate(new Date(), APP.tz, 'yyyy-MM-dd HH:mm:ss'); }
function toDate_(s) { return s ? Utilities.parseDate(s, APP.tz, 'yyyy-MM-dd') : ''; }
function cell_(v) { return v instanceof Date ? Utilities.formatDate(v, APP.tz, 'yyyy-MM-dd') : (v === null || v === undefined ? '' : v); }
// 名前や備考が「=」などで始まっても数式として扱われないようにする
function safe_(v) { return typeof v === 'string' && /^[=+\-@]/.test(v) ? "'" + v : v; }

function sheet_(ss, name) {
  const sh = ss.getSheetByName(name);
  if (!sh) throw new Error('「' + name + '」シートがありません。「初期設定」を実行してください');
  return sh;
}

function headerMap_(sh, required) {
  const lastCol = Math.max(1, sh.getLastColumn());
  const head = sh.getRange(1, 1, 1, lastCol).getValues()[0].map(v => String(v).trim());
  const map = {};
  required.forEach(h => {
    const idx = head.reduce((a, x, i) => (x === h ? a.concat(i) : a), []);
    if (idx.length !== 1) throw new Error('「' + sh.getName() + '」の見出し「' + h + '」が' + (idx.length ? '重複しています' : 'ありません') + '。見出しは変えないでください');
    map[h] = idx[0] + 1;
  });
  map._width = lastCol;
  return map;
}

// 見出しを使って行を読む。inputs のどれにも値がない行は空行として除く
function readRows_(sh, headers, inputs) {
  const H = headerMap_(sh, headers);
  const last = sh.getLastRow();
  if (last < 2) return { H, rows: [] };
  const values = sh.getRange(2, 1, last - 1, H._width).getValues();
  const rows = [];
  values.forEach((r, i) => {
    const o = { _row: i + 2 };
    headers.forEach(h => { o[h] = cell_(r[H[h] - 1]); });
    const keys = inputs || headers;
    if (keys.some(h => String(o[h]).trim() !== '' && o[h] !== false)) rows.push(o);
  });
  return { H, rows };
}

function loadContext_() {
  const soumu = book_('soumu'), kaikei = book_('kaikei'), today = today_();
  const roster = readRows_(sheet_(soumu, '正本'), ['登録番号', '氏名', 'よみがな', '登録期', '在籍状況', '会費案内先'], ['登録番号', '氏名']);
  const mem = Logic.parseMembers(roster.rows.map(r => ({ row: r._row, id: r['登録番号'], name: r['氏名'], kana: r['よみがな'], cohort: r['登録期'], membership: r['在籍状況'], emails: r['会費案内先'] })), APP.idDigits);
  const st = readRows_(sheet_(kaikei, '年度設定'), ['年度', '本会分', '支部分', '地区協議会分', '標準納期限', '振込先', '振込名義', '問い合わせ先'], ['年度']);
  const settings = Logic.parseSettings(st.rows.map(r => ({ row: r._row, year: r['年度'], main: r['本会分'], branch: r['支部分'], district: r['地区協議会分'], due: r['標準納期限'], bank: r['振込先'], payer: r['振込名義'], contact: r['問い合わせ先'] })));
  const feeRows = [];
  ledgerSheets_(kaikei).forEach(({ sh, year }) => {
    readRows_(sh, ['登録番号', '請求金額', '納期限', '納入状況', '入金日', '入金額', '会計備考'], LEDGER_INPUTS).rows.forEach(r => feeRows.push({
      row: r._row, sheet: sh.getName(), id: r['登録番号'], year, amount: r['請求金額'], due: r['納期限'], status: r['納入状況'], paidDate: r['入金日'], paid: r['入金額'], note: r['会計備考'],
    }));
  });
  const fees = Logic.parseFees(feeRows, new Set(mem.byId.keys()), today, APP.idDigits);
  const tl = readRows_(sheet_(kaikei, '送金記録'), TRANSFER_LOG_HEADERS, ['記録ID']);
  const transfers = Logic.parseTransfers(tl.rows.map(r => ({ row: r._row, id: r['記録ID'], kind: r['区分'], year: r['年度'], recipient: r['送金先'], count: r['対象人数'], amount: r['送金額'], date: r['送金日'], note: r['備考'], cancelOf: r['取消対象ID'] })));
  return {
    soumu, kaikei, today, digits: APP.idDigits, startMonth: APP.fiscalStartMonth,
    members: mem.list, membersById: mem.byId, memberErrors: mem.errors,
    settings: settings.map, settingErrors: settings.errors, fees, transfers,
  };
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(20000)) throw new Error('ほかの処理が実行中です。少し待ってから、もう一度チェックしてください');
  try { return fn(); } finally { lock.releaseLock(); }
}

function logError_(bookName, sheetName, row, message) {
  console.error(bookName + '/' + sheetName + '/' + row + '：' + message);
  try {
    const sh = book_('soumu').getSheetByName('エラー記録');
    if (sh) sh.appendRow([now_(), bookName, sheetName, row, safe_(String(message).slice(0, 1000))]);
  } catch (ignore) { /* 記録できなくても元の処理は続ける */ }
}

function markDirty_() { PropertiesService.getScriptProperties().setProperty('DIRTY', '1'); }

function protectSheet_(sh, description) {
  const me = Session.getEffectiveUser();
  let p = sh.getProtections(SpreadsheetApp.ProtectionType.SHEET).find(x => x.getDescription() === description);
  if (!p) p = sh.protect().setDescription(description);
  p.setWarningOnly(false);
  p.addEditor(me);
  p.removeEditors(p.getEditors().filter(u => u.getEmail() !== me.getEmail()));
  if (p.canDomainEdit()) p.setDomainEdit(false);
}

function protectRange_(range, description) {
  const me = Session.getEffectiveUser();
  const sh = range.getSheet();
  sh.getProtections(SpreadsheetApp.ProtectionType.RANGE).filter(x => x.getDescription() === description).forEach(x => x.remove());
  const p = range.protect().setDescription(description);
  p.addEditor(me);
  p.removeEditors(p.getEditors().filter(u => u.getEmail() !== me.getEmail()));
  if (p.canDomainEdit()) p.setDomainEdit(false);
}

/* ======================================================================
 * 初期設定（何度実行しても大丈夫です）
 * ====================================================================== */
function 初期設定() {
  withLock_(() => {
    const soumu = book_('soumu'), kaikei = book_('kaikei');
    [soumu, kaikei].forEach(ss => { ss.setSpreadsheetTimeZone(APP.tz); ss.setSpreadsheetLocale('ja_JP'); });

    // ---- 総務ブック ----
    const roster = ensureSheet_(soumu, '正本', ROSTER_HEADERS, ROSTER_REQUIRED);
    const RH = headerMap_(roster, ROSTER_REQUIRED);
    roster.getRange(2, RH['登録番号'], roster.getMaxRows() - 1, 1).setNumberFormat('@');
    roster.getRange(2, RH['修正日'], roster.getMaxRows() - 1, 1).setNumberFormat('yyyy-mm-dd');
    roster.getRange(2, RH['在籍状況'], roster.getMaxRows() - 1, 1).setDataValidation(list_(Logic.MEMBER_STATUSES));
    roster.setFrozenRows(1);

    const move = ensureSheet_(soumu, '異動受付', MOVE_HEADERS);
    setupInputSheet_(move, MOVE_HEADERS, {
      checkbox: '実行', auto: ['状態', '結果・確認内容', '受付ID', '確認キー', '処理日時'], hide: ['確認キー'],
      lists: { '手続き': Logic.ACTIONS, '元支部での納入（本人申告）': Logic.PAYMENTS },
      dates: ['異動日', '個別納期限'], texts: ['登録番号'],
      widths: { '結果・確認内容': 420, '確認内容・理由': 260 },
    });
    protectSheet_(ensureSheet_(soumu, '会員異動履歴', JOURNAL_HEADERS), '自動記録');
    protectSheet_(ensureSheet_(soumu, '管理', ['項目', '値']), '自動出力');
    protectSheet_(ensureSheet_(soumu, 'エラー記録', ERROR_HEADERS), '自動記録');
    removeDefaultSheet_(soumu);

    // ---- 会計ブック ----
    migrateOldLedger_(kaikei);
    ledgerSheets_(kaikei).forEach(x => setupLedgerSheet_(x.sh));

    const settings = ensureSheet_(kaikei, '年度設定', SETTINGS_HEADERS);
    setupInputSheet_(settings, SETTINGS_HEADERS, {
      checkbox: '年度追加', auto: ['会費額（自動）', '状態', '結果・確認内容', '確認キー'], hide: ['確認キー'],
      dates: ['標準納期限'], numbers: ['年度'], money: ['本会分', '支部分', '地区協議会分', '会費額（自動）'],
      widths: { '結果・確認内容': 420, '振込先': 220 }, rows: 50,
    });

    const tin = ensureSheet_(kaikei, '送金入力', TRANSFER_IN_HEADERS);
    setupInputSheet_(tin, TRANSFER_IN_HEADERS, {
      checkbox: '実行', auto: ['状態', '結果・確認内容', '確認キー', '記録ID'], hide: ['確認キー'],
      lists: { '送金先': Logic.RECIPIENTS }, dates: ['送金日'], numbers: ['年度', '対象人数'], money: ['送金額'],
      widths: { '結果・確認内容': 420, '備考': 220 }, rows: 200,
    });
    const tlog = ensureSheet_(kaikei, '送金記録', TRANSFER_LOG_HEADERS);
    protectSheet_(tlog, '自動記録');
    ['会計一覧', '年度別集計', '送金集計'].forEach(name => protectSheet_(ensureSheet_(kaikei, name, null), '自動出力'));
    protectSheet_(ensureSheet_(kaikei, '台帳変更履歴', AUDIT_HEADERS), '自動記録');
    removeDefaultSheet_(kaikei);

    // ---- トリガー ----
    ScriptApp.getProjectTriggers()
      .filter(t => ['handleSoumuEdit', 'handleKaikeiEdit', 'refreshTick'].includes(t.getHandlerFunction()))
      .forEach(t => ScriptApp.deleteTrigger(t));
    ScriptApp.newTrigger('handleSoumuEdit').forSpreadsheet(soumu).onEdit().create();
    ScriptApp.newTrigger('handleKaikeiEdit').forSpreadsheet(kaikei).onEdit().create();
    ScriptApp.newTrigger('refreshTick').timeBased().everyMinutes(10).create();

    PropertiesService.getScriptProperties().setProperty('VERSION', APP.version);
    refreshAll_();
  });
  console.log('初期設定が完了しました（' + APP.version + '）');
}

function ledgerName_(year) { return '会費台帳_' + year; }

function ledgerSheets_(ss) {
  return ss.getSheets().map(sh => {
    const m = sh.getName().match(/^会費台帳_(20\d\d)$/);
    return m ? { sh, year: Number(m[1]) } : null;
  }).filter(Boolean).sort((a, b) => b.year - a.year);
}

// その年度のシートを返す。create のときは無ければ先頭に作る
function ledgerSheet_(ss, year, create) {
  let sh = ss.getSheetByName(ledgerName_(year));
  if (!sh && create) { sh = ss.insertSheet(ledgerName_(year), 0); setupLedgerSheet_(sh); }
  return sh;
}

function setupLedgerSheet_(ledger) {
  ensureSheet_(ledger.getParent(), ledger.getName(), LEDGER_HEADERS);
  const LH = headerMap_(ledger, LEDGER_HEADERS);
  ensureRows_(ledger, 1000);
  const n = ledger.getMaxRows() - 1;
  ledger.getRange(2, LH['登録番号'], n, 1).setNumberFormat('@');
  ['請求金額', '入金額'].forEach(h => ledger.getRange(2, LH[h], n, 1).setNumberFormat('#,##0'));
  ['納期限', '入金日'].forEach(h => ledger.getRange(2, LH[h], n, 1).setNumberFormat('yyyy-mm-dd').setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build()));
  ledger.getRange(2, LH['納入状況'], n, 1).setDataValidation(list_(Logic.FEE_STATUSES));
  LEDGER_AUTO.forEach(h => ledger.getRange(1, LH[h], ledger.getMaxRows(), 1).setBackground(AUTO_FILL));
  ledger.setFrozenRows(1);
  ledger.setColumnWidth(LH['チェック（自動）'], 320);
  ledger.setColumnWidth(LH['会計備考'], 260);
  protectRange_(ledger.getRange(1, LH['氏名（自動）'], ledger.getMaxRows(), 3), '自動列（氏名・登録期・在籍状況）');
  protectRange_(ledger.getRange(1, LH['チェック（自動）'], ledger.getMaxRows(), 2), '自動列（チェック・最終更新）');
  protectRange_(ledger.getRange(1, 1, 1, LEDGER_HEADERS.length), '見出し');
}

// 1枚にまとまった旧形式の「会費台帳」を、年度ごとのシートへ移す（1回だけ）
function migrateOldLedger_(ss) {
  const old = ss.getSheetByName('会費台帳');
  if (!old) return;
  const { rows } = readRows_(old, OLD_LEDGER_HEADERS, ['登録番号', '年度', '請求金額', '納入状況']);
  const byYear = {};
  rows.forEach(r => {
    const y = Logic.toInt(r['年度']);
    if (!(y >= 2000 && y <= 2099)) throw new Error('旧「会費台帳」' + r._row + '行目の年度を確認してください（移行を中止しました）');
    (byYear[y] = byYear[y] || []).push(r);
  });
  Object.keys(byYear).forEach(y => {
    const sh = ss.getSheetByName(ledgerName_(y));
    if (sh && lastDataRow_(sh, headerMap_(sh, LEDGER_HEADERS)['登録番号']) > 1) throw new Error('「' + ledgerName_(y) + '」に既にデータがあるため、旧「会費台帳」の移行を中止しました');
  });
  Object.keys(byYear).sort().forEach(y => {
    const sh = ledgerSheet_(ss, Number(y), true);
    const keep = (v, parsed) => (parsed === null || (typeof parsed === 'number' && isNaN(parsed)) ? v : parsed);
    appendFees_(sh, headerMap_(sh, LEDGER_HEADERS), byYear[y].map(r => ({
      id: Logic.normId(r['登録番号'], APP.idDigits) || String(r['登録番号']), year: Number(y),
      amount: keep(r['請求金額'], Logic.toInt(r['請求金額'])), due: keep(r['納期限'], Logic.normDate(r['納期限'])),
      status: String(r['納入状況']), paidDate: keep(r['入金日'], Logic.normDate(r['入金日'])),
      paid: String(r['入金額']).trim() === '' ? 0 : keep(r['入金額'], Logic.toInt(r['入金額'])), note: String(r['会計備考']),
    })), null);
  });
  old.setName('旧_会費台帳（移行済み）');
}

function ensureSheet_(ss, name, headers, required) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (headers) {
    const width = headers.length;
    if (sh.getMaxColumns() < width) sh.insertColumnsAfter(sh.getMaxColumns(), width - sh.getMaxColumns());
    const current = sh.getRange(1, 1, 1, width).getValues()[0].map(v => String(v).trim());
    if (current.every(v => v === '')) {
      sh.getRange(1, 1, 1, width).setValues([headers]).setFontWeight('bold');
      sh.setFrozenRows(1);
    } else if (current.join('|') !== headers.join('|')) {
      // 列の並べ替えには対応するが、見出しの欠け・重複は止める
      headerMap_(sh, required || headers);
    }
  }
  return sh;
}

function ensureRows_(sh, n) { if (sh.getMaxRows() < n + 1) sh.insertRowsAfter(sh.getMaxRows(), n + 1 - sh.getMaxRows()); }

function list_(items) { return SpreadsheetApp.newDataValidation().requireValueInList(items, true).setAllowInvalid(false).build(); }

function setupInputSheet_(sh, headers, o) {
  const H = headerMap_(sh, headers);
  const rows = o.rows || INPUT_ROWS;
  ensureRows_(sh, rows);
  const col = h => sh.getRange(2, H[h], rows, 1);
  if (o.checkbox) col(o.checkbox).insertCheckboxes();
  Object.keys(o.lists || {}).forEach(h => col(h).setDataValidation(list_(o.lists[h])));
  (o.dates || []).forEach(h => col(h).setNumberFormat('yyyy-mm-dd').setDataValidation(SpreadsheetApp.newDataValidation().requireDate().setAllowInvalid(false).build()));
  (o.texts || []).forEach(h => col(h).setNumberFormat('@'));
  (o.numbers || []).forEach(h => col(h).setNumberFormat('0'));
  (o.money || []).forEach(h => col(h).setNumberFormat('#,##0'));
  (o.auto || []).forEach(h => sh.getRange(1, H[h], rows + 1, 1).setBackground(AUTO_FILL));
  if (H['結果・確認内容']) col('結果・確認内容').setWrap(true);
  Object.keys(o.widths || {}).forEach(h => sh.setColumnWidth(H[h], o.widths[h]));
  (o.hide || []).forEach(h => sh.hideColumns(H[h]));
  sh.setFrozenRows(1);
}

function removeDefaultSheet_(ss) {
  ['シート1', 'Sheet1'].forEach(name => {
    const sh = ss.getSheetByName(name);
    if (sh && ss.getSheets().length > 1 && sh.getLastRow() === 0) ss.deleteSheet(sh);
  });
}

/* ======================================================================
 * 編集されたときの処理（初期設定で登録したトリガーから呼ばれます）
 * ====================================================================== */
function handleSoumuEdit(e) {
  if (!e || !e.range) return;
  const sh = e.range.getSheet(), name = sh.getName();
  try {
    if (name === '異動受付') onMoveEdit_(e, sh);
    else if (name === '正本') onRosterEdit_(e, sh);
  } catch (err) {
    logError_('総務', name, e.range.getRow(), err.message);
  }
}

function handleKaikeiEdit(e) {
  if (!e || !e.range) return;
  const sh = e.range.getSheet(), name = sh.getName();
  try {
    if (/^会費台帳_20\d\d$/.test(name)) onLedgerEdit_(e, sh);
    else if (name === '年度設定') onSettingsEdit_(e, sh);
    else if (name === '送金入力') onTransferEdit_(e, sh);
  } catch (err) {
    logError_('会計', name, e.range.getRow(), err.message);
  }
}

function isTick_(e, H, column) {
  return e.range.getNumRows() === 1 && e.range.getNumColumns() === 1 && e.range.getColumn() === H[column] && e.range.getRow() >= 2 && String(e.value).toUpperCase() === 'TRUE';
}

function editedRows_(e, limit) {
  const first = Math.max(2, e.range.getRow()), last = Math.min(e.range.getLastRow(), first + (limit || 200) - 1);
  const out = [];
  for (let r = first; r <= last; r++) out.push(r);
  return out;
}

function touches_(e, H, names) {
  const c1 = e.range.getColumn(), c2 = e.range.getLastColumn();
  return names.some(h => H[h] >= c1 && H[h] <= c2);
}

// 確認待ちの行の入力が変わったら、確認をやり直してもらう
function invalidate_(sh, H, rows) {
  rows.forEach(r => {
    const st = String(sh.getRange(r, H['状態']).getValue());
    if (st === '確認待ち') {
      sh.getRange(r, H['状態']).setValue('');
      sh.getRange(r, H['結果・確認内容']).setValue('入力が変わりました。もう一度チェックして確認してください');
      sh.getRange(r, H['確認キー']).setValue('');
    }
  });
}

function rowObject_(sh, H, row, headers) {
  const v = sh.getRange(row, 1, 1, H._width).getValues()[0];
  const o = {};
  headers.forEach(h => { o[h] = cell_(v[H[h] - 1]); });
  return o;
}

/* ---------- 異動受付 ---------- */
function onMoveEdit_(e, sh) {
  const H = headerMap_(sh, MOVE_HEADERS);
  if (isTick_(e, H, '実行')) {
    const row = e.range.getRow();
    try { withLock_(() => processMove_(sh, H, row)); }
    catch (err) {
      sh.getRange(row, H['状態']).setValue('エラー');
      sh.getRange(row, H['結果・確認内容']).setValue('エラー：' + err.message);
    } finally { sh.getRange(row, H['実行']).setValue(false); }
    return;
  }
  if (touches_(e, H, MOVE_INPUTS)) invalidate_(sh, H, editedRows_(e));
}

function processMove_(sh, H, row) {
  const o = rowObject_(sh, H, row, MOVE_HEADERS);
  const state = String(o['状態']);
  const out = (status, message) => {
    sh.getRange(row, H['状態']).setValue(status);
    sh.getRange(row, H['結果・確認内容']).setValue(safe_(message));
  };
  if (state === '完了') { out('完了', 'この行は保存済みです。新しい手続きは新しい行に入力してください'); return; }

  let receipt = String(o['受付ID']);
  if (!receipt) { receipt = Utilities.getUuid(); sh.getRange(row, H['受付ID']).setValue(receipt); }

  if (state === '処理中' || state === '処理中断') {
    const plan = journalPlan_(receipt);
    if (!plan) { out('処理中断', 'エラー：会員異動履歴に受付ID ' + receipt + ' が見つかりません。管理者に確認してください'); return; }
    try { applyMove_(plan, receipt); }
    catch (err) {
      out('処理中断', 'エラー：' + err.message + '\n→ 原因を直してから、もう一度「実行」にチェックすると続きから再開します');
      logError_('総務', '異動受付', row, err.message);
      return;
    }
    out('完了', '保存しました（途中から再開）：' + plan.id + ' ' + plan.after.name + ' の' + plan.action);
    sh.getRange(row, H['処理日時']).setValue(now_());
    markDirty_();
    return;
  }

  const ctx = loadContext_();
  const input = {
    action: o['手続き'], date: o['異動日'], id: o['登録番号'], name: o['氏名'], kana: o['よみがな'], cohort: o['登録期'],
    emails: o['会費案内先'], branch: o['関係支部'], payment: o['元支部での納入（本人申告）'],
    year: o['対象年度'], due: o['個別納期限'], reason: o['確認内容・理由'],
  };
  const plan = Logic.planMembership(input, ctx);
  const key = Logic.hash(JSON.stringify(plan));

  if (state !== '確認待ち' || String(o['確認キー']) !== key) {
    out('確認待ち', Logic.membershipPreview(plan));
    sh.getRange(row, H['確認キー']).setValue(key);
    return;
  }

  sh.getRange(row, H['状態']).setValue('処理中');
  try {
    applyMove_(plan, receipt);
  } catch (err) {
    out('処理中断', 'エラー：' + err.message + '\n→ 原因を直してから、もう一度「実行」にチェックすると続きから再開します');
    logError_('総務', '異動受付', row, err.message);
    return;
  }
  out('完了', '保存しました：' + plan.id + ' ' + plan.after.name + ' の' + plan.action + (plan.feeAdds.length + plan.feeUpdates.length ? '（会費 ' + (plan.feeAdds.length + plan.feeUpdates.length) + '件）' : ''));
  sh.getRange(row, H['処理日時']).setValue(now_());
  markDirty_();
}

function journalPlan_(receipt) {
  const sh = sheet_(book_('soumu'), '会員異動履歴');
  const { rows } = readRows_(sh, JOURNAL_HEADERS, ['受付ID']);
  const r = rows.find(x => x['受付ID'] === receipt);
  return r ? JSON.parse(r['処理計画']) : null;
}

// 途中で止まっても、もう一度実行すれば続きから正しく終わるように書いています
function applyMove_(plan, receipt) {
  const soumu = book_('soumu'), kaikei = book_('kaikei');
  const journal = sheet_(soumu, '会員異動履歴');
  const J = headerMap_(journal, JOURNAL_HEADERS);
  const jr = readRows_(journal, JOURNAL_HEADERS, ['受付ID']).rows.find(x => x['受付ID'] === receipt);
  let jRow;
  if (jr) {
    if (jr['処理状態'] === '完了') return;
    jRow = jr._row;
  } else {
    jRow = journal.getLastRow() + 1;
    journal.getRange(jRow, 1, 1, JOURNAL_HEADERS.length).setValues([[
      receipt, '処理中', now_(), plan.date, plan.action, "'" + plan.id, safe_(plan.after.name),
      plan.before ? plan.before.membership : '未登録', plan.after.membership, safe_(plan.branch), safe_(plan.reason), JSON.stringify(plan),
    ]]);
  }

  // 1) 正本
  const roster = sheet_(soumu, '正本');
  const RH = headerMap_(roster, ROSTER_REQUIRED);
  const last = roster.getLastRow();
  const ids = last >= 2 ? roster.getRange(2, RH['登録番号'], last - 1, 1).getValues().map(r => Logic.normId(r[0], APP.idDigits)) : [];
  const hits = ids.map((x, i) => (x === plan.id ? i + 2 : 0)).filter(Boolean);
  const todayDate = toDate_(plan.today);
  if (!plan.before) {
    if (hits.length === 0) {
      const r = last + 1;
      const rowVals = new Array(RH._width).fill('');
      const put = (h, v) => { rowVals[RH[h] - 1] = v; };
      put('都道府県番号', APP.pref.code); put('都道府県名', APP.pref.name);
      put('登録番号', plan.id); put('登録期', safe_(plan.after.cohort)); put('氏名', safe_(plan.after.name)); put('よみがな', safe_(plan.after.kana));
      put('会費案内先', plan.after.emails); put('在籍状況', '在籍'); put('修正日', todayDate);
      put('備考', safe_(plan.date + ' ' + plan.action));
      roster.getRange(r, RH['登録番号']).setNumberFormat('@');
      roster.getRange(r, RH['都道府県番号']).setNumberFormat('@');
      roster.getRange(r, 1, 1, RH._width).setValues([rowVals]);
    } else if (hits.length !== 1 || String(roster.getRange(hits[0], RH['氏名']).getValue()).trim() !== plan.after.name) {
      throw new Error('正本に登録番号 ' + plan.id + ' の別の行があります。正本を確認してください');
    }
  } else {
    if (hits.length !== 1) throw new Error('正本で登録番号 ' + plan.id + ' の行が見つからないか、重複しています');
    const cur = String(roster.getRange(hits[0], RH['在籍状況']).getValue()).trim();
    if (cur !== plan.after.membership) {
      if (cur !== plan.before.membership) throw new Error('正本の在籍状況が確認後に変わりました（' + cur + '）。行を確認してください');
      roster.getRange(hits[0], RH['在籍状況']).setValue(plan.after.membership);
      roster.getRange(hits[0], RH['修正日']).setValue(todayDate);
    }
  }

  // 2) 会費台帳（年度ごとのシート）
  const years = [...new Set(plan.feeAdds.map(f => f.year).concat(plan.feeUpdates.map(u => u.year)))];
  years.forEach(year => {
    const ledger = ledgerSheet_(kaikei, year, true);
    const LH = headerMap_(ledger, LEDGER_HEADERS);
    const lg = readRows_(ledger, LEDGER_HEADERS, LEDGER_INPUTS).rows;
    const find = id => lg.filter(r => Logic.normId(r['登録番号'], APP.idDigits) === id);
    const snap = r => ({ status: String(r['納入状況']), amount: Logic.toInt(r['請求金額']), due: Logic.normDate(r['納期限']), paidDate: Logic.normDate(r['入金日']) || '', paid: String(r['入金額']).trim() === '' ? 0 : Logic.toInt(r['入金額']), note: String(r['会計備考']) });
    const same = (a, b) => a.status === b.status && a.amount === b.amount && a.due === b.due && a.paidDate === b.paidDate && a.paid === b.paid && a.note === b.note;
    const where = id => '「' + ledgerName_(year) + '」の ' + id;
    const appendRows = [];
    plan.feeAdds.filter(f => f.year === year).forEach(f => {
      const ex = find(f.id);
      if (ex.length === 0) appendRows.push(f);
      else if (ex.length > 1 || !same(snap(ex[0]), f)) throw new Error(where(f.id) + ' が確認後に変わりました。台帳を確認してください');
    });
    plan.feeUpdates.filter(u => u.year === year).forEach(u => {
      const ex = find(u.id);
      if (ex.length !== 1) throw new Error(where(u.id) + ' の行が見つからないか、重複しています');
      const cur = snap(ex[0]);
      if (same(cur, u.to)) return;
      if (!same(cur, u.from)) throw new Error(where(u.id) + ' が確認後に変わりました。台帳を確認してください');
      writeFee_(ledger, LH, ex[0]._row, u.to);
    });
    if (appendRows.length) appendFees_(ledger, LH, appendRows, () => plan.after);
  });

  journal.getRange(jRow, J['処理状態']).setValue('完了');
}

function feeCells_(f) {
  const d = v => (Logic.isDate(v) ? toDate_(v) : (v || ''));
  return { '請求金額': f.amount, '納期限': d(f.due), '納入状況': f.status, '入金日': d(f.paidDate), '入金額': f.paid, '会計備考': safe_(f.note) };
}

function writeFee_(ledger, LH, row, f) {
  const cells = feeCells_(f);
  Object.keys(cells).forEach(h => ledger.getRange(row, LH[h]).setValue(cells[h]));
  ledger.getRange(row, LH['最終更新（自動）']).setValue(now_());
}

function appendFees_(ledger, LH, fees, memberOf) {
  const start = Math.max(ledger.getLastRow(), lastDataRow_(ledger, LH['登録番号'])) + 1;
  ensureRows_(ledger, start + fees.length);
  const stamp = now_();
  const values = fees.map(f => {
    const row = new Array(LH._width).fill('');
    const put = (h, v) => { row[LH[h] - 1] = v; };
    const cells = feeCells_(f);
    put('登録番号', f.id);
    Object.keys(cells).forEach(h => put(h, cells[h]));
    const member = memberOf ? memberOf(f.id) : null;
    if (member) { put('氏名（自動）', safe_(member.name)); put('登録期（自動）', safe_(member.cohort)); put('在籍状況（自動）', member.membership); }
    put('最終更新（自動）', stamp);
    return row;
  });
  ledger.getRange(start, LH['登録番号'], values.length, 1).setNumberFormat('@');
  ledger.getRange(start, 1, values.length, LH._width).setValues(values);
}

function lastDataRow_(sh, col) {
  const last = sh.getLastRow();
  if (last < 2) return 1;
  const v = sh.getRange(2, col, last - 1, 1).getValues();
  for (let i = v.length - 1; i >= 0; i--) if (String(v[i][0]).trim() !== '') return i + 2;
  return 1;
}

/* ---------- 正本の直接編集 ---------- */
function onRosterEdit_(e, sh) {
  const H = headerMap_(sh, ['登録番号', '修正日']);
  const rows = editedRows_(e, 500);
  if (!touches_(e, H, ['修正日'])) {
    const d = toDate_(today_());
    rows.forEach(r => { if (String(sh.getRange(r, H['登録番号']).getValue()).trim()) sh.getRange(r, H['修正日']).setValue(d); });
  }
  if (touches_(e, H, ['登録番号'])) {
    rows.forEach(r => {
      const c = sh.getRange(r, H['登録番号']), raw = String(c.getValue()).trim(), n = Logic.normId(raw, APP.idDigits);
      if (n && n !== raw) { c.setNumberFormat('@'); c.setValue(n); }
    });
  }
  markDirty_();
}

/* ---------- 会費台帳 ---------- */
function onLedgerEdit_(e, sh) {
  const H = headerMap_(sh, LEDGER_HEADERS);
  const rows = editedRows_(e, 500);
  if (!rows.length) return;
  const year = Number(sh.getName().slice(-4));
  // 変更履歴
  const audit = sheet_(book_('kaikei'), '台帳変更履歴');
  const user = (e.user && e.user.getEmail && e.user.getEmail()) || '（取得できません）';
  const single = e.range.getNumRows() === 1 && e.range.getNumColumns() === 1;
  const head = sh.getRange(1, e.range.getColumn(), 1, e.range.getNumColumns()).getValues()[0];
  if (single) {
    const r = e.range.getRow();
    audit.appendRow([now_(), user, r, "'" + String(sh.getRange(r, H['登録番号']).getValue()), year, String(head[0]),
      safe_(e.oldValue === undefined ? '' : String(e.oldValue)), safe_(e.value === undefined ? '（空欄）' : String(e.value))]);
  } else {
    audit.appendRow([now_(), user, e.range.getA1Notation(), '', year, '複数セル（' + head.join('・') + '）', '（記録できません）', '貼り付けなどで変更']);
  }
  // 登録番号の桁をそろえる
  if (touches_(e, H, ['登録番号'])) {
    rows.forEach(r => {
      const c = sh.getRange(r, H['登録番号']), raw = String(c.getValue()).trim(), n = Logic.normId(raw, APP.idDigits);
      if (n && n !== raw) { c.setNumberFormat('@'); c.setValue(n); }
    });
  }
  // 編集した行をすぐ検査する
  withLock_(() => {
    const ctx = loadContext_();
    const byRow = new Map(ctx.fees.map(f => [f.sheet + ':' + f.row, f]));
    const stamp = now_();
    rows.forEach(r => {
      const f = byRow.get(sh.getName() + ':' + r);
      writeCheck_(sh, H, r, f, ctx);
      if (f || String(sh.getRange(r, H['登録番号']).getValue()).trim()) sh.getRange(r, H['最終更新（自動）']).setValue(stamp);
    });
  });
  markDirty_();
}

function writeCheck_(sh, H, r, f, ctx) {
  const c = sh.getRange(r, H['チェック（自動）']);
  if (!f) { c.setValue('').setBackground(AUTO_FILL); return; }
  if (f.ok) c.setValue('OK').setBackground(AUTO_FILL);
  else c.setValue('要確認：' + f.errors.join('／')).setBackground('#f8d7d3');
  const m = f.id && ctx.membersById.get(f.id);
  sh.getRange(r, H['氏名（自動）'], 1, 3).setValues([[m ? safe_(m.name) : '', m ? safe_(m.cohort) : '', m ? m.membership : '']]);
}

/* ---------- 年度設定 ---------- */
function onSettingsEdit_(e, sh) {
  const H = headerMap_(sh, SETTINGS_HEADERS);
  if (isTick_(e, H, '年度追加')) {
    const row = e.range.getRow();
    try { withLock_(() => processNewYear_(sh, H, row)); }
    catch (err) {
      sh.getRange(row, H['状態']).setValue('エラー');
      sh.getRange(row, H['結果・確認内容']).setValue('エラー：' + err.message);
    } finally { sh.getRange(row, H['年度追加']).setValue(false); }
    return;
  }
  const inputs = ['年度', '本会分', '支部分', '地区協議会分', '標準納期限'];
  if (!touches_(e, H, inputs)) return;
  const rows = editedRows_(e, 50);
  invalidate_(sh, H, rows);
  const ctx = loadContext_();
  rows.forEach(r => {
    const o = rowObject_(sh, H, r, SETTINGS_HEADERS);
    const parts = [o['本会分'], o['支部分'], o['地区協議会分']].map(Logic.toInt);
    const total = parts.every(n => n >= 0) ? parts[0] + parts[1] + parts[2] : '';
    sh.getRange(r, H['会費額（自動）']).setValue(total);
    const y = Logic.toInt(o['年度']);
    const mism = total === '' ? 0 : ctx.fees.filter(f => f.year === y && !['他支部納入済み', '対象外', '免除'].includes(f.status) && f.amount !== total).length;
    if (mism && String(sh.getRange(r, H['状態']).getValue()) !== '確認待ち') {
      sh.getRange(r, H['結果・確認内容']).setValue('※ この年度の会費台帳に、会費額（' + Logic.yen(total) + '）と違う請求金額の行が ' + mism + '件あります。台帳は自動では変わりません');
    }
  });
  markDirty_();
}

function processNewYear_(sh, H, row) {
  const o = rowObject_(sh, H, row, SETTINGS_HEADERS);
  const year = Logic.toInt(o['年度']);
  if (!(year >= 2000 && year <= 2099)) throw new Error('この行の「年度」を4桁で入力してください');
  const ctx = loadContext_();
  if (!ctx.settings[year]) throw new Error(year + '年度の年度設定を確認してください' + (ctx.settingErrors.length ? '\n' + ctx.settingErrors.join('\n') : ''));
  const plan = Logic.planNewYear(year, ctx);
  const key = Logic.hash(JSON.stringify(plan));
  if (String(o['状態']) !== '確認待ち' || String(o['確認キー']) !== key) {
    sh.getRange(row, H['状態']).setValue(plan.adds.length ? '確認待ち' : '');
    sh.getRange(row, H['結果・確認内容']).setValue(Logic.newYearPreview(plan));
    sh.getRange(row, H['確認キー']).setValue(plan.adds.length ? key : '');
    return;
  }
  const ledger = ledgerSheet_(ctx.kaikei, year, true);
  const LH = headerMap_(ledger, LEDGER_HEADERS);
  appendFees_(ledger, LH, plan.adds, id => ctx.membersById.get(id));
  sh.getRange(row, H['状態']).setValue('完了');
  sh.getRange(row, H['結果・確認内容']).setValue(now_() + '：' + year + '年度の会費行を ' + plan.adds.length + '件追加しました（' + Logic.yen(plan.total) + '／納期限 ' + plan.due + '）');
  sh.getRange(row, H['確認キー']).setValue('');
  markDirty_();
}

/* ---------- 送金入力 ---------- */
function onTransferEdit_(e, sh) {
  const H = headerMap_(sh, TRANSFER_IN_HEADERS);
  if (isTick_(e, H, '実行')) {
    const row = e.range.getRow();
    try { withLock_(() => processTransfer_(sh, H, row)); }
    catch (err) {
      sh.getRange(row, H['状態']).setValue('エラー');
      sh.getRange(row, H['結果・確認内容']).setValue('エラー：' + err.message);
    } finally { sh.getRange(row, H['実行']).setValue(false); }
    return;
  }
  if (touches_(e, H, TRANSFER_IN_INPUTS)) invalidate_(sh, H, editedRows_(e));
}

function processTransfer_(sh, H, row) {
  const o = rowObject_(sh, H, row, TRANSFER_IN_HEADERS);
  if (String(o['状態']) === '完了') {
    sh.getRange(row, H['結果・確認内容']).setValue('この行は記録済みです（記録ID ' + o['記録ID'] + '）。新しい記録は新しい行に入力してください');
    return;
  }
  const ctx = loadContext_();
  const recId = String(o['記録ID']) || ('T' + Utilities.formatDate(new Date(), APP.tz, 'yyyyMMdd') + '-' + Utilities.getUuid().slice(0, 6));
  const logSh = sheet_(ctx.kaikei, '送金記録');
  // 前回の保存が途中で止まっていた場合は、二重に記録しない
  if (o['記録ID'] && ctx.transfers.some(t => t.id === recId)) {
    sh.getRange(row, H['状態']).setValue('完了');
    sh.getRange(row, H['結果・確認内容']).setValue('記録済みでした（記録ID ' + recId + '）。二重には記録していません');
    return;
  }
  const plan = Logic.planTransfer({ year: o['年度'], recipient: o['送金先'], count: o['対象人数'], amount: o['送金額'], date: o['送金日'], note: o['備考'], cancelId: o['取消する記録ID'] }, ctx);
  const key = Logic.hash(JSON.stringify(plan) + recId);
  if (String(o['状態']) !== '確認待ち' || String(o['確認キー']) !== key) {
    sh.getRange(row, H['記録ID']).setValue(recId);
    sh.getRange(row, H['状態']).setValue('確認待ち');
    sh.getRange(row, H['結果・確認内容']).setValue(safe_(Logic.transferPreview(plan)));
    sh.getRange(row, H['確認キー']).setValue(key);
    return;
  }
  const r = Math.max(logSh.getLastRow(), 1) + 1;
  logSh.getRange(r, 1, 1, TRANSFER_LOG_HEADERS.length).setValues([[recId, plan.kind, plan.year, plan.recipient, plan.count, plan.amount, toDate_(plan.date), safe_(plan.note), plan.cancelOf, now_()]]);
  logSh.getRange(r, 7).setNumberFormat('yyyy-mm-dd');
  logSh.getRange(r, 6).setNumberFormat('#,##0');
  sh.getRange(row, H['状態']).setValue('完了');
  sh.getRange(row, H['結果・確認内容']).setValue(now_() + '：記録しました（記録ID ' + recId + '）。実際の銀行送金はこのシステムでは行いません');
  sh.getRange(row, H['確認キー']).setValue('');
  markDirty_();
}

/* ======================================================================
 * 一覧・集計の更新
 * ====================================================================== */
function refreshTick() {
  const p = PropertiesService.getScriptProperties();
  if (p.getProperty('DIRTY') !== '1') return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return; // 次の回に更新する
  try { p.deleteProperty('DIRTY'); refreshAll_(); }
  catch (err) { p.setProperty('DIRTY', '1'); logError_('全体', '一覧の更新', '', err.message); }
  finally { lock.releaseLock(); }
}

function 今すぐ一覧を更新() {
  withLock_(() => { PropertiesService.getScriptProperties().deleteProperty('DIRTY'); refreshAll_(); });
  console.log('一覧・集計を更新しました');
}

function refreshAll_() {
  const ctx = loadContext_();
  const stamp = now_();
  Logic.setRemitDeadline(APP.remitDeadline);

  // 各年度の会費台帳の自動列（氏名・登録期・在籍状況・チェック）
  const byRow = new Map(ctx.fees.map(f => [f.sheet + ':' + f.row, f]));
  ledgerSheets_(ctx.kaikei).forEach(({ sh: ledger }) => {
    const LH = headerMap_(ledger, LEDGER_HEADERS);
    const lastRow = lastDataRow_(ledger, LH['登録番号']);
    if (lastRow < 2) return;
    const names = [], checks = [], colors = [];
    for (let r = 2; r <= lastRow; r++) {
      const f = byRow.get(ledger.getName() + ':' + r), m = f && f.id && ctx.membersById.get(f.id);
      names.push([m ? safe_(m.name) : '', m ? safe_(m.cohort) : '', m ? m.membership : '']);
      checks.push([f ? (f.ok ? 'OK' : '要確認：' + f.errors.join('／')) : '']);
      colors.push([f && !f.ok ? '#f8d7d3' : AUTO_FILL]);
    }
    ledger.getRange(2, LH['氏名（自動）'], names.length, 3).setValues(names);
    ledger.getRange(2, LH['チェック（自動）'], checks.length, 1).setValues(checks).setBackgrounds(colors);
  });

  writeTable_(sheet_(ctx.kaikei, '会計一覧'), '会計一覧（最終更新 ' + stamp + '）　「（要確認）」は会費台帳のチェック欄を見てください', Logic.matrix(ctx.members, ctx.fees));
  writeTable_(sheet_(ctx.kaikei, '年度別集計'), '年度別集計（最終更新 ' + stamp + '）　要確認の行は合計に含めていません', Logic.yearTotals(ctx.fees), ['請求額の合計', '入金額の合計', '未収額（未納・確認中）']);
  writeTable_(sheet_(ctx.kaikei, '送金集計'), '送金集計（最終更新 ' + stamp + '）　目安＝台帳で「納入済み」の人数×1人あたりの額。送金額は自動では決めません', Logic.transferSummary(ctx.fees, ctx.settings, ctx.transfers, ctx.today), ['1人あたり', '送るべき額（目安）', '送金済み額', '差額']);

  // 総務の管理シート
  const count = st => ctx.members.filter(m => m.membership === st).length;
  const badFees = ctx.fees.filter(f => !f.ok);
  const rows = [
    ['システムの版', APP.version],
    ['最終更新', stamp],
    ['会員数（在籍／休会／退会／転出）', count('在籍') + '／' + count('休会') + '／' + count('退会') + '／' + count('転出')],
    ['正本の要確認', ctx.memberErrors.length ? ctx.memberErrors.join('\n') : 'なし'],
    ['年度設定の要確認', ctx.settingErrors.length ? ctx.settingErrors.join('\n') : 'なし'],
    ['会費台帳の要確認', badFees.length ? badFees.length + '行（会計ブックの各年度の会費台帳「チェック」欄を参照）' : 'なし'],
  ];
  Logic.yearTotals(ctx.fees.filter(f => { const m = ctx.membersById.get(f.id); return m && m.membership === '在籍'; })).rows
    .forEach(r => rows.push([r[0] + '年度（在籍者のみ）', '未納 ' + r[2] + '／納入済み ' + r[3] + '／確認中 ' + r[4] + '／免除 ' + r[5] + '／他支部納入済み ' + r[6]]));
  rows.push(['会計ブック', 'https://docs.google.com/spreadsheets/d/' + APP.books.kaikei + '/edit']);
  const admin = sheet_(ctx.soumu, '管理');
  admin.getRange(2, 1, Math.max(admin.getMaxRows() - 1, 1), 2).clearContent();
  admin.getRange(2, 1, rows.length, 2).setValues(rows.map(r => [r[0], safe_(String(r[1]))])).setWrap(true);
  admin.setColumnWidth(1, 260); admin.setColumnWidth(2, 560);
}

function writeTable_(sh, title, table, moneyCols) {
  sh.clearContents();
  sh.getRange(1, 1).setValue(title).setFontWeight('bold');
  const width = table.header.length;
  if (sh.getMaxColumns() < width) sh.insertColumnsAfter(sh.getMaxColumns(), width - sh.getMaxColumns());
  sh.getRange(2, 1, 1, width).setValues([table.header]).setFontWeight('bold').setBackground('#173f32').setFontColor('#ffffff');
  if (table.rows.length) {
    ensureRows_(sh, table.rows.length + 2);
    // 「0001」のような番号が数値に変わらないよう、数字だけの文字列は文字として書く
    sh.getRange(3, 1, table.rows.length, width).setValues(table.rows.map(r => r.map(v => (typeof v === 'string' && /^\d+$/.test(v) ? "'" + v : safe_(v)))));
    (moneyCols || []).forEach(h => { const i = table.header.indexOf(h); if (i >= 0) sh.getRange(3, i + 1, table.rows.length, 1).setNumberFormat('#,##0'); });
  }
  sh.setFrozenRows(2);
}

/* ======================================================================
 * 試験用
 * ====================================================================== */
function 架空データを入れる() {
  withLock_(() => {
    const ctx = loadContext_();
    if (ctx.members.length || ctx.fees.length) throw new Error('正本か会費台帳に既にデータがあるため、架空データは入れません');
    const soumu = ctx.soumu, kaikei = ctx.kaikei;
    const roster = sheet_(soumu, '正本');
    const RH = headerMap_(roster, ROSTER_HEADERS);
    const people = [
      ['0001', '21期', '架空 桜子', 'カクウ サクラコ', '在籍', 'sakura@example.invalid'],
      ['0002', '21期', '架空 欅一', 'カクウ ケヤキイチ', '在籍', 'keyaki@example.invalid'],
      ['0003', '27期', '架空 松美', 'カクウ マツミ', '在籍', 'matsu@example.invalid'],
      ['0004', '28期', '架空 梅二', 'カクウ ウメジ', '在籍', 'ume@example.invalid'],
      ['0005', '34期', '架空 杉子', 'カクウ スギコ', '退会', 'sugi@example.invalid'],
      ['0006', '30期', '架空 楓', 'カクウ カエデ', '休会', 'kaede@example.invalid'],
      ['0007', '32期', '架空 椿', 'カクウ ツバキ', '転出', 'tsubaki@example.invalid'],
      ['0008', '35期', '架空 柏', 'カクウ カシワ', '在籍', ''],
    ];
    const d = toDate_(ctx.today);
    const values = people.map(p => {
      const row = new Array(RH._width).fill('');
      const put = (h, v) => { row[RH[h] - 1] = v; };
      put('都道府県番号', APP.pref.code); put('都道府県名', APP.pref.name); put('登録番号', p[0]); put('登録期', p[1]); put('氏名', p[2]); put('よみがな', p[3]);
      put('自宅住所', '架空市 見本町'); put('メール自宅', p[5]); put('在籍状況', p[4]); put('会費案内先', p[5]); put('修正日', d); put('備考', '架空データ');
      put('郵送対象者', p[5] ? '' : '要');
      return row;
    });
    roster.getRange(2, RH['登録番号'], values.length, 1).setNumberFormat('@');
    roster.getRange(2, RH['都道府県番号'], values.length, 1).setNumberFormat('@');
    roster.getRange(2, 1, values.length, RH._width).setValues(values);

    const st = sheet_(kaikei, '年度設定');
    const SH = headerMap_(st, SETTINGS_HEADERS);
    [[2026, '2026-07-31'], [2027, '2027-07-31']].forEach(([y, due], i) => {
      const r = 2 + i;
      const put = (h, v) => st.getRange(r, SH[h]).setValue(v);
      put('年度', y); put('本会分', 12000); put('支部分', 5000); put('地区協議会分', 1000); put('会費額（自動）', 18000);
      put('標準納期限', toDate_(due)); put('振込先', '架空銀行 架空支店 普通0000000'); put('振込名義', '登録番号＋氏名'); put('問い合わせ先', '会計部会（試験用）');
    });

    const ledger = ledgerSheet_(kaikei, 2026, true);
    const LH = headerMap_(ledger, LEDGER_HEADERS);
    const fees = [
      ['0001', '納入済み', 18000, '2026-07-10', ''],
      ['0002', '納入済み', 18000, '2026-07-20', ''],
      ['0003', '他支部納入済み', 0, '', '架空：転入元 東京都支部／本人申告により元支部で納入済み（当支部では確認不可）'],
      ['0004', '確認中', 5000, '2026-08-01', '架空：一部入金（5,000円）'],
      ['0005', '未納', 0, '', ''],
      ['0006', '免除', 0, '', '架空：休会中のため免除（理事会承認の想定）'],
      ['0007', '未納', 0, '', ''],
      ['0008', '未納', 0, '', ''],
    ].map(([id, status, paid, paidDate, note]) => ({ id, year: 2026, status, amount: status === '他支部納入済み' ? 0 : 18000, due: '2026-07-31', paid, paidDate, note }));
    appendFees_(ledger, LH, fees, null);
    PropertiesService.getScriptProperties().deleteProperty('DIRTY');
    refreshAll_();
  });
  console.log('架空データを入れました。会計ブックの「年度設定」で2027年度の「年度追加」を試せます');
}

function トリガーを止める() {
  ScriptApp.getProjectTriggers()
    .filter(t => ['handleSoumuEdit', 'handleKaikeiEdit', 'refreshTick'].includes(t.getHandlerFunction()))
    .forEach(t => ScriptApp.deleteTrigger(t));
  console.log('自動処理を止めました。再開するには「初期設定」を実行してください');
}

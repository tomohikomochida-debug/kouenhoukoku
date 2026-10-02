/**
 * 日本樹木医会 神奈川県支部 支部管理システム v2
 * 第1段階：総務（正本・会員の異動）＋ 会計（会費台帳・年度追加・送金記録）
 * 第2段階：広報（督促メールの文面・対象・送信）＋ 総務（本番の送信アカウントの登録・送信記録・郵送リスト）
 * 第3段階：研修（申込フォーム・参加資格の照合・出欠）＋ 総務（長期未納の一覧）
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
 *  - 督促メール（広報の仕事）：広報ブックの「文面」を整え、「督促対象」で送らない人のチェックを外す。
 *    広報ブックの「送信設定」で送信モード（停止・試験・本番）を選び、「送信実行」に対象年度を入れて
 *    「実行」にチェック → 確認内容が出る → もう一度チェックで送信。
 *    本番送信には、総務ブック「送信設定」への「本番で使う送信アカウント」の登録が必要（総務の安全装置）。
 *  - 研修：研修ブックの「研修一覧」に1行入力（研修IDは空欄なら「2026-01」の形で自動）すると、
 *    研修会ごとの「申込_研修ID」シートができる。「フォーム作成」にチェック → 申込フォームができる。
 *    回答は10分ごとにその研修の申込シートへ取り込まれ、参加資格を自動で判定（基準は「判定の基準」シート）。
 *    締切・定員・開催日でフォームの受付は自動で閉じます。出欠は申込シートの「出欠」に入力し、
 *    年度ごとの「年度集計_2026」などに出欠の一覧が出ます。
 *  - 一覧・集計は操作のたびに自動更新（念のため10分ごとにも確認）。
 *
 * このプロジェクトはウェブアプリとして公開しないでください。
 */

const APP = {
  version: 'v2-第3段階-20261002',
  books: {
    soumu: '1EpwGgak2yF5cEbu4YDUKmjwqaKj5-3690rOcnJu-oXs',   // 総務_正本_v2
    kaikei: '1CQv396GIBXz1M4xBi8pHE3J97iKJtsOeBey9n2-roUc',  // 会計_会費台帳_v2
    kouhou: '1dGWIZNiDjo1YrsXKgz3yWG6DMGA-1-pKKEbLGwn6xGQ',  // 広報_督促_v2
    kenshu: '1um-reIWCtidpGwIHp-kizsgak78nVa6ZS1I9COYl_g0',  // 研修_申込照合_v2
  },
  tz: 'Asia/Tokyo',
  fiscalStartMonth: 4,  // 会費の年度は4月始まり
  idDigits: 4,          // 登録番号（＝樹木医番号）の桁数
  pref: { code: '14', name: '神奈川県' },
  remitDeadline: '09-30', // 本会への納入期限（取扱要領 第4条）
  mailRecentDays: 7,      // 同じ人・同じ年度への督促は、この日数のあいだ再送しない
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

  /* ---------- 督促メール ---------- */
  const MAIL_KEYS = ['氏名', '登録番号', '対象年度', '会費額', '本会分', '支部分', '地区協議会分', '納期限', '振込先', '振込名義', '問い合わせ先'];
  const MAIL_MODES = ['停止', '試験', '本番'];
  const SEND_STYLES = ['BCCで一斉', '1人ずつ'];
  const BCC_MAX = 50; // 無料のGmailは1通の宛先が50人まで

  function emailList(v) { return text(v).normalize('NFKC').split(/[,、;\s]+/).map(x => x.trim().toLowerCase()).filter(Boolean); }
  function isEmail(x) { return /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/.test(x); }

  // 督促の対象：在籍者で、納期限を過ぎた「未納」。メール・郵送・要確認に分ける
  function dunningTargets(members, fees, today) {
    const byId = new Map(members.map(m => [m.id, m]));
    const used = new Map();
    members.forEach(m => emailList(m.emails).forEach(a => used.set(a, (used.get(a) || 0) + 1)));
    const out = [];
    fees.filter(f => f.ok && f.status === '未納' && f.due && f.due < today).forEach(f => {
      const m = byId.get(f.id);
      if (!m || m.membership !== '在籍') return;
      const emails = emailList(m.emails);
      let route = 'メール', note = '';
      if (!emails.length) route = '郵送';
      else if (emails.some(a => !isEmail(a))) { route = '要確認'; note = '会費案内先のメールアドレスの形を確認してください'; }
      else if (emails.some(a => used.get(a) > 1)) { route = '要確認'; note = 'ほかの会員と同じメールアドレスです'; }
      out.push({ id: f.id, name: m.name, cohort: m.cohort, year: f.year, amount: f.amount, due: f.due, route, note, emails });
    });
    return out.sort((a, b) => b.year - a.year || a.id.localeCompare(b.id));
  }

  // bcc=true のときは全員に同じ文面なので、個人の項目（氏名・登録番号）は使えない
  function renderMail(tpl, t, s, bcc) {
    const map = {
      '氏名': t.name, '登録番号': t.id, '対象年度': t.year, '会費額': yen(t.amount), '本会分': yen(s.main), '支部分': yen(s.branch),
      '地区協議会分': yen(s.district), '納期限': t.due, '振込先': s.bank, '振込名義': s.payer, '問い合わせ先': s.contact,
    };
    return String(tpl).replace(/\{\{([^}]*)\}\}/g, (_, k) => {
      k = k.trim();
      check(Object.prototype.hasOwnProperty.call(map, k), '文面に使えない差し込み項目があります：{{' + k + '}}（使えるのは ' + MAIL_KEYS.map(x => '{{' + x + '}}').join(' ') + '）');
      check(!(bcc && ['氏名', '登録番号'].includes(k)), 'BCCで一斉に送るときは、全員に同じ文面が届くため {{' + k + '}} は使えません。文面から外すか、広報ブック「送信設定」の送り方を「1人ずつ」にしてください');
      return String(map[k]);
    });
  }

  // BCC一斉送信の文面に入れる値（年度設定の標準の会費額・納期限）
  function commonTarget(year, s) { return { id: '', name: '', year, amount: s.total, due: s.due }; }

  function checkTemplate(subject, body) {
    check(text(subject) && !/[\r\n]/.test(subject) && text(subject).length <= 150, '広報ブック「文面」の件名を確認してください（改行なし・150文字以内）');
    check(text(body) && String(body).length <= 20000, '広報ブック「文面」の本文を入力してください');
  }

  // v: { year, mode, style, testTo, account, allowed, limit, subject, body, selected(Map 'id:year'→true/false), history[] }
  function planSend(v, ctx) {
    const year = toInt(v.year);
    check(year >= 2000 && year <= 2099, '「対象年度」を4桁で入力してください');
    const s = ctx.settings[year];
    check(s, year + '年度の年度設定がありません');
    const mode = text(v.mode);
    check(mode === '試験' || mode === '本番', '広報ブック「送信設定」の送信モードが「' + (mode || '空欄') + '」です。送るときは「試験」か「本番」にしてください');
    const style = text(v.style) || SEND_STYLES[0];
    check(SEND_STYLES.includes(style), '広報ブック「送信設定」の送り方は「' + SEND_STYLES.join('」か「') + '」にしてください');
    const bcc = style === 'BCCで一斉';
    checkTemplate(v.subject, v.body);
    let testTo = '';
    if (mode === '試験') {
      testTo = text(v.testTo).toLowerCase();
      check(isEmail(testTo), '広報ブック「送信設定」の「試験送信先」にメールアドレスを1つ入れてください');
    } else {
      check(text(v.allowed) && text(v.allowed).toLowerCase() === text(v.account).toLowerCase(),
        '本番送信は、総務ブック「送信設定」の「本番で使う送信アカウント」と、このシステムを動かしているアカウント（' + v.account + '）が同じときだけできます。総務に登録を依頼してください');
    }
    const limit = toInt(v.limit);
    check(limit >= 1 && limit <= 100, '広報ブック「送信設定」の「1回の送信上限」は1〜100にしてください');
    // 文面の誤りは、送る相手がいなくても先に知らせる
    if (bcc) renderMail(v.body, commonTarget(year, s), s, true);
    const all = dunningTargets(ctx.members, ctx.fees, ctx.today).filter(t => t.year === year);
    const skipped = { '郵送': 0, '要確認': 0, '送らない': 0, '最近送信済み': 0 };
    const today = Date.parse(ctx.today + 'T00:00:00Z'), days = v.recentDays || 7;
    const picked = [];
    all.forEach(t => {
      if (t.route !== 'メール') { skipped[t.route]++; return; }
      if (v.selected && v.selected.get(t.id + ':' + t.year) === false) { skipped['送らない']++; return; }
      const recent = (v.history || []).some(h => h.id === t.id && h.year === t.year && h.mode === mode &&
        (['送信中', '結果不明'].includes(h.result) || (['送信済み', '試験送信済み'].includes(h.result) && today - Date.parse(h.day + 'T00:00:00Z') < days * 86400000)));
      if (recent) { skipped['最近送信済み']++; return; }
      if (mode === '本番') check(!t.emails.some(a => /\.(invalid|example|test|localhost)$/.test(a)), t.id + ' の会費案内先が試験用のアドレスです。本番では送れません');
      picked.push(t);
    });
    if (!bcc && all.length) renderMail(v.body, all[0], s);
    const now = picked.slice(0, limit);
    const subject = (mode === '試験' ? '【試験】' : '') + text(v.subject);
    const member = t => ({ id: t.id, name: t.name, year: t.year, addr: t.emails.join(',') });
    const messages = [];
    if (bcc) {
      const body = renderMail(v.body, commonTarget(year, s), s, true);
      for (let i = 0; i < now.length; i += BCC_MAX) {
        const group = now.slice(i, i + BCC_MAX);
        messages.push({
          members: group.map(member), to: mode === '試験' ? testTo : text(v.account).toLowerCase(),
          bcc: mode === '試験' ? '' : [...new Set([].concat(...group.map(t => t.emails)))].join(','), subject,
          body: (mode === '試験' ? '（試験送信です。本番では次の ' + group.length + '名にBCCで送ります：' + group.map(t => t.id + ' ' + t.name).join('、') + '）\n\n' : '') + body,
        });
      }
    } else {
      now.forEach(t => messages.push({
        members: [member(t)], to: mode === '試験' ? testTo : t.emails.join(','), bcc: '', subject,
        body: (mode === '試験' ? '（試験送信です。本来の宛先：' + t.id + ' ' + t.name + '）\n\n' : '') + renderMail(v.body, t, s),
      }));
    }
    return { year, mode, style, account: v.account, testTo, limit, total: picked.length, people: now.length, messages, remaining: picked.length - now.length, skipped, today: ctx.today };
  }

  function sendPreview(p) {
    const lines = [];
    lines.push('【督促メール・' + p.mode + '・' + p.style + '】' + p.year + '年度／送信元 ' + p.account);
    lines.push('今回の宛先：' + p.people + '名（メール ' + p.messages.length + '通）' + (p.remaining ? '　上限のため残り ' + p.remaining + '名は次回' : ''));
    if (p.mode === '試験') lines.push('送り先：試験送信先 ' + p.testTo + ' だけに送ります（会員には届きません）');
    else if (p.style === 'BCCで一斉') lines.push('送り先：宛先（To）は送信アカウント、未納者は全員BCC（ほかの人のアドレスは見えません）');
    else lines.push('送り先：各会員の会費案内先に1人ずつ（本番。会員に届きます）');
    lines.push('送らない人：郵送 ' + p.skipped['郵送'] + '名／要確認 ' + p.skipped['要確認'] + '名／「送る」のチェックなし ' + p.skipped['送らない'] + '名／最近送信済み ' + p.skipped['最近送信済み'] + '名');
    if (p.messages.length) {
      const m = p.messages[0];
      lines.push('―― 送るメール' + (p.messages.length > 1 ? '（1通目）' : '') + ' ――', '件名：' + m.subject, m.body, '――――');
      lines.push('→ この内容でよければ、もう一度「実行」にチェックしてください');
    } else lines.push('送る相手がいません');
    return lines.join('\n');
  }

  /* ---------- 研修（第3段階） ---------- */
  const KUBUN = ['神奈川県支部の会員', '他支部の樹木医', 'その他（一般など）'];
  const JUDGES = ['参加可', '要確認', '参加不可'];
  const EXTERNAL = '外部（判定なし）';
  const OVERRIDES = ['参加可', '参加不可'];
  const ATTEND = ['出席', '欠席', '申込取消'];
  // フォームの標準の質問（題名で読み取る。研修担当が追加した質問は「その他の回答」へ）
  const FORM_ITEMS = { kind: '区分', id: '樹木医登録番号', cohort: '樹木医の登録期', name: '氏名', org: '所属・勤務先', note: '連絡事項' };

  function parseTrainings(rows) {
    const list = [], byId = new Map(), errors = [];
    rows.forEach(r => {
      const t = {
        row: r.row, id: text(r.id).normalize('NFKC'), name: text(r.name), date: normDate(r.date), venue: text(r.venue),
        deadline: normDate(r.deadline), capacity: text(r.capacity) === '' ? 0 : toInt(r.capacity), guide: text(r.guide), formId: text(r.formId),
      };
      const e = [];
      if (!t.id) e.push('研修IDを入力');
      else if (!/^[0-9A-Za-z_-]{1,30}$/.test(t.id)) e.push('研修IDは半角の英数字と - _ だけ（30文字まで）');
      else if (byId.has(t.id)) e.push('研修IDが重複（' + byId.get(t.id).row + '行目）');
      if (!t.name) e.push('研修名を入力');
      if (!t.date) e.push('開催日を日付で');
      if (t.deadline === null) e.push('申込締切を日付で');
      else if (t.deadline && t.date && t.deadline > t.date) e.push('申込締切が開催日より後');
      if (!(t.capacity >= 0)) e.push('定員は0以上の整数（空欄なら制限なし）');
      t.errors = e; t.ok = !e.length;
      if (t.id && !byId.has(t.id)) byId.set(t.id, t);
      if (e.length) errors.push('研修一覧 ' + r.row + '行目：' + e.join('／'));
      list.push(t);
    });
    return { list, byId, errors };
  }

  // 受付の状態（フォームを開けておくのは「受付中」のときだけ）
  function trainingState(t, count, today) {
    if (!t.ok) return '入力を確認';
    if (today > t.date) return '終了（開催済み）';
    if (!t.formId) return 'フォーム未作成';
    if (today > (t.deadline || t.date)) return '締切';
    if (t.capacity && count >= t.capacity) return '定員到達';
    return '受付中';
  }

  function formText(t) {
    const lines = [];
    if (t.guide) lines.push(t.guide, '');
    lines.push('開催日：' + t.date);
    if (t.venue) lines.push('会場：' + t.venue);
    lines.push('申込締切：' + (t.deadline || t.date));
    if (t.capacity) lines.push('定員：' + t.capacity + '名（定員に達した時点で受付を終了します）');
    lines.push('', '主催：日本樹木医会神奈川県支部');
    return { title: t.name + '（' + t.date + '）参加申込', description: lines.join('\n') };
  }

  // フォームの回答（[題名, 回答] の並び）を申込の項目に分ける
  function mapAnswers(pairs) {
    const out = { kind: '', id: '', cohort: '', name: '', org: '', note: '', other: [] };
    const keys = Object.keys(FORM_ITEMS);
    pairs.forEach(([title, answer]) => {
      const a = Array.isArray(answer) ? answer.join('、') : text(answer);
      const k = keys.find(x => FORM_ITEMS[x] === text(title));
      if (k) out[k] = a; else if (a) out.other.push(text(title) + '：' + a);
    });
    out.other = out.other.join('\n');
    return out;
  }

  // 「第21期」「２１」「21期」を同じものとして比べる
  function cohortKey(v) { const d = text(v).normalize('NFKC').match(/\d+/); return d ? String(Number(d[0])) : nameKey(v); }

  // 参加判定（支部の運用）
  //  - 会費の年度は開催日で決める（4月始まり）
  //  - その年度以前の会費で、開催日より前に納期限が過ぎた「未納」があれば参加不可（期限前の未納は参加可）
  //  - 確認中は要確認。納入済み・免除・他支部納入済み（本人申告）は参加可
  //  - 休会は参加不可。外部（他支部の樹木医・一般）は判定しない
  function judgeApplication(a, t, ctx) {
    const kind = text(a.kind);
    if (!t) return { result: '要確認', reason: '研修IDが研修一覧にありません' };
    if (!t.ok) return { result: '要確認', reason: '研修一覧のこの研修の入力を確認してください' };
    const id = normId(a.id, ctx.digits), m = id ? ctx.membersById.get(id) : null;
    if (kind !== KUBUN[0]) {
      if (!KUBUN.includes(kind)) return { result: '要確認', reason: '区分を選んでください（' + KUBUN.join('・') + '）' };
      if (m && m.membership === '在籍' && nameKey(m.name) === nameKey(a.name)) return { result: '要確認', reason: '名簿に同じ番号・氏名の会員がいます。区分を確認してください' };
      return { result: EXTERNAL, reason: kind };
    }
    if (!text(a.id)) return { result: '要確認', reason: '登録番号が空欄です' };
    if (!id) return { result: '要確認', reason: '登録番号「' + text(a.id) + '」を確認してください（' + ctx.digits + '桁まで）' };
    if (!m) return { result: '要確認', reason: '名簿にない登録番号です（' + id + '）' };
    let level = 0;
    const reasons = [];
    const bump = (l, r) => { level = Math.max(level, l); reasons.push(r); };
    if (nameKey(m.name) !== nameKey(a.name)) bump(1, '氏名が名簿と違います（名簿：' + m.name + '）');
    if (text(a.cohort) && text(m.cohort) && cohortKey(a.cohort) !== cohortKey(m.cohort)) bump(1, '登録期が名簿と違います（名簿：' + m.cohort + '）');
    if (m.membership === '休会') bump(2, '休会中です');
    else if (m.membership !== '在籍') bump(1, '名簿では「' + m.membership + '」です');
    const year = fiscalYear(t.date, ctx.startMonth);
    const mine = ctx.fees.filter(f => f.id === id && f.year <= year).sort((x, y) => x.year - y.year);
    mine.forEach(f => {
      if (!f.ok) { bump(1, f.year + '年度の会費台帳の行に要確認があります'); return; }
      if (f.status === '未納') {
        if (f.due < t.date) bump(2, f.year + '年度の会費が未納（納期限 ' + f.due + '。開催日までに入金の確認が必要）');
        else if (f.year === year) reasons.push(year + '年度は未納ですが、納期限（' + f.due + '）前の開催のため参加可');
      } else if (f.status === '確認中') bump(1, f.year + '年度の会費が確認中です');
      else if (f.status === '対象外' && f.year === year) bump(1, year + '年度の会費が「対象外」です');
    });
    const cur = mine.find(f => f.year === year);
    if (!cur) {
      if (ctx.settings[year]) bump(1, year + '年度の会費台帳にこの方の行がありません');
      else reasons.push(year + '年度の会費はまだ設定前のため、前年度までで判定');
    }
    if (!reasons.length) reasons.push(year + '年度の会費：' + cur.status);
    return { result: JUDGES[level], reason: reasons.join('／'), memberName: m.name };
  }

  // 研修IDの自動採番：その年度の「2026-01」「2026-02」…の次
  function nextTrainingId(ids, year) {
    const re = new RegExp('^' + year + '-(\\d+)$');
    const n = ids.map(x => (text(x).match(re) || [])[1]).filter(Boolean).map(Number);
    return year + '-' + String((n.length ? Math.max(...n) : 0) + 1).padStart(2, '0');
  }

  // 年度の出欠の一覧。list：[{ t: 研修, apps: [{ kind, id, name, att, dup }] }]（開催日順）
  function yearAttendance(list) {
    const people = new Map();
    list.forEach(({ apps }, i) => apps.forEach(a => {
      if (a.dup || (!a.id && !nameKey(a.name))) return;
      const key = a.id ? 'id:' + a.id : 'n:' + nameKey(a.name);
      if (!people.has(key)) people.set(key, { id: a.id, name: a.name, kind: a.kind, cells: list.map(() => ''), count: 0 });
      const p = people.get(key);
      if (a.att === '申込取消') { if (!p.cells[i]) p.cells[i] = '取消'; } else p.cells[i] = a.att || '申込';
      if (a.att === '出席') p.count++;
    }));
    const rows = [...people.values()]
      .sort((x, y) => (x.id ? 0 : 1) - (y.id ? 0 : 1) || x.id.localeCompare(y.id) || x.name.localeCompare(y.name, 'ja'))
      .map(p => [p.id, p.name, p.kind, p.count].concat(p.cells));
    return { header: ['登録番号', '氏名', '区分', '出席回数'].concat(list.map(({ t }) => t.id + '（' + t.date.slice(5).replace('-', '/') + '）')), rows };
  }

  // 2年度分以上の会費が未納（納期限経過）の在籍会員（規約により退会の扱い）
  function longUnpaid(members, fees, today) {
    return members.filter(m => m.membership === '在籍').map(m => {
      const due = fees.filter(f => f.id === m.id && f.ok && f.status === '未納' && f.due < today).sort((x, y) => x.year - y.year);
      return { id: m.id, name: m.name, cohort: m.cohort, years: due.map(f => f.year), total: due.reduce((s, f) => s + f.amount, 0) };
    }).filter(x => x.years.length >= 2);
  }

  let APP_REMIT_DEADLINE = '09-30';
  function setRemitDeadline(md) { APP_REMIT_DEADLINE = md; }

  return {
    FEE_STATUSES, MEMBER_STATUSES, ACTIONS, PAYMENTS, RECIPIENTS,
    text, normId, normDate, isDate, toInt, fiscalYear, yen, normEmails, hash, nameKey,
    parseMembers, parseSettings, parseFees, parseTransfers, snapFee,
    planMembership, membershipPreview, planNewYear, newYearPreview, planTransfer, transferPreview,
    matrix, yearTotals, transferSummary, setRemitDeadline,
    MAIL_KEYS, MAIL_MODES, SEND_STYLES, BCC_MAX, emailList, isEmail, dunningTargets, renderMail, commonTarget, checkTemplate, planSend, sendPreview,

    KUBUN, JUDGES, EXTERNAL, OVERRIDES, ATTEND, FORM_ITEMS, parseTrainings, trainingState, formText, mapAnswers, judgeApplication, longUnpaid, nextTrainingId, yearAttendance,
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
// 広報ブック「送信設定」（広報が操作）
const KOUHOU_SEND_ROWS = [
  ['送信モード', '停止', '停止：送らない／試験：試験送信先にだけ送る／本番：会員へ送る'],
  ['試験送信先', '', '試験のとき、このアドレスにだけ送ります'],
  ['送り方', 'BCCで一斉', 'BCCで一斉：未納者全員に同じ文面を1通で（50人ずつ）／1人ずつ：氏名入りの文面を1人ずつ'],
  ['1回の送信上限', 30, '1回のチェックで送る最大人数（無料のGmailは1日に約100人、Workspaceは約1,500人まで。BCCの人数も数えます）'],
  ['差出人の表示名', '日本樹木医会神奈川県支部', '受け取った人に見える差出人名'],
  ['返信先', '', '空欄なら送信アカウントに返信が届きます'],
];
// 総務ブック「送信設定」（総務の安全装置）
const SOUMU_SEND_ROWS = [
  ['本番で使う送信アカウント', '', '本番の送信元。このシステムを動かすアカウントと同じときだけ、広報が本番送信できます'],
];
const SEND_SETTING_ROWS = KOUHOU_SEND_ROWS.concat(SOUMU_SEND_ROWS);
const SEND_RUN_HEADERS = ['実行', '状態', '結果・確認内容', '対象年度', 'メモ', '確認キー', '受付ID', '処理日時'];
const SEND_RUN_INPUTS = ['対象年度', 'メモ'];
const SEND_LOG_HEADERS = ['日時', '受付ID', '登録番号', '氏名', '年度', '宛先', 'モード', '結果'];
const TEMPLATE_DEFAULT = {
  subject: '【日本樹木医会神奈川県支部】年会費納入のお願い',
  body: ['神奈川県支部 会員各位', '', '日本樹木医会神奈川県支部です。',
    '{{対象年度}}年度の年会費 {{会費額}}（本会分 {{本会分}}・支部分 {{支部分}}・関東甲信地区協議会分 {{地区協議会分}}）について、',
    '納期限（{{納期限}}）を過ぎましたが、まだ入金を確認できていない方にお送りしています。', 'お手数ですが、下記へお振り込みをお願いいたします。', '',
    '振込先：{{振込先}}', '振込名義：{{振込名義}}', '',
    'このメールは、入金を確認できていない会員の皆様にBCCでお送りしています。',
    '行き違いでお振り込み済みの場合は、ご容赦ください。', 'お問い合わせ：{{問い合わせ先}}'].join('\n'),
};
// 前の版の標準文面（{{氏名}} 入り）。手を加えていなければ、初期設定で新しい標準文面に置き換える
const TEMPLATE_OLD_BODY = ['{{氏名}} 様', '', '日本樹木医会神奈川県支部です。',
  '{{対象年度}}年度の年会費 {{会費額}}（本会分 {{本会分}}・支部分 {{支部分}}・関東甲信地区協議会分 {{地区協議会分}}）について、',
  '納期限（{{納期限}}）を過ぎましたが、まだ入金を確認できておりません。', 'お手数ですが、下記へお振り込みをお願いいたします。', '',
  '振込先：{{振込先}}', '振込名義：{{振込名義}}', '', '行き違いでお振り込み済みの場合は、ご容赦ください。', 'お問い合わせ：{{問い合わせ先}}'].join('\n');

// 研修ブック（第3段階）
const TRAINING_HEADERS = ['研修ID', '研修名', '開催日', '年度（自動）', '会場', '申込締切', '定員', '案内文', 'フォーム作成', '受付（自動）', 'フォームURL（自動）', '申込シート（自動）', '申込（自動）', '参加可（自動）', '要確認（自動）', '参加不可（自動）', '外部（自動）', '出席（自動）', '結果・確認内容', 'フォームID'];
const TRAINING_INPUTS = ['研修ID', '研修名', '開催日', '会場', '申込締切', '定員', '案内文'];
const TRAINING_AUTO = ['年度（自動）', '受付（自動）', 'フォームURL（自動）', '申込シート（自動）', '申込（自動）', '参加可（自動）', '要確認（自動）', '参加不可（自動）', '外部（自動）', '出席（自動）', '結果・確認内容', 'フォームID'];
// 研修会ごとの申込シート「申込_研修ID」
const APPLY_HEADERS = ['受付ID', '受付日時', '区分', '登録番号', '登録期', '氏名', 'メール', '所属・勤務先', '連絡事項', 'その他の回答', '判定（自動）', '理由（自動）', '研修担当の判断', '最終（自動）', '出欠', 'メモ', '判定日（自動）'];
const APPLY_INPUTS = ['区分', '登録番号', '登録期', '氏名', 'メール', '所属・勤務先', '連絡事項'];
const APPLY_AUTO = ['受付ID', '受付日時', '判定（自動）', '理由（自動）', '最終（自動）', '判定日（自動）'];
const JUDGE_RULES = [
  '参加資格の判定の基準（支部の運用）',
  '・会費の年度は、研修の開催日で決まります（4月始まり。例：2026年11月の研修 → 2026年度）。',
  '・その年度までの会費に、納期限が開催日より前に過ぎた「未納」がある → 参加不可。',
  '・その年度の会費が未納でも、納期限より前に開催する研修 → 参加可（最初の集金の期限は7月中頃）。',
  '・「確認中」（振込の照合待ちなど）→ 要確認。',
  '・「納入済み」「免除」「他支部納入済み」（本人申告。当支部では確認できません）→ 参加可。',
  '・休会中 → 参加不可。名簿にない番号、名簿と違う氏名・登録期 → 要確認（登録期が空欄なら照合しません）。',
  '・他支部の樹木医・一般の方 → 判定しません（外部）。',
  '・判定は開催日まで自動でやり直します（入金が確認されると参加可に変わります）。開催日を過ぎると固定されます。',
  '・要確認を確かめたら「研修担当の判断」に参加可／参加不可を入れてください。「最終」に反映されます。',
  '・2年度分以上の会費が未納の方は規約により退会の扱いです（総務ブック「長期未納」に一覧が出ます）。',
];
const TRIGGER_FNS = ['handleSoumuEdit', 'handleKaikeiEdit', 'handleKouhouEdit', 'handleKenshuEdit', 'refreshTick'];

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

// 操作のすぐ後に一覧・集計を更新する（失敗しても元の操作は取り消さず、次の自動更新に任せる）
function refreshNow_() {
  try { PropertiesService.getScriptProperties().deleteProperty('DIRTY'); refreshAll_(); }
  catch (err) { markDirty_(); logError_('全体', '一覧の更新', '', err.message); }
}

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
// 許可画面で一部の権限（メールの送信など）が外されていたら、もう一度許可画面を出す
function requireAllScopes_() {
  if (typeof ScriptApp.requireAllScopes === 'function') ScriptApp.requireAllScopes(ScriptApp.AuthMode.FULL);
}

function メール送信を許可する() {
  requireAllScopes_();
  console.log('メール送信は許可されています（今日あと ' + MailApp.getRemainingDailyQuota() + ' 人まで送れます）');
}

function 初期設定() {
  requireAllScopes_();
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
    // 督促メール（第2段階）：総務は本番の送信アカウントの登録だけ
    const sset = ensureSheet_(soumu, '送信設定', ['項目', '値', '説明']);
    const oldValues = moveSendSettingsOut_(sset); // 前の版で総務にあった広報向けの設定を取り出す
    addSettingRows_(sset, SOUMU_SEND_ROWS);
    sset.setColumnWidth(1, 200); sset.setColumnWidth(2, 280); sset.setColumnWidth(3, 520);
    const oldRun = soumu.getSheetByName('送信実行');
    if (oldRun) oldRun.setName('旧_送信実行（広報へ移動）');
    protectSheet_(ensureSheet_(soumu, '送信記録', SEND_LOG_HEADERS), '自動記録');
    protectSheet_(ensureSheet_(soumu, '郵送リスト', null), '自動出力');
    removeDefaultSheet_(soumu);

    // ---- 広報ブック ----
    const kouhou = book_('kouhou');
    kouhou.setSpreadsheetTimeZone(APP.tz); kouhou.setSpreadsheetLocale('ja_JP');
    const tpl = ensureSheet_(kouhou, '文面', ['項目', '値', '説明']);
    if (tpl.getLastRow() < 3) {
      tpl.getRange(2, 1, 2, 3).setValues([
        ['件名', TEMPLATE_DEFAULT.subject, '改行なし・150文字以内'],
        ['本文', TEMPLATE_DEFAULT.body, '使える差し込み：' + Logic.MAIL_KEYS.map(k => '{{' + k + '}}').join(' ')],
      ]);
    }
    if (String(tpl.getRange(3, 2).getValue()) === TEMPLATE_OLD_BODY) tpl.getRange(3, 2).setValue(TEMPLATE_DEFAULT.body);
    tpl.getRange(3, 3).setValue('使える差し込み：' + Logic.MAIL_KEYS.map(k => '{{' + k + '}}').join(' ') + '（BCCで一斉のときは {{氏名}} {{登録番号}} 以外）');
    tpl.getRange(2, 2, 2, 1).setWrap(true);
    tpl.setColumnWidth(1, 80); tpl.setColumnWidth(2, 560); tpl.setColumnWidth(3, 300);
    protectRange_(tpl.getRange(1, 1, 3, 1), '項目名');
    ['督促対象', '文面の確認', '送信結果'].forEach(name => ensureSheet_(kouhou, name, null));
    protectSheet_(sheet_(kouhou, '文面の確認'), '自動出力');
    protectSheet_(sheet_(kouhou, '送信結果'), '自動出力');
    const kset = ensureSheet_(kouhou, '送信設定', ['項目', '値', '説明']);
    addSettingRows_(kset, KOUHOU_SEND_ROWS, oldValues);
    kset.getRange(sendSettingRow_(kset, '送信モード'), 2).setDataValidation(list_(Logic.MAIL_MODES));
    kset.getRange(sendSettingRow_(kset, '送り方'), 2).setDataValidation(list_(Logic.SEND_STYLES));
    kset.setColumnWidth(1, 200); kset.setColumnWidth(2, 280); kset.setColumnWidth(3, 560);
    protectRange_(kset.getRange(1, 1, kset.getMaxRows(), 1), '項目名');
    const run = ensureSheet_(kouhou, '送信実行', SEND_RUN_HEADERS);
    setupInputSheet_(run, SEND_RUN_HEADERS, {
      checkbox: '実行', auto: ['状態', '結果・確認内容', '確認キー', '受付ID', '処理日時'], hide: ['確認キー'],
      numbers: ['対象年度'], widths: { '結果・確認内容': 520 }, rows: 200,
    });
    removeDefaultSheet_(kouhou);

    // ---- 研修ブック ----
    const kenshu = book_('kenshu');
    setupKenshu_(kenshu);
    migrateApplyList_(kenshu);
    protectSheet_(ensureSheet_(soumu, '長期未納', null), '自動出力');

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
      .filter(t => TRIGGER_FNS.includes(t.getHandlerFunction()))
      .forEach(t => ScriptApp.deleteTrigger(t));
    ScriptApp.newTrigger('handleSoumuEdit').forSpreadsheet(soumu).onEdit().create();
    ScriptApp.newTrigger('handleKaikeiEdit').forSpreadsheet(kaikei).onEdit().create();
    ScriptApp.newTrigger('handleKouhouEdit').forSpreadsheet(kouhou).onEdit().create();
    ScriptApp.newTrigger('handleKenshuEdit').forSpreadsheet(kenshu).onEdit().create();
    ScriptApp.newTrigger('refreshTick').timeBased().everyMinutes(10).create();

    PropertiesService.getScriptProperties().setProperty('VERSION', APP.version);
    refreshAll_();
  });
  // メール送信の許可を確認する（許可画面で「メールの送信」が外れていると、ここで知らせる）
  try { MailApp.getRemainingDailyQuota(); }
  catch (err) {
    throw new Error('初期設定は済みましたが、メール送信が許可されていません。Googleアカウントの「サードパーティ製のアプリとサービス」でこのプロジェクトのアクセス権を削除してから、もう一度「初期設定」を実行し、許可画面で「すべて選択」にチェックしてください（' + err.message + '）');
  }
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
    else if (name === '送信設定') withLock_(() => { invalidateAllSends_(); refreshNow_(); });
  } catch (err) {
    logError_('総務', name, e.range.getRow(), err.message);
  }
}

function handleKouhouEdit(e) {
  if (!e || !e.range) return;
  const sh = e.range.getSheet(), name = sh.getName();
  try {
    if (name === '送信実行') onSendEdit_(e, sh);
    else if (name === '送信設定') withLock_(() => { invalidateAllSends_(); writeMailPreview_(loadContext_()); });
    else if (name === '文面' || name === '督促対象') { invalidateAllSends_(); if (name === '文面') withLock_(() => writeMailPreview_(loadContext_())); }
  } catch (err) {
    logError_('広報', name, e.range.getRow(), err.message);
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
    refreshNow_();
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
  refreshNow_();
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
// 日付のセルは編集時に通し番号（例 46297）で渡されるので、日付の形に直して記録する
function auditValue_(header, v, blank) {
  if (v === undefined || v === null || v === '') return blank;
  const s = String(v);
  if (['納期限', '入金日'].includes(String(header)) && /^\d+(\.\d+)?$/.test(s)) {
    return Utilities.formatDate(new Date(Math.round((Number(s) - 25569) * 86400000)), 'UTC', 'yyyy-MM-dd');
  }
  return s;
}
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
      safe_(auditValue_(head[0], e.oldValue, '')), safe_(auditValue_(head[0], e.value, '（空欄）'))]);
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
    refreshNow_();
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
  refreshNow_();
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
  refreshNow_();
}

/* ======================================================================
 * 督促メール（第2段階）
 * ====================================================================== */
function sendSettingRow_(sh, key) {
  const v = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 1).getValues();
  for (let i = 1; i < v.length; i++) if (String(v[i][0]).trim() === key) return i + 1;
  throw new Error('「' + sh.getParent().getName() + '」の「送信設定」に「' + key + '」の行がありません。「初期設定」を実行してください');
}

// 足りない行だけ追加する（values があれば、その値を初期値にする）
function addSettingRows_(sh, rows, values) {
  const have = sh.getLastRow() >= 2 ? sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues().map(r => String(r[0]).trim()) : [];
  rows.filter(r => !have.includes(r[0])).forEach(r => {
    const v = values && Object.prototype.hasOwnProperty.call(values, r[0]) && values[r[0]] !== '' ? values[r[0]] : r[1];
    sh.appendRow([r[0], v, r[2]]);
  });
}

// 前の版で総務の「送信設定」にあった広報向けの行を、値を控えてから取り除く
function moveSendSettingsOut_(sh) {
  const out = {};
  for (let r = sh.getLastRow(); r >= 2; r--) {
    const key = String(sh.getRange(r, 1).getValue()).trim();
    if (KOUHOU_SEND_ROWS.some(x => x[0] === key)) { out[key] = cell_(sh.getRange(r, 2).getValue()); sh.deleteRow(r); }
  }
  return out;
}

// 広報と総務の送信設定をまとめて読む
function sendSettings_() {
  const out = {};
  [[book_('kouhou'), KOUHOU_SEND_ROWS], [book_('soumu'), SOUMU_SEND_ROWS]].forEach(([ss, rows]) => {
    const sh = sheet_(ss, '送信設定');
    rows.forEach(r => { out[r[0]] = String(cell_(sh.getRange(sendSettingRow_(sh, r[0]), 2).getValue())).trim(); });
  });
  return out;
}

function mailTemplate_() {
  const sh = sheet_(book_('kouhou'), '文面'), v = sh.getRange(1, 1, Math.max(sh.getLastRow(), 1), 2).getValues();
  const get = k => { const r = v.find(x => String(x[0]).trim() === k); return r ? String(r[1]) : ''; };
  return { subject: get('件名'), body: get('本文') };
}

// 広報ブック「督促対象」の「送る」チェック（登録番号:年度 → true/false）
function sendSelection_() {
  const sh = book_('kouhou').getSheetByName('督促対象'), map = new Map();
  if (!sh || sh.getLastRow() < 3) return map;
  const head = sh.getRange(2, 1, 1, sh.getLastColumn()).getValues()[0].map(String);
  const ci = head.indexOf('送る'), ii = head.indexOf('登録番号'), yi = head.indexOf('年度');
  if (ci < 0 || ii < 0 || yi < 0) return map;
  sh.getRange(3, 1, sh.getLastRow() - 2, head.length).getValues().forEach(r => {
    const id = Logic.normId(r[ii], APP.idDigits);
    if (id) map.set(id + ':' + Number(r[yi]), r[ci] === true || String(r[ci]).toUpperCase() === 'TRUE');
  });
  return map;
}

function sendHistory_(soumu) {
  return readRows_(sheet_(soumu, '送信記録'), SEND_LOG_HEADERS, ['受付ID']).rows.map(r => ({
    id: Logic.normId(r['登録番号'], APP.idDigits), name: String(r['氏名']), year: Number(r['年度']), mode: String(r['モード']),
    result: String(r['結果']).startsWith('結果不明') ? '結果不明' : String(r['結果']), day: String(r['日時']).slice(0, 10), at: String(r['日時']),
  }));
}

// 文面・対象・設定が変わったら、確認待ちの送信をやり直してもらう
function invalidateAllSends_() {
  const sh = book_('kouhou').getSheetByName('送信実行');
  if (!sh || sh.getLastRow() < 2) return;
  const H = headerMap_(sh, SEND_RUN_HEADERS);
  const st = sh.getRange(2, H['状態'], sh.getLastRow() - 1, 1).getValues();
  st.forEach((v, i) => { if (String(v[0]) === '確認待ち') { const r = i + 2; sh.getRange(r, H['状態']).setValue(''); sh.getRange(r, H['結果・確認内容']).setValue('文面・送る相手・送信設定のどれかが変わりました。もう一度チェックして確認してください'); sh.getRange(r, H['確認キー']).setValue(''); } });
}

function onSendEdit_(e, sh) {
  const H = headerMap_(sh, SEND_RUN_HEADERS);
  if (isTick_(e, H, '実行')) {
    const row = e.range.getRow();
    try { withLock_(() => processSend_(sh, H, row)); }
    catch (err) {
      sh.getRange(row, H['状態']).setValue('エラー');
      sh.getRange(row, H['結果・確認内容']).setValue('エラー：' + err.message);
    } finally { sh.getRange(row, H['実行']).setValue(false); }
    return;
  }
  if (touches_(e, H, SEND_RUN_INPUTS)) invalidate_(sh, H, editedRows_(e));
}

function processSend_(sh, H, row) {
  const o = rowObject_(sh, H, row, SEND_RUN_HEADERS);
  if (String(o['状態']) === '完了') { sh.getRange(row, H['結果・確認内容']).setValue('この行は送信済みです。新しい送信は新しい行で行ってください'); return; }
  let receipt = String(o['受付ID']);
  if (!receipt) { receipt = Utilities.getUuid(); sh.getRange(row, H['受付ID']).setValue(receipt); }
  const ctx = loadContext_();
  const cfg = sendSettings_(), tpl = mailTemplate_();
  const plan = Logic.planSend({
    year: o['対象年度'], mode: cfg['送信モード'], style: cfg['送り方'], testTo: cfg['試験送信先'], account: Session.getEffectiveUser().getEmail(),
    allowed: cfg['本番で使う送信アカウント'], limit: cfg['1回の送信上限'], subject: tpl.subject, body: tpl.body,
    selected: sendSelection_(), history: sendHistory_(ctx.soumu), recentDays: APP.mailRecentDays,
  }, ctx);
  const key = Logic.hash(JSON.stringify(plan) + receipt + cfg['差出人の表示名'] + cfg['返信先']);
  if (String(o['状態']) !== '確認待ち' || String(o['確認キー']) !== key) {
    sh.getRange(row, H['状態']).setValue(plan.messages.length ? '確認待ち' : '');
    sh.getRange(row, H['結果・確認内容']).setValue(safe_(Logic.sendPreview(plan)));
    sh.getRange(row, H['確認キー']).setValue(plan.messages.length ? key : '');
    return;
  }
  const result = sendMessages_(ctx.soumu, plan, receipt, cfg);
  const left = plan.remaining + (plan.people - result.sent);
  sh.getRange(row, H['状態']).setValue(result.stopped ? '中断' : (left ? '一部完了' : '完了'));
  sh.getRange(row, H['結果・確認内容']).setValue(now_() + '：' + plan.mode + '（' + plan.style + '）で ' + result.sent + '名分を送りました（メール ' + result.mails + '通）' +
    (left ? '。残り ' + left + '名は、もう一度「実行」にチェックすると確認内容が出ます' : '') + (result.stopped ? '\n中断の理由：' + result.stopped : ''));
  sh.getRange(row, H['確認キー']).setValue('');
  sh.getRange(row, H['処理日時']).setValue(now_());
  refreshNow_();
}

// 送る前に宛先の全員を「送信中」と記録してから送る。結果が分からないものは自動で再送しない
function sendMessages_(soumu, plan, receipt, cfg) {
  const log = sheet_(soumu, '送信記録'), started = Date.now(), W = SEND_LOG_HEADERS.length;
  let sent = 0, mails = 0, stopped = '';
  for (const m of plan.messages) {
    if (Date.now() - started > 240000) { stopped = '時間の上限（4分）'; break; }
    if (MailApp.getRemainingDailyQuota() < m.members.length + 1) { stopped = 'このアカウントの1日の送信上限に近いため止めました（明日以降に続きを送ってください）'; break; }
    const r = log.getLastRow() + 1, stamp = now_();
    log.getRange(r, 1, m.members.length, W).setValues(m.members.map(x => [stamp, receipt, "'" + x.id, safe_(x.name), x.year,
      plan.mode === '試験' ? m.to + '（試験送信先）' : (m.bcc ? 'BCC：' + x.addr : x.addr), plan.mode, '送信中']));
    SpreadsheetApp.flush();
    const msg = { to: m.to, subject: m.subject, body: m.body, name: cfg['差出人の表示名'] || '日本樹木医会神奈川県支部' };
    if (m.bcc) msg.bcc = m.bcc;
    if (cfg['返信先']) msg.replyTo = cfg['返信先'];
    const results = r => log.getRange(r, W, m.members.length, 1);
    try { MailApp.sendEmail(msg); }
    catch (err) {
      results(r).setValues(m.members.map(() => [safe_('結果不明：' + err.message)]));
      logError_('広報', '送信実行', '', '督促メールの送信：' + err.message);
      stopped = 'メールの送信でエラー（' + err.message + '）。この宛先には自動で再送しません。届いたか確認してください';
      break;
    }
    results(r).setValues(m.members.map(() => [plan.mode === '試験' ? '試験送信済み' : '送信済み']));
    sent += m.members.length; mails++;
  }
  return { sent, mails, stopped };
}

// 広報ブックの「文面の確認」に、送るときの完成文の例を出す
function writeMailPreview_(ctx) {
  const sh = sheet_(book_('kouhou'), '文面の確認'), tpl = mailTemplate_();
  const style = sendSettings_()['送り方'] || 'BCCで一斉', bcc = style === 'BCCで一斉';
  const t = Logic.dunningTargets(ctx.members, ctx.fees, ctx.today).find(x => x.route === 'メール') ||
    { id: '0000', name: '（見本）樹木 太郎', year: Object.keys(ctx.settings).map(Number).sort().pop() || 2026, amount: 18000, due: ctx.today };
  let text;
  try {
    Logic.checkTemplate(tpl.subject, tpl.body);
    const s = ctx.settings[t.year];
    if (!s) throw new Error(t.year + '年度の年度設定がありません');
    text = '件名：' + tpl.subject + '\n\n' + Logic.renderMail(tpl.body, bcc ? Logic.commonTarget(t.year, s) : t, s, bcc);
  } catch (err) { text = '文面に問題があります：' + err.message; }
  sh.clearContents();
  sh.getRange(1, 1).setValue('文面の確認（最終更新 ' + now_() + '）　' + (bcc ? '送り方：BCCで一斉（全員に同じ文面）' : '送り方：1人ずつ（' + t.id + ' ' + t.name + ' さんに送る場合の例）')).setFontWeight('bold');
  sh.getRange(3, 1).setValue(safe_(text)).setWrap(true);
  sh.setColumnWidth(1, 700);
}

/* ======================================================================
 * 研修の申込と参加資格の照合（第3段階）
 *  - 研修一覧：研修を1行ずつ登録（研修IDは空欄なら「2026-01」の形で自動採番）
 *  - 申込_研修ID：研修会ごとの申込・判定・出欠（フォームの回答もここへ入る）
 *  - 年度集計_2026：年度ごとの出欠の一覧（だれがどの研修に出たか）
 * ====================================================================== */
function applySheetName_(id) { return '申込_' + id; }

function setupKenshu_(kenshu) {
  kenshu.setSpreadsheetTimeZone(APP.tz); kenshu.setSpreadsheetLocale('ja_JP');
  // 前の版の研修一覧には「年度」「申込シート」の列がない
  const old = kenshu.getSheetByName('研修一覧');
  addColumnAfter_(old, '開催日', '年度（自動）');
  addColumnAfter_(old, 'フォームURL（自動）', '申込シート（自動）');
  const tl = ensureSheet_(kenshu, '研修一覧', TRAINING_HEADERS);
  setupInputSheet_(tl, TRAINING_HEADERS, {
    checkbox: 'フォーム作成', auto: TRAINING_AUTO, hide: ['フォームID'], dates: ['開催日', '申込締切'], numbers: ['定員'], texts: ['研修ID'],
    widths: { '研修名': 220, '案内文': 260, 'フォームURL（自動）': 220, '申込シート（自動）': 140, '結果・確認内容': 360 }, rows: 200,
  });
  const TH = headerMap_(tl, TRAINING_HEADERS);
  TRAINING_AUTO.forEach(h => protectRange_(tl.getRange(1, TH[h], tl.getMaxRows(), 1), '自動列（' + h + '）'));
  kenshu.getSheets().filter(sh => sh.getName().startsWith('申込_')).forEach(setupApplySheet_);
  const hist = kenshu.getSheetByName('参加履歴'); // 前の版の自動出力（年度集計に置き換え）
  if (hist && kenshu.getSheets().length > 1) kenshu.deleteSheet(hist);
  const rule = ensureSheet_(kenshu, '判定の基準', null);
  rule.clearContents();
  rule.getRange(1, 1, JUDGE_RULES.length, 1).setValues(JUDGE_RULES.map(x => [x]));
  rule.getRange(1, 1).setFontWeight('bold');
  rule.setColumnWidth(1, 900);
  protectSheet_(rule, '自動出力');
  removeDefaultSheet_(kenshu);
}

function setupApplySheet_(sh) {
  ensureSheet_(sh.getParent(), sh.getName(), APPLY_HEADERS);
  setupInputSheet_(sh, APPLY_HEADERS, {
    auto: APPLY_AUTO, lists: { '区分': Logic.KUBUN, '研修担当の判断': Logic.OVERRIDES, '出欠': Logic.ATTEND }, texts: ['登録番号', '登録期'],
    widths: { '理由（自動）': 380, '連絡事項': 200, 'その他の回答': 200 }, rows: 300,
  });
  const AH = headerMap_(sh, APPLY_HEADERS);
  APPLY_AUTO.forEach(h => protectRange_(sh.getRange(1, AH[h], sh.getMaxRows(), 1), '自動列（' + h + '）'));
}

// 見出し after の右に、見出し name の列がなければ差し込む
function addColumnAfter_(sh, after, name) {
  if (!sh || sh.getLastColumn() < 1) return;
  const head = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0].map(v => String(v).trim());
  const i = head.indexOf(after);
  if (i < 0 || head.includes(name)) return;
  sh.insertColumnAfter(i + 1);
  sh.getRange(1, i + 2).setValue(name).setFontWeight('bold');
}

function handleKenshuEdit(e) {
  if (!e || !e.range) return;
  const sh = e.range.getSheet(), name = sh.getName();
  try {
    if (name === '研修一覧') onTrainingEdit_(e, sh);
    else if (name.startsWith('申込_')) withLock_(() => refreshKenshu_(loadContext_()));
  } catch (err) {
    logError_('研修', name, e.range.getRow(), err.message);
  }
}

function onTrainingEdit_(e, sh) {
  const H = headerMap_(sh, TRAINING_HEADERS);
  if (isTick_(e, H, 'フォーム作成')) {
    const row = e.range.getRow();
    try { withLock_(() => createForm_(sh, H, row)); }
    catch (err) { sh.getRange(row, H['結果・確認内容']).setValue('エラー：' + err.message); }
    finally { sh.getRange(row, H['フォーム作成']).setValue(false); }
    return;
  }
  if (touches_(e, H, TRAINING_INPUTS)) withLock_(() => refreshKenshu_(loadContext_()));
}

function readTrainings_(kenshu) {
  const sh = sheet_(kenshu, '研修一覧');
  const { H, rows } = readRows_(sh, TRAINING_HEADERS, TRAINING_INPUTS);
  const parsed = Logic.parseTrainings(rows.map(r => ({
    row: r._row, id: r['研修ID'], name: r['研修名'], date: r['開催日'], venue: r['会場'], deadline: r['申込締切'], capacity: r['定員'], guide: r['案内文'], formId: r['フォームID'],
  })));
  const prev = new Map(rows.map(r => [r._row, r]));
  parsed.list.forEach(t => {
    const r = prev.get(t.row) || {};
    t.prevState = String(r['受付（自動）'] || ''); t.prevMsg = String(r['結果・確認内容'] || ''); t.sheetName = String(r['申込シート（自動）'] || '');
    t.year = t.date ? Logic.fiscalYear(t.date, APP.fiscalStartMonth) : '';
    t.idOk = /^[0-9A-Za-z_-]{1,30}$/.test(t.id) && parsed.byId.get(t.id) === t;
  });
  return { sh, H, parsed };
}

// 研修IDが空欄で、研修名と開催日がある行に「2026-01」の形のIDを付ける
function assignTrainingIds_(kenshu) {
  const sh = sheet_(kenshu, '研修一覧');
  const { H, rows } = readRows_(sh, TRAINING_HEADERS, TRAINING_INPUTS);
  const ids = rows.map(r => Logic.text(r['研修ID']).normalize('NFKC')).filter(Boolean);
  rows.forEach(r => {
    const date = Logic.normDate(r['開催日']);
    if (Logic.text(r['研修ID']) || !Logic.text(r['研修名']) || !date) return;
    const id = Logic.nextTrainingId(ids, Logic.fiscalYear(date, APP.fiscalStartMonth));
    ids.push(id);
    sh.getRange(r._row, H['研修ID']).setValue(id);
  });
}

// 研修会ごとの申込シートを用意する（研修IDを変えたらシート名も合わせる）
function ensureApplySheets_(kenshu, tr) {
  tr.parsed.list.forEach(t => {
    if (!t.idOk) { t.sheet = t.sheetName ? kenshu.getSheetByName(t.sheetName) : null; return; }
    const want = applySheetName_(t.id);
    let sh = kenshu.getSheetByName(want);
    const prev = t.sheetName && t.sheetName !== want ? kenshu.getSheetByName(t.sheetName) : null;
    if (!sh && prev) { prev.setName(want); sh = prev; }
    if (!sh) { sh = kenshu.insertSheet(want, 1); setupApplySheet_(sh); }
    t.sheet = sh;
    if (t.sheetName !== want) { tr.sh.getRange(t.row, tr.H['申込シート（自動）']).setValue(want); t.sheetName = want; }
  });
}

// 前の版の「申込一覧」（全研修を1枚）を、研修会ごとのシートへ移す（1回だけ。元のシートは名前を変えて残す）
function migrateApplyList_(kenshu) {
  const old = kenshu.getSheetByName('申込一覧');
  if (!old) return;
  const tr = readTrainings_(kenshu);
  ensureApplySheets_(kenshu, tr);
  const width = old.getLastColumn(), last = old.getLastRow();
  const head = width ? old.getRange(1, 1, 1, width).getValues()[0].map(v => String(v).trim()) : [];
  const ti = head.indexOf('研修ID'), left = [], out = new Map();
  if (last >= 2 && ti >= 0) {
    old.getRange(2, 1, last - 1, width).getValues().forEach((r, i) => {
      if (r.every(v => String(cell_(v)).trim() === '')) return;
      const t = tr.parsed.byId.get(Logic.text(r[ti]).normalize('NFKC'));
      if (!t || !t.sheet) { left.push(i + 2); return; }
      if (!out.has(t.sheet)) out.set(t.sheet, []);
      out.get(t.sheet).push(r);
    });
  }
  out.forEach((list, sh) => {
    const AH = headerMap_(sh, APPLY_HEADERS);
    const have = new Set(), l = lastDataRow_(sh, AH['受付ID']);
    if (l >= 2) sh.getRange(2, AH['受付ID'], l - 1, 1).getValues().forEach(x => have.add(String(x[0])));
    const rows = list.filter(r => { const rid = String(r[head.indexOf('受付ID')] || ''); return !rid || !have.has(rid); }).map(r => {
      const row = new Array(AH._width).fill('');
      APPLY_HEADERS.forEach(h => { const j = head.indexOf(h); if (j >= 0) row[AH[h] - 1] = idCell_(r[j]); });
      return row;
    });
    if (!rows.length) return;
    const start = sh.getLastRow() + 1;
    ensureRows_(sh, start + rows.length);
    sh.getRange(start, 1, rows.length, AH._width).setValues(rows);
  });
  old.setName(left.length ? '旧_申込一覧（' + left.length + '行は移せませんでした）' : '旧_申込一覧（移行済み）');
  if (left.length) logError_('研修', '申込一覧', '', '研修IDが研修一覧にないため、研修会ごとのシートへ移せなかった行：' + left.join('、') + '行目');
}

// 研修ごとに申込フォームを1つ作る。回答はフォームに貯まり、このシステムがその研修の申込シートへ取り込む（回答用のシートは作らない）
function createForm_(sh, H, row) {
  const t = readTrainings_(sh.getParent()).parsed.list.find(x => x.row === row);
  if (!t) throw new Error('研修ID・研修名・開催日を入力してください');
  if (!t.ok) throw new Error(t.errors.join('／'));
  if (t.formId) { sh.getRange(row, H['結果・確認内容']).setValue('フォームは作成済みです。編集：' + FormApp.openById(t.formId).getEditUrl()); return; }
  if (today_() > (t.deadline || t.date)) throw new Error('申込締切（空欄なら開催日）を過ぎているため、フォームは作りません');
  const txt = Logic.formText(t);
  let form;
  try { form = FormApp.create(txt.title); }
  catch (err) { throw new Error('フォームを作れませんでした。Apps Script で「初期設定」をもう一度実行し、許可画面で「すべて選択」にしてください（' + err.message + '）'); }
  form.setDescription(txt.description);
  form.setCollectEmail(true);
  form.setAllowResponseEdits(false);
  form.setShowLinkToRespondAgain(false);
  form.setConfirmationMessage('お申し込みを受け付けました。ありがとうございました。');
  form.setCustomClosedFormMessage('この研修の申込の受付は終了しました（締切または定員）。');
  try { form.setRequireLogin(false); } catch (ignore) { /* 個人のGoogleアカウントでは設定不要（もともとログイン不要） */ }
  ensureFormItems_(form);
  sh.getRange(row, H['フォームID']).setValue(form.getId());
  sh.getRange(row, H['フォームURL（自動）']).setValue(form.getPublishedUrl());
  PropertiesService.getScriptProperties().setProperty('FORMTXT_' + form.getId(), formHash_(t));
  sh.getRange(row, H['結果・確認内容']).setValue(now_() + '：フォームを作りました。「フォームURL」を会員に案内してください。質問の追加や文面の調整は編集画面で（標準の質問「' + Object.values(Logic.FORM_ITEMS).join('」「') + '」の題名は変えないでください）：' + form.getEditUrl());
  refreshKenshu_(loadContext_());
}

// フォームの題名・説明と標準の質問。標準の質問が変わったら（版の更新など）作成済みのフォームにも足す
function formHash_(t) { return Logic.hash(JSON.stringify([Logic.formText(t), Logic.FORM_ITEMS])); }

function ensureFormItems_(form) {
  const I = Logic.FORM_ITEMS;
  const pattern = p => FormApp.createTextValidation().setHelpText('数字で入力してください').requireTextMatchesPattern(p).build();
  const makers = {
    kind: () => form.addMultipleChoiceItem().setTitle(I.kind).setChoiceValues(Logic.KUBUN).setRequired(true),
    id: () => form.addTextItem().setTitle(I.id).setHelpText('神奈川県支部の会員・他支部の樹木医の方は、樹木医の登録番号を入力してください（一般の方は空欄）')
      .setValidation(pattern('^\\s*[0-9０-９]{1,6}\\s*$')),
    cohort: () => form.addTextItem().setTitle(I.cohort).setHelpText('樹木医の方は、何期の登録かを入力してください（例：21）。一般の方は空欄')
      .setValidation(pattern('^\\s*第?\\s*[0-9０-９]{1,3}\\s*期?\\s*$')),
    name: () => form.addTextItem().setTitle(I.name).setRequired(true),
    org: () => form.addTextItem().setTitle(I.org).setHelpText('他支部の樹木医・一般の方は、所属や勤務先をご記入ください（任意）'),
    note: () => form.addParagraphTextItem().setTitle(I.note),
  };
  const keys = Object.keys(I);
  keys.forEach((k, n) => {
    const titles = () => form.getItems().map(x => x.getTitle());
    if (titles().includes(I[k])) return;
    makers[k]();
    // 直前の標準の質問のすぐ後ろへ移す
    const prev = n > 0 ? titles().indexOf(I[keys[n - 1]]) : -1;
    const last = form.getItems().length - 1;
    if (prev + 1 < last) form.moveItem(last, prev + 1);
  });
}

function addDays_(day, n) { return Utilities.formatDate(new Date(toDate_(day).getTime() + n * 86400000), APP.tz, 'yyyy-MM-dd'); }
function idCell_(v) { return typeof v === 'string' && /^\d+$/.test(v) ? "'" + v : safe_(v); }

// フォームの新しい回答を、その研修の申込シートへ取り込む（何度実行しても同じ回答は1回だけ）
function syncForms_() {
  const kenshu = book_('kenshu'), today = today_();
  const tr = readTrainings_(kenshu);
  const active = tr.parsed.list.filter(t => t.ok && t.formId && today <= addDays_(t.date, 7));
  if (!active.length) return 0;
  ensureApplySheets_(kenshu, tr);
  let added = 0;
  active.forEach(t => {
    if (!t.sheet) return;
    let form;
    try { form = FormApp.openById(t.formId); }
    catch (err) { logError_('研修', '研修一覧', t.row, 'フォームを開けません（' + t.id + '）：' + err.message); return; }
    const ap = t.sheet, AH = headerMap_(ap, APPLY_HEADERS);
    const have = new Set(), last = lastDataRow_(ap, AH['受付ID']);
    if (last >= 2) ap.getRange(2, AH['受付ID'], last - 1, 1).getValues().forEach(r => have.add(String(r[0])));
    const add = [];
    form.getResponses().forEach(res => {
      const rid = 'F-' + res.getId();
      if (have.has(rid)) return;
      have.add(rid);
      const a = Logic.mapAnswers(res.getItemResponses().map(ir => [ir.getItem().getTitle(), ir.getResponse()]));
      const row = new Array(AH._width).fill('');
      const put = (h, v) => { row[AH[h] - 1] = idCell_(v); };
      put('受付ID', rid); put('受付日時', Utilities.formatDate(res.getTimestamp(), APP.tz, 'yyyy-MM-dd HH:mm:ss'));
      put('区分', a.kind); put('登録番号', a.id); put('登録期', a.cohort); put('氏名', a.name); put('メール', String(res.getRespondentEmail() || ''));
      put('所属・勤務先', a.org); put('連絡事項', a.note); put('その他の回答', a.other);
      add.push(row);
    });
    if (!add.length) return;
    const start = ap.getLastRow() + 1;
    ensureRows_(ap, start + add.length);
    ap.getRange(start, 1, add.length, AH._width).setValues(add);
    added += add.length;
  });
  return added;
}

// 指定した列だけを書き換える（研修担当が入力するほかの列には触れない）
function patchColumns_(sh, H, last, patches) {
  if (last < 2) return;
  const headers = [...new Set([].concat(...[...patches.values()].map(o => Object.keys(o))))];
  headers.forEach(h => {
    const range = sh.getRange(2, H[h], last - 1, 1), v = range.getValues();
    let changed = false;
    patches.forEach((o, r) => {
      if (!(h in o) || String(cell_(v[r - 2][0])) === String(o[h])) return;
      v[r - 2][0] = o[h]; changed = true;
    });
    if (changed) range.setValues(v.map(x => [idCell_(x[0])]));
  });
}

// 1つの研修の申込シートを判定し、集計を返す
function judgeTrainingSheet_(t, jctx, today, stamp) {
  const s = { apply: 0, '参加可': 0, '要確認': 0, '参加不可': 0, [Logic.EXTERNAL]: 0, attend: 0, apps: [] };
  if (!t.sheet) return s;
  const { H: AH, rows } = readRows_(t.sheet, APPLY_HEADERS, APPLY_INPUTS.concat(['受付ID']));
  const seen = new Map(), patches = new Map();
  rows.forEach(r => {
    const rid = String(r['受付ID']) || 'M-' + Utilities.getUuid().slice(0, 8);
    const att = String(r['出欠']);
    let result = String(r['判定（自動）']), reason = String(r['理由（自動）']), day = String(r['判定日（自動）']);
    const id = Logic.normId(r['登録番号'], APP.idDigits);
    const who = id || Logic.nameKey(r['氏名']);
    const dup = att !== '申込取消' && seen.has(who);
    if (att !== '申込取消' && !dup) seen.set(who, rid);
    // 研修一覧のこの行に誤りがある間と、開催日を過ぎた後は、判定を変えない
    if (t.ok && !(result && today > t.date)) {
      const j = Logic.judgeApplication({ kind: r['区分'], id: r['登録番号'], cohort: r['登録期'], name: r['氏名'] }, t, jctx);
      result = j.result; reason = j.reason; day = today;
      if (dup) { result = '要確認'; reason = '同じ研修への申込が重複しています（先の受付：' + seen.get(who) + '）／' + reason; }
    }
    const final = String(r['研修担当の判断']) || result;
    patches.set(r._row, { '受付ID': rid, '受付日時': String(r['受付日時']) || stamp, '判定（自動）': result, '理由（自動）': reason, '最終（自動）': final, '判定日（自動）': day });
    if (att !== '申込取消' && !dup) { s.apply++; if (final in s) s[final]++; }
    if (att === '出席') s.attend++;
    s.apps.push({ kind: String(r['区分']), id: id || '', name: String(r['氏名']), att, dup });
  });
  patchColumns_(t.sheet, AH, rows.length ? Math.max(...rows.map(r => r._row)) : 1, patches);
  return s;
}

function refreshKenshu_(ctx) {
  const kenshu = book_('kenshu'), today = ctx.today, stamp = now_();
  assignTrainingIds_(kenshu);
  const tr = readTrainings_(kenshu);
  ensureApplySheets_(kenshu, tr);
  const jctx = { digits: APP.idDigits, membersById: ctx.membersById, fees: ctx.fees, settings: ctx.settings, startMonth: APP.fiscalStartMonth };
  const props = PropertiesService.getScriptProperties(), tp = new Map(), byYear = new Map();
  tr.parsed.list.forEach(t => {
    const s = judgeTrainingSheet_(t, jctx, today, stamp);
    const state = Logic.trainingState(t, s.apply, today);
    const p = {
      '年度（自動）': t.year, '受付（自動）': state, '申込（自動）': s.apply, '参加可（自動）': s['参加可'], '要確認（自動）': s['要確認'],
      '参加不可（自動）': s['参加不可'], '外部（自動）': s[Logic.EXTERNAL], '出席（自動）': s.attend,
    };
    if (!t.ok) p['結果・確認内容'] = '入力を確認：' + t.errors.join('／');
    else if (t.prevMsg.startsWith('入力を確認：')) p['結果・確認内容'] = '';
    if (t.ok && t.formId && state !== '終了（開催済み）') {
      const txtHash = formHash_(t);
      if (state !== t.prevState || props.getProperty('FORMTXT_' + t.formId) !== txtHash) {
        try {
          const form = FormApp.openById(t.formId), txt = Logic.formText(t);
          form.setAcceptingResponses(state === '受付中');
          if (props.getProperty('FORMTXT_' + t.formId) !== txtHash) { form.setTitle(txt.title); form.setDescription(txt.description); ensureFormItems_(form); props.setProperty('FORMTXT_' + t.formId, txtHash); }
        } catch (err) { logError_('研修', '研修一覧', t.row, 'フォームを更新できません（' + t.id + '）：' + err.message); }
      }
    } else if (t.ok && t.formId && state === '終了（開催済み）' && t.prevState !== state) {
      try { FormApp.openById(t.formId).setAcceptingResponses(false); } catch (err) { logError_('研修', '研修一覧', t.row, 'フォームを閉じられません：' + err.message); }
    }
    tp.set(t.row, p);
    if (t.ok) { if (!byYear.has(t.year)) byYear.set(t.year, []); byYear.get(t.year).push({ t, apps: s.apps }); }
  });
  patchColumns_(tr.sh, tr.H, tr.parsed.list.length ? Math.max(...tr.parsed.list.map(t => t.row)) : 1, tp);

  // 年度ごとの出欠の一覧
  byYear.forEach((list, year) => {
    const name = '年度集計_' + year;
    let sh = kenshu.getSheetByName(name);
    if (!sh) { sh = kenshu.insertSheet(name); protectSheet_(sh, '自動出力'); }
    list.sort((a, b) => (a.t.date < b.t.date ? -1 : a.t.date > b.t.date ? 1 : 0));
    writeTable_(sh, year + '年度の研修の出欠（最終更新 ' + stamp + '）　出席・欠席・取消は各研修の申込シートの「出欠」から。「申込」は出欠が未入力', Logic.yearAttendance(list));
  });
  props.setProperty('KENSHU_DAY', today);
}

// 試験用：研修2件と、判定の見本になる申込を手入力の形で入れる
function 研修の架空データを入れる() {
  withLock_(() => {
    const kenshu = book_('kenshu');
    const tl = sheet_(kenshu, '研修一覧'), TH = headerMap_(tl, TRAINING_HEADERS);
    if (lastDataRow_(tl, TH['研修ID']) > 1 || lastDataRow_(tl, TH['研修名']) > 1) throw new Error('研修一覧に既にデータがあるため、架空データは入れません');
    [['TEST-01', '架空・夏の研修（納期限前）', '2026-07-20', '架空会館', '2026-07-10', '', '動作確認用の架空の研修です。'],
      ['TEST-02', '架空・秋の研修（納期限後）', '2026-11-15', '架空公園', '2026-11-01', 30, '動作確認用の架空の研修です。']].forEach((v, i) => {
      const r = 2 + i;
      tl.getRange(r, TH['研修ID']).setValue(v[0]); tl.getRange(r, TH['研修名']).setValue(v[1]); tl.getRange(r, TH['開催日']).setValue(toDate_(v[2]));
      tl.getRange(r, TH['会場']).setValue(v[3]); tl.getRange(r, TH['申込締切']).setValue(toDate_(v[4])); tl.getRange(r, TH['定員']).setValue(v[5]); tl.getRange(r, TH['案内文']).setValue(v[6]);
    });
    ensureApplySheets_(kenshu, readTrainings_(kenshu));
    const K = Logic.KUBUN;
    const apps = {
      'TEST-01': [[K[0], '0004', '架空 梅二', '28']],
      'TEST-02': [[K[0], '0001', '架空 桜子', '21期'], [K[0], '0003', '架空 松美', '第27期'], [K[0], '0004', '架空 梅二', '28'], [K[0], '0006', '架空 楓', '30'],
        [K[0], '0001', '架空 さくら', '21'], [K[1], '1234', '他支部 花子', '25'], [K[2], '', '一般 次郎', '']],
    };
    Object.keys(apps).forEach(id => {
      const ap = sheet_(kenshu, applySheetName_(id)), AH = headerMap_(ap, APPLY_HEADERS);
      apps[id].forEach((v, i) => {
        const r = 2 + i;
        ap.getRange(r, AH['区分']).setValue(v[0]); ap.getRange(r, AH['登録番号']).setValue(idCell_(v[1]));
        ap.getRange(r, AH['氏名']).setValue(v[2]); ap.getRange(r, AH['登録期']).setValue(idCell_(v[3]));
      });
    });
    refreshKenshu_(loadContext_());
  });
  console.log('研修の架空データを入れました。研修ブックの「申込_TEST-02」などで判定を確認してください');
}

/* ======================================================================
 * 一覧・集計の更新
 * ====================================================================== */
function refreshTick() {
  const p = PropertiesService.getScriptProperties();
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return; // 次の回に更新する
  try {
    let added = 0;
    try { added = syncForms_(); } catch (err) { logError_('研修', 'フォームの取り込み', '', err.message); }
    if (p.getProperty('DIRTY') === '1') { p.deleteProperty('DIRTY'); refreshAll_(); }
    // 新しい申込があったとき、また日付が変わったとき（締切でフォームを閉じる）は研修の判定を更新
    else if (added || p.getProperty('KENSHU_DAY') !== today_()) refreshKenshu_(loadContext_());
  }
  catch (err) { p.setProperty('DIRTY', '1'); logError_('全体', '一覧の更新', '', err.message); }
  finally { lock.releaseLock(); }
}

function 今すぐ一覧を更新() {
  withLock_(() => {
    PropertiesService.getScriptProperties().deleteProperty('DIRTY');
    try { syncForms_(); } catch (err) { logError_('研修', 'フォームの取り込み', '', err.message); }
    refreshAll_();
  });
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

  // 督促（第2段階）：広報の督促対象・文面の確認・送信結果、総務の郵送リスト
  refreshDunning_(ctx, stamp);

  // 研修（第3段階）：申込の判定（失敗してもほかの一覧の更新は続ける）
  try { refreshKenshu_(ctx); } catch (err) { logError_('研修', '研修一覧', '', err.message); }

  // 長期未納（2年度分以上・納期限経過）の在籍会員
  const longs = Logic.longUnpaid(ctx.members, ctx.fees, ctx.today);
  writeTable_(sheet_(ctx.soumu, '長期未納'), '長期未納（最終更新 ' + stamp + '）　2年度分以上の会費が未納（納期限経過）の在籍会員。規約により退会の扱い。手続きは「異動受付」で「退会」を処理してください', {
    header: ['登録番号', '氏名', '登録期', '未納の年度', '未納額の合計'],
    rows: longs.map(x => [x.id, x.name, x.cohort, x.years.join('・'), x.total]),
  }, ['未納額の合計']);

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
  const dun = Logic.dunningTargets(ctx.members, ctx.fees, ctx.today);
  const sc = sendSettings_();
  rows.push(['督促メールの送信モード（広報が操作）', (sc['送信モード'] || '（未設定）') + '／本番の送信アカウント：' + (sc['本番で使う送信アカウント'] || '未登録（本番送信はできません）')]);
  rows.push(['督促の対象（在籍・納期限超過の未納）', 'メール ' + dun.filter(t => t.route === 'メール').length + '件／郵送 ' + dun.filter(t => t.route === '郵送').length + '件／要確認 ' + dun.filter(t => t.route === '要確認').length + '件']);
  rows.push(['長期未納（2年度分以上・退会の扱い）', longs.length ? longs.length + '名（「長期未納」シートを参照）' : 'なし']);
  rows.push(['会計ブック', 'https://docs.google.com/spreadsheets/d/' + APP.books.kaikei + '/edit']);
  rows.push(['広報ブック', 'https://docs.google.com/spreadsheets/d/' + APP.books.kouhou + '/edit']);
  rows.push(['研修ブック', 'https://docs.google.com/spreadsheets/d/' + APP.books.kenshu + '/edit']);
  const admin = sheet_(ctx.soumu, '管理');
  admin.getRange(2, 1, Math.max(admin.getMaxRows() - 1, 1), 2).clearContent();
  admin.getRange(2, 1, rows.length, 2).setValues(rows.map(r => [r[0], safe_(String(r[1]))])).setWrap(true);
  admin.setColumnWidth(1, 260); admin.setColumnWidth(2, 560);
}

function refreshDunning_(ctx, stamp) {
  const kouhou = book_('kouhou');
  const targets = Logic.dunningTargets(ctx.members, ctx.fees, ctx.today);
  const history = sendHistory_(ctx.soumu);
  const last = new Map();
  history.forEach(h => { if (h.id) last.set(h.id + ':' + h.year, h.at + ' ' + h.result + (h.mode === '試験' ? '（試験）' : '')); });
  const keep = sendSelection_();
  const tsh = sheet_(kouhou, '督促対象');
  writeTable_(tsh, '督促対象（最終更新 ' + stamp + '）　在籍者で納期限を過ぎた「未納」。メールを送らない人は「送る」のチェックを外してください', {
    header: ['送る', '登録番号', '氏名', '登録期', '年度', '請求金額', '納期限', '送り方', '備考', '最終送信'],
    rows: targets.map(t => [t.route === 'メール' ? (keep.has(t.id + ':' + t.year) ? keep.get(t.id + ':' + t.year) : true) : false,
      t.id, t.name, t.cohort, t.year, t.amount, t.due, t.route, t.note, last.get(t.id + ':' + t.year) || '']),
  }, ['請求金額']);
  if (tsh.getMaxRows() > 2) tsh.getRange(3, 1, tsh.getMaxRows() - 2, 1).clearDataValidations();
  if (targets.length) tsh.getRange(3, 1, targets.length, 1).insertCheckboxes();
  const p = tsh.getProtections(SpreadsheetApp.ProtectionType.SHEET).find(x => x.getDescription() === '自動出力（「送る」だけ変更可）') ||
    tsh.protect().setDescription('自動出力（「送る」だけ変更可）');
  p.setUnprotectedRanges(targets.length ? [tsh.getRange(3, 1, targets.length, 1)] : []);
  const me = Session.getEffectiveUser();
  p.addEditor(me); p.removeEditors(p.getEditors().filter(u => u.getEmail() !== me.getEmail()));
  if (p.canDomainEdit()) p.setDomainEdit(false);

  writeMailPreview_(ctx);
  writeTable_(sheet_(kouhou, '送信結果'), '送信結果（最終更新 ' + stamp + '）　宛先のアドレスは総務だけが見られます', {
    header: ['日時', '登録番号', '氏名', '年度', 'モード', '結果'],
    rows: history.slice().reverse().map(h => [h.at, h.id || '', h.name, h.year, h.mode, h.result]),
  });

  // 郵送リスト（総務。住所を含むので総務のブックにだけ出す）
  const roster = sheet_(ctx.soumu, '正本');
  let addr = new Map();
  try {
    readRows_(roster, ['登録番号', '自宅〒', '自宅住所'], ['登録番号']).rows.forEach(r => addr.set(Logic.normId(r['登録番号'], APP.idDigits), [r['自宅〒'], r['自宅住所']]));
  } catch (ignore) { addr = new Map(); }
  const postal = targets.filter(t => t.route === '郵送');
  writeTable_(sheet_(ctx.soumu, '郵送リスト'), '郵送リスト（最終更新 ' + stamp + '）　会費案内先のメールがない、在籍・納期限超過の未納者', {
    header: ['登録番号', '氏名', '年度', '請求金額', '納期限', '自宅〒', '自宅住所'],
    rows: postal.map(t => [t.id, t.name, t.year, t.amount, t.due].concat(addr.get(t.id) || ['', ''])),
  }, ['請求金額']);
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
  for (let c = 2; c <= width; c++) sh.setColumnWidth(c, 130);
  sh.setColumnWidth(1, 90);
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
      ['0004', '未納', 0, '', '架空：督促メールの試験用（メールあり・納期限超過）'],
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
    .filter(t => TRIGGER_FNS.includes(t.getHandlerFunction()))
    .forEach(t => ScriptApp.deleteTrigger(t));
  console.log('自動処理を止めました。再開するには「初期設定」を実行してください');
}

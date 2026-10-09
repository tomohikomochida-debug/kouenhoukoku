/****************************************************************
 * 庭乃持田園 タイムカード — GAS 本体（app=timecard）
 *
 *  ・打刻（出勤・退勤・位置・電波なしの後送り）、あとから入力・修正（理由と修正履歴）
 *  ・休みの登録（出勤調整カレンダーに「表示名」「表示名 午前休」で入れる）、有休・欠勤の確認
 *  ・20日締め、年間休日カレンダー（会社の休みを出勤調整カレンダーに「@all」で入れる）
 *  ・本人確認：4桁の暗証番号（暗号化してスクリプト プロパティに保存。シートには置かない）
 *
 * ───────── 置き方 ─────────
 *  この本体は GitHub（kouenhoukoku/gas/timecard_app.gs）に置き、
 *  現場アプリの本体（gas/genba_app.gs）が app=timecard のときに読み込みます。
 *  GAS の貼り直し・デプロイのし直しは不要。ここを直して GitHub に上げれば数分で反映されます。
 *
 *  データ：Google ドライブ「社内アプリ ＞ タイムカード ＞ タイムカードデータ」
 *  スクリプト プロパティ（どれも任意。なければ既定値）
 *   TC_SHEET_ID … データのスプレッドシート
 *   HOLIDAY_CALENDAR … 出勤調整カレンダーの名前（現場アプリと共通。既定「出勤調整カレンダー」）
 ****************************************************************/

const VERSION = '1.1.0';
const DEFAULT_SHEET_ID = '1Iw--r2mcrZDROzpj3Gsa2MJHXSidP89CX0tXTl5ul-s';
const DEFAULT_APP_URL = 'https://tomohikomochida-debug.github.io/kouenhoukoku/timecard.html';
/** 親方・事務担当の最初の登録（合言葉のハッシュ。合言葉そのものはここにない）。暗証番号がまだない人だけ・期限まで使える */
const BOOTSTRAP = [
  { staffId: '4',  hash: 'e432df3c33bc2666a853920bb0ffa31d809979de793a9ea336f51d014b7ec9ba' },
  { staffId: '22', hash: '5ac58659b3bdd0206b4ae8caa2967c2a6862723f4dd28ff284ada6a01f271e3e' },
];
const BOOTSTRAP_UNTIL = '2026-12-31';
const TZ = 'Asia/Tokyo';
const HOLIDAY_CAL_ID = 'ja.japanese#holiday@group.v.calendar.google.com';
const SESSION_DAYS = 365;
const PIN_MAX_FAILS = 5;
const PIN_LOCK_MIN = 15;
const CODE_MIN = { qr: 10, temp: 60 * 24 };

const SHEETS = {
  staff:    ['id', 'name', 'disp', 'freeeNo', 'setting', 'pay', 'role', 'punch', 'join', 'active'],
  days:     ['key', 'staffId', 'date', 'kind', 'half', 'pay', 'leaveBy', 'in', 'out', 'brk', 'site', 'src', 'by', 'lag', 'bio', 'gps', 'lat', 'lng', 'acc', 'checked', 'updatedAt', 'dist', 'away', 'direct', 'outSite', 'outDist'],
  punches:  ['receivedAt', 'staffId', 'type', 'pressedAt', 'date', 'time', 'lat', 'lng', 'acc', 'site', 'clientId', 'bio', 'device'],
  history:  ['at', 'by', 'staffId', 'date', 'field', 'before', 'after', 'reason'],
  calendar: ['date', 'off'],
  closings: ['period', 'status', 'by', 'at'],
  settings: ['key', 'value'],
};
const AUTH_SHEETS = {
  pins:     ['staffId', 'salt', 'hash', 'fails', 'lockedUntil', 'updatedAt'],
  sessions: ['tokenHash', 'staffId', 'device', 'createdAt', 'lastUsed', 'expiresAt'],
  codes:    ['codeHash', 'staffId', 'kind', 'expiresAt', 'usedAt', 'by', 'createdAt'],
};
const DEFAULT_SETTINGS = { start: '07:30', end: '17:10', break: '100', useFrom: '',
  // 朝の出勤は事務所で押す。事務所（川崎市高津区向ケ丘94-2）から離れて出勤を押したら知らせる
  officeLat: '35.594349', officeLng: '139.595978', officeR: '150', officeCheck: '1' };
const DATE_COLS = { date: 1, join: 1, useFrom: 1 };
const TIME_COLS = { in: 1, out: 1, start: 1, end: 1 };
const KINDS = ['出勤', '休日出勤', '休み', '振休', '代休', '雨天中止（半日）', '雨天中止（全日）', '公休'];
const REASONS = ['打ち忘れ', '電池切れ', '電波なし', '時刻の間違い', '暗証番号忘れ', 'その他'];

/* ===================== 入口 ===================== */

function doGet(e) {
  const a = (e && e.parameter && e.parameter.action) || 'ping';
  if (a === 'ping') { try { ensureInit_(); return out_({ ok: true, app: 'timecard', version: VERSION }); } catch (x) { return out_({ ok: false, error: x.message }); } }
  return out_({ ok: false, error: 'POST で呼び出してください' });
}

function doPost(e) {
  let body = {};
  try {
    body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    ensureInit_();
    const fn = API[body.action];
    if (!fn) throw err_('知らない操作です：' + body.action);
    return out_(Object.assign({ ok: true }, fn(body) || {}));
  } catch (x) {
    return out_({ ok: false, error: x.message || String(x), code: x.code || '' });
  }
}

function out_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}
function err_(msg, code) { const x = new Error(msg); x.code = code || ''; return x; }

/* ===================== API ===================== */

const API = {
  ping: () => ({ version: VERSION }),

  /** ログイン画面の名前一覧 */
  names: () => ({
    names: staffAll_().filter(s => s.active && (s.punch || isAdminRole_(s.role))).map(s => ({ id: s.id, disp: s.disp, name: s.name })),
  }),

  /** 登録コード → 暗証番号を決めてログイン */
  enroll: b => withLock_(() => {
    const raw = String(b.code || '').trim();
    checkPin_(b.pin);
    enrollGuard_(false);
    if (/^[A-Za-z0-9]{20,}$/.test(raw)) return bootstrapEnroll_(raw, b);
    const code = raw.replace(/\D/g, '');
    if (code.length !== 6) throw err_('登録コードは6桁です');
    const t = authTable_('codes');
    const now = Date.now();
    const hit = t.rows.find(r => r.codeHash === sha_(code) && !r.usedAt && Number(r.expiresAt) > now);
    if (!hit) { enrollGuard_(true); throw err_('登録コードが違うか、期限が切れています。担当に出し直してもらってください'); }
    const st = staffById_(hit.staffId);
    if (!st || !st.active) throw err_('この登録コードの人は登録されていません');
    t.update(hit, { usedAt: iso_(new Date()) });
    setPin_(st.id, b.pin);
    revokeSessions_(st.id);
    const token = newSession_(st.id, b.device);
    addHistory_(st.disp, st.id, '', '登録', '', 'この端末で登録', hit.kind === 'qr' ? '登録用QRコード' : '仮の番号');
    return { token, me: mePayload_(st) };
  }),

  /** 名前と暗証番号でログイン */
  login: b => withLock_(() => {
    const st = staffById_(b.staffId);
    if (!st || !st.active) throw err_('名前が見つかりません');
    verifyPin_(st.id, b.pin);
    return { token: newSession_(st.id, b.device), me: mePayload_(st) };
  }),

  /** 生体認証がうまくいかないときの暗証番号の確認 */
  verifyPin: b => withLock_(() => { const me = auth_(b); verifyPin_(me.id, b.pin); return {}; }),

  me: b => ({ me: mePayload_(auth_(b)) }),

  logout: b => withLock_(() => {
    const t = authTable_('sessions');
    const hit = t.rows.find(r => r.tokenHash === sha_(String(b.token || '')));
    if (hit) t.remove(hit);
    return {};
  }),

  changePin: b => withLock_(() => {
    const me = auth_(b);
    verifyPin_(me.id, b.oldPin);
    checkPin_(b.pin);
    setPin_(me.id, b.pin);
    return {};
  }),

  /** 画面に必要なデータをまとめて返す */
  data: b => {
    const me = auth_(b);
    const admin = isAdminRole_(me.role);
    const from = normDate_(b.from), to = normDate_(b.to);
    if (!from || !to) throw err_('期間がありません');
    const ids = admin ? null : [me.id];
    const days = dataTable_('days').rows
      .filter(r => r.date >= from && r.date <= to && (!ids || ids.includes(r.staffId)) && hasContent_(r))
      .map(dayPublic_);
    const fys = fysBetween_(from, to);
    const cal = {};
    fys.forEach(fy => { cal[fy] = { off: calendarOff_(fy), exists: calendarExists_(fy) }; });
    const res = {
      me: mePayload_(me),
      days,
      cal,
      holidays: holidays_(fyStart_(fys[0]), fyEnd_(fys[fys.length - 1])),
      closings: closingsMap_(),
      settings: settings_(),
      staff: (admin ? staffAll_() : [me]).map(staffPublic_),
    };
    if (b.withCalRests) {
      try { res.calRests = readCalRests_(from, to).filter(r => !ids || ids.includes(r.staffId)); }
      catch (x) { res.calRests = []; res.calWarning = 'カレンダーを読めませんでした：' + x.message; }
    }
    return res;
  },

  /** 出勤調整カレンダーに入っている休み（画面を出したあとに、裏で読む） */
  calRests: b => {
    const me = auth_(b);
    const ids = isAdminRole_(me.role) ? null : [me.id];
    const from = normDate_(b.from), to = normDate_(b.to);
    if (!from || !to) throw err_('期間がありません');
    try { return { calRests: readCalRests_(from, to).filter(r => !ids || ids.includes(r.staffId)) }; }
    catch (x) { return { calRests: [], calWarning: 'カレンダーを読めませんでした：' + x.message }; }
  },

  /** 出勤・退勤の打刻 */
  punch: b => withLock_(() => {
    const me = auth_(b);
    if (!me.punch) throw err_('打刻の対象になっていません', 'invalid');
    if (b.kind && !['出勤', '休日出勤', '雨天中止（半日）'].includes(b.kind)) throw err_('打刻の区分が違います', 'invalid');
    const type = b.type === 'out' ? 'out' : 'in';
    const pressed = new Date(Number(b.pressedAt) || Date.now());
    const now = new Date();
    if (pressed.getTime() > now.getTime() + 5 * 60000) throw err_('端末の時計が進んでいます。時計を直してください', 'invalid');
    const pt = dataTable_('punches');
    const clientId = String(b.clientId || '');
    if (clientId && pt.rows.slice(-400).some(r => r.clientId === clientId)) {
      return { day: dayPublic_(findDay_(me.id, fmt_(pressed, 'yyyy-MM-dd')) || {}), duplicate: true };
    }
    const time = fmt_(pressed, 'HH:mm');
    let date = fmt_(pressed, 'yyyy-MM-dd');
    if (type === 'out') {
      const today = findDay_(me.id, date);
      if (!(today && today.in && !today.out)) {
        const yday = addDays_(date, -1), y = findDay_(me.id, yday);
        if (y && y.in && !y.out && minutesBetween_(yday, y.in, date, time) <= 20 * 60) date = yday;
      }
    }
    if (isClosedDate_(date)) throw err_(periodLabel_(date) + 'は締め済みです。担当に連絡してください', 'closed');
    const lag = Math.max(0, Math.round((now.getTime() - pressed.getTime()) / 60000));
    pt.append({
      receivedAt: iso_(now), staffId: me.id, type, pressedAt: iso_(pressed), date, time,
      lat: b.lat || '', lng: b.lng || '', acc: b.acc || '', site: b.site || '', clientId, bio: b.bio || '', device: String(b.device || '').slice(0, 80),
    });
    const old = findDay_(me.id, date) || {};
    const upd = {
      staffId: me.id, date, kind: old.kind || b.kind || '出勤', half: old.half || '', pay: old.pay || '',
      brk: old.brk !== '' && old.brk !== undefined ? old.brk : settings_().break,
      site: old.site || '', src: (!old.src || old.src === '打刻') ? '打刻' : old.src, by: me.disp,
      lag: Math.max(Number(old.lag) || 0, lag), bio: b.bio === 'unverified' ? 'unverified' : (old.bio || b.bio || ''),
      gps: b.lat ? 'TRUE' : (old.gps || 'FALSE'), lat: b.lat || old.lat || '', lng: b.lng || old.lng || '', acc: b.acc || old.acc || '',
      leaveBy: old.leaveBy || '', checked: 'FALSE',
    };
    if (type === 'in') {
      if (old.in && old.in !== time) addHistory_(me.disp, me.id, date, '出勤（打ち直し）', old.in, time, 'スマホ打刻');
      upd.in = time;
      upd.site = b.site || old.site || '';   // 出勤の現場
      const ofc = officeCheck_(b.lat, b.lng, b.acc);
      upd.dist = ofc.dist; upd.away = ofc.away ? '1' : ''; upd.direct = b.direct ? '1' : '';
    } else {
      if (old.out && old.out !== time) addHistory_(me.disp, me.id, date, '退勤（打ち直し）', old.out, time, 'スマホ打刻');
      upd.out = time;
      // 退勤の現場（直行直帰で出勤と違う現場のとき）。退勤はどこで押してもよい。事務所からの距離は直帰の目安に残す
      if (!upd.site) upd.site = b.site || '';
      else upd.outSite = b.site && b.site !== upd.site ? b.site : (old.outSite || '');
      upd.outDist = officeCheck_(b.lat, b.lng, b.acc).dist;
    }
    let wasRest = false;
    if (upd.kind === '休み' && !upd.half) { upd.kind = '出勤'; upd.pay = ''; upd.leaveBy = ''; wasRest = true; }
    const saved = saveDay_(upd);
    if (wasRest) {
      addHistory_(me.disp, me.id, date, '区分', restLabel_(me, old), '出勤', '休みの日に打刻');
      try { syncRestEvents_(me, date); } catch (x) { /* カレンダーは後で直せる */ }
    }
    return { day: dayPublic_(saved), lag };
  }),

  /** あとから入力・修正・代理入力 */
  saveDay: b => withLock_(() => {
    const me = auth_(b);
    const st = staffById_(b.staffId);
    if (!st) throw err_('人が見つかりません');
    const admin = isAdminRole_(me.role);
    if (!admin && st.id !== me.id) throw err_('自分の分だけ入力できます');
    const date = normDate_(b.date);
    if (!date) throw err_('日付がありません');
    if (date > today_()) throw err_('先の日の時刻は入力できません');
    if (isClosedDate_(date)) throw err_(periodLabel_(date) + 'は締め済みです。締めを解除してから直してください', 'closed');
    const reason = String(b.reason || '').trim();
    if (!REASONS.includes(reason)) throw err_('理由を選んでください');
    const memo = String(b.memo || '').trim();
    if (reason === 'その他' && !memo) throw err_('「その他」のときはメモを書いてください');
    const kind = KINDS.includes(b.kind) ? b.kind : '出勤';
    const inT = normTime_(b.in), outT = normTime_(b.out);
    if (['出勤', '休日出勤', '雨天中止（半日）'].includes(kind) && !inT) throw err_('出勤の時刻を入れてください');
    const brk = Math.max(0, Math.min(600, Number(b.brk) || 0));
    const old = findDay_(st.id, date) || {};
    const nv = { kind, in: inT, out: outT, brk: String(brk), site: String(b.site || '') };
    const labels = { kind: '区分', in: '出勤', out: '退勤', brk: '休憩（分）', site: '現場' };
    if (b.outSite !== undefined) { const os = String(b.outSite || '').trim(); nv.outSite = os === nv.site ? '' : os; labels.outSite = '退勤の現場'; }
    const oldVal = f => f === 'kind' ? (old.kind || '出勤') : f === 'brk' ? String(old.brk === '' || old.brk === undefined ? settings_().break : old.brk) : String(old[f] || '');
    const changes = Object.keys(labels).filter(f => oldVal(f) !== String(nv[f]));
    if (!changes.length) throw err_('変わったところがありません');
    const why = memo ? reason + '（' + memo + '）' : reason;
    changes.forEach(f => addHistory_(me.disp, st.id, date, labels[f], oldVal(f) || '（なし）', String(nv[f]) || '（なし）', why));
    const hadPunch = old.src === '打刻' && (old.in || old.out);
    const src = me.id !== st.id ? '代理' : (hadPunch ? '修正' : (old.src === '代理' || old.src === '修正' ? '修正' : 'あとから'));
    const upd = Object.assign({}, old, nv, { staffId: st.id, date, src, by: me.disp, checked: 'FALSE' });
    if (kind !== '休み') { upd.half = ''; upd.pay = ''; upd.leaveBy = ''; }
    else if (!old.leaveBy) upd.leaveBy = me.disp;
    const saved = saveDay_(upd);
    let calWarning = '';
    if (old.kind === '休み' || kind === '休み') { try { syncRestEvents_(st, date); } catch (x) { calWarning = '出勤調整カレンダーを直せませんでした：' + x.message; } }
    return { day: dayPublic_(saved), calWarning };
  }),

  /** 休みの登録・取り消し（mode: all / am / pm / cancel） */
  rest: b => withLock_(() => {
    const me = auth_(b);
    const st = staffById_(b.staffId);
    if (!st) throw err_('人が見つかりません');
    const admin = isAdminRole_(me.role);
    if (!admin && st.id !== me.id) throw err_('自分の分だけ登録できます');
    const date = normDate_(b.date);
    if (!date) throw err_('日付がありません');
    if (isClosedDate_(date)) throw err_(periodLabel_(date) + 'は締め済みです', 'closed');
    const mode = String(b.mode || '');
    if (!['all', 'am', 'pm', 'cancel'].includes(mode)) throw err_('休みの種類がありません');
    const old = findDay_(st.id, date) || {};
    const before = restLabel_(st, old);
    let upd;
    if (mode === 'cancel') {
      upd = (old.in || old.out)
        ? Object.assign({}, old, { kind: '出勤', half: '', pay: '', leaveBy: '', src: old.src === 'leave' ? '打刻' : old.src, checked: 'FALSE' })
        : { staffId: st.id, date, kind: '', half: '', pay: '', leaveBy: '', in: '', out: '', brk: '', site: '', src: '', by: me.disp, lag: '', bio: '', gps: '', lat: '', lng: '', acc: '', checked: '' };
    } else {
      if (calendarOff_(fyOf_(date)).includes(date) && mode === 'all' && !old.in) throw err_('会社の休みの日です');
      if (mode === 'all' && (old.in || old.out)) throw err_('この日は打刻があります。半日の休みにするか、先に時刻を直してください');
      upd = Object.assign({}, old, {
        staffId: st.id, date, kind: '休み', half: mode === 'all' ? '' : mode, leaveBy: old.kind === '休み' && old.leaveBy ? old.leaveBy : me.disp,
        src: old.src || 'leave', by: me.disp, checked: 'FALSE',
      });
      if (mode !== 'all' && (old.brk === '' || old.brk === undefined || String(old.brk) === settings_().break)) upd.brk = '0';
      if (mode === 'all') { upd.in = ''; upd.out = ''; }
      if (!admin) upd.pay = '';
    }
    upd.staffId = st.id; upd.date = date;
    const saved = saveDay_(upd);
    const after = restLabel_(st, saved);
    if (before !== after) addHistory_(me.disp, st.id, date, '区分', before, after, mode === 'cancel' ? '休みの取り消し' : '休みの登録');
    let calWarning = '';
    try { syncRestEvents_(st, date); } catch (x) { calWarning = '出勤調整カレンダーに入れられませんでした：' + x.message; }
    return { day: dayPublic_(saved), calWarning, calTitle: mode === 'cancel' ? '' : st.disp + (mode === 'am' ? ' 午前休' : mode === 'pm' ? ' 午後休' : '') };
  }),

  /** 有休・欠勤の確認（担当） */
  pay: b => withLock_(() => {
    const me = adminAuth_(b);
    const st = staffById_(b.staffId);
    const date = normDate_(b.date);
    const old = st && findDay_(st.id, date);
    if (!old || old.kind !== '休み') throw err_('休みの登録がありません');
    if (isClosedDate_(date)) throw err_(periodLabel_(date) + 'は締め済みです', 'closed');
    const pay = b.pay === 'paid' ? 'paid' : b.pay === 'unpaid' ? 'unpaid' : '';
    const before = restLabel_(st, old);
    const saved = saveDay_(Object.assign({}, old, { pay, checked: 'TRUE', by: me.disp }));
    addHistory_(me.disp, st.id, date, '有休・欠勤', before, restLabel_(st, saved), '担当が確認');
    return { day: dayPublic_(saved) };
  }),

  /** 特記を確認済みにする */
  check: b => withLock_(() => {
    const me = adminAuth_(b);
    const date = normDate_(b.date);
    if (isClosedDate_(date)) throw err_(periodLabel_(date) + 'は締め済みです', 'closed');
    const old = findDay_(String(b.staffId), date);
    const saved = saveDay_(Object.assign({ staffId: String(b.staffId), date }, old || {}, { checked: 'TRUE' }));
    return { day: dayPublic_(saved), by: me.disp };
  }),

  /** まとめて確認済みにする */
  checkMany: b => withLock_(() => {
    adminAuth_(b);
    const out = [];
    (b.items || []).slice(0, 500).forEach(it => {
      const date = normDate_(it.date), id = String(it.staffId || '');
      if (!date || !id || isClosedDate_(date)) return;
      const old = findDay_(id, date);
      out.push(dayPublic_(saveDay_(Object.assign({ staffId: id, date }, old || {}, { checked: 'TRUE' }))));
    });
    return { days: out };
  }),

  /** 締め・締めの解除（period は 'YYYY-MM'。9/21〜10/20 なら '2026-10'） */
  close: b => withLock_(() => setClosing_(adminAuth_(b), b.period, 'closed')),
  unclose: b => withLock_(() => setClosing_(adminAuth_(b), b.period, 'open')),

  history: b => {
    adminAuth_(b);
    const limit = Math.min(2000, Number(b.limit) || 300);
    const rows = dataTable_('history').rows.slice(-limit).reverse().map(r => ({
      at: r.at, by: r.by, staffId: r.staffId, date: r.date, field: r.field, before: r.before, after: r.after, reason: r.reason,
    }));
    return { history: rows };
  },

  /** 年間休日カレンダー */
  calGet: b => {
    auth_(b);
    const fy = Number(b.fy);
    return { fy, off: calendarOff_(fy), exists: calendarExists_(fy), holidays: holidays_(fyStart_(fy), fyEnd_(fy)) };
  },
  calSave: b => withLock_(() => {
    const me = adminAuth_(b);
    const fy = Number(b.fy);
    if (!fy) throw err_('年度がありません');
    const want = (b.off || []).map(normDate_).filter(d => d && d >= fyStart_(fy) && d <= fyEnd_(fy));
    const before = calendarOff_(fy);
    const t = dataTable_('calendar');
    t.rows.filter(r => r.date >= fyStart_(fy) && r.date <= fyEnd_(fy)).reverse().forEach(r => t.remove(r));
    const rows = fyDates_(fy).map(d => ({ date: d, off: want.includes(d) ? 'TRUE' : 'FALSE' }));
    t.appendMany(rows);
    const added = want.filter(d => !before.includes(d)), removed = before.filter(d => !want.includes(d));
    if (added.length || removed.length) {
      addHistory_(me.disp, '', '', fy + '年度 年間休日カレンダー', '休日' + before.length + '日', '休日' + want.length + '日',
        [added.length ? '休みにした日 ' + added.join('・') : '', removed.length ? '出勤日にした日 ' + removed.join('・') : ''].filter(Boolean).join(' / '));
    }
    return { off: calendarOff_(fy) };
  }),
  calReflect: b => withLock_(() => {
    const me = adminAuth_(b);
    const fy = Number(b.fy);
    const r = reflectCompanyOff_(fy, !!b.dryRun);
    if (!b.dryRun && (r.added.length || r.removed.length)) {
      addHistory_(me.disp, '', '', fy + '年度 出勤調整カレンダー', '', '追加' + r.added.length + '件・削除' + r.removed.length + '件', '年間休日カレンダーから反映');
    }
    return r;
  }),

  /** スタッフ（設定画面） */
  staffList: b => { adminAuth_(b); return { staff: staffAll_().map(staffPublic_), settings: settings_() }; },
  staffSave: b => withLock_(() => {
    const me = bossAuth_(b);
    const list = (b.staff || []).map(s => ({
      id: String(s.id || '').trim() || 's' + Date.now().toString(36) + Math.floor(Math.random() * 1000),
      name: String(s.name || '').trim(), disp: String(s.disp || '').trim(), freeeNo: String(s.freeeNo || '').trim(),
      setting: String(s.setting || '').trim(), pay: s.pay === 'hourly' ? 'hourly' : 'monthly',
      role: ['boss', 'office', 'staff', 'none'].includes(s.role) ? s.role : 'staff',
      punch: s.punch ? 'TRUE' : 'FALSE', join: normDate_(s.join) || '', active: s.active === false ? 'FALSE' : 'TRUE',
    })).filter(s => s.name);
    if (!list.some(s => s.role === 'boss' && s.active === 'TRUE')) throw err_('親方が1人もいなくなります');
    const t = dataTable_('staff');
    t.rows.slice().reverse().forEach(r => t.remove(r));
    t.appendMany(list);
    addHistory_(me.disp, '', '', 'スタッフ', '', list.length + '人', 'スタッフの設定を保存');
    return { staff: staffAll_().map(staffPublic_) };
  }),
  settingsSave: b => withLock_(() => {
    const me = bossAuth_(b);
    const s = b.settings || {};
    const v = { start: normTime_(s.start), end: normTime_(s.end), break: String(Math.max(0, Number(s.break) || 0)), useFrom: normDate_(s.useFrom) };
    if (!v.start || !v.end) throw err_('始業・終業の時刻を入れてください');
    const t = dataTable_('settings');
    Object.keys(v).forEach(k => {
      const hit = t.rows.find(r => r.key === k);
      if (hit) t.update(hit, { value: v[k] }); else t.append({ key: k, value: v[k] });
    });
    addHistory_(me.disp, '', '', '勤務時間の設定', '', v.start + '〜' + v.end + ' 休憩' + v.break + '分' + (v.useFrom ? ' 使い始め ' + v.useFrom : ''), '設定を保存');
    return { settings: settings_() };
  }),

  /** 事務所の位置（朝の出勤を事務所で押したかの確かめ） */
  officeSave: b => withLock_(() => {
    const me = adminAuth_(b);
    const o = b.office || {};
    const lat = Number(o.lat), lng = Number(o.lng), r = Math.round(Number(o.r));
    if (!(lat > 20 && lat < 50 && lng > 120 && lng < 155)) throw err_('事務所の位置が正しくありません');
    if (!(r >= 30 && r <= 2000)) throw err_('認める範囲は30〜2000mで入れてください');
    const v = { officeLat: lat.toFixed(6), officeLng: lng.toFixed(6), officeR: String(r), officeCheck: o.check === false || o.check === '0' ? '0' : '1' };
    const t = dataTable_('settings');
    Object.keys(v).forEach(k => {
      const hit = t.rows.find(x => x.key === k);
      if (hit) t.update(hit, { value: v[k] }); else t.append({ key: k, value: v[k] });
    });
    addHistory_(me.disp, '', '', '事務所の位置', '', v.officeLat + ',' + v.officeLng + ' 半径' + v.officeR + 'm' + (v.officeCheck === '1' ? '' : '（確かめない）'), '設定を保存');
    return { settings: settings_() };
  }),

  /** 登録用QRコード・仮の番号を出す（kind: qr / temp） */
  issueCode: b => withLock_(() => {
    const me = adminAuth_(b);
    const st = staffById_(b.staffId);
    if (!st || !st.active) throw err_('人が見つかりません');
    if (isAdminRole_(st.role) && me.role !== 'boss') throw err_('親方・事務担当の登録コードは、親方だけが出せます');
    const kind = b.kind === 'temp' ? 'temp' : 'qr';
    const r = issueCode_(st.id, kind, me.disp);
    addHistory_(me.disp, st.id, '', '登録コード', '', kind === 'qr' ? '登録用QRコードを発行' : '仮の番号を発行', '');
    return r;
  }),
};

/* ===================== 本人確認 ===================== */

function auth_(b) {
  const token = String((b && b.token) || '');
  if (!token) throw err_('ログインしてください', 'auth');
  const t = authTable_('sessions');
  const hit = t.rows.find(r => r.tokenHash === sha_(token));
  if (!hit || Number(hit.expiresAt) < Date.now()) throw err_('ログインし直してください', 'auth');
  const st = staffById_(hit.staffId);
  if (!st || !st.active) throw err_('ログインし直してください', 'auth');
  return st;
}
function adminAuth_(b) { const me = auth_(b); if (!isAdminRole_(me.role)) throw err_('親方か事務担当だけができます'); return me; }
function bossAuth_(b) { const me = auth_(b); if (me.role !== 'boss') throw err_('親方だけができます'); return me; }
function isAdminRole_(r) { return r === 'boss' || r === 'office'; }

function checkPin_(pin) { if (!/^\d{4}$/.test(String(pin || ''))) throw err_('暗証番号は4桁の数字です'); }
function setPin_(staffId, pin) {
  checkPin_(pin);
  const t = authTable_('pins');
  const salt = Utilities.getUuid();
  const v = { staffId, salt, hash: pinHash_(salt, pin), fails: '0', lockedUntil: '0', updatedAt: iso_(new Date()) };
  const hit = t.rows.find(r => r.staffId === staffId);
  if (hit) t.update(hit, v); else t.append(v);
}
function verifyPin_(staffId, pin) {
  const t = authTable_('pins');
  const hit = t.rows.find(r => r.staffId === staffId);
  if (!hit) throw err_('まだ登録されていません。担当に登録コードを出してもらってください');
  if (Number(hit.lockedUntil) > Date.now()) throw err_('間違いが続いたので、' + PIN_LOCK_MIN + '分ほど待ってからやり直してください');
  if (pinHash_(hit.salt, String(pin || '')) !== hit.hash) {
    const fails = (Number(hit.fails) || 0) + 1;
    t.update(hit, { fails: String(fails), lockedUntil: fails >= PIN_MAX_FAILS ? String(Date.now() + PIN_LOCK_MIN * 60000) : '0' });
    throw err_(fails >= PIN_MAX_FAILS ? '間違いが続いたので、しばらくログインできません' : '暗証番号が違います');
  }
  if (Number(hit.fails)) t.update(hit, { fails: '0', lockedUntil: '0' });
}
function pinHash_(salt, pin) {
  const pepper = prop_('TC_PEPPER');
  if (!pepper) throw err_('TC_PEPPER がありません');
  let h = sha_(salt + ':' + pin + ':' + pepper);
  for (let i = 0; i < 300; i++) h = sha_(h + pepper);
  return h;
}
function newSession_(staffId, device) {
  const token = (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, '');
  const now = Date.now();
  authTable_('sessions').append({
    tokenHash: sha_(token), staffId, device: String(device || '').slice(0, 80),
    createdAt: String(now), lastUsed: String(now), expiresAt: String(now + SESSION_DAYS * 86400000),
  });
  return token;
}
/** 親方・事務担当の最初の登録（合言葉のリンク） */
function bootstrapEnroll_(token, b) {
  const hit = BOOTSTRAP.find(x => x.hash === sha_(token));
  if (!hit || today_() > BOOTSTRAP_UNTIL) { enrollGuard_(true); throw err_('登録のリンクが違うか、期限が切れています'); }
  const st = staffById_(hit.staffId);
  if (!st || !st.active) throw err_('この登録の人は登録されていません');
  if (authTable_('pins').rows.some(r => r.staffId === st.id)) throw err_('もう登録が済んでいます。名前と暗証番号でログインしてください');
  setPin_(st.id, b.pin);
  const token2 = newSession_(st.id, b.device);
  addHistory_(st.disp, st.id, '', '登録', '', 'この端末で登録', '最初の登録');
  return { token: token2, me: mePayload_(st) };
}

/** 登録コードの総当たりを防ぐ：10分間に全体で20回まちがえたら、10分止める */
function enrollGuard_(failed) {
  const P = PropertiesService.getScriptProperties();
  const now = Date.now();
  const [cnt, since, lockUntil] = String(P.getProperty('TC_ENROLL_GUARD') || '0|0|0').split('|').map(Number);
  if (lockUntil > now) throw err_('登録コードの間違いが続いたので、しばらく登録できません。10分ほど待ってください');
  if (!failed) return;
  let c = now - since > 10 * 60000 ? 1 : cnt + 1;
  const st = now - since > 10 * 60000 ? now : since;
  P.setProperty('TC_ENROLL_GUARD', [c, st, c >= 20 ? now + 10 * 60000 : 0].join('|'));
}
function revokeSessions_(staffId) {
  const t = authTable_('sessions');
  t.rows.filter(r => r.staffId === staffId).reverse().forEach(r => t.remove(r));
}
function issueCode_(staffId, kind, by) {
  const t = authTable_('codes');
  t.rows.filter(r => r.staffId === staffId && !r.usedAt).forEach(r => t.update(r, { usedAt: 'revoked' }));
  const code = String(parseInt(sha_(Utilities.getUuid()).slice(0, 10), 16) % 1000000).padStart(6, '0');
  const expiresAt = Date.now() + CODE_MIN[kind] * 60000;
  while (t.rows.length > 100) t.rows.shift();
  t.append({ codeHash: sha_(code), staffId, kind, expiresAt: String(expiresAt), usedAt: '', by, createdAt: iso_(new Date()) });
  const base = prop_('TC_APP_URL') || DEFAULT_APP_URL;
  return { code, kind, expiresAt, url: base ? base + '#enroll=' + code : '' };
}

/* ===================== 勤怠データ ===================== */

function findDay_(staffId, date) {
  const r = dataTable_('days').rows.find(x => x.key === staffId + '|' + date);
  return r && hasContent_(r) ? Object.assign({}, r) : null;   // 写しを返す（保存で元が書き換わっても前の値が残るように）
}
function saveDay_(v) {
  const t = dataTable_('days');
  const key = v.staffId + '|' + v.date;
  const rec = Object.assign({}, v, { key, updatedAt: iso_(new Date()) });
  delete rec._row;
  const hit = t.rows.find(x => x.key === key);
  if (hit) t.update(hit, rec); else t.append(rec);
  return t.rows.find(x => x.key === key);
}
function hasContent_(r) { return !!(r.kind || r.in || r.out || String(r.checked).toUpperCase() === 'TRUE'); }
function dayPublic_(r) {
  const o = {};
  SHEETS.days.forEach(h => { if (h !== 'key' && h !== 'lat' && h !== 'lng' && h !== 'acc') o[h] = r[h] === undefined ? '' : r[h]; });
  o.checked = String(r.checked).toUpperCase() === 'TRUE';
  o.gps = String(r.gps).toUpperCase() === 'TRUE';
  return o;
}
function restLabel_(st, d) {
  if (!d || !hasContent_(d)) return '（なし）';
  if (d.kind !== '休み') return d.in ? (d.kind || '出勤') : (d.kind || '（なし）');
  const part = d.half === 'am' ? '午前' : d.half === 'pm' ? '午後' : '';
  if (st.pay === 'hourly') return part + '休み' + (d.pay === 'paid' ? '（有休）' : '');
  return part + '休み（' + (d.pay === 'paid' ? '有休' : d.pay === 'unpaid' ? '欠勤' : '確認中') + '）';
}
function addHistory_(by, staffId, date, field, before, after, reason) {
  dataTable_('history').append({ at: fmt_(new Date(), 'yyyy-MM-dd HH:mm'), by, staffId, date, field, before, after, reason });
}

/* ===================== 締め ===================== */

/** 20日締め：21日以降は翌月分 */
function periodOf_(date) {
  const y = +date.slice(0, 4), m = +date.slice(5, 7), d = +date.slice(8, 10);
  if (d <= 20) return date.slice(0, 7);
  return m === 12 ? (y + 1) + '-01' : y + '-' + String(m + 1).padStart(2, '0');
}
function periodLabel_(date) { return Number(periodOf_(date).slice(5, 7)) + '月分'; }
function closingsMap_() {
  const m = {};
  dataTable_('closings').rows.forEach(r => { m[r.period] = { status: r.status, by: r.by, at: r.at }; });
  return m;
}
function isClosedDate_(date) { const c = closingsMap_()[periodOf_(date)]; return !!(c && c.status === 'closed'); }
function setClosing_(me, period, status) {
  if (!/^\d{4}-\d{2}$/.test(String(period || ''))) throw err_('締める月がありません');
  const t = dataTable_('closings');
  const hit = t.rows.find(r => r.period === period);
  const v = { period, status, by: me.disp, at: fmt_(new Date(), 'yyyy-MM-dd HH:mm') };
  if (hit) t.update(hit, v); else t.append(v);
  addHistory_(me.disp, '', '', status === 'closed' ? '締め' : '締めの解除', status === 'closed' ? '締め前' : '締め済み',
    Number(period.slice(5)) + '月分 ' + (status === 'closed' ? '締め済み' : '締め前'), status === 'closed' ? '月次の締め' : '修正のため');
  return { closings: closingsMap_() };
}

/* ===================== 年間休日カレンダー ===================== */

function fyOf_(date) { const y = +date.slice(0, 4), m = +date.slice(5, 7); return m >= 4 ? y : y - 1; }
function fyStart_(fy) { return fy + '-04-01'; }
function fyEnd_(fy) { return (fy + 1) + '-03-31'; }
function fyDates_(fy) { const out = []; for (let d = fyStart_(fy); d <= fyEnd_(fy); d = addDays_(d, 1)) out.push(d); return out; }
function fysBetween_(from, to) { const a = fyOf_(from), b = fyOf_(to); const out = []; for (let y = a; y <= b; y++) out.push(y); return out; }
function calendarExists_(fy) { return dataTable_('calendar').rows.some(r => r.date >= fyStart_(fy) && r.date <= fyEnd_(fy)); }
function calendarOff_(fy) {
  const rows = dataTable_('calendar').rows.filter(r => r.date >= fyStart_(fy) && r.date <= fyEnd_(fy));
  if (rows.length) return rows.filter(r => String(r.off).toUpperCase() === 'TRUE').map(r => r.date).sort();
  const hol = holidays_(fyStart_(fy), fyEnd_(fy));
  return fyDates_(fy).filter(d => weekday_(d) === 0 || hol[d]);
}
/** 祝日：2028年3月までは中の一覧を使う。それより先は Google の日本の祝日カレンダーの「祝日」だけを使う（節分・大晦日などは除く） */
const FALLBACK_END = '2028-03-31';
function holidays_(from, to) {
  const out = {};
  Object.keys(JP_HOLIDAYS_FALLBACK).forEach(d => { if (d >= from && d <= to) out[d] = JP_HOLIDAYS_FALLBACK[d]; });
  if (to <= FALLBACK_END) return out;
  try {
    const cal = CalendarApp.getCalendarById(HOLIDAY_CAL_ID);
    if (cal) {
      const a = from > FALLBACK_END ? from : addDays_(FALLBACK_END, 1);
      cal.getEvents(dateObj_(a), dateObj_(addDays_(to, 1))).forEach(ev => {
        if ((ev.getDescription() || '').indexOf('祝日') < 0) return;
        out[fmt_(ev.getAllDayStartDate(), 'yyyy-MM-dd')] = ev.getTitle();
      });
    }
  } catch (x) { /* 読めないときは一覧の分だけ */ }
  return out;
}

/* ===================== Googleカレンダー（出勤調整カレンダー） ===================== */

function adjustCal_() {
  const id = prop_('TC_ADJUST_CAL_ID');
  if (id) { const c = CalendarApp.getCalendarById(id); if (c) return c; }
  const name = prop_('HOLIDAY_CALENDAR') || '出勤調整カレンダー';
  const n = name.replace(/\s/g, '');
  const cid = prop_('TC_ADJUST_CAL_FOUND');
  if (cid) { try { const c = CalendarApp.getCalendarById(cid); if (c && c.getName().replace(/\s/g, '') === n) return c; } catch (x) {} }
  let cal = (CalendarApp.getCalendarsByName(name) || [])[0];
  if (!cal) cal = CalendarApp.getAllCalendars().find(c => c.getName().replace(/\s/g, '') === n);
  if (!cal) throw err_('「' + name + '」というカレンダーが見つかりません');
  try { PropertiesService.getScriptProperties().setProperty('TC_ADJUST_CAL_FOUND', cal.getId()); } catch (x) {}
  return cal;
}
const TAG_PREFIX = '[TC:';
function tagOf_(key) { return TAG_PREFIX + key + ']'; }

/** 会社休み（日曜・祝日以外）を「@all」で入れる */
function reflectCompanyOff_(fy, dryRun) {
  const cal = adjustCal_();
  const hol = holidays_(fyStart_(fy), fyEnd_(fy));
  const want = calendarOff_(fy).filter(d => weekday_(d) !== 0 && !hol[d]);
  const evs = cal.getEvents(dateObj_(fyStart_(fy)), dateObj_(addDays_(fyEnd_(fy), 1)));
  const appEv = {}, manual = {};
  evs.forEach(ev => {
    if (!ev.isAllDayEvent() || ev.getTitle().trim() !== '@all') return;
    const s = fmt_(ev.getAllDayStartDate(), 'yyyy-MM-dd');
    const e = fmt_(ev.getAllDayEndDate(), 'yyyy-MM-dd');
    for (let d = s; d < e; d = addDays_(d, 1)) {
      if ((ev.getDescription() || '').indexOf(tagOf_('@all')) >= 0) appEv[d] = ev; else manual[d] = true;
    }
  });
  const added = [], removed = [], skipped = [];
  want.forEach(d => {
    if (appEv[d]) return;
    if (manual[d]) { skipped.push(d); return; }
    added.push(d);
    if (!dryRun) cal.createAllDayEvent('@all', dateObj_(d), { description: tagOf_('@all') + ' 年間休日カレンダーから登録' });
  });
  Object.keys(appEv).forEach(d => {
    if (want.includes(d)) return;
    removed.push(d);
    if (!dryRun) appEv[d].deleteEvent();
  });
  return { added: added.sort(), removed: removed.sort(), skipped: skipped.sort(), total: want.length };
}

/** 個人の休みを「樋上」「樋上 午前休」で入れる。続けて休む日は1本にまとめる */
function syncRestEvents_(st, date) {
  const cal = adjustCal_();
  const from = addDays_(date, -40), to = addDays_(date, 40);
  const map = {};
  dataTable_('days').rows.forEach(r => { if (r.staffId === st.id && r.date >= addDays_(from, -20) && r.date <= addDays_(to, 20) && r.kind === '休み') map[r.date] = r; });
  const evs = cal.getEvents(dateObj_(addDays_(from, -20)), dateObj_(addDays_(to, 21)));
  const mine = [], manualDays = {};
  evs.forEach(ev => {
    if (!ev.isAllDayEvent()) return;
    const desc = ev.getDescription() || '';
    const s = fmt_(ev.getAllDayStartDate(), 'yyyy-MM-dd'), e = fmt_(ev.getAllDayEndDate(), 'yyyy-MM-dd');
    if (desc.indexOf(tagOf_(st.id)) >= 0) { mine.push({ ev, s, e, title: ev.getTitle() }); return; }
    const t = ev.getTitle().trim();
    if (t === st.disp || t.indexOf(st.disp + ' ') === 0 || t.indexOf(st.disp + '　') === 0) {
      for (let d = s; d < e; d = addDays_(d, 1)) manualDays[d] = true;
    }
  });
  // あるべき予定
  const want = [];
  let d = addDays_(from, -20);
  const last = addDays_(to, 20);
  while (d <= last) {
    const r = map[d];
    if (r && !manualDays[d]) {
      if (r.half) { want.push({ s: d, e: addDays_(d, 1), title: st.disp + (r.half === 'am' ? ' 午前休' : ' 午後休') }); d = addDays_(d, 1); continue; }
      let e = d;
      while (map[addDays_(e, 1)] && !map[addDays_(e, 1)].half && !manualDays[addDays_(e, 1)] && addDays_(e, 1) <= last) e = addDays_(e, 1);
      want.push({ s: d, e: addDays_(e, 1), title: st.disp });
      d = addDays_(e, 1);
      continue;
    }
    d = addDays_(d, 1);
  }
  const k = x => x.title + '|' + x.s + '|' + x.e;
  const wantKeys = want.map(k), haveKeys = mine.map(k);
  mine.forEach(m => { if (m.e > from && m.s <= to && !wantKeys.includes(k(m))) m.ev.deleteEvent(); });
  want.forEach(w => {
    if (w.e > from && w.s <= to && !haveKeys.includes(k(w))) {
      if (w.e === addDays_(w.s, 1)) cal.createAllDayEvent(w.title, dateObj_(w.s), { description: tagOf_(st.id) + ' タイムカードの休みの登録から' });
      else cal.createAllDayEvent(w.title, dateObj_(w.s), dateObj_(w.e), { description: tagOf_(st.id) + ' タイムカードの休みの登録から' });
    }
  });
}

/** 手で入れた個人の休み（「樋上」など）を読む */
function readCalRests_(from, to) {
  const cal = adjustCal_();
  const staff = staffAll_().filter(s => s.active && s.disp);
  const out = [];
  cal.getEvents(dateObj_(from), dateObj_(addDays_(to, 1))).forEach(ev => {
    if (!ev.isAllDayEvent()) return;
    if ((ev.getDescription() || '').indexOf(TAG_PREFIX) >= 0) return;
    const title = ev.getTitle().trim();
    if (title === '@all') return;
    const st = staff.find(s => title === s.disp || title.indexOf(s.disp + ' ') === 0 || title.indexOf(s.disp + '　') === 0);
    if (!st) return;
    const half = title.indexOf('午前') >= 0 ? 'am' : title.indexOf('午後') >= 0 ? 'pm' : '';
    const s = fmt_(ev.getAllDayStartDate(), 'yyyy-MM-dd'), e = fmt_(ev.getAllDayEndDate(), 'yyyy-MM-dd');
    for (let d = s; d < e; d = addDays_(d, 1)) if (d >= from && d <= to) out.push({ staffId: st.id, date: d, title, half });
  });
  return out;
}

/* ===================== スタッフ・設定 ===================== */

function staffAll_() {
  return dataTable_('staff').rows.map(r => ({
    id: String(r.id), name: r.name, disp: r.disp, freeeNo: String(r.freeeNo || ''), setting: r.setting,
    pay: r.pay === 'hourly' ? 'hourly' : 'monthly', role: r.role || 'staff',
    punch: String(r.punch).toUpperCase() === 'TRUE', join: r.join || '', active: String(r.active).toUpperCase() !== 'FALSE',
  }));
}
function staffById_(id) { return staffAll_().find(s => s.id === String(id)); }
function staffPublic_(s) { return { id: s.id, name: s.name, disp: s.disp, freeeNo: s.freeeNo, setting: s.setting, pay: s.pay, role: s.role, punch: s.punch, join: s.join, active: s.active }; }
function mePayload_(s) { return Object.assign(staffPublic_(s), { admin: isAdminRole_(s.role) }); }
/** 事務所からの距離（m）と、離れているか。位置がないとき・ずれが大きすぎるときは決めない */
function officeCheck_(lat, lng, acc) {
  const st = settings_();
  lat = Number(lat); lng = Number(lng); acc = Number(acc) || 0;
  if (!lat || !lng) return { dist: '', away: false };
  const dist = Math.round(distM_(lat, lng, Number(st.officeLat), Number(st.officeLng)));
  if (st.officeCheck === '0') return { dist, away: false };
  return { dist, away: acc <= 1000 && dist > officeLimit_(st, acc) };
}
/** 認める距離：半径＋GPSのずれ（100mまで） */
function officeLimit_(st, acc) { return (Number(st.officeR) || 150) + Math.min(Math.max(Number(acc) || 0, 0), 100); }
function distM_(a1, o1, a2, o2) {
  const R = 6371000, rad = x => x * Math.PI / 180;
  const dA = rad(a2 - a1), dO = rad(o2 - o1);
  const h = Math.sin(dA / 2) ** 2 + Math.cos(rad(a1)) * Math.cos(rad(a2)) * Math.sin(dO / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function settings_() {
  const o = Object.assign({}, DEFAULT_SETTINGS);
  dataTable_('settings').rows.forEach(r => { if (r.key) o[r.key] = String(r.value); });
  return o;
}

/* ===================== シートの読み書き ===================== */

const CACHE_ = {};
function book_() { return CACHE_.book || (CACHE_.book = SpreadsheetApp.openById(prop_('TC_SHEET_ID') || DEFAULT_SHEET_ID)); }
function dataTable_(name) { return table_(book_(), name, SHEETS[name], 'd:' + name); }

/** 暗証番号・ログイン・登録コードは、シートではなくスクリプト プロパティに置く（社員共有のフォルダに出さない） */
function authTable_(name) {
  const key = 'a:' + name;
  if (CACHE_[key]) return CACHE_[key];
  const P = PropertiesService.getScriptProperties();
  const base = 'TC_AUTH_' + name.toUpperCase();
  const n = Number(P.getProperty(base + '_N') || 0);
  let txt = ''; for (let i = 0; i < n; i++) txt += P.getProperty(base + '_' + i) || '';
  let rows = []; try { rows = txt ? JSON.parse(txt) : []; } catch (x) { rows = []; }
  if (name === 'sessions') rows = rows.filter(r => Number(r.expiresAt) > Date.now());
  const save = () => {
    const t = JSON.stringify(rows), size = 8000, m = Math.ceil(t.length / size) || 1, obj = {};
    for (let i = 0; i < m; i++) obj[base + '_' + i] = t.slice(i * size, (i + 1) * size);
    obj[base + '_N'] = String(m);
    P.setProperties(obj, false);
    for (let i = m; i < n; i++) P.deleteProperty(base + '_' + i);
  };
  const t = {
    rows,
    append(o) { const rec = {}; AUTH_SHEETS[name].forEach(h => { rec[h] = o[h] === undefined || o[h] === null ? '' : String(o[h]); }); rows.push(rec); save(); return rec; },
    update(rec, patch) { Object.keys(patch).forEach(k => { rec[k] = patch[k] === undefined || patch[k] === null ? '' : String(patch[k]); }); save(); },
    remove(rec) { const i = rows.indexOf(rec); if (i >= 0) rows.splice(i, 1); save(); },
  };
  CACHE_[key] = t;
  return t;
}
function table_(book, name, head, cacheKey) {
  if (CACHE_[cacheKey]) return CACHE_[cacheKey];
  let s = book.getSheetByName(name);
  if (!s) {
    s = book.insertSheet(name);
    s.getRange(1, 1, 1, head.length).setValues([head]);
    s.setFrozenRows(1);
    s.getRange(1, 1, Math.max(2, s.getMaxRows()), head.length).setNumberFormat('@');
  }
  const values = s.getDataRange().getValues();
  let top = values.shift() || [];
  if (top.length && head.some(h => top.indexOf(h) < 0) && head.slice(0, top.filter(String).length).every((h, i) => top[i] === h)) {
    s.getRange(1, 1, 1, head.length).setValues([head]);   // 列が後ろに増えたときは見出しを足す
    top = head.slice();
  }
  const cols = head.map(h => top.indexOf(h));
  const rows = values.map((v, i) => {
    const o = { _row: i + 2 };
    head.forEach((h, j) => { o[h] = cols[j] >= 0 ? norm_(h, v[cols[j]]) : ''; });
    return o;
  }).filter(o => head.some(h => o[h] !== ''));
  const toVals = o => head.map(h => (o[h] === undefined || o[h] === null) ? '' : String(o[h]));
  const t = {
    rows,
    append(o) {
      const row = s.getLastRow() + 1;
      s.getRange(row, 1, 1, head.length).setNumberFormat('@').setValues([toVals(o)]);
      const rec = Object.assign({}, o, { _row: row });
      head.forEach(h => { if (rec[h] === undefined || rec[h] === null) rec[h] = ''; else rec[h] = String(rec[h]); });
      rows.push(rec);
      return rec;
    },
    appendMany(list) {
      if (!list.length) return;
      const row = s.getLastRow() + 1;
      s.getRange(row, 1, list.length, head.length).setNumberFormat('@').setValues(list.map(toVals));
      list.forEach((o, i) => { const rec = Object.assign({}, o, { _row: row + i }); head.forEach(h => { rec[h] = rec[h] === undefined || rec[h] === null ? '' : String(rec[h]); }); rows.push(rec); });
    },
    update(rec, patch) {
      Object.assign(rec, patch);
      head.forEach(h => { if (rec[h] === undefined || rec[h] === null) rec[h] = ''; else rec[h] = String(rec[h]); });
      s.getRange(rec._row, 1, 1, head.length).setNumberFormat('@').setValues([toVals(rec)]);
    },
    remove(rec) {
      s.deleteRow(rec._row);
      const i = rows.indexOf(rec);
      if (i >= 0) rows.splice(i, 1);
      rows.forEach(r => { if (r._row > rec._row) r._row -= 1; });
    },
  };
  CACHE_[cacheKey] = t;
  return t;
}
function norm_(h, v) {
  if (v === null || v === undefined) return '';
  if (v instanceof Date || Object.prototype.toString.call(v) === '[object Date]') {
    if (DATE_COLS[h]) return fmt_(v, 'yyyy-MM-dd');
    if (TIME_COLS[h]) return fmt_(v, 'HH:mm');
    return fmt_(v, 'yyyy-MM-dd HH:mm:ss');
  }
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  return String(v);
}
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw err_('混み合っています。少し待ってからもう一度押してください', 'busy');
  try { return fn(); } finally { lock.releaseLock(); }
}

/* ===================== 日付・小道具 ===================== */

function prop_(k) { return PropertiesService.getScriptProperties().getProperty(k) || ''; }
function sha_(s) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(s), Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 255).toString(16)).slice(-2)).join('');
}
function fmt_(d, f) { return Utilities.formatDate(d, TZ, f); }
function iso_(d) { return fmt_(d, "yyyy-MM-dd'T'HH:mm:ssXXX"); }
function today_() { return fmt_(new Date(), 'yyyy-MM-dd'); }
function normDate_(s) {
  const m = String(s || '').match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  return m ? m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0') : '';
}
function normTime_(s) {
  const m = String(s || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m || +m[1] > 23 || +m[2] > 59) return '';
  return m[1].padStart(2, '0') + ':' + m[2];
}
function dateObj_(s) { return new Date(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10)); }
function addDays_(s, n) {
  const d = new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10) + n));
  return d.toISOString().slice(0, 10);
}
function weekday_(s) { return new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7) - 1, +s.slice(8, 10))).getUTCDay(); }
function minutesBetween_(d1, t1, d2, t2) {
  const a = Date.UTC(+d1.slice(0, 4), +d1.slice(5, 7) - 1, +d1.slice(8, 10), +t1.slice(0, 2), +t1.slice(3, 5));
  const b = Date.UTC(+d2.slice(0, 4), +d2.slice(5, 7) - 1, +d2.slice(8, 10), +t2.slice(0, 2), +t2.slice(3, 5));
  return (b - a) / 60000;
}

/* ===================== 初期設定（はじめて呼ばれたときに自動で） ===================== */

const INIT_VERSION = '1';
function ensureInit_() {
  const P = PropertiesService.getScriptProperties();
  if (P.getProperty('TC_INIT') === INIT_VERSION) return;
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(25000)) throw err_('準備中です。少し待ってからもう一度開いてください', 'busy');
  try {
    if (P.getProperty('TC_INIT') === INIT_VERSION) return;
    if (!P.getProperty('TC_PEPPER')) P.setProperty('TC_PEPPER', (Utilities.getUuid() + Utilities.getUuid()).replace(/-/g, ''));
    const book = book_();
    book.setSpreadsheetTimeZone(TZ);
    // 名簿は、ドライブで作った最初のシート（1行目が id, name, …）を「staff」にする
    if (!book.getSheetByName('staff')) {
      const first = book.getSheets().find(sh => String(sh.getRange(1, 1).getValue()) === 'id' && String(sh.getRange(1, 2).getValue()) === 'name');
      if (first) first.setName('staff');
    }
    Object.keys(SHEETS).forEach(n => dataTable_(n));
    ['シート1', 'Sheet1', 'Untitled'].forEach(n => { const sh = book.getSheetByName(n); if (sh && book.getSheets().length > 1 && sh.getLastRow() <= 1) book.deleteSheet(sh); });
    const se = dataTable_('settings');
    if (!se.rows.length) se.appendMany(Object.keys(DEFAULT_SETTINGS).map(k => ({ key: k, value: k === 'useFrom' ? today_() : DEFAULT_SETTINGS[k] })));
    if (!calendarExists_(2026)) {
      const off = [];
      Object.keys(SEED_CAL_2026).forEach(ym => SEED_CAL_2026[ym].forEach(d => off.push(ym + '-' + String(d).padStart(2, '0'))));
      dataTable_('calendar').appendMany(fyDates_(2026).map(d => ({ date: d, off: off.includes(d) ? 'TRUE' : 'FALSE' })));
    }
    P.setProperty('TC_INIT', INIT_VERSION);
  } finally { lock.releaseLock(); }
}
function setup() { ensureInit_(); return 'ok'; }

/** 2026年度 年間休日カレンダー（紙のカレンダーから。8月は12日出勤・19日休みに入れ替え済み） */
const SEED_CAL_2026 = {
  '2026-04': [4, 5, 11, 12, 18, 19, 25, 26, 29], '2026-05': [2, 3, 4, 5, 6, 10, 17, 24, 30, 31], '2026-06': [7, 13, 14, 21, 27, 28],
  '2026-07': [5, 11, 12, 18, 19, 20, 26], '2026-08': [1, 2, 9, 13, 14, 15, 16, 17, 18, 19, 23, 29, 30], '2026-09': [5, 6, 12, 13, 19, 20, 21, 22, 23, 27],
  '2026-10': [3, 4, 10, 11, 12, 18, 24, 25, 31], '2026-11': [1, 2, 3, 8, 14, 15, 21, 22, 23, 29], '2026-12': [6, 12, 13, 20, 27, 30, 31],
  '2027-01': [1, 2, 3, 4, 5, 6, 10, 11, 17, 23, 24, 30, 31], '2027-02': [6, 7, 11, 14, 20, 21, 23, 28], '2027-03': [6, 7, 13, 14, 20, 21, 22, 28],
};

/** 祝日（Googleの祝日カレンダーが読めないときの予備） */
const JP_HOLIDAYS_FALLBACK = {
  '2026-04-29': '昭和の日', '2026-05-03': '憲法記念日', '2026-05-04': 'みどりの日', '2026-05-05': 'こどもの日', '2026-05-06': '振替休日',
  '2026-07-20': '海の日', '2026-08-11': '山の日', '2026-09-21': '敬老の日', '2026-09-22': '国民の休日', '2026-09-23': '秋分の日',
  '2026-10-12': 'スポーツの日', '2026-11-03': '文化の日', '2026-11-23': '勤労感謝の日', '2027-01-01': '元日', '2027-01-11': '成人の日',
  '2027-02-11': '建国記念の日', '2027-02-23': '天皇誕生日', '2027-03-21': '春分の日', '2027-03-22': '振替休日',
  '2027-04-29': '昭和の日', '2027-05-03': '憲法記念日', '2027-05-04': 'みどりの日', '2027-05-05': 'こどもの日', '2027-07-19': '海の日',
  '2027-08-11': '山の日', '2027-09-20': '敬老の日', '2027-09-23': '秋分の日', '2027-10-11': 'スポーツの日', '2027-11-03': '文化の日',
  '2027-11-23': '勤労感謝の日', '2028-01-01': '元日', '2028-01-10': '成人の日', '2028-02-11': '建国記念の日', '2028-02-23': '天皇誕生日', '2028-03-20': '春分の日',
};

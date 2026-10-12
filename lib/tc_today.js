/* 今日の出勤（タイムカード）— 日報アプリ・日報ダッシュボードに出す小さな欄
   ・この端末でタイムカードにログインしていれば、そのログインで読む（同じサイトなので端末の中で共有される）
   ・親方・事務担当は全員、スタッフは自分の分だけ（サーバーで確かめる）
   ・id="tcToday" の要素に出す。前回の内容をすぐ出して、裏で最新に入れかえる（3分ごと・画面に戻ったときも） */
(function () {
  'use strict';
  var GAS_URL = 'https://script.google.com/macros/s/AKfycbzCkxdDCT3hnSEbtpcbQcvOcsehvX5pLUzZ8xFBIxQ40qvRmwmnixJ3q_vEr7X0v-vm7A/exec';
  var CACHE = 'tc_today_cache', OPEN = 'tc_today_open';
  var WD = '日月火水木金土';
  var el = null, timer = null, busy = false, data = null, err = '';

  function lsGet(k) { try { var v = localStorage.getItem(k); return v === null ? null : JSON.parse(v); } catch (e) { return null; } }
  function lsSet(k, v) { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function token() { return lsGet('tc_token'); }
  function me() { return lsGet('tc_me'); }
  function jstNow() { var s = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date()); return { date: s.slice(0, 10), time: s.slice(11, 16) }; }
  function dlabel(s) { var d = new Date(s + 'T00:00:00Z'); return (d.getUTCMonth() + 1) + '/' + d.getUTCDate() + '（' + WD[d.getUTCDay()] + '）'; }
  function isOpen() { var v = lsGet(OPEN); return v === null ? true : !!v; }

  var CSS = '.tct{background:#fff;border:1px solid #DCD9D0;border-radius:12px;margin:0 0 14px;overflow:hidden;font-size:14px;color:#22231F}' +
    '.tct-h{display:flex;align-items:center;gap:8px;width:100%;padding:10px 12px;background:#E5EDE7;border:0;font:inherit;color:inherit;text-align:left;cursor:pointer}' +
    '.tct-h b{font-size:15px;color:#214A37}.tct-h .g{flex:1}.tct-h .c{font-size:12px;color:#5B5750}.tct-h .ar{color:#214A37;font-size:12px}' +
    '.tct-sum{display:flex;gap:6px;flex-wrap:wrap;padding:8px 12px 0}.tct-sum span{font-size:12px;border-radius:999px;padding:2px 8px;background:#F6F5F0}' +
    '.tct-l{list-style:none;margin:0;padding:6px 8px 8px}.tct-l li{display:grid;grid-template-columns:5.2em 6.4em 1fr;gap:6px;align-items:center;padding:6px 4px;border-bottom:1px solid #ECEAE3}' +
    '.tct-l li:last-child{border-bottom:0}.tct-n{font-weight:700;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
    '.tct-p{display:inline-block;text-align:center;border-radius:6px;padding:2px 4px;font-size:12px;font-weight:700;white-space:nowrap}' +
    '.tct-d{font-size:12px;color:#5B5750;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.tct-d b{color:#22231F;font-size:13px}' +
    '.p-in{background:#2E7D55;color:#fff}.p-out{background:#E5EDE7;color:#214A37}.p-no{background:#B0533F;color:#fff}.p-yet{background:#ECEAE3;color:#5B5750}.p-rest{background:#F1E6DA;color:#8a5a2b}' +
    '.tct-f{display:flex;align-items:center;gap:8px;padding:6px 12px 10px;font-size:12px;color:#5B5750}.tct-f .g{flex:1}.tct-f a,.tct-f button{font:inherit;color:#214A37;background:none;border:1px solid #DCD9D0;border-radius:8px;padding:4px 10px;text-decoration:none;cursor:pointer}' +
    '.tct-one{display:flex;align-items:center;gap:8px;padding:9px 12px;flex-wrap:wrap}.tct-one .g{flex:1}.tct-one a{font-size:12px;color:#214A37}' +
    '.tct-warn{color:#C0492F;font-weight:700}';

  /** 1人分の状態 → { k: 並び順, cls, label, detail } */
  function status(r, ctx) {
    var d = r.day || {}, site = d.site || '';
    if (d.outSite && d.outSite !== d.site) site = (site ? site + ' → ' : '→ ') + d.outSite;
    var note = [];
    if (d.direct === '1') note.push('直行');
    else if (d.away === '1') note.push('<span class="tct-warn">事務所外で出勤</span>');
    if (d.kind === '休み' && d.half) note.push(d.half === 'am' ? '午前休' : '午後休');
    var tail = (site ? esc(site) : '') + (note.length ? (site ? '・' : '') + note.join('・') : '');
    if (d.in && !d.out) return { k: 1, cls: 'p-in', label: '出勤中', detail: '<b>' + esc(d.in) + '〜</b> ' + tail };
    if (d.in && d.out) return { k: 2, cls: 'p-out', label: '退勤', detail: '<b>' + esc(d.in) + '〜' + esc(d.out) + '</b> ' + tail };
    if (d.out && !d.in) return { k: 0, cls: 'p-no', label: '出勤なし', detail: '退勤 ' + esc(d.out) };
    if (d.kind === '休み') return { k: 4, cls: 'p-rest', label: d.half === 'am' ? '午前休' : d.half === 'pm' ? '午後休' : '休み', detail: d.half === 'am' ? '午後から出勤' : d.half === 'pm' ? '午前だけ出勤（打刻なし）' : '' };
    if (d.kind && d.kind !== '出勤' && d.kind !== '休日出勤') return { k: 4, cls: 'p-rest', label: d.kind.replace('（全日）', '').replace('（半日）', '半日'), detail: '' };
    if (r.calRest) return { k: 4, cls: 'p-rest', label: '休み予定', detail: 'カレンダー：' + esc(r.calRest) };
    if (ctx.off) return { k: 5, cls: 'p-yet', label: '会社の休み', detail: '' };
    if (r.pay === 'hourly') return { k: 3, cls: 'p-yet', label: 'まだ', detail: '時給（出ない日もあります）' };
    if (ctx.now >= (ctx.start || '07:30')) return { k: 0, cls: 'p-no', label: '未出勤', detail: '始業 ' + esc(ctx.start || '07:30') + ' を過ぎています' };
    return { k: 3, cls: 'p-yet', label: 'まだ', detail: '' };
  }

  function render() {
    if (!el) return;
    var t = token(), m = me();
    if (!t || !m) {
      el.innerHTML = '<div class="tct"><div class="tct-one"><b style="color:#214A37">今日の出勤</b><span class="g tct-d">この端末でタイムカードにログインすると、ここに出ます</span><a href="timecard.html">タイムカードを開く</a></div></div>';
      return;
    }
    if (!data) {
      el.innerHTML = '<div class="tct"><div class="tct-one"><b style="color:#214A37">今日の出勤</b><span class="g tct-d">' + (err ? esc(err) : '読み込み中…') + '</span>' + (err ? '<a href="timecard.html">タイムカードを開く</a>' : '') + '</div></div>';
      return;
    }
    var ctx = { now: jstNow().time, start: data.start, off: data.off };
    var rows = data.rows.map(function (r) { return { r: r, s: status(r, ctx) }; });
    rows.sort(function (a, b) { return a.s.k - b.s.k || String(a.r.disp).localeCompare(String(b.r.disp), 'ja'); });
    var upd = (busy ? '更新中…' : (data._at ? data._at + ' 時点' : '')) + (err ? '（' + esc(err) + '）' : '');
    // スタッフ：自分の1行だけ
    if (!data.admin) {
      var x = rows[0];
      el.innerHTML = '<div class="tct"><div class="tct-one"><b style="color:#214A37">今日の出勤</b>' +
        (x ? '<span class="tct-p ' + x.s.cls + '">' + esc(x.s.label) + '</span><span class="g tct-d">' + x.s.detail + '</span>' : '<span class="g tct-d">打刻の対象ではありません</span>') +
        '<a href="timecard.html">タイムカード</a></div></div>';
      return;
    }
    var cnt = { in: 0, out: 0, no: 0, rest: 0, yet: 0 };
    rows.forEach(function (x) { var c = x.s.cls; if (c === 'p-in') cnt.in++; else if (c === 'p-out') cnt.out++; else if (c === 'p-no') cnt.no++; else if (c === 'p-rest') cnt.rest++; else cnt.yet++; });
    var open = isOpen();
    var sum = '出勤中' + cnt.in + (cnt.out ? '・退勤' + cnt.out : '') + '・休み' + cnt.rest + (cnt.no ? '・<span class="tct-warn">未出勤' + cnt.no + '</span>' : '');
    el.innerHTML = '<div class="tct">' +
      '<button type="button" class="tct-h" data-tct="toggle" aria-expanded="' + open + '"><b>今日の出勤</b><span class="c">' + esc(dlabel(data.date)) + (data.off ? '・会社の休み' : '') + '</span><span class="g c" style="text-align:right">' + sum + '</span><span class="ar">' + (open ? '▲' : '▼') + '</span></button>' +
      (open ? '<ul class="tct-l">' + rows.map(function (x) {
        return '<li><span class="tct-n">' + esc(x.r.disp) + '</span><span><span class="tct-p ' + x.s.cls + '">' + esc(x.s.label) + '</span></span><span class="tct-d">' + x.s.detail + '</span></li>';
      }).join('') + '</ul>' +
      '<div class="tct-f"><span class="g">' + upd + '</span><button type="button" data-tct="reload">更新</button><a href="timecard.html">タイムカードで見る</a></div>' : '') +
      '</div>';
  }

  function load() {
    var t = token();
    if (!t || busy) { render(); return; }
    busy = true; render();
    var ac = window.AbortController ? new AbortController() : null, tm = setTimeout(function () { if (ac) ac.abort(); }, 30000);
    fetch(GAS_URL, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ app: 'timecard', action: 'today', token: t }), signal: ac ? ac.signal : undefined })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) { err = d.code === 'auth' ? 'タイムカードでもう一度ログインしてください' : (d.error || '読めませんでした'); if (d.code === 'auth') data = null; return; }
        err = ''; d._at = jstNow().time; d._me = (me() || {}).id; data = d; lsSet(CACHE, d);
      })
      .catch(function () { err = '電波がないので前の内容です'; })
      .then(function () { clearTimeout(tm); busy = false; render(); });
  }

  function mount() {
    el = document.getElementById('tcToday');
    if (!el) return;
    if (!document.getElementById('tct-css')) { var st = document.createElement('style'); st.id = 'tct-css'; st.textContent = CSS; document.head.appendChild(st); }
    var c = lsGet(CACHE), m = me();
    if (c && m && c._me === m.id && c.date === jstNow().date) data = c;   // 前回の内容（今日・同じ人の分だけ）
    el.addEventListener('click', function (e) {
      var b = e.target.closest('[data-tct]'); if (!b) return;
      if (b.dataset.tct === 'toggle') { lsSet(OPEN, !isOpen()); render(); }
      if (b.dataset.tct === 'reload') load();
    });
    render(); load();
    timer = setInterval(function () { if (document.visibilityState === 'visible') load(); }, 180000);
    document.addEventListener('visibilitychange', function () { if (document.visibilityState === 'visible') load(); });
    window.addEventListener('storage', function (e) { if (e.key === 'tc_token' || e.key === 'tc_me') { data = null; load(); } });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
  window.TcToday = { reload: load };
})();

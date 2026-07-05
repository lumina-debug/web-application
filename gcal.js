"use strict";

/* =========================================================
 * 段取り（Dandori） — 週間予定表モジュール（Google カレンダー連携）
 *
 *   分割済みの未完了タスクを「その週の空き時間」に自動で割り当てて
 *   週間予定表（アプリ内カレンダー）を作り、Google カレンダーへ登録する。
 *
 *   - 既存の予定は Google カレンダーから読み込む／手入力の両対応
 *   - 割り当ては決め打ちルール：至急 → 締切が近い → 優先度スコア順に、
 *     稼働時間帯の早い空きスロット（15分刻み）へ詰める
 *   - 予定表はアプリ内の週カレンダーに表示し、行単位で日時・所要を調整可
 *   - 登録は Google Calendar API（REST）。アクセストークンは sync.js の
 *     window.DandoriCloud ブリッジ（Firebase Auth の Google ログイン）から取得
 *   - Google に接続できない環境向けに .ics 保存も用意
 *
 *   app.js とは window.Dandori（state 参照・priorityOf）経由で疎結合。
 * ======================================================= */

(function () {

  const SCOPE = "https://www.googleapis.com/auth/calendar.events";
  const API = "https://www.googleapis.com/calendar/v3";
  const PREFS_KEY = "dandori.gcalPrefs";     // 稼働時間帯などの端末ローカル設定
  const PENDING_KEY = "dandori.gcalPending"; // リダイレクトログイン中の作業状態
  const STEP_MS = 15 * 60 * 1000;            // 開始時刻は15分刻み
  const HOUR_PX = 44;                        // カレンダー1時間の高さ(px)
  const WD = ["日", "月", "火", "水", "木", "金", "土"];

  /* ---------- 状態 ---------- */
  let overlay = null;
  let prefs = loadPrefs();
  let weekOffset = 0;        // 0=今週, 1=来週, 2=再来週
  let gcalBusy = null;       // Googleカレンダーから読んだ予定（null=未読込）
  let manualBusy = [];       // 手入力の予定（パース済み）
  let manualText = "";       // 手入力テキスト（textarea の内容）
  let selectedIds = null;    // 割り当て対象タスクid（null=未初期化→全選択）
  let plan = null;           // { rows:[...], unplaced:[...] }
  let pushing = false;

  function defaults() { return { workStart: "09:00", workEnd: "18:00", weekend: false, defDur: 60 }; }
  function loadPrefs() {
    try {
      const o = JSON.parse(localStorage.getItem(PREFS_KEY) || "null");
      if (o) return Object.assign(defaults(), o);
    } catch (e) { /* ignore */ }
    return defaults();
  }
  function savePrefs() {
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* ignore */ }
  }

  /* ---------- 小道具 ---------- */
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function p2(n) { return String(n).padStart(2, "0"); }
  function ymd(d) { return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()); }
  function atTime(d, hmStr) {
    const m = String(hmStr || "0:00").split(":");
    const x = new Date(d); x.setHours(Number(m[0]) || 0, Number(m[1]) || 0, 0, 0); return x;
  }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function mondayOf(d) {
    const x = new Date(d); x.setHours(0, 0, 0, 0);
    x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x;
  }
  function weekStartDate() { return addDays(mondayOf(new Date()), weekOffset * 7); }
  function mdw(d) { return (d.getMonth() + 1) + "/" + d.getDate() + "(" + WD[d.getDay()] + ")"; }
  function ceilStep(d) { return new Date(Math.ceil(d.getTime() / STEP_MS) * STEP_MS); }
  function parseHM(hmStr) { const m = String(hmStr).split(":"); return (Number(m[0]) || 0) * 60 + (Number(m[1]) || 0); }
  function minOfDay(d) { return d.getHours() * 60 + d.getMinutes(); }
  function msg(e) { return (e && (e.message || e.code)) || String(e); }
  function q(sel) { return overlay ? overlay.querySelector(sel) : null; }

  function toRFC3339(d) {
    const off = -d.getTimezoneOffset();
    const sign = off >= 0 ? "+" : "-";
    const a = Math.abs(off);
    return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()) +
      "T" + p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":00" +
      sign + p2(Math.floor(a / 60)) + ":" + p2(a % 60);
  }

  /* ---------- タスク（app.js の state を参照） ---------- */
  function prioScore(t) {
    try { const p = window.Dandori.priorityOf(t); return (p && p.score) || 0; } catch (e) { return 0; }
  }
  // 割り当て順：至急 → 締切が近い → 優先度スコア
  function cmpTasks(a, b) {
    if (!!a.t.pinned !== !!b.t.pinned) return a.t.pinned ? -1 : 1;
    const da = a.t.deadline || "9999-12-31", db = b.t.deadline || "9999-12-31";
    if (da !== db) return da < db ? -1 : 1;
    return b.score - a.score;
  }
  function activeTasksSorted() {
    const st = window.Dandori.getState();
    return st.tasks.filter((t) => t.status !== "done")
      .map((t) => ({ t, score: prioScore(t) }))
      .sort(cmpTasks)
      .map((x) => x.t);
  }
  function goalTitle(goalId) {
    if (!goalId) return "";
    const st = window.Dandori.getState();
    const g = (st.goals || []).find((x) => x.id === goalId);
    return g ? ((g.emoji ? g.emoji + " " : "") + g.title) : "";
  }

  /* ---------- 手入力の予定のパース ----------
   * 1行1件。例：
   *   7/7 13:00-14:00 定例会議
   *   2026/7/9 10:00〜11:30 通院
   *   金 18:00-19:00 送迎        （曜日はその週の日付に読み替え）      */
  function parseBusyLines(text, weekStart) {
    const events = [], errors = [];
    const reDate = /^\s*(?:(\d{4})[\/\-年])?(\d{1,2})[\/\-月](\d{1,2})日?\s+(\d{1,2}):(\d{2})\s*[-〜~－ー]\s*(\d{1,2}):(\d{2})\s*(.*)$/;
    const reWd = /^\s*([月火水木金土日])(?:曜日?)?\s+(\d{1,2}):(\d{2})\s*[-〜~－ー]\s*(\d{1,2}):(\d{2})\s*(.*)$/;
    String(text || "").split(/\r?\n/).forEach((line, i) => {
      if (!line.trim()) return;
      let d = null, rest = null, m = line.match(reDate);
      if (m) {
        d = new Date(m[1] ? Number(m[1]) : weekStart.getFullYear(), Number(m[2]) - 1, Number(m[3]));
        if (!m[1]) { // 年の指定なし：選択中の週に近い年とみなす
          if (d - weekStart > 180 * 86400000) d.setFullYear(d.getFullYear() - 1);
          else if (weekStart - d > 180 * 86400000) d.setFullYear(d.getFullYear() + 1);
        }
        rest = m.slice(4);
      } else if ((m = line.match(reWd))) {
        d = addDays(weekStart, (WD.indexOf(m[1]) + 6) % 7); // 月=先頭
        rest = m.slice(2);
      } else { errors.push(i + 1); return; }
      const s = new Date(d); s.setHours(Number(rest[0]), Number(rest[1]), 0, 0);
      const e = new Date(d); e.setHours(Number(rest[2]), Number(rest[3]), 0, 0);
      if (e <= s) { errors.push(i + 1); return; }
      events.push({ start: s, end: e, title: (rest[4] || "").trim() || "予定", src: "manual" });
    });
    return { events, errors };
  }

  // 空き時間の計算に使う「ふさがっている時間」（終日・空き扱いの予定は除く）
  function allBusy() {
    const g = (gcalBusy || []).filter((b) => !b.allDay && !b.free);
    return g.concat(manualBusy);
  }

  /* ---------- 自動割り当て ----------
   * tasks: 割り当てるタスク配列
   * opts:  { weekStart, workStart, workEnd, weekend, defDur, busy, now, scoreFn } */
  function computePlan(tasks, opts) {
    const now = opts.now || new Date();
    const scoreFn = opts.scoreFn || prioScore;

    // 稼働日ごとの空きスロットを作る
    const days = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(opts.weekStart, i);
      const dow = d.getDay();
      if (!opts.weekend && (dow === 0 || dow === 6)) continue;
      let s = atTime(d, opts.workStart);
      const e = atTime(d, opts.workEnd);
      if (e <= now) continue;           // 過ぎた日はスキップ
      if (s < now) s = new Date(now);   // 今日は「今」以降だけ使う
      s = ceilStep(s);
      if (s >= e) continue;
      const dayBusy = (opts.busy || [])
        .filter((b) => b.end > s && b.start < e)
        .map((b) => ({ s: b.start < s ? s : b.start, e: b.end > e ? e : b.end }))
        .sort((a, b) => a.s - b.s);
      const slots = [];
      let cur = s;
      for (const b of dayBusy) {
        if (b.s > cur) slots.push({ s: new Date(cur), e: new Date(b.s) });
        if (b.e > cur) cur = b.e;
      }
      if (cur < e) slots.push({ s: new Date(cur), e: new Date(e) });
      days.push({ date: d, slots });
    }

    const sorted = tasks.map((t) => ({ t, score: scoreFn(t) })).sort(cmpTasks);

    const rows = [], unplaced = [];
    for (const { t } of sorted) {
      const dur = Math.max(15, Math.round((t.effort || opts.defDur) / 5) * 5);
      let placed = null;
      outer:
      for (const day of days) {
        for (let si = 0; si < day.slots.length; si++) {
          const start = ceilStep(day.slots[si].s);
          const end = new Date(start.getTime() + dur * 60000);
          if (end <= day.slots[si].e) { placed = { day, si, start, end }; break outer; }
        }
      }
      if (!placed) {
        unplaced.push({
          id: t.id, title: t.title, dur,
          reason: "空き時間が足りません" + (dur > 240 ? "（見積が長いので「分解」で分割を検討）" : ""),
        });
        continue;
      }
      // 使ったスロットを前後の残りに分割
      const slot = placed.day.slots[placed.si];
      const rest = [];
      if (placed.start - slot.s >= STEP_MS) rest.push({ s: slot.s, e: placed.start });
      if (slot.e - placed.end >= STEP_MS) rest.push({ s: placed.end, e: slot.e });
      placed.day.slots.splice(placed.si, 1, ...rest);

      let warn = "";
      if (t.deadline && placed.end > atTime(new Date(t.deadline + "T00:00:00"), "23:59")) {
        warn = "締切（" + t.deadline.slice(5).replace("-", "/") + "）を過ぎた割り当てです";
      }
      rows.push({
        id: t.id, title: t.title, note: t.note || "", goalId: t.goalId || null,
        deadline: t.deadline || null, pinned: !!t.pinned,
        day: ymd(placed.start), time: p2(placed.start.getHours()) + ":" + p2(placed.start.getMinutes()),
        dur, include: true, warn, done: false, error: "",
      });
    }
    return { rows, unplaced };
  }

  // 行編集後の警告（締切・既存予定との重なり）を付け直す
  function recomputeWarns() {
    if (!plan) return;
    const busy = allBusy();
    const rows = plan.rows;
    for (const r of rows) {
      r.warn = "";
      if (!r.include || r.done) continue;
      const s = new Date(r.day + "T" + r.time + ":00");
      const e = new Date(s.getTime() + r.dur * 60000);
      if (r.deadline && e > atTime(new Date(r.deadline + "T00:00:00"), "23:59")) {
        r.warn = "締切（" + r.deadline.slice(5).replace("-", "/") + "）を過ぎた割り当てです";
        continue;
      }
      for (const b of busy) {
        if (b.end > s && b.start < e) { r.warn = "既存の予定と重なっています"; break; }
      }
      if (r.warn) continue;
      for (const o of rows) {
        if (o === r || !o.include) continue;
        const os = new Date(o.day + "T" + o.time + ":00");
        const oe = new Date(os.getTime() + o.dur * 60000);
        if (oe > s && os < e) { r.warn = "他のタスクと重なっています"; break; }
      }
    }
  }

  /* ---------- Google 認証（sync.js のブリッジ経由） ---------- */
  async function getToken() {
    if (!window.DandoriCloud) throw new Error("同期モジュール（sync.js）が読み込まれていません。");
    return await window.DandoriCloud.getGoogleToken(SCOPE);
  }

  function savePending(action) {
    try {
      localStorage.setItem(PENDING_KEY, JSON.stringify({
        action,
        weekOffset,
        prefs,
        manualText,
        selected: selectedIds ? Array.from(selectedIds) : null,
        plan,
      }));
    } catch (e) { /* ignore */ }
  }

  function handleAuthError(e, action) {
    if (e && e.redirectRequired && typeof e.redirect === "function") {
      // 作業状態を保存してから画面遷移ログインへ（復帰後に自動で続きを実行）
      savePending(action);
      setStatus("Googleのログイン画面に移動します…");
      e.redirect().catch((err) => {
        try { localStorage.removeItem(PENDING_KEY); } catch (_) { /* ignore */ }
        setStatus("ログインに失敗：" + msg(err), true);
      });
      return;
    }
    const code = (e && e.code) || "";
    if (/popup-closed-by-user|cancelled-popup-request/i.test(code)) {
      setStatus("ログインがキャンセルされました。", true);
    } else if (/user-mismatch/i.test(code)) {
      setStatus("同期でログイン中と同じGoogleアカウントを選んでください。", true);
    } else {
      setStatus("Google認証に失敗：" + msg(e), true);
    }
  }

  function apiErrText(status, j) {
    const gm = (j && j.error && j.error.message) || "";
    if (status === 401) {
      if (window.DandoriCloud) window.DandoriCloud.clearGoogleToken();
      return "認証の有効期限が切れました（401）。もう一度ボタンを押してください。";
    }
    if (status === 403) {
      if (/not been used|disabled|accessNotConfigured/i.test(gm)) {
        return "Google Calendar API が有効になっていません（初回のみの設定。下の「うまくいかない時」参照）。";
      }
      if (/insufficient/i.test(gm)) {
        if (window.DandoriCloud) window.DandoriCloud.clearGoogleToken();
        return "カレンダーへの権限が足りません。もう一度ボタンを押して、カレンダーへのアクセスを許可してください。";
      }
      return "アクセスが拒否されました（403）：" + gm;
    }
    return "エラー（" + status + "）：" + (gm || "不明");
  }

  /* ---------- Google カレンダーから予定を読み込む ---------- */
  async function loadFromGoogle() {
    const el = q("#gc-load-state");
    if (el) { el.textContent = "読み込み中…"; el.classList.remove("is-error"); }
    let token;
    try { token = await getToken(); }
    catch (e) { if (el) el.textContent = ""; handleAuthError(e, "load"); return; }
    try {
      const ws = weekStartDate(), we = addDays(ws, 7);
      const url = API + "/calendars/primary/events?" + new URLSearchParams({
        timeMin: ws.toISOString(),
        timeMax: we.toISOString(),
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "250",
      });
      const res = await fetch(url, { headers: { Authorization: "Bearer " + token } });
      if (!res.ok) {
        const j = await res.json().catch(() => null);
        if (el) { el.textContent = apiErrText(res.status, j); el.classList.add("is-error"); }
        return;
      }
      const data = await res.json();
      gcalBusy = (data.items || [])
        .filter((ev) => ev.status !== "cancelled")
        .map((ev) => {
          if (ev.start && ev.start.dateTime) {
            return {
              start: new Date(ev.start.dateTime), end: new Date(ev.end.dateTime),
              title: ev.summary || "予定", src: "gcal",
              free: ev.transparency === "transparent",
            };
          }
          if (ev.start && ev.start.date) {
            return { allDay: true, day: ev.start.date, title: ev.summary || "終日", src: "gcal" };
          }
          return null;
        })
        .filter(Boolean);
      const n = gcalBusy.filter((b) => !b.allDay && !b.free).length;
      const ad = gcalBusy.filter((b) => b.allDay).length;
      if (el) el.textContent = "読み込みました：" + n + "件" + (ad ? "（＋終日" + ad + "件）" : "");
      recomputeWarns();
      renderCalendar();
      renderPlanArea();
    } catch (e) {
      if (el) { el.textContent = "読み込みに失敗：" + msg(e); el.classList.add("is-error"); }
    }
  }

  /* ---------- Google カレンダーへ登録 ---------- */
  function eventDesc(r) {
    const lines = [];
    const g = goalTitle(r.goalId);
    if (g) lines.push("目標: " + g);
    if (r.deadline) lines.push("締切: " + r.deadline);
    if (r.note) lines.push(r.note);
    lines.push("— 段取り（Dandori）から登録");
    return lines.join("\n");
  }

  async function pushToGoogle() {
    if (!plan || pushing) return;
    const rows = plan.rows.filter((r) => r.include && !r.done);
    if (!rows.length) { setStatus("登録するものがありません（すべて登録済みか、チェックが外れています）。"); return; }
    let token;
    try { token = await getToken(); }
    catch (e) { handleAuthError(e, "push"); return; }
    pushing = true;
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    let ok = 0, fail = 0, i = 0;
    for (const r of rows) {
      i++;
      setStatus("登録中… " + i + "/" + rows.length);
      const start = new Date(r.day + "T" + r.time + ":00");
      const end = new Date(start.getTime() + r.dur * 60000);
      const body = {
        summary: r.title,
        description: eventDesc(r),
        start: { dateTime: toRFC3339(start), timeZone: tz },
        end: { dateTime: toRFC3339(end), timeZone: tz },
      };
      try {
        const res = await fetch(API + "/calendars/primary/events", {
          method: "POST",
          headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (res.ok) { r.done = true; r.error = ""; ok++; }
        else {
          const j = await res.json().catch(() => null);
          r.error = apiErrText(res.status, j);
          fail++;
          if (res.status === 401) break; // トークン切れ：以降は再取得後にやり直し
        }
      } catch (err) { r.error = "通信エラー：" + msg(err); fail++; }
    }
    pushing = false;
    renderPlanArea();
    renderCalendar();
    setStatus(
      "登録結果：成功 " + ok + "件" + (fail ? "／失敗 " + fail + "件（各行のメッセージを確認）" : "。Googleカレンダーに反映されました。"),
      fail > 0
    );
  }

  /* ---------- .ics 書き出し（Googleが使えない時の代替） ---------- */
  function icsEsc(s) {
    return String(s == null ? "" : s)
      .replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n");
  }
  function icsDate(d) { return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); }
  function icsForRows(rows) {
    const now = icsDate(new Date());
    const out = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Dandori//JP", "CALSCALE:GREGORIAN"];
    rows.forEach((r, i) => {
      const start = new Date(r.day + "T" + r.time + ":00");
      const end = new Date(start.getTime() + r.dur * 60000);
      out.push(
        "BEGIN:VEVENT",
        "UID:dandori-" + now + "-" + i + "@dandori",
        "DTSTAMP:" + now,
        "DTSTART:" + icsDate(start),
        "DTEND:" + icsDate(end),
        "SUMMARY:" + icsEsc(r.title),
        "DESCRIPTION:" + icsEsc(eventDesc(r)),
        "END:VEVENT"
      );
    });
    out.push("END:VCALENDAR");
    return out.join("\r\n");
  }
  function downloadICS() {
    if (!plan) return;
    const rows = plan.rows.filter((r) => r.include);
    if (!rows.length) { setStatus("保存するものがありません。"); return; }
    const blob = new Blob([icsForRows(rows)], { type: "text/calendar" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "dandori-week-" + ymd(weekStartDate()) + ".ics";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(".ics を保存しました。カレンダーアプリで開く／取り込むと登録されます。");
  }

  /* =========================================================
   * UI
   * ======================================================= */
  function buildPanel() {
    overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.hidden = true;
    overlay.innerHTML =
      '<div class="modal modal-wide" role="dialog" aria-modal="true">' +
        '<div class="modal-header">' +
          '<h2>📆 週間予定表 → Google カレンダー</h2>' +
          '<button type="button" class="icon-btn" data-gc="close" aria-label="閉じる">×</button>' +
        '</div>' +
        '<div class="modal-body" id="gc-body"></div>' +
      '</div>';
    document.body.appendChild(overlay);
    overlay.addEventListener("click", (e) => { if (e.target === overlay) closePanel(); });
    overlay.querySelector('[data-gc="close"]').addEventListener("click", closePanel);
  }
  function openPanel() {
    if (!overlay) buildPanel();
    if (selectedIds === null) selectedIds = new Set(activeTasksSorted().map((t) => t.id));
    renderBody();
    overlay.hidden = false;
  }
  function closePanel() { if (overlay) overlay.hidden = true; }

  function setStatus(text, isError) {
    const el = q("#gc-status");
    if (!el) return;
    el.textContent = text || "";
    el.classList.toggle("is-error", !!isError);
  }

  function weekOptionsHTML() {
    const labels = ["今週", "来週", "再来週"];
    let html = "";
    for (let i = 0; i < 3; i++) {
      const ws = addDays(mondayOf(new Date()), i * 7);
      html += '<option value="' + i + '"' + (i === weekOffset ? " selected" : "") + ">" +
        labels[i] + "（" + mdw(ws) + "〜" + mdw(addDays(ws, 6)) + "）</option>";
    }
    return html;
  }

  function renderBody() {
    const body = q("#gc-body");
    if (!body) return;
    const durs = [30, 45, 60, 90, 120];
    body.innerHTML =
      '<p class="sync-sub">未完了タスクをその週の空き時間に自動で割り当てて予定表を作り、Google カレンダーへ登録します（.ics 保存も可）。</p>' +

      '<div class="gcal-opts">' +
        '<div class="field"><label for="gc-week">週</label><select id="gc-week">' + weekOptionsHTML() + '</select></div>' +
        '<div class="field"><label>作業に使う時間帯</label><div class="gcal-hours">' +
          '<input type="time" id="gc-ws" value="' + esc(prefs.workStart) + '"> 〜 ' +
          '<input type="time" id="gc-we" value="' + esc(prefs.workEnd) + '">' +
          '<label class="gcal-chk"><input type="checkbox" id="gc-weekend"' + (prefs.weekend ? " checked" : "") + '> 土日も使う</label>' +
        '</div></div>' +
        '<div class="field"><label for="gc-defdur">見積なしタスクの所要</label><select id="gc-defdur">' +
          durs.map((d) => '<option value="' + d + '"' + (d === prefs.defDur ? " selected" : "") + ">" + d + "分</option>").join("") +
        '</select></div>' +
      '</div>' +

      '<h3 class="gcal-step">1. その週の予定を取り込む</h3>' +
      '<div class="sync-actions">' +
        '<button id="gc-load" class="btn btn-ghost">📥 Googleカレンダーから読み込む</button>' +
        '<span id="gc-load-state" class="sync-status"></span>' +
      '</div>' +
      '<div class="field"><label for="gc-busy-text">手で追加（1行1件：「7/7 13:00-14:00 定例会議」「金 18:00-19:00 送迎」など）</label>' +
        '<textarea id="gc-busy-text" rows="3" placeholder="7/7 13:00-14:00 定例会議">' + esc(manualText) + '</textarea>' +
        '<div id="gc-busy-err" class="sync-status is-error"></div>' +
      '</div>' +

      '<h3 class="gcal-step">2. タスクを選んで空き時間に割り当てる</h3>' +
      '<div id="gc-task-list" class="gcal-task-list"></div>' +
      '<div class="sync-actions">' +
        '<button id="gc-make" class="btn btn-primary">🧮 空き時間に自動割り当て</button>' +
        '<span id="gc-make-state" class="sync-status"></span>' +
      '</div>' +

      '<h3 class="gcal-step">3. 週間予定表</h3>' +
      '<div id="gc-cal" class="gcal-cal"></div>' +
      '<div id="gc-plan-area"></div>' +
      '<p id="gc-status" class="sync-status"></p>' +

      '<details class="sync-help"><summary>うまくいかない時（初回設定・ヘルプ）</summary>' +
        '<ul class="sync-steps">' +
          '<li>「読み込む」「登録」には Google ログインと<b>カレンダーへのアクセス許可</b>が必要です（初回に許可画面が出ます）。</li>' +
          '<li><b>「Google Calendar API が有効になっていません」</b>と出る場合：<a href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=dandori-dddf0" target="_blank" rel="noopener">Google Cloud Console</a> でプロジェクト <code>dandori-dddf0</code> の Google Calendar API を有効化してください（1回だけ）。</li>' +
          '<li><b>「このアプリは確認されていません」</b>画面が出たら「詳細」→「（安全でないページに）移動」で続行できます。<b>アクセスがブロック</b>される場合は、OAuth同意画面（テストモード）の<b>テストユーザー</b>に自分のGmailを追加してください。</li>' +
          '<li>ポップアップがブロックされる環境（iPhoneのホーム画面アプリ等）では自動で画面遷移ログインに切り替わり、戻ってきたら続きから再開します。</li>' +
          '<li>Googleに接続できない場合は「📥 .icsで保存」→ カレンダーアプリに取り込みでも登録できます。</li>' +
        '</ul>' +
      '</details>';

    renderTaskList();
    renderCalendar();
    renderPlanArea();
    wireBody();
  }

  function wireBody() {
    q("#gc-week").addEventListener("change", (e) => {
      weekOffset = Number(e.target.value) || 0;
      gcalBusy = null;   // 週が変われば予定も読み直し
      plan = null;       // 割り当ても作り直し
      const el = q("#gc-load-state");
      if (el) { el.textContent = "週を変えました。必要なら読み込み直してください。"; el.classList.remove("is-error"); }
      applyManualText();
      renderCalendar();
      renderPlanArea();
    });
    q("#gc-ws").addEventListener("change", (e) => { prefs.workStart = e.target.value || "09:00"; savePrefs(); renderCalendar(); });
    q("#gc-we").addEventListener("change", (e) => { prefs.workEnd = e.target.value || "18:00"; savePrefs(); renderCalendar(); });
    q("#gc-weekend").addEventListener("change", (e) => { prefs.weekend = !!e.target.checked; savePrefs(); });
    q("#gc-defdur").addEventListener("change", (e) => { prefs.defDur = Number(e.target.value) || 60; savePrefs(); });

    q("#gc-load").addEventListener("click", loadFromGoogle);

    let busyTimer = null;
    q("#gc-busy-text").addEventListener("input", (e) => {
      manualText = e.target.value;
      clearTimeout(busyTimer);
      busyTimer = setTimeout(() => { applyManualText(); renderCalendar(); }, 300);
    });

    q("#gc-task-list").addEventListener("change", (e) => {
      const cb = e.target.closest("input[data-tid]");
      if (!cb) return;
      if (cb.checked) selectedIds.add(cb.dataset.tid); else selectedIds.delete(cb.dataset.tid);
    });

    q("#gc-make").addEventListener("click", makePlan);

    q("#gc-plan-area").addEventListener("change", onPlanEdit);
    q("#gc-plan-area").addEventListener("click", (e) => {
      const t = e.target;
      if (t && t.id === "gc-push") pushToGoogle();
      if (t && t.id === "gc-ics") downloadICS();
    });

    applyManualText();
  }

  function applyManualText() {
    const r = parseBusyLines(manualText, weekStartDate());
    manualBusy = r.events;
    const el = q("#gc-busy-err");
    if (el) el.textContent = r.errors.length ? "解釈できない行があります：" + r.errors.join(", ") + "行目" : "";
    recomputeWarns();
  }

  function renderTaskList() {
    const el = q("#gc-task-list");
    if (!el) return;
    const tasks = activeTasksSorted();
    if (!tasks.length) {
      el.innerHTML = '<p class="sync-sub">未完了のタスクがありません。先に「＋ タスクを追加」で作成してください。</p>';
      return;
    }
    el.innerHTML = tasks.map((t) => {
      const meta = [];
      meta.push(t.effort ? t.effort + "分" : "見積なし→" + prefs.defDur + "分");
      if (t.deadline) meta.push("締切 " + t.deadline.slice(5).replace("-", "/"));
      const g = goalTitle(t.goalId);
      if (g) meta.push(g);
      return '<label class="gcal-task-item">' +
        '<input type="checkbox" data-tid="' + esc(t.id) + '"' + (selectedIds.has(t.id) ? " checked" : "") + '>' +
        '<span>' + (t.pinned ? "🔥 " : "") + esc(t.title) + ' <span class="meta">（' + esc(meta.join("・")) + '）</span></span>' +
        '</label>';
    }).join("");
  }

  function makePlan() {
    applyManualText();
    const tasks = activeTasksSorted().filter((t) => selectedIds.has(t.id));
    const stateEl = q("#gc-make-state");
    if (!tasks.length) {
      if (stateEl) stateEl.textContent = "タスクが選ばれていません。";
      return;
    }
    plan = computePlan(tasks, {
      weekStart: weekStartDate(),
      workStart: prefs.workStart,
      workEnd: prefs.workEnd,
      weekend: prefs.weekend,
      defDur: prefs.defDur,
      busy: allBusy(),
    });
    if (stateEl) {
      stateEl.textContent = "割り当て：" + plan.rows.length + "件" +
        (plan.unplaced.length ? "／入りきらず " + plan.unplaced.length + "件" : "");
    }
    setStatus("");
    renderCalendar();
    renderPlanArea();
  }

  function onPlanEdit(e) {
    const row = e.target.closest(".gcal-row");
    if (!row || !plan) return;
    const r = plan.rows[Number(row.dataset.i)];
    if (!r) return;
    if (e.target.classList.contains("gc-r-inc")) r.include = !!e.target.checked;
    if (e.target.classList.contains("gc-r-day")) r.day = e.target.value;
    if (e.target.classList.contains("gc-r-time")) r.time = e.target.value || r.time;
    if (e.target.classList.contains("gc-r-dur")) r.dur = Math.max(5, Number(e.target.value) || r.dur);
    recomputeWarns();
    renderCalendar();
    renderPlanArea();
  }

  function renderPlanArea() {
    const el = q("#gc-plan-area");
    if (!el) return;
    if (!plan) { el.innerHTML = ""; return; }
    const ws = weekStartDate();
    const dayOpts = [];
    for (let i = 0; i < 7; i++) {
      const d = addDays(ws, i);
      dayOpts.push({ v: ymd(d), label: mdw(d) });
    }
    let html = plan.rows.map((r, i) => {
      const dis = r.done ? " disabled" : "";
      return '<div class="gcal-row' + (r.done ? " is-done" : "") + '" data-i="' + i + '">' +
        '<input type="checkbox" class="gc-r-inc"' + (r.include ? " checked" : "") + dis + '>' +
        '<span class="gcal-row-title">' + (r.done ? "✅ " : r.pinned ? "🔥 " : "") + esc(r.title) + '</span>' +
        '<select class="gc-r-day"' + dis + '>' +
          dayOpts.map((o) => '<option value="' + o.v + '"' + (o.v === r.day ? " selected" : "") + ">" + o.label + "</option>").join("") +
        '</select>' +
        '<input type="time" class="gc-r-time" value="' + esc(r.time) + '"' + dis + '>' +
        '<input type="number" class="gc-r-dur gcal-dur" min="5" step="5" value="' + r.dur + '"' + dis + '><span class="gcal-unit">分</span>' +
        (r.warn && !r.done ? '<span class="gcal-warn">⚠ ' + esc(r.warn) + '</span>' : "") +
        (r.error ? '<span class="gcal-err">' + esc(r.error) + '</span>' : "") +
        '</div>';
    }).join("");
    if (plan.unplaced.length) {
      html += '<div class="gcal-unplaced"><b>入りきらなかったタスク：</b><ul>' +
        plan.unplaced.map((u) => "<li>" + esc(u.title) + "（" + u.dur + "分）— " + esc(u.reason) + "</li>").join("") +
        "</ul>手入力の予定を減らす・時間帯を広げる・土日を使う・タスクを分解する、などで再度お試しください。</div>";
    }
    html += '<div class="sync-actions">' +
      '<button id="gc-push" class="btn btn-primary"' + (pushing ? " disabled" : "") + '>📤 Googleカレンダーへ登録</button>' +
      '<button id="gc-ics" class="btn btn-ghost">📥 .icsで保存</button>' +
    '</div>';
    el.innerHTML = html;
  }

  /* ---------- アプリ内の週カレンダー描画 ---------- */
  function renderCalendar() {
    const el = q("#gc-cal");
    if (!el) return;
    const ws = weekStartDate();
    const we = addDays(ws, 7);
    const busyAll = ((gcalBusy || []).concat(manualBusy)).filter((b) => !b.allDay);
    const rows = (plan && plan.rows.filter((r) => r.include)) || [];

    // 表示レンジ（分）：稼働時間帯を基本に、はみ出す予定があれば広げる
    let sMin = parseHM(prefs.workStart);
    let eMin = parseHM(prefs.workEnd);
    const consider = (s, e) => {
      if (e <= ws || s >= we) return;
      sMin = Math.min(sMin, minOfDay(s));
      const em = minOfDay(e);
      eMin = Math.max(eMin, em === 0 ? 24 * 60 : em);
    };
    busyAll.forEach((b) => consider(b.start, b.end));
    rows.forEach((r) => {
      const s = new Date(r.day + "T" + r.time + ":00");
      consider(s, new Date(s.getTime() + r.dur * 60000));
    });
    sMin = Math.max(0, Math.floor(sMin / 60) * 60);
    eMin = Math.min(24 * 60, Math.ceil(eMin / 60) * 60);
    if (eMin - sMin < 4 * 60) eMin = Math.min(24 * 60, sMin + 4 * 60);
    const bodyH = (eMin - sMin) / 60 * HOUR_PX;

    const blockHTML = (top, h, cls, label, title) =>
      '<div class="gcal-block ' + cls + '" style="top:' + top.toFixed(1) + 'px;height:' + Math.max(h, 12).toFixed(1) + 'px" title="' + esc(title) + '">' + esc(label) + '</div>';

    // 時刻軸
    let axis = "";
    for (let m = sMin; m <= eMin; m += 60) {
      axis += '<div class="gcal-hour-label" style="top:' + (((m - sMin) / 60) * HOUR_PX) + 'px">' + Math.floor(m / 60) + ':00</div>';
    }

    const todayYmd = ymd(new Date());
    let cols =
      '<div class="gcal-col gcal-axis"><div class="gcal-col-head"></div>' +
      '<div class="gcal-col-body" style="height:' + bodyH + 'px">' + axis + '</div></div>';

    for (let i = 0; i < 7; i++) {
      const d = addDays(ws, i);
      const d0 = new Date(d);
      const d1 = addDays(d, 1);
      const dYmd = ymd(d);
      let blocks = "";
      // 既存の予定（グレー）
      for (const b of busyAll) {
        const s = b.start < d0 ? d0 : b.start;
        const e = b.end > d1 ? d1 : b.end;
        if (e <= s || ymd(s) !== dYmd) continue;
        const top = (minOfDay(s) - sMin) / 60 * HOUR_PX;
        const h = (e - s) / 3600000 * HOUR_PX;
        const label = p2(s.getHours()) + ":" + p2(s.getMinutes()) + " " + b.title;
        blocks += blockHTML(top, h, b.src === "manual" ? "b-manual" : "b-busy" + (b.free ? " b-free" : ""), label, label + (b.free ? "（空き扱い）" : ""));
      }
      // 割り当てたタスク（紫）
      rows.forEach((r) => {
        if (r.day !== dYmd) return;
        const s = new Date(r.day + "T" + r.time + ":00");
        const top = (minOfDay(s) - sMin) / 60 * HOUR_PX;
        const h = r.dur / 60 * HOUR_PX;
        const label = r.time + " " + r.title;
        blocks += blockHTML(top, h, "b-task" + (r.done ? " is-done" : "") + (r.warn ? " is-warn" : ""), label, label);
      });
      // 終日予定はヘッダー下に表示
      const allday = (gcalBusy || []).filter((b) => b.allDay && b.day === dYmd);
      const adHtml = allday.length
        ? '<div class="gcal-allday" title="' + esc(allday.map((a) => a.title).join(" / ")) + '">終日: ' + esc(allday.map((a) => a.title).join(" / ")) + '</div>'
        : "";
      cols += '<div class="gcal-col' + (dYmd === todayYmd ? " is-today" : "") + '">' +
        '<div class="gcal-col-head">' + mdw(d) + adHtml + '</div>' +
        '<div class="gcal-col-body" style="height:' + bodyH + 'px">' + blocks + '</div></div>';
    }

    el.innerHTML =
      '<div class="gcal-cal-scroll"><div class="gcal-cal-grid">' + cols + '</div></div>' +
      '<div class="gcal-legend"><span class="lg lg-busy"></span>Googleカレンダーの予定　<span class="lg lg-manual"></span>手入力の予定　<span class="lg lg-task"></span>割り当てたタスク</div>';
  }

  /* ---------- リダイレクトログインからの復帰 ---------- */
  function waitForToken(ms) {
    return new Promise((resolve) => {
      const t0 = Date.now();
      const timer = setInterval(() => {
        if (window.DandoriCloud && window.DandoriCloud.hasCachedToken()) { clearInterval(timer); resolve(true); }
        else if (Date.now() - t0 > ms) { clearInterval(timer); resolve(false); }
      }, 400);
    });
  }

  function resumePending(p) {
    weekOffset = p.weekOffset || 0;
    if (p.prefs) prefs = Object.assign(defaults(), p.prefs);
    manualText = p.manualText || "";
    selectedIds = p.selected ? new Set(p.selected) : null;
    plan = p.plan || null;
    openPanel();
    setStatus("ログインから戻りました。確認しています…");
    waitForToken(12000).then((ok) => {
      if (!ok) { setStatus("ログインを確認できませんでした。もう一度ボタンを押してください。", true); return; }
      if (p.action === "push") pushToGoogle();
      else if (p.action === "load") loadFromGoogle();
      else setStatus("");
    });
  }

  /* ---------- 起動 ---------- */
  function start() {
    const btn = document.getElementById("gcal-btn");
    if (btn) btn.addEventListener("click", openPanel);
    let pending = null;
    try { pending = JSON.parse(localStorage.getItem(PENDING_KEY) || "null"); } catch (e) { /* ignore */ }
    if (pending) {
      try { localStorage.removeItem(PENDING_KEY); } catch (e) { /* ignore */ }
      try { resumePending(pending); } catch (e) { /* 復帰失敗時は通常起動 */ }
    }
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }

  // デバッグ・Node再現テスト用フック
  window.DandoriGcal = {
    open: openPanel,
    _test: { parseBusyLines, computePlan, toRFC3339, icsForRows },
  };

})();

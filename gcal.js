"use strict";

/* =========================================================
 * 段取り（Dandori） — 予定表モジュール（週表示 / 月表示）
 *
 *   コンセプト：
 *   - Google カレンダーは「既存予定の閲覧のみ」（readonly）。
 *     予定を見て“空いている時間”を把握するためだけに使う。
 *     タスクを Google に書き込むことはしない（カレンダーにはタスク以外も
 *     色々入っているため、用途を空き時間把握に絞る）。
 *   - ユーザーがカレンダー上を**ドラッグ／タップして「空き時間」枠**を作る。
 *   - アプリがその空き時間へ**未完了タスクを自動配置**（優先度順）。
 *   - 配置したタスク（紫のブロック）は**ドラッグで動かせる**。
 *   - **週表示 / 月表示**を切り替え、前後ナビで任意の週・月へ。
 *
 *   保存（すべて端末ローカル・クラウド非同期）：
 *   - dandori.gcalPrefs  … 表示時間帯・既定所要
 *   - dandori.gcalFree   … 空き時間枠 [{start,end}]（ms）
 *   - dandori.gcalPlan   … 配置したタスク [{id,title,...,start,dur}]
 *
 *   app.js とは window.Dandori（state 参照・priorityOf）で疎結合。
 *   Google 認証は sync.js の window.DandoriCloud ブリッジ経由。
 * ======================================================= */

(function () {

  const SCOPE = "https://www.googleapis.com/auth/calendar.readonly"; // 閲覧のみ
  const API = "https://www.googleapis.com/calendar/v3";
  const PREFS_KEY = "dandori.gcalPrefs";
  const FREE_KEY = "dandori.gcalFree";
  const PLAN_KEY = "dandori.gcalPlan";
  const PENDING_KEY = "dandori.gcalPending";
  const STEP_MS = 15 * 60 * 1000; // 15分刻み
  const HOUR_PX = 44;             // 週表示の1時間の高さ
  const WD = ["日", "月", "火", "水", "木", "金", "土"];

  /* ---------- 状態 ---------- */
  let overlay = null;
  let prefs = loadPrefs();
  let viewMode = "week";                 // "week" | "month"
  let anchor = startOfDay(new Date());   // 表示中の週/月を表す基準日
  let gcalBusy = [];                     // 読み込んだ既存予定
  let cachedRange = null;                // {start,end} 取得済み範囲(ms)
  let freeWindows = loadFree();          // [{start,end}] ms
  let planRows = loadPlan();             // 配置済みタスク
  let lastUnplaced = [];                 // 直近の自動配置で入りきらなかったもの
  let selectedIds = null;                // 配置対象タスクid（null=未初期化→全選択）
  let drag = null;                       // ドラッグ中の状態
  let render = { startMin: 0, top: 0, cols: [] }; // 週表示の座標系（ドラッグ計算用）

  /* ---------- 保存/読込 ---------- */
  function prefDefaults() { return { dayStart: "07:00", dayEnd: "22:00", defDur: 60 }; }
  function loadPrefs() {
    try { const o = JSON.parse(localStorage.getItem(PREFS_KEY) || "null"); if (o) return Object.assign(prefDefaults(), o); } catch (e) { /* ignore */ }
    return prefDefaults();
  }
  function savePrefs() { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* ignore */ } }
  function loadFree() {
    try { const a = JSON.parse(localStorage.getItem(FREE_KEY) || "[]"); const t0 = startOfDay(new Date()).getTime(); return (a || []).filter((w) => w && w.end > t0); } catch (e) { return []; }
  }
  function saveFree() { try { localStorage.setItem(FREE_KEY, JSON.stringify(freeWindows)); } catch (e) { /* ignore */ } }
  function loadPlan() {
    try { const a = JSON.parse(localStorage.getItem(PLAN_KEY) || "[]"); const t0 = startOfDay(new Date()).getTime(); return (a || []).filter((r) => r && (r.start + r.dur * 60000) > t0); } catch (e) { return []; }
  }
  function savePlan() { try { localStorage.setItem(PLAN_KEY, JSON.stringify(planRows)); } catch (e) { /* ignore */ } }

  /* ---------- 時刻ユーティリティ ---------- */
  function startOfDay(d) { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; }
  function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
  function addMonths(d, n) { const x = new Date(d); x.setMonth(x.getMonth() + n); return x; }
  function startOfWeek(d) { const x = startOfDay(d); x.setDate(x.getDate() - ((x.getDay() + 6) % 7)); return x; } // 月曜始まり
  function startOfMonth(d) { const x = startOfDay(d); x.setDate(1); return x; }
  function p2(n) { return String(n).padStart(2, "0"); }
  function ymd(d) { d = new Date(d); return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()); }
  function mdw(d) { d = new Date(d); return (d.getMonth() + 1) + "/" + d.getDate() + "(" + WD[d.getDay()] + ")"; }
  function parseHM(s) { const m = String(s).split(":"); return (Number(m[0]) || 0) * 60 + (Number(m[1]) || 0); }
  function minOfDay(ms) { const d = new Date(ms); return d.getHours() * 60 + d.getMinutes(); }
  function fmtTime(ms) { const d = new Date(ms); return p2(d.getHours()) + ":" + p2(d.getMinutes()); }
  function snapUp(ms) { return Math.ceil(ms / STEP_MS) * STEP_MS; }
  function snapNear(ms) { return Math.round(ms / STEP_MS) * STEP_MS; }
  function dayMs(dateOrMs) { return startOfDay(dateOrMs).getTime(); }
  function msg(e) { return (e && (e.message || e.code)) || String(e); }
  function esc(s) {
    return String(s == null ? "" : s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }
  function q(sel) { return overlay ? overlay.querySelector(sel) : null; }
  function toRFC3339(d) {
    d = new Date(d);
    const off = -d.getTimezoneOffset(), sign = off >= 0 ? "+" : "-", a = Math.abs(off);
    return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate()) +
      "T" + p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":00" + sign + p2(Math.floor(a / 60)) + ":" + p2(a % 60);
  }

  /* ---------- app.js のタスク（state 参照） ---------- */
  function prioScore(t) { try { const p = window.Dandori.priorityOf(t); return (p && p.score) || 0; } catch (e) { return 0; } }
  function cmpTasks(a, b) {
    if (!!a.pinned !== !!b.pinned) return a.pinned ? -1 : 1;
    const da = a.deadline || "9999-12-31", db = b.deadline || "9999-12-31";
    if (da !== db) return da < db ? -1 : 1;
    return prioScore(b) - prioScore(a);
  }
  function activeTasksSorted() {
    const st = window.Dandori.getState();
    return st.tasks.filter((t) => t.status !== "done").slice().sort(cmpTasks);
  }
  function goalTitle(goalId) {
    if (!goalId) return "";
    const st = window.Dandori.getState();
    const g = (st.goals || []).find((x) => x.id === goalId);
    return g ? ((g.emoji ? g.emoji + " " : "") + g.title) : "";
  }

  /* =========================================================
   * スケジューリング（純粋関数：Nodeでテスト可能）
   * ======================================================= */
  // 空き時間枠から、既存予定（busy）と「今」を差し引いた実際の空きスロットを返す
  function computeOpenSlots(free, busy, now) {
    now = now || 0;
    const b = (busy || []).filter((x) => !x.allDay && !x.free).map((x) => ({ s: x.start, e: x.end }));
    let slots = (free || []).map((w) => ({ s: Math.max(w.start, now), e: w.end })).filter((x) => x.e - x.s >= STEP_MS);
    for (const bb of b) {
      const nx = [];
      for (const s of slots) {
        if (bb.e <= s.s || bb.s >= s.e) { nx.push(s); continue; }
        if (bb.s > s.s) nx.push({ s: s.s, e: Math.min(bb.s, s.e) });
        if (bb.e < s.e) nx.push({ s: Math.max(bb.e, s.s), e: s.e });
      }
      slots = nx;
    }
    return slots.filter((x) => x.e - x.s >= STEP_MS).sort((a, b2) => a.s - b2.s);
  }

  // タスク（cmpTasks済み想定）を空きスロットへ詰める
  function placeTasks(tasks, slots, defDur) {
    slots = slots.map((s) => ({ s: s.s, e: s.e }));
    const rows = [], unplaced = [];
    for (const t of tasks) {
      const dur = Math.max(15, Math.round(((t.effort || defDur) || 60) / 5) * 5);
      let hit = -1, start = 0;
      for (let i = 0; i < slots.length; i++) {
        const st = snapUp(slots[i].s);
        if (st + dur * 60000 <= slots[i].e) { hit = i; start = st; break; }
      }
      if (hit < 0) { unplaced.push({ id: t.id, title: t.title, dur }); continue; }
      const slot = slots[hit], end = start + dur * 60000, rest = [];
      if (start - slot.s >= STEP_MS) rest.push({ s: slot.s, e: start });
      if (slot.e - end >= STEP_MS) rest.push({ s: end, e: slot.e });
      slots.splice(hit, 1, ...rest);
      rows.push({ id: t.id, start, dur });
    }
    return { rows, unplaced };
  }

  function rowFromTask(t, start, dur) {
    return { id: t.id, title: t.title, note: t.note || "", goalId: t.goalId || null,
      deadline: t.deadline || null, pinned: !!t.pinned, start, dur };
  }

  function autoPlace() {
    const tasks = activeTasksSorted().filter((t) => selectedIds.has(t.id));
    const slots = computeOpenSlots(freeWindows, gcalBusy, Date.now());
    const res = placeTasks(tasks, slots, prefs.defDur);
    const byId = {};
    tasks.forEach((t) => { byId[t.id] = t; });
    planRows = res.rows.map((r) => rowFromTask(byId[r.id], r.start, r.dur));
    lastUnplaced = res.unplaced.map((u) => ({ title: (byId[u.id] && byId[u.id].title) || u.title, dur: u.dur }));
    savePlan();
  }

  // 行の警告（重なり・空き外・締切超過・過去）
  function rowWarn(r) {
    const s = r.start, e = r.start + r.dur * 60000;
    if (e <= Date.now()) return "過去の時間です";
    if (r.deadline) { const dl = new Date(r.deadline + "T23:59:59").getTime(); if (e > dl) return "締切（" + r.deadline.slice(5).replace("-", "/") + "）を過ぎています"; }
    for (const b of gcalBusy) { if (b.allDay || b.free) continue; if (b.end > s && b.start < e) return "予定と重なっています"; }
    for (const o of planRows) { if (o === r) continue; const os = o.start, oe = o.start + o.dur * 60000; if (oe > s && os < e) return "他のタスクと重なっています"; }
    const inFree = freeWindows.some((w) => w.start <= s && w.end >= e);
    if (!inFree) return "空き時間の外です";
    return "";
  }

  /* =========================================================
   * Google カレンダー読み込み（閲覧のみ）
   * ======================================================= */
  async function getToken() {
    if (!window.DandoriCloud) throw new Error("同期モジュール（sync.js）が読み込まれていません。");
    return await window.DandoriCloud.getGoogleToken(SCOPE);
  }
  function savePending() {
    try { localStorage.setItem(PENDING_KEY, JSON.stringify({ viewMode, anchor: anchor.getTime() })); } catch (e) { /* ignore */ }
  }
  function handleAuthError(e) {
    if (e && e.redirectRequired && typeof e.redirect === "function") {
      savePending();
      setStatus("Googleのログイン画面に移動します…");
      e.redirect().catch((err) => { try { localStorage.removeItem(PENDING_KEY); } catch (_) {} setStatus("ログインに失敗：" + msg(err), true); });
      return;
    }
    const code = (e && e.code) || "";
    if (/popup-closed-by-user|cancelled-popup-request/i.test(code)) setStatus("ログインがキャンセルされました。", true);
    else setStatus("Google認証に失敗：" + msg(e), true);
  }
  function apiErrText(status, j) {
    const gm = (j && j.error && j.error.message) || "";
    if (status === 401) { if (window.DandoriCloud) window.DandoriCloud.clearGoogleToken(); return "認証の有効期限が切れました（401）。もう一度お試しください。"; }
    if (status === 403) {
      if (/not been used|disabled|accessNotConfigured/i.test(gm)) return "Google Calendar API が有効になっていません（初回のみの設定。下の「うまくいかない時」参照）。";
      if (/insufficient/i.test(gm)) { if (window.DandoriCloud) window.DandoriCloud.clearGoogleToken(); return "カレンダー閲覧の権限が足りません。もう一度押して、閲覧を許可してください。"; }
      return "アクセスが拒否されました（403）：" + gm;
    }
    return "エラー（" + status + "）：" + (gm || "不明");
  }

  // 表示中ビューをカバーする範囲を読み込む（週なら±その週＋数週、月なら前後含む）
  async function loadFromGoogle() {
    const el = q("#gc-load-state");
    if (el) { el.textContent = "読み込み中…"; el.classList.remove("is-error"); }
    let token;
    try { token = await getToken(); }
    catch (e) { if (el) el.textContent = ""; handleAuthError(e); return; }
    try {
      // 今日を含む週の頭から8週間ぶんを一括取得（週/月ナビをカバー）
      const start = startOfWeek(new Date());
      const end = addDays(start, 8 * 7);
      const url = API + "/calendars/primary/events?" + new URLSearchParams({
        timeMin: start.toISOString(), timeMax: end.toISOString(),
        singleEvents: "true", orderBy: "startTime", maxResults: "2500",
      });
      const res = await fetch(url, { headers: { Authorization: "Bearer " + token } });
      if (!res.ok) { const j = await res.json().catch(() => null); if (el) { el.textContent = apiErrText(res.status, j); el.classList.add("is-error"); } return; }
      const data = await res.json();
      gcalBusy = (data.items || []).filter((ev) => ev.status !== "cancelled").map((ev) => {
        if (ev.start && ev.start.dateTime) return { start: new Date(ev.start.dateTime).getTime(), end: new Date(ev.end.dateTime).getTime(), title: ev.summary || "予定", free: ev.transparency === "transparent" };
        if (ev.start && ev.start.date) return { allDay: true, day: ev.start.date, title: ev.summary || "終日" };
        return null;
      }).filter(Boolean);
      cachedRange = { start: start.getTime(), end: end.getTime() };
      const n = gcalBusy.filter((b) => !b.allDay && !b.free).length;
      if (el) el.textContent = "予定 " + n + "件を読み込みました（この予定を避けて空き時間に配置します）";
      renderView();
    } catch (e) { if (el) { el.textContent = "読み込みに失敗：" + msg(e); el.classList.add("is-error"); } }
  }

  /* ---------- .ics 書き出し（任意：別カレンダー等へ手動取込用） ---------- */
  function eventDesc(r) {
    const lines = []; const g = goalTitle(r.goalId);
    if (g) lines.push("目標: " + g);
    if (r.deadline) lines.push("締切: " + r.deadline);
    if (r.note) lines.push(r.note);
    lines.push("— 段取り（Dandori）");
    return lines.join("\n");
  }
  function icsEsc(s) { return String(s == null ? "" : s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n"); }
  function icsDate(ms) { return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); }
  function icsForRows(rows) {
    const now = icsDate(Date.now());
    const out = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Dandori//JP", "CALSCALE:GREGORIAN"];
    rows.forEach((r, i) => {
      out.push("BEGIN:VEVENT", "UID:dandori-" + now + "-" + i + "@dandori", "DTSTAMP:" + now,
        "DTSTART:" + icsDate(r.start), "DTEND:" + icsDate(r.start + r.dur * 60000),
        "SUMMARY:" + icsEsc(r.title), "DESCRIPTION:" + icsEsc(eventDesc(r)), "END:VEVENT");
    });
    out.push("END:VCALENDAR");
    return out.join("\r\n");
  }
  function downloadICS() {
    if (!planRows.length) { setStatus("配置したタスクがありません。"); return; }
    const blob = new Blob([icsForRows(planRows)], { type: "text/calendar" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = "dandori-plan-" + ymd(new Date()) + ".ics";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    setStatus(".ics を保存しました（任意のカレンダーに取り込めます）。");
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
          '<h2>📆 予定表</h2>' +
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
  function closePanel() { if (overlay) { overlay.hidden = true; drag = null; } }
  function setStatus(text, isError) { const el = q("#gc-status"); if (!el) return; el.textContent = text || ""; el.classList.toggle("is-error", !!isError); }

  function rangeLabel() {
    if (viewMode === "week") { const ws = startOfWeek(anchor); return mdw(ws) + " 〜 " + mdw(addDays(ws, 6)); }
    const m = startOfMonth(anchor); return m.getFullYear() + "年 " + (m.getMonth() + 1) + "月";
  }

  function renderBody() {
    const body = q("#gc-body");
    if (!body) return;
    const durs = [30, 45, 60, 90, 120];
    body.innerHTML =
      '<p class="sync-sub">Googleカレンダーの予定（灰色）を見ながら、空いている時間を<b>ドラッグ／タップで指定</b>すると、その枠に未完了タスクを<b>自動で配置</b>します。配置したタスク（紫）は<b>ドラッグで移動</b>できます。Googleへは書き込みません（閲覧のみ）。</p>' +

      '<div class="gcal-toolbar">' +
        '<div class="gcal-nav">' +
          '<button class="btn btn-ghost gc-icon" id="gc-prev" aria-label="前へ">‹</button>' +
          '<button class="btn btn-ghost" id="gc-today">今日</button>' +
          '<button class="btn btn-ghost gc-icon" id="gc-next" aria-label="次へ">›</button>' +
          '<span class="gcal-range" id="gc-range">' + esc(rangeLabel()) + '</span>' +
        '</div>' +
        '<div class="gcal-viewtoggle">' +
          '<button class="gc-vt' + (viewMode === "week" ? " is-active" : "") + '" data-view="week">週</button>' +
          '<button class="gc-vt' + (viewMode === "month" ? " is-active" : "") + '" data-view="month">月</button>' +
        '</div>' +
      '</div>' +

      '<div class="gcal-toolbar gcal-toolbar-2">' +
        '<div class="sync-actions" style="margin:0">' +
          '<button id="gc-load" class="btn btn-ghost">📥 Google予定を読み込む</button>' +
          '<span id="gc-load-state" class="sync-status"></span>' +
        '</div>' +
        '<details class="gcal-settings"><summary>表示設定</summary>' +
          '<div class="gcal-hours">表示時間帯 ' +
            '<input type="time" id="gc-ds" value="' + esc(prefs.dayStart) + '"> 〜 ' +
            '<input type="time" id="gc-de" value="' + esc(prefs.dayEnd) + '">' +
            '　見積なしの所要 <select id="gc-defdur">' +
              durs.map((d) => '<option value="' + d + '"' + (d === prefs.defDur ? " selected" : "") + ">" + d + "分</option>").join("") +
            '</select>' +
          '</div>' +
        '</details>' +
      '</div>' +

      '<div id="gc-cal"></div>' +

      '<div class="gcal-plan-controls">' +
        '<details class="gcal-tasks-wrap"><summary id="gc-tasks-sum">配置するタスクを選ぶ</summary>' +
          '<div id="gc-task-list" class="gcal-task-list"></div>' +
        '</details>' +
        '<div class="sync-actions">' +
          '<button id="gc-auto" class="btn btn-primary">🧮 空き時間にタスクを自動配置</button>' +
          '<button id="gc-clear-plan" class="btn btn-ghost">配置をクリア</button>' +
          '<button id="gc-clear-free" class="btn btn-ghost">空き時間をクリア</button>' +
          '<button id="gc-ics" class="link-btn">📥 .icsで保存（任意）</button>' +
        '</div>' +
        '<div id="gc-unplaced"></div>' +
        '<p id="gc-status" class="sync-status"></p>' +
      '</div>' +

      '<details class="sync-help"><summary>うまくいかない時（初回設定・ヘルプ）</summary>' +
        '<ul class="sync-steps">' +
          '<li><b>空き時間の作り方</b>：週表示でカレンダーの空欄を上下にドラッグ（スマホは長めにスワイプ）すると緑の枠ができます。枠をタップすると削除。月表示で日付をタップするとその週に移動します。</li>' +
          '<li><b>Google予定の読み込み</b>：Googleログインと<b>カレンダーの閲覧許可</b>が必要です（書き込みはしません）。初回に許可画面が出ます。</li>' +
          '<li><b>「Google Calendar API が有効になっていません」</b>：<a href="https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=dandori-dddf0" target="_blank" rel="noopener">Google Cloud Console</a> でプロジェクト <code>dandori-dddf0</code> の Calendar API を有効化（1回だけ）。</li>' +
          '<li><b>「このアプリは確認されていません」</b>→「詳細」→「移動」。<b>ブロック</b>される場合は OAuth 同意画面のテストユーザーに自分のGmailを追加。</li>' +
          '<li>Google予定を読み込まなくても、空き時間を手で指定すれば自動配置は使えます。</li>' +
        '</ul>' +
      '</details>';

    wireToolbar();
    renderTaskList();
    renderView();
  }

  function wireToolbar() {
    q("#gc-prev").addEventListener("click", () => { anchor = viewMode === "week" ? addDays(anchor, -7) : addMonths(anchor, -1); afterNav(); });
    q("#gc-next").addEventListener("click", () => { anchor = viewMode === "week" ? addDays(anchor, 7) : addMonths(anchor, 1); afterNav(); });
    q("#gc-today").addEventListener("click", () => { anchor = startOfDay(new Date()); afterNav(); });
    overlay.querySelectorAll(".gc-vt").forEach((b) => b.addEventListener("click", () => {
      viewMode = b.dataset.view; afterNav();
    }));
    q("#gc-load").addEventListener("click", loadFromGoogle);
    q("#gc-ds").addEventListener("change", (e) => { prefs.dayStart = e.target.value || "07:00"; savePrefs(); renderView(); });
    q("#gc-de").addEventListener("change", (e) => { prefs.dayEnd = e.target.value || "22:00"; savePrefs(); renderView(); });
    q("#gc-defdur").addEventListener("change", (e) => { prefs.defDur = Number(e.target.value) || 60; savePrefs(); });

    q("#gc-task-list").addEventListener("change", (e) => {
      const cb = e.target.closest("input[data-tid]"); if (!cb) return;
      if (cb.checked) selectedIds.add(cb.dataset.tid); else selectedIds.delete(cb.dataset.tid);
    });
    q("#gc-auto").addEventListener("click", () => {
      if (!freeWindows.length) { setStatus("先にカレンダーで空き時間を指定してください（空欄をドラッグ）。", true); return; }
      const n = selectedIds.size;
      if (!n) { setStatus("配置するタスクが選ばれていません。", true); return; }
      autoPlace();
      setStatus("配置しました：" + planRows.length + "件" + (lastUnplaced.length ? "／入りきらず " + lastUnplaced.length + "件" : "") + "。紫のブロックはドラッグで動かせます。");
      renderView();
    });
    q("#gc-clear-plan").addEventListener("click", () => { planRows = []; lastUnplaced = []; savePlan(); setStatus("配置をクリアしました。"); renderView(); });
    q("#gc-clear-free").addEventListener("click", () => { freeWindows = []; saveFree(); setStatus("空き時間の指定をクリアしました。"); renderView(); });
    q("#gc-ics").addEventListener("click", downloadICS);
  }
  function afterNav() {
    // ビュー切替でトグルの見た目・範囲ラベルを更新
    overlay.querySelectorAll(".gc-vt").forEach((b) => b.classList.toggle("is-active", b.dataset.view === viewMode));
    const rl = q("#gc-range"); if (rl) rl.textContent = rangeLabel();
    renderView();
  }

  function renderTaskList() {
    const el = q("#gc-task-list"); if (!el) return;
    const tasks = activeTasksSorted();
    const sum = q("#gc-tasks-sum"); if (sum) sum.textContent = "配置するタスクを選ぶ（" + selectedIds.size + "/" + tasks.length + "）";
    if (!tasks.length) { el.innerHTML = '<p class="sync-sub">未完了のタスクがありません。先に「＋ タスクを追加」で作成してください。</p>'; return; }
    el.innerHTML = tasks.map((t) => {
      const meta = [];
      meta.push(t.effort ? t.effort + "分" : "見積なし→" + prefs.defDur + "分");
      if (t.deadline) meta.push("締切 " + t.deadline.slice(5).replace("-", "/"));
      const g = goalTitle(t.goalId); if (g) meta.push(g);
      return '<label class="gcal-task-item"><input type="checkbox" data-tid="' + esc(t.id) + '"' + (selectedIds.has(t.id) ? " checked" : "") + '>' +
        '<span>' + (t.pinned ? "🔥 " : "") + esc(t.title) + ' <span class="meta">（' + esc(meta.join("・")) + '）</span></span></label>';
    }).join("");
  }

  function renderView() {
    if (viewMode === "month") renderMonth();
    else renderWeek();
    renderUnplaced();
  }

  function renderUnplaced() {
    const el = q("#gc-unplaced"); if (!el) return;
    if (!lastUnplaced.length) { el.innerHTML = ""; return; }
    el.innerHTML = '<div class="gcal-unplaced"><b>入りきらなかったタスク：</b><ul>' +
      lastUnplaced.map((u) => "<li>" + esc(u.title) + "（" + u.dur + "分）</li>").join("") +
      "</ul>空き時間を増やす・タスクを分解する、などで再度お試しください。</div>";
  }

  /* ---------- 週表示 ---------- */
  // 指定日の 0:00(ms) を返す（週の i 日目）
  function weekDayMs(i) { return startOfWeek(anchor).getTime() + i * 86400000; }

  function computeDisplayRange() {
    let sMin = parseHM(prefs.dayStart), eMin = parseHM(prefs.dayEnd);
    const ws = startOfWeek(anchor).getTime(), we = ws + 7 * 86400000;
    const consider = (a, b) => {
      if (b <= ws || a >= we) return;
      sMin = Math.min(sMin, minOfDay(a));
      const em = minOfDay(b) === 0 && b > a ? 24 * 60 : minOfDay(b);
      eMin = Math.max(eMin, em);
    };
    gcalBusy.forEach((b) => { if (!b.allDay) consider(b.start, b.end); });
    freeWindows.forEach((w) => consider(w.start, w.end));
    planRows.forEach((r) => consider(r.start, r.start + r.dur * 60000));
    sMin = Math.max(0, Math.floor(sMin / 60) * 60);
    eMin = Math.min(24 * 60, Math.ceil(eMin / 60) * 60);
    if (eMin - sMin < 4 * 60) eMin = Math.min(24 * 60, sMin + 4 * 60);
    return { sMin, eMin };
  }

  function blockHTML(topPx, hPx, cls, label, title, extra) {
    return '<div class="gcal-block ' + cls + '" style="top:' + topPx.toFixed(1) + 'px;height:' + Math.max(hPx, 11).toFixed(1) + 'px"' +
      (extra || "") + ' title="' + esc(title) + '">' + esc(label) + '</div>';
  }

  function renderWeek() {
    const el = q("#gc-cal"); if (!el) return;
    const { sMin, eMin } = computeDisplayRange();
    const bodyH = (eMin - sMin) / 60 * HOUR_PX;
    const todayY = ymd(new Date());

    let axis = "";
    for (let m = sMin; m <= eMin; m += 60) axis += '<div class="gcal-hour-label" style="top:' + (((m - sMin) / 60) * HOUR_PX) + 'px">' + Math.floor(m / 60) + ':00</div>';
    const axisCol = '<div class="gcal-col gcal-axis"><div class="gcal-col-head"></div><div class="gcal-col-body" style="height:' + bodyH + 'px">' + axis + '</div></div>';

    const topOf = (ms) => (minOfDay(ms) - sMin) / 60 * HOUR_PX;

    let cols = axisCol;
    for (let i = 0; i < 7; i++) {
      const d0 = weekDayMs(i), d1 = d0 + 86400000, dY = ymd(d0);
      let blocks = "";
      // Google 既存予定（灰）
      gcalBusy.forEach((b) => {
        if (b.allDay) return;
        const s = Math.max(b.start, d0), e = Math.min(b.end, d1);
        if (e <= s || ymd(s) !== dY) return;
        blocks += blockHTML(topOf(s), (e - s) / 3600000 * HOUR_PX, "b-busy" + (b.free ? " b-free-ev" : ""), fmtTime(s) + " " + b.title, fmtTime(s) + " " + b.title);
      });
      // 空き時間枠（緑）
      freeWindows.forEach((w, wi) => {
        const s = Math.max(w.start, d0), e = Math.min(w.end, d1);
        if (e <= s || ymd(s) !== dY) return;
        blocks += blockHTML(topOf(s), (e - s) / 3600000 * HOUR_PX, "b-free-win", "空き " + fmtTime(s) + "–" + fmtTime(e), "空き時間（タップで削除）", ' data-fi="' + wi + '"');
      });
      // 配置タスク（紫）
      planRows.forEach((r, ri) => {
        const s = r.start, e = r.start + r.dur * 60000;
        if (ymd(s) !== dY) return;
        const warn = rowWarn(r);
        blocks += blockHTML(topOf(s), r.dur / 60 * HOUR_PX, "b-task" + (warn ? " is-warn" : ""), fmtTime(s) + " " + r.title, fmtTime(s) + " " + r.title + (warn ? "（" + warn + "）" : ""), ' data-ri="' + ri + '"');
      });
      // ドラッグ中プレビュー（空き時間の作成）
      if (drag && drag.type === "draw" && drag.ymd === dY) {
        const a = Math.min(drag.startMin, drag.curMin), b = Math.max(drag.startMin, drag.curMin);
        blocks += '<div class="gcal-block b-free-preview" style="top:' + ((a - sMin) / 60 * HOUR_PX) + 'px;height:' + Math.max((b - a) / 60 * HOUR_PX, 11) + 'px">空き ' + p2(Math.floor(a / 60)) + ":" + p2(a % 60) + "–" + p2(Math.floor(b / 60)) + ":" + p2(b % 60) + '</div>';
      }
      const allday = gcalBusy.filter((b) => b.allDay && b.day === dY);
      const adHtml = allday.length ? '<div class="gcal-allday" title="' + esc(allday.map((a) => a.title).join(" / ")) + '">終日: ' + esc(allday.map((a) => a.title).join(" / ")) + '</div>' : "";
      cols += '<div class="gcal-col' + (dY === todayY ? " is-today" : "") + '">' +
        '<div class="gcal-col-head">' + mdw(d0) + adHtml + '</div>' +
        '<div class="gcal-col-body" data-ymd="' + dY + '" data-dayms="' + d0 + '" style="height:' + bodyH + 'px;touch-action:none">' + blocks + '</div></div>';
    }

    el.innerHTML =
      '<div class="gcal-legend"><span class="lg lg-busy"></span>Googleの予定　<span class="lg lg-free"></span>空き時間（ドラッグで作成／タップで削除）　<span class="lg lg-task"></span>配置したタスク（ドラッグで移動）</div>' +
      '<div class="gcal-cal-scroll"><div class="gcal-cal-grid gcal-week">' + cols + '</div></div>';

    // ドラッグ座標系を記録
    render.startMin = sMin;
    const bodies = Array.from(el.querySelectorAll(".gcal-col-body[data-ymd]"));
    render.cols = bodies.map((b) => ({ ymd: b.dataset.ymd, dayms: Number(b.dataset.dayms), el: b }));
    wireWeekPointer(el);
  }

  /* ---------- 週表示のポインタ操作（ドラッグ） ---------- */
  function colFromX(x) {
    let best = null, bestDist = Infinity;
    for (const c of render.cols) {
      const r = c.el.getBoundingClientRect();
      if (x >= r.left && x <= r.right) return c;
      const d = x < r.left ? r.left - x : x - r.right;
      if (d < bestDist) { bestDist = d; best = c; }
    }
    return best;
  }
  function yToMin(clientY, bodyEl) {
    const r = bodyEl.getBoundingClientRect();
    const y = Math.max(0, Math.min(r.height, clientY - r.top));
    return render.startMin + (y / HOUR_PX) * 60;
  }
  function snapMin(m) { return Math.round(m / 15) * 15; }

  function wireWeekPointer(calEl) {
    const grid = calEl.querySelector(".gcal-week");
    if (!grid) return;
    grid.addEventListener("pointerdown", onPointerDown);
  }

  function onPointerDown(e) {
    const body = e.target.closest(".gcal-col-body[data-ymd]");
    if (!body) return;
    const taskEl = e.target.closest(".gcal-block.b-task");
    const freeEl = e.target.closest(".gcal-block.b-free-win");
    if (taskEl) {
      const ri = Number(taskEl.dataset.ri);
      const r = planRows[ri];
      drag = { type: "task", ri, moved: false, grabMin: snapMin(yToMin(e.clientY, body)) - minOfDay(r.start), pid: e.pointerId };
    } else if (freeEl) {
      drag = { type: "free", fi: Number(freeEl.dataset.fi), moved: false, pid: e.pointerId };
    } else {
      const m = snapMin(yToMin(e.clientY, body));
      drag = { type: "draw", ymd: body.dataset.ymd, dayms: Number(body.dataset.dayms), startMin: m, curMin: m, moved: false, pid: e.pointerId };
    }
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    e.preventDefault();
  }

  function onPointerMove(e) {
    if (!drag) return;
    if (drag.type === "draw") {
      const col = colFromX(e.clientX) || render.cols.find((c) => c.ymd === drag.ymd);
      if (col && col.ymd !== drag.ymd) { drag.ymd = col.ymd; drag.dayms = col.dayms; }
      const body = (col && col.el) || render.cols[0].el;
      drag.curMin = snapMin(yToMin(e.clientY, body));
      if (Math.abs(drag.curMin - drag.startMin) >= 15) drag.moved = true;
      renderWeek();
    } else if (drag.type === "task") {
      const col = colFromX(e.clientX); if (!col) return;
      const r = planRows[drag.ri];
      let m = snapMin(yToMin(e.clientY, col.el) - drag.grabMin);
      m = Math.max(0, Math.min(24 * 60 - r.dur, m));
      const newStart = col.dayms + m * 60000;
      if (newStart !== r.start) { r.start = newStart; drag.moved = true; renderWeek(); }
    }
  }

  function onPointerUp() {
    window.removeEventListener("pointermove", onPointerMove);
    window.removeEventListener("pointerup", onPointerUp);
    if (!drag) return;
    if (drag.type === "draw") {
      if (drag.moved) {
        const a = Math.min(drag.startMin, drag.curMin), b = Math.max(drag.startMin, drag.curMin);
        if (b - a >= 15) { freeWindows.push({ start: drag.dayms + a * 60000, end: drag.dayms + b * 60000 }); mergeFree(); saveFree(); }
      }
      drag = null; renderWeek(); renderUnplaced();
    } else if (drag.type === "free") {
      if (!drag.moved) { freeWindows.splice(drag.fi, 1); saveFree(); }
      drag = null; renderWeek();
    } else if (drag.type === "task") {
      if (drag.moved) savePlan();
      drag = null; renderWeek();
    }
  }

  // 重なった/隣接した空き枠をまとめる
  function mergeFree() {
    freeWindows.sort((a, b) => a.start - b.start);
    const out = [];
    for (const w of freeWindows) {
      const last = out[out.length - 1];
      if (last && w.start <= last.end) { last.end = Math.max(last.end, w.end); }
      else out.push({ start: w.start, end: w.end });
    }
    freeWindows = out;
  }

  /* ---------- 月表示 ---------- */
  function renderMonth() {
    const el = q("#gc-cal"); if (!el) return;
    const first = startOfMonth(anchor);
    const gridStart = startOfWeek(first);
    const curMonth = first.getMonth();
    const todayY = ymd(new Date());

    let head = '<div class="gcal-month-head">' + ["月", "火", "水", "木", "金", "土", "日"].map((w) => "<div>" + w + "</div>").join("") + "</div>";
    let cells = "";
    for (let i = 0; i < 42; i++) {
      const d0 = gridStart.getTime() + i * 86400000, d1 = d0 + 86400000, dY = ymd(d0);
      const other = new Date(d0).getMonth() !== curMonth;
      const evs = gcalBusy.filter((b) => !b.allDay && !b.free && b.end > d0 && b.start < d1).length;
      const freeMin = freeWindows.reduce((acc, w) => acc + Math.max(0, Math.min(w.end, d1) - Math.max(w.start, d0)), 0) / 60000;
      const tasks = planRows.filter((r) => ymd(r.start) === dY);
      const chips = tasks.slice(0, 3).map((r) => '<div class="gcal-mchip' + (rowWarn(r) ? " is-warn" : "") + '">' + esc(fmtTime(r.start) + " " + r.title) + "</div>").join("") +
        (tasks.length > 3 ? '<div class="gcal-mmore">＋' + (tasks.length - 3) + "</div>" : "");
      cells += '<div class="gcal-mcell' + (other ? " is-other" : "") + (dY === todayY ? " is-today" : "") + (freeMin > 0 ? " has-free" : "") + '" data-ymd="' + dY + '">' +
        '<div class="gcal-mdate">' + new Date(d0).getDate() +
          (evs ? '<span class="gcal-mev">●' + evs + '</span>' : "") +
          (freeMin > 0 ? '<span class="gcal-mfree">空' + (Math.round(freeMin / 6) / 10) + "h</span>" : "") +
        '</div>' + chips + '</div>';
    }
    el.innerHTML =
      '<div class="gcal-legend gcal-legend-month">日付をタップするとその週（週表示）に移動します。空き時間の作成は週表示で行います。</div>' +
      '<div class="gcal-month">' + head + '<div class="gcal-month-grid">' + cells + '</div></div>';

    el.querySelector(".gcal-month-grid").addEventListener("click", (e) => {
      const cell = e.target.closest(".gcal-mcell"); if (!cell) return;
      anchor = startOfDay(new Date(cell.dataset.ymd + "T00:00:00"));
      viewMode = "week"; afterNav();
    });
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
    if (p.viewMode) viewMode = p.viewMode;
    if (p.anchor) anchor = startOfDay(new Date(p.anchor));
    openPanel();
    setStatus("ログインから戻りました。予定を読み込んでいます…");
    waitForToken(12000).then((ok) => { if (ok) loadFromGoogle(); else setStatus("ログインを確認できませんでした。もう一度お試しください。", true); });
  }

  /* ---------- 起動 ---------- */
  function start() {
    const btn = document.getElementById("gcal-btn");
    if (btn) btn.addEventListener("click", openPanel);
    let pending = null;
    try { pending = JSON.parse(localStorage.getItem(PENDING_KEY) || "null"); } catch (e) { /* ignore */ }
    if (pending) {
      try { localStorage.removeItem(PENDING_KEY); } catch (e) { /* ignore */ }
      try { resumePending(pending); } catch (e) { /* 通常起動 */ }
    }
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start);
  else start();

  // テスト用フック
  window.DandoriGcal = { open: openPanel, _test: { computeOpenSlots, placeTasks, cmpTasks, icsForRows, toRFC3339, STEP_MS } };

})();

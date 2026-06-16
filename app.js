"use strict";

/* =========================================================
 * 段取り（Dandori） — タスク優先度ボード
 * データはブラウザの localStorage に保存（端末内のみ）
 * ======================================================= */

const STORAGE_KEY = "dandori.v1";
const HORIZON_DAYS = 30; // この日数より先の締切は緊急度ほぼ最低とみなす
const FULL_DAY_MIN = 480; // 8時間 = 「丸一日」相当の作業量

/* ---------- State ---------- */
let state = {
  goals: [],   // { id, title, desc, emoji, createdAt }
  tasks: [],   // { id, goalId, title, deadline, effort, status, note, createdAt, completedAt }
  memos: [],   // { id, text, createdAt }
  settings: { deadlineWeight: 0.5, aiProvider: "claude", aiModel: "claude-opus-4-8", geminiModel: "gemini-2.5-flash", sortMode: "score" },
  aiSuggestion: null, // { orderIds, text, createdAt, model, signature }
  aiContext: null,    // { ids: [taskId...] } — 直近に生成したプロンプトのタスク番号対応
};

// APIキーはプロバイダ別に、本体stateとは別保存（エクスポートに混ざらないよう）
const API_KEY_STORAGE = { claude: "dandori.apiKey", gemini: "dandori.geminiKey" };

function defaultSettings() {
  return { deadlineWeight: 0.5, aiProvider: "claude", aiModel: "claude-opus-4-8", geminiModel: "gemini-2.5-flash", sortMode: "score" };
}

let activeGoalFilter = "all";

/* ---------- Storage ---------- */
function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      state = {
        goals: parsed.goals || [],
        tasks: parsed.tasks || [],
        memos: parsed.memos || [],
        settings: Object.assign(defaultSettings(), parsed.settings || {}),
        aiSuggestion: parsed.aiSuggestion || null,
        aiContext: parsed.aiContext || null,
      };
    }
  } catch (e) {
    console.warn("保存データの読み込みに失敗しました:", e);
  }
}

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch (e) {
    console.warn("保存に失敗しました:", e);
  }
}

/* ---------- Utilities ---------- */
function uid() {
  return (crypto.randomUUID && crypto.randomUUID()) ||
    Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function startOfDay(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function daysUntil(dateStr) {
  if (!dateStr) return null;
  const today = startOfDay(new Date());
  const target = startOfDay(new Date(dateStr + "T00:00:00"));
  return Math.round((target - today) / 86400000);
}

function deadlineLabel(dateStr) {
  const d = daysUntil(dateStr);
  if (d === null) return { text: "期限なし", cls: "" };
  if (d < 0) return { text: `${-d}日超過`, cls: "overdue" };
  if (d === 0) return { text: "今日まで", cls: "overdue" };
  if (d === 1) return { text: "明日まで", cls: "soon" };
  if (d <= 3) return { text: `あと${d}日`, cls: "soon" };
  if (d <= 7) return { text: `あと${d}日`, cls: "" };
  return { text: dateStr, cls: "" };
}

function effortLabel(min) {
  if (!min) return "見積なし";
  if (min < 60) return `${min}分`;
  const h = min / 60;
  return (Number.isInteger(h) ? h : h.toFixed(1)) + "時間";
}

function statusLabel(s) {
  return s === "doing" ? "進行中" : s === "done" ? "完了" : "未着手";
}

function todayStr() {
  return startOfDay(new Date()).toLocaleDateString("sv-SE"); // YYYY-MM-DD
}

function addDaysStr(n) {
  const d = startOfDay(new Date());
  d.setDate(d.getDate() + n);
  return d.toLocaleDateString("sv-SE");
}

function nextWeekendStr() {
  const d = startOfDay(new Date());
  const day = d.getDay(); // 0=日
  const diff = (6 - day + 7) % 7 || 7; // 次の土曜
  d.setDate(d.getDate() + diff);
  return d.toLocaleDateString("sv-SE");
}

/* ---------- Priority calculation ---------- */
// 締切が近いほど高い（0–100）。期限なしは低め、超過は最大。
function urgencyScore(deadline) {
  if (!deadline) return 8;
  const d = daysUntil(deadline);
  if (d <= 0) return 100;
  return Math.max(8, Math.round(100 * (1 - d / HORIZON_DAYS)));
}

// 作業が短いほど高い（0–100）。見積なしは中間より低め。
function quicknessScore(effort) {
  if (!effort) return 30;
  if (effort <= 15) return 100;
  if (effort >= FULL_DAY_MIN) return 5;
  const score = 100 * (1 - Math.log(effort / 15) / Math.log(FULL_DAY_MIN / 15));
  return Math.max(5, Math.round(score));
}

function priorityOf(task) {
  const u = urgencyScore(task.deadline);
  const q = quicknessScore(task.effort);
  const w = state.settings.deadlineWeight; // 締切の重み
  const score = Math.round(w * u + (1 - w) * q);
  return { score, urgency: u, quickness: q };
}

function priorityTier(score) {
  if (score >= 67) return "high";
  if (score >= 40) return "mid";
  return "low";
}

/* ---------- Helpers on data ---------- */
function goalById(id) {
  return state.goals.find((g) => g.id === id) || null;
}

function activeTasks() {
  return state.tasks.filter((t) => t.status !== "done");
}

function tasksForGoal(goalId) {
  return state.tasks.filter((t) => t.goalId === goalId);
}

/* =========================================================
 * Rendering
 * ======================================================= */
function renderAll() {
  renderGoalFilter();
  renderPriority();
  renderGoals();
  renderMemos();
  renderDone();
  renderMemoCount();
  renderWeightReadout();
  renderAi();
}

function renderMemoCount() {
  const el = document.getElementById("memo-count");
  el.textContent = state.memos.length ? String(state.memos.length) : "";
}

function renderWeightReadout() {
  const w = Math.round(state.settings.deadlineWeight * 100);
  document.getElementById("weight-readout").textContent = `締切 ${w}% / 手軽さ ${100 - w}%`;
}

function renderGoalFilter() {
  const sel = document.getElementById("goal-filter");
  const current = activeGoalFilter;
  let html = `<option value="all">すべて</option><option value="none">未分類</option>`;
  state.goals.forEach((g) => {
    html += `<option value="${esc(g.id)}">${esc(g.emoji || "🎯")} ${esc(g.title)}</option>`;
  });
  sel.innerHTML = html;
  sel.value = current;
  if (sel.value !== current) {
    activeGoalFilter = "all";
    sel.value = "all";
  }
}

function renderPriority() {
  const list = document.getElementById("priority-list");
  const sortSel = document.getElementById("sort-mode");
  if (sortSel) sortSel.value = state.settings.sortMode || "score";

  let tasks = activeTasks();

  if (activeGoalFilter === "none") {
    tasks = tasks.filter((t) => !t.goalId);
  } else if (activeGoalFilter !== "all") {
    tasks = tasks.filter((t) => t.goalId === activeGoalFilter);
  }

  if (tasks.length === 0) {
    list.innerHTML = emptyState("🗂️", "タスクがありません", "「＋ タスクを追加」から、やるべきことを登録しましょう。");
    return;
  }

  const aiMode = state.settings.sortMode === "ai";
  const order = aiMode && state.aiSuggestion ? state.aiSuggestion.orderIds : null;

  const ranked = tasks
    .map((t) => ({ task: t, pri: priorityOf(t) }))
    .sort((a, b) => {
      if (order && order.length) {
        const ia = order.indexOf(a.task.id);
        const ib = order.indexOf(b.task.id);
        const ra = ia === -1 ? Infinity : ia;
        const rb = ib === -1 ? Infinity : ib;
        if (ra !== rb) return ra - rb;
      }
      return b.pri.score - a.pri.score;
    });

  let banner = "";
  if (aiMode) {
    if (order && order.length) {
      const stale = state.aiSuggestion.signature !== tasksSignature();
      banner = `<div class="ai-banner">🤖 AI提案順で表示中${stale ? "（タスクが変わりました・再提案がおすすめ）" : ""}<button class="link-btn" data-action="sort-score">スコア順に戻す</button></div>`;
    } else {
      banner = `<div class="ai-banner">AI提案がまだありません。「AI提案」タブで作成してください。<button class="link-btn" data-action="sort-score">スコア順に戻す</button></div>`;
    }
  }

  list.innerHTML = banner + ranked.map(({ task, pri }) => taskCardHTML(task, pri)).join("");
}

function taskCardHTML(task, pri) {
  const tier = priorityTier(pri.score);
  const goal = task.goalId ? goalById(task.goalId) : null;
  const dl = deadlineLabel(task.deadline);
  const doneCls = task.status === "done" ? "is-done" : "";

  const chips = [];
  if (goal) chips.push(`<span class="chip goal">${esc(goal.emoji || "🎯")} ${esc(goal.title)}</span>`);
  chips.push(`<span class="chip ${dl.cls}">🗓 ${esc(dl.text)}</span>`);
  chips.push(`<span class="chip">⏱ ${esc(effortLabel(task.effort))}</span>`);
  if (task.status === "doing") chips.push(`<span class="chip doing">進行中</span>`);

  return `
    <div class="task-card pri-${tier} ${doneCls}" data-id="${esc(task.id)}">
      <input type="checkbox" class="task-check" data-action="toggle" ${task.status === "done" ? "checked" : ""} aria-label="完了切り替え" />
      <div class="task-main">
        <div class="task-title">${esc(task.title)}</div>
        <div class="task-meta">${chips.join("")}</div>
      </div>
      <div class="task-side">
        <div class="pri-score"><small>優先度</small>${pri.score}</div>
        <div class="pri-breakdown">締切 ${pri.urgency} ／ 手軽さ ${pri.quickness}</div>
        <div class="task-actions">
          <button class="link-btn" data-action="decompose">分解</button>
          <button class="link-btn task-edit" data-action="edit">編集</button>
        </div>
      </div>
    </div>`;
}

function renderGoals() {
  const list = document.getElementById("goals-list");
  if (state.goals.length === 0) {
    list.innerHTML = emptyState("🎯", "やりたいことがありません", "達成したい目標を登録し、そこに「やるべきこと」を紐づけましょう。");
    return;
  }

  list.innerHTML = state.goals.map((g) => {
    const tasks = tasksForGoal(g.id);
    const done = tasks.filter((t) => t.status === "done").length;
    const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0;

    const taskRows = tasks.length
      ? tasks.map((t) => `
        <div class="goal-task-row ${t.status === "done" ? "is-done" : ""}" data-id="${esc(t.id)}">
          <input type="checkbox" class="task-check" data-action="toggle" ${t.status === "done" ? "checked" : ""} aria-label="完了切り替え" />
          <span class="grow">${esc(t.title)}</span>
          <span class="chip ${deadlineLabel(t.deadline).cls}">${esc(deadlineLabel(t.deadline).text)}</span>
          <button class="link-btn" data-action="edit">編集</button>
        </div>`).join("")
      : `<div class="goal-task-row"><span class="grow" style="color:var(--text-faint)">まだタスクがありません</span></div>`;

    return `
      <div class="goal-card" data-id="${esc(g.id)}">
        <div class="goal-head">
          <span class="goal-emoji">${esc(g.emoji || "🎯")}</span>
          <div class="goal-info">
            <div class="goal-title">${esc(g.title)}</div>
            ${g.desc ? `<div class="goal-desc">${esc(g.desc)}</div>` : ""}
          </div>
          <div class="goal-actions">
            <button class="link-btn" data-action="edit-goal">編集</button>
          </div>
        </div>
        <div class="progress"><div class="progress-bar" style="width:${pct}%"></div></div>
        <div class="goal-progress-text">${done} / ${tasks.length} 完了（${pct}%）</div>
        <div class="goal-tasks">${taskRows}</div>
        <button class="btn btn-ghost goal-add-task" data-action="add-task-to-goal">＋ このゴールにタスクを追加</button>
      </div>`;
  }).join("");
}

function renderMemos() {
  const list = document.getElementById("memos-list");
  if (state.memos.length === 0) {
    list.innerHTML = emptyState("📝", "メモはありません", "上部の入力欄から、思いついたことをすぐ書き留められます。");
    return;
  }
  const sorted = [...state.memos].sort((a, b) => b.createdAt - a.createdAt);
  list.innerHTML = sorted.map((m) => `
    <div class="memo-card" data-id="${esc(m.id)}">
      <div class="memo-text">${esc(m.text)}</div>
      <span class="memo-date">${new Date(m.createdAt).toLocaleDateString("ja-JP")}</span>
      <div class="memo-actions">
        <button class="btn btn-ghost" data-action="memo-to-task">タスク化</button>
        <button class="link-btn danger" data-action="memo-delete">削除</button>
      </div>
    </div>`).join("");
}

function renderDone() {
  const list = document.getElementById("done-list");
  const done = state.tasks
    .filter((t) => t.status === "done")
    .sort((a, b) => (b.completedAt || 0) - (a.completedAt || 0));

  document.getElementById("done-summary").textContent =
    done.length ? `完了したタスク：${done.length}件` : "";

  if (done.length === 0) {
    list.innerHTML = emptyState("✅", "完了したタスクはまだありません", "タスクのチェックを入れると、ここに移動します。");
    return;
  }
  list.innerHTML = done.map((t) => {
    const goal = t.goalId ? goalById(t.goalId) : null;
    return `
      <div class="task-card pri-low is-done" data-id="${esc(t.id)}">
        <input type="checkbox" class="task-check" data-action="toggle" checked aria-label="完了切り替え" />
        <div class="task-main">
          <div class="task-title">${esc(t.title)}</div>
          <div class="task-meta">
            ${goal ? `<span class="chip goal">${esc(goal.emoji || "🎯")} ${esc(goal.title)}</span>` : ""}
            <span class="chip">完了日 ${t.completedAt ? new Date(t.completedAt).toLocaleDateString("ja-JP") : "-"}</span>
          </div>
        </div>
        <div class="task-side">
          <button class="link-btn task-edit" data-action="edit">編集</button>
        </div>
      </div>`;
  }).join("");
}

function emptyState(emoji, title, sub) {
  return `<div class="empty"><span class="empty-emoji">${emoji}</span><strong>${esc(title)}</strong><div>${esc(sub)}</div></div>`;
}

/* =========================================================
 * Modal — タスク / 目標フォーム
 * ======================================================= */
const overlay = document.getElementById("modal-overlay");
const modalTitle = document.getElementById("modal-title");
const modalBody = document.getElementById("modal-body");

function openModal() { overlay.hidden = false; }
function closeModal() { overlay.hidden = true; modalBody.innerHTML = ""; }

const EFFORT_PRESETS = [
  { label: "15分", v: 15 }, { label: "30分", v: 30 }, { label: "1時間", v: 60 },
  { label: "2時間", v: 120 }, { label: "半日", v: 240 }, { label: "1日", v: 480 },
];

function openTaskModal(taskId, presetGoalId, prefill) {
  const task = taskId ? state.tasks.find((t) => t.id === taskId) : null;
  modalTitle.textContent = task ? "タスクを編集" : "タスクを追加";

  const goalOptions = [`<option value="">（未分類）</option>`]
    .concat(state.goals.map((g) =>
      `<option value="${esc(g.id)}" ${(task ? task.goalId : presetGoalId) === g.id ? "selected" : ""}>${esc(g.emoji || "🎯")} ${esc(g.title)}</option>`))
    .join("");

  modalBody.innerHTML = `
    <form id="task-form">
    <div class="field">
      <label for="f-title">タスク名 *</label>
      <input type="text" id="f-title" value="${esc(task ? task.title : (prefill && prefill.title ? prefill.title : ""))}" placeholder="例）企画書をレビューする" />
    </div>
    <div class="field">
      <label for="f-goal">紐づける目標（やりたいこと）</label>
      <select id="f-goal">${goalOptions}</select>
    </div>
    <div class="field">
      <label for="f-deadline">締切</label>
      <input type="date" id="f-deadline" value="${esc(task ? task.deadline || "" : "")}" />
      <div class="presets" id="deadline-presets">
        <button type="button" class="preset" data-days="0">今日</button>
        <button type="button" class="preset" data-days="1">明日</button>
        <button type="button" class="preset" data-days="3">3日後</button>
        <button type="button" class="preset" data-weekend="1">今週末</button>
        <button type="button" class="preset" data-days="7">1週間後</button>
        <button type="button" class="preset" data-clear="1">なし</button>
      </div>
    </div>
    <div class="field">
      <label for="f-effort">作業見積（所要時間）</label>
      <div class="presets" id="effort-presets">
        ${EFFORT_PRESETS.map((p) => `<button type="button" class="preset" data-min="${p.v}">${p.label}</button>`).join("")}
      </div>
      <input type="number" id="f-effort" min="0" step="5" placeholder="分で入力（例：45）" value="${task && task.effort ? task.effort : ""}" style="margin-top:8px" />
    </div>
    <div class="field">
      <label for="f-status">状態</label>
      <select id="f-status">
        <option value="todo" ${task && task.status === "todo" ? "selected" : ""}>未着手</option>
        <option value="doing" ${task && task.status === "doing" ? "selected" : ""}>進行中</option>
        <option value="done" ${task && task.status === "done" ? "selected" : ""}>完了</option>
      </select>
    </div>
    <div class="field">
      <label for="f-note">メモ</label>
      <textarea id="f-note" placeholder="補足があれば">${esc(task ? task.note || "" : "")}</textarea>
    </div>
    <div class="modal-actions">
      ${task ? `<button type="button" class="link-btn delete-btn" id="f-delete">削除</button>` : ""}
      <button type="button" class="btn btn-ghost" id="f-cancel">キャンセル</button>
      <button type="submit" class="btn btn-primary" id="f-save">保存</button>
    </div>
    </form>`;

  // 見積プリセット
  const effortInput = document.getElementById("f-effort");
  function syncEffortPresets() {
    document.querySelectorAll("#effort-presets .preset").forEach((b) => {
      b.classList.toggle("is-active", Number(b.dataset.min) === Number(effortInput.value));
    });
  }
  document.querySelectorAll("#effort-presets .preset").forEach((btn) => {
    btn.addEventListener("click", () => { effortInput.value = btn.dataset.min; syncEffortPresets(); });
  });
  effortInput.addEventListener("input", syncEffortPresets);
  syncEffortPresets();

  // 締切プリセット
  const deadlineInput = document.getElementById("f-deadline");
  document.querySelectorAll("#deadline-presets .preset").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (btn.dataset.clear) deadlineInput.value = "";
      else if (btn.dataset.weekend) deadlineInput.value = nextWeekendStr();
      else deadlineInput.value = addDaysStr(Number(btn.dataset.days));
    });
  });

  document.getElementById("f-cancel").addEventListener("click", closeModal);
  document.getElementById("task-form").addEventListener("submit", (e) => { e.preventDefault(); saveTask(taskId, prefill); });
  if (task) document.getElementById("f-delete").addEventListener("click", () => deleteTask(taskId));

  openModal();
  document.getElementById("f-title").focus();
}

function saveTask(taskId, prefill) {
  const title = document.getElementById("f-title").value.trim();
  if (!title) {
    document.getElementById("f-title").focus();
    return;
  }
  const goalId = document.getElementById("f-goal").value || null;
  const deadline = document.getElementById("f-deadline").value || null;
  const effortRaw = document.getElementById("f-effort").value;
  const effort = effortRaw ? Math.max(0, Math.round(Number(effortRaw))) : null;
  const status = document.getElementById("f-status").value;
  const note = document.getElementById("f-note").value.trim();

  if (taskId) {
    const t = state.tasks.find((x) => x.id === taskId);
    const wasDone = t.status === "done";
    Object.assign(t, { title, goalId, deadline, effort, status, note });
    if (status === "done" && !wasDone) t.completedAt = Date.now();
    if (status !== "done") t.completedAt = null;
  } else {
    state.tasks.push({
      id: uid(), goalId, title, deadline, effort, status, note,
      createdAt: Date.now(),
      completedAt: status === "done" ? Date.now() : null,
    });
  }
  // メモから変換した場合は、保存できたタイミングで元メモを削除
  if (prefill && prefill.memoId) {
    state.memos = state.memos.filter((x) => x.id !== prefill.memoId);
  }
  save();
  renderAll();
  closeModal();
}

function deleteTask(taskId) {
  if (!confirm("このタスクを削除しますか？")) return;
  state.tasks = state.tasks.filter((t) => t.id !== taskId);
  save();
  renderAll();
  closeModal();
}

const GOAL_EMOJIS = ["🎯", "🚀", "📈", "💡", "📚", "🏆", "🌱", "🛠️", "💼", "❤️"];

function openGoalModal(goalId) {
  const goal = goalId ? goalById(goalId) : null;
  modalTitle.textContent = goal ? "目標を編集" : "目標を追加";

  modalBody.innerHTML = `
    <form id="goal-form">
    <div class="field">
      <label for="g-title">やりたいこと（目標）*</label>
      <input type="text" id="g-title" value="${esc(goal ? goal.title : "")}" placeholder="例）新サービスの企画を通す" />
    </div>
    <div class="field">
      <label>アイコン</label>
      <div class="presets" id="emoji-presets">
        ${GOAL_EMOJIS.map((e) => `<button type="button" class="preset ${goal && goal.emoji === e ? "is-active" : (!goal && e === "🎯" ? "is-active" : "")}" data-emoji="${e}">${e}</button>`).join("")}
      </div>
    </div>
    <div class="field">
      <label for="g-desc">説明（任意）</label>
      <textarea id="g-desc" placeholder="この目標のゴールやメモ">${esc(goal ? goal.desc || "" : "")}</textarea>
    </div>
    <div class="modal-actions">
      ${goal ? `<button type="button" class="link-btn delete-btn" id="g-delete">削除</button>` : ""}
      <button type="button" class="btn btn-ghost" id="g-cancel">キャンセル</button>
      <button type="submit" class="btn btn-primary" id="g-save">保存</button>
    </div>
    </form>`;

  let selectedEmoji = goal ? goal.emoji || "🎯" : "🎯";
  document.querySelectorAll("#emoji-presets .preset").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedEmoji = btn.dataset.emoji;
      document.querySelectorAll("#emoji-presets .preset").forEach((b) => b.classList.toggle("is-active", b === btn));
    });
  });

  document.getElementById("g-cancel").addEventListener("click", closeModal);
  document.getElementById("goal-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const title = document.getElementById("g-title").value.trim();
    if (!title) { document.getElementById("g-title").focus(); return; }
    const desc = document.getElementById("g-desc").value.trim();
    if (goal) {
      Object.assign(goal, { title, desc, emoji: selectedEmoji });
    } else {
      state.goals.push({ id: uid(), title, desc, emoji: selectedEmoji, createdAt: Date.now() });
    }
    save();
    renderAll();
    closeModal();
  });
  if (goal) {
    document.getElementById("g-delete").addEventListener("click", () => {
      const tasks = tasksForGoal(goalId);
      const msg = tasks.length
        ? `この目標を削除しますか？\n紐づく${tasks.length}件のタスクは「未分類」になります。`
        : "この目標を削除しますか？";
      if (!confirm(msg)) return;
      tasks.forEach((t) => { t.goalId = null; });
      state.goals = state.goals.filter((g) => g.id !== goalId);
      save();
      renderAll();
      closeModal();
    });
  }

  openModal();
  document.getElementById("g-title").focus();
}

/* =========================================================
 * Actions on tasks/memos via delegation
 * ======================================================= */
function toggleTask(taskId) {
  const t = state.tasks.find((x) => x.id === taskId);
  if (!t) return;
  if (t.status === "done") {
    t.status = "todo";
    t.completedAt = null;
  } else {
    t.status = "done";
    t.completedAt = Date.now();
  }
  save();
  renderAll();
}

function memoToTask(memoId) {
  const m = state.memos.find((x) => x.id === memoId);
  if (!m) return;
  // メモはタスクを「保存」できたときに削除する（キャンセル時は残す）
  openTaskModal(null, null, { title: m.text, memoId });
}

function deleteMemo(memoId) {
  state.memos = state.memos.filter((x) => x.id !== memoId);
  save();
  renderAll();
}

/* =========================================================
 * Event wiring
 * ======================================================= */
function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("is-active", t.dataset.tab === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("is-active", v.id === "view-" + name));
}

function init() {
  load();
  renderAll();

  // タブ
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => switchTab(tab.dataset.tab));
  });

  // クイックメモ
  document.getElementById("quick-capture").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = document.getElementById("quick-input");
    const text = input.value.trim();
    if (!text) return;
    state.memos.push({ id: uid(), text, createdAt: Date.now() });
    input.value = "";
    save();
    renderAll();
  });

  // 追加ボタン
  document.getElementById("add-task-btn").addEventListener("click", () => openTaskModal(null, null));
  document.getElementById("bulk-task-btn").addEventListener("click", openBulkModal);
  document.getElementById("ics-task-btn").addEventListener("click", openIcsModal);
  document.getElementById("add-goal-btn").addEventListener("click", () => openGoalModal(null));

  // 重みスライダー
  const slider = document.getElementById("weight-slider");
  slider.value = String(Math.round(state.settings.deadlineWeight * 100));
  slider.addEventListener("input", () => {
    state.settings.deadlineWeight = Number(slider.value) / 100;
    save();
    renderPriority();
    renderWeightReadout();
  });

  // 目標フィルタ
  document.getElementById("goal-filter").addEventListener("change", (e) => {
    activeGoalFilter = e.target.value;
    renderPriority();
  });

  // 並び順（スコア / AI提案）
  document.getElementById("sort-mode").addEventListener("change", (e) => {
    state.settings.sortMode = e.target.value;
    save();
    renderPriority();
  });

  // AI提案タブ
  document.getElementById("ai-copy").addEventListener("click", aiCopyPrompt);
  document.getElementById("ai-run").addEventListener("click", aiRunDirect);
  document.getElementById("ai-apply").addEventListener("click", () => {
    if (!state.aiSuggestion || !state.aiSuggestion.orderIds.length) return;
    state.settings.sortMode = "ai";
    save();
    renderAll();
    switchTab("priority");
  });
  document.getElementById("ai-apply-paste").addEventListener("click", aiApplyPaste);
  document.getElementById("ai-provider").addEventListener("change", (e) => {
    state.settings.aiProvider = e.target.value;
    save();
    renderAi();
  });
  document.getElementById("ai-model").addEventListener("change", (e) => {
    if (currentProvider() === "gemini") state.settings.geminiModel = e.target.value;
    else state.settings.aiModel = e.target.value;
    save();
  });
  document.getElementById("ai-key-save").addEventListener("click", () => {
    const input = document.getElementById("ai-key");
    const v = input.value.trim();
    setApiKey(currentProvider(), v);
    input.value = "";
    renderAi();
    setAiStatus(v ? "APIキーを保存しました。" : "キーが空のため削除しました。");
  });
  document.getElementById("ai-key-clear").addEventListener("click", () => {
    setApiKey(currentProvider(), "");
    document.getElementById("ai-key").value = "";
    renderAi();
    setAiStatus("APIキーを削除しました。");
  });

  // モーダルを閉じる
  document.getElementById("modal-close").addEventListener("click", closeModal);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closeModal(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !overlay.hidden) closeModal(); });

  // タスクカード／目標カード／メモのクリック（イベント委譲）
  document.querySelector(".content").addEventListener("click", (e) => {
    const actionEl = e.target.closest("[data-action]");
    if (!actionEl) return;
    const action = actionEl.dataset.action;
    const card = actionEl.closest("[data-id]");
    const id = card ? card.dataset.id : null;

    switch (action) {
      case "toggle": toggleTask(id); break;
      case "edit": openTaskModal(id); break;
      case "decompose": openDecomposeModal(id); break;
      case "edit-goal": openGoalModal(id); break;
      case "add-task-to-goal": openTaskModal(null, id); break;
      case "memo-to-task": memoToTask(id); break;
      case "memo-delete": deleteMemo(id); break;
      case "sort-score":
        state.settings.sortMode = "score";
        save();
        renderPriority();
        break;
    }
  });

  // フッター
  document.getElementById("load-sample").addEventListener("click", loadSample);
  document.getElementById("clear-all").addEventListener("click", () => {
    if (!confirm("すべてのデータを消去します。よろしいですか？")) return;
    state = { goals: [], tasks: [], memos: [], settings: defaultSettings(), aiSuggestion: null, aiContext: null };
    activeGoalFilter = "all";
    save();
    renderAll();
  });
}

/* =========================================================
 * AI提案：プロンプト生成 / 直接依頼（Claude API） / 適用
 * ======================================================= */

/* ---- プロバイダ / モデル / APIキー（state とは別保存） ---- */
const MODEL_OPTIONS = {
  claude: [
    { value: "claude-opus-4-8", label: "Claude Opus 4.8 — 高品質（既定）" },
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 — バランス" },
    { value: "claude-haiku-4-5", label: "Claude Haiku 4.5 — 高速・低コスト" },
  ],
  gemini: [
    { value: "gemini-2.5-flash", label: "Gemini 2.5 Flash — 高速・低コスト（既定）" },
    { value: "gemini-3.5-flash", label: "Gemini 3.5 Flash — 高性能" },
    { value: "gemini-2.5-pro", label: "Gemini 2.5 Pro — 最上位" },
    { value: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite — 最安" },
  ],
};

function currentProvider() { return state.settings.aiProvider || "claude"; }
function currentModel() {
  return currentProvider() === "gemini"
    ? (state.settings.geminiModel || "gemini-2.5-flash")
    : (state.settings.aiModel || "claude-opus-4-8");
}
function getApiKey(provider) {
  const k = API_KEY_STORAGE[provider || currentProvider()];
  try { return localStorage.getItem(k) || ""; } catch (e) { return ""; }
}
function setApiKey(provider, val) {
  const k = API_KEY_STORAGE[provider || currentProvider()];
  try { if (val) localStorage.setItem(k, val); else localStorage.removeItem(k); } catch (e) { /* ignore */ }
}

/* ---- プロンプト生成（タスク番号→id対応も返す） ---- */
function buildAiPrompt() {
  const tasks = activeTasks();
  const ids = tasks.map((t) => t.id);
  const lines = tasks.map((t, i) => {
    const goal = t.goalId ? goalById(t.goalId) : null;
    const dl = deadlineLabel(t.deadline);
    const pri = priorityOf(t);
    let line = `${i + 1}. ${t.title}`
      + ` / 目標:${goal ? goal.title : "なし"}`
      + ` / 締切:${dl.text}${t.deadline ? `(${t.deadline})` : ""}`
      + ` / 見積:${effortLabel(t.effort)}`
      + ` / 状態:${statusLabel(t.status)}`
      + ` / 現在スコア:${pri.score}`;
    if (t.note) line += ` / メモ:${t.note}`;
    return line;
  });

  const prompt = `あなたは優秀なプロジェクトマネジメントの秘書です。下のタスク一覧を見て、今日から着手すべき順番を提案してください。

【判断の基準】
- 締切が近い・超過しているものを優先する
- すぐ終わるタスク（手軽さ）は前倒しで片付けると全体が進む
- 依存関係（あるタスクが別のタスクの前提になっている）があれば考慮する
- 同じ目標のタスクはまとめて進めると効率的

【タスク一覧】
${lines.join("\n")}

【出力の形式】
1) おすすめ順とその理由を、簡潔な箇条書きで説明してください（各1行程度）。
2) 最後に、必ず次の1行だけの形式で並び順を出力してください：
ORDER: 3,1,5,2,4
※番号は上のタスク番号です。すべての番号を一度ずつ含めてください。`;

  return { prompt, ids };
}

/* ---- 現在のタスク集合のシグネチャ（提案の鮮度判定用） ---- */
function tasksSignature() {
  return activeTasks()
    .map((t) => [t.id, t.title, t.deadline, t.effort, t.status, t.goalId].join("|"))
    .sort()
    .join("¶");
}

/* ---- AIの回答から「ORDER: ...」を解析して taskId 配列へ ---- */
function parseOrder(text, ids) {
  const m = text.match(/ORDER\s*[:：]\s*([0-9０-９,\s、，]+)/i);
  if (!m) return null;
  const normalized = m[1].replace(/[０-９]/g, (d) => "０１２３４５６７８９".indexOf(d));
  const nums = normalized.split(/[,\s、，]+/).map((s) => parseInt(s, 10)).filter((n) => !isNaN(n));
  const orderIds = [];
  nums.forEach((n) => {
    const id = ids[n - 1];
    if (id && !orderIds.includes(id)) orderIds.push(id);
  });
  return orderIds.length ? orderIds : null;
}

function applyAiOrder(orderIds, text, model) {
  state.aiSuggestion = {
    orderIds,
    text: text || "",
    createdAt: Date.now(),
    model: model || "",
    signature: tasksSignature(),
  };
  state.settings.sortMode = "ai";
  save();
  renderAll();
}

/* ---- Claude API（ブラウザ直叩き・ストリーミング） ---- */
async function streamClaude(prompt, onText, maxTokens) {
  const key = getApiKey();
  const model = state.settings.aiModel || "claude-opus-4-8";
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "anthropic-dangerous-direct-browser-access": "true",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens || 2000,
      stream: true,
      messages: [{ role: "user", content: prompt }],
    }),
  });

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const e = await res.json(); if (e && e.error && e.error.message) msg = e.error.message; } catch (e) { /* ignore */ }
    throw new Error(msg);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop(); // 未完の行は次へ持ち越す
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let ev;
      try { ev = JSON.parse(data); } catch (e) { continue; }
      if (ev.type === "content_block_delta" && ev.delta && ev.delta.type === "text_delta") {
        full += ev.delta.text;
        if (onText) onText(full);
      }
    }
  }
  return full;
}

/* ---- Gemini API（ブラウザ直叩き・ストリーミング） ---- */
async function streamGemini(prompt, onText, maxTokens) {
  const key = getApiKey("gemini");
  const model = state.settings.geminiModel || "gemini-2.5-flash";
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:streamGenerateContent?alt=sse`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens || 2000 },
    }),
  });

  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try { const e = await res.json(); if (e && e.error && e.error.message) msg = e.error.message; } catch (e) { /* ignore */ }
    throw new Error(msg);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let full = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop();
    for (const line of lines) {
      const t = line.trim();
      if (!t.startsWith("data:")) continue;
      const data = t.slice(5).trim();
      if (!data || data === "[DONE]") continue;
      let ev;
      try { ev = JSON.parse(data); } catch (e) { continue; }
      const parts = ev && ev.candidates && ev.candidates[0] && ev.candidates[0].content && ev.candidates[0].content.parts;
      if (parts) {
        for (const p of parts) {
          if (p && p.text) { full += p.text; if (onText) onText(full); }
        }
      }
    }
  }
  return full;
}

/* ---- プロバイダで振り分け ---- */
function streamAI(prompt, onText, maxTokens) {
  return currentProvider() === "gemini"
    ? streamGemini(prompt, onText, maxTokens)
    : streamClaude(prompt, onText, maxTokens);
}

/* ---- ステータス表示（数秒で自動クリア） ---- */
let aiStatusTimer = null;
function setAiStatus(msg) {
  const el = document.getElementById("ai-status");
  if (!el) return;
  el.textContent = msg;
  if (aiStatusTimer) clearTimeout(aiStatusTimer);
  if (msg) aiStatusTimer = setTimeout(() => { el.textContent = ""; }, 6000);
}

/* ---- アクション ---- */
async function aiCopyPrompt() {
  const { prompt, ids } = buildAiPrompt();
  if (!ids.length) { setAiStatus("対象のタスクがありません。"); return; }
  state.aiContext = { ids };
  save();
  try {
    await navigator.clipboard.writeText(prompt);
    setAiStatus("プロンプトをコピーしました。お使いのAIに貼り付けてください。");
  } catch (e) {
    const ta = document.getElementById("ai-prompt");
    const details = ta.closest("details"); if (details) details.open = true;
    ta.focus(); ta.select();
    setAiStatus("自動コピー不可。プロンプト欄を選択しました（Ctrl/⌘+Cでコピー）。");
  }
}

function aiApplyPaste() {
  const text = document.getElementById("ai-paste").value.trim();
  if (!text) { setAiStatus("AIの回答を貼り付けてください。"); return; }
  if (!state.aiContext || !state.aiContext.ids) { setAiStatus("先に「プロンプトをコピー」を押してください。"); return; }
  const orderIds = parseOrder(text, state.aiContext.ids);
  if (!orderIds) { setAiStatus("回答から並び順（ORDER: ...）を読み取れませんでした。"); return; }
  applyAiOrder(orderIds, text, "コピペ");
  switchTab("priority");
  setAiStatus("AIの提案を適用しました。");
}

async function aiRunDirect() {
  const key = getApiKey();
  if (!key) { setAiStatus("先にAPIキーを設定してください。"); return; }

  const { prompt, ids } = buildAiPrompt();
  if (!ids.length) { setAiStatus("対象のタスクがありません。"); return; }
  state.aiContext = { ids };

  const runBtn = document.getElementById("ai-run");
  const box = document.getElementById("ai-result");
  const textEl = document.getElementById("ai-result-text");
  runBtn.disabled = true;
  box.hidden = false;
  textEl.textContent = "";
  document.getElementById("ai-meta").textContent = "";
  document.getElementById("ai-applied").textContent = "";
  setAiStatus("AIに問い合わせ中…");

  try {
    const full = await streamAI(prompt, (t) => { textEl.textContent = t; });
    const orderIds = parseOrder(full, ids);
    if (orderIds) {
      applyAiOrder(orderIds, full, currentModel());
      setAiStatus("AI提案順に並べ替えました。優先度タブで確認できます。");
    } else {
      state.aiSuggestion = {
        orderIds: [], text: full, createdAt: Date.now(),
        model: currentModel(), signature: tasksSignature(),
      };
      save();
      renderAll();
      setAiStatus("提案は取得しましたが、並び順を自動抽出できませんでした。");
    }
  } catch (e) {
    setAiStatus("エラー: " + e.message);
  } finally {
    document.getElementById("ai-run").disabled = !getApiKey();
  }
}

/* ---- 描画 ---- */
function renderAi() {
  const keyStatusEl = document.getElementById("ai-key-status");
  if (!keyStatusEl) return; // AIビュー未挿入時の保険

  const provider = currentProvider();
  const providerSel = document.getElementById("ai-provider");
  if (providerSel) providerSel.value = provider;

  // モデル候補をプロバイダに応じて再構築
  const modelSel = document.getElementById("ai-model");
  modelSel.innerHTML = MODEL_OPTIONS[provider]
    .map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`)
    .join("");
  modelSel.value = currentModel();

  // APIキー欄（プロバイダ別）
  const hasKey = !!getApiKey(provider);
  keyStatusEl.textContent = hasKey ? "設定済み" : "未設定";
  document.getElementById("ai-run").disabled = !hasKey;
  const keyInput = document.getElementById("ai-key");
  keyInput.placeholder = provider === "gemini" ? "AIza..." : "sk-ant-...";
  const hintEl = document.getElementById("ai-key-hint");
  if (hintEl) {
    hintEl.innerHTML = provider === "gemini"
      ? 'キーは <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">Google AI Studio</a> で発行（無料枠あり・前払い不要）'
      : 'キーは <a href="https://console.anthropic.com" target="_blank" rel="noopener">Anthropic Console</a> で発行（要チャージ）';
  }

  const { prompt } = buildAiPrompt();
  document.getElementById("ai-prompt").value = prompt;

  const box = document.getElementById("ai-result");
  if (state.aiSuggestion && state.aiSuggestion.text) {
    box.hidden = false;
    document.getElementById("ai-result-text").textContent = state.aiSuggestion.text;
    const stale = state.aiSuggestion.signature !== tasksSignature();
    const when = new Date(state.aiSuggestion.createdAt).toLocaleString("ja-JP");
    const model = state.aiSuggestion.model ? state.aiSuggestion.model + " ・ " : "";
    document.getElementById("ai-meta").textContent = `${model}${when}${stale ? " ・ タスクが変わりました（再提案推奨）" : ""}`;
    document.getElementById("ai-applied").textContent =
      (state.settings.sortMode === "ai" && state.aiSuggestion.orderIds.length) ? "適用中" : "";
    document.getElementById("ai-apply").disabled = !state.aiSuggestion.orderIds.length;
  } else {
    box.hidden = true;
  }
}

/* =========================================================
 * まとめて入力：自由記述 → AIでタスク化 → 一括登録
 * ======================================================= */
function buildBulkPrompt(text) {
  const today = todayStr();
  return `あなたは優秀なアシスタントです。次のメモ（やること・目標）を、管理しやすいタスクに分解・整理してください。
今日の日付は ${today} です。

【ルール】
- 大きすぎる項目は実行できる単位に分解する
- 各タスクに作業見積（分）を概算で付ける
- 締切が読み取れるものは設定。読み取れない場合は、緊急度と分量から今日(${today})以降の日付に振り分ける（1日に詰め込みすぎない／目安は1日合計3〜4時間まで）
- 関連するタスクは同じ「目標」名でグループ化する（なければ null）

【入力メモ】
${text}

【出力】
次の形式のJSON配列だけを出力してください。前後に説明文やコードフェンスは付けないでください。
[
  {"title":"タスク名","effort":30,"deadline":"YYYY-MM-DD または null","goal":"目標名 または null","note":"補足 または null"}
]
- effort は分単位の整数（不明なら null）
- deadline は YYYY-MM-DD 形式（不明なら null）
- すべての項目を漏れなく含める`;
}

function extractJsonArray(text) {
  if (!text) return null;
  const s = String(text).replace(/```json/gi, "```").split("```").join("").trim();

  // パース（末尾カンマも許容して再挑戦）
  const relaxed = (str) => {
    try { return JSON.parse(str); } catch (e) { /* try next */ }
    try { return JSON.parse(str.replace(/,\s*([\]}])/g, "$1")); } catch (e) { /* give up */ }
    return undefined;
  };
  // 値から配列を取り出す（配列そのもの / {tasks:[...]} / 任意の配列プロパティ）
  const pickArray = (v) => {
    if (Array.isArray(v)) return v;
    if (v && typeof v === "object") {
      if (Array.isArray(v.tasks)) return v.tasks;
      for (const k in v) if (Array.isArray(v[k])) return v[k];
    }
    return null;
  };

  let arr = pickArray(relaxed(s));            // 1) 全体をそのまま
  if (arr) return arr;

  const a = s.indexOf("["), b = s.lastIndexOf("]");   // 2) [ 〜 ]
  if (a !== -1 && b > a) { arr = pickArray(relaxed(s.slice(a, b + 1))); if (arr) return arr; }

  const c = s.indexOf("{"), d = s.lastIndexOf("}");   // 3) { 〜 }（オブジェクト包み）
  if (c !== -1 && d > c) { arr = pickArray(relaxed(s.slice(c, d + 1))); if (arr) return arr; }

  return null;
}

function normalizeParsedTasks(arr) {
  const out = [];
  arr.forEach((item) => {
    if (!item || typeof item !== "object") return;
    const title = (item.title || item.name || "").toString().trim();
    if (!title) return;

    let effort = item.effort;
    if (typeof effort === "string") effort = parseInt(effort, 10);
    effort = (typeof effort === "number" && !isNaN(effort) && effort > 0) ? Math.round(effort) : null;

    let deadline = (item.deadline == null ? "" : String(item.deadline)).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(deadline)) deadline = null;

    let goal = item.goal == null ? "" : String(item.goal).trim();
    if (!goal || goal.toLowerCase() === "null") goal = null;

    let note = item.note == null ? "" : String(item.note).trim();
    if (note.toLowerCase() === "null") note = "";

    out.push({ title, effort, deadline, goal, note });
  });
  return out;
}

function findOrCreateGoal(name, cache) {
  const key = name.trim().toLowerCase();
  if (cache[key]) return cache[key];
  let g = state.goals.find((x) => x.title.trim().toLowerCase() === key);
  if (!g) {
    g = { id: uid(), title: name.trim(), desc: "", emoji: "🎯", createdAt: Date.now() };
    state.goals.push(g);
  }
  cache[key] = g.id;
  return g.id;
}

// パース結果のタスク群を、チェックボックス付きプレビューに（まとめ入力・分解で共用）
function previewTasksHTML(parsed, label, chkClass) {
  return `<div class="bulk-preview-head">${parsed.length}件の${esc(label)}（チェックしたものを追加）</div>` +
    parsed.map((t, i) => {
      const chips = [];
      if (t.goal) chips.push(`<span class="chip goal">🎯 ${esc(t.goal)}</span>`);
      chips.push(`<span class="chip">🗓 ${esc(t.deadline ? deadlineLabel(t.deadline).text : "期限なし")}</span>`);
      chips.push(`<span class="chip">⏱ ${esc(effortLabel(t.effort))}</span>`);
      return `<label class="bulk-row"><input type="checkbox" class="${chkClass}" data-i="${i}" checked><div class="bulk-row-main"><div class="bulk-row-title">${esc(t.title)}</div><div class="task-meta">${chips.join("")}</div></div></label>`;
    }).join("");
}

// 解析できなかったときに生の回答を見せる（共用）
function rawReplyHTML(text) {
  return `<div class="bulk-preview-head">AIの生の回答（自動解析できませんでした）</div>`
    + `<textarea class="ai-paste" rows="6" readonly>${esc(text)}</textarea>`
    + `<p class="ai-sub">途中で切れている場合はモデルを変える/再試行を、形式が違う場合はこの内容を「貼り付けて解析」欄に貼って再解析してください。</p>`;
}

function openBulkModal() {
  modalTitle.textContent = "まとめて入力（AIでタスク化）";
  modalBody.innerHTML = `
    <p class="ai-sub">やること・目標を箇条書きや文章で自由に書いてください。AIがタスク（見積・締切・目標）に整理し、日付に振り分けます。</p>
    <div class="field">
      <textarea id="bulk-input" rows="7" placeholder="例）来週の役員会の準備一式。競合調査、企画書ドラフト、スライド作成、関係者へ日程連絡。経費精算も今週中。"></textarea>
    </div>
    <div class="bulk-actions">
      <button type="button" class="btn btn-primary" id="bulk-run">⚡ AIでタスク化</button>
      <button type="button" class="btn btn-ghost" id="bulk-copy">📋 プロンプトをコピー</button>
      <span id="bulk-status" class="ai-status"></span>
    </div>
    <details class="ai-block">
      <summary>AIの回答（JSON）を貼り付けて解析（コピペ方式）</summary>
      <textarea id="bulk-paste" class="ai-paste" rows="5" placeholder="AIの回答をここに貼り付け…"></textarea>
      <button type="button" class="btn btn-ghost" id="bulk-parse">解析</button>
    </details>
    <div id="bulk-preview" class="bulk-preview"></div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" id="bulk-cancel">閉じる</button>
      <button type="button" class="btn btn-primary" id="bulk-add" disabled>選択したタスクを追加</button>
    </div>`;

  let parsed = [];

  function setBulkStatus(m) {
    const e = document.getElementById("bulk-status");
    if (e) e.textContent = m;
  }

  function showPreview() {
    const box = document.getElementById("bulk-preview");
    const addBtn = document.getElementById("bulk-add");
    if (!parsed.length) { box.innerHTML = ""; addBtn.disabled = true; return; }
    box.innerHTML = previewTasksHTML(parsed, "タスク", "bulk-chk");
    addBtn.disabled = false;
  }

  function showRaw(text) {
    document.getElementById("bulk-preview").innerHTML = rawReplyHTML(text);
    document.getElementById("bulk-add").disabled = true;
  }

  function ingest(text) {
    if (!text || !text.trim()) {
      setBulkStatus("AIからの回答が空でした。モデルを変える/出力量を増やすか、コピペ方式をお試しください。");
      return;
    }
    const arr = extractJsonArray(text);
    if (!arr) { setBulkStatus("JSONを読み取れませんでした。生の回答を表示します。"); showRaw(text); return; }
    parsed = normalizeParsedTasks(arr);
    if (!parsed.length) { setBulkStatus("有効なタスクが見つかりませんでした。"); showRaw(text); return; }
    setBulkStatus(`${parsed.length}件を読み取りました。内容を確認して追加してください。`);
    showPreview();
  }

  document.getElementById("bulk-run").addEventListener("click", async () => {
    const text = document.getElementById("bulk-input").value.trim();
    if (!text) { setBulkStatus("やること・目標を入力してください。"); return; }
    if (!getApiKey()) { setBulkStatus("APIキーが未設定です。『プロンプトをコピー』で手動でも作れます（設定はAI提案タブから）。"); return; }
    const btn = document.getElementById("bulk-run");
    btn.disabled = true;
    setBulkStatus("AIでタスク化中…");
    try {
      const full = await streamAI(buildBulkPrompt(text), () => {}, 8192);
      ingest(full);
    } catch (e) {
      setBulkStatus("エラー: " + e.message);
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("bulk-copy").addEventListener("click", async () => {
    const text = document.getElementById("bulk-input").value.trim();
    if (!text) { setBulkStatus("先にやること・目標を入力してください。"); return; }
    try {
      await navigator.clipboard.writeText(buildBulkPrompt(text));
      setBulkStatus("プロンプトをコピーしました。AIに貼り付け、回答を下の欄に貼って『解析』を押してください。");
    } catch (e) {
      setBulkStatus("自動コピー不可。プロンプト全文は手動でコピーしてください。");
    }
  });

  document.getElementById("bulk-parse").addEventListener("click", () => {
    const text = document.getElementById("bulk-paste").value.trim();
    if (!text) { setBulkStatus("AIの回答を貼り付けてください。"); return; }
    ingest(text);
  });

  document.getElementById("bulk-cancel").addEventListener("click", closeModal);

  document.getElementById("bulk-add").addEventListener("click", () => {
    const checks = Array.from(document.querySelectorAll("#bulk-preview .bulk-chk:checked")).map((c) => Number(c.dataset.i));
    if (!checks.length) { setBulkStatus("追加するタスクを選んでください。"); return; }
    const goalCache = {};
    let added = 0;
    checks.forEach((i) => {
      const t = parsed[i];
      if (!t) return;
      const goalId = t.goal ? findOrCreateGoal(t.goal, goalCache) : null;
      state.tasks.push({
        id: uid(), goalId, title: t.title, deadline: t.deadline, effort: t.effort,
        status: "todo", note: t.note || "", createdAt: Date.now(), completedAt: null,
      });
      added++;
    });
    save();
    renderAll();
    closeModal();
    switchTab("priority");
  });

  openModal();
  document.getElementById("bulk-input").focus();
}

/* =========================================================
 * カレンダー取り込み（.ics / iCalendar）— OAuth不要・端末内で解析
 * ======================================================= */
function unescapeICS(v) {
  return String(v).replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}
function localYMD(dt) { return dt.toLocaleDateString("sv-SE"); } // YYYY-MM-DD（ローカル）

// DTSTART/DTEND の値を {dateStr, ms, allDay} に
function parseICSDate(value, params) {
  const v = String(value).trim();
  const m = v.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
  if (!m) return null;
  const y = m[1], mo = m[2], d = m[3], hh = m[4], mi = m[5], ss = m[6], z = m[7];
  const dateOnly = /VALUE=DATE/i.test(params || "") || hh === undefined;
  if (dateOnly) return { dateStr: `${y}-${mo}-${d}`, ms: null, allDay: true };
  if (z === "Z") {
    const dt = new Date(Date.UTC(+y, +mo - 1, +d, +hh, +mi, +(ss || 0)));
    return { dateStr: localYMD(dt), ms: dt.getTime(), allDay: false };
  }
  // フローティング/TZID付きは、書かれた壁時計の日付・時刻をそのまま採用
  const dt = new Date(+y, +mo - 1, +d, +hh, +mi, +(ss || 0));
  return { dateStr: `${y}-${mo}-${d}`, ms: dt.getTime(), allDay: false };
}
// DURATION（PT1H30M 等）を分に
function parseICSDuration(v) {
  const m = String(v).trim().match(/^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/i);
  if (!m) return null;
  const mins = (parseInt(m[1] || 0, 10) * 1440) + (parseInt(m[2] || 0, 10) * 60) + parseInt(m[3] || 0, 10) + Math.round(parseInt(m[4] || 0, 10) / 60);
  return mins > 0 ? mins : null;
}
function parseICS(text) {
  // RFC5545 行折り返しの復元（改行+空白/タブは継続行）
  const unfolded = String(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\n[ \t]/g, "");
  const lines = unfolded.split("\n");
  const events = [];
  let cur = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") { cur = {}; continue; }
    if (line === "END:VEVENT") { if (cur) events.push(cur); cur = null; continue; }
    if (!cur) continue;
    const idx = line.indexOf(":");
    if (idx === -1) continue;
    const left = line.slice(0, idx);
    const value = line.slice(idx + 1);
    const semi = left.indexOf(";");
    const name = (semi === -1 ? left : left.slice(0, semi)).toUpperCase();
    const params = semi === -1 ? "" : left.slice(semi + 1);
    if (name === "SUMMARY") cur.summary = unescapeICS(value);
    else if (name === "LOCATION") cur.location = unescapeICS(value);
    else if (name === "DTSTART") cur.start = parseICSDate(value, params);
    else if (name === "DTEND") cur.end = parseICSDate(value, params);
    else if (name === "DURATION") cur.duration = parseICSDuration(value);
    else if (name === "RRULE") cur.rrule = value;
  }
  return events;
}
function eventToTask(ev) {
  const title = (ev.summary || "").trim();
  if (!title || !ev.start) return null;
  let effort = null;
  if (!ev.start.allDay) {
    if (ev.start.ms != null && ev.end && ev.end.ms != null) {
      const d = Math.round((ev.end.ms - ev.start.ms) / 60000);
      if (d > 0 && d <= 600) effort = d; // 10時間超は所要時間として不自然なので除外
    } else if (ev.duration && ev.duration <= 600) {
      effort = ev.duration;
    }
  }
  const note = ev.location ? ("場所: " + ev.location) : "";
  return { title, effort, deadline: ev.start.dateStr, goal: null, note };
}

function openIcsModal() {
  modalTitle.textContent = "カレンダー取り込み（.ics）";
  modalBody.innerHTML = `
    <p class="ai-sub">Googleカレンダー等から書き出した <code>.ics</code> ファイルを選ぶと、予定をタスクとして取り込めます（OAuth不要・端末内で処理）。</p>
    <div class="field">
      <input type="file" id="ics-file" accept=".ics,text/calendar" />
    </div>
    <label class="ics-opt"><input type="checkbox" id="ics-future" checked> 今日以降の予定だけ取り込む</label>
    <span id="ics-status" class="ai-status"></span>
    <div id="ics-preview" class="bulk-preview"></div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" id="ics-cancel">閉じる</button>
      <button type="button" class="btn btn-primary" id="ics-add" disabled>選択した予定を追加</button>
    </div>`;

  let candidates = [];

  function setIcsStatus(m) { const e = document.getElementById("ics-status"); if (e) e.textContent = m; }

  function render() {
    const box = document.getElementById("ics-preview");
    const addBtn = document.getElementById("ics-add");
    const future = document.getElementById("ics-future").checked;
    const today = todayStr();
    const list = candidates.filter((t) => !future || (t.deadline && t.deadline >= today));
    if (!list.length) {
      box.innerHTML = candidates.length ? `<div class="bulk-preview-head">条件に合う予定がありません</div>` : "";
      addBtn.disabled = true;
      return;
    }
    box.innerHTML = `<div class="bulk-preview-head">${list.length}件の予定（チェックしたものを追加）</div>` +
      list.map((t) => {
        const i = candidates.indexOf(t);
        const chips = [`<span class="chip">🗓 ${esc(t.deadline)}</span>`, `<span class="chip">⏱ ${esc(effortLabel(t.effort))}</span>`];
        if (t.note) chips.push(`<span class="chip">📍</span>`);
        return `<label class="bulk-row"><input type="checkbox" class="ics-chk" data-i="${i}" checked><div class="bulk-row-main"><div class="bulk-row-title">${esc(t.title)}</div><div class="task-meta">${chips.join("")}</div></div></label>`;
      }).join("");
    addBtn.disabled = false;
  }

  document.getElementById("ics-file").addEventListener("change", (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setIcsStatus("読み込み中…");
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const events = parseICS(String(reader.result));
        candidates = events.map(eventToTask).filter(Boolean);
        if (!candidates.length) {
          setIcsStatus("予定（VEVENT）が見つかりませんでした。");
          document.getElementById("ics-preview").innerHTML = "";
          document.getElementById("ics-add").disabled = true;
          return;
        }
        setIcsStatus(`${candidates.length}件の予定を読み取りました。`);
        render();
      } catch (err) {
        setIcsStatus("読み込みに失敗しました: " + err.message);
      }
    };
    reader.onerror = () => setIcsStatus("ファイルを読めませんでした。");
    reader.readAsText(file);
  });

  document.getElementById("ics-future").addEventListener("change", render);
  document.getElementById("ics-cancel").addEventListener("click", closeModal);

  document.getElementById("ics-add").addEventListener("click", () => {
    const checks = Array.from(document.querySelectorAll("#ics-preview .ics-chk:checked")).map((c) => Number(c.dataset.i));
    if (!checks.length) { setIcsStatus("追加する予定を選んでください。"); return; }
    let added = 0;
    checks.forEach((i) => {
      const t = candidates[i];
      if (!t) return;
      state.tasks.push({
        id: uid(), goalId: null, title: t.title, deadline: t.deadline, effort: t.effort,
        status: "todo", note: t.note || "", createdAt: Date.now(), completedAt: null,
      });
      added++;
    });
    save();
    renderAll();
    closeModal();
    switchTab("priority");
  });

  openModal();
}

/* =========================================================
 * タスクの分解：親タスク＋任意の補足情報 → AIでサブタスク化
 * ======================================================= */
function buildDecomposePrompt(task, info, goalName) {
  const today = todayStr();
  const dl = task.deadline ? task.deadline : "期限なし";
  return `あなたは優秀なアシスタントです。次の「親タスク」を、実行できる小さなサブタスクに分解してください。
今日の日付は ${today} です。

【親タスク】
- タイトル: ${task.title}
- 目標: ${goalName || "なし"}
- 締切: ${dl}
- 現在の見積: ${effortLabel(task.effort)}
- メモ: ${task.note || "なし"}

【補足情報】
${info || "特になし"}

【ルール】
- 具体的で着手できる単位に分解する（3〜8個を目安に、細かすぎない）
- 各サブタスクに作業見積（分）を概算で付ける
- 締切は親タスクの締切(${dl})当日かそれより前に設定する。親に締切が無ければ緊急度から今日以降に配分
- 目標は親と同じ「${goalName || "（なし）"}」にする（親に目標が無ければ null）

【出力】
次の形式のJSON配列だけを出力してください（前後に説明文やコードフェンスは不要）:
[
  {"title":"サブタスク名","effort":30,"deadline":"YYYY-MM-DD または null","goal":${goalName ? JSON.stringify(goalName) : "null"},"note":"補足 または null"}
]
- effort は分単位の整数（不明なら null）
- deadline は YYYY-MM-DD 形式（不明なら null）`;
}

function openDecomposeModal(taskId) {
  const task = state.tasks.find((t) => t.id === taskId);
  if (!task) return;
  const goal = task.goalId ? goalById(task.goalId) : null;
  const goalName = goal ? goal.title : null;

  modalTitle.textContent = "タスクを分解";
  modalBody.innerHTML = `
    <div class="decompose-parent">
      <div class="bulk-row-title">${esc(task.title)}</div>
      <div class="task-meta">
        ${goal ? `<span class="chip goal">🎯 ${esc(goal.title)}</span>` : ""}
        <span class="chip">🗓 ${esc(deadlineLabel(task.deadline).text)}</span>
        <span class="chip">⏱ ${esc(effortLabel(task.effort))}</span>
      </div>
    </div>
    <div class="field">
      <label for="dec-info">補足情報（任意）— 制約・前提・成果物の形など、分解の手がかり</label>
      <textarea id="dec-info" rows="4" placeholder="例）社内データのみ使用。来週の役員会で使うスライド5枚程度。担当は自分ひとり。"></textarea>
    </div>
    <div class="bulk-actions">
      <button type="button" class="btn btn-primary" id="dec-run">⚡ AIで分解</button>
      <button type="button" class="btn btn-ghost" id="dec-copy">📋 プロンプトをコピー</button>
      <span id="dec-status" class="ai-status"></span>
    </div>
    <details class="ai-block">
      <summary>AIの回答（JSON）を貼り付けて解析（コピペ方式）</summary>
      <textarea id="dec-paste" class="ai-paste" rows="5" placeholder="AIの回答をここに貼り付け…"></textarea>
      <button type="button" class="btn btn-ghost" id="dec-parse">解析</button>
    </details>
    <label class="ics-opt"><input type="checkbox" id="dec-complete"> 追加後、元のタスクを完了にする</label>
    <div id="dec-preview" class="bulk-preview"></div>
    <div class="modal-actions">
      <button type="button" class="btn btn-ghost" id="dec-cancel">閉じる</button>
      <button type="button" class="btn btn-primary" id="dec-add" disabled>選択したサブタスクを追加</button>
    </div>`;

  let parsed = [];
  const setDecStatus = (m) => { const e = document.getElementById("dec-status"); if (e) e.textContent = m; };
  const promptText = () => buildDecomposePrompt(task, document.getElementById("dec-info").value.trim(), goalName);

  function showPreview() {
    const box = document.getElementById("dec-preview");
    const addBtn = document.getElementById("dec-add");
    if (!parsed.length) { box.innerHTML = ""; addBtn.disabled = true; return; }
    box.innerHTML = previewTasksHTML(parsed, "サブタスク", "dec-chk");
    addBtn.disabled = false;
  }

  function ingest(text) {
    if (!text || !text.trim()) { setDecStatus("AIからの回答が空でした。モデルを変える/出力量を増やすか、コピペ方式をお試しください。"); return; }
    const arr = extractJsonArray(text);
    if (!arr) { setDecStatus("JSONを読み取れませんでした。生の回答を表示します。"); document.getElementById("dec-preview").innerHTML = rawReplyHTML(text); document.getElementById("dec-add").disabled = true; return; }
    parsed = normalizeParsedTasks(arr);
    if (!parsed.length) { setDecStatus("有効なサブタスクが見つかりませんでした。"); document.getElementById("dec-preview").innerHTML = rawReplyHTML(text); document.getElementById("dec-add").disabled = true; return; }
    setDecStatus(`${parsed.length}件を読み取りました。確認して追加してください。`);
    showPreview();
  }

  document.getElementById("dec-run").addEventListener("click", async () => {
    if (!getApiKey()) { setDecStatus("APIキーが未設定です。『プロンプトをコピー』で手動でも作れます（設定はAI提案タブから）。"); return; }
    const btn = document.getElementById("dec-run");
    btn.disabled = true;
    setDecStatus("AIで分解中…");
    try {
      const full = await streamAI(promptText(), () => {}, 8192);
      ingest(full);
    } catch (e) {
      setDecStatus("エラー: " + e.message);
    } finally {
      btn.disabled = false;
    }
  });

  document.getElementById("dec-copy").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(promptText());
      setDecStatus("プロンプトをコピーしました。AIに貼り付け、回答を下の欄に貼って『解析』を押してください。");
    } catch (e) {
      setDecStatus("自動コピー不可。プロンプトは手動でコピーしてください。");
    }
  });

  document.getElementById("dec-parse").addEventListener("click", () => {
    const text = document.getElementById("dec-paste").value.trim();
    if (!text) { setDecStatus("AIの回答を貼り付けてください。"); return; }
    ingest(text);
  });

  document.getElementById("dec-cancel").addEventListener("click", closeModal);

  document.getElementById("dec-add").addEventListener("click", () => {
    const checks = Array.from(document.querySelectorAll("#dec-preview .dec-chk:checked")).map((c) => Number(c.dataset.i));
    if (!checks.length) { setDecStatus("追加するサブタスクを選んでください。"); return; }
    const goalCache = {};
    checks.forEach((i) => {
      const t = parsed[i];
      if (!t) return;
      const gName = t.goal || goalName; // 親の目標を継承
      const goalId = gName ? findOrCreateGoal(gName, goalCache) : null;
      state.tasks.push({
        id: uid(), goalId, title: t.title, deadline: t.deadline, effort: t.effort,
        status: "todo", note: t.note || "", createdAt: Date.now(), completedAt: null,
      });
    });
    if (document.getElementById("dec-complete").checked) {
      task.status = "done";
      task.completedAt = Date.now();
    }
    save();
    renderAll();
    closeModal();
    switchTab("priority");
  });

  openModal();
  document.getElementById("dec-info").focus();
}

/* ---------- Sample data ---------- */
function loadSample() {
  if (state.goals.length || state.tasks.length || state.memos.length) {
    if (!confirm("既存のデータにサンプルを追加します。よろしいですか？")) return;
  }
  const g1 = uid(), g2 = uid();
  state.goals.push(
    { id: g1, title: "新サービスの企画を通す", desc: "来月の役員会で承認を得る", emoji: "🚀", createdAt: Date.now() },
    { id: g2, title: "チーム運営を効率化する", desc: "定例業務の見直し", emoji: "📈", createdAt: Date.now() },
  );
  state.tasks.push(
    { id: uid(), goalId: g1, title: "競合調査メモをまとめる", deadline: addDaysStr(1), effort: 30, status: "todo", note: "", createdAt: Date.now(), completedAt: null },
    { id: uid(), goalId: g1, title: "企画書ドラフト作成", deadline: addDaysStr(5), effort: 240, status: "doing", note: "", createdAt: Date.now(), completedAt: null },
    { id: uid(), goalId: g1, title: "役員会の日程調整メール", deadline: addDaysStr(0), effort: 15, status: "todo", note: "", createdAt: Date.now(), completedAt: null },
    { id: uid(), goalId: g2, title: "週報フォーマットを見直す", deadline: addDaysStr(10), effort: 60, status: "todo", note: "", createdAt: Date.now(), completedAt: null },
    { id: uid(), goalId: null, title: "経費精算を提出", deadline: addDaysStr(-1), effort: 20, status: "todo", note: "", createdAt: Date.now(), completedAt: null },
  );
  state.memos.push(
    { id: uid(), text: "次回MTGでKPIの定義をそろえる件を提案する", createdAt: Date.now() },
  );
  save();
  renderAll();
  switchTab("priority");
}

document.addEventListener("DOMContentLoaded", init);

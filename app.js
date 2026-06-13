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
  settings: { deadlineWeight: 0.5 }, // 0=手軽さ重視 / 1=締切重視
};

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
        settings: Object.assign({ deadlineWeight: 0.5 }, parsed.settings || {}),
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

  const ranked = tasks
    .map((t) => ({ task: t, pri: priorityOf(t) }))
    .sort((a, b) => b.pri.score - a.pri.score);

  list.innerHTML = ranked.map(({ task, pri }) => taskCardHTML(task, pri)).join("");
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
        <button class="link-btn task-edit" data-action="edit">編集</button>
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

function openTaskModal(taskId, presetGoalId) {
  const task = taskId ? state.tasks.find((t) => t.id === taskId) : null;
  modalTitle.textContent = task ? "タスクを編集" : "タスクを追加";

  const goalOptions = [`<option value="">（未分類）</option>`]
    .concat(state.goals.map((g) =>
      `<option value="${esc(g.id)}" ${(task ? task.goalId : presetGoalId) === g.id ? "selected" : ""}>${esc(g.emoji || "🎯")} ${esc(g.title)}</option>`))
    .join("");

  modalBody.innerHTML = `
    <div class="field">
      <label for="f-title">タスク名 *</label>
      <input type="text" id="f-title" value="${esc(task ? task.title : "")}" placeholder="例）企画書をレビューする" />
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
      ${task ? `<button class="link-btn delete-btn" id="f-delete">削除</button>` : ""}
      <button class="btn btn-ghost" id="f-cancel">キャンセル</button>
      <button class="btn btn-primary" id="f-save">保存</button>
    </div>`;

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
  document.getElementById("f-save").addEventListener("click", () => saveTask(taskId));
  if (task) document.getElementById("f-delete").addEventListener("click", () => deleteTask(taskId));

  openModal();
  document.getElementById("f-title").focus();
}

function saveTask(taskId) {
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
      ${goal ? `<button class="link-btn delete-btn" id="g-delete">削除</button>` : ""}
      <button class="btn btn-ghost" id="g-cancel">キャンセル</button>
      <button class="btn btn-primary" id="g-save">保存</button>
    </div>`;

  let selectedEmoji = goal ? goal.emoji || "🎯" : "🎯";
  document.querySelectorAll("#emoji-presets .preset").forEach((btn) => {
    btn.addEventListener("click", () => {
      selectedEmoji = btn.dataset.emoji;
      document.querySelectorAll("#emoji-presets .preset").forEach((b) => b.classList.toggle("is-active", b === btn));
    });
  });

  document.getElementById("g-cancel").addEventListener("click", closeModal);
  document.getElementById("g-save").addEventListener("click", () => {
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
  // メモを下書きにタスク作成モーダルを開く
  state.memos = state.memos.filter((x) => x.id !== memoId);
  save();
  renderAll();
  openTaskModal(null, null);
  document.getElementById("f-title").value = m.text;
  document.getElementById("f-title").focus();
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
      case "edit-goal": openGoalModal(id); break;
      case "add-task-to-goal": openTaskModal(null, id); break;
      case "memo-to-task": memoToTask(id); break;
      case "memo-delete": deleteMemo(id); break;
    }
  });

  // フッター
  document.getElementById("load-sample").addEventListener("click", loadSample);
  document.getElementById("clear-all").addEventListener("click", () => {
    if (!confirm("すべてのデータを消去します。よろしいですか？")) return;
    state = { goals: [], tasks: [], memos: [], settings: { deadlineWeight: 0.5 } };
    activeGoalFilter = "all";
    save();
    renderAll();
  });
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

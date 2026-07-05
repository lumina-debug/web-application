"use strict";

/* =========================================================
 * 段取り（Dandori） — クラウド同期モジュール
 *   Firebase Authentication（Googleログイン）＋ Realtime Database で
 *   複数端末のデータを自動同期する。
 *
 *   ※ Realtime Database を採用（Firestore は新規作成に課金/請求先が
 *      必要になるケースがあるため）。Realtime Database は無料の Spark
 *      プランのまま・請求先登録なしで使える。
 *
 *   - 同期対象は app.js の state（tasks/goals/memos/recurring/
 *     settings/manualOrder など）。APIキーは state に含まれない
 *     ため、この同期・書き出しには一切混ざらない。
 *   - 保存先は users/{uid} に state を1ノード丸ごと。ルールで本人限定。
 *   - 競合は last-write-wins（state.updatedAt で新しい方を採用）。
 *   - 静的PWAのまま動かすため、Firebase は gstatic の ESM CDN を
 *     必要時に動的 import する（app.js は据え置き／疎結合）。
 *   - firebaseConfig は localStorage に端末ローカル保存（クラウドへは
 *     送らない）。設定UIから入力する。
 * ======================================================= */

const FB_VERSION = "10.12.5";
const BASE = `https://www.gstatic.com/firebasejs/${FB_VERSION}/`;
const CONFIG_KEY = "dandori.firebaseConfig"; // 端末ローカルの上書き用（通常は使わない）
const SIGNED_IN_KEY = "dandori.signedIn";    // 過去にログインした端末か（起動時に自動復元するか判断）

// このアプリ専用の Firebase 設定（公開前提の値。秘密ではない）。
// これをコードに固定してあるので、各端末は設定入力なしで「Googleでログイン」できる。
// データ保護は Realtime Database のルール（本人のuidのみ読み書き）で担保。
const HARDCODED_CONFIG = {
  apiKey: "AIzaSyD1x80IfyWHceY-NaH88jqvZ77pDXKwJas",
  authDomain: "dandori-dddf0.firebaseapp.com",
  databaseURL: "https://dandori-dddf0-default-rtdb.firebaseio.com",
  projectId: "dandori-dddf0",
  storageBucket: "dandori-dddf0.firebasestorage.app",
  messagingSenderId: "850916973828",
  appId: "1:850916973828:web:c5ed2d5bf471e9dd4f8451",
};

const CONFIG_FIELDS = [
  { key: "apiKey", required: true },
  { key: "authDomain", required: true },
  { key: "databaseURL", required: true },   // Realtime Database のURL（…firebaseio.com / …firebasedatabase.app）
  { key: "projectId", required: true },
  { key: "storageBucket", required: false },
  { key: "messagingSenderId", required: false },
  { key: "appId", required: true },
];

// ハードコードされた設定が有効か（apiKey/databaseURL/appId が埋まっているか）
function hasHardcodedConfig() {
  const c = HARDCODED_CONFIG;
  return !!(c && c.apiKey && c.databaseURL && c.appId);
}

/* ---------- firebaseConfig ----------
 * 通常はコードに固定した HARDCODED_CONFIG を使う。
 * 万一の上書き用に localStorage の設定があればそちらを優先（開発・切替用）。 */
function loadConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (raw) {
      const cfg = JSON.parse(raw);
      if (cfg && cfg.apiKey && cfg.databaseURL && cfg.appId) return cfg;
    }
  } catch (e) { /* ignore */ }
  return hasHardcodedConfig() ? HARDCODED_CONFIG : null;
}
function saveConfig(cfg) {
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ }
}
function hasConfig() { return !!loadConfig(); }

/* ---------- 状態 ---------- */
let fb = null;            // { app, auth, db, ...authFns, ...dbFns }
let initPromise = null;
let currentUser = null;
let unsubSnapshot = null;  // onValue の購読解除関数
let pushTimer = null;

/* ---------- Firebase 初期化（必要時に CDN から動的 import） ---------- */
function ensureFirebase() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const cfg = loadConfig();
    if (!cfg) throw new Error("Firebaseの設定がありません。");
    const [appMod, authMod, dbMod] = await Promise.all([
      import(BASE + "firebase-app.js"),
      import(BASE + "firebase-auth.js"),
      import(BASE + "firebase-database.js"),
    ]);
    const app = appMod.initializeApp(cfg);
    const auth = authMod.getAuth(app);
    const db = dbMod.getDatabase(app);
    fb = Object.assign({ app, auth, db }, authMod, dbMod);
    fb.onAuthStateChanged(auth, onAuth);
    // リダイレクト方式ログインの戻り（iOS PWA等）を回収。認証結果は onAuth が受ける
    fb.getRedirectResult(auth).catch((e) => setStatus("ログインに失敗：" + errMsg(e), true));
    return fb;
  })();
  initPromise.catch(() => { initPromise = null; }); // 失敗時は再試行できるように
  return initPromise;
}

/* ---------- 認証状態の変化 ---------- */
async function onAuth(user) {
  currentUser = user || null;
  if (unsubSnapshot) { unsubSnapshot(); unsubSnapshot = null; }
  renderPanel();
  updateFooter();
  if (!user) return;

  // 次回以降は起動時に自動でセッション復元・同期する印
  try { localStorage.setItem(SIGNED_IN_KEY, "1"); } catch (e) { /* ignore */ }

  const userRef = fb.ref(fb.db, "users/" + user.uid);

  await initialSync(userRef);

  // リアルタイム購読（他端末の変更を自動反映）。onValue はunsubscribe関数を返す
  unsubSnapshot = fb.onValue(userRef,
    (s) => {
      if (!s.exists()) return;
      const remote = s.val();
      // 空データで手元の中身を消さない（他端末の初期化中の空push対策）
      if (stateIsEmpty(remote) && !localIsEmpty()) return;
      // 自分の書き込みは updatedAt が同じなので下の条件で自然にスキップされる
      if ((remote && remote.updatedAt || 0) > window.Dandori.getUpdatedAt()) {
        window.Dandori.applyExternalState(remote, { notify: false });
        setStatus("他の端末の変更を反映（" + timeNow() + "）");
      }
    },
    (err) => setStatus("同期エラー：" + errMsg(err), true)
  );
}

// 初回マージ／手動同期。基本は last-write-wins（updatedAt）だが、
// 「空データで中身のあるデータを上書きしない」ガードを最優先する。
async function initialSync(userRef) {
  if (!fb || !currentUser) return;
  userRef = userRef || fb.ref(fb.db, "users/" + currentUser.uid);
  try {
    const snap = await fb.get(userRef);
    const local = window.Dandori.getUpdatedAt();
    const localEmpty = localIsEmpty();
    if (snap.exists() && !stateIsEmpty(snap.val())) {
      const remote = snap.val();
      const rT = (remote && remote.updatedAt) || 0;
      if (localEmpty || rT > local) {
        // ローカルが空、またはクラウドが新しい → クラウドを採用（空で潰さない）
        window.Dandori.applyExternalState(remote, { notify: false });
        setStatus("クラウドのデータを反映しました（" + timeNow() + "）");
      } else if (local > rT) {
        await pushNow();
      } else {
        setStatus("同期済み（" + timeNow() + "）");
      }
    } else {
      // クラウドが空 or 未作成
      if (!localEmpty) {
        await pushNow(); // この端末のデータでクラウドを初期化
      } else {
        setStatus("同期の準備ができました（データはまだありません）");
      }
    }
  } catch (e) {
    setStatus("同期に失敗：" + errMsg(e), true);
  }
}

// state に実データ（タスク/目標/メモ/週タスク）が無いか
function stateIsEmpty(s) {
  if (!s) return true;
  const n = (s.tasks && s.tasks.length) || 0;
  const g = (s.goals && s.goals.length) || 0;
  const m = (s.memos && s.memos.length) || 0;
  const r = (s.recurring && s.recurring.length) || 0;
  return (n + g + m + r) === 0;
}
function localIsEmpty() {
  try { return stateIsEmpty(window.Dandori.getState()); } catch (e) { return true; }
}

/* ---------- クラウドへ push（ローカル変更時・デバウンス） ---------- */
async function pushNow() {
  if (!fb || !currentUser) return;
  try {
    const data = JSON.parse(window.Dandori.getStateJSON()); // undefined を除去
    await fb.set(fb.ref(fb.db, "users/" + currentUser.uid), data);
    setStatus("保存しました（" + timeNow() + "）");
  } catch (e) {
    setStatus("クラウド保存に失敗：" + errMsg(e), true);
  }
}
function schedulePush() {
  if (!currentUser) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(() => { pushTimer = null; pushNow(); }, 1200);
}
// 未送信の変更があれば即座に送る（アプリを閉じる／背面化する直前などに使用）
function flushPush() {
  if (!currentUser || !pushTimer) return;
  clearTimeout(pushTimer);
  pushTimer = null;
  pushNow();
}

/* ---------- ログイン / ログアウト ---------- */
async function login() {
  try {
    await ensureFirebase();
  } catch (e) {
    setStatus("初期化に失敗：" + errMsg(e), true);
    alert("Firebaseの初期化に失敗しました。設定値を確認してください。\n" + errMsg(e));
    return;
  }
  const provider = new fb.GoogleAuthProvider();
  try {
    await fb.signInWithPopup(fb.auth, provider);
  } catch (e) {
    const code = (e && e.code) || "";
    // ポップアップが使えない環境（iOSのホーム画面アプリ等）はリダイレクトで再試行
    if (/popup|cancelled|blocked|operation-not-supported/i.test(code)) {
      setStatus("ポップアップが使えないため画面遷移でログインします…");
      // リダイレクト復帰後、起動時に自動でFirebase初期化→getRedirectResultを回収させる印
      try { localStorage.setItem(SIGNED_IN_KEY, "1"); } catch (_) { /* ignore */ }
      try { await fb.signInWithRedirect(fb.auth, provider); return; } catch (e2) { e = e2; }
    }
    setStatus("ログインに失敗：" + errMsg(e), true);
    alert("ログインに失敗しました。\n" + errMsg(e));
  }
}
async function logout() {
  try { localStorage.removeItem(SIGNED_IN_KEY); } catch (e) { /* ignore */ }
  if (!fb) return;
  if (unsubSnapshot) { unsubSnapshot(); unsubSnapshot = null; }
  try { await fb.signOut(fb.auth); } catch (e) { /* ignore */ }
}

/* =========================================================
 * UI（設定 / ログイン / 同期ステータス）
 * ======================================================= */
let overlay = null;
let statusEl = null;

function esc(s) {
  return String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
function timeNow() {
  const d = new Date();
  return String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
}
function errMsg(e) { return (e && (e.message || e.code)) || String(e); }

function buildPanel() {
  overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.hidden = true;
  overlay.innerHTML =
    '<div class="modal" role="dialog" aria-modal="true">' +
      '<div class="modal-header">' +
        '<h2>ログイン / 同期</h2>' +
        '<button type="button" class="icon-btn" data-sync="close" aria-label="閉じる">×</button>' +
      '</div>' +
      '<div class="modal-body" id="sync-body"></div>' +
    '</div>';
  document.body.appendChild(overlay);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) closePanel(); });
  overlay.querySelector('[data-sync="close"]').addEventListener("click", closePanel);
}

function openPanel() {
  if (!overlay) buildPanel();
  if (hasConfig() && !fb) ensureFirebase().catch(() => {/* renderPanelで案内 */});
  renderPanel();
  overlay.hidden = false;
}
function closePanel() { if (overlay) overlay.hidden = true; }

// 「設定を変更」が押された時だけ設定画面を強制表示するフラグ
let forceSetup = false;

function renderPanel() {
  if (!overlay) return;
  const body = overlay.querySelector("#sync-body");
  if (!body) return;

  if (forceSetup || !hasConfig()) { forceSetup = false; body.innerHTML = setupHTML(); wireSetup(body); return; }
  if (!currentUser) { body.innerHTML = loginHTML(); wireLogin(body); return; }
  body.innerHTML = signedInHTML(); wireSignedIn(body);
}

/* ---- 設定（firebaseConfig 入力） ---- */
function setupHTML() {
  const cfg = loadConfig() || {};
  // Realtime Database のセキュリティルール（本人だけが自分のデータを読み書き）
  const rules =
    "{\n" +
    "  \"rules\": {\n" +
    "    \"users\": {\n" +
    "      \"$uid\": {\n" +
    "        \".read\": \"$uid === auth.uid\",\n" +
    "        \".write\": \"$uid === auth.uid\"\n" +
    "      }\n" +
    "    }\n" +
    "  }\n" +
    "}";
  const fields = CONFIG_FIELDS.map((f) =>
    '<div class="field">' +
      '<label for="sync-cfg-' + f.key + '">' + esc(f.key) + (f.required ? ' <span class="req">*</span>' : '') + '</label>' +
      '<input id="sync-cfg-' + f.key + '" type="text" autocomplete="off" spellcheck="false" value="' + esc(cfg[f.key] || "") + '" />' +
    '</div>'
  ).join("");

  return '' +
    '<p class="sync-sub">複数端末で自動同期するには Firebase の設定が必要です（<b>Realtime Database</b> を使うので無料・請求先登録なしで利用できます）。下の値はこのブラウザにのみ保存され、クラウドには送られません。</p>' +
    '<details class="sync-help"><summary>準備の手順（初回のみ）</summary>' +
      '<ol class="sync-steps">' +
        '<li><a href="https://console.firebase.google.com/" target="_blank" rel="noopener">Firebase Console</a> でプロジェクトを作成</li>' +
        '<li>「Authentication」→「Sign-in method」で <b>Google</b> を有効化</li>' +
        '<li>「<b>Realtime Database</b>」を作成（ロケーションを選び、<b>ロックモード</b>で開始）。※「Firestore」ではありません</li>' +
        '<li>「プロジェクトの設定」→「マイアプリ」で <b>ウェブアプリ（&lt;/&gt;）</b> を追加し、表示される <code>firebaseConfig</code> の各値を下に貼り付け（<code>databaseURL</code> が含まれます）</li>' +
        '<li>Realtime Database の「ルール」タブを下記に置き換えて公開（本人だけが読み書き）</li>' +
      '</ol>' +
      '<pre class="sync-rules">' + esc(rules) + '</pre>' +
      '<p class="sync-sub">公開URL（GitHub Pages 等）で使う場合は、Authentication →「設定」→「承認済みドメイン」にそのドメインを追加してください。</p>' +
    '</details>' +
    '<form id="sync-cfg-form">' + fields +
      '<div class="sync-actions">' +
        '<button type="submit" class="btn btn-primary">設定を保存</button>' +
        '<span id="sync-status" class="sync-status"></span>' +
      '</div>' +
    '</form>';
}
function wireSetup(body) {
  statusEl = body.querySelector("#sync-status");
  const form = body.querySelector("#sync-cfg-form");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const cfg = {};
    let ok = true;
    for (const f of CONFIG_FIELDS) {
      const v = body.querySelector("#sync-cfg-" + f.key).value.trim();
      if (v) cfg[f.key] = v;
      if (f.required && !v) ok = false;
    }
    if (!ok) { setStatus("必須項目（*）を入力してください。", true); return; }
    const wasInit = !!fb;
    saveConfig(cfg);
    if (wasInit) {
      // 既に初期化済み → 設定差し替えはリロードで確実に反映
      alert("設定を保存しました。反映のためページを再読み込みします。");
      location.reload();
      return;
    }
    ensureFirebase()
      .then(() => renderPanel())
      .catch((err) => setStatus("初期化に失敗：" + errMsg(err), true));
    renderPanel();
  });
}

/* ---- ログイン ---- */
// ハードコード設定がある場合は「設定を変更」リンクを出さない（＝設定画面は非表示）
function editCfgLinkHTML() {
  return hasHardcodedConfig() ? "" : '<button id="sync-edit-cfg" class="link-btn">Firebase設定を変更</button>';
}
function wireEditCfg(body) {
  const b = body.querySelector("#sync-edit-cfg");
  if (b) b.addEventListener("click", () => { forceSetup = true; renderPanel(); });
}

function loginHTML() {
  return '' +
    '<p class="sync-sub">Googleアカウントでログインすると、この端末のデータがクラウドに保存され、他の端末と自動で同期されます。</p>' +
    '<div class="sync-actions">' +
      '<button id="sync-login" class="btn btn-primary">Googleでログイン</button>' +
      editCfgLinkHTML() +
    '</div>' +
    '<p class="sync-status" id="sync-status"></p>' +
    '<p class="sync-sub">※ ログインしなくても、これまで通り端末内（localStorage）だけで利用できます。APIキーは同期されません。</p>';
}
function wireLogin(body) {
  statusEl = body.querySelector("#sync-status");
  body.querySelector("#sync-login").addEventListener("click", login);
  wireEditCfg(body);
}

/* ---- ログイン中 ---- */
function signedInHTML() {
  const name = currentUser.displayName ? esc(currentUser.displayName) + "（" + esc(currentUser.email || "") + "）" : esc(currentUser.email || currentUser.uid);
  return '' +
    '<p class="sync-account">✓ <b>' + name + '</b> でログイン中</p>' +
    '<p class="sync-sub"><b>✅ 自動同期オン</b>：変更するたび自動でクラウドに保存され、同じアカウントの他端末にもリアルタイムで反映されます（通常、手動操作は不要）。<b>APIキーは同期されません</b>（端末ローカルのまま）。</p>' +
    '<div class="sync-actions">' +
      '<button id="sync-logout" class="btn btn-ghost">ログアウト</button>' +
      '<button id="sync-now" class="link-btn">🔄 今すぐ同期（予備）</button>' +
      editCfgLinkHTML() +
    '</div>' +
    '<p class="sync-status" id="sync-status"></p>';
}
function wireSignedIn(body) {
  statusEl = body.querySelector("#sync-status");
  body.querySelector("#sync-now").addEventListener("click", async () => {
    setStatus("同期中…");
    await initialSync();
  });
  body.querySelector("#sync-logout").addEventListener("click", logout);
  wireEditCfg(body);
}

/* ---- ステータス表示（パネル内＋フッター） ---- */
function setStatus(text, isError) {
  if (statusEl) {
    statusEl.textContent = text;
    statusEl.classList.toggle("is-error", !!isError);
  }
  updateFooter(text);
}
function updateFooter(text) {
  const el = document.getElementById("sync-state");
  const btn = document.getElementById("sync-btn");
  if (!el) return;
  if (currentUser) {
    el.hidden = false;
    el.textContent = "☁️ " + (currentUser.email || "ログイン中") + (text ? " · " + text : "");
    if (btn) btn.textContent = "☁️ 同期の設定…";
  } else {
    el.hidden = true;
    el.textContent = "";
    if (btn) btn.textContent = "☁️ ログイン / 同期…";
  }
}

/* =========================================================
 * 起動
 * ======================================================= */
function start() {
  const btn = document.getElementById("sync-btn");
  if (btn) btn.addEventListener("click", openPanel);
  // ローカル変更をクラウドへ自動反映（デバウンス）
  if (window.Dandori && window.Dandori.onSave) window.Dandori.onSave(schedulePush);
  // アプリを閉じる／背面化する直前に、未送信の変更を取りこぼさず送る
  document.addEventListener("visibilitychange", () => { if (document.hidden) flushPush(); });
  window.addEventListener("pagehide", flushPush);
  // 過去にログインした端末だけ、起動時に裏で初期化してセッションを自動復元する。
  // （未ログインの人に毎回 Firebase SDK を読み込ませないための最適化）
  let signedBefore = false;
  try { signedBefore = !!localStorage.getItem(SIGNED_IN_KEY); } catch (e) { /* ignore */ }
  if (hasConfig() && signedBefore) ensureFirebase().catch(() => { /* パネルを開いたときに案内 */ });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}

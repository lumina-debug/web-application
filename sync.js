"use strict";

/* =========================================================
 * 段取り（Dandori） — クラウド同期モジュール
 *   Firebase Authentication（Googleログイン）＋ Firestore で
 *   複数端末のデータを自動同期する。
 *
 *   - 同期対象は app.js の state（tasks/goals/memos/recurring/
 *     settings/manualOrder など）。APIキーは state に含まれない
 *     ため、この同期・書き出しには一切混ざらない。
 *   - 競合は last-write-wins（state.updatedAt で新しい方を採用）。
 *   - 静的PWAのまま動かすため、Firebase は gstatic の ESM CDN を
 *     必要時に動的 import する（app.js は据え置き／疎結合）。
 *   - firebaseConfig は localStorage に端末ローカル保存（クラウドへは
 *     送らない）。設定UIから入力する。
 * ======================================================= */

const FB_VERSION = "10.12.5";
const BASE = `https://www.gstatic.com/firebasejs/${FB_VERSION}/`;
const CONFIG_KEY = "dandori.firebaseConfig"; // 端末ローカル（state とは別保存）

const CONFIG_FIELDS = [
  { key: "apiKey", required: true },
  { key: "authDomain", required: true },
  { key: "projectId", required: true },
  { key: "storageBucket", required: false },
  { key: "messagingSenderId", required: false },
  { key: "appId", required: true },
];

/* ---------- firebaseConfig（端末ローカル保存） ---------- */
function loadConfig() {
  try {
    const raw = localStorage.getItem(CONFIG_KEY);
    if (!raw) return null;
    const cfg = JSON.parse(raw);
    if (cfg && cfg.apiKey && cfg.projectId && cfg.appId) return cfg;
  } catch (e) { /* ignore */ }
  return null;
}
function saveConfig(cfg) {
  try { localStorage.setItem(CONFIG_KEY, JSON.stringify(cfg)); } catch (e) { /* ignore */ }
}
function hasConfig() { return !!loadConfig(); }

/* ---------- 状態 ---------- */
let fb = null;            // { app, auth, db, ...authFns, ...fsFns }
let initPromise = null;
let currentUser = null;
let unsubSnapshot = null;
let pushTimer = null;

/* ---------- Firebase 初期化（必要時に CDN から動的 import） ---------- */
function ensureFirebase() {
  if (initPromise) return initPromise;
  initPromise = (async () => {
    const cfg = loadConfig();
    if (!cfg) throw new Error("Firebaseの設定がありません。");
    const [appMod, authMod, fsMod] = await Promise.all([
      import(BASE + "firebase-app.js"),
      import(BASE + "firebase-auth.js"),
      import(BASE + "firebase-firestore.js"),
    ]);
    const app = appMod.initializeApp(cfg);
    const auth = authMod.getAuth(app);
    let db;
    try {
      db = fsMod.initializeFirestore(app, {
        localCache: fsMod.persistentLocalCache({ tabManager: fsMod.persistentMultipleTabManager() }),
      });
    } catch (e) {
      // オフライン永続が使えない環境（プライベートブラウズ等）はメモリで継続
      db = fsMod.getFirestore(app);
    }
    fb = Object.assign({ app, auth, db }, authMod, fsMod);
    fb.onAuthStateChanged(auth, onAuth);
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

  const ref = fb.doc(fb.db, "users", user.uid);

  // 初回マージ（last-write-wins）
  try {
    const snap = await fb.getDoc(ref);
    const local = window.Dandori.getUpdatedAt();
    if (snap.exists()) {
      const remote = snap.data();
      const rT = remote.updatedAt || 0;
      if (rT > local) {
        window.Dandori.applyExternalState(remote, { notify: false });
        setStatus("クラウドのデータを反映しました（" + timeNow() + "）");
      } else if (local > rT) {
        await pushNow();
      } else {
        setStatus("同期中（" + timeNow() + "）");
      }
    } else {
      await pushNow(); // 初回：今の端末のデータをクラウドへ保存
    }
  } catch (e) {
    setStatus("初回同期に失敗：" + errMsg(e), true);
  }

  // リアルタイム購読（他端末の変更を自動反映）
  unsubSnapshot = fb.onSnapshot(ref,
    (s) => {
      if (s.metadata && s.metadata.hasPendingWrites) return; // 自分の書き込みは無視
      if (!s.exists()) return;
      const remote = s.data();
      if ((remote.updatedAt || 0) > window.Dandori.getUpdatedAt()) {
        window.Dandori.applyExternalState(remote, { notify: false });
        setStatus("他の端末の変更を反映（" + timeNow() + "）");
      }
    },
    (err) => setStatus("同期エラー：" + errMsg(err), true)
  );
}

/* ---------- クラウドへ push（ローカル変更時・デバウンス） ---------- */
async function pushNow() {
  if (!fb || !currentUser) return;
  try {
    const data = JSON.parse(window.Dandori.getStateJSON());
    await fb.setDoc(fb.doc(fb.db, "users", currentUser.uid), data);
    setStatus("保存しました（" + timeNow() + "）");
  } catch (e) {
    setStatus("クラウド保存に失敗：" + errMsg(e), true);
  }
}
function schedulePush() {
  if (!currentUser) return;
  clearTimeout(pushTimer);
  pushTimer = setTimeout(pushNow, 1200);
}

/* ---------- ログイン / ログアウト ---------- */
async function login() {
  try {
    await ensureFirebase();
    const provider = new fb.GoogleAuthProvider();
    await fb.signInWithPopup(fb.auth, provider);
  } catch (e) {
    setStatus("ログインに失敗：" + errMsg(e), true);
    alert("ログインに失敗しました。\n" + errMsg(e));
  }
}
async function logout() {
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
  const rules =
    "rules_version = '2';\n" +
    "service cloud.firestore {\n" +
    "  match /databases/{database}/documents {\n" +
    "    match /users/{userId} {\n" +
    "      allow read, write: if request.auth != null && request.auth.uid == userId;\n" +
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
    '<p class="sync-sub">複数端末で自動同期するには Firebase の設定が必要です（無料枠で利用できます）。下の値はこのブラウザにのみ保存され、クラウドには送られません。</p>' +
    '<details class="sync-help"><summary>準備の手順（初回のみ）</summary>' +
      '<ol class="sync-steps">' +
        '<li><a href="https://console.firebase.google.com/" target="_blank" rel="noopener">Firebase Console</a> でプロジェクトを作成</li>' +
        '<li>「Authentication」→「Sign-in method」で <b>Google</b> を有効化</li>' +
        '<li>「Firestore Database」を作成（本番モードでOK）</li>' +
        '<li>「プロジェクトの設定」→「マイアプリ」で <b>ウェブアプリ（&lt;/&gt;）</b> を追加し、表示される <code>firebaseConfig</code> の各値を下に貼り付け</li>' +
        '<li>Firestore の「ルール」を下記に置き換えて公開（本人だけが読み書き）</li>' +
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
function loginHTML() {
  return '' +
    '<p class="sync-sub">Googleアカウントでログインすると、この端末のデータがクラウドに保存され、他の端末と自動で同期されます。</p>' +
    '<div class="sync-actions">' +
      '<button id="sync-login" class="btn btn-primary">Googleでログイン</button>' +
      '<button id="sync-edit-cfg" class="link-btn">Firebase設定を変更</button>' +
    '</div>' +
    '<p class="sync-status" id="sync-status"></p>' +
    '<p class="sync-sub">※ ログインしなくても、これまで通り端末内（localStorage）だけで利用できます。APIキーは同期されません。</p>';
}
function wireLogin(body) {
  statusEl = body.querySelector("#sync-status");
  body.querySelector("#sync-login").addEventListener("click", login);
  body.querySelector("#sync-edit-cfg").addEventListener("click", () => { forceSetup = true; renderPanel(); });
}

/* ---- ログイン中 ---- */
function signedInHTML() {
  const name = currentUser.displayName ? esc(currentUser.displayName) + "（" + esc(currentUser.email || "") + "）" : esc(currentUser.email || currentUser.uid);
  return '' +
    '<p class="sync-account">✓ <b>' + name + '</b> でログイン中</p>' +
    '<p class="sync-sub">このアプリのデータ（タスク・目標・メモ・設定など）は自動でクラウドに保存され、同じアカウントの他端末と同期されます。<b>APIキーは同期されません</b>（端末ローカルのまま）。</p>' +
    '<div class="sync-actions">' +
      '<button id="sync-logout" class="btn btn-ghost">ログアウト</button>' +
      '<button id="sync-edit-cfg" class="link-btn">Firebase設定を変更</button>' +
    '</div>' +
    '<p class="sync-status" id="sync-status"></p>';
}
function wireSignedIn(body) {
  statusEl = body.querySelector("#sync-status");
  body.querySelector("#sync-logout").addEventListener("click", logout);
  body.querySelector("#sync-edit-cfg").addEventListener("click", () => { forceSetup = true; renderPanel(); });
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
  // ローカル変更をクラウドへ反映（デバウンス）
  if (window.Dandori && window.Dandori.onSave) window.Dandori.onSave(schedulePush);
  // 設定済みなら裏で初期化し、前回のログインを自動復元
  if (hasConfig()) ensureFirebase().catch(() => { /* パネルを開いたときに案内 */ });
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", start);
} else {
  start();
}

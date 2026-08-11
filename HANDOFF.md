# 引き継ぎ資料 — 段取り（Dandori）

新しいセッション／開発者がそのまま続きを作れるようにまとめた資料です。
（このファイル自体もリポジトリに含まれるので、新セッションでクローンすれば読めます）

---

## 0. まず押さえること（TL;DR）

- **何のアプリ**：個人向けのタスク優先度ボード「段取り（Dandori）」。日本語UI。
- **技術**：**バニラ HTML/CSS/JS のみ。ビルド不要・依存ゼロ**。データは `localStorage`。サーバーなし。
- **⚠️ PUSH先＝`claude/funny-tesla-bk7f0g`（本番・正本ブランチ）**：公開URL **https://lumina-debug.github.io/web-application/**（GitHub Pages）の**配信元がこの funny-tesla ブランチ**。つまり **funny-tesla に push するとサイトが更新される**。ユーザーは funny-tesla を「元のブランチ」と呼ぶ。
  - セッションごとに指定される作業ブランチ（例 `claude/account-linking-auto-sync-mdirkh`）でまず作業してよいが、**必ず最後に funny-tesla へ反映（fast-forward）して push すること**。反映しないと公開サイトに出ない。運用は §7 参照。**今は両ブランチとも同一コミットを指している**。
  - **PRはユーザーが明示的に頼むまで作らない**。
- **直近の実装（本番稼働中）**：
  - **予定表（週/月表示）＋空き時間ドラッグ＋タスク自動配置**（`gcal.js`）… Googleカレンダーは**閲覧のみ**（既存予定を表示して空き時間把握）。カレンダー上をドラッグ/タップで空き時間を指定→未完了タスクを自動配置→紫ブロックをドラッグで手直し。週/月切替。**Googleへは書き込まない**。**閲覧には初回のみ Google Cloud Console で Calendar API 有効化が必要**。詳細 §12。
  - **アカウント連携＆自動同期**（Firebase Auth/Google ＋ **Realtime Database**）… **実接続・複数端末同期まで動作確認済み**（PC↔スマホでタスクが同期）。詳細 §8。
  - **JSON 書き出し/取り込み**（端末間の手動移行・バックアップ）。
  - **至急タスクの先頭固定・まとめて選択（一括削除）・ドラッグ&ドロップ並び替え**（§11）。
- **同期の要点**：**Firestore ではなく Realtime Database**（Firestore は新規作成に課金/請求先が必要になり詰まったため）。**`firebaseConfig` は sync.js に固定済み**（`HARDCODED_CONFIG`、プロジェクト `dandori-dddf0`）→ 各端末は**設定入力なしで「Googleでログイン」だけ**。変更は自動同期（編集でpush・onValueでpull）。
- **次にやること候補**：CSV エクスポート、議事録→タスク抽出、定例レポート自動生成、同期の競合対策強化（現状 last-write-wins）など。
- **ローカル実行**：`python -m http.server 8000` → `http://localhost:8000`。
  - AIの「直接依頼」は **CORSの都合で `http://localhost`（HTTPS）でのみ動作**。`file://` では不可（コピペ方式は可）。
- **検証のしかた**：`node --check app.js` / `node --check sw.js`、`manifest.json` は `JSON.parse` で妥当性確認。ロジックは Node で小さく再現テスト（これまでもそうしてきた）。

---

## 1. ファイル構成

```
index.html          画面構造（タブ、モーダルの共通シェル、PWAタグ）
styles.css          見た目（CSS変数。末尾にモバイル用 @media (max-width:560px)）
app.js              すべてのロジック（約2000行・単一ファイル。フレームワーク不使用）
sync.js             クラウド同期（Firebase Auth/Google ＋ Realtime Database）。ESM module・CDNを動的import。app.jsの window.Dandori ブリッジ経由で疎結合。Googleアクセストークン取得ブリッジ window.DandoriCloud も提供（§12）
gcal.js             予定表（週/月表示・空き時間ドラッグ指定・タスク自動配置・移動）。Googleカレンダーは閲覧のみ。通常script・IIFE。詳細 §12
manifest.json       PWA マニフェスト
sw.js               Service Worker（ネットワーク優先、キャッシュ名 "dandori-v14"。sync.js / gcal.js もキャッシュ対象）
icons/              icon-192.png / icon-512.png / icon-180.png（優先度リストのモチーフ）
start-dandori.vbs   Windows自動起動用（サーバーを隠れて起動しブラウザで開く）
start-dandori.bat   同上（ウィンドウ表示版）
README.md           使い方・PWA公開手順・自動起動手順
HANDOFF.md          このファイル
```

---

## 2. データモデル（localStorage）

メインの状態は **`localStorage["dandori.v1"]`** に JSON で保存（`save()` / `load()`）。

```js
state = {
  goals:   [ { id, title, desc, emoji, createdAt } ],
  tasks:   [ { id, goalId|null, title, deadline|null, effort|null, status, note, createdAt, completedAt|null, recurringId? } ],
  memos:   [ { id, text, createdAt } ],
  settings:{ deadlineWeight, aiProvider, aiModel, geminiModel, sortMode, focusMode? },
  aiSuggestion: { orderIds, text, createdAt, model, signature } | null,
  aiContext:    { ids: [taskId...] } | null,   // 直近に生成したプロンプトのタスク番号→id対応
  manualOrder:  [ taskId... ],                  // 手動並び替え順
  recurring:    [ { id, title, weekdays:[0-6], goalId, effort, note, createdAt, lastGenerated } ],
  updatedAt:    1730000000000,                  // 最終更新ms。クラウド同期の last-write-wins 判定に使用
}
```

- `task.deadline` は `"YYYY-MM-DD"` か `null`。`task.effort` は分（整数）か `null`。
- `task.status` は `"todo" | "doing" | "done"`。
- **APIキーは state とは別保存**：`localStorage["dandori.apiKey"]`（Claude）/ `localStorage["dandori.geminiKey"]`（Gemini）。
  **意図的に state に入れていない**（同期・書き出しに混ぜないため）。
- **同期関連の localStorage（state とは別）**：`dandori.firebaseConfig`（通常は未使用の上書き用。本番は sync.js の `HARDCODED_CONFIG` を使う）／`dandori.signedIn`（過去にログインした端末か＝起動時に自動復元するかの印）。いずれもクラウドへは送らない。
- `save()` は毎回 `state.updatedAt = Date.now()` を打ち、ローカル変更を `saveListeners`（=sync.js）へ通知する。外部反映（取り込み/クラウド）中は `suppressSaveNotify` で通知を止めてエコー（再push）を防ぐ。

---

## 3. 主要機能と担当関数（app.js）

`grep -nE "^function " app.js` で一覧が出る。要点：

### 優先度スコア
- `urgencyScore(deadline)` … 締切が近い/超過ほど高い（0–100、HORIZON=30日）
- `quicknessScore(effort)` … 短いほど高い（対数、15分=100 / 8h=5）
- `priorityOf(task)` … `deadlineWeight × 締切 + (1-w) × 手軽さ`。`priorityTier()` で high/mid/low。
- 重みは `settings.deadlineWeight`（スライダー）。

### 並び順（優先度ビュー）
- `settings.sortMode` = `"score" | "ai" | "manual"`。
- `rankActive(tasks, orderIds)` … orderIds順→未掲載はスコア順で末尾（**スコア/AI/手動で共用**）。
- `orderForMode(mode)` / `orderedActiveIds(mode)` / `filteredActiveTasks()`（目標フィルタ適用）。
- 手動：各カードの ↑↓ → `moveTask(id, dir)`（フィルタ中は可視タスク同士で入替、隠れた分の位置は維持）。

### タブ／描画
- `renderAll()` がすべてを再描画。タブ = 優先度 / AI提案 / やりたいこと / メモ / 完了（`switchTab`）。
- `taskCardHTML(task, pri)` … 優先度ビューのカード（↑↓・分解・編集リンク付き）。

### モーダル共通シェル
- `#modal-overlay > .modal > (.modal-header, #modal-body)`。`openModal()` / `closeModal()`。
- **ヘッダー保存ボタン**：`setHeaderSave(handler)` でヘッダー右に「保存」を表示（iPhoneでキーボードに隠れず1タップ保存）。openTaskModal / openGoalModal で有効化。`openModal()` が毎回 null リセット。
- フォームは `<form>` 化済みで **Enterでも保存**（textareaは改行）。

### タスク/目標/メモ
- `openTaskModal(taskId, presetGoalId, prefill)` / `saveTask(taskId, prefill)` / `deleteTask`。
- `openGoalModal(goalId)`（内部 `saveGoal()`）。
- `memoToTask(memoId)` … **保存できた時にだけ元メモを削除**（キャンセルでは消えない）。`prefill.memoId` 経由。

### AI提案（並び替え提案）
- プロバイダ：Claude / Gemini を選択（`settings.aiProvider`）。`currentProvider()` / `currentModel()`。
- 送信：`streamClaude` / `streamGemini` / `streamAI(prompt, onText, maxTokens)`（**ブラウザ直叩き・SSEストリーミング**）。
  - Claude: `POST https://api.anthropic.com/v1/messages`、ヘッダー `x-api-key` / `anthropic-version: 2023-06-01` / **`anthropic-dangerous-direct-browser-access: true`**、SSE `content_block_delta.delta.text`。
  - Gemini: `POST .../v1beta/models/{model}:streamGenerateContent?alt=sse`、ヘッダー `x-goog-api-key`、`candidates[].content.parts[].text` を結合。
- プロンプト生成 `buildAiPrompt()` → 出力末尾の `ORDER: 3,1,5,...` を `parseOrder()` で解析 → `applyAiOrder()` で `aiSuggestion` 保存＋ `sortMode="ai"`。
- コピペ方式（キー不要）：プロンプトをコピー→AIの回答を貼り付け→`aiApplyPaste()`。
- モデル既定：Claude=`claude-opus-4-8`（他 sonnet/haiku）、Gemini=`gemini-2.5-flash`（他 3.5-flash/2.5-pro/3.1-flash-lite）。

### まとめて入力（自由記述→AIでタスク化）
- `openBulkModal()`、`buildBulkPrompt()`、`extractJsonArray()`（フェンス/オブジェクト包み/末尾カンマ/前後文を吸収）、`normalizeParsedTasks()`、`findOrCreateGoal()`。
- プレビュー描画は `previewTasksHTML()`、解析失敗時は `rawReplyHTML()`（**分解と共用**）。
- 出力上限は `streamAI(..., 8192)`（途切れ・Geminiの思考消費対策）。
- **下書きの自動一時保存**：本文・貼り付け欄を入力のたび `localStorage["dandori.bulkDraft"]`（`{input,paste}`）へ保存。`openBulkModal()` 冒頭で復元し、誤ってESC/背景クリックで閉じても消えない。**タスク追加成功時**と「下書きを消す」で `clearBulkDraft()`。`loadBulkDraft/saveBulkDraft/clearBulkDraft` はモジュール関数。

### タスク分解
- カードの「分解」→ `openDecomposeModal(taskId)`、`buildDecomposePrompt(task, info, goalName)`。
- 親の情報＋任意の補足情報を渡す。サブタスクは**親の目標を継承**。「追加後に元タスクを完了にする」オプション有り。

### カレンダー取込（.ics）
- `openIcsModal()`、`parseICS()`（RFC5545の行折り返し復元）、`parseICSDate`（VALUE=DATE / フローティング / Z=UTC→ローカル）、`parseICSDuration`、`eventToTask`。
- 「今日以降のみ」フィルタ。OAuth不要・端末内処理。

### 集中モード（次の1件）
- `settings.focusMode`。`renderFocus()`（現在の並び順の先頭1件を大表示）、`focusComplete` / `focusSkip`、`focusSkipped`（一時スキップ・非永続）。

### 週タスク（繰り返し）
- `openRecurringModal()`、`generateRecurring()`。
- **アプリを開いた日に生成**（`init()` と `visibilitychange` で実行）。`lastGenerated` で重複防止、取りこぼしは**直近14日まで補完**、新規ルールは過去を作らない。

---

## 4. UI/イベントの流儀

- **イベント委譲**：`.content` のクリックを1か所で受け、`data-action`（toggle/edit/decompose/move-up/move-down/sort-ai/sort-score/focus-*/memo-* など）で分岐。カードに `data-id`。
- HTML挿入は必ず `esc()` でエスケープ。
- 文字列日付は `"YYYY-MM-DD"`、比較は文字列のままでOK（`todayStr()` / `addDaysStr(n)` / `nextDayStr` / `weekdayOf`）。
- `Date.now()` 等はブラウザ実行なので普通に使用可（※Node検証スクリプト側では使わない運用）。

---

## 5. PWA / Service Worker

- `index.html` に manifest / theme-color / apple-touch-icon / SW登録あり。
- `sw.js` は **ネットワーク優先**（オンラインは常に最新→キャッシュ更新、オフライン時のみキャッシュ）。**外部API（別オリジン）には介入しない**。
- **資産を変えたら**：基本はネットワーク優先なのでリロードで反映。確実に切り替えたい時は **`CACHE` 名を上げる**（現在 `"dandori-v14"`。同期系を変えた時は毎回上げてきた）。
- iPhoneのホーム画面アプリは、更新反映に**Safariで一度リロード／アプリ再起動**が要ることがある。

---

## 6. モバイル（iOS）対応の要点

- 入力欄はモバイルで **16px**（`@media (max-width:560px)` で `input,select,textarea{font-size:16px !important}`）→ **Safariの自動ズーム防止**。
- `.modal-actions` は **下部に sticky 固定**＋セーフエリア余白。`.modal` は `max-height: 90dvh`。
- ヘッダーに保存ボタン（§3 モーダル）。

---

## 7. 開発・公開のワークフロー

- ローカル確認：`python -m http.server 8000` → `http://localhost:8000`（直接依頼を試すならこれ。`file://`不可）。
- 変更後の検証（最低限）：`node --check app.js`、`node --check sync.js`（ESMなので `.mjs` にコピーしてから、または `node --input-type=module --check`）、`node --check sw.js`、`node -e 'JSON.parse(require("fs").readFileSync("manifest.json","utf8"))'`。UIは Playwright（グローバル導入済み: `/opt/node22/lib/node_modules/playwright`、Chromium: `/opt/pw-browsers/chromium-1194/chrome-linux/chrome`）で `http://localhost:8000` を開いてスモークテストしてきた。
- コミット：日本語メッセージ。末尾に Co-Authored-By とセッションURL（新セッションのものに置き換え）。
- **プッシュ先（重要）**：
  1. まず作業ブランチへ push（`git push -u origin <作業ブランチ>`）。
  2. **公開するため `claude/funny-tesla-bk7f0g` に反映して push**：
     ```
     git branch -f claude/funny-tesla-bk7f0g <HEAD>
     git push origin claude/funny-tesla-bk7f0g
     ```
     （作業ブランチは funny-tesla を土台にしているので基本 fast-forward。失敗時のみ指数バックオフで最大4回リトライ）
  3. **funny-tesla に push すると GitHub Pages が自動で再ビルド＆デプロイ**して公開サイトが更新される。
- **⚠️ Pages デプロイが一時失敗することがある**：ビルド成果物は正常でも deploy ステップが「Deployment failed, try again later.」で落ちる GitHub 側の一時障害を実際に2回連続で踏んだ（サイトが数版古いまま止まる）。**push 後は Pages ビルドの成否を必ず確認**すること。
  - 確認：GitHub MCP `mcp__github__actions_list`（`method:list_workflow_runs`, `branch:claude/funny-tesla-bk7f0g`）で「pages build and deployment」の conclusion を見る（出力が大きいので `python -c` でJSONパースして絞る）。失敗ログは `mcp__github__get_job_logs`（`failed_only:true, return_content:true`）。
  - 復旧：**新規コミットを1つ積んで push**すると新しいビルドが走り直る（SW の `CACHE` 版数を上げるのが一石二鳥＝クライアント更新も促す）。ワークフローの再実行（`actions_run_trigger` の `rerun_workflow_run`）は Pages の動的ワークフローでは queued のまま進まないことがあった。
  - 反映確認：`WebFetch` で `…/sync.js?v=<sha>`（クエリでキャッシュ回避）を取り、狙った内容が出ているか確認。
- スマホ公開：既に設定済み（Pages 配信元 = funny-tesla）。HTTPSで配信 →「ホーム画面に追加」。**更新が古い時は iPhone アプリを終了→再起動、または Safari で一度リロード**。

---

## 8. アカウント連携＆自動同期（本番稼働中）

§8 は完了し、**PC↔スマホでの実同期まで動作確認済み**。Firebase プロジェクト `dandori-dddf0`（Realtime Database）を使用、`firebaseConfig` は sync.js に固定済みなので**各端末は設定入力なしで「Googleでログイン」だけ**。変更は自動同期される。

### 実装したもの
- **JSON 書き出し / 取り込み**（app.js）：フッターの「📤 書き出し」「📥 取り込み」。`exportData()` / `importDataFromFile(file)`。取り込みは `tasks` 配列の有無で妥当性チェックし、確認の上 `Dandori.applyExternalState(obj, {notify:true, touch:true})` で全置換（最新扱い＝ログイン中ならクラウドへも反映）。**APIキーは含まれない**。
- **Firebase 同期**（`sync.js`、`<script type="module">`）：
  - **Auth**：Google ログイン。`signInWithPopup` → 失敗（popup/blocked/cancelled/operation-not-supported）時は自動で `signInWithRedirect` にフォールバック（iOSのホーム画面アプリ対策）。`getRedirectResult` で戻りを回収。既定の local 永続でセッション自動復元。
  - **Realtime Database**：`users/{uid}` に state 全体を1ノードで保存（`ref/get/set/onValue`）。オフラインは localStorage 側で担保（web版RTDBのディスク永続はモバイル限定のため未使用。再接続時に onValue が発火）。
  - **CDN 動的import**：`https://www.gstatic.com/firebasejs/10.12.5/firebase-{app,auth,database}.js` を必要時に import（静的構成維持、app.js は据え置き）。
  - **自動同期（双方向）**：
    - **push**：`window.Dandori.onSave(schedulePush)` 登録済み。ローカル編集で `save()`→`schedulePush()`（1.2sデバウンス）→`pushNow()`（`set(users/{uid}, state)`）。**背面化/離脱時フラッシュ**：`visibilitychange`(hidden)/`pagehide` で `flushPush()` し、編集直後に閉じても取りこぼさない。
    - **pull**：`onValue` でリアルタイム購読。remote 変更を自動反映。
  - **初回マージ `initialSync(userRef)`**：`get` して `stateIsEmpty()`/`updatedAt` で判定。**空データ保護を最優先**（ローカルが空→クラウド採用／クラウドが空→ローカルをpush／両方中身あり→updatedAtのlast-write-wins）。`onValue` 側も「空リモートで手元の中身を消さない」ガードあり。パネルの「🔄 今すぐ同期（予備）」も `initialSync()` を呼ぶ。
  - **エコー防止**：自分の書き込みは remote.updatedAt が local と同値になるので `remote.updatedAt > local` で自然にスキップ。外部反映中は app.js 側 `suppressSaveNotify` で再push抑止。
  - **設定はコード固定**：`sync.js` の **`HARDCODED_CONFIG`**（プロジェクト `dandori-dddf0`。config は公開前提の値で秘密ではない）。設定入力フォーム・「設定を変更」リンクは `hasHardcodedConfig()` が真のとき非表示（`editCfgLinkHTML()`）。`setupHTML`/`wireSetup` はフォールバックとして残置。`localStorage["dandori.firebaseConfig"]` があればそれを優先（開発時の上書き用）。
  - **ログイン**：`signInWithPopup`→失敗時 `signInWithRedirect`（iOS PWA対策）。リダイレクト開始時に `dandori.signedIn` を立て、復帰後の起動で自動 `ensureFirebase()`→`getRedirectResult` 回収→ログイン完了。
  - **起動時の自動復元**：`dandori.signedIn` がある端末のみ起動時に `ensureFirebase()`（未ログインの人には Firebase SDK を読み込ませない最適化）。ログアウトでフラグ削除。
- **app.js ブリッジ `window.Dandori`**：`getState()` / `getStateJSON()` / `getUpdatedAt()` / `applyExternalState(obj,{notify,touch})` / `onSave(cb)`。sync.js はこれ経由で疎結合（app.js は Firebase を知らない）。

### UI
- フッターに「☁️ ログイン / 同期…」ボタン（`#sync-btn`）＋ ログイン中の状態表示（`#sync-state`）。
- sync.js が独自モーダル（既存 `.modal-overlay`/`.modal` クラス流用）を生成：（config固定済みなので通常は）未ログイン→Googleログイン、ログイン中→「✅ 自動同期オン」表示＋ログアウト＋「🔄 今すぐ同期（予備）」。

### Firebase 側の設定（設定済み・参考）
- プロジェクト `dandori-dddf0`。Authentication で Google 有効。承認済みドメインに `lumina-debug.github.io` 追加済み。
- **Realtime Database**（Firestore ではない）。ルールは本人限定：
  ```json
  { "rules": { "users": { "$uid": { ".read": "$uid === auth.uid", ".write": "$uid === auth.uid" } } } }
  ```
- **マルチユーザー**：1プロジェクトを全員で共有。各自が自分の Google でログイン→ `users/{自分のuid}` に隔離保存（他人のデータはルールで不可視）。他ユーザーは設定入力不要（ログインするだけ）。config を差し替えて自分のFirebaseにしたい場合は `HARDCODED_CONFIG` を書き換える。

### 留意点 / TODO
- 競合は **last-write-wins**（フィールド単位マージはしない）。別々の端末で別々に編集すると後勝ち。空データでの上書きは保護済みだが、非空どうしの競合は未対策 → 強化候補（タスクid単位マージ／競合時の確認UI）。
- Firestore ではなく **Realtime Database** を採用（Firestore は新規作成に課金/請求先が必要で詰まったため。RTDB は無料Sparkのまま・カード登録不要）。
- `apiKey` 等をコードに公開しているが Firebase の正規運用（秘密ではない）。保護は Auth＋RTDBルールで担保。気になれば承認済みドメイン限定等で追加ロック可。

---

## 9. 既知の注意点・未対応

- **データは端末ごと**（origin単位）。`file://` / `localhost` / 公開URL はそれぞれ別の保存先。→ §8の同期（ログイン）で端末横断は解決。未ログイン時は従来どおり origin 単位。
- Gemini 2.5系は「思考」で出力トークンを使い切ることがある→ まとめ入力/分解は `maxTokens=8192` で緩和済み。完全無効化（thinkingBudget:0）はモデル依存で未導入（Pro/新モデルで400の恐れ）。
- 繰り返しは「毎週」のみ（隔週・毎月・平日毎日などは未対応）。
- フッターの「キャンセル」ボタンはユーザーが「不要かも」と言及（×でも閉じられる）。要否は次セッションで確認。
- JSON エクスポート/インポート・Firebase同期は実装済み（§8）。CSV や共同編集は未対応。

---

## 10. これまでの主な変更履歴（ブランチのコミット要旨）

MVP → メモ消失バグ修正＋Enter保存 → AI提案（Claude）→ Gemini対応 → まとめて入力 → JSON解析堅牢化 → タスク分解 → 手動並び替え → 集中モード → 週タスク → Windows自動起動 → PWA化 → SWネットワーク優先 → iOSモーダル改善 → ヘッダー保存ボタン → **JSON書き出し/取り込み＋Firebaseアカウント連携・自動同期** → **至急タスクの先頭固定・まとめて選択・ドラッグ&ドロップ並び替え** → **同期をFirestore→Realtime Databaseへ変更** → **firebaseConfigをコード固定・設定画面廃止** → **同期堅牢化（空データ保護・リダイレクト復帰・閉じる前フラッシュ・今すぐ同期ボタン・自動同期の明示）** → **週間予定表（タスクを空き時間へ自動割り当て→Googleカレンダー登録、gcal.js・§12）** → **予定表を刷新：週/月表示・カレンダー上でドラッグ/タップして空き時間指定→タスク自動配置→紫ブロックをドラッグ移動。Googleは閲覧のみ（readonly）に用途変更・書き込み廃止（§12）**。
（`git log --oneline` で詳細確認。公開は §7 のとおり funny-tesla に反映して行う）

---

## 11. 至急タスク／まとめて選択／ドラッグ並び替え（app.js）

- **至急（pinned）**：`task.pinned` / `task.pinnedAt`。`rankActive()` がどのモードでも pinned を先頭グループへ。追加は「🔥 至急を追加」ボタン（`openTaskModal(null,null,{pinned:true})`）・モーダルの `#f-pinned`・カードの `data-action="pin-toggle"`（`togglePin`）。新規pinnedは `pinToFront()` で手動順の先頭にも入る。
- **まとめて選択**：`selectMode` / `selectedIds`（非永続）。「☑️ 選択」で切替。カードに `.select-check`、上部に `.bulk-bar`（すべて選択/選択解除/削除/終了）。`bulkDeleteSelected()` が一括削除。
- **ドラッグ&ドロップ**：`.drag-handle`（⠿）を Pointer Events で掴む（`onListPointerDown/Move/Up`、`#priority-list` に委譲）。マウス/タッチ両対応（handleに `touch-action:none`）。ドロップで DOM順を `commitDraggedOrder()` が手動順へ反映＋手動モードへ。フィルタで隠れたタスクの相対位置は保持。
- 手動順の初期化は `ensureManualOrderInitialized()` に共通化（`moveTask` と共用）。

---

## 12. 予定表（gcal.js）— 週/月表示・空き時間ドラッグ・タスク自動配置

フッター…ではなく**優先度ビュー上部の「📆 予定表」ボタン**（`#gcal-btn`）→ 専用モーダル（独自 overlay、`.modal-wide`）。gcal.js は **通常script の IIFE**（app.js の `window.Dandori`、sync.js の `window.DandoriCloud` を利用）。

### コンセプト（重要：旧仕様から用途変更）
- **Google カレンダーは「既存予定の閲覧のみ」（readonly スコープ）**。予定を灰色で表示して“空き時間の把握”だけに使う。**タスクを Google へ書き込むことはしない**（カレンダーにはタスク以外も色々入っているため用途を絞った、というユーザー方針）。旧仕様の events.insert 登録・手入力テキスト・1週/2週セレクタは**廃止**。
- ユーザーが**カレンダー上を上下ドラッグ（スマホはスワイプ）して緑の「空き時間」枠を作る**（枠タップで削除）。
- アプリが空き時間へ**未完了タスクを自動配置**（優先度順）。**配置した紫ブロックはドラッグで移動**（15分スナップ、別日にも移動可）。
- **週表示 / 月表示**を切替。前後ナビ（`‹ 今日 ›`）で任意の週・月へ。月表示の日付タップでその週へ。

### データ（すべて端末ローカル・クラウド非同期）
- `dandori.gcalPrefs`：`{ dayStart, dayEnd, defDur, otherAccount }`（表示時間帯・見積なしタスクの既定所要・別アカウント読み込みON/OFF）。
- `dandori.gcalFree`：空き時間枠 `[{start,end}]`（ms、絶対日時）。過去分は起動時に掃除。`mergeFree()` で重なり結合。
- `dandori.gcalPlan`：配置したタスク `[{id,title,note,goalId,deadline,pinned,start,dur}]`（ms）。過去分掃除。
- `dandori.gcalPending`：リダイレクトログイン中の復帰用（viewMode/anchor）。
- 別アカウント用トークンは端末メモリ（`otherToken`）のみ・永続化しない（クライアントID等の設定は不要）。

### スケジューリング（純粋関数・Nodeテスト対象）
- `computeOpenSlots(free, busy, now)`：空き枠から Google 予定（`!allDay && !free(transparent)`）と「今」を差し引いた実スロット配列。
- `placeTasks(sortedTasks, slots, defDur)`：**至急→締切→優先度スコア**（`cmpTasks`、スコアは `window.Dandori.priorityOf`）順に早いスロットへ15分刻みで詰める。`{rows, unplaced}`。所要 = `effort`（無ければ defDur）。
- `autoPlace()` が上記を state と接続して `planRows` を作る。行の警告 `rowWarn()`（過去／締切超過／Google予定と重なり／他タスクと重なり／空き時間の外）。

### 描画・操作
- 週：`renderWeek()`（時刻軸＋7日列。灰=Google予定、緑=空き枠、紫=配置タスク。表示時間帯は `computeDisplayRange()` がデータに合わせ拡張）。ポインタ操作 `onPointerDown/Move/Up`：空欄ドラッグ=空き枠作成（プレビュー表示）、**緑枠ドラッグ=移動／緑枠タップ=削除**（`drag.moved` で判定、移動後は `mergeFree()`）、紫ブロックドラッグ=移動（`colFromX`で列判定・`yToMin`で時刻、15分スナップ・別日可）。列座標は `render.cols` にキャッシュ。`.gcal-col-body` に `touch-action:none`。
- **時刻目盛りのズレ対策**：`.gcal-col-head` を全列 `height:40px` 固定（軸列は空ヘッダー）。ヘッダー高が列ごとに違うと本体開始位置がズレて左の時刻と右のグリッド線が合わなくなるため（終日予定でヘッダーが伸びるのも固定高＋overflow hiddenで吸収）。
- 月：`renderMonth()`（6週×7日。各セルに Google予定件数●・空き時間h・タスクchip。セルクリックで週表示へ）。
- `.icsで保存`（任意）は配置済みタスクの手動エクスポート（別カレンダーへの取込用。Google書き込みではない）。

### 認証（2系統）
- **同期用アカウント**（既定）：`getToken()`→sync.js の `getGoogleToken(scope)`。**scope = `calendar.readonly`**。Firebase Auth の Google プロバイダに addScope→`reauthenticateWithPopup`（未ログインなら `signInWithPopup`）→ accessToken。**sessionStorage `dandori.gtoken` に約55分キャッシュ**。ポップアップ不可（iOS PWA等）は `REDIRECT_REQUIRED`→`savePending()`→`signInWithRedirect`、復帰起動で `resumePending()` が再読込。
- **別のGoogleアカウント**（`prefs.otherAccount`）：`getReadToken()` が sync.js の `DandoriCloud.getOtherAccountToken(SCOPE)` を呼ぶ。sync.js は **二次的な Firebase app インスタンス**（`initializeApp(cfg, "gcalReader")`＋その `getAuth`）で `signInWithPopup`（`prompt:'select_account'`）→ accessToken。**同期用（既定app）のセッションは壊れない**。Firebase自身のOAuthクライアント＋authDomainを使うので **クライアントIDの入力や生成元設定は不要**（承認済みドメインは設定済み）。トークンはメモリ `otherToken` に約55分キャッシュ。ポップアップ不可時は `popupNeeded` エラーで許可を促す。401/403 は `clearReadToken()` が使用中系統のトークンを破棄。
  - ⚠ その別アカウントは **OAuth同意画面（テストモード）のテストユーザー**に入っている必要あり（同期用アカウント側で追加）。Calendar API 有効化も従来どおり必要。

### ⚠ Google 側の初回設定（未実施なら必要・ユーザー作業）
1. **Google Calendar API の有効化**（1回だけ）：https://console.cloud.google.com/apis/library/calendar-json.googleapis.com?project=dandori-dddf0 → 「有効にする」。未有効だと読み込み時に 403（モーダル内ヘルプにも記載）。
2. 同意画面で**「このアプリは確認されていません」**が出たら「詳細」→「移動」。**ブロック**される場合は OAuth 同意画面（テストモード）の**テストユーザー**に自分の Gmail を追加。
- ※ Google 予定を読み込まなくても、空き時間を手で指定すれば自動配置は使える。

### 検証
- ロジック（computeOpenSlots / placeTasks / cmpTasks / ics）は Node + vm スタブで再現テスト済み。UI は Playwright スモーク（空き時間ドラッグ作成・自動配置・タスクドラッグ移動・緑枠タップ削除・週/月切替・localStorage永続化・モバイル幅）で確認済み。**実際の Google API 読み込みは本番ドメインで人間の動作確認が必要**。

# 引き継ぎ資料 — 段取り（Dandori）

新しいセッション／開発者がそのまま続きを作れるようにまとめた資料です。
（このファイル自体もリポジトリに含まれるので、新セッションでクローンすれば読めます）

---

## 0. まず押さえること（TL;DR）

- **何のアプリ**：個人向けのタスク優先度ボード「段取り（Dandori）」。日本語UI。
- **技術**：**バニラ HTML/CSS/JS のみ。ビルド不要・依存ゼロ**。データは `localStorage`。サーバーなし。
- **作業ブランチ**：`claude/funny-tesla-bk7f0g`（リポジトリ `lumina-debug/web-application`）。ここにコミット＆プッシュ。**PRはユーザーが明示的に頼むまで作らない**。
- **次にやること**：**アカウント連携＆自動同期**（Firebase 想定）。詳細は §8。
- **ローカル実行**：`python -m http.server 8000` → `http://localhost:8000`。
  - AIの「直接依頼」は **CORSの都合で `http://localhost`（HTTPS）でのみ動作**。`file://` では不可（コピペ方式は可）。
- **検証のしかた**：`node --check app.js` / `node --check sw.js`、`manifest.json` は `JSON.parse` で妥当性確認。ロジックは Node で小さく再現テスト（これまでもそうしてきた）。

---

## 1. ファイル構成

```
index.html          画面構造（タブ、モーダルの共通シェル、PWAタグ）
styles.css          見た目（CSS変数。末尾にモバイル用 @media (max-width:560px)）
app.js              すべてのロジック（約2000行・単一ファイル。フレームワーク不使用）
manifest.json       PWA マニフェスト
sw.js               Service Worker（ネットワーク優先、キャッシュ名 "dandori-v2"）
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
}
```

- `task.deadline` は `"YYYY-MM-DD"` か `null`。`task.effort` は分（整数）か `null`。
- `task.status` は `"todo" | "doing" | "done"`。
- **APIキーは state とは別保存**：`localStorage["dandori.apiKey"]`（Claude）/ `localStorage["dandori.geminiKey"]`（Gemini）。
  **意図的に state に入れていない**（将来の同期・エクスポートに混ぜないため）。

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
- **資産を変えたら**：基本はネットワーク優先なのでリロードで反映。確実に切り替えたい時は **`CACHE` 名を上げる**（現在 `"dandori-v2"`）。
- iPhoneのホーム画面アプリは、更新反映に**Safariで一度リロード／アプリ再起動**が要ることがある。

---

## 6. モバイル（iOS）対応の要点

- 入力欄はモバイルで **16px**（`@media (max-width:560px)` で `input,select,textarea{font-size:16px !important}`）→ **Safariの自動ズーム防止**。
- `.modal-actions` は **下部に sticky 固定**＋セーフエリア余白。`.modal` は `max-height: 90dvh`。
- ヘッダーに保存ボタン（§3 モーダル）。

---

## 7. 開発・公開のワークフロー

- ローカル確認：`python -m http.server 8000` → `http://localhost:8000`（直接依頼を試すならこれ。`file://`不可）。
- 変更後の検証（最低限）：`node --check app.js`、`node --check sw.js`、`node -e 'JSON.parse(require("fs").readFileSync("manifest.json","utf8"))'`。ロジックはNodeで小テスト。
- コミット：日本語メッセージ。これまでは末尾に `https://claude.ai/code/session_...` を付与（新セッションのものに置き換え）。
- プッシュ：`git push -u origin claude/funny-tesla-bk7f0g`（失敗時のみ指数バックオフで最大4回）。
- スマホ公開：GitHub Pages（Settings→Pages→該当ブランチ＋ /root）または Netlify/Cloudflare Pages。HTTPSで配信→「ホーム画面に追加」。

---

## 8. 次の作業：アカウント連携＆自動同期（未着手）

ユーザー合意済みの方針（最終確認は次セッション冒頭で取る）：

- **方式**：Firebase（**Authでログイン＋Firestoreでリアルタイム同期**）。サーバー自前なし、無料枠、静的PWAのまま動く。
- **ログイン**：Google ログイン（最有力）。
- **同期対象**：`state`（tasks/goals/memos/recurring/settings/manualOrder 等）。**APIキーは同期しない**（端末ローカル維持＝既に別localStorage）。
- **保存単位**：`users/{uid}` に1ドキュメント（全state）。Firestoreセキュリティルールで **本人のみ読み書き**（`request.auth.uid == userId`）。
- **マージ方針**：1人利用が前提なので原則 **last-write-wins ＋ updatedAt**。ログイン時に「リモート取得→新しい方を採用→ローカル反映」、以後はリアルタイム購読＋ローカル変更をデバウンスでpush。
- **オフライン**：Firestoreのオフライン永続でPWAと相性良。

### 進め方の提案（2段階）
1. **JSONエクスポート/インポート**（軽い中間策・すぐ作れる）… 手動で端末間移行。同期前の保険にもなる。
2. **Firebase同期**（本命）… 下記の準備をユーザーに依頼してから実装。

### ユーザーにやってもらう準備（手順は次セッションで提示）
1. Firebaseプロジェクト作成（無料）
2. Authentication で Google を有効化
3. Firestore データベース作成
4. ウェブアプリ登録 → `firebaseConfig`（apiKey等）を取得 → アプリに設定（※このapiKeyはクライアント公開前提でOK／秘密ではない）
5. Firestore セキュリティルールを本人限定に設定

### 実装の留意点
- 静的構成を維持するなら Firebase は **ESM CDN（`https://www.gstatic.com/firebasejs/.../firebase-*.js`）を `import`** で読み込む `<script type="module">` を別途用意するのが楽（既存 app.js はそのまま、同期モジュールを追加する形が無難）。
- SW がCDNをキャッシュしないよう注意（現状 別オリジンは介入しないのでOK）。
- ログインUIの置き場：フッターかヘッダーに「ログイン/同期」ボタン。未ログインでも従来通りローカルで動く設計に。

---

## 9. 既知の注意点・未対応

- **データは端末ごと**（origin単位）。`file://` / `localhost` / 公開URL はそれぞれ別の保存先。→ §8の同期で解決予定。
- Gemini 2.5系は「思考」で出力トークンを使い切ることがある→ まとめ入力/分解は `maxTokens=8192` で緩和済み。完全無効化（thinkingBudget:0）はモデル依存で未導入（Pro/新モデルで400の恐れ）。
- 繰り返しは「毎週」のみ（隔週・毎月・平日毎日などは未対応）。
- フッターの「キャンセル」ボタンはユーザーが「不要かも」と言及（×でも閉じられる）。要否は次セッションで確認。
- データのエクスポート/インポートは未実装。

---

## 10. これまでの主な変更履歴（ブランチのコミット要旨）

MVP → メモ消失バグ修正＋Enter保存 → AI提案（Claude）→ Gemini対応 → まとめて入力 → JSON解析堅牢化 → タスク分解 → 手動並び替え → 集中モード → 週タスク → Windows自動起動 → PWA化 → SWネットワーク優先 → iOSモーダル改善 → ヘッダー保存ボタン。
（`git log --oneline` で詳細確認）

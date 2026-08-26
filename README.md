# 📦 引継ぎ資料箱

研究室の引継ぎを「作る手間」と「見つからない問題」の両方から解決するWebアプリです。

- **上級生は忙しくて資料を書けない** → 箇条書きのメモと写真を放り込むだけで、AIが引継ぎ資料に整えます。APIキーが無くても、そのままAIに貼れる**資料作成プロンプト**を出力できます。
- **資料がBoxの奥底にあって後輩が見つけられない** → すべての資料が1つの「資料箱」に並び、**自動でカテゴリ分類**されて検索できます。写真・スキャン・前任者のスライドなど、AI生成でない資料もそのまま置けます。

## できること

| 要件 | 実装 |
| --- | --- |
| 引継ぎ用メモや写真の入力欄 | 「✍️ 資料をつくる」タブ。メモのテキスト欄＋写真/ファイルのドラッグ＆ドロップ |
| 資料作成プロンプトの出力 or AIのAPI | 「✨ AIで資料を作成」（Claude API）と「📝 資料作成プロンプトを出力」（コピーして手持ちのAIへ）の両対応 |
| 出力：資料 | Markdownの資料を生成・表示・編集・`.md`でダウンロード |
| まとめた資料箱 | 「📚 資料箱」タブ。カード一覧・全文検索・タグ・ピン留め |
| 資料の自動分類 | 8カテゴリへ自動振り分け。AIが使えるときはAIが、使えないときはキーワードで分類（分類根拠と確信度をカードに表示、手動修正も可） |

分類カテゴリ: 装置・機器の使い方 / 実験手順・プロトコル / 安全・注意事項 / データ解析・ソフトウェア / 事務・手続き / 研究室の運営・生活 / トラブル対応 / その他

## 2つの置き方

| | ① サーバー版 | ② Google Drive版（GitHub Pages） |
| --- | --- | --- |
| 画面 | Node（Express）が配信 | GitHub Pages などの静的ホスティング |
| 資料の保存先 | サーバーの `data/` | **Google Drive の共有フォルダ**（Markdown＋写真として残る） |
| 必要なもの | Nodeが動く常設マシン | Googleアカウントのみ（サーバー不要） |
| APIキーの置き場所 | サーバーの環境変数 | Apps Script のスクリプトプロパティ |

**GitHub Pages だけでは動きません**（静的ホスティングにはデータの保存先が無いため）。
Pages で公開する場合は、保存先として **Google Apps Script + Google Drive** を使う②の構成にします。
画面右上の ⚙ でいつでも保存先を切り替えられます。

## ① サーバー版の使い方

```bash
npm install
npm start          # http://localhost:3000
```

AIによる資料生成・分類を使う場合は、起動前にAPIキーを設定します（未設定でもアプリは動きます）。

```bash
export ANTHROPIC_API_KEY=sk-ant-...
npm start
```

設定できる環境変数は `.env.example` を参照してください（モデル、ポート、保存先、添付上限）。

## ② Google Drive で共有する（GitHub Pages 対応）

研究室のDriveフォルダを資料箱の実体にします。サーバーは1台も要りません。
**この作業をするのは最初のひとりだけ**で、他のメンバーは公開されたURLを開くだけです。

### 1. Apps Script を作る

1. [script.google.com](https://script.google.com/home) →「新しいプロジェクト」。
2. `npm run build:gas` を実行し、`gas/shared.gs` と `gas/main.gs` の中身を貼り付ける
   （エディタ左の「＋ → スクリプト」でファイルを2つ作り、それぞれに貼る）。
3. 左の「⚙ プロジェクトの設定」→「スクリプト プロパティ」で必要なものを追加する。

   | プロパティ | 必須 | 内容 |
   | --- | --- | --- |
   | `ROOT_FOLDER_ID` | 任意 | 資料を置くDriveフォルダのID（URLの `folders/` 以降）。未設定ならマイドライブに「引継ぎ資料箱」を自動作成 |
   | `ANTHROPIC_API_KEY` | 任意 | AI生成・AI分類を使う場合のみ。ブラウザには渡りません |
   | `CLAUDE_MODEL` | 任意 | 既定 `claude-opus-5` |
   | `CLAUDE_EFFORT` | 任意 | 既定 `low`。上げると資料は厚くなるが、Apps Scriptの外部通信の時間制限に掛かりやすくなる |
   | `ACCESS_TOKEN` | 任意 | 合言葉。設定すると、画面側でも同じ文字列を入れた人だけが読み書きできる |
   | `PUBLIC_FILES` | 任意 | `true` にすると添付を「リンクを知る全員が閲覧可」にする（サムネイルが確実に出る代わりに公開範囲が広がる） |

4. エディタで関数 `setup` を1回実行し、Driveへのアクセスを承認する（保管フォルダのURLがログに出ます）。
5. 右上の「デプロイ」→「新しいデプロイ」→ 種類「**ウェブアプリ**」
   - 次のユーザーとして実行: **自分**
   - アクセスできるユーザー: **全員**（＝URLを知っている人。合言葉を併用すると安全側に寄せられます）
6. 表示された `https://script.google.com/macros/s/……/exec` をコピーする。

### 2. フォルダを研究室で共有する

`setup` のログに出た保管フォルダを、研究室のメンバー（または共有ドライブ）に共有します。
資料は `資料タイトル__ID/` フォルダの中に `資料.md`・写真・`meta.json` として入るので、
**このアプリを経由しなくてもDriveから直接読めます**（引継ぎ資料が特定のツールに閉じ込められません）。

### 3. GitHub Pages に画面を置く

1. `public/config.js` の `gasUrl` に、手順1でコピーしたURLを書いてコミットする（空のままでも、各自が⚙から設定できます）。
2. リポジトリの Settings → Pages → Source を **GitHub Actions** にする。
3. `main` に push すると `.github/workflows/pages.yml` が `public/` を公開します
   （公開URLは `https://<ユーザー名>.github.io/<リポジトリ名>/` のようにリポジトリ名がぶら下がります）。
4. 公開URLを開き、右上のバッジが「🗂 Google Drive」になっていれば接続完了です。

> URLを直接渡したいときは `https://<ユーザー名>.github.io/<リポジトリ>/?api=<Apps ScriptのURL>` でも設定できます（初回に保存されます）。

### 注意点

- Apps Script の外部通信には時間制限があるため、AI生成が長引くと失敗することがあります。その場合は `CLAUDE_EFFORT` を下げるか、「📝 資料作成プロンプトを出力」で手持ちのAIに投げてください。
- 写真は送信前にブラウザ側で長辺1600pxに縮小されます（Driveに載せる量を抑えるため）。
- サムネイルはDriveの共有設定に従います。閲覧権限が無い人の画面ではサムネイルだけ表示されません（資料本文とリンクは開けます）。

## 画面の使い方（共通）

1. **✍️ 資料をつくる** — メモ＋写真を入力して
   - `✨ AIで資料を作成`: Claudeが写真も読み取り、「事前準備 / 手順 / ハマりどころ / トラブル対応」構成の資料を生成し、そのまま資料箱に保存します。
   - `📝 資料作成プロンプトを出力`: 同じ内容のプロンプトを表示します。コピーして手持ちのAI（Claude / ChatGPTなど）に貼り、返ってきたMarkdownを画面下部に貼り付けると、分類されて資料箱に入ります。**APIキーが無い研究室でもこの経路だけで運用できます。**
2. **📎 そのままアップロード** — 装置の写真、紙マニュアルのスキャン、前任者のスライドなどをそのまま登録。ひとことメモを添えると分類の精度が上がります。
3. **📚 資料箱** — カテゴリのチップ、キーワード検索、タグで目的の資料に到達。詳細画面から編集・分類しなおし・Markdown保存・削除ができます。

## AIが無いときの動作

| 機能 | APIキーあり | APIキーなし |
| --- | --- | --- |
| 資料の自動生成 | ✅ Claudeが生成（写真も参照） | ⛔ 代わりにプロンプトを出力 |
| 自動分類 | ✅ AIがカテゴリ・タグ・要約を付与 | ✅ キーワード辞書で分類（要約は本文の冒頭） |
| 資料箱・検索・編集 | ✅ | ✅ |

AI分類が失敗したときも、自動的にキーワード分類へ切り替わるため保存が止まることはありません。

## 構成

```
server/
  index.js       Express本体（API・ファイル配信・エラーハンドリング）
  config.js      環境変数と保存先
  store.js       JSONファイルへの永続化（一時ファイル経由の安全な書き込み）
  categories.js  カテゴリ定義とキーワード辞書
  classify.js    自動分類（AI → 失敗時はキーワードベース）
  ai.js          Claude API 呼び出し（資料生成 / 分類）
  prompts.js     資料作成プロンプト・分類プロンプト
public/
  index.html / app.js / styles.css / markdown.js   （ビルド不要のフロントエンド）
  api-client.js  保存先（サーバー / Google Drive）の違いを吸収する層
  config.js      GitHub Pages 用の既定の保存先
gas/
  main.gs        Apps Script バックエンド（Drive保存・Claude呼び出し）
  shared.gs      npm run build:gas が server/ から生成する共有ロジック
tools/
  build-gas.mjs  shared.gs の生成スクリプト
data/            db.json と添付ファイルの保存先（.gitignore済み・サーバー版のみ）
```

カテゴリ定義・キーワード分類・プロンプトは `server/` の3ファイルが唯一の原本で、
Apps Script 版は `npm run build:gas` でそこから生成されます（2か所を直す必要はありません）。

### API（サーバー版）

| メソッド | パス | 用途 |
| --- | --- | --- |
| GET | `/api/config` | AIの有効/無効、カテゴリ定義、添付上限 |
| GET | `/api/documents` | 一覧（`q` 検索 / `category` / `tag` / `sort`）＋カテゴリ別件数 |
| GET | `/api/documents/:id` | 資料1件 |
| GET | `/api/documents/:id/markdown` | Markdownとしてダウンロード |
| POST | `/api/prompt` | 資料作成プロンプトの生成（AI不要） |
| POST | `/api/documents` | 資料の作成（`mode=ai` はAI生成、`mode=manual` は本文/ファイル） |
| PATCH | `/api/documents/:id` | タイトル・本文・タグ・カテゴリ・ピン留めの更新 |
| POST | `/api/documents/:id/reclassify` | 分類のやり直し |
| DELETE | `/api/documents/:id` | 削除（添付の実体も削除） |

### API（Google Drive版）

Apps Script のウェブアプリURLに `{"action": "...", "token": "...", ...}` をPOSTします
（`config` / `list` / `get` / `prompt` / `create` / `update` / `reclassify` / `delete` / `rebuildIndex`）。
`index.json` が壊れても `rebuildIndex` でDrive上のフォルダから作り直せます。

## カスタマイズ

- **カテゴリを研究室に合わせる**: `server/categories.js` の配列を編集します。`keywords` はAPIキーが無いときの分類精度に直結するので、装置名や薬品名など研究室の言葉を足してください。
- **資料の構成を変える**: `server/prompts.js` の `DOC_SECTIONS` が資料の章立てです。AI生成とプロンプト出力の両方に反映されます。
- **保存先**: サーバー版の既定はリポジトリ内の `data/`（`DATA_DIR` で変更可）。Drive版は `ROOT_FOLDER_ID` のフォルダです。
- **共有ロジックを変えたら**: `npm run build:gas` を実行し、`gas/shared.gs` を Apps Script に貼り直してください。

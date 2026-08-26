/*
 * 自動生成ファイル — 直接編集しないでください。
 * 元ファイル: server/categories.js, server/classify.js, server/prompts.js
 * 更新方法: npm run build:gas を実行し、このファイルを Apps Script に貼り直す。
 */

// ===== server/categories.js =====
// 資料の分類カテゴリ定義。
// keywords はAPIキーが無い環境で動くルールベース分類器が使う手がかり。
const CATEGORIES = [
  {
    id: 'equipment',
    label: '装置・機器の使い方',
    emoji: '🔬',
    color: '#3b82f6',
    description: '実験装置・測定機器・PC周辺機器の起動手順や操作方法、予約ルールなど',
    keywords: ['装置', '機器', '測定', '顕微鏡', 'SEM', 'TEM', 'XRD', 'NMR', 'GC', 'HPLC', 'レーザー', 'スパッタ', '真空', 'ポンプ', '電源', '起動', '立ち上げ', '立上げ', 'シャットダウン', '予約', 'メンテナンス', '校正', 'キャリブレーション', '恒温槽', 'オーブン', '天秤', 'クリーンルーム'],
  },
  {
    id: 'protocol',
    label: '実験手順・プロトコル',
    emoji: '🧪',
    color: '#10b981',
    description: '試料作製・測定条件・実験レシピなど、再現するための手順書',
    keywords: ['手順', 'プロトコル', '実験', '試料', 'サンプル', '作製', '合成', '培養', '前処理', '条件', 'レシピ', '濃度', '試薬', '溶液', '滴定', '洗浄', '仕込み', '検量線', '再現'],
  },
  {
    id: 'safety',
    label: '安全・注意事項',
    emoji: '⚠️',
    color: '#ef4444',
    description: '薬品管理、危険物、事故対応、法令・講習など安全にかかわること',
    keywords: ['安全', '危険', '事故', '劇物', '毒物', '薬品', '廃液', '廃棄', '保護', 'ゴーグル', '手袋', '白衣', '換気', 'ドラフト', '高圧', 'ガス', 'ボンベ', '感電', '火傷', '火災', '地震', '緊急', '講習', '法令', 'MSDS', 'SDS', '注意'],
  },
  {
    id: 'analysis',
    label: 'データ解析・ソフトウェア',
    emoji: '💻',
    color: '#8b5cf6',
    description: '解析コード、ソフトの使い方、データの保存場所や命名規則',
    keywords: ['解析', 'データ', 'ソフト', 'プログラム', 'コード', 'スクリプト', 'Python', 'MATLAB', 'Origin', 'Excel', 'ImageJ', 'LabVIEW', 'R言語', 'Git', 'サーバ', 'サーバー', '計算', 'シミュレーション', 'フィッティング', 'グラフ', '可視化', 'ライセンス', 'インストール', '命名規則', 'バックアップ'],
  },
  {
    id: 'admin',
    label: '事務・手続き',
    emoji: '📋',
    color: '#f59e0b',
    description: '発注、旅費、学会申込、経費精算、書類の出し方',
    keywords: ['事務', '手続', '申請', '発注', '購入', '見積', '納品', '請求', '経費', '精算', '旅費', '出張', '学会', '投稿', '締切', '書類', '提出', '予算', '科研費', '報告書', '許可', 'ハンコ', '押印'],
  },
  {
    id: 'lablife',
    label: '研究室の運営・生活',
    emoji: '🏠',
    color: '#14b8a6',
    description: 'ゼミ運営、当番、鍵、掃除、備品の場所、連絡手段など日々のルール',
    keywords: ['ゼミ', 'ミーティング', '当番', '掃除', '清掃', '鍵', '入室', 'カード', '備品', '文房具', '発注リスト', '連絡', 'Slack', 'メール', '歓迎会', '新歓', '席', '部屋', '冷蔵庫', 'ゴミ', '共用', 'ルール', '慣習', '年間', 'スケジュール'],
  },
  {
    id: 'troubleshoot',
    label: 'トラブル対応',
    emoji: '🛠️',
    color: '#f43f5e',
    description: '「動かない時」「エラーが出た時」の対処法、過去にハマった事例',
    keywords: ['トラブル', 'エラー', '不具合', '故障', '動かない', '直し', '修理', '再起動', '対処', '原因', 'ハマ', '失敗', 'うまくいかない', '止まる', '落ちる', 'ノイズ', '異音', '漏れ', '業者', '問い合わせ'],
  },
  {
    id: 'other',
    label: 'その他',
    emoji: '📦',
    color: '#64748b',
    description: '上のどれにも当てはまらない資料',
    keywords: [],
  },
];

const CATEGORY_IDS = CATEGORIES.map((c) => c.id);
const DEFAULT_CATEGORY = 'other';

function getCategory(id) {
  return CATEGORIES.find((c) => c.id === id) || CATEGORIES.find((c) => c.id === DEFAULT_CATEGORY);
}

function isValidCategory(id) {
  return CATEGORY_IDS.includes(id);
}

// ===== server/classify.js =====
/*
 * 依存なしの純粋ロジック。ここは Node（server/）と Google Apps Script（gas/）で共有するため、
 * import / 外部呼び出しを持ち込まないこと（npm run build:gas がそのまま連結する）。
 */

function normalize(text) {
  return String(text || '').toLowerCase();
}

/** Markdown記号を落として一覧表示用の短い要約を作る。 */
function excerptOf(body, limit = 120) {
  const plain = String(body || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^[>\-*+]\s+/gm, '')
    .replace(/[*_`>|]/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  return plain.length > limit ? `${plain.slice(0, limit)}…` : plain;
}

/**
 * APIキー無しでも動く、キーワードベースの分類器。
 * タイトル・タグ・ファイル名は本文より重く数える（そこに書かれた語のほうが資料の主題に近いため）。
 */
function classifyByRules({ title, body, extra = '', fileNames = [], tags = [] }) {
  const heavy = normalize([title, tags.join(' '), fileNames.join(' ')].join(' '));
  const light = normalize(`${body}\n${extra}`);
  const scores = [];
  const hitWords = new Map();

  for (const category of CATEGORIES) {
    let score = 0;
    for (const keyword of category.keywords) {
      const needle = normalize(keyword);
      const inHeavy = heavy.includes(needle);
      const bodyHits = light.split(needle).length - 1;
      if (!inHeavy && bodyHits === 0) continue;
      score += (inHeavy ? 3 : 0) + Math.min(bodyHits, 4);
      const current = hitWords.get(keyword) || 0;
      hitWords.set(keyword, current + (inHeavy ? 3 : 0) + Math.min(bodyHits, 4));
    }
    scores.push({ category: category.id, score });
  }

  scores.sort((a, b) => b.score - a.score);
  const best = scores[0];
  const runnerUp = scores[1];

  if (!best || best.score === 0) {
    return { category: DEFAULT_CATEGORY, tags: [], summary: excerptOf(body), confidence: 0.2 };
  }

  // 1位と2位の差が小さいほど確信度を下げる。
  const margin = best.score - (runnerUp?.score || 0);
  const confidence = Math.max(0.25, Math.min(0.85, 0.35 + best.score * 0.05 + margin * 0.04));

  const autoTags = [...hitWords.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([word]) => word);

  return { category: best.category, tags: autoTags, summary: excerptOf(body), confidence };
}

/** 本文の見出し（なければ先頭行）からタイトルを起こす。 */
function deriveTitle(body) {
  const heading = String(body || '').match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  const firstLine = String(body || '')
    .split('\n')
    .find((line) => line.trim());
  return firstLine ? excerptOf(firstLine, 40) : '';
}

// ===== server/prompts.js =====
const DOC_SYSTEM_PROMPT = `あなたは大学・企業の研究室で「引継ぎ資料」をまとめるベテランの技術ライターです。
忙しい上級生が書き殴ったメモや写真から、来年その作業を初めてやる後輩がひとりで再現できる資料を作ります。

守ること:
- 出力は日本語のMarkdownのみ。前置き・後書き・「承知しました」などは書かない。
- メモに書かれていない事実を作らない。情報が足りない箇所は本文中に「【要確認】〇〇（前任者に確認）」と明記する。
- 手順は番号付きで、1ステップ1動作。数値・型番・場所・ファイル名などの具体はメモから漏らさず拾う。
- 写真が添付されている場合は内容を読み取り、該当する手順の中で「（写真1参照：〜が写っている）」のように参照する。
- 「ハマりどころ」「注意」は箇条書きで、なぜ危ないのか／どうなるのかまで書く。
- 見出しは ## から使う。冒頭にタイトルの # を1行だけ置く。`;

const DOC_SECTIONS = `# （資料タイトル）

## この資料について
- 目的 / 想定読者 / 所要時間の目安

## 事前に用意するもの
- 必要な物品・薬品・アカウント・権限・場所

## 手順
1. …

## 注意点・ハマりどころ
- …

## よくあるトラブルと対処
- 症状 → 原因 → 対処

## 関連情報・保管場所
- 元データやマニュアルの場所、関連資料、問い合わせ先

## 引継ぎ元メモ（原文）
> 入力されたメモをそのまま引用して残す`;

/**
 * AIに渡す（＝APIキーが無い場合はユーザーがそのままコピペできる）資料作成プロンプトを組み立てる。
 */
function buildDocumentPrompt({ title, memo, author, tags = [], photoNames = [], category }) {
  const lines = [];
  lines.push('次の引継ぎメモから、後輩がひとりで再現できる引継ぎ資料をMarkdownで作成してください。');
  lines.push('');
  lines.push('## 入力');
  lines.push(`- 資料タイトル（案）: ${title || '（未入力：メモから適切に付けてください）'}`);
  if (author) lines.push(`- 前任者: ${author}`);
  if (category) lines.push(`- 分野の指定: ${category}`);
  if (tags.length) lines.push(`- キーワード: ${tags.join(', ')}`);
  if (photoNames.length) {
    lines.push(`- 添付写真: ${photoNames.map((n, i) => `写真${i + 1}（${n}）`).join(' / ')}`);
  }
  lines.push('');
  lines.push('### 引継ぎメモ（原文）');
  lines.push('```');
  lines.push((memo || '').trim() || '（メモ本文なし）');
  lines.push('```');
  lines.push('');
  lines.push('## 出力フォーマット');
  lines.push('以下の構成のMarkdownだけを出力してください（該当する内容が無い節は省いて構いません）。');
  lines.push('');
  lines.push('```markdown');
  lines.push(DOC_SECTIONS);
  lines.push('```');
  lines.push('');
  lines.push('## ルール');
  lines.push('- メモに無い事実を創作しない。不明点は「【要確認】…」と本文に残す。');
  lines.push('- 手順は番号付き・1ステップ1動作。型番や数値などの具体はすべて拾う。');
  lines.push('- 写真がある場合は該当手順で「（写真1参照）」のように参照する。');
  lines.push('- 出力はMarkdown本文のみ。挨拶や説明文は付けない。');
  return lines.join('\n');
}

const CLASSIFY_SYSTEM_PROMPT = `あなたは研究室の資料アーカイブの司書です。資料を決められたカテゴリに1つだけ振り分け、検索用のタグと1〜2文の要約を付けます。
迷ったら「資料を探す後輩がどのカテゴリを最初に開くか」で選びます。判断材料が乏しい場合は confidence を低く付けてください。`;

function buildClassifyPrompt({ title, body, extra = '', fileNames = [], tags = [] }) {
  const catalog = CATEGORIES.map((c) => `- ${c.id}: ${c.label} — ${c.description}`).join('\n');
  const excerpt = (body || '').slice(0, 6000);
  const note = (extra || '').slice(0, 1000);
  return `次の資料を分類してください。

## カテゴリ一覧
${catalog}

## 資料
- タイトル: ${title || '(なし)'}
${fileNames.length ? `- 添付ファイル: ${fileNames.join(', ')}\n` : ''}${tags.length ? `- 入力済みタグ: ${tags.join(', ')}\n` : ''}
### 本文
"""
${excerpt || '(本文なし)'}
"""
${note ? `\n### 投稿者のメモ\n"""\n${note}\n"""\n` : ''}

## 出力
- category: 上のidから1つ
- tags: 検索に使う日本語キーワード3〜6個（装置名・薬品名・ソフト名など固有名詞を優先）
- summary: 資料箱の一覧に表示する1〜2文の要約
- confidence: 0〜1の確信度`;
}

const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    category: { type: 'string', enum: CATEGORIES.map((c) => c.id) },
    tags: { type: 'array', items: { type: 'string' }, maxItems: 6 },
    summary: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['category', 'tags', 'summary', 'confidence'],
  additionalProperties: false,
};

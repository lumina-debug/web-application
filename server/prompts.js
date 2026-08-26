import { CATEGORIES } from './categories.js';

export const DOC_SYSTEM_PROMPT = `あなたは大学・企業の研究室で「引継ぎ資料」をまとめるベテランの技術ライターです。
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
export function buildDocumentPrompt({ title, memo, author, tags = [], photoNames = [], category }) {
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

export const CLASSIFY_SYSTEM_PROMPT = `あなたは研究室の資料アーカイブの司書です。資料を決められたカテゴリに1つだけ振り分け、検索用のタグと1〜2文の要約を付けます。
迷ったら「資料を探す後輩がどのカテゴリを最初に開くか」で選びます。判断材料が乏しい場合は confidence を低く付けてください。`;

export function buildClassifyPrompt({ title, body, extra = '', fileNames = [], tags = [] }) {
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

export const CLASSIFY_SCHEMA = {
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

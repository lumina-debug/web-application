/*
 * 依存なしの純粋ロジック。ここは Node（server/）と Google Apps Script（gas/）で共有するため、
 * import / 外部呼び出しを持ち込まないこと（npm run build:gas がそのまま連結する）。
 */
import { CATEGORIES, DEFAULT_CATEGORY } from './categories.js';

function normalize(text) {
  return String(text || '').toLowerCase();
}

/** Markdown記号を落として一覧表示用の短い要約を作る。 */
export function excerptOf(body, limit = 120) {
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
export function classifyByRules({ title, body, extra = '', fileNames = [], tags = [] }) {
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
export function deriveTitle(body) {
  const heading = String(body || '').match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  const firstLine = String(body || '')
    .split('\n')
    .find((line) => line.trim());
  return firstLine ? excerptOf(firstLine, 40) : '';
}

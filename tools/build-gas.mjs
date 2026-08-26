/*
 * 共有ロジック（カテゴリ定義・ルールベース分類・プロンプト）を
 * Google Apps Script にそのまま貼れる 1ファイル gas/shared.gs に変換する。
 *   npm run build:gas
 * Apps Script は ES Modules を解釈しないため、import/export だけを取り除いて連結する。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sources = ['server/categories.js', 'server/classify.js', 'server/prompts.js'];
const out = path.join(root, 'gas', 'shared.gs');

const header = `/*
 * 自動生成ファイル — 直接編集しないでください。
 * 元ファイル: ${sources.join(', ')}
 * 更新方法: npm run build:gas を実行し、このファイルを Apps Script に貼り直す。
 */
`;

const chunks = sources.map((rel) => {
  const code = fs.readFileSync(path.join(root, rel), 'utf8');
  const stripped = code
    .replace(/^import[\s\S]*?from\s+'[^']+';\n/gm, '')
    .replace(/^export\s+/gm, '')
    .trim();
  return `// ===== ${rel} =====\n${stripped}\n`;
});

fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, `${header}\n${chunks.join('\n')}`);
console.log(`generated ${path.relative(root, out)} (${chunks.length} files)`);

import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT_DIR = path.resolve(here, '..');
export const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
export const DATA_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT_DIR, 'data');
export const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
export const DB_FILE = path.join(DATA_DIR, 'db.json');

export const PORT = Number(process.env.PORT || 3000);

// 生成・分類に使うモデル。環境変数で上書き可能。
export const MODEL = process.env.CLAUDE_MODEL || 'claude-opus-5';

// 1ファイル25MBまで、1回のアップロードで最大12ファイル。
export const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 25 * 1024 * 1024);
export const MAX_FILES = Number(process.env.MAX_FILES || 12);

// APIキーが無ければ「プロンプト出力モード」だけが有効になる。
export const AI_ENABLED = Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);

export function ensureDirs() {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

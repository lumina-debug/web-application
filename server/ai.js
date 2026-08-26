import fs from 'node:fs';
import Anthropic from '@anthropic-ai/sdk';
import { AI_ENABLED, MODEL } from './config.js';
import {
  DOC_SYSTEM_PROMPT,
  CLASSIFY_SYSTEM_PROMPT,
  CLASSIFY_SCHEMA,
  buildDocumentPrompt,
  buildClassifyPrompt,
} from './prompts.js';

const VISION_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const MAX_IMAGES = 6;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024; // APIの1画像あたりの上限に対する安全側の値

// 安全分類にかかった場合に別モデルへ回すサーバサイドフォールバック。
const FALLBACK_OPTS = {
  betas: ['server-side-fallback-2026-07-01'],
  fallbacks: 'default',
};

let client = null;
function getClient() {
  if (!AI_ENABLED) {
    const err = new Error('ANTHROPIC_API_KEY が設定されていません（プロンプト出力モードのみ利用できます）');
    err.status = 503;
    throw err;
  }
  // 認証情報は環境変数 / ant auth プロファイルから解決される。
  client ??= new Anthropic();
  return client;
}

// フォールバックのbetaを受け付けないエンドポイント/バージョンでは、
// 一度だけ素のリクエストに落として再試行する。
function isUnsupportedParamError(err) {
  const message = String(err?.message || '');
  return err?.status === 400 && /fallback|beta/i.test(message);
}

async function callWithFallback(run) {
  try {
    return await run(FALLBACK_OPTS);
  } catch (err) {
    if (!isUnsupportedParamError(err)) throw err;
    return run({});
  }
}

function textOf(message) {
  return (message.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

function assertNotRefused(message) {
  if (message.stop_reason === 'refusal') {
    const err = new Error('AIが生成を拒否しました。メモの内容を見直してください。');
    err.status = 422;
    throw err;
  }
}

/** 添付画像をVision入力のcontentブロックに変換する。実際に載せた写真の名前も返す。 */
function imageBlocks(files = []) {
  const blocks = [];
  const names = [];
  for (const file of files) {
    if (names.length >= MAX_IMAGES) break;
    if (!VISION_TYPES.has(file.mime)) continue;
    let bytes;
    try {
      bytes = fs.readFileSync(file.path);
    } catch {
      continue; // 実体が読めない添付は黙って飛ばす
    }
    if (bytes.byteLength > MAX_IMAGE_BYTES) continue;
    names.push(file.name);
    blocks.push({ type: 'text', text: `写真${names.length}: ${file.name}` });
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: file.mime, data: bytes.toString('base64') },
    });
  }
  return { blocks, names };
}

/**
 * 引継ぎメモ（＋写真）から資料本文（Markdown）を生成する。
 */
export async function generateDocument({ title, memo, author, tags, category, files = [] }) {
  const anthropic = getClient();
  const { blocks, names: photoNames } = imageBlocks(files);
  const prompt = buildDocumentPrompt({ title, memo, author, tags, photoNames, category });
  const content = [...blocks, { type: 'text', text: prompt }];

  const message = await callWithFallback((extra) =>
    anthropic.beta.messages
      .stream({
        model: MODEL,
        max_tokens: 32000,
        system: DOC_SYSTEM_PROMPT,
        thinking: { type: 'adaptive' },
        messages: [{ role: 'user', content }],
        ...extra,
      })
      .finalMessage(),
  );

  assertNotRefused(message);
  const body = textOf(message);
  if (!body) {
    const err = new Error('AIから資料本文を取得できませんでした。もう一度お試しください。');
    err.status = 502;
    throw err;
  }
  return stripCodeFence(body);
}

// モデルが本文全体を ```markdown で囲んで返した場合に剥がす。
function stripCodeFence(text) {
  const fence = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/;
  const match = text.trim().match(fence);
  return match ? match[1].trim() : text;
}

/**
 * 資料をカテゴリ・タグ・要約に自動分類する。失敗時は例外（呼び出し側でルールベースに退避）。
 */
export async function classifyDocument({ title, body, extra = '', fileNames = [], tags = [], files = [] }) {
  const anthropic = getClient();
  const prompt = buildClassifyPrompt({ title, body, extra, fileNames, tags });
  // 本文が薄い（写真だけの資料など）ときは画像そのものを手がかりにする。
  const useImages = `${body}${extra}`.trim().length < 200;
  const content = [...(useImages ? imageBlocks(files).blocks : []), { type: 'text', text: prompt }];

  const message = await callWithFallback((extra) =>
    anthropic.beta.messages.create({
      model: MODEL,
      max_tokens: 2000,
      system: CLASSIFY_SYSTEM_PROMPT,
      output_config: { format: { type: 'json_schema', schema: CLASSIFY_SCHEMA } },
      messages: [{ role: 'user', content }],
      ...extra,
    }),
  );

  assertNotRefused(message);
  const parsed = JSON.parse(textOf(message));
  return {
    category: parsed.category,
    tags: Array.isArray(parsed.tags) ? parsed.tags.map(String) : [],
    summary: String(parsed.summary || ''),
    confidence: Number(parsed.confidence ?? 0.5),
  };
}

import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import express from 'express';
import multer from 'multer';
import {
  PORT,
  PUBLIC_DIR,
  UPLOAD_DIR,
  MAX_FILE_SIZE,
  MAX_FILES,
  AI_ENABLED,
  MODEL,
  ensureDirs,
} from './config.js';
import { CATEGORIES, isValidCategory, DEFAULT_CATEGORY } from './categories.js';
import { listDocuments, getDocument, insertDocument, updateDocument, deleteDocument, newId } from './store.js';
import { classifyByRules, excerptOf, deriveTitle } from './classify.js';
import { autoClassify } from './auto-classify.js';
import { generateDocument } from './ai.js';
import { buildDocumentPrompt } from './prompts.js';

ensureDirs();

const app = express();
app.use(express.json({ limit: '2mb' }));

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    // 元のファイル名は保持せず、拡張子だけ引き継いだランダム名で保存する。
    const ext = path.extname(file.originalname).slice(0, 12).replace(/[^.\w]/g, '');
    cb(null, `${crypto.randomBytes(12).toString('hex')}${ext}`);
  },
});
const upload = multer({ storage, limits: { fileSize: MAX_FILE_SIZE, files: MAX_FILES } });

// 添付ファイルの配信。パス操作でアップロード領域の外に出られないようにする。
app.get('/files/:name', (req, res) => {
  const target = path.join(UPLOAD_DIR, path.basename(req.params.name));
  if (!target.startsWith(UPLOAD_DIR) || !fs.existsSync(target)) {
    return res.status(404).send('not found');
  }
  res.sendFile(target);
});

app.use(express.static(PUBLIC_DIR));

const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res)).catch(next);

function parseTags(raw) {
  if (Array.isArray(raw)) return raw.map((t) => String(t).trim()).filter(Boolean);
  return String(raw || '')
    .split(/[,、\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function decodeName(originalname) {
  // multerはmultipartのファイル名をlatin1として渡すため、UTF-8に戻す。
  const buf = Buffer.from(originalname, 'latin1');
  return buf.toString('utf8');
}

function toAttachment(file) {
  const name = decodeName(file.originalname);
  return {
    id: newId(),
    name,
    storedName: file.filename,
    url: `/files/${file.filename}`,
    mime: file.mimetype,
    size: file.size,
    isImage: file.mimetype.startsWith('image/'),
  };
}

function attachmentPath(att) {
  return path.join(UPLOAD_DIR, att.storedName);
}

function cleanupFiles(files = []) {
  for (const file of files) fs.rmSync(file.path, { force: true });
}

app.get('/api/config', (_req, res) => {
  res.json({
    aiEnabled: AI_ENABLED,
    model: AI_ENABLED ? MODEL : null,
    categories: CATEGORIES,
    maxFileSize: MAX_FILE_SIZE,
    maxFiles: MAX_FILES,
  });
});

// 資料一覧（検索・絞り込み込み）
app.get('/api/documents', (req, res) => {
  const { q = '', category = '', tag = '', sort = 'new' } = req.query;
  const needle = String(q).trim().toLowerCase();
  let docs = listDocuments();

  if (category && isValidCategory(String(category))) {
    docs = docs.filter((d) => d.category === category);
  }
  if (tag) {
    docs = docs.filter((d) => (d.tags || []).some((t) => t.toLowerCase() === String(tag).toLowerCase()));
  }
  if (needle) {
    docs = docs.filter((d) =>
      [d.title, d.summary, d.body, d.author, (d.tags || []).join(' '), (d.attachments || []).map((a) => a.name).join(' ')]
        .join('\n')
        .toLowerCase()
        .includes(needle),
    );
  }

  const sorters = {
    new: (a, b) => b.createdAt.localeCompare(a.createdAt),
    old: (a, b) => a.createdAt.localeCompare(b.createdAt),
    title: (a, b) => a.title.localeCompare(b.title, 'ja'),
  };
  docs = [...docs].sort(sorters[sort] || sorters.new);
  // ピン留めした資料は常に先頭。
  docs = [...docs.filter((d) => d.pinned), ...docs.filter((d) => !d.pinned)];

  const counts = Object.fromEntries(CATEGORIES.map((c) => [c.id, 0]));
  for (const doc of listDocuments()) counts[doc.category] = (counts[doc.category] || 0) + 1;

  res.json({
    documents: docs.map(({ body, ...rest }) => ({ ...rest, excerpt: rest.summary || excerptOf(body) })),
    counts,
    total: listDocuments().length,
  });
});

app.get('/api/documents/:id', (req, res) => {
  const doc = getDocument(req.params.id);
  if (!doc) return res.status(404).json({ error: '資料が見つかりません' });
  res.json(doc);
});

app.get('/api/documents/:id/markdown', (req, res) => {
  const doc = getDocument(req.params.id);
  if (!doc) return res.status(404).send('not found');
  const fileName = encodeURIComponent(`${doc.title || 'document'}.md`);
  res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${fileName}`);
  res.send(doc.body || '');
});

// 資料作成プロンプトだけを組み立てて返す（AI API を使わないモード）
app.post('/api/prompt', (req, res) => {
  const { title = '', memo = '', author = '', tags = [], photoNames = [] } = req.body || {};
  if (!String(memo).trim() && !String(title).trim()) {
    return res.status(400).json({ error: 'タイトルかメモのどちらかは入力してください' });
  }
  res.json({
    prompt: buildDocumentPrompt({
      title,
      memo,
      author,
      tags: parseTags(tags),
      photoNames: Array.isArray(photoNames) ? photoNames.map(String) : [],
    }),
  });
});

/**
 * 資料の作成。
 *  mode=ai     … メモ＋写真からAIが資料本文を生成する
 *  mode=manual … 本文が既にある（手書き／外部AIの出力を貼り付け／ファイルだけのアップロード）
 * どちらの場合も、カテゴリ未指定なら自動分類にかける。
 */
app.post(
  '/api/documents',
  upload.array('files', MAX_FILES),
  asyncRoute(async (req, res) => {
    const files = req.files || [];
    const mode = req.body.mode === 'ai' ? 'ai' : 'manual';
    const title = String(req.body.title || '').trim();
    const memo = String(req.body.memo || '').trim();
    const author = String(req.body.author || '').trim();
    const inputTags = parseTags(req.body.tags);
    const requestedCategory = String(req.body.category || '').trim();

    if (mode === 'ai' && !memo) {
      cleanupFiles(files);
      return res.status(400).json({ error: '引継ぎメモを入力してください' });
    }
    if (mode === 'manual' && !String(req.body.body || '').trim() && !memo && files.length === 0) {
      cleanupFiles(files);
      return res.status(400).json({ error: '本文かファイルのどちらかは必要です' });
    }

    const attachments = files.map(toAttachment);
    const forAi = attachments.map((att) => ({ name: att.name, mime: att.mime, path: attachmentPath(att) }));

    let body;
    try {
      if (mode === 'ai') {
        body = await generateDocument({ title, memo, author, tags: inputTags, files: forAi });
      } else {
        body = String(req.body.body || '').trim() || memo;
      }
    } catch (err) {
      cleanupFiles(files);
      throw err;
    }

    const fileNames = attachments.map((a) => a.name);
    const classification =
      requestedCategory && isValidCategory(requestedCategory)
        ? {
            category: requestedCategory,
            tags: [],
            summary: excerptOf(body),
            confidence: 1,
            classifiedBy: 'manual',
          }
        : await autoClassify({ title, body, extra: memo, fileNames, tags: inputTags, files: forAi });

    // ファイルを置いただけの資料はファイル名を、本文がある資料は見出しをタイトルに使う。
    const hasWrittenBody = Boolean(String(req.body.body || '').trim()) || mode === 'ai';
    const fallbackTitle = hasWrittenBody ? deriveTitle(body) : fileNames[0] || deriveTitle(body);

    const now = new Date().toISOString();
    const doc = {
      id: newId(),
      title: title || fallbackTitle || '無題の資料',
      body,
      memo,
      summary: classification.summary || excerptOf(body),
      category: classification.category || DEFAULT_CATEGORY,
      confidence: classification.confidence ?? 0.3,
      classifiedBy: classification.classifiedBy,
      tags: [...new Set([...inputTags, ...(classification.tags || [])])].slice(0, 10),
      attachments,
      source: mode === 'ai' ? 'ai' : files.length && !hasWrittenBody ? 'upload' : 'manual',
      author,
      pinned: false,
      createdAt: now,
      updatedAt: now,
    };

    insertDocument(doc);
    res.status(201).json(doc);
  }),
);

app.patch('/api/documents/:id', (req, res) => {
  const doc = getDocument(req.params.id);
  if (!doc) return res.status(404).json({ error: '資料が見つかりません' });

  const patch = {};
  if (typeof req.body.title === 'string') patch.title = req.body.title.trim() || doc.title;
  if (typeof req.body.body === 'string') patch.body = req.body.body;
  if (typeof req.body.summary === 'string') patch.summary = req.body.summary.trim();
  if (typeof req.body.pinned === 'boolean') patch.pinned = req.body.pinned;
  if (req.body.tags !== undefined) patch.tags = parseTags(req.body.tags).slice(0, 10);
  if (typeof req.body.category === 'string' && isValidCategory(req.body.category)) {
    patch.category = req.body.category;
    // 人が直したカテゴリは自動分類で上書きしない。
    patch.classifiedBy = 'manual';
    patch.confidence = 1;
  }
  res.json(updateDocument(doc.id, patch));
});

// 分類のやり直し（本文を直したあとなどに使う）
app.post(
  '/api/documents/:id/reclassify',
  asyncRoute(async (req, res) => {
    const doc = getDocument(req.params.id);
    if (!doc) return res.status(404).json({ error: '資料が見つかりません' });

    const files = (doc.attachments || []).map((att) => ({
      name: att.name,
      mime: att.mime,
      path: attachmentPath(att),
    }));
    const result = await autoClassify({
      title: doc.title,
      body: doc.body,
      extra: doc.memo || '',
      fileNames: files.map((f) => f.name),
      tags: doc.tags || [],
      files,
    });

    res.json(
      updateDocument(doc.id, {
        category: result.category,
        confidence: result.confidence,
        classifiedBy: result.classifiedBy,
        summary: result.summary || doc.summary,
        tags: [...new Set([...(doc.tags || []), ...(result.tags || [])])].slice(0, 10),
      }),
    );
  }),
);

app.delete('/api/documents/:id', (req, res) => {
  const removed = deleteDocument(req.params.id);
  if (!removed) return res.status(404).json({ error: '資料が見つかりません' });
  res.json({ ok: true });
});

// エラーハンドラ（multerの制限超過もここに来る）
app.use((err, _req, res, _next) => {
  if (err?.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: `ファイルが大きすぎます（1件あたり${Math.round(MAX_FILE_SIZE / 1024 / 1024)}MBまで）` });
  }
  if (err?.code === 'LIMIT_FILE_COUNT') {
    return res.status(413).json({ error: `一度に添付できるのは${MAX_FILES}件までです` });
  }
  console.error('[error]', err);
  res.status(err.status || 500).json({ error: err.message || 'サーバーでエラーが発生しました' });
});

app.listen(PORT, () => {
  console.log(`引継ぎ資料箱 → http://localhost:${PORT}`);
  console.log(AI_ENABLED ? `AI: 有効 (${MODEL})` : 'AI: 無効（プロンプト出力モードとルールベース自動分類で動作します）');
});

export { app, classifyByRules };

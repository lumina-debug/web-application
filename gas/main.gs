/*
 * 引継ぎ資料箱 — Google Apps Script バックエンド
 *
 * 役割: サーバーを1台も持たずに「共有できる資料箱」を成立させる。
 *   - 資料の実体（Markdown・写真）は Google Drive のフォルダに保存する
 *   - ANTHROPIC_API_KEY はスクリプトプロパティに置き、ブラウザには渡さない
 *   - GitHub Pages 等に置いたフロントエンドから JSON で呼ばれる
 *
 * 使い方は README.md の「Google Drive で共有する」を参照。
 * shared.gs（npm run build:gas で生成）と一緒に貼り付けること。
 */

const DOC_FILE = '資料.md';
const META_FILE = 'meta.json';
const INDEX_FILE = 'index.json';
const MAX_FILES_GAS = 12;
const MAX_FILE_SIZE_GAS = 12 * 1024 * 1024; // base64で送る都合上、サーバー版より控えめ
const VISION_TYPES_GAS = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];

function props_() {
  return PropertiesService.getScriptProperties();
}

function prop_(key, fallback) {
  const value = props_().getProperty(key);
  return value === null || value === '' ? fallback : value;
}

/* ========== 入口 ========== */

function doGet(e) {
  return handle_((e && e.parameter) || {});
}

function doPost(e) {
  let request = {};
  try {
    request = JSON.parse((e && e.postData && e.postData.contents) || '{}');
  } catch (err) {
    return json_({ error: 'リクエストの形式が不正です' });
  }
  return handle_(request);
}

function handle_(request) {
  try {
    const action = String(request.action || 'config');
    const required = prop_('ACCESS_TOKEN', '');
    if (required && action !== 'config' && String(request.token || '') !== required) {
      return json_({ error: '合言葉（アクセストークン）が違います' });
    }

    switch (action) {
      case 'config':
        return json_(configPayload_());
      case 'list':
        return json_(listDocuments_(request));
      case 'get':
        return json_({ document: mustGetDocument_(request.id) });
      case 'prompt':
        return json_({
          prompt: buildDocumentPrompt({
            title: request.title || '',
            memo: request.memo || '',
            author: request.author || '',
            tags: parseTags_(request.tags),
            photoNames: request.photoNames || [],
          }),
        });
      case 'create':
        return json_({ document: withLock_(() => createDocument_(request)) });
      case 'update':
        return json_({ document: withLock_(() => updateDocument_(request)) });
      case 'reclassify':
        return json_({ document: withLock_(() => reclassifyDocument_(request)) });
      case 'delete':
        return json_(withLock_(() => deleteDocument_(request)));
      case 'rebuildIndex':
        return json_(withLock_(() => ({ total: rebuildIndex_(rootFolder_()).documents.length })));
      default:
        return json_({ error: `未知のアクション: ${action}` });
    }
  } catch (err) {
    return json_({ error: String((err && err.message) || err) });
  }
}

function json_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload)).setMimeType(ContentService.MimeType.JSON);
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  // 同時投稿で index.json が壊れないように直列化する。
  lock.waitLock(25000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function configPayload_() {
  return {
    aiEnabled: Boolean(prop_('ANTHROPIC_API_KEY', '')),
    model: prop_('ANTHROPIC_API_KEY', '') ? prop_('CLAUDE_MODEL', 'claude-opus-5') : null,
    categories: CATEGORIES,
    maxFiles: MAX_FILES_GAS,
    maxFileSize: MAX_FILE_SIZE_GAS,
    requiresToken: Boolean(prop_('ACCESS_TOKEN', '')),
    backend: 'gas',
    folderUrl: rootFolder_().getUrl(),
  };
}

/* ========== Drive 上の保管場所 ========== */

function rootFolder_() {
  const id = prop_('ROOT_FOLDER_ID', '');
  if (id) return DriveApp.getFolderById(id);
  // 未設定なら作って記録する（次回以降はこのフォルダを使う）。
  const folder = DriveApp.createFolder('引継ぎ資料箱');
  props_().setProperty('ROOT_FOLDER_ID', folder.getId());
  return folder;
}

function fileByName_(folder, name) {
  const it = folder.getFilesByName(name);
  return it.hasNext() ? it.next() : null;
}

function writeTextFile_(folder, name, text, mime) {
  const existing = fileByName_(folder, name);
  if (existing) {
    existing.setContent(text);
    return existing;
  }
  return folder.createFile(Utilities.newBlob(text, mime || 'text/plain', name));
}

function readIndex_(root) {
  const file = fileByName_(root, INDEX_FILE);
  if (!file) return rebuildIndex_(root);
  try {
    const parsed = JSON.parse(file.getBlob().getDataAsString('UTF-8'));
    if (!parsed || !Array.isArray(parsed.documents)) return rebuildIndex_(root);
    return parsed;
  } catch (err) {
    // 壊れていたらフォルダを走査して作り直す（資料そのものはDriveに残っている）。
    return rebuildIndex_(root);
  }
}

function writeIndex_(root, index) {
  writeTextFile_(root, INDEX_FILE, JSON.stringify(index, null, 2), 'application/json');
  return index;
}

/** 各資料フォルダの meta.json を読み直して index.json を作り直す。 */
function rebuildIndex_(root) {
  const documents = [];
  const folders = root.getFolders();
  while (folders.hasNext()) {
    const folder = folders.next();
    const metaFile = fileByName_(folder, META_FILE);
    if (!metaFile) continue;
    try {
      documents.push(JSON.parse(metaFile.getBlob().getDataAsString('UTF-8')));
    } catch (err) {
      // 壊れた meta.json は飛ばす
    }
  }
  documents.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  return writeIndex_(root, { documents });
}

function folderName_(title, id) {
  const safe = String(title || '無題の資料')
    .replace(/[\\/:*?"<>|]/g, '_')
    .slice(0, 60)
    .trim();
  return `${safe}__${id}`;
}

/* ========== 資料の読み書き ========== */

function metaOf_(id) {
  const root = rootFolder_();
  const index = readIndex_(root);
  const meta = index.documents.find((d) => d.id === id);
  if (!meta) throw new Error('資料が見つかりません');
  return { root, index, meta };
}

function mustGetDocument_(id) {
  const { meta } = metaOf_(String(id || ''));
  const folder = DriveApp.getFolderById(meta.folderId);
  const docFile = fileByName_(folder, DOC_FILE);
  return Object.assign({}, meta, { body: docFile ? docFile.getBlob().getDataAsString('UTF-8') : '' });
}

function listDocuments_(request) {
  const root = rootFolder_();
  const all = readIndex_(root).documents;
  const needle = String(request.q || '').trim().toLowerCase();
  const category = String(request.category || '');
  const tag = String(request.tag || '').toLowerCase();
  const sort = String(request.sort || 'new');

  let documents = all.slice();
  if (category) documents = documents.filter((d) => d.category === category);
  if (tag) documents = documents.filter((d) => (d.tags || []).some((t) => String(t).toLowerCase() === tag));
  if (needle) {
    documents = documents.filter((d) =>
      [d.title, d.summary, d.memo, d.author, (d.tags || []).join(' '), (d.attachments || []).map((a) => a.name).join(' ')]
        .join('\n')
        .toLowerCase()
        .includes(needle),
    );
  }

  documents.sort((a, b) => {
    if (sort === 'old') return String(a.createdAt).localeCompare(String(b.createdAt));
    if (sort === 'title') return String(a.title).localeCompare(String(b.title), 'ja');
    return String(b.createdAt).localeCompare(String(a.createdAt));
  });
  documents = documents.filter((d) => d.pinned).concat(documents.filter((d) => !d.pinned));

  const counts = {};
  CATEGORIES.forEach((c) => {
    counts[c.id] = 0;
  });
  all.forEach((d) => {
    counts[d.category] = (counts[d.category] || 0) + 1;
  });

  return {
    documents: documents.map((d) => Object.assign({}, d, { excerpt: d.summary || '' })),
    counts,
    total: all.length,
  };
}

function parseTags_(raw) {
  if (Array.isArray(raw)) return raw.map((t) => String(t).trim()).filter(Boolean);
  return String(raw || '')
    .split(/[,、\s]+/)
    .map((t) => t.trim())
    .filter(Boolean);
}

function saveAttachments_(folder, files) {
  const attachments = [];
  (files || []).slice(0, MAX_FILES_GAS).forEach((file) => {
    const bytes = Utilities.base64Decode(String(file.data || ''));
    if (bytes.length > MAX_FILE_SIZE_GAS) throw new Error(`${file.name} が大きすぎます`);
    const mime = String(file.mime || 'application/octet-stream');
    const blob = Utilities.newBlob(bytes, mime, String(file.name || 'file'));
    const created = folder.createFile(blob);
    if (String(prop_('PUBLIC_FILES', 'false')) === 'true') {
      // サムネイルを誰にでも表示したい場合のみ。既定はフォルダの共有設定を継承する。
      created.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
    }
    const id = created.getId();
    const isImage = mime.indexOf('image/') === 0;
    attachments.push({
      id: id,
      name: created.getName(),
      url: `https://drive.google.com/file/d/${id}/view`,
      thumbUrl: isImage ? `https://drive.google.com/thumbnail?id=${id}&sz=w800` : '',
      mime: mime,
      size: bytes.length,
      isImage: isImage,
    });
  });
  return attachments;
}

function createDocument_(request) {
  const root = rootFolder_();
  const mode = request.mode === 'ai' ? 'ai' : 'manual';
  const title = String(request.title || '').trim();
  const memo = String(request.memo || '').trim();
  const author = String(request.author || '').trim();
  const inputTags = parseTags_(request.tags);
  const requested = String(request.category || '').trim();
  const files = request.files || [];
  const writtenBody = String(request.body || '').trim();

  if (mode === 'ai' && !memo) throw new Error('引継ぎメモを入力してください');
  if (mode === 'manual' && !writtenBody && !memo && files.length === 0) {
    throw new Error('本文かファイルのどちらかは必要です');
  }

  const body = mode === 'ai' ? generateDocumentGas_(title, memo, author, inputTags, files) : writtenBody || memo;
  const fileNames = files.map((f) => String(f.name || ''));
  const known = CATEGORIES.some((c) => c.id === requested);
  const classification = known
    ? { category: requested, tags: [], summary: excerptOf(body), confidence: 1, classifiedBy: 'manual' }
    : autoClassifyGas_({ title: title, body: body, extra: memo, fileNames: fileNames, tags: inputTags, files: files });

  const id = Utilities.getUuid().replace(/-/g, '').slice(0, 12);
  const hasWrittenBody = Boolean(writtenBody) || mode === 'ai';
  const fallbackTitle = hasWrittenBody ? deriveTitle(body) : fileNames[0] || deriveTitle(body);
  const finalTitle = title || fallbackTitle || '無題の資料';

  const folder = root.createFolder(folderName_(finalTitle, id));
  const attachments = saveAttachments_(folder, files);
  writeTextFile_(folder, DOC_FILE, body, 'text/markdown');

  const now = new Date().toISOString();
  const tags = [];
  inputTags.concat(classification.tags || []).forEach((t) => {
    if (t && tags.indexOf(t) === -1) tags.push(t);
  });

  const meta = {
    id: id,
    title: finalTitle,
    memo: memo,
    summary: classification.summary || excerptOf(body),
    category: classification.category || 'other',
    confidence: classification.confidence,
    classifiedBy: classification.classifiedBy,
    tags: tags.slice(0, 10),
    attachments: attachments,
    source: mode === 'ai' ? 'ai' : files.length && !hasWrittenBody ? 'upload' : 'manual',
    author: author,
    pinned: false,
    createdAt: now,
    updatedAt: now,
    folderId: folder.getId(),
    folderUrl: folder.getUrl(),
  };
  writeTextFile_(folder, META_FILE, JSON.stringify(meta, null, 2), 'application/json');

  const index = readIndex_(root);
  // index.json が無い状態で作られた場合、再構築で同じ資料が既に入っていることがある。
  index.documents = [meta].concat(index.documents.filter((d) => d.id !== meta.id));
  writeIndex_(root, index);

  return Object.assign({}, meta, { body: body });
}

function persistMeta_(root, index, meta, folder, body) {
  writeTextFile_(folder, META_FILE, JSON.stringify(meta, null, 2), 'application/json');
  if (typeof body === 'string') writeTextFile_(folder, DOC_FILE, body, 'text/markdown');
  const position = index.documents.findIndex((d) => d.id === meta.id);
  if (position === -1) index.documents.unshift(meta);
  else index.documents[position] = meta;
  writeIndex_(root, index);
}

function updateDocument_(request) {
  const { root, index, meta } = metaOf_(String(request.id || ''));
  const folder = DriveApp.getFolderById(meta.folderId);
  const patch = request.patch || {};
  let body;

  if (typeof patch.title === 'string' && patch.title.trim()) {
    meta.title = patch.title.trim();
    folder.setName(folderName_(meta.title, meta.id));
  }
  if (typeof patch.body === 'string') body = patch.body;
  if (typeof patch.summary === 'string') meta.summary = patch.summary.trim();
  if (typeof patch.pinned === 'boolean') meta.pinned = patch.pinned;
  if (patch.tags !== undefined) meta.tags = parseTags_(patch.tags).slice(0, 10);
  if (typeof patch.category === 'string' && CATEGORIES.some((c) => c.id === patch.category)) {
    meta.category = patch.category;
    meta.classifiedBy = 'manual';
    meta.confidence = 1;
  }
  meta.updatedAt = new Date().toISOString();
  persistMeta_(root, index, meta, folder, body);

  const docFile = fileByName_(folder, DOC_FILE);
  return Object.assign({}, meta, { body: typeof body === 'string' ? body : docFile ? docFile.getBlob().getDataAsString('UTF-8') : '' });
}

function reclassifyDocument_(request) {
  const { root, index, meta } = metaOf_(String(request.id || ''));
  const folder = DriveApp.getFolderById(meta.folderId);
  const docFile = fileByName_(folder, DOC_FILE);
  const body = docFile ? docFile.getBlob().getDataAsString('UTF-8') : '';

  const result = autoClassifyGas_({
    title: meta.title,
    body: body,
    extra: meta.memo || '',
    fileNames: (meta.attachments || []).map((a) => a.name),
    tags: meta.tags || [],
    files: [],
  });

  meta.category = result.category;
  meta.confidence = result.confidence;
  meta.classifiedBy = result.classifiedBy;
  meta.summary = result.summary || meta.summary;
  const tags = (meta.tags || []).slice();
  (result.tags || []).forEach((t) => {
    if (t && tags.indexOf(t) === -1) tags.push(t);
  });
  meta.tags = tags.slice(0, 10);
  meta.updatedAt = new Date().toISOString();

  persistMeta_(root, index, meta, folder);
  return Object.assign({}, meta, { body: body });
}

function deleteDocument_(request) {
  const { root, index, meta } = metaOf_(String(request.id || ''));
  DriveApp.getFolderById(meta.folderId).setTrashed(true);
  index.documents = index.documents.filter((d) => d.id !== meta.id);
  writeIndex_(root, index);
  return { ok: true };
}

/* ========== Claude API（キーはスクリプトプロパティに置く） ========== */

function callClaude_(payload) {
  const key = prop_('ANTHROPIC_API_KEY', '');
  if (!key) throw new Error('ANTHROPIC_API_KEY が未設定です（プロンプト出力モードのみ利用できます）');

  const request = function (withFallback) {
    const headers = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
    const body = Object.assign({}, payload);
    if (withFallback) {
      headers['anthropic-beta'] = 'server-side-fallback-2026-07-01';
      body.fallbacks = 'default';
    }
    return UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
      method: 'post',
      contentType: 'application/json',
      headers: headers,
      payload: JSON.stringify(body),
      muteHttpExceptions: true,
    });
  };

  let response = request(true);
  if (response.getResponseCode() === 400 && /fallback|beta/i.test(response.getContentText())) {
    response = request(false); // フォールバック指定を解釈しない場合は素のリクエストで再試行
  }

  const code = response.getResponseCode();
  const parsed = JSON.parse(response.getContentText());
  if (code >= 400) {
    throw new Error(`Claude API エラー (${code}): ${(parsed.error && parsed.error.message) || ''}`);
  }
  if (parsed.stop_reason === 'refusal') {
    throw new Error('AIが生成を拒否しました。メモの内容を見直してください。');
  }
  return (parsed.content || [])
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('\n')
    .trim();
}

/** 添付画像をVision入力に変換する（ブラウザから届いたbase64をそのまま使う）。 */
function imageBlocksGas_(files) {
  const blocks = [];
  const names = [];
  (files || []).forEach((file) => {
    if (names.length >= 6) return;
    const mime = String(file.mime || '');
    if (VISION_TYPES_GAS.indexOf(mime) === -1) return;
    const data = String(file.data || '');
    if (data.length > 5.4 * 1024 * 1024) return; // base64で約4MB超はスキップ
    names.push(String(file.name || ''));
    blocks.push({ type: 'text', text: `写真${names.length}: ${file.name}` });
    blocks.push({ type: 'image', source: { type: 'base64', media_type: mime, data: data } });
  });
  return { blocks: blocks, names: names };
}

function generateDocumentGas_(title, memo, author, tags, files) {
  const images = imageBlocksGas_(files);
  const prompt = buildDocumentPrompt({
    title: title,
    memo: memo,
    author: author,
    tags: tags,
    photoNames: images.names,
  });
  // Apps Script の外部リクエストには時間制限があるため、既定は effort=low。
  const text = callClaude_({
    model: prop_('CLAUDE_MODEL', 'claude-opus-5'),
    max_tokens: 8000,
    system: DOC_SYSTEM_PROMPT,
    thinking: { type: 'adaptive' },
    output_config: { effort: prop_('CLAUDE_EFFORT', 'low') },
    messages: [{ role: 'user', content: images.blocks.concat([{ type: 'text', text: prompt }]) }],
  });
  const fence = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/);
  return fence ? fence[1].trim() : text;
}

function classifyWithClaude_(input) {
  const useImages = String(input.body || '').concat(input.extra || '').trim().length < 200;
  const images = useImages ? imageBlocksGas_(input.files).blocks : [];
  const prompt = buildClassifyPrompt({
    title: input.title,
    body: input.body,
    extra: input.extra,
    fileNames: input.fileNames,
    tags: input.tags,
  });
  const text = callClaude_({
    model: prop_('CLAUDE_MODEL', 'claude-opus-5'),
    max_tokens: 2000,
    system: CLASSIFY_SYSTEM_PROMPT,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: CLASSIFY_SCHEMA } },
    messages: [{ role: 'user', content: images.concat([{ type: 'text', text: prompt }]) }],
  });
  const parsed = JSON.parse(text);
  return {
    category: parsed.category,
    tags: parsed.tags || [],
    summary: String(parsed.summary || ''),
    confidence: Number(parsed.confidence),
  };
}

/** AIが使えればAIで、使えない・失敗したらキーワードで分類する。 */
function autoClassifyGas_(input) {
  if (prop_('ANTHROPIC_API_KEY', '')) {
    try {
      const result = classifyWithClaude_(input);
      if (CATEGORIES.some((c) => c.id === result.category)) {
        return Object.assign(result, { classifiedBy: 'ai' });
      }
    } catch (err) {
      console.warn('AI分類に失敗したためキーワード分類に切り替えます: ' + err);
    }
  }
  return Object.assign(classifyByRules(input), { classifiedBy: 'rule' });
}

/* ========== 動作確認用（Apps Scriptのエディタから実行する） ========== */

function setup() {
  const folder = rootFolder_();
  const index = rebuildIndex_(folder);
  console.log('保管フォルダ: ' + folder.getUrl());
  console.log('登録済みの資料: ' + index.documents.length + '件');
  console.log('AI: ' + (prop_('ANTHROPIC_API_KEY', '') ? '有効 (' + prop_('CLAUDE_MODEL', 'claude-opus-5') + ')' : '未設定'));
}

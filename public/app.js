/* 引継ぎ資料箱 フロントエンド（依存なし） */
const state = {
  config: { aiEnabled: false, categories: [], maxFiles: 12, maxFileSize: 0 },
  filters: { q: '', category: '', tag: '', sort: 'new' },
  counts: {},
  total: 0,
  current: null,
  editing: false,
};

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const esc = (s) => window.markdown.escapeHtml(s ?? '');

const CLASSIFIER_LABEL = { ai: 'AIが分類', rule: 'キーワードで分類', manual: '人が指定' };
const SOURCE_LABEL = { ai: 'AI生成', manual: '手入力', upload: 'アップロード' };

/* ---------- 共通UI ---------- */
let toastTimer = null;
function toast(message, kind = 'info') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast toast-${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.hidden = true;
  }, 4200);
}

function loading(on, text = '処理中…') {
  $('#loading-text').textContent = text;
  $('#loading').hidden = !on;
}

const API = window.hikitsugiApi;

function categoryOf(id) {
  return state.config.categories.find((c) => c.id === id) || { label: '未分類', emoji: '📦', color: '#64748b' };
}

function formatDate(iso) {
  const d = new Date(iso);
  return `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/${String(d.getDate()).padStart(2, '0')}`;
}

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/* ---------- ファイル選択（ドラッグ＆ドロップ + プレビュー） ---------- */
function createFilePicker(dropId, inputId, previewId) {
  const drop = $(`#${dropId}`);
  const input = $(`#${inputId}`);
  const preview = $(`#${previewId}`);
  const picked = [];

  function render() {
    preview.innerHTML = picked
      .map((file, index) => {
        const thumb = file.type.startsWith('image/')
          ? `<img src="${URL.createObjectURL(file)}" alt="" />`
          : `<span class="file-icon">📄</span>`;
        return `<div class="preview">
          ${thumb}
          <div class="preview-meta"><strong>${esc(file.name)}</strong><span>${formatSize(file.size)}</span></div>
          <button type="button" class="preview-remove" data-index="${index}" aria-label="削除">✕</button>
        </div>`;
      })
      .join('');
  }

  function add(files) {
    for (const file of files) {
      if (picked.length >= state.config.maxFiles) {
        toast(`添付は${state.config.maxFiles}件までです`, 'warn');
        break;
      }
      if (state.config.maxFileSize && file.size > state.config.maxFileSize) {
        toast(`${file.name} は大きすぎます（${formatSize(state.config.maxFileSize)}まで）`, 'warn');
        continue;
      }
      picked.push(file);
    }
    render();
  }

  input.addEventListener('change', () => {
    add(input.files);
    input.value = '';
  });
  preview.addEventListener('click', (event) => {
    const btn = event.target.closest('.preview-remove');
    if (!btn) return;
    picked.splice(Number(btn.dataset.index), 1);
    render();
  });
  ['dragenter', 'dragover'].forEach((type) =>
    drop.addEventListener(type, (e) => {
      e.preventDefault();
      drop.classList.add('is-over');
    }),
  );
  ['dragleave', 'drop'].forEach((type) =>
    drop.addEventListener(type, (e) => {
      e.preventDefault();
      drop.classList.remove('is-over');
    }),
  );
  drop.addEventListener('drop', (e) => add(e.dataTransfer.files));

  return {
    files: () => picked,
    names: () => picked.map((f) => f.name),
    clear: () => {
      picked.length = 0;
      render();
    },
  };
}

/* ---------- 資料箱 ---------- */
function renderChips() {
  const chips = [
    `<button class="chip ${state.filters.category === '' ? 'is-active' : ''}" data-category="">すべて <b>${state.total}</b></button>`,
    ...state.config.categories.map((c) => {
      const count = state.counts[c.id] || 0;
      const active = state.filters.category === c.id ? 'is-active' : '';
      return `<button class="chip ${active}" data-category="${c.id}" style="--chip:${c.color}">
        ${c.emoji} ${esc(c.label)} <b>${count}</b>
      </button>`;
    }),
  ];
  $('#chips').innerHTML = chips.join('');
}

function cardHtml(doc) {
  const cat = categoryOf(doc.category);
  const attachments = doc.attachments || [];
  const thumb = attachments.find((a) => a.isImage);
  const confidence = Math.round((doc.confidence ?? 0) * 100);
  return `<article class="card" data-id="${doc.id}" style="--cat:${cat.color}">
    ${thumb ? `<div class="card-thumb"><img src="${thumb.thumbUrl || thumb.url}" alt="" loading="lazy" onerror="this.parentElement.remove()" /></div>` : ''}
    <div class="card-main">
      <div class="card-top">
        <span class="cat-badge" style="--cat:${cat.color}">${cat.emoji} ${esc(cat.label)}</span>
        ${doc.pinned ? '<span class="pin">📌</span>' : ''}
      </div>
      <h3>${esc(doc.title)}</h3>
      <p class="card-excerpt">${esc(doc.excerpt || '')}</p>
      <div class="tag-row">${(doc.tags || []).map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}</div>
      <div class="card-meta">
        <span>${formatDate(doc.createdAt)}</span>
        ${doc.author ? `<span>${esc(doc.author)}</span>` : ''}
        <span>${SOURCE_LABEL[doc.source] || doc.source}</span>
        ${attachments.length ? `<span>📎 ${attachments.length}</span>` : ''}
        <span class="conf" title="分類の確信度">${CLASSIFIER_LABEL[doc.classifiedBy] || ''}${confidence ? ` ${confidence}%` : ''}</span>
      </div>
    </div>
  </article>`;
}

async function loadDocuments() {
  const data = await API.listDocuments(state.filters);
  state.counts = data.counts;
  state.total = data.total;
  renderChips();
  $('#doc-list').innerHTML = data.documents.map(cardHtml).join('');
  const nothing = data.documents.length === 0;
  $('#empty-box').hidden = !nothing;
  $('#empty-box').textContent =
    state.total === 0
      ? 'まだ資料がありません。「✍️ 資料をつくる」からメモを投げ込むか、「📎 そのままアップロード」で手元のファイルを置いてください。'
      : '条件に合う資料が見つかりませんでした。';
}

/* ---------- 詳細 ---------- */
function attachmentHtml(att) {
  if (att.isImage) {
    return `<a class="att att-image" href="${att.url}" target="_blank" rel="noopener">
      <img src="${att.thumbUrl || att.url}" alt="${esc(att.name)}" loading="lazy" onerror="this.remove()" />
      <span>${esc(att.name)}</span>
    </a>`;
  }
  return `<a class="att att-file" href="${att.url}" target="_blank" rel="noopener">
    <span class="file-icon">📄</span>
    <span>${esc(att.name)}<em>${formatSize(att.size)}</em></span>
  </a>`;
}

function renderDetail(doc) {
  state.current = doc;
  const cat = categoryOf(doc.category);
  $('#detail-meta').innerHTML = `
    <span class="cat-badge" style="--cat:${cat.color}">${cat.emoji} ${esc(cat.label)}</span>
    <h2>${esc(doc.title)}</h2>
    <div class="card-meta">
      <span>${formatDate(doc.createdAt)}${doc.updatedAt !== doc.createdAt ? `（更新 ${formatDate(doc.updatedAt)}）` : ''}</span>
      ${doc.author ? `<span>${esc(doc.author)}</span>` : ''}
      <span>${SOURCE_LABEL[doc.source] || doc.source}</span>
      <span>${CLASSIFIER_LABEL[doc.classifiedBy] || ''} ${Math.round((doc.confidence ?? 0) * 100)}%</span>
    </div>
    <div class="tag-row">${(doc.tags || []).map((t) => `<span class="tag">#${esc(t)}</span>`).join('')}</div>`;
  $('#detail-body').innerHTML = window.markdown.render(doc.body || '');
  $('#detail-attachments').innerHTML = (doc.attachments || []).map(attachmentHtml).join('');
  $('#btn-pin').textContent = doc.pinned ? '📌 ピン留めを外す' : '📌 ピン留め';
  $('#btn-edit').textContent = '✏️ 編集';
  state.editing = false;
  $('#detail-edit').hidden = true;
  $('#detail-body').hidden = false;
  $('#detail').hidden = false;
  document.body.classList.add('is-locked');
}

function openEditor() {
  const doc = state.current;
  const options = state.config.categories
    .map((c) => `<option value="${c.id}" ${c.id === doc.category ? 'selected' : ''}>${c.emoji} ${esc(c.label)}</option>`)
    .join('');
  $('#detail-edit').innerHTML = `
    <label class="field"><span>タイトル</span><input id="edit-title" type="text" value="${esc(doc.title)}" /></label>
    <div class="grid-2">
      <label class="field"><span>カテゴリ</span><select id="edit-category">${options}</select></label>
      <label class="field"><span>タグ（カンマ区切り）</span><input id="edit-tags" type="text" value="${esc((doc.tags || []).join(', '))}" /></label>
    </div>
    <label class="field"><span>本文（Markdown）</span><textarea id="edit-body" rows="18">${esc(doc.body || '')}</textarea></label>
    <div class="actions">
      <button type="button" class="btn btn-primary" id="edit-save">💾 保存</button>
      <button type="button" class="btn" id="edit-cancel">キャンセル</button>
    </div>`;
  $('#detail-edit').hidden = false;
  $('#detail-body').hidden = true;
  state.editing = true;
  $('#btn-edit').textContent = '👁 プレビュー';

  $('#edit-cancel').onclick = () => renderDetail(state.current);
  $('#edit-save').onclick = async () => {
    try {
      loading(true, '保存中…');
      const updated = await API.updateDocument(doc.id, {
        title: $('#edit-title').value,
        body: $('#edit-body').value,
        tags: $('#edit-tags').value,
        category: $('#edit-category').value,
      });
      renderDetail(updated);
      await loadDocuments();
      toast('保存しました');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      loading(false);
    }
  };
}

function closeDetail() {
  $('#detail').hidden = true;
  document.body.classList.remove('is-locked');
  state.current = null;
}

/* ---------- 作成フロー ---------- */
function formValues(form) {
  const data = new FormData(form);
  return {
    title: (data.get('title') || '').trim(),
    memo: (data.get('memo') || '').trim(),
    tags: (data.get('tags') || '').trim(),
    category: data.get('category') || '',
  };
}

function buildPayload(form, picker, extra = {}) {
  return Object.assign(formValues(form), { author: $('#author').value.trim(), files: picker.files() }, extra);
}

function switchView(view) {
  $$('.tab').forEach((tab) => tab.classList.toggle('is-active', tab.dataset.view === view));
  $$('.view').forEach((section) => section.classList.toggle('is-active', section.id === `view-${view}`));
}

/* ---------- 保存先の設定 ---------- */
function renderStoreBadge() {
  const badge = $('#store-badge');
  const drive = API.isDrive();
  badge.textContent = drive ? '🗂 Google Drive' : '💾 このサーバー';
  badge.className = `badge ${drive ? 'badge-on' : ''}`;
  badge.title = drive
    ? `保存先: ${API.endpoint()}`
    : 'この画面を配信しているサーバーに保存しています（⚙でGoogle Driveに切り替えられます）';
}

function openSettings(message = '') {
  $('#settings-url').value = API.isDrive() ? API.endpoint() : '';
  $('#settings-token').value = localStorage.getItem('hikitsugi.gasToken') || '';
  $('#settings-status').textContent = message;
  $('#settings').hidden = false;
  document.body.classList.add('is-locked');
}

function closeSettings() {
  $('#settings').hidden = true;
  document.body.classList.remove('is-locked');
}

function wireSettings() {
  $('#btn-settings').addEventListener('click', () => openSettings());
  $('#settings-close').addEventListener('click', closeSettings);
  $('#settings').addEventListener('click', (event) => {
    if (event.target.id === 'settings') closeSettings();
  });
  $('#settings-save').addEventListener('click', async () => {
    const url = $('#settings-url').value.trim();
    const pass = $('#settings-token').value.trim();
    if (!url) return toast('Apps Script のURLを入力してください', 'warn');
    $('#settings-status').textContent = '接続を確認しています…';
    try {
      // 保存する前に必ず疎通を確認する（URLの貼り間違いをそのまま保存しない）。
      const config = await API.test(url, pass);
      API.setEndpoint(url, pass);
      $('#settings-status').textContent = `接続できました（資料の保存先: ${config.folderUrl || 'Google Drive'}）`;
      closeSettings();
      await boot();
      toast('Google Drive に接続しました');
    } catch (err) {
      $('#settings-status').textContent = `接続できませんでした: ${err.message}`;
    }
  });
  $('#settings-clear').addEventListener('click', async () => {
    API.setEndpoint('', '');
    closeSettings();
    await boot();
    toast('このサーバーの保存先に戻しました');
  });
}

/** 保存先から受け取った設定を画面に反映する（保存先を切り替えるたびに呼ぶ）。 */
function applyConfig() {
  renderStoreBadge();
  if (state.config.folderUrl) $('#store-badge').title = `保存先フォルダ: ${state.config.folderUrl}`;

  const options = state.config.categories
    .map((c) => `<option value="${c.id}">${c.emoji} ${c.label}</option>`)
    .join('');
  for (const id of ['#create-category', '#upload-category']) {
    $(id).innerHTML = `<option value="">🤖 自動で分類する</option>${options}`;
  }

  const badge = $('#ai-badge');
  if (state.config.aiEnabled) {
    badge.textContent = '🤖 AI 有効';
    badge.className = 'badge badge-on';
    badge.title = `モデル: ${state.config.model}`;
    $('#btn-ai').disabled = false;
    $('#ai-hint').textContent = '「AIで資料を作成」は写真も読み取って資料をまとめます。分類もAIが行います。';
  } else {
    badge.textContent = '🔌 AI 未接続';
    badge.className = 'badge badge-off';
    badge.title = state.config.backend === 'drive'
      ? 'Apps Script のスクリプトプロパティに ANTHROPIC_API_KEY を設定すると資料の自動生成が使えます'
      : 'ANTHROPIC_API_KEY を設定すると資料の自動生成が使えます';
    $('#btn-ai').disabled = true;
    $('#ai-hint').textContent =
      'APIキーが未設定のため「AIで資料を作成」は使えません。「資料作成プロンプトを出力」を使って、お手持ちのAIに貼り付けてください（自動分類はキーワードで動きます）。';
  }
}

async function init() {
  applyConfig();

  $('#author').value = localStorage.getItem('hikitsugi.author') || '';
  $('#author').addEventListener('change', (e) => localStorage.setItem('hikitsugi.author', e.target.value.trim()));

  const createPicker = createFilePicker('create-drop', 'create-files', 'create-previews');
  const uploadPicker = createFilePicker('upload-drop', 'upload-files', 'upload-previews');

  $$('.tab').forEach((tab) => tab.addEventListener('click', () => switchView(tab.dataset.view)));

  // 検索・絞り込み
  let searchTimer = null;
  $('#search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.filters.q = e.target.value.trim();
      loadDocuments().catch((err) => toast(err.message, 'error'));
    }, 220);
  });
  $('#sort').addEventListener('change', (e) => {
    state.filters.sort = e.target.value;
    loadDocuments().catch((err) => toast(err.message, 'error'));
  });
  $('#chips').addEventListener('click', (event) => {
    const chip = event.target.closest('.chip');
    if (!chip) return;
    state.filters.category = chip.dataset.category;
    state.filters.tag = '';
    loadDocuments().catch((err) => toast(err.message, 'error'));
  });
  $('#doc-list').addEventListener('click', async (event) => {
    // タグをクリックしたら、そのタグでの絞り込みに切り替える。
    const tagEl = event.target.closest('.tag');
    if (tagEl) {
      state.filters.tag = tagEl.textContent.replace(/^#/, '');
      state.filters.category = '';
      $('#search').value = '';
      state.filters.q = '';
      loadDocuments().catch((err) => toast(err.message, 'error'));
      toast(`タグ「${state.filters.tag}」で絞り込みました（「すべて」で解除）`);
      return;
    }
    const card = event.target.closest('.card');
    if (!card) return;
    try {
      renderDetail(await API.getDocument(card.dataset.id));
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  // AIで資料を作成
  $('#btn-ai').addEventListener('click', async () => {
    const form = $('#create-form');
    if (!formValues(form).memo) return toast('引継ぎメモを入力してください', 'warn');
    try {
      loading(true, 'AIが資料を作成しています…（30秒ほどかかることがあります）');
      const doc = await API.createDocument(buildPayload(form, createPicker, { mode: 'ai' }));
      form.reset();
      createPicker.clear();
      $('#prompt-panel').hidden = true;
      await loadDocuments();
      switchView('box');
      renderDetail(doc);
      toast('資料を作成して資料箱に入れました');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      loading(false);
    }
  });

  // 資料作成プロンプトを出力
  $('#btn-prompt').addEventListener('click', async () => {
    const form = $('#create-form');
    const values = formValues(form);
    if (!values.memo && !values.title) return toast('タイトルかメモを入力してください', 'warn');
    try {
      const prompt = await API.buildPrompt({
        title: values.title,
        memo: values.memo,
        tags: values.tags,
        author: $('#author').value.trim(),
        photoNames: createPicker.names(),
      });
      $('#prompt-text').textContent = prompt;
      $('#prompt-panel').hidden = false;
      $('#prompt-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  $('#btn-copy').addEventListener('click', async () => {
    const text = $('#prompt-text').textContent;
    try {
      await navigator.clipboard.writeText(text);
      toast('プロンプトをコピーしました');
    } catch {
      // クリップボードAPIが使えない環境向けの保険
      const area = document.createElement('textarea');
      area.value = text;
      document.body.appendChild(area);
      area.select();
      document.execCommand('copy');
      area.remove();
      toast('プロンプトをコピーしました');
    }
  });

  // AIの出力を貼り付けて保存
  $('#btn-save-pasted').addEventListener('click', async () => {
    const form = $('#create-form');
    const pasted = $('#paste-body').value.trim();
    if (!pasted) return toast('AIが出力したMarkdownを貼り付けてください', 'warn');
    try {
      loading(true, '保存して分類しています…');
      const doc = await API.createDocument(buildPayload(form, createPicker, { mode: 'manual', body: pasted }));
      form.reset();
      createPicker.clear();
      $('#paste-body').value = '';
      $('#prompt-panel').hidden = true;
      await loadDocuments();
      switchView('box');
      renderDetail(doc);
      toast('資料箱に保存しました');
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      loading(false);
    }
  });

  // そのままアップロード
  $('#upload-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    if (uploadPicker.files().length === 0) return toast('ファイルを選択してください', 'warn');
    try {
      loading(true, 'アップロードして分類しています…');
      const doc = await API.createDocument(buildPayload(form, uploadPicker, { mode: 'manual' }));
      form.reset();
      uploadPicker.clear();
      await loadDocuments();
      switchView('box');
      renderDetail(doc);
      toast(`「${categoryOf(doc.category).label}」に分類しました`);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      loading(false);
    }
  });

  // 詳細画面の操作
  $('#detail-close').addEventListener('click', closeDetail);
  $('#detail').addEventListener('click', (event) => {
    if (event.target.id === 'detail') closeDetail();
  });
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape' && !$('#detail').hidden) closeDetail();
  });
  $('#btn-download').addEventListener('click', () => API.downloadMarkdown(state.current));
  $('#btn-edit').addEventListener('click', () => (state.editing ? renderDetail(state.current) : openEditor()));
  $('#btn-pin').addEventListener('click', async () => {
    try {
      const updated = await API.updateDocument(state.current.id, { pinned: !state.current.pinned });
      renderDetail(updated);
      await loadDocuments();
    } catch (err) {
      toast(err.message, 'error');
    }
  });
  $('#btn-reclassify').addEventListener('click', async () => {
    try {
      loading(true, '分類しなおしています…');
      const updated = await API.reclassify(state.current.id);
      renderDetail(updated);
      await loadDocuments();
      toast(`「${categoryOf(updated.category).label}」に分類しました`);
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      loading(false);
    }
  });
  $('#btn-delete').addEventListener('click', async () => {
    if (!confirm(`「${state.current.title}」を削除します。よろしいですか？`)) return;
    try {
      await API.deleteDocument(state.current.id);
      closeDetail();
      await loadDocuments();
      toast('削除しました');
    } catch (err) {
      toast(err.message, 'error');
    }
  });

  await loadDocuments();
}

let booted = false;
async function boot() {
  try {
    state.config = await API.getConfig();
    if (booted) {
      // 保存先を切り替えたときは設定と一覧を読み直す。
      applyConfig();
      state.filters = { q: '', category: '', tag: '', sort: state.filters.sort };
      $('#search').value = '';
      await loadDocuments();
      return;
    }
    await init();
    booted = true;
  } catch (err) {
    renderStoreBadge();
    $('#ai-badge').textContent = '⚠️ 保存先未接続';
    $('#ai-badge').className = 'badge badge-off';
    openSettings(`保存先に接続できませんでした: ${err.message}`);
  }
}

wireSettings();
boot();

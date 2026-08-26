/*
 * 保存先の違いを吸収する層。
 *   - サーバー版  : 同じオリジンの Express (/api/...) に FormData で送る
 *   - Drive版     : Google Apps Script のURLに JSON で送る（GitHub Pages 等から利用）
 * app.js はこのファイルの関数だけを使う。
 */
(function () {
  const LS_URL = 'hikitsugi.gasUrl';
  const LS_TOKEN = 'hikitsugi.gasToken';
  const DEFAULTS = window.HIKITSUGI_CONFIG || {};

  // ?api=<Apps ScriptのURL> で渡された場合は保存して以後そのまま使う。
  const fromQuery = new URLSearchParams(location.search).get('api');
  if (fromQuery) localStorage.setItem(LS_URL, fromQuery.trim());

  const endpoint = () => localStorage.getItem(LS_URL) || DEFAULTS.gasUrl || '';
  const token = () => localStorage.getItem(LS_TOKEN) || DEFAULTS.token || '';
  const isDrive = () => Boolean(endpoint());
  // file:// や GitHub Pages では同一オリジンのAPIが存在しない。
  const hasLocalServer = () => location.protocol === 'http:' || location.protocol === 'https:';

  function setEndpoint(url, pass) {
    if (url) localStorage.setItem(LS_URL, url.trim());
    else localStorage.removeItem(LS_URL);
    if (pass) localStorage.setItem(LS_TOKEN, pass.trim());
    else localStorage.removeItem(LS_TOKEN);
  }

  async function local(path, options = {}) {
    const res = await fetch(path, options);
    const isJson = (res.headers.get('content-type') || '').includes('application/json');
    const payload = isJson ? await res.json() : null;
    if (!res.ok) throw new Error(payload?.error || `通信に失敗しました (${res.status})`);
    return payload;
  }

  async function drive(action, payload = {}, url = null) {
    let res;
    try {
      res = await fetch(url || endpoint(), {
        method: 'POST',
        // Content-Type を付けると事前リクエスト(preflight)が飛び、Apps Script が応答できない。
        body: JSON.stringify(Object.assign({ action, token: token() }, payload)),
        redirect: 'follow',
      });
    } catch (err) {
      throw new Error('Google Apps Script に接続できません。URLと公開設定（アクセスできるユーザー: 全員）を確認してください。');
    }
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch (err) {
      throw new Error('Apps Script から想定外の応答が返りました。ウェブアプリとして再デプロイしてください。');
    }
    if (data.error) throw new Error(data.error);
    return data;
  }

  /* ---- 添付ファイル: Drive版は base64 で送るので、大きな写真は縮小してから積む ---- */
  const MAX_DIM = 1600;
  const RESIZE_OVER = 900 * 1024;

  function readAsBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('ファイルを読み込めませんでした'));
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.readAsDataURL(blob);
    });
  }

  async function shrinkImage(file) {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_DIM / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    bitmap.close?.();
    return blob;
  }

  async function toPayloadFile(file) {
    let blob = file;
    let mime = file.type || 'application/octet-stream';
    let name = file.name;
    if (mime.startsWith('image/') && mime !== 'image/gif' && file.size > RESIZE_OVER) {
      try {
        blob = await shrinkImage(file);
        mime = 'image/jpeg';
        name = name.replace(/\.[^.]+$/, '') + '.jpg';
      } catch (err) {
        blob = file; // 縮小できなければ元のまま送る
      }
    }
    return { name, mime, data: await readAsBase64(blob) };
  }

  async function toPayloadFiles(files = []) {
    const out = [];
    for (const file of files) out.push(await toPayloadFile(file));
    return out;
  }

  function toFormData(input) {
    const form = new FormData();
    for (const key of ['mode', 'title', 'memo', 'tags', 'category', 'author', 'body']) {
      if (input[key] !== undefined) form.set(key, input[key]);
    }
    for (const file of input.files || []) form.append('files', file);
    return form;
  }

  const api = {
    isDrive,
    endpoint,
    setEndpoint,
    hasToken: () => Boolean(token()),

    /** 設定用: 指定URLに直接つないで確認する（保存前のテスト） */
    test: (url, pass) => drive('config', { token: pass || '' }, url),

    async getConfig() {
      if (isDrive()) return Object.assign(await drive('config'), { backend: 'drive' });
      if (!hasLocalServer()) {
        throw new Error('保存先が未設定です。右上の⚙から Google Apps Script のURLを設定してください。');
      }
      return Object.assign(await local('/api/config'), { backend: 'server' });
    },

    async listDocuments(filters) {
      if (isDrive()) return drive('list', filters);
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(filters)) if (value) params.set(key, value);
      return local(`/api/documents?${params}`);
    },

    async getDocument(id) {
      if (isDrive()) return (await drive('get', { id })).document;
      return local(`/api/documents/${id}`);
    },

    async createDocument(input) {
      if (isDrive()) {
        const payload = Object.assign({}, input, { files: await toPayloadFiles(input.files) });
        return (await drive('create', payload)).document;
      }
      return local('/api/documents', { method: 'POST', body: toFormData(input) });
    },

    async updateDocument(id, patch) {
      if (isDrive()) return (await drive('update', { id, patch })).document;
      return local(`/api/documents/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
    },

    async reclassify(id) {
      if (isDrive()) return (await drive('reclassify', { id })).document;
      return local(`/api/documents/${id}/reclassify`, { method: 'POST' });
    },

    async deleteDocument(id) {
      if (isDrive()) return drive('delete', { id });
      return local(`/api/documents/${id}`, { method: 'DELETE' });
    },

    async buildPrompt(input) {
      if (isDrive()) return (await drive('prompt', input)).prompt;
      return (
        await local('/api/prompt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input),
        })
      ).prompt;
    },

    /** 資料をMarkdownファイルとして保存する（どちらの保存先でも同じ動き） */
    downloadMarkdown(doc) {
      const blob = new Blob([doc.body || ''], { type: 'text/markdown;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${(doc.title || 'document').replace(/[\\/:*?"<>|]/g, '_')}.md`;
      document.body.appendChild(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    },
  };

  window.hikitsugiApi = api;
})();

/* 依存なしの小さなMarkdownレンダラ。入力は必ずHTMLエスケープしてから組み立てる。 */
(function () {
  function escapeHtml(text) {
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function inline(text) {
    let html = escapeHtml(text);
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    html = html.replace(/~~([^~]+)~~/g, '<del>$1</del>');
    html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    html = html.replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
    return html;
  }

  function renderTable(rows) {
    const cells = (line) =>
      line
        .trim()
        .replace(/^\||\|$/g, '')
        .split('|')
        .map((c) => c.trim());
    const head = cells(rows[0]);
    const bodyRows = rows.slice(2).map(cells);
    const thead = `<thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead>`;
    const tbody = `<tbody>${bodyRows
      .map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`)
      .join('')}</tbody>`;
    return `<div class="table-wrap"><table>${thead}${tbody}</table></div>`;
  }

  function render(markdown) {
    const lines = String(markdown || '').replace(/\r\n/g, '\n').split('\n');
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      // コードブロック
      const fence = line.match(/^\s*```(\w*)\s*$/);
      if (fence) {
        const buf = [];
        i += 1;
        while (i < lines.length && !/^\s*```\s*$/.test(lines[i])) buf.push(lines[i++]);
        i += 1;
        out.push(`<pre><code>${escapeHtml(buf.join('\n'))}</code></pre>`);
        continue;
      }

      if (!line.trim()) {
        i += 1;
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.*)$/);
      if (heading) {
        const level = heading[1].length;
        out.push(`<h${level}>${inline(heading[2])}</h${level}>`);
        i += 1;
        continue;
      }

      if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
        out.push('<hr />');
        i += 1;
        continue;
      }

      // 表（ヘッダ行 + 区切り行）
      if (/\|/.test(line) && /^\s*\|?[\s:-]*\|[\s:|-]*$/.test(lines[i + 1] || '')) {
        const rows = [];
        while (i < lines.length && lines[i].includes('|')) rows.push(lines[i++]);
        out.push(renderTable(rows));
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        const buf = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote>${render(buf.join('\n'))}</blockquote>`);
        continue;
      }

      if (/^\s*(?:[-*+]|\d+[.)])\s+/.test(line)) {
        const ordered = /^\s*\d+[.)]\s+/.test(line);
        const items = [];
        while (i < lines.length && /^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i])) {
          let item = lines[i].replace(/^\s*(?:[-*+]|\d+[.)])\s+/, '');
          i += 1;
          // 次行以降のインデント継続行を同じ項目にぶら下げる
          while (i < lines.length && /^\s{2,}\S/.test(lines[i]) && !/^\s*(?:[-*+]|\d+[.)])\s+/.test(lines[i])) {
            item += ` ${lines[i].trim()}`;
            i += 1;
          }
          items.push(`<li>${inline(item)}</li>`);
        }
        out.push(ordered ? `<ol>${items.join('')}</ol>` : `<ul>${items.join('')}</ul>`);
        continue;
      }

      const buf = [];
      while (i < lines.length && lines[i].trim() && !/^\s*(?:#{1,6}\s|>|```|[-*+]\s|\d+[.)]\s)/.test(lines[i])) {
        buf.push(lines[i++]);
      }
      out.push(`<p>${inline(buf.join('\n')).replace(/\n/g, '<br />')}</p>`);
    }

    return out.join('\n');
  }

  window.markdown = { render, escapeHtml };
})();

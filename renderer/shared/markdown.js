// markdown.js · the Quick Notes preview renderer (ported from content.js
// renderPreview). Supports headings, lists, checklists, tables, fenced code,
// blockquotes, links, images, **bold**, *italic*, ~~strike~~, <u>underline</u>
// and <span style="color: …"> text colors.
//
// Images: `attachments/…` paths, Obsidian `![[name.png]]` embeds, data: URLs
// and http(s) URLs. Local files are served through the qn-asset: protocol.
(function (root) {
  const { escapeHtml } = root.QN;
  const ZWS_RE = /[\u200B-\u200D\uFEFF\u00AD]/g;

  function imageSrc(url) {
    if (/^(https?:|data:image\/)/i.test(url)) return url;
    const name = String(url).split(/[\\/]/).pop();
    return name ? `qn-asset://file/${encodeURIComponent(name)}` : '';
  }

  function inlineFormat(s) {
    return s
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/~~([^~]+)~~/g, '<del>$1</del>')
      .replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
  }

  function inline(s) {
    const imgs = [];
    let out = s
      .replace(/!\[\[([^\]|]+\.(?:png|jpe?g|gif|webp|svg|bmp))(?:\|[^\]]*)?\]\]/gi, (_, name) => {
        imgs.push({ alt: name, url: name });
        return `\u0000QNIMG${imgs.length - 1}\u0000`;
      })
      .replace(/!\[([^\]]*)\]\(((?:https?:\/\/|data:image\/)[^)\s]+|[^)\s]+\.(?:png|jpe?g|gif|webp|svg|bmp))\)/gi, (_, alt, url) => {
        imgs.push({ alt, url });
        return `\u0000QNIMG${imgs.length - 1}\u0000`;
      });

    // Color spans and <u> are the only inline HTML let through; colors are
    // limited to hex codes or single words so nothing else can be injected.
    const spans = [];
    out = out.replace(/<span\s+style="color:\s*(#[0-9a-fA-F]{3,8}|[a-zA-Z]+)\s*">([\s\S]*?)<\/span>/g, (_, color, content) => {
      spans.push({ color, content });
      return `\u0000QNSPAN${spans.length - 1}\u0000`;
    });
    const unders = [];
    out = out.replace(/<u>([\s\S]*?)<\/u>/g, (_, content) => {
      unders.push(content);
      return `\u0000QNU${unders.length - 1}\u0000`;
    });

    out = inlineFormat(escapeHtml(out))
      .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
      .replace(/(^|\s)(https?:\/\/[^\s<]+)/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');

    out = out.replace(/\u0000QNU(\d+)\u0000/g, (_, n) => `<u>${inlineFormat(escapeHtml(unders[+n]))}</u>`);
    out = out.replace(/\u0000QNSPAN(\d+)\u0000/g, (_, n) => {
      const { color, content } = spans[+n];
      return `<span style="color: ${color}">${inlineFormat(escapeHtml(content))}</span>`;
    });
    out = out.replace(/\u0000QNIMG(\d+)\u0000/g, (_, n) => {
      const { alt, url } = imgs[+n];
      const src = imageSrc(url);
      if (!src) return `<span class="qn-img-missing">[missing image]</span>`;
      return `<img class="qn-img" alt="${escapeHtml(alt || 'image')}" src="${escapeHtml(src)}">`;
    });
    return out;
  }

  function splitCells(line) {
    let s = line.trim();
    if (s.startsWith('|')) s = s.slice(1);
    if (s.endsWith('|')) s = s.slice(0, -1);
    return s.split('|').map((c) => c.trim());
  }

  function isSepRow(line) {
    const s = line.trim();
    if (!s.includes('|') && !/^[\s:|-]+$/.test(s)) return false;
    const cells = splitCells(s);
    return cells.length > 0 && cells.every((c) => /^:?-{3,}:?$/.test(c));
  }

  function tryTable(lines, start) {
    const header = lines[start];
    const sep = lines[start + 1];
    if (!header || !sep || !header.includes('|') || !isSepRow(sep)) return null;
    const headers = splitCells(header);
    const aligns = splitCells(sep).map((c) => {
      const l = c.startsWith(':'), r = c.endsWith(':');
      return l && r ? 'center' : r ? 'right' : l ? 'left' : null;
    });
    const rows = [];
    let i = start + 2;
    while (i < lines.length && lines[i].includes('|') && lines[i].trim() !== '') rows.push(splitCells(lines[i++]));
    const al = (idx) => (aligns[idx] ? ` style="text-align:${aligns[idx]}"` : '');
    let h = '<div class="qn-tbl-wrap"><table class="qn-tbl"><thead><tr>';
    headers.forEach((c, idx) => { h += `<th${al(idx)}>${inline(c)}</th>`; });
    h += '</tr></thead><tbody>';
    rows.forEach((row) => {
      h += '<tr>';
      for (let idx = 0; idx < headers.length; idx++) h += `<td${al(idx)}>${inline(row[idx] || '')}</td>`;
      h += '</tr>';
    });
    h += '</tbody></table></div>';
    return { html: h, consumed: i - start };
  }

  function render(text) {
    const lines = String(text || '').split('\n');
    let html = '', inCode = false, inList = false, inOList = false;
    const closeList = () => {
      if (inList) { html += '</ul>'; inList = false; }
      if (inOList) { html += '</ol>'; inOList = false; }
    };
    for (let idx = 0; idx < lines.length; idx++) {
      const line = lines[idx];
      if (/^```/.test(line)) {
        if (!inCode) { closeList(); html += '<pre><code>'; inCode = true; }
        else { html += '</code></pre>'; inCode = false; }
        continue;
      }
      if (inCode) { html += escapeHtml(line) + '\n'; continue; }
      if (line.includes('|')) {
        const t = tryTable(lines, idx);
        if (t) { closeList(); html += t.html; idx += t.consumed - 1; continue; }
      }
      const chk = line.match(/^(\s*)[-*] \[( |x|X)\] (.*)$/);
      if (chk) {
        closeList();
        const checked = chk[2].toLowerCase() === 'x';
        html += `<label class="chk-line ${checked ? 'done' : ''}" data-line="${idx}"><input type="checkbox" ${checked ? 'checked' : ''} data-line="${idx}"><span class="txt">${inline(chk[3])}</span></label>`;
        continue;
      }
      const h = line.match(/^(#{1,3})\s+(.+)$/);
      if (h) { closeList(); html += `<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`; continue; }
      if (/^(---+|━+)\s*$/.test(line)) { closeList(); html += '<hr>'; continue; }
      if (/^>\s?/.test(line)) { closeList(); html += `<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`; continue; }
      const uli = line.match(/^\s*[-*+]\s+(.+)$/);
      if (uli) {
        if (inOList) { html += '</ol>'; inOList = false; }
        if (!inList) { html += '<ul>'; inList = true; }
        html += `<li>${inline(uli[1])}</li>`;
        continue;
      }
      const oli = line.match(/^\s*\d+\.\s+(.+)$/);
      if (oli) {
        if (inList) { html += '</ul>'; inList = false; }
        if (!inOList) { html += '<ol>'; inOList = true; }
        html += `<li>${inline(oli[1])}</li>`;
        continue;
      }
      if (!line.replace(ZWS_RE, '').trim()) { closeList(); continue; }
      closeList();
      html += `<p>${inline(line)}</p>`;
    }
    closeList();
    if (inCode) html += '</code></pre>';
    return html;
  }

  root.QNMarkdown = { render };
})(window);

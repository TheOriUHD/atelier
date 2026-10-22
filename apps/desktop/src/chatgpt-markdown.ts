/**
 * Turns the rendered answer of a ChatGPT page back into Markdown, inside the page. The page shows Markdown already
 * rendered (tables, lists, code blocks, math, source chips), and `innerText` of that loses its structure and mixes in
 * the page's own controls ("Copy code", the source chips, KaTeX's twin MathML text), so the reply used to arrive as
 * flat text. This reads the DOM instead, so Atelier shows what ChatGPT wrote.
 *
 * It is a string, not a function, because it runs in the page (`executeJavaScript`); a function would carry the
 * bundler's helpers with it. The page code avoids template literals and spells a backtick as \x60 so that this file
 * can hold it in String.raw. `chatgpt-markdown.test.ts` runs the same source against fixtures in a DOM.
 */
export const MARKDOWN_SCRIPT = String.raw`
const toMarkdown = (root) => {
  const TICK = '\x60';
  const BLOCK = new Set(['ADDRESS', 'ARTICLE', 'ASIDE', 'BLOCKQUOTE', 'DD', 'DETAILS', 'DIV', 'DL', 'DT', 'FIELDSET', 'FIGCAPTION', 'FIGURE', 'FOOTER', 'FORM', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'HEADER', 'HGROUP', 'HR', 'LI', 'MAIN', 'NAV', 'OL', 'P', 'PRE', 'SECTION', 'SUMMARY', 'TABLE', 'TBODY', 'TFOOT', 'THEAD', 'TR', 'UL']);
  const SKIPPED = new Set(['BUTTON', 'CANVAS', 'IFRAME', 'NOSCRIPT', 'SCRIPT', 'SELECT', 'STYLE', 'SVG', 'TEMPLATE', 'TEXTAREA']);
  const HAS_BLOCK = 'p, div, pre, ul, ol, table, blockquote, h1, h2, h3, h4, h5, h6, hr, section, article';
  // The page marks its own controls (a code block's header, a table's buttons) as not part of the text.
  const skip = (node) => SKIPPED.has(node.tagName.toUpperCase()) || node.hidden || node.getAttribute('data-markdown-copy') === 'exclude' || node.getAttribute('aria-hidden') === 'true' && !node.matches('.katex-html');

  const trimLines = (text) => text.split('\n').map((line) => line.replace(/[ \t]+$/, '')).join('\n');

  const tex = (math) => (math.querySelector('annotation[encoding="application/x-tex"]') || { textContent: math.textContent }).textContent.trim();
  const url = (href) => {
    if (!/^(https?:|mailto:)/i.test(href)) return null;
    let out = href;
    try {
      const parsed = new URL(href);
      if (parsed.searchParams.get('utm_source') === 'chatgpt.com') { parsed.searchParams.delete('utm_source'); out = parsed.toString(); }
    } catch (error) { /* keep as written */ }
    return out.replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29');
  };
  const wrap = (mark, text) => {
    const core = text.replace(/^\s+|\s+$/g, '');
    if (!core) return text;
    return text.slice(0, text.indexOf(core)) + mark + core + mark + text.slice(text.indexOf(core) + core.length);
  };
  const codeSpan = (text) => {
    const longest = Math.max(0, ...(text.match(/\x60+/g) || []).map((run) => run.length));
    const fence = TICK.repeat(longest + 1);
    return fence + (/^\x60|\x60$/.test(text) ? ' ' + text + ' ' : text) + fence;
  };

  const inline = (node) => {
    if (node.nodeType === 3) return (node.nodeValue || '').replace(/[ \t\r\n\u00a0]+/g, ' ');
    if (node.nodeType !== 1 || skip(node)) return '';
    const tag = node.tagName.toUpperCase();
    // Math: the page keeps the TeX it was given; the rendered twin (KaTeX's MathML and HTML) is only a picture of it.
    const given = node.getAttribute('data-math-source');
    if (given) return node.getAttribute('data-math-display') === 'true' ? '$$' + given + '$$' : '$' + given + '$';
    if (node.matches('.katex')) { const source = tex(node); return source ? '$' + source + '$' : ''; }
    if (node.getAttribute('data-markdown-copy') === 'inline-code') return codeSpan(node.textContent || '');
    const children = () => [...node.childNodes].map(inline).join('');
    switch (tag) {
      case 'BR': return '\u0001';
      case 'STRONG': case 'B': return wrap('**', children());
      case 'EM': case 'I': return wrap('*', children());
      case 'DEL': case 'S': case 'STRIKE': return wrap('~~', children());
      case 'CODE': case 'KBD': case 'SAMP': return codeSpan(node.textContent || '');
      case 'IMG': {
        const src = node.getAttribute('src') || '';
        const alt = (node.getAttribute('alt') || '').replace(/[\[\]]/g, '');
        if (!alt && node.closest('a')) return '';
        return /^https?:/i.test(src) ? '![' + alt + '](' + src.replace(/ /g, '%20') + ')' : alt;
      }
      case 'A': {
        const target = url(node.getAttribute('href') || '');
        const text = children().replace(/^\s+|\s+$/g, '');
        if (!target) return text;
        // The page links an address written as plain text (and an e-mail address) to itself: that is the text as written.
        const bare = (address) => address.replace(/^(?:https?:\/\/|mailto:)/i, '').replace(/\/+$/, '');
        if (bare(text) === bare(node.getAttribute('href') || '')) return text;
        return '[' + (text || target) + '](' + target + ')';
      }
      case 'INPUT': return '';
      default: return children();
    }
  };

  const breaks = (run) => trimLines(run.replace(/^[ \t\u0001]+|[ \t\u0001]+$/g, '').replace(/ *\u0001 */g, '\u0001')).replace(/\u0001/g, '  \n');
  const text = (node) => breaks([...node.childNodes].map(inline).join(''));

  // The language the page names in a code block's header ("Python", "JavaScript"), as a fence's info string.
  const labelOf = (header) => {
    if (!header) return '';
    const names = [...header.querySelectorAll('div, span')].filter((part) => !part.childElementCount).map((part) => (part.textContent || '').trim());
    const name = names.find((text) => text && !/^(copy|enable word wrap|wrap)/i.test(text)) || '';
    return /^(text|plain ?text|plaintext)$/i.test(name) ? '' : name.toLowerCase().replace(/[^\w+#.-]/g, '');
  };
  const codeBlock = (pre) => {
    const source = pre.querySelector('[data-code-block-source]');
    const code = pre.querySelector('code');
    const viewer = pre.querySelector('.cm-content');
    let body;
    if (source) body = (source.querySelector('code') || source).textContent || '';
    else if (viewer) body = [...viewer.querySelectorAll('.cm-line')].map((line) => line.textContent || '').join('\n');
    else if (code) body = code.textContent || '';
    else {
      const copy = pre.cloneNode(true);
      copy.querySelectorAll('button, svg, [class*="select-none"]').forEach((extra) => extra.remove());
      body = copy.textContent || '';
    }
    body = body.replace(/\r\n?/g, '\n').replace(/\n+$/, '');
    const marked = (code && /(?:^|\s)language-([\w+#.-]+)/.exec(code.getAttribute('class') || '')) || /(?:^|\s)language-([\w+#.-]+)/.exec(pre.outerHTML.slice(0, 600));
    const named = marked && marked[1] !== 'plaintext' && marked[1] !== 'text' ? marked[1] : '';
    const language = named || labelOf(pre.querySelector('[data-markdown-copy="exclude"]'));
    const longest = Math.max(2, ...(body.match(/^\s*\x60{3,}/gm) || []).map((run) => run.trim().length));
    const fence = TICK.repeat(longest + 1);
    return fence + language + '\n' + body + '\n' + fence;
  };

  const listItem = (item, marker) => {
    const pad = ' '.repeat(marker.length);
    let lead = marker;
    const box = item.querySelector(':scope > input[type="checkbox"], :scope > p > input[type="checkbox"]');
    if (box) lead += box.checked || box.hasAttribute('checked') ? '[x] ' : '[ ] ';
    const parts = flow(item);
    if (!parts.length) return lead.replace(/\s+$/, '');
    let body = parts[0];
    for (const part of parts.slice(1)) body += (/^(?: *)(?:[-*+]|\d+[.)]) /.test(part) || /^ *\x60{3}/.test(part) ? '\n' : '\n\n') + part;
    return lead + body.split('\n').map((line, index) => (index === 0 || !line ? line : pad + line)).join('\n');
  };
  const list = (list) => {
    const ordered = list.tagName.toUpperCase() === 'OL';
    const start = parseInt(list.getAttribute('start') || '1', 10);
    const items = [...list.children].filter((child) => child.tagName.toUpperCase() === 'LI');
    const loose = items.some((item) => item.querySelector(':scope > p + p, :scope > p + ul, :scope > p + ol') && item.querySelector(':scope > p + p'));
    const rendered = items.map((item, index) => listItem(item, ordered ? (start + index) + '. ' : '- '));
    return rendered.join(loose ? '\n\n' : '\n');
  };

  const table = (element) => {
    const rows = [...element.querySelectorAll('tr')].filter((row) => row.closest('table') === element)
      .map((row) => [...row.children].filter((cell) => /^(TH|TD)$/i.test(cell.tagName)));
    if (!rows.length) return '';
    const width = Math.max(...rows.map((row) => row.length));
    const cell = (node) => (node ? flow(node).join(' ').replace(/\n+/g, ' ').replace(/\|/g, '\\|').trim() : '');
    const line = (row) => '| ' + Array.from({ length: width }, (unused, column) => cell(row[column])).join(' | ') + ' |';
    const align = Array.from({ length: width }, (unused, column) => {
      const node = rows[0][column];
      const side = node && ((node.style && node.style.textAlign) || node.getAttribute('align') || '');
      return side === 'center' ? ':---:' : side === 'right' ? '---:' : side === 'left' ? ':---' : '---';
    });
    return [line(rows[0]), '| ' + align.join(' | ') + ' |', ...rows.slice(1).map(line)].join('\n');
  };

  const block = (node) => {
    const tag = node.tagName.toUpperCase();
    if (node.matches('.katex-display')) { const source = tex(node); return source ? ['$$\n' + source + '\n$$'] : []; }
    if (node.matches('[data-code-block]')) return [codeBlock(node)];
    if (node.getAttribute('data-math-source')) return ['$$\n' + node.getAttribute('data-math-source') + '\n$$'];
    if (/^H[1-6]$/.test(tag)) { const heading = text(node); return heading ? ['#'.repeat(Number(tag[1])) + ' ' + heading.replace(/\n/g, ' ')] : []; }
    switch (tag) {
      case 'P': case 'SUMMARY': case 'DT': case 'FIGCAPTION': { const paragraph = text(node); return paragraph ? [paragraph] : []; }
      case 'PRE': return [codeBlock(node)];
      case 'UL': case 'OL': return [list(node)];
      case 'HR': return ['---'];
      case 'TABLE': { const grid = table(node); return grid ? [grid] : []; }
      case 'BLOCKQUOTE': { const inner = flow(node).join('\n\n'); return inner ? [inner.split('\n').map((line) => (line ? '> ' + line : '>')).join('\n')] : []; }
      case 'DETAILS': {
        const summary = node.querySelector(':scope > summary');
        const rest = flow(node).filter((part, index) => !(summary && index === 0 && part === text(summary)));
        return [...(summary ? ['**' + text(summary) + '**'] : []), ...rest];
      }
      default: return flow(node);
    }
  };

  // Children as a list of blocks: runs of inline content become paragraphs, block elements stand on their own.
  const flow = (parent) => {
    const out = [];
    let run = '';
    const flush = () => {
      const paragraph = breaks(run);
      if (paragraph) out.push(paragraph);
      run = '';
    };
    for (const child of parent.childNodes) {
      if (child.nodeType === 3) { run += inline(child); continue; }
      if (child.nodeType !== 1 || skip(child)) continue;
      if (BLOCK.has(child.tagName.toUpperCase()) || child.matches('.katex-display') || child.querySelector(HAS_BLOCK)) {
        flush();
        out.push(...block(child));
      } else run += inline(child);
    }
    flush();
    return out;
  };

  const own = BLOCK.has(root.tagName.toUpperCase()) && !/^(DIV|SECTION|ARTICLE|MAIN)$/i.test(root.tagName) ? block(root) : flow(root);
  return own.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
};
`;

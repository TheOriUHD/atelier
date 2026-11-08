/**
 * Markdown for the terminal: `marked`'s tokens drawn with ANSI. Headings in the accent, code blocks coloured with a bar
 * down their side, lists and task lists, quotes, tables in box drawing, links clickable where the terminal can.
 */
import { marked, type Token, type Tokens } from 'marked';
import { strip, type Paint } from '../style.ts';
import { link, linksWork } from '../term.ts';
import { highlight } from './highlight.ts';

const width = (s: string) => [...strip(s)].reduce((n, ch) => n + (/[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿가-힣豈-﫿︰-﹏＀-｠￠-￦]|\p{Extended_Pictographic}/u.test(ch) ? 2 : 1), 0);
const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - width(s)));

function inline(tokens: Token[] | undefined, paint: Paint): string {
  if (!tokens) return '';
  return tokens
    .map((t) => {
      switch (t.type) {
        case 'strong':
          return paint.bold(inline((t as Tokens.Strong).tokens, paint));
        case 'em':
          return paint.italic(inline((t as Tokens.Em).tokens, paint));
        case 'del':
          return `\x1b[9m${inline((t as Tokens.Del).tokens, paint)}\x1b[29m`;
        case 'codespan':
          return paint.fg('accentSoft', (t as Tokens.Codespan).text.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'"));
        case 'link': {
          const l = t as Tokens.Link;
          const text = strip(inline(l.tokens, paint));
          const bare = text === l.href || `mailto:${text}` === l.href;
          // Where links aren't clickable, the address follows the text.
          return linksWork() || bare ? link(l.href, paint.fg('info', text)) : `${paint.fg('info', text)} ${paint.fg('muted', `(${l.href})`)}`;
        }
        case 'image':
          return paint.fg('muted', `[image: ${(t as Tokens.Image).text || (t as Tokens.Image).href}]`);
        case 'br':
          return '\n';
        case 'escape':
        case 'text': {
          const x = t as Tokens.Text;
          return x.tokens ? inline(x.tokens, paint) : decode(x.text);
        }
        case 'html':
          return (t as Tokens.HTML).text;
        default:
          return 'text' in t ? decode(String(t.text)) : '';
      }
    })
    .join('');
}

const decode = (s: string) => s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");

function block(t: Token, paint: Paint, columns: number, depth = 0): string[] {
  switch (t.type) {
    case 'heading': {
      const h = t as Tokens.Heading;
      const text = inline(h.tokens, paint);
      return [h.depth <= 2 ? paint.bold(paint.fg('accent', text)) : paint.bold(text), ''];
    }
    case 'paragraph':
      return [...inline((t as Tokens.Paragraph).tokens, paint).split('\n'), ''];
    case 'text': {
      const x = t as Tokens.Text;
      return (x.tokens ? inline(x.tokens, paint) : decode(x.text)).split('\n');
    }
    case 'code': {
      const c = t as Tokens.Code;
      const bar = paint.fg('faint', '│ ');
      const lines = highlight(c.text.replace(/\n$/, ''), c.lang?.split(/\s/)[0] ?? '', paint);
      return [...(c.lang ? [paint.fg('faint', `╭ ${c.lang}`)] : []), ...lines.map((l) => bar + l), ''];
    }
    case 'blockquote': {
      const q = t as Tokens.Blockquote;
      const inner = q.tokens.flatMap((x) => block(x, paint, columns - 2, depth));
      while (inner.at(-1) === '') inner.pop();
      return [...inner.map((l) => paint.fg('faint', '▎ ') + paint.fg('secondary', l)), ''];
    }
    case 'list': {
      const l = t as Tokens.List;
      const out: string[] = [];
      l.items.forEach((item, i) => {
        const marker = item.task ? (item.checked ? paint.fg('good', '☒') : paint.fg('muted', '☐')) : l.ordered ? paint.fg('muted', `${Number(l.start || 1) + i}.`) : paint.fg('accent', depth % 2 ? '◦' : '•');
        const body = item.tokens.flatMap((x) => (x.type === 'list' ? block(x, paint, columns - 2, depth + 1) : x.type === 'checkbox' ? [] : block(x, paint, columns - 2, depth + 1)));
        while (body.at(-1) === '') body.pop();
        const indent = ' '.repeat(width(marker) + 1);
        body.forEach((line, j) => out.push(j === 0 ? `${marker} ${line}` : `${indent}${line}`));
      });
      return [...out, ...(depth === 0 ? [''] : [])];
    }
    case 'table':
      return [...table(t as Tokens.Table, paint, columns), ''];
    case 'hr':
      return [paint.fg('faint', '─'.repeat(Math.min(columns, 60))), ''];
    case 'space':
      return [];
    case 'html':
      return [...(t as Tokens.HTML).text.replace(/\n$/, '').split('\n'), ''];
    default:
      return 'text' in t ? [String(t.text), ''] : [];
  }
}

function table(t: Tokens.Table, paint: Paint, columns: number): string[] {
  const head = t.header.map((c) => paint.bold(inline(c.tokens, paint)));
  const rows = t.rows.map((r) => r.map((c) => inline(c.tokens, paint)));
  const n = head.length;
  const widths = Array.from({ length: n }, (_, i) => Math.max(3, width(head[i] ?? ''), ...rows.map((r) => width(r[i] ?? ''))));
  // Too wide: shrink the widest columns; cells keep their text and wrap in the terminal.
  const room = columns - (3 * n + 1);
  while (widths.reduce((a, b) => a + b, 0) > room && Math.max(...widths) > 8) widths[widths.indexOf(Math.max(...widths))]!--;
  const cut = (s: string, w: number) => (width(s) > w ? `${[...strip(s)].slice(0, Math.max(1, w - 1)).join('')}…` : s);
  const line = (l: string, m: string, r: string) => paint.fg('faint', l + widths.map((w) => '─'.repeat(w + 2)).join(m) + r);
  const row = (cells: string[]) => paint.fg('faint', '│') + cells.map((c, i) => ` ${pad(cut(c, widths[i]!), widths[i]!)} `).join(paint.fg('faint', '│')) + paint.fg('faint', '│');
  return [line('┌', '┬', '┐'), row(head), line('├', '┼', '┤'), ...rows.map(row), line('└', '┴', '┘')];
}

/** Markdown as lines of ANSI text for a terminal `columns` wide. */
export function renderMarkdown(text: string, paint: Paint, columns = 80): string {
  const tokens = marked.lexer(text, { gfm: true });
  const lines = tokens.flatMap((t) => block(t, paint, columns));
  while (lines.at(-1) === '') lines.pop();
  return lines.join('\n');
}

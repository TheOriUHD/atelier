/**
 * Markdown from reports (assistant messages, descriptions) as HTML that is safe to put in the page. Report content is
 * untrusted, so: raw HTML in the markdown is shown as text, links keep only http(s) and mailto addresses and open
 * elsewhere without a referrer, pictures are never loaded (a placeholder names them). marked escapes all other text
 * itself. The page's content security policy (public/_headers) is the second line: no inline scripts or handlers run.
 */
import { Marked, type Tokens } from 'marked';

const ESCAPES: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const escapeHtml = (s: string): string => s.replace(/[&<>"']/g, (c) => ESCAPES[c]!);

/** An address a link may go to, or null. */
export function safeHref(href: string): string | null {
  const trimmed = href.trim();
  if (!/^(?:https?:|mailto:)/i.test(trimmed)) return null;
  try {
    const url = new URL(trimmed);
    return ['http:', 'https:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
}

const marked = new Marked({
  gfm: true,
  breaks: false,
  async: false,
  renderer: {
    html(token: Tokens.HTML | Tokens.Tag) {
      return escapeHtml(token.text);
    },
    link(token: Tokens.Link) {
      const text = this.parser.parseInline(token.tokens);
      const href = safeHref(token.href);
      if (!href) return text;
      const title = token.title ? ` title="${escapeHtml(token.title)}"` : '';
      return `<a href="${escapeHtml(href)}"${title} target="_blank" rel="noopener noreferrer nofollow">${text}</a>`;
    },
    image(token: Tokens.Image) {
      return `<span class="md-image">[picture: ${escapeHtml(token.text || token.href)}]</span>`;
    },
  },
});

export function renderMarkdown(text: string): string {
  return marked.parse(text, { async: false }) as string;
}

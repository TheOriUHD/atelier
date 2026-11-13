/**
 * The Preview tool's addresses (packages/core/src/tools/preview.ts), shared with the app that opens what a call named
 * (packages/ui/src/features/code/shown-pages.ts).
 */

/** What a successful Preview opened: a workspace file by its path from the root (forward slashes), or an address. */
export type PreviewTarget = { kind: 'file'; path: string } | { kind: 'url'; url: string };

const LOCAL = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|0\.0\.0\.0|[\w-]+(\.[\w-]+)*\.(localhost|test))(:\d+)?(\/|$)/i;

/** An address the pane opens as it is: http(s), or a local one without its scheme (`localhost:5173`). Null for a path. */
export function pageAddress(page: string): string | null {
  const text = page.trim();
  if (/^https?:\/\//i.test(text)) return URL.canParse(text) ? new URL(text).toString() : null;
  if (LOCAL.test(text) && URL.canParse(`http://${text}`)) return new URL(`http://${text}`).toString();
  return null;
}

/** The start of a successful Preview's result for a workspace file; the path follows it. */
export const PREVIEW_OPENED = 'Opened ';
export const PREVIEW_IN_PANE = ' in the browser pane beside the conversation';

/** What a successful Preview call opened, from its input and its result's text (null when it opened nothing). */
export function previewTarget(input: unknown, resultText: string): PreviewTarget | null {
  const page = (input as { page?: unknown } | null)?.page;
  const url = typeof page === 'string' ? pageAddress(page) : null;
  if (url) return { kind: 'url', url };
  if (!resultText.startsWith(PREVIEW_OPENED)) return null;
  const end = resultText.indexOf(PREVIEW_IN_PANE);
  return end > PREVIEW_OPENED.length ? { kind: 'file', path: resultText.slice(PREVIEW_OPENED.length, end) } : null;
}

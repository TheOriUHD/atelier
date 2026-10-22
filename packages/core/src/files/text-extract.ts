/** Extracts plain text from uploaded documents for models without native document input. */
const TEXT_MIME = /^(text\/|application\/(json|xml|javascript|typescript|x-yaml|yaml|toml|x-sh|sql|csv)|image\/svg\+xml)/;

export function isTextMime(mime: string): boolean {
  return TEXT_MIME.test(mime);
}

export function canExtractText(mime: string): boolean {
  return isTextMime(mime) || mime === 'application/pdf';
}

export async function extractText(bytes: Uint8Array, mime: string, maxChars = 400_000): Promise<{ text: string; truncated: boolean }> {
  let text: string;
  if (mime === 'application/pdf') text = await pdfText(bytes);
  else if (isTextMime(mime)) text = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
  else throw new Error(`Cannot extract text from ${mime}`);
  return text.length > maxChars ? { text: text.slice(0, maxChars), truncated: true } : { text, truncated: false };
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  // pdf.js runs its worker in this thread when it finds it here; otherwise it looks for a worker file, which
  // bundled builds (server, desktop backend) don't have next to them.
  const scope = globalThis as { pdfjsWorker?: unknown };
  // @ts-expect-error pdfjs-dist ships no types for its worker module.
  scope.pdfjsWorker ??= await import('pdfjs-dist/legacy/build/pdf.worker.mjs');
  const task = pdfjs.getDocument({ data: new Uint8Array(bytes), useSystemFonts: true });
  const doc = await task.promise;
  const pages: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => ('str' in item ? item.str + (item.hasEOL ? '\n' : '') : '')).join(''));
  }
  await task.destroy();
  return pages.map((p, i) => `--- page ${i + 1} ---\n${p.trim()}`).join('\n\n');
}

/** Rough token estimate (chars/4), used for budgets before a provider reports real usage. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

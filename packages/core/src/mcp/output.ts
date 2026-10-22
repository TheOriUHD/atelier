/** An MCP tool's result as a tool result: text as text, images as blobs, resources summarized, long output cut. */
import type { CallToolResult, ContentBlock } from '@modelcontextprotocol/client';
import type { BlobStore } from '../store/blobs.ts';
import type { ToolOutput } from '../tools/types.ts';

/** About 25k tokens, as for Read. */
export const MAX_OUTPUT_CHARS = 100_000;
/** Images every vision model takes; other types become a note. */
const IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/** `redact` masks the server's resolved secrets in case it echoes them. */
export async function toOutput(result: CallToolResult, blobs: Pick<BlobStore, 'put'>, redact: (text: string) => string): Promise<ToolOutput> {
  const content: ToolOutput['content'] = [];
  let total = 0;
  const text = (raw: string) => {
    if (!raw) return;
    const value = redact(raw);
    const room = MAX_OUTPUT_CHARS - total;
    total += value.length;
    if (room > 0) content.push({ type: 'text', text: value.slice(0, room) });
  };
  for (const block of result.content) {
    if (block.type === 'text') text(block.text);
    else if (block.type === 'image' && IMAGE_TYPES.has(block.mimeType)) {
      const { sha256 } = await blobs.put(Buffer.from(block.data, 'base64'), block.mimeType);
      content.push({ type: 'image', mime: block.mimeType, blob: sha256 });
    } else text(summarize(block));
  }
  if (!result.content.length && result.structuredContent !== undefined) text(JSON.stringify(result.structuredContent));
  if (total > MAX_OUTPUT_CHARS) content.push({ type: 'text', text: `\n[Output truncated: showing ${MAX_OUTPUT_CHARS} of ${total} characters.]` });
  if (!content.length) content.push({ type: 'text', text: '(no output)' });
  return { content, ...(result.isError ? { isError: true } : {}) };
}

function summarize(block: ContentBlock): string {
  switch (block.type) {
    case 'image':
      return `[An image (${block.mimeType}) that can't be shown here.]`;
    case 'audio':
      return `[Audio (${block.mimeType}) that can't be played here.]`;
    case 'resource_link':
      return `[Resource ${block.name}: ${block.uri}${block.mimeType ? ` (${block.mimeType})` : ''}${block.description ? ` – ${block.description}` : ''}]`;
    case 'resource': {
      const r = block.resource;
      if ('text' in r) return `[Resource ${r.uri}]\n${r.text}`;
      return `[Resource ${r.uri}${r.mimeType ? ` (${r.mimeType})` : ''}: ${Math.floor((r.blob.length * 3) / 4)} bytes of binary data, not shown]`;
    }
    default:
      return '';
  }
}

/** `SaveImage`: puts an image from the conversation into the folder, as a file edit like Write (ARCHITECTURE §23). */
import { imageId, IMAGE_ID_PREFIX, type Message } from '@atelier/protocol';
import type { Workspace } from '../workspaces/workspace.ts';
import { sniffMime } from '../providers/images.ts';
import { toBase64 } from '../providers/util.ts';
import { textOutput, type Tool, type ToolContext } from './types.ts';

export interface SaveImageDeps {
  history(sessionId: string): Promise<Message[]>;
  read(sha256: string): Promise<Uint8Array>;
  checkpoint?(ctx: ToolContext, path: string): Promise<void>;
}

interface Input {
  image: string;
  file_path: string;
}

const EXTENSIONS: Record<string, string[]> = { 'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/webp': ['webp'], 'image/gif': ['gif'] };

export function createSaveImageTool(workspace: Pick<Workspace, 'runner'>, deps: SaveImageDeps): Tool<Input> {
  return {
    name: 'SaveImage',
    description: 'Saves an image from this conversation (generated or attached, by its `img_…` id) as a file in the folder. Missing parent folders are created. The file type comes from the image, so the extension must match it.',
    compactExample: { image: 'img_ab12cd34', file_path: '<path>' },
    inputSchema: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'The image id, like img_ab12cd34.' },
        file_path: { type: 'string', description: 'Where to save it.' },
      },
      required: ['image', 'file_path'],
      additionalProperties: false,
    },
    readOnly: false,
    async run({ image, file_path }, ctx) {
      if (!image.startsWith(IMAGE_ID_PREFIX)) return textOutput(`"${image}" isn't an image id.`, true);
      const blob = imageBlob(await deps.history(ctx.sessionId), image);
      if (!blob) return textOutput(`There's no image ${image} in this conversation.`, true);
      const bytes = await deps.read(blob);
      const mime = sniffMime(bytes);
      const extension = file_path.split('.').pop()?.toLowerCase() ?? '';
      if (mime && !EXTENSIONS[mime]?.includes(extension)) return textOutput(`This image is a ${mime.split('/')[1]!.toUpperCase()}: save it with a .${EXTENSIONS[mime]![0]} name, or convert it afterwards.`, true);
      await deps.checkpoint?.(ctx, file_path);
      const { created } = await workspace.runner.call('fs.write', { path: file_path, content: toBase64(bytes), encoding: 'base64', mkdirp: true }, { signal: ctx.signal });
      return textOutput(`${created ? 'Saved' : 'Replaced'} ${file_path} (${Math.ceil(bytes.byteLength / 1024)} KB).`);
    },
  };
}

function imageBlob(messages: readonly Message[], id: string): string | undefined {
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type === 'image' && imageId(p.blob) === id) return p.blob;
      if (p.type === 'tool_result') for (const c of p.content) if (c.type === 'image' && imageId(c.blob) === id) return c.blob;
    }
  }
  return undefined;
}

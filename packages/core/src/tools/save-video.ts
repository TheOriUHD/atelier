/** `SaveVideo`: puts a generated video from the conversation into the folder, as a file edit like Write (ARCHITECTURE §23). `SaveImage` stays for pictures. */
import { VIDEO_ID_PREFIX, videoId, type Message } from '@atelier/protocol';
import { sniffVideo, type VideoMime } from '../images/video.ts';
import { toBase64 } from '../providers/util.ts';
import type { Workspace } from '../workspaces/workspace.ts';
import { textOutput, type Tool, type ToolContext } from './types.ts';

export interface SaveVideoDeps {
  history(sessionId: string): Promise<Message[]>;
  read(sha256: string): Promise<Uint8Array>;
  checkpoint?(ctx: ToolContext, path: string): Promise<void>;
}

interface Input {
  video: string;
  file_path: string;
}

const EXTENSIONS: Record<VideoMime, string[]> = { 'video/mp4': ['mp4', 'm4v'], 'video/webm': ['webm'] };

export function createSaveVideoTool(workspace: Pick<Workspace, 'runner'>, deps: SaveVideoDeps): Tool<Input> {
  return {
    name: 'SaveVideo',
    description: 'Saves a video made in this conversation (by its `vid_…` id) as a file in the folder. Missing parent folders are created. The file type comes from the video, so the extension must match it.',
    compactExample: { video: 'vid_ab12cd34', file_path: '<path>' },
    inputSchema: {
      type: 'object',
      properties: {
        video: { type: 'string', description: 'The video id, like vid_ab12cd34.' },
        file_path: { type: 'string', description: 'Where to save it.' },
      },
      required: ['video', 'file_path'],
      additionalProperties: false,
    },
    readOnly: false,
    async run({ video, file_path }, ctx) {
      if (!video.startsWith(VIDEO_ID_PREFIX)) return textOutput(`"${video}" isn't a video id. For a picture, use SaveImage.`, true);
      const blob = videoBlob(await deps.history(ctx.sessionId), video);
      if (!blob) return textOutput(`There's no video ${video} in this conversation.`, true);
      const bytes = await deps.read(blob);
      // The bytes decide, not the id or a name: this isn't a way to write any stored file into the folder.
      const mime = sniffVideo(bytes);
      if (!mime) return textOutput(`${video} isn't a video.`, true);
      const extension = file_path.split('.').pop()?.toLowerCase() ?? '';
      if (!EXTENSIONS[mime].includes(extension)) return textOutput(`This video is ${mime === 'video/webm' ? 'a WebM' : 'an MP4'}: save it with a .${EXTENSIONS[mime][0]} name, or convert it afterwards.`, true);
      await deps.checkpoint?.(ctx, file_path);
      const { created } = await workspace.runner.call('fs.write', { path: file_path, content: toBase64(bytes), encoding: 'base64', mkdirp: true }, { signal: ctx.signal });
      return { ...textOutput(`${created ? 'Saved' : 'Replaced'} ${file_path} (${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB).`), saved: { blob, mime } };
    },
  };
}

/** Only videos this conversation's tools made: a model can't reach another conversation's by guessing a hash. */
function videoBlob(messages: readonly Message[], id: string): string | undefined {
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type !== 'tool_result') continue;
      for (const g of p.generated ?? []) if (g.kind === 'video' && videoId(g.blob) === id) return g.blob;
    }
  }
  return undefined;
}

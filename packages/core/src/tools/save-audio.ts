/** `SaveAudio`: puts a generated sound from the conversation into the folder, as a file edit like Write (ARCHITECTURE §23). */
import { AUDIO_ID_PREFIX, audioId, type Message } from '@atelier/protocol';
import { AUDIO_EXTENSIONS, AUDIO_NAMES, sniffAudio } from '../images/audio.ts';
import { toBase64 } from '../providers/util.ts';
import type { Workspace } from '../workspaces/workspace.ts';
import { textOutput, type Tool, type ToolContext } from './types.ts';

export interface SaveAudioDeps {
  history(sessionId: string): Promise<Message[]>;
  read(sha256: string): Promise<Uint8Array>;
  checkpoint?(ctx: ToolContext, path: string): Promise<void>;
}

interface Input {
  audio: string;
  file_path: string;
}

export function createSaveAudioTool(workspace: Pick<Workspace, 'runner'>, deps: SaveAudioDeps): Tool<Input> {
  return {
    name: 'SaveAudio',
    description: 'Saves a sound made in this conversation (by its `aud_…` id) as a file in the folder. Missing parent folders are created. The file type comes from the sound, so the extension must match it.',
    compactExample: { audio: 'aud_ab12cd34', file_path: '<path>' },
    inputSchema: {
      type: 'object',
      properties: {
        audio: { type: 'string', description: 'The sound id, like aud_ab12cd34.' },
        file_path: { type: 'string', description: 'Where to save it.' },
      },
      required: ['audio', 'file_path'],
      additionalProperties: false,
    },
    readOnly: false,
    async run({ audio, file_path }, ctx) {
      if (!audio.startsWith(AUDIO_ID_PREFIX)) return textOutput(`"${audio}" isn't a sound id. For a picture use SaveImage, for a video SaveVideo.`, true);
      const blob = soundBlob(await deps.history(ctx.sessionId), audio);
      if (!blob) return textOutput(`There's no sound ${audio} in this conversation.`, true);
      const bytes = await deps.read(blob);
      // The bytes decide, not the id or a name: this isn't a way to write any stored file into the folder.
      const mime = sniffAudio(bytes);
      if (!mime) return textOutput(`${audio} isn't a sound.`, true);
      const extension = file_path.split('.').pop()?.toLowerCase() ?? '';
      const allowed = AUDIO_EXTENSIONS[mime];
      if (!allowed.includes(extension)) return textOutput(`This sound is ${AUDIO_NAMES[mime]} file: save it with a .${allowed[0]} name, or convert it afterwards.`, true);
      await deps.checkpoint?.(ctx, file_path);
      const { created } = await workspace.runner.call('fs.write', { path: file_path, content: toBase64(bytes), encoding: 'base64', mkdirp: true }, { signal: ctx.signal });
      const size = bytes.byteLength >= 1024 * 1024 ? `${(bytes.byteLength / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes.byteLength / 1024))} KB`;
      return { ...textOutput(`${created ? 'Saved' : 'Replaced'} ${file_path} (${size}).`), saved: { blob, mime } };
    },
  };
}

/** Only sounds this conversation's tools made: a model can't reach another conversation's by guessing a hash. */
function soundBlob(messages: readonly Message[], id: string): string | undefined {
  for (const m of messages) {
    for (const p of m.parts) {
      if (p.type !== 'tool_result') continue;
      for (const g of p.generated ?? []) if (g.kind === 'audio' && audioId(g.blob) === id) return g.blob;
    }
  }
  return undefined;
}

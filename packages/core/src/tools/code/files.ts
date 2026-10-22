/**
 * Read, Write and Edit. Text is shown `cat -n` style and a directory as its entries; Edit writes with `expectSha256`
 * so a concurrent change is never clobbered. Write and Edit undo the tag escaping of what the model read (escape.ts).
 */
import { RpcError, RunnerErrorCode } from '@atelier/protocol';
import { extractText } from '../../files/text-extract.ts';
import { unescapeTags } from '../../prompts/escape.ts';
import { imageSize } from '../../providers/image-size.ts';
import type { BlobStore } from '../../store/blobs.ts';
import type { Workspace } from '../../workspaces/workspace.ts';
import { textOutput, type Tool, type ToolContext } from '../types.ts';

/** Called before a file changes, so the turn can be rewound (ARCHITECTURE §8). */
export type Checkpoint = (ctx: ToolContext, path: string) => Promise<void>;

const DEFAULT_LINES = 2000;
/** Entries Read lists for a directory. */
const MAX_ENTRIES = 500;
const MAX_LINE_CHARS = 2000;
/** About 25k tokens: Read returns no more than this, whatever `limit` says. */
const MAX_READ_CHARS = 100_000;
/** Lines of context Edit shows around a change. */
const SNIPPET_CONTEXT = 3;
/** The longest side from which a model still reads detail: a larger image is shown to it reduced. */
const READABLE_SIDE = 2000;

/** What Read says about an image: its size, and for a large one that the model sees it reduced, so a crop shows detail. */
function imageNote(file: string, mime: string, bytes: Uint8Array): string {
  const size = imageSize(bytes);
  const base = `Image ${file} (${mime}${size ? `, ${size.width}×${size.height} pixels` : ''}, ${bytes.length} bytes)`;
  return size && Math.max(size.width, size.height) > READABLE_SIDE
    ? `${base}. It is larger than a model reads in detail, so it is shown reduced; crop it or take a viewport-sized screenshot to see detail.`
    : base;
}

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

interface ReadInput {
  file_path: string;
  offset?: number;
  limit?: number;
}

interface WriteInput {
  file_path: string;
  content: string;
}

interface EditInput {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

const FILE_PATH = { type: 'string', description: 'A path relative to the workspace root, or an absolute one.' };

/** Lines without their terminators (LF or CRLF); a trailing newline does not start another line. */
function splitLines(text: string): string[] {
  const lines = text.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

/** `cat -n` style: the right-aligned line number, a tab, the line. */
function numbered(lines: string[], first: number): string {
  return lines.map((line, i) => `${String(first + i).padStart(6)}\t${line}`).join('\n');
}

/** Read's line prefix copied into an Edit: the right-aligned number and the tab after it. */
const READ_PREFIX = /^ *\d+\t/;

/** `text` without one Read prefix per line, or null unless every line has one. */
function withoutReadPrefix(text: string): string | null {
  const lines = text.split('\n');
  return lines.every((line) => READ_PREFIX.test(line)) ? lines.map((line) => line.replace(READ_PREFIX, '')).join('\n') : null;
}

/**
 * Why an `old_string` that starts every line with a tab may have missed: templates that show tool output JSON-escaped
 * (gpt-oss's) turn the tab after Read's line number into a visible `\t`, which models take for indentation. A bare tab
 * is never removed on a guess (it is real indentation in Go files and Makefiles); the model hears what to check.
 */
function tabHint(oldString: string, content: string): string {
  const lines = oldString.split('\n');
  if (!lines.every((line) => line.startsWith('\t'))) return '';
  const untabbed = lines.map((line) => line.slice(1)).join('\n');
  return untabbed && content.includes(untabbed)
    ? " It matches without the tab at the start of each line: in Read's output that tab only separates the line number from the line, so leave it out of old_string and new_string unless the file is indented with tabs."
    : '';
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

export function createFileTools(workspace: Workspace, blobs?: Pick<BlobStore, 'put'>, checkpoint?: Checkpoint): Tool[] {
  const { runner } = workspace;

  const read: Tool<ReadInput> = {
    name: 'Read',
    description: ({ tier, has }) =>
      tier === 'compact'
        ? [
            'Reads a file. Each line comes back with its line number in front.',
            '- `file_path`: a path relative to the workspace root, or an absolute one.',
            '- Use `offset` and `limit` only for long files.',
            ...(has('Edit') ? ['- Read a file before you Edit it.'] : []),
          ].join('\n')
        : [
            'Reads a file from the workspace: text, an image or a PDF. Given a directory, it lists the entries instead.',
            '- Text comes back with a line number and a tab in front of each line, up to 2,000 lines from the top. Pass `offset` and `limit` only for files too long to read at once, or to read just the part you need when you know where it is. Lines longer than 2,000 characters are cut off.',
            `- The line-number prefix isn't part of the file${has('Edit') ? '; never copy it into Edit' : ''}.`,
            '- Images (PNG, JPEG, GIF, WebP) are shown to you when this model can see images; PDFs come back as their text.',
            `- Reading a path that doesn't exist only returns an error, so there is no need to check for it first${has('Bash') ? ' with Bash' : ''}.`,
            "- Don't read a file again right after writing or editing it to confirm the change; the tool would have reported a failure.",
            '- When you will probably need several files, read them all in one message.',
          ].join('\n'),
    compactExample: { file_path: '<path>' },
    inputSchema: {
      type: 'object',
      properties: {
        file_path: FILE_PATH,
        offset: {
          type: 'integer',
          minimum: 0,
          description: 'The 1-based line to start at. Only for files too long to read at once.',
        },
        limit: { type: 'integer', minimum: 1, description: 'How many lines to read from `offset`.' },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
    readOnly: true,
    async run({ file_path, offset, limit }, ctx) {
      const ext = /\.([^./\\]+)$/.exec(file_path)?.[1]?.toLowerCase();
      const mime = ext && IMAGE_MIME[ext];
      if (mime || ext === 'pdf') {
        const file = await runner.call('fs.read', { path: file_path, encoding: 'base64' }, { signal: ctx.signal });
        if (file.truncated) return textOutput(`${file_path} is too large to read (${file.size} bytes).`, true);
        const bytes = Buffer.from(file.content, 'base64');
        if (!mime) {
          const { text, truncated } = await extractText(bytes, 'application/pdf', MAX_READ_CHARS);
          return textOutput(truncated ? `${text}\n\n[The text is cut off after ${MAX_READ_CHARS} characters.]` : text);
        }
        if (!blobs) return textOutput(`${file_path} is an image (${mime}); images can't be shown in this session.`);
        const { sha256 } = await blobs.put(bytes, mime);
        return {
          content: [
            { type: 'text', text: imageNote(file_path, mime, bytes) },
            { type: 'image', mime, blob: sha256 },
          ],
        };
      }

      const first = Math.max(offset ?? 1, 1);
      const file = await runner
        .call('fs.read', { path: file_path, offset: first - 1, limit: limit ?? DEFAULT_LINES }, { signal: ctx.signal })
        .catch((e: unknown) => {
          if (e instanceof RpcError && e.code === RunnerErrorCode.IO && e.data?.code === 'EISDIR') return null;
          throw e;
        });
      if (!file) return listDirectory(file_path, ctx);
      if (file.binary)
        return textOutput(`${file_path} is a binary file. Read shows text files, images and PDFs.`, true);
      if (file.size === 0) return textOutput(`${file_path} exists but is empty.`);
      const lines: string[] = [];
      let chars = 0;
      for (const line of splitLines(file.content)) {
        const shown =
          line.length > MAX_LINE_CHARS
            ? `${line.slice(0, MAX_LINE_CHARS)}… [line cut off, ${line.length - MAX_LINE_CHARS} more characters]`
            : line;
        chars += shown.length + 8;
        if (chars > MAX_READ_CHARS && lines.length > 0) break;
        lines.push(shown);
      }
      if (lines.length === 0)
        return textOutput(`${file_path} has ${plural(file.totalLines, 'line')}; line ${first} is past the end.`);
      const last = first + lines.length - 1;
      const range =
        first > 1 || last < file.totalLines
          ? `\n\n[Showing lines ${first}-${last} of ${file.totalLines}. Use offset and limit to read the rest.]`
          : '';
      return textOutput(numbered(lines, first) + range);
    },
  };

  /** A directory's entries, one per line, `/` after subdirectories. */
  const listDirectory = async (path: string, ctx: ToolContext) => {
    const { entries, truncated } = await runner.call('fs.list', { path }, { signal: ctx.signal });
    if (entries.length === 0) return textOutput(`${path} is an empty directory.`);
    const shown = entries.slice(0, MAX_ENTRIES).map((e) => (e.type === 'dir' ? `${e.name}/` : e.name));
    const more = truncated || entries.length > MAX_ENTRIES ? `\n\n[Only the first ${shown.length} entries are listed.]` : '';
    return textOutput(`${path} is a directory:\n${shown.join('\n')}${more}`);
  };

  const write: Tool<WriteInput> = {
    name: 'Write',
    description: ({ tier, has }) =>
      tier === 'compact'
        ? ['Creates a file or replaces all of its content.', '- `content` is the complete file.', ...(has('Edit') ? ['- For a change to an existing file, use Edit.'] : [])].join('\n')
        : [
            'Creates a file or replaces its entire contents. Missing parent folders are created.',
            `- Use it for new files and complete rewrites.${has('Edit') ? ' To change part of an existing file use Edit, which sends only the change.' : ''}`,
            '- Read an existing file before you overwrite it, so you know what you are replacing.',
            "- Don't create documentation or README files unless the person asked for them.",
          ].join('\n'),
    compactExample: { file_path: '<path>', content: '<the complete file content>' },
    inputSchema: {
      type: 'object',
      properties: { file_path: FILE_PATH, content: { type: 'string', description: 'The complete new contents of the file.' } },
      required: ['file_path', 'content'],
      additionalProperties: false,
    },
    readOnly: false,
    async run({ file_path, content: written }, ctx) {
      const content = unescapeTags(written);
      await checkpoint?.(ctx, file_path);
      const { created } = await runner.call(
        'fs.write',
        { path: file_path, content, mkdirp: true },
        { signal: ctx.signal },
      );
      return textOutput(
        `${created ? 'Created' : 'Updated'} ${file_path} (${plural(splitLines(content).length, 'line')}).`,
      );
    },
  };

  const edit: Tool<EditInput> = {
    name: 'Edit',
    description: ({ tier }) =>
      tier === 'compact'
        ? [
            'Replaces exact text in a file.',
            "- `old_string`: copied exactly from the file, without Read's line numbers, and found only once in it.",
            '- `new_string`: the replacement.',
            '- If it fails, Read the file again and copy a smaller piece.',
          ].join('\n')
        : [
            'Replaces an exact piece of text in a file.',
            "- `old_string` must match the file character for character, indentation included and Read's line-number prefix left out, and it must occur exactly once; otherwise the call fails. When the text repeats, add a neighbouring line until it is unique, or set `replace_all` when every copy should change (handy for renames).",
            '- Keep `old_string` short: the few lines that pin down the place.',
            '- `new_string` must differ from `old_string`.',
            "- If the result says `old_string` wasn't found, Read the file again and copy a smaller exact piece instead of sending the same text again.",
            '- Line endings are handled for you; write `\\n`.',
            '- For several changes to one file, send several Edit calls (they can share a message and apply in order), or one Write for a rewrite.',
          ].join('\n'),
    compactExample: { file_path: '<path>', old_string: '<exact text from the file>', new_string: '<replacement text>' },
    inputSchema: {
      type: 'object',
      properties: {
        file_path: FILE_PATH,
        old_string: { type: 'string', description: "The exact text to replace, copied from the file without Read's line-number prefix." },
        new_string: { type: 'string', description: 'The text to put in its place; must differ from old_string.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence instead of exactly one (default false).' },
      },
      required: ['file_path', 'old_string', 'new_string'],
      additionalProperties: false,
    },
    readOnly: false,
    async run(input, ctx) {
      const { file_path, replace_all } = input;
      const [old_string, new_string] = [unescapeTags(input.old_string), unescapeTags(input.new_string)];
      if (old_string === '') return textOutput('old_string is empty. Use Write to create a file.', true);
      if (old_string === new_string)
        return textOutput('old_string and new_string are identical; there is nothing to change.', true);
      const file = await runner.call('fs.read', { path: file_path }, { signal: ctx.signal });
      if (file.binary) return textOutput(`${file_path} is a binary file and can't be edited.`, true);
      if (file.truncated) return textOutput(`${file_path} is too large to edit.`, true);
      const { content } = file;
      const crlf = /^[^\n]*\r\n/.test(content);
      const toFile = (s: string) => (crlf ? s.replace(/\r?\n/g, '\r\n') : s);
      let [from, to] = [toFile(old_string), toFile(new_string)];

      let parts = content.split(from);
      let count = parts.length - 1;
      let note = '';
      // Not found as sent, but found without the Read prefixes copied into it: edit what the model meant.
      const bare = count === 0 ? withoutReadPrefix(old_string) : null;
      if (bare) {
        const bareParts = content.split(toFile(bare));
        if (bareParts.length > 1) {
          // Only numbered prefixes come off new_string; a line without one keeps its tabs, which may be real.
          [from, to, parts, count] = [toFile(bare), toFile(new_string.split('\n').map((line) => line.replace(READ_PREFIX, '')).join('\n')), bareParts, bareParts.length - 1];
          note = " Read's line prefixes (the number and the tab after it) aren't part of the file, so they were left out of old_string and new_string.";
        }
      }
      if (count === 0) {
        return textOutput(
          `old_string was not found in ${file_path}. Read the file again and copy the text exactly, including whitespace and indentation.${tabHint(toFile(old_string), content)}`,
          true,
        );
      }
      if (count > 1 && !replace_all) {
        return textOutput(
          `old_string matches ${count} places in ${file_path}. Extend old_string with neighbouring lines until it matches only one, or set replace_all to true to change all ${count}.`,
          true,
        );
      }
      const at = content.indexOf(from);
      const updated = replace_all ? parts.join(to) : content.slice(0, at) + to + content.slice(at + from.length);
      await checkpoint?.(ctx, file_path);
      try {
        await runner.call(
          'fs.write',
          { path: file_path, content: updated, expectSha256: file.sha256 },
          { signal: ctx.signal },
        );
      } catch (e) {
        if (e instanceof RpcError && e.code === RunnerErrorCode.Conflict) {
          return textOutput('The file changed since it was read; read it again.', true);
        }
        throw e;
      }

      const lines = splitLines(updated);
      const changed = content.slice(0, at).split('\n').length; // 1-based line of the first change
      const start = Math.max(changed - SNIPPET_CONTEXT, 1);
      const end = Math.min(changed + to.split('\n').length - 1 + SNIPPET_CONTEXT, lines.length);
      const what = count > 1 ? ` (${count} replacements; the first is shown)` : '';
      return textOutput(`Edited ${file_path}${what}:${note}\n${numbered(lines.slice(start - 1, end), start)}`);
    },
  };

  return [read, write, edit];
}

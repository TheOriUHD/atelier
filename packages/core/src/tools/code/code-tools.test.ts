/**
 * The code tools against the real runner binary for this host. Build it first with `pnpm runner:build`;
 * without a build the suite is skipped.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Ajv } from 'ajv';
import type { RunEvent } from '@atelier/protocol';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hostRunnerBinary, RunnerClient } from '../../workspaces/runner-client.ts';
import type { RunnerCalls, Workspace } from '../../workspaces/workspace.ts';
import type { Tool, ToolContext, ToolOutput } from '../types.ts';
import { createCodeTools } from './index.ts';

const binary = hostRunnerBinary(join(import.meta.dirname, '../../../../../runner/bin'));
const built = existsSync(binary);
if (!built) console.warn(`code tools suite skipped: ${binary} is not built; run \`pnpm runner:build\` first`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const text = (out: ToolOutput) => out.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
/** Text with the path separators of this machine written as `/`: Glob and Grep print paths the way the OS does. */
const slashed = (out: ToolOutput) => text(out).replaceAll('\\', '/');
const ctx = (sessionId = 'session', signal = new AbortController().signal): ToolContext => ({
  sessionId,
  messageId: 'message',
  callId: 'call',
  signal,
  emit: () => {},
});

/** Minimal single-page PDF containing "Hello PDF". */
function tinyPdf(): Buffer {
  const stream = 'BT /F1 12 Tf 20 50 Td (Hello PDF) Tj ET';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  let out = '%PDF-1.4\n';
  const offsets = objects.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(out);
}

describe.skipIf(!built)('code tools', { timeout: 30_000 }, () => {
  let tmp: string;
  let client: RunnerClient;
  let workspace: Workspace;
  let tools: Map<string, Tool>;
  const blobs = new Map<string, { bytes: Uint8Array; mime: string }>();
  const at = (...parts: string[]) => join(workspace.root, ...parts);
  const write = (path: string, content: string | Buffer, mtimeSec?: number) => {
    mkdirSync(dirname(at(path)), { recursive: true });
    writeFileSync(at(path), content);
    if (mtimeSec !== undefined) utimesSync(at(path), mtimeSec, mtimeSec);
  };
  const run = (name: string, input: unknown, context = ctx()) => tools.get(name)!.run(input, context);

  beforeAll(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'atelier-code-tools-'));
    mkdirSync(join(tmp, 'workspace', 'src'), { recursive: true });
    writeFileSync(join(tmp, 'outside.txt'), 'secret\n');
    client = await RunnerClient.spawn({ binaryPath: binary, roots: [join(tmp, 'workspace')] });
    const shells = new Map<string, Promise<string>>();
    const { info } = client;
    workspace = {
      id: 'workspace',
      deviceId: null,
      host: null,
      root: info.roots[0]!,
      home: info.home,
      os: info.os,
      shell: info.shell,
      pathSep: info.pathSep,
      runner: client,
      shellFor: (sessionId) => {
        let shell = shells.get(sessionId);
        if (!shell) shells.set(sessionId, (shell = client.call('shell.open', {}).then((r) => r.shellId)));
        return shell;
      },
    };
    const store = {
      put: async (bytes: Uint8Array, mime: string) => {
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        blobs.set(sha256, { bytes, mime });
        return { sha256, size: bytes.byteLength, mime };
      },
    };
    tools = new Map(createCodeTools(workspace, { blobs: store }).map((t) => [t.name, t]));
  });

  afterAll(async () => {
    await client?.shutdown();
    if (tmp) rmSync(tmp, { recursive: true, force: true });
  });

  it('uses Claude Code names, read-only flags and strict schemas', () => {
    const readOnly = Object.fromEntries([...tools.values()].map((t) => [t.name, t.readOnly]));
    expect(readOnly).toEqual({
      Read: true,
      Write: false,
      Edit: false,
      Glob: true,
      Grep: true,
      Bash: false,
      BashOutput: true,
      KillShell: false,
    });
    const ajv = new Ajv({ strict: true });
    const valid: Record<string, object> = {
      Read: { file_path: 'a', offset: 1, limit: 2 },
      Write: { file_path: 'a', content: '' },
      Edit: { file_path: 'a', old_string: 'x', new_string: 'y', replace_all: true },
      Glob: { pattern: '*', path: 'src' },
      Grep: { pattern: 'x', output_mode: 'content', '-i': true, '-n': false, '-C': 2, head_limit: 5 },
      Bash: { command: 'ls', timeout: 1000, run_in_background: false, description: 'List files' },
      BashOutput: { bash_id: 'x', filter: 'y' },
      KillShell: { shell_id: 'x' },
    };
    for (const tool of tools.values()) {
      const validate = ajv.compile(tool.inputSchema);
      expect(validate(valid[tool.name]), tool.name).toBe(true);
      expect(validate({ ...valid[tool.name], extra: 1 }), tool.name).toBe(false);
      expect(validate({}), tool.name).toBe(false);
    }
  });

  describe('Read', () => {
    it('numbers lines like cat -n, with paths relative to the root or absolute', async () => {
      write('a.txt', 'one\ntwo\r\nthree\n');
      const expected = '     1\tone\n     2\ttwo\n     3\tthree';
      expect(text(await run('Read', { file_path: 'a.txt' }))).toBe(expected);
      expect(text(await run('Read', { file_path: at('a.txt') }))).toBe(expected);
      expect(text(await run('Read', { file_path: 'a.txt', offset: 2, limit: 1 }))).toBe(
        '     2\ttwo\n\n[Showing lines 2-2 of 3. Use offset and limit to read the rest.]',
      );
      expect(text(await run('Read', { file_path: 'a.txt', offset: 9 }))).toBe(
        'a.txt has 3 lines; line 9 is past the end.',
      );
    });

    it('reads 2000 lines by default and cuts long lines', async () => {
      const lines = Array.from({ length: 2500 }, (_, i) => `line ${i + 1}`);
      lines[0] = 'x'.repeat(2600);
      write('long.txt', `${lines.join('\n')}\n`);
      const out = text(await run('Read', { file_path: 'long.txt' }));
      expect(out.startsWith(`     1\t${'x'.repeat(2000)}… [line cut off, 600 more characters]\n     2\tline 2\n`)).toBe(
        true,
      );
      expect(out).toContain('  2000\tline 2000\n\n[Showing lines 1-2000 of 2500.');
      expect(out).not.toContain('line 2001');
    });

    it('notes empty files and refuses binary ones', async () => {
      write('empty.txt', '');
      expect(await run('Read', { file_path: 'empty.txt' })).toEqual({
        content: [{ type: 'text', text: 'empty.txt exists but is empty.' }],
      });
      write('blob.bin', Buffer.from([0, 1, 2, 3]));
      const binary = await run('Read', { file_path: 'blob.bin' });
      expect(binary.isError).toBe(true);
      expect(text(binary)).toContain('binary file');
    });

    it('returns images as blobs, or a note without a blob store', async () => {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
      write('pic.PNG', png);
      const out = await run('Read', { file_path: 'pic.PNG' });
      const image = out.content[1];
      expect(image).toMatchObject({ type: 'image', mime: 'image/png' });
      expect(Buffer.from(blobs.get((image as { blob: string }).blob)!.bytes)).toEqual(png);

      const withoutStore = createCodeTools(workspace).find((t) => t.name === 'Read')!;
      const note = await withoutStore.run({ file_path: 'pic.PNG' }, ctx());
      expect(note.content).toEqual([
        { type: 'text', text: "pic.PNG is an image (image/png); images can't be shown in this session." },
      ]);
    });

    it('shows a very tall image, saying that it is reduced and what to do for detail', async () => {
      const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
      const tall = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, ...be32(1440), ...be32(12000), 8, 6, 0, 0, 0]);
      write('full-page.png', tall);
      const out = await run('Read', { file_path: 'full-page.png' });
      expect(out.isError).toBeUndefined();
      expect(out.content[0]).toMatchObject({ type: 'text', text: expect.stringContaining('1440×12000 pixels') });
      expect((out.content[0] as { text: string }).text).toContain('viewport');
      expect(out.content[1]).toMatchObject({ type: 'image', mime: 'image/png' });
    });

    it('lists a directory instead of failing on it', async () => {
      write('listing/b.txt', 'b');
      write('listing/a/inner.txt', 'x');
      expect(text(await run('Read', { file_path: 'listing' }))).toBe('listing is a directory:\na/\nb.txt');
    });

    it('extracts the text of PDFs', async () => {
      write('doc.pdf', tinyPdf());
      expect(text(await run('Read', { file_path: 'doc.pdf' }))).toContain('Hello PDF');
    });

    it('refuses paths outside the workspace with the runner message', async () => {
      await expect(run('Read', { file_path: '../outside.txt' })).rejects.toThrow(/outside the workspace/);
      await expect(run('Read', { file_path: join(tmp, 'outside.txt') })).rejects.toThrow(/outside the workspace/);
      await expect(run('Write', { file_path: '../escape.txt', content: 'x' })).rejects.toThrow(/outside the workspace/);
      await expect(run('Read', { file_path: 'missing.txt' })).rejects.toMatchObject({ data: { code: 'ENOENT' } });
      expect(existsSync(join(tmp, 'escape.txt'))).toBe(false);
    });
  });

  describe('Write', () => {
    it("writes Atelier's tags as the model copied them from escaped tool output", async () => {
      await run('Write', { file_path: 'tags.html', content: '‹env> stays <env>\n' });
      expect(readFileSync(at('tags.html'), 'utf8')).toBe('<env> stays <env>\n');
      expect(text(await run('Edit', { file_path: 'tags.html', old_string: '‹env> stays', new_string: '‹/env> moved' }))).toContain('Edited tags.html');
      expect(readFileSync(at('tags.html'), 'utf8')).toBe('</env> moved <env>\n');
    });

    it('creates files with their directories, then updates them', async () => {
      expect(text(await run('Write', { file_path: 'new/deep/f.txt', content: 'a\nb\n' }))).toBe(
        'Created new/deep/f.txt (2 lines).',
      );
      expect(readFileSync(at('new', 'deep', 'f.txt'), 'utf8')).toBe('a\nb\n');
      expect(text(await run('Write', { file_path: 'new/deep/f.txt', content: 'only' }))).toBe(
        'Updated new/deep/f.txt (1 line).',
      );
      expect(readFileSync(at('new', 'deep', 'f.txt'), 'utf8')).toBe('only');
    });

    it('lets Rewind keep the old content first, for Write and Edit alike', async () => {
      const seen: string[] = [];
      const checkpoint = async (_ctx: ToolContext, path: string) => void seen.push(`${path}=${existsSync(at(path)) ? readFileSync(at(path), 'utf8') : '(none)'}`);
      const tools = new Map(createCodeTools(workspace, { checkpoint }).map((t) => [t.name, t]));
      await tools.get('Write')!.run({ file_path: 'kept.txt', content: 'v1' }, ctx());
      await tools.get('Edit')!.run({ file_path: 'kept.txt', old_string: 'v1', new_string: 'v2' }, ctx());
      await tools.get('Edit')!.run({ file_path: 'kept.txt', old_string: 'missing', new_string: 'x' }, ctx());
      expect(seen).toEqual(['kept.txt=(none)', 'kept.txt=v1']);
    });
  });

  describe('Edit', () => {
    it('replaces a unique string literally and shows the change in context', async () => {
      write('e.txt', `${['a', 'b', 'c', 'd', 'target', 'f', 'g', 'h', 'i'].join('\n')}\n`);
      const out = await run('Edit', { file_path: 'e.txt', old_string: 'target', new_string: 'cost = $& 5\nmore' });
      expect(out.isError).toBeUndefined();
      expect(text(out)).toBe(
        [
          'Edited e.txt:',
          '     2\tb',
          '     3\tc',
          '     4\td',
          '     5\tcost = $& 5',
          '     6\tmore',
          '     7\tf',
          '     8\tg',
          '     9\th',
        ].join('\n'),
      );
      expect(readFileSync(at('e.txt'), 'utf8')).toBe('a\nb\nc\nd\ncost = $& 5\nmore\nf\ng\nh\ni\n');
    });

    it('refuses missing, ambiguous and no-op edits; replace_all changes every occurrence', async () => {
      write('dup.txt', 'x = 1\nx = 1\n');
      const ambiguous = await run('Edit', { file_path: 'dup.txt', old_string: 'x = 1', new_string: 'x = 2' });
      expect(ambiguous.isError).toBe(true);
      expect(text(ambiguous)).toBe('old_string matches 2 places in dup.txt. Extend old_string with neighbouring lines until it matches only one, or set replace_all to true to change all 2.');
      const missing = await run('Edit', { file_path: 'dup.txt', old_string: 'y = 1', new_string: 'y = 2' });
      expect(missing.isError).toBe(true);
      expect(text(missing)).toContain('Read the file again');
      const same = await run('Edit', { file_path: 'dup.txt', old_string: 'x', new_string: 'x' });
      expect(same.isError).toBe(true);
      expect(readFileSync(at('dup.txt'), 'utf8')).toBe('x = 1\nx = 1\n');

      const all = await run('Edit', {
        file_path: 'dup.txt',
        old_string: 'x = 1',
        new_string: 'x = 2',
        replace_all: true,
      });
      expect(text(all)).toContain('(2 replacements; the first is shown)');
      expect(readFileSync(at('dup.txt'), 'utf8')).toBe('x = 2\nx = 2\n');
    });

    it('fails without clobbering when the file changes between its read and its write', async () => {
      write('race.txt', 'mine\n');
      const racing: RunnerCalls = {
        on: client.on.bind(client),
        call: (async (method: 'fs.read', params: { path: string }, options?: { signal?: AbortSignal }) => {
          const result = await client.call(method, params, options);
          if (method === 'fs.read') writeFileSync(at('race.txt'), 'theirs\n');
          return result;
        }) as RunnerCalls['call'],
      };
      const edit = createCodeTools({ ...workspace, runner: racing }).find((t) => t.name === 'Edit')!;
      const out = await edit.run({ file_path: 'race.txt', old_string: 'mine', new_string: 'ours' }, ctx());
      expect(out).toEqual({
        content: [{ type: 'text', text: 'The file changed since it was read; read it again.' }],
        isError: true,
      });
      expect(readFileSync(at('race.txt'), 'utf8')).toBe('theirs\n');
    });

    it("leaves out Read's numbered line prefixes copied into old_string and new_string", async () => {
      write('tabs.go', 'func a() {\n\treturn 1\n}\n');
      const numbered = await run('Edit', { file_path: 'tabs.go', old_string: '     1\tfunc a() {\n     2\t\treturn 1', new_string: '     1\tfunc a() {\n     2\t\treturn 2' });
      expect(numbered.isError).toBeUndefined();
      expect(text(numbered)).toContain("Read's line prefixes (the number and the tab after it) aren't part of the file");
      expect(readFileSync(at('tabs.go'), 'utf8')).toBe('func a() {\n\treturn 2\n}\n');

      // A new_string line without a number keeps its tab: here it is the file's indentation.
      write('tabs2.go', 'func a() {\n\treturn 1\n}\n');
      expect((await run('Edit', { file_path: 'tabs2.go', old_string: '     2\t\treturn 1', new_string: '\treturn 2' })).isError).toBeUndefined();
      expect(readFileSync(at('tabs2.go'), 'utf8')).toBe('func a() {\n\treturn 2\n}\n');
      write('Makefile', 'all:\n\tgo build\n');
      expect((await run('Edit', { file_path: 'Makefile', old_string: '     2\t\tgo build', new_string: '\tgo build ./...' })).isError).toBeUndefined();
      expect(readFileSync(at('Makefile'), 'utf8')).toBe('all:\n\tgo build ./...\n');

      // A tab that really is in the file matches as sent; without a match either way the edit still fails.
      expect((await run('Edit', { file_path: 'tabs.go', old_string: '\treturn 2', new_string: '\treturn 3' })).isError).toBeUndefined();
      expect(readFileSync(at('tabs.go'), 'utf8')).toBe('func a() {\n\treturn 3\n}\n');
      expect((await run('Edit', { file_path: 'tabs.go', old_string: '\tmissing', new_string: '\tx' })).isError).toBe(true);
    });

    it('never drops a bare leading tab on a guess, but says when the text matches without it', async () => {
      // What gpt-oss-20b sent after reading `     2\t  return …` (its template shows the tab as `\t`).
      write('greet.ts', 'export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n');
      const out = await run('Edit', { file_path: 'greet.ts', old_string: '\t  return `Hello, ${name}`;', new_string: '\t  return `Hi, ${name}!`;' });
      expect(out.isError).toBe(true);
      expect(text(out)).toContain("It matches without the tab at the start of each line: in Read's output that tab only separates the line number");
      expect(readFileSync(at('greet.ts'), 'utf8')).toBe('export function greet(name: string): string {\n  return `Hello, ${name}`;\n}\n');
      expect(text(await run('Edit', { file_path: 'greet.ts', old_string: '\tnowhere', new_string: 'x' }))).not.toContain('matches without the tab');
    });

    it('matches and writes CRLF line endings in CRLF files', async () => {
      write('crlf.txt', 'one\r\ntwo\r\nthree\r\n');
      const out = await run('Edit', { file_path: 'crlf.txt', old_string: 'one\ntwo', new_string: 'uno\ndos' });
      expect(text(out)).toBe('Edited crlf.txt:\n     1\tuno\n     2\tdos\n     3\tthree');
      expect(readFileSync(at('crlf.txt'), 'utf8')).toBe('uno\r\ndos\r\nthree\r\n');
    });
  });

  describe('Glob', () => {
    it('lists matches relative to the root, newest first', async () => {
      write('globbed/a.ts', '', 1_000_000);
      write('globbed/b.ts', '', 2_000_000);
      write('globbed/sub/c.ts', '', 3_000_000);
      write('globbed/d.js', '');
      const expected = 'globbed/sub/c.ts\nglobbed/b.ts\nglobbed/a.ts';
      expect(slashed(await run('Glob', { pattern: 'globbed/**/*.ts' }))).toBe(expected);
      expect(slashed(await run('Glob', { pattern: '**/*.ts', path: 'globbed' }))).toBe(expected);
      expect(slashed(await run('Glob', { pattern: 'globbed/*.py' }))).toBe('No files found.');
    });

    // `<` and `>` can't be in a file name on Windows.
    it.skipIf(process.platform === 'win32')("finds names with Atelier's tags from a pattern copied out of escaped output", async () => {
      write('tagged/<env>.txt', '');
      expect(slashed(await run('Glob', { pattern: 'tagged/‹env>.txt' }))).toBe('tagged/<env>.txt');
    });

    it('returns at most 100 files and says so', async () => {
      for (let i = 0; i < 105; i++) write(`many/f${i}.txt`, '');
      const out = slashed(await run('Glob', { pattern: 'many/*.txt' }));
      expect(out.split('\n').filter((l) => l.startsWith('many/'))).toHaveLength(100);
      expect(out).toContain('[Only the 100 most recently modified matches are shown.');
    });
  });

  describe('Grep', () => {
    beforeAll(() => {
      write('grepped/one.ts', "export const Greeting = 'hello';\n// TODO: wave\n", 1_000_000);
      write('grepped/two.md', '# Notes\nhello there\nbye\n', 2_000_000);
    });

    it('lists matching files by default, newest first', async () => {
      expect(slashed(await run('Grep', { pattern: 'hello', path: 'grepped' }))).toBe(
        'Found 2 files\ngrepped/two.md\ngrepped/one.ts',
      );
      expect(slashed(await run('Grep', { pattern: 'absent', path: 'grepped' }))).toBe('No files found.');
    });

    it('reads an output mode sent as `type` as the output mode, and says so', async () => {
      // gpt-oss-20b sent `"type":"files_with_matches"` and `"type":"content"` over and over.
      expect(slashed(await run('Grep', { pattern: 'hello', path: 'grepped', type: 'files_with_matches' }))).toBe(
        'Found 2 files\ngrepped/two.md\ngrepped/one.ts\n\n(`type` filters by file type, such as ts or py; "files_with_matches" was used as output_mode.)',
      );
      expect(slashed(await run('Grep', { pattern: 'there', path: 'grepped', type: 'content' }))).toMatch(/^grepped\/two\.md:2:hello there\n\n\(`type` filters/);
      // A real file type is still a file type.
      expect(slashed(await run('Grep', { pattern: 'hello', path: 'grepped', type: 'md' }))).toBe('Found 1 files\ngrepped/two.md');
    });

    it('shows matching lines with numbers, context, case folding and filters', async () => {
      const content = (input: object) => run('Grep', { path: 'grepped', output_mode: 'content', ...input }).then(slashed);
      expect(await content({ pattern: 'greeting', '-i': true })).toBe(
        "grepped/one.ts:1:export const Greeting = 'hello';",
      );
      expect(await content({ pattern: 'greeting' })).toBe('No matches found.');
      expect(await content({ pattern: 'hello', type: 'md', '-A': 1 })).toBe(
        'grepped/two.md:2:hello there\ngrepped/two.md-3-bye',
      );
      expect(await content({ pattern: 'hello', glob: '*.ts', '-n': false })).toBe(
        "grepped/one.ts:export const Greeting = 'hello';",
      );
      expect(await content({ pattern: 'TODO', '-C': 1 })).toBe(
        "grepped/one.ts-1-export const Greeting = 'hello';\ngrepped/one.ts:2:// TODO: wave",
      );
      expect(await content({ pattern: 'Notes\\nhello', multiline: true })).toBe(
        'grepped/two.md:1:# Notes\ngrepped/two.md:2:hello there',
      );
      expect(await content({ pattern: 'e', head_limit: 1 })).toBe(
        "grepped/one.ts:1:export const Greeting = 'hello';\n\n[Results truncated. Narrow the search with path, glob or type, or set head_limit.]",
      );
    });

    it("searches for Atelier's tags as they are in the files when the pattern was copied escaped", async () => {
      write('grepped-tags/page.html', '<env>\n</env>\n');
      expect(slashed(await run('Grep', { pattern: '‹/env>', path: 'grepped-tags', output_mode: 'content' }))).toBe('grepped-tags/page.html:2:</env>');
    });

    it('counts matching lines per file', async () => {
      expect(slashed(await run('Grep', { pattern: 'e', path: 'grepped', output_mode: 'count' }))).toBe(
        'grepped/one.ts:2\ngrepped/two.md:3\n\n5 matching lines in 2 files.',
      );
    });
  });

  describe('Bash', () => {
    it('keeps the working directory but not exports between commands', async () => {
      const first = await run('Bash', { command: 'cd src && export FOO=1 && echo hi' }, ctx('bash-cwd'));
      expect(text(first)).toBe(`hi\n\nExit code 0.\nWorking directory is now ${at('src')}.`);
      const second = await run('Bash', { command: 'pwd; echo "FOO=${FOO:-unset}"' }, ctx('bash-cwd'));
      // Git Bash writes its working directory as `C:\\Users/me/x`.
      expect(slashed(second)).toBe(`${at('src').replaceAll('\\', '/')}\nFOO=unset\n\nExit code 0.`);
      expect(slashed(await run('Bash', { command: 'pwd' }, ctx('bash-other')))).toBe(`${workspace.root.replaceAll('\\', '/')}\n\nExit code 0.`);
    });

    it('streams output while the command runs', async () => {
      const events: RunEvent[] = [];
      await run('Bash', { command: 'echo one; sleep 0.2; echo two' }, { ...ctx('bash-stream'), emit: (e) => void events.push(e) });
      const streamed = events.flatMap((e) => (e.type === 'tool_output' ? [e] : []));
      expect(streamed.every((e) => e.callId === 'call' && e.messageId === 'message')).toBe(true);
      expect(streamed.map((e) => e.text).join('')).toBe('one\ntwo\n');
    });

    it('reports non-zero exits and timeouts as errors', async () => {
      const failed = await run('Bash', { command: 'echo oops >&2; exit 3' });
      expect(failed).toEqual({ content: [{ type: 'text', text: 'oops\n\nExit code 3.' }], isError: true });
      expect(text(await run('Bash', { command: 'true' }))).toBe('(no output)\n\nExit code 0.');
      const started = Date.now();
      const slow = await run('Bash', { command: 'echo before; sleep 20', timeout: 300 });
      expect(slow.isError).toBe(true);
      expect(text(slow)).toBe('before\n\nTimed out after 0.3s; the command was killed.');
      expect(Date.now() - started).toBeLessThan(10_000);
    });

    it('stops the command when the run is aborted', async () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 300);
      const stopped = await run('Bash', { command: 'sleep 30' }, ctx('bash-abort', controller.signal));
      expect(stopped).toEqual({
        content: [{ type: 'text', text: 'The command was stopped before it finished.' }],
        isError: true,
      });
      // The shell runs one foreground command at a time, so this returns only once sleep was killed.
      const started = Date.now();
      expect(text(await run('Bash', { command: 'echo after' }, ctx('bash-abort')))).toBe('after\n\nExit code 0.');
      expect(Date.now() - started).toBeLessThan(10_000);
    });

    it('runs commands in the background, reads only new output and kills them', async () => {
      const started = text(
        await run('Bash', { command: 'echo first; sleep 1; echo second; sleep 30', run_in_background: true }),
      );
      const id = /with ID (\S+)\.$/m.exec(started)![1]!;
      const reads: string[] = [];
      for (const deadline = Date.now() + 10_000; !reads.at(-1)?.includes('second'); await sleep(50)) {
        if (Date.now() > deadline) throw new Error(`no background output: ${reads.join(' | ')}`);
        reads.push(text(await run('BashOutput', { bash_id: id })));
      }
      expect(reads.filter((r) => r.includes('first'))).toHaveLength(1);
      expect(reads.at(-1)).toBe('second\n\nStill running.');

      expect(text(await run('KillShell', { shell_id: id }))).toBe(`Killed ${id}.`);
      let last = '';
      for (const deadline = Date.now() + 10_000; !last.includes('Exited'); await sleep(50)) {
        if (Date.now() > deadline) throw new Error('the killed command kept running');
        last = text(await run('BashOutput', { bash_id: id }));
      }
      expect(last).toMatch(/^\(no new output\)\n\nExited with code -?\d+\.$/);
      expect(last).not.toContain('code 0.');
      expect(text(await run('KillShell', { shell_id: id }))).toBe(`${id} had already exited.`);
    });

    it('says an unknown ID is from before a restart, instead of a bare error', async () => {
      const read = await run('BashOutput', { bash_id: 'exec-999' });
      expect(read.isError).toBe(true);
      expect(text(read)).toMatch(/^exec-999 isn't running: background commands stop when the app or its runner restarts/);
      expect(text(await run('KillShell', { shell_id: 'exec-999' }))).toMatch(/^exec-999 isn't running/);
    });

    it('filters background output by regex', async () => {
      const started = text(await run('Bash', { command: 'printf "a1\\nb1\\na2\\n"', run_in_background: true }));
      const id = /with ID (\S+)\.$/m.exec(started)![1]!;
      expect((await run('BashOutput', { bash_id: id, filter: '(' })).isError).toBe(true);
      for (
        const deadline = Date.now() + 10_000;
        (await client.call('shell.read', { execId: id })).running;
        await sleep(50)
      ) {
        if (Date.now() > deadline) throw new Error('the command kept running');
      }
      expect(text(await run('BashOutput', { bash_id: id, filter: '^a' }))).toBe('a1\na2\n\nExited with code 0.');
      expect(text(await run('BashOutput', { bash_id: id }))).toBe('(no new output)\n\nExited with code 0.');
    });
  });
});

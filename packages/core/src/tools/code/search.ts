/** Glob and Grep over the runner's gitignore-aware walk, with paths shown relative to the workspace root. */
import { unescapeTags } from '../../prompts/escape.ts';
import type { Workspace } from '../../workspaces/workspace.ts';
import { textOutput, type Tool } from '../types.ts';

const GLOB_LIMIT = 100;
const MAX_GREP_CHARS = 30_000;

interface GlobInput {
  pattern: string;
  path?: string;
}

interface GrepInput {
  pattern: string;
  path?: string;
  glob?: string;
  type?: string;
  output_mode?: 'content' | 'files_with_matches' | 'count';
  '-i'?: boolean;
  '-n'?: boolean;
  '-A'?: number;
  '-B'?: number;
  '-C'?: number;
  multiline?: boolean;
  head_limit?: number;
}

const CONTEXT_LINES = { type: 'integer', minimum: 0 };
const OUTPUT_MODES = new Set(['content', 'files_with_matches', 'count']);

export function createSearchTools(workspace: Workspace): Tool[] {
  const { runner, root, pathSep } = workspace;
  const prefix = root.endsWith(pathSep) ? root : root + pathSep;
  /** Strips the workspace root from a path, or from the start of a `path:line:text` grep line. */
  const rel = (p: string) => (p.startsWith(prefix) ? p.slice(prefix.length) : p);

  const glob: Tool<GlobInput> = {
    name: 'Glob',
    description: ({ tier, has }) =>
      tier === 'compact'
        ? ['Finds files by name pattern.', '- `pattern` such as `src/**/*.ts`.', '- Newest first, at most 100 paths.'].join('\n')
        : [
            'Finds files by path pattern, such as `**/*.ts` or `src/components/**/*.tsx`. It returns paths relative to the workspace root, most recently changed first, at most 100; files ignored by .gitignore are skipped.',
            `- Use it when you know roughly what a file is called.${has('Grep') ? ' To search inside files, use Grep.' : ''}`,
            ...(has('Agent') ? ['- For open-ended exploration that will take many rounds, hand the search to a sub-agent with Agent.'] : []),
            '- Leave out `path` to search from the workspace root; never pass an empty string or "null".',
          ].join('\n'),
    compactExample: { pattern: '<glob pattern>' },
    inputSchema: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'The glob pattern; `**` matches any number of folders.' },
        path: { type: 'string', description: 'The folder to search in. Leave it out to search the workspace root.' },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    readOnly: true,
    async run({ pattern, path }, ctx) {
      const { files, truncated } = await runner.call(
        'fs.glob',
        // A pattern copied from escaped output searches for Atelier's tags as they are in the files.
        { pattern: unescapeTags(pattern), cwd: path, limit: GLOB_LIMIT },
        { signal: ctx.signal },
      );
      if (files.length === 0) return textOutput('No files found.');
      const note = truncated
        ? `\n\n[Only the ${GLOB_LIMIT} most recently modified matches are shown. Use a more specific pattern or path.]`
        : '';
      return textOutput(files.map(rel).join('\n') + note);
    },
  };

  const grep: Tool<GrepInput> = {
    name: 'Grep',
    description: ({ tier, has }) =>
      tier === 'compact'
        ? ['Searches file contents with a regular expression.', '- By default it lists the matching files; `output_mode: "content"` shows the lines.', '- Narrow the search with `path` or `glob`.'].join('\n')
        : [
            'Searches file contents with a regular expression in ripgrep syntax. Files ignored by .gitignore are skipped.',
            ...(has('Bash') ? ['- Use it rather than `grep` or `rg` in Bash.'] : []),
            '- `output_mode`: `files_with_matches` (the default, newest first) to find where something is, `content` to see the matching lines (with `-n`, `-A`, `-B` or `-C`), `count` for totals per file. Narrow the search with `glob` (`*.ts`, `src/**/*.{js,jsx}`) or `type` (ts, py, go, rust), and cap the output with `head_limit`.',
            '- Escape literal braces and parentheses (`fn\\(`), and set `multiline` for patterns that span lines.',
            '- Independent searches can go in one message and run together.',
          ].join('\n'),
    compactExample: { pattern: '<regular expression>', path: '<folder>' },
    inputSchema: {
      type: 'object',
      properties: {
        pattern: {
          type: 'string',
          description: 'Regular expression. Escape literal braces and parentheses, e.g. `fn\\(`.',
        },
        path: { type: 'string', description: 'The file or folder to search. Leave it out to search the workspace root.' },
        glob: { type: 'string', description: 'Only search files matching this glob; separate several with spaces, and start one with `!` to exclude.' },
        type: {
          type: 'string',
          description: 'Only search files of this type: ts, js, py, go, rust, java, md, json, …',
        },
        output_mode: {
          type: 'string',
          enum: ['content', 'files_with_matches', 'count'],
          description: 'files_with_matches (default): file paths; content: matching lines; count: matches per file.',
        },
        '-i': { type: 'boolean', description: 'Case-insensitive search.' },
        '-n': { type: 'boolean', description: 'Show line numbers in content mode (default true).' },
        '-A': { ...CONTEXT_LINES, description: 'Lines of context after each match (content mode).' },
        '-B': { ...CONTEXT_LINES, description: 'Lines of context before each match (content mode).' },
        '-C': { ...CONTEXT_LINES, description: 'Lines of context before and after each match (content mode).' },
        multiline: { type: 'boolean', description: 'Let patterns span lines; `.` also matches newlines.' },
        head_limit: {
          type: 'integer',
          minimum: 0,
          description: 'Return at most this many lines (content) or entries (other modes).',
        },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    readOnly: true,
    async run(given, ctx) {
      // An output mode sent as `type` (gpt-oss-20b did this again and again): no file type has those names, so it
      // is read as the output mode it was meant to be.
      const misplaced = given.type !== undefined && OUTPUT_MODES.has(given.type) && (!given.output_mode || given.output_mode === given.type);
      const input: GrepInput = misplaced ? { ...given, type: undefined, output_mode: given.type as GrepInput['output_mode'] } : given;
      const mode = input.output_mode ?? 'files_with_matches';
      const res = await runner.call(
        'fs.grep',
        {
          pattern: unescapeTags(input.pattern),
          path: input.path,
          glob: input.glob,
          type: input.type,
          outputMode: mode === 'files_with_matches' ? 'files' : mode,
          caseInsensitive: input['-i'],
          lineNumbers: input['-n'] ?? true,
          before: input['-B'] ?? input['-C'],
          after: input['-A'] ?? input['-C'],
          multiline: input.multiline,
          headLimit: input.head_limit,
        },
        { signal: ctx.signal },
      );
      const note = misplaced ? `\n\n(\`type\` filters by file type, such as ts or py; "${mode}" was used as output_mode.)` : '';
      if (res.numFiles === 0)
        return textOutput(`${mode === 'files_with_matches' ? 'No files found.' : 'No matches found.'}${note}`);
      let text =
        mode === 'content'
          ? res.lines.map(rel).join('\n')
          : mode === 'count'
            ? `${res.counts.map((c) => `${rel(c.path)}:${c.count}`).join('\n')}\n\n${res.numMatches} matching lines in ${res.numFiles} files.`
            : `Found ${res.numFiles} files\n${res.files.map(rel).join('\n')}`;
      let truncated = res.truncated;
      if (text.length > MAX_GREP_CHARS) {
        const cut = text.lastIndexOf('\n', MAX_GREP_CHARS);
        text = text.slice(0, cut > 0 ? cut : MAX_GREP_CHARS);
        truncated = true;
      }
      return textOutput(
        `${truncated ? `${text}\n\n[Results truncated. Narrow the search with path, glob or type, or set head_limit.]` : text}${note}`,
      );
    },
  };

  return [glob, grep];
}

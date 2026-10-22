/**
 * The `artifact` tool: versioned artifacts shown beside the conversation. Chat creates, patches and rewrites them from
 * content the model writes; Code shows a workspace file the model already wrote (the Artifact pane), read through the
 * runner like Read, so a page is never generated twice.
 */
import { ArtifactType, artifactIdForPath } from '@atelier/protocol';
import type { ArtifactRepo } from '../artifacts/artifact-repo.ts';
import { unescapeTags } from '../prompts/escape.ts';
import type { Workspace } from '../workspaces/workspace.ts';
import { textOutput, type DescribeContext, type Tool } from './types.ts';

interface ArtifactInput {
  command: 'create' | 'update' | 'rewrite';
  identifier: string;
  type?: string;
  title?: string;
  language?: string;
  content?: string;
  old?: string;
  new?: string;
}

interface FileArtifactInput {
  file_path: string;
}

const MAX_CONTENT = 500_000;

/** The sandbox limits sit here as well as in the artifacts fragment, so compact-tier models see them too. */
const RUNTIME =
  'Artifacts run in a sandbox without network access: no external URLs or CDN scripts, no `localStorage`, `sessionStorage` or IndexedDB, and no form submission (use click and change handlers). A `react` artifact is one default-exported component without required props, styled with Tailwind utility classes, importing only React, lucide-react and recharts.';

function describe({ tier }: DescribeContext): string {
  if (tier === 'compact') {
    return [
      'Creates or changes a standalone piece of content shown in a panel next to the chat.',
      '- `create` needs identifier, type, title and the complete content; `rewrite` replaces the content.',
      '- `type` is html, react, svg, mermaid, markdown or code.',
      `- ${RUNTIME}`,
    ].join('\n');
  }
  return [
    'Creates or changes a standalone piece of content (a document, program, web page, React component, SVG or Mermaid diagram) shown in a panel next to the conversation. Every change makes a new version.',
    '- `create` takes a new `identifier` (kebab-case, unique in this conversation), a `type`, a `title` and the complete `content`.',
    '- `update` replaces `old`, which must occur exactly once in the latest version, with `new`. Use it for small, local edits.',
    '- `rewrite` replaces the whole content (and optionally the title). Use it for larger changes.',
    '- Types: `html`, `react`, `svg`, `mermaid`, `markdown`, and `code` with `language`.',
    `- ${RUNTIME}`,
    '- Content must be complete: no placeholders or "rest unchanged" comments.',
    '- A reply makes a single artifact unless the person asks for several.',
  ].join('\n');
}

function describeFile({ tier }: DescribeContext): string {
  if (tier === 'compact') return 'Shows a file you wrote (page, SVG, Markdown, Mermaid, code) in a pane beside the chat; call it again after a change. Pages run offline: no CDN scripts or external URLs.';
  return [
    'Shows a file from the workspace in the Artifact pane beside the conversation, so the person can look at what you made without leaving Atelier.',
    '- `file_path` is relative to the workspace root, or absolute. The extension decides how the file is shown: `.html` as a page, `.svg` as an image, `.md` as a document, `.mmd` as a Mermaid diagram, anything else as code.',
    '- Write the file first. Calling it again for the same path after a change adds a new version; the pane follows the latest.',
    '- Pages run in a sandbox without network access: no external URLs or CDN scripts, no `localStorage`, `sessionStorage` or IndexedDB, and no form submission. Keep a page you mean to show self-contained.',
  ].join('\n');
}

/** The artifact type and language for a file, from its extension; anything unknown is shown as code. */
export function typeForPath(path: string): { type: ArtifactType; language: string | null } {
  const ext = /\.([^./\\]+)$/.exec(path)?.[1]?.toLowerCase();
  const type = ext ? EXTENSIONS[ext] : undefined;
  return type ? { type, language: null } : { type: 'code', language: ext ?? null };
}

const EXTENSIONS: Record<string, ArtifactType> = { html: 'html', htm: 'html', svg: 'svg', md: 'markdown', markdown: 'markdown', mmd: 'mermaid', mermaid: 'mermaid' };

/** Code's form: shows `file_path` (read through the session's workspace, so outside it is refused like Read). */
export function createArtifactTool(repo: ArtifactRepo, workspace: Workspace): Tool<FileArtifactInput>;
/** Chat's form: content the model writes. */
export function createArtifactTool(repo: ArtifactRepo, workspace?: null): Tool<ArtifactInput>;
export function createArtifactTool(repo: ArtifactRepo, workspace?: Workspace | null): Tool<ArtifactInput> | Tool<FileArtifactInput> {
  return workspace ? fileArtifactTool(repo, workspace) : contentArtifactTool(repo);
}

function fileArtifactTool(repo: ArtifactRepo, workspace: Workspace): Tool<FileArtifactInput> {
  return {
    name: 'artifact',
    readOnly: false,
    description: describeFile,
    compactExample: { file_path: '<path>' },
    inputSchema: {
      type: 'object',
      properties: {
        file_path: { type: 'string' },
      },
      required: ['file_path'],
      additionalProperties: false,
    },
    async run(input, ctx) {
      // A path copied from escaped text gets Atelier's tags back; the file itself is shown exactly as it is on disk.
      const path = unescapeTags(input.file_path);
      let content: string;
      try {
        const file = await workspace.runner.call('fs.read', { path }, { signal: ctx.signal });
        if (file.binary) return textOutput(`${path} is a binary file; an artifact shows text.`, true);
        if (file.truncated || file.content.length > MAX_CONTENT) return textOutput(`${path} is too large to show as an artifact.`, true);
        content = file.content;
      } catch (e) {
        return textOutput(`Couldn't read ${path}: ${e instanceof Error ? e.message : String(e)}`, true);
      }
      const identifier = artifactIdForPath(path);
      const existing = await repo.findByIdentifier(ctx.sessionId, identifier);
      if (!existing) {
        const { type, language } = typeForPath(path);
        const title = path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
        const summary = await repo.create({ sessionId: ctx.sessionId, identifier, type, title, language, content, messageId: ctx.messageId });
        ctx.emit({ type: 'artifact', artifact: summary });
        return textOutput(`Showing ${path} beside the conversation (version 1).`);
      }
      if ((await repo.latest(existing.id)).content === content) {
        // Nothing changed: the pane comes back to the front without a new version.
        const [summary] = (await repo.list(ctx.sessionId)).filter((a) => a.id === existing.id);
        if (summary) ctx.emit({ type: 'artifact', artifact: summary });
        return textOutput(`${path} is unchanged since version ${summary?.version ?? 1}, which is shown beside the conversation.`);
      }
      const summary = await repo.addVersion(existing, content, ctx.messageId);
      ctx.emit({ type: 'artifact', artifact: summary });
      return textOutput(`Showing ${path} beside the conversation (version ${summary.version}).`);
    },
  };
}

function contentArtifactTool(repo: ArtifactRepo): Tool<ArtifactInput> {
  return {
    name: 'artifact',
    readOnly: false,
    description: describe,
    inputSchema: {
      type: 'object',
      properties: {
        command: { type: 'string', enum: ['create', 'update', 'rewrite'] },
        identifier: { type: 'string', pattern: '^[a-z0-9][a-z0-9-]{0,63}$', description: 'Kebab-case name; a new one for create, the existing one for update and rewrite.' },
        type: { type: 'string', enum: ArtifactType.options },
        title: { type: 'string', maxLength: 120, description: 'Shown above the panel.' },
        language: { type: 'string', description: 'The programming language, when type is code.' },
        content: { type: 'string', description: 'The complete content, for create and rewrite.' },
        old: { type: 'string', description: 'For update: text that occurs exactly once in the latest version.' },
        new: { type: 'string', description: 'For update: the text that replaces `old`.' },
      },
      required: ['command', 'identifier'],
      additionalProperties: false,
    },
    async run(written, ctx) {
      // Code the model copies from the person's escaped text gets Atelier's tags back, as with Write and Edit.
      const back = (s: string | undefined) => (s === undefined ? undefined : unescapeTags(s));
      const input = { ...written, content: back(written.content), old: back(written.old), new: back(written.new) };
      const existing = await repo.findByIdentifier(ctx.sessionId, input.identifier);
      if (input.command === 'create') {
        if (existing) return textOutput(`An artifact "${input.identifier}" already exists. Use rewrite or update.`, true);
        // A type sent as `language` (gemma-4 sent `language: "html"` four times over) is the type it names.
        const type = ArtifactType.safeParse(input.type ?? (input.language && input.language !== 'code' ? input.language : undefined));
        if (!type.success || !input.title || input.content === undefined) {
          const missing = [!type.success && 'type', !input.title && 'title', input.content === undefined && 'content'].filter(Boolean).join(', ');
          return textOutput(`create needs type, title and content; missing or invalid: ${missing}. \`type\` is one of ${ArtifactType.options.join(', ')}.`, true);
        }
        if (input.content.length > MAX_CONTENT) return textOutput('Content is too large for an artifact.', true);
        const language = type.data === 'code' ? (input.language ?? null) : input.language && input.language !== type.data ? input.language : null;
        const summary = await repo.create({ sessionId: ctx.sessionId, identifier: input.identifier, type: type.data, title: input.title, language, content: input.content, messageId: ctx.messageId });
        ctx.emit({ type: 'artifact', artifact: summary });
        return textOutput(`Created artifact "${input.identifier}" (version 1).`);
      }
      if (!existing) return textOutput(`No artifact "${input.identifier}" exists yet. Use create.`, true);
      let content: string;
      if (input.command === 'update') {
        if (input.old === undefined || input.new === undefined) return textOutput('update needs old and new.', true);
        const current = (await repo.latest(existing.id)).content;
        const first = current.indexOf(input.old);
        if (first === -1) return textOutput('`old` was not found in the latest version. Copy it exactly, or use rewrite.', true);
        if (current.indexOf(input.old, first + 1) !== -1) return textOutput('`old` occurs more than once. Include more surrounding text so it is unique.', true);
        content = current.slice(0, first) + input.new + current.slice(first + input.old.length);
      } else {
        if (input.content === undefined) return textOutput('rewrite needs content.', true);
        content = input.content;
      }
      if (content.length > MAX_CONTENT) return textOutput('Content is too large for an artifact.', true);
      const type = input.type ? ArtifactType.safeParse(input.type) : undefined;
      const summary = await repo.addVersion(existing, content, ctx.messageId, {
        ...(input.title ? { title: input.title } : {}),
        ...(type?.success ? { type: type.data } : {}),
        ...(input.language ? { language: input.language } : {}),
      });
      ctx.emit({ type: 'artifact', artifact: summary });
      return textOutput(`Updated artifact "${input.identifier}" (version ${summary.version}).`);
    },
  };
}

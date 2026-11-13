/**
 * `Preview`: opens a web page in the desktop app's browser pane beside the conversation, as a browser would show it. A
 * page in the workspace is served with the files around it (styles, scripts, images, other pages, by their relative
 * links; apps/desktop/src/workspace-pages.ts), so a site needs no bundling into one file; an address (a dev server, a
 * docs page) opens as it is. Nothing is stored: the app opens what a successful call names, or reloads it when it is
 * already open (packages/ui/src/features/code/shown-pages.ts). Offered only while the person writes from the desktop
 * app, which has the pane.
 */
import { pageAddress, PREVIEW_IN_PANE, PREVIEW_OPENED } from '@atelier/protocol';
import type { Workspace } from '../workspaces/workspace.ts';
import { unescapeTags } from '../prompts/escape.ts';
import { textOutput, type DescribeContext, type Tool } from './types.ts';

export interface PreviewInput {
  page: string;
}

/** `path` from `root`, with forward slashes, when it is inside it (the runner's paths may be Windows ones). */
export function insideRoot(path: string, root: string): string | null {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
  const [file, base] = [norm(path), norm(root)];
  const windows = /^[a-z]:\//i.test(base);
  const same = (a: string, b: string) => (windows ? a.toLowerCase() === b.toLowerCase() : a === b);
  if (!same(file.slice(0, base.length), base) || file[base.length] !== '/') return null;
  return file.slice(base.length + 1) || null;
}

function describe({ tier }: DescribeContext): string {
  if (tier === 'compact') return 'Opens a web page in the browser pane beside the chat: an .html file in the workspace (its styles, scripts and images load from beside it, no bundling) or an address such as http://localhost:5173. Call it again after a change to reload.';
  return [
    'Opens a web page in the browser pane beside the conversation, where the person sees it as a browser shows it.',
    '- `page`: an `.html` file in the workspace (relative to the root, or absolute; a folder opens its index.html), or an address such as `http://localhost:5173` for a dev server you started or a page on the web.',
    '- A workspace page loads the files beside it by their relative links (stylesheets, scripts, images, fonts, other pages) as they are on disk, and may load from the web. Build a site as separate files as usual; there is no need to put it in one file.',
    '- It shows what is saved: after a change, call it again and the page reloads in its tab.',
    '- Pages run without storage or cookies. Plain `<script src>` works; ES modules (`type="module"`) and `fetch()` of the page’s own files don’t, so for a site built with them start its dev server and open the address.',
  ].join('\n');
}

export function createPreviewTool(workspace: Workspace): Tool<PreviewInput> {
  return {
    name: 'Preview',
    // It opens a page in the person's own pane; nothing in the workspace or elsewhere changes.
    readOnly: true,
    description: describe,
    compactExample: { page: 'site/index.html' },
    inputSchema: {
      type: 'object',
      properties: {
        page: { type: 'string', description: 'An .html file in the workspace, or an address such as http://localhost:5173.' },
      },
      required: ['page'],
      additionalProperties: false,
    },
    async run(input, ctx) {
      const page = unescapeTags(input.page).trim();
      if (!page) return textOutput('Name a page: an .html file in the workspace, or an address.', true);
      const url = pageAddress(page);
      if (url) return textOutput(`${PREVIEW_OPENED}${url}${PREVIEW_IN_PANE}.`);
      if (/^[a-z][a-z\d+.-]*:\/\//i.test(page)) return textOutput(`${page} isn't an address the browser pane opens: use http:// or https://.`, true);
      let found;
      try {
        found = await workspace.runner.call('fs.stat', { path: page }, { signal: ctx.signal });
        if (found.type === 'dir') found = await workspace.runner.call('fs.stat', { path: `${found.path.replace(/[\\/]+$/, '')}/index.html` }, { signal: ctx.signal });
      } catch (e) {
        return textOutput(`Couldn't open ${page}: ${e instanceof Error ? e.message : String(e)}`, true);
      }
      if (found.type !== 'file') return textOutput(`${page} is not a file.`, true);
      const path = insideRoot(found.path, workspace.root);
      if (!path) return textOutput(`${page} is outside the workspace (${workspace.root}); the browser pane shows the workspace's own files.`, true);
      return textOutput(`${PREVIEW_OPENED}${path}${PREVIEW_IN_PANE}, with the files beside it as they are on disk. After a change, call Preview again to reload it.`);
    },
  };
}

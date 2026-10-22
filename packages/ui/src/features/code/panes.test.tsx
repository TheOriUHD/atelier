import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, renderHook, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { File, FileCode, FileImage, FileJson, FileLock, FileText } from 'lucide-react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { artifactIdForPath, type ArtifactSummary, type Message, type ToolCallPart } from '@atelier/protocol';
import { TooltipProvider } from '../../components/ui/index.ts';
import { callsTo, resetBackend } from '../settings/test-backend.ts';
import { ArtifactCard, ArtifactPaneContext } from '../chat/artifact-card.tsx';
import { Markdown, OpenFilePath, looksLikePath } from '../chat/markdown.tsx';
import { ArtifactPane, shownArtifact, useShownArtifacts } from './artifact-pane.tsx';
import { BrowserPane, addressUrl } from './browser-pane.tsx';
import { DiffView, compareOptions } from './diff-review.tsx';
import { FilesPane, fileIcon, parseFilter, type OpenFiles } from './file-tree.tsx';
import { PaneButtons } from './pane-buttons.tsx';
import { PaneFrame, type PaneFrameState } from './pane-dock.tsx';
import { PlanPane, latestPlan } from './plan-pane.tsx';
import { planComments } from './plan-comments.ts';

vi.mock('../../lib/platform.ts', async (importOriginal) => ({ ...(await importOriginal<object>()), artifactRuntimeUrl: () => 'about:blank' }));
vi.mock('../../lib/rpc.ts', async (importOriginal) => {
  const { fakeRpc } = await import('../settings/test-backend.ts');
  return { ...(await importOriginal<object>()), rpc: () => fakeRpc };
});

const wrap = (children: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <TooltipProvider>{children}</TooltipProvider>
  </QueryClientProvider>
);

const frame = (pane: PaneFrameState['pane']): PaneFrameState => ({ pane, style: {}, hidden: false, maximized: false, canMaximize: true, others: 1, sheet: false, dispatch: () => {}, close: () => {} });

beforeEach(() => resetBackend({}));

describe('a pane as a sheet (too narrow for a dock)', () => {
  it('is the whole body edge to edge, not a rounded card with a shadow over the transcript', () => {
    render(wrap(<PaneFrame frame={{ ...frame('terminal'), sheet: true, canMaximize: false }} title="Terminal">body</PaneFrame>));
    const pane = screen.getByRole('region', { name: 'Terminal' });
    expect(pane.className).toContain('rounded-none');
    expect(pane.className).toContain('border-0');
    expect(pane.className).not.toContain('shadow-panel');
  });
});

describe('the header’s pane buttons', () => {
  it('toggle their panes, show which are open, and offer More', () => {
    const onToggle = vi.fn();
    const onOpen = vi.fn();
    const keepAwake = { on: false, set: vi.fn() };
    render(
      wrap(
        <PaneButtons
          open={new Set(['diff'])}
          available={['terminal', 'diff', 'files', 'tasks', 'plan']}
          onToggle={onToggle}
          onOpen={onOpen}
          runningTasks={2}
          keepAwake={keepAwake}
          buttonRef={() => () => {}}
        />,
      ),
    );
    // No Browser where it isn't available (a web browser).
    expect(screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Terminal', 'Diff', 'Files', 'More']);
    expect(screen.getByRole('button', { name: 'Diff' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Terminal' }).getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(screen.getByRole('button', { name: 'Terminal' }));
    expect(onToggle).toHaveBeenCalledWith('terminal');
  });
});

describe('the compare selector', () => {
  it('offers the working tree against HEAD, staged, the default branch and the session', () => {
    expect(compareOptions({ repo: true, branch: 'feature', defaultBranch: 'main' }).map((o) => [o.value, o.label])).toEqual([
      ['head', 'feature → working tree'],
      ['staged', 'feature → staged'],
      ['base', 'main → working tree'],
      ['session', 'Session start → working tree'],
    ]);
    // On the default branch itself there is nothing to compare it with; detached, HEAD.
    expect(compareOptions({ repo: true, branch: 'main', defaultBranch: 'main' }).map((o) => o.value)).toEqual(['head', 'staged', 'session']);
    expect(compareOptions({ repo: true, branch: null, defaultBranch: null })[0]!.label).toBe('HEAD → working tree');
    expect(compareOptions({ repo: false, branch: null, defaultBranch: null }).map((o) => o.value)).toEqual(['session']);
  });

  const NEW_FILE = 'diff --git a/b.ts b/b.ts\nnew file mode 100644\n--- /dev/null\n+++ b/b.ts\n@@ -0,0 +1 @@\n+export {};\n';

  it('shows what is staged without Reject, and asks for that compare', async () => {
    resetBackend({
      'workspaces.gitStatus': () => ({ branch: 'main', upstream: null, files: [{ path: 'b.ts', status: 'added', staged: true }, { path: 'c.ts', status: 'modified', staged: false }] }),
      'workspaces.diff': () => ({ diff: NEW_FILE, truncated: false, base: 'HEAD' }),
    });
    render(wrap(<DiffView workspaceId="w1" compare="staged" />));
    const card = await screen.findByRole('region', { name: 'b.ts' });
    expect(within(card).getByText('A')).toBeTruthy();
    expect(within(card).queryByRole('button', { name: 'Reject' })).toBeNull();
    expect(screen.queryByRole('region', { name: 'c.ts' })).toBeNull();
    expect(callsTo('workspaces.diff')).toEqual([{ workspaceId: 'w1', compare: 'staged' }]);
  });

  it('shows a session’s own changes outside a repository, and an empty state', async () => {
    resetBackend({ 'workspaces.gitStatus': () => null, 'workspaces.diff': () => ({ diff: NEW_FILE, truncated: false, base: null }) });
    const { unmount } = render(wrap(<DiffView workspaceId="w1" sessionId="s1" compare="session" showFiles />));
    expect(await screen.findByRole('region', { name: 'b.ts' })).toBeTruthy();
    expect(within(screen.getByRole('navigation', { name: 'Changed files' })).getByRole('button', { name: /b\.ts/ })).toBeTruthy();
    expect(screen.queryByRole('textbox', { name: 'Commit message' })).toBeNull();
    expect(callsTo('workspaces.diff')).toEqual([{ workspaceId: 'w1', compare: 'session', sessionId: 's1' }]);
    unmount();
    resetBackend({ 'workspaces.gitStatus': () => null, 'workspaces.diff': () => ({ diff: '', truncated: false, base: null }) });
    render(wrap(<DiffView workspaceId="w1" sessionId="s1" compare="session" />));
    expect(await screen.findByText('No changes to show')).toBeTruthy();
  });
});

describe('the Files pane', () => {
  it('reads the filter: names, `?` for contents, or the tree', () => {
    expect(parseFilter('')).toEqual({ kind: 'tree' });
    expect(parseFilter('  app ')).toEqual({ kind: 'names', query: 'app' });
    expect(parseFilter('?todo later')).toEqual({ kind: 'contents', query: 'todo later' });
    expect(parseFilter('? ')).toEqual({ kind: 'tree' });
  });

  it('gives files an icon by their type', () => {
    expect(fileIcon('app.tsx')).toBe(FileCode);
    expect(fileIcon('package.json')).toBe(FileJson);
    expect(fileIcon('README.md')).toBe(FileText);
    expect(fileIcon('logo.png')).toBe(FileImage);
    expect(fileIcon('pnpm-lock.yaml')).toBe(FileLock);
    expect(fileIcon('notes')).toBe(File);
  });

  const workspace = { id: 'w1', kind: 'local' as const, name: 'repo', root: '/repo', host: null, deviceId: null, available: true, scratch: false, lastUsedAt: 0 };

  function setup(files: OpenFiles = { paths: [], active: null }) {
    resetBackend({
      'workspaces.files': () => [
        { name: 'src', path: 'src', kind: 'dir', size: 0 },
        { name: 'README.md', path: 'README.md', kind: 'file', size: 7 },
      ],
      'workspaces.findFiles': ({ query }: { query: string }) => (query === 'app' ? ['src/app.ts'] : []),
      'workspaces.grep': () => ({ matches: [{ path: 'src/app.ts', line: 3, text: 'export const answer = 42;' }], truncated: false }),
      'workspaces.readFile': ({ path }: { path: string }) => ({ path, content: 'export const answer = 42;\n', truncated: false, size: 26 }),
    });
    const onFiles = vi.fn();
    const view = render(wrap(<FilesPane frame={frame('files')} workspace={workspace} files={files} onFiles={onFiles} />));
    return { onFiles, view };
  }

  it('shows the tree and an empty viewer until a file is open', async () => {
    setup();
    expect(await screen.findByRole('button', { name: 'README.md' })).toBeTruthy();
    expect(screen.getByText('Open files appear here')).toBeTruthy();
    expect(screen.getByText('Pick a file in the tree, or click a file path in the conversation.')).toBeTruthy();
  });

  it('filters by name and searches contents after `?`, opening at the line found', async () => {
    const { onFiles } = setup();
    const filter = screen.getByRole('textbox', { name: 'Filter files' });
    fireEvent.change(filter, { target: { value: 'app' } });
    fireEvent.click(await within(await screen.findByRole('list', { name: 'Matching files' })).findByRole('button', { name: /app\.ts/ }));
    expect(onFiles).toHaveBeenLastCalledWith({ paths: ['src/app.ts'], active: 'src/app.ts' });

    fireEvent.change(filter, { target: { value: '?answer' } });
    const results = await screen.findByRole('group', { name: 'Search results' });
    fireEvent.click(within(results).getByRole('button', { name: /export const answer/ }));
    expect(onFiles).toHaveBeenLastCalledWith({ paths: ['src/app.ts'], active: 'src/app.ts', line: 3 });
    expect(callsTo('workspaces.grep')).toEqual([{ workspaceId: 'w1', query: 'answer' }]);
    // The search button starts a content search.
    fireEvent.change(filter, { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search in files' }));
    expect((filter as HTMLInputElement).value).toBe('?');
  });

  it('shows open files in tabs and closes them', async () => {
    const { onFiles } = setup({ paths: ['README.md', 'src/app.ts'], active: 'src/app.ts' });
    const open = within(screen.getByRole('group', { name: 'Open files' }));
    expect(open.getByRole('button', { name: 'app.ts' }).getAttribute('aria-current')).toBe('true');
    expect(open.getByRole('button', { name: 'README.md' }).getAttribute('aria-current')).toBeNull();
    await waitFor(() => expect(screen.getByRole('region', { name: 'src/app.ts' }).textContent).toContain('export const answer = 42;'));
    fireEvent.click(screen.getByRole('button', { name: 'Close app.ts' }));
    expect(onFiles).toHaveBeenCalledWith({ paths: ['README.md'], active: 'README.md' });
  });
});

describe('file paths in the conversation', () => {
  it('reads inline code as a path when it names a folder or a file type', () => {
    for (const path of ['src/app.ts', 'package.json', 'README.md', '.github/workflows/ci.yml', 'docs/'.concat('guide')]) expect(looksLikePath(path)).toBe(true);
    for (const text of ['console.log', 'npm run dev', 'a.b()', 'https://example.com/x', '...', 'useState']) expect(looksLikePath(text)).toBe(false);
  });

  it('opens a path in Files when a Code page offers it', async () => {
    const open = vi.fn();
    render(
      <OpenFilePath.Provider value={open}>
        <Markdown text="See `src/app.ts` and `npm test`." streaming={false} />
      </OpenFilePath.Provider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'src/app.ts' }));
    expect(open).toHaveBeenCalledWith('src/app.ts');
    expect(screen.queryByRole('button', { name: 'npm test' })).toBeNull();
  });
});

describe('the Browser pane’s tabs', () => {
  it('stop at 20', () => {
    render(wrap(<BrowserPane frame={frame('browser')} />));
    const tabs = within(screen.getByRole('group', { name: 'Browser tabs' }));
    for (let i = 0; i < 25; i++) fireEvent.click(tabs.getAllByRole('button', { name: 'New tab' }).at(-1)!);
    // Every blank tab is called "New tab", as is the + after them.
    expect(tabs.getAllByRole('button', { name: 'New tab' })).toHaveLength(20 + 1);
  });
});

describe('the Browser pane’s address field', () => {
  it('takes local dev servers over http and other hosts over https, and nothing but the web', () => {
    expect(addressUrl('localhost:3000')).toBe('http://localhost:3000/');
    expect(addressUrl(':5173/docs')).toBe('http://localhost:5173/docs');
    expect(addressUrl('127.0.0.1:8080')).toBe('http://127.0.0.1:8080/');
    expect(addressUrl('app.test')).toBe('http://app.test/');
    expect(addressUrl('docs.example.com/guide')).toBe('https://docs.example.com/guide');
    expect(addressUrl('https://example.com')).toBe('https://example.com/');
    for (const typed of ['file:///etc/passwd', 'javascript:alert(1)', 'chrome://settings', 'hello world', 'plainword', '']) expect(addressUrl(typed)).toBeNull();
  });
});

describe('the Plan pane', () => {
  const message = (id: string, role: Message['role'], parts: Message['parts']): Message => ({
    id,
    sessionId: 's',
    parentId: null,
    role,
    parts,
    model: null,
    usage: null,
    stopReason: null,
    error: null,
    kind: 'normal',
    summarizesThroughId: null,
    createdAt: 0,
  });
  const plan = (id: string, text: string) => message(id, 'assistant', [{ type: 'tool_call', id: `c-${id}`, name: 'ExitPlanMode', input: { plan: text } }]);
  const answer = (id: string, isError: boolean) => message(`r-${id}`, 'tool', [{ type: 'tool_result', callId: `c-${id}`, content: [{ type: 'text', text: '' }], ...(isError ? { isError } : {}) }]);

  it('shows the newest plan and whether it was approved', () => {
    expect(latestPlan([])).toBeNull();
    expect(latestPlan([plan('a', 'First'), answer('a', true), plan('b', 'Second')])).toEqual({ plan: 'Second', status: 'waiting' });
    expect(latestPlan([plan('a', 'First'), answer('a', true)])).toEqual({ plan: 'First', status: 'declined' });
    expect(latestPlan([plan('a', 'First'), answer('a', false), message('x', 'assistant', [{ type: 'text', text: 'Done' }])])).toEqual({ plan: 'First', status: 'approved' });
  });

  it('offers a comment on selected text while the plan waits, and keeps it until the plan is answered', async () => {
    planComments.clear('s');
    render(wrap(<PlanPane frame={frame('plan')} sessionId="s" messages={[plan('a', '## Steps\n\nWrite the failing test first.')]} todos={[]} running={false} />));
    expect(screen.getByText('Select any text to leave a comment for Atelier')).toBeTruthy();
    const passage = screen.getByText('Write the failing test first.');
    const range = document.createRange();
    range.selectNodeContents(passage);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    fireEvent.mouseUp(passage);
    fireEvent.click(await screen.findByRole('button', { name: 'Comment' }));
    fireEvent.change(screen.getByRole('textbox', { name: 'Your comment' }), { target: { value: 'Name the file too' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));
    expect(planComments.get('s').map((c) => [c.quote, c.text])).toEqual([['Write the failing test first.', 'Name the file too']]);
    expect(screen.getByRole('region', { name: 'Your comments' }).textContent).toContain('Name the file too');
    fireEvent.click(screen.getByRole('button', { name: 'Remove comment' }));
    expect(planComments.get('s')).toEqual([]);
  });

  it('shows a plan that was answered without the comment hint', () => {
    render(wrap(<PlanPane frame={frame('plan')} sessionId="s" messages={[plan('a', 'First'), answer('a', false)]} todos={[]} running={false} />));
    expect(screen.queryByText('Select any text to leave a comment for Atelier')).toBeNull();
    expect(screen.getByText('Approved')).toBeTruthy();
  });
});

describe('the Artifact pane', () => {
  const summary = (id: string, version: number, updatedAt: number, extra: Partial<ArtifactSummary> = {}): ArtifactSummary => ({
    id,
    sessionId: 's',
    identifier: `${id}-html`,
    type: 'html',
    title: `${id}.html`,
    language: null,
    version,
    versions: version,
    updatedAt,
    ...extra,
  });

  it('opens for each artifact the session shows after it loaded, and only then', () => {
    const onShow = vi.fn();
    const page = summary('page', 1, 1);
    const { rerender } = renderHook(({ artifacts, loaded }) => useShownArtifacts(artifacts, loaded, onShow), {
      initialProps: { artifacts: {} as Record<string, ArtifactSummary>, loaded: false },
    });
    // The artifacts a session already had when it loaded don't open the pane.
    rerender({ artifacts: { page }, loaded: true });
    expect(onShow).not.toHaveBeenCalled();
    const v2 = summary('page', 2, 5);
    rerender({ artifacts: { page: v2 }, loaded: true });
    expect(onShow).toHaveBeenLastCalledWith(v2);
    // Nothing new (the person closed the pane in between): it stays closed.
    rerender({ artifacts: { page: v2 }, loaded: true });
    expect(onShow).toHaveBeenCalledTimes(1);
    // The same file shown again (a new summary from the event) brings it back, the newest first when several changed.
    const chart = summary('chart', 1, 9);
    rerender({ artifacts: { page: { ...v2 }, chart }, loaded: true });
    expect(onShow).toHaveBeenCalledTimes(2);
    expect(onShow).toHaveBeenLastCalledWith(chart);
  });

  it('shows the chosen artifact or the one changed last, with its versions, a preview or the code, and an empty state', async () => {
    const page = summary('page', 2, 1);
    const notes = summary('notes', 1, 3, { type: 'markdown', title: 'notes.md' });
    expect(shownArtifact({ page, notes }, null)).toBe(notes);
    expect(shownArtifact({ page, notes }, 'page')).toBe(page);
    expect(shownArtifact({ page, notes }, 'gone')).toBe(notes);
    expect(shownArtifact({}, null)).toBeUndefined();

    resetBackend({ 'artifacts.get': (input) => ({ ...page, content: { version: (input as { version?: number }).version ?? 2, content: '<h1>Landing</h1>', createdAt: 0 } }) });
    const onState = vi.fn();
    const state = { artifactId: 'page', version: null, view: 'preview' as const };
    const { rerender } = render(wrap(<ArtifactPane frame={frame('artifact')} artifacts={{ page, notes }} state={state} onState={onState} />));
    const pane = screen.getByRole('region', { name: 'Artifact' });
    await waitFor(() => expect(within(pane).getByText('v2/2')).toBeTruthy());
    expect(within(pane).getByRole('heading', { name: 'page.html' })).toBeTruthy();
    expect(pane.querySelector('iframe')).toBeTruthy();
    fireEvent.click(within(pane).getByRole('button', { name: 'Previous version' }));
    expect(onState).toHaveBeenCalledWith({ version: 1 });
    fireEvent.click(within(pane).getByRole('radio', { name: 'Code' }));
    expect(onState).toHaveBeenCalledWith({ view: 'code' });
    rerender(wrap(<ArtifactPane frame={frame('artifact')} artifacts={{ page, notes }} state={{ ...state, view: 'code' }} onState={onState} />));
    await waitFor(() => expect(pane.querySelector('iframe')).toBeNull());
    expect(callsTo('artifacts.get')).toContainEqual({ id: 'page', version: 2 });

    rerender(wrap(<ArtifactPane frame={frame('artifact')} artifacts={{}} state={state} onState={onState} />));
    expect(screen.getByText(/Nothing to show yet/)).toBeTruthy();
  });

  it('lets the transcript card show and hide its artifact in the pane', () => {
    const page = summary('page', 1, 1, { identifier: artifactIdForPath('site/index.html'), title: 'index.html' });
    const call: ToolCallPart = { type: 'tool_call', id: 'c1', name: 'artifact', input: { file_path: 'site/index.html' } };
    const toggle = vi.fn();
    const card = (shown: string | null) =>
      wrap(
        <ArtifactPaneContext.Provider value={{ shown, toggle }}>
          <ArtifactCard sessionId="s" call={call} artifacts={{ page }} status="done" partialInput={undefined} />
        </ArtifactPaneContext.Provider>,
      );
    const { rerender } = render(card(null));
    const button = screen.getByRole('button', { name: /index\.html/ });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(button);
    expect(toggle).toHaveBeenCalledWith('page');
    rerender(card('page'));
    expect(screen.getByRole('button', { name: /index\.html/ }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('Hide')).toBeTruthy();
  });
});

/**
 * The Files pane (design/components.md › FileTree, FileViewer): a filter over the workspace tree (plain text matches
 * file names; `?` and a phrase searches inside files), the tree loaded one directory at a time with an icon per file
 * type, and beside it the files you open, in tabs, read-only and highlighted (Work's file previews show the same
 * view). Clicking a file path in the conversation opens it here. Files and folders have a right-click menu (file-menu.tsx).
 */
import { useDeferredValue, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  ChevronRight,
  File,
  FileArchive,
  FileCode,
  FileCog,
  FileImage,
  FileJson,
  FileLock,
  FileSpreadsheet,
  FileTerminal,
  FileText,
  Folder,
  FolderOpen,
  FoldVertical,
  RefreshCw,
  Search,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { WorkspaceSummary } from '@atelier/protocol';
import { Icon, IconButton, MenuItem, Spinner, TextField, cn } from '../../components/ui/index.ts';
import { keys, useFindFiles, useWorkspaceFile, useWorkspaceFiles, useWorkspaceGrep } from '../../lib/queries.ts';
import { describeError } from '../../lib/rpc.ts';
import { CodePre, useHighlightedLines } from '../chat/code-block.tsx';
import { CopyButton } from '../chat/copy-button.tsx';
import { Markdown } from '../chat/markdown.tsx';
import { formatBytes } from '../chat/composer.tsx';
import { PaneFrame, PaneTitle, type PaneFrameState } from './pane-dock.tsx';
import { languageOf } from './paths.ts';
import { useFileMenu, type FileActions, type FileTarget } from './file-menu.tsx';

export function PaneMessage({ children, error }: { children: ReactNode; error?: boolean }) {
  return (
    <p role={error ? 'alert' : undefined} className={cn('px-4 py-6 text-center text-body', error ? 'text-danger-text' : 'text-fg-muted')}>
      {children}
    </p>
  );
}

/** The files open in the pane, and the one shown (with a line to scroll to, from a search result). */
export interface OpenFiles {
  paths: string[];
  active: string | null;
  line?: number;
}

const EXTENSION_ICONS: [RegExp, LucideIcon][] = [
  [/\.(ts|tsx|js|jsx|mjs|cjs|go|py|rb|rs|java|kt|swift|c|h|cc|cpp|hpp|cs|php|lua|vue|svelte|html|css|scss|sql)$/, FileCode],
  [/\.(json|jsonc|json5)$/, FileJson],
  [/\.(md|mdx|txt|rst|adoc)$|^(readme|license|changelog)/, FileText],
  [/\.(png|jpe?g|gif|webp|avif|svg|ico|bmp)$/, FileImage],
  [/\.(csv|tsv|xlsx?)$/, FileSpreadsheet],
  [/\.(zip|tar|gz|tgz|bz2|xz|7z|rar)$/, FileArchive],
  [/\.(sh|bash|zsh|fish|ps1)$/, FileTerminal],
  [/\.lock$|lock\.(json|yaml)$/, FileLock],
  [/\.(ya?ml|toml|ini|env|conf|cfg)$|^\.|^(dockerfile|makefile)$/, FileCog],
];

/** The outline glyph for a file, by its name. */
export function fileIcon(name: string): LucideIcon {
  const lower = name.toLowerCase();
  return EXTENSION_ICONS.find(([re]) => re.test(lower))?.[1] ?? File;
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);
const dirName = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf('/')));

/** What the filter field asks for: names matching some text, a search inside files (`?`), or the tree. */
export function parseFilter(value: string): { kind: 'tree' } | { kind: 'names'; query: string } | { kind: 'contents'; query: string } {
  if (value.startsWith('?')) {
    const query = value.slice(1).trim();
    return query ? { kind: 'contents', query } : { kind: 'tree' };
  }
  const query = value.trim();
  return query ? { kind: 'names', query } : { kind: 'tree' };
}

export function FilesPane({
  frame,
  workspace,
  files,
  onFiles,
  onOpenInBrowser,
  onAttach,
  onOpenTerminal,
}: {
  frame: PaneFrameState;
  workspace: WorkspaceSummary | undefined;
  files: OpenFiles;
  onFiles(files: OpenFiles): void;
} & Omit<FileActions, 'workspace'>) {
  const qc = useQueryClient();
  const usable = workspace?.available ? workspace : null;
  const [filter, setFilter] = useState('');
  // Kept here so the tree comes back as it was after a search.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const field = useRef<HTMLInputElement>(null);
  const open = (path: string, line?: number) => onFiles({ paths: files.paths.includes(path) ? files.paths : [...files.paths, path], active: path, ...(line ? { line } : {}) });
  const close = (path: string) => {
    const paths = files.paths.filter((p) => p !== path);
    const at = files.paths.indexOf(path);
    onFiles({ paths, active: files.active === path ? (paths[Math.max(0, at - 1)] ?? null) : files.active });
  };

  return (
    <PaneFrame
      frame={frame}
      title="Files"
      start={
        <>
          <PaneTitle>Files</PaneTitle>
          {usable && (
            <IconButton
              icon={Search}
              label="Search in files"
              size="xs"
              className="text-fg-secondary"
              onClick={() => {
                if (!filter.startsWith('?')) setFilter(`?${filter}`);
                field.current?.focus();
              }}
            />
          )}
        </>
      }
      menu={
        usable && (
          <>
            <MenuItem icon={RefreshCw} onClick={() => void qc.invalidateQueries({ queryKey: keys.workspace(usable.id) })}>
              Refresh
            </MenuItem>
            <MenuItem icon={FoldVertical} disabled={expanded.size === 0} onClick={() => setExpanded(new Set())}>
              Collapse folders
            </MenuItem>
          </>
        )
      }
    >
      {!usable ? (
        <PaneMessage>{workspace ? 'This folder’s computer is offline.' : 'This session has no folder.'}</PaneMessage>
      ) : (
        <div className="@container flex min-h-0 flex-1 flex-col">
          <div className="flex min-h-0 flex-1 flex-col @min-[34rem]:flex-row">
            <div className="flex min-h-0 shrink-0 basis-[45%] flex-col border-line-subtle @max-[34rem]:border-b @min-[34rem]:w-[min(40%,280px)] @min-[34rem]:basis-auto @min-[34rem]:border-r">
              <div className="shrink-0 p-2 pb-1">
                <TextField
                  ref={field}
                  aria-label="Filter files"
                  placeholder="Filter, or ? to search in files"
                  value={filter}
                  maxLength={201}
                  onChange={(e) => setFilter(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Escape' && filter) {
                      e.stopPropagation();
                      setFilter('');
                    }
                  }}
                  className="h-7 text-control-sm"
                />
              </div>
              <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
                <Browse
                  workspaceId={usable.id}
                  filter={filter}
                  expanded={expanded}
                  active={files.active}
                  onToggle={(dir) =>
                    setExpanded((s) => {
                      const next = new Set(s);
                      if (!next.delete(dir)) next.add(dir);
                      return next;
                    })
                  }
                  onOpen={open}
                  actions={{ workspace: usable, onOpenInBrowser, onAttach, onOpenTerminal }}
                />
              </div>
            </div>
            <Viewer workspaceId={usable.id} files={files} onActivate={(path) => onFiles({ ...files, active: path, line: undefined })} onClose={close} />
          </div>
        </div>
      )}
    </PaneFrame>
  );
}

interface BrowseProps {
  workspaceId: string;
  filter: string;
  expanded: ReadonlySet<string>;
  active: string | null;
  onToggle(dir: string): void;
  onOpen(path: string, line?: number): void;
  actions: FileActions;
}

/** The tree, or what the filter found. */
function Browse({ filter, ...props }: BrowseProps) {
  // Typing stays quick; the search follows a moment behind.
  const what = parseFilter(useDeferredValue(filter));
  if (what.kind === 'names') return <NameResults {...props} query={what.query} />;
  if (what.kind === 'contents') return <ContentResults {...props} query={what.query} />;
  return <Entries {...props} dir="" depth={0} />;
}

/** Rows 28 tall, indented 12px per level, icon 16, 13/19. */
const rowClass =
  'flex h-7 w-full items-center gap-1.5 rounded-md pr-2 text-left text-control-sm text-fg-secondary outline-none focus-ring hover:bg-fill-ghost-hover hover:text-fg aria-[current=true]:bg-fill-ghost-selected aria-[current=true]:text-fg';

function Entries({ workspaceId, dir, depth, expanded, active, onToggle, onOpen, actions }: Omit<BrowseProps, 'filter'> & { dir: string; depth: number }) {
  const { data, error } = useWorkspaceFiles(workspaceId, dir);
  if (error) return <PaneMessage error>{describeError(error).message}</PaneMessage>;
  if (!data) return <Spinner label="Loading files" className="m-2 text-fg-muted" />;
  if (data.length === 0 && depth === 0) return <PaneMessage>This folder is empty.</PaneMessage>;
  const indent = { paddingLeft: 4 + depth * 12 };
  return (
    <ul>
      {data.map((entry) => (
        <li key={entry.path}>
          {entry.kind === 'dir' ? (
            <>
              <Row
                target={{ path: entry.path, kind: 'dir' }}
                actions={actions}
                aria-expanded={expanded.has(entry.path)}
                onClick={() => onToggle(entry.path)}
                className={rowClass}
                style={indent}
              >
                <Icon icon={ChevronRight} className={cn('size-3.5 text-fg-muted transition-transform duration-(--at-duration-snap)', expanded.has(entry.path) && 'rotate-90')} />
                <Icon icon={expanded.has(entry.path) ? FolderOpen : Folder} className="text-fg-muted" />
                <span className="truncate">{entry.name}</span>
              </Row>
              {expanded.has(entry.path) && <Entries {...{ workspaceId, expanded, active, onToggle, onOpen, actions }} dir={entry.path} depth={depth + 1} />}
            </>
          ) : (
            <Row
              target={{ path: entry.path, kind: 'file' }}
              actions={actions}
              aria-current={active === entry.path}
              onClick={() => onOpen(entry.path)}
              className={rowClass}
              style={indent}
            >
              <span className="w-3.5 shrink-0" />
              <Icon icon={fileIcon(entry.name)} className="text-fg-muted" />
              <span className="truncate">{entry.name}</span>
            </Row>
          )}
        </li>
      ))}
    </ul>
  );
}

function NameResults({ workspaceId, query, active, onOpen, actions }: Omit<BrowseProps, 'filter'> & { query: string }) {
  const { data, error } = useFindFiles(workspaceId, query);
  if (error) return <PaneMessage error>{describeError(error).message}</PaneMessage>;
  if (!data) return <Spinner label="Finding files" className="m-2 text-fg-muted" />;
  if (!data.length) return <PaneMessage>No file names match “{query}”.</PaneMessage>;
  return (
    <ul aria-label="Matching files">
      {data.map((path) => (
        <li key={path}>
          <Row target={{ path, kind: 'file' }} actions={actions} aria-current={active === path} onClick={() => onOpen(path)} className={cn(rowClass, 'pl-1')}>
            <Icon icon={fileIcon(baseName(path))} className="text-fg-muted" />
            <span className="shrink-0">{baseName(path)}</span>
            <span className="min-w-0 truncate text-fg-muted">{dirName(path)}</span>
          </Row>
        </li>
      ))}
    </ul>
  );
}

function ContentResults({ workspaceId, query, onOpen, actions }: Omit<BrowseProps, 'filter'> & { query: string }) {
  const { data, error, isFetching } = useWorkspaceGrep(workspaceId, query);
  if (error) return <PaneMessage error>{describeError(error).message}</PaneMessage>;
  if (!data) return <Spinner label="Searching in files" className="m-2 text-fg-muted" />;
  if (!data.matches.length) return <PaneMessage>{isFetching ? 'Searching…' : `No files contain “${query}”.`}</PaneMessage>;
  const byFile = Map.groupBy(data.matches, (m) => m.path);
  return (
    <div aria-label="Search results" role="group" className="flex flex-col gap-1">
      {[...byFile].map(([path, matches]) => (
        <section key={path} aria-label={path}>
          <ResultFile path={path} count={matches.length} actions={actions} />
          <ul>
            {matches.map((m) => (
              <li key={m.line}>
                <button type="button" onClick={() => onOpen(path, m.line)} className={cn(rowClass, 'h-auto min-h-7 items-start py-1 pl-6 font-mono text-code')}>
                  <span className="w-8 shrink-0 text-right text-fg-muted tabular-nums">{m.line}</span>
                  <span className="min-w-0 truncate">{m.text.trim()}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {data.truncated && <PaneMessage>Only the first matches are shown; search for something longer.</PaneMessage>}
    </div>
  );
}

/** A file or folder in the tree or the names found: a button with the right-click menu. */
function Row({
  target,
  actions,
  onClick,
  className,
  style,
  children,
  ...aria
}: {
  target: FileTarget;
  actions: FileActions;
  onClick(): void;
  className: string;
  style?: CSSProperties;
  children: ReactNode;
  'aria-current'?: boolean;
  'aria-expanded'?: boolean;
}) {
  const { onContextMenu, onKeyDown, menu } = useFileMenu(target, actions);
  return (
    <>
      <button type="button" {...aria} onClick={onClick} onContextMenu={onContextMenu} onKeyDown={onKeyDown} className={className} style={style}>
        {children}
      </button>
      {menu}
    </>
  );
}

/** A file's heading over its matching lines, with the same right-click menu. */
function ResultFile({ path, count, actions }: { path: string; count: number; actions: FileActions }) {
  const { onContextMenu, menu } = useFileMenu({ path, kind: 'file' }, actions);
  return (
    <div onContextMenu={onContextMenu} className="flex h-7 items-center gap-1.5 px-1 text-control-sm text-fg">
      <Icon icon={fileIcon(baseName(path))} className="text-fg-muted" />
      <span className="truncate">{path}</span>
      <span className="ml-auto shrink-0 text-footnote text-fg-muted tabular-nums">{count}</span>
      {menu}
    </div>
  );
}

/** The open files in tabs over the one shown, or the empty state. */
function Viewer({ workspaceId, files, onActivate, onClose }: { workspaceId: string; files: OpenFiles; onActivate(path: string): void; onClose(path: string): void }) {
  if (!files.active)
    return (
      <div className="flex min-h-0 min-w-0 flex-1 flex-col items-center justify-center gap-2 p-6 text-center">
        <Icon icon={Folder} size="lg" className="text-fg-muted" />
        <p className="text-body text-fg">Open files appear here</p>
        <p className="max-w-64 text-footnote text-fg-muted">Pick a file in the tree, or click a file path in the conversation.</p>
      </div>
    );
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <div role="group" aria-label="Open files" className="flex h-9 shrink-0 items-center gap-0.5 overflow-x-auto border-b border-line-subtle px-1.5">
        {files.paths.map((path) => (
          <div
            key={path}
            title={path}
            className={cn(
              'flex h-7 max-w-48 shrink-0 items-center rounded-md pr-0.5 text-control-sm text-fg-secondary hover:bg-fill-ghost-hover',
              files.active === path && 'bg-fill-ghost-selected text-fg hover:bg-fill-ghost-selected',
            )}
          >
            <button
              type="button"
              aria-current={files.active === path || undefined}
              onClick={() => onActivate(path)}
              className="flex h-full min-w-0 items-center gap-1.5 rounded-md pl-2 outline-none focus-ring"
            >
              <Icon icon={fileIcon(baseName(path))} className="text-fg-muted" />
              <span className="truncate">{baseName(path)}</span>
            </button>
            <IconButton icon={X} label={`Close ${baseName(path)}`} size="xs" className="size-5 text-fg-muted" onClick={() => onClose(path)} />
          </div>
        ))}
      </div>
      <section aria-label={files.active} className="flex min-h-0 flex-1 flex-col">
        <ViewerHeader workspaceId={workspaceId} path={files.active} />
        <FileContent key={files.active} workspaceId={workspaceId} path={files.active} line={files.line} />
      </section>
    </div>
  );
}

function ViewerHeader({ workspaceId, path }: { workspaceId: string; path: string }) {
  const { data } = useWorkspaceFile(workspaceId, path);
  return (
    <div className="flex h-8 shrink-0 items-center gap-1 px-3">
      <span className="min-w-0 flex-1 truncate font-mono text-caption text-fg-muted">{path}</span>
      {data?.content != null && <CopyButton text={data.content} label="Copy contents" />}
    </div>
  );
}

/** A workspace file's text, highlighted (or, with `markdown`, rendered), or why it isn't shown; scrolled to `line`. */
export function FileContent({ workspaceId, path, markdown = false, line }: { workspaceId: string; path: string; markdown?: boolean; line?: number }) {
  const { data, error } = useWorkspaceFile(workspaceId, path);
  const lines = useHighlightedLines(markdown ? '' : (data?.content ?? ''), languageOf(path), true);
  const scroller = useRef<HTMLDivElement>(null);
  const ready = !!data && lines.length > 0;
  useLayoutEffect(() => {
    const el = scroller.current;
    const pre = el?.querySelector('pre');
    if (!el || !pre || !line || !ready) return;
    const height = parseFloat(getComputedStyle(pre).lineHeight) || 20;
    el.scrollTop = Math.max(0, (line - 1) * height - el.clientHeight / 3);
  }, [line, ready]);
  useEffect(() => {
    if (line && scroller.current) scroller.current.focus({ preventScroll: true });
  }, [line]);
  if (error) return <PaneMessage error>{describeError(error).message}</PaneMessage>;
  if (!data) return <Spinner label="Loading file" className="m-4 text-fg-muted" />;
  if (data.content === null) return <PaneMessage>Binary file ({formatBytes(data.size)}), not shown.</PaneMessage>;
  const truncated = data.truncated && <PaneMessage>Only the beginning of this file is shown.</PaneMessage>;
  if (markdown)
    return (
      <div className="min-h-0 flex-1 overflow-auto px-6 py-4">
        <Markdown text={data.content} streaming={false} verbatim />
        {truncated}
      </div>
    );
  return (
    <div ref={scroller} tabIndex={-1} className="at-code min-h-0 flex-1 overflow-auto outline-none">
      <CodePre lines={lines} streaming={false} lineNumbers className="min-w-max overflow-visible" />
      {truncated}
    </div>
  );
}

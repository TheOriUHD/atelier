/**
 * design/components.md › OutputFiles, FileCard: the files a task produced, by name and where they are in the folder.
 * Compact rows in the progress column, full cards (the ArtifactCard frame) at the end of a finished task. A card
 * opens its preview, or for documents without one, shows the file in its folder (desktop) or downloads it.
 */
import { File, FileArchive, FileCode2, FileImage, FileSpreadsheet, FileText, Presentation, type LucideIcon } from 'lucide-react';
import type { WorkspaceSummary } from '@atelier/protocol';
import { Icon, cn } from '../../components/ui/index.ts';
import { isMac } from '../../lib/platform.ts';
import { extension, fileKind, openAction, type OutputFile } from './output-files.ts';

const ICONS: [LucideIcon, string[]][] = [
  [FileText, ['md', 'markdown', 'txt', 'docx', 'doc', 'odt', 'pages', 'rtf', 'pdf', 'epub']],
  [FileSpreadsheet, ['csv', 'tsv', 'xlsx', 'xls', 'ods', 'numbers']],
  [Presentation, ['pptx', 'ppt', 'odp', 'key']],
  [FileArchive, ['zip', 'gz', 'tgz', 'tar', '7z', 'rar']],
];

export function fileIcon(name: string): LucideIcon {
  const ext = extension(name);
  const kind = fileKind(name);
  if (kind === 'image') return FileImage;
  return ICONS.find(([, exts]) => exts.includes(ext))?.[0] ?? (kind === 'text' ? FileCode2 : File);
}

const ACTION_LABEL = { preview: 'Open', reveal: isMac ? 'Show in Finder' : 'Show in folder', download: 'Download' } as const;

export function FileCard({
  file,
  workspace,
  compact = false,
  onOpen,
}: {
  file: OutputFile;
  workspace: WorkspaceSummary;
  compact?: boolean;
  onOpen(file: OutputFile): void;
}) {
  const action = ACTION_LABEL[openAction(file, workspace)];
  // Where it is in the folder; the name is already the title.
  const where = `in ${workspace.name}${file.path.includes('/') ? `/${file.path.slice(0, file.path.lastIndexOf('/'))}` : ''}`;
  if (compact)
    return (
      <button
        type="button"
        title={`${file.path} · ${action}`}
        onClick={() => onOpen(file)}
        className="flex h-12 w-full items-center gap-2.5 rounded-lg px-1.5 text-left outline-none focus-ring hover:bg-fill-ghost-hover"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-raised text-fg-muted inset-ring inset-ring-line">
          <Icon icon={fileIcon(file.name)} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate text-body text-fg">{file.name}</span>
          <span className="truncate text-caption text-fg-muted">{where}</span>
        </span>
      </button>
    );
  return (
    <button
      type="button"
      onClick={() => onOpen(file)}
      className={cn(
        'flex w-full items-center gap-5 overflow-hidden rounded-2xl border-[0.5px] border-line-strong bg-fill-secondary pt-1.5 pr-4 pb-2 pl-5 text-left shadow-field-drop outline-none focus-ring',
        'transition-[background-color,border-color,box-shadow] duration-(--at-duration-base) ease-out hover:border-line-stronger hover:bg-fill-secondary-hover hover:shadow-sm',
      )}
    >
      <span className="flex size-14 shrink-0 translate-y-2.5 items-center justify-center rounded-t-lg bg-raised text-fg-muted inset-ring inset-ring-line">
        <Icon icon={fileIcon(file.name)} size="lg" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[15px]/5 text-fg">{file.name}</span>
        <span className="truncate text-caption text-fg-muted">{where}</span>
      </span>
      <span className="flex h-8 shrink-0 items-center rounded-lg bg-fill-secondary px-3 text-body text-fg inset-ring inset-ring-fill-secondary-ring">{action}</span>
    </button>
  );
}

/** The cards at the end of a finished task. */
export function OutputFiles({ files, workspace, onOpen }: { files: OutputFile[]; workspace: WorkspaceSummary; onOpen(file: OutputFile): void }) {
  return (
    <section aria-label="Files from this task" className="flex flex-col gap-2">
      {files.map((file) => (
        <FileCard key={file.path} file={file} workspace={workspace} onOpen={onOpen} />
      ))}
    </section>
  );
}

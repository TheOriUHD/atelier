/**
 * A Work output file in the side panel frame: text and code highlighted (the Code view's file viewer), Markdown
 * rendered, images shown. The header copies, shows the file in its folder or downloads it, and closes.
 */
import { useQuery } from '@tanstack/react-query';
import { Download, FolderOpen, X } from 'lucide-react';
import type { WorkspaceSummary } from '@atelier/protocol';
import { Icon, IconButton, Spinner } from '../../components/ui/index.ts';
import { isMac } from '../../lib/platform.ts';
import { keys, useWorkspaceFile } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { SidePanel } from '../artifacts/artifact-panel.tsx';
import { CopyButton } from '../chat/copy-button.tsx';
import { FileContent, PaneMessage } from '../code/file-tree.tsx';
import { fileIcon } from './file-cards.tsx';
import { canReveal, fileKind, saveFile, type OutputFile } from './output-files.ts';

export function FilePreview({ workspace, file, onClose }: { workspace: WorkspaceSummary; file: OutputFile; onClose(): void }) {
  const kind = fileKind(file.name);
  const reveal = canReveal(workspace);
  return (
    <SidePanel label="File preview" className="w-[50%]">
      <header className="flex h-[41px] shrink-0 items-center gap-1 border-b border-line pr-[calc(var(--at-window-controls)+0.5rem)] pl-4">
        <Icon icon={fileIcon(file.name)} className="text-fg-muted" />
        <h2 title={file.path} className="min-w-0 flex-1 truncate px-1.5 text-control-sm text-fg">
          {file.path}
        </h2>
        {workspace.available && kind !== 'image' && <CopyContents workspaceId={workspace.id} path={file.path} />}
        <IconButton
          icon={reveal ? FolderOpen : Download}
          label={reveal ? (isMac ? 'Show in Finder' : 'Show in folder') : 'Download'}
          size="xs"
          onClick={() => void saveFile(workspace, file)}
        />
        <IconButton icon={X} label="Close preview" size="xs" onClick={onClose} />
      </header>
      {!workspace.available ? (
        <PaneMessage>This folder’s computer is offline.</PaneMessage>
      ) : kind === 'image' ? (
        <ImagePreview workspaceId={workspace.id} file={file} />
      ) : (
        <FileContent workspaceId={workspace.id} path={file.path} markdown={kind === 'markdown'} />
      )}
    </SidePanel>
  );
}

function CopyContents({ workspaceId, path }: { workspaceId: string; path: string }) {
  const { data } = useWorkspaceFile(workspaceId, path);
  return data?.content != null && <CopyButton text={data.content} label="Copy contents" />;
}

function ImagePreview({ workspaceId, file }: { workspaceId: string; file: OutputFile }) {
  const { data, error } = useQuery({
    queryKey: [...keys.workspace(workspaceId), 'bytes', file.path],
    queryFn: () => rpc().call('workspaces.fileBytes', { workspaceId, path: file.path }),
  });
  if (error) return <PaneMessage error>{describeError(error).message}</PaneMessage>;
  if (!data) return <Spinner label="Loading image" className="m-4 text-fg-muted" />;
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto bg-bg p-6">
      <img src={`data:${data.mime};base64,${data.dataBase64}`} alt={file.name} className="max-h-full max-w-full object-contain" />
    </div>
  );
}

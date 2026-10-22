/**
 * The composer's + menu (design/components.md › + menu): files and, on a new conversation, a folder that makes it a
 * Cowork task; skills, connectors and plugins; and the Research toggle. Rows show only where they work.
 */
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import {
  Blocks,
  Cloud,
  FolderClosed,
  FolderOpen,
  FolderPlus,
  Paperclip,
  Plus,
  Puzzle,
  ScrollText,
  Telescope,
} from 'lucide-react';
import {
  IconButton,
  Menu,
  MenuCheckboxItem,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuSubmenu,
  MenuTrigger,
  toast,
} from '../../components/ui/index.ts';
import { useOpenSettings } from '../../app/navigation.ts';
import { desktop, isMac } from '../../lib/platform.ts';
import { keys, useAccount, useWorkspaces } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { recentWorkspaces, workspaceLabel } from '../code/workspaces.ts';
import { chooseLocalFolder } from '../workspaces/trust.tsx';
import type { ConnectorSwitches } from './composer.tsx';
import { useSlashList } from './composer-menu.tsx';
import type { ResearchSwitch } from './research.ts';

/** Rows 36 tall with 15px labels. */
const ROW = 'min-h-9 text-composer';

export const UPLOAD_SHORTCUT = isMac ? '⌘U' : 'Ctrl+U';

export function PlusMenu({
  onUpload,
  onSkill,
  onAddFolder,
  workspaceId,
  connectors,
  research,
}: {
  onUpload(): void;
  /** Puts `/name ` in the message box. */
  onSkill(name: string): void;
  /** A new conversation only: it becomes a Cowork task in the folder picked. */
  onAddFolder?: (workspaceId: string) => void;
  workspaceId: string | null | undefined;
  connectors: ConnectorSwitches | undefined;
  research: ResearchSwitch | undefined;
}) {
  const navigate = useNavigate();
  const { account } = useAccount();
  const skills = (useSlashList(workspaceId).data ?? []).filter((e) => e.kind === 'skill');
  const extend = skills.length > 0 || !!connectors?.list.length || account?.role === 'admin';

  return (
    <Menu>
      <MenuTrigger render={<IconButton icon={Plus} label="Add files and more" iconSize="md" />} />
      <MenuContent side="top" align="start" className="w-[250px]">
        <MenuItem icon={Paperclip} shortcut={UPLOAD_SHORTCUT} className={ROW} onClick={onUpload}>
          Upload or add files
        </MenuItem>
        {onAddFolder && <AddFolder onAdd={onAddFolder} />}
        {extend && <MenuSeparator />}
        {skills.length > 0 && (
          <MenuSubmenu label="Skills" icon={ScrollText} triggerClassName={ROW} className="max-h-80 w-64">
            {skills.map((s) => (
              <MenuItem key={s.name} title={s.description} onClick={() => onSkill(s.name)}>
                {s.name}
              </MenuItem>
            ))}
          </MenuSubmenu>
        )}
        {!!connectors?.list.length && (
          <MenuSubmenu
            label="Connectors"
            icon={Blocks}
            hint={`${connectors.list.length - connectors.off.filter((n) => connectors.list.some((c) => c.name === n)).length} on`}
            triggerClassName={ROW}
            className="w-64"
          >
            {connectors.list.map((c) => (
              <MenuCheckboxItem
                key={c.name}
                checked={!connectors.off.includes(c.name)}
                disabled={c.state === 'disabled'}
                description={
                  c.state === 'error'
                    ? 'Not connected'
                    : c.state === 'disabled'
                      ? 'Switched off by an admin'
                      : undefined
                }
                onCheckedChange={(on) =>
                  connectors.onChange(on ? connectors.off.filter((n) => n !== c.name) : [...connectors.off, c.name])
                }
              >
                {c.name}
              </MenuCheckboxItem>
            ))}
          </MenuSubmenu>
        )}
        {account?.role === 'admin' && (
          <MenuItem
            icon={Puzzle}
            className={ROW}
            onClick={() => void navigate({ to: '/customize', search: { tab: 'plugins' } })}
          >
            Add plugins
          </MenuItem>
        )}
        {research && (
          <>
            <MenuSeparator />
            <MenuCheckboxItem
              icon={Telescope}
              className={ROW}
              checked={research.on}
              onCheckedChange={(on) => research.onChange(on)}
            >
              Research
            </MenuCheckboxItem>
          </>
        )}
      </MenuContent>
    </Menu>
  );
}

/** The folders a Cowork task can run in: recent ones whose computer is online, another on this computer, or a codespace. */
function AddFolder({ onAdd }: { onAdd(workspaceId: string): void }) {
  const { data } = useWorkspaces();
  const openSettings = useOpenSettings();
  const qc = useQueryClient();
  const folders = recentWorkspaces(data ?? []).filter((w) => w.available && !w.scratch);

  const openFolder = async () => {
    try {
      const path = await chooseLocalFolder();
      if (!path) return;
      const added = await rpc().call('workspaces.addLocal', { path });
      // The new chat names the folder from this list.
      await qc.invalidateQueries({ queryKey: keys.workspaces });
      onAdd(added.id);
    } catch (e) {
      toast.error(describeError(e).message);
    }
  };

  return (
    <MenuSubmenu label="Add folder" icon={FolderPlus} triggerClassName={ROW} className="w-72">
      {folders.map((w) => (
        <MenuItem
          key={w.id}
          icon={FolderClosed}
          description={w.kind === 'ssh' ? undefined : w.root}
          onClick={() => onAdd(w.id)}
        >
          {workspaceLabel(w)}
        </MenuItem>
      ))}
      {folders.length > 0 && <MenuSeparator />}
      {desktop ? (
        <MenuItem icon={FolderOpen} onClick={() => void openFolder()}>
          Open folder…
        </MenuItem>
      ) : (
        !folders.length && (
          <MenuItem disabled description="Folders on your computer come from the desktop app.">
            No folder available
          </MenuItem>
        )
      )}
      <MenuItem icon={Cloud} onClick={() => openSettings('cloud')}>
        Use a codespace…
      </MenuItem>
    </MenuSubmenu>
  );
}

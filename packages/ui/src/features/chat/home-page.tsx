import { useRef, useState } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { BriefcaseBusiness, ChevronDown, FolderClosed, Plus, X } from 'lucide-react';
import type { Effort, WorkspaceSummary } from '@atelier/protocol';
import {
  Icon,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from '../../components/ui/index.ts';
import { BrandMark } from '../../components/brand-mark.tsx';
import { greeting } from '../../lib/dates.ts';
import { draftKeys } from '../../lib/drafts.ts';
import {
  useAccount,
  useModels,
  usePrefs,
  useProjects,
  useProviderType,
  useSessions,
  useWorkspaces,
} from '../../lib/queries.ts';
import { workspaceLabel } from '../code/workspaces.ts';
import { ProjectDetailsDialog } from '../projects/project-dialogs.tsx';
import { askToNotify } from '../work/notifications.ts';
import { Composer, FileDropZone, type ComposerHandle } from './composer.tsx';
import { useSlashList } from './composer-menu.tsx';
import { ModelPicker } from './model-picker.tsx';
import { NewSessionContextButton } from '../code/context-popover.tsx';
import { useDefaultModel } from './models.ts';
import { modelCommand } from './session-view.tsx';
import { useNewConnectors } from './connector-switches.ts';
import { useNewResearch } from './research.ts';
import { useStartSession } from './start-session.ts';
import { Starters } from './starters.tsx';
import { TemporaryBar, TemporaryHeading, TemporaryNote, TemporaryToggle } from './temporary.tsx';
import { useAttachments } from './use-attachments.ts';

/** People with fewer chats than this see the starter ideas under the composer. */
const STARTER_CHATS = 5;

/**
 * New chat: greeting and the large composer, with starter ideas for people new to it. The session is created on
 * first send; a folder added from + makes it a Cowork task instead. `?temporary=true` (the ghost toggle) starts a
 * temporary chat: Chat only, never in history.
 */
export function HomePage() {
  const navigate = useNavigate();
  const temporary = useSearch({ strict: false, select: (s: { temporary?: boolean }) => s.temporary === true });
  const setTemporary = (on: boolean) => void navigate({ to: '/', search: (prev) => ({ ...prev, temporary: on || undefined }) });
  const { account } = useAccount();
  const { prefs } = usePrefs();
  const { data: models } = useModels();
  const { data: chats } = useSessions({ mode: 'chat' });
  const { data: workspaces } = useWorkspaces();
  const hasSkills = useSlashList(undefined).data?.some((e) => e.kind === 'skill');
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  // A temporary chat is Chat only: a folder picked before switching waits until it is off again.
  const folder = temporary ? undefined : workspaces?.find((w) => w.id === workspaceId);
  const defaultModel = useDefaultModel(folder ? 'work' : 'chat');
  const [modelRef, setModelRef] = useState<string | null>(null);
  const [effort, setEffort] = useState<Effort | null>(null);
  const [pickingModel, setPickingModel] = useState(false);
  const [projectId, setProjectId] = useState<string | null>(null);
  const attachments = useAttachments(temporary ? undefined : draftKeys.newChat);
  const { sending, start } = useStartSession(attachments);
  const connectors = useNewConnectors();
  const research = useNewResearch();
  const composer = useRef<ComposerHandle>(null);
  const model = models?.find((m) => m.ref === modelRef) ?? defaultModel;
  const providerType = useProviderType(model?.providerId);
  const name = prefs?.callMe.trim() || account?.name.trim();
  const temporaryMode = prefs?.privacy.temporaryChats ?? 'private';
  // A fresh temporary chat gets no project context, so it offers none.
  const offersProject = !temporary || temporaryMode === 'private';

  const send = (text: string) => {
    if (!model) return;
    const choices = {
      model: model.ref,
      effort,
      ...(connectors.off.length ? { connectorsOff: [...connectors.off] } : {}),
      ...(research?.on ? { research: true } : {}),
    };
    if (!folder) return start({ mode: 'chat', ...choices, ...(projectId && offersProject ? { projectId } : {}), ...(temporary ? { temporary: true } : {}) }, text);
    // Sending is the gesture browsers want before they ask; Cowork tells the person when a task is done.
    if (prefs) askToNotify(prefs);
    return start({ mode: 'work', workspaceId: folder.id, ...choices }, text);
  };

  return (
    <FileDropZone onFiles={(files) => void attachments.add(files)}>
      {temporary ? (
        <TemporaryBar onLeave={() => setTemporary(false)} />
      ) : (
        <div className="app-drag flex h-(--at-layout-header-height) shrink-0 items-start justify-end pr-[calc(var(--at-window-controls)+1rem)]">
          <TemporaryToggle on={false} onChange={setTemporary} />
        </div>
      )}
      {/* Narrow screens: the composer sits at the bottom, the greeting centered above it. */}
      <div className="flex flex-1 flex-col items-center justify-center px-6 pb-[105px] max-md:justify-end max-md:px-4 max-md:pb-2">
        {temporary ? (
          <TemporaryHeading />
        ) : (
          <h1 className="mb-[30px] flex items-center gap-3 font-chat text-greeting leading-10 text-fg max-md:my-auto">
            <BrandMark className="size-8" />
            {greeting(name)}
          </h1>
        )}
        {/* The starters hang below the composer so they don't move it. */}
        <div className="relative w-full max-w-(--at-layout-composer-width-new-chat)">
          <Composer
            ref={composer}
            variant="new"
            // Nothing of a temporary chat is kept, not even an unsent draft.
            draftKey={temporary ? undefined : draftKeys.newChat}
            temporary={temporary}
            connectors={connectors}
            research={research}
            onAddFolder={temporary ? undefined : setWorkspaceId}
            autoFocus
            attachments={attachments}
            model={model}
            streaming={sending}
            placeholder={temporary ? undefined : folder ? 'Describe a task for this folder' : hasSkills ? 'Type / for skills' : undefined}
            commands={[modelCommand(() => setPickingModel(true))]}
            onSubmit={(text) => void send(text)}
            footerStart={
              folder ? (
                <FolderChip folder={folder} onRemove={() => setWorkspaceId(null)} />
              ) : offersProject ? (
                <ProjectSelect value={projectId} onChange={setProjectId} />
              ) : undefined
            }
            footerEnd={
              <>
                {model && <NewSessionContextButton limit={model.contextLength} provider={providerType} />}
                <ModelPicker
                  open={pickingModel}
                  onOpenChange={setPickingModel}
                  model={model}
                  mode={folder ? 'work' : 'chat'}
                  effort={effort}
                  onModelChange={setModelRef}
                  onEffortChange={setEffort}
                />
              </>
            }
          />
          {temporary && <TemporaryNote mode={temporaryMode} className="absolute inset-x-0 top-full mt-4 max-md:static max-md:mt-3" />}
          {!temporary && !folder && chats && chats.length < STARTER_CHATS && (
            <Starters
              className="absolute inset-x-0 top-full mt-4 max-md:hidden"
              onPick={(prompt) => composer.current?.setText(prompt)}
            />
          )}
        </div>
      </div>
    </FileDropZone>
  );
}

/** The folder a Cowork task will run in, in place of the project picker; × makes it a chat again. */
function FolderChip({ folder, onRemove }: { folder: WorkspaceSummary; onRemove(): void }) {
  return (
    <span className="flex h-6 min-w-0 items-center gap-1.5 rounded-sm pl-2 text-control-sm text-fg-secondary">
      <Icon icon={BriefcaseBusiness} className="size-3.5 shrink-0" />
      <span className="truncate">Cowork in {workspaceLabel(folder)}</span>
      <IconButton icon={X} label="Remove folder" size="xs" className="text-fg-muted" onClick={onRemove} />
    </span>
  );
}

/** Project ⌄: start the chat in a project, or create one (which opens it, with its own composer). */
function ProjectSelect({ value, onChange }: { value: string | null; onChange(id: string | null): void }) {
  const { data: projects } = useProjects();
  const [creating, setCreating] = useState(false);
  const current = projects?.find((p) => p.id === value);
  return (
    <>
      <Menu>
        <MenuTrigger className="flex h-6 items-center gap-1.5 rounded-sm px-2 text-control-sm text-fg-secondary outline-none focus-ring hover:bg-fill-ghost-hover data-popup-open:bg-fill-ghost-hover">
          {current && <Icon icon={FolderClosed} size="sm" className="size-3.5" />}
          <span className="max-w-48 truncate">{current?.name ?? 'Project'}</span>
          <Icon icon={ChevronDown} size="sm" className="size-3 text-fg-muted" />
        </MenuTrigger>
        <MenuContent className="w-60">
          <MenuRadioGroup value={value ?? 'none'} onValueChange={(v: string) => onChange(v === 'none' ? null : v)}>
            <MenuRadioItem value="none">No project</MenuRadioItem>
            {!!projects?.length && <MenuSeparator />}
            {projects?.map((p) => (
              <MenuRadioItem key={p.id} value={p.id} icon={FolderClosed}>
                {p.name}
              </MenuRadioItem>
            ))}
          </MenuRadioGroup>
          <MenuSeparator />
          <MenuItem icon={Plus} onClick={() => setCreating(true)}>
            New project…
          </MenuItem>
        </MenuContent>
      </Menu>
      <ProjectDetailsDialog open={creating} onOpenChange={setCreating} />
    </>
  );
}

/**
 * A new Code session or Cowork task (design/components.md › Code home): the greeting and the stats card at the top,
 * the environment and folder chips and the composer at the bottom. The session is created on first send, in the
 * chosen folder or with no folder (a new scratch folder), and in Code with the chosen permission mode.
 */
import { useState, type ReactNode } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import type { Effort, PermissionMode } from '@atelier/protocol';
import { toast } from '../../components/ui/index.ts';
import { BrandMark } from '../../components/brand-mark.tsx';
import { MODE_HOME } from '../../app/navigation.ts';
import { desktop } from '../../lib/platform.ts';
import { draftKeys } from '../../lib/drafts.ts';
import { useSplitCell } from '../../lib/split-cell.tsx';
import { useAccount, useModels, usePrefs, useProviderType } from '../../lib/queries.ts';
import { Composer, FileDropZone } from '../chat/composer.tsx';
import { ModelPicker } from '../chat/model-picker.tsx';
import { useDefaultModel } from '../chat/models.ts';
import { ContextMeter, modelCommand } from '../chat/session-view.tsx';
import { useNewConnectors } from '../chat/connector-switches.ts';
import { useStartSession } from '../chat/start-session.ts';
import { useAttachments } from '../chat/use-attachments.ts';
import { askToNotify } from '../work/notifications.ts';
import { PermissionModePicker, nextMode, switchesMode, useEffectiveMode } from './permission-mode.tsx';
import { NewSessionContextButton } from './context-popover.tsx';
import { StatsCard } from './stats-card.tsx';
import { NO_FOLDER_HINT, WorkspaceChips, useEnvironment } from './workspace-picker.tsx';
import { NO_FOLDER, type FolderSearch } from './workspaces.ts';

const COPY = {
  code: { greeting: 'What’s up next', placeholder: 'Describe a task or ask a question' },
  work: { greeting: 'What should we get done', placeholder: 'Describe a task for this folder' },
};

/** `children` follow the stats card above the composer (Cowork: the person's tasks). */
export function FolderHome({ mode: sessionMode, children }: { mode: 'work' | 'code'; children?: ReactNode }) {
  // In a split view cell it sets up a session there: no stats card, and the folder is the cell's own pick, not the page's.
  const cell = useSplitCell();
  const routeSearch: FolderSearch = useSearch({ strict: false });
  const [cellSearch, setCellSearch] = useState<FolderSearch>({});
  const search = cell ? cellSearch : routeSearch;
  const navigate = useNavigate();
  const { account } = useAccount();
  const { prefs } = usePrefs();
  const { data: models } = useModels();
  const defaultModel = useDefaultModel(sessionMode);
  const [modelRef, setModelRef] = useState<string | null>(null);
  const [effort, setEffort] = useState<Effort | null>(null);
  const [pickingModel, setPickingModel] = useState(false);
  // null follows the system default, which the session then keeps following.
  const [chosenMode, setChosenMode] = useState<PermissionMode | null>(null);
  const mode = useEffectiveMode(chosenMode);
  const attachments = useAttachments(cell ? undefined : sessionMode === 'code' ? draftKeys.newCode : draftKeys.newChat);
  const { sending, start } = useStartSession(attachments);
  const connectors = useNewConnectors();
  const { environment, folders, choice, scratchHost, choose } = useEnvironment(sessionMode, search.workspace, search.host);
  const model = models?.find((m) => m.ref === modelRef) ?? defaultModel;
  const providerType = useProviderType(model?.providerId);
  const workspace = choice?.kind === 'folder' ? choice.workspace : undefined;
  const name = prefs?.callMe.trim() || account?.name.trim();
  const code = sessionMode === 'code';
  const pickFolder = (id?: string, host?: string) =>
    cell
      ? setCellSearch({ ...(id ? { workspace: id, ...(id === NO_FOLDER && host ? { host } : {}) } : {}) })
      : void navigate({
      to: MODE_HOME[sessionMode],
      search: { ...(id ? { workspace: id, ...(id === NO_FOLDER && host ? { host } : {}) } : {}), ...(search.group ? { group: search.group } : {}) },
      replace: true,
    });

  const send = async (text: string) => {
    if (!model || sending) return;
    if (!choice) return void toast.error(desktop ? 'Choose a folder to work in first.' : NO_FOLDER_HINT);
    // Sending is the gesture browsers want before they ask; Cowork tells the person when a task is done.
    if (!code && prefs) askToNotify(prefs);
    const choices = { ...(code && chosenMode ? { permissionMode: chosenMode } : {}), ...(connectors.off.length ? { connectorsOff: [...connectors.off] } : {}) };
    const where = choice.kind === 'folder' ? { workspaceId: choice.workspace.id } : { scratch: choice.host ? { sshHost: choice.host } : {} };
    await start({ mode: sessionMode, model: model.ref, effort, ...where, ...choices, ...(search.group ? { groupId: search.group } : {}) }, text);
  };

  return (
    <FileDropZone onFiles={(files) => void attachments.add(files)}>
      {!cell && <div className="app-drag h-(--at-layout-header-height) shrink-0" />}
      {/* Chips, box and footer sit 8px apart, with 20px to the window's edge. */}
      <div className="flex min-h-0 flex-1 flex-col px-6 pb-5 max-md:px-4">
        <div className="mx-auto flex min-h-0 w-full max-w-(--at-layout-composer-width-chat) flex-1 flex-col overflow-y-auto">
          <h1 className="mt-1.5 flex items-center gap-2 text-[18px] leading-6 text-fg">
            <BrandMark className="size-5" />
            {name ? `${COPY[sessionMode].greeting}, ${name}?` : `${COPY[sessionMode].greeting}?`}
          </h1>
          {cell ? <div className="mt-8" /> : <StatsCard mode={sessionMode} className="mt-14 mb-6" />}
          {children}
        </div>
        <div className="mx-auto flex w-full max-w-(--at-layout-composer-width-chat) flex-col gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <WorkspaceChips
              environment={environment}
              folders={folders}
              value={choice}
              noFolder={scratchHost !== undefined}
              onEnvironmentChange={(env, id, host) => {
                choose(env);
                pickFolder(id, host);
              }}
              onChange={(id) => pickFolder(id, scratchHost ?? undefined)}
            />
            {!desktop && !choice && <span className="text-footnote text-fg-muted">{NO_FOLDER_HINT}</span>}
          </div>
          <Composer
            variant="reply"
            // The new Cowork task shares the new chat's draft; a split view cell's new session keeps none (several can be open).
            draftKey={cell ? undefined : code ? draftKeys.newCode : draftKeys.newChat}
            compact
            connectors={connectors}
            autoFocus
            attachments={attachments}
            model={model}
            streaming={sending}
            placeholder={COPY[sessionMode].placeholder}
            workspaceId={workspace?.id ?? null}
            commands={[modelCommand(() => setPickingModel(true))]}
            onSubmit={(text) => void send(text)}
            onKeyDown={(e) => code && switchesMode(e) && setChosenMode(nextMode(mode))}
            footerStart={code && <PermissionModePicker value={mode} onChange={setChosenMode} />}
            footerEnd={
              <>
                <ModelPicker
                  open={pickingModel}
                  onOpenChange={setPickingModel}
                  model={model}
                  mode={sessionMode}
                  effort={effort}
                  onModelChange={setModelRef}
                  onEffortChange={setEffort}
                />
                {model && (code ? <NewSessionContextButton limit={model.contextLength} provider={providerType} /> : <ContextMeter used={0} limit={model.contextLength} />)}
              </>
            }
          />
        </div>
      </div>
    </FileDropZone>
  );
}

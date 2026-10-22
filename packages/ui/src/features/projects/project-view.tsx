import { useLayoutEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { ChevronDown, MessagesSquare, Pencil, Pin, PinOff, Trash2 } from 'lucide-react';
import type { Effort, FileRef, Project } from '@atelier/protocol';
import { ConfirmDialog, Icon, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Spinner, cn, toast } from '../../components/ui/index.ts';
import { trafficLightInset, useSidebarHidden } from '../../app/chrome.tsx';
import { draftKeys } from '../../lib/drafts.ts';
import { relativeTime } from '../../lib/dates.ts';
import { queryClient, useModels, useProject, useSessions } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { Composer, FileDropZone } from '../chat/composer.tsx';
import { ModelPicker } from '../chat/model-picker.tsx';
import { useDefaultModel } from '../chat/models.ts';
import { modelCommand } from '../chat/session-view.tsx';
import { useNewConnectors } from '../chat/connector-switches.ts';
import { useNewResearch } from '../chat/research.ts';
import { useStartSession } from '../chat/start-session.ts';
import { useAttachments } from '../chat/use-attachments.ts';
import { ProjectDetailsDialog, updateProject } from './project-dialogs.tsx';
import { ProjectPanel } from './project-panel.tsx';

type ProjectDetails = Project & { files: FileRef[] };

export function ProjectPage() {
  const { projectId } = useParams({ from: '/projects/$projectId' });
  // Keyed so drafts and the composer reset when switching projects.
  return <ProjectView key={projectId} projectId={projectId} />;
}

function ProjectView({ projectId }: { projectId: string }) {
  const { data: project, error } = useProject(projectId);

  return (
    <>
      <ProjectHeader project={project} />
      {project ? (
        <div className="@container min-h-0 flex-1 overflow-y-auto px-4 pb-10">
          <div className="mx-auto max-w-160 @min-[880px]:max-w-[1006px]">
            <div className="max-w-160 px-4 pt-5">
              <InlineText
                label="Project name"
                value={project.name}
                maxLength={120}
                required
                onSave={(name) => updateProject(project.id, { name })}
                className="font-serif text-page-title text-fg"
              />
              <InlineText
                label="Project description"
                value={project.description}
                placeholder="Add a description"
                maxLength={2000}
                multiline
                onSave={(description) => updateProject(project.id, { description })}
                className="mt-1 text-body text-fg-secondary"
              />
            </div>
            <div className="mt-8 flex flex-col gap-10 @min-[880px]:flex-row @min-[880px]:gap-14">
              <div className="min-w-0 flex-1">
                <ProjectComposer project={project} />
                <ProjectChats projectId={project.id} />
              </div>
              <ProjectPanel project={project} />
            </div>
          </div>
        </div>
      ) : error ? (
        <div className="mt-24 flex flex-col items-center gap-2 text-body text-fg-muted">
          <p>This project doesn’t exist anymore.</p>
          <Link to="/projects" className="rounded-sm text-interactive-text outline-none focus-ring hover:underline">
            Show all projects
          </Link>
        </div>
      ) : (
        <Spinner className="mx-auto mt-24" />
      )}
    </>
  );
}

function ProjectHeader({ project }: { project: ProjectDetails | undefined }) {
  const sidebarHidden = useSidebarHidden();
  const navigate = useNavigate();
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);

  return (
    <header className={cn('app-drag flex h-(--at-layout-header-height) shrink-0 items-center pl-3 pr-[calc(var(--at-window-controls)+0.75rem)]', sidebarHidden && (trafficLightInset ? 'pl-[112px]' : 'pl-11'))}>
      <nav aria-label="Breadcrumb" className="flex min-w-0 items-center gap-0.5">
        <Link
          to="/projects"
          className="app-no-drag flex h-7 shrink-0 items-center rounded-md px-2 text-body text-fg-secondary outline-none focus-ring hover:bg-fill-ghost-hover hover:text-fg"
        >
          Projects
        </Link>
        <span aria-hidden className="text-body text-fg-muted">
          /
        </span>
        {project && (
          <Menu>
            <MenuTrigger className="app-no-drag flex h-7 min-w-0 max-w-[min(480px,60vw)] items-center gap-1 rounded-md px-2 text-body text-fg outline-none focus-ring hover:bg-fill-ghost-hover data-popup-open:bg-fill-ghost-hover">
              <span className="truncate">{project.name}</span>
              <Icon icon={ChevronDown} className="text-fg-muted" />
            </MenuTrigger>
            <MenuContent className="w-52">
              <MenuItem
                icon={project.pinnedAt ? PinOff : Pin}
                onClick={() => void updateProject(project.id, { pinned: !project.pinnedAt }).catch((e: unknown) => toast.error(describeError(e).message))}
              >
                {project.pinnedAt ? 'Unpin' : 'Pin'}
              </MenuItem>
              <MenuItem icon={Pencil} onClick={() => setEditing(true)}>
                Edit details
              </MenuItem>
              <MenuSeparator />
              <MenuItem icon={Trash2} danger onClick={() => setDeleting(true)}>
                Delete project
              </MenuItem>
            </MenuContent>
          </Menu>
        )}
      </nav>
      {project && (
        <>
          <ProjectDetailsDialog project={project} open={editing} onOpenChange={setEditing} />
          <ConfirmDialog
            open={deleting}
            onOpenChange={setDeleting}
            title={`Delete “${project.name}”?`}
            description="Its instructions and files will be deleted. Its chats are kept, outside any project. This can’t be undone."
            onConfirm={async () => {
              try {
                await rpc().call('projects.delete', { id: project.id });
                // The chats lost their project; no session event announces that.
                void queryClient.invalidateQueries({ queryKey: ['sessions'] });
                void navigate({ to: '/projects' });
              } catch (error) {
                toast.error(describeError(error).message);
              }
            }}
          />
        </>
      )}
    </header>
  );
}

/**
 * Text that edits in place: Enter or leaving the field saves, Escape cancels. Shows the saved
 * value (and its live updates) except while focused or saving.
 */
function InlineText({
  label,
  value,
  placeholder,
  maxLength,
  required,
  multiline,
  onSave,
  className,
}: {
  label: string;
  value: string;
  placeholder?: string;
  maxLength: number;
  required?: boolean;
  multiline?: boolean;
  onSave(value: string): Promise<void>;
  className: string;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const cancelled = useRef(false);
  const field = useRef<HTMLTextAreaElement>(null);
  const shown = draft ?? value;

  useLayoutEffect(() => {
    const el = field.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [shown]);

  const commit = async () => {
    const next = draft?.trim() ?? value;
    if (!cancelled.current && next !== value && (next || !required)) {
      try {
        await onSave(next);
      } catch (error) {
        toast.error(describeError(error).message);
      }
    }
    cancelled.current = false;
    setDraft(null);
  };

  return (
    <textarea
      ref={field}
      rows={1}
      aria-label={label}
      value={shown}
      placeholder={placeholder}
      maxLength={maxLength}
      onFocus={() => setDraft(value)}
      onChange={(e) => setDraft(multiline ? e.target.value : e.target.value.replace(/\s*\n\s*/g, ' '))}
      onBlur={() => void commit()}
      onKeyDown={(e) => {
        if (e.key === 'Escape') cancelled.current = true;
        else if (e.key !== 'Enter' || (multiline && e.shiftKey) || e.nativeEvent.isComposing) return;
        e.preventDefault();
        e.currentTarget.blur();
      }}
      className={cn(
        '-mx-2 block w-[calc(100%+16px)] resize-none overflow-hidden rounded-lg bg-transparent px-2 outline-none placeholder:text-fg-muted',
        'transition-colors duration-(--at-duration-fast) hover:bg-fill-ghost-hover focus:bg-fill-field focus:inset-ring focus:inset-ring-fill-field-ring',
        className,
      )}
    />
  );
}

/** The new-chat composer, fixed to this project: sending creates the chat inside it. */
function ProjectComposer({ project }: { project: Project }) {
  const { data: models } = useModels();
  const defaultModel = useDefaultModel('chat');
  const [modelRef, setModelRef] = useState<string | null>(null);
  const [effort, setEffort] = useState<Effort | null>(null);
  const [pickingModel, setPickingModel] = useState(false);
  const attachments = useAttachments();
  const { sending, start } = useStartSession(attachments);
  const connectors = useNewConnectors();
  const research = useNewResearch();
  const model = models?.find((m) => m.ref === modelRef) ?? defaultModel;

  const send = (text: string) =>
    model &&
    start(
      {
        mode: 'chat',
        model: model.ref,
        effort,
        projectId: project.id,
        ...(connectors.off.length ? { connectorsOff: [...connectors.off] } : {}),
        ...(research?.on ? { research: true } : {}),
      },
      text,
    );

  return (
    <FileDropZone onFiles={(files) => void attachments.add(files)}>
      <Composer
        variant="new"
        draftKey={draftKeys.project(project.id)}
        connectors={connectors}
        research={research}
        autoFocus
        attachments={attachments}
        model={model}
        streaming={sending}
        placeholder={`New chat in ${project.name}`}
        commands={[modelCommand(() => setPickingModel(true))]}
        onSubmit={(text) => void send(text)}
        footerEnd={
          <ModelPicker
            open={pickingModel}
            onOpenChange={setPickingModel}
            model={model}
            mode="chat"
            effort={effort}
            onModelChange={setModelRef}
            onEffortChange={setEffort}
          />
        }
      />
    </FileDropZone>
  );
}

function ProjectChats({ projectId }: { projectId: string }) {
  const { data: sessions } = useSessions({ mode: 'chat', projectId });
  if (!sessions) return null;
  if (!sessions.length) {
    return (
      <div className="mt-20 flex flex-col items-center gap-3 px-4 text-center">
        <Icon icon={MessagesSquare} size="lg" className="text-fg-muted" />
        <p className="text-body text-fg-muted">Chats you start here use this project’s instructions and files.</p>
      </div>
    );
  }
  return (
    <ul aria-label="Chats in this project" className="mt-8 flex flex-col">
      {sessions.map((s) => (
        <li key={s.id} className="border-b border-line-subtle last:border-b-0">
          <Link
            to="/chat/$sessionId"
            params={{ sessionId: s.id }}
            className="my-px flex flex-col gap-0.5 rounded-lg px-4 py-3 outline-none focus-ring hover:bg-fill-ghost-hover"
          >
            <span className="truncate text-body text-fg">{s.title || 'New chat'}</span>
            <span className="text-caption text-fg-muted">Last activity {relativeTime(s.updatedAt)}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}

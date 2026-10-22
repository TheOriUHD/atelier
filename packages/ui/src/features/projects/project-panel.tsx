import { useRef, useState, type ReactNode } from 'react';
import { FileText, Files, NotebookPen, TriangleAlert, X, type LucideIcon } from 'lucide-react';
import type { FileRef, Project } from '@atelier/protocol';
import { Button, Dialog, DialogContent, DialogFooter, Icon, IconButton, ProgressBar, Spinner, TextArea, cn, toast } from '../../components/ui/index.ts';
import { keys, queryClient } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { FileDropZone, formatBytes } from '../chat/composer.tsx';
import { formatTokens } from '../chat/models.ts';
import { MAX_UPLOAD_BYTES, mimeFor, readBase64 } from '../chat/use-attachments.ts';
import { updateProject } from './project-dialogs.tsx';
import { fileBudget, fileType, type FileBudget } from './projects.ts';

type ProjectDetails = Project & { files: FileRef[] };

/** Right column of the project view: instructions and files, both included in every new chat. */
export function ProjectPanel({ project }: { project: ProjectDetails }) {
  const [editingInstructions, setEditingInstructions] = useState(false);
  const { uploading, upload } = useProjectUploads(project.id);
  const picker = useRef<HTMLInputElement>(null);

  return (
    <aside aria-label="Project knowledge" className="shrink-0 @min-[880px]:w-[310px]">
      <FileDropZone label="Drop files to add them to the project" onFiles={(files) => void upload(files)}>
        <PanelSection icon={NotebookPen} label="Instructions" action={project.instructions ? 'Edit' : 'Add'} onAction={() => setEditingInstructions(true)}>
          {project.instructions && (
            <button
              type="button"
              onClick={() => setEditingInstructions(true)}
              className="line-clamp-3 rounded-sm text-left text-footnote whitespace-pre-line text-fg-muted outline-none focus-ring hover:text-fg-secondary"
            >
              {project.instructions}
            </button>
          )}
        </PanelSection>
        <PanelSection icon={Files} label="Files" action="Add" onAction={() => picker.current?.click()}>
          <FileList project={project} uploading={uploading} />
        </PanelSection>
      </FileDropZone>
      <input
        ref={picker}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          void upload([...(e.target.files ?? [])]);
          e.target.value = '';
        }}
      />
      <InstructionsDialog project={project} open={editingInstructions} onOpenChange={setEditingInstructions} />
    </aside>
  );
}

function PanelSection({ icon, label, action, onAction, children }: { icon: LucideIcon; label: string; action: string; onAction(): void; children: ReactNode }) {
  return (
    <section aria-label={label} className="border-b border-line last:border-b-0">
      <div className="flex h-[50px] items-center gap-3">
        <Icon icon={icon} className="text-fg-secondary" />
        <h2 className="flex-1 text-body text-fg">{label}</h2>
        <button
          type="button"
          aria-label={`${action} ${label.toLowerCase()}`}
          onClick={onAction}
          className="rounded-sm text-body text-fg-secondary outline-none focus-ring hover:text-fg"
        >
          {action}
        </button>
      </div>
      {children && <div className="pb-4">{children}</div>}
    </section>
  );
}

function FileList({ project, uploading }: { project: ProjectDetails; uploading: Upload[] }) {
  if (!project.files.length && !uploading.length) {
    return <p className="text-footnote text-fg-muted">Drop files here or use Add. Their text is included in every new chat in this project.</p>;
  }
  const budget = fileBudget(project.files);
  return (
    <>
      {project.files.length > 0 && <BudgetMeter budget={budget} />}
      <ul className="mt-2 flex flex-col">
        {project.files.map((f) => (
          <FileRow key={f.id} file={f} projectId={project.id} overBudget={budget.overBudget.has(f.id)} />
        ))}
        {uploading.map((u) => (
          <li key={u.key} className="flex h-12 items-center gap-2.5">
            <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-fill-ghost-hover">
              <Spinner size="sm" />
            </span>
            <span className="truncate text-body text-fg-secondary">{u.name}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

function BudgetMeter({ budget }: { budget: FileBudget }) {
  const left = budget.overBudget.size;
  return (
    <div>
      <div className="mb-1.5 flex items-baseline justify-between gap-2 text-caption text-fg-muted">
        <span>Prompt budget</span>
        <span className="tabular-nums">
          {formatTokens(budget.total)} / {formatTokens(budget.budget)} tokens
        </span>
      </div>
      <ProgressBar value={budget.total / budget.budget} aria-label="Project files in the prompt budget" className={cn(left > 0 && '[&>div]:bg-warning')} />
      {left > 0 && (
        <p className="mt-2 flex gap-1.5 text-footnote text-warning-text">
          <Icon icon={TriangleAlert} className="mt-px" />
          {left === 1 ? '1 file doesn’t fit the budget and is' : `${left} files don’t fit the budget and are`} left out of new chats.
        </p>
      )}
    </div>
  );
}

function FileRow({ file, projectId, overBudget }: { file: FileRef; projectId: string; overBudget: boolean }) {
  const [removing, setRemoving] = useState(false);
  const note = file.tokens === null ? 'No readable text' : overBudget ? 'Over budget' : null;

  const remove = async () => {
    setRemoving(true);
    try {
      await rpc().call('projects.removeFile', { projectId, fileId: file.id });
    } catch (error) {
      toast.error(describeError(error).message);
      setRemoving(false);
    }
  };

  return (
    <li className={cn('group/file flex h-12 items-center gap-2.5', removing && 'opacity-40')}>
      <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-fill-ghost-hover text-fg-secondary">
        <Icon icon={FileText} />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-body text-fg">{file.name}</p>
        <p className="truncate text-caption text-fg-muted">
          {fileType(file)} · {formatBytes(file.size)}
          {file.tokens !== null && ` · ${formatTokens(file.tokens)} tokens`}
          {note && <span className="text-warning-text"> · {note}</span>}
        </p>
      </div>
      <IconButton
        icon={X}
        label={`Remove ${file.name}`}
        size="xs"
        disabled={removing}
        onClick={() => void remove()}
        className="text-fg-secondary opacity-0 group-hover/file:opacity-100 focus-visible:opacity-100 pointer-coarse:opacity-100"
      />
    </li>
  );
}

interface Upload {
  key: string;
  name: string;
}

/** Uploads files one by one and adds each to the project; failures are reported per file. */
function useProjectUploads(projectId: string) {
  const [uploading, setUploading] = useState<Upload[]>([]);

  const upload = async (files: File[]) => {
    const queued = files.map((file) => ({ key: crypto.randomUUID(), name: file.name, file }));
    setUploading((list) => [...list, ...queued.map(({ key, name }) => ({ key, name }))]);
    for (const { key, name, file } of queued) {
      try {
        if (file.size > MAX_UPLOAD_BYTES) throw new Error('The file is larger than 32 MB.');
        const ref = await rpc().call('files.upload', { name, mime: mimeFor(file), dataBase64: await readBase64(file) });
        await rpc().call('projects.addFile', { projectId, fileId: ref.id });
        // Keep the spinner row until the file row has arrived.
        await queryClient.invalidateQueries({ queryKey: keys.project(projectId) });
      } catch (error) {
        toast.error(`${name}: ${describeError(error).message}`);
      } finally {
        setUploading((list) => list.filter((u) => u.key !== key));
      }
    }
  };

  return { uploading, upload };
}

function InstructionsDialog({ project, open, onOpenChange }: { project: Project; open: boolean; onOpenChange(open: boolean): void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Project instructions" description="Every new chat in this project starts with these instructions." width={640}>
        {/* Mounted only while open, so every opening starts from the saved text. */}
        <InstructionsForm project={project} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function InstructionsForm({ project, onDone }: { project: Project; onDone(): void }) {
  const [text, setText] = useState(project.instructions);
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      await updateProject(project.id, { instructions: text.trim() });
      onDone();
    } catch (error) {
      toast.error(describeError(error).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <TextArea
        aria-label="Instructions"
        value={text}
        rows={14}
        maxLength={100_000}
        autoFocus
        placeholder="How should chats in this project respond? For example: tone, audience, format, or what to keep in mind."
        onChange={(e) => setText(e.target.value)}
        className="min-h-80"
      />
      <DialogFooter>
        <Button onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" loading={saving}>
          Save instructions
        </Button>
      </DialogFooter>
    </form>
  );
}

import { useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import type { FileRef, Project } from '@atelier/protocol';
import { Button, Dialog, DialogContent, DialogFooter, Field, TextArea, TextField, toast } from '../../components/ui/index.ts';
import { keys, queryClient } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';

/** Saves project fields and updates the cached project at once, so inline edits don't flash the old value. */
export async function updateProject(id: string, patch: { name?: string; description?: string; instructions?: string; pinned?: boolean }): Promise<void> {
  const updated = await rpc().call('projects.update', { id, ...patch });
  queryClient.setQueryData<Project & { files: FileRef[] }>(keys.project(id), (p) => p && { ...p, ...updated });
}

/** Name and description: creates a project (then opens it) or edits an existing one. */
export function ProjectDetailsDialog({ project, open, onOpenChange }: { project?: Project; open: boolean; onOpenChange(open: boolean): void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title={project ? 'Edit details' : 'New project'}>
        {/* Mounted only while open, so every opening starts from the saved values. */}
        <DetailsForm project={project} onDone={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

function DetailsForm({ project, onDone }: { project: Project | undefined; onDone(): void }) {
  const navigate = useNavigate();
  const [name, setName] = useState(project?.name ?? '');
  const [description, setDescription] = useState(project?.description ?? '');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const details = { name: name.trim(), description: description.trim() };
    if (!details.name) return;
    setSaving(true);
    try {
      if (project) await updateProject(project.id, details);
      else {
        const created = await rpc().call('projects.create', details);
        void navigate({ to: '/projects/$projectId', params: { projectId: created.id } });
      }
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
      <Field label="Name">
        <TextField value={name} maxLength={120} autoFocus placeholder="Name your project" onChange={(e) => setName(e.target.value)} />
      </Field>
      <Field label="Description" className="mt-5">
        <TextArea value={description} maxLength={2000} rows={3} placeholder="What is this project about?" onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <DialogFooter>
        <Button onClick={onDone}>Cancel</Button>
        <Button type="submit" variant="primary" loading={saving} disabled={!name.trim()}>
          {project ? 'Save' : 'Create project'}
        </Button>
      </DialogFooter>
    </form>
  );
}

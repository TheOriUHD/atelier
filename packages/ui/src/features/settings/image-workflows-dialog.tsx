/**
 * A ComfyUI provider's own workflows: each becomes an image model. Importing reads a workflow on the backend (pasted JSON,
 * or a dropped PNG or JSON file) and shows which of its inputs it found, so a person can correct that before saving.
 */
import { useRef, useState } from 'react';
import { FileUp, Pencil, Trash2 } from 'lucide-react';
import { ImageWorkflow, type ImageProviderConfig } from '@atelier/protocol';
import { Button, ConfirmDialog, Dialog, DialogClose, DialogContent, DialogFooter, Field, IconButton, Select, TextArea, TextField } from '../../components/ui/index.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { FileDropZone } from '../chat/composer.tsx';
import { configToDraft } from './image-provider-form.ts';
import { WORKFLOW_SLOTS, inputValue, mappedSummary, parseInputValue, slotOptions, withSlot, workflowInputs } from './image-workflow.ts';
import { ITEM_ROW_CLASS } from './item-row.tsx';

export interface ImageWorkflowsDialogProps {
  config: ImageProviderConfig;
  open: boolean;
  onOpenChange(open: boolean): void;
}

/** A PNG holds a whole picture as well as its workflow; past this it's not one ComfyUI saved. */
const MAX_FILE_BYTES = 32 * 1024 * 1024;

/** Select value for an input nothing fills; inputs always contain a `|`. */
const UNSET = 'unset';

function readBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).split(',')[1] ?? '');
    reader.onerror = () => reject(new Error(`Couldn’t read ${file.name}.`));
    reader.readAsDataURL(file);
  });
}

const isJson = (file: File) => file.type === 'application/json' || file.name.toLowerCase().endsWith('.json');
const isPng = (file: File) => file.type === 'image/png' || file.name.toLowerCase().endsWith('.png');

export function ImageWorkflowsDialog({ config, open, onOpenChange }: ImageWorkflowsDialogProps) {
  // Set while a read or chosen workflow is being mapped; the list shows otherwise.
  const [mapping, setMapping] = useState<ImageWorkflow | null>(null);
  const workflows = config.workflows ?? [];

  const write = (next: ImageWorkflow[]) => rpc().call('imageProviders.save', { ...configToDraft(config), workflows: next });

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setMapping(null);
      }}
    >
      <DialogContent width={560} title={mapping ? `Map ${mapping.name}` : 'Workflows'} description={mapping ? 'Which inputs Atelier fills in for each image. Anything left as it is keeps the value in the workflow.' : `Your own workflows on ${config.name}. Each one shows up as an image model.`}>
        {mapping ? (
          <MappingForm key={mapping.id} workflow={mapping} onCancel={() => setMapping(null)} onSave={async (saved) => {
            await write([...workflows.filter((w) => w.id !== saved.id), saved]);
            setMapping(null);
          }} />
        ) : (
          <div className="flex flex-col gap-6">
            {workflows.length > 0 && (
              <ul aria-label="Workflows">
                {workflows.map((w) => (
                  <WorkflowRow key={w.id} workflow={w} onEdit={() => setMapping(w)} onRemove={() => write(workflows.filter((other) => other.id !== w.id))} />
                ))}
              </ul>
            )}
            <ImportBox providerId={config.id} onRead={setMapping} />
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function WorkflowRow({ workflow, onEdit, onRemove }: { workflow: ImageWorkflow; onEdit(): void; onRemove(): Promise<unknown> }) {
  const [removing, setRemoving] = useState(false);
  return (
    <li className={ITEM_ROW_CLASS}>
      <div className="min-w-0 flex-1">
        <p className="truncate text-body-strong text-fg">{workflow.name}</p>
        <p className="truncate text-footnote text-fg-muted">{mappedSummary(workflow.map)}</p>
      </div>
      <IconButton icon={Pencil} size="sm" label={`Edit the mapping of ${workflow.name}`} onClick={onEdit} />
      <IconButton icon={Trash2} size="sm" label={`Remove ${workflow.name}`} onClick={() => setRemoving(true)} />
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove ${workflow.name}?`}
        description="It leaves the image model picker. Images it already made stay in their chats."
        confirmLabel="Remove"
        onConfirm={async () => {
          await onRemove();
        }}
      />
    </li>
  );
}

/** Pasting and dropping both end in `imageProviders.parseWorkflow`, whose refusal says what to do instead. */
function ImportBox({ providerId, onRead }: { providerId: string; onRead(workflow: ImageWorkflow): void }) {
  const [text, setText] = useState('');
  const [reading, setReading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const picker = useRef<HTMLInputElement>(null);

  const read = async (input: { text: string } | { pngBase64: string }) => {
    setReading(true);
    setError(null);
    try {
      onRead(await rpc().call('imageProviders.parseWorkflow', { ...input, providerId }));
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      setReading(false);
    }
  };

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    if (file.size > MAX_FILE_BYTES) return setError(`${file.name} is too big to be a workflow.`);
    if (isJson(file)) return read({ text: await file.text() });
    if (isPng(file)) return read({ pngBase64: await readBase64(file) });
    setError('Drop a PNG or JSON file.');
  };

  return (
    <div>
      <FileDropZone label="Drop a PNG or JSON file" onFiles={(files) => void readFile(files[0])}>
        <div className="flex flex-col gap-3">
          <Field label="Import a workflow" description="Paste the JSON from Save (API) in ComfyUI, or drop that file or a PNG ComfyUI made.">
            <TextArea rows={5} spellCheck={false} value={text} placeholder='{ "3": { "class_type": "KSampler", … } }' className="font-mono" onChange={(e) => setText(e.target.value)} />
          </Field>
          {error && (
            <p role="alert" className="text-body text-danger-text">
              {error}
            </p>
          )}
          <div className="flex items-center justify-end gap-3">
            <input
              ref={picker}
              type="file"
              accept=".json,.png,application/json,image/png"
              hidden
              aria-label="Workflow file"
              onChange={(e) => {
                void readFile(e.target.files?.[0]);
                e.target.value = '';
              }}
            />
            <Button leadingIcon={FileUp} onClick={() => picker.current?.click()}>
              Choose a file
            </Button>
            <Button variant="primary" disabled={!text.trim()} loading={reading} onClick={() => void read({ text })}>
              Read workflow
            </Button>
          </div>
        </div>
      </FileDropZone>
    </div>
  );
}

function MappingForm({ workflow, onCancel, onSave }: { workflow: ImageWorkflow; onCancel(): void; onSave(workflow: ImageWorkflow): Promise<void> }) {
  const [draft, setDraft] = useState(workflow);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputs = workflowInputs(workflow.graph);

  const save = async () => {
    const parsed = ImageWorkflow.safeParse({ ...draft, name: draft.name.trim() });
    if (!parsed.success) return setError(draft.name.trim() ? 'Choose which input takes the prompt.' : 'Enter a name.');
    setSaving(true);
    setError(null);
    try {
      await onSave(parsed.data);
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
      className="flex flex-col gap-4"
    >
      <Field label="Name">
        <TextField maxLength={100} value={draft.name} onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
      </Field>
      <div className="grid grid-cols-2 gap-x-3 gap-y-4 max-md:grid-cols-1">
        {WORKFLOW_SLOTS.map((slot) => {
          const chosen = draft.map[slot.key];
          const options = slotOptions(draft, slot, inputs);
          return (
            <Field key={slot.key} label={slot.label}>
              <Select
                variant="field"
                options={[{ value: UNSET, label: 'Not used' }, ...options]}
                value={chosen ? inputValue(chosen) : UNSET}
                onValueChange={(value) => setDraft((d) => ({ ...d, map: withSlot(d.map, slot.key, value === UNSET ? null : parseInputValue(value)) }))}
              />
            </Field>
          );
        })}
      </div>
      {error && (
        <p role="alert" className="text-body text-danger-text">
          {error}
        </p>
      )}
      <DialogFooter className="mt-2">
        <Button onClick={onCancel}>Back</Button>
        <DialogClose render={<Button />}>Cancel</DialogClose>
        <Button type="submit" variant="primary" loading={saving}>
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}

import { useEffect, useId, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent, type ReactNode } from 'react';
import { useSearch } from '@tanstack/react-router';
import { useQueryClient } from '@tanstack/react-query';
import { ArrowLeft, ArrowUp, Check, ChevronRight, Copy } from 'lucide-react';
import {
  describeImportChanges,
  describeMemoryChanges,
  FIXED_MEMORY_TITLES,
  isFixedMemorySection,
  MEMORY_LIST_SECTIONS,
  memoryLines,
  splitMemoryExport,
  type MemoryChange,
  type MemoryEntry,
} from '@atelier/protocol';
import { Button, ConfirmDialog, Dialog, DialogContent, DialogFooter, Icon, Spinner, Switch, TextArea, TextField, cn } from '../../components/ui/index.ts';
import { useOpenMemory } from '../../app/navigation.ts';
import { relativeTime, shortDate } from '../../lib/dates.ts';
import { openExternal } from '../../lib/platform.ts';
import { keys, useAccount, useMemory, useModels, usePrefs, useProjects, useSettings } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { Markdown } from '../chat/markdown.tsx';
import { ModelMenu } from '../chat/model-picker.tsx';
import { MEMORY_IMPORT_PROMPT } from './memory-import-prompt.ts';
import { SettingRow, SettingsSection } from './setting-row.tsx';
import type { SettingId } from './search-index.ts';
import { useDialog } from './use-dialog.ts';
import { usePref } from './use-setting.ts';

/** The docs page each "Learn more" opens. */
export const MEMORY_DOCS = 'https://docs.atelierhq.dev/memory/';

/** The bottom bar's placeholder cycles through these on the memory list. */
export const MEMORY_EXAMPLES = ['My dog’s name is Beans', 'Keep lists under five things', 'I work Pacific time hours', 'I’m learning Japanese', 'Call me Sam'];

/** Pseudo ids for Preferences and Profile before anything is written to them. */
const FIXED_IDS: Record<'preferences' | 'profile', string> = { preferences: 'preferences', profile: 'profile' };

/** Where the model chosen for memory requests is kept while the window is open. */
const MODEL_CHOICE_KEY = 'atelier.memoryModel';
const choiceListeners = new Set<() => void>();
/** The choice when sessionStorage can't be used. */
let unstoredChoice: string | null = null;

function storedModelChoice(): string | null {
  try {
    return sessionStorage.getItem(MODEL_CHOICE_KEY);
  } catch {
    return unstoredChoice;
  }
}

function storeModelChoice(ref: string | null): void {
  try {
    if (ref) sessionStorage.setItem(MODEL_CHOICE_KEY, ref);
    else sessionStorage.removeItem(MODEL_CHOICE_KEY);
  } catch {
    unstoredChoice = ref;
  }
  for (const listener of choiceListeners) listener();
}

function subscribeModelChoice(listener: () => void): () => void {
  choiceListeners.add(listener);
  return () => choiceListeners.delete(listener);
}

/** One choice for the import dialog and both bars; null (Default, or a model no longer visible) lets the server pick. */
function useMemoryModel(): { model: string | null; label: string; choose(ref: string | null): void } {
  const choice = useSyncExternalStore(subscribeModelChoice, storedModelChoice);
  const { data: models } = useModels();
  const chosen = choice ? models?.find((m) => m.ref === choice && !m.hidden) : undefined;
  return { model: chosen?.ref ?? null, label: chosen?.displayName ?? 'Default', choose: storeModelChoice };
}

const AUTOMATIC_MODEL = { label: 'Default', description: 'The small model, else your default model' };

/** The compact model list for one memory request, as in the composer. */
function MemoryModelMenu({ memoryModel, disabled }: { memoryModel: ReturnType<typeof useMemoryModel>; disabled?: boolean }) {
  return (
    <ModelMenu
      aria-label={`Model: ${memoryModel.label}`}
      value={memoryModel.model}
      label={memoryModel.label}
      onChange={memoryModel.choose}
      automatic={AUTOMATIC_MODEL}
      disabled={disabled}
    />
  );
}

/**
 * The memory pages fill the settings panel: the content scrolls in its own area and the bar sits on the panel's
 * bottom edge, never over the last row. The negative margin takes back the panel's bottom padding.
 */
function MemoryLayout({ children, bar }: { children: ReactNode; bar: ReactNode }) {
  return (
    <div className="-mb-12 flex h-[calc(100%+3rem)] flex-col">
      <div data-testid="memory-scroll" className="-mx-6 min-h-0 flex-1 overflow-y-auto px-6 pb-4 max-md:-mx-4 max-md:px-4">
        {children}
      </div>
      {bar}
    </div>
  );
}

/** The person's Atelier projects by id, for naming the groups of project entries. */
function useProjectNames(): (id: string | null) => string {
  const { data: projects } = useProjects();
  return (id) => projects?.find((p) => p.id === id)?.name ?? 'Project';
}

/** Settings › Memory: the toggles, import, and the person's memory; `?memory=<id>` shows one entry instead. */
export function MemoryPage() {
  const { memory } = useSearch({ strict: false }) as { memory?: string };
  return memory ? <MemoryEntryPage id={memory} /> : <MemoryOverview />;
}

/** How the person is named in "How Ada wants Atelier to respond". */
function usePersonName(): string {
  const { prefs } = usePrefs();
  const { account } = useAccount();
  return prefs?.callMe.trim() || account?.name.split(' ')[0] || 'you';
}

function fixedSummary(section: 'preferences' | 'profile', name: string): string {
  return section === 'preferences' ? `How ${name} wants Atelier to respond` : `Who ${name} is`;
}

function MemoryOverview() {
  const { data: entries, isPending, error } = useMemory();
  const name = usePersonName();
  const qc = useQueryClient();
  const fixed = (section: 'preferences' | 'profile') => entries?.find((e) => e.section === section);
  return (
    <MemoryLayout
      bar={
        <MemoryBar
          placeholders={MEMORY_EXAMPLES}
          label="Tell Atelier something to remember"
          send={async (text, model) => (await rpc().call('memory.instruct', { text, ...(model ? { model } : {}) })).changes}
          onChanged={() => void qc.invalidateQueries({ queryKey: keys.memory })}
        />
      }
    >
      <SettingsSection title="Memory">
        <MemoryToggle id="memory.searchChats" field="searchChats" anchor="search-and-reference-chats" />
        <MemoryToggle id="memory.generate" field="generate" anchor="generate-memory-from-chats" />
        <MemoryToggle id="memory.sensitive" field="sensitive" anchor="sensitive-topics" />
        <ImportRow />
      </SettingsSection>
      <SettingsSection title="You" id="memory.entries">
        {isPending ? (
          <div className="flex justify-center py-6 text-fg-muted">
            <Spinner size="md" label="Loading memory" />
          </div>
        ) : error ? (
          <p role="alert" className="text-body text-danger-text">
            {describeError(error).message}
          </p>
        ) : (
          <ul className="flex flex-col">
            {(['preferences', 'profile'] as const).map((section) => {
              const entry = fixed(section);
              return (
                <MemoryRow
                  key={section}
                  id={entry?.id ?? FIXED_IDS[section]}
                  title={FIXED_MEMORY_TITLES[section]}
                  summary={fixedSummary(section, name)}
                  updatedAt={entry && (entry.details || entry.summary) ? entry.updatedAt : null}
                />
              );
            })}
          </ul>
        )}
      </SettingsSection>
      {entries &&
        MEMORY_LIST_SECTIONS.map(({ section, title }) => {
          const list = entries.filter((e) => e.section === section);
          if (!list.length) return null;
          return (
            <SettingsSection key={section} title={title}>
              {section === 'project' ? (
                <ProjectGroups entries={list} />
              ) : (
                <ul className="flex flex-col">
                  {list.map((e) => (
                    <MemoryRow key={e.id} id={e.id} title={e.title} summary={e.summary} updatedAt={e.updatedAt} />
                  ))}
                </ul>
              )}
            </SettingsSection>
          );
        })}
      {entries && !entries.some((e) => !isFixedMemorySection(e.section)) && (
        <p className="mt-6 text-body text-fg-muted">Topics, areas, people and project notes show up here as Atelier learns about them from your chats, or tell it something below.</p>
      )}
    </MemoryLayout>
  );
}

function MemoryToggle({ id, field, anchor }: { id: SettingId; field: 'searchChats' | 'generate' | 'sensitive'; anchor: string }) {
  const setting = usePref<boolean>(['memory', field]);
  return (
    <SettingRow id={id} setting={setting} detail={<LearnMore anchor={anchor} />}>
      {(label) => <Switch {...label} checked={!!setting.value} onCheckedChange={(on) => void setting.set(on)} />}
    </SettingRow>
  );
}

function LearnMore({ anchor }: { anchor?: string }) {
  return (
    <button type="button" onClick={() => openExternal(`${MEMORY_DOCS}${anchor ? `#${anchor}` : ''}`)} className="rounded-xs text-interactive-text outline-none focus-ring hover:underline">
      Learn more
    </button>
  );
}

/** Project entries grouped under their Atelier project, each group behind a chevron. */
function ProjectGroups({ entries }: { entries: MemoryEntry[] }) {
  const projectName = useProjectNames();
  const ids = [...new Set(entries.map((e) => e.projectId))];
  const groups = ids.map((id) => ({ id, name: projectName(id), entries: entries.filter((e) => e.projectId === id) })).sort((a, b) => a.name.localeCompare(b.name));
  return (
    <ul className="flex flex-col">
      {groups.map((g) => (
        <ProjectGroup key={g.id ?? ''} name={g.name} entries={g.entries} />
      ))}
    </ul>
  );
}

function ProjectGroup({ name, entries }: { name: string; entries: MemoryEntry[] }) {
  const [open, setOpen] = useState(false);
  return (
    <li className="border-b border-line-subtle last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex min-h-11 w-full items-center gap-2 rounded-sm py-2 text-left text-body outline-none focus-ring hover:bg-fill-ghost-hover"
      >
        <Icon icon={ChevronRight} className={cn('shrink-0 text-fg-muted transition-transform duration-(--at-duration-snap) ease-snap', open && 'rotate-90')} />
        <span className="min-w-0 flex-1 truncate text-fg">{name}</span>
        <span className="shrink-0 text-footnote text-fg-muted">{entries.length === 1 ? '1 entry' : `${entries.length} entries`}</span>
      </button>
      {open && (
        <ul className="ml-6 flex flex-col border-t border-line-subtle">
          {entries.map((e) => (
            <MemoryRow key={e.id} id={e.id} title={e.title} summary={e.summary} updatedAt={e.updatedAt} />
          ))}
        </ul>
      )}
    </li>
  );
}

/** Title in a 160px column, the summary on one line, when it changed on the right; the whole row opens the entry. */
function MemoryRow({ id, title, summary, updatedAt }: { id: string; title: string; summary: string; updatedAt: number | null }) {
  const open = useOpenMemory();
  return (
    <li className="flex items-center gap-1 border-b border-line-subtle last:border-b-0">
      <button
        type="button"
        onClick={() => open(id)}
        className="grid min-h-11 min-w-0 flex-1 grid-cols-[160px_minmax(0,1fr)_auto] items-center gap-4 rounded-sm py-2 text-left text-body outline-none focus-ring hover:bg-fill-ghost-hover max-md:grid-cols-[minmax(0,1fr)_auto]"
      >
        <span className="truncate text-fg">{title}</span>
        <span className="truncate text-fg-secondary max-md:hidden">{summary}</span>
        <span className="shrink-0 text-footnote text-fg-muted">{updatedAt === null ? 'Empty' : `Updated ${relativeTime(updatedAt)}`}</span>
      </button>
    </li>
  );
}

// ------------------------------------------------------------------ import

function ImportRow() {
  const dialog = useDialog();
  return (
    <SettingRow id="memory.import" detail={<LearnMore anchor="import-memory" />}>
      <Button onClick={dialog.show}>Start import</Button>
      <ImportDialog key={dialog.key} open={dialog.open} onOpenChange={dialog.onOpenChange} />
    </SettingRow>
  );
}

/** Two steps: copy the prompt into the other assistant, paste its answer back; a model merges it into memory. */
export function ImportDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [copied, setCopied] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [progress, setProgress] = useState<{ part: number; total: number } | null>(null);
  const [finished, setFinished] = useState(false);
  const memoryModel = useMemoryModel();

  const copy = async () => {
    await navigator.clipboard?.writeText(MEMORY_IMPORT_PROMPT).catch(() => undefined);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };
  const add = async (e: FormEvent) => {
    e.preventDefault();
    if (!text.trim() || pending) return;
    setPending(true);
    setError(null);
    setResult(null);
    // A part at a time, so no model reply has to hold the whole export and the dialog can show how far it got.
    const parts = splitMemoryExport(text);
    const changes: MemoryChange[] = [];
    try {
      for (const [i, part] of parts.entries()) {
        setProgress({ part: i + 1, total: parts.length });
        changes.push(...(await rpc().call('memory.import', { text: part, ...(memoryModel.model ? { model: memoryModel.model } : {}) })).changes);
        void qc.invalidateQueries({ queryKey: keys.memory });
      }
      if (changes.length) {
        setResult(`${describeImportChanges(changes)}.`);
        setFinished(true);
      } else setResult('Nothing in it could be added to memory. Check that you pasted the whole answer.');
    } catch (err) {
      setError(`${describeError(err).message}${changes.length ? ` Before that: ${describeImportChanges(changes).toLowerCase()}.` : ''}`);
    } finally {
      setPending(false);
      setProgress(null);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => pending || onOpenChange(next)}>
      <DialogContent title="Import memory to Atelier" width={560}>
        <form onSubmit={(e) => void add(e)} className="flex flex-col gap-5">
          <section className="flex flex-col gap-2">
            <h3 className="text-body font-medium text-fg">1. Copy this prompt into a chat with your other AI provider</h3>
            <div className="relative">
              <pre aria-label="Import prompt" className="max-h-40 overflow-y-auto rounded-lg bg-fill-field p-3 pr-12 font-sans text-footnote whitespace-pre-wrap text-fg-secondary inset-ring inset-ring-fill-field-ring">
                {MEMORY_IMPORT_PROMPT}
              </pre>
              <Button size="sm" variant="secondary" leadingIcon={copied ? Check : Copy} onClick={() => void copy()} className="absolute top-2 right-2">
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          </section>
          <section className="flex flex-col gap-2">
            <label htmlFor="memory-import-text" className="text-body font-medium text-fg">
              2. Paste the result below to add it to Atelier’s memory
            </label>
            <TextArea id="memory-import-text" rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the export here" disabled={pending || finished} />
            {progress && <ImportProgress {...progress} />}
            {result && !pending && (
              <p role="status" className={cn('text-footnote', finished ? 'text-fg' : 'text-fg-muted')}>
                {result}
              </p>
            )}
            {error && (
              <p role="alert" className="text-footnote text-danger-text">
                {error}
              </p>
            )}
          </section>
          <DialogFooter>
            {finished ? (
              <Button variant="primary" onClick={() => onOpenChange(false)}>
                Done
              </Button>
            ) : (
              <>
                <Button disabled={pending} onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <MemoryModelMenu memoryModel={memoryModel} disabled={pending} />
                <Button type="submit" variant="primary" disabled={!text.trim()} loading={pending}>
                  Add to memory
                </Button>
              </>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** "Adding 3 of 7…" with a thin bar; one part reads as a plain wait. */
function ImportProgress({ part, total }: { part: number; total: number }) {
  return (
    <div className="flex flex-col gap-1.5">
      <p className="text-footnote text-fg-muted">{total > 1 ? `Adding ${part} of ${total}… This can take a few minutes.` : 'Adding to memory… This can take a minute.'}</p>
      {total > 1 && (
        <div role="progressbar" aria-label="Import progress" aria-valuemin={0} aria-valuemax={total} aria-valuenow={part - 1} className="h-1 overflow-hidden rounded-full bg-fill-field">
          <div className="h-full rounded-full bg-accent transition-[width] duration-(--at-duration-fast)" style={{ width: `${((part - 1) / total) * 100}%` }} />
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ one entry

function MemoryEntryPage({ id }: { id: string }) {
  const { data: entries, isPending } = useMemory();
  const { settings } = useSettings();
  const name = usePersonName();
  const projectName = useProjectNames();
  const back = useOpenMemory();
  const qc = useQueryClient();
  const confirm = useDialog();
  const [editing, setEditing] = useState(false);
  const pseudo = id === FIXED_IDS.preferences || id === FIXED_IDS.profile ? (id as 'preferences' | 'profile') : null;
  const entry = entries?.find((e) => e.id === id) ?? (pseudo ? entries?.find((e) => e.section === pseudo) : undefined);
  const section = entry?.section ?? pseudo;
  const fixed = section && isFixedMemorySection(section) ? section : null;
  const title = fixed ? FIXED_MEMORY_TITLES[fixed] : entry?.title;
  const empty = !entry || (!entry.details.trim() && !entry.summary.trim());
  const editable = !!settings?.memory?.manualEditing;

  const remove = async () => {
    if (!entry) return;
    await rpc().call('memory.delete', { id: entry.id });
    await qc.invalidateQueries({ queryKey: keys.memory });
    if (!fixed) back();
  };

  return (
    <MemoryLayout
      bar={
        title &&
        !editing && (
          <MemoryBar
            placeholders={['Tell Atelier what to change']}
            label={`Tell Atelier what to change in ${title}`}
            send={async (text, model) =>
              (await rpc().call('memory.instruct', { text, ...(entry ? { entryId: entry.id } : fixed ? { section: fixed } : {}), ...(model ? { model } : {}) })).changes
            }
            onChanged={(changes) => {
              void qc.invalidateQueries({ queryKey: keys.memory });
              if (entry && changes.some((c) => c.op === 'deleted' && c.id === entry.id) && !fixed) back();
            }}
          />
        )
      }
    >
      <button type="button" onClick={() => back()} className="-mt-1 mb-4 flex items-center gap-1.5 rounded-sm text-body text-fg-secondary outline-none focus-ring hover:text-fg">
        <Icon icon={ArrowLeft} />
        Memory
      </button>
      {isPending ? (
        <div className="flex justify-center py-6 text-fg-muted">
          <Spinner size="md" label="Loading memory" />
        </div>
      ) : !title ? (
        <p className="text-body text-fg-muted">This memory no longer exists.</p>
      ) : editing ? (
        <EntryEditor
          entry={entry}
          fixed={fixed}
          title={title}
          onDone={() => {
            setEditing(false);
            void qc.invalidateQueries({ queryKey: keys.memory });
          }}
        />
      ) : (
        <>
          <div className="mb-6 flex items-center justify-between gap-4">
            <h2 className="min-w-0 text-section-heading break-words text-fg">{title}</h2>
            <div className="flex shrink-0 items-center gap-2">
              {editable && <Button onClick={() => setEditing(true)}>Edit</Button>}
              {entry && !(fixed && empty) && (
                <>
                  <Button onClick={confirm.show}>{fixed ? 'Clear' : 'Delete'}</Button>
                  <ConfirmDialog
                    key={confirm.key}
                    open={confirm.open}
                    onOpenChange={confirm.onOpenChange}
                    title={fixed ? `Clear ${title}?` : 'Delete this memory?'}
                    description={fixed ? `Atelier forgets everything in ${title}. You can tell it again any time.` : `Atelier forgets “${title}”. This can’t be undone.`}
                    confirmLabel={fixed ? 'Clear' : 'Delete'}
                    onConfirm={remove}
                  />
                </>
              )}
            </div>
          </div>
          <dl className="flex flex-col gap-5 text-body">
            {entry?.projectId && (
              <div>
                <dt className="mb-1 text-footnote text-fg-muted">Project</dt>
                <dd className="text-fg">{projectName(entry.projectId)}</dd>
              </div>
            )}
            <div>
              <dt className="mb-1 text-footnote text-fg-muted">Last updated</dt>
              <dd className="text-fg">{entry && !empty ? shortDate(entry.updatedAt) : 'Not yet'}</dd>
            </div>
            <div>
              <dt className="mb-1 text-footnote text-fg-muted">Summary</dt>
              <dd className="text-fg">{fixed ? fixedSummary(fixed, name) : entry?.summary || '—'}</dd>
            </div>
            <div>
              <dt className="mb-1 text-footnote text-fg-muted">Details</dt>
              {/* Settings' own type, not the chat's: the interface font at body size. */}
              <dd className="text-fg [--at-font-chat:var(--at-font-ui)] [--at-text-prose-leading:var(--at-text-body-leading)] [--at-text-prose-size:var(--at-text-body-size)]">{entry?.details.trim() ? <Markdown text={entry.details} streaming={false} /> : <span className="text-fg-muted">Nothing yet. Tell Atelier below.</span>}</dd>
            </div>
          </dl>
        </>
      )}
    </MemoryLayout>
  );
}

/** Editing by hand (when the administrator allows it): title and summary of a list entry, details one fact per line. */
function EntryEditor({ entry, fixed, title, onDone }: { entry: MemoryEntry | undefined; fixed: 'preferences' | 'profile' | null; title: string; onDone(): void }) {
  const [draftTitle, setDraftTitle] = useState(entry?.title ?? '');
  const [summary, setSummary] = useState(entry?.summary ?? '');
  const [details, setDetails] = useState(() => memoryLines(entry?.details ?? '').join('\n'));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ids = useId();

  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (saving || (!fixed && !draftTitle.trim())) return;
    setSaving(true);
    setError(null);
    try {
      await rpc().call('memory.update', { ...(entry ? { id: entry.id } : fixed ? { section: fixed } : {}), ...(fixed ? {} : { title: draftTitle.trim(), summary }), details });
      onDone();
    } catch (err) {
      setError(describeError(err).message);
      setSaving(false);
    }
  };

  return (
    <form onSubmit={(e) => void save(e)} className="flex flex-col gap-5" aria-label={`Edit ${title}`}>
      {fixed ? (
        <h2 className="text-section-heading text-fg">{title}</h2>
      ) : (
        <>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${ids}-title`} className="text-footnote text-fg-muted">
              Title
            </label>
            <TextField id={`${ids}-title`} value={draftTitle} onChange={(e) => setDraftTitle(e.target.value)} maxLength={120} invalid={!draftTitle.trim()} disabled={saving} />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor={`${ids}-summary`} className="text-footnote text-fg-muted">
              Summary
            </label>
            <TextField id={`${ids}-summary`} value={summary} onChange={(e) => setSummary(e.target.value)} maxLength={300} disabled={saving} />
          </div>
        </>
      )}
      <div className="flex flex-col gap-1.5">
        <label htmlFor={`${ids}-details`} className="text-footnote text-fg-muted">
          Details, one fact per line
        </label>
        <TextArea id={`${ids}-details`} value={details} onChange={(e) => setDetails(e.target.value)} rows={14} disabled={saving} />
      </div>
      {error && (
        <p role="alert" className="text-footnote text-danger-text">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button disabled={saving} onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" loading={saving} disabled={!fixed && !draftTitle.trim()}>
          Save
        </Button>
      </div>
    </form>
  );
}

// ------------------------------------------------------------------ the bottom bar

/**
 * The composer-like bar at the bottom of the memory pages: what the person types goes to a model that changes memory,
 * and a line under it says what happened ("Updating memory…", then "Updated Preferences").
 */
export function MemoryBar({
  placeholders,
  label,
  send,
  onChanged,
}: {
  placeholders: readonly string[];
  label: string;
  /** `model` is the one chosen in the bar, null for Default. */
  send(text: string, model: string | null): Promise<MemoryChange[]>;
  onChanged(changes: MemoryChange[]): void;
}) {
  const [text, setText] = useState('');
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState<{ text: string; error?: boolean } | null>(null);
  const [example, setExample] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const memoryModel = useMemoryModel();

  useEffect(() => {
    if (placeholders.length < 2 || text) return;
    const timer = setInterval(() => setExample((i) => (i + 1) % placeholders.length), 4000);
    return () => clearInterval(timer);
  }, [placeholders.length, text]);

  const submit = async () => {
    const value = text.trim();
    if (!value || pending) return;
    setPending(true);
    setStatus({ text: 'Updating memory…' });
    try {
      const changes = await send(value, memoryModel.model);
      setText('');
      setStatus({ text: changes.length ? describeMemoryChanges(changes) : 'Nothing to change in memory' });
      onChanged(changes);
    } catch (err) {
      setStatus({ text: describeError(err).message, error: true });
    } finally {
      setPending(false);
      input.current?.focus();
    }
  };
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div data-testid="memory-bar" className="shrink-0 bg-surface pt-3 pb-6 max-md:pb-4">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
        className="flex items-end gap-2 rounded-composer bg-raised p-2 pl-4 shadow-composer"
      >
        <textarea
          ref={input}
          aria-label={label}
          rows={1}
          value={text}
          disabled={pending}
          placeholder={placeholders[example % placeholders.length]}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          className="max-h-32 min-h-8 flex-1 resize-none bg-transparent py-1.5 text-body text-fg outline-none [field-sizing:content] placeholder:text-fg-muted disabled:opacity-60"
        />
        <div className="flex h-8 shrink-0 items-center">
          <MemoryModelMenu memoryModel={memoryModel} disabled={pending} />
        </div>
        <button
          type="submit"
          aria-label="Send"
          disabled={!text.trim() || pending}
          className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-accent text-on-accent outline-none transition-opacity duration-(--at-duration-fast) focus-ring hover:bg-accent-hover disabled:opacity-40"
        >
          {pending ? <Spinner size="sm" label="Updating memory" /> : <Icon icon={ArrowUp} size="sm" />}
        </button>
      </form>
      <p role="status" aria-live="polite" className={cn('mt-2 min-h-5 px-1 text-footnote', status?.error ? 'text-danger-text' : 'text-fg-muted')}>
        {status?.text}
      </p>
    </div>
  );
}

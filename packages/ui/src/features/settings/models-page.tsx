import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Calculator, MoreHorizontal, Plus, SlidersHorizontal, Star, Trash2, Wrench } from 'lucide-react';
import { modelRef, type ModelInfo, type ModelOverride, type Settings } from '@atelier/protocol';
import {
  Badge,
  Button,
  Icon,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Switch,
  TextField,
  cn,
  toast,
} from '../../components/ui/index.ts';
import { useOpenSettings } from '../../app/navigation.ts';
import { keys, useModels, useSetSetting, useSettings } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { formatTokens } from '../chat/models.ts';
import { ModelOverridesDialog } from './model-overrides-dialog.tsx';
import { isUnavailable, ModelSelect } from './model-select.tsx';
import { settingEntry, type SettingId } from './search-index.ts';
import { SettingRow, SettingsSection } from './setting-row.tsx';
import { useSetting, useWrite } from './use-setting.ts';

type Alias = keyof Settings['models']['aliases'];
const ALIASES: Alias[] = ['opus', 'sonnet', 'haiku', 'fable'];

export function ModelsPage() {
  // The admin's own models on their computers are theirs, not everyone's: they aren't set up here.
  const { data: listed = [] } = useModels();
  const models = useMemo(() => listed.filter((m) => !m.personal), [listed]);
  const { settings } = useSettings();
  const providerNames = useMemo(() => new Map(settings?.providers.map((p) => [p.id, p.name])), [settings?.providers]);
  const groups = useMemo(() => {
    const byProvider = new Map<string, ModelInfo[]>();
    for (const m of models) byProvider.set(m.providerId, [...(byProvider.get(m.providerId) ?? []), m]);
    // A provider that lists no models still gets its block, so a model can be added to it by id.
    for (const p of settings?.providers ?? []) if (p.enabled && !byProvider.has(p.id)) byProvider.set(p.id, []);
    return [...byProvider];
  }, [models, settings?.providers]);
  const visible = models.filter((m) => !m.hidden);
  const list = settingEntry('models.list');
  const qc = useQueryClient();
  const [calculating, setCalculating] = useState(false);
  const calculateAll = async () => {
    setCalculating(true);
    try {
      const statuses = await rpc().call('providers.refresh', {});
      await qc.invalidateQueries({ queryKey: keys.models });
      await qc.invalidateQueries({ queryKey: keys.providers });
      const unavailable = statuses.filter((status) => !status.ok);
      if (unavailable.length) toast.warning('Recalculated with cached metadata for unavailable providers', { description: 'Reconnect those providers to refresh missing model metadata. Manual overrides were preserved.' });
      else toast.success('Recalculated all models', { description: 'Fresh model metadata and current memory budgets applied. Manual overrides were preserved.' });
    } catch (error) {
      toast.error(describeError(error).message);
    } finally {
      setCalculating(false);
    }
  };

  return (
    <>
      <SettingsSection title="Defaults">
        <ModelSelectRow
          id="models.defaults.chat"
          path={['models', 'defaults', 'chat']}
          unsetLabel="First available model"
          unavailable="This model is no longer available. New chats start with the first available model until you choose another."
          models={visible}
          providerNames={providerNames}
        />
        <ModelSelectRow
          id="models.defaults.small"
          path={['models', 'defaults', 'small']}
          unsetLabel="Same as the chat"
          unavailable="This model is no longer available. Titles, summaries and memory use the chat’s model until you choose another."
          models={visible}
          providerNames={providerNames}
        />
      </SettingsSection>
      <SettingsSection id="models.list" title={list.label} description={list.description} action={<Button size="sm" variant="ghost" leadingIcon={Calculator} loading={calculating} disabled={groups.length === 0} onClick={() => void calculateAll()}>Calculate all</Button>}>
        {groups.length === 0 ? (
          <EmptyModels />
        ) : (
          groups.map(([providerId, group]) => (
            <ModelTable key={providerId} providerId={providerId} label={providerNames.get(providerId) ?? providerId} models={group} />
          ))
        )}
      </SettingsSection>
      <SettingsSection
        title="Aliases"
        description="Agent files written for Claude Code ask for opus, sonnet, haiku or fable. Choose which of your models answers to each name."
      >
        {ALIASES.map((alias) => (
          <ModelSelectRow
            key={alias}
            id={`models.aliases.${alias}`}
            path={['models', 'aliases', alias]}
            unsetLabel="Not set"
            models={visible}
            providerNames={providerNames}
          />
        ))}
      </SettingsSection>
    </>
  );
}

function EmptyModels() {
  const openSettings = useOpenSettings();
  return (
    <div className="flex items-center justify-between gap-4 rounded-2xl bg-fill-ghost-hover p-4">
      <p className="text-body text-fg-muted">Models appear here once a provider is connected.</p>
      <Button size="sm" variant="primary" onClick={() => openSettings('providers')}>
        Go to Providers
      </Button>
    </div>
  );
}

/** A system default or alias; `unavailable` is the warning while it points at a model that isn't visible. */
function ModelSelectRow({
  id,
  path,
  unsetLabel,
  unavailable,
  models,
  providerNames,
}: {
  id: SettingId;
  path: string[];
  unsetLabel: string;
  unavailable?: string;
  models: ModelInfo[];
  providerNames: Map<string, string>;
}) {
  const setting = useSetting<string | undefined>(path);
  return (
    <SettingRow id={id} setting={setting} error={unavailable && isUnavailable(setting.value, models) ? unavailable : null}>
      {(label) => <ModelSelect {...label} setting={setting} unsetLabel={unsetLabel} models={models} providerNames={providerNames} />}
    </SettingRow>
  );
}

// Narrow screens keep the columns readable and scroll the table sideways.
const COLUMNS = 'grid grid-cols-[minmax(0,1fr)_72px_216px_32px_44px_32px] items-center gap-x-3 max-md:min-w-160';

function ModelTable({ providerId, label, models }: { providerId: string; label: string; models: ModelInfo[] }) {
  const { settings } = useSettings();
  const [catalog, setCatalog] = useState(false);
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(0);
  const enabled = (model: ModelInfo) => !(settings?.models.overrides[model.ref]?.hidden ?? model.hidden);
  const active = models.filter(enabled);
  const query = search.trim().toLowerCase();
  const matches = (catalog ? models : active).filter((model) => !query || `${model.displayName} ${model.modelId}`.toLowerCase().includes(query));
  const pageSize = 20;
  const currentPage = Math.min(page, Math.max(0, Math.ceil(matches.length / pageSize) - 1));
  const shown = matches.slice(currentPage * pageSize, (currentPage + 1) * pageSize);
  return (
    <div className="mb-6 rounded-xl border border-line p-4 last:mb-0">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-body-strong text-fg">{label}</h3>
          <p className="text-footnote text-fg-muted">{active.length} enabled · {models.length} available</p>
        </div>
        <div className="flex items-center gap-1 rounded-lg bg-fill-ghost-hover p-1" role="group" aria-label={`${label} model view`}>
          <Button size="sm" variant={catalog ? 'ghost' : 'secondary'} aria-pressed={!catalog} onClick={() => { setCatalog(false); setPage(0); }}>Your models</Button>
          <Button size="sm" variant={catalog ? 'secondary' : 'ghost'} aria-pressed={catalog} onClick={() => { setCatalog(true); setPage(0); }}>Browse catalog</Button>
        </div>
      </div>
      <TextField aria-label={`Search ${label} models`} placeholder="Search models by name or id…" value={search} onChange={(event) => { setSearch(event.target.value); setPage(0); }} className="mb-3" />
      {catalog && <p className="mb-3 text-footnote text-fg-muted">Choose which models appear in the picker. This library is shared across this installation.</p>}
      {matches.length === 0 && <div className="py-6 text-center text-body text-fg-muted">{query ? 'No matching models.' : catalog ? 'No models discovered yet.' : 'Your model library is empty. Browse the catalog to enable a model.'}</div>}
      <div role="table" aria-label={label} className="max-md:overflow-x-auto">
        <div role="row" className={cn(COLUMNS, 'h-[34px] border-b border-line-subtle text-footnote text-fg-muted')}>
          <span role="columnheader" className="pl-2">
            {label}
          </span>
          <span role="columnheader" className="text-right">
            Context
          </span>
          <span role="columnheader">Capabilities</span>
          <span role="columnheader" className="sr-only">
            Favorite
          </span>
          <span role="columnheader" className="text-center">
            Visible
          </span>
          <span role="columnheader" className="sr-only">
            Actions
          </span>
        </div>
        {shown.map((m) => (
          <ModelRow key={m.ref} model={m} />
        ))}
      </div>
      {matches.length > pageSize && <div className="mt-3 flex items-center justify-between gap-3 text-footnote text-fg-muted">
        <span>{currentPage * pageSize + 1}–{Math.min((currentPage + 1) * pageSize, matches.length)} of {matches.length}</span>
        <div className="flex gap-1">
          <Button size="sm" variant="ghost" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</Button>
          <Button size="sm" variant="ghost" disabled={(currentPage + 1) * pageSize >= matches.length} onClick={() => setPage(currentPage + 1)}>Next</Button>
        </div>
      </div>}
      <AddModelById providerId={providerId} label={label} models={models} />
    </div>
  );
}

/** Lists a model the provider's model list leaves out; the backend fills in default limits for it. */
function AddModelById({ providerId, label, models }: { providerId: string; label: string; models: ModelInfo[] }) {
  const qc = useQueryClient();
  const { mutateAsync } = useSetSetting();
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const close = () => {
    setDraft(null);
    setError(null);
  };

  if (draft === null) {
    return (
      <Button size="xs" variant="ghost" leadingIcon={Plus} className="mt-1.5" onClick={() => setDraft('')}>
        Add model by id
      </Button>
    );
  }

  const add = async () => {
    const id = draft.trim();
    if (!id || /\s/.test(id)) return setError('Enter the id the provider uses, without spaces.');
    if (models.some((m) => m.modelId === id)) return setError(`${id} is in the list already.`);
    setSaving(true);
    setError(null);
    try {
      await mutateAsync({ path: ['models', 'overrides', modelRef(providerId, id), 'manual'], value: true });
      await qc.invalidateQueries({ queryKey: keys.models });
      close();
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
        void add();
      }}
      className="mt-2 flex flex-col gap-1.5"
    >
      <div className="flex items-center gap-2">
        <TextField
          autoFocus
          aria-label={`Model id to add to ${label}`}
          placeholder="Model id, e.g. glm-5.3-flash-free"
          autoComplete="off"
          spellCheck={false}
          value={draft}
          invalid={error !== null}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key !== 'Escape') return;
            // Escape leaves the field, not Settings.
            e.stopPropagation();
            close();
          }}
          className="h-7 flex-1 font-mono"
        />
        <Button size="sm" variant="ghost" onClick={close}>
          Cancel
        </Button>
        <Button size="sm" type="submit" variant="primary" loading={saving}>
          Add
        </Button>
      </div>
      {error && (
        <p role="alert" className="text-footnote text-danger-text">
          {error}
        </p>
      )}
    </form>
  );
}

/** One override field of a model. The backend applies overrides and republishes `models.changed`. */
function useOverride<K extends keyof ModelOverride>(ref: string, key: K) {
  const setting = useSetting<ModelOverride[K]>(['models', 'overrides', ref, key], { toast: true });
  return {
    value: setting.value,
    set: (value: NonNullable<ModelOverride[K]>) => void setting.set(value),
    clear: () => void setting.clear(),
  };
}

const TOOL_LABELS: Record<ModelInfo['capabilities']['tools'], string> = { native: 'Tools', prompted: 'Prompted tools', none: 'No tools' };

function ModelRow({ model }: { model: ModelInfo }) {
  const displayName = useOverride(model.ref, 'displayName');
  const hidden = useOverride(model.ref, 'hidden');
  const favorite = useOverride(model.ref, 'favorite');
  const context = useOverride(model.ref, 'contextLength');
  const { settings } = useSettings();
  const memoryBudget = settings?.providers.find((provider) => provider.id === model.providerId)?.vramGiB;
  const [editing, setEditing] = useState(false);
  const qc = useQueryClient();
  const { run } = useWrite({ toast: true });
  // Overrides from the (optimistically updated) settings win until `models.list` catches up.
  const name = displayName.value ?? model.displayName;
  const isHidden = hidden.value ?? model.hidden;
  const isFavorite = favorite.value ?? model.favorite;
  const caps = model.capabilities;

  const probe = () =>
    toast.promise(rpc().call('models.probeTools', { ref: model.ref }), {
      loading: `Testing tool calling on ${name}…`,
      success: (result) => result.detail,
      error: (e: unknown) => describeError(e).message,
    });

  const remove = () =>
    run(async () => {
      await rpc().call('settings.reset', { layer: 'global', path: ['models', 'overrides', model.ref] });
      await qc.invalidateQueries({ queryKey: keys.models });
    });

  return (
    <div role="row" className={cn(COLUMNS, 'min-h-11 border-b border-line-subtle py-1.5 last:border-b-0')}>
      <div role="cell" className={cn('min-w-0', isHidden && 'opacity-60')}>
        <NameField
          name={name}
          label={`Display name for ${model.modelId}`}
          onCommit={(next) => (next ? displayName.set(next) : displayName.clear())}
        />
        {name !== model.modelId && <p className="truncate px-2 font-mono text-caption text-fg-muted">{model.modelId}</p>}
      </div>
      <span role="cell" className="text-right text-body text-fg-secondary tabular-nums">
        {formatTokens(model.calculatedContextLength ?? context.value ?? model.contextLength)}
        {model.calculatedContextLength !== undefined ? <span className="block text-caption text-fg-muted" title={`Effective request context: ${formatTokens(context.value ?? model.contextLength)}. Model overrides take priority over the calculated budget.`}>Calculated</span> : memoryBudget !== undefined && <span className="block text-caption text-fg-muted" title="Calculation requires cached model weight size and architecture. Reconnect once to collect missing metadata; VRAM alone is insufficient.">Not calculated</span>}
      </span>
      <div role="cell" className="flex flex-wrap gap-1">
        <Badge tone={caps.tools === 'prompted' ? 'warning' : 'neutral'}>{TOOL_LABELS[caps.tools]}</Badge>
        {caps.vision && <Badge>Vision</Badge>}
        {caps.reasoning !== 'none' && <Badge>Reasoning</Badge>}
        {model.free && <Badge tone="success">Free</Badge>}
      </div>
      <div role="cell">
        <Button
          iconOnly
          size="sm"
          variant="ghost"
          aria-label={`Favorite ${name}`}
          aria-pressed={isFavorite}
          onClick={() => (isFavorite ? favorite.clear() : favorite.set(true))}
        >
          <Icon icon={Star} className={isFavorite ? 'fill-current text-fg' : 'text-fg-muted'} />
        </Button>
      </div>
      <div role="cell" className="flex justify-center">
        <Switch
          size="sm"
          aria-label={`Show ${name} in the model picker`}
          checked={!isHidden}
          onCheckedChange={(on) => hidden.set(!on)}
        />
      </div>
      <div role="cell">
        <Menu>
          <MenuTrigger render={<IconButton icon={MoreHorizontal} label={`${name} options`} size="sm" />} />
          <MenuContent align="end">
            <MenuItem icon={SlidersHorizontal} onClick={() => setEditing(true)}>
              Edit overrides…
            </MenuItem>
            <MenuItem icon={Wrench} onClick={() => void probe()}>
              Probe tool calling
            </MenuItem>
            {model.manual && (
              <>
                <MenuSeparator />
                <MenuItem icon={Trash2} danger onClick={() => void remove()}>
                  Remove
                </MenuItem>
              </>
            )}
          </MenuContent>
        </Menu>
        <ModelOverridesDialog model={model} open={editing} onOpenChange={setEditing} />
      </div>
    </div>
  );
}

/** Looks like text until focused; commits on blur or Enter. An empty name restores the detected one. */
function NameField({ name, label, onCommit }: { name: string; label: string; onCommit(next: string): void }) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      aria-label={label}
      value={draft ?? name}
      onFocus={() => setDraft(name)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft !== null && draft.trim() !== name) onCommit(draft.trim());
        setDraft(null);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
      className={cn(
        'h-7 w-full min-w-0 truncate rounded-md bg-transparent px-2 text-body text-fg outline-none',
        'transition-[background-color,box-shadow] duration-(--at-duration-fast) ease-standard',
        'hover:bg-fill-ghost-hover focus:bg-fill-field focus:inset-ring focus:inset-ring-fill-field-ring focus-visible:shadow-focus',
      )}
    />
  );
}

/** Settings › Admin › Image providers (ARCHITECTURE §23): where images are made, which models people get, and the limits. */
import { useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Cloud, MoreHorizontal, Pencil, Plus, RefreshCw, Server, SlidersHorizontal, Star, Trash2, Workflow } from 'lucide-react';
import type { DetectedImageServer, ImageModelInfo, ImageModelOverride, ImageProviderConfig, ProviderStatus, Settings } from '@atelier/protocol';
import {
  Badge,
  Button,
  ConfirmDialog,
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
import { keys, useImageModels, useImageProviderStatus, useSettings } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { ImageModelDialog } from './image-model-dialog.tsx';
import { detectedDraft, presetFor } from './image-provider-form.ts';
import { ImageProviderWizard, useImageProviderWizard } from './image-provider-wizard.tsx';
import { ImageWorkflowsDialog } from './image-workflows-dialog.tsx';
import { ITEM_ROW_CLASS, ItemTile } from './item-row.tsx';
import { isUnavailable, ModelSelect } from './model-select.tsx';
import { keyHint } from './provider-form.ts';
import { detectImageKey, useDetectedImageServers, useSecrets } from './provider-queries.ts';
import { HealthDot, providerHealth } from './providers-page.tsx';
import { plural } from './provider-wizard.tsx';
import { settingEntry, type SettingId } from './search-index.ts';
import { SettingRow, SettingsSection } from './setting-row.tsx';
import { useDraftText, useSetting } from './use-setting.ts';

export function ImageProvidersPage() {
  const { settings } = useSettings();
  const { data: statuses } = useImageProviderStatus();
  const { data: secrets } = useSecrets();
  const wizard = useImageProviderWizard();
  const list = settingEntry('imageProviders.list');
  // The dialog reads the provider from settings, so what it saves shows at once.
  const [workflows, setWorkflows] = useState<{ open: boolean; id?: string }>({ open: false });
  const shown = settings?.imageProviders?.find((p) => p.id === workflows.id);

  return (
    <>
      <DetectedSection />
      <SettingsSection id="imageProviders.list" title={list.label} description={list.description}>
        {settings?.imageProviders?.map((config, index) => (
          <ImageProviderRow
            key={config.id}
            config={config}
            index={index}
            status={statuses?.find((s) => s.providerId === config.id)}
            keyHint={keyHint(config.apiKey, secrets)}
            onEdit={() => wizard.open(config)}
            onWorkflows={() => setWorkflows({ open: true, id: config.id })}
          />
        ))}
        <SettingRow id="imageProviders.add">
          <Button leadingIcon={Plus} onClick={() => wizard.open()}>
            Add image provider
          </Button>
        </SettingRow>
      </SettingsSection>
      <ImageModelsSection />
      <ImageGenerationSection />
      <ImageProviderWizard key={wizard.key} {...wizard.props} />
      {shown && <ImageWorkflowsDialog config={shown} open={workflows.open} onOpenChange={(open) => setWorkflows((w) => ({ ...w, open }))} />}
    </>
  );
}

function DetectedSection() {
  const { data: detected, isFetching, refetch } = useDetectedImageServers();
  const entry = settingEntry('imageProviders.detect');
  return (
    <SettingsSection
      id="imageProviders.detect"
      title={entry.label}
      description={entry.description}
      action={
        <Button size="sm" variant="ghost" leadingIcon={RefreshCw} loading={isFetching} onClick={() => void refetch()}>
          Scan again
        </Button>
      }
    >
      {detected?.map((server) => <DetectedRow key={`${server.preset}|${server.baseUrl}`} server={server} />)}
      {detected?.length === 0 && <p className="pb-3 text-body text-fg-muted">Nothing new found.</p>}
    </SettingsSection>
  );
}

/** A server found here is added in one click: it needs no key, and the rest of its details are known. */
function DetectedRow({ server }: { server: DetectedImageServer }) {
  const { settings } = useSettings();
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const add = async () => {
    setAdding(true);
    try {
      const taken = new Set([...(settings?.providers ?? []), ...(settings?.imageProviders ?? [])].map((p) => p.id));
      const config = await rpc().call('imageProviders.save', detectedDraft(server, taken));
      void qc.invalidateQueries({ queryKey: detectImageKey });
      toast.success(`Added ${config.name}`);
    } catch (e) {
      toast.error(describeError(e).message);
    } finally {
      setAdding(false);
    }
  };
  return (
    <div className={ITEM_ROW_CLASS}>
      <ItemTile icon={Server} />
      <div className="min-w-0 flex-1">
        <p className="text-body-strong text-fg">{server.label}</p>
        <p className="truncate text-footnote text-fg-muted">Running at {server.baseUrl.replace(/^https?:\/\//, '')}</p>
      </div>
      <Button size="sm" loading={adding} onClick={() => void add()}>
        Add
      </Button>
    </div>
  );
}

function ImageProviderRow({
  config,
  index,
  status,
  keyHint: key,
  onEdit,
  onWorkflows,
}: {
  config: ImageProviderConfig;
  index: number;
  status: ProviderStatus | undefined;
  keyHint: string | undefined;
  onEdit(): void;
  onWorkflows(): void;
}) {
  const qc = useQueryClient();
  const { settings } = useSettings();
  const enabled = useSetting<boolean>(['imageProviders', index, 'enabled'], { toast: true });
  const [refreshing, setRefreshing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const preset = presetFor(config);
  const health = providerHealth(config, status);
  const checked = config.enabled && status && status.checkedAt > 0 && status.ok;
  const partner = config.sharesGpuWith ? (settings?.providers.find((p) => p.id === config.sharesGpuWith)?.name ?? config.sharesGpuWith) : null;

  const refresh = async () => {
    setRefreshing(true);
    try {
      await rpc().call('imageProviders.refresh', { id: config.id });
    } catch (e) {
      toast.error(describeError(e).message);
    } finally {
      setRefreshing(false);
    }
  };

  const meta = [
    config.baseUrl.replace(/^https?:\/\//, ''),
    checked && status.latencyMs != null ? `${Math.round(status.latencyMs)} ms` : null,
    checked ? plural(status.modelCount, 'model') : null,
    partner ? `Shares a GPU with ${partner}` : null,
    key ? `Key ${key}` : null,
  ].filter(Boolean);

  return (
    <div className={ITEM_ROW_CLASS}>
      <ItemTile icon={preset.group === 'local' || preset.group === 'custom' ? Server : Cloud}>
        <HealthDot health={health} checking={refreshing} />
      </ItemTile>
      <div className={cn('min-w-0 flex-1', !config.enabled && 'opacity-60')}>
        <div className="flex items-center gap-2">
          <span className="truncate text-body-strong text-fg">{config.name}</span>
          {config.name !== preset.label && <Badge>{preset.label}</Badge>}
        </div>
        <p className="truncate text-footnote text-fg-muted">{meta.join(' · ')}</p>
        {config.enabled && status?.error && <p className="mt-0.5 text-footnote text-danger-text">{status.error}</p>}
        {config.enabled &&
          status?.warnings.map((w) => (
            <p key={w} className="mt-0.5 text-footnote text-warning-text">
              {w}
            </p>
          ))}
      </div>
      <Switch aria-label={`Enable ${config.name}`} checked={config.enabled} onCheckedChange={(on) => void enabled.set(on).then((ok) => (ok ? refresh() : undefined))} />
      <Menu>
        <MenuTrigger render={<IconButton icon={MoreHorizontal} label={`${config.name} options`} size="sm" />} />
        <MenuContent align="end">
          <MenuItem icon={RefreshCw} disabled={!config.enabled} onClick={() => void refresh()}>
            Test connection
          </MenuItem>
          {config.type === 'comfyui' && (
            <MenuItem icon={Workflow} onClick={onWorkflows}>
              Workflows…
            </MenuItem>
          )}
          <MenuItem icon={Pencil} onClick={onEdit}>
            Edit
          </MenuItem>
          <MenuSeparator />
          <MenuItem icon={Trash2} danger onClick={() => setRemoving(true)}>
            Remove
          </MenuItem>
        </MenuContent>
      </Menu>
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove ${config.name}?`}
        description="Its models leave the image model picker and its stored API key is deleted. Images it already made stay in their chats."
        confirmLabel="Remove"
        onConfirm={async () => {
          try {
            await rpc().call('imageProviders.remove', { id: config.id });
            void qc.invalidateQueries({ queryKey: keys.secrets });
            void qc.invalidateQueries({ queryKey: detectImageKey });
          } catch (e) {
            toast.error(describeError(e).message);
          }
        }}
      />
    </div>
  );
}

function ImageModelsSection() {
  const { data: listed = [] } = useImageModels();
  const { settings } = useSettings();
  const models = useMemo(() => listed.filter((m) => !m.personal), [listed]);
  const providerNames = useMemo(() => new Map(settings?.imageProviders?.map((p) => [p.id, p.name])), [settings?.imageProviders]);
  const groups = useMemo(() => {
    const byProvider = new Map<string, ImageModelInfo[]>();
    for (const m of models) byProvider.set(m.providerId, [...(byProvider.get(m.providerId) ?? []), m]);
    return [...byProvider];
  }, [models]);
  const fallback = useSetting<string | undefined>(['models', 'defaults', 'image']);
  const visible = models.filter((m) => !m.hidden);
  const entry = settingEntry('imageModels.list');
  return (
    <SettingsSection id="imageModels.list" title={entry.label} description={entry.description}>
      <SettingRow id="models.defaults.image" setting={fallback} error={isUnavailable(fallback.value, visible) ? 'This model is no longer available. Images use the first available model until you choose another.' : null}>
        {(label) => <ModelSelect {...label} setting={fallback} unsetLabel="First available model" models={visible} providerNames={providerNames} />}
      </SettingRow>
      {groups.length === 0 ? (
        <p className="py-3 text-body text-fg-muted">Models appear here once an image provider is connected.</p>
      ) : (
        <div className="mt-3 flex flex-col gap-6">
          {groups.map(([providerId, group]) => (
            <ImageModelTable key={providerId} label={providerNames.get(providerId) ?? providerId} models={group} defaultRef={fallback.value} onMakeDefault={(ref) => void fallback.set(ref)} />
          ))}
        </div>
      )}
    </SettingsSection>
  );
}

// Narrow screens drop the capabilities: what's left fits, so a model's switches never hide off to the side.
const COLUMNS = 'grid grid-cols-[minmax(0,1fr)_176px_32px_44px_32px] items-center gap-x-3 max-md:grid-cols-[minmax(0,1fr)_32px_44px_32px]';

/** Past this many a table gets a search box: a ComfyUI folder can hold dozens of checkpoints. */
const SEARCH_FROM = 10;

function ImageModelTable({ label, models, defaultRef, onMakeDefault }: { label: string; models: ImageModelInfo[]; defaultRef: string | undefined; onMakeDefault(ref: string): void }) {
  const [search, setSearch] = useState('');
  const query = search.trim().toLowerCase();
  const shown = models.filter((m) => !query || `${m.displayName} ${m.modelId}`.toLowerCase().includes(query));
  return (
    <div className="rounded-xl border border-line p-4">
      <h3 className="mb-3 text-body-strong text-fg">{label}</h3>
      {models.length > SEARCH_FROM && <TextField aria-label={`Search ${label} models`} placeholder="Search models by name or id…" value={search} onChange={(e) => setSearch(e.target.value)} className="mb-3" />}
      <div role="table" aria-label={`${label} models`}>
        <div role="row" className={cn(COLUMNS, 'h-[34px] border-b border-line-subtle text-footnote text-fg-muted')}>
          <span role="columnheader" className="pl-2">
            Model
          </span>
          <span role="columnheader" className="max-md:hidden">
            Capabilities
          </span>
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
          <ImageModelRow key={m.ref} model={m} isDefault={m.ref === defaultRef} onMakeDefault={() => onMakeDefault(m.ref)} />
        ))}
      </div>
      {shown.length === 0 && <p className="py-6 text-center text-body text-fg-muted">No matching models.</p>}
    </div>
  );
}

/** One override field of an image model. The backend applies overrides and republishes `imageModels.changed`. */
function useOverride<K extends keyof ImageModelOverride>(ref: string, key: K) {
  const setting = useSetting<ImageModelOverride[K]>(['imageModels', 'overrides', ref, key], { toast: true });
  return {
    value: setting.value,
    set: (value: NonNullable<ImageModelOverride[K]>) => void setting.set(value),
    clear: () => void setting.clear(),
  };
}

/** What families are called; hosted services and unknown checkpoints have no family worth naming. */
const FAMILY_LABELS: Record<string, string> = {
  sd15: 'SD 1.5',
  sdxl: 'SDXL',
  'sdxl-distilled': 'SDXL distilled',
  sd3: 'SD3',
  flux: 'FLUX',
  flux2: 'FLUX.2',
  'z-image': 'Z-Image',
};

function ImageModelRow({ model, isDefault, onMakeDefault }: { model: ImageModelInfo; isDefault: boolean; onMakeDefault(): void }) {
  const hidden = useOverride(model.ref, 'hidden');
  const favorite = useOverride(model.ref, 'favorite');
  const [editing, setEditing] = useState(false);
  // Overrides from the (optimistically updated) settings win until `imageModels.list` catches up.
  const isHidden = hidden.value ?? model.hidden;
  const isFavorite = favorite.value ?? model.favorite;
  const name = model.displayName;
  const caps = model.capabilities;
  const family = FAMILY_LABELS[caps.family];
  return (
    <div role="row" className={cn(COLUMNS, 'min-h-11 border-b border-line-subtle py-1.5 last:border-b-0')}>
      <div role="cell" className={cn('min-w-0 px-2', isHidden && 'opacity-60')}>
        <div className="flex items-center gap-2">
          <span className="truncate text-body text-fg">{name}</span>
          {isDefault && <Badge tone="accent">Default</Badge>}
        </div>
        {name !== model.modelId && <p className="truncate font-mono text-caption text-fg-muted">{model.modelId}</p>}
        {model.description && <p className="truncate text-footnote text-fg-muted">{model.description}</p>}
      </div>
      <div role="cell" className="flex flex-wrap gap-1 max-md:hidden">
        {family && <Badge>{family}</Badge>}
        {caps.edit && <Badge>Edits</Badge>}
        {caps.previews && <Badge>Previews</Badge>}
      </div>
      <div role="cell">
        <Button iconOnly size="sm" variant="ghost" aria-label={`Favorite ${name}`} aria-pressed={isFavorite} onClick={() => (isFavorite ? favorite.clear() : favorite.set(true))}>
          <Icon icon={Star} className={isFavorite ? 'fill-current text-fg' : 'text-fg-muted'} />
        </Button>
      </div>
      <div role="cell" className="flex justify-center">
        <Switch size="sm" aria-label={`Show ${name} in the model picker`} checked={!isHidden} onCheckedChange={(on) => hidden.set(!on)} />
      </div>
      <div role="cell">
        <Menu>
          <MenuTrigger render={<IconButton icon={MoreHorizontal} label={`${name} options`} size="sm" />} />
          <MenuContent align="end">
            <MenuItem icon={SlidersHorizontal} onClick={() => setEditing(true)}>
              Description and tuning…
            </MenuItem>
            <MenuItem icon={Star} disabled={isDefault} onClick={onMakeDefault}>
              Make default
            </MenuItem>
          </MenuContent>
        </Menu>
        <ImageModelDialog model={model} open={editing} onOpenChange={setEditing} />
      </div>
    </div>
  );
}

function ImageGenerationSection() {
  const enabled = useSetting<boolean>(['imageGeneration', 'enabled']);
  return (
    <SettingsSection title="Image generation">
      <SettingRow id="imageGeneration.enabled" setting={enabled}>
        {(label) => <Switch {...label} checked={enabled.value} onCheckedChange={(on) => void enabled.set(on)} />}
      </SettingRow>
      <LimitRow id="imageGeneration.maxImagesPerTurn" field="maxImagesPerTurn" problem="Enter a whole number from 1 to 100." parse={(text) => wholeNumber(text, 100)} required unit="images" />
      <LimitRow id="imageGeneration.maxImagesPerUserPerDay" field="maxImagesPerUserPerDay" problem="Enter a whole number, or leave it empty for no limit." parse={(text) => wholeNumber(text, Number.MAX_SAFE_INTEGER)} unit="images" />
      <LimitRow id="imageGeneration.maxSpendPerUserPerDayUsd" field="maxSpendPerUserPerDayUsd" problem="Enter dollars, or leave it empty for no limit." parse={dollars} unit="dollars" />
    </SettingsSection>
  );
}

function wholeNumber(text: string, max: number): number | null {
  const n = Number(text);
  return /^\d+$/.test(text) && n >= 1 && n <= max ? n : null;
}

function dollars(text: string): number | null {
  const n = Number(text);
  return /^(\d+\.?\d*|\.\d+)$/.test(text) && n > 0 ? n : null;
}

/** A number that saves as it's typed. Left empty, an optional limit goes, and a required one keeps its value. */
function LimitRow({ id, field, problem, parse, required, unit }: { id: SettingId; field: keyof Settings['imageGeneration']; problem: string; parse(text: string): number | null; required?: boolean; unit: string }) {
  const setting = useSetting<number | undefined>(['imageGeneration', field]);
  const [invalid, setInvalid] = useState(false);
  const draft = useDraftText({
    value: setting.value?.toString() ?? '',
    set: async (text) => {
      const trimmed = text.trim();
      if (!trimmed && !required) {
        setInvalid(false);
        return setting.clear();
      }
      const value = parse(trimmed);
      setInvalid(value === null);
      return value !== null && setting.set(value);
    },
  });
  return (
    <SettingRow id={id} setting={setting} error={invalid ? problem : null}>
      {(label) => (
        <div className="flex items-center gap-2">
          <TextField {...label} {...draft} inputMode="decimal" placeholder={required ? undefined : 'No limit'} invalid={invalid} className="w-24 text-right" />
          <span className="text-body text-fg-muted">{unit}</span>
        </div>
      )}
    </SettingRow>
  );
}


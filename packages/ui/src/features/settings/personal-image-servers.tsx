/**
 * Settings › Your models › Image servers on your computers (ARCHITECTURE §23): the person's own image servers. Only they
 * see and use these models, and only while that computer is connected to the server. They are added from the desktop
 * app there, which first lends the server the address.
 */
import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Image as ImageIcon, MoreHorizontal, Plus, RefreshCw, Trash2 } from 'lucide-react';
import {
  IMAGE_PROVIDER_PRESETS,
  imagePreset,
  newPersonalProviderId,
  type DetectedImageServer,
  type ImageModelInfo,
  type ImagePreset,
  type PersonalImageProvider,
  type PersonalImageProviderDraft,
} from '@atelier/protocol';
import { Badge, Button, ConfirmDialog, Dialog, DialogContent, DialogFooter, Field, IconButton, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Select, Spinner, Switch, TextField, cn, toast } from '../../components/ui/index.ts';
import { changeLending, useLending } from '../../lib/lending.ts';
import { keys, useAppInfo } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { ITEM_ROW_CLASS, ItemTile } from './item-row.tsx';
import { plural } from './provider-wizard.tsx';
import { SettingsSection } from './setting-row.tsx';

/**
 * Whether the server takes image servers from people's computers. An older one has no such calls: the desktop app says
 * nothing about them there rather than failing.
 */
export function useImageServersOffered(): boolean {
  const { data: info } = useAppInfo();
  return !!info?.imageGeneration && !!info.deviceLink?.services.includes('ws');
}

export function usePersonalImageServers() {
  const offered = useImageServersOffered();
  return useQuery({ queryKey: keys.personalImageProviders, queryFn: () => rpc().call('personalImageProviders.list', {}), enabled: offered });
}

export interface ImageModelGroup {
  id: string;
  label: string;
  models: ImageModelInfo[];
  /** Every model here is on a computer that isn't connected. */
  offline: boolean;
}

/**
 * Image models grouped for a picker, as `useModelGroups` does for text: by provider, and the person's own by the computer
 * they run on, which is what the picker shows as the group's name. `providerName` names the shared providers.
 */
export function imageModelGroups(models: readonly ImageModelInfo[], providerName: (id: string) => string | undefined): ImageModelGroup[] {
  const groups = new Map<string, ImageModelInfo[]>();
  for (const m of models) {
    const key = m.personal ? `device:${m.personal.deviceId}` : m.providerId;
    if (!m.hidden) groups.set(key, [...(groups.get(key) ?? []), m]);
  }
  return [...groups].map(([id, list]) => ({
    id,
    label: list[0]!.personal?.deviceName ?? providerName(id) ?? id,
    models: [...list].sort((a, b) => Number(b.favorite) - Number(a.favorite) || a.order - b.order || a.displayName.localeCompare(b.displayName)),
    offline: list.every((m) => m.available === false),
  }));
}

/** One line under an image model in a picker; a personal one whose computer is away says so, and can't be chosen. */
export function imageModelSubtitle(m: ImageModelInfo): string | undefined {
  return m.available === false ? `${m.personal?.deviceName ?? 'Its computer'} isn’t connected` : m.description;
}

/** What a server on a computer can be added as: the ones that run there, and any server with the OpenAI images API. */
const PRESETS = IMAGE_PROVIDER_PRESETS.filter((p) => p.group === 'local' || p.id === 'openai-compatible');

/** An image server found or entered here: its address is lent to the server, which checks it through this computer and saves it. */
async function addImageServer(server: { preset: ImagePreset; name: string; baseUrl: string; apiKey?: string }): Promise<PersonalImageProvider> {
  const { preset, ...rest } = server;
  const draft = { ...rest, id: newPersonalProviderId(), type: preset.type, preset: preset.id, baseUrl: server.baseUrl.trim().replace(/\/+$/, '') } as PersonalImageProviderDraft;
  await changeLending({ kind: 'http', id: draft.id, baseUrl: draft.baseUrl, allowed: true });
  try {
    const { status } = await rpc().call('personalImageProviders.test', draft);
    if (!status.ok) throw new Error(status.error ?? `${draft.name} didn't answer.`);
    return await rpc().call('personalImageProviders.save', draft);
  } catch (e) {
    await changeLending({ kind: 'http', id: draft.id, allowed: false }).catch(() => null);
    throw e;
  }
}

/** The "Image servers on your computers" part of Your models; `here` is this computer's device id. */
export function PersonalImageServers({ here }: { here: string | undefined }) {
  const offered = useImageServersOffered();
  const lending = useLending();
  const { data: servers } = usePersonalImageServers();
  const addsHere = lending.lends('ws');
  const [adding, setAdding] = useState<{ key: number; open: boolean }>({ key: 0, open: false });
  if (!offered) return null;
  return (
    <>
      {addsHere && <FoundHere />}
      <SettingsSection title="Image servers on your computers" description="ComfyUI, Forge and other image servers on your own computers. Only you see their models, and only while that computer is connected.">
        {servers?.map((s) => <ImageServerRow key={s.id} server={s} here={s.deviceId === here} />)}
        {servers?.length === 0 && <p className="pb-3 text-body text-fg-muted">None yet.</p>}
        <div className="flex flex-col items-start gap-2 pt-3">
          <Button leadingIcon={Plus} disabled={!addsHere} onClick={() => setAdding((a) => ({ key: a.key + 1, open: true }))}>
            Add image server
          </Button>
          {!addsHere && <p className="text-footnote text-fg-muted">Open the desktop app on the computer that runs them, signed in to this server, and add them there.</p>}
        </div>
      </SettingsSection>
      <AddImageServerDialog key={adding.key} open={adding.open} onOpenChange={(open) => setAdding((a) => ({ ...a, open }))} />
    </>
  );
}

/** Image servers answering on this computer's default ports that aren't added yet. */
function FoundHere() {
  const qc = useQueryClient();
  const { data: found, isFetching, refetch } = useQuery({ queryKey: [...keys.personalImageProviders, 'detect'], queryFn: () => rpc().call('personalImageProviders.detect', {}) });
  const [busy, setBusy] = useState<string | null>(null);
  const add = async (server: DetectedImageServer) => {
    const preset = imagePreset(server.preset);
    if (!preset) return;
    setBusy(server.baseUrl);
    try {
      const added = await addImageServer({ preset, name: server.label, baseUrl: server.baseUrl });
      toast.success(`Added ${added.name}`);
      void qc.invalidateQueries({ queryKey: keys.personalImageProviders });
    } catch (e) {
      toast.error(describeError(e).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <SettingsSection
      title="Image servers found on this computer"
      description="Image servers answering on their default ports here (ComfyUI, Forge, SwarmUI and others)."
      action={
        <Button size="sm" variant="ghost" leadingIcon={RefreshCw} loading={isFetching} onClick={() => void refetch()}>
          Scan again
        </Button>
      }
    >
      {found?.map((s) => (
        <div key={`${s.preset}|${s.baseUrl}`} className={ITEM_ROW_CLASS}>
          <ItemTile icon={ImageIcon} />
          <div className="min-w-0 flex-1">
            <p className="text-body-strong text-fg">{s.label}</p>
            <p className="truncate text-footnote text-fg-muted">Running at {s.baseUrl.replace(/^https?:\/\//, '')}</p>
          </div>
          <Button size="sm" loading={busy === s.baseUrl} disabled={busy !== null} onClick={() => void add(s)}>
            Add
          </Button>
        </div>
      ))}
      {found?.length === 0 && <p className="pb-3 text-body text-fg-muted">Nothing new found.</p>}
    </SettingsSection>
  );
}

type Health = { tone: 'success' | 'danger' | 'muted'; label: string };

/** Where a server on someone's computer stands, for its row's dot. */
export function serverHealth(p: { enabled: boolean; online: boolean; status?: { ok: boolean } | undefined }): Health {
  if (!p.enabled) return { tone: 'muted', label: 'Turned off' };
  if (!p.online) return { tone: 'muted', label: 'Not connected' };
  if (!p.status) return { tone: 'muted', label: 'Not checked yet' };
  return p.status.ok ? { tone: 'success', label: 'Connected' } : { tone: 'danger', label: 'Unreachable' };
}

export const HEALTH_DOT_CLASS: Record<Health['tone'], string> = { success: 'bg-success', danger: 'bg-danger', muted: 'bg-line-stronger' };

function ImageServerRow({ server: s, here }: { server: PersonalImageProvider; here: boolean }) {
  const qc = useQueryClient();
  const [checking, setChecking] = useState(false);
  const [removing, setRemoving] = useState(false);
  const state = serverHealth(s);
  const failed = (e: unknown) => void toast.error(describeError(e).message);
  const refresh = () => qc.invalidateQueries({ queryKey: keys.personalImageProviders });
  const meta = [`On ${s.deviceName}${here ? ' (this computer)' : ''}`, s.baseUrl.replace(/^https?:\/\//, ''), s.online && s.status?.ok ? plural(s.status.modelCount, 'model') : null, s.enabled && !s.online ? 'Not connected' : null].filter(Boolean);
  const check = async () => {
    setChecking(true);
    try {
      await rpc().call('personalImageProviders.refresh', { id: s.id });
    } catch (e) {
      failed(e);
    } finally {
      setChecking(false);
    }
  };
  const draft: PersonalImageProviderDraft = {
    id: s.id,
    type: s.type,
    name: s.name,
    baseUrl: s.baseUrl,
    ...(s.preset ? { preset: s.preset } : {}),
    ...(s.parallelRequests ? { parallelRequests: s.parallelRequests } : {}),
    ...(s.freeAfterRun !== undefined ? { freeAfterRun: s.freeAfterRun } : {}),
    ...(s.models ? { models: s.models } : {}),
    ...(s.workflows ? { workflows: s.workflows } : {}),
  };
  return (
    <div className={ITEM_ROW_CLASS}>
      <ItemTile icon={ImageIcon}>
        <span className="absolute -right-0.5 -bottom-0.5 flex size-3 items-center justify-center rounded-full bg-surface">
          {checking ? <Spinner className="size-3" label="Checking" /> : <span role="img" aria-label={state.label} className={cn('size-2 rounded-full', HEALTH_DOT_CLASS[state.tone])} />}
        </span>
      </ItemTile>
      <div className={cn('min-w-0 flex-1', (!s.enabled || !s.online) && 'opacity-60')}>
        <div className="flex items-center gap-2">
          <span className="truncate text-body-strong text-fg">{s.name}</span>
          <Badge>{imagePreset(s.preset)?.label ?? s.type}</Badge>
        </div>
        <p className="truncate text-footnote text-fg-muted">{meta.join(' · ')}</p>
        {s.enabled && s.online && s.status?.error && <p className="mt-0.5 text-footnote text-danger-text">{s.status.error}</p>}
      </div>
      <Switch aria-label={`Use ${s.name}`} checked={s.enabled} onCheckedChange={(on) => void rpc().call('personalImageProviders.save', { ...draft, enabled: on }).then(refresh, failed)} />
      <Menu>
        <MenuTrigger render={<IconButton icon={MoreHorizontal} label={`${s.name} options`} size="sm" />} />
        <MenuContent align="end">
          <MenuItem icon={RefreshCw} disabled={!s.enabled || !s.online} onClick={() => void check()}>
            Test connection
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
        title={`Remove ${s.name}?`}
        description="Its models leave your image model list. Images you made with it stay in your chats."
        confirmLabel="Remove"
        onConfirm={async () => {
          try {
            await rpc().call('personalImageProviders.remove', { id: s.id });
            // This computer stops lending what only it was for.
            if (here) await changeLending({ kind: 'http', id: s.id, allowed: false });
            void refresh();
          } catch (e) {
            failed(e);
          }
        }}
      />
    </div>
  );
}

/** An image server on this computer or its network, entered by hand, starting from what it is. */
function AddImageServerDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const qc = useQueryClient();
  const [preset, setPreset] = useState<ImagePreset>(PRESETS[0]!);
  const [name, setName] = useState(preset.label);
  const [baseUrl, setBaseUrl] = useState(preset.baseUrl);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const address = URL.parse(baseUrl.trim());
  const valid = !!name.trim() && !!address && /^https?:$/.test(address.protocol);
  const choose = (id: string) => {
    const next = imagePreset(id)!;
    // The name and address follow the choice until the person changed them.
    if (name === preset.label) setName(next.label);
    if (baseUrl === preset.baseUrl) setBaseUrl(next.baseUrl);
    setPreset(next);
    setError(null);
  };
  const add = async () => {
    if (!valid) return setError('Enter a name and an http:// or https:// address.');
    setBusy(true);
    setError(null);
    try {
      const added = await addImageServer({ preset, name: name.trim(), baseUrl, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
      toast.success(`Added ${added.name}`);
      void qc.invalidateQueries({ queryKey: keys.personalImageProviders });
      onOpenChange(false);
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Add image server" description="On this computer or its network. Only you see its models, while this computer is connected.">
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <div className="flex flex-col gap-4">
            <Field label="Server" description={preset.help}>
              <Select variant="field" options={PRESETS.map((p) => ({ value: p.id, label: p.label }))} value={preset.id} onValueChange={choose} />
            </Field>
            <Field label="Name">
              <TextField value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Address" description="As this computer reaches it.">
              <TextField value={baseUrl} inputMode="url" spellCheck={false} onChange={(e) => setBaseUrl(e.target.value)} />
            </Field>
            {preset.key !== 'none' && (
              <Field label="API key" description="Optional. Only needed if the server asks for one; kept as your own secret.">
                <TextField type="password" value={apiKey} placeholder="Optional" onChange={(e) => setApiKey(e.target.value)} />
              </Field>
            )}
            {error && (
              <p role="alert" className="text-body text-danger-text">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button variant="ghost" type="button" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="primary" type="submit" loading={busy}>
              Add
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Settings › Models on your computers (ARCHITECTURE §8, personal providers): the person's own model servers and ChatGPT
 * Chat on their computers. Only they see and use these models, and only while that computer is connected to the
 * server. They are added from the desktop app there, which first lends the server the address (or its ChatGPT window).
 */
import { useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { MessageSquare, MoreHorizontal, Plus, RefreshCw, Server, Trash2 } from 'lucide-react';
import { DEFAULT_BASE_URLS, newPersonalProviderId, PROVIDER_LABELS, type LocalServer, type PersonalProvider, type PersonalProviderDraft } from '@atelier/protocol';
import {
  Badge,
  Button,
  ConfirmDialog,
  Dialog,
  DialogContent,
  DialogFooter,
  Field,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuTrigger,
  Select,
  Spinner,
  Switch,
  TextField,
  cn,
  toast,
} from '../../components/ui/index.ts';
import { changeLending, useLending } from '../../lib/lending.ts';
import { keys } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { ChatGptChatSteps, type ChatGptChatWindow } from './chatgpt-chat-sign-in.tsx';
import { ITEM_ROW_CLASS, ItemTile } from './item-row.tsx';
import { plural } from './provider-wizard.tsx';
import { settingEntry } from './search-index.ts';
import { SettingRow, SettingsSection } from './setting-row.tsx';

export function usePersonalProviders() {
  return useQuery({ queryKey: keys.personalProviders, queryFn: () => rpc().call('personalProviders.list', {}) });
}

type ServerType = Exclude<PersonalProvider['type'], 'chatgpt-chat'>;
const SERVER_TYPES: readonly ServerType[] = ['ollama', 'llamacpp', 'openai-compatible'];

/** A model server found or entered here: its address is lent to the server, which checks it through this computer and saves it. */
async function addServer(server: { type: ServerType; name: string; baseUrl: string; apiKey?: string }): Promise<PersonalProvider> {
  const draft: PersonalProviderDraft = { ...server, id: newPersonalProviderId(), baseUrl: server.baseUrl.trim().replace(/\/+$/, '') };
  await changeLending({ kind: 'http', id: draft.id, baseUrl: draft.baseUrl, allowed: true });
  try {
    const { status } = await rpc().call('personalProviders.test', draft);
    if (!status.ok) throw new Error(status.error ?? `${draft.name} didn't answer.`);
    return await rpc().call('personalProviders.save', draft);
  } catch (e) {
    await changeLending({ kind: 'http', id: draft.id, allowed: false }).catch(() => null);
    throw e;
  }
}

/** The ChatGPT window of this desktop, through the server. Signing in there allows it to be used for the server. */
const DESKTOP_WINDOW: ChatGptChatWindow = {
  key: 'personal',
  status: () => rpc().call('personalProviders.chatgptChat.status', {}),
  open: async () => {
    await changeLending({ kind: 'chatgptChat', allowed: true });
    return rpc().call('personalProviders.chatgptChat.open', {});
  },
  hide: () => rpc().call('personalProviders.chatgptChat.hide', {}),
};

export function PersonalModelsPage() {
  const lending = useLending();
  const { data: providers } = usePersonalProviders();
  const { data: devices } = useQuery({ queryKey: keys.devices, queryFn: () => rpc().call('account.devices', {}), enabled: lending.server });
  const here = devices?.find((d) => d.current)?.id;
  const addsHere = lending.lends('http');
  const chatgptHere = lending.lends('chatgptChat') && !providers?.some((p) => p.type === 'chatgpt-chat' && p.deviceId === here);
  const [adding, setAdding] = useState<{ key: number; open: boolean }>({ key: 0, open: false });
  const [chatgpt, setChatgpt] = useState(false);
  const list = settingEntry('personalModels.providers');
  // Signing in allowed this computer's ChatGPT window for the server; leaving without adding it takes that back.
  const leaveChatgpt = () => {
    setChatgpt(false);
    if (!providers?.some((p) => p.type === 'chatgpt-chat' && p.deviceId === here)) void changeLending({ kind: 'chatgptChat', allowed: false }).catch(() => null);
  };

  return (
    <>
      {addsHere && <FoundHere />}
      <SettingsSection id="personalModels.providers" title={list.label} description={list.description}>
        {providers?.map((p) => <PersonalRow key={p.id} provider={p} here={p.deviceId === here} />)}
        {providers?.length === 0 && <p className="pb-3 text-body text-fg-muted">None yet.</p>}
        <SettingRow id="personalModels.add" detail={addsHere ? undefined : 'Open the desktop app on the computer that runs them, signed in to this server, and add them there.'}>
          <Button leadingIcon={Plus} disabled={!addsHere} onClick={() => setAdding((a) => ({ key: a.key + 1, open: true }))}>
            Add model server
          </Button>
        </SettingRow>
        {chatgptHere && (
          <SettingRow id="personalModels.chatgptChat">
            <Button leadingIcon={MessageSquare} onClick={() => setChatgpt(true)}>
              Add ChatGPT Chat
            </Button>
          </SettingRow>
        )}
      </SettingsSection>
      <AddServerDialog key={adding.key} open={adding.open} onOpenChange={(open) => setAdding((a) => ({ ...a, open }))} />
      <Dialog open={chatgpt} onOpenChange={(open) => (open ? setChatgpt(true) : leaveChatgpt())}>
        <DialogContent title="Add ChatGPT Chat">
          {chatgpt && (
            <ChatGptChatSteps
              window={DESKTOP_WINDOW}
              onBack={leaveChatgpt}
              add={async () => {
                const added = await rpc().call('personalProviders.save', { id: newPersonalProviderId(), type: 'chatgpt-chat', name: 'ChatGPT Chat', baseUrl: DEFAULT_BASE_URLS['chatgpt-chat'] });
                await DESKTOP_WINDOW.hide();
                toast.success(`Added ${added.name}`);
                setChatgpt(false);
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

/** Model servers answering on this computer's default ports that aren't added yet. */
function FoundHere() {
  const qc = useQueryClient();
  const { data: found, isFetching, refetch } = useQuery({ queryKey: [...keys.personalProviders, 'detect'], queryFn: () => rpc().call('personalProviders.detect', {}) });
  const [busy, setBusy] = useState<string | null>(null);
  const entry = settingEntry('personalModels.detect');
  const add = async (server: LocalServer) => {
    if (server.type === 'chatgpt-chat') return;
    setBusy(server.baseUrl);
    try {
      const added = await addServer({ type: server.type, name: server.label, baseUrl: server.baseUrl });
      toast.success(`Added ${added.name}`);
      void qc.invalidateQueries({ queryKey: keys.personalProviders });
    } catch (e) {
      toast.error(describeError(e).message);
    } finally {
      setBusy(null);
    }
  };
  return (
    <SettingsSection
      id="personalModels.detect"
      title={entry.label}
      description={entry.description}
      action={
        <Button size="sm" variant="ghost" leadingIcon={RefreshCw} loading={isFetching} onClick={() => void refetch()}>
          Scan again
        </Button>
      }
    >
      {found?.map((s) => (
        <div key={`${s.type}|${s.baseUrl}`} className={ITEM_ROW_CLASS}>
          <ItemTile icon={Server} />
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

function health(p: PersonalProvider): Health {
  if (!p.enabled) return { tone: 'muted', label: 'Turned off' };
  if (!p.online) return { tone: 'muted', label: 'Not connected' };
  if (!p.status) return { tone: 'muted', label: 'Not checked yet' };
  return p.status.ok ? { tone: 'success', label: 'Connected' } : { tone: 'danger', label: 'Unreachable' };
}

const DOT_CLASS: Record<Health['tone'], string> = { success: 'bg-success', danger: 'bg-danger', muted: 'bg-line-stronger' };

function PersonalRow({ provider: p, here }: { provider: PersonalProvider; here: boolean }) {
  const qc = useQueryClient();
  const [checking, setChecking] = useState(false);
  const [removing, setRemoving] = useState(false);
  const state = health(p);
  const failed = (e: unknown) => void toast.error(describeError(e).message);
  const meta = [
    `On ${p.deviceName}${here ? ' (this computer)' : ''}`,
    p.type === 'chatgpt-chat' ? null : p.baseUrl.replace(/^https?:\/\//, ''),
    p.online && p.status?.ok ? plural(p.status.modelCount, 'model') : null,
    p.enabled && !p.online ? 'Not connected' : null,
  ].filter(Boolean);
  const check = async () => {
    setChecking(true);
    try {
      await rpc().call('personalProviders.refresh', { id: p.id });
    } catch (e) {
      failed(e);
    } finally {
      setChecking(false);
    }
  };
  const draft = useMemo(
    () => ({ id: p.id, type: p.type, name: p.name, baseUrl: p.baseUrl, ...(p.parallelRequests ? { parallelRequests: p.parallelRequests } : {}), ...(p.modelsAtOnce ? { modelsAtOnce: p.modelsAtOnce } : {}), ...(p.vramGiB !== undefined ? { vramGiB: p.vramGiB } : {}) }),
    [p],
  );
  return (
    <div className={ITEM_ROW_CLASS}>
      <ItemTile icon={p.type === 'chatgpt-chat' ? MessageSquare : Server}>
        <span className="absolute -right-0.5 -bottom-0.5 flex size-3 items-center justify-center rounded-full bg-surface">
          {checking ? <Spinner className="size-3" label="Checking" /> : <span role="img" aria-label={state.label} className={cn('size-2 rounded-full', DOT_CLASS[state.tone])} />}
        </span>
      </ItemTile>
      <div className={cn('min-w-0 flex-1', (!p.enabled || !p.online) && 'opacity-60')}>
        <div className="flex items-center gap-2">
          <span className="truncate text-body-strong text-fg">{p.name}</span>
          <Badge>{PROVIDER_LABELS[p.type]}</Badge>
        </div>
        <p className="truncate text-footnote text-fg-muted">{meta.join(' · ')}</p>
        {p.enabled && p.online && p.status?.error && <p className="mt-0.5 text-footnote text-danger-text">{p.status.error}</p>}
      </div>
      <Switch
        aria-label={`Use ${p.name}`}
        checked={p.enabled}
        onCheckedChange={(on) => void rpc().call('personalProviders.save', { ...draft, enabled: on }).then(() => qc.invalidateQueries({ queryKey: keys.personalProviders }), failed)}
      />
      <Menu>
        <MenuTrigger render={<IconButton icon={MoreHorizontal} label={`${p.name} options`} size="sm" />} />
        <MenuContent align="end">
          <MenuItem icon={RefreshCw} disabled={!p.enabled || !p.online} onClick={() => void check()}>
            Test connection
          </MenuItem>
          {p.type === 'chatgpt-chat' && (
            <MenuItem disabled={!p.online} onClick={() => void rpc().call('personalProviders.chatgptChat.open', { providerId: p.id }).catch(failed)}>
              Open ChatGPT session
            </MenuItem>
          )}
          <MenuSeparator />
          <MenuItem icon={Trash2} danger onClick={() => setRemoving(true)}>
            Remove
          </MenuItem>
        </MenuContent>
      </Menu>
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Remove ${p.name}?`}
        description={
          p.type === 'chatgpt-chat'
            ? 'The private ChatGPT browser session on that computer is cleared and its model leaves your model picker. Your conversations stay in your history.'
            : 'Its models leave your model picker. Chats that used it stay in your history.'
        }
        confirmLabel="Remove"
        onConfirm={async () => {
          try {
            if (p.type === 'chatgpt-chat' && p.online) await rpc().call('personalProviders.chatgptChat.disconnect', { providerId: p.id }).catch(() => null);
            await rpc().call('personalProviders.remove', { id: p.id });
            // This computer stops lending what only it was for.
            if (here) await changeLending(p.type === 'chatgpt-chat' ? { kind: 'chatgptChat', allowed: false } : { kind: 'http', id: p.id, allowed: false });
            void qc.invalidateQueries({ queryKey: keys.personalProviders });
          } catch (e) {
            failed(e);
          }
        }}
      />
    </div>
  );
}

/** A model server on this computer or its network, entered by hand. */
function AddServerDialog({ open, onOpenChange }: { open: boolean; onOpenChange(open: boolean): void }) {
  const qc = useQueryClient();
  const [type, setType] = useState<ServerType>('ollama');
  const [name, setName] = useState<string>(PROVIDER_LABELS.ollama);
  const [baseUrl, setBaseUrl] = useState(DEFAULT_BASE_URLS.ollama);
  const [apiKey, setApiKey] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const address = URL.parse(baseUrl.trim());
  const valid = !!name.trim() && !!address && /^https?:$/.test(address.protocol);
  const choose = (next: ServerType) => {
    // The name and address follow the type until the person changed them.
    if (name === PROVIDER_LABELS[type]) setName(PROVIDER_LABELS[next]);
    if (baseUrl === DEFAULT_BASE_URLS[type]) setBaseUrl(DEFAULT_BASE_URLS[next]);
    setType(next);
    setError(null);
  };
  const add = async () => {
    if (!valid) return setError('Enter a name and an http:// or https:// address.');
    setBusy(true);
    setError(null);
    try {
      const added = await addServer({ type, name: name.trim(), baseUrl, ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}) });
      toast.success(`Added ${added.name}`);
      void qc.invalidateQueries({ queryKey: keys.personalProviders });
      onOpenChange(false);
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Add model server" description="On this computer or its network. Only you see its models, while this computer is connected.">
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void add();
          }}
        >
          <div className="flex flex-col gap-4">
            <Field label="Type">
              <Select variant="field" options={SERVER_TYPES.map((t) => ({ value: t, label: PROVIDER_LABELS[t] }))} value={type} onValueChange={choose} />
            </Field>
            <Field label="Name">
              <TextField value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="Address" description="As this computer reaches it.">
              <TextField value={baseUrl} inputMode="url" spellCheck={false} onChange={(e) => setBaseUrl(e.target.value)} />
            </Field>
            <Field label="API key" description="Optional. Only needed if the server asks for one; kept as your own secret.">
              <TextField type="password" value={apiKey} placeholder="Optional" onChange={(e) => setApiKey(e.target.value)} />
            </Field>
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

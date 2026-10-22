import { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Cloud, MoreHorizontal, Pencil, Plus, RefreshCw, Server, Trash2 } from 'lucide-react';
import { chatGptPlanLabel, PROVIDER_LABELS, type DetectedProvider, type ProviderConfig, type ProviderStatus } from '@atelier/protocol';
import {
  Badge,
  Button,
  ConfirmDialog,
  IconButton,
  Menu,
  MenuContent,
  MenuItem,
  MenuSeparator,
  MenuSwitchItem,
  MenuTrigger,
  Spinner,
  Switch,
  cn,
  toast,
} from '../../components/ui/index.ts';
import { keys, useProviderStatus, useSettings } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { ITEM_ROW_CLASS, ItemTile } from './item-row.tsx';
import { useChatGptStatus } from './chatgpt-sign-in.tsx';
import { useCopilotStatus } from './copilot-sign-in.tsx';
import { keyHint } from './provider-form.ts';
import { detectKey, useDetectedProviders, useSecrets } from './provider-queries.ts';
import { ProviderWizard, plural, useProviderWizard } from './provider-wizard.tsx';
import { settingEntry } from './search-index.ts';
import { SettingRow, SettingsSection } from './setting-row.tsx';
import { useSetting } from './use-setting.ts';

export function ProvidersPage() {
  const { settings } = useSettings();
  const { data: statuses } = useProviderStatus();
  const { data: secrets } = useSecrets();
  const wizard = useProviderWizard();

  return (
    <>
      <DetectedSection onSetUp={(detected) => wizard.open({ detected })} />
      <SettingsSection title="Providers">
        {settings?.providers.map((config, index) => (
          <ProviderRow
            key={config.id}
            config={config}
            index={index}
            status={statuses?.find((s) => s.providerId === config.id)}
            keyHint={keyHint(config.apiKey, secrets)}
            onEdit={() => wizard.open({ existing: config })}
          />
        ))}
        <SettingRow id="providers.add">
          <Button leadingIcon={Plus} onClick={() => wizard.open()}>
            Add provider
          </Button>
        </SettingRow>
      </SettingsSection>
      <ProviderWizard key={wizard.key} {...wizard.props} />
    </>
  );
}

function DetectedSection({ onSetUp }: { onSetUp(detected: DetectedProvider): void }) {
  const { data: detected, isFetching, refetch } = useDetectedProviders();
  const entry = settingEntry('providers.detect');
  return (
    <SettingsSection
      id="providers.detect"
      title={entry.label}
      description={entry.description}
      action={
        <Button size="sm" variant="ghost" leadingIcon={RefreshCw} loading={isFetching} onClick={() => void refetch()}>
          Scan again
        </Button>
      }
    >
      {detected?.map((d) => (
        <div key={`${d.type}|${d.baseUrl}`} className={ITEM_ROW_CLASS}>
          <TypeTile type={d.type} />
          <div className="min-w-0 flex-1">
            <p className="text-body-strong text-fg">{d.label}</p>
            <p className="truncate text-footnote text-fg-muted">{detectedWhere(d)}</p>
          </div>
          <Button size="sm" onClick={() => onSetUp(d)}>
            Set up
          </Button>
        </div>
      ))}
      {detected?.length === 0 && <p className="pb-3 text-body text-fg-muted">Nothing new found.</p>}
    </SettingsSection>
  );
}

/** "Running at localhost:11434" or "ANTHROPIC_API_KEY is set". */
export function detectedWhere(d: DetectedProvider): string {
  return d.via === 'env' && d.envVar ? `${d.envVar} is set in the environment` : `Running at ${d.baseUrl.replace(/^https?:\/\//, '')}`;
}

function TypeTile({ type, children }: { type: ProviderConfig['type']; children?: ReactNode }) {
  return <ItemTile icon={type === 'anthropic' || type === 'openai' || type === 'chatgpt' || type === 'copilot' ? Cloud : Server}>{children}</ItemTile>;
}

type Health = { tone: 'success' | 'warning' | 'danger' | 'muted'; label: string };

function providerHealth(config: ProviderConfig, status: ProviderStatus | undefined): Health {
  if (!config.enabled) return { tone: 'muted', label: 'Disabled' };
  if (!status || status.checkedAt === 0) return { tone: 'muted', label: 'Not checked yet' };
  if (!status.ok) return { tone: 'danger', label: 'Unreachable' };
  if (status.warnings.length) return { tone: 'warning', label: 'Connected with warnings' };
  return { tone: 'success', label: 'Connected' };
}

const DOT_CLASS: Record<Health['tone'], string> = {
  success: 'bg-success',
  warning: 'bg-warning',
  danger: 'bg-danger',
  muted: 'bg-line-stronger',
};

function ProviderRow({
  config,
  index,
  status,
  keyHint: key,
  onEdit,
}: {
  config: ProviderConfig;
  index: number;
  status: ProviderStatus | undefined;
  keyHint: string | undefined;
  onEdit(): void;
}) {
  const qc = useQueryClient();
  const enabled = useSetting<boolean>(['providers', index, 'enabled'], { toast: true });
  const temporary = useSetting<boolean>(['providers', index, 'temporaryChat'], { toast: true });
  const [refreshing, setRefreshing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const health = providerHealth(config, status);
  // The subscription's account and plan stand in for an address.
  const account = useChatGptStatus(config.type === 'chatgpt').data;
  const github = useCopilotStatus(config.type === 'copilot').data;
  const checked = config.enabled && status && status.checkedAt > 0 && status.ok;

  const refresh = async () => {
    setRefreshing(true);
    try {
      await rpc().call('providers.refresh', { id: config.id });
    } catch (e) {
      toast.error(describeError(e).message);
    } finally {
      setRefreshing(false);
    }
  };

  const meta = [
    config.type === 'chatgpt'
      ? [account?.email, account?.plan ? `${chatGptPlanLabel(account.plan)} plan` : null].filter(Boolean).join(' · ') || 'Signed in'
      : config.type === 'copilot'
        ? github?.login
          ? `Signed in as ${github.login}`
          : 'Signed in'
        : config.baseUrl.replace(/^https?:\/\//, ''),
    checked && status.latencyMs != null ? `${Math.round(status.latencyMs)} ms` : null,
    checked ? plural(status.modelCount, 'model') : null,
    // Only servers with limited room (a local GPU) say how much they take.
    status?.queue && status.queue.modelsAtOnce !== null ? (status.queue.parallel === 1 ? 'One request at a time' : `${status.queue.parallel} requests at once`) : null,
    key ? `Key ${key}` : null,
  ].filter(Boolean);

  return (
    <div className={ITEM_ROW_CLASS}>
      <TypeTile type={config.type}>
        <span className="absolute -right-0.5 -bottom-0.5 flex size-3 items-center justify-center rounded-full bg-surface">
          {refreshing ? (
            <Spinner className="size-3" label="Checking" />
          ) : (
            <span role="img" aria-label={health.label} className={cn('size-2 rounded-full', DOT_CLASS[health.tone])} />
          )}
        </span>
      </TypeTile>
      <div className={cn('min-w-0 flex-1', !config.enabled && 'opacity-60')}>
        <div className="flex items-center gap-2">
          <span className="truncate text-body-strong text-fg">{config.name}</span>
          <Badge>{PROVIDER_LABELS[config.type]}</Badge>
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
      <Switch
        aria-label={`Enable ${config.name}`}
        checked={config.enabled}
        onCheckedChange={(on) => void enabled.set(on).then((ok) => (ok ? refresh() : undefined))}
      />
      <Menu>
        <MenuTrigger render={<IconButton icon={MoreHorizontal} label={`${config.name} options`} size="sm" />} />
        <MenuContent align="end">
          <MenuItem icon={RefreshCw} disabled={!config.enabled} onClick={() => void refresh()}>
            Test connection
          </MenuItem>
          {config.type === 'chatgpt-chat' && <MenuItem onClick={() => void rpc().call('chatgptChat.open', {}).catch((error: unknown) => toast.error(describeError(error).message))}>Open ChatGPT session</MenuItem>}
          {config.type === 'chatgpt-chat' && (
            <MenuSwitchItem
              checked={config.temporaryChat !== false}
              onCheckedChange={(on) => void temporary.set(on).then((ok) => (ok ? refresh() : undefined))}
              description="Keeps these chats out of your ChatGPT history and memory."
            >
              Temporary chats
            </MenuSwitchItem>
          )}
          {config.type !== 'chatgpt-chat' && config.type !== 'chatgpt' && config.type !== 'copilot' && (
            <MenuItem icon={Pencil} onClick={onEdit}>
              Edit
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
        title={`Remove ${config.name}?`}
        description={
          config.type === 'chatgpt-chat' ? 'The private ChatGPT browser session is cleared and its model leaves the picker. Your Atelier conversations stay in your history.' : config.type === 'chatgpt'
            ? 'You are signed out of ChatGPT and its models leave the model picker. Chats that used it stay in your history.'
            : config.type === 'copilot'
              ? 'You are signed out of GitHub Copilot and its models leave the model picker. Chats that used it stay in your history.'
              : 'Its models leave the model picker and its stored API key is deleted. Chats that used it stay in your history.'
        }
        confirmLabel="Remove"
        onConfirm={async () => {
          try {
            if (config.type === 'chatgpt-chat') await rpc().call('chatgptChat.disconnect', {});
            await rpc().call('providers.remove', { id: config.id });
            void qc.invalidateQueries({ queryKey: keys.chatgpt });
            void qc.invalidateQueries({ queryKey: keys.copilot });
            void qc.invalidateQueries({ queryKey: keys.secrets });
            void qc.invalidateQueries({ queryKey: detectKey });
          } catch (e) {
            toast.error(describeError(e).message);
          }
        }}
      />
    </div>
  );
}

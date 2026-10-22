import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { PromptSettings, type SafeguardCategories, type Settings } from '@atelier/protocol';
import { Button, Select, Switch, TextField, type SelectOption } from '../../components/ui/index.ts';
import { keys } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { InstructionsField } from './instructions-field.tsx';
import { useSecrets } from './provider-queries.ts';
import type { SettingId } from './search-index.ts';
import { SecretField } from './secret-field.tsx';
import { SettingRow, SettingsSection } from './setting-row.tsx';
import { useDraftText, useSetting, type Setting } from './use-setting.ts';

type SearchProvider = Settings['capabilities']['webSearch']['provider'];

const PROVIDERS: SelectOption<SearchProvider>[] = [
  { value: 'auto', label: 'Built-in (automatic)' },
  { value: 'searxng', label: 'SearXNG (your own)' },
  { value: 'brave', label: 'Brave Search API' },
  { value: 'tavily', label: 'Tavily API' },
];

/** The backend's limit for the administrator's instructions. */
const ORGANIZATION_MAX = PromptSettings.shape.organizationInstructions.unwrap().maxLength!;

export function CapabilitiesPage() {
  return (
    <>
      <WebSection />
      <InstructionsSection />
      <MemorySection />
      <SafeguardsSection />
    </>
  );
}

/** What every model is told in every conversation; Code and Cowork also get the system AGENTS.md (Admin › Code). */
function InstructionsSection() {
  const setting = useSetting<string>(['prompts', 'organizationInstructions']);
  return (
    <SettingsSection title="Instructions">
      <SettingRow id="prompts.organizationInstructions" setting={setting} stacked>
        {(label) => (
          <InstructionsField
            label={label}
            saved={setting.value ?? ''}
            max={ORGANIZATION_MAX}
            placeholder="For example: We are Acme Gardens, a nursery in Leeds. Answer in British English and give prices in pounds."
            onSave={setting.set}
          />
        )}
      </SettingRow>
    </SettingsSection>
  );
}

/** Memory for everyone: whether people may edit their entries by hand (the backend enforces it too). */
function MemorySection() {
  const manual = useSetting<boolean>(['memory', 'manualEditing']);
  return (
    <SettingsSection title="Memory">
      <SettingRow id="memory.manualEditing" setting={manual}>
        {(label) => <Switch {...label} checked={!!manual.value} onCheckedChange={(v) => void manual.set(v)} />}
      </SettingRow>
    </SettingsSection>
  );
}

function WebSection() {
  const search = useSetting<boolean>(['capabilities', 'webSearch', 'enabled']);
  const provider = useSetting<SearchProvider>(['capabilities', 'webSearch', 'provider']);
  const fetch = useSetting<boolean>(['capabilities', 'webFetch']);
  return (
    <SettingsSection title="Web">
      <SettingRow id="capabilities.webSearch.enabled" setting={search}>
        {(label) => <Switch {...label} checked={search.value} onCheckedChange={(v) => void search.set(v)} />}
      </SettingRow>
      {search.value && (
        <>
          <SettingRow id="capabilities.webSearch.provider" setting={provider}>
            {(label) => <Select {...label} options={PROVIDERS} value={provider.value} onValueChange={(v) => void provider.set(v)} />}
          </SettingRow>
          {provider.value === 'searxng' && <SearxngUrlRow />}
          {(provider.value === 'brave' || provider.value === 'tavily') && <SearchKeyRow provider={provider.value} />}
          <SearchStatusRow />
        </>
      )}
      <SettingRow id="capabilities.webFetch" setting={fetch}>
        {(label) => <Switch {...label} checked={fetch.value} onCheckedChange={(v) => void fetch.set(v)} />}
      </SettingRow>
    </SettingsSection>
  );
}

export const SAFEGUARD_CATEGORIES: [keyof SafeguardCategories, SettingId][] = [
  ['sexual', 'safeguards.categories.sexual'],
  ['hate', 'safeguards.categories.hate'],
  ['harassment', 'safeguards.categories.harassment'],
  ['selfHarm', 'safeguards.categories.selfHarm'],
];

/**
 * Optional extra safeguards (docs/PROMPTS.md §9). The categories apply wherever safeguards are on: for everyone with
 * the switch, or for the people Admin › Users turns them on for.
 */
function SafeguardsSection() {
  const enabled = useSetting<boolean>(['safeguards', 'enabled']);
  const selfHarm = useSetting<boolean>(['safeguards', 'categories', 'selfHarm']);
  const profile = useSetting<Settings['safeguards']['profile']>(['safeguards', 'profile']);
  return (
    <SettingsSection
      title="Content safeguards"
      description="Safeguards are instructions to the model, not a filter. A determined person, or a model that follows instructions poorly, can get around them; only the model provider's own filters are a hard limit."
    >
      <SettingRow id="safeguards.enabled" setting={enabled}>
        {(label) => <Switch {...label} checked={enabled.value} onCheckedChange={(v) => void enabled.set(v)} />}
      </SettingRow>
      {SAFEGUARD_CATEGORIES.map(([key, id]) => (
        <CategoryRow key={key} category={key} id={id} />
      ))}
      <SettingRow id="safeguards.profile" setting={profile}>
        {(label) => <Switch {...label} checked={profile.value === 'younger'} onCheckedChange={(v) => void profile.set(v ? 'younger' : 'adult')} />}
      </SettingRow>
      {selfHarm.value && <CrisisRow />}
    </SettingsSection>
  );
}

function CategoryRow({ category, id }: { category: keyof SafeguardCategories; id: SettingId }) {
  const setting = useSetting<boolean>(['safeguards', 'categories', category]);
  return (
    <SettingRow id={id} setting={setting}>
      {(label) => <Switch {...label} checked={setting.value} onCheckedChange={(v) => void setting.set(v)} />}
    </SettingRow>
  );
}

function CrisisRow() {
  const crisis = useSetting<string>(['safeguards', 'crisisResources']);
  const draft = useDraftText(crisis);
  return (
    <SettingRow id="safeguards.crisisResources" setting={crisis}>
      {(label) => <TextField {...label} {...draft} placeholder="A helpline and its number" className="w-[253px]" />}
    </SettingRow>
  );
}

const ago = (ms: number) => {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return `${minutes} minute${minutes === 1 ? '' : 's'}`;
};

const SOURCE_GROUPS = [
  ['news', 'News'],
  ['dev', 'Programming'],
] as const;

/** "working", "limited for about 2 minutes", "not used yet". */
function sourceState(engine: { state: 'ok' | 'limited' | 'unknown'; retryAt?: number | undefined }, now: number): string {
  if (engine.state === 'ok') return 'working';
  if (engine.state === 'unknown') return 'not used yet';
  return engine.retryAt && engine.retryAt > now ? `limited for about ${ago(engine.retryAt - now)}` : 'limited';
}

/** How search is doing right now, and a button that runs one real search. */
function SearchStatusRow() {
  const status = useQuery({ queryKey: keys.searchStatus, queryFn: () => rpc().call('search.status', {}), refetchInterval: 15_000 });
  const qc = useQueryClient();
  const [state, setState] = useState<{ busy: boolean; text: string | null; failed: boolean }>({ busy: false, text: null, failed: false });
  const all = status.data?.engines ?? [];
  const engines = all.filter((e) => e.kind !== 'news' && e.kind !== 'dev');
  const limited = engines.filter((e) => e.state === 'limited');
  const retry = limited.length ? Math.min(...limited.map((e) => e.retryAt ?? Infinity)) - status.dataUpdatedAt : null;
  const summary =
    status.data?.mode && status.data.mode !== 'auto'
      ? 'Using the search service you set up. Atelier does not fall back to other engines.'
      : limited.length === engines.length && engines.length > 0
        ? `Search engines are limiting requests from this computer. Atelier tries again${retry && Number.isFinite(retry) ? ` in about ${ago(retry)}` : ' shortly'}.`
        : engines.some((e) => e.state === 'ok')
          ? `Working. Answered by ${engines.filter((e) => e.state === 'ok').map((e) => e.name).join(' and ')}${limited.length ? `; ${limited.map((e) => e.name).join(' and ')} is catching its breath` : ''}.`
          : 'Ready. Atelier picks an engine on the first search.';
  const test = async () => {
    setState({ busy: true, text: null, failed: false });
    try {
      const r = await rpc().call('search.test', {});
      setState({ busy: false, failed: false, text: `${r.engine} answered in ${(r.ms / 1000).toFixed(1)} s with ${r.results.length} result${r.results.length === 1 ? '' : 's'}.` });
    } catch (e) {
      setState({ busy: false, failed: true, text: describeError(e).message });
    } finally {
      void qc.invalidateQueries({ queryKey: keys.searchStatus });
    }
  };
  return (
    <SettingRow
      id="capabilities.webSearch.status"
      error={state.failed ? state.text : null}
      detail={
        <>
          {summary}
          {status.data?.mode === 'auto' &&
            SOURCE_GROUPS.map(([kind, label]) => {
              const group = all.filter((e) => e.kind === kind);
              return group.length > 0 && <span key={kind} className="block">{`${label}: ${group.map((e) => `${e.name} ${sourceState(e, status.dataUpdatedAt)}`).join(', ')}.`}</span>;
            })}
          {!state.failed && state.text && <span className="block text-fg">{state.text}</span>}
        </>
      }
    >
      <Button loading={state.busy} onClick={() => void test()}>
        Test search
      </Button>
    </SettingRow>
  );
}

function SearxngUrlRow() {
  const url = useSetting<string | undefined>(['capabilities', 'webSearch', 'url']);
  const draft = useDraftText({ ...url, value: url.value ?? '' } as Setting<string>);
  return (
    <SettingRow id="capabilities.webSearch.url" setting={url}>
      {(label) => <TextField {...label} {...draft} type="url" spellCheck={false} placeholder="https://searx.example.lan" className="w-[253px]" />}
    </SettingRow>
  );
}

/** Brave and Tavily keys go to the secret store; settings only hold the `${secret:…}` reference. */
function SearchKeyRow({ provider }: { provider: 'brave' | 'tavily' }) {
  const apiKey = useSetting<string | undefined>(['capabilities', 'webSearch', 'apiKey']);
  const { data: secrets } = useSecrets();
  const qc = useQueryClient();
  const [value, setValue] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const secretId = `web-search-${provider}`;
  const stored = apiKey.value === `\${secret:${secretId}}` ? secrets?.find((s) => s.id === secretId)?.masked : undefined;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await rpc().call('secrets.set', { id: secretId, label: `${provider === 'brave' ? 'Brave Search' : 'Tavily'} API key`, kind: 'api_key', value: value.trim() });
      await apiKey.set(`\${secret:${secretId}}`);
      void qc.invalidateQueries({ queryKey: keys.secrets });
      setValue('');
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingRow id="capabilities.webSearch.apiKey" setting={apiKey} error={error}>
      {(label) => (
        <form
          className="flex w-[320px] items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            if (value.trim()) void save();
          }}
        >
          <div className="min-w-0 flex-1">
            <SecretField labelledBy={label['aria-labelledby']} value={value} onValueChange={setValue} stored={stored} placeholder="Paste your API key" />
          </div>
          {value.trim() && (
            <Button type="submit" variant="primary" loading={saving}>
              Save
            </Button>
          )}
        </form>
      )}
    </SettingRow>
  );
}

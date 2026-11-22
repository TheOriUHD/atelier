/**
 * Settings › Admin › Decision models (ARCHITECTURE §28): whether Atelier asks one, which one, the services added only
 * for them, Auto mode's check and how it compares with the reviewer, and what else Atelier uses one for.
 */
import { useId, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Radio } from '@base-ui/react/radio';
import { RadioGroup } from '@base-ui/react/radio-group';
import { Cloud, MoreHorizontal, Pencil, Plus, RefreshCw, Server, Trash2 } from 'lucide-react';
import type { DecisionAutoMode, DecisionComparison, DecisionServiceConfig, DecisionSource, DecisionStatus } from '@atelier/protocol';
import { Badge, Button, ConfirmDialog, IconButton, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Select, Switch, cn, toast, type SelectOption } from '../../components/ui/index.ts';
import { clockTime, shortDate } from '../../lib/dates.ts';
import { keys, useDecisionStatus, useSettings } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { DecideDialog } from '../decisions/decide-dialog.tsx';
import { DecisionServiceDialog, presetOf, testSummary, toServiceDraft, serviceFormFrom, type TestState } from './decision-service-dialog.tsx';
import { ITEM_ROW_CLASS, ItemTile } from './item-row.tsx';
import { NamedDecisionModelDialog } from './named-decision-model-dialog.tsx';
import { keyHint } from './provider-form.ts';
import { useSecrets } from './provider-queries.ts';
import { plural } from './provider-wizard.tsx';
import { settingEntry } from './search-index.ts';
import { SettingRow, SettingsSection } from './setting-row.tsx';
import { useSetting } from './use-setting.ts';

/** The source picker's value for "no choice": source ids always have a colon. */
const AUTO = 'auto';
/** The picker's entry that opens "A model of a provider". */
const NAMED = 'named';

export function DecisionsPage() {
  const enabled = useSetting<boolean>(['decisions', 'enabled']);
  const { data: status, error } = useDecisionStatus();
  const [trying, setTrying] = useState(false);
  const on = enabled.value !== false;
  return (
    <>
      <SettingsSection
        title="Decision models"
        description="Models that don’t write. They read a text and answer set questions about it, yes or no, one of a few options or a level on a scale, with how likely each answer is."
        action={
          on && (
            <Button size="sm" disabled={!status?.source && !status?.sources.length} onClick={() => setTrying(true)}>
              Try it
            </Button>
          )
        }
      >
        <SettingRow id="decisions.enabled" setting={enabled}>
          {(label) => <Switch {...label} checked={on} onCheckedChange={(next) => void enabled.set(next)} />}
        </SettingRow>
        {on && status && <SourceRow status={status} />}
        {on && error && !status && <p className="py-3 text-body text-danger-text">{describeError(error).message}</p>}
      </SettingsSection>
      {on && <ServicesSection />}
      {on && <AutoModeSection status={status} />}
      {on && <UsesSection />}
      <DecideDialog open={trying} onOpenChange={setTrying} />
    </>
  );
}

const describe = (s: DecisionSource) => `${s.label} · ${s.provider}`;

function SourceRow({ status }: { status: DecisionStatus }) {
  const setting = useSetting<string | undefined>(['decisions', 'source']);
  const [naming, setNaming] = useState(false);
  const { sources } = status;
  const providers = status.providers ?? [];
  const named = providers.length > 0 && (
    <NamedDecisionModelDialog open={naming} onOpenChange={setNaming} providers={providers} onUse={async (source) => void (await setting.set(source))} />
  );
  const problems = status.problems ?? [];
  // The setting, not `status.chosen`: it changes the moment it is picked.
  const chosen = setting.value ?? null;
  const quiet = problems.length > 0 && (
    <span className="mt-1 block text-footnote">
      {problems.map((p) => (
        <span key={p.provider} className="block">
          Couldn’t ask {p.provider}: {p.error}
        </span>
      ))}
    </span>
  );
  if (sources.length === 0)
    return (
      <SettingRow
        id="decisions.source"
        detail={
          <>
            None found yet. Pull <span className="font-mono text-code">nimble</span> or <span className="font-mono text-code">tev1</span> into Ollama 0.35 or later, load a decision model in LM Studio, or add a service below.
            {providers.length > 0 && ' Or name a decision model of a provider set up already.'}
            {quiet}
          </>
        }
      >
        {providers.length > 0 ? (
          <>
            <Button size="sm" onClick={() => setNaming(true)}>
              Name a model…
            </Button>
            {named}
          </>
        ) : null}
      </SettingRow>
    );
  const byId = new Map(sources.map((s) => [s.id, s]));
  const gone = !!chosen && !byId.has(chosen);
  const options: SelectOption[] = [{ value: AUTO, label: 'Automatic' }, ...sources.map((s) => ({ value: s.id, label: describe(s) })), ...(providers.length ? [{ value: NAMED, label: 'A model of a provider…' }] : [])];
  const picked = !chosen || gone ? (status.source ? `Automatic: ${status.source.label} on ${status.source.provider}.` : 'Automatic picks no paid model by itself: choose one to use it.') : null;
  return (
    <SettingRow
      id="decisions.source"
      setting={setting}
      error={gone ? 'The model chosen is no longer offered: Atelier uses the automatic choice until you choose another.' : null}
      detail={
        (picked || quiet) && (
          <>
            {picked}
            {quiet}
          </>
        )
      }
    >
      {(label) => (
        <>
        <Select
          {...label}
          className="max-w-80"
          options={options}
          value={chosen && !gone ? chosen : AUTO}
          onValueChange={(v) => (v === NAMED ? setNaming(true) : void (v === AUTO ? setting.clear() : setting.set(v)))}
          renderOption={(o) => {
            const s = byId.get(o.value);
            return s ? (
              <>
                {s.label} <span className="text-fg-muted">· {s.provider} · {s.local ? 'local' : 'paid'}</span>
              </>
            ) : (
              o.label
            );
          }}
        />
        {named}
        </>
      )}
    </SettingRow>
  );
}

function ServicesSection() {
  const { settings } = useSettings();
  const { data: secrets } = useSecrets();
  const services = settings?.decisions?.services ?? [];
  const [dialog, setDialog] = useState<{ open: boolean; key: number; existing?: DecisionServiceConfig }>({ open: false, key: 0 });
  const open = (existing?: DecisionServiceConfig) => setDialog((d) => ({ open: true, key: d.key + 1, ...(existing ? { existing } : {}) }));
  const entry = settingEntry('decisions.services');
  return (
    <SettingsSection id="decisions.services" title={entry.label} description={entry.description}>
      {services.map((config) => (
        <ServiceRow key={config.id} config={config} keyHint={keyHint(config.apiKey, secrets)} onEdit={() => open(config)} />
      ))}
      <SettingRow id="decisions.services.add">
        <Button leadingIcon={Plus} onClick={() => open()}>
          Add service
        </Button>
      </SettingRow>
      <DecisionServiceDialog key={dialog.key} open={dialog.open} onOpenChange={(next) => setDialog((d) => ({ ...d, open: next }))} existing={dialog.existing} />
    </SettingsSection>
  );
}

function ServiceRow({ config, keyHint: key, onEdit }: { config: DecisionServiceConfig; keyHint: string | undefined; onEdit(): void }) {
  const qc = useQueryClient();
  const [test, setTest] = useState<TestState>({ state: 'idle' });
  const [removing, setRemoving] = useState(false);
  const preset = presetOf(config);
  const meta = [config.baseUrl.replace(/^https?:\/\//, ''), config.models?.length ? config.models.join(', ') : 'Lists its own models', key ? `Key ${key}` : null].filter(Boolean);

  const runTest = async () => {
    setTest({ state: 'testing' });
    try {
      setTest({ state: 'done', result: await rpc().call('decisions.testService', toServiceDraft(serviceFormFrom(config), config)) });
    } catch (e) {
      setTest({ state: 'failed', message: describeError(e).message });
    }
  };

  return (
    <div className={ITEM_ROW_CLASS}>
      <ItemTile icon={preset.key === 'custom' ? Server : Cloud} />
      <div className={cn('min-w-0 flex-1', !config.enabled && 'opacity-60')}>
        <div className="flex items-center gap-2">
          <span className="truncate text-body-strong text-fg">{config.name}</span>
          {config.name !== preset.name && <Badge>{preset.name}</Badge>}
        </div>
        <p className="truncate text-footnote text-fg-muted">{meta.join(' · ')}</p>
        <div aria-live="polite">
          {test.state === 'testing' && <p className="mt-0.5 text-footnote text-fg-muted">Testing…</p>}
          {test.state === 'failed' && <p className="mt-0.5 text-footnote text-danger-text">{test.message}</p>}
          {test.state === 'done' && <p className={cn('mt-0.5 text-footnote', test.result.ok ? 'text-success-text' : 'text-danger-text')}>{testSummary(test.result)}</p>}
        </div>
      </div>
      <Menu>
        <MenuTrigger render={<IconButton icon={MoreHorizontal} label={`${config.name} options`} size="sm" />} />
        <MenuContent align="end">
          <MenuItem icon={RefreshCw} onClick={() => void runTest()}>
            Test
          </MenuItem>
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
        description="Its decision models are no longer offered here. If Atelier was using one, it goes back to the automatic choice."
        confirmLabel="Remove"
        onConfirm={async () => {
          try {
            qc.setQueryData(keys.decisions, await rpc().call('decisions.removeService', { id: config.id }));
            void qc.invalidateQueries({ queryKey: keys.settings });
            void qc.invalidateQueries({ queryKey: keys.secrets });
          } catch (e) {
            toast.error(describeError(e).message);
          }
        }}
      />
    </div>
  );
}

const MODES: { value: DecisionAutoMode; label: string; line: string }[] = [
  { value: 'off', label: 'Off', line: 'Auto mode’s reviewer looks at every action on its own, as before.' },
  {
    value: 'compare',
    label: 'Compare with the reviewer',
    line: 'The decision model looks at each action Auto mode reviews, side by side with the reviewer. Nothing changes: this measures how it would do.',
  },
  {
    value: 'approve',
    label: 'Approve what it is sure of',
    line: 'Actions it is sure are fine run at once, without the reviewer. Anything else still goes to the reviewer. Dangerous commands, anything outside the folder and connectors keep asking as before.',
  },
];

function AutoModeSection({ status }: { status: DecisionStatus | undefined }) {
  const setting = useSetting<DecisionAutoMode | undefined>(['decisions', 'autoMode']);
  const mode = setting.value ?? 'compare';
  const comparison = status?.comparison;
  const id = useId();
  // What the comparison found so far is worth reading before letting it approve on its own.
  const misses = mode === 'compare' && comparison ? comparison.wronglyAllowed : 0;
  return (
    <SettingsSection title="Auto mode">
      <SettingRow id="decisions.autoMode" setting={setting} stacked detail={status && !status.source ? 'Nothing checks yet: it starts once there is a decision model.' : undefined}>
        {(label) => (
          <RadioGroup {...label} value={mode} onValueChange={(next) => void setting.set(next as DecisionAutoMode)} className="flex flex-col gap-2">
            {MODES.map((m) => (
              <Radio.Root
                key={m.value}
                value={m.value}
                aria-labelledby={`${id}-${m.value}`}
                aria-describedby={`${id}-${m.value}-line`}
                className="group flex w-full cursor-default items-start gap-3 rounded-xl p-3 text-left inset-ring inset-ring-line outline-none focus-ring hover:bg-fill-ghost-hover data-checked:inset-ring-interactive"
              >
                <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full inset-ring inset-ring-line-strong group-data-checked:bg-interactive group-data-checked:inset-ring-interactive">
                  <Radio.Indicator className="size-1.5 rounded-full bg-on-interactive" />
                </span>
                <span className="min-w-0 flex-1">
                  <span id={`${id}-${m.value}`} className="block text-body text-fg">
                    {m.label}
                  </span>
                  <span id={`${id}-${m.value}-line`} className="mt-0.5 block text-footnote text-fg-muted">
                    {m.line}
                    {m.value === 'approve' && misses > 0 && (
                      <span className="mt-1 block text-warning-text">
                        In the comparison so far it would have let through {plural(misses, 'action')} the reviewer stopped.
                      </span>
                    )}
                  </span>
                </span>
              </Radio.Root>
            ))}
          </RadioGroup>
        )}
      </SettingRow>
      {comparison && mode !== 'off' && <ComparisonRow comparison={comparison} approving={mode === 'approve'} />}
    </SettingsSection>
  );
}

/** "Nov 20, 14:25": when a miss happened. */
const when = (at: number) => `${shortDate(at)}, ${clockTime(at)}`;

/** What the check would have done next to the reviewer: only the numbers the backend counted, nothing worked out here. */
function ComparisonRow({ comparison: c, approving }: { comparison: DecisionComparison; approving: boolean }) {
  const qc = useQueryClient();
  const [resetting, setResetting] = useState(false);
  const summary =
    c.checked === 0
      ? 'Nothing compared yet. This fills in as Auto mode reviews actions.'
      : `Compared on ${plural(c.checked, 'action')} since ${shortDate(c.since)}: both allowed ${c.bothAllowed}, it left ${c.leftToReviewer} to the reviewer, it would have let through ${c.wronglyAllowed} the reviewer stopped.`;
  return (
    <SettingRow
      id="decisions.comparison"
      stacked
      detail={
        <div className="flex flex-col gap-1">
          <p>{summary}</p>
          {(approving || c.approved > 0) && <p>It let {plural(c.approved, 'action')} run without the reviewer.</p>}
          {c.medianMs != null && <p>It usually answers in {Math.round(c.medianMs)} ms.</p>}
          {c.misses.length > 0 && (
            <div className="mt-2">
              <p className="text-body text-fg">What it would have let through</p>
              <ul aria-label="What it would have let through" className="mt-1 flex flex-col">
                {c.misses.map((m, i) => (
                  <li key={`${m.at}-${i}`} className="flex flex-col gap-0.5 border-b border-line-subtle py-2 last:border-b-0">
                    <span className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-footnote text-fg-muted">{when(m.at)}</span>
                      <span className="font-mono text-code text-fg-secondary">{m.tool}</span>
                    </span>
                    <span className="text-body text-fg">{m.summary}</span>
                    <span className="text-footnote text-fg-muted">The reviewer: {m.verdict}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-2">
            <Button size="sm" disabled={c.checked === 0 && c.approved === 0} onClick={() => setResetting(true)}>
              Reset
            </Button>
          </div>
          <ConfirmDialog
            open={resetting}
            onOpenChange={setResetting}
            title="Reset the comparison?"
            description="Its numbers and the list of misses are cleared, and counting starts again from now."
            confirmLabel="Reset"
            onConfirm={async () => {
              try {
                qc.setQueryData(keys.decisions, await rpc().call('decisions.resetComparison', {}));
              } catch (e) {
                toast.error(describeError(e).message);
              }
            }}
          />
        </div>
      }
    >
      {null}
    </SettingRow>
  );
}

function UsesSection() {
  const tool = useSetting<boolean | undefined>(['decisions', 'tool']);
  const helpers = useSetting<boolean | undefined>(['decisions', 'helpers']);
  return (
    <SettingsSection title="What else uses it">
      <SettingRow id="decisions.tool" setting={tool}>
        {(label) => <Switch {...label} checked={tool.value !== false} onCheckedChange={(next) => void tool.set(next)} />}
      </SettingRow>
      <SettingRow id="decisions.helpers" setting={helpers}>
        {(label) => <Switch {...label} checked={helpers.value !== false} onCheckedChange={(next) => void helpers.set(next)} />}
      </SettingRow>
    </SettingsSection>
  );
}

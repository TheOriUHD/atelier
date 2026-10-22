import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { contract, HOOK_EVENTS, HooksConfig, type PermissionMode } from '@atelier/protocol';
import { Button, Select, Switch, TextArea, TextField, type SelectOption } from '../../components/ui/index.ts';
import { keys } from '../../lib/queries.ts';
import { rpc } from '../../lib/rpc.ts';
import { InstructionsField } from './instructions-field.tsx';
import { ListRow } from './list-row.tsx';
import { directoryError, ruleError } from './permission-rules.ts';
import type { SettingId } from './search-index.ts';
import { SettingRow, SettingsSection } from './setting-row.tsx';
import { useDraftText, useSetting, useWrite } from './use-setting.ts';

const MODES: SelectOption<PermissionMode>[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'default', label: 'Ask' },
  { value: 'acceptEdits', label: 'Accept edits' },
  { value: 'plan', label: 'Plan' },
  { value: 'bypassPermissions', label: 'Bypass' },
];

const RULE_LISTS = [
  { id: 'permissions.allow', kind: 'allow', placeholder: 'Bash(npm test *)' },
  { id: 'permissions.ask', kind: 'ask', placeholder: 'Bash(git push *)' },
  { id: 'permissions.deny', kind: 'deny', placeholder: 'Read(./.env)' },
] as const satisfies readonly { id: SettingId; kind: string; placeholder: string }[];

/** The backend's limit for the system AGENTS.md. */
const INSTRUCTIONS_MAX = contract.procedures['instructions.set'].input.shape.content.maxLength!;

/** What every Code session on this backend may do, and the instructions all of them follow. */
export function AdminCodePage() {
  const mode = useSetting<PermissionMode>(['permissions', 'defaultMode']);
  const compat = useSetting<boolean>(['compat', 'claudeCode']);
  const ultracode = useSetting<boolean>(['ultracode', 'enabled']);
  return (
    <>
      <SettingsSection title="Permissions">
        <SettingRow id="permissions.defaultMode" setting={mode}>
          {(label) => <Select {...label} options={MODES} value={mode.value} onValueChange={(v) => void mode.set(v)} />}
        </SettingRow>
        {RULE_LISTS.map((list) => (
          <RulesRow key={list.id} {...list} />
        ))}
        <DirectoriesRow />
      </SettingsSection>
      <SettingsSection title="Instructions">
        <InstructionsRow />
      </SettingsSection>
      <SettingsSection title="Automation">
        <HooksRow />
        <RetentionRow />
      </SettingsSection>
      <SettingsSection title="Effort">
        <SettingRow id="ultracode.enabled" setting={ultracode}>
          {(label) => <Switch {...label} checked={ultracode.value} onCheckedChange={(v) => void ultracode.set(v)} />}
        </SettingRow>
      </SettingsSection>
      <SettingsSection title="Compatibility">
        <SettingRow id="compat.claudeCode" setting={compat}>
          {(label) => <Switch {...label} checked={compat.value} onCheckedChange={(v) => void compat.set(v)} />}
        </SettingRow>
      </SettingsSection>
    </>
  );
}

function RulesRow({ id, kind, placeholder }: (typeof RULE_LISTS)[number]) {
  const setting = useSetting<string[]>(['permissions', kind]);
  return <ListRow id={id} setting={setting} validate={ruleError} fieldLabel={`New ${kind} rule`} placeholder={placeholder} />;
}

function DirectoriesRow() {
  const setting = useSetting<string[]>(['permissions', 'additionalDirectories']);
  return <ListRow id="permissions.additionalDirectories" setting={setting} validate={directoryError} fieldLabel="New directory" placeholder="/srv/shared" />;
}

/** The system AGENTS.md, saved explicitly since every session reads it. */
function InstructionsRow() {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: keys.systemInstructions, queryFn: () => rpc().call('instructions.get', {}), staleTime: 0 });
  const { error, run } = useWrite();
  const save = (content: string) =>
    run(async () => {
      await rpc().call('instructions.set', { content });
      qc.setQueryData(keys.systemInstructions, { content });
    });

  return (
    <SettingRow id="instructions.system" error={error} stacked>
      {(label) => (
        <InstructionsField
          label={label}
          saved={data?.content ?? ''}
          max={INSTRUCTIONS_MAX}
          disabled={!data}
          monospace
          placeholder={'# Conventions\n\n- Use pnpm, not npm.\n- Run the tests before you commit.'}
          onSave={save}
        />
      )}
    </SettingRow>
  );
}

const RETENTION_MAX = 3650;

function RetentionRow() {
  const setting = useSetting<number>(['checkpoints', 'retentionDays']);
  const [invalid, setInvalid] = useState(false);
  const draft = useDraftText({
    value: String(setting.value ?? ''),
    set: async (text) => {
      const days = Number(text);
      const ok = /^\d+$/.test(text) && days >= 1 && days <= RETENTION_MAX;
      setInvalid(!ok);
      return ok && setting.set(days);
    },
  });
  return (
    <SettingRow id="checkpoints.retentionDays" setting={setting} error={invalid ? `Enter whole days, 1 to ${RETENTION_MAX}.` : null}>
      {(label) => (
        <div className="flex items-center gap-2">
          <TextField {...label} {...draft} inputMode="numeric" invalid={invalid} className="w-20 text-right" />
          <span className="text-body text-fg-muted">days</span>
        </div>
      )}
    </SettingRow>
  );
}

/** Events and handler types Atelier parses but doesn't run, named so nobody waits for them to fire. */
function unsupported(config: HooksConfig): string[] {
  const notes: string[] = [];
  for (const [event, groups] of Object.entries(config)) {
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) notes.push(`${event} hooks don’t run in Atelier.`);
    else for (const type of new Set(groups.flatMap((g) => g.hooks.map((h) => h.type)))) if (type !== 'command') notes.push(`“${type}” hooks under ${event} don’t run in Atelier; only “command” hooks do.`);
  }
  return notes;
}

/** The system hooks as JSON, saved explicitly once they parse. */
function HooksRow() {
  const setting = useSetting<HooksConfig>(['hooks']);
  const saved = JSON.stringify(setting.value ?? {}, null, 2);
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? saved;
  const dirty = draft !== null && draft !== saved;
  let parsed: HooksConfig | null = null;
  let problem: string | null = null;
  try {
    const result = HooksConfig.safeParse(JSON.parse(value));
    if (result.success) parsed = result.data;
    else problem = 'This isn’t Claude Code’s hooks format: { "PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command", "command": "…" }] }] }';
  } catch {
    problem = 'This isn’t valid JSON.';
  }
  const notes = parsed ? unsupported(parsed) : [];

  return (
    <SettingRow id="hooks" setting={setting} error={dirty ? problem : null} stacked>
      {(label) => (
        <div className="flex flex-col gap-2">
          <TextArea {...label} value={value} onChange={(e) => setDraft(e.target.value)} invalid={dirty && !!problem} rows={8} spellCheck={false} className="font-mono text-code" />
          {notes.map((note) => (
            <p key={note} className="text-footnote text-fg-muted">
              {note}
            </p>
          ))}
          <div className="flex items-center justify-end gap-2">
            {dirty && (
              <Button variant="ghost" onClick={() => setDraft(null)}>
                Discard
              </Button>
            )}
            <Button variant="primary" disabled={!dirty || !parsed} onClick={() => void (parsed && setting.set(parsed).then((ok) => ok && setDraft(null)))}>
              Save
            </Button>
          </div>
        </div>
      )}
    </SettingRow>
  );
}


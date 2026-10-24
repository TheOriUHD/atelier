import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ScrollText, Trash2, TriangleAlert } from 'lucide-react';
import { RpcError, type SkillSummary } from '@atelier/protocol';
import { Badge, Button, ConfirmDialog, Icon, IconButton, Select, TextField, Tooltip, toast } from '../../components/ui/index.ts';
import { shortDate } from '../../lib/dates.ts';
import { keys, useAccount, useWorkspaces } from '../../lib/queries.ts';
import { describeError, errorCode, rpc } from '../../lib/rpc.ts';
import { ITEM_ROW_CLASS, ItemTile } from './item-row.tsx';
import { settingEntry } from './search-index.ts';
import { SettingsSection } from './setting-row.tsx';

const SCOPES = { project: 'Project', global: 'Global', plugin: 'Plugin' } as const;
const PRECEDENCE = Object.keys(SCOPES);

/** A project's skills win over global ones, and those over plugins' (ARCHITECTURE §10); the list follows that order. */
const byPrecedence = (a: SkillSummary, b: SkillSummary) => PRECEDENCE.indexOf(a.scope) - PRECEDENCE.indexOf(b.scope) || a.name.localeCompare(b.name);

const NO_FOLDER = 'none';

/** The skills Atelier sees, with a folder's project skills on request; admins install and uninstall them. */
export function SkillsPage() {
  const { account } = useAccount();
  const { data: workspaces } = useWorkspaces();
  const [folder, setFolder] = useState(NO_FOLDER);
  const folders = workspaces?.filter((w) => w.available && !w.scratch) ?? [];
  const workspaceId = folders.find((w) => w.id === folder)?.id;
  const { data: skills } = useQuery({
    queryKey: [...keys.skills, workspaceId ?? null],
    queryFn: () => rpc().call('skills.list', workspaceId ? { workspaceId } : {}),
    staleTime: 0,
  });
  const admin = account?.role === 'admin';
  const entry = settingEntry('skills.list');

  return (
    <>
      <SettingsSection
        id="skills.list"
        title={entry.label}
        description={entry.description}
        action={
          folders.length > 0 ? (
            <div className="flex items-center gap-1">
              <span id="skills-folder" className="text-body text-fg-muted">
                Project skills from
              </span>
              <Select
                aria-labelledby="skills-folder"
                options={[{ value: NO_FOLDER, label: 'No folder' }, ...folders.map((w) => ({ value: w.id, label: w.name }))]}
                value={workspaceId ?? NO_FOLDER}
                onValueChange={setFolder}
              />
            </div>
          ) : null
        }
      >
        {skills?.length === 0 && <p className="pb-3 text-body text-fg-muted">No skills yet.</p>}
        {!!skills?.length && (
          <ul aria-label={entry.label}>
            {[...skills].sort(byPrecedence).map((s) => (
              <SkillRow key={s.name} skill={s} admin={admin} />
            ))}
          </ul>
        )}
      </SettingsSection>
      {admin && <InstallSection />}
    </>
  );
}

function SkillRow({ skill, admin }: { skill: SkillSummary; admin: boolean }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const { installed } = skill;

  const uninstall = async () => {
    try {
      await rpc().call('skills.uninstall', { name: skill.name });
    } catch (e) {
      toast.error(describeError(e).message);
    }
    await qc.invalidateQueries({ queryKey: keys.skills });
  };

  return (
    <li className={ITEM_ROW_CLASS}>
      <ItemTile icon={ScrollText} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-body-strong text-fg">{skill.name}</span>
          <Badge>{SCOPES[skill.scope]}</Badge>
          {skill.device && <Badge>From {skill.device}</Badge>}
          {skill.manualOnly && (
            <Tooltip content="Sessions don’t start it on their own">
              <Badge>Only by /{skill.name}</Badge>
            </Tooltip>
          )}
        </div>
        <p title={skill.description} className="truncate text-footnote text-fg-muted">
          {installed && (
            <>
              from {installed.source} <span className="font-mono">{installed.sha.slice(0, 7)}</span> ·{' '}
            </>
          )}
          {skill.description}
        </p>
        {skill.warnings.map((w) => (
          <p key={w} className="mt-0.5 flex items-center gap-1 text-footnote text-fg-muted">
            <Icon icon={TriangleAlert} className="size-3.5" />
            {w}
          </p>
        ))}
      </div>
      {installed && <span className="shrink-0 text-footnote text-fg-muted">{shortDate(Date.parse(installed.installedAt))}</span>}
      {admin && installed && (
        <>
          <IconButton icon={Trash2} label={`Uninstall ${skill.name}`} size="sm" onClick={() => setConfirm(true)} />
          <ConfirmDialog
            open={confirm}
            onOpenChange={setConfirm}
            title={`Uninstall ${skill.name}?`}
            description={`Its folder is deleted and sessions stop offering it. You can install it again from ${installed.source}.`}
            confirmLabel="Uninstall"
            onConfirm={uninstall}
          />
        </>
      )}
    </li>
  );
}

function InstallSection() {
  const qc = useQueryClient();
  const entry = settingEntry('skills.install');
  const [source, setSource] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [taken, setTaken] = useState<{ name: string; source: string } | null>(null);
  const [confirming, setConfirming] = useState(false);

  const install = async (from: string, replace: boolean) => {
    setPending(true);
    setError(null);
    try {
      const { installed } = await rpc().call('skills.install', { source: from, ...(replace && { replace }) });
      toast.success(installed.length === 1 ? `Installed ${installed[0]}.` : `Installed ${installed.length} skills: ${installed.join(', ')}.`);
      setSource('');
    } catch (e) {
      const { message } = describeError(e);
      // A skill of that name exists and Atelier didn't install it: offer to replace it.
      const name = !replace && errorCode(e) === 'skill_exists' && e instanceof RpcError ? String(e.data?.name) : undefined;
      if (name) {
        setTaken({ name, source: from });
        setConfirming(true);
      } else setError(message);
    } finally {
      setPending(false);
      void qc.invalidateQueries({ queryKey: keys.skills });
    }
  };

  return (
    <SettingsSection id="skills.install" title={entry.label} description={entry.description}>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void install(source.trim(), false);
        }}
      >
        <TextField
          aria-label="Skill repository"
          value={source}
          onChange={(e) => {
            setSource(e.target.value);
            setError(null);
          }}
          invalid={!!error}
          placeholder="owner/repo or https://github.com/owner/repo"
          spellCheck={false}
          autoComplete="off"
          className="flex-1 font-mono"
        />
        <Button type="submit" disabled={!source.trim()} loading={pending}>
          Install
        </Button>
      </form>
      {error && (
        <p role="alert" className="mt-2 text-body text-danger-text">
          {error}
        </p>
      )}
      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={`Replace ${taken?.name}?`}
        description={`A skill named ${taken?.name} is already there, put in place by another tool like npx skills or by hand. Replacing it overwrites that copy with the one from ${taken?.source}.`}
        confirmLabel="Replace"
        onConfirm={() => install(taken!.source, true)}
      />
    </SettingsSection>
  );
}

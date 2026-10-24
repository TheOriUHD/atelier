import { useId, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Puzzle, Trash2 } from 'lucide-react';
import type { z } from 'zod';
import type { contract, PluginSummary } from '@atelier/protocol';
import { Badge, Button, ConfirmDialog, Icon, IconButton, Switch, TextField, cn, toast } from '../../components/ui/index.ts';
import { keys, useSettings } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { ITEM_ROW_CLASS, ItemTile } from './item-row.tsx';
import { plural } from './provider-wizard.tsx';
import { settingEntry } from './search-index.ts';
import { SettingsSection } from './setting-row.tsx';

type Marketplace = z.infer<(typeof contract)['procedures']['plugins.browse']['output']> & { repo: string };

const KINDS = [
  { key: 'skills', title: 'Skills', word: 'skill' },
  { key: 'commands', title: 'Commands', word: 'command' },
  { key: 'agents', title: 'Agents', word: 'agent' },
] as const;

/** Plugins change the skills sessions see as well as this list. */
function useRefresh() {
  const qc = useQueryClient();
  return () => Promise.all([qc.invalidateQueries({ queryKey: keys.plugins }), qc.invalidateQueries({ queryKey: keys.skills })]);
}

/**
 * Installed plugins (Atelier's and, on desktop, Claude Code's) and installing more from a marketplace. `readOnly`
 * (Customize for everyone but admins) lists them and what they bring, without the admin's controls.
 */
export function PluginsPage({ readOnly }: { readOnly?: boolean }) {
  const { data: plugins } = useQuery({ queryKey: keys.plugins, queryFn: () => rpc().call('plugins.list', {}), staleTime: 0 });
  const entry = settingEntry('plugins.installed');
  return (
    <>
      <SettingsSection
        id="plugins.installed"
        title={entry.label}
        description={readOnly ? 'Bundles of skills, commands and agents an admin installed for everyone.' : entry.description}
      >
        {plugins?.length === 0 && <p className="pb-3 text-body text-fg-muted">{readOnly ? 'No plugins yet.' : 'No plugins yet. Add one from a marketplace below.'}</p>}
        {!!plugins?.length && (
          <ul aria-label={entry.label}>
            {plugins.map((p) => (
              <PluginRow key={p.id} plugin={p} readOnly={readOnly} />
            ))}
          </ul>
        )}
      </SettingsSection>
      {!readOnly && <MarketplaceSection installed={plugins} />}
    </>
  );
}

function PluginRow({ plugin, readOnly }: { plugin: PluginSummary; readOnly?: boolean }) {
  const qc = useQueryClient();
  const refresh = useRefresh();
  const panel = useId();
  const [expanded, setExpanded] = useState(false);
  const [removing, setRemoving] = useState(false);
  const kinds = KINDS.filter((k) => plugin[k.key].length > 0);

  // One on the person's own computer is theirs to switch; the others are the admin's, for everyone.
  const own = !!plugin.device;
  const setEnabled = async (enabled: boolean) => {
    qc.setQueryData<PluginSummary[]>(keys.plugins, (list) => list?.map((p) => (p.id === plugin.id ? { ...p, enabled } : p)));
    try {
      if (own) await rpc().call('prefs.set', { path: ['plugins', 'enabled', plugin.id], value: enabled });
      else await rpc().call('plugins.setEnabled', { id: plugin.id, enabled });
    } catch (e) {
      toast.error(describeError(e).message);
    }
    await refresh();
  };

  const uninstall = async () => {
    try {
      await rpc().call('plugins.uninstall', { id: plugin.id });
    } catch (e) {
      toast.error(describeError(e).message);
    }
    await refresh();
  };

  return (
    <li className="border-b border-line-subtle py-3 last:border-b-0">
      <div className="flex items-center gap-4">
        <ItemTile icon={Puzzle} />
        <div className={cn('min-w-0 flex-1', !plugin.enabled && 'opacity-60')}>
          <div className="flex items-center gap-2">
            <span className="truncate text-body-strong text-fg">{plugin.name}</span>
            {plugin.source === 'claude-code' && <Badge>Claude Code</Badge>}
            {plugin.device && <Badge>From {plugin.device}</Badge>}
            {readOnly && !own && !plugin.enabled && <Badge>Off</Badge>}
          </div>
          <p title={plugin.description} className="truncate text-footnote text-fg-muted">
            {[plugin.version, plugin.description].filter(Boolean).join(' · ')}
          </p>
          {kinds.length > 0 ? (
            <button
              type="button"
              aria-expanded={expanded}
              aria-controls={panel}
              onClick={() => setExpanded((e) => !e)}
              className="mt-0.5 flex items-center gap-1 rounded-xs text-footnote text-fg-secondary outline-none focus-ring hover:text-fg"
            >
              {kinds.map((k) => plural(plugin[k.key].length, k.word)).join(' · ')}
              <Icon icon={ChevronDown} className={cn('size-3.5 transition-transform duration-(--at-duration-fast)', expanded && 'rotate-180')} />
            </button>
          ) : (
            <p className="mt-0.5 text-footnote text-fg-muted">No skills, commands or agents</p>
          )}
        </div>
        {!readOnly && plugin.source === 'atelier' && (
          <IconButton icon={Trash2} label={`Uninstall ${plugin.name}`} size="sm" onClick={() => setRemoving(true)} />
        )}
        {(!readOnly || own) && <Switch aria-label={`Enable ${plugin.name}`} checked={plugin.enabled} onCheckedChange={(on) => void setEnabled(on)} />}
      </div>
      {expanded && (
        <div id={panel} className="mt-3 ml-[50px] flex flex-col gap-2">
          {kinds.map((k) => (
            <div key={k.key}>
              <p className="text-footnote text-fg-muted">{k.title}</p>
              <ul aria-label={`${k.title} in ${plugin.name}`} className="mt-1 flex flex-wrap gap-1">
                {plugin[k.key].map((name) => (
                  <li key={name} className="rounded-xs bg-fill-ghost-hover px-1.5 py-px font-mono text-badge text-fg-secondary">
                    {name}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title={`Uninstall ${plugin.name}?`}
        description="Its skills, commands and agents leave every session, and its files are deleted. You can install it again from its marketplace."
        confirmLabel="Uninstall"
        onConfirm={uninstall}
      />
    </li>
  );
}

/** Marketplaces plugins were installed from before, as `owner/repo`. */
function useKnownMarketplaces(): string[] {
  const { settings } = useSettings();
  const repos = Object.values(settings?.extraKnownMarketplaces ?? {}).flatMap((m) => (m.source.repo ? [m.source.repo] : []));
  return [...new Set(repos)];
}

function MarketplaceSection({ installed }: { installed: PluginSummary[] | undefined }) {
  const entry = settingEntry('plugins.marketplace');
  const known = useKnownMarketplaces();
  const [repo, setRepo] = useState('');
  const [browsing, setBrowsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [market, setMarket] = useState<Marketplace | null>(null);

  const browse = async (target: string) => {
    setRepo(target);
    setBrowsing(true);
    setError(null);
    try {
      setMarket({ ...(await rpc().call('plugins.browse', { repo: target })), repo: target });
    } catch (e) {
      setMarket(null);
      setError(describeError(e).message);
    } finally {
      setBrowsing(false);
    }
  };

  return (
    <SettingsSection id="plugins.marketplace" title={entry.label} description={entry.description}>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void browse(repo.trim());
        }}
      >
        <TextField
          aria-label="Marketplace repository"
          value={repo}
          onChange={(e) => {
            setRepo(e.target.value);
            setError(null);
          }}
          invalid={!!error}
          placeholder="owner/repo"
          spellCheck={false}
          autoComplete="off"
          className="flex-1 font-mono"
        />
        <Button type="submit" disabled={!repo.trim()} loading={browsing}>
          Browse
        </Button>
      </form>
      {known.length > 0 && (
        <div className="mt-2 flex flex-wrap items-center gap-1">
          <span className="mr-1 text-footnote text-fg-muted">Added before:</span>
          {known.map((r) => (
            <Button key={r} size="xs" variant="ghost" className="font-mono" onClick={() => void browse(r)}>
              {r}
            </Button>
          ))}
        </div>
      )}
      {error && (
        <p role="alert" className="mt-2 text-body text-danger-text">
          {error}
        </p>
      )}
      {market && <MarketplacePlugins market={market} installed={installed ?? []} />}
    </SettingsSection>
  );
}

function MarketplacePlugins({ market, installed }: { market: Marketplace; installed: PluginSummary[] }) {
  const refresh = useRefresh();
  const [installing, setInstalling] = useState<string | null>(null);

  const install = async (plugin: string) => {
    setInstalling(plugin);
    try {
      await rpc().call('plugins.install', { repo: market.repo, plugin });
      toast.success(`Installed ${plugin}.`);
    } catch (e) {
      toast.error(describeError(e).message);
    } finally {
      setInstalling(null);
    }
    await refresh();
  };

  return (
    <div className="mt-4">
      <p className="text-footnote text-fg-muted">
        {plural(market.plugins.length, 'plugin')} in {market.name}
      </p>
      <ul aria-label={`Plugins in ${market.name}`}>
        {market.plugins.map((p) => (
          <li key={p.name} className={ITEM_ROW_CLASS}>
            <ItemTile icon={Puzzle} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-body-strong text-fg">{p.name}</p>
              <p title={p.description} className="truncate text-footnote text-fg-muted">
                {[p.version, p.description].filter(Boolean).join(' · ')}
              </p>
              {p.unsupported && <p className="mt-0.5 text-footnote text-fg-muted">{p.unsupported}</p>}
            </div>
            {installed.some((i) => i.id === `${p.name}@${market.name}`) ? (
              <Badge tone="success">Installed</Badge>
            ) : (
              <Button
                size="sm"
                aria-label={`Install ${p.name}`}
                disabled={!!p.unsupported || (installing !== null && installing !== p.name)}
                loading={installing === p.name}
                onClick={() => void install(p.name)}
              >
                Install
              </Button>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

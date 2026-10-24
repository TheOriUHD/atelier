/**
 * "Select remote folder": the host's folders one level at a time, a path field with Go, a breadcrumb
 * from the home folder, the subfolders to open, and here also New folder, which makes one where you are.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronRight, Folder, FolderPlus, House } from 'lucide-react';
import { Button, Dialog, DialogContent, DialogFooter, Icon, Spinner, TextField } from '../../components/ui/index.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { lendSsh } from '../../lib/lending.ts';

interface Listing {
  path: string;
  home: string;
  dirs: string[];
}

/** The breadcrumb's steps for `path`: the home folder first, then each folder below it (or from `/`). */
export function crumbs(path: string, home: string): { label: string; path: string }[] {
  const below = path === home || path.startsWith(`${home}/`);
  const base = below ? home : '/';
  const rest = path.slice(base.length).split('/').filter(Boolean);
  const out: { label: string; path: string }[] = [{ label: below ? home.split('/').filter(Boolean).at(-1) || '/' : '/', path: base }];
  let at = base === '/' ? '' : base;
  for (const part of rest) {
    at = `${at}/${part}`;
    out.push({ label: part, path: at });
  }
  return out;
}

export function RemoteFolderDialog({
  open,
  onOpenChange,
  host,
  start,
  onSelect,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  host: string;
  /** Where to open (the folder's recent sibling, say); the home folder by default. */
  start?: string;
  onSelect(path: string): void;
}) {
  const [listing, setListing] = useState<Listing | null>(null);
  const [typed, setTyped] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [naming, setNaming] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // The newest request wins: a slow listing never replaces a later one.
  const latest = useRef(0);

  const go = useCallback(
    async (path?: string) => {
      const mine = ++latest.current;
      setLoading(true);
      setError(null);
      try {
        const next = await rpc().call('ssh.browse', { host, ...(path ? { path } : {}) });
        if (mine !== latest.current) return;
        setListing(next);
        setTyped(next.path);
        setNaming(null);
      } catch (e) {
        if (mine === latest.current) setError(describeError(e).message);
      } finally {
        if (mine === latest.current) setLoading(false);
      }
    },
    [host],
  );
  // The first listing, when the dialog opens; later ones come from `go`.
  useEffect(() => {
    if (!open) return;
    let live = true;
    // Browsed from this computer: a server may reach the host from here.
    lendSsh(host)
      .then(() => rpc().call('ssh.browse', { host, ...(start ? { path: start } : {}) }))
      .then(
        (next) => {
          if (!live) return;
          setListing(next);
          setTyped(next.path);
        },
        (e: unknown) => live && setError(describeError(e).message),
      );
    return () => {
      live = false;
    };
  }, [open, host, start]);

  const create = async () => {
    if (!listing || !naming?.trim()) return;
    setCreating(true);
    setError(null);
    try {
      const made = await rpc().call('ssh.mkdir', { host, parent: listing.path, name: naming.trim() });
      await go(made.path);
    } catch (e) {
      setError(describeError(e).message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Select remote folder" description={`Folders on ${host}.`}>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void go(typed.trim() || undefined);
          }}
          className="flex gap-2"
        >
          <TextField aria-label="Path" value={typed} onChange={(e) => setTyped(e.target.value)} autoCapitalize="none" autoComplete="off" spellCheck={false} className="flex-1 font-mono" />
          <Button type="submit" loading={loading && !!typed}>
            Go
          </Button>
        </form>
        {listing && (
          <nav aria-label="Path" className="mt-3 flex flex-wrap items-center gap-0.5 text-body text-fg-secondary">
            {crumbs(listing.path, listing.home).map((c, i, all) => (
              <span key={c.path} className="flex items-center gap-0.5">
                {i > 0 && <Icon icon={ChevronRight} className="size-3.5 text-fg-muted" />}
                <button
                  type="button"
                  onClick={() => void go(c.path)}
                  aria-current={i === all.length - 1 || undefined}
                  className="flex items-center gap-1 rounded-sm px-1.5 py-0.5 outline-none focus-ring hover:bg-fill-ghost-hover aria-[current]:text-fg"
                >
                  {i === 0 && c.path === listing.home && <Icon icon={House} className="size-3.5" />}
                  {c.label}
                </button>
              </span>
            ))}
          </nav>
        )}
        <div className="mt-3 h-64 overflow-y-auto rounded-xl inset-ring inset-ring-line">
          {error ? (
            <p role="alert" className="px-3 py-3 text-body text-danger-text">
              {error}
            </p>
          ) : !listing ? (
            <p role="status" className="flex items-center gap-2 px-3 py-3 text-body text-fg-muted">
              <Spinner /> Connecting to {host}…
            </p>
          ) : listing.dirs.length === 0 ? (
            <p className="flex h-full items-center justify-center text-body text-fg-muted">No subdirectories</p>
          ) : (
            <ul>
              {listing.dirs.map((name) => (
                <li key={name} className="border-t border-line first:border-t-0">
                  <button
                    type="button"
                    onClick={() => void go(`${listing.path === '/' ? '' : listing.path}/${name}`)}
                    className="flex h-9 w-full items-center gap-2 px-3 text-left text-body text-fg outline-none focus-ring hover:bg-fill-ghost-hover"
                  >
                    <Icon icon={Folder} className="size-4 shrink-0 text-fg-muted" />
                    <span className="min-w-0 truncate">{name}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        {naming !== null && (
          <form
            noValidate
            onSubmit={(e) => {
              e.preventDefault();
              void create();
            }}
            className="mt-3 flex items-center gap-2"
          >
            <TextField
              autoFocus
              aria-label="New folder name"
              placeholder="Name of the new folder"
              value={naming}
              onChange={(e) => setNaming(e.target.value)}
              autoCapitalize="none"
              autoComplete="off"
              spellCheck={false}
              className="flex-1 font-mono"
            />
            <Button type="submit" variant="primary" loading={creating} disabled={!naming.trim()}>
              Create
            </Button>
            <Button onClick={() => setNaming(null)} disabled={creating}>
              Cancel
            </Button>
          </form>
        )}
        <DialogFooter className="mt-4">
          {naming === null && (
            <Button leadingIcon={FolderPlus} className="mr-auto" disabled={!listing || !!error} onClick={() => setNaming('')}>
              New folder
            </Button>
          )}
          <Button onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="primary" disabled={!listing || !!error} onClick={() => listing && onSelect(listing.path)}>
            Select folder
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

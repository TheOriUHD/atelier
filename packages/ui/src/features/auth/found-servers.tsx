/** "Found on your network": Atelier servers the desktop app finds on the local network, one click to connect. */
import { useEffect, useId, useState } from 'react';
import { Server } from 'lucide-react';
import { Icon, Spinner } from '../../components/ui/index.ts';
import { desktop, type FoundServer } from '../../lib/platform.ts';

export function FoundServers({ disabled = false, onPick }: { disabled?: boolean; onPick(url: string): void }) {
  const id = useId();
  const [servers, setServers] = useState<FoundServer[]>([]);
  const [searching, setSearching] = useState(!!desktop?.discovery);

  useEffect(() => {
    const discovery = desktop?.discovery;
    if (!discovery) return;
    let live = true;
    const add = (server: FoundServer) => {
      if (live) setServers((list) => (list.some((s) => s.url === server.url) ? list : [...list, server]));
    };
    discovery
      .scan(add)
      .catch(() => [])
      .finally(() => {
        if (live) setSearching(false);
      });
    return () => {
      live = false;
    };
  }, []);

  // Nothing found is no news: the field above is how most people connect.
  if (!searching && servers.length === 0) return null;
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <div className="flex items-center gap-2 text-footnote text-fg-muted">
        <h2 id={id}>Found on your network</h2>
        {searching && (
          <span className="flex items-center gap-1.5" role="status">
            <Spinner size="sm" />
            Searching…
          </span>
        )}
      </div>
      {servers.length > 0 && (
        <ul className="flex flex-col gap-1">
          {servers.map((server) => (
            <li key={server.url}>
              <button
                type="button"
                disabled={disabled}
                onClick={() => onPick(server.url)}
                className="flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left inset-ring inset-ring-line outline-none focus-ring hover:bg-fill-ghost-hover disabled:pointer-events-none disabled:opacity-40"
              >
                <Icon icon={Server} size="md" className="text-fg-secondary" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-body-strong text-fg">{server.name ?? server.host}</span>
                  <span className="block truncate text-footnote text-fg-muted">
                    {[server.name ? server.host : null, server.version ? `Atelier ${server.version}` : null].filter(Boolean).join(' · ') || server.url}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

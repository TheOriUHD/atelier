import { RefreshCw, Server, TriangleAlert } from 'lucide-react';
import { APP, compareVersions } from '@atelier/protocol';
import { Button, Icon } from '../components/ui/index.ts';
import { desktop } from '../lib/platform.ts';
import { useAccount, useAppInfo } from '../lib/queries.ts';
import { useOpenSettings } from './navigation.ts';

const BOX = 'mx-2 mb-2 rounded-lg px-2.5 py-2';

/** Non-admins hear nothing of an older server: they can't update it, and a newer app keeps working with it. */
export function VersionNotice() {
  const { data: info } = useAppInfo();
  const { account } = useAccount();
  const openSettings = useOpenSettings();
  if (!info || info.surface !== 'web') return null;
  const order = compareVersions(info.version, APP.version);

  if (order > 0 && !desktop) {
    return (
      <div role="status" className={`${BOX} flex items-center gap-2 bg-fill-control`}>
        <Icon icon={RefreshCw} className="shrink-0 text-fg-secondary" />
        <span className="min-w-0 flex-1 text-footnote text-fg-secondary">The server was updated to Atelier {info.version}.</span>
        <Button size="xs" variant="primary" onClick={() => location.reload()}>
          Reload
        </Button>
      </div>
    );
  }
  if (order > 0) {
    return (
      <div role="status" className={`${BOX} flex gap-2 bg-warning-subtle text-warning-text`}>
        <Icon icon={TriangleAlert} className="mt-0.5 shrink-0" />
        <span className="min-w-0 flex-1 text-footnote">
          The server runs Atelier {info.version}, newer than this app. Some features may not work as intended.
        </span>
      </div>
    );
  }
  if (order < 0 && account?.role === 'admin') {
    return (
      <div role="status" className={`${BOX} flex gap-2 bg-fill-control`}>
        <Icon icon={Server} className="mt-0.5 shrink-0 text-fg-secondary" />
        <span className="min-w-0 flex-1 text-footnote text-fg-secondary">
          The server runs an older version ({info.version}). Update it in{' '}
          <button
            type="button"
            className="rounded-xs text-interactive-text outline-none focus-ring hover:underline"
            onClick={() => openSettings('server')}
          >
            Settings › Admin › Server
          </button>
          .
        </span>
      </div>
    );
  }
  return null;
}

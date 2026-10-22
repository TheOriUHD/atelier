import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Download, RefreshCw } from 'lucide-react';
import { Button, Icon, ProgressBar } from '../components/ui/index.ts';
import { desktop } from '../lib/platform.ts';

const UPDATES = ['desktop', 'updates'] as const;
const BOX = 'mx-2 mb-2 rounded-lg bg-fill-control px-2.5 py-2';

/**
 * The desktop app's update, in the sidebar where it is seen: it downloads in the background (shown with its progress)
 * and installs when Atelier quits, so all there is to offer is "Restart" now; a Mac that can't replace its own app (it
 * runs from a disk image or a folder it can't write) is offered the download instead. Nothing shows while the app is up
 * to date.
 */
export function UpdateNotice() {
  const qc = useQueryClient();
  const { data: status } = useQuery({ queryKey: UPDATES, queryFn: () => desktop!.updates.status(), enabled: !!desktop });
  useEffect(() => desktop?.updates.onStatus((next) => qc.setQueryData(UPDATES, next)), [qc]);
  if (!desktop || !status) return null;
  const { state } = status;
  if (state.kind === 'downloading') {
    // An older app (or a server's UI on one) may not name the version.
    const label = state.version ? `Downloading Atelier ${state.version}` : 'Downloading an update';
    return (
      <div role="status" className={`${BOX} flex flex-col gap-2`}>
        <div className="flex items-center gap-2">
          <Icon icon={Download} className="shrink-0 text-fg-secondary" />
          <span className="min-w-0 flex-1 truncate text-footnote text-fg-secondary">{label}</span>
        </div>
        <ProgressBar value={state.percent / 100} aria-label={label} aria-valuetext={`${state.percent}%`} />
      </div>
    );
  }
  // Ready on every platform: it installs on quit, or now on Restart. A Mac that can't replace its own app is offered the image.
  const ready = state.kind === 'downloaded';
  const download = state.kind === 'available' && !!state.manual;
  if (!ready && !download) return null;
  return (
    <div role="status" className={`${BOX} flex items-center gap-2`}>
      <Icon icon={ready ? RefreshCw : Download} className="shrink-0 text-fg-secondary" />
      <span className="min-w-0 flex-1 text-footnote text-fg-secondary">
        {ready ? `Update ${state.version} is ready` : `Atelier ${state.kind === 'available' ? state.version : ''} is available`}
      </span>
      <Button size="xs" variant="primary" onClick={() => void (ready ? desktop!.updates.install() : desktop!.updates.download())}>
        {ready ? 'Restart' : 'Download'}
      </Button>
    </div>
  );
}

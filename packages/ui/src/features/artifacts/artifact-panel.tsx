/**
 * The artifact side panel (design/components.md › Artifacts) in the shared `SidePanel` frame, 62% of the main
 * area wide (all of it when expanded). Its pieces (loading a version, the version switcher, the preview or source)
 * also make Code's Artifact pane.
 */
import { memo, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, CircleAlert, Download, Maximize2, Minimize2, X } from 'lucide-react';
import type { ArtifactSummary, ArtifactVersion } from '@atelier/protocol';
import { Icon, IconButton, SegmentedControl, cn } from '../../components/ui/index.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { useResolvedTheme } from '../../lib/theme.ts';
import { useUi, type ArtifactPanelState } from '../../lib/ui-store.ts';
import { CodePre, useHighlightedLines } from '../chat/code-block.tsx';
import { CopyButton } from '../chat/copy-button.tsx';
import { ArtifactFrame, FrameSkeleton } from './artifact-frame.tsx';
import { PREVIEWABLE, artifactFilename, downloadText, sourceLanguage } from './artifact-files.ts';

/**
 * Floating card inset 8px from the main area's top, right and bottom, sliding in from the right. The page keeps
 * its column clear of it; `className` sets the width (or `left-2` for full width). Narrow screens: it covers the main area.
 */
export function SidePanel({ label, className, children }: { label: string; className: string; children: ReactNode }) {
  return (
    <aside
      aria-label={label}
      className={cn(
        'absolute top-2 right-2 bottom-2 z-10 flex flex-col overflow-hidden rounded-xl bg-surface shadow-panel',
        'transition-[translate] duration-(--at-duration-sheet) ease-out starting:translate-x-[calc(100%+8px)]',
        className,
        'max-md:inset-0 max-md:w-auto max-md:rounded-none'
      )}
    >
      {children}
    </aside>
  );
}

export const ARTIFACT_VIEWS = [
  { value: 'preview', label: 'Preview' },
  { value: 'code', label: 'Code' },
] as const;

export type LoadedArtifact = ArtifactSummary & { content: ArtifactVersion };

/** One version of an artifact (the latest when `version` is undefined), kept on screen while another one loads. */
export function useArtifactVersion(artifactId: string, version: number | undefined) {
  return useQuery({
    queryKey: ['artifact', artifactId, version ?? 'latest'],
    queryFn: () => rpc().call('artifacts.get', { id: artifactId, ...(version ? { version } : {}) }),
    // Versions are immutable. While another version loads, keep showing this artifact (never a different one).
    staleTime: Infinity,
    placeholderData: (previous) => (previous?.id === artifactId ? previous : undefined),
  });
}

/** "‹ v2/3 ›"; `onVersion(null)` goes back to following the latest. */
export function VersionSwitcher({ shown, latest, onVersion }: { shown: number; latest: number; onVersion(version: number | null): void }) {
  return (
    <span className="flex shrink-0 items-center text-caption text-fg-muted tabular-nums">
      <IconButton icon={ChevronLeft} label="Previous version" size="xs" disabled={shown <= 1} onClick={() => onVersion(shown - 1)} />
      v{shown}/{latest}
      <IconButton
        icon={ChevronRight}
        label="Next version"
        size="xs"
        disabled={shown >= latest}
        onClick={() => onVersion(shown + 1 >= latest ? null : shown + 1)}
      />
    </span>
  );
}

/** The preview (in the artifact sandbox) or the highlighted source; a skeleton while it loads, or what went wrong. */
export function ArtifactBody({ data, error, view }: { data: LoadedArtifact | undefined; error: unknown; view: 'preview' | 'code' }) {
  const theme = useResolvedTheme();
  if (!data)
    return error ? (
      <p role="alert" className="flex items-center gap-2 p-4 text-body text-danger-text">
        <Icon icon={CircleAlert} />
        {describeError(error).message}
      </p>
    ) : (
      <FrameSkeleton />
    );
  return view === 'preview' && PREVIEWABLE.has(data.type) ? (
    <ArtifactFrame key={`${data.id}:${data.content.version}:${theme}`} type={data.type} content={data.content.content} theme={theme} />
  ) : (
    <SourceView code={data.content.content} language={sourceLanguage(data.type, data.language)} />
  );
}

/** `summary` is the live summary from the session (undefined until known); it drives "follow the latest version". */
export const ArtifactPanel = memo(function ArtifactPanel({
  state,
  summary,
}: {
  state: ArtifactPanelState;
  summary: ArtifactSummary | undefined;
}) {
  const updateArtifact = useUi((s) => s.updateArtifact);
  const closeArtifact = useUi((s) => s.closeArtifact);
  const { data, error } = useArtifactVersion(state.artifactId, state.version ?? summary?.version);

  const shown = data?.content.version;
  const latest = summary?.versions ?? data?.versions ?? 1;
  const previewable = !!data && PREVIEWABLE.has(data.type);
  const view = previewable ? state.view : 'code';

  return (
    <SidePanel label="Artifact" className={state.expanded ? 'left-2' : 'w-[62%]'}>
      <header className="flex h-[41px] shrink-0 items-center gap-1 border-b border-line pr-[calc(var(--at-window-controls)+0.5rem)] pl-3">
        <h2 className="min-w-0 flex-1 truncate px-1.5 text-control-sm text-fg">{data?.title ?? summary?.title}</h2>
        {shown && latest > 1 && <VersionSwitcher shown={shown} latest={latest} onVersion={(version) => updateArtifact({ version })} />}
        {previewable && (
          <SegmentedControl
            size="sm"
            aria-label="View"
            items={ARTIFACT_VIEWS}
            value={view}
            onValueChange={(v) => updateArtifact({ view: v })}
            className="mx-1"
          />
        )}
        {data && (
          <>
            <CopyButton text={data.content.content} label="Copy content" />
            <IconButton
              icon={Download}
              label="Download"
              size="xs"
              onClick={() => downloadText(artifactFilename(data), data.content.content)}
            />
          </>
        )}
        <IconButton
          icon={state.expanded ? Minimize2 : Maximize2}
          label={state.expanded ? 'Exit full width' : 'Full width'}
          size="xs"
          className="max-md:hidden"
          onClick={() => updateArtifact({ expanded: !state.expanded })}
        />
        <IconButton icon={X} label="Close" size="xs" onClick={closeArtifact} />
      </header>
      <div className="relative flex min-h-0 flex-1 flex-col">
        <ArtifactBody data={data} error={error} view={view} />
      </div>
    </SidePanel>
  );
});

function SourceView({ code, language }: { code: string; language: string }) {
  const lines = useHighlightedLines(code, language, true);
  return (
    <div className="at-code flex min-h-0 flex-1 flex-col">
      <CodePre lines={lines} streaming={false} lineNumbers className="min-h-0 flex-1 overflow-auto" />
    </div>
  );
}

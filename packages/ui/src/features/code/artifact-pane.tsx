/**
 * The Artifact pane (design/components.md › Code panes): what the session showed with the `artifact` tool, as Chat's
 * artifact panel shows it (preview or code, versions, the same sandbox). It opens by itself whenever the session shows
 * an artifact; closed, it stays closed until the next one.
 */
import { useEffect, useRef } from 'react';
import { Copy, Download } from 'lucide-react';
import type { ArtifactSummary } from '@atelier/protocol';
import { MenuItem, SegmentedControl } from '../../components/ui/index.ts';
import { PREVIEWABLE, artifactFilename, downloadText } from '../artifacts/artifact-files.ts';
import { ARTIFACT_VIEWS, ArtifactBody, VersionSwitcher, useArtifactVersion } from '../artifacts/artifact-panel.tsx';
import { PaneMessage } from './file-tree.tsx';
import { PaneFrame, PaneTitle, type PaneFrameState } from './pane-dock.tsx';

/** What the pane shows: an artifact (null: the one changed last), a version of it (null: the latest) and how. */
export interface ArtifactPaneState {
  artifactId: string | null;
  version: number | null;
  view: 'preview' | 'code';
}

export const INITIAL_ARTIFACT_PANE: ArtifactPaneState = { artifactId: null, version: null, view: 'preview' };

/** The artifact the pane shows: the chosen one, else the one changed last. */
export function shownArtifact(
  artifacts: Record<string, ArtifactSummary>,
  artifactId: string | null,
): ArtifactSummary | undefined {
  return (
    (artifactId ? artifacts[artifactId] : undefined) ??
    Object.values(artifacts).reduce<ArtifactSummary | undefined>(
      (a, b) => (!a || b.updatedAt > a.updatedAt ? b : a),
      undefined,
    )
  );
}

/**
 * Calls `onShow` with each artifact the session shows from now on (made, changed, or shown again: every `artifact`
 * event replaces its summary), never with the ones it had when it loaded.
 */
export function useShownArtifacts(
  artifacts: Record<string, ArtifactSummary>,
  loaded: boolean,
  onShow: (artifact: ArtifactSummary) => void,
): void {
  const seen = useRef<Record<string, ArtifactSummary> | null>(null);
  const callback = useRef(onShow);
  useEffect(() => {
    callback.current = onShow;
  });
  useEffect(() => {
    if (!loaded) return;
    const before = seen.current;
    seen.current = artifacts;
    if (!before) return;
    const shown = Object.values(artifacts)
      .filter((a) => before[a.id] !== a)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0];
    if (shown) callback.current(shown);
  }, [artifacts, loaded]);
}

export function ArtifactPane({
  frame,
  artifacts,
  state,
  onState,
}: {
  frame: PaneFrameState;
  artifacts: Record<string, ArtifactSummary>;
  state: ArtifactPaneState;
  onState(patch: Partial<ArtifactPaneState>): void;
}) {
  const summary = shownArtifact(artifacts, state.artifactId);
  if (!summary)
    return (
      <PaneFrame frame={frame} title="Artifact">
        <div className="flex flex-1 items-center justify-center">
          <PaneMessage>
            Nothing to show yet. When the assistant shows you a page, a diagram or a document, it opens here.
          </PaneMessage>
        </div>
      </PaneFrame>
    );
  return <ShownArtifact key={summary.id} frame={frame} summary={summary} state={state} onState={onState} />;
}

function ShownArtifact({
  frame,
  summary,
  state,
  onState,
}: {
  frame: PaneFrameState;
  summary: ArtifactSummary;
  state: ArtifactPaneState;
  onState(patch: Partial<ArtifactPaneState>): void;
}) {
  const { data, error } = useArtifactVersion(summary.id, state.version ?? summary.version);
  const shown = data?.content.version;
  const previewable = PREVIEWABLE.has(data?.type ?? summary.type);
  const view = previewable ? state.view : 'code';
  return (
    <PaneFrame
      frame={frame}
      title="Artifact"
      start={
        <>
          <PaneTitle>{data?.title ?? summary.title}</PaneTitle>
          {shown && summary.versions > 1 && (
            <VersionSwitcher shown={shown} latest={summary.versions} onVersion={(version) => onState({ version })} />
          )}
          {previewable && (
            <SegmentedControl
              size="sm"
              aria-label="View"
              items={ARTIFACT_VIEWS}
              value={view}
              onValueChange={(v) => onState({ view: v })}
              className="ml-auto"
            />
          )}
        </>
      }
      menu={
        data && (
          <>
            <MenuItem icon={Copy} onClick={() => void navigator.clipboard.writeText(data.content.content)}>
              Copy content
            </MenuItem>
            <MenuItem icon={Download} onClick={() => downloadText(artifactFilename(data), data.content.content)}>
              Download
            </MenuItem>
          </>
        )
      }
    >
      <ArtifactBody data={data} error={error} view={view} />
    </PaneFrame>
  );
}

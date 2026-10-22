import { createContext, useContext } from 'react';
import { Atom, FileCode2, FileText, Globe, Image, Workflow, type LucideIcon } from 'lucide-react';
import { artifactIdForPath, type ArtifactSummary, type ArtifactType, type ToolCallPart } from '@atelier/protocol';
import { Icon, ThinkingDots, cn } from '../../components/ui/index.ts';
import { useUi } from '../../lib/ui-store.ts';

/** Each artifact type's name and glyph (cards here and on the Artifacts page). */
export const ARTIFACT_TYPES: Record<ArtifactType, { label: string; icon: LucideIcon }> = {
  html: { label: 'HTML', icon: Globe },
  react: { label: 'React', icon: Atom },
  svg: { label: 'SVG', icon: Image },
  mermaid: { label: 'Diagram', icon: Workflow },
  markdown: { label: 'Document', icon: FileText },
  code: { label: 'Code', icon: FileCode2 },
};

/** Where a page shows artifacts in a pane of its own (Code): the one it shows, if open, and how to show or hide one. */
export const ArtifactPaneContext = createContext<{ shown: string | null; toggle(artifactId: string): void } | null>(null);

/** A string field of tool-call JSON that may still be streaming (`{"title": "Tal…`). */
function partialField(json: string | undefined, field: string): string | undefined {
  const match = json && new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`).exec(json);
  if (!match) return undefined;
  try {
    return JSON.parse(`"${match[1]!.replace(/\\$/, '')}"`) as string;
  } catch {
    return undefined;
  }
}

/**
 * Transcript card for an `artifact` tool call (design/components.md › ArtifactCard). The whole card
 * toggles the artifact panel; while the call is still running it shows "Writing…".
 */
export function ArtifactCard({
  sessionId,
  call,
  artifacts,
  status,
  partialInput,
}: {
  sessionId: string;
  call: ToolCallPart;
  artifacts: Record<string, ArtifactSummary>;
  status: 'writing' | 'done' | 'failed';
  /** Tool-input JSON received so far, while the call streams. */
  partialInput: string | undefined;
}) {
  const input = (call.input ?? {}) as { identifier?: string; title?: string; type?: ArtifactType; file_path?: string };
  // Code's calls name a file, whose path is the artifact's identifier.
  const file = input.file_path ?? partialField(partialInput, 'file_path');
  const identifier = input.identifier ?? partialField(partialInput, 'identifier') ?? (file && artifactIdForPath(file));
  const artifact = Object.values(artifacts).find((a) => a.identifier === identifier);
  const pane = useContext(ArtifactPaneContext);
  const inPanel = useUi((s) => !!artifact && s.artifact?.sessionId === sessionId && s.artifact.artifactId === artifact.id);
  const open = pane ? !!artifact && pane.shown === artifact.id : inPanel;
  const openArtifact = useUi((s) => s.openArtifact);
  const closeArtifact = useUi((s) => s.closeArtifact);
  const toggle = (id: string) => (pane ? pane.toggle(id) : open ? closeArtifact() : openArtifact(sessionId, id));
  const title = artifact?.title ?? input.title ?? partialField(partialInput, 'title') ?? file?.split('/').at(-1) ?? 'Artifact';
  const type = ARTIFACT_TYPES[artifact?.type ?? input.type ?? 'code'] ?? ARTIFACT_TYPES.code;

  return (
    <button
      type="button"
      aria-expanded={artifact ? open : undefined}
      disabled={!artifact}
      onClick={() => artifact && toggle(artifact.id)}
      className={cn(
        'flex w-full items-center gap-5 overflow-hidden rounded-2xl border-[0.5px] border-line-strong bg-fill-secondary pt-1.5 pr-4 pb-2 pl-5 text-left shadow-field-drop outline-none focus-ring',
        'transition-[background-color,border-color,box-shadow] duration-(--at-duration-base) ease-out',
        'enabled:hover:border-line-stronger enabled:hover:bg-fill-secondary-hover enabled:hover:shadow-sm',
      )}
    >
      <span className="flex size-14 shrink-0 translate-y-2.5 items-center justify-center rounded-t-lg bg-raised text-fg-muted inset-ring inset-ring-line">
        <Icon icon={type.icon} size="lg" />
      </span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-[15px]/5 text-fg">{title}</span>
        <span className="flex items-center gap-1.5 text-caption text-fg-muted">
          {status === 'writing' ? (
            <>
              <ThinkingDots />
              Writing…
            </>
          ) : status === 'failed' ? (
            <span className="text-danger-text">Failed</span>
          ) : (
            artifact && `${type.label}${artifact.versions > 1 ? ` · v${artifact.version}` : ''}`
          )}
        </span>
      </span>
      {artifact && (
        <span className="flex h-8 shrink-0 items-center rounded-lg bg-fill-secondary px-3 text-body text-fg inset-ring inset-ring-fill-secondary-ring">
          {open ? 'Hide' : 'Open'}
        </span>
      )}
    </button>
  );
}

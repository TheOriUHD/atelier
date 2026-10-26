/** Artifacts (Chat sidebar): everything the person's chats built, newest first; a card opens its chat with the panel open. */
import { useState } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Shapes } from 'lucide-react';
import type { ArtifactListItem, ArtifactType } from '@atelier/protocol';
import { Button, Icon, Spinner, cn } from '../../components/ui/index.ts';
import { relativeTime } from '../../lib/dates.ts';
import { rpc } from '../../lib/rpc.ts';
import { sessionTitle } from '../../lib/sessions.ts';
import { useUi } from '../../lib/ui-store.ts';
import { ARTIFACT_TYPES } from '../chat/artifact-card.tsx';

const PAGE = 60;

export function ArtifactsPage() {
  const [type, setType] = useState<ArtifactType | null>(null);
  const query = useInfiniteQuery({
    queryKey: ['artifacts', type],
    queryFn: ({ pageParam }) =>
      rpc().call('artifacts.listAll', {
        limit: PAGE,
        ...(pageParam ? { cursor: pageParam } : {}),
        ...(type ? { type } : {}),
      }),
    initialPageParam: null as string | null,
    getNextPageParam: (page) => page.nextCursor,
    staleTime: 0,
  });
  const items = query.data?.pages.flatMap((p) => p.items);

  return (
    <>
      <div className="app-drag h-(--at-layout-header-height) shrink-0" />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-10">
        <div className="@container mx-auto max-w-240">
          <h1 className="mt-1.5 font-serif text-page-title text-fg">Artifacts</h1>
          <div role="group" aria-label="Type" className="mt-6 flex flex-wrap gap-1">
            <Chip pressed={type === null} onClick={() => setType(null)}>
              All
            </Chip>
            {(Object.keys(ARTIFACT_TYPES) as ArtifactType[]).map((t) => (
              <Chip key={t} pressed={type === t} onClick={() => setType(t)}>
                {ARTIFACT_TYPES[t].label}
              </Chip>
            ))}
          </div>
          {!items ? (
            <Spinner className="mx-auto mt-24" />
          ) : items.length === 0 ? (
            type ? (
              <p className="mt-24 text-center text-body text-fg-muted">
                No {ARTIFACT_TYPES[type].label} artifacts yet.
              </p>
            ) : (
              <EmptyState />
            )
          ) : (
            <>
              <ul aria-label="Artifacts" className="mt-6 grid grid-cols-1 gap-4 @xl:grid-cols-2 @3xl:grid-cols-3">
                {items.map((a) => (
                  <li key={a.id}>
                    <ArtifactTile artifact={a} />
                  </li>
                ))}
              </ul>
              {query.hasNextPage && (
                <Button
                  className="mx-auto mt-6 flex"
                  loading={query.isFetchingNextPage}
                  onClick={() => void query.fetchNextPage()}
                >
                  Show more
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </>
  );
}

/** Filter chip: 28 tall, r7; the chosen one on the selected fill. */
function Chip({ pressed, onClick, children }: { pressed: boolean; onClick(): void; children: string }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'h-7 rounded-md px-2 text-body text-fg-secondary outline-none focus-ring hover:bg-fill-ghost-hover hover:text-fg',
        pressed && 'bg-fill-ghost-selected text-fg hover:bg-fill-ghost-selected',
      )}
    >
      {children}
    </button>
  );
}

function ArtifactTile({ artifact }: { artifact: ArtifactListItem }) {
  const openArtifact = useUi((s) => s.openArtifact);
  const type = ARTIFACT_TYPES[artifact.type];
  return (
    <Link
      // Where its conversation lives: a Code session's artifact opens in Code, not in the Chat layout.
      to={artifact.sessionMode === 'code' ? '/code/$sessionId' : artifact.sessionMode === 'work' ? '/work/$sessionId' : '/chat/$sessionId'}
      params={{ sessionId: artifact.sessionId }}
      onClick={() => openArtifact(artifact.sessionId, artifact.id)}
      className="flex h-[136px] flex-col rounded-2xl border border-line p-4 outline-none transition-colors duration-(--at-duration-fast) focus-ring hover:bg-fill-ghost-hover"
    >
      <span className="flex items-center gap-2 text-caption text-fg-muted">
        <span className="flex size-7 items-center justify-center rounded-lg bg-fill-ghost-hover text-fg-secondary">
          <Icon icon={type.icon} />
        </span>
        {type.label}
        {artifact.versions > 1 && ` · ${artifact.versions} versions`}
      </span>
      <span className="mt-3 line-clamp-2 text-body-strong text-fg">{artifact.title}</span>
      <span className="mt-auto truncate text-caption text-fg-muted">
        {sessionTitle({ title: artifact.sessionTitle, mode: 'chat' })} · {relativeTime(artifact.updatedAt)}
      </span>
    </Link>
  );
}

function EmptyState() {
  const navigate = useNavigate();
  return (
    <div className="mt-12 flex items-center gap-4 rounded-2xl bg-fill-ghost-hover p-4">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-bg text-fg-secondary inset-ring inset-ring-line">
        <Icon icon={Shapes} size="md" />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-section-heading text-fg">No artifacts yet</h2>
        <p className="mt-0.5 text-body text-fg-muted">
          When a reply builds something, like a page, a component or a diagram, it’s kept here.
        </p>
      </div>
      <Button variant="primary" size="sm" onClick={() => void navigate({ to: '/' })}>
        New chat
      </Button>
    </div>
  );
}

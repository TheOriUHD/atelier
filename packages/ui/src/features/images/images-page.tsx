/** Images (Chat sidebar): everything the person's conversations made, newest first, searchable by prompt. */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { keepPreviousData, useInfiniteQuery } from '@tanstack/react-query';
import { Image as ImageIcon, Search } from 'lucide-react';
import type { GeneratedImage } from '@atelier/protocol';
import { Button, Icon, Select, Spinner, TextField, type SelectOption } from '../../components/ui/index.ts';
import { useOpenSettings } from '../../app/navigation.ts';
import { blobUrl } from '../../lib/platform.ts';
import { keys, useAccount, useImageGeneration, useImageModels } from '../../lib/queries.ts';
import { describeError, rpc } from '../../lib/rpc.ts';
import { useDebounced } from '../chat/composer-menu.tsx';
import { ImageViewer } from './image-viewer.tsx';
import { justified } from './justified.ts';

const PAGE = 48;
const SEARCH_DEBOUNCE_MS = 250;
const ALL_MODELS = 'all';
const GAP = 6;
/** The widest a phone gets in portrait: below it, tiles are small enough for two or three in a row. */
const PHONE_WIDTH = 560;
/** Before the grid has been measured; a test's layout has no width at all. */
const FALLBACK_WIDTH = 960;

/** Decimal, as the rest of the app shows sizes of models and disks. */
export function totalSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

export function ImagesPage() {
  const offered = useImageGeneration();
  const { data: models } = useImageModels();
  const [typed, setTyped] = useState('');
  const query = useDebounced(typed.trim(), SEARCH_DEBOUNCE_MS);
  const [ref, setRef] = useState(ALL_MODELS);
  const [open, setOpen] = useState<number | null>(null);
  const list = useInfiniteQuery({
    queryKey: [...keys.generatedImages, 'list', query, ref],
    queryFn: ({ pageParam }) =>
      rpc().call('generatedImages.list', {
        limit: PAGE,
        ...(pageParam !== null ? { before: pageParam } : {}),
        ...(query ? { query } : {}),
        ...(ref !== ALL_MODELS ? { ref } : {}),
      }),
    initialPageParam: null as number | null,
    getNextPageParam: (page) => page.next,
    placeholderData: keepPreviousData,
    enabled: offered,
    staleTime: 0,
  });
  const items = useMemo(() => list.data?.pages.flatMap((p) => p.items), [list.data]);
  const total = list.data?.pages[0]?.totalBytes;
  const filtering = !!query || ref !== ALL_MODELS;

  // Images from a provider that has since been removed can still be filtered by.
  const options = useMemo<SelectOption[]>(() => {
    const named = new Map((models ?? []).filter((m) => !m.hidden).map((m) => [m.ref, m.displayName]));
    for (const image of items ?? []) if (!named.has(image.ref)) named.set(image.ref, image.modelName);
    return [{ value: ALL_MODELS, label: 'All models' }, ...[...named].map(([value, label]) => ({ value, label }))];
  }, [models, items]);

  return (
    <>
      <div className="app-drag h-(--at-layout-header-height) shrink-0" />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-10 max-md:px-4">
        <div className="mx-auto max-w-280">
          <div className="mt-1.5 flex items-baseline justify-between gap-4">
            <h1 className="font-serif text-page-title text-fg">Images</h1>
            {!!total && <p className="shrink-0 text-footnote text-fg-muted tabular-nums">{totalSize(total)} in all</p>}
          </div>
          {(!!items?.length || filtering) && (
            <div className="mt-6 flex flex-wrap items-center gap-3">
              <div className="relative min-w-48 flex-1 md:max-w-80">
                <Icon icon={Search} className="pointer-events-none absolute top-2 left-2.5 text-fg-muted" />
                <TextField aria-label="Search by prompt" placeholder="Search by prompt" value={typed} onChange={(e) => setTyped(e.target.value)} className="pl-8" />
              </div>
              {options.length > 2 && <Select aria-label="Model" options={options} value={ref} onValueChange={setRef} className="max-w-60" />}
            </div>
          )}
          {list.error ? (
            <p role="alert" className="mt-24 text-center text-body text-danger-text">
              {describeError(list.error).message}
            </p>
          ) : !items ? (
            <Spinner className="mx-auto mt-24" />
          ) : items.length === 0 ? (
            filtering ? (
              <p className="mt-24 text-center text-body text-fg-muted">{query ? `No images match “${query}”.` : 'No images from this model yet.'}</p>
            ) : (
              <EmptyState />
            )
          ) : (
            <>
              <ImageGrid images={items} onOpen={setOpen} />
              {list.hasNextPage && <LoadMore key={items.length} loading={list.isFetchingNextPage} onLoad={() => void list.fetchNextPage()} />}
            </>
          )}
        </div>
      </div>
      <ImageViewer images={items ?? []} index={open} onIndexChange={setOpen} />
    </>
  );
}

function ImageGrid({ images, onOpen }: { images: readonly GeneratedImage[]; onOpen(index: number): void }) {
  const grid = useRef<HTMLUListElement>(null);
  const [width, setWidth] = useState(0);
  useLayoutEffect(() => {
    const element = grid.current;
    if (!element) return;
    setWidth(element.clientWidth);
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const room = width || FALLBACK_WIDTH;
  const tiles = useMemo(() => justified(images, room, { rowHeight: room < PHONE_WIDTH ? 132 : 216, gap: GAP }), [images, room]);
  return (
    <ul ref={grid} aria-label="Images" className="mt-6 flex flex-wrap" style={{ gap: GAP }}>
      {images.map((image, i) => (
        <li key={image.blob + image.createdAt} style={tiles[i]}>
          <button type="button" onClick={() => onOpen(i)} className="block size-full cursor-zoom-in overflow-hidden rounded-lg bg-fill-ghost-hover outline-none focus-ring">
            <img src={blobUrl(image.blob)} alt={image.prompt} loading="lazy" decoding="async" className="size-full object-cover transition-opacity duration-(--at-duration-fast) ease-standard hover:opacity-90" />
          </button>
        </li>
      ))}
    </ul>
  );
}

/** Loads the next page on the way down; a button too, for keyboards and for a browser that can't tell. Remounted per page, as the observer reports a change only. */
function LoadMore({ loading, onLoad }: { loading: boolean; onLoad(): void }) {
  const button = useRef<HTMLButtonElement>(null);
  const load = useRef(onLoad);
  useLayoutEffect(() => {
    load.current = onLoad;
  });
  useEffect(() => {
    const element = button.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => entry?.isIntersecting && load.current(), { rootMargin: '600px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  return (
    <Button ref={button} className="mx-auto mt-6 flex" loading={loading} onClick={onLoad}>
      Show more
    </Button>
  );
}

function EmptyState() {
  const navigate = useNavigate();
  const openSettings = useOpenSettings();
  const { data: models } = useImageModels();
  const { account } = useAccount();
  const usable = !!models?.some((m) => !m.hidden);
  const admin = account?.role === 'admin';
  return (
    <div className="mt-12 flex items-center gap-4 rounded-2xl bg-fill-ghost-hover p-4 max-md:flex-col max-md:items-start">
      <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-bg text-fg-secondary inset-ring inset-ring-line">
        <Icon icon={ImageIcon} size="md" />
      </span>
      <div className="min-w-0 flex-1">
        <h2 className="text-section-heading text-fg">No images yet</h2>
        <p className="mt-0.5 text-body text-fg-muted">
          {usable ? 'Ask for one in a chat, like “make a poster for the summer party”. Everything you make is kept here.' : admin ? 'Add an image provider, then ask for an image in a chat.' : 'Ask an admin to add an image provider, then ask for an image in a chat.'}
        </p>
      </div>
      {usable ? (
        <Button variant="primary" size="sm" onClick={() => void navigate({ to: '/' })}>
          New chat
        </Button>
      ) : (
        admin && (
          <Button variant="primary" size="sm" onClick={() => openSettings('image-providers')}>
            Add image provider
          </Button>
        )
      )}
    </div>
  );
}

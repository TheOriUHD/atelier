/**
 * An image from the Images page in the `Lightbox`, with what made it and the way back to its conversation.
 */
import { useState, type ReactNode } from 'react';
import { Link } from '@tanstack/react-router';
import { Download, MessageCircle } from 'lucide-react';
import type { GeneratedImage } from '@atelier/protocol';
import { Button, Icon, Lightbox, toast } from '../../components/ui/index.ts';
import { SESSION_ROUTE } from '../../app/navigation.ts';
import { shortDate } from '../../lib/dates.ts';
import { blobUrl, saveBlob } from '../../lib/platform.ts';
import { describeError } from '../../lib/rpc.ts';
import { sessionTitle } from '../../lib/sessions.ts';
import { formatUsd } from '../settings/usage-data.ts';

export interface ImageViewerProps {
  images: readonly GeneratedImage[];
  /** The image shown; null keeps it closed. */
  index: number | null;
  onIndexChange(index: number | null): void;
}

export function ImageViewer({ images, index, onIndexChange }: ImageViewerProps) {
  const [detailsOpen, setDetailsOpen] = useState(true);
  return (
    <Lightbox
      images={images.map((image) => ({ src: blobUrl(image.blob), alt: image.prompt }))}
      index={index}
      onIndexChange={onIndexChange}
      details={(at) => images[at] && <Details image={images[at]} onLeave={() => onIndexChange(null)} />}
      detailsOpen={detailsOpen}
      onDetailsOpenChange={setDetailsOpen}
    />
  );
}

const seconds = (ms: number) => `${ms < 10_000 ? (ms / 1000).toFixed(1) : Math.round(ms / 1000)} s`;

function Details({ image, onLeave }: { image: GeneratedImage; onLeave(): void }) {
  const download = () => void saveBlob(image.blob, `${image.id}.${image.mime === 'image/jpeg' ? 'jpg' : image.mime.split('/')[1]}`).catch((e: unknown) => toast.error(describeError(e).message));
  return (
    <div className="flex min-h-full flex-col gap-5 text-body">
      <Block label="Prompt">{image.prompt}</Block>
      {image.revisedPrompt && <Block label="What the service made of it">{image.revisedPrompt}</Block>}
      {image.negativePrompt && <Block label="Negative prompt">{image.negativePrompt}</Block>}
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5">
        <Fact label="Model">{image.modelName}</Fact>
        {image.width > 0 && (
          <Fact label="Size">
            {image.width}×{image.height}
          </Fact>
        )}
        {image.seed !== undefined && <Fact label="Seed">{image.seed}</Fact>}
        {image.durationMs !== undefined && <Fact label="Took">{seconds(image.durationMs)}</Fact>}
        {image.costUsd !== undefined && (
          <Fact label="Cost">
            {formatUsd(image.costUsd)}
            {image.costEstimated && <span className="text-fg-muted"> estimate</span>}
          </Fact>
        )}
        <Fact label="Made">{shortDate(image.createdAt)}</Fact>
      </dl>
      <div className="mt-auto flex flex-col gap-2">
        {image.sessionId && image.sessionMode && (
          <Link
            to={SESSION_ROUTE[image.sessionMode]}
            params={{ sessionId: image.sessionId }}
            onClick={onLeave}
            className="flex min-h-11 items-center gap-2 rounded-lg px-2 text-fg-secondary outline-none focus-ring hover:bg-fill-ghost-hover hover:text-fg"
          >
            <Icon icon={MessageCircle} className="shrink-0" />
            <span className="min-w-0 truncate">{sessionTitle({ title: image.sessionTitle ?? '', mode: image.sessionMode })}</span>
          </Link>
        )}
        <Button leadingIcon={Download} onClick={download}>
          Download
        </Button>
      </div>
    </div>
  );
}

function Block({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <h3 className="mb-1 text-footnote text-fg-muted">{label}</h3>
      <p className="break-words whitespace-pre-wrap text-fg">{children}</p>
    </div>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <dt className="text-fg-muted">{label}</dt>
      <dd className="min-w-0 break-words text-fg tabular-nums">{children}</dd>
    </>
  );
}

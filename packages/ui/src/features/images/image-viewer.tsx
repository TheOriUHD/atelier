/**
 * An image, video or sound from the Images page in the `Lightbox` (a video in the `VideoLightbox`, a sound in a dialog with
 * its player), with what made it and the way back to its conversation. Stepping goes to the next of the same kind: a
 * picture's viewer zooms, and a video's plays.
 */
import { useState, type ReactNode } from 'react';
import { Link, useNavigate } from '@tanstack/react-router';
import { Download, ImagePlus, MessageCircle, Paintbrush } from 'lucide-react';
import type { GeneratedImage } from '@atelier/protocol';
import { Button, Dialog, DialogContent, Icon, IconButton, Lightbox, VideoLightbox, toast } from '../../components/ui/index.ts';
import { soundFileName, soundLabel, type ShownSound } from '../chat/audio-view.ts';
import { SoundDetails, SoundPlayer } from '../chat/generated-audio.tsx';
import { SESSION_ROUTE } from '../../app/navigation.ts';
import { shortDate } from '../../lib/dates.ts';
import { blobUrl, saveBlob } from '../../lib/platform.ts';
import { describeError } from '../../lib/rpc.ts';
import { sessionTitle } from '../../lib/sessions.ts';
import { formatUsd } from '../settings/usage-data.ts';
import { AreaEditor } from './area-editor.tsx';
import { sendAreaChange } from './change-area.tsx';
import { useInNewChat } from './use-in-new-chat.ts';

export interface ImageViewerProps {
  images: readonly GeneratedImage[];
  /** The image shown; null keeps it closed. */
  index: number | null;
  onIndexChange(index: number | null): void;
}

export const isVideo = (image: Pick<GeneratedImage, 'kind'>) => image.kind === 'video';
export const isSound = (image: Pick<GeneratedImage, 'kind'>) => image.kind === 'audio';

type ItemKind = 'image' | 'video' | 'audio';
const kindOf = (image: Pick<GeneratedImage, 'kind'>): ItemKind => image.kind ?? 'image';

/** The items of one kind with where each sits in the whole list, and which of them is `index`. */
function ofKind(images: readonly GeneratedImage[], index: number | null, kind: ItemKind) {
  const at = images.flatMap((image, i) => (kindOf(image) === kind ? [i] : []));
  const sub = index === null ? -1 : at.indexOf(index);
  return { items: at.map((i) => images[i]!), at, shown: sub >= 0 ? sub : null };
}

export function ImageViewer({ images, index, onIndexChange }: ImageViewerProps) {
  const [detailsOpen, setDetailsOpen] = useState(true);
  const inNewChat = useInNewChat();
  const navigate = useNavigate();
  // The image being marked stays through the editor's fade, and the lightbox is closed behind it.
  const [marking, setMarking] = useState<{ image: GeneratedImage; open: boolean } | null>(null);
  const area = marking?.image;
  const pictures = ofKind(images, index, 'image');
  const clips = ofKind(images, index, 'video');
  const sounds = ofKind(images, index, 'audio');
  const sound = sounds.shown !== null ? sounds.items[sounds.shown] : undefined;
  const leave = () => onIndexChange(null);
  return (
    <>
      <Lightbox
        images={pictures.items.map((image) => ({ src: blobUrl(image.blob), alt: image.prompt }))}
        index={pictures.shown}
        onIndexChange={(sub) => onIndexChange(sub === null ? null : (pictures.at[sub] ?? null))}
        actions={(at) => {
          const image = pictures.items[at];
          if (!image) return null;
          return (
            <>
              <IconButton icon={ImagePlus} label="Use as reference" iconSize="md" size="lg" onClick={() => void inNewChat(image).then(leave)} />
              {/* The change goes to the conversation the image was made in, which is where its result will be. */}
              {image.sessionId && image.sessionMode && (
                <IconButton
                  icon={Paintbrush}
                  label="Change an area"
                  iconSize="md"
                  size="lg"
                  onClick={() => {
                    setMarking({ image, open: true });
                    leave();
                  }}
                />
              )}
            </>
          );
        }}
        details={(at) => pictures.items[at] && <Details image={pictures.items[at]} onLeave={leave} />}
        detailsOpen={detailsOpen}
        onDetailsOpenChange={setDetailsOpen}
      />
      <VideoLightbox
        videos={clips.items.map((image) => ({ src: blobUrl(image.blob), alt: image.prompt, width: image.width, height: image.height }))}
        index={clips.shown}
        onIndexChange={(sub) => onIndexChange(sub === null ? null : (clips.at[sub] ?? null))}
        actions={(at) => clips.items[at] && <DownloadAction image={clips.items[at]} />}
        details={(at) => clips.items[at] && <Details image={clips.items[at]} onLeave={leave} />}
        detailsOpen={detailsOpen}
        onDetailsOpenChange={setDetailsOpen}
      />
      <Dialog open={!!sound} onOpenChange={(open) => !open && leave()}>
        {sound && (
          <DialogContent title={soundLabel(sound.audioKind ?? 'speech', undefined)} width={560}>
            <div className="flex flex-col gap-5">
              <SoundPlayer key={sound.blob} sound={sound as ShownSound} size="lg" />
              <SoundDetails sound={sound as ShownSound} />
              <SoundLinks image={sound} onLeave={leave} />
            </div>
          </DialogContent>
        )}
      </Dialog>
      {marking && area?.sessionId && area.sessionMode && (
        <AreaEditor
          open={marking.open}
          src={blobUrl(area.blob)}
          alt={area.prompt}
          onClose={() => setMarking((now) => now && { ...now, open: false })}
          onSubmit={async (instruction, mask) => {
            await sendAreaChange(area.sessionId!, area, instruction, mask);
            await navigate({ to: SESSION_ROUTE[area.sessionMode!], params: { sessionId: area.sessionId! } });
          }}
        />
      )}
    </>
  );
}

/** Under a sound's details: when it was made, the way back to its conversation, and its file. */
function SoundLinks({ image, onLeave }: { image: GeneratedImage; onLeave(): void }) {
  const download = () => void saveBlob(image.blob, soundFileName(image as ShownSound)).catch((e: unknown) => toast.error(describeError(e).message));
  return (
    <div className="flex flex-col gap-2">
      <p className="text-footnote text-fg-muted">Made {shortDate(image.createdAt)}</p>
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
  );
}

function DownloadAction({ image }: { image: GeneratedImage }) {
  return <IconButton icon={Download} label="Download" size="lg" onClick={() => void saveBlob(image.blob, `${image.id}.${image.mime === 'video/webm' ? 'webm' : 'mp4'}`).catch((e: unknown) => toast.error(describeError(e).message))} />;
}

const clock = (s: number) => `${Math.floor(Math.round(s) / 60)}:${String(Math.round(s) % 60).padStart(2, '0')}`;
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
        {image.seconds !== undefined && <Fact label="Length">{clock(image.seconds)}</Fact>}
        {image.width > 0 && (
          <Fact label="Size">
            {image.width}×{image.height}
          </Fact>
        )}
        {image.fps !== undefined && <Fact label="Frame rate">{Math.round(image.fps * 100) / 100} fps</Fact>}
        {isVideo(image) && image.audio !== undefined && <Fact label="Sound">{image.audio ? 'Yes' : 'No'}</Fact>}
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

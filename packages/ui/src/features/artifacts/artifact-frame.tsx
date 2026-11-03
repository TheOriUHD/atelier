/**
 * The sandboxed artifact preview (docs/ARCHITECTURE.md §14). The frame gets `sandbox="allow-scripts"`
 * and never `allow-same-origin`, so the runtime has an opaque origin and no access to the app. It only
 * talks to us through postMessage, and we only listen to messages from this frame's window:
 *   runtime → { type: 'ready' } | { type: 'rendered' } | { type: 'error', message }
 *   parent  → { type: 'render', artifactType, content, theme }   (after 'ready')
 * `content` has its `atelier-image:img_…` references swapped for data URLs of the conversation's own images first
 * (image-refs.ts), so the sandbox needs no way to ask for anything. An HTML artifact replaces the runtime document (and its listeners), so the owner remounts the
 * frame (React `key`) whenever content, version or theme change.
 */
import { useEffect, useEffectEvent, useRef, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import type { ArtifactType } from '@atelier/protocol';
import { Icon, cn } from '../../components/ui/index.ts';
import { reducedMotionClass } from '../../components/ui/styles.ts';
import { artifactRuntimeUrl } from '../../lib/platform.ts';
import type { ImageIndex } from '../images/session-images.tsx';
import { useInlinedImages } from './use-inlined-images.ts';

const NO_IMAGES: ImageIndex = new Map();

type FrameState = { status: 'loading' } | { status: 'rendered' } | { status: 'error'; message: string };

export function ArtifactFrame({
  type,
  content,
  theme,
  images = NO_IMAGES,
}: {
  type: ArtifactType;
  content: string;
  theme: 'light' | 'dark';
  /** The conversation's images, by id, for the `atelier-image:` references in `content`. */
  images?: ImageIndex;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<FrameState>({ status: 'loading' });
  const inlined = useInlinedImages(content, images);
  // The frame says it is ready once; the pictures may still be coming. It is sent what it asked for when both are true.
  const ready = useRef(false);
  const sent = useRef(false);
  const send = useEffectEvent(() => {
    const target = frame.current?.contentWindow;
    if (!target || !ready.current || sent.current || inlined.pending) return;
    sent.current = true;
    target.postMessage({ type: 'render', artifactType: type, content: inlined.content, theme }, '*');
  });
  useEffect(() => send(), [inlined.pending]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const target = frame.current?.contentWindow;
      if (!target || event.source !== target) return;
      const data = event.data as { type?: unknown; message?: unknown } | null;
      if (data?.type === 'ready') {
        ready.current = true;
        sent.current = false;
        send();
      } else if (data?.type === 'rendered') setState((s) => (s.status === 'error' ? s : { status: 'rendered' }));
      else if (data?.type === 'error')
        setState({
          status: 'error',
          message: typeof data.message === 'string' && data.message ? data.message : 'The artifact failed to render.',
        });
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [type, content, theme]);

  return (
    <div className="relative min-h-0 flex-1 bg-bg" aria-busy={state.status === 'loading'}>
      <iframe
        ref={frame}
        title="Artifact preview"
        sandbox="allow-scripts"
        src={artifactRuntimeUrl()}
        className={cn('block size-full border-0', state.status === 'loading' && 'invisible')}
      />
      {state.status === 'loading' && <FrameSkeleton />}
      {state.status === 'error' && (
        <div
          role="alert"
          className="absolute inset-x-3 top-3 flex items-start gap-2 rounded-lg bg-danger-subtle px-3 py-2 text-body text-danger-text"
        >
          <Icon icon={CircleAlert} className="mt-0.5" />
          <span className="min-w-0 break-words">{state.message}</span>
        </div>
      )}
    </div>
  );
}

export function FrameSkeleton() {
  const bar = cn('rounded-md bg-skeleton animate-pulse', reducedMotionClass);
  return (
    <div aria-hidden className="absolute inset-0 flex flex-col gap-3 p-6">
      <div className={cn(bar, 'h-6 w-1/3')} />
      <div className={cn(bar, 'h-4 w-2/3')} />
      <div className={cn(bar, 'h-4 w-1/2')} />
      <div className={cn(bar, 'mt-2 h-48 w-full rounded-lg')} />
    </div>
  );
}

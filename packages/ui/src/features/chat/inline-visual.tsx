import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { Download, Maximize2, Minimize2, RotateCcw } from 'lucide-react';
import { unescapeTags, type ToolCallPart, type ToolResultPart } from '@atelier/protocol';
import { Button, IconButton, cn } from '../../components/ui/index.ts';
import { artifactRuntimeUrl } from '../../lib/platform.ts';
import { useResolvedTheme } from '../../lib/theme.ts';
import { useReducedMotion } from '../../lib/motion.ts';
import { downloadText } from '../artifacts/artifact-files.ts';
import { visualField } from './inline-visual-input.ts';

export const InlineVisual = memo(function InlineVisual({ call, result, partialInput, running }: {
  call: ToolCallPart;
  result: ToolResultPart | undefined;
  partialInput: string | undefined;
  running: boolean;
}) {
  const input = call.input as Record<string, unknown>;
  const field = (name: string) => typeof input?.[name] === 'string' ? input[name] : visualField(partialInput, name);
  const html = unescapeTags(field('html') ?? '');
  const title = field('title') ?? 'Interactive visual';
  const description = field('description') ?? title;
  const final = !!result && !result.isError;
  const theme = useResolvedTheme();
  const reducedMotion = useReducedMotion();
  const container = useRef<HTMLElement>(null);
  const frame = useRef<HTMLIFrameElement>(null);
  const [ready, setReady] = useState(false);
  const [height, setHeight] = useState(240);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [generation, setGeneration] = useState(0);
  const exportPending = useRef(false);
  const latest = useRef({ html, final, theme, reducedMotion });
  latest.current = { html, final, theme, reducedMotion };
  const send = useCallback(() => frame.current?.contentWindow?.postMessage({ type: 'inline:render', ...latest.current }, '*'), []);

  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || !event.data || typeof event.data !== 'object') return;
      const data = event.data as Record<string, unknown>;
      if (data.type === 'inline:ready') { setReady(true); send(); }
      else if (data.type === 'inline:height' && typeof data.height === 'number' && Number.isFinite(data.height)) setHeight(Math.max(64, Math.min(1200, Math.ceil(data.height))));
      else if (data.type === 'inline:error') setError(typeof data.message === 'string' ? data.message.slice(0, 300) : 'The visual could not render.');
      else if (data.type === 'inline:export' && exportPending.current && typeof data.html === 'string' && data.html.length <= 200_000) {
        exportPending.current = false;
        downloadText(`${title.replace(/[^a-z0-9_-]+/gi, '-').slice(0, 80) || 'visual'}.html`, data.html);
      }
    };
    window.addEventListener('message', receive);
    return () => window.removeEventListener('message', receive);
  }, [title, generation, send]);

  useEffect(() => {
    if (!ready) return;
    send();
    if (final) return;
    const timer = setInterval(send, 120);
    return () => clearInterval(timer);
  }, [final, theme, reducedMotion, ready, send]);

  useEffect(() => {
    const element = container.current;
    if (!element || typeof IntersectionObserver === 'undefined') return;
    const observer = new IntersectionObserver(([entry]) => frame.current?.contentWindow?.postMessage({ type: 'inline:visibility', visible: !!entry?.isIntersecting }, '*'), { rootMargin: '200px' });
    observer.observe(element);
    return () => observer.disconnect();
  }, [generation]);

  useEffect(() => {
    const change = () => setExpanded(document.fullscreenElement === container.current);
    document.addEventListener('fullscreenchange', change);
    return () => document.removeEventListener('fullscreenchange', change);
  }, []);

  const reload = () => { setError(null); setReady(false); setGeneration((n) => n + 1); };
  const failed = result?.isError || (!running && !result);
  return (
    <section ref={container} aria-label={title} className={cn('group/visual relative isolate w-full min-w-0 bg-transparent', expanded && 'flex h-full flex-col bg-bg p-6')}>
      <span className="sr-only">{description}</span>
      {!failed && (
        <iframe
          key={generation}
          ref={frame}
          title={title}
          sandbox="allow-scripts"
          src={new URL('../inline-visual.html', artifactRuntimeUrl()).href}
          className={cn('block w-full border-0 bg-transparent', expanded && 'min-h-0 flex-1')}
          style={expanded ? undefined : { height }}
        />
      )}
      {!ready && !failed && <div className="pointer-events-none absolute inset-x-0 top-0 flex flex-col gap-3 py-4" aria-label="Building interactive visual"><div className="h-3 w-1/3 animate-pulse rounded bg-skeleton motion-reduce:animate-none" /><div className="h-32 animate-pulse rounded-lg bg-skeleton/40 motion-reduce:animate-none" /></div>}
      {(error || failed) && <div role="alert" className="flex items-center gap-3 py-4 text-body text-fg-secondary"><span>{error ?? 'The visual was not completed.'}</span>{!failed && <Button size="sm" variant="ghost" onClick={reload}>Try again</Button>}</div>}
      {final && <div className="absolute top-1 right-1 z-10 flex gap-1 rounded-lg bg-bg/95 p-0.5 opacity-0 transition-opacity focus-within:opacity-100 group-hover/visual:opacity-100 max-md:opacity-100">
        <IconButton icon={RotateCcw} label="Reset visual" size="xs" onClick={reload} />
        <IconButton icon={Download} label="Download as HTML" size="xs" onClick={() => { exportPending.current = true; frame.current?.contentWindow?.postMessage({ type: 'inline:export' }, '*'); }} />
        <IconButton icon={expanded ? Minimize2 : Maximize2} label={expanded ? 'Exit fullscreen' : 'Expand visual'} size="xs" onClick={() => { void (expanded ? document.exitFullscreen() : container.current?.requestFullscreen())?.catch(() => undefined); }} />
      </div>}
    </section>
  );
});
